/**
 * Fake gdb process over real pipes (ChildProcess transport).
 *
 * Skips when the environment denies stdio pipes (e.g. DSH sandbox with
 * workspace-write only). In a normal shell/CI this exercises the pipe path.
 *
 * The interrupt part asserts a *new* stop: the fake keeps "running" for 250ms
 * after -exec-continue, the test interrupts inside that window, and the fake
 * then emits *stopped reason="signal-received" (never a stale breakpoint stop).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GdbSession } from '../../src/gdb/gdb-session.mjs';

const FAKE_GDB = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fake', 'fake-gdb.mjs');

/** True when the platform allows Node to create stdio pipes for a child. */
function pipesUsable() {
  try {
    const child = spawn(process.execPath, ['-e', '0'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    child.on('error', () => undefined);
    try { child.stdin.end(); } catch { /* ignore */ }
    setTimeout(() => { try { child.kill(); } catch { /* ignore */ } }, 2000).unref();
    return true;
  } catch {
    return false;
  }
}

const PIPES = pipesUsable();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('fake gdb process over pipes: start, exec, run, stop, interrupt, close', { timeout: 30000 }, async (t) => {
  if (!PIPES) {
    t.skip('stdio pipes are blocked in this sandbox (child_process spawn EPERM)');
    return;
  }
  const session = new GdbSession({ gdbPath: process.execPath, argv: [FAKE_GDB] });
  const stops = [];
  session.on('stop', (s) => stops.push(s));
  try {
    await session.start();
    assert.equal(session.stdioMode, 'pipe');
    assert.equal(session.status, 'stopped');

    const inserted = await session.exec('-break-insert main');
    assert.equal(inserted.results.bkpt.func, 'main');

    const frames = await session.exec('-stack-list-frames 0 2');
    assert.equal(frames.results.stack.length, 2);

    await session.exec('-exec-run');
    const stop = await session.waitForStop({ timeoutMs: 5000 });
    assert.equal(stop.reason, 'breakpoint-hit');
    assert.equal(stop.bkptno, 1);
    assert.equal(stop.frame.func, 'main');
    assert.equal(stop.frame.line, 12);
    assert.equal(stops.length, 1);

    const evalRes = await session.exec('-data-evaluate-expression counter');
    assert.equal(evalRes.results.value, '42');

    // Continue and interrupt while the fake is still "running" (250ms window).
    await session.exec('-exec-continue');
    assert.equal(session.status, 'running');
    await sleep(40);
    assert.equal(session.status, 'running', 'must interrupt before the breakpoint stop arrives');
    await session.interrupt();
    const interrupted = await session.waitForStop({ timeoutMs: 5000 });
    assert.equal(interrupted.reasonKind, 'signal', `reason=${interrupted.reason}`);
    assert.equal(interrupted.signal, 'SIGINT');
    assert.equal(stops.length, 2, 'interrupt must produce a new stop event');
    assert.equal(stops[1], interrupted);
  } finally {
    await session.close();
  }
  assert.equal(session.status, 'closed');
});
