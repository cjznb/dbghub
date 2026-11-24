#!/usr/bin/env node
/**
 * dbghub CLI / MCP shim.
 *
 *   dbghub mcp [--inline] [--socket <path>]     MCP stdio (stdout = JSON-RPC only, logs stderr)
 *   dbghub serve [--daemon] [--socket <path>]   daemon (NDJSON named pipe / Unix socket)
 *   dbghub doctor [--json]                      probe/toolchain diagnosis
 *
 * The shim holds no business state: it either talks to a daemon or (degraded, `--inline`) runs the
 * same SessionManager in-process. Hardware/backend/symbol implementations are loaded dynamically so
 * this file keeps working while other workflows are still landing.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runMcpServer } from '../src/protocol/mcp.mjs';
import { DaemonClient, defaultServeArgs } from '../src/protocol/daemon-client.mjs';
import {
  defaultSocketPath,
  writeDaemonInfo,
  removeDaemonInfo,
  runtimeDir,
  PROTO,
} from '../src/protocol/ipc-paths.mjs';
import { runDaemon } from '../src/daemon/daemon.mjs';
import { createSessionManager } from '../src/daemon/sessions.mjs';
import { createLogger } from '../src/util/log.mjs';
import { err, toErrorPayload } from '../src/util/errors.mjs';

const VERSION = '0.1.0';
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function importLocal(relPath) {
  return import(pathToFileURL(path.join(ROOT, relPath)).href);
}

function parseFlags(argv) {
  const flags = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--') break;
    if (arg === '--daemon') flags.daemon = true;
    else if (arg === '--inline') flags.inline = true;
    else if (arg === '--json') flags.json = true;
    else if (arg === '--verbose' || arg === '-v') flags.verbose = true;
    else if (arg === '--help' || arg === '-h') flags.help = true;
    else if (arg === '--version') flags.version = true;
    else if (arg === '--no-autostart') flags.autoStart = false;
    else if (arg === '--scan') flags.scan = true;
    else if (arg === '--socket' || arg === '--idle' || arg === '--profile') {
      const value = argv[++i];
      if (value === undefined) throw err('E_INVALID_ARG', `${arg} requires a value`, 'usage: dbghub serve --socket <path>');
      flags[arg.slice(2)] = value;
    } else if (arg.startsWith('--socket=')) flags.socket = arg.slice('--socket='.length);
    else if (arg.startsWith('--idle=')) flags.idle = arg.slice('--idle='.length);
    else if (arg.startsWith('--profile=')) flags.profile = arg.slice('--profile='.length);
    else if (arg.startsWith('-')) throw err('E_INVALID_ARG', `unknown flag ${arg}`, 'run dbghub --help');
    else flags._.push(arg);
  }
  return flags;
}

async function loadConfigSafe(log) {
  try {
    const mod = await importLocal('src/config/load.mjs');
    if (typeof mod.loadConfig === 'function') return mod.loadConfig({});
  } catch (e) {
    log?.warn?.(`config loader unavailable, using built-in defaults: ${e && e.message}`);
  }
  return {
    daemon: { mode: 'auto', idle_exit_min: 0, max_sessions: 8, allow_raw: false, allow_attach: false },
    profiles: {},
    workspace: { source_map: [], symbol_paths: [] },
  };
}

/** Load optional workflow implementations; each factory stays null when its module is not there yet. */
async function loadImplementations(log) {
  const impl = { gdbFactory: null, backendFactory: null, symbolLoader: null, probeManager: null };

  try {
    const gdb = await importLocal('src/gdb/gdb-session.mjs');
    if (typeof gdb.GdbSession === 'function') {
      impl.gdbFactory = (opts) => new gdb.GdbSession(opts);
    }
  } catch { /* gdb engine not landed yet */ }

  if (!impl.gdbFactory) {
    impl.gdbFactory = async () => {
      throw err(
        'E_TOOLCHAIN_MISSING',
        'no gdb adapter is available in this checkout',
        'pass a working profiles.<name>.gdb and make sure src/gdb/gdb-session.mjs exists',
      );
    };
  }

  try {
    const backends = await importLocal('src/backends/openocd.mjs');
    if (typeof backends.OpenOCD === 'function') {
      impl.backendFactory = ({ profile = {}, config = {}, log: backendLog }) =>
        new backends.OpenOCD({
          command: config.backends?.openocd?.command,
          search: config.backends?.openocd?.search,
          interface: profile.interface || 'stlink',
          target: profile.target || 'stm32f1x',
          transport: profile.transport || 'swd',
          speedKhz: profile.speed_khz || 480,
          extraArgs: Array.isArray(profile.server_args) ? profile.server_args : [],
          log: backendLog || log,
        });
    }
  } catch { /* backend not landed yet */ }

  try {
    const symbols = await importLocal('src/symbols/index.mjs');
    if (typeof symbols.loadSymbols === 'function') impl.symbolLoader = symbols.loadSymbols;
  } catch { /* symbols not landed yet */ }

  try {
    const probes = await importLocal('src/probes/registry.mjs');
    const parts = {};
    for (const name of ['discoverProbes', 'listBackends', 'doctor', 'plan']) {
      if (typeof probes[name] === 'function') parts[name] = probes[name];
    }
    if (Object.keys(parts).length) impl.probeManager = parts;
  } catch { /* probe registry not landed yet */ }

  return impl;
}

function buildManager({ config, impl, log, daemonInfo }) {
  return createSessionManager({
    config,
    gdbFactory: impl.gdbFactory,
    backendFactory: impl.backendFactory || undefined,
    symbolLoader: impl.symbolLoader || undefined,
    probeManager: impl.probeManager || undefined,
    log,
    daemonInfo,
    workspace: process.cwd(),
  });
}

/**
 * Prefer the Lead-owned production wiring (src/app/runtime.mjs) so the CLI and the MCP shim share
 * exactly one integration point; fall back to the dynamic-import wiring while files are landing.
 */
async function createManagerContext(log, daemonInfo = { mode: 'daemon', socket: null }) {
  try {
    const runtimeMod = await importLocal('src/app/runtime.mjs');
    if (typeof runtimeMod.createRuntime === 'function') {
      const runtime = runtimeMod.createRuntime({ cwd: process.cwd(), log, daemonInfo });
      if (runtime && runtime.manager && runtime.config) return { config: runtime.config, manager: runtime.manager, wiring: 'app/runtime' };
    }
  } catch (e) {
    log?.debug?.(`app/runtime wiring unavailable: ${e && e.message}`);
  }
  const config = await loadConfigSafe(log);
  const impl = await loadImplementations(log);
  const manager = buildManager({ config, impl, log, daemonInfo });
  return { config, manager, wiring: 'bin/fallback' };
}

function resolveSocketPath(flags, config) {
  if (flags.socket) return flags.socket;
  if (process.env.DBGHUB_SOCKET) return process.env.DBGHUB_SOCKET;
  return defaultSocketPath({});
}

// --------------------------------------------------------------------- serve

async function cmdServe(flags) {
  const daemonMode = flags.daemon === true;
  const runtime = runtimeDir({});
  const logFile = daemonMode ? path.join(runtime, 'daemon.log') : null;
  const log = createLogger({ name: 'dbghub-daemon', file: logFile, level: flags.verbose ? 'debug' : 'info' });

  if (daemonMode) {
    // Detached daemon: stdout/stderr may be pipes owned by the spawning shim; keep them quiet.
    try { process.stdout.write(''); } catch { /* ignore */ }
  }

  const { config, manager, wiring } = await createManagerContext(log, {
    mode: daemonMode ? 'daemon' : 'inline',
    socket: flags.socket || process.env.DBGHUB_SOCKET || null,
  });
  const socketPath = resolveSocketPath(flags, config);
  log.info(`wiring: ${wiring}`);
  // Detached autostart must never leak a forever-daemon: an explicit 0 in config means "never",
  // but a spawned daemon with no sessions falls back to the design default (30 min).
  const configIdle = Number(config.daemon?.idle_exit_min);
  const idleExitMin = flags.idle !== undefined
    ? Number(flags.idle)
    : configIdle > 0
      ? configIdle
      : daemonMode
        ? 30
        : 0;

  let daemon;
  try {
    daemon = await runDaemon({
      socketPath,
      handlers: manager.handlers,
      idleExitMin,
      hasActiveSessions: () => manager.sessionCount,
      log,
      onIdle: async () => {
        await manager.closeAll();
      },
    });
  } catch (e) {
    if (e && e.code === 'E_DAEMON_STARTING' && daemonMode) {
      // Another daemon already owns the endpoint: autostart is idempotent, exit quiet and success.
      log.info(`daemon already running at ${socketPath}`);
      return 0;
    }
    throw e;
  }

  if (daemonMode) {
    writeDaemonInfo({
      pid: process.pid,
      version: VERSION,
      proto: PROTO,
      socket: socketPath,
      started_at: new Date().toISOString(),
    });
    log.info(`daemon listening on ${socketPath}`);
  }

  let shuttingDown = false;
  async function shutdown(why) {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      await manager.closeAll();
      await daemon.close(why);
    } finally {
      if (daemonMode) removeDaemonInfo();
      log.close?.();
    }
  }

  const onSignal = (signal) => {
    void shutdown(signal).then(() => process.exit(0));
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  const closed = await daemon.whenClosed;
  if (daemonMode) removeDaemonInfo();
  log.info(`daemon closed (${closed && closed.why})`);
  return 0;
}

// ----------------------------------------------------------------------- mcp

function inlineClientFor(manager) {
  return {
    async callTool(name, args) {
      const handler = manager.handlers[name];
      if (typeof handler !== 'function') throw err('E_INVALID_ARG', `unknown tool: ${name}`, 'see tools/list');
      return handler(args, { clientId: `inline:${process.pid}`, workspace: process.cwd() });
    },
    async close() {
      await manager.closeAll();
    },
  };
}

async function cmdMcp(flags) {
  const log = createLogger({ name: 'dbghub-mcp', level: process.env.DBGHUB_LOG_LEVEL || 'error' });
  const config = await loadConfigSafe(log);
  const mode = flags.inline || process.env.DBGHUB_INLINE === '1'
    ? 'inline'
    : String(config.daemon?.mode || 'auto');

  let client = null;
  let inline = null;

  async function ensureInline(reason) {
    if (inline) return inline;
    const { manager, wiring } = await createManagerContext(log, { mode: 'inline', socket: null });
    inline = { manager, client: inlineClientFor(manager) };
    log.warn(`running in inline mode${reason ? ` (${reason})` : ''}: wiring=${wiring}; sessions end with this process and cannot be shared`);
    return inline;
  }

  if (mode === 'inline') {
    client = (await ensureInline('mode=inline')).client;
  } else {
    const socketPath = flags.socket || process.env.DBGHUB_SOCKET || undefined;
    try {
      const dc = await DaemonClient.connect({
        socketPath,
        autoStart: flags.autoStart !== false && mode !== 'daemon',
        args: defaultServeArgs(socketPath || defaultSocketPath({})),
        timeoutMs: 15000,
        log,
      });
      const callTimeout = Number(process.env.DBGHUB_CALL_TIMEOUT_MS) || 55000;
      client = {
        callTool: (name, args) => dc.call(name, args, { timeoutMs: callTimeout }),
        close: () => dc.close(),
      };
      log.info(`connected to daemon at ${dc.socketPath}`);
    } catch (e) {
      if (mode === 'daemon') throw e;
      client = (await ensureInline(`daemon unavailable: ${e && e.code ? e.code : e}`)).client;
    }
  }

  const server = runMcpServer({
    stdin: process.stdin,
    stdout: process.stdout,
    client,
    version: VERSION,
    onError: (e) => log.error(`mcp: ${e && e.message ? e.message : e}`),
  });

  // A host that closes our stdout is done with us: exit without noise.
  process.stdout.on('error', () => process.exit(0));

  let finished = false;
  const finish = async () => {
    if (finished) return;
    finished = true;
    // Let in-flight tools/call responses reach the host before we drop the transport.
    try { await server.awaitDrain(1500); } catch { /* ignore */ }
    try { await server.close(); } catch { /* ignore */ }
    try { await client.close?.(); } catch { /* ignore */ }
    process.exit(0);
  };
  process.stdin.on('end', () => void finish());
  process.stdin.on('close', () => void finish());
  process.on('SIGINT', () => void finish());
  process.on('SIGTERM', () => void finish());
}

// -------------------------------------------------------------------- doctor

async function cmdDoctor(flags) {
  const log = createLogger({ name: 'dbghub-doctor', level: 'error' });
  if (!flags.inline) {
    try {
      const dc = await DaemonClient.connect({
        socketPath: flags.socket || process.env.DBGHUB_SOCKET || undefined,
        autoStart: false,
        timeoutMs: 1500,
        log,
      });
      try {
        const result = await dc.call('discover', { action: 'doctor', profile: flags.profile });
        process.stdout.write(JSON.stringify(result, null, 2) + '\n');
        return 0;
      } finally {
        await dc.close();
      }
    } catch (e) {
      log.warn(`daemon not reachable (${e && e.code ? e.code : e}); running inline doctor`);
    }
  }
  const { manager } = await createManagerContext(log, { mode: 'inline', socket: null });
  const result = await manager.discover({ action: 'doctor', profile: flags.profile });
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  return 0;
}

// ---------------------------------------------------------------------- main

function usage() {
  return [
    'dbghub — agent-oriented C/C++ debugger MCP',
    '',
    'Usage:',
    '  dbghub mcp [--inline] [--socket <path>]   run the MCP stdio shim (stdout = JSON-RPC only)',
    '  dbghub serve [--daemon] [--socket <path>] [--idle <min>]',
    '                                            run the debug daemon',
    '  dbghub doctor [--json] [--profile <name>] diagnose probes/toolchains/backends',
    '',
    'Env: DBGHUB_SOCKET, DBGHUB_INLINE=1, DBGHUB_MODE, DBGHUB_LOG_LEVEL',
  ].join('\n');
}

async function main(argv) {
  const flags = parseFlags(argv);
  if (flags.version) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  const command = flags._[0] || (flags.help ? 'help' : 'mcp');
  if (flags.help || command === 'help') {
    process.stdout.write(usage() + '\n');
    return 0;
  }
  switch (command) {
    case 'mcp':
      return cmdMcp(flags);
    case 'serve':
      return cmdServe(flags);
    case 'doctor':
      return cmdDoctor(flags);
    default:
      throw err('E_INVALID_ARG', `unknown command "${command}"`, 'use mcp | serve | doctor');
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    if (typeof code === 'number' && code !== 0) process.exitCode = code;
  },
  (e) => {
    const payload = toErrorPayload(e);
    process.stderr.write(`dbghub: ${payload.code}: ${payload.message}${payload.hint ? ` (${payload.hint})` : ''}\n`);
    process.exitCode = 1;
  },
);
