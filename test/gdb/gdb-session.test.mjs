/**
 * GdbSession tests against an in-process fake gdb (injected spawn).
 *
 * No OS pipes are used, so these tests are deterministic and also pass in
 * sandboxes that deny pipe creation. A separate optional test file
 * (gdb-session-spawn.test.mjs) exercises the same class against a real
 * fake-gdb *process* when pipes are available.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GdbSession } from '../../src/gdb/gdb-session.mjs';
import { createFakeGdb } from './helpers/fake-spawn.mjs';

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

function makeSession(fake, extra = {}) {
  return new GdbSession({ gdbPath: 'fake-gdb', spawn: fake.spawn, ...extra });
}

async function startedSession(extra = {}, fakeOpts = {}) {
  const fake = createFakeGdb(fakeOpts);
  const session = makeSession(fake, extra);
  await session.start();
  return { fake, session };
}

test('program option: auto-loads once and explicit loadProgram is a no-op', async () => {
  const fake = createFakeGdb();
  const program = 'D:\\work\\demo\\build\\app.elf';
  const session = new GdbSession({ gdbPath: 'fake-gdb', spawn: fake.spawn, program });
  await session.start();
  const loadCommands = fake.commands.filter((c) => c.includes('-file-exec-and-symbols'));
  assert.equal(loadCommands.length, 1, 'auto-loaded exactly once at start');
  await session.loadProgram(program);
  assert.equal(fake.commands.filter((c) => c.includes('-file-exec-and-symbols')).length, 1);
  await session.close();
});

test('close(): safe before start()', async () => {
  const fake = createFakeGdb();
  const session = new GdbSession({ gdbPath: 'fake-gdb', spawn: fake.spawn });
  await session.close();
  assert.equal(session.status, 'closed');
  assert.equal(fake.spawnCalls.length, 0);
});

test('start(): argv array, status, stdioMode and initial prompt', async () => {
  const fake = createFakeGdb();
  const session = new GdbSession({ gdbPath: 'fake-gdb', args: ['-nx', '--nx'], spawn: fake.spawn });
  assert.equal(session.status, 'closed');
  assert.equal(session.stdioMode, 'pipe');
  await session.start();
  assert.equal(session.status, 'stopped');
  assert.equal(session.stdioMode, 'pipe');
  assert.equal(fake.spawnCalls.length, 1);
  assert.equal(fake.spawnCalls[0].file, 'fake-gdb');
  assert.deepEqual(fake.spawnCalls[0].args, ['--interpreter=mi3', '-q', '-nx', '--nx']);
  assert.equal(fake.spawnCalls[0].shell, false);
  assert.equal(fake.spawnCalls[0].windowsHide, true);
  await session.close();
});

test('exec(): token-matched result records', async () => {
  const { fake, session } = await startedSession();
  const res = await session.exec('-break-insert main');
  assert.equal(res.class, 'done');
  assert.equal(res.token, 1);
  assert.equal(res.results.bkpt.number, '1');
  assert.equal(res.results.bkpt.func, 'main');
  assert.equal(res.results.bkpt.fullname, 'D:\\work\\demo\\src\\main.c');
  assert.equal(res.results.bkpt['thread-groups'][0], 'i1');
  // Commands are written with their token immediately before the '-'.
  assert.match(fake.commands[0], /^1-break-insert main$/);
  await session.close();
});

test('exec(): async records arriving mid-command do not become the result', async () => {
  const { fake, session } = await startedSession({}, { noise: true });
  const records = [];
  const outputs = [];
  session.on('record', (r) => records.push(r));
  session.on('output', (o) => outputs.push(o));
  const res = await session.exec('-break-list');
  assert.equal(res.class, 'done');
  assert.ok(res.results.BreakpointTable);
  assert.ok(records.some((r) => r.kind === 'notify' && r.class === 'thread-created'));
  assert.ok(outputs.some((o) => o.stream === 'console' && o.text === 'chatter from the target\n'));
  await session.close();
});

test('exec(): commands are serialized in call order', async () => {
  const { fake, session } = await startedSession({}, { replyDelayMs: 15 });
  const [a, b, c] = await Promise.all([
    session.exec('-break-insert main'),
    session.exec('-break-list'),
    session.exec('-data-evaluate-expression 1+1'),
  ]);
  assert.equal(a.class, 'done');
  assert.equal(b.class, 'done');
  assert.equal(c.results.value, '42');
  // Commands reach gdb strictly one after another (queue), tokens increasing.
  assert.deepEqual(fake.commands.map((c2) => c2.replace(/^\d+/, '')), [
    '-break-insert main',
    '-break-list',
    '-data-evaluate-expression 1+1',
  ]);
  await session.close();
});

test('exec(): ^error rejects with a clean Error carrying miError', async () => {
  const { session } = await startedSession();
  let caught;
  try {
    await session.exec('-bogus-command');
  } catch (e) {
    caught = e;
  }
  assert.ok(caught, 'rejects');
  assert.equal(caught.code, 'E_GDB_MI');
  assert.equal(caught.miError.class, 'error');
  assert.equal(caught.miError.msg, 'Undefined MI command: -bogus-command');
  assert.equal(caught.message, caught.miError.msg);
  assert.equal(caught.message.includes('\n'), false, 'single-line agent-facing message');
  assert.equal(/^\s+at /m.test(caught.message), false, 'no stack frames in the message');
  // Session remains usable after a rejected command.
  const ok = await session.exec('-gdb-set pagination off');
  assert.equal(ok.class, 'done');
  await session.close();
});

test('exec(): timeout rejects E_TIMEOUT, late reply is ignored, session survives', async () => {
  const { session } = await startedSession();
  await assert.rejects(session.exec('-slow-command', { timeoutMs: 40 }), (e) => {
    assert.equal(e.code, 'E_TIMEOUT');
    assert.equal(e.miError.timeout, true);
    assert.equal(e.miError.command, '-slow-command');
    assert.match(e.message, /timed out after 40ms/);
    return true;
  });
  await assert.rejects(session.exec('-slow-command-late', { timeoutMs: 40 }), (e) => e.code === 'E_TIMEOUT');
  await tick(150); // late ^done arrives; must be swallowed
  const res = await session.exec('-gdb-set pagination off');
  assert.equal(res.class, 'done');
  await session.close();
});

test('exec(): rejects invalid commands without touching gdb', async () => {
  const { fake, session } = await startedSession();
  const before = fake.commands.length;
  await assert.rejects(session.exec(''), (e) => e.code === 'E_INVALID_ARG');
  await assert.rejects(session.exec('-exec-continue\n-exec-kill'), (e) => e.code === 'E_INVALID_ARG');
  assert.equal(fake.commands.length, before);
  await session.close();
});

test('loadProgram(): quotes the path and is idempotent for the same path', async () => {
  const { fake, session } = await startedSession();
  const program = 'D:\\work\\demo\\build\\app.elf';
  const first = await session.loadProgram(program);
  assert.equal(first.class, 'done');
  assert.equal(fake.commands.at(-1), `1-file-exec-and-symbols "D:\\\\work\\\\demo\\\\build\\\\app.elf"`);
  const count = fake.commands.length;
  const second = await session.loadProgram(program);
  assert.equal(second, first, 'same path returns the cached result');
  assert.equal(fake.commands.length, count, 'same path is not reloaded');
  // A different path does reload.
  await session.loadProgram('D:\\work\\demo\\build\\other.elf');
  assert.equal(fake.commands.length, count + 1);
  await session.close();
});

test('selectRemote(): unquoted -target-select extended-remote (Renode/OpenOCD)', async () => {
  const { fake, session } = await startedSession();
  const res = await session.selectRemote('127.0.0.1:3333');
  assert.equal(res.class, 'connected');
  // MI target-select must NOT quote the address: gdb would treat the quote as
  // part of the host name ("127.0.0.1:3333": cannot resolve name).
  assert.equal(fake.commands.at(-1), '1-target-select extended-remote 127.0.0.1:3333');
  const ipv6 = await session.selectRemote('[::1]:3333');
  assert.equal(ipv6.class, 'connected');
  assert.equal(fake.commands.at(-1), '2-target-select extended-remote [::1]:3333');
  await session.close();
});

test('selectRemote(): rejects addresses that would break MI syntax', async () => {
  const { fake, session } = await startedSession();
  const before = fake.commands.length;
  for (const bad of ['local host:3333', 'host"x:1', 'host;rm -rf:1', '', null]) {
    await assert.rejects(session.selectRemote(bad), (e) => e.code === 'E_INVALID_ARG');
  }
  assert.equal(fake.commands.length, before);
  await session.close();
});

test('exec(): -exec-run reaches *running then *stopped with a mapped StopEvent', async () => {
  const { session } = await startedSession({}, { stopDelayMs: 20 });
  const stops = [];
  session.on('stop', (s) => stops.push(s));
  await session.exec('-exec-run');
  assert.equal(session.status, 'running');
  const stop = await session.waitForStop({ timeoutMs: 2000 });
  assert.equal(session.status, 'stopped');
  assert.equal(session.lastStop, stop);
  assert.equal(stops.length, 1);
  assert.equal(stops[0], stop);
  assert.equal(stop.reason, 'breakpoint-hit');
  assert.equal(stop.reasonKind, 'breakpoint');
  assert.equal(stop.bkptno, 1);
  assert.equal(stop.threadId, 1);
  assert.equal(stop.disp, 'keep');
  assert.deepEqual(
    { level: stop.frame.level, func: stop.frame.func, line: stop.frame.line, file: stop.frame.file },
    { level: 0, func: 'main', line: 12, file: 'src/main.c' },
  );
  assert.equal(stop.frame.fullname, 'D:\\work\\demo\\src\\main.c');
  assert.equal(stop.raw.kind, 'exec');
  await session.close();
});

test('waitForStop(): returns immediately when already stopped', async () => {
  const { session } = await startedSession({}, { stopDelayMs: 5 });
  await session.exec('-exec-run');
  const first = await session.waitForStop({ timeoutMs: 2000 });
  const t0 = Date.now();
  const second = await session.waitForStop({ timeoutMs: 5000 });
  assert.ok(Date.now() - t0 < 50, 'already-stopped path must not wait');
  assert.equal(second, first);
  await session.close();
});

test('waitForStop(): times out with E_TIMEOUT when nothing stops', async () => {
  const { session } = await startedSession();
  await assert.rejects(session.waitForStop({ timeoutMs: 40 }), (e) => {
    assert.equal(e.code, 'E_TIMEOUT');
    assert.equal(e.miError.timeout, true);
    return true;
  });
  await session.close();
});

test('signal stop events keep signal name/meaning and thread id', async () => {
  const { session } = await startedSession({}, {
    stop: { reason: 'signal-received', signal: 'SIGSEGV', signalMeaning: 'Segmentation fault', threadId: 2 },
  });
  const stopP = session.waitForStop({ timeoutMs: 2000 });
  await session.exec('-exec-run');
  const stop = await stopP;
  assert.equal(stop.reasonKind, 'signal');
  assert.equal(stop.signal, 'SIGSEGV');
  assert.equal(stop.signalMeaning, 'Segmentation fault');
  assert.equal(stop.threadId, 2);
  await session.close();
});

test('exited stop sets status=exited and has no frame', async () => {
  const { session } = await startedSession({}, { stop: { reason: 'exited-normally', exitCode: '0' } });
  const stopP = session.waitForStop({ timeoutMs: 2000 });
  await session.exec('-exec-run');
  const stop = await stopP;
  assert.equal(stop.reasonKind, 'exited');
  assert.equal(stop.frame, null);
  assert.equal(stop.exitCode, '0');
  assert.equal(session.status, 'exited');
  await session.close();
});

test('interrupt(): out-of-band, not queued behind a pending command', async () => {
  const { fake, session } = await startedSession({}, {
    autoStop: false,
    stop: { reason: 'signal-received', signal: 'SIGINT', signalMeaning: 'Interrupt' },
    stopDelayMs: 10,
  });
  await session.exec('-exec-run');
  // Hold a command in the queue; interrupt() must bypass it.
  const slow = session.exec('-slow-command', { timeoutMs: 250 });
  slow.catch(() => undefined);
  await tick(10);
  assert.equal(session.status, 'running');
  await session.interrupt();
  const stop = await session.waitForStop({ timeoutMs: 2000 });
  assert.equal(stop.reasonKind, 'signal');
  assert.equal(stop.signal, 'SIGINT');
  const interruptIndex = fake.commands.findIndex((c) => c.includes('-exec-interrupt --all'));
  const slowIndex = fake.commands.findIndex((c) => c.includes('-slow-command'));
  assert.ok(interruptIndex > slowIndex, 'interrupt was written after the queued command');
  await assert.rejects(slow, (e) => e.code === 'E_TIMEOUT');
  await session.close();
});

test('interrupt(): "not running" ^error is swallowed (pause is idempotent)', async () => {
  const { session } = await startedSession();
  await session.interrupt(); // not running: fake replies ^error
  assert.equal(session.status, 'stopped');
  await session.close();
});

test('execRaw(): writes without waiting for the result', async () => {
  const { fake, session } = await startedSession({}, { replyDelayMs: 30 });
  const t0 = Date.now();
  await session.execRaw('-gdb-set pagination off');
  assert.ok(Date.now() - t0 < 25, 'execRaw must not await the ^done');
  await tick(60);
  assert.ok(fake.commands.some((c) => c.includes('-gdb-set pagination off')));
  // The raw reply token must not complete an unrelated pending command.
  const res = await session.exec('-break-insert main');
  assert.equal(res.class, 'done');
  await session.close();
});

test('output events: console/target/log streams with decoded text', async () => {
  const { fake, session } = await startedSession();
  const outputs = [];
  session.on('output', (o) => outputs.push(o));
  fake.emitRaw('~"console line\\n"\r\n');
  fake.emitRaw('@"/uart: hello\\n"\r\n');
  fake.emitRaw('&"log line\\n"\r\n');
  await tick(10);
  assert.deepEqual(outputs, [
    { stream: 'console', text: 'console line\n' },
    { stream: 'target', text: '/uart: hello\n' },
    { stream: 'log', text: 'log line\n' },
  ]);
  await session.close();
});

test('progress events from +download', async () => {
  const { fake, session } = await startedSession();
  const progress = [];
  session.on('progress', (p) => progress.push(p));
  fake.emitRaw('+download,{section=".text",section-size="4096"},total-size="16384"\r\n');
  await tick(10);
  assert.equal(progress.length, 1);
  assert.equal(progress[0].section, '.text');
  assert.equal(progress[0].size, 4096);
  assert.equal(progress[0].total, 16384);
  await session.close();
});

test('stderr tail is recorded and bounded', async () => {
  const { fake, session } = await startedSession({ stderrTailLines: 3 });
  const seen = [];
  session.on('stderr', (e) => seen.push(e.text));
  fake.emitStderr('warn 1\r\nwarn 2\r\n');
  fake.emitStderr('warn 3\nwarn 4\nwarn 5\n');
  await tick(10);
  assert.deepEqual(session.stderrTail, ['warn 3', 'warn 4', 'warn 5']);
  assert.equal(seen.length, 5);
  await session.close();
});

test('^exit resolves the command, then the exit event fires', async () => {
  const { session } = await startedSession();
  const exitEvents = [];
  session.on('exit', (e) => exitEvents.push(e));
  const res = await session.exec('-gdb-exit');
  assert.equal(res.class, 'exit');
  await tick(20);
  assert.equal(session.status, 'exited');
  assert.deepEqual(exitEvents, [{ code: 0, signal: null }]);
  assert.deepEqual(session.exitInfo, { code: 0, signal: null });
  // close() after gdb already exited is a no-op.
  await session.close();
  assert.equal(session.status, 'closed');
});

test('close(): idempotent, rejects in-flight commands and stop waiters', async () => {
  const { session } = await startedSession();
  const pending = session.exec('-slow-command', { timeoutMs: 5000 });
  pending.catch(() => undefined);
  const waiting = session.waitForStop({ timeoutMs: 5000 });
  waiting.catch(() => undefined);
  await tick(5);
  const t0 = Date.now();
  await Promise.all([session.close(), session.close()]);
  assert.ok(Date.now() - t0 < 500, 'close must not hang');
  assert.equal(session.status, 'closed');
  await assert.rejects(pending, (e) => e.code === 'E_CLOSED');
  await assert.rejects(waiting, (e) => e.code === 'E_CLOSED');
  // Calls after close fail fast instead of hanging.
  await assert.rejects(session.exec('-gdb-set x 1'), (e) => e.code === 'E_CLOSED');
});

test('spawn errors reject start() with E_SPAWN (no unhandled error event)', async () => {
  const fake = createFakeGdb({ greet: false });
  const session = new GdbSession({ gdbPath: 'missing-gdb', spawn: fake.spawn, startTimeoutMs: 2000 });
  const startP = session.start();
  const err = Object.assign(new Error('spawn missing-gdb ENOENT'), { code: 'ENOENT' });
  setTimeout(() => fake.child.emit('error', err), 5);
  await assert.rejects(startP, (e) => {
    assert.equal(e.code, 'E_SPAWN');
    assert.match(e.message, /ENOENT/);
    return true;
  });
  await session.close();
  assert.equal(session.status, 'closed');
});

test('start(): gdb exiting before the first prompt rejects start()', async () => {
  const fake = createFakeGdb({ greet: false });
  const session = new GdbSession({ gdbPath: 'fake-gdb', spawn: fake.spawn, startTimeoutMs: 2000 });
  const startP = session.start();
  setTimeout(() => fake.emitExit(3), 10);
  await assert.rejects(startP, (e) => e.code === 'E_GDB_EXIT');
  await session.close();
});

test('start(): quiet gdb falls back to a degraded-but-usable session', async () => {
  const fake = createFakeGdb({ greet: false });
  const session = new GdbSession({ gdbPath: 'fake-gdb', spawn: fake.spawn, startTimeoutMs: 60 });
  await session.start();
  assert.equal(session.readyDegraded, true);
  assert.equal(session.status, 'stopped');
  // gdb is alive (just quiet); commands still work.
  const res = await session.exec('-gdb-set pagination off');
  assert.equal(res.class, 'done');
  await session.close();
});

test('events: record fires for async records, prompt records are not results', async () => {
  const { fake, session } = await startedSession();
  const records = [];
  session.on('record', (r) => records.push(r));
  fake.emitRaw('=thread-created,id="3",group-id="i1"\r\n');
  fake.emitRaw('*stopped,reason="breakpoint-hit",bkptno="7",frame={level="0",addr="0x1",func="f"},thread-id="3"\r\n');
  await tick(10);
  assert.ok(records.some((r) => r.kind === 'notify' && r.class === 'thread-created'));
  const stop = await session.waitForStop({ timeoutMs: 1000 });
  assert.equal(stop.bkptno, 7);
  assert.equal(stop.threadId, 3);
  assert.equal(stop.frame.func, 'f');
  assert.equal(stop.frame.level, 0);
  await session.close();
});

test('works with CRLF-terminated output and split packets', async () => {
  const fake = createFakeGdb({ crlf: true, chunked: true });
  const session = makeSession(fake);
  await session.start();
  const res = await session.exec('-break-insert main');
  assert.equal(res.results.bkpt.number, '1');
  await session.exec('-exec-run');
  const stop = await session.waitForStop({ timeoutMs: 2000 });
  assert.equal(stop.reasonKind, 'breakpoint');
  await session.close();
});
