/**
 * Probe registry tests: parsing, discovery with an injected runner, doctor, plan.
 * Pure unit tests: no process spawn, no hardware.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  listBackends,
  findToolchains,
  discoverProbes,
  doctor,
  plan,
  parseProbeLog,
  guessSearchDir,
} from '../../src/probes/registry.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, 'fixtures');
const readFixture = (name) => fs.readFileSync(path.join(FIXTURES, name), 'utf8');

const EMPTY_ENV = { PATH: '', PATHEXT: '.EXE;.CMD' };
const noExist = () => false;

/** Canned OpenOCD runner used by discovery/doctor tests. */
function fakeRunner({ scan = true } = {}) {
  return async ({ args }) => {
    const argv = args.join(' ');
    if (argv.includes('--version')) return { code: 0, output: readFixture('openocd-version.txt') };
    if (argv.includes('interface/jlink.cfg') || argv.includes('interface/cmsis-dap.cfg')) {
      return { code: 1, output: argv.includes('jlink') ? readFixture('noprobe-jlink.txt') : readFixture('noprobe-cmsisdap.txt') };
    }
    if (!argv.includes('interface/stlink.cfg')) return { code: 1, output: 'Error: unknown interface' };
    // scan=true transcripts include DPIDR; interface-only ones do not.
    return { code: 0, output: readFixture(scan ? 'stlink-target.txt' : 'stlink-interface.txt') };
  };
}

test('parseProbeLog extracts ST-LINK identity from the real OpenOCD transcript', () => {
  const p = parseProbeLog(readFixture('stlink-target.txt'), { interface: 'stlink' });
  assert.equal(p.key, 'stlink:0483:3748');
  assert.equal(p.kind, 'stlink');
  assert.equal(p.serial, null);
  assert.equal(p.firmware, 'V2J37S7');
  assert.equal(p.vid, 0x0483);
  assert.equal(p.pid, 0x3748);
  assert.equal(p.model, 'ST-LINK/V2');
  assert.equal(p.transport, 'swd');
  assert.equal(p.status, 'ready');
  assert.deepEqual(p.servers, ['openocd']);
  assert.equal(p.voltage, 3.222266);
  assert.equal(p.dpidr, '0x2ba01477');
  assert.equal(p.clock_khz, 950);
  assert.equal(p.breakpoints, 6);
  assert.equal(p.watchpoints, 4);
  assert.equal(p.target, 'stm32f1x');
  assert.equal(p.capabilities.connectUnderReset, true);
  assert.equal(p.capabilities.swo, true);
});

test('parseProbeLog returns null when no probe matched', () => {
  assert.equal(parseProbeLog(readFixture('noprobe-jlink.txt'), { interface: 'jlink' }), null);
  assert.equal(parseProbeLog('', { interface: 'stlink' }), null);
});

test('guessSearchDir finds the xpack layout next to bin/openocd.exe', () => {
  const bin = 'G:\\mcu\\openOCD\\xpack-openocd-0.12.0-7\\bin\\openocd.exe';
  const scripts = 'G:\\mcu\\openOCD\\xpack-openocd-0.12.0-7\\openocd\\scripts';
  const dir = guessSearchDir(bin, { env: {}, exists: (p) => p === scripts });
  assert.equal(dir, scripts);
  assert.equal(guessSearchDir(bin, { env: { DBGHUB_OPENOCD_SCRIPTS: 'D:\\oc\\scripts' }, exists: () => true }), 'D:\\oc\\scripts');
});

test('discoverProbes: scan=true returns one ready ST-LINK probe with DPIDR', async () => {
  const res = await discoverProbes({
    openocd: { command: 'openocd', search: 'C:\\scripts' },
    scan: true,
    env: EMPTY_ENV,
    run: fakeRunner({ scan: true }),
    exists: noExist,
  });
  assert.equal(res.probes.length, 1);
  assert.equal(res.probes[0].key, 'stlink:0483:3748');
  assert.equal(res.probes[0].status, 'ready');
  assert.equal(res.probes[0].dpidr, '0x2ba01477');
  assert.deepEqual(res.warnings, []);
});

test('discoverProbes: no hardware returns empty probes + warning (never throws)', async () => {
  const res = await discoverProbes({
    openocd: { command: 'openocd', search: 'C:\\scripts' },
    scan: false,
    env: EMPTY_ENV,
    run: async () => ({ code: 1, output: readFixture('noprobe-jlink.txt') }),
    exists: noExist,
  });
  assert.deepEqual(res.probes, []);
  assert.equal(res.warnings.length, 1);
  assert.match(res.warnings[0], /no probes detected/i);
});

test('discoverProbes: permission failure is surfaced as an actionable warning', async () => {
  const res = await discoverProbes({
    openocd: { command: 'openocd', search: 'C:\\scripts' },
    env: EMPTY_ENV,
    run: async () => ({ code: 1, output: 'Error: LIBUSB_ERROR_ACCESS\nError: open failed' }),
    exists: noExist,
  });
  assert.deepEqual(res.probes, []);
  assert.match(res.warnings.join(' '), /access denied/i);
});

test('discoverProbes: missing OpenOCD yields a warning, not a throw', async () => {
  const res = await discoverProbes({ env: EMPTY_ENV, run: async () => ({ code: 0, output: '' }), exists: noExist });
  assert.deepEqual(res.probes, []);
  assert.match(res.warnings[0], /openocd not found/i);
});

test('listBackends / findToolchains resolve via known paths and report versions', async () => {
  const known = {
    openocd: ['G:\\fake\\bin\\openocd.exe'],
    'arm-none-eabi-gdb': ['G:\\fake\\bin\\arm-none-eabi-gdb.exe'],
    gdb: ['D:\\msys64\\mingw64\\bin\\gdb.exe'],
  };
  const exists = (p) => Object.values(known).some((list) => list.includes(p));
  const run = async ({ command }) => {
    if (command === 'G:\\fake\\bin\\openocd.exe') return { code: 0, output: readFixture('openocd-version.txt') };
    if (command.endsWith('arm-none-eabi-gdb.exe')) {
      return { code: 0, output: 'GNU gdb (Arm GNU Toolchain 15.2.Rel1 (Build arm-15.86)) 16.3.90.20250906-git\n' };
    }
    if (command.endsWith('gdb.exe')) return { code: 0, output: 'GNU gdb (GDB) 16.3\n' };
    return { code: 1, output: '' };
  };

  const backends = await listBackends(EMPTY_ENV, { exists, run, knownPaths: known });
  const openocd = backends.find((b) => b.id === 'openocd');
  assert.equal(openocd.available, true);
  assert.equal(openocd.version, '0.12.0+dev-02228-ge5888bda3-dirty');
  assert.equal(openocd.search, null); // injected exists() knows no scripts dir
  assert.equal(backends.find((b) => b.id === 'jlink').available, false);

  const toolchains = await findToolchains(EMPTY_ENV, { exists, run, knownPaths: known });
  assert.equal(toolchains.find((t) => t.id === 'arm-none-eabi-gdb').version, '15.2');
  assert.equal(toolchains.find((t) => t.id === 'gdb').version, '16.3');
});

test('doctor reports actionable issues for missing toolchains, probes and target cfg', async () => {
  const backends = [{ id: 'openocd', available: true, path: 'openocd', version: '0.12.0', search: 'C:\\scripts' }];
  const toolchains = [{ id: 'gdb', available: true, path: 'gdb', version: '16.3' }];
  const probes = [
    {
      key: 'stlink:0483:3748',
      kind: 'stlink',
      status: 'ready',
      servers: ['openocd'],
      clock_khz: 950,
    },
  ];
  const out = await doctor({
    env: EMPTY_ENV,
    backends,
    toolchains,
    probes,
    exists: noExist,
    profiles: { p1: { target: 'does_not_exist', interface: 'stlink', speed_khz: 480 } },
    profile: 'p1',
  });
  const codes = out.issues.map((i) => i.code);
  assert.ok(codes.includes('E_TARGET_UNKNOWN'));
  assert.ok(codes.includes('NOTICE_ADAPTER_SPEED'));
  assert.ok(out.issues.every((i) => i.hint && i.hint.length > 0));

  const bad = await doctor({
    env: EMPTY_ENV,
    backends: [{ id: 'openocd', available: false, path: null, version: null }],
    toolchains: [{ id: 'gdb', available: false, path: null, version: null }],
    probes: [],
  });
  const badCodes = bad.issues.map((i) => i.code);
  assert.ok(badCodes.includes('E_TOOLCHAIN_MISSING'));
  assert.ok(badCodes.includes('E_PROBE_NOT_FOUND'));
});

test('doctor maps permission/firmware/busy probe status to issues', async () => {
  const out = await doctor({
    env: EMPTY_ENV,
    backends: [{ id: 'openocd', available: true, path: 'openocd', version: '0.12.0', search: null }],
    toolchains: [{ id: 'arm-none-eabi-gdb', available: true, path: 'gdb', version: '15.2' }],
    probes: [
      { key: 'stlink:0483:3748', status: 'permission', servers: ['openocd'] },
      { key: 'jlink:99', status: 'busy', servers: ['openocd', 'jlink'] },
    ],
  });
  const codes = out.issues.map((i) => i.code);
  assert.ok(codes.includes('E_PROBE_PERMISSION'));
  assert.ok(codes.includes('E_PROBE_BUSY'));
});

test('plan picks a ready probe and openocd, with reasons and alternatives', () => {
  const probes = [
    { key: 'stlink:0483:3748', kind: 'stlink', status: 'ready', servers: ['openocd'] },
    { key: 'jlink:50430612', kind: 'jlink', status: 'busy', servers: ['openocd', 'jlink'] },
  ];
  const out = plan({ probes, profiles: { stm32: { backend: 'auto', target: 'stm32f1x' } }, profile: 'stm32' });
  assert.equal(out.probe, 'stlink:0483:3748');
  assert.equal(out.backend, 'openocd');
  assert.equal(out.profile, 'stm32');
  assert.ok(out.reasons.some((r) => /auto-selected/.test(r)));
  assert.ok(out.alternatives.length >= 1);

  const explicit = plan({ probes, probe: 'jlink:50430612', backend: 'jlink' });
  assert.equal(explicit.probe, 'jlink:50430612');
  assert.equal(explicit.backend, 'jlink');

  const unsupported = plan({ probes, probe: 'stlink:0483:3748', backend: 'jlink' });
  assert.equal(unsupported.backend, 'jlink');
  assert.ok(unsupported.reasons.some((r) => /unsupported/.test(r)));
  assert.ok(unsupported.alternatives.some((a) => a.backend === 'openocd'));

  const none = plan({ probes: [] });
  assert.equal(none.probe, null);
  assert.ok(none.reasons.some((r) => /no probe detected/.test(r)));

  const missing = plan({ probes, probe: 'cmsis-dap:deadbeef' });
  assert.equal(missing.probe, null);
  assert.ok(missing.reasons.some((r) => /not found/.test(r)));
});
