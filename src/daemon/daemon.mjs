/**
 * The dbghub daemon: one NDJSON net server (Windows named pipe / Unix socket), a method table
 * supplied by the session manager, idle-exit and graceful shutdown. This module never writes
 * to stdout — in `--daemon` mode stdout must stay silent so a supervising host sees no noise.
 */
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { err, toErrorPayload } from '../util/errors.mjs';
import { removeStaleSocketFile, parseEndpoint, PROTO } from '../protocol/ipc-paths.mjs';

const DEFAULT_IDLE_CHECK_MS = 5000;
const MAX_REQUEST_BYTES = 8 * 1024 * 1024;

function isPipe(socketPath) {
  return typeof socketPath === 'string' && socketPath.startsWith('\\\\.\\pipe\\');
}

function formatRemote(address, port) {
  if (!address) return null;
  const host = String(address).replace(/^::ffff:/, '');
  return port ? `${host}:${port}` : host;
}

/**
 * Start the daemon server.
 *
 * @param {{
 *   socketPath: string,
 *   handlers: Record<string, (params:object, ctx:{clientId:string,remote?:string,pid?:number})=>Promise<any>|any>,
 *   idleExitMin?: number,        // minutes without sessions/requests before exit; 0 disables
 *   hasActiveSessions?: () => number,
 *   token?: string|null,         // required for loopback TCP connections
 *   log?: object,
 *   idleCheckMs?: number,
 *   onIdle?: () => Promise<void>|void,
 * }} opts
 * @returns {Promise<{server: net.Server, socketPath: string, close: (why?:string)=>Promise<void>,
 *                    whenClosed: Promise<void>, address: () => any, stats: () => object}>}
 */
export async function runDaemon({
  socketPath,
  handlers,
  idleExitMin = 0,
  hasActiveSessions = () => 0,
  token = null,
  log = null,
  idleCheckMs = DEFAULT_IDLE_CHECK_MS,
  onIdle = null,
} = {}) {
  if (!socketPath) throw err('E_INVALID_ARG', 'socketPath is required to run the daemon');
  if (!handlers || typeof handlers !== 'object') throw err('E_INVALID_ARG', 'handlers table is required');

  const endpoint = parseEndpoint(socketPath);
  const kind = endpoint.kind;
  const connections = new Set();
  let activeRequests = 0;
  let lastActivityAt = Date.now();
  let closed = false;
  let idleTimer = null;
  let resolveClosed;
  const whenClosed = new Promise((resolve) => { resolveClosed = resolve; });
  const nextClientId = { value: 0 };
  const stats = { connections: 0, requests: 0, errors: 0, startedAt: Date.now() };

  const server = net.createServer((socket) => {
    if (closed) { socket.destroy(); return; }
    connections.add(socket);
    stats.connections += 1;
    lastActivityAt = Date.now();
    const clientId = `c${++nextClientId.value}`;
    const ctx = {
      clientId,
      remote: kind === 'pipe' ? 'pipe' : formatRemote(socket.remoteAddress, socket.remotePort),
      isTcp: kind === 'tcp',
    };
    let authed = token === null || kind !== 'tcp';
    let buffer = '';
    let chain = Promise.resolve();

    socket.setNoDelay?.(true);
    socket.on('error', () => { /* close handled below */ });
    socket.on('close', () => {
      connections.delete(socket);
      lastActivityAt = Date.now();
    });

    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      if (buffer.length > MAX_REQUEST_BYTES) {
        buffer = '';
        writeLine(socket, { id: null, ok: false, error: toErrorPayload(err('E_INVALID_ARG', 'request line too large')) });
        return;
      }
      for (;;) {
        const idx = buffer.indexOf('\n');
        if (idx < 0) break;
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        chain = chain.then(() => dispatchLine(line)).catch(() => {});
      }
    });

    async function dispatchLine(line) {
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        writeLine(socket, { id: null, ok: false, error: { code: 'E_INVALID_ARG', message: 'invalid JSON line' } });
        return;
      }
      if (!msg || typeof msg !== 'object' || typeof msg.method !== 'string') {
        writeLine(socket, { id: msg && msg.id !== undefined ? msg.id : null, ok: false, error: { code: 'E_INVALID_ARG', message: 'method is required' } });
        return;
      }
      lastActivityAt = Date.now();
      const id = msg.id ?? null;
      if (msg.method === 'hello') {
        const given = msg.params && msg.params.token;
        if (kind === 'tcp' && token !== null) {
          if (given !== token) {
            writeLine(socket, { id, ok: false, error: toErrorPayload(err('E_ATTACH_DENIED', 'daemon token mismatch', 'read the token from daemon.json')) });
            socket.destroy();
            return;
          }
          authed = true;
        }
        writeLine(socket, { id, ok: true, result: { proto: PROTO, daemon: { version: '0.1.0', proto: PROTO, pid: process.pid, mode: 'daemon' } } });
        return;
      }
      if (!authed) {
        writeLine(socket, { id, ok: false, error: toErrorPayload(err('E_ATTACH_DENIED', 'handshake required on this connection')) });
        socket.destroy();
        return;
      }
      const handler = handlers[msg.method];
      if (typeof handler !== 'function') {
        writeLine(socket, { id, ok: false, error: toErrorPayload(err('E_INVALID_ARG', `unknown method: ${msg.method}`)) });
        return;
      }
      activeRequests += 1;
      stats.requests += 1;
      try {
        const result = await handler(msg.params || {}, ctx);
        writeLine(socket, { id, ok: true, result: result === undefined ? {} : result });
      } catch (e) {
        stats.errors += 1;
        log?.warn?.(`handler ${msg.method} failed: ${e && e.message ? e.message : e}`);
        writeLine(socket, { id, ok: false, error: toErrorPayload(e) });
      } finally {
        activeRequests -= 1;
        lastActivityAt = Date.now();
      }
    }
  });

  function writeLine(socket, message) {
    if (socket.destroyed) return;
    try {
      socket.write(JSON.stringify(message) + '\n');
    } catch { /* peer went away */ }
  }

  if (kind === 'unix' && process.platform !== 'win32') {
    try { fs.mkdirSync(path.dirname(endpoint.path), { recursive: true }); } catch { /* ignore */ }
  }

  await new Promise((resolve, reject) => {
    const onError = (e) => {
      server.off('listening', onListening);
      reject(e);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    try {
      if (kind === 'tcp') server.listen({ host: endpoint.host, port: endpoint.port });
      else server.listen(endpoint.path);
    } catch (e) {
      onError(e);
    }
  }).catch((e) => {
    if (e && (e.code === 'EADDRINUSE' || e.code === 'EACCES')) {
      throw err(
        'E_DAEMON_STARTING',
        `dbghub daemon socket is already in use: ${socketPath}`,
        'another daemon owns this endpoint; the shim should connect to it instead of spawning',
      );
    }
    throw e;
  });

  if (kind === 'unix' && process.platform !== 'win32') {
    try { fs.chmodSync(endpoint.path, 0o600); } catch { /* best effort */ }
  }

  function currentIdleMs(now = Date.now()) {
    return now - lastActivityAt;
  }

  if (idleExitMin > 0) {
    idleTimer = setInterval(() => {
      if (closed) return;
      if (activeRequests > 0) return;
      if (hasActiveSessions() > 0) return;
      if (currentIdleMs() < idleExitMin * 60000) return;
      log?.info?.(`idle for ${idleExitMin}min with no sessions; exiting daemon`);
      void close('idle');
    }, Math.max(50, idleCheckMs));
    idleTimer.unref?.();
  }

  async function close(why = 'close') {
    if (closed) return;
    closed = true;
    if (idleTimer) { clearInterval(idleTimer); idleTimer = null; }
    if (why === 'idle' && onIdle) {
      try { await onIdle(); } catch (e) { log?.warn?.(`onIdle failed: ${e && e.message}`); }
    }
    for (const socket of connections) {
      try { socket.end(); } catch { /* ignore */ }
    }
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 500);
      timer.unref?.();
      server.close(() => {
        clearTimeout(timer);
        resolve();
      });
    });
    if (!isPipe(socketPath)) removeStaleSocketFile(socketPath);
    resolveClosed({ why });
  }

  function listenPort() {
    const addr = server.address();
    return addr && typeof addr === 'object' ? addr.port : null;
  }

  return {
    server,
    socketPath,
    kind,
    close,
    whenClosed,
    address: () => server.address(),
    port: listenPort,
    stats: () => ({ ...stats, activeRequests, connections: connections.size, idleMs: currentIdleMs() }),
  };
}
