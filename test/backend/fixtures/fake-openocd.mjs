#!/usr/bin/env node
/**
 * Deterministic fake OpenOCD for tests. Mimics the stdout/stderr + exit codes of a
 * real openocd run; never touches a USB probe.
 *
 * Env:
 *   FAKE_OC_MODE       ok (default) | noprobe | permission | busy | nocfg | crash | neverready
 *   FAKE_OC_ARGV_FILE  if set, write the received argv (JSON) to this path
 */
import fs from 'node:fs';

const argv = process.argv.slice(2);
const mode = process.env.FAKE_OC_MODE || 'ok';

const out = (line) => process.stderr.write(line + '\n');

if (process.env.FAKE_OC_ARGV_FILE) {
  try {
    fs.writeFileSync(process.env.FAKE_OC_ARGV_FILE, JSON.stringify(argv));
  } catch {
    /* ignore */
  }
}

if (argv.includes('--version')) {
  out('xPack Open On-Chip Debugger 0.12.0+dev-02228-ge5888bda3-dirty (2025-10-04-22:44)');
  out('Licensed under GNU GPL v2');
  process.exit(0);
}

let gdbPort = '3333';
for (const a of argv) {
  const m = /gdb_port\s+(\d+)/.exec(a);
  if (m) gdbPort = m[1];
}

out('xPack Open On-Chip Debugger 0.12.0+dev-02228-ge5888bda3-dirty (2025-10-04-22:44)');
out('Licensed under GNU GPL v2');

switch (mode) {
  case 'noprobe':
    out('Error: No J-Link device found');
    process.exit(1);
    break;
  case 'permission':
    out('Error: LIBUSB_ERROR_ACCESS');
    out('Error: open failed');
    process.exit(1);
    break;
  case 'busy':
    out('Error: LIBUSB_ERROR_BUSY');
    out('Error: open failed');
    process.exit(1);
    break;
  case 'nocfg':
    out('Error: Could not open target/stm32f1x.cfg');
    process.exit(1);
    break;
  case 'crash':
    out('Error: unexpected fake failure');
    process.exit(1);
    break;
  case 'neverready':
    out('Info : STLINK V2J37S7 (API v2) VID:PID 0483:3748');
    break;
  case 'startingonly':
    out('Info : STLINK V2J37S7 (API v2) VID:PID 0483:3748');
    out(`Info : [stm32f1x.cpu] starting gdb server on ${gdbPort}`);
    break;
  case 'bindfail-once': {
    // First invocation fails to bind (simulating a port race), second succeeds.
    const marker = process.env.FAKE_OC_MARKER;
    let seen = false;
    try {
      seen = !!marker && fs.existsSync(marker);
    } catch {
      seen = false;
    }
    if (!seen) {
      if (marker) {
        try {
          fs.writeFileSync(marker, '1');
        } catch {
          /* ignore */
        }
      }
      out("Error: couldn't bind TCP/IP port for gdb");
      process.exit(1);
    }
    out('Info : STLINK V2J37S7 (API v2) VID:PID 0483:3748');
    out(`Info : Listening on port ${gdbPort} for gdb connections`);
    break;
  }
  default:
    out('Info : STLINK V2J37S7 (API v2) VID:PID 0483:3748');
    out('Info : Target voltage: 3.222266');
    out(`Info : [stm32f1x.cpu] starting gdb server on ${gdbPort}`);
    out(`Info : Listening on port ${gdbPort} for gdb connections`);
    break;
}

// Real openocd keeps running until signalled; keep the fake alive the same way.
setInterval(() => {}, 1000);
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
