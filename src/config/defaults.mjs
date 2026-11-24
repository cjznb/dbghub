/**
 * Built-in configuration defaults. Paths are resolved lazily by src/config/load.mjs.
 */
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_CONFIG = {
  daemon: {
    mode: 'auto',
    idle_exit_min: 0, // 0 = never exit while sessions exist; tests can override
    max_sessions: 8,
    allow_raw: false,
    allow_attach: false,
  },
  backends: {
    openocd: {
      command: 'openocd',
      search: null, // resolved from known install locations
    },
  },
  toolchains: {
    'arm-none-eabi-gdb': { command: 'arm-none-eabi-gdb' },
    gdb: { command: 'gdb' },
  },
  profiles: {
    native: {
      adapter: 'gdbmi',
      gdb: 'gdb',
      launch: { stop_at_entry: true },
      entry: 'main',
    },
    'stm32f103-openocd': {
      adapter: 'gdbmi',
      gdb: 'arm-none-eabi-gdb',
      probe: 'auto',
      backend: 'openocd',
      interface: 'stlink',
      target: 'stm32f1x',
      transport: 'swd',
      speed_khz: 480,
      connect: ['monitor reset halt'],
      flash: ['load'],
      after: ['monitor reset halt'],
      attach_connect: [],
      attach_after: [],
      stop_at_entry: true,
      entry: 'main',
      flash_on_open: true,
      rtos: 'auto',
      openocd_target: 'stm32f1x.cpu',
      openocd_rtos: 'FreeRTOS',
    },
    // Same target but daemon-side TCB walker only (Plan B fallback / no RTOS plugin).
    'stm32f103-walker': {
      adapter: 'gdbmi',
      gdb: 'arm-none-eabi-gdb',
      probe: 'auto',
      backend: 'openocd',
      interface: 'stlink',
      target: 'stm32f1x',
      transport: 'swd',
      speed_khz: 480,
      connect: ['monitor reset halt'],
      flash: ['load'],
      after: ['monitor reset halt'],
      attach_connect: [],
      attach_after: [],
      stop_at_entry: true,
      entry: 'main',
      flash_on_open: true,
      rtos: 'walker',
    },
    // Simulation / no local probe: connect straight to an external GDB stub (Renode, QEMU, remote OpenOCD).
    renode: {
      adapter: 'gdbmi',
      gdb: 'arm-none-eabi-gdb',
      probe: 'none',
      backend: 'none',
      endpoint: '127.0.0.1:3333',
      connect: ['target extended-remote 127.0.0.1:3333'],
      attach_connect: ['target extended-remote 127.0.0.1:3333'],
      attach_after: [],
      flash_on_open: false,
      stop_at_entry: false,
      rtos: 'auto',
    },
  },
  rtos: {
    auto_detect: true,
    task_cap: 20,
    fault_decode: true,
  },
  workspace: {
    source_map: [],
    symbol_paths: [],
  },
};

/** Well-known install locations on this machine, used as last resort. */
export function knownCandidates(env = process.env) {
  const home = env.USERPROFILE || env.HOME || os.homedir();
  return {
    'arm-none-eabi-gdb': [
      env.DBGHUB_ARM_GDB,
      'G:\\mcu\\Arm GNU Toolchain arm-none-eabi\\15.2.rel1\\bin\\arm-none-eabi-gdb.exe',
      'C:\\Program Files (x86)\\Arm GNU Toolchain arm-none-eabi\\13.2 rel1\\bin\\arm-none-eabi-gdb.exe',
      'C:\\Program Files\\Arm GNU Toolchain arm-none-eabi\\13.2 rel1\\bin\\arm-none-eabi-gdb.exe',
      '/usr/bin/arm-none-eabi-gdb',
    ].filter(Boolean),
    gdb: [
      env.DBGHUB_GDB,
      'D:\\msys64\\mingw64\\bin\\gdb.exe',
      'C:\\msys64\\mingw64\\bin\\gdb.exe',
      '/usr/bin/gdb',
    ].filter(Boolean),
    openocd: [
      env.DBGHUB_OPENOCD,
      'G:\\mcu\\openOCD\\xpack-openocd-0.12.0-7\\bin\\openocd.exe',
      'C:\\Program Files\\OpenOCD\\bin\\openocd.exe',
      '/usr/bin/openocd',
    ].filter(Boolean),
    openocdScripts: [
      env.DBGHUB_OPENOCD_SCRIPTS,
      'G:\\mcu\\openOCD\\xpack-openocd-0.12.0-7\\openocd\\scripts',
      'C:\\Program Files\\OpenOCD\\share\\openocd\\scripts',
      '/usr/share/openocd/scripts',
    ].filter(Boolean),
    home,
  };
}

export const KNOWN_PROFILE_NAMES = Object.keys(DEFAULT_CONFIG.profiles);
