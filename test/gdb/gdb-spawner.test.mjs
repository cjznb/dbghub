/**
 * GdbSpawner tests: transport selection and error mapping.
 *
 * The relay fallback itself is exercised end-to-end by gdb-real.test.mjs (this
 * sandbox forces it). Here we only pin down the pipe-first behaviour and the
 * non-retryable error path, which are cheap and deterministic.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { GdbSpawner } from '../../src/gdb/gdb-spawner.mjs';
import { createFakeGdb } from './helpers/fake-spawn.mjs';

/** True when this environment denies child stdio pipes (e.g. DSH sandbox). */
function pipesBlocked() {
  try {
    const child = spawn(process.execPath, ['-e', '0'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    child.on('error', () => undefined);
    try { child.stdin.end(); } catch { /* ignore */ }
    setTimeout(() => { try { child.kill(); } catch { /* ignore */ } }, 2000).unref();
    return false;
  } catch {
    return true;
  }
}

test('spawn(): uses pipes and reports stdioMode=pipe', async () => {
  const fake = createFakeGdb();
  const spawner = new GdbSpawner({ spawnFn: fake.spawn });
  assert.equal(spawner.stdioMode, 'pipe');
  const child = await spawner.spawn('gdb', ['--interpreter=mi3', '-q'], {
    cwd: 'C:\\work',
    env: { PATH: 'x' },
    windowsHide: true,
  });
  assert.equal(child, fake.child);
  assert.equal(spawner.stdioMode, 'pipe');
  assert.equal(fake.spawnCalls.length, 1);
  assert.deepEqual(fake.spawnCalls[0].args, ['--interpreter=mi3', '-q']);
  assert.deepEqual(fake.spawnCalls[0].stdio, ['pipe', 'pipe', 'pipe']);
  assert.equal(fake.spawnCalls[0].cwd, 'C:\\work');
  assert.equal(fake.spawnCalls[0].shell, false);
});

test('spawn(): non-permission spawn failures are not retried through the relay', async () => {
  const spawner = new GdbSpawner({
    spawnFn: () => {
      const err = new Error('spawn missing-gdb ENOENT');
      err.code = 'ENOENT';
      throw err;
    },
  });
  await assert.rejects(spawner.spawn('missing-gdb', [], {}), (e) => {
    assert.equal(e.code, 'E_SPAWN');
    assert.match(e.message, /ENOENT/);
    assert.equal(e.miError.spawn, true);
    return true;
  });
});

test('spawn(): empty program path loadProgram is rejected before spawning', async () => {
  const fake = createFakeGdb();
  const { GdbSession } = await import('../../src/gdb/gdb-session.mjs');
  const session = new GdbSession({ gdbPath: 'gdb', spawn: fake.spawn });
  await session.start();
  await assert.rejects(session.loadProgram(''), (e) => e.code === 'E_INVALID_ARG');
  await assert.rejects(session.loadProgram(null), (e) => e.code === 'E_INVALID_ARG');
  await session.close();
});

test('relay fallback failure surfaces as E_SPAWN instead of hanging', { timeout: 30000 }, async (t) => {
  if (!pipesBlocked()) {
    t.skip('stdio pipes are usable here, so the relay fallback is not exercised');
    return;
  }
  const { GdbSession } = await import('../../src/gdb/gdb-session.mjs');
  const session = new GdbSession({
    gdbPath: 'C:/definitely/not/gdb.exe',
    pwshPath: 'C:/definitely/not/pwsh.exe',
    startTimeoutMs: 5000,
  });
  const t0 = Date.now();
  await assert.rejects(session.start(), (e) => {
    assert.equal(e.code, 'E_SPAWN');
    assert.match(e.message, /PowerShell 7|relay/i);
    return true;
  });
  assert.ok(Date.now() - t0 < 5000, 'relay failure must fail fast');
  await session.close();
  assert.equal(session.status, 'closed');
});
