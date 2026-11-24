/**
 * Probe registry: backend/toolchain discovery, OpenOCD-based probe enumeration,
 * `doctor` diagnostics and backend `plan` selection.
 *
 * Design notes:
 * - Discovery never throws for "no hardware": it returns `{probes:[], warnings:[...]}`.
 * - OpenOCD is the v1 enumeration source: one short `init;shutdown` run per
 *   interface cfg (`stlink`, `jlink`, `cmsis-dap`); `scan:true` additionally loads
 *   a target cfg to read voltage/DPIDR and prove the target is attachable.
 * - Every process call goes through an injectable `run()` so tests stay offline.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnCapture } from '../backends/childproc.mjs';

const HINTS = {
  E_TOOLCHAIN_MISSING:
    'Install the missing tool or point dbghub config at an absolute path (backends.openocd.command / profiles.*.gdb).',
  E_PROBE_NOT_FOUND:
    'Plug the probe and check USB/driver: Linux -> OpenOCD contrib/60-openocd.rules (plugdev); Windows -> ST VCP/WinUSB or SEGGER driver.',
  E_PROBE_PERMISSION:
    'Fix probe access: install udev rules / replace the driver (Zadig/WinUSB) / close the other session holding the probe.',
  E_PROBE_FIRMWARE:
    'Update probe firmware: ST-LINK -> STM32CubeProgrammer; J-Link -> JLinkConfigurator or `JLinkExe -fwupdate`.',
  E_SERVER_START:
    'Check OpenOCD `-s <scripts>` path and interface/target cfg names; rerun with `--scan` for more detail.',
  E_TARGET_UNKNOWN:
    'Target cfg is missing from the OpenOCD scripts tree; choose another profile.target or install the matching OpenOCD scripts.',
};

/** Known backends and how to find/version them. */
const BACKEND_SPECS = [
  {
    id: 'openocd',
    names: ['openocd', 'openocd.exe'],
    versionArgs: ['--version'],
    versionRe: /Open On-Chip Debugger\s+([0-9][\w.+-]*)/,
    known: [
      'G:\\mcu\\openOCD\\xpack-openocd-0.12.0-7\\bin\\openocd.exe',
      'C:\\Program Files\\OpenOCD\\bin\\openocd.exe',
      'C:\\Program Files (x86)\\OpenOCD\\bin\\openocd.exe',
      '/usr/bin/openocd',
      '/usr/local/bin/openocd',
      '/opt/homebrew/bin/openocd',
    ],
  },
  {
    id: 'jlink',
    names: ['JLinkGDBServerCL', 'JLinkGDBServerCL.exe', 'JLinkGDBServer', 'JLinkGDBServer.exe'],
    versionArgs: ['-version'],
    versionRe: /V([0-9]+\.[0-9]+[a-z]?)/i,
    known: [
      'C:\\Program Files\\SEGGER\\JLink\\JLinkGDBServerCL.exe',
      'C:\\Program Files (x86)\\SEGGER\\JLink\\JLinkGDBServerCL.exe',
      '/opt/SEGGER/JLink/JLinkGDBServerCLExe',
      '/usr/bin/JLinkGDBServerCLExe',
    ],
  },
  {
    id: 'pyocd',
    names: ['pyocd', 'pyocd.exe'],
    versionArgs: ['--version'],
    versionRe: /([0-9]+\.[0-9]+\.[0-9]+)/,
    known: [],
  },
  {
    id: 'stlink',
    names: ['st-util', 'st-util.exe'],
    versionArgs: ['--version'],
    versionRe: /v?([0-9]+\.[0-9]+(?:\.[0-9]+)?)/,
    known: [],
  },
];

/** Toolchains are the debugger front-ends (GDB), plus OpenOCD for convenience. */
const TOOLCHAIN_SPECS = [
  {
    id: 'arm-none-eabi-gdb',
    names: ['arm-none-eabi-gdb', 'arm-none-eabi-gdb.exe'],
    versionArgs: ['--version'],
    versionRe: /\b([0-9]+\.[0-9]+(?:\.[0-9]+)?)/,
    known: [
      'G:\\mcu\\Arm GNU Toolchain arm-none-eabi\\15.2.rel1\\bin\\arm-none-eabi-gdb.exe',
      'C:\\Program Files (x86)\\Arm GNU Toolchain arm-none-eabi\\bin\\arm-none-eabi-gdb.exe',
      '/usr/bin/arm-none-eabi-gdb',
      '/opt/homebrew/bin/arm-none-eabi-gdb',
    ],
  },
  {
    id: 'gdb',
    names: ['gdb', 'gdb.exe'],
    versionArgs: ['--version'],
    versionRe: /\bGNU gdb\b.*?\b([0-9]+\.[0-9]+(?:\.[0-9]+)?)/,
    known: [
      'D:\\msys64\\mingw64\\bin\\gdb.exe',
      'C:\\msys64\\mingw64\\bin\\gdb.exe',
      '/usr/bin/gdb',
      '/usr/local/bin/gdb',
      '/opt/homebrew/bin/gdb',
    ],
  },
  {
    id: 'openocd',
    names: ['openocd', 'openocd.exe'],
    versionArgs: ['--version'],
    versionRe: /Open On-Chip Debugger\s+([0-9][\w.+-]*)/,
    known: [
      'G:\\mcu\\openOCD\\xpack-openocd-0.12.0-7\\bin\\openocd.exe',
      'C:\\Program Files\\OpenOCD\\bin\\openocd.exe',
      '/usr/bin/openocd',
      '/usr/local/bin/openocd',
    ],
  },
];

const INTERFACE_KINDS = { stlink: 'stlink', jlink: 'jlink', 'cmsis-dap': 'cmsis-dap' };
const DEFAULT_CAPABILITIES = {
  stlink: { swo: true, rtt: true, connectUnderReset: true, multicore: false, rtos: true },
  jlink: { swo: true, rtt: true, connectUnderReset: true, multicore: true, rtos: true },
  'cmsis-dap': { swo: false, rtt: false, connectUnderReset: false, multicore: false, rtos: true },
};

function isAbs(p) {
  return path.isAbsolute(p) || /^[A-Za-z]:[\\/]/.test(p);
}

function hex4(n) {
  return Number(n).toString(16).padStart(4, '0').toLowerCase();
}

/** Default process runner; merges stdout+stderr, kills on timeout, pipe/file fallback. */
function defaultRun({ command, args = [], timeoutMs = 8000, cwd, env }) {
  return spawnCapture({ command, args, timeoutMs, cwd, env });
}

function makeDeps(opts = {}) {
  return {
    env: opts.env || process.env,
    platform: opts.platform || process.platform,
    run: opts.run || defaultRun,
    exists: opts.exists || ((p) => fs.existsSync(p)),
    knownPaths: opts.knownPaths || null,
    timeoutMs: Number(opts.timeoutMs) || 8000,
  };
}

function pathCandidates(spec, deps) {
  const out = [];
  if (spec.id === 'openocd') {
    const override = deps.env?.DBGHUB_OPENOCD;
    if (override) out.push(override);
  }
  const known = deps.knownPaths?.[spec.id] ?? spec.known ?? [];
  out.push(...known);
  return out;
}

function pathLookup(names, deps) {
  const env = deps.env || {};
  const dirs = String(env.PATH || env.Path || '').split(deps.platform === 'win32' ? ';' : ':');
  const exts =
    deps.platform === 'win32'
      ? String(env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';')
      : [''];
  for (const name of names) {
    if (isAbs(name)) {
      if (deps.exists(name)) return name;
      continue;
    }
    for (const dir of dirs) {
      if (!dir) continue;
      for (const ext of exts) {
        const lower = name.toLowerCase();
        const full = path.join(dir, lower.endsWith(String(ext).toLowerCase()) ? name : name + ext);
        if (deps.exists(full)) return full;
      }
    }
  }
  return null;
}

function resolveCommand(spec, deps) {
  for (const p of pathCandidates(spec, deps)) {
    try {
      if (p && deps.exists(p)) return p;
    } catch {
      /* ignore */
    }
  }
  return pathLookup(spec.names, deps);
}

function parseVersion(text, re) {
  if (!text) return null;
  const m = re?.exec(text);
  return m ? m[1] : null;
}

async function probeOne(spec, deps) {
  const found = resolveCommand(spec, deps);
  if (!found) return { id: spec.id, available: false, path: null, version: null };
  const r = await deps.run({
    command: found,
    args: [...spec.versionArgs],
    timeoutMs: deps.timeoutMs,
    env: deps.env,
  });
  const output = [r.output || '', r.spawnError ? String(r.spawnError.message) : ''].join('\n');
  return { id: spec.id, available: true, path: found, version: parseVersion(output, spec.versionRe) };
}

/** [{id:'openocd',available,path,version,search?}] — never throws. */
export async function listBackends(env = process.env, opts = {}) {
  const deps = makeDeps({ ...opts, env });
  const out = [];
  for (const spec of BACKEND_SPECS) {
    const entry = await probeOne(spec, deps);
    if (entry.available && spec.id === 'openocd') entry.search = guessSearchDir(entry.path, deps);
    out.push(entry);
  }
  return out;
}

/** [{id:'arm-none-eabi-gdb'|'gdb'|'openocd',available,path,version}] — never throws. */
export async function findToolchains(env = process.env, opts = {}) {
  const deps = makeDeps({ ...opts, env });
  const out = [];
  for (const spec of TOOLCHAIN_SPECS) out.push(await probeOne(spec, deps));
  return out;
}

/** Best-effort OpenOCD scripts dir from the binary location / env override. */
export function guessSearchDir(command, deps = {}) {
  const env = deps.env || process.env;
  const exists = deps.exists || ((p) => fs.existsSync(p));
  const cands = [];
  if (env.DBGHUB_OPENOCD_SCRIPTS) cands.push(env.DBGHUB_OPENOCD_SCRIPTS);
  if (command) {
    const dir = path.dirname(command);
    cands.push(path.resolve(dir, '..', 'openocd', 'scripts'));
    cands.push(path.resolve(dir, '..', 'share', 'openocd', 'scripts'));
    cands.push(path.resolve(dir, '..', '..', 'share', 'openocd', 'scripts'));
  }
  cands.push(
    '/usr/share/openocd/scripts',
    '/usr/local/share/openocd/scripts',
    '/opt/homebrew/share/openocd/scripts',
    'C:\\Program Files\\OpenOCD\\share\\openocd\\scripts',
    'C:\\Program Files (x86)\\OpenOCD\\share\\openocd\\scripts',
  );
  for (const c of cands) {
    try {
      if (c && exists(c)) return c;
    } catch {
      /* ignore */
    }
  }
  return null;
}

function serializeCommand(input) {
  if (!input) return null;
  if (input instanceof Promise) return null;
  if (typeof input === 'string') return { command: input, search: null };
  if (typeof input === 'object') {
    const command = input.command || input.path || null;
    if (!command) return null;
    return { command, search: input.search || null };
  }
  return null;
}

async function resolveOpenOCD(input, deps) {
  const direct = serializeCommand(input);
  if (direct) {
    return {
      command: direct.command,
      search: direct.search || guessSearchDir(direct.command, deps),
    };
  }
  const pathFound = pathLookup(BACKEND_SPECS[0].names, deps);
  const known = pathFound || pathCandidates(BACKEND_SPECS[0], deps).find((p) => {
    try {
      return p && deps.exists(p);
    } catch {
      return false;
    }
  });
  if (!known) return null;
  return { command: known, search: guessSearchDir(known, deps) };
}

function buildDiscoveryArgs({ search, iface, target, transport = 'swd', speedKhz = 480, scan = false }) {
  const args = [];
  if (search) args.push('-s', search);
  args.push('-f', `interface/${iface}.cfg`);
  if (transport) args.push('-c', `transport select ${transport}`);
  if (speedKhz) args.push('-c', `adapter speed ${speedKhz}`);
  if (scan && target) args.push('-f', `target/${target}.cfg`);
  args.push('-c', 'init');
  if (scan) args.push('-c', 'halt');
  args.push('-c', 'shutdown');
  return args;
}

function firstMatch(lines, re) {
  for (const line of lines) {
    const m = re.exec(line);
    if (m) return m;
  }
  return null;
}

function firstErrorSnippet(lines) {
  const line = lines.find((l) => /Error:/i.test(l)) || lines.find((l) => /^\s*Error/i.test(l));
  return line
    ? line.replace(/^.*?Error:\s*/i, '').replace(/\u001b\[[0-9;]*m/g, '').trim().slice(0, 160)
    : '';
}

function probeKey(kind, serial, vid, pid) {
  if (serial) return `${kind}:${serial}`;
  if (Number.isFinite(vid) && Number.isFinite(pid)) return `${kind}:${hex4(vid)}:${hex4(pid)}`;
  return `${kind}:unknown`;
}

/**
 * Parse one OpenOCD transcript into a Probe record (contract shape + voltage/dpidr).
 * Returns null when no probe of the requested interface family was detected.
 */
export function parseProbeLog(text, { interface: iface = 'stlink', transport = 'swd' } = {}) {
  const lines = String(text || '').split(/\r?\n/);
  const kind = INTERFACE_KINDS[iface] || iface;
  const vidpid = firstMatch(lines, /VID:PID\s+([0-9A-Fa-f]{4}):([0-9A-Fa-f]{4})/i);
  const serialMatch =
    firstMatch(lines, /S\/N[: ]+([0-9A-Za-z]+)/) ||
    firstMatch(lines, /Serial(?: Number| No\.?)?[:= ]+([0-9A-Za-z]{6,})/i);
  const voltage = firstMatch(lines, /Target voltage:\s*([0-9.]+)/i);
  const dpidr = firstMatch(lines, /SWD DPIDR\s+(0x[0-9A-Fa-f]+)/i) || firstMatch(lines, /DPIDR\s*[=:]\s*(0x[0-9A-Fa-f]+)/i);
  const clock = firstMatch(lines, /clock speed\s+(\d+)\s*kHz/i);
  const bp = firstMatch(lines, /target has\s+(\d+)\s+breakpoints,\s+(\d+)\s+watchpoints/i);
  const cpu = firstMatch(lines, /\[([\w.]+)\]\s+(Cortex-[\w+]+)/i);

  let probe = null;
  if (kind === 'stlink') {
    const m = firstMatch(lines, /STLINK\s+(\S+)\s+\(API v\d\)\s+VID:PID\s+([0-9A-Fa-f]{4}):([0-9A-Fa-f]{4})/i);
    if (m) {
      const fw = m[1];
      const vid = parseInt(m[2], 16);
      const pid = parseInt(m[3], 16);
      const model = /^V2/i.test(fw) ? 'ST-LINK/V2' : /^V3/i.test(fw) ? 'ST-LINK/V3' : 'ST-LINK';
      probe = {
        kind: 'stlink',
        serial: serialMatch ? serialMatch[1] : null,
        firmware: fw,
        vid,
        pid,
        model,
      };
    }
  } else if (kind === 'jlink') {
    if (firstMatch(lines, /Info\s*:.*J-Link/i)) {
      const fw = firstMatch(lines, /Firmware:\s*([^\r\n]+)/i) || firstMatch(lines, /J-Link\s+(V\d+[^\s]*)/i);
      probe = {
        kind: 'jlink',
        serial: serialMatch ? serialMatch[1] : null,
        firmware: fw ? fw[1].trim() : null,
        vid: vidpid ? parseInt(vidpid[1], 16) : 0x1366,
        pid: vidpid ? parseInt(vidpid[2], 16) : null,
        model: 'J-Link',
      };
    }
  } else if (kind === 'cmsis-dap') {
    if (firstMatch(lines, /Info\s*:.*CMSIS-DAP/i)) {
      const fw = firstMatch(lines, /(?:FW|Firmware)(?:\s*Version)?[:= ]+([\w.]+)/i);
      probe = {
        kind: 'cmsis-dap',
        serial: serialMatch ? serialMatch[1] : null,
        firmware: fw ? fw[1] : null,
        vid: vidpid ? parseInt(vidpid[1], 16) : null,
        pid: vidpid ? parseInt(vidpid[2], 16) : null,
        model: 'CMSIS-DAP',
      };
    }
  }
  if (!probe) return null;

  const caps = DEFAULT_CAPABILITIES[probe.kind] || DEFAULT_CAPABILITIES.stlink;
  return {
    key: probeKey(probe.kind, probe.serial, probe.vid, probe.pid),
    kind: probe.kind,
    serial: probe.serial,
    firmware: probe.firmware ?? null,
    vid: probe.vid ?? null,
    pid: probe.pid ?? null,
    model: probe.model,
    transport,
    status: 'ready',
    servers: ['openocd'],
    capabilities: { ...caps },
    voltage: voltage ? Number(voltage[1]) : null,
    dpidr: dpidr ? dpidr[1] : null,
    clock_khz: clock ? Number(clock[1]) : null,
    breakpoints: bp ? Number(bp[1]) : null,
    watchpoints: bp ? Number(bp[2]) : null,
    target: cpu ? cpu[1].replace(/\.cpu$/, '') : null,
    core: cpu ? cpu[2] : null,
  };
}

/**
 * Enumerate probes through short OpenOCD runs. `scan:true` also loads a target cfg
 * (`init;halt;shutdown`) to validate voltage/DPIDR. Never throws for missing hardware.
 */
export async function discoverProbes(options = {}) {
  const {
    scan = false,
    env = process.env,
    interfaces = ['stlink', 'jlink', 'cmsis-dap'],
    target = 'stm32f1x',
    transport = 'swd',
    speedKhz = 480,
    timeoutMs = 12000,
    openocd = null,
    run = null,
    exists = null,
  } = options;

  const deps = makeDeps({ ...options, env, run, exists, timeoutMs: options.versionTimeoutMs });
  const oc = await resolveOpenOCD(openocd, deps);
  if (!oc) {
    return {
      probes: [],
      warnings: ['openocd not found; cannot enumerate probes (set backends.openocd.command or install OpenOCD)'],
    };
  }

  const probes = new Map();
  const warnings = [];
  let accessDenied = false;
  for (const iface of interfaces) {
    const args = buildDiscoveryArgs({ search: oc.search, iface, target, transport, speedKhz, scan });
    const r = await deps.run({ command: oc.command, args, timeoutMs, env: deps.env });
    const output = r.output || '';
    if (r.spawnError) {
      warnings.push(`openocd failed to spawn (${r.spawnError.code || r.spawnError.message})`);
      continue;
    }
    if (/LIBUSB_ERROR_ACCESS|permission denied|access denied/i.test(output)) accessDenied = true;
    const parsed = parseProbeLog(output, { interface: iface, transport });
    if (!parsed) continue;
    if (r.timedOut) {
      parsed.status = 'unknown';
      warnings.push(`${parsed.key}: openocd timed out while scanning ${iface}`);
    } else if (r.code !== 0) {
      parsed.status = 'unknown';
      const snippet = firstErrorSnippet(output.split(/\r?\n/));
      if (snippet) warnings.push(`${parsed.key}: ${snippet}`);
    }
    const prev = probes.get(parsed.key);
    if (prev) {
      // Prefer the record carrying scan evidence (DPIDR/voltage).
      if (!prev.dpidr && parsed.dpidr) probes.set(parsed.key, { ...prev, ...parsed });
    } else {
      probes.set(parsed.key, parsed);
    }
  }

  const list = [...probes.values()];
  if (!list.length) {
    if (accessDenied) {
      warnings.push(`probe access denied (LIBUSB_ERROR_ACCESS); fix driver/udev permissions ('${HINTS.E_PROBE_PERMISSION}')`);
    } else {
      warnings.push(
        `no probes detected (checked ${interfaces.join(', ')}); connect a probe or run \`discover action=doctor\``,
      );
    }
  }
  return { probes: list, warnings };
}

function resolveProfile(profile, profiles) {
  if (!profile) return null;
  if (typeof profile === 'object') return { ...profile };
  const fromMap = profiles && typeof profiles === 'object' ? profiles[profile] : null;
  return fromMap ? { ...fromMap, name: profile } : { name: profile };
}

/**
 * Doctor: backends + toolchains + probes + actionable issues.
 * `options.backends` / `options.toolchains` / `options.probes` are test seams.
 */
export async function doctor(options = {}) {
  const { env = process.env, profile = null, profiles = null, scan = true, openocd = null } = options;
  const [backends, toolchains, disc] = await Promise.all([
    options.backends ? Promise.resolve(options.backends) : listBackends(env, options),
    options.toolchains ? Promise.resolve(options.toolchains) : findToolchains(env, options),
    options.probes
      ? Promise.resolve({ probes: options.probes, warnings: [] })
      : discoverProbes({ ...options, scan, openocd, env }),
  ]);
  const probes = disc.probes || [];
  const warnings = [...(disc.warnings || [])];
  const issues = [];

  const oc = backends.find((b) => b.id === 'openocd');
  if (!oc?.available) {
    issues.push({
      level: 'error',
      code: 'E_TOOLCHAIN_MISSING',
      message: 'OpenOCD not found',
      hint: `Install OpenOCD or set backends.openocd.command; ${HINTS.E_TOOLCHAIN_MISSING}`,
    });
  }
  const gdb =
    toolchains.find((t) => t.id === 'arm-none-eabi-gdb' && t.available) ||
    toolchains.find((t) => t.id === 'gdb' && t.available);
  if (!gdb) {
    issues.push({
      level: 'error',
      code: 'E_TOOLCHAIN_MISSING',
      message: 'No GDB front-end found (arm-none-eabi-gdb or gdb)',
      hint: `Install Arm GNU Toolchain/gdb or set profiles.*.gdb; ${HINTS.E_TOOLCHAIN_MISSING}`,
    });
  }
  if (!probes.length) {
    issues.push({
      level: 'error',
      code: 'E_PROBE_NOT_FOUND',
      message: 'No debug probe detected',
      hint: HINTS.E_PROBE_NOT_FOUND,
    });
  }
  for (const p of probes) {
    if (p.status === 'permission') {
      issues.push({ level: 'error', code: 'E_PROBE_PERMISSION', message: `${p.key}: probe access denied`, hint: HINTS.E_PROBE_PERMISSION });
    } else if (p.status === 'firmware') {
      issues.push({ level: 'warn', code: 'E_PROBE_FIRMWARE', message: `${p.key}: firmware update required`, hint: HINTS.E_PROBE_FIRMWARE });
    } else if (p.status === 'busy') {
      issues.push({ level: 'warn', code: 'E_PROBE_BUSY', message: `${p.key}: probe busy`, hint: HINTS.E_PROBE_BUSY });
    }
  }

  const prof = resolveProfile(profile, profiles);
  if (prof && oc?.available) {
    const search = oc.search || guessSearchDir(oc.path, makeDeps(options));
    if (!search) {
      issues.push({
        level: 'error',
        code: 'E_SERVER_START',
        message: 'OpenOCD scripts directory not found',
        hint: 'Set backends.openocd.search (or DBGHUB_OPENOCD_SCRIPTS) to the OpenOCD scripts dir.',
      });
    } else {
      if (prof.interface && !fsExistsSafe(path.join(search, 'interface', `${prof.interface}.cfg`), options)) {
        issues.push({
          level: 'error',
          code: 'E_SERVER_UNSUPPORTED',
          message: `interface cfg not found: interface/${prof.interface}.cfg`,
          hint: `Check profile.interface against ${path.join(search, 'interface')}.`,
        });
      }
      if (prof.target && !fsExistsSafe(path.join(search, 'target', `${prof.target}.cfg`), options)) {
        issues.push({
          level: 'error',
          code: 'E_TARGET_UNKNOWN',
          message: `target cfg not found: target/${prof.target}.cfg`,
          hint: `${HINTS.E_TARGET_UNKNOWN} (scripts: ${search})`,
        });
      }
    }
    const chosen = probes.find((p) => p.key === prof.probe) || probes[0];
    if (prof.speed_khz && chosen?.clock_khz && Number(prof.speed_khz) !== Number(chosen.clock_khz)) {
      issues.push({
        level: 'info',
        code: 'NOTICE_ADAPTER_SPEED',
        message: `adapter speed requested ${prof.speed_khz} kHz, actual ${chosen.clock_khz} kHz`,
        hint: 'Target cfg may re-set adapter speed; move `adapter speed` after the target cfg (-c after -f target/...).',
      });
    }
  }
  return { probes, toolchains, backends, issues, warnings };
}

function fsExistsSafe(p, opts = {}) {
  const exists = opts.exists || ((x) => fs.existsSync(x));
  try {
    return exists(p);
  } catch {
    return false;
  }
}

/**
 * Pure planning: choose probe + backend, explain why, list alternatives.
 * Returns contract shape `{probe,backend,profile,reasons,alternatives}`.
 */
export function plan({ probes = [], profiles = {}, profile = null, probe = 'auto', backend = 'auto' } = {}) {
  const reasons = [];
  const alternatives = [];
  const prof = resolveProfile(profile, profiles);
  if (profile && !prof) reasons.push(`profile '${profile}' not defined`);
  if (prof?.target) reasons.push(`profile target=${prof.target} interface=${prof.interface || '?'} transport=${prof.transport || 'swd'}`);

  let selected = null;
  if (probe && probe !== 'auto') {
    selected = probes.find((p) => p.key === probe || p.serial === probe || p.kind === probe) || null;
    if (selected) reasons.push(`probe '${probe}' matched ${selected.key}`);
    else reasons.push(`probe '${probe}' not found among ${probes.length} detected probe(s)`);
  } else {
    selected = probes.find((p) => p.status === 'ready') || probes[0] || null;
    if (selected) reasons.push(`auto-selected ${selected.key} (status=${selected.status})`);
    else reasons.push('no probe detected; connect a probe or declare probes.* in config');
  }

  const servers = selected?.servers?.length ? selected.servers : ['openocd'];
  let chosenBackend = null;
  if (backend && backend !== 'auto') {
    chosenBackend = backend;
    if (selected && !servers.includes(backend)) {
      reasons.push(`backend '${backend}' unsupported by ${selected.key}; supported=[${servers.join(', ')}]`);
      for (const s of servers) alternatives.push({ probe: selected.key, backend: s, why: 'probe-compatible' });
    } else {
      reasons.push(`backend '${backend}' explicitly requested`);
    }
  } else {
    const profileBackend = prof?.backend && prof.backend !== 'auto' ? prof.backend : null;
    chosenBackend = profileBackend && servers.includes(profileBackend) ? profileBackend : servers[0] || 'openocd';
    reasons.push(
      profileBackend && servers.includes(profileBackend)
        ? `backend '${chosenBackend}' from profile.backend`
        : `backend '${chosenBackend}' from probe.servers`,
    );
  }

  for (const other of probes) {
    if (other === selected) continue;
    alternatives.push({ probe: other.key, backend: other.servers?.[0] || 'openocd', why: `status=${other.status}` });
  }
  for (const s of servers) {
    if (s !== chosenBackend) alternatives.push({ probe: selected?.key || null, backend: s, why: 'probe-compatible' });
  }

  return {
    probe: selected ? selected.key : null,
    backend: chosenBackend,
    profile: profile ? (typeof profile === 'string' ? profile : profile.name || null) : null,
    reasons,
    alternatives,
  };
}

