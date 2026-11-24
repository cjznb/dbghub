/**
 * In-process tests for the fake-gdb state machine (test/gdb/fake/fake-gdb-core.mjs).
 *
 * These pin down exactly why the interrupt integration test is deterministic:
 *  - -exec-continue keeps the fake "running" for 250ms;
 *  - -exec-interrupt inside that window cancels the pending breakpoint stop and
 *    emits a fresh *stopped reason="signal-received";
 *  - the breakpoint stop never follows an interrupt.
 * They run anywhere, including sandboxes that cannot spawn children.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGdb } from './fake/fake-gdb-core.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeFake(opts = {}) {
  const lines = [];
  const exits = [];
  const fake = createFakeGdb({
    emit: (line) => lines.push(line),
    onExit: (code) => exits.push(code),
    ...opts,
  });
  return { fake, lines, exits, text: () => lines.join('\n') };
}

test('fake gdb core: greetings aside, -exec-run runs then stops as breakpoint-hit', async () => {
  const { fake, lines } = makeFake({ stopDelayMs: 30 });
  fake.handleLine('1-exec-run');
  assert.equal(fake.running, true);
  assert.deepEqual(lines.slice(0, 3), ['1^running', '*running,thread-id="all"', '(gdb) ']);
  await sleep(60);
  const stop = lines.find((l) => l.startsWith('*stopped'));
  assert.ok(stop);
  assert.match(stop, /reason="breakpoint-hit"/);
  assert.match(stop, /bkptno="1"/);
  assert.match(stop, /func="main"/);
  assert.equal(fake.running, false);
  fake.dispose();
});

test('fake gdb core: interrupt inside the running window emits a fresh signal stop', async () => {
  const { fake, lines } = makeFake({ stopDelayMs: 250, interruptDelayMs: 10 });
  fake.handleLine('1-exec-continue');
  await sleep(30);
  assert.equal(fake.running, true, 'still running before the 250ms stop');
  fake.handleLine('2-exec-interrupt --all');
  assert.match(lines.join('\n'), /2\^done/);
  await sleep(40);
  const stops = lines.filter((l) => l.startsWith('*stopped'));
  assert.equal(stops.length, 1, 'exactly one stop: the interrupt, not a stale breakpoint stop');
  assert.match(stops[0], /reason="signal-received"/);
  assert.match(stops[0], /signal-name="SIGINT"/);
  assert.equal(fake.running, false);
  // The cancelled breakpoint stop must not show up later.
  await sleep(260);
  assert.equal(lines.filter((l) => l.startsWith('*stopped')).length, 1);
  fake.dispose();
});

test('fake gdb core: interrupt while stopped replies ^error and does not fake a stop', async () => {
  const { fake, lines } = makeFake({ stopDelayMs: 10 });
  fake.handleLine('1-exec-run');
  await sleep(40);
  const before = lines.filter((l) => l.startsWith('*stopped')).length;
  fake.handleLine('2-exec-interrupt --all');
  assert.match(lines.join('\n'), /2\^error,msg="The program is not being run\."/);
  assert.equal(lines.filter((l) => l.startsWith('*stopped')).length, before);
  fake.dispose();
});

test('fake gdb core: tokens, unquoted target-select, breakpoint and eval replies', () => {
  const { fake, lines } = makeFake();
  fake.handleLine('7-break-insert main');
  assert.match(lines.at(-2), /^7\^done,bkpt=\{number="1"/);
  fake.handleLine('8-target-select extended-remote 127.0.0.1:3333');
  assert.equal(lines.at(-2), '8^connected,thread-id="1"');
  fake.handleLine('9-data-evaluate-expression counter');
  assert.equal(lines.at(-2), '9^done,value="42"');
  fake.handleLine('-gdb-set confirm off');
  assert.equal(lines.at(-2), '^done');
  fake.handleLine('10-bogus-command');
  assert.match(lines.at(-2), /^10\^error,msg="Undefined MI command: -bogus-command"/);
  fake.dispose();
});

test('fake gdb core: -gdb-exit replies ^exit and reports exit 0', async () => {
  const { fake, exits, lines } = makeFake({ exitDelayMs: 5 });
  fake.handleLine('3-gdb-exit');
  assert.equal(lines.at(-1), '3^exit');
  await sleep(20);
  assert.deepEqual(exits, [0]);
  fake.dispose();
});
