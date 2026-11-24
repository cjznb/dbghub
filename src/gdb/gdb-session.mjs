/**
 * GDB/MI session: one gdb child process, serial command queue, token-matched
 * results, asynchronous events.
 *
 * See docs/dev-interfaces.md section A for the public API. Summary:
 *
 *   const s = new GdbSession({ gdbPath, args, cwd, env, program, log });
 *   await s.start();
 *   await s.loadProgram('app.elf');
 *   await s.selectRemote('localhost:3333');
 *   await s.exec('-break-insert main');
 *   await s.exec('-exec-continue');          // resolves at ^running
 *   const stop = await s.waitForStop();      // resolves at *stopped
 *   await s.interrupt();                     // out-of-band -exec-interrupt --all
 *   await s.close();                         // idempotent
 *
 * Events:
 *   'stop'     StopEvent
 *   'output'   { stream:'console'|'target'|'log', text }
 *   'exit'     { code, signal }              (gdb process exited)
 *   'error'    Error                         (transport/spawn failures only)
 *   'record'   MiRecord                      (every parsed MI record)
 *   'progress' { section?, size?, total?, raw }   (+download, additive)
 *   'stderr'   { text }                      (gdb stderr line, additive)
 *
 * StopEvent:
 *   { reason, reasonKind, threadId, frame:{level,addr,func,file?,fullname?,line?,
 *     arch?,from?,args?}|null, bkptno?, signal?, signalMeaning?, disp?, exitCode?, raw }
 *
 * Contract details / known deviations:
 *  - `reason` is GDB's raw reason ("breakpoint-hit", "end-stepping-range",
 *    "signal-received", "exited-normally", ...); `reasonKind` is the normalized
 *    value StopCard needs (breakpoint|step|signal|watchpoint|entry|pause|exited|unknown).
 *  - On `*stopped` with reason="exited*" the session status becomes 'exited' and
 *    `frame` is null (GDB sends no frame for an exit stop).
 *  - `^error` rejects with an Error whose `message` is GDB's `msg` (single line,
 *    no MI rewrite) and whose `miError` carries {msg, code?, class, command,
 *    token, results, raw}. Timeouts reject with code 'E_TIMEOUT' and
 *    `miError.timeout === true`; the command's late reply is ignored.
 *  - Transport failures (spawn error, gdb death) use codes E_SPAWN / E_GDB_EXIT;
 *    closing rejects in-flight work with E_CLOSED.
 *  - `program` is auto-loaded with `-file-exec-and-symbols` at the end of
 *    start() unless `loadOnStart:false` is passed.
 *  - Fully non-blocking: commands run one at a time, but interrupt() bypasses
 *    the queue and is written to gdb immediately.
 *  - Nothing is ever written to stdout; diagnostics go to the optional `log`
 *    object ({debug,info,warn,error}) and the in-memory stderr tail.
 *  - Stdio transport: `session.stdioMode` is 'pipe' normally. Inside Windows
 *    sandboxes that deny pipe creation, src/gdb/gdb-spawner.mjs falls back to a
 *    PowerShell-hosted relay and the mode is 'relay' (same API, same events).
 *  - `loadProgram(path)` is idempotent: repeating the same path is a no-op, so
 *    callers may pass `program` in the constructor and still call loadProgram.
 */
import { EventEmitter } from 'node:events';
import { MiStreamParser } from './mi-parser.mjs';
import { GdbSpawner } from './gdb-spawner.mjs';
import { quoteMi } from '../util/text.mjs';

const STOP = Object.freeze({
  BREAKPOINT: 'breakpoint-hit',
  STEP: 'end-stepping-range',
  SIGNAL: 'signal-received',
});

function makeError(code, message, fields = {}) {
  const e = new Error(message);
  e.code = code;
  Object.assign(e, fields);
  return e;
}

function toInt(value, fallback = undefined) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/** Normalize a MI frame tuple into the documented StopEvent.frame shape. */
export function normalizeFrame(frame) {
  if (!frame || typeof frame !== 'object') return null;
  const out = {
    level: toInt(frame.level, 0),
    addr: typeof frame.addr === 'string' ? frame.addr : '',
    func: typeof frame.func === 'string' ? frame.func : '',
  };
  if (frame.file !== undefined) out.file = frame.file;
  if (frame.fullname !== undefined) out.fullname = frame.fullname;
  if (frame.line !== undefined) out.line = toInt(frame.line, undefined);
  if (frame.arch !== undefined) out.arch = frame.arch;
  if (frame.from !== undefined) out.from = frame.from;
  if (frame.args !== undefined) out.args = frame.args;
  return out;
}

/** Map a raw MI stop reason onto the StopCard reason vocabulary. */
export function classifyStopReason(reason) {
  switch (reason) {
    case 'breakpoint-hit':
    case 'hw-breakpoint-hit':
      return 'breakpoint';
    case 'watchpoint-trigger':
    case 'read-watchpoint-trigger':
    case 'access-watchpoint-trigger':
    case 'watchpoint-scope':
      return 'watchpoint';
    case 'end-stepping-range':
    case 'function-finished':
    case 'location-reached':
      return 'step';
    case 'signal-received':
      return 'signal';
    case 'exited':
    case 'exited-normally':
    case 'exited-signalled':
      return 'exited';
    case 'solib-event':
    case 'fork':
    case 'vfork':
    case 'exec':
      return 'entry';
    case 'pause':
      return 'pause';
    default:
      return 'unknown';
  }
}

export class GdbSession extends EventEmitter {
  constructor({
    gdbPath = 'gdb',
    args = [],
    cwd = undefined,
    env = undefined,
    program = null,
    log = null,
    spawn = null,
    spawner = null,
    argv = null,
    pwshPath = process.env.DBGHUB_PWSH || 'pwsh',
    relayScriptPath = undefined,
    preferPipe = true,
    interpreter = 'mi3',
    windowsHide = true,
    startTimeoutMs = 10000,
    defaultTimeoutMs = 15000,
    connectTimeoutMs = 15000,
    interruptTimeoutMs = 5000,
    exitGraceMs = 2000,
    stderrTailLines = 200,
    loadOnStart = true,
  } = {}) {
    super();
    this.gdbPath = gdbPath;
    this.args = Array.isArray(args) ? args : [args];
    this.cwd = cwd;
    this.env = env;
    this.program = program;
    this.log = log;
    // Deterministic tests inject a plain spawn(); production uses GdbSpawner
    // (pipe first, PowerShell relay fallback when the sandbox blocks pipes).
    if (typeof spawn === 'function') {
      this._spawner = {
        stdioMode: 'pipe',
        spawn: async (file, argv, opts) => spawn(file, argv, opts),
      };
    } else if (spawner) {
      this._spawner = spawner;
    } else {
      this._spawner = new GdbSpawner({ pwshPath, relayScriptPath, preferPipe, log });
    }
    this._loadedProgram = null;
    this._programResult = null;
    this.interpreter = interpreter;
    // argv null => ['--interpreter=<interpreter>', '-q', ...args]. A custom
    // argv is used by tests that run a fake-gdb script through node.
    this.argv = argv;
    this.windowsHide = windowsHide;
    this.startTimeoutMs = startTimeoutMs;
    this.defaultTimeoutMs = defaultTimeoutMs;
    this.connectTimeoutMs = connectTimeoutMs;
    this.interruptTimeoutMs = interruptTimeoutMs;
    this.exitGraceMs = exitGraceMs;
    this.stderrTailLines = stderrTailLines;
    this.loadOnStart = loadOnStart && Boolean(program);

    this._parser = new MiStreamParser();
    this._child = null;
    this._stdin = null;
    this._status = 'closed';
    this._started = false;
    this._starting = null;
    this._closing = false;
    this._closePromise = null;
    this._token = 0;
    this._pending = new Map();
    this._rawTokens = new Set();
    this._abandoned = new Set();
    this._queue = Promise.resolve();
    this._lastStop = null;
    this._stopWaiters = new Set();
    this._ready = false;
    this._readyWaiters = new Set();
    this._stderr = [];
    this._exit = null;
    this._readyDegraded = false;
  }

  // ---------------------------------------------------------------- getters

  get status() {
    return this._status;
  }

  get lastStop() {
    return this._lastStop;
  }

  get stderrTail() {
    return this._stderr.slice();
  }

  get pid() {
    return this._child && typeof this._child.pid === 'number' ? this._child.pid : null;
  }

  /** How stdio is wired to gdb: 'pipe' normally, 'relay' in a Windows sandbox. */
  get stdioMode() {
    if (this._child && this._child.stdioMode) return this._child.stdioMode;
    return this._spawner && this._spawner.stdioMode ? this._spawner.stdioMode : 'pipe';
  }

  /** Last `{code,signal}` observed for the gdb process, or null. */
  get exitInfo() {
    return this._exit;
  }

  /** True when start() timed out waiting for gdb's first output but the child lived. */
  get readyDegraded() {
    return this._readyDegraded;
  }

  // --------------------------------------------------------------- lifecycle

  async start() {
    if (this._started) return this;
    if (this._starting) return this._starting;
    this._starting = this._doStart().catch((e) => {
      this._starting = null;
      throw e;
    });
    return this._starting;
  }

  async _doStart() {
    const argv = this.argv ? this.argv.slice() : [`--interpreter=${this.interpreter}`, '-q', ...this.args];
    let child;
    try {
      child = await this._spawner.spawn(this.gdbPath, argv, {
        cwd: this.cwd,
        env: this.env ? { ...process.env, ...this.env } : process.env,
        windowsHide: this.windowsHide,
        shell: false,
      });
    } catch (e) {
      if (e && e.code === 'E_SPAWN') throw e;
      throw makeError('E_SPAWN', `failed to start gdb (${this.gdbPath}): ${e && e.message ? e.message : e}`, {
        hint: 'Check the gdb path and permissions.',
        miError: { spawn: true, gdbPath: this.gdbPath, argv },
      });
    }
    this._child = child;
    this._stdin = child.stdin;
    this._status = 'stopped';

    if (child.stdout) {
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => this._onStdout(chunk));
      child.stdout.on('error', (e) => this._reportError(e));
    }
    if (child.stderr) {
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk) => this._onStderr(chunk));
      child.stderr.on('error', (e) => this._reportError(e));
    }
    if (child.stdin) child.stdin.on('error', (e) => this._reportError(e));
    child.on('error', (e) => this._onChildError(e));
    child.on('exit', (code, signal) => this._onChildExit(code, signal));

    await this._waitReady(this.startTimeoutMs);
    this._started = true;
    if (this.loadOnStart && this.program) await this.loadProgram(this.program);
    return this;
  }

  /** Close gdb. Idempotent; never throws for an already closed session. */
  async close() {
    if (this._closePromise) return this._closePromise;
    this._closePromise = this._doClose().catch((e) => {
      this.log?.warn?.('close() failed', { error: e && e.message });
    });
    return this._closePromise;
  }

  async _doClose() {
    if (this._status === 'closed') return;
    this._closing = true;
    this._rejectPending(makeError('E_CLOSED', 'gdb session is closing', { miError: { closed: true } }));
    this._rejectStopWaiters(makeError('E_CLOSED', 'gdb session is closing', { miError: { closed: true } }));
    this._rejectReadyWaiters(makeError('E_CLOSED', 'gdb session is closing', { miError: { closed: true } }));
    const child = this._child;
    if (child && this._stdin && !this._stdin.destroyed && child.exitCode === null) {
      try { await this._write('-gdb-exit'); } catch { /* best effort */ }
      try { this._stdin.end(); } catch { /* ignore */ }
      if (!child.killed) await this._waitChildExit(child, this.exitGraceMs);
    }
    try { this._stdin?.destroy(); } catch { /* ignore */ }
    this._status = 'closed';
    this._closing = false;
  }

  _waitChildExit(child, graceMs) {
    if (child.exitCode !== null) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* ignore */ }
        resolve();
      }, graceMs);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
    });
  }

  // ---------------------------------------------------------------- commands

  /**
   * Run one MI command (must include the leading '-', e.g. '-exec-continue'),
   * serialized behind previous commands. Resolves at the matching result record
   * with { class, results, token }. Rejects on ^error or timeout.
   */
  async exec(command, { timeoutMs = this.defaultTimeoutMs } = {}) {
    this._assertUsable();
    return this._enqueue(() => {
      this._assertUsable();
      return this._sendAndWait(command, timeoutMs);
    });
  }

  /** Write an MI command without waiting for its result (out-of-band). */
  async execRaw(command) {
    this._assertUsable();
    const { line, token } = this._newTokenLine(command);
    this._rawTokens.add(token);
    await this._write(line);
  }

  /** Load a program/symbol file: `-file-exec-and-symbols "<path>"`. Idempotent. */
  async loadProgram(programPath) {
    if (!programPath || typeof programPath !== 'string') {
      throw makeError('E_INVALID_ARG', 'loadProgram() needs a program path', { hint: 'Pass the .elf/.axf path.' });
    }
    if (this._loadedProgram === programPath && this._programResult) return this._programResult;
    const result = await this.exec(`-file-exec-and-symbols ${quoteMi(programPath)}`);
    this._loadedProgram = programPath;
    this._programResult = result;
    return result;
  }

  /**
   * Select a remote target: `-target-select extended-remote <host:port>`.
   * GDB's MI target-select does NOT accept quoting around the address (the
   * quotes would become part of the host name), so the address is validated
   * against a conservative character set instead of being quoted.
   */
  async selectRemote(hostPort, { timeoutMs = this.connectTimeoutMs } = {}) {
    if (!hostPort || typeof hostPort !== 'string') {
      throw makeError('E_INVALID_ARG', 'selectRemote() needs "host:port"', { hint: 'Example: "localhost:3333".' });
    }
    if (!/^[A-Za-z0-9.:_\-\[\]]+$/.test(hostPort)) {
      throw makeError('E_INVALID_ARG', `invalid remote address for selectRemote(): ${JSON.stringify(hostPort)}`, {
        hint: 'Use host:port with letters, digits, ".", ":", "_", "-" or "[]" only (e.g. "127.0.0.1:3333").',
      });
    }
    return this.exec(`-target-select extended-remote ${hostPort}`, { timeoutMs });
  }

  /**
   * Out-of-band interrupt (`-exec-interrupt --all`), never queued behind a
   * pending -exec-continue. "Not running" errors are treated as a no-op so
   * pause is idempotent; timeouts still surface as E_TIMEOUT.
   */
  async interrupt() {
    this._assertUsable();
    try {
      await this._sendAndWait('-exec-interrupt --all', this.interruptTimeoutMs);
    } catch (e) {
      if (e && e.code === 'E_TIMEOUT') throw e;
      if (e && e.miError && e.miError.class === 'error') return; // already stopped
      throw e;
    }
  }

  /**
   * Resolve with the next StopEvent. If the session is already stopped (or a
   * stop is already buffered), resolves immediately with `lastStop`.
   */
  async waitForStop({ timeoutMs = 20000 } = {}) {
    if (this._lastStop && (this._status === 'stopped' || this._status === 'exited')) return this._lastStop;
    if (this._status === 'closed' || this._closing) {
      throw makeError('E_CLOSED', 'gdb session is closed', { miError: { closed: true } });
    }
    return new Promise((resolve, reject) => {
      const waiter = { resolve: null, reject, timer: null };
      waiter.timer = setTimeout(() => {
        if (!this._stopWaiters.delete(waiter)) return;
        reject(makeError('E_TIMEOUT', `no stop event within ${timeoutMs}ms`, {
          miError: { timeout: true, timeoutMs },
        }));
      }, timeoutMs);
      waiter.resolve = (stop) => {
        clearTimeout(waiter.timer);
        this._stopWaiters.delete(waiter);
        resolve(stop);
      };
      this._stopWaiters.add(waiter);
    });
  }

  // --------------------------------------------------------------- internals

  _assertUsable() {
    if (this._status === 'closed' || this._closing) {
      throw makeError('E_CLOSED', 'gdb session is closed', { miError: { closed: true } });
    }
    if (!this._started) {
      throw makeError('E_NOT_STARTED', 'gdb session has not been started', { hint: 'await session.start() first.' });
    }
  }

  _newTokenLine(command) {
    if (typeof command !== 'string' || command.length === 0) {
      throw makeError('E_INVALID_ARG', 'MI command must be a non-empty string', { hint: 'Example: "-break-insert main".' });
    }
    if (/[\r\n]/.test(command)) {
      throw makeError('E_INVALID_ARG', 'MI command must not contain newlines', {
        hint: 'Pass one MI command per exec() call.',
      });
    }
    const token = ++this._token;
    return { token, line: `${token}${command}` };
  }

  _sendAndWait(command, timeoutMs) {
    const { token, line } = this._newTokenLine(command);
    const result = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this._pending.delete(token)) return;
        // Late reply (if any) must not be mistaken for a command result.
        this._abandoned.add(token);
        reject(makeError('E_TIMEOUT', `GDB/MI command timed out after ${timeoutMs}ms: ${command}`, {
          miError: { timeout: true, command, token, timeoutMs },
          hint: 'The command may still complete; call waitForStop() or interrupt().',
        }));
      }, timeoutMs);
      this._pending.set(token, {
        token,
        command,
        timer,
        resolve: (out) => { clearTimeout(timer); resolve(out); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
    });
    return this._write(line).then(() => result, (e) => {
      const pending = this._pending.get(token);
      if (pending) {
        clearTimeout(pending.timer);
        this._pending.delete(token);
        pending.reject(e);
      }
      result.catch(() => undefined);
      throw e;
    });
  }

  _enqueue(fn) {
    const run = () => Promise.resolve().then(fn);
    const next = this._queue.then(run, run);
    this._queue = next.then(() => undefined, () => undefined);
    return next;
  }

  _write(line) {
    return new Promise((resolve, reject) => {
      const stdin = this._stdin;
      if (!stdin || stdin.destroyed || !this._child || this._child.exitCode !== null) {
        reject(makeError('E_CLOSED', 'gdb stdin is not available', { miError: { closed: true } }));
        return;
      }
      try {
        stdin.write(line + '\n', 'utf8', (err) => {
          if (err) reject(this._writeError(err));
          else resolve();
        });
      } catch (e) {
        reject(this._writeError(e));
      }
    });
  }

  _writeError(e) {
    if (e && e.code === 'EPIPE') {
      return makeError('E_GDB_EXIT', 'gdb process is no longer running', { miError: { write: true, code: e.code } });
    }
    return makeError('E_IO', `failed to write to gdb: ${e && e.message ? e.message : e}`, {
      miError: { write: true, code: e && e.code },
    });
  }

  _assertNotClosing() {
    return this._status !== 'closed' && !this._closing;
  }

  // ------------------------------------------------------------- MI plumbing

  _onStdout(chunk) {
    if (!this._assertNotClosing()) return;
    let records;
    try {
      records = this._parser.feed(chunk);
    } catch (e) {
      this._reportError(makeError('E_MI_PARSE', `MI parse failure: ${e && e.message ? e.message : e}`, {
        miError: { parse: true },
      }));
      return;
    }
    for (const rec of records) {
      try {
        this._handleRecord(rec);
      } catch (e) {
        this._reportError(e);
      }
    }
  }

  _handleRecord(rec) {
    this._safeEmit('record', rec);
    if (rec.kind === 'prompt') {
      this._markReady();
      return;
    }
    this._markReady();
    switch (rec.kind) {
      case 'console':
        this._safeEmit('output', { stream: 'console', text: rec.text });
        return;
      case 'target':
        this._safeEmit('output', { stream: 'target', text: rec.text });
        return;
      case 'log':
        this._safeEmit('output', { stream: 'log', text: rec.text });
        return;
      case 'result':
        this._onResult(rec);
        return;
      case 'exec':
        this._onExec(rec);
        return;
      case 'notify':
        this._onNotify(rec);
        return;
      case 'status':
        this._onStatus(rec);
        return;
      default:
        return;
    }
  }

  _onResult(rec) {
    const token = rec.token;
    if (rec.class === 'error') {
      const miErr = {
        msg: rec.results && typeof rec.results.msg === 'string' ? rec.results.msg : 'GDB/MI command failed',
        code: rec.results && rec.results.code,
        class: 'error',
        token,
        results: rec.results || {},
        raw: rec.raw,
      };
      const pending = token !== undefined ? this._pending.get(token) : null;
      if (pending) {
        this._pending.delete(token);
        miErr.command = pending.command;
        pending.reject(makeError('E_GDB_MI', miErr.msg, { miError: miErr }));
        return;
      }
      if (this._abandoned.delete(token)) return;
      if (this._rawTokens.delete(token)) return;
      // Asynchronous ^error without a matching request: surface it.
      this._reportError(makeError('E_GDB_MI', miErr.msg, { miError: miErr }));
      return;
    }
    if (rec.class === 'exit') {
      if (this._status !== 'closed') this._status = 'exited';
    } else if (rec.class === 'running') {
      if (this._status !== 'closed') this._status = 'running';
    }
    this._settleResult(rec);
  }

  _onExec(rec) {
    if (rec.class === 'running') {
      if (this._status !== 'closed') this._status = 'running';
      return;
    }
    if (rec.class === 'stopped') {
      const stop = this._buildStop(rec);
      this._lastStop = stop;
      if (stop.reasonKind === 'exited') this._status = 'exited';
      else if (this._status !== 'closed') this._status = 'stopped';
      this._resolveStopWaiters(stop);
      this._safeEmit('stop', stop);
    }
  }

  _onNotify() {
    // thread-created/exited, library-loaded, cmd-param-changed, ... are emitted
    // through 'record'; they never complete a command.
  }

  _onStatus(rec) {
    if (rec.class !== 'download') return;
    const results = rec.results || {};
    const sections = Array.isArray(results._positional) ? results._positional : [];
    const section = sections.length > 0 && sections[0] && typeof sections[0] === 'object' ? sections[0] : null;
    this._safeEmit('progress', {
      section: section && section.section,
      size: section && section['section-size'] !== undefined ? toInt(section['section-size'], undefined) : undefined,
      total: results['total-size'] !== undefined ? toInt(results['total-size'], undefined) : undefined,
      raw: rec,
    });
  }

  _buildStop(rec) {
    const r = rec.results || {};
    const reason = typeof r.reason === 'string' ? r.reason : 'unknown';
    const stop = {
      reason,
      reasonKind: classifyStopReason(reason),
      threadId: toInt(r['thread-id'], 0),
      frame: normalizeFrame(r.frame),
      bkptno: toInt(r.bkptno !== undefined ? r.bkptno : r.bkpt && r.bkpt.number, undefined),
      raw: rec,
    };
    const signal = r['signal-name'] !== undefined ? r['signal-name'] : undefined;
    if (signal !== undefined) stop.signal = signal;
    if (r['signal-meaning'] !== undefined) stop.signalMeaning = r['signal-meaning'];
    const disp = r.disp !== undefined ? r.disp : r.bkpt && r.bkpt.disp;
    if (disp !== undefined) stop.disp = disp;
    if (r['exit-code'] !== undefined) stop.exitCode = r['exit-code'];
    if (r['stopped-threads'] !== undefined) stop.stoppedThreads = r['stopped-threads'];
    if (r.core !== undefined) stop.core = r.core;
    return stop;
  }

  _settleResult(rec) {
    const token = rec.token;
    if (token !== undefined) {
      if (this._abandoned.delete(token)) return; // late reply to a timed-out command
      if (this._rawTokens.delete(token)) return; // execRaw() reply
      const pending = this._pending.get(token);
      if (pending) {
        this._pending.delete(token);
        pending.resolve({ class: rec.class, results: rec.results || {}, token, raw: rec.raw });
        return;
      }
    }
    // Result record with no waiter: informational only ('record' already fired).
  }

  _onStderr(chunk) {
    const text = String(chunk);
    const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
    for (const line of lines) {
      this._stderr.push(line);
      if (this._stderr.length > this.stderrTailLines) this._stderr.shift();
      this.log?.warn?.('gdb stderr', { line });
      this._safeEmit('stderr', { text: line });
    }
  }

  _onChildError(e) {
    const err = e && e.code && e.miError
      ? e
      : makeError('E_SPAWN', `gdb process error: ${e && e.message ? e.message : e}`, {
        miError: { spawn: true, code: e && e.code, gdbPath: this.gdbPath },
        hint: 'Check the gdb path and permissions.',
      });
    this._rejectReadyWaiters(err);
    this._rejectPending(err);
    this._reportError(err);
  }

  _onChildExit(code, signal) {
    this._exit = { code, signal };
    if (this._status !== 'closed') this._status = 'exited';
    this._rejectReadyWaiters(makeError('E_GDB_EXIT', 'gdb exited before it became ready', {
      miError: { exit: true, code, signal },
    }));
    this._rejectPending(makeError('E_GDB_EXIT', `gdb exited (code=${code}${signal ? `, signal=${signal}` : ''})`, {
      miError: { exit: true, code, signal },
    }));
    this._rejectStopWaiters(makeError('E_GDB_EXIT', 'gdb exited while waiting for a stop event', {
      miError: { exit: true, code, signal },
    }));
    this._safeEmit('exit', { code, signal });
  }

  // ---------------------------------------------------------------- waiters

  _markReady() {
    if (this._ready) return;
    this._ready = true;
    for (const w of this._readyWaiters) {
      clearTimeout(w.timer);
      w.resolve();
    }
    this._readyWaiters.clear();
  }

  _waitReady(timeoutMs) {
    if (this._ready) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const waiter = { resolve: null, reject, timer: null };
      waiter.timer = setTimeout(() => {
        if (!this._readyWaiters.delete(waiter)) return;
        if (this._child && this._child.exitCode === null && this._status !== 'closed') {
          // gdb is alive but quiet: better a usable degraded session than a hard failure.
          this._readyDegraded = true;
          this.log?.warn?.('gdb produced no output before start timeout; continuing', { timeoutMs });
          resolve();
          return;
        }
        reject(makeError('E_GDB_START', `gdb did not become ready within ${timeoutMs}ms`, {
          hint: 'Check the gdb path/arguments; try running gdb --interpreter=mi3 manually.',
          miError: { start: true, timeoutMs },
        }));
      }, timeoutMs);
      waiter.resolve = () => {
        clearTimeout(waiter.timer);
        this._readyWaiters.delete(waiter);
        resolve();
      };
      this._readyWaiters.add(waiter);
    });
  }

  _rejectReadyWaiters(err) {
    for (const w of this._readyWaiters) {
      clearTimeout(w.timer);
      w.reject(err);
    }
    this._readyWaiters.clear();
  }

  _resolveStopWaiters(stop) {
    for (const w of this._stopWaiters) {
      clearTimeout(w.timer);
      w.resolve(stop);
    }
    this._stopWaiters.clear();
  }

  _rejectStopWaiters(err) {
    for (const w of this._stopWaiters) {
      clearTimeout(w.timer);
      w.reject(err);
    }
    this._stopWaiters.clear();
  }

  _rejectPending(err) {
    for (const [, pending] of this._pending) {
      clearTimeout(pending.timer);
      pending.reject(err);
    }
    this._pending.clear();
    this._abandoned.clear();
    this._rawTokens.clear();
  }

  _reportError(err) {
    this.log?.error?.(err && err.message ? err.message : String(err));
    if (this.listenerCount('error') > 0) this._safeEmit('error', err);
  }

  _safeEmit(name, payload) {
    try {
      this.emit(name, payload);
    } catch (e) {
      this.log?.error?.(`listener for '${name}' threw`, { error: e && e.message });
    }
  }
}
