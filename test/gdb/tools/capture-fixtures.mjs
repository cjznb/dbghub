/**
 * Dev tool (not part of the test suite): records real gdb MI transcripts into
 * test/gdb/fixtures/.
 *
 * Usage:
 *   node test/gdb/tools/capture-fixtures.mjs
 *
 * Capturing is done with stdin/stdout/stderr redirected to files instead of
 * pipes, because pipes are blocked inside the DSH Windows sandbox
 * (child_process spawn with stdio:'pipe' => EPERM). gdb writes LF-only output
 * when its stdout is a file; the CRLF transcripts in fixtures came from a real
 * pipe capture (see PIPE_MODE notes below).
 *
 * Each scenario writes:
 *   <name>.txt   raw stdout transcript (byte-exact)
 *   <name>.meta.json { gdb, argv, commands, exitCode, stderr }
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(HERE, '..', 'fixtures');
const GDB_NATIVE = process.env.DBG_GDB || 'D:/msys64/mingw64/bin/gdb.exe';
const GDB_ARM = process.env.DBG_ARM_GDB || 'G:/mcu/Arm GNU Toolchain arm-none-eabi/15.2.rel1/bin/arm-none-eabi-gdb.exe';
const ARM_ELF = 'D:/projects/agent/dbghub/.hw/P01_WindSensor_Val/build/RelWithDebInfo/P01_WindSensor_Val.elf';

function exists(p) {
  try { fs.accessSync(p); return true; } catch { return false; }
}

const scenario = (name, gdb, program, commands) => ({ name, gdb, argv: [gdb, '--interpreter=mi3', '-q'], program, commands });

const SCENARIOS = [
  scenario('native-startup', GDB_NATIVE, 'C:/Windows/System32/whoami.exe', [
    '-gdb-set confirm off',
    '-gdb-set pagination off',
    '-interpreter-exec console "show version"',
    '-interpreter-exec console "show endian"',
    '-file-exec-and-symbols "C:/Windows/System32/whoami.exe"',
    '-break-insert no_such_function_xyz',
    '-interpreter-exec console "info files"',
    '-gdb-exit',
  ]),
  scenario('native-run-exited', GDB_NATIVE, 'C:/Windows/System32/whoami.exe', [
    '-gdb-set confirm off',
    '-gdb-set pagination off',
    '-file-exec-and-symbols "C:/Windows/System32/whoami.exe"',
    '-exec-run',
    '-gdb-exit',
  ]),
  scenario('native-starti-step', GDB_NATIVE, 'C:/Windows/System32/whoami.exe', [
    '-gdb-set confirm off',
    '-gdb-set pagination off',
    '-file-exec-and-symbols "C:/Windows/System32/whoami.exe"',
    '-interpreter-exec console "starti"',
    '-stack-list-frames --no-frame-filters 0 3',
    '-thread-info',
    '-exec-next-instruction',
    '-exec-next-instruction',
    '-stack-list-frames --no-frame-filters 0 3',
    '-exec-continue',
    '-gdb-exit',
  ]),
  scenario('arm-symbols-break', GDB_ARM, null, [
    '-gdb-set confirm off',
    '-gdb-set pagination off',
    `-file-exec-and-symbols "${ARM_ELF}"`,
    '-break-insert main',
    '-break-insert "main.c:77"',
    '-break-list',
    '-interpreter-exec console "show version"',
    '-target-select extended-remote localhost:1',
    '-gdb-exit',
  ]),
];

function runOne({ name, gdb, argv, program, commands }) {
  if (!exists(gdb)) { console.log(`skip ${name}: missing ${gdb}`); return; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dbghub-mi-'));
  const cmdFile = path.join(dir, 'commands.txt');
  const outFile = path.join(dir, 'stdout.txt');
  const errFile = path.join(dir, 'stderr.txt');
  fs.writeFileSync(cmdFile, commands.join('\n') + '\n', 'utf8');
  if (program) fs.accessSync(program); // sanity: program referenced by the scenario exists

  const code = spawnSyncFd(gdb, argv.slice(1), dir);
  const out = fs.readFileSync(outFile);
  const err = fs.readFileSync(errFile, 'utf8');
  fs.mkdirSync(FIXTURES, { recursive: true });
  fs.writeFileSync(path.join(FIXTURES, `${name}.txt`), out);
  fs.writeFileSync(
    path.join(FIXTURES, `${name}.meta.json`),
    JSON.stringify({ gdb, argv, program, commands, exitCode: code, stderr: err }, null, 1),
    'utf8',
  );
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`wrote ${name}.txt: ${out.length} bytes, stderr=${err.length} bytes`);

  function spawnSyncFd(file, args, cwd) {
    const inFd = fs.openSync(cmdFile, 'r');
    const outFd = fs.openSync(outFile, 'w');
    const errFd = fs.openSync(errFile, 'w');
    let res;
    try {
      res = spawnSync(file, args, { stdio: [inFd, outFd, errFd], cwd, windowsHide: true, timeout: 60000 });
    } finally {
      try { fs.closeSync(inFd); fs.closeSync(outFd); fs.closeSync(errFd); } catch { /* ignore */ }
    }
    if (res.error) console.log(` spawn error: ${res.error.code || res.error.message}`);
    return res.status;
  }
}

for (const s of SCENARIOS) runOne(s);
console.log('done');
