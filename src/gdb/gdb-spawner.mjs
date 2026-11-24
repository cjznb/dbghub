/**
 * Spawn strategy for the gdb child process.
 *
 * Preferred: normal pipes (`stdio: ['pipe','pipe','pipe']`), which is what a
 * daemon running outside a sandbox uses.
 *
 * Windows sandbox fallback ("relay" mode): some sandboxes deny named-pipe
 * creation, so spawn({stdio:'pipe'}) fails with EPERM. Node cannot create
 * anonymous pipes itself, so we start a small PowerShellhosted relay
 * (src/gdb/gdb-relay.ps1) with its stdio redirected to files and a loopback
 * TCP socket, and the relay starts gdb with .NET redirected pipes
 * (anonymous pipes are allowed). Stdout/stderr bytes are streamed back over
 * the socket (base64 framed), stdin commands are streamed to gdb. The relay
 * .NET part is compiled at runtime with Add-Type (ships with PowerShell 7).
 *
 * The returned object is a deliberately small ChildProcess look-alike:
 *   .stdout/.stderr  EventEmitter with 'data' (utf8 strings), setEncoding()
 *   .stdin           { write(text, enc, cb), end(), destroy(), destroyed }
 *   .on('exit'|'error'), .exitCode, .pid, .kill(), .stdioMode
 *
 * `stdioMode` is 'pipe' or 'relay' and is surfaced through GdbSession for
 * diagnostics.
 */
import { spawn as nodeSpawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_RELAY_SCRIPT = path.join(HERE, 'gdb-relay.ps1');

function makeError(code, message, fields = {}) {
  const e = new Error(message);
  e.code = code;
  Object.assign(e, fields);
  return e;
}

function isPipeBlocked(e) {
  const code = e && e.code;
  return code === 'EPERM' || code === 'ENOTSUP' || code === 'EACCES' || code === 'EINVAL';
}

class RelayStream extends EventEmitter {
  constructor(name) {
    super();
    this.name = name;
  }
  // GdbSession calls setEncoding('utf8'); the relay already decodes to strings.
  setEncoding() { return this; }
}

class RelayStdin extends EventEmitter {
  constructor(owner) {
    super();
    this._owner = owner;
    this.destroyed = false;
    this._ended = false;
  }
  write(text, encoding, cb) {
    if (typeof encoding === 'function') { cb = encoding; encoding = undefined; }
    if (this.destroyed || this._ended) {
      const err = makeError('EPIPE', 'gdb stdin is closed');
      if (typeof cb === 'function') queueMicrotask(() => cb(err));
      return false;
    }
    this._owner._sendCommand(String(text));
    if (typeof cb === 'function') queueMicrotask(() => cb(null));
    return true;
  }
  end() {
    if (this._ended) return;
    this._ended = true;
    this._owner._sendStop();
  }
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this._owner._destroy();
  }
}

class RelayChild extends EventEmitter {
  constructor({ pwshChild, outPath, errPath, outFd, errFd, tmpDir, connectTimeoutMs, log }) {
    super();
    this.pid = pwshChild && typeof pwshChild.pid === 'number' ? pwshChild.pid : null;
    this.exitCode = null;
    this.signalCode = null;
    this.killed = false;
    this.stdioMode = 'relay';
    this.stdout = new RelayStream('stdout');
    this.stderr = new RelayStream('stderr');
    this.stdin = new RelayStdin(this);
    this._pwshChild = pwshChild;
    this._outPath = outPath;
    this._errPath = errPath;
    this._outFd = outFd;
    this._errFd = errFd;
    this._tmpDir = tmpDir;
    this._connectTimeoutMs = connectTimeoutMs;
    this._log = log;
    this._socket = null;
    this._server = null;
    this._lineBuf = '';
    this._outDecoder = new StringDecoder('utf8');
    this._errDecoder = new StringDecoder('utf8');
    this._finished = false;
    this._connected = false;
    this._stopped = false;
    this.relayStderrTail = '';
    if (pwshChild) {
      pwshChild.on('error', (e) => this._onRelayError(e));
      pwshChild.on('exit', (code, signal) => this._onRelayExit(code, signal));
    }
  }

  /** Wait for the relay to connect back, then attach it to this facade. */
  _start(server) {
    this._server = server;
    this._connectTimer = setTimeout(() => {
      this._connectTimer = null;
      this._fail(makeError('E_SPAWN', `gdb relay did not connect within ${this._connectTimeoutMs}ms`, {
        hint: 'PowerShell 7 (pwsh) is required for the Windows sandbox stdio fallback.',
        miError: { relay: true, timeout: true, timeoutMs: this._connectTimeoutMs },
      }));
    }, this._connectTimeoutMs);
    server.once('connection', (socket) => {
      this._clearConnectTimer();
      this._attachSocket(socket);
    });
    server.once('error', (e) => {
      this._clearConnectTimer();
      this._fail(makeError('E_SPAWN', `gdb relay TCP error: ${e && e.message ? e.message : e}`, {
        miError: { relay: true },
      }));
    });
  }

  _clearConnectTimer() {
    if (this._connectTimer) {
      clearTimeout(this._connectTimer);
      this._connectTimer = null;
    }
  }

  _attachSocket(socket) {
    if (this._finished) { try { socket.destroy(); } catch { /* ignore */ } return; }
    this._connected = true;
    this._socket = socket;
    try { socket.setNoDelay(true); } catch { /* ignore */ }
    socket.on('data', (chunk) => this._onSocketData(chunk));
    socket.on('error', (e) => {
      if (!this._finished) this._fail(makeError('E_SPAWN', `gdb relay socket error: ${e && e.message ? e.message : e}`, {
        miError: { relay: true },
      }));
    });
    socket.on('close', () => {
      if (!this._finished) this._finish(this.exitCode, this.signalCode);
    });
  }

  _onSocketData(chunk) {
    this._lineBuf += String(chunk);
    for (;;) {
      const nl = this._lineBuf.indexOf('\n');
      if (nl === -1) break;
      const line = this._lineBuf.slice(0, nl).replace(/\r$/, '');
      this._lineBuf = this._lineBuf.slice(nl + 1);
      this._onRelayMessage(line);
    }
  }

  _onRelayMessage(line) {
    if (!line) return;
    const kind = line[0];
    const body = line.length > 2 && line[1] === ' ' ? line.slice(2) : '';
    if (kind === 'o') {
      const text = this._outDecoder.write(Buffer.from(body, 'base64'));
      if (text) this._emitStream(this.stdout, 'data', text);
      return;
    }
    if (kind === 'e') {
      const text = this._errDecoder.write(Buffer.from(body, 'base64'));
      if (text) this._emitStream(this.stderr, 'data', text);
      return;
    }
    if (kind === 'x') {
      const code = Number.parseInt(body, 10);
      this.exitCode = Number.isFinite(code) ? code : null;
      this._finish(this.exitCode, null);
      return;
    }
    if (kind === 'f') {
      const message = Buffer.from(body, 'base64').toString('utf8');
      this._fail(makeError('E_SPAWN', `gdb relay failed: ${message}`, {
        hint: 'Check the gdb path and that PowerShell 7 (pwsh) is installed.',
        miError: { relay: true, gdbPath: null },
      }));
    }
  }

  _sendCommand(text) {
    if (this._finished) return;
    if (!this._socket) {
      // Commands written before the relay connects are queued.
      this._pendingWrites = this._pendingWrites || [];
      this._pendingWrites.push(text);
      return;
    }
    this._writeFrame('i', Buffer.from(text, 'utf8').toString('base64'));
    this._flushPending();
  }

  _flushPending() {
    if (!this._pendingWrites || !this._socket) return;
    const pending = this._pendingWrites;
    this._pendingWrites = [];
    for (const text of pending) {
      this._writeFrame('i', Buffer.from(text, 'utf8').toString('base64'));
    }
  }

  _sendStop() {
    this._stopped = true;
    if (this._finished) return;
    this._writeFrame('x', '');
  }

  _writeFrame(kind, body) {
    if (!this._socket) return;
    try {
      this._socket.write(body ? `${kind} ${body}\n` : `${kind}\n`);
    } catch (e) {
      this._log?.warn?.('relay write failed', { error: e && e.message });
    }
  }

  _emitStream(stream, event, payload) {
    try {
      stream.emit(event, payload);
    } catch (e) {
      this._log?.error?.('relay stream listener threw', { error: e && e.message });
    }
  }

  _onRelayError(e) {
    if (e && e.code === 'ENOENT') {
      this._fail(makeError('E_SPAWN', `PowerShell 7 (pwsh) not found: ${e.message}`, {
        hint: 'Install PowerShell 7 or run dbghub outside the sandbox.',
        miError: { relay: true, spawn: true, code: e.code },
      }));
      return;
    }
    this._fail(makeError('E_SPAWN', `gdb relay process error: ${e && e.message ? e.message : e}`, {
      miError: { relay: true, code: e && e.code },
    }));
  }

  _onRelayExit(code, signal) {
    if (this._finished) return;
    const tail = this._readRelayLog();
    this._fail(makeError('E_SPAWN', `gdb relay exited unexpectedly (code=${code})${tail ? `: ${tail}` : ''}`, {
      miError: { relay: true, code, signal, log: tail },
      hint: 'PowerShell 7 (pwsh) must be available for the Windows sandbox fallback.',
    }));
  }

  _readRelayLog() {
    try {
      const parts = [];
      for (const p of [this._errPath, this._outPath]) {
        try {
          const text = fs.readFileSync(p, 'utf8').trim();
          if (text) parts.push(text.slice(-600));
        } catch { /* ignore */ }
      }
      this.relayStderrTail = parts.join('\n');
      return this.relayStderrTail;
    } catch {
      return '';
    }
  }

  _fail(err) {
    if (this._finished) return;
    if (this.listenerCount('error') > 0) this.emit('error', err);
    else this._log?.error?.(err.message);
    this._finish(this.exitCode, this.signalCode, true);
  }

  _finish(code, signal) {
    if (this._finished) return;
    this._finished = true;
    this._clearConnectTimer();
    this.exitCode = code === undefined ? null : code;
    this.signalCode = signal === undefined ? null : signal;
    this.stdin.destroyed = true;
    try { this._socket?.destroy(); } catch { /* ignore */ }
    try { this._server?.close(); } catch { /* ignore */ }
    try { if (this._pwshChild && this._pwshChild.exitCode === null) this._pwshChild.kill(); } catch { /* ignore */ }
    this._cleanupFiles();
    try { this.emit('exit', this.exitCode, this.signalCode); } catch { /* ignore */ }
  }

  kill(signal = 'SIGTERM') {
    if (this._finished) return true;
    this.killed = true;
    try {
      if (this._pwshChild && this._pwshChild.exitCode === null) this._pwshChild.kill(signal);
    } catch { /* ignore */ }
    this._finish(this.exitCode, signal);
    return true;
  }

  _destroy() {
    this.kill('SIGKILL');
  }

  _cleanupFiles() {
    for (const fd of [this._outFd, this._errFd]) {
      if (typeof fd === 'number' && fd >= 0) { try { fs.closeSync(fd); } catch { /* ignore */ } }
    }
    this._outFd = null;
    this._errFd = null;
    if (this._tmpDir) {
      try { fs.rmSync(this._tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
      this._tmpDir = null;
    }
  }
}

export class GdbSpawner {
  constructor({
    spawnFn = nodeSpawn,
    preferPipe = true,
    pwshPath = process.env.DBGHUB_PWSH || 'pwsh',
    relayScriptPath = DEFAULT_RELAY_SCRIPT,
    relayConnectTimeoutMs = 60000,
    log = null,
  } = {}) {
    this.spawnFn = spawnFn;
    this.preferPipe = preferPipe;
    this.pwshPath = pwshPath;
    this.relayScriptPath = relayScriptPath;
    this.relayConnectTimeoutMs = relayConnectTimeoutMs;
    this.log = log;
    this._mode = 'pipe';
  }

  /** 'pipe' or 'relay' (the mode of the most recent successful spawn). */
  get stdioMode() {
    return this._mode;
  }

  /**
   * Spawn gdb (or a relay hosting gdb). Resolves to a ChildProcess look-alike.
   * Throws when neither pipes nor the relay fallback can be used.
   */
  async spawn(file, args, options = {}) {
    const base = {
      cwd: options.cwd,
      env: options.env,
      windowsHide: options.windowsHide !== false,
      shell: false,
    };
    const piped = this._tryPipe(file, args, base);
    if (piped.child) {
      this._mode = 'pipe';
      return piped.child;
    }
    const pipeError = piped.error;
    if (!isPipeBlocked(pipeError) || process.platform !== 'win32') {
      throw makeError('E_SPAWN', `failed to start gdb (${file}): ${pipeError && pipeError.message ? pipeError.message : pipeError}`, {
        hint: 'Check the gdb path and permissions.',
        miError: { spawn: true, gdbPath: file, code: pipeError && pipeError.code },
      });
    }
    this.log?.warn?.('pipe stdio is blocked; using PowerShell relay fallback', { code: pipeError && pipeError.code });
    return this._spawnRelay(file, args, base);
  }

  _tryPipe(file, args, options) {
    try {
      return { child: this.spawnFn(file, args, { ...options, stdio: ['pipe', 'pipe', 'pipe'] }) };
    } catch (e) {
      return { error: e };
    }
  }

  async _spawnRelay(file, args, options) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dbghub-gdb-relay-'));
    const outPath = path.join(tmpDir, 'relay-stdout.txt');
    const errPath = path.join(tmpDir, 'relay-stderr.txt');
    let outFd = null;
    let errFd = null;
    let server = null;
    try {
      outFd = fs.openSync(outPath, 'w');
      errFd = fs.openSync(errPath, 'w');
      server = net.createServer();
      const port = await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => resolve(server.address().port));
      });
      const env = {
        ...options.env,
        DBGHUB_GDB_PATH: file,
        DBGHUB_GDB_ARGV: JSON.stringify(args),
      };
      if (options.cwd) env.DBGHUB_GDB_CWD = options.cwd;
      const pwshChild = this.spawnFn(
        this.pwshPath,
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', this.relayScriptPath, '-Port', String(port)],
        { cwd: options.cwd, env, stdio: ['ignore', outFd, errFd], windowsHide: true, shell: false },
      );
      const child = new RelayChild({
        pwshChild,
        outPath,
        errPath,
        outFd,
        errFd,
        tmpDir,
        connectTimeoutMs: this.relayConnectTimeoutMs,
        log: this.log,
      });
      outFd = null; // ownership handed to the facade
      errFd = null;
      child._start(server);
      server = null;
      this._mode = 'relay';
      return child;
    } catch (e) {
      if (server) { try { server.close(); } catch { /* ignore */ } }
      for (const fd of [outFd, errFd]) {
        if (typeof fd === 'number') { try { fs.closeSync(fd); } catch { /* ignore */ } }
      }
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
      throw makeError('E_SPAWN', `failed to start gdb relay for ${file}: ${e && e.message ? e.message : e}`, {
        hint: 'PowerShell 7 (pwsh) is required for the Windows sandbox stdio fallback.',
        miError: { spawn: true, relay: true, gdbPath: file },
      });
    }
  }
}
