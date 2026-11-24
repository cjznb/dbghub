/**
 * childproc helper tests: pipe/file stdio fallback, timeout and spawn errors.
 * These spawn only `node` (never OpenOCD / a probe).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnCapture, spawnWatch } from '../../src/backends/childproc.mjs';

test('spawnCapture captures stdout+stderr and exit code', async () => {
  const r = await spawnCapture({
    command: process.execPath,
    args: ['-e', "console.log('out-line'); console.error('err-line')"],
    timeoutMs: 10000,
  });
  assert.equal(r.code, 0);
  assert.match(r.output, /out-line/);
  assert.match(r.output, /err-line/);
  assert.equal(r.mode === 'pipe' || r.mode === 'file', true);
});

test('spawnCapture reports ENOENT as spawnError', async () => {
  const r = await spawnCapture({ command: 'dbghub-missing-binary-xyz', timeoutMs: 5000 });
  assert.ok(r.spawnError);
  assert.equal(r.spawnError.code, 'ENOENT');
});

test('spawnCapture kills on timeout', async () => {
  const t0 = Date.now();
  const r = await spawnCapture({
    command: process.execPath,
    args: ['-e', 'setInterval(() => {}, 1000)'],
    timeoutMs: 400,
  });
  assert.equal(r.timedOut, true);
  assert.ok(Date.now() - t0 < 5000);
});

test('spawnWatch streams lines and reports a file/pipe mode', async () => {
  const lines = [];
  const proc = spawnWatch({
    command: process.execPath,
    args: ['-e', "console.log('a'); console.log('b'); console.error('c')"],
  });
  proc.subscribe((line) => lines.push(line));
  await new Promise((resolve) => {
    proc.child.once('exit', () => setTimeout(resolve, 120)); // let the poller flush
  });
  proc.dispose();
  assert.deepEqual(lines.slice(0, 3).sort(), ['a', 'b', 'c']);
  assert.equal(proc.mode === 'pipe' || proc.mode === 'file', true);
});
