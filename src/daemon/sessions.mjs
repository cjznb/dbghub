/**
 * Session manager: the daemon's single source of truth for debug sessions.
 *
 * All hardware/process work is dependency-injected (`gdbFactory`, `backendFactory`,
 * `symbolLoader`, `probeManager`) so this module never imports a concrete gdb/backend/symbol
 * implementation and unit tests can run fully fake. Semantics follow docs/contract-v1.md and
 * design.md §4 (epoch/ev, probeKey/resourceKey exclusivity, lease, op_id cache, rings).
 */
import { err, fail, ok, toErrorPayload } from '../util/errors.mjs';
import { clampText, quoteMi } from '../util/text.mjs';
import path from 'node:path';
import { listTasks as listRtosTasks, faultStatus as readFaultStatus, decodeCortexM3Context } from '../rtos/freertos.mjs';
import { discoverTargets } from '../probes/targets.mjs';

const VERSION = '0.1.0';
const PROTO = 1;
const SID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';
const EVENT_RING_MAX = 5000;
const OUTPUT_RING_BYTES = 2 * 1024 * 1024;
const OUTPUT_PAGE_DEFAULT = 100;
const OUTPUT_CAP_BYTES = 64 * 1024;
const OP_CACHE_TTL_MS = 10 * 60 * 1000;
const LEASE_TTL_MS = 90 * 1000;
const DEFAULT_WAIT_MS = 20000;
const MAX_WAIT_MS = 60000;
const PAGE_DEFAULT = 20;
const STATE_RANK = { starting: 0, running: 1, stopped: 2, exited: 3, error: 4 };

function defaultRand(n) {
  const bytes = new Uint8Array(n);
  for (let i = 0; i < n; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  return bytes;
}

function randomSid(rand) {
  const bytes = rand(4);
  let out = 's';
  for (const b of bytes) out += SID_ALPHABET[b % SID_ALPHABET.length];
  return out;
}

function toArray(v) {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

function isObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * @param {{
 *   config: object,
 *   gdbFactory: (opts: object) => Promise<object>|object,
 *   backendFactory?: (opts: object) => object,
 *   symbolLoader?: (opts: object) => Promise<object>,
 *   probeManager?: object,
 *   log?: object,
 *   daemonInfo?: {mode?: string, socket?: string},
 *   workspace?: string,
 *   clock?: () => number,
 *   rand?: (n: number) => Uint8Array,
 * }} opts
 */
export function createSessionManager({
  config = {},
  gdbFactory,
  backendFactory,
  symbolLoader,
  probeManager,
  log = null,
  daemonInfo = {},
  workspace = process.cwd(),
  clock = () => Date.now(),
  rand = defaultRand,
} = {}) {
  if (typeof gdbFactory !== 'function') {
    throw new Error('createSessionManager: gdbFactory is required (use a stub when gdb is unavailable)');
  }

  /** @type {Map<string, any>} */
  const sessions = new Map();
  const probeOwners = new Map();
  const resourceOwners = new Map();
  const opCache = new Map();
  const daemonCfg = config.daemon || {};

  // ---------------------------------------------------------------- utilities

  function profileFor(name) {
    const profiles = config.profiles || {};
    if (name && profiles[name]) return { name, def: profiles[name] };
    return null;
  }

  function genSid() {
    for (let i = 0; i < 50; i += 1) {
      const sid = randomSid(rand);
      if (!sessions.has(sid)) return sid;
    }
    return `s${(sessions.size + 1).toString(32)}${clock().toString(32).slice(-3)}`;
  }

  function now() {
    return clock();
  }

  function touch(sess) {
    sess.lastActiveAt = now();
  }

  function setState(sess, state) {
    if (sess.state === state) return;
    sess.state = state;
    sess.epoch += 1;
    touch(sess);
  }

  function visible(sess, ctx, all = false) {
    if (sess.owner.clientId === ctx.clientId) return true;
    return all === true;
  }

  function summary(sess) {
    const out = {
      sid: sess.sid,
      profile: sess.profile,
      probe: sess.probeKey || null,
      backend: sess.backendId || null,
      state: sess.state,
      owner: { ...sess.owner },
      share: sess.share,
      lease: sess.lease ? { holder: sess.lease.holder, expiresAt: sess.lease.expiresAt } : null,
      workspace: sess.workspace,
      ev: sess.ev,
      epoch: sess.epoch,
    };
    if (sess.rtos) out.rtos = sess.rtos;
    if (sess.lastError) out.lastError = sess.lastError;
    return out;
  }

  function resolveSid(args, ctx) {
    const explicit = args && typeof args.sid === 'string' ? args.sid.trim() : '';
    if (explicit) return explicit;
    const owned = [...sessions.values()].filter(
      (s) => s.owner.clientId === ctx.clientId && s.state !== 'exited' && visible(s, ctx),
    );
    if (owned.length === 1) return owned[0].sid;
    if (owned.length === 0) {
      throw err('E_NO_SESSION', 'no open session for this client', 'call open first; discover can pick a profile');
    }
    throw err(
      'E_NO_SESSION',
      'multiple sessions are open; pass sid explicitly',
      `known sids: ${owned.map((s) => s.sid).join(', ')}`,
    );
  }

  function getSession(args, ctx) {
    const sid = resolveSid(args, ctx);
    const sess = sessions.get(sid);
    if (!sess) {
      throw err('E_NO_SESSION', `session ${sid} is not open`, 'run sessions action=list to see your sessions');
    }
    if (sess.owner.clientId !== ctx.clientId && sess.share === 'exclusive') {
      // Cross-workspace/cross-client details never leak (design.md §10.2 T4).
      throw err('E_NO_SESSION', `session ${sid} is not open`, 'run sessions action=list to see your sessions');
    }
    return sess;
  }

  // ------------------------------------------------------------------- events

  function pushEvent(sess, event) {
    sess.ev += 1;
    const record = { ev: sess.ev, ts: now(), ...event };
    sess.events.push(record);
    if (sess.events.length > EVENT_RING_MAX) sess.events.splice(0, sess.events.length - EVENT_RING_MAX);
    for (const waiter of [...sess.waiters]) {
      let matched = false;
      try {
        matched = waiter.pred(record) === true;
      } catch {
        matched = false;
      }
      if (matched) {
        sess.waiters.delete(waiter);
        clearTimeout(waiter.timer);
        waiter.resolve(record);
      }
    }
    touch(sess);
    return record;
  }

  function pushOutput(sess, { stream = 'console', text = '' } = {}) {
    const raw = String(text ?? '');
    if (!raw) return;
    const segments = raw.split(/\r?\n/);
    // A trailing newline means the last segment is not a line of its own.
    if (segments.length > 1 && segments[segments.length - 1] === '') segments.pop();
    for (const segment of segments) {
      sess.outSeq += 1;
      sess.output.push({ seq: sess.outSeq, stream, text: segment, ts: now() });
      sess.outBytes += segment.length;
      while (sess.outBytes > OUTPUT_RING_BYTES && sess.output.length > 1) {
        const dropped = sess.output.shift();
        sess.outBytes -= dropped.text.length;
      }
      if (sess.state === 'running' || sess.state === 'starting') {
        sess.pendingOut.push(segment);
        if (sess.pendingOut.length > 200) sess.pendingOut.splice(0, sess.pendingOut.length - 200);
      }
      pushEvent(sess, { type: 'output', stream, text: clampText(segment, 400) });
    }
  }

  function waitEvent(sess, pred, timeoutMs) {
    return new Promise((resolve) => {
      const waiter = { pred, resolve, timer: null };
      waiter.timer = setTimeout(() => {
        sess.waiters.delete(waiter);
        resolve(null);
      }, Math.max(0, timeoutMs));
      waiter.timer.unref?.();
      sess.waiters.add(waiter);
    });
  }

  function waitStop(sess, timeoutMs) {
    const pred = (e) => e.type === 'stop' || e.type === 'exited' || e.type === 'error';
    if (sess.state === 'stopped' && sess.lastStop && sess.stopHandled !== sess.ev) {
      const event = { ev: sess.ev, type: 'stop' };
      sess.stopHandled = sess.ev;
      return Promise.resolve(event);
    }
    return waitEvent(sess, pred, Math.max(0, timeoutMs));
  }

  function stripOk(obj) {
    if (!isObject(obj)) return obj;
    const { ok: _ok, ...rest } = obj;
    return rest;
  }

  // --------------------------------------------------------------------- gdb

  async function exec(sess, command, timeoutMs = 15000) {
    if (!sess.gdb) throw err('E_NO_SESSION', `session ${sess.sid} has no debugger`, 'run open again');
    return sess.gdb.exec(command, { timeoutMs });
  }

  async function execConsole(sess, consoleCommand, timeoutMs = 30000) {
    return exec(sess, `-interpreter-exec console ${quoteMi(consoleCommand)}`, timeoutMs);
  }

  function gdbError(e, fallbackCode = 'E_INVALID_ARG', hint = '') {
    if (e && typeof e.code === 'string' && /^E_[A-Z_]+$/.test(e.code)) {
      if (e.code === 'E_GDB_MI') {
        const message = String(e.message || 'gdb command failed').split('\n')[0].slice(0, 240);
        return err(fallbackCode, message, hint);
      }
      return e;
    }
    const message = e && e.message ? String(e.message) : String(e);
    return err(fallbackCode, message.split('\n')[0].slice(0, 240), hint || 'run `state` to see whether the session is still stopped');
  }

  /**
   * Turn opaque GDB remote failures into actionable errors. A common real-world mistake is
   * pointing gdb at a telnet/monitor port (Renode 1234, OpenOCD telnet 4444), which fails the
   * RSP handshake with `vMustReplyEmpty`/`Remote replied unexpectedly`.
   */
  function classifyTargetError(e) {
    const msg = e && e.message ? String(e.message) : String(e);
    const line = msg.split(/\r?\n/)[0].slice(0, 240);
    if (/vMustReplyEmpty|Remote replied unexpectedly|Remote communication error|Malformed response|unexpected reply|not in executable format|Remote connection closed|Connection reset/i.test(msg)) {
      return err('E_TARGET_PROTOCOL', `target endpoint is not a GDB server (${line})`,
        'connect to the GDB stub port (OpenOCD gdb_port, Renode machine StartGdbServer, QEMU -gdb), not a telnet/monitor port (Renode 1234 / OpenOCD 4444); `discover` reports running targets with roles');
    }
    if (/Connection refused|ECONNREFUSED|cannot resolve name|No route to host|network is unreachable/i.test(msg)) {
      return err('E_TARGET_UNREACHABLE', `cannot reach target endpoint (${line})`,
        'check the port/host; `discover` lists listening debug targets; start OpenOCD/Renode/QEMU or fix the endpoint');
    }
    return e;
  }

  function attachGdbEvents(sess, gdb) {
    const gdbRef = gdb;
    const onStop = (ev) => {
      if (sess.gdb !== gdbRef) return;
      sess.lastStop = ev || {};
      pushEvent(sess, {
        type: 'stop',
        reason: sess.lastStop.reason || 'signal',
        thread: sess.lastStop.threadId ?? null,
        bkptno: sess.lastStop.bkptno ?? null,
        signal: sess.lastStop.signal ?? null,
      });
      setState(sess, 'stopped');
    };
    const onOutput = (payload) => {
      if (sess.gdb !== gdbRef) return;
      pushOutput(sess, payload || {});
    };
    const onExit = (payload) => {
      if (sess.gdb !== gdbRef) return;
      pushEvent(sess, { type: 'exited', code: payload && payload.code, signal: payload && payload.signal });
      setState(sess, 'exited');
      releaseLocks(sess);
    };
    const onError = (e) => {
      if (sess.gdb !== gdbRef) return;
      sess.lastError = toErrorPayload(e);
      pushEvent(sess, { type: 'error', code: sess.lastError.code, message: sess.lastError.message });
    };
    gdb.on?.('stop', onStop);
    gdb.on?.('output', onOutput);
    gdb.on?.('exit', onExit);
    gdb.on?.('error', onError);
    sess.detachEvents = () => {
      gdb.off?.('stop', onStop);
      gdb.off?.('output', onOutput);
      gdb.off?.('exit', onExit);
      gdb.off?.('error', onError);
    };
  }

  function releaseLocks(sess) {
    if (sess.probeKey && probeOwners.get(sess.probeKey) === sess.sid) probeOwners.delete(sess.probeKey);
    if (sess.resourceKey && resourceOwners.get(sess.resourceKey) === sess.sid) resourceOwners.delete(sess.resourceKey);
  }

  // ------------------------------------------------------------------ styling

  function relPath(sess, file) {
    if (!file) return undefined;
    const ws = sess.workspace;
    if (!ws) return file;
    const norm = String(file).replace(/\\/g, '/');
    const base = String(ws).replace(/\\/g, '/').replace(/\/+$/, '');
    if (norm.startsWith(base + '/')) return norm.slice(base.length + 1);
    return norm;
  }

  const TOP_LOCALS = 8;

  async function buildStopCard(sess, { withOk = false } = {}) {
    const stop = sess.lastStop || {};
    const frame = stop.frame || {};
    const card = {
      sid: sess.sid,
      state: sess.state,
      reason: stop.reason && stop.reason !== 'unknown'
        ? stop.reason
        : (sess.state === 'stopped' ? 'entry' : 'signal'),
      epoch: sess.epoch,
      thread: Number.isFinite(Number(stop.threadId)) ? Number(stop.threadId) : 1,
      frame: Number.isFinite(Number(frame.level)) ? Number(frame.level) : 0,
      loc: { fn: frame.func || '??' },
      ev: sess.ev,
    };
    if (stop.bkptno !== undefined && stop.bkptno !== null) card.bp = Number(stop.bkptno) || stop.bkptno;
    if (stop.signal) card.signal = String(stop.signal);
    const file = frame.fullname || frame.file;
    if (file) card.loc.file = relPath(sess, file);
    if (Number.isFinite(Number(frame.line))) card.loc.line = Number(frame.line);
    card.loc.pc = frame.addr ? String(frame.addr) : '0x0';

    try {
      const res = await exec(sess, '-stack-info-depth', 3000);
      const depth = res && res.results ? Number(res.results.depth) : NaN;
      if (Number.isFinite(depth)) card.frames = depth;
    } catch { /* best effort */ }

    if (sess.symbols && typeof sess.symbols.sourceLines === 'function' && file) {
      try {
        const src = await sess.symbols.sourceLines(file, card.loc.line || 1, 3);
        if (src && src.ok !== false && Array.isArray(src.lines) && src.lines.length) {
          card.src = { from: Number.isFinite(Number(src.from)) ? Number(src.from) : Math.max(1, (card.loc.line || 1) - 1), lines: src.lines };
        }
      } catch { /* best effort */ }
    }

    try {
      const res = await exec(sess, '-stack-list-variables --simple-values', 3000);
      const vars = (res && res.results && res.results.variables) || [];
      if (vars.length) {
        card.locals = vars.slice(0, TOP_LOCALS).map((v) => ({
          name: String(v.name ?? '?'),
          value: clampText(v.value ?? '<unavailable>', 200),
        }));
      }
    } catch { /* best effort */ }

    if (sess.pendingOut.length) {
      card.out = sess.pendingOut.splice(0).slice(-5);
    }
    return withOk ? { ok: true, ...card } : card;
  }

  // ------------------------------------------------------------- exclusivity

  function resourceKeyFor({ profileName, profile, args, probeKey }) {
    if (args.pid) return `pid:${Number(args.pid)}`;
    if (args.core) return `core:${String(args.core)}`;
    if (args.target) return `tcp:${String(args.target)}`;
    if (profile.backend && !['none', 'remote', null, undefined].includes(profile.backend)) {
      return `embedded:${probeKey || `auto:${profileName}`}:${profileName}`;
    }
    const program = args.program ? String(args.program) : `<${profileName}>`;
    return `local:${program}`;
  }

  function acquireLocks(sess) {
    if (sess.probeKey) {
      const holder = probeOwners.get(sess.probeKey);
      if (holder && holder !== sess.sid) {
        throw err(
          'E_PROBE_BUSY',
          `probe ${sess.probeKey} is already in use by session ${holder}`,
          'close that session (session_ctl action=close sid=...) or pick another probe',
        );
      }
      probeOwners.set(sess.probeKey, sess.sid);
    }
    const holder = resourceOwners.get(sess.resourceKey);
    if (holder && holder !== sess.sid) {
      throw err(
        'E_RESOURCE_BUSY',
        `target ${sess.resourceKey} is already open in another session`,
        'only one session may own a target; close the other session or use reuse=true with the same owner',
      );
    }
    resourceOwners.set(sess.resourceKey, sess.sid);
  }

  function ensureShare(sess, ctx, { force = false, write = true } = {}) {
    if (!write) return;
    if (sess.share === 'observer') {
      throw err('E_INVALID_ARG', 'session is observer (read-only)', 'open the session with share=exclusive|shared to control the target');
    }
    if (sess.share === 'shared') {
      const lease = sess.lease;
      if (!lease) throw err('E_LEASE_HELD', `session ${sess.sid} has no control lease`, 'session_ctl action=lock to take the lease');
      if (lease.holder !== ctx.clientId && !force) {
        throw err('E_LEASE_HELD', `control lease is held by ${lease.holder} until ${new Date(lease.expiresAt).toISOString()}`, 'wait for expiry or session_ctl action=lock force=true');
      }
      if (lease.expiresAt <= now() && lease.holder !== ctx.clientId && !force) {
        throw err('E_LEASE_HELD', `control lease held by ${lease.holder} has expired`, 'session_ctl action=lock to take it over');
      }
      sess.lease = { holder: ctx.clientId, expiresAt: now() + LEASE_TTL_MS };
      return;
    }
    if (sess.owner.clientId !== ctx.clientId) {
      throw err('E_SESSION_BUSY', `session ${sess.sid} belongs to another client`, 'only the owning client may control an exclusive session');
    }
  }

  // --------------------------------------------------------------- op cache

  function opKey(sid, tool, opId) {
    return `${sid}|${tool}|${opId}`;
  }

  function opGet(sid, tool, opId) {
    if (!opId) return null;
    const hit = opCache.get(opKey(sid, tool, opId));
    if (!hit) return null;
    if (now() - hit.at > OP_CACHE_TTL_MS) {
      opCache.delete(opKey(sid, tool, opId));
      return null;
    }
    return hit.result;
  }

  function opSet(sid, tool, opId, result) {
    if (!opId) return;
    opCache.set(opKey(sid, tool, opId), { at: now(), result });
    if (opCache.size > 500) {
      const cutoff = now() - OP_CACHE_TTL_MS;
      for (const [k, v] of opCache) if (v.at < cutoff) opCache.delete(k);
    }
  }

  // ------------------------------------------------------------------ open

  async function resolveProbeAndBackend(args, profileName, profile) {
    const warnings = [];
    const embedded = Boolean(
      (profile.backend && profile.backend !== 'none' && profile.backend !== 'remote')
      || (profile.probe && profile.probe !== 'none'),
    );
    // Native/attach profiles have no probe or external server: never consult the probe registry.
    if (!embedded && !args.probe && !args.backend) return { probe: null, backendId: null, warnings };
    let probe = args.probe && typeof args.probe === 'object' ? args.probe.key : args.probe || null;
    if (!probe && profile.probe && profile.probe !== 'auto') probe = profile.probe;
    let backendId = args.backend || (profile.backend && profile.backend !== 'auto' ? profile.backend : null);
    if (probeManager && (!probe || !backendId)) {
      try {
        const found = typeof probeManager.discoverProbes === 'function'
          ? await probeManager.discoverProbes({ scan: false })
          : null;
        const probes = (found && found.probes) || [];
        if (found && Array.isArray(found.warnings)) warnings.push(...found.warnings);
        if (typeof probeManager.plan === 'function') {
          const plan = await probeManager.plan({
            probes,
            profiles: config.profiles || {},
            profile: profileName,
            probe,
            backend: backendId,
          });
          if (plan) {
            probe = probe || plan.probe || null;
            backendId = backendId || plan.backend || null;
            if (Array.isArray(plan.reasons) && plan.reasons.length) warnings.push(...plan.reasons.map(String));
          }
        }
      } catch (e) {
        warnings.push(`probe/backend resolution failed: ${e && e.message ? e.message : e}`);
      }
    }
    if (!backendId && profile.backend && profile.backend !== 'auto') backendId = profile.backend;
    return { probe: probe || null, backendId: backendId || null, warnings };
  }

  function normalizeOpenArgs(raw = {}) {
    const args = { ...raw };
    args.program = args.program ? String(args.program) : null;
    args.entry = args.entry ? String(args.entry) : null;
    args.symbols = toArray(args.symbols).map(String);
    args.symbol_paths = toArray(args.symbol_paths).map(String);
    args.images = toArray(args.images).filter(isObject);
    args.args = toArray(args.args).map(String);
    args.source_map = toArray(args.source_map).filter((p) => Array.isArray(p) && p.length >= 2);
    if (args.cwd) {
      const base = path.resolve(String(args.cwd));
      const resolve = (p) => (p && !path.isAbsolute(String(p)) ? path.resolve(base, String(p)) : p);
      args.program = resolve(args.program);
      args.symbols = args.symbols.map(resolve);
      args.symbol_paths = args.symbol_paths.map(resolve);
      args.images = args.images.map((img) => (img && img.file ? { ...img, file: resolve(img.file) } : img));
    }
    args.wait_ms = Number.isFinite(Number(args.wait_ms)) ? Math.max(0, Number(args.wait_ms)) : DEFAULT_WAIT_MS;
    args.mode = args.mode === 'attach' ? 'attach' : 'launch';
    if (args.mode === 'attach' && args.flash === true) {
      throw err('E_INVALID_ARG', 'mode=attach cannot flash the target',
        'attach only loads symbols and halts; use mode="launch" + flash=true to write firmware');
    }
    if (args.mode === 'attach') args.flash = false;
    args.stop_at_entry = args.stop_at_entry === undefined ? true : Boolean(args.stop_at_entry);
    if (args.mode === 'attach') args.stop_at_entry = false;
    args.share = ['exclusive', 'shared', 'observer'].includes(args.share) ? args.share : 'exclusive';
    return args;
  }

  /**
   * Stop at an entry symbol (default `main`) using a temporary hardware breakpoint
   * (fallback software). This is more reliable than "wait for any stop" after flash:
   * the MCU may hit an ISR first, and reset-halt may already have resumed.
   */
  async function stopAtEntry(sess, entry, warnings) {
    let bkpt = null;
    let lastErr = null;
    for (const useHw of [true, false]) {
      try {
        const res = await exec(sess, `-break-insert -t ${useHw ? '-h ' : ''}${quoteMi(entry)}`, 5000);
        const b = res && res.results ? res.results.bkpt : null;
        if (b && Number.isFinite(Number(b.number))) {
          bkpt = { id: Number(b.number), hw: useHw };
          break;
        }
      } catch (e) {
        lastErr = e;
      }
    }
    if (!bkpt) {
      warnings.push(`entry breakpoint "${entry}" could not be set (${lastErr && lastErr.message ? lastErr.message : 'no symbol'}); falling back to current stop`);
      return false;
    }
    try {
      if (sess.state !== 'running') {
        setState(sess, 'running');
        sess.stopHandled = -1;
        await exec(sess, '-exec-continue', 15000);
      } else {
        sess.stopHandled = -1;
      }
      const hit = await waitStop(sess, 10000);
      if (hit && sess.state === 'stopped') {
        const loc = sess.lastStop && sess.lastStop.frame ? sess.lastStop.frame : {};
        const fn = loc.func || loc.function || '';
        if (fn && entry && !String(fn).toLowerCase().includes(String(entry).toLowerCase())) {
          warnings.push(`entry breakpoint "${entry}" hit "${fn}" instead (interrupt/other stop before entry)`);
        }
        return true;
      }
      // Timeout: halt without reset so the caller still gets a usable stopped session.
      try {
        if (sess.backend && typeof sess.backend.halt === 'function') await sess.backend.halt();
        else await sess.gdb.interrupt?.();
      } catch { /* ignore */ }
      await waitStop(sess, 3000);
      warnings.push(`entry breakpoint "${entry}" not hit within 10s; target halted at current PC`);
      return sess.state === 'stopped';
    } finally {
      try { await exec(sess, `-break-delete ${bkpt.id}`, 4000); } catch { /* temp breakpoint may auto-delete */ }
    }
  }

  async function orchestrate(sess, args) {
    const profile = sess.profileDef;
    const openWarnings = sess.openWarnings || [];
    sess.flashed = false;
    setState(sess, 'starting');
    sess.progress = 'resolving backend';
    try {
      if (sess.backendId && sess.backendId !== 'none' && sess.backendId !== 'remote' && typeof backendFactory === 'function') {
        sess.progress = `starting backend ${sess.backendId}`;
        const backend = backendFactory({
          profile,
          profileName: sess.profile,
          config,
          log,
        });
        sess.backend = backend;
        const started = await backend.start();
        sess.backendInfo = started || {};
        if (started && started.gdbPort) sess.gdbTarget = `127.0.0.1:${started.gdbPort}`;
        else if (profile.target_port) sess.gdbTarget = `127.0.0.1:${profile.target_port}`;
      }

      sess.progress = 'starting gdb';
      const gdbInstance = await gdbFactory({
        profile,
        profileName: sess.profile,
        gdbPath: profile.gdb || 'gdb',
        args: toArray(profile.gdb_args),
        cwd: args.cwd || sess.workspace,
        env: process.env,
        program: args.program || null,
        log,
      });
      if (!gdbInstance) throw err('E_TOOLCHAIN_MISSING', 'no debugger adapter available', 'install arm-none-eabi-gdb or set profiles.<name>.gdb');
      sess.gdb = gdbInstance;
      attachGdbEvents(sess, gdbInstance);
      await gdbInstance.start();
      adoptGdbStop(sess);

      if (args.program && !/\.(hex|bin)$/i.test(args.program)) {
        sess.progress = 'loading program';
        try {
          await gdbInstance.loadProgram(args.program);
        } catch (e) {
          throw err('E_SYMBOL_NOT_FOUND', `cannot load program "${args.program}": ${String(e && e.message ? e.message : e).split(/\r?\n/)[0].slice(0, 200)}`,
            'pass an absolute path, or open(cwd=<your project dir>) so relative paths resolve; the daemon cwd may differ from your shell');
        }
      }
      if (args.pid) {
        sess.progress = `attaching pid ${args.pid}`;
        if (!daemonCfg.allow_attach) {
          throw err('E_ATTACH_DENIED', 'attach is disabled', 'set daemon.allow_attach=true in the user config to attach to a live process');
        }
        await exec(sess, `-target-attach ${Number(args.pid)}`, 15000);
      }

      const hasSymbolInput = Boolean(args.program || args.symbols.length || args.symbol_paths.length);
      if (typeof symbolLoader === 'function' && hasSymbolInput) {
        sess.progress = 'loading symbols';
        try {
          const loaded = await symbolLoader({
            program: args.program,
            symbols: args.symbols,
            symbolPaths: args.symbol_paths,
            sourceMap: args.source_map,
            session: gdbInstance,
            cwd: args.cwd || sess.workspace,
          });
          if (loaded && loaded.ok === false) {
            // Hard symbol failures (arch mismatch / no debug / bad map) are contract errors, not warnings.
            const e = loaded.error || {};
            throw err(e.code || 'E_SYMBOL_PARSE', e.message || 'symbol loading failed', e.hint || '');
          }
          sess.symbols = loaded;
        } catch (e) {
          if (e instanceof Error && typeof e.code === 'string' && /^E_SYMBOL_|^E_MAP_/.test(e.code)) {
            if (e.code === 'E_SYMBOL_NOT_FOUND') {
              throw err(e.code, e.message, 'pass an absolute program path or open(cwd=<your project dir>); relative paths resolve against the daemon cwd');
            }
            throw e;
          }
          sess.symbols = { summary: { sources: [], warnings: [`symbol loading failed: ${e && e.message ? e.message : e}`] } };
          sess.symbolError = toErrorPayload(e);
        }
      } else {
        sess.symbols = {
          summary: {
            sources: [],
            warnings: ['no program/symbols provided; breakpoints must use absolute addresses (*0x...) and backtraces may be symbol-less'],
          },
        };
      }

      if (sess.gdbTarget) {
        sess.progress = `connecting ${sess.gdbTarget}`;
        await gdbInstance.selectRemote(sess.gdbTarget);
      }
      if (args.core) {
        sess.progress = 'loading core';
        await exec(sess, `-target-select core ${quoteMi(args.core)}`, 15000);
      }

      const attach = sess.mode === 'attach';
      const hasAttachConnect = Array.isArray(profile.attach_connect);
      const connectCmds = attach && hasAttachConnect ? toArray(profile.attach_connect) : toArray(profile.connect);
      if (attach && !hasAttachConnect && connectCmds.some((c) => /reset/i.test(c))) {
        openWarnings.push('attach mode: profile has no attach_connect; reset commands are skipped (add attach_connect to make this explicit)');
      }
      for (const cmd of connectCmds) {
        if (attach && /reset/i.test(cmd)) {
          openWarnings.push(`attach mode skipped reset command: ${cmd}`);
          continue;
        }
        sess.progress = `connect: ${cmd}`;
        try {
          await execConsole(sess, cmd);
        } catch (e) {
          if (!attach) throw e;
          openWarnings.push(`attach connect command failed (ignored): ${cmd}: ${e && e.message ? e.message : e}`);
        }
        if (!attach && /reset/i.test(cmd)) sess.resetDone = true;
      }
      if (args.target) {
        sess.progress = `connecting ${args.target}`;
        await gdbInstance.selectRemote(String(args.target));
      }
      if (attach && sess.backend && typeof sess.backend.halt === 'function') {
        // Ensure a running target is halted without resetting it.
        try { await sess.backend.halt(); } catch { /* GDB may already have halted it */ }
      }
      if (!attach) {
        if (args.flash !== false && profile.flash_on_open && toArray(profile.flash).length) {
          for (const cmd of toArray(profile.flash)) {
            sess.progress = `flash: ${cmd}`;
            await execConsole(sess, cmd, 120000);
          }
          sess.flashed = true;
        }
        for (const image of args.images) {
          sess.progress = `loading image ${image.file}`;
          await execConsole(sess, `load ${quoteMi(image.file)}`, 120000);
        }
        for (const cmd of toArray(profile.after)) {
          sess.progress = `after: ${cmd}`;
          await execConsole(sess, cmd);
          if (/reset/i.test(cmd)) sess.resetDone = true;
        }
      } else {
        const afterCmds = Array.isArray(profile.attach_after) ? toArray(profile.attach_after) : [];
        for (const cmd of afterCmds) {
          sess.progress = `attach after: ${cmd}`;
          try { await execConsole(sess, cmd); } catch (e) { openWarnings.push(`attach after command failed (ignored): ${cmd}: ${e && e.message ? e.message : e}`); }
        }
      }

      if (attach) {
        sess.progress = 'waiting for attach halt';
        try {
          await ensureStopped(sess, 4000);
        } catch (e) {
          if (sess.gdb && (sess.gdb.lastStop || sess.gdb.status === 'stopped')) {
            sess.lastStop = sess.gdb.lastStop || sess.lastStop || { reason: 'entry' };
            setState(sess, 'stopped');
          } else {
            throw err('E_TIMEOUT', 'attached but target did not report a stop', 'use run action=pause then state, or mode="launch" to reset');
          }
        }
      } else if (args.stop_at_entry !== false && profile.stop_at_entry !== false) {
        const entry = args.entry || profile.entry || 'main';
        sess.progress = `stop at entry ${entry}`;
        const reached = await stopAtEntry(sess, entry, openWarnings);
        if (!reached) {
          sess.progress = 'waiting for entry stop';
          await ensureStopped(sess, 5000);
        }
      } else if (sess.gdb && sess.gdb.status === 'running') {
        setState(sess, 'running');
      } else if (sess.state === 'starting') {
        await ensureStopped(sess, 5000);
      }
      sess.progress = null;
      await maybeDetectRtos(sess);
      sess.openedAt = now();
      return sess;
    } catch (e) {
      const mapped = classifyTargetError(e);
      sess.lastError = toErrorPayload(mapped);
      pushEvent(sess, { type: 'error', code: sess.lastError.code, message: sess.lastError.message });
      setState(sess, 'error');
      try { await teardown(sess, { keepRecord: true }); } catch { /* ignore */ }
      throw mapped;
    }
  }

  async function ensureStopped(sess, timeoutMs) {
    const gdb = sess.gdb;
    if (!gdb) throw err('E_NO_SESSION', `session ${sess.sid} has no debugger`, 'run open again');
    adoptGdbStop(sess);
    const status = typeof gdb.status === 'string' ? gdb.status : undefined;
    if (status === 'exited' || status === 'closed') {
      setState(sess, 'exited');
      return sess.lastStop || { reason: 'exited' };
    }
    if (status !== 'running' && sess.lastStop) {
      setState(sess, 'stopped');
      return sess.lastStop;
    }
    if (status === 'running' || !sess.lastStop) {
      try {
        await gdb.interrupt?.();
      } catch { /* ignore */ }
      const hit = await waitStop(sess, timeoutMs);
      adoptGdbStop(sess);
      if (!hit && sess.state !== 'stopped' && sess.state !== 'exited') {
        throw err('E_TIMEOUT', `target did not stop within ${timeoutMs}ms`, 'the target may be stalled; try run action=pause, then state');
      }
      if (sess.state !== 'exited') setState(sess, 'stopped');
    }
    return sess.lastStop || {};
  }

  /**
   * A freshly started gdb may already be halted (attach/entry) without emitting `*stopped`.
   * Adopt its last stop so the session has an ev/epoch-backed stop before the first command.
   */
  function adoptGdbStop(sess) {
    const stop = sess.gdb && sess.gdb.lastStop;
    if (!stop || stop === sess.lastStop || sess.state === 'stopped') return;
    sess.lastStop = stop;
    pushEvent(sess, {
      type: 'stop',
      reason: stop.reason || 'entry',
      thread: stop.threadId ?? null,
      bkptno: stop.bkptno ?? null,
      signal: stop.signal ?? null,
    });
    setState(sess, 'stopped');
  }

  async function open(args = {}, ctx = {}) {
    const clientId = ctx.clientId || 'local';
    const normalized = normalizeOpenArgs(args);
    if (normalized.op_id) {
      const hit = opCache.get(`open:${clientId}:${normalized.op_id}`);
      if (hit && now() - hit.at <= OP_CACHE_TTL_MS) return hit.result;
    }
    const profileName = normalized.profile || config.project?.profile || 'native';
    const found = profileFor(profileName);
    if (!found) {
      const known = Object.keys(config.profiles || {});
      throw err('E_INVALID_ARG', `unknown profile "${profileName}"`, `known profiles: ${known.join(', ') || '(none)'}`);
    }
    const profile = found.def;
    if (!normalized.program && !normalized.pid && !normalized.core && !normalized.target) {
      throw err('E_INVALID_ARG', 'open requires program (or pid/core/target for attach)', 'pass program=<path to .elf>; discover action=plan can suggest a profile');
    }
    const maxSessions = Number(daemonCfg.max_sessions) || 8;
    if (sessions.size >= maxSessions) {
      const victim = [...sessions.values()]
        .filter((s) => s.state === 'exited' || s.state === 'error')
        .sort((a, b) => a.lastActiveAt - b.lastActiveAt)[0];
      if (!victim) {
        throw err('E_SESSION_BUSY', `session limit reached (${maxSessions})`, 'close an idle session with session_ctl action=close');
      }
      await teardown(victim, { kill: true });
    }

    const resolved = await resolveProbeAndBackend(normalized, profileName, profile);
    const probeKey = resolved.probe
      ? String(typeof resolved.probe === 'object' ? resolved.probe.key : resolved.probe)
      : profile.backend && !['none', 'remote', null, undefined].includes(profile.backend)
        ? `auto:${profileName}`
        : null;
    const resourceKey = resourceKeyFor({ profileName, profile, args: normalized, probeKey });

    const existingSid = resourceOwners.get(resourceKey);
    if (existingSid && existingSid !== ctx.sid) {
      const existing = sessions.get(existingSid);
      if (existing && normalized.reuse && existing.owner.clientId === clientId) {
        const actorSame = (existing.owner.actor || null) === (normalized.actor || null);
        if (actorSame) {
          touch(existing);
          const result = { ok: true, sid: existing.sid, state: existing.state, reused: true };
          if (existing.state === 'stopped') result.stop = await buildStopCard(existing);
          return result;
        }
      }
    }

    const sid = genSid();
    const sess = {
      sid,
      profile: profileName,
      profileDef: profile,
      adapter: profile.adapter || 'gdbmi',
      probeKey,
      resourceKey,
      workspace: normalized.cwd ? String(normalized.cwd) : String(ctx.workspace || workspace || process.cwd()),
      target: {
        ...(normalized.pid ? { pid: Number(normalized.pid) } : {}),
        ...(normalized.core ? { core: String(normalized.core) } : {}),
        ...(normalized.target ? { host: String(normalized.target) } : {}),
        program: normalized.program || '',
      },
      state: 'starting',
      owner: {
        clientId,
        ...(normalized.actor ? { actor: String(normalized.actor) } : {}),
        ...(normalized.actor ? { label: String(normalized.actor) } : {}),
      },
      share: normalized.share,
      lease: normalized.share === 'shared' ? { holder: clientId, expiresAt: now() + LEASE_TTL_MS } : null,
      epoch: 0,
      breakpoints: [],
      ev: 0,
      events: [],
      waiters: new Set(),
      output: [],
      outSeq: 0,
      outBytes: 0,
      pendingOut: [],
      lastError: null,
      startedAt: now(),
      lastActiveAt: now(),
      gdb: null,
      backend: null,
      backendId: resolved.backendId,
      gdbTarget: null,
      symbols: null,
      openArgs: normalized,
      mode: normalized.mode,
      attached: normalized.mode === 'attach',
      resetDone: false,
      progress: 'queued',
      stopHandled: -1,
    };
    sessions.set(sid, sess);
    try {
      acquireLocks(sess);
    } catch (e) {
      sessions.delete(sid);
      throw e;
    }

    sess.openWarnings = resolved.warnings;
    const task = orchestrate(sess, normalized);
    const timed = await raceWithTimeout(task, normalized.wait_ms);
    if (timed.timedOut) {
      task.catch(() => { /* recorded in session.lastError */ });
      return { ok: true, sid, state: sess.state === 'starting' ? 'starting' : sess.state, job: 'j1', progress: sess.progress || 'starting' };
    }

    if (sess.share === 'exclusive') sess.lease = { holder: clientId, expiresAt: now() + LEASE_TTL_MS };
    const result = {
      ok: true,
      sid,
      state: sess.state,
      probe: sess.probeKey || null,
      backend: sess.backendId || null,
    };
    if (sess.state === 'stopped') result.stop = await buildStopCard(sess);
    if (sess.symbols) result.symbols = sess.symbols.summary || sess.symbols;
    if (resolved.warnings.length) result.warnings = resolved.warnings;
    const endpoint = sess.gdbTarget || normalized.target || profile.endpoint || null;
    const targetMode = sess.backendId && !['none', 'remote'].includes(sess.backendId)
      ? 'embedded'
      : endpoint ? 'remote' : 'local';
    result.target = {
      mode: targetMode,
      attached: Boolean(sess.attached),
      reset: Boolean(sess.resetDone),
      endpoint,
      flashed: Boolean(sess.flashed),
    };
    if (normalized.program) {
      result.program = { path: normalized.program, used_for: sess.flashed ? 'flash+symbols' : 'symbols' };
      if (sess.attached) {
        result.notes = [
          'attached without reset (mode="attach"); target memory/flash was not modified',
          'program is used for symbols only; verify it matches the firmware already running in the target',
        ];
      } else if (targetMode !== 'local' && !sess.flashed) {
        result.notes = [
          'program is used for symbols only; the remote target memory was not modified (flash=false)',
          'dbghub cannot verify that this ELF matches the image already loaded in the target; if PC/backtrace looks wrong, pass the ELF that was actually loaded',
        ];
      }
    }
    opSet(sid, 'open', normalized.op_id, result);
    if (normalized.op_id) opCache.set(`open:${clientId}:${normalized.op_id}`, { at: now(), result });
    return result;
  }

  async function raceWithTimeout(promise, ms) {
    if (!Number.isFinite(ms) || ms <= 0) return { timedOut: false, value: await promise };
    let timer;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve({ timedOut: true }), ms);
      timer.unref?.();
    });
    try {
      const result = await Promise.race([promise.then((value) => ({ timedOut: false, value })), timeout]);
      return result;
    } finally {
      clearTimeout(timer);
    }
  }

  // -------------------------------------------------------------------- run

  const RUN_COMMANDS = {
    continue: '-exec-continue',
    step_over: '-exec-next',
    step_in: '-exec-step',
    step_out: '-exec-finish',
  };

  async function run(args = {}, ctx = {}) {
    const sess = getSession(args, ctx);
    const action = typeof args.action === 'string' ? args.action : '';
    if (!action) throw err('E_INVALID_ARG', 'run requires action', 'one of continue/step_over/step_in/step_out/pause/restart/kill/detach');
    if (args.expect_epoch !== undefined && args.expect_epoch !== null && Number(args.expect_epoch) !== sess.epoch) {
      throw err(
        'E_STALE_STATE',
        `stale expect_epoch ${args.expect_epoch} (current ${sess.epoch})`,
        'another write already changed the target; call state to resync',
      );
    }
    const cached = opGet(sess.sid, 'run', args.op_id);
    if (cached) return cached;
    ensureShare(sess, ctx);
    touch(sess);

    if (action === 'kill' || action === 'detach') {
      await teardown(sess, { kill: action === 'kill' });
      const result = { ok: true, sid: sess.sid, state: 'exited', ev: sess.ev };
      opSet(sess.sid, 'run', args.op_id, result);
      return result;
    }
    if (action === 'restart') {
      const requestedMode = args.mode === undefined || args.mode === null || args.mode === '' ? null : String(args.mode);
      if (requestedMode && !['launch', 'attach'].includes(requestedMode)) {
        throw err('E_INVALID_ARG', `invalid restart mode "${requestedMode}"`, 'use mode="launch" (reset) or mode="attach" (no reset)');
      }
      const restartArgs = { ...sess.openArgs };
      if (requestedMode) {
        restartArgs.mode = requestedMode;
        restartArgs.flash = requestedMode === 'attach' ? false : restartArgs.flash;
        restartArgs.stop_at_entry = requestedMode === 'attach' ? false : true;
        sess.openArgs = restartArgs;
        sess.mode = requestedMode;
        sess.attached = requestedMode === 'attach';
        sess.resetDone = false;
      }
      await teardown(sess, { keepRecord: true, kill: true });
      sess.epoch += 1;
      sess.stopHandled = -1;
      const task = orchestrate(sess, sess.openArgs);
      const timed = await raceWithTimeout(task, Number(args.timeout_ms) || DEFAULT_WAIT_MS);
      if (timed.timedOut) return { ok: true, sid: sess.sid, state: 'starting', job: 'j1', progress: sess.progress || 'restarting' };
      const result = {
        ok: true,
        sid: sess.sid,
        state: sess.state,
        restarted: true,
        mode: sess.mode || 'launch',
        reset: Boolean(sess.resetDone),
        ...(sess.attached ? { attached: true } : {}),
      };
      if (sess.state === 'stopped') Object.assign(result, await buildStopCard(sess));
      opSet(sess.sid, 'run', args.op_id, result);
      return result;
    }
    if (action === 'pause') {
      if (sess.state !== 'running') {
        const result = { ok: true, sid: sess.sid, state: sess.state, ev: sess.ev };
        if (sess.state === 'stopped') result.stop = await buildStopCard(sess);
        return result;
      }
      let interruptError = null;
      try {
        await sess.gdb.interrupt?.();
      } catch (e) {
        interruptError = e;
        // OpenOCD/J-Link remote targets often accept the per-server `monitor halt`
        // even when GDB's MI -exec-interrupt --all stalls.
        try { await execConsole(sess, 'monitor halt', 4000); } catch { /* try backend halt */ }
        try { if (sess.backend && typeof sess.backend.halt === 'function') await sess.backend.halt(); } catch { /* try waitStop below */ }
      }
      const hit = await waitStop(sess, Number(args.timeout_ms) || 5000);
      if (hit && sess.state === 'stopped') {
        const result = await buildStopCard(sess, { withOk: true });
        opSet(sess.sid, 'run', args.op_id, result);
        return result;
      }
      // Some OpenOCD/ST-LINK combinations halt the target without GDB emitting *stopped.
      // Retry the interrupt once after the backend halt so GDB resyncs.
      if (!interruptError) {
        try { await sess.gdb.interrupt?.(); } catch { /* ignore */ }
        const hit2 = await waitStop(sess, 2000);
        if (hit2 && sess.state === 'stopped') {
          const result = await buildStopCard(sess, { withOk: true });
          opSet(sess.sid, 'run', args.op_id, result);
          return result;
        }
      }
      if (interruptError) {
        const msg = interruptError && interruptError.message ? String(interruptError.message) : String(interruptError);
        if ((interruptError.code === 'E_TIMEOUT') || /timed out|timeout/i.test(msg)) {
          throw err('E_INTERRUPT_UNSUPPORTED', 'target did not accept an asynchronous interrupt',
            'this GDB stub (e.g. Renode/QEMU) may not support break-in; use run action=restart to regain control, or the simulator monitor port');
        }
        throw gdbError(interruptError, 'E_TIMEOUT', 'interrupt failed; the target may be unresponsive — session_ctl action=close kill=true');
      }
      sess.lastError = { code: 'E_TARGET_UNRESPONSIVE', message: 'target did not report a stop after halt' };
      throw err('E_TARGET_UNRESPONSIVE', 'target did not report a stop after halt/interrupt',
        'the target may be wedged (fault/WFI/locked debug): use run action=restart, or session_ctl action=close kill=true then reopen');
    }

    const command = RUN_COMMANDS[action];
    if (!command) throw err('E_INVALID_ARG', `unknown run action "${action}"`, 'continue/step_over/step_in/step_out/pause/restart/kill/detach');
    if (sess.state === 'running') {
      throw err('E_NOT_STOPPED', 'session is running', 'call run action=pause first');
    }
    if (sess.state !== 'stopped') {
      throw err('E_NOT_STOPPED', `session is ${sess.state}, not stopped`, 'open the session first; use state to check');
    }

    setState(sess, 'running');
    sess.stopHandled = -1;
    try {
      if (args.thread) await exec(sess, `-thread-select ${Number(args.thread)}`, 4000);
      if (action === 'continue' && args.until) await exec(sess, `-exec-until ${quoteMi(String(args.until))}`, 15000);
      else await exec(sess, command, 15000);
    } catch (e) {
      setState(sess, 'stopped');
      throw gdbError(e, 'E_INVALID_ARG', 'target did not accept the command; try `state`');
    }
    const timeoutMs = Math.min(Number(args.timeout_ms) || DEFAULT_WAIT_MS, MAX_WAIT_MS);
    const hit = await waitStop(sess, timeoutMs);
    let result;
    if (!hit) {
      try { await sess.gdb.interrupt?.(); } catch { /* ignore */ }
      const late = await waitStop(sess, 2000);
      result = late && sess.state === 'stopped'
        ? await buildStopCard(sess, { withOk: true })
        : { ok: true, sid: sess.sid, state: 'running', timed_out: true, ev: sess.ev };
    } else if (sess.state === 'exited') {
      result = { ok: true, sid: sess.sid, state: 'exited', ev: sess.ev };
    } else {
      result = await buildStopCard(sess, { withOk: true });
    }
    opSet(sess.sid, 'run', args.op_id, result);
    return result;
  }

  // ------------------------------------------------------------------- wait

  async function wait(args = {}, ctx = {}) {
    const sess = getSession(args, ctx);
    const after = Number(args.after) || 0;
    const timeoutMs = Math.min(Number(args.timeout_ms) || 10000, MAX_WAIT_MS);
    const types = toArray(args.events).filter((t) => typeof t === 'string');
    const matches = (e) => e.ev > after && (types.length === 0 || types.includes(e.type));
    let events = sess.events.filter(matches);
    let timedOut = false;
    if (events.length === 0) {
      const hit = await waitEvent(sess, matches, timeoutMs);
      events = hit ? [hit] : [];
      timedOut = events.length === 0;
    }
    const result = {
      ok: true,
      sid: sess.sid,
      state: sess.state,
      ev: sess.ev,
      events: events.map((e) => ({ ...e })),
    };
    if (events.some((e) => e.type === 'stop') && sess.state === 'stopped') {
      result.stop = await buildStopCard(sess);
    }
    if (timedOut) result.timed_out = true;
    return result;
  }

  // ------------------------------------------------------------------ state

  async function state(args = {}, ctx = {}) {
    const sess = getSession(args, ctx);
    const detail = Number.isFinite(Number(args.detail)) ? Math.max(0, Math.min(2, Number(args.detail))) : 1;
    const result = { ok: true, sid: sess.sid, state: sess.state, ev: sess.ev };
    if (sess.state === 'stopped') {
      result.stop = await buildStopCard(sess);
    } else if (sess.state === 'error' && sess.lastError) {
      result.error = sess.lastError;
    }
    if (detail >= 1 && sess.progress && sess.state === 'starting') result.progress = sess.progress;
    if (detail >= 2) {
      result.epoch = sess.epoch;
      result.breakpoints = sess.breakpoints.map((b) => ({ id: b.id, spec: b.spec, enabled: b.enabled, hits: b.hits }));
    }
    return result;
  }

  // ------------------------------------------------------------------ break

  function parseBreakpoint(bkpt) {
    if (!isObject(bkpt)) return null;
    const id = Number(bkpt.number ?? bkpt.id);
    if (!Number.isFinite(id)) return null;
    const file = bkpt.fullname || bkpt.file || null;
    const line = Number.isFinite(Number(bkpt.line)) ? Number(bkpt.line) : null;
    const addr = bkpt.addr ? String(bkpt.addr) : null;
    const pending = Boolean(bkpt.pending) || (addr ? /PENDING/i.test(addr) : false);
    const spec = file
      ? `${file}${line ? `:${line}` : ''}`
      : (pending && bkpt.original_location) || bkpt.func || addr || String(id);
    return {
      id,
      spec: String(spec),
      enabled: bkpt.enabled === undefined ? true : bkpt.enabled === 'y' || bkpt.enabled === true,
      hits: Number(bkpt.times) || 0,
      ...(file ? { file: String(file) } : {}),
      ...(line ? { line } : {}),
      ...(bkpt.func ? { func: String(bkpt.func) } : {}),
      ...(addr && !pending ? { addr } : {}),
      ...(pending ? { pending: true } : {}),
      ...(bkpt.cond ? { cond: String(bkpt.cond) } : {}),
    };
  }

  /**
   * Build a GDB break location from either `spec` (compat) or intuitive `file` + `line`
   * (line alone means "current stop file"), or `function`.
   */
  function buildBreakSpec(args, sess) {
    let spec = args.spec ? String(args.spec).trim() : '';
    const rawLine = args.line;
    const line = rawLine === undefined || rawLine === null || rawLine === '' ? null : Number(rawLine);
    if (!spec && line !== null) {
      if (!Number.isInteger(line) || line <= 0) {
        throw err('E_INVALID_ARG', `invalid line number "${rawLine}"`, 'line must be a positive integer, e.g. line=42');
      }
      let file = args.file ? String(args.file) : '';
      if (!file && sess.lastStop && sess.lastStop.frame) {
        file = sess.lastStop.frame.fullname || sess.lastStop.frame.file || '';
      }
      if (!file) {
        throw err('E_INVALID_ARG', 'line breakpoint needs a file', 'pass file="src/main.c" line=42, or spec="src/main.c:42"');
      }
      if (sess.symbols && typeof sess.symbols.resolvePath === 'function') {
        try { file = sess.symbols.resolvePath(file) || file; } catch { /* keep original */ }
      }
      spec = `${file}:${line}`;
    }
    if (!spec && args.function) spec = String(args.function);
    if (!spec) {
      throw err('E_INVALID_ARG', 'break action=set requires a location',
        'use file+line (e.g. file="src/main.c" line=42), function="app_main", spec="src/main.c:42", or spec="*0x08000000"');
    }
    return spec;
  }

  function upsertBreakpoint(sess, parsed, owner) {
    if (!parsed) return;
    const existing = sess.breakpoints.find((b) => b.id === parsed.id);
    if (existing) Object.assign(existing, parsed);
    else sess.breakpoints.push({ ...parsed, owner });
  }

  async function brk(args = {}, ctx = {}) {
    const sess = getSession(args, ctx);
    ensureShare(sess, ctx);
    const action = typeof args.action === 'string' ? args.action : '';
    if (!action) throw err('E_INVALID_ARG', 'break requires action', 'set/remove/list/enable/disable');
    const cached = opGet(sess.sid, 'break', args.op_id);
    if (cached) return cached;
    const list = () => ({
      ok: true,
      sid: sess.sid,
      breakpoints: sess.breakpoints.map((b) => ({
        id: b.id,
        spec: b.spec,
        enabled: b.enabled,
        ...(b.file ? { file: b.file } : {}),
        ...(b.line ? { line: b.line } : {}),
        ...(b.func ? { func: b.func } : {}),
        ...(b.addr ? { addr: b.addr } : {}),
        ...(b.pending ? { pending: true } : {}),
        ...(b.hits ? { hits: b.hits } : {}),
        ...(b.cond ? { cond: b.cond } : {}),
        ...(b.owner ? { owner: b.owner } : {}),
      })),
    });

    if (action === 'set') {
      const spec = buildBreakSpec(args, sess);
      const kind = args.kind || 'sw';
      let command;
      if (kind === 'watch') command = `-break-watch ${spec}`;
      else command = `-break-insert ${args.temp ? '-t ' : ''}${kind === 'hw' ? '-h ' : ''}${quoteMi(spec)}`;
      const res = await exec(sess, command, 8000).catch((e) => {
        throw gdbError(e, 'E_INVALID_ARG',
          `cannot set breakpoint at "${spec}"; verify the file/line exists in debug info, or map source paths via open(source_map=[["old","new"]])`);
      });
      const bkpts = res && res.results ? [res.results.bkpt, ...(res.results.bkpts || [])].filter(Boolean) : [];
      const createdIds = [];
      for (const b of bkpts) {
        const parsed = parseBreakpoint(b);
        if (!parsed) continue;
        upsertBreakpoint(sess, parsed, ctx.clientId);
        createdIds.push(parsed.id);
      }
      const created = createdIds.length ? sess.breakpoints.find((b) => b.id === createdIds[createdIds.length - 1]) : null;
      if (args.cond && created) {
        try {
          await exec(sess, `-break-condition ${created.id} ${quoteMi(String(args.cond))}`, 5000);
          created.cond = String(args.cond);
        } catch { /* condition unsupported on this target */ }
      }
      touch(sess);
      const result = { ...list(), created: createdIds };
      opSet(sess.sid, 'break', args.op_id, result);
      return result;
    }
    if (action === 'remove') {
      const spec = args.spec === undefined || args.spec === null ? '' : String(args.spec);
      if (!spec) throw err('E_INVALID_ARG', 'break action=remove requires spec', 'pass the breakpoint id from break action=list');
      const byId = /^\d+$/.test(spec.trim()) ? Number(spec.trim()) : null;
      const target = byId !== null ? byId : (sess.breakpoints.find((b) => b.spec === spec) || {}).id;
      if (target === undefined || target === null) {
        throw err('E_NO_SESSION', `breakpoint "${spec}" not found`, 'break action=list to see ids');
      }
      await exec(sess, `-break-delete ${target}`, 5000).catch((e) => { throw gdbError(e, 'E_INVALID_ARG', 'break action=list to see ids'); });
      sess.breakpoints = sess.breakpoints.filter((b) => b.id !== target);
      const result = list();
      opSet(sess.sid, 'break', args.op_id, result);
      return result;
    }
    if (action === 'list') {
      try {
        const res = await exec(sess, '-break-list', 5000);
        const body = res && res.results && res.results.BreakpointTable ? res.results.BreakpointTable.body || [] : [];
        sess.breakpoints = body
          .map((row) => parseBreakpoint(row && row.bkpt))
          .filter(Boolean)
          .map((b) => ({ ...b, owner: (sess.breakpoints.find((x) => x.id === b.id) || {}).owner }));
      } catch { /* keep cached list */ }
      return list();
    }
    if (action === 'enable' || action === 'disable') {
      const spec = args.spec === undefined || args.spec === null ? '' : String(args.spec);
      if (!spec) throw err('E_INVALID_ARG', `break action=${action} requires spec`, 'pass the breakpoint id');
      const id = Number(spec);
      if (!Number.isFinite(id)) throw err('E_INVALID_ARG', `"${spec}" is not a breakpoint id`, 'break action=list shows ids');
      await exec(sess, `-break-${action} ${id}`, 5000).catch((e) => { throw gdbError(e, 'E_INVALID_ARG'); });
      const bp = sess.breakpoints.find((b) => b.id === id);
      if (bp) bp.enabled = action === 'enable';
      const result = list();
      opSet(sess.sid, 'break', args.op_id, result);
      return result;
    }
    throw err('E_INVALID_ARG', `unknown break action "${action}"`, 'set/remove/list/enable/disable');
  }

  // ---------------------------------------------------------------- inspect

  function paginate(items, { count, cursor } = {}) {
    const size = Number.isFinite(Number(count)) && Number(count) > 0 ? Number(count) : PAGE_DEFAULT;
    const offset = Number.isFinite(Number(cursor)) && Number(cursor) > 0 ? Number(cursor) : 0;
    const slice = items.slice(offset, offset + size);
    const more = offset + size < items.length;
    return {
      items: slice,
      ...(more ? { next: offset + size, has_more: true } : { has_more: false }),
    };
  }

  function unsupported(what, hint) {
    return err('E_SERVER_UNSUPPORTED', `inspect what="${what}" is not supported in v1`, hint || 'use what=frames/vars/registers/threads/memory/disasm/source/symbols');
  }

  // ------------------------------------------------------------- RTOS bridge
  // The FreeRTOS walker works purely through MI, so no gdb Python is required.
  function rtosIo(sess) {
    const evalValue = async (expr) => {
      const res = await exec(sess, `-data-evaluate-expression ${quoteMi(expr)}`, 5000);
      return res && res.results ? res.results.value : undefined;
    };
    const parseAddr = (value) => {
      if (value === undefined || value === null) throw err('E_RTOS_NOT_FOUND', `cannot evaluate ${value}`, 'build with debug symbols');
      const m = String(value).match(/0x[0-9a-fA-F]+/);
      if (!m) throw err('E_RTOS_NOT_FOUND', `not an address: ${value}`, 'build with debug symbols');
      return Number.parseInt(m[0], 16);
    };
    return {
      async symbol(name) {
        return parseAddr(await evalValue(`&${name}`));
      },
      async evalInt(expr) {
        const v = await evalValue(expr);
        const n = Number.parseInt(String(v), 10);
        if (!Number.isFinite(n)) throw err('E_RTOS_WALK', `cannot evaluate ${expr}: ${v}`);
        return n;
      },
      async readMemory(addr, len) {
        const res = await exec(sess, `-data-read-memory-bytes 0x${Number(addr).toString(16)} ${len}`, 5000);
        const mem = res && res.results ? res.results.memory : null;
        if (!mem) throw err('E_RTOS_WALK', `memory read failed at 0x${Number(addr).toString(16)}`);
        const entries = Array.isArray(mem) ? mem : [mem];
        const hex = entries.map((e) => e && e.contents ? e.contents : '').join('');
        return Buffer.from(hex, 'hex');
      },
    };
  }

  async function maybeDetectRtos(sess) {
    if (!sess.profileDef || !sess.profileDef.rtos || sess.profileDef.rtos === 'none') return null;
    try {
      const r = await listRtosTasks(rtosIo(sess), { cap: 5 });
      sess.rtosInfo = r.rtos;
      return r;
    } catch {
      return null;
    }
  }

  // ------------------------------------------------------- thread-aware views

  async function threadInfo(sess) {
    const res = await exec(sess, '-thread-info', 8000);
    return {
      current: Number(res && res.results ? res.results['current-thread-id'] : NaN),
      threads: (res && res.results && res.results.threads) || [],
    };
  }

  async function withThread(sess, threadId, fn) {
    const id = Number(threadId);
    if (!Number.isFinite(id) || id <= 0) return fn();
    const { current } = await threadInfo(sess).catch(() => ({ current: NaN }));
    await exec(sess, `-thread-select ${id}`, 4000);
    try {
      return await fn();
    } finally {
      if (Number.isFinite(current) && current !== id) {
        try { await exec(sess, `-thread-select ${current}`, 4000); } catch { /* best effort */ }
      }
    }
  }

  async function readFrames(sess) {
    const res = await exec(sess, '-stack-list-frames', 8000);
    const stack = (res && res.results && res.results.stack) || [];
    return stack.map((entry) => {
      const f = entry.frame || {};
      return {
        i: Number(f.level) || 0,
        fn: f.func || '??',
        ...(f.file ? { file: relPath(sess, f.fullname || f.file) } : {}),
        ...(Number.isFinite(Number(f.line)) ? { line: Number(f.line) } : {}),
        pc: f.addr || '0x0',
      };
    });
  }

  async function readMemoryBytes(sess, addr, len) {
    const res = await exec(sess, `-data-read-memory-bytes 0x${Number(addr).toString(16)} ${len}`, 5000);
    const mem = res && res.results ? res.results.memory : null;
    if (!mem) throw err('E_RTOS_WALK', `cannot read memory at 0x${Number(addr).toString(16)}`);
    const entries = Array.isArray(mem) ? mem : [mem];
    return Buffer.from(entries.map((e) => (e && e.contents ? e.contents : '')).join(''), 'hex');
  }

  async function readRegister(sess, name) {
    try {
      const res = await exec(sess, `-data-evaluate-expression ${quoteMi('$' + name)}`, 4000);
      const v = res && res.results ? String(res.results.value || '') : '';
      const m = v.match(/0x[0-9a-fA-F]+/);
      return m ? m[0] : null;
    } catch {
      return null;
    }
  }

  /** Snapshot all core registers by name (reliable for lr/r7/r11 where `$lr` expressions may fail). */
  async function registerSnapshot(sess) {
    const namesRes = await exec(sess, '-data-list-register-names', 5000);
    const valuesRes = await exec(sess, '-data-list-register-values x', 5000);
    const names = (namesRes && namesRes.results && namesRes.results['register-names']) || [];
    const values = (valuesRes && valuesRes.results && valuesRes.results['register-values']) || [];
    const byName = new Map();
    for (const v of values) {
      const name = names[Number(v.number)];
      if (name) byName.set(String(name), { name: String(name), value: String(v.value ?? '') });
    }
    return byName;
  }

  async function setRegister(sess, name, value) {
    await exec(sess, `-interpreter-exec console ${quoteMi(`set $${name}=${value}`)}`, 4000);
  }

  /**
   * Plan B fallback: switch GDB registers to the TCB's saved Cortex-M3 context,
   * collect a backtrace, then restore the original registers.
   */
  async function unwindFromTcb(sess, task) {
    if (!task || !task.sp) {
      throw err('E_RTOS_STACK', `task ${task && task.name ? task.name : '?'} has no saved stack pointer`, 'use the OpenOCD FreeRTOS plugin (profile.openocd_rtos) for thread-aware stacks');
    }
    if (sess.state !== 'stopped') throw err('E_NOT_STOPPED', 'target must be stopped to unwind a task stack', 'run action=pause/restart first');
    const top = Number.parseInt(task.sp, 16);
    const buf = await readMemoryBytes(sess, top, 64);
    const ctx = decodeCortexM3Context(buf);
    if (!ctx.pc) throw err('E_RTOS_STACK', `task ${task.name} has an empty saved PC`, 'the task may never have run or the TCB layout is unsupported');
    const snapshot = await registerSnapshot(sess);
    const pick = (...names) => names.map((n) => snapshot.get(n)).find(Boolean) || null;
    const saved = {
      sp: pick('sp'),
      pc: pick('pc'),
      lr: pick('lr', 'r14'),
      r7: pick('r7'),
      r11: pick('r11'),
    };
    log?.debug?.(`tcb-unwind ${task.name}: saved=${JSON.stringify(saved)} ctx.pc=0x${ctx.pc.toString(16)} ctx.lr=0x${(ctx.lr >>> 0).toString(16)}`);
    try {
      await setRegister(sess, 'sp', `0x${(top + 64).toString(16)}`);
      await setRegister(sess, 'pc', `0x${ctx.pc.toString(16)}`);
      await setRegister(sess, 'lr', `0x${(ctx.lr >>> 0).toString(16)}`);
      await setRegister(sess, 'r7', `0x${ctx.r7.toString(16)}`);
      await setRegister(sess, 'r11', `0x${ctx.r11.toString(16)}`);
      const frames = await readFrames(sess);
      return { frames, source: 'tcb-unwind', confidence: 'medium', layout: 'cortex-m3' };
    } finally {
      // Restore the full core context: writing pc/sp can invalidate GDB's cached registers,
      // so only restoring the five we touched is not enough.
      const CORE = new Set([...Array.from({ length: 13 }, (_, i) => `r${i}`), 'sp', 'lr', 'pc', 'xpsr']);
      for (const reg of snapshot.values()) {
        if (!CORE.has(reg.name)) continue;
        try {
          await setRegister(sess, reg.name === 'lr' ? 'r14' : reg.name, reg.value);
        } catch (e) {
          log?.warn?.(`tcb-unwind ${task.name}: restore $${reg.name} failed: ${e && e.message}`);
        }
      }
    }
  }

  async function inspect(args = {}, ctx = {}) {    const sess = getSession(args, ctx);
    const what = typeof args.what === 'string' ? args.what : '';
    if (!what) throw err('E_INVALID_ARG', 'inspect requires what', 'e.g. frames, vars, registers, memory, disasm');
    const pageOpts = { count: args.count, cursor: args.cursor };
    const base = { ok: true, sid: sess.sid, what };

    switch (what) {
      case 'frames': {
        const items = args.thread
          ? await withThread(sess, args.thread, () => readFrames(sess))
          : await readFrames(sess);
        return { ...base, ...paginate(items, pageOpts) };
      }
      case 'vars':
      case 'args': {
        const frame = Number.isFinite(Number(args.frame)) ? Number(args.frame) : null;
        const command = what === 'args'
          ? `-stack-list-arguments 1${frame !== null ? ` ${frame} ${frame}` : ''}`
          : '-stack-list-variables --simple-values';
        const res = await exec(sess, command, 8000);
        let raw = [];
        if (what === 'args') {
          const stackArgs = (res && res.results && res.results['stack-args']) || [];
          raw = stackArgs.flatMap((entry) => entry.args || []);
        } else {
          raw = (res && res.results && res.results.variables) || [];
        }
        const items = raw.map((v) => ({
          name: String(v.name ?? '?'),
          value: clampText(v.value ?? '<optimized out>', 400),
          ...(v.type ? { type: String(v.type) } : {}),
        }));
        return { ...base, ...paginate(items, pageOpts) };
      }
      case 'registers': {
        const namesRes = await exec(sess, '-data-list-register-names', 8000);
        const valuesRes = await exec(sess, '-data-list-register-values x', 8000);
        const names = (namesRes && namesRes.results && namesRes.results['register-names']) || [];
        const values = (valuesRes && valuesRes.results && valuesRes.results['register-values']) || [];
        const items = values
          .map((v) => ({
            name: names[Number(v.number)] || `r${v.number}`,
            value: String(v.value ?? ''),
          }))
          .filter((it) => it.name && it.value);
        return { ...base, ...paginate(items, { ...pageOpts, count: args.count == null ? 32 : args.count }) };
      }
      case 'threads': {
        const res = await exec(sess, '-thread-info', 8000);
        const threads = (res && res.results && res.results.threads) || [];
        const items = threads.map((t) => {
          const f = t.frame || {};
          return {
            id: Number(t.id),
            ...(t.name ? { name: String(t.name) } : {}),
            ...(t.state ? { state: String(t.state) } : {}),
            ...(f.func || f.file
              ? {
                  frame: {
                    fn: f.func || '??',
                    ...(f.file ? { file: relPath(sess, f.fullname || f.file) } : {}),
                    ...(Number.isFinite(Number(f.line)) ? { line: Number(f.line) } : {}),
                    pc: f.addr || '0x0',
                  },
                }
              : {}),
          };
        });
        return { ...base, ...paginate(items, pageOpts) };
      }
      case 'memory': {
        const addr = args.addr ? String(args.addr) : '';
        if (!addr) throw err('E_INVALID_ARG', 'inspect what=memory requires addr', 'e.g. addr=0x20000000 range=64');
        const count = Number(args.range) > 0 ? Number(args.range) : 64;
        const res = await exec(sess, `-data-read-memory-bytes ${addr} ${count}`, 8000);
        const memory = (res && res.results && res.results.memory) || [];
        const items = memory.map((m) => ({ addr: m.begin || addr, hex: String(m.contents || '') }));
        return { ...base, ...paginate(items, pageOpts) };
      }
      case 'disasm': {
        const count = Number(args.count) > 0 ? Math.min(Number(args.count), 128) : PAGE_DEFAULT;
        let cmd;
        const range = args.range ? String(args.range).trim() : '';
        if (range) {
          const m = range.match(/^(0x[0-9a-f]+|\d+)\s*(?:-|\.\.|,|:)\s*(0x[0-9a-f]+|\d+)$/i);
          if (!m) throw err('E_INVALID_ARG', `invalid range "${range}"`, 'use range="0x08000000-0x08000040"');
          cmd = `-data-disassemble -s ${m[1]} -e ${m[2]} -- 0`;
        } else {
          const addr = args.addr ? String(args.addr) : (sess.lastStop && sess.lastStop.frame && sess.lastStop.frame.addr);
          if (!addr) throw err('E_INVALID_ARG', 'inspect what=disasm requires addr or range', 'e.g. addr="0x0800002c" count=20, or range="0x08000000-0x08000040"');
          const start = Number.parseInt(addr, 0);
          if (!Number.isFinite(start)) throw err('E_INVALID_ARG', `invalid addr "${addr}"`, 'pass a numeric address like 0x0800002c');
          const end = start + Math.max(1, count) * 4;
          cmd = `-data-disassemble -s 0x${start.toString(16)} -e 0x${end.toString(16)} -- 0`;
        }
        const res = await exec(sess, cmd, 10000);
        const asm = (res && res.results && (res.results.asm_insns || res.results.asm_insn)) || [];
        const items = asm.map((insn) => ({
          addr: insn.address || '0x0',
          insn: String(insn.inst || ''),
          ...(insn['func-name'] ? { fn: String(insn['func-name']) } : {}),
          ...(insn.file ? { src: `${relPath(sess, insn.fullname || insn.file)}:${insn.line}` } : {}),
        })).slice(0, count);
        return { ...base, ...paginate(items, { count, cursor: 0 }) };
      }
      case 'source': {
        const target = args.path || (sess.lastStop && (sess.lastStop.frame || {}).fullname) || null;
        if (!target) throw err('E_INVALID_ARG', 'inspect what=source requires path', 'pass path=src/main.c (or stop somewhere first)');
        if (!sess.symbols || typeof sess.symbols.sourceLines !== 'function') {
          throw err('E_SYMBOL_NOT_FOUND', `source is unavailable for ${target}`, 'load symbols by passing program/symbols to open');
        }
        const stopFrame = (sess.lastStop && sess.lastStop.frame) || {};
        const sameFile = stopFrame.fullname === target || stopFrame.file === target;
        const line = Number.isFinite(Number(args.range)) && Number(args.range) > 0
          ? Number(args.range)
          : Number.isFinite(Number(args.frame)) && Number(args.frame) > 0
            ? Number(args.frame)
            : sameFile && Number.isFinite(Number(stopFrame.line))
              ? Number(stopFrame.line)
              : 1;
        const src = await sess.symbols.sourceLines(String(target), line, Number(args.count) || 3);
        if (src && src.ok === false) {
          const e = src.error || {};
          throw err(e.code || 'E_SYMBOL_NOT_FOUND', e.message || `source is unavailable for ${target}`, e.hint || '');
        }
        const lines = (src && src.lines) || [];
        const from = Number(src && src.from) || Math.max(1, line);
        const items = lines.map((text, i) => ({ line: from + i, text }));
        return { ...base, ...paginate(items, pageOpts) };
      }
      case 'symbols': {
        const key = args.name || args.addr;
        if (!key) throw err('E_INVALID_ARG', 'inspect what=symbols requires name or addr', 'e.g. name=pxCurrentTCB');
        if (!sess.symbols || typeof sess.symbols.lookup !== 'function') {
          throw err('E_SYMBOL_NOT_FOUND', 'symbol table is not loaded', 'pass program/symbols to open');
        }
        const found = await sess.symbols.lookup(String(key));
        if (found && found.ok === false) {
          const e = found.error || {};
          throw err(e.code || 'E_SYMBOL_NOT_FOUND', e.message || `symbol "${key}" not found`, e.hint || '');
        }
        const symbol = found
          ? {
              ...found,
              ...(Number.isFinite(Number(found.addr)) ? { addr: `0x${Number(found.addr).toString(16)}` } : {}),
            }
          : null;
        return { ...base, symbol };
      }
      case 'globals':
        throw unsupported('globals', 'read a global by name with inspect what=symbols, or eval with the symbol name');
      case 'modules':
        throw unsupported('modules', 'embedded targets load one image per session; inspect what=symbols shows the loaded image');
      case 'rtos': {
        const kind = args.kind || 'tasks';
        if (!['tasks', 'stacks'].includes(kind)) {
          throw unsupported('rtos', 'v1 supports kind="tasks" and kind="stacks"; queues/mutexes/timers/heap come in P2');
        }
        try {
          const cap = Number(args.count) || (config.rtos && config.rtos.task_cap) || 20;
          const ti = await threadInfo(sess).catch(() => ({ threads: [], current: NaN }));
          const threadsByName = new Map();
          for (const t of ti.threads) {
            if (t && t.name) threadsByName.set(String(t.name), Number(t.id));
          }
          if (kind === 'tasks') {
            const r = await listRtosTasks(rtosIo(sess), { cap, includeSp: true });
            sess.rtosInfo = r.rtos;
            const tasks = r.tasks.map((t) => ({
              ...t,
              ...(threadsByName.has(t.name) ? { thread: threadsByName.get(t.name) } : {}),
            }));
            const running = tasks.filter((t) => t.state === 'running').length;
            const blocked = tasks.filter((t) => t.state === 'blocked').length;
            return {
              ok: true, sid: sess.sid, what: 'rtos', kind,
              rtos: r.rtos,
              summary: `${r.count} task(s): ${running} running, ${blocked} blocked` + (threadsByName.size ? `; ${threadsByName.size} GDB thread(s)` : '; daemon TCB walker'),
              tasks, count: r.count, has_more: r.has_more, warnings: r.warnings || [],
            };
          }
          // kind === 'stacks': per-task call stack (Plan A via GDB RTOS threads, Plan B via TCB unwind)
          const want = args.task || args.name;
          if (!want) throw err('E_INVALID_ARG', 'inspect what=rtos kind=stacks requires task', 'pass task="wind_spd" (see kind=tasks for names)');
          const r = await listRtosTasks(rtosIo(sess), { cap: 64, includeSp: true });
          const task = r.tasks.find((t) => t.name === want || t.id === want);
          if (!task) throw err('E_INVALID_ARG', `task "${want}" not found`, `known tasks: ${r.tasks.map((t) => t.name).join(', ')}`);
          let frames;
          let source;
          let confidence;
          if (task.current) {
            frames = await readFrames(sess);
            source = 'current-task';
            confidence = 'high';
          } else {
            const tid = threadsByName.get(task.name);
            if (tid) {
              frames = await withThread(sess, tid, () => readFrames(sess));
              source = 'gdb-thread';
              confidence = 'high';
            } else {
              const unwound = await unwindFromTcb(sess, task);
              frames = unwound.frames;
              source = unwound.source;
              confidence = unwound.confidence;
            }
          }
          return {
            ok: true, sid: sess.sid, what: 'rtos', kind: 'stacks',
            task: { name: task.name, state: task.state, prio: task.prio, thread: threadsByName.get(task.name) || null },
            frames, source, confidence,
            ...(frames.length ? {} : { warnings: ['no frames returned (optimized code or unsupported unwinding)'] }),
          };
        } catch (e) {
          throw err(e.code || 'E_RTOS_WALK', e.message || 'RTOS walk failed', e.hint || 'inspect what=symbols and ensure the RTOS build has debug symbols');
        }
      }
      case 'fault': {
        try {
          const fault = await readFaultStatus(rtosIo(sess));
          return { ok: true, sid: sess.sid, what: 'fault', fault };
        } catch (e) {
          throw err(e.code || 'E_RTOS_WALK', e.message || 'fault read failed', e.hint || 'target may not be a Cortex-M');
        }
      }
      default:
        throw err('E_INVALID_ARG', `unknown inspect what "${what}"`, 'frames/vars/args/registers/threads/memory/disasm/source/symbols');
    }
  }

  // ------------------------------------------------------------------- eval

  const EVAL_FORBIDDEN = /\b(call|set\s+\w+|set\s*\{|set\s*\()/i;

  async function evaluate(args = {}, ctx = {}) {
    const sess = getSession(args, ctx);
    ensureShare(sess, ctx);
    let rawExprs = args.exprs;
    // Some MCP hosts stringify array-like anyOf schemas; accept a JSON array string defensively.
    if (typeof rawExprs === 'string' && /^\s*\[/.test(rawExprs)) {
      try { rawExprs = JSON.parse(rawExprs); } catch { /* keep the string as a single expression */ }
    }
    const exprs = toArray(rawExprs).map(String).filter((e) => e.length > 0);
    if (exprs.length === 0) throw err('E_INVALID_ARG', 'eval requires exprs', 'exprs="x" or exprs=["x","y"]');
    if (exprs.length > 32) throw err('E_INVALID_ARG', 'eval accepts at most 32 expressions', 'split into batches');
    const allowCall = Boolean(config.daemon && config.daemon.allow_eval_call);
    const results = [];
    for (const expr of exprs) {
      if (!allowCall && EVAL_FORBIDDEN.test(expr)) {
        throw err('E_ATTACH_DENIED', `eval refuses "${expr}" (call/set)`, 'calling functions or writing memory is disabled; set daemon.allow_eval_call=true to allow');
      }
      const res = await exec(sess, `-data-evaluate-expression ${quoteMi(expr)}`, 8000).catch((e) => {
        throw gdbError(e, 'E_INVALID_ARG', 'check the expression against the current frame; use inspect what=vars for names');
      });
      const value = res && res.results ? res.results.value : undefined;
      results.push({ expr, value: clampText(value === undefined ? '<unavailable>' : value, 400) });
    }
    touch(sess);
    return { ok: true, sid: sess.sid, results };
  }

  // ----------------------------------------------------------------- output

  async function output(args = {}, ctx = {}) {
    const sess = getSession(args, ctx);
    const after = Number(args.after) || 0;
    const limit = Number.isFinite(Number(args.limit)) && Number(args.limit) > 0 ? Number(args.limit) : OUTPUT_PAGE_DEFAULT;
    const streams = typeof args.streams === 'string' && args.streams !== 'all' ? args.streams : null;
    const filter = args.filter ? String(args.filter).toLowerCase() : null;
    const selected = sess.output.filter(
      (line) =>
        line.seq > after
        && (!streams || line.stream === streams)
        && (!filter || line.text.toLowerCase().includes(filter)),
    );
    const slice = selected.slice(0, limit);
    const next = slice.length ? slice[slice.length - 1].seq : after;
    return {
      ok: true,
      sid: sess.sid,
      lines: slice.map((line) => ({ seq: line.seq, stream: line.stream, text: clampText(line.text, 2000) })),
      next,
      has_more: selected.length > slice.length,
    };
  }

  // ---------------------------------------------------------------- sessions

  async function listSessions(args = {}, ctx = {}) {
    const action = typeof args.action === 'string' ? args.action : 'list';
    if (action === 'status') {
      const sess = getSession(args, ctx);
      return { ok: true, session: summary(sess) };
    }
    if (action !== 'list') throw err('E_INVALID_ARG', `unknown sessions action "${action}"`, 'list|status');
    const all = args.all === true;
    const rows = [...sessions.values()].filter((s) => visible(s, ctx, all)).map(summary);
    return { ok: true, sessions: rows };
  }

  // ------------------------------------------------------------- session_ctl

  async function sessionCtl(args = {}, ctx = {}) {
    const action = typeof args.action === 'string' ? args.action : '';
    if (!['close', 'lock', 'unlock'].includes(action)) {
      throw err('E_INVALID_ARG', `unknown session_ctl action "${action}"`, 'close|lock|unlock');
    }
    const sess = getSession(args, ctx);
    if (action === 'close') {
      if (sess.owner.clientId !== ctx.clientId) {
        throw err('E_SESSION_BUSY', `session ${sess.sid} belongs to another client`, 'ask its owner to close it');
      }
      const kill = args.kill === true;
      const state = sess.state;
      await teardown(sess, { kill });
      return { ok: true, sid: sess.sid, action, state: state === 'exited' ? 'exited' : 'exited' };
    }
    if (action === 'lock') {
      const force = args.force === true;
      if (sess.share === 'observer') throw err('E_INVALID_ARG', 'observer sessions have no control lease', 'open with share=exclusive|shared');
      if (sess.lease && sess.lease.holder !== ctx.clientId && !force) {
        throw err('E_LEASE_HELD', `control lease is held by ${sess.lease.holder}`, 'pass force=true only when that client is gone');
      }
      sess.lease = { holder: ctx.clientId, expiresAt: now() + LEASE_TTL_MS };
      touch(sess);
      return { ok: true, sid: sess.sid, action, lease: { ...sess.lease } };
    }
    if (sess.lease && sess.lease.holder !== ctx.clientId) {
      throw err('E_LEASE_HELD', `control lease is held by ${sess.lease.holder}`, 'only the holder can unlock');
    }
    sess.lease = null;
    touch(sess);
    return { ok: true, sid: sess.sid, action, lease: null };
  }

  // -------------------------------------------------------------------- raw

  const RAW_ALLOW = /^(info|p\b|print\b|x\b|bt\b|backtrace|thread|frame|list\b|disassemble|disas\b|monitor|ptype|whatis|show\b|maintenance\s+info|echo\b)/i;
  const RAW_DENY = /(^|\s)(shell|!|\||source|define)(\s|$)|startup-with-shell|set\s+exec-wrapper|gdb-set/i;

  async function raw(args = {}, ctx = {}) {
    if (!daemonCfg.allow_raw) {
      throw err('E_RAW_DISABLED', 'raw console access is disabled', 'set daemon.allow_raw=true in the user config (~/.dbghub/config.json) to enable the allowlist');
    }
    const sess = getSession(args, ctx);
    ensureShare(sess, ctx);
    const cmd = args.cmd ? String(args.cmd).trim() : '';
    if (!cmd) throw err('E_INVALID_ARG', 'raw requires cmd', 'e.g. cmd="info registers"');
    if (RAW_DENY.test(cmd) || !RAW_ALLOW.test(cmd)) {
      throw err('E_ATTACH_DENIED', `raw command is not allowed: ${cmd}`, 'allowed prefixes: info/print/x/bt/thread/frame/list/disassemble/monitor/ptype/whatis/show');
    }
    const cached = opGet(sess.sid, 'raw', args.op_id);
    if (cached) return cached;
    const res = await execConsole(sess, cmd, 15000).catch((e) => { throw gdbError(e, 'E_INVALID_ARG', 'check the command against the allowlist'); });
    const results = (res && res.results) || {};
    const text = results.console || results.value || (res && res.class === 'done' ? '' : JSON.stringify(results));
    const capped = clampText(String(text || ''), OUTPUT_CAP_BYTES);
    const result = { ok: true, sid: sess.sid, output: capped };
    if (capped.length < String(text || '').length) result.truncated = true;
    opSet(sess.sid, 'raw', args.op_id, result);
    return result;
  }

  // --------------------------------------------------------------- discover

  async function discover(args = {}, ctx = {}) {
    const action = typeof args.action === 'string' ? args.action : 'list';
    const warnings = [];
    let probes = [];
    let backends = [];
    let toolchains = [];
    let issues;
    let targets = [];
    try {
      const foundTargets = await discoverTargets({ env: process.env });
      targets = foundTargets.targets || [];
      if (Array.isArray(foundTargets.warnings)) warnings.push(...foundTargets.warnings);
    } catch (e) {
      warnings.push(`target discovery failed: ${e && e.message ? e.message : e}`);
    }
    // Declared endpoints from profiles (e.g. renode :3333) are always worth surfacing.
    for (const [name, p] of Object.entries(config.profiles || {})) {
      const endpoint = p && (p.endpoint || p.target_port);
      if (!endpoint) continue;
      const ep = String(endpoint).includes(':') ? String(endpoint) : `127.0.0.1:${endpoint}`;
      if (!targets.some((t) => t.endpoint === ep)) {
        targets.push({ endpoint: ep, host: ep.split(':')[0], port: Number(ep.split(':').pop()), process: null, pid: null, role: 'gdb', confidence: 'declared', source: 'profile', profile: name });
      }
    }
    if (probeManager && typeof probeManager.discoverProbes === 'function') {
      try {
        const found = await probeManager.discoverProbes({ scan: action === 'scan' });
        probes = (found && found.probes) || [];
        if (found && Array.isArray(found.warnings)) warnings.push(...found.warnings);
      } catch (e) {
        warnings.push(`probe discovery failed: ${e && e.message ? e.message : e}`);
      }
    }
    if (probeManager && typeof probeManager.listBackends === 'function') {
      try {
        backends = (await probeManager.listBackends({})) || [];
      } catch (e) {
        warnings.push(`backend discovery failed: ${e && e.message ? e.message : e}`);
      }
    }
    if (action === 'doctor' && probeManager && typeof probeManager.doctor === 'function') {
      try {
        const doc = await probeManager.doctor({ profile: args.profile });
        probes = doc.probes || probes;
        toolchains = doc.toolchains || toolchains;
        backends = doc.backends || backends;
        issues = doc.issues || [];
      } catch (e) {
        warnings.push(`doctor failed: ${e && e.message ? e.message : e}`);
      }
    }
    const profiles = Object.entries(config.profiles || {}).map(([name, p]) => ({
      name,
      adapter: p.adapter || 'gdbmi',
      gdb: p.gdb || null,
      target: p.target || null,
      endpoint: p.endpoint || null,
      probe: p.probe || null,
      backend: p.backend || null,
    }));
    if (!probes.length && targets.length) {
      const hints = targets.slice(0, 4).map((t) => `${t.endpoint}${t.process ? ` (${t.process}, ${t.role})` : ` (${t.role})`}`);
      warnings.push(`no probes detected, but running debug target(s) found: ${hints.join(', ')}; use open(profile=..., target=<endpoint>)`);
    }
    const result = {
      ok: true,
      daemon: {
        version: VERSION,
        proto: PROTO,
        pid: process.pid,
        mode: daemonInfo.mode || 'daemon',
        socket: daemonInfo.socket || null,
      },
      probes,
      profiles,
      backends,
      toolchains,
      targets,
      warnings,
    };
    if (action === 'doctor') result.issues = issues || [];
    if (action === 'plan') {
      if (probeManager && typeof probeManager.plan === 'function') {
        try {
          result.plan = await probeManager.plan({
            probes,
            profiles: config.profiles || {},
            profile: args.profile,
            probe: args.probe,
            backend: args.backend,
          });
        } catch (e) {
          warnings.push(`plan failed: ${e && e.message ? e.message : e}`);
        }
      } else {
        warnings.push('plan is unavailable: probe manager is not configured');
      }
    }
    return result;
  }

  // -------------------------------------------------------------- teardown

  async function teardown(sess, { kill = false, keepRecord = false } = {}) {
    const gdb = sess.gdb;
    sess.gdb = null;
    try { sess.detachEvents?.(); } catch { /* ignore */ }
    if (gdb) {
      try {
        if (kill && typeof gdb.kill === 'function') await gdb.kill();
        else if (typeof gdb.close === 'function') await gdb.close();
      } catch (e) {
        log?.warn?.(`gdb close failed for ${sess.sid}: ${e && e.message}`);
      }
    }
    const backend = sess.backend;
    sess.backend = null;
    if (backend && typeof backend.stop === 'function') {
      try { await backend.stop(); } catch (e) { log?.warn?.(`backend stop failed for ${sess.sid}: ${e && e.message}`); }
    }
    releaseLocks(sess);
    setState(sess, 'exited');
    pushEvent(sess, { type: 'exited', reason: kill ? 'killed' : 'closed' });
    for (const waiter of [...sess.waiters]) {
      sess.waiters.delete(waiter);
      clearTimeout(waiter.timer);
      waiter.resolve(null);
    }
    if (!keepRecord) sessions.delete(sess.sid);
  }

  async function closeAll() {
    for (const sess of [...sessions.values()]) {
      try { await teardown(sess, { kill: true }); } catch (e) { log?.warn?.(`closeAll: ${e && e.message}`); }
    }
    sessions.clear();
    probeOwners.clear();
    resourceOwners.clear();
    opCache.clear();
  }

  // ---------------------------------------------------------------- handlers

  function handler(fn) {
    return async (params = {}, ctx = {}) => {
      const safeCtx = {
        clientId: ctx.clientId || 'local',
        workspace: ctx.workspace || workspace,
        ...ctx,
      };
      try {
        return await fn(params || {}, safeCtx);
      } catch (e) {
        return fail(e);
      }
    };
  }

  const handlers = {
    discover: handler(discover),
    sessions: handler(listSessions),
    session_ctl: handler(sessionCtl),
    open: handler(open),
    run: handler(run),
    wait: handler(wait),
    state: handler(state),
    break: handler(brk),
    inspect: handler(inspect),
    eval: handler(evaluate),
    output: handler(output),
    raw: handler(raw),
  };

  return {
    handlers,
    discover,
    sessions: listSessions,
    sessionCtl,
    open,
    run,
    wait,
    state,
    break: brk,
    inspect,
    eval: evaluate,
    output,
    raw,
    closeAll,
    get sessionCount() {
      return sessions.size;
    },
    getSessions: () => [...sessions.values()].map(summary),
    getSessionBySid: (sid) => sessions.get(sid) || null,
  };
}

export { VERSION as DAEMON_VERSION, PROTO as DAEMON_PROTO };
