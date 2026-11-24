/**
 * scripts/hw-discover.mjs tests: exported CLI entry point, JSON output shape.
 * Uses injected deps (no process spawn, no hardware).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runHwDiscover, parseArgs } from '../../scripts/hw-discover.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, 'fixtures');
const readFixture = (name) => fs.readFileSync(path.join(FIXTURES, name), 'utf8');

const EMPTY_ENV = { PATH: '', PATHEXT: '.EXE;.CMD' };
const noExist = () => false;

const runner = async ({ args }) => {
  const argv = args.join(' ');
  if (argv.includes('--version')) return { code: 0, output: readFixture('openocd-version.txt') };
  if (argv.includes('interface/stlink.cfg')) return { code: 0, output: readFixture('stlink-target.txt') };
  return { code: 1, output: readFixture('noprobe-jlink.txt') };
};

test('parseArgs handles the documented flags', () => {
  const a = parseArgs(['--doctor', '--scan', '--openocd', 'oc.exe', '--search', 'S', '--target', 'stm32f4x', '--interface', 'stlink,jlink', '--speed', '1000', '--profile', 'p1', '--plan']);
  assert.equal(a.doctor, true);
  assert.equal(a.scan, true);
  assert.equal(a.openocd, 'oc.exe');
  assert.equal(a.search, 'S');
  assert.equal(a.target, 'stm32f4x');
  assert.deepEqual(a.interfaces, ['stlink', 'jlink']);
  assert.equal(a.speed, 1000);
  assert.equal(a.profile, 'p1');
  assert.equal(a.plan, true);
});

test('--help prints usage JSON, exit 0', async () => {
  const { code, output } = await runHwDiscover({ argv: ['--help'], env: EMPTY_ENV });
  assert.equal(code, 0);
  const parsed = JSON.parse(output);
  assert.equal(parsed.ok, true);
  assert.match(parsed.usage, /hw-discover/);
});

test('discover mode prints probes/backends/toolchains JSON', async () => {
  const { code, output } = await runHwDiscover({
    argv: ['--openocd', 'openocd', '--scan'],
    env: EMPTY_ENV,
    deps: { run: runner, exists: noExist },
  });
  assert.equal(code, 0);
  const parsed = JSON.parse(output);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.probes.length, 1);
  assert.equal(parsed.probes[0].key, 'stlink:0483:3748');
  assert.equal(parsed.probes[0].dpidr, '0x2ba01477');
  assert.ok(Array.isArray(parsed.backends));
  assert.ok(Array.isArray(parsed.toolchains));
  assert.ok(Array.isArray(parsed.warnings));
});

test('doctor mode prints issues with hints and exit 0', async () => {
  const { code, output } = await runHwDiscover({
    argv: ['--doctor', '--openocd', 'openocd'],
    env: EMPTY_ENV,
    deps: { run: runner, exists: noExist },
    profiles: { stm32f103: { target: 'stm32f1x', interface: 'stlink', speed_khz: 480 } },
  });
  assert.equal(code, 0);
  const parsed = JSON.parse(output);
  assert.equal(parsed.ok, true);
  assert.ok(Array.isArray(parsed.issues));
  assert.ok(parsed.issues.length > 0);
  for (const issue of parsed.issues) {
    assert.ok(issue.code && issue.message && issue.hint);
  }
});
