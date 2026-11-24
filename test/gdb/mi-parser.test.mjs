/**
 * GDB/MI parser tests.
 *
 * Real transcripts: native gdb 16.3 (MinGW) and arm-none-eabi-gdb 15.2 (Arm
 * GNU Toolchain) captured by test/gdb/tools/capture-fixtures.mjs; pipe-crlf.txt
 * was captured over a real pipe on Windows so it is CRLF-terminated like
 * production traffic. synthetic-events.txt covers records that need a live
 * target (+download, @target output, watchpoints, ...).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MiStreamParser, parseMiRecord, parseMiTuple } from '../../src/gdb/mi-parser.mjs';
import { REAL_FIXTURES, SYNTHETIC_FIXTURE, chunkText, readFixture } from './helpers/fixtures.mjs';

const parseAll = (text) => new MiStreamParser().feed(text);
const kindsOf = (records) => {
  const out = {};
  for (const r of records) out[r.kind] = (out[r.kind] || 0) + 1;
  return out;
};
const byClass = (records, kind, cls) => records.find((r) => r.kind === kind && r.class === cls);

test('parseMiRecord: result records and tokens', () => {
  const done = parseMiRecord('^done');
  assert.equal(done.kind, 'result');
  assert.equal(done.class, 'done');
  assert.deepEqual(done.results, {});
  assert.equal(done.raw, '^done');

  assert.equal(parseMiRecord('^running').class, 'running');
  assert.equal(parseMiRecord('42^done,value="42"').token, 42);
  assert.equal(parseMiRecord('42^done,value="42"').results.value, '42');
  assert.equal(parseMiRecord('^connected,thread-id="1"').class, 'connected');
  assert.equal(parseMiRecord('^exit').class, 'exit');
  const err = parseMiRecord('^error,msg="No symbol table is loaded.  Use the \\"file\\" command."');
  assert.equal(err.class, 'error');
  assert.equal(err.results.msg, 'No symbol table is loaded.  Use the "file" command.');
});

test('parseMiRecord: async record classes', () => {
  assert.equal(parseMiRecord('*stopped,reason="exited-normally"').kind, 'exec');
  assert.equal(parseMiRecord('*running,thread-id="all"').kind, 'exec');
  assert.equal(parseMiRecord('=thread-created,id="1",group-id="i1"').kind, 'notify');
  assert.equal(parseMiRecord('+download,{section=".text",section-size="16"}').kind, 'status');
  const dl = parseMiRecord('+download,{section=".text",section-size="16"},total-size="32"');
  assert.equal(dl.class, 'download');
  assert.equal(dl.results['total-size'], '32');
  assert.deepEqual(dl.results._positional, [{ section: '.text', 'section-size': '16' }]);
});

test('parseMiRecord: stream records decode C escapes and octal', () => {
  assert.deepEqual(parseMiRecord('~"hello\\n"'), { kind: 'console', token: undefined, text: 'hello\n', raw: '~"hello\\n"' });
  assert.equal(parseMiRecord('@"target \\"quoted\\" line\\n"').text, 'target "quoted" line\n');
  assert.equal(parseMiRecord('@"back\\\\slash"').text, 'back\\slash');
  assert.equal(parseMiRecord('~"tab\\there"').text, 'tab\there');
  assert.equal(parseMiRecord('~"octal \\101\\102\\103"').text, 'octal ABC');
  assert.equal(parseMiRecord('7~"tokened"').token, 7);
  // Two adjacent strings on one record are concatenated.
  assert.equal(parseMiRecord('~"a"~"b"').text, 'ab');
});

test('parseMiRecord: prompt and non-MI lines', () => {
  assert.equal(parseMiRecord('(gdb) ').kind, 'prompt');
  assert.equal(parseMiRecord('(gdb)').kind, 'prompt');
  assert.equal(parseMiRecord('(gdb) \n').kind, 'prompt');
  // Real native gdb can leak raw inferior output onto the MI stdout stream.
  const unknown = parseMiRecord('desktop-5p8cqhq\\cjz');
  assert.equal(unknown.kind, 'unknown');
  assert.equal(unknown.text, 'desktop-5p8cqhq\\cjz');
  assert.equal(parseMiRecord(''), null);
  assert.equal(parseMiRecord('\r\n'), null);
  assert.equal(parseMiRecord(null), null);
});

test('parseMiTuple: nested tuples, lists, strings and bare values', () => {
  assert.deepEqual(parseMiTuple('a="1",b={c="2",d=["x","y"]},e=[]'), {
    a: '1',
    b: { c: '2', d: ['x', 'y'] },
    e: [],
  });
  assert.deepEqual(parseMiTuple(''), {});
  // Names keep their dashes.
  const stop = parseMiTuple('reason="breakpoint-hit",thread-id="1",signal-name="SIGSEGV"');
  assert.equal(stop['thread-id'], '1');
  assert.equal(stop['signal-name'], 'SIGSEGV');
  // Lists of named results (what gdb 16 really prints for -stack-list-frames).
  assert.deepEqual(parseMiTuple('stack=[frame={level="0",addr="0x1"},frame={level="1",addr="0x2"}]'), {
    stack: [
      { frame: { level: '0', addr: '0x1' } },
      { frame: { level: '1', addr: '0x2' } },
    ],
  });
  // Escaped backslashes and quotes.
  assert.deepEqual(parseMiTuple('full="D:\\\\work\\\\a.c",msg="say \\"hi\\""'), {
    full: 'D:\\work\\a.c',
    msg: 'say "hi"',
  });
});

test('every committed fixture parses without throwing and leaves no pending bytes', () => {
  for (const name of [...REAL_FIXTURES, SYNTHETIC_FIXTURE]) {
    const parser = new MiStreamParser();
    const records = parser.feed(readFixture(name));
    assert.ok(records.length > 0, `${name} produced records`);
    assert.equal(parser.pending, '', `${name} fully consumed`);
    for (const rec of records) {
      assert.equal(typeof rec.raw, 'string', `${name}: raw is a string`);
      assert.ok(!rec.raw.includes('\r'), `${name}: raw is newline-normalized`);
    }
  }
});

test('native gdb 16.3 startup transcript', () => {
  const recs = parseAll(readFixture('native-startup.txt'));
  const kinds = kindsOf(recs);
  assert.ok(kinds.prompt >= 8, 'one prompt per command');
  assert.ok(kinds.console >= 20, 'console stream chunks');
  const grp = byClass(recs, 'notify', 'thread-group-added');
  assert.equal(grp.results.id, 'i1');
  const version = recs.filter((r) => r.kind === 'console' && r.text.includes('GNU gdb (GDB) 16.3'));
  assert.equal(version.length, 1);
  const err = byClass(recs, 'result', 'error');
  assert.match(err.results.msg, /No symbol table is loaded/);
  assert.ok(byClass(recs, 'result', 'exit'));
  assert.equal(recs.filter((r) => r.kind === 'console').length, 25);
});

test('native gdb run/exited transcript: threads, running and exited stop', () => {
  const recs = parseAll(readFixture('native-run-exited.txt'));
  assert.equal(byClass(recs, 'notify', 'thread-group-started').results.pid !== undefined, true);
  assert.ok(byClass(recs, 'notify', 'thread-created'));
  assert.ok(byClass(recs, 'notify', 'thread-exited'));
  assert.ok(byClass(recs, 'notify', 'thread-group-exited'));
  assert.ok(byClass(recs, 'exec', 'running'));
  const stopped = byClass(recs, 'exec', 'stopped');
  assert.equal(stopped.results.reason, 'exited-normally');
  // Windows native inferior output leaks onto the MI stream as a raw line.
  assert.equal(kindsOf(recs).unknown, 1);
});

test('native gdb step/starti transcript: signal stop, stepping, stack and thread-info', () => {
  const recs = parseAll(readFixture('native-starti-step.txt'));
  const signalStop = recs.find((r) => r.kind === 'exec' && r.class === 'stopped' && r.results.reason === 'signal-received');
  assert.equal(signalStop.results['signal-name'], '0');
  assert.equal(signalStop.results['signal-meaning'], 'Signal 0');
  assert.equal(signalStop.results.frame.func, 'ntdll!RtlGetReturnAddressHijackTarget');
  assert.equal(signalStop.results.frame.from, 'C:\\WINDOWS\\SYSTEM32\\ntdll.dll');
  assert.equal(signalStop.results['thread-id'], '1');
  const steps = recs.filter((r) => r.kind === 'exec' && r.class === 'stopped' && r.results.reason === 'end-stepping-range');
  assert.equal(steps.length, 2);
  assert.equal(steps[0].results.frame.arch, 'i386:x86-64');
  const stackDone = recs.find((r) => r.kind === 'result' && r.class === 'done' && r.results.stack);
  assert.equal(stackDone.results.stack[0].frame.func, 'ntdll!RtlGetReturnAddressHijackTarget');
  assert.equal(stackDone.results.stack[1].frame.level, '1');
  const info = recs.find((r) => r.kind === 'result' && r.results.threads);
  assert.equal(info.results.threads.length, 4);
  assert.equal(info.results.threads[0].state, 'stopped');
  assert.equal(info.results['current-thread-id'], '1');
  assert.equal(byClass(recs, 'exec', 'stopped').results.reason, 'signal-received');
  const allStops = recs.filter((r) => r.kind === 'exec' && r.class === 'stopped');
  assert.equal(allStops.at(-1).results.reason, 'exited-normally');
});

test('arm-none-eabi-gdb 15.2 transcript: breakpoints, BreakpointTable, log stream, octal error', () => {
  const recs = parseAll(readFixture('arm-symbols-break.txt'));
  const insert = recs.find((r) => r.kind === 'result' && r.results && r.results.bkpt);
  assert.equal(insert.results.bkpt.number, '1');
  assert.equal(insert.results.bkpt.func, 'main');
  assert.equal(insert.results.bkpt.line, '77');
  assert.deepEqual(insert.results.bkpt['thread-groups'], ['i1']);
  assert.equal(insert.results.bkpt.fullname, 'D:\\projects\\f103\\zxw\\P01_WindSensor_Val\\Core\\Src\\main.c');
  const table = recs.find((r) => r.results && r.results.BreakpointTable);
  assert.equal(table.results.BreakpointTable.nr_rows, '2');
  assert.equal(table.results.BreakpointTable.body.length, 2);
  assert.equal(table.results.BreakpointTable.body[1].bkpt['original-location'], 'main.c:77');
  const logs = recs.filter((r) => r.kind === 'log');
  assert.equal(logs.length, 2);
  assert.match(logs[0].text, /could not convert 'main' from the host encoding/);
  const err = byClass(recs, 'result', 'error');
  assert.match(err.results.msg, /^could not connect \(error 138\): /);
  // Message contains octal-encoded non-ASCII bytes: decoded, no escapes left.
  assert.ok(!/\\[0-7]{3}/.test(err.results.msg));
  assert.ok(err.results.msg.length > 'could not connect (error 138): '.length);
  assert.ok(byClass(recs, 'result', 'exit'));
});

test('CRLF pipe transcript (real Windows pipe capture)', () => {
  const text = readFixture('pipe-crlf.txt');
  assert.ok(text.includes('\r\n'), 'fixture is CRLF');
  const recs = parseAll(text);
  assert.equal(recs.filter((r) => r.kind === 'prompt').length, 8);
  const errors = recs.filter((r) => r.kind === 'result' && r.class === 'error');
  assert.equal(errors.length, 2);
  assert.equal(errors[0].results.msg, 'C:/no such dir/missing.exe: No such file or directory.');
  assert.equal(errors[1].results.msg, 'No symbol table is loaded.  Use the "file" command.');
  for (const rec of recs) assert.ok(!rec.raw.includes('\r'));
});

test('synthetic events: +download, @target, &log, threads, watchpoints, tokens', () => {
  const recs = parseAll(readFixture(SYNTHETIC_FIXTURE));
  const kinds = kindsOf(recs);
  assert.equal(kinds.notify, 4);
  assert.equal(kinds.status, 2);
  assert.equal(kinds.target, 2);
  assert.equal(kinds.log, 1);
  assert.equal(kinds.console, 1);
  assert.equal(kinds.exec, 4);
  assert.equal(kinds.result, 6);
  assert.equal(kinds.prompt, 1);

  const downloads = recs.filter((r) => r.kind === 'status');
  assert.deepEqual(downloads[0].results._positional, [{ section: '.text', 'section-size': '4096' }]);
  assert.equal(downloads[1].results._positional[0]['section-size'], '512');

  const targets = recs.filter((r) => r.kind === 'target');
  assert.equal(targets[0].text, '/uart: hello "world"\n');
  assert.equal(targets[1].text, '/uart: backslash \\ and tab \t end');
  assert.equal(recs.find((r) => r.kind === 'log').text.startsWith('warning:'), true);
  assert.equal(recs.find((r) => r.kind === 'console').text, 'octal: ABC and quote: "q" and slash: \\ \n');

  const stops = recs.filter((r) => r.kind === 'exec' && r.class === 'stopped');
  assert.equal(stops[0].results.reason, 'breakpoint-hit');
  assert.equal(stops[0].results.bkptno, '2');
  assert.equal(stops[0].results.frame.fullname, 'D:\\work\\app\\Core\\Src\\main.c');
  assert.equal(stops[1].results['signal-name'], 'SIGSEGV');
  assert.deepEqual(stops[2].results.wpt, { number: '3', exp: 'counter' });
  assert.deepEqual(stops[2].results.value, { old: '1', new: '2' });
  assert.equal(stops[3].results['exit-code'], '0x0f');

  assert.equal(byClass(recs, 'result', 'connected').results['thread-id'], '1');
  const tokenRecords = recs.filter((r) => r.kind === 'result' && r.token !== undefined);
  assert.deepEqual(tokenRecords.map((r) => r.token), [42, 42, 43, 44, 45]);
  const threads = recs.find((r) => r.results && r.results.threads).results.threads;
  assert.deepEqual(threads.map((t) => t.name), ['main', 'worker']);
});

test('MiStreamParser: arbitrary chunking is equivalent to one-shot feeding', () => {
  for (const name of [...REAL_FIXTURES, SYNTHETIC_FIXTURE]) {
    const text = readFixture(name);
    const whole = parseAll(text);
    for (const sizes of [[1], [2, 3], [7], [5, 11, 1], [13, 4, 9]]) {
      const parser = new MiStreamParser();
      const records = [];
      for (const chunk of chunkText(text, sizes)) records.push(...parser.feed(chunk));
      assert.equal(parser.pending, '', `${name} sizes=${sizes} no pending bytes`);
      assert.deepEqual(records, whole, `${name} sizes=${sizes}`);
    }
  }
});

test('MiStreamParser: partial records, split CRLF and unterminated prompt', () => {
  const p = new MiStreamParser();
  assert.deepEqual(p.feed('~"abc'), []);
  const tail = p.feed('def\\n"\n');
  assert.equal(tail.length, 1);
  assert.equal(tail[0].text, 'abcdef\n');

  const p2 = new MiStreamParser();
  assert.deepEqual(p2.feed('^done\r'), []); // lone CR may be the first half of CRLF
  const doneAfterCrlf = p2.feed('\n');
  assert.equal(doneAfterCrlf.length, 1);
  assert.equal(doneAfterCrlf[0].class, 'done');
  assert.equal(p2.pending, '');

  const p3 = new MiStreamParser();
  const first = p3.feed('^done\n(gd');
  assert.equal(first.length, 1);
  assert.equal(first[0].class, 'done');
  const second = p3.feed('b) ');
  assert.equal(second.length, 1);
  assert.equal(second[0].kind, 'prompt');

  const p4 = new MiStreamParser();
  const recs = p4.feed('^done\n(gdb) ');
  assert.deepEqual(recs.map((r) => r.kind), ['result', 'prompt']);
  assert.equal(p4.pending, '');

  // Prompt bytes arriving in a chunk with no newline must be visible at once.
  const p5 = new MiStreamParser();
  assert.equal(p5.feed('(gdb) ').at(0).kind, 'prompt');
});

test('MiStreamParser: malformed line becomes kind:unknown instead of throwing', () => {
  const p = new MiStreamParser();
  const recs = p.feed('this is not mi\n^done\n');
  assert.equal(recs.length, 2);
  assert.equal(recs[0].kind, 'unknown');
  assert.equal(recs[0].text, 'this is not mi');
  assert.equal(recs[1].class, 'done');
  assert.equal(p.unknownLines, 1);
});
