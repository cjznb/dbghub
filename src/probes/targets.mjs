/**
 * Best-effort discovery of already-running debug targets (GDB stubs / monitors).
 *
 * Motivation: an agent asked to "debug the running target" has no idea which port holds
 * a GDB stub. `discover` used to list only probes/profiles; this module surfaces listening
 * debug-related processes with role hints (gdb/monitor/telnet) so the agent can pick an
 * endpoint instead of shelling out to netstat itself.
 *
 * This is advisory: no protocol handshake is performed (a Renode monitor port would answer
 * TCP but not GDB RSP). Roles are inferred from known process/port conventions.
 */
import { spawnCapture } from '../backends/childproc.mjs';

const PROCESS_RE = /(renode|openocd|jlink|j-?link|qemu|pyocd|st-util|stlink|gdbserver|openocd-esp32)/i;
const COMMON_GDB_PORTS = new Set([3333, 3334, 3331, 2331, 2332, 4242, 5000, 5001, 9000]);
const KNOWN_ROLES = {
  renode: { 1234: 'monitor', 3333: 'gdb' },
  openocd: { 3333: 'gdb', 3334: 'gdb', 4444: 'telnet', 4445: 'telnet', 6666: 'tcl', 6667: 'tcl' },
  jlink: { 2331: 'gdb', 2332: 'swo', 2333: 'telnet' },
  'st-util': { 4242: 'gdb' },
  stlink: { 4242: 'gdb' },
  pyocd: { 3333: 'gdb' },
  qemu: {},
};

function looksLikeGdbProcess(proc) {
  return Boolean(proc && PROCESS_RE.test(proc));
}

function roleFor(proc, port) {
  const key = String(proc || '').toLowerCase().replace(/\.exe$/, '');
  const table = KNOWN_ROLES[key];
  if (table && table[port]) return table[port];
  if (looksLikeGdbProcess(proc)) {
    if (port === 3333 || port === 3334 || port === 2331 || port === 4242) return 'gdb';
    if (key.includes('renode') && port === 1234) return 'monitor';
    return 'unknown';
  }
  return 'unknown';
}

function normalizeHost(host) {
  let h = String(host || '').replace(/^\[|\]$/g, '').replace(/^::ffff:/, '');
  if (!h || h === '0.0.0.0' || h === '::' || h === '*') h = '127.0.0.1';
  return h;
}

/** @returns {Array<{endpoint,host,port,process,pid,role,confidence,source}>} */
export function parseWindowsListings(netstatText, tasklistText = '') {
  const names = new Map();
  for (const line of String(tasklistText || '').split(/\r?\n/)) {
    const m = line.match(/^"([^"]+)","(\d+)"/);
    if (m) names.set(Number(m[2]), m[1]);
  }
  const out = [];
  for (const line of String(netstatText || '').split(/\r?\n/)) {
    const m = line.match(/^\s*TCP\s+(?:\[([^\]]+)\]|([^:\s]+)):(\d+)\s+\S+\s+LISTENING\s+(\d+)/i);
    if (!m) continue;
    const host = normalizeHost(m[1] || m[2] || '127.0.0.1');
    const port = Number(m[3]);
    const pid = Number(m[4]);
    const proc = names.get(pid) || null;
    if (!looksLikeGdbProcess(proc) && !COMMON_GDB_PORTS.has(port)) continue;
    out.push({
      endpoint: `${host}:${port}`,
      host,
      port,
      process: proc,
      pid,
      role: roleFor(proc, port),
      confidence: looksLikeGdbProcess(proc) ? 'process' : 'port',
      source: 'process',
    });
  }
  return out;
}

/** Linux `ss -ltnp` (falls back to `ss -ltn` without process names). */
export function parseSsListings(ssText) {
  const out = [];
  for (const line of String(ssText || '').split(/\r?\n/)) {
    const m = line.match(/LISTEN\s+\d+\s+\d+\s+(\S+):(\d+)\s+\S+\s+(.*)$/i);
    if (!m) continue;
    const host = normalizeHost(m[1]);
    const port = Number(m[2]);
    const rest = m[3] || '';
    const pm = rest.match(/users:\(\("([^"]+)",pid=(\d+)/);
    const proc = pm ? pm[1] : null;
    const pid = pm ? Number(pm[2]) : null;
    if (!looksLikeGdbProcess(proc) && !COMMON_GDB_PORTS.has(port)) continue;
    out.push({
      endpoint: `${host}:${port}`,
      host,
      port,
      process: proc,
      pid,
      role: roleFor(proc, port),
      confidence: looksLikeGdbProcess(proc) ? 'process' : 'port',
      source: 'process',
    });
  }
  return out;
}

/** macOS `lsof -nP -iTCP -sTCP:LISTEN`. */
export function parseLsofListings(lsofText) {
  const out = [];
  for (const line of String(lsofText || '').split(/\r?\n/)) {
    const m = line.match(/^(\S+)\s+(\d+)\s+.*?\bTCP\s+(\S+):(\d+)\s+\(LISTEN\)/i);
    if (!m) continue;
    const proc = m[1];
    const pid = Number(m[2]);
    const host = normalizeHost(m[3]);
    const port = Number(m[4]);
    if (!looksLikeGdbProcess(proc) && !COMMON_GDB_PORTS.has(port)) continue;
    out.push({
      endpoint: `${host}:${port}`,
      host,
      port,
      process: proc,
      pid,
      role: roleFor(proc, port),
      confidence: looksLikeGdbProcess(proc) ? 'process' : 'port',
      source: 'process',
    });
  }
  return out;
}

async function runText(run, command, args, timeoutMs) {
  const r = await run({ command, args, timeoutMs });
  if (!r || r.spawnError || r.timedOut) return { text: '', error: r && (r.spawnError || (r.timedOut ? 'timeout' : null)) };
  return { text: String(r.output || ''), error: null };
}

/**
 * Discover listening debugger endpoints. Never throws; returns warnings on failure.
 * @param {{run?:Function, platform?:string, env?:object}} opts
 */
export async function discoverTargets({ run = spawnCapture, platform = process.platform, env = process.env } = {}) {
  const warnings = [];
  const targets = [];
  try {
    if (platform === 'win32') {
      const netstat = await runText(run, 'netstat', ['-ano', '-p', 'tcp'], 5000);
      const tasklist = await runText(run, 'tasklist', ['/fo', 'csv', '/nh'], 5000);
      if (netstat.error) warnings.push(`target scan: netstat failed (${netstat.error})`);
      if (tasklist.error) warnings.push(`target scan: tasklist failed (${tasklist.error})`);
      targets.push(...parseWindowsListings(netstat.text, tasklist.text));
    } else if (platform === 'linux') {
      let ss = await runText(run, 'ss', ['-ltnp'], 5000);
      if (!ss.text.trim()) ss = await runText(run, 'ss', ['-ltn'], 5000);
      if (ss.error) warnings.push(`target scan: ss failed (${ss.error})`);
      targets.push(...parseSsListings(ss.text));
    } else if (platform === 'darwin') {
      const lsof = await runText(run, 'lsof', ['-nP', '-iTCP', '-sTCP:LISTEN'], 5000);
      if (lsof.error) warnings.push(`target scan: lsof failed (${lsof.error})`);
      targets.push(...parseLsofListings(lsof.text));
    }
  } catch (e) {
    warnings.push(`target scan failed: ${e && e.message ? e.message : e}`);
  }

  const seen = new Set();
  const deduped = [];
  for (const t of targets) {
    const key = t.endpoint;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(t);
  }
  deduped.sort((a, b) => (a.role === 'gdb' ? -1 : 0) - (b.role === 'gdb' ? -1 : 0) || a.port - b.port);
  return { targets: deduped, warnings };
}
