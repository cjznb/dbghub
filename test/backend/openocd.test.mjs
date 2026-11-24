/**
 * OpenOCD backend tests: argv assembly, readiness, error classification, idempotent stop.
 * Uses test/backend/fixtures/fake-openocd.mjs; never touches a real probe.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { OpenOCD, classifyOpenOCDError, findFreePort } from '../../src/backends/openocd.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE = path.join(HERE, 'fixtures', 'fake-openocd.mjs');
const FIXTURES = path.join(HERE, 'fixtures');

function readFixture(name) {
  return fs.readFileSync(path.join(FIXTURES, name), 'utf8').split(/\r?\n/);
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dbghub-oc-test-'));
}

function makeOC(extra = {}) {
  return new OpenOCD({
    command: process.execPath,
    commandArgs: [FAKE],
    search: 'C:\\fake\\scripts',
    timeoutMs: 6000,
    ...extra,
  });
}

test('classifyOpenOCDError maps real transcripts to contract codes', () => {
  assert.equal(classifyOpenOCDError(readFixture('noprobe-jlink.txt'), 1).code, 'E_PROBE_NOT_FOUND');
  assert.equal(classifyOpenOCDError(readFixture('noprobe-cmsisdap.txt'), 1).code, 'E_PROBE_NOT_FOUND');

  const perm = ['Info : STLINK V2J37S7 (API v2) VID:PID 0483:3748', 'Error: LIBUSB_ERROR_ACCESS', 'Error: open failed'];
  const permErr = classifyOpenOCDError(perm, 1);
  assert.equal(permErr.code, 'E_PROBE_PERMISSION');
  assert.match(permErr.hint, /udev|driver/i);

  const busy = ['Error: LIBUSB_ERROR_BUSY', 'Error: open failed'];
  assert.equal(classifyOpenOCDError(busy, 1).code, 'E_PROBE_BUSY');

  const cfg = ["Error: Could not open target/does-not-exist.cfg"];
  assert.equal(classifyOpenOCDError(cfg, 1).code, 'E_SERVER_START');

  assert.equal(classifyOpenOCDError([], null).code, 'E_SERVER_START');
  assert.equal(classifyOpenOCDError(readFixture('stlink-target.txt'), 0), null);
});

test('start() allocates distinct ports, builds the documented argv, becomes ready', async () => {
  const dir = tmpDir();
  const argvFile = path.join(dir, 'argv.json');
  const oc = makeOC({ env: { ...process.env, FAKE_OC_MODE: 'ok', FAKE_OC_ARGV_FILE: argvFile } });
  try {
    const r = await oc.start();
    assert.equal(oc.status, 'ready');
    assert.equal(oc.stdioMode === 'pipe' || oc.stdioMode === 'file', true);
    assert.ok(r.gdbPort > 0);
    assert.equal(new Set([r.gdbPort, r.telnetPort, r.tclPort]).size, 3);
    assert.equal(r.pid > 0, true);
    assert.match(oc.tail(10).join('\n'), /Listening on port/);

    const argv = JSON.parse(fs.readFileSync(argvFile, 'utf8')); // process.argv.slice(2) in the fake
    assert.deepEqual(argv.slice(0, 10), [
      '-s',
      'C:\\fake\\scripts',
      '-f',
      'interface/stlink.cfg',
      '-c',
      'transport select swd',
      '-c',
      'adapter speed 480',
      '-f',
      'target/stm32f1x.cfg',
    ]);
    assert.deepEqual(argv.slice(10), [
      '-c',
      `gdb_port ${r.gdbPort}`,
      '-c',
      `telnet_port ${r.telnetPort}`,
      '-c',
      `tcl_port ${r.tclPort}`,
    ]);
    assert.equal(r.argv.length, argv.length + 1); // + the fake script path
  } finally {
    await oc.stop();
    await oc.stop(); // idempotent
    assert.equal(oc.status, 'exited');
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('start() honours fixed gdb/telnet/tcl ports', async () => {
  // A port that is free right now; the fake openocd never binds it.
  const fixed = await findFreePort();
  const oc = makeOC({ gdbPort: fixed, telnetPort: fixed + 1, tclPort: fixed + 2, env: { ...process.env, FAKE_OC_MODE: 'ok' } });
  try {
    const r = await oc.start();
    assert.equal(r.gdbPort, fixed);
    assert.deepEqual(oc.requestedPorts, { gdbPort: fixed, telnetPort: fixed + 1, tclPort: fixed + 2 });
  } finally {
    await oc.stop();
  }
});

for (const [mode, code] of [
  ['noprobe', 'E_PROBE_NOT_FOUND'],
  ['permission', 'E_PROBE_PERMISSION'],
  ['busy', 'E_PROBE_BUSY'],
  ['nocfg', 'E_SERVER_START'],
  ['crash', 'E_SERVER_START'],
]) {
  test(`start() classifies FAKE_OC_MODE=${mode} as ${code}`, async () => {
    const oc = makeOC({ env: { ...process.env, FAKE_OC_MODE: mode } });
    try {
      await assert.rejects(oc.start(), (e) => {
        assert.equal(e.code, code);
        assert.ok(e.message.length > 0);
        return true;
      });
      assert.equal(oc.status, 'error');
      assert.ok(oc.tail(20).some((l) => /Error:/.test(l)));
    } finally {
      await oc.stop();
    }
  });
}

test('start() times out with E_SERVER_START and kills the child', async () => {
  const oc = makeOC({ timeoutMs: 700, env: { ...process.env, FAKE_OC_MODE: 'neverready' } });
  try {
    await assert.rejects(oc.start(), (e) => e.code === 'E_SERVER_START' && /within 700ms/.test(e.message));
    assert.equal(oc.status, 'error');
  } finally {
    await oc.stop();
  }
});

test('start() reports E_TOOLCHAIN_MISSING for a missing binary', async () => {
  const oc = new OpenOCD({ command: 'dbghub-totally-missing-openocd-xyz', timeoutMs: 3000 });
  await assert.rejects(oc.start(), (e) => e.code === 'E_TOOLCHAIN_MISSING');
  await oc.stop();
});

test('stop() during startup rejects start() and reaps the child', async () => {
  const oc = makeOC({ timeoutMs: 10000, env: { ...process.env, FAKE_OC_MODE: 'neverready' } });
  const outcome = oc.start().then(
    () => 'resolved',
    (e) => e.code,
  );
  await new Promise((r) => setTimeout(r, 300));
  await oc.stop();
  assert.equal(await outcome, 'E_SERVER_START');
  assert.notEqual(oc.status, 'ready');
  await oc.stop();
});

test('start() can be called again after stop()', async () => {
  const oc = makeOC({ env: { ...process.env, FAKE_OC_MODE: 'ok' } });
  const first = await oc.start();
  await oc.stop();
  const second = await oc.start();
  assert.ok(second.gdbPort > 0);
  assert.notEqual(second.pid, first.pid);
  await oc.stop();
});

test('start() retries once with fresh ports after a bind race', async () => {
  const dir = tmpDir();
  const oc = makeOC({
    env: { ...process.env, FAKE_OC_MODE: 'bindfail-once', FAKE_OC_MARKER: path.join(dir, 'marker') },
  });
  try {
    const r = await oc.start();
    assert.equal(oc.status, 'ready');
    assert.ok(r.gdbPort > 0);
  } finally {
    await oc.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('start() treats "starting gdb server on N" as ready when the listen line is late', async () => {
  const dir = tmpDir();
  const argvFile = path.join(dir, 'argv.json');
  const oc = makeOC({
    env: { ...process.env, FAKE_OC_MODE: 'startingonly', FAKE_OC_ARGV_FILE: argvFile },
  });
  try {
    const r = await oc.start();
    const argv = JSON.parse(fs.readFileSync(argvFile, 'utf8'));
    const requested = argv.find((a) => /^gdb_port \d+$/.test(a));
    assert.equal(r.gdbPort, Number(/gdb_port (\d+)/.exec(requested)[1]));
    assert.equal(oc.status, 'ready');
  } finally {
    await oc.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('tail(n) returns at most n lines and stop() is safe before start', async () => {
  const oc = makeOC();
  assert.deepEqual(oc.tail(5), []);
  await oc.stop();
  assert.equal(oc.status, 'exited');
});
