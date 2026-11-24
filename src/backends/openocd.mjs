/**
 * OpenOCD backend process manager.
 *
 * Spawns `openocd` with an argv array (never a shell string), auto-allocates free
 * gdb/telnet/tcl ports, waits until the GDB server is listening, and classifies
 * startup failures into the v1 error codes so callers never surface raw stderr.
 *
 * Lifecycle: idle -> starting -> ready -> exited | error.  `stop()` is idempotent.
 */

import { spawnWatch } from './childproc.mjs';
import net from 'node:net';
import { err } from '../util/errors.mjs';

const LISTEN_RE = /Listening on port (\d+)/;
const STARTING_RE = /starting gdb server on (\d+)/;
const BIND_ERROR_RE = /Address already in use|Failed to bind|bind\(\) failed|couldn't bind/i;

/** Hints are agent-facing: one actionable sentence per failure class. */
const HINTS = {
  E_PROBE_NOT_FOUND:
    'No debug probe detected: check USB cable/power, verify the interface cfg matches the probe, then run `discover action=doctor`.',
  E_PROBE_PERMISSION:
    'Probe is not accessible: install OpenOCD udev rules (contrib/60-openocd.rules, plugdev group) or the vendor USB/WinUSB driver; another session may also hold the probe.',
  E_PROBE_BUSY:
    'Probe is busy: another process/session holds it; close that session or pick another probe.',
  E_PROBE_FIRMWARE:
    'Probe firmware needs an update: ST-LINK -> STM32CubeProgrammer; J-Link -> J-Link Configurator/`JLinkExe -fwupdate`.',
  E_SERVER_START:
    'OpenOCD failed to start: check `-s <scripts>` path, interface/target cfg names, and port availability.',
  E_TOOLCHAIN_MISSING:
    'OpenOCD binary not found: install OpenOCD or set backends.openocd.command to its absolute path.',
};

/** Strip ANSI + `Error:` prefix, keep one short line for the agent. */
function cleanLine(line) {
  return String(line)
    .replace(/\u001b\[[0-9;]*m/g, '')
    .replace(/^.*?Error:\s*/i, '')
    .trim()
    .slice(0, 240);
}

function pickErrorLine(lines) {
  const prefixed = lines.find((l) => /Error:/i.test(l));
  if (prefixed) return cleanLine(prefixed);
  const meaningful = lines.filter(
    (l) =>
      l.trim() &&
      !/^xPack Open|^Licensed|bug reports|doxygen|^Info\s*:|^Warn\s*:|^adapter speed|^DEPRECATED|^shutdown command/i.test(l),
  );
  return cleanLine(meaningful[0] || lines[lines.length - 1] || 'openocd exited unexpectedly');
}

/**
 * Map OpenOCD log lines (+ exit code) to a structured error.
 * Exported for tests; returns null when the log looks like a normal run.
 */
export function classifyOpenOCDError(lines = [], exitCode = null) {
  const text = lines.join('\n');
  const message = pickErrorLine(lines);
  const make = (code) => ({ code, message, hint: HINTS[code] || HINTS.E_SERVER_START });
  if (exitCode === 0 && !/Error:/i.test(text)) return null;
  if (!text.trim()) {
    return { ...make('E_SERVER_START'), message: `openocd exited (code ${exitCode}) without output` };
  }
  // udev / WinUSB / driver problems (most common on fresh Linux installs).
  if (/LIBUSB_ERROR_ACCESS|LIBUSB_ERROR_NOT_SUPPORTED|permission denied|access denied|EACCES|udev/i.test(text)) {
    return make('E_PROBE_PERMISSION');
  }
  // Firmware gate before generic open failures (ST-LINK "firmware upgrade required").
  if (/firmware\s+(?:upgrade|update|version).{0,40}(?:required|needed|too old)|upgrade\s+(?:the\s+)?firmware|ST-LINK firmware/i.test(text)) {
    return make('E_PROBE_FIRMWARE');
  }
  // No probe attached / wrong interface cfg.
  if (/No\s+[\w .-]*\bdevice found|unable to find a matching|no (?:jlink|stlink|cmsis-dap|probe)|could not find .{0,40}device|no devices found/i.test(text)) {
    return make('E_PROBE_NOT_FOUND');
  }
  // Broken -s search path / bad target cfg must not be mistaken for a probe problem.
  if (/Could not open .*\.cfg|Can't find .*\.cfg|unable to find .*\.cfg|invalid command name/i.test(text)) {
    return make('E_SERVER_START');
  }
  // Second instance / probe claimed by another process.
  if (/LIBUSB_ERROR_BUSY|resource busy|already in use|open failed|could not open|unable to open|can't open/i.test(text)) {
    return make('E_PROBE_BUSY');
  }
  return make('E_SERVER_START');
}

/** Ask the OS for one free TCP port (listener is closed before returning). */
export function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function allocatePorts() {
  const used = new Set();
  while (used.size < 3) {
    const p = await findFreePort();
    if (!used.has(p)) used.add(p);
  }
  const [gdbPort, telnetPort, tclPort] = [...used];
  return { gdbPort, telnetPort, tclPort };
}

export class OpenOCD {
  constructor({
    command = 'openocd',
    commandArgs = [],
    search = null,
    interface: iface = 'stlink',
    target = 'stm32f1x',
    transport = 'swd',
    speedKhz = 480,
    extraArgs = [],
    gdbPort = 0,
    telnetPort = 0,
    tclPort = 0,
    timeoutMs = 15000,
    cwd = undefined,
    env = undefined,
    log = null,
  } = {}) {
    this.command = command;
    this.commandArgs = [...commandArgs];
    this.search = search || null;
    this.interface = iface;
    this.target = target;
    this.transport = transport;
    this.speedKhz = Number(speedKhz) || 0;
    this.extraArgs = [...extraArgs];
    this.timeoutMs = Number(timeoutMs) > 0 ? Number(timeoutMs) : 15000;
    this.cwd = cwd;
    this.env = env;
    this.log = log;

    this._fixed = {
      gdbPort: Number(gdbPort) || 0,
      telnetPort: Number(telnetPort) || 0,
      tclPort: Number(tclPort) || 0,
    };
    this._ports = { gdbPort: 0, telnetPort: 0, tclPort: 0 };
    this._status = 'idle';
    this._lines = [];
    this._argv = [];
    this._child = null;
    this._proc = null;
    this._stdioMode = null;
    this._alive = false;
    this._result = null;
    this._starting = null;
    this._stopping = false;
    this.exitCode = null;
    this.exitSignal = null;
  }

  get status() {
    return this._status;
  }

  get pid() {
    return this._child ? this._child.pid : null;
  }

  get argv() {
    return [...this._argv];
  }

  get ports() {
    return { ...this._ports };
  }

  get requestedPorts() {
    return { ...this._fixed };
  }

  /** 'pipe' normally; 'file' when the host forbids anonymous pipes (sandbox). */
  get stdioMode() {
    return this._stdioMode;
  }

  /** Last n log lines (stdout+stderr merged, no ANSI stripping). */
  tail(n = 50) {
    return this._lines.slice(-Math.max(0, Number(n) || 0));
  }

  /** Build the argv exactly once (also used by tests via `argv` before start). */
  _buildArgv(ports) {
    const argv = [...this.commandArgs];
    if (this.search) argv.push('-s', this.search);
    argv.push('-f', `interface/${this.interface}.cfg`);
    if (this.transport) argv.push('-c', `transport select ${this.transport}`);
    if (this.speedKhz > 0) argv.push('-c', `adapter speed ${this.speedKhz}`);
    if (this.target) argv.push('-f', `target/${this.target}.cfg`);
    argv.push('-c', `gdb_port ${ports.gdbPort}`);
    argv.push('-c', `telnet_port ${ports.telnetPort}`);
    argv.push('-c', `tcl_port ${ports.tclPort}`);
    if (this.extraArgs.length) argv.push(...this.extraArgs);
    return argv;
  }

  async start() {
    if (this._status === 'ready') return this._result;
    if (this._starting) return this._starting;

    const ports = await allocatePorts();
    this._starting = this._spawnAndWait(ports).finally(() => {
      this._starting = null;
    });
    return this._starting;
  }

  async _spawnAndWait(ports, attempt = 0) {
    const effective = {
      gdbPort: this._fixed.gdbPort || ports.gdbPort,
      telnetPort: this._fixed.telnetPort || ports.telnetPort,
      tclPort: this._fixed.tclPort || ports.tclPort,
    };
    this._ports = effective;
    this._argv = this._buildArgv(effective);
    this._status = 'starting';
    this._lines = [];
    this.exitCode = null;
    this.exitSignal = null;

    let proc;
    try {
      proc = spawnWatch({ command: this.command, args: this._argv, env: this.env, cwd: this.cwd });
    } catch (e) {
      this._status = 'error';
      throw err('E_TOOLCHAIN_MISSING', `failed to spawn openocd: ${e.message}`, HINTS.E_TOOLCHAIN_MISSING);
    }
    const child = proc.child;
    this._proc = proc;
    this._stdioMode = proc.mode;
    this._child = child;
    this._alive = true;

    return new Promise((resolve, reject) => {
      let settled = false;
      let startedPort = 0;
      let graceTimer = null;

      const shutdownTimer = setTimeout(() => {
        if (settled) return;
        settled = true;
        clearTimeout(shutdownTimer);
        if (graceTimer) clearTimeout(graceTimer);
        const classified = classifyOpenOCDError(this._lines, null);
        const e = err(
          'E_SERVER_START',
          `openocd did not become ready within ${this.timeoutMs}ms: ${classified.message}`,
          HINTS.E_SERVER_START,
        );
        this._status = 'error';
        this._killChild();
        reject(e);
      }, this.timeoutMs);
      shutdownTimer.unref?.();

      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(shutdownTimer);
        if (graceTimer) clearTimeout(graceTimer);
        fn(value);
      };

      const onReady = (port) => {
        if (this._status === 'starting') this._status = 'ready';
        this._ports = { ...effective, gdbPort: port || effective.gdbPort };
        this._result = {
          gdbPort: this._ports.gdbPort,
          telnetPort: this._ports.telnetPort,
          tclPort: this._ports.tclPort,
          pid: child.pid,
          argv: [...this._argv],
          logTail: this.tail(20),
        };
        finish(resolve, this._result);
      };

      const onLine = (line) => {
        const text = String(line).replace(/\r$/, '');
        if (!text) return;
        this._lines.push(text);
        if (this._lines.length > 2000) this._lines.shift();
        this.log?.debug?.('openocd', { line: text });

        const listen = LISTEN_RE.exec(text);
        if (listen) {
          // OpenOCD also prints "Listening on port N for telnet/tcl connections";
          // only the gdb line (or a gdb-less generic line) may resolve readiness.
          if (!/telnet|tcl/i.test(text)) onReady(Number(listen[1]));
          return;
        }
        const starting = STARTING_RE.exec(text);
        if (starting && this._status === 'starting') {
          startedPort = Number(starting[1]);
          // OpenOCD prints "starting gdb server" just before it binds; treat it as
          // ready, but give the "Listening on port" line a short chance to win.
          if (!graceTimer) {
            graceTimer = setTimeout(() => {
              graceTimer = null;
              if (!settled) onReady(startedPort);
            }, 300);
            graceTimer.unref?.();
          }
        }
      };

      proc.subscribe(onLine);

      child.once('error', (e) => {
        if (settled) return;
        this._status = 'error';
        const code = e.code === 'ENOENT' ? 'E_TOOLCHAIN_MISSING' : 'E_SERVER_START';
        finish(reject, err(code, `failed to start openocd (${e.code || e.message})`, HINTS[code]));
      });

      child.once('exit', (code, signal) => {
        this.exitCode = code;
        this.exitSignal = signal;
        this._alive = false;
        if (settled) {
          if (this._status === 'ready') this._status = 'exited';
          return;
        }
        this._status = 'error';
        const classified = classifyOpenOCDError(this._lines, code);
        // One free retry when auto-allocated ports lost a race with another process.
        const canRetry =
          attempt === 0 && BIND_ERROR_RE.test(this._lines.join('\n')) && !this._fixed.gdbPort;
        if (canRetry) {
          settled = true;
          clearTimeout(shutdownTimer);
          if (graceTimer) clearTimeout(graceTimer);
          allocatePorts()
            .then((fresh) => this._spawnAndWait(fresh, attempt + 1))
            .then(resolve, reject);
          return;
        }
        finish(reject, err(classified.code, classified.message, classified.hint));
      });
    });
  }

  /** SIGTERM now, SIGKILL after a short grace period. Safe to call repeatedly. */
  _killChild() {
    const child = this._child;
    if (!child || !this._alive) return;
    try {
      child.kill('SIGTERM');
    } catch {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
    }
    const t = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
    }, 1500);
    t.unref?.();
  }

  /**
   * Ask OpenOCD to halt the target through its telnet console.
   * Used as a fallback when gdb's MI `-exec-interrupt` stalls on a real ST-LINK/OpenOCD.
   */
  async halt({ timeoutMs = 3000 } = {}) {
    const port = this._ports.telnetPort;
    if (!port) throw err('E_SERVER_UNSUPPORTED', 'OpenOCD telnet port is unavailable', 'restart the session or use run action=restart');
    return await new Promise((resolve, reject) => {
      let settled = false;
      const socket = net.connect({ host: '127.0.0.1', port });
      const done = (e) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { socket.destroy(); } catch { /* ignore */ }
        if (e) reject(e); else resolve({ halted: true, port });
      };
      const timer = setTimeout(() => done(err('E_TIMEOUT', `OpenOCD halt timed out after ${timeoutMs}ms`, 'try run action=restart')), timeoutMs);
      socket.setNoDelay?.(true);
      socket.on('error', (e) => done(err('E_TIMEOUT', `OpenOCD telnet error: ${e.message}`, 'try run action=restart')));
      socket.on('connect', () => {
        try { socket.write('halt\n'); } catch (e) { done(err('E_TIMEOUT', `OpenOCD telnet write failed: ${e.message}`)); }
      });
      socket.on('data', (buf) => {
        if (String(buf).includes('>') || String(buf).includes('halted')) done(null);
      });
    });
  }

  /** Idempotent stop; resolves once the child is gone (or was never running). */
  async stop() {
    if (this._stopping) {
      await this._stopping;
      return;
    }
    if (!this._child || !this._alive) {
      if (this._status !== 'error') this._status = 'exited';
      return;
    }
    const child = this._child;
    this._stopping = new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        resolve();
      };
      child.once('exit', finish);
      this._killChild();
      const t = setTimeout(finish, 2000);
      t.unref?.();
    });
    await this._stopping;
    this._stopping = null;
    this._proc?.dispose?.();
    this._status = 'exited';
  }
}
