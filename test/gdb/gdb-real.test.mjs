/**
 * Optional real-gdb integration test (no hardware needed).
 *
 * 1. native gdb 16.3 (MinGW): compiles test/gdb/fixtures/native/sample.c with
 *    clang + lld DWARF, then drives a real breakpoint -> step -> exit flow.
 * 2. arm-none-eabi-gdb 15.2: loads the STM32F103 FreeRTOS ELF from .hw and
 *    inserts a real breakpoint on main; also verifies the unquoted
 *    -target-select extended-remote error path.
 *
 * Everything skips cleanly when a tool is missing. In the DSH Windows sandbox
 * GdbSession automatically falls back to the PowerShell relay transport
 * (session.stdioMode === 'relay') because pipe stdio is denied; outside a
 * sandbox the same test runs with stdioMode === 'pipe'.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GdbSession } from '../../src/gdb/gdb-session.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE_C = path.join(HERE, 'fixtures', 'native', 'sample.c');
const GDB = process.env.DBG_GDB || 'gdb';
const ARM_GDB = process.env.DBG_ARM_GDB || 'arm-none-eabi-gdb';
const ARM_ELF = process.env.DBG_ARM_ELF
  || path.join(HERE, '..', '..', '.hw', 'P01_WindSensor_Val', 'build', 'RelWithDebInfo', 'P01_WindSensor_Val.elf');
const CLANG = process.env.DBG_CLANG || 'clang';

function exists(p) {
  try { fs.accessSync(p); return true; } catch { return false; }
}

/** Compile sample.c with DWARF into a temp dir. Returns the exe path or null. */
function compileSample() {
  if (!exists(CLANG) || !exists(SAMPLE_C)) return null;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dbghub-gdb-it-'));
  const exe = path.join(dir, 'sample.exe');
  // clang + lld keep DWARF in the PE (gdb cannot read MSVC PDBs).
  const res = spawnSync(CLANG, [
    '-g', '-gdwarf', '-O0', '-fuse-ld=lld', '-Wl,/debug:dwarf', SAMPLE_C, '-o', exe,
  ], { stdio: 'ignore', windowsHide: true, timeout: 120000 });
  if (res.status !== 0 || !fs.existsSync(exe)) {
    fs.rmSync(dir, { recursive: true, force: true });
    return null;
  }
  return { dir, exe };
}

test('real gdb 16.3: load, breakpoint, run, step, exit', { timeout: 90000 }, async (t) => {
  if (!exists(GDB)) { t.skip(`real gdb not available at ${GDB}`); return; }
  const build = compileSample();
  if (!build) { t.skip(`clang (${CLANG}) unavailable to build the DWARF test program`); return; }
  const session = new GdbSession({ gdbPath: GDB });
  try {
    await session.start();
    assert.ok(['pipe', 'relay'].includes(session.stdioMode), `stdioMode=${session.stdioMode}`);
    await session.exec('-gdb-set confirm off');
    await session.loadProgram(build.exe);

    const inserted = await session.exec('-break-insert main');
    const bkpt = inserted.results.bkpt;
    assert.equal(bkpt.func, 'main');
    assert.equal(bkpt.enabled, 'y');
    assert.match(bkpt.addr, /^0x[0-9a-f]+$/i);
    assert.ok(Number(bkpt.line) > 0);

    await session.exec('-exec-run');
    const stop = await session.waitForStop({ timeoutMs: 20000 });
    assert.equal(stop.reasonKind, 'breakpoint', `reason=${stop.reason}`);
    assert.equal(stop.reason, 'breakpoint-hit');
    assert.equal(stop.bkptno, Number(bkpt.number));
    assert.equal(stop.frame.func, 'main');
    assert.equal(stop.frame.line, Number(bkpt.line));
    assert.match(stop.frame.file || '', /sample\.c$/);
    assert.match(stop.frame.fullname || '', /sample\.c$/);
    assert.ok(stop.threadId >= 1);

    const frames = await session.exec('-stack-list-frames 0 3');
    assert.ok(Array.isArray(frames.results.stack));
    assert.ok(frames.results.stack.length >= 1);

    const value = await session.exec('-data-evaluate-expression counter');
    assert.equal(typeof value.results.value, 'string');

    await session.exec('-exec-next');
    const stepped = await session.waitForStop({ timeoutMs: 20000 });
    assert.equal(stepped.reasonKind, 'step', `reason=${stepped.reason}`);
    assert.equal(stepped.frame.func, 'main');
  } finally {
    await session.close();
    fs.rmSync(build.dir, { recursive: true, force: true });
  }
  assert.equal(session.status, 'closed');
});

test('real gdb 16.3: interrupt while running (mi-async)', { timeout: 90000 }, async (t) => {
  if (!exists(GDB)) { t.skip(`real gdb not available at ${GDB}`); return; }
  const build = compileSample();
  if (!build) { t.skip(`clang (${CLANG}) unavailable to build the DWARF test program`); return; }
  const session = new GdbSession({ gdbPath: GDB });
  try {
    await session.start();
    await session.exec('-gdb-set confirm off');
    await session.exec('-gdb-set mi-async on');
    await session.loadProgram(build.exe);
    await session.exec('-break-insert main');
    await session.exec('-exec-run');
    await session.waitForStop({ timeoutMs: 20000 });
    await session.exec('-break-delete 1');

    await session.exec('-exec-continue');
    assert.equal(session.status, 'running');
    // sample.c sleeps for 1.5s, so this interrupt lands while the inferior runs.
    await new Promise((r) => setTimeout(r, 200));
    await session.interrupt();
    const stopped = await session.waitForStop({ timeoutMs: 20000 });
    assert.equal(stopped.reasonKind, 'signal', `reason=${stopped.reason}`);
    assert.ok(stopped.signal);
  } finally {
    await session.close();
    fs.rmSync(build.dir, { recursive: true, force: true });
  }
});

test('real arm-none-eabi-gdb 15.2: ELF symbols, breakpoint, remote connect error', { timeout: 90000 }, async (t) => {
  if (!exists(ARM_GDB)) { t.skip(`arm-none-eabi-gdb not available at ${ARM_GDB}`); return; }
  if (!exists(ARM_ELF)) { t.skip(`ARM ELF not available at ${ARM_ELF}`); return; }
  const session = new GdbSession({ gdbPath: ARM_GDB });
  try {
    await session.start();
    await session.exec('-gdb-set confirm off');
    await session.loadProgram(ARM_ELF);

    const inserted = await session.exec('-break-insert main');
    const bkpt = inserted.results.bkpt;
    assert.equal(bkpt.func, 'main');
    assert.match(bkpt.addr, /^0x[0-9a-f]+$/i);
    assert.match(bkpt.fullname || '', /main\.c$/);
    assert.ok(Number(bkpt.line) > 0);

    const list = await session.exec('-break-list');
    assert.ok(list.results.BreakpointTable);
    assert.equal(Number(list.results.BreakpointTable.nr_rows), 1);

    // -target-select must not quote the address (Renode/OpenOCD regression).
    // COM99 fails immediately and the error proves gdb parsed the address as a
    // target (not as a syntax error / hostname with quotes).
    await assert.rejects(session.selectRemote('COM99', { timeoutMs: 8000 }), (e) => {
      assert.equal(e.code, 'E_GDB_MI');
      assert.match(e.message, /could not open|COM99/i);
      return true;
    });
    assert.equal(await session.exec('-gdb-set confirm off').then((r) => r.class), 'done');
  } finally {
    await session.close();
  }
});
