#!/usr/bin/env node
/**
 * Hardware discovery helper for manual verification.
 *
 * Usage:
 *   node scripts/hw-discover.mjs                 # list probes + backends + toolchains
 *   node scripts/hw-discover.mjs --scan          # also load target cfg (voltage/DPIDR)
 *   node scripts/hw-discover.mjs --doctor        # full doctor (issues + hints)
 *   node scripts/hw-discover.mjs --plan --profile stm32f103-openocd
 *   node scripts/hw-discover.mjs --search <openocd-scripts-dir> --openocd <path>
 *
 * Always prints one JSON object on stdout; exit code 1 only on unexpected errors.
 */

import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { listBackends, findToolchains, discoverProbes, doctor, plan } from '../src/probes/registry.mjs';

const USAGE = [
  'node scripts/hw-discover.mjs [--doctor|--scan] [--openocd <path>] [--search <scripts>]',
  '  --interface <name>   interface cfg to probe (default: stlink,jlink,cmsis-dap)',
  '  --target <name>      target cfg used with --scan/--doctor (default: stm32f1x)',
  '  --speed <khz>        adapter speed (default: 480)',
  '  --profile <name>     profile name for doctor/plan',
  '  --plan               include plan() result',
  '  --help               show this text (as JSON)',
].join('\n');

export function parseArgs(argv = []) {
  const args = { interfaces: null, target: 'stm32f1x', speed: 480, scan: false, doctor: false, plan: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case '--help':
      case '-h':
        args.help = true;
        break;
      case '--doctor':
        args.doctor = true;
        break;
      case '--scan':
        args.scan = true;
        break;
      case '--plan':
        args.plan = true;
        break;
      case '--openocd':
        args.openocd = next();
        break;
      case '--search':
        args.search = next();
        break;
      case '--target':
        args.target = next();
        break;
      case '--interface':
        args.interfaces = String(next() || '')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
        break;
      case '--speed':
        args.speed = Number(next()) || 480;
        break;
      case '--profile':
        args.profile = next();
        break;
      default:
        break;
    }
  }
  return args;
}

/**
 * Pure-ish entry point (deps injectable for tests): returns { code, output }.
 * `deps.run` / `deps.exists` follow registry seams; no MCP state involved.
 */
export async function runHwDiscover({ argv = [], env = process.env, deps = {}, profiles = null } = {}) {
  const args = parseArgs(argv);
  if (args.help) return { code: 0, output: JSON.stringify({ ok: true, usage: USAGE }, null, 2) };
  const mergedEnv = { ...env };
  if (args.search) mergedEnv.DBGHUB_OPENOCD_SCRIPTS = args.search;
  const base = {
    env: mergedEnv,
    run: deps.run,
    exists: deps.exists,
    scan: args.scan,
    interfaces: args.interfaces || undefined,
    target: args.target,
    speedKhz: args.speed,
    openocd: args.openocd || null,
  };
  try {
    let result;
    if (args.doctor) {
      // Doctor needs a profile to check target/interface cfg and speed; for CLI use
      // the flags directly when no config profiles are available yet.
      const profileObj =
        args.profile && profiles && profiles[args.profile]
          ? profiles[args.profile]
          : {
              name: args.profile || 'cli',
              target: args.target,
              interface: (args.interfaces && args.interfaces[0]) || 'stlink',
              transport: 'swd',
              speed_khz: args.speed,
            };
      const out = await doctor({ ...base, scan: true, profile: profileObj, profiles });
      result = { ok: true, ...out };
    } else {
      const [disc, backends, toolchains] = await Promise.all([
        discoverProbes({ ...base, scan: args.scan }),
        listBackends(mergedEnv, deps),
        findToolchains(mergedEnv, deps),
      ]);
      result = { ok: true, probes: disc.probes, warnings: disc.warnings, backends, toolchains };
      if (args.plan) {
        result.plan = plan({ probes: disc.probes, profiles: profiles || {}, profile: args.profile });
      }
    }
    return { code: 0, output: JSON.stringify(result, null, 2) };
  } catch (e) {
    return {
      code: 1,
      output: JSON.stringify(
        { ok: false, error: { code: e.code || 'E_INTERNAL', message: String(e.message || e) } },
        null,
        2,
      ),
    };
  }
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) {
  const { code, output } = await runHwDiscover({ argv: process.argv.slice(2) });
  process.stdout.write(output + '\n');
  process.exitCode = code;
}
