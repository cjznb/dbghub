/**
 * Daemon IPC client (NDJSON over a Windows named pipe or a Unix domain socket).
 *
 * Wire: request  {"id":1,"method":"open","params":{...}}
 *       response {"id":1,"ok":true,"result":{...}} | {"id":1,"ok":false,"error":{code,message,hint}}
 * Discovery: explicit socketPath -> DBGHUB_SOCKET/daemon.json -> spawn a detached daemon and wait
 * for the endpoint (<= timeoutMs). Calls time out; a broken pipe reconnects once before failing.
 */
import { spawn } from 'node:child_process';
import net from 'node:net';
import {
  defaultSocketPath,
  readDaemonInfo,
  isProcessAlive,
  parseEndpoint,
} from './ipc-paths.mjs';
import { err } from '../util/errors.mjs';

const DEFAULT_CALL_TIMEOUT_MS = 30000;
const DEFAULT_CONNECT_TIMEOUT_MS = 5000;
const RECONNECT_WINDOW_MS = 4000;

/** Build the error a caller sees when the daemon is unreachable. */
function daemonDownError(cause) {
  return err(
    'E_DAEMON_DOWN',
    `dbghub daemon is not reachable${cause ? `: ${cause}` : ''}`,
    'run `dbghub serve` or set DBGHUB_MODE=inline; `dbghub doctor` shows the socket path',
  );
}

/**
 * Connect to one daemon. `autoStart` spawns `command serve --daemon` (detached) when nothing answers.
 * Options: {socketPath, autoStart, command, args, timeoutMs, token, env, log}
 */
export class DaemonClient {
  #socketPath;
  #socket = null;
  #buffer = '';
  #pending = new Map();
  #nextId = 1;
  #connecting = null;
  #closed = false;
  #opts;

  constructor(opts = {}) {
    this.#opts = opts;
    this.#socketPath = opts.socketPath || null;
    this.token = opts.token || null;
  }

  static async connect(opts = {}) {
    const client = new DaemonClient(opts);
    await client.ensureConnected();
    return client;
  }

  get socketPath() {
    return this.#socketPath;
  }

  get connected() {
    return this.#socket !== null;
  }

  /** Resolve the endpoint: explicit path, then daemon.json, then the platform default. */
  #resolveEndpoint({ env = process.env, platform = process.platform } = {}) {
    if (this.#socketPath) {
      const parsed = parseEndpoint(this.#socketPath);
      return { ...parsed, token: this.token };
    }
    const info = readDaemonInfo({ env, platform });
    if (info && info.port && !info.socket) {
      return { kind: 'tcp', host: '127.0.0.1', port: Number(info.port), spec: `tcp://127.0.0.1:${info.port}`, token: info.token || this.token };
    }
    if (info && typeof info.socket === 'string' && info.socket) {
      if (info.pid && !isProcessAlive(info.pid)) {
        this.#opts.log?.debug?.(`daemon.json points at dead pid ${info.pid}; probing socket anyway`);
      }
      return { ...parseEndpoint(info.socket), token: info.token || this.token };
    }
    return { ...parseEndpoint(defaultSocketPath({ env, platform })), token: this.token };
  }

  async ensureConnected() {
    if (this.connected) return;
    if (this.#closed) throw daemonDownError('client closed');
    if (this.#connecting) return this.#connecting;
    const timeoutMs = this.#opts.timeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    this.#connecting = this.#openWithRetry(timeoutMs).finally(() => {
      this.#connecting = null;
    });
    return this.#connecting;
  }

  async #openWithRetry(timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    let lastError = null;
    for (;;) {
      try {
        await this.#openOnce();
        return;
      } catch (e) {
        lastError = e;
      }
      // A permission denial cannot be fixed by spawning a daemon (sandboxed hosts block IPC);
      // fail fast so the shim can fall back to inline mode with a useful hint.
      const code = lastError && lastError.code;
      if (code === 'EPERM' || code === 'EACCES') {
        throw daemonDownError(
          `endpoint access denied (${code}); this host blocks local IPC — use DBGHUB_INLINE=1`
            + ` or run the daemon outside the sandbox`,
        );
      }
      if (this.#opts.autoStart) {
        // Re-spawn after a daemon crash too (not just the first connect), with a small cooldown
        // so a tight retry loop cannot fork-bomb a broken binary.
        const now = Date.now();
        if (!this.#opts._lastSpawnAt || now - this.#opts._lastSpawnAt > 1500) {
          this.#opts._lastSpawnAt = now;
          this.#spawnDaemon();
        }
      }
      if (Date.now() >= deadline) break;
      await delay(100);
    }
    throw daemonDownError(lastError && lastError.message);
  }

  #spawnDaemon() {
    const opts = this.#opts;
    const env = opts.env || process.env;
    const endpoint = this.#resolveEndpoint({ env });
    const socketPath = endpoint.spec || endpoint.path;
    const command = opts.command || process.execPath;
    const args = opts.args || defaultServeArgs(socketPath);
    try {
      const child = spawn(command, args, {
        detached: true,
        windowsHide: true,
        stdio: ['ignore', 'ignore', opts.stderrFd ?? 'ignore'],
        env: { ...env, DBGHUB_SOCKET: socketPath },
      });
      child.on('error', (e) => opts.log?.debug?.(`daemon spawn failed: ${e.message}`));
      child.unref();
      opts.log?.info?.(`spawned daemon: ${command} ${args.join(' ')}`);
    } catch (e) {
      opts.log?.warn?.(`daemon spawn threw: ${e.message}`);
    }
  }

  #openOnce() {
    const endpoint = this.#resolveEndpoint({ env: this.#opts.env || process.env });
    this.#socketPath = endpoint.spec || endpoint.path;
    return new Promise((resolve, reject) => {
      const socket =
        endpoint.kind === 'tcp'
          ? net.createConnection({ host: endpoint.host, port: endpoint.port })
          : net.createConnection({ path: endpoint.path });
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        socket.destroy();
        reject(daemonDownError('connect timeout'));
      }, Math.max(300, Math.min(1000, this.#opts.timeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS)));
      timer.unref?.();

      socket.once('connect', async () => {
        clearTimeout(timer);
        if (settled) return;
        settled = true;
        this.#attachSocket(socket);
        try {
          if (endpoint.kind === 'tcp' && endpoint.token) {
            const res = await this.#request('hello', { token: endpoint.token }, { timeoutMs: 3000 });
            if (res && res.proto === undefined) { /* old daemon: ignore */ }
          }
          resolve();
        } catch (e) {
          socket.destroy();
          reject(e);
        }
      });
      socket.once('error', (e) => {
        clearTimeout(timer);
        if (settled) return;
        settled = true;
        socket.destroy();
        reject(e);
      });
    });
  }

  #attachSocket(socket) {
    this.#socket = socket;
    this.#buffer = '';
    socket.setNoDelay?.(true);
    socket.on('data', (chunk) => this.#onData(chunk));
    socket.on('close', () => this.#onClose());
    socket.on('error', () => this.#onClose());
  }

  #onData(chunk) {
    this.#buffer += chunk.toString('utf8');
    if (this.#buffer.length > 16 * 1024 * 1024) {
      this.#buffer = '';
      this.#failAll(daemonDownError('daemon response exceeded 16MB'));
      this.#socket?.destroy();
      return;
    }
    for (;;) {
      const idx = this.#buffer.indexOf('\n');
      if (idx < 0) break;
      const line = this.#buffer.slice(0, idx).trim();
      this.#buffer = this.#buffer.slice(idx + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        this.#opts.log?.debug?.('dropping non-JSON daemon line');
        continue;
      }
      this.#onMessage(msg);
    }
  }

  #onMessage(msg) {
    const pending = this.#pending.get(msg.id);
    if (!pending) return;
    this.#pending.delete(msg.id);
    clearTimeout(pending.timer);
    if (msg.ok) pending.resolve(msg.result);
    else {
      const e = msg.error || {};
      pending.reject(err(e.code || 'E_INTERNAL', e.message || 'daemon error', e.hint || ''));
    }
  }

  #onClose() {
    const wasConnected = this.#socket !== null;
    this.#socket = null;
    if (wasConnected) this.#failAll(daemonDownError('connection closed'));
  }

  #failAll(error) {
    for (const [, pending] of this.#pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
  }

  #request(method, params, { timeoutMs = DEFAULT_CALL_TIMEOUT_MS } = {}) {
    if (!this.#socket) return Promise.reject(daemonDownError('not connected'));
    const id = this.#nextId++;
    const line = JSON.stringify({ id, method, params: params || {} }) + '\n';
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(
          err(
            'E_TIMEOUT',
            `daemon call ${method} timed out after ${timeoutMs}ms`,
            'the target may be stalled: check `state`, or `run action=pause` then retry',
          ),
        );
      }, timeoutMs);
      timer.unref?.();
      this.#pending.set(id, { resolve, reject, timer, method });
      try {
        this.#socket.write(line, (e) => {
          if (!e) return;
          this.#pending.delete(id);
          clearTimeout(timer);
          reject(daemonDownError(e.message));
        });
      } catch (e) {
        this.#pending.delete(id);
        clearTimeout(timer);
        reject(daemonDownError(e.message));
      }
    });
  }

  /**
   * Call one daemon method. Reconnects once when a stale pipe broke before the write reached the
   * daemon; a timeout never retries (retrying `continue` would move the target twice).
   */
  async call(method, params = {}, { timeoutMs = DEFAULT_CALL_TIMEOUT_MS } = {}) {
    if (this.#closed) throw daemonDownError('client closed');
    if (!this.connected) await this.ensureConnected();
    try {
      return await this.#request(method, params, { timeoutMs });
    } catch (e) {
      if (e && (e.code === 'E_DAEMON_DOWN' || e.code === 'E_TIMEOUT')) {
        this.#socket?.destroy();
        this.#socket = null;
        if (e.code === 'E_DAEMON_DOWN') {
          await this.ensureConnected().catch(() => {});
          if (this.connected) return this.#request(method, params, { timeoutMs });
        }
      }
      throw e;
    }
  }

  async close() {
    this.#closed = true;
    this.#failAll(daemonDownError('client closed'));
    const socket = this.#socket;
    this.#socket = null;
    if (socket) {
      await new Promise((resolve) => {
        socket.end(() => resolve());
        setTimeout(resolve, 200).unref?.();
      });
    }
  }
}

function endpointKind(socketPath) {
  return typeof socketPath === 'string' && socketPath.startsWith('\\\\.\\pipe\\') ? 'pipe' : 'unix';
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Default args used when auto-starting: `<current bin> serve --daemon --socket <path>`. */
export function defaultServeArgs(socketPath) {
  const bin = process.argv[1] || '';
  const args = ['serve', '--daemon'];
  if (socketPath) args.push('--socket', socketPath);
  return bin ? [bin, ...args] : args;
}

export { RECONNECT_WINDOW_MS };
