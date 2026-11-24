/**
 * Production wiring: config + concrete gdb/backend/probe/symbol implementations -> session manager.
 * Kept separate from src/daemon/sessions.mjs so the manager stays dependency-injected/testable.
 */
import { loadConfig } from '../config/load.mjs';
import { createSessionManager } from '../daemon/sessions.mjs';
import { GdbSession } from '../gdb/gdb-session.mjs';
import { OpenOCD } from '../backends/openocd.mjs';
import * as registry from '../probes/registry.mjs';
import { loadSymbols } from '../symbols/index.mjs';
import { createLogger } from '../util/log.mjs';

export function createProbeManager(config, { log = null } = {}) {
  const oc = config.backends?.openocd || {};
  const profileDefaults = config.profiles?.['stm32f103-openocd'] || {};
  const probeOptions = {
    openocd: { command: oc.command, search: oc.search },
    target: profileDefaults.target || 'stm32f1x',
    transport: profileDefaults.transport || 'swd',
    speedKhz: profileDefaults.speed_khz || 480,
  };
  return {
    async discoverProbes(opts = {}) {
      return registry.discoverProbes({ ...probeOptions, ...opts, openocd: oc, env: process.env });
    },
    async doctor(opts = {}) {
      return registry.doctor({
        ...probeOptions,
        ...opts,
        openocd: oc,
        profiles: config.profiles,
        env: process.env,
      });
    },
    async plan(opts = {}) {
      return registry.plan({
        profiles: config.profiles,
        ...opts,
      });
    },
    async listBackends(opts = {}) {
      return registry.listBackends(process.env, { ...probeOptions, ...opts });
    },
    async findToolchains(opts = {}) {
      return registry.findToolchains(process.env, { ...probeOptions, ...opts });
    },
  };
}

export function createRuntime({ config = null, cwd = process.cwd(), env = process.env, log = null, daemonInfo = null, workspace = null } = {}) {
  const cfg = config || loadConfig({ cwd, env });
  const logger = log || createLogger({ name: 'dbghub', level: 'info' });
  const probeManager = createProbeManager(cfg, { log: logger });

  const gdbFactory = async (opts = {}) => {
    return new GdbSession({
      gdbPath: opts.gdbPath,
      args: opts.args || [],
      cwd: opts.cwd || cwd,
      env: opts.env || env,
      program: opts.program || null,
      log: logger,
    });
  };

  const backendFactory = (opts = {}) => {
    const profile = opts.profile || {};
    const oc = cfg.backends?.openocd || {};
    const extraArgs = [...(profile.openocd_args || [])];
    // When a FreeRTOS profile asks for thread awareness, configure the OpenOCD target
    // before init so `info threads` exposes one GDB thread per task (Plan A).
    if (profile.openocd_rtos) {
      const targetName = profile.openocd_target || `${profile.target || 'stm32f1x'}.cpu`;
      extraArgs.push('-c', `${targetName} configure -rtos ${profile.openocd_rtos}`);
    }
    return new OpenOCD({
      command: oc.command || 'openocd',
      search: oc.search || null,
      interface: profile.interface || 'stlink',
      target: profile.target || 'stm32f1x',
      transport: profile.transport || 'swd',
      speedKhz: profile.speed_khz || 480,
      extraArgs,
      log: logger,
    });
  };

  const symbolLoader = async (opts = {}) => loadSymbols(opts);

  const manager = createSessionManager({
    config: cfg,
    gdbFactory,
    backendFactory,
    symbolLoader,
    probeManager,
    log: logger,
    daemonInfo: daemonInfo || { mode: 'daemon', socket: null },
    workspace,
  });

  return { config: cfg, log: logger, manager, probeManager };
}
