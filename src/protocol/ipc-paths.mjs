/**
 * IPC endpoint discovery shared by the daemon, the MCP shim and `doctor`.
 *
 * Socket priority (design.md §3.3):
 *   1) DBGHUB_SOCKET
 *   2) Windows: \\.\pipe\dbghub-<user>; Unix: $XDG_RUNTIME_DIR/dbghub.sock (else ~/.cache/dbghub/)
 *   3) loopback TCP + token recorded in daemon.json (fallback)
 * daemon.json lives in the runtime dir and is discovery only — the socket bind is the lock.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DAEMON_JSON_NAME = 'daemon.json';
export const PROTO = 1;

export function safeUserName(env = process.env) {
  const raw = env.USERNAME || env.USER || env.LOGNAME || (safe(() => os.userInfo().username) ?? 'user');
  return String(raw || 'user').toLowerCase().replace(/[^a-z0-9_.-]/g, '-').slice(0, 40) || 'user';
}

export function runtimeDir({ env = process.env, platform = process.platform } = {}) {
  if (platform === 'win32') {
    const base = env.LOCALAPPDATA || path.join(env.USERPROFILE || os.homedir(), 'AppData', 'Local');
    return path.join(base, 'dbghub', 'run');
  }
  if (env.XDG_RUNTIME_DIR) return path.join(env.XDG_RUNTIME_DIR, 'dbghub');
  return path.join(env.HOME || os.homedir(), '.cache', 'dbghub');
}

export function defaultSocketPath({ env = process.env, platform = process.platform, user } = {}) {
  if (env.DBGHUB_SOCKET) return env.DBGHUB_SOCKET;
  if (platform === 'win32') {
    const who = user
      ? String(user).toLowerCase().replace(/[^a-z0-9_.-]/g, '-').slice(0, 40)
      : safeUserName(env);
    return `\\\\.\\pipe\\dbghub-${who || 'user'}`;
  }
  return path.join(runtimeDir({ env, platform }), 'dbghub.sock');
}

export function daemonJsonPath({ env = process.env, platform = process.platform } = {}) {
  return path.join(runtimeDir({ env, platform }), DAEMON_JSON_NAME);
}

export function readDaemonInfo({ env = process.env, platform = process.platform } = {}) {
  const file = daemonJsonPath({ env, platform });
  try {
    const info = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!info || typeof info !== 'object') return null;
    return info;
  } catch {
    return null;
  }
}

export function writeDaemonInfo(info, { env = process.env, platform = process.platform } = {}) {
  const file = daemonJsonPath({ env, platform });
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(info, null, 0));
  try {
    fs.renameSync(tmp, file);
  } catch {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    fs.writeFileSync(file, JSON.stringify(info, null, 0));
  }
  return file;
}

export function removeDaemonInfo({ env = process.env, platform = process.platform } = {}) {
  const file = daemonJsonPath({ env, platform });
  try { fs.unlinkSync(file); } catch { /* ignore */ }
}

/** True when `pid` looks alive (EPERM counts as alive: exists, other account). */
export function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return Boolean(e && e.code === 'EPERM');
  }
}

/**
 * Classify an endpoint spec: `tcp://host:port` (loopback fallback), a Windows pipe name, or a Unix
 * socket path. Parsing lives here so daemon and client can never disagree about the transport.
 */
export function parseEndpoint(spec) {
  const raw = String(spec || '');
  if (raw.startsWith('tcp://')) {
    const rest = raw.slice('tcp://'.length);
    const idx = rest.lastIndexOf(':');
    const host = idx > 0 ? rest.slice(0, idx) : '127.0.0.1';
    const port = idx > 0 ? Number(rest.slice(idx + 1)) : NaN;
    return { kind: 'tcp', host: host || '127.0.0.1', port: Number.isFinite(port) ? port : 0, spec: raw };
  }
  if (raw.startsWith('\\\\.\\pipe\\')) return { kind: 'pipe', path: raw, spec: raw };
  return { kind: 'unix', path: raw, spec: raw };
}

/** Unix only: drop a stale socket file left by a crashed daemon. Never touches Windows pipes. */
export function removeStaleSocketFile(socketPath, platform = process.platform) {
  if (platform === 'win32' || !socketPath || socketPath.startsWith('\\\\.\\pipe\\') || socketPath.startsWith('tcp://')) return false;
  try {
    fs.unlinkSync(socketPath);
    return true;
  } catch {
    return false;
  }
}

function safe(fn) {
  try { return fn(); } catch { return undefined; }
}
