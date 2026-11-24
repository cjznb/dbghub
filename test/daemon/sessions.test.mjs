/**
 * Session manager tests with fully fake gdb/backend/symbols/probe dependencies.
 * Covers open orchestration, StopCard/epoch/ev semantics, exclusivity, lease, op_id cache,
 * pagination, output ring, raw gating and close/restart.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createSessionManager } from '../../src/daemon/sessions.mjs';

const WORKSPACE = 'D:/ws';

// --------------------------------------------------------------------- fakes

const STOP_FRAME = {
  level: 0,
  func: 'main',
  file: 'src/main.c',
  fullname: 'D:/ws/src/main.c',
  line: 10,
  addr: '0x8000100',
};

function defaultScript() {
  return [
    { match: '-stack-info-depth', respond: () => ({ class: 'done', results: { depth: 3 } }) },
    {
      match: '-stack-list-variables',
      respond: () => ({ class: 'done', results: { variables: [{ name: 'x', value: '41' }, { name: 'y', value: '<optimized out>' }] } }),
    },
    {
      match: '-stack-list-frames',
      respond: () => ({
        class: 'done',
        results: {
          stack: [
            { level: 0, frame: { func: 'main', file: 'src/main.c', fullname: 'D:/ws/src/main.c', line: 10, addr: '0x8000100' } },
            { level: 1, frame: { func: 'foo', file: 'src/main.c', fullname: 'D:/ws/src/main.c', line: 20, addr: '0x8000200' } },
          ],
        },
      }),
    },
    {
      match: '-stack-list-arguments',
      respond: () => ({ class: 'done', results: { 'stack-args': [{ level: 0, args: [{ name: 'argc', value: '1' }] }] } }),
    },
    { match: '-data-evaluate-expression', respond: () => ({ class: 'done', results: { value: '42' } }) },
    {
      match: '-break-insert',
      respond: () => ({ class: 'done', results: { bkpt: { number: 1, func: 'main', file: 'src/main.c', fullname: 'D:/ws/src/main.c', line: 10, enabled: 'y', times: '0' } } }),
    },
    {
      match: '-break-list',
      respond: () => ({
        class: 'done',
        results: {
          BreakpointTable: {
            body: [{ bkpt: { number: 1, func: 'main', file: 'src/main.c', fullname: 'D:/ws/src/main.c', line: 10, enabled: 'y', times: '2' } }],
          },
        },
      }),
    },
    { match: '-break-delete', respond: () => ({ class: 'done', results: {} }) },
    { match: '-break-condition', respond: () => ({ class: 'done', results: {} }) },
    { match: '-break-enable', respond: () => ({ class: 'done', results: {} }) },
    { match: '-break-disable', respond: () => ({ class: 'done', results: {} }) },
    { match: '-data-list-register-names', respond: () => ({ class: 'done', results: { 'register-names': ['r0', 'r1', 'sp', 'pc'] } }) },
    {
      match: '-data-list-register-values',
      respond: () => ({
        class: 'done',
        results: {
          'register-values': [
            { number: '0', value: '0x1' }, { number: '1', value: '0x2' },
            { number: '2', value: '0x7ffffff0' }, { number: '3', value: '0x8000100' },
          ],
        },
      }),
    },
    {
      match: '-thread-info',
      respond: () => ({ class: 'done', results: { threads: [{ id: 1, state: 'stopped', frame: { func: 'main', fullname: 'D:/ws/src/main.c', line: 10, addr: '0x8000100' } }] } }),
    },
    {
      match: '-data-read-memory-bytes',
      respond: () => ({ class: 'done', results: { memory: [{ begin: '0x20000000', offset: '0x0', contents: '01020304' }] } }),
    },
    {
      match: '-data-disassemble',
      respond: () => ({
        class: 'done',
        results: {
          asm_insns: [
            { address: '0x8000100', 'func-name': 'main', offset: '0', inst: 'push {r7}' },
            { address: '0x8000102', 'func-name': 'main', offset: '2', inst: 'mov r7, sp' },
          ],
        },
      }),
    },
    { match: '-interpreter-exec console', respond: () => ({ class: 'done', results: { console: 'monitor output\n' } }) },
  ];
}

class FakeGdb extends EventEmitter {
  constructor(options = {}) {
    super();
    this.options = options;
    this.calls = [];
    this.startCount = 0;
    this.closedCount = 0;
    this.status = 'closed';
    this.lastStop = null;
    this.stderrTail = [];
    this.script = options.script || defaultScript();
    this.stopOnRun = options.stopOnRun !== false;
  }

  async start() {
    this.startCount += 1;
    this.status = 'stopped';
    this.lastStop = this.options.initialStop || { reason: 'entry', threadId: 1, frame: { ...STOP_FRAME } };
  }

  async exec(command) {
    this.calls.push(command);
    if (command.startsWith('-exec-continue') || command.startsWith('-exec-next')
      || command.startsWith('-exec-step') || command.startsWith('-exec-finish') || command.startsWith('-exec-until')) {
      if (this.stopOnRun) {
        setImmediate(() => {
          this.emitStop({ reason: 'breakpoint', threadId: 1, bkptno: 1, frame: { ...STOP_FRAME } });
        });
        return { class: 'running', results: {} };
      }
      this.status = 'running';
      return { class: 'running', results: {} };
    }
    const entry = this.script.find((row) => (row.match instanceof RegExp ? row.match.test(command) : command.startsWith(row.match)));
    if (entry) return entry.respond(command, this);
    return { class: 'done', results: {} };
  }

  async execRaw(command) {
    this.calls.push(command);
  }

  async loadProgram(program) {
    this.calls.push(`loadProgram:${program}`);
  }

  async selectRemote(target) {
    this.calls.push(`selectRemote:${target}`);
  }

  async interrupt() {
    this.calls.push('-exec-interrupt --all');
    if (this.status === 'running') {
      setImmediate(() => this.emitStop({ reason: 'signal', threadId: 1, frame: { ...STOP_FRAME } }));
    }
  }

  async waitForStop() {
    return this.lastStop;
  }

  async close() {
    this.closedCount += 1;
    this.status = 'closed';
  }

  async kill() {
    this.status = 'exited';
    this.emit('exit', { code: null, signal: 'SIGKILL' });
  }

  emitStop(stop) {
    this.lastStop = stop;
    this.status = 'stopped';
    this.emit('stop', stop);
  }

  countCalls(prefix) {
    return this.calls.filter((c) => c.startsWith(prefix)).length;
  }
}

function makeProbeManager() {
  const probes = [{ key: 'stlink:ABC', kind: 'stlink', status: 'ready', servers: ['openocd'] }];
  return {
    async discoverProbes() {
      return { probes, warnings: [] };
    },
    async listBackends() {
      return [{ id: 'openocd', available: true, path: 'openocd', version: '0.12.0' }];
    },
    async plan() {
      return { probe: 'stlink:ABC', backend: 'openocd', profile: 'embedded', reasons: [], alternatives: [] };
    },
    async doctor() {
      return { probes, toolchains: [{ id: 'gdb', available: true }], backends: [], issues: [] };
    },
  };
}

function makeSymbols() {
  return {
    summary: { sources: [{ path: 'app.elf', kind: 'elf', arch: 'arm', dwarf: 5 }], warnings: [] },
    async lookup(name) {
      return { name: String(name), addr: '0x20000000' };
    },
    async sourceLines(file, line, context = 3) {
      return { from: Math.max(1, Number(line) - 1), lines: ['int main(void) {', '  loop();', '}'] };
    },
    resolvePath: (file) => file,
  };
}

const BASE_CONFIG = {
  daemon: { mode: 'auto', idle_exit_min: 0, max_sessions: 8, allow_raw: false, allow_attach: false },
  profiles: {
    native: { adapter: 'gdbmi', gdb: 'gdb', stop_at_entry: true },
    embedded: {
      adapter: 'gdbmi', gdb: 'arm-none-eabi-gdb', probe: 'auto', backend: 'openocd',
      target: 'stm32f1x', interface: 'stlink', transport: 'swd', stop_at_entry: true,
      connect: ['monitor reset halt'], after: ['monitor halt'],
    },
  },
  workspace: { source_map: [], symbol_paths: [] },
};

function makeHarness({ config = BASE_CONFIG, gdbOptions = {}, symbolLoader } = {}) {
  const gdbs = [];
  const backends = [];
  const manager = createSessionManager({
    config,
    gdbFactory: async () => {
      const gdb = new FakeGdb(gdbOptions);
      gdbs.push(gdb);
      return gdb;
    },
    backendFactory: () => {
      const backend = {
        started: false,
        stopped: false,
        async start() {
          this.started = true;
          return { gdbPort: 3333, pid: 4242, argv: ['openocd'], logTail: [] };
        },
        async stop() {
          this.stopped = true;
        },
        tail: () => [],
        status: 'ready',
      };
      backends.push(backend);
      return backend;
    },
    symbolLoader: symbolLoader || (async () => makeSymbols()),
    probeManager: makeProbeManager(),
    workspace: WORKSPACE,
    log: { debug() {}, info() {}, warn() {}, error() {} },
  });
  return { manager, gdbs, backends, ctx: { clientId: 'client-a', workspace: WORKSPACE } };
}

const openNative = { profile: 'native', program: 'D:/ws/app.elf', wait_ms: 2000, stop_at_entry: false };

// ---------------------------------------------------------------- open/state

test('open(native) returns a StopCard, symbol summary and one listed session', async () => {
  const { manager, gdbs, ctx } = makeHarness();
  const res = await manager.handlers.open(openNative, ctx);
  assert.equal(res.ok, true);
  assert.equal(res.state, 'stopped');
  assert.match(res.sid, /^s[a-z2-7]{4}$/);
  assert.equal(res.symbols.sources[0].kind, 'elf');
  assert.equal(res.stop.reason, 'entry');
  assert.equal(res.stop.loc.fn, 'main');
  assert.equal(res.stop.loc.file, 'src/main.c');
  assert.equal(res.stop.loc.line, 10);
  assert.equal(res.stop.frames, 3);
  assert.deepEqual(res.stop.locals, [{ name: 'x', value: '41' }, { name: 'y', value: '<optimized out>' }]);
  assert.equal(res.stop.src.lines.length, 3);
  assert.ok(res.stop.ev >= 1);
  assert.ok(res.stop.epoch >= 1);

  assert.equal(gdbs.length, 1);
  assert.deepEqual(gdbs[0].calls.slice(0, 1), ['loadProgram:D:/ws/app.elf']);
  const list = await manager.handlers.sessions({ action: 'list' }, ctx);
  assert.equal(list.sessions.length, 1);
  assert.equal(list.sessions[0].sid, res.sid);
  assert.equal(list.sessions[0].share, 'exclusive');
  assert.equal(list.sessions[0].workspace, WORKSPACE);
});

test('open stop_at_entry sets a temporary entry breakpoint, stops at main and deletes it', async () => {
  const { manager, gdbs, ctx } = makeHarness();
  const res = await manager.handlers.open({ ...openNative, stop_at_entry: true }, ctx);
  assert.equal(res.ok, true);
  assert.equal(res.state, 'stopped');
  assert.equal(res.stop.loc.fn, 'main');
  assert.ok(gdbs[0].calls.some((c) => c.includes('-break-insert') && c.includes('-h') && c.includes('main')), 'temporary hardware breakpoint at main');
  assert.ok(gdbs[0].calls.includes('-exec-continue'), 'continues to the entry breakpoint');
  assert.ok(gdbs[0].calls.some((c) => c.startsWith('-break-delete')), 'temporary breakpoint is deleted');
});

test('open refuses unknown profile, missing program and attach without allow_attach', async () => {
  const { manager, ctx } = makeHarness();
  const badProfile = await manager.handlers.open({ profile: 'nope', program: 'x.elf' }, ctx);
  assert.equal(badProfile.error.code, 'E_INVALID_ARG');
  assert.match(badProfile.error.hint, /known profiles/);

  const noProgram = await manager.handlers.open({ profile: 'native' }, ctx);
  assert.equal(noProgram.error.code, 'E_INVALID_ARG');

  const attach = await manager.handlers.open({ profile: 'native', pid: 1234 }, ctx);
  assert.equal(attach.error.code, 'E_ATTACH_DENIED');
});

test('open(embedded) orchestrates probe -> backend -> gdb remote -> connect commands', async () => {
  const { manager, gdbs, backends, ctx } = makeHarness();
  const res = await manager.handlers.open({ profile: 'embedded', program: 'D:/ws/fw.elf', wait_ms: 2000 }, ctx);
  assert.equal(res.ok, true);
  assert.equal(res.probe, 'stlink:ABC');
  assert.equal(res.backend, 'openocd');
  assert.equal(backends.length, 1);
  assert.equal(backends[0].started, true);
  assert.ok(gdbs[0].calls.includes('selectRemote:127.0.0.1:3333'));
  assert.ok(gdbs[0].countCalls('-interpreter-exec console') >= 2, 'connect + after commands run');
});

test('open wait_ms timeout returns state=starting with a job id', async () => {
  const slowGdbFactoryHarness = makeHarness();
  // Replace the factory with one whose start() never settles until we release it.
  const manager = createSessionManager({
    config: BASE_CONFIG,
    gdbFactory: () => {
      const gdb = new FakeGdb();
      gdb.start = () => new Promise(() => {});
      return gdb;
    },
    symbolLoader: makeSymbols(),
    workspace: WORKSPACE,
  });
  const res = await manager.handlers.open({ ...openNative, wait_ms: 50 }, { clientId: 'client-a', workspace: WORKSPACE });
  assert.equal(res.ok, true);
  assert.equal(res.state, 'starting');
  assert.equal(res.job, 'j1');
  assert.ok(slowGdbFactoryHarness.manager);
  await manager.closeAll();
});

// --------------------------------------------------------------- exclusivity

test('probeKey is exclusive: a second embedded session gets E_PROBE_BUSY', async () => {
  const { manager, ctx } = makeHarness();
  const first = await manager.handlers.open({ profile: 'embedded', program: 'D:/ws/a.elf', wait_ms: 2000 }, ctx);
  assert.equal(first.ok, true);
  const second = await manager.handlers.open({ profile: 'embedded', program: 'D:/ws/b.elf', wait_ms: 2000 }, ctx);
  assert.equal(second.ok, false);
  assert.equal(second.error.code, 'E_PROBE_BUSY');
  assert.match(second.error.message, /stlink:ABC/);
});

test('open op_id is idempotent: the same op_id never starts a second gdb', async () => {
  const { manager, gdbs, ctx } = makeHarness();
  const first = await manager.handlers.open({ ...openNative, op_id: 'op-open-1' }, ctx);
  const second = await manager.handlers.open({ ...openNative, op_id: 'op-open-1', program: 'D:/ws/other.elf' }, ctx);
  assert.equal(first.ok, true);
  assert.deepEqual(second, first);
  assert.equal(gdbs.length, 1);
});

test('exclusive sessions are invisible to other clients (E_NO_SESSION)', async () => {
  const { manager, ctx } = makeHarness();
  const res = await manager.handlers.open(openNative, ctx);
  const other = { clientId: 'client-b', workspace: WORKSPACE };
  const state = await manager.handlers.state({ sid: res.sid }, other);
  assert.equal(state.error.code, 'E_NO_SESSION');
  const list = await manager.handlers.sessions({ action: 'list' }, other);
  assert.deepEqual(list.sessions, []);
  const all = await manager.handlers.sessions({ action: 'list', all: true }, other);
  assert.equal(all.sessions.length, 1);
});

// ------------------------------------------------------------------- running

test('run(continue) blocks for the stop and returns a fresh StopCard/epoch', async () => {
  const { manager, gdbs, ctx } = makeHarness();
  const opened = await manager.handlers.open(openNative, ctx);
  const beforeEpoch = opened.stop.epoch;
  const res = await manager.handlers.run({ sid: opened.sid, action: 'continue', timeout_ms: 500 }, ctx);
  assert.equal(res.ok, true);
  assert.equal(res.state, 'stopped');
  assert.equal(res.reason, 'breakpoint');
  assert.equal(res.bp, 1);
  assert.ok(res.epoch > beforeEpoch);
  assert.ok(gdbs[0].calls.includes('-exec-continue'));
  const state = await manager.handlers.state({ sid: opened.sid }, ctx);
  assert.equal(state.state, 'stopped');
  assert.equal(state.stop.reason, 'breakpoint');
});

test('run with a stale expect_epoch is rejected with E_STALE_STATE', async () => {
  const { manager, ctx } = makeHarness();
  const opened = await manager.handlers.open(openNative, ctx);
  const res = await manager.handlers.run({ sid: opened.sid, action: 'continue', expect_epoch: 999 }, ctx);
  assert.equal(res.ok, false);
  assert.equal(res.error.code, 'E_STALE_STATE');
  assert.match(res.error.hint, /state/);
});

test('run action=pause interrupts an unstopped target via the out-of-band path', async () => {
  const { manager, gdbs, ctx } = makeHarness({ gdbOptions: { stopOnRun: false } });
  const opened = await manager.handlers.open(openNative, ctx);
  // continue never stops; run returns timed_out after interrupting.
  const res = await manager.handlers.run({ sid: opened.sid, action: 'continue', timeout_ms: 30 }, ctx);
  assert.equal(res.ok, true);
  assert.ok(gdbs[0].countCalls('-exec-interrupt') >= 1, 'timeout path interrupts the target');
  assert.ok(['stopped', 'running'].includes(res.state));

  const pause = await manager.handlers.run({ sid: opened.sid, action: 'pause', timeout_ms: 300 }, ctx);
  assert.equal(pause.ok, true);
});

test('run action=kill tears the session down', async () => {
  const { manager, gdbs, ctx } = makeHarness();
  const opened = await manager.handlers.open(openNative, ctx);
  const res = await manager.handlers.run({ sid: opened.sid, action: 'kill' }, ctx);
  assert.equal(res.ok, true);
  assert.equal(res.state, 'exited');
  assert.equal(gdbs[0].status, 'exited');
  const list = await manager.handlers.sessions({ action: 'list' }, ctx);
  assert.deepEqual(list.sessions, []);
});

// -------------------------------------------------------------------- break

test('break set/list/remove round-trips the breakpoint table', async () => {
  const { manager, ctx } = makeHarness();
  const opened = await manager.handlers.open(openNative, ctx);
  const set = await manager.handlers.break({ sid: opened.sid, action: 'set', spec: 'src/main.c:10', cond: 'x > 3' }, ctx);
  assert.equal(set.ok, true);
  assert.equal(set.breakpoints.length, 1);
  assert.equal(set.breakpoints[0].id, 1);
  assert.equal(set.breakpoints[0].enabled, true);
  assert.equal(set.breakpoints[0].cond, 'x > 3');
  assert.equal(set.breakpoints[0].owner, 'client-a');

  const list = await manager.handlers.break({ sid: opened.sid, action: 'list' }, ctx);
  assert.equal(list.breakpoints[0].hits, 2);

  const removed = await manager.handlers.break({ sid: opened.sid, action: 'remove', spec: '1' }, ctx);
  assert.deepEqual(removed.breakpoints, []);
});

test('break set requires a spec', async () => {
  const { manager, ctx } = makeHarness();
  const opened = await manager.handlers.open(openNative, ctx);
  const res = await manager.handlers.break({ sid: opened.sid, action: 'set' }, ctx);
  assert.equal(res.error.code, 'E_INVALID_ARG');
});

// ------------------------------------------------------------------ inspect

test('inspect frames paginate with next/has_more', async () => {
  const { manager, ctx } = makeHarness();
  const opened = await manager.handlers.open(openNative, ctx);
  const all = await manager.handlers.inspect({ sid: opened.sid, what: 'frames' }, ctx);
  assert.equal(all.ok, true);
  assert.equal(all.what, 'frames');
  assert.equal(all.items.length, 2);
  assert.equal(all.items[0].fn, 'main');
  assert.equal(all.items[0].file, 'src/main.c');
  assert.equal(all.has_more, false);

  const firstPage = await manager.handlers.inspect({ sid: opened.sid, what: 'frames', count: 1 }, ctx);
  assert.equal(firstPage.items.length, 1);
  assert.equal(firstPage.has_more, true);
  assert.equal(firstPage.next, 1);
});

test('inspect vars/args/registers/threads/memory/disasm/source/symbols', async () => {
  const { manager, ctx } = makeHarness();
  const opened = await manager.handlers.open(openNative, ctx);
  const sid = opened.sid;

  const vars = await manager.handlers.inspect({ sid, what: 'vars' }, ctx);
  assert.deepEqual(vars.items[0], { name: 'x', value: '41' });

  const args = await manager.handlers.inspect({ sid, what: 'args' }, ctx);
  assert.deepEqual(args.items[0], { name: 'argc', value: '1' });

  const regs = await manager.handlers.inspect({ sid, what: 'registers' }, ctx);
  assert.deepEqual(regs.items[3], { name: 'pc', value: '0x8000100' });

  const threads = await manager.handlers.inspect({ sid, what: 'threads' }, ctx);
  assert.equal(threads.items[0].id, 1);
  assert.equal(threads.items[0].state, 'stopped');

  const memory = await manager.handlers.inspect({ sid, what: 'memory', addr: '0x20000000', range: 4 }, ctx);
  assert.deepEqual(memory.items[0], { addr: '0x20000000', hex: '01020304' });

  const disasm = await manager.handlers.inspect({ sid, what: 'disasm', addr: '0x8000100' }, ctx);
  assert.equal(disasm.items[0].insn, 'push {r7}');
  assert.equal(disasm.items[0].fn, 'main');

  const source = await manager.handlers.inspect({ sid, what: 'source', path: 'D:/ws/src/main.c', range: 10 }, ctx);
  assert.equal(source.items[0].line, 9);
  assert.equal(source.items.length, 3);

  const symbols = await manager.handlers.inspect({ sid, what: 'symbols', name: 'pxCurrentTCB' }, ctx);
  assert.deepEqual(symbols.symbol, { name: 'pxCurrentTCB', addr: '0x20000000' });
});

test('inspect rejects unsupported v1 surfaces with E_SERVER_UNSUPPORTED', async () => {
  const { manager, ctx } = makeHarness();
  const opened = await manager.handlers.open(openNative, ctx);
  for (const what of ['globals', 'modules']) {
    const res = await manager.handlers.inspect({ sid: opened.sid, what }, ctx);
    assert.equal(res.ok, false, what);
    assert.equal(res.error.code, 'E_SERVER_UNSUPPORTED', what);
  }
  const unknown = await manager.handlers.inspect({ sid: opened.sid, what: 'nope' }, ctx);
  assert.equal(unknown.error.code, 'E_INVALID_ARG');
});

// --------------------------------------------------------------------- eval

test('eval batches expressions and refuses call/set', async () => {
  const { manager, ctx } = makeHarness();
  const opened = await manager.handlers.open(openNative, ctx);
  const res = await manager.handlers.eval({ sid: opened.sid, exprs: ['x', 'y'] }, ctx);
  assert.equal(res.ok, true);
  assert.deepEqual(res.results, [{ expr: 'x', value: '42' }, { expr: 'y', value: '42' }]);

  const denied = await manager.handlers.eval({ sid: opened.sid, exprs: ['call foo()'] }, ctx);
  assert.equal(denied.ok, false);
  assert.equal(denied.error.code, 'E_ATTACH_DENIED');
});

// ------------------------------------------------------------------- output

test('output serves an incremental ring with after/limit/streams/filter', async () => {
  const { manager, gdbs, ctx } = makeHarness();
  const opened = await manager.handlers.open(openNative, ctx);
  gdbs[0].emit('output', { stream: 'target', text: 'boot\nsensor ready\n' });
  gdbs[0].emit('output', { stream: 'console', text: 'console noise\n' });

  const all = await manager.handlers.output({ sid: opened.sid }, ctx);
  assert.ok(all.lines.length >= 3);
  const targetOnly = await manager.handlers.output({ sid: opened.sid, streams: 'target' }, ctx);
  assert.ok(targetOnly.lines.every((l) => l.stream === 'target'));
  assert.ok(targetOnly.lines.some((l) => l.text.includes('sensor ready')));

  const filtered = await manager.handlers.output({ sid: opened.sid, filter: 'SENSOR' }, ctx);
  assert.equal(filtered.lines.length, 1);

  const afterFirst = await manager.handlers.output({ sid: opened.sid, after: all.lines[0].seq }, ctx);
  assert.ok(afterFirst.lines.every((l) => l.seq > all.lines[0].seq));
  assert.equal(afterFirst.next, afterFirst.lines[afterFirst.lines.length - 1].seq);

  const limited = await manager.handlers.output({ sid: opened.sid, limit: 1 }, ctx);
  assert.equal(limited.lines.length, 1);
  assert.equal(limited.has_more, true);
});

test('wait returns the first matching event after a cursor', async () => {
  const { manager, ctx } = makeHarness();
  const opened = await manager.handlers.open(openNative, ctx);
  const ran = await manager.handlers.run({ sid: opened.sid, action: 'continue', timeout_ms: 500 }, ctx);
  const waited = await manager.handlers.wait({ sid: opened.sid, after: 0, events: ['stop'], timeout_ms: 500 }, ctx);
  assert.equal(waited.ok, true);
  assert.ok(waited.events.length >= 1);
  assert.equal(waited.events[0].type, 'stop');
  assert.equal(waited.stop.reason, ran.reason);

  const empty = await manager.handlers.wait({ sid: opened.sid, after: waited.ev, timeout_ms: 40 }, ctx);
  assert.equal(empty.timed_out, true);
  assert.deepEqual(empty.events, []);
});

// ------------------------------------------------------------------- lease

test('shared session lease can be taken over with force; observer is read-only', async () => {
  const { manager, ctx } = makeHarness();
  const opened = await manager.handlers.open({ ...openNative, share: 'shared' }, ctx);
  assert.equal(opened.ok, true);
  const other = { clientId: 'client-b', workspace: WORKSPACE };
  const read = await manager.handlers.state({ sid: opened.sid }, other);
  assert.equal(read.state, 'stopped', 'shared sessions are readable by other clients');

  const writeDenied = await manager.handlers.run({ sid: opened.sid, action: 'continue' }, other);
  assert.equal(writeDenied.error.code, 'E_LEASE_HELD');

  const locked = await manager.handlers.session_ctl({ sid: opened.sid, action: 'lock', force: true }, other);
  assert.equal(locked.ok, true);
  assert.equal(locked.lease.holder, 'client-b');
  const nowWritable = await manager.handlers.run({ sid: opened.sid, action: 'continue', timeout_ms: 500 }, other);
  assert.equal(nowWritable.ok, true);

  const observer = await manager.handlers.open({ profile: 'native', program: 'D:/ws/obs.elf', share: 'observer' }, ctx);
  assert.equal(observer.ok, true);
  const observerWrite = await manager.handlers.run({ sid: observer.sid, action: 'continue' }, ctx);
  assert.equal(observerWrite.error.code, 'E_INVALID_ARG');
  assert.match(observerWrite.error.message, /observer/);

  const unlocked = await manager.handlers.session_ctl({ sid: opened.sid, action: 'unlock' }, other);
  assert.equal(unlocked.lease, null);
});

// --------------------------------------------------------------------- raw

test('raw is disabled by default and allowlisted when enabled', async () => {
  const disabled = makeHarness();
  const opened = await disabled.manager.handlers.open(openNative, disabled.ctx);
  const denied = await disabled.manager.handlers.raw({ sid: opened.sid, cmd: 'info registers' }, disabled.ctx);
  assert.equal(denied.ok, false);
  assert.equal(denied.error.code, 'E_RAW_DISABLED');

  const enabled = makeHarness({ config: { ...BASE_CONFIG, daemon: { ...BASE_CONFIG.daemon, allow_raw: true } } });
  const opened2 = await enabled.manager.handlers.open(openNative, enabled.ctx);
  const allowed = await enabled.manager.handlers.raw({ sid: opened2.sid, cmd: 'info registers' }, enabled.ctx);
  assert.equal(allowed.ok, true);
  assert.match(allowed.output, /monitor output/);

  const shell = await enabled.manager.handlers.raw({ sid: opened2.sid, cmd: 'shell rm -rf /' }, enabled.ctx);
  assert.equal(shell.error.code, 'E_ATTACH_DENIED');
  const notAllowlisted = await enabled.manager.handlers.raw({ sid: opened2.sid, cmd: 'python print(1)' }, enabled.ctx);
  assert.equal(notAllowlisted.error.code, 'E_ATTACH_DENIED');
});

// -------------------------------------------------------------- close/restart

test('session_ctl close stops gdb, backend and releases the probe', async () => {
  const { manager, gdbs, backends, ctx } = makeHarness();
  const opened = await manager.handlers.open({ profile: 'embedded', program: 'D:/ws/fw.elf', wait_ms: 2000 }, ctx);
  const closed = await manager.handlers.session_ctl({ sid: opened.sid, action: 'close', kill: true }, ctx);
  assert.equal(closed.ok, true);
  assert.equal(closed.state, 'exited');
  assert.equal(gdbs[0].status, 'exited');
  assert.equal(backends[0].stopped, true);
  assert.deepEqual((await manager.handlers.sessions({ action: 'list' }, ctx)).sessions, []);

  // the probe lock is free again
  const reopened = await manager.handlers.open({ profile: 'embedded', program: 'D:/ws/fw.elf', wait_ms: 2000 }, ctx);
  assert.equal(reopened.ok, true);
});

test('run action=restart rebuilds the debugger in place', async () => {
  const { manager, gdbs, ctx } = makeHarness();
  const opened = await manager.handlers.open(openNative, ctx);
  const restarted = await manager.handlers.run({ sid: opened.sid, action: 'restart', timeout_ms: 2000 }, ctx);
  assert.equal(restarted.ok, true);
  assert.equal(restarted.sid, opened.sid);
  assert.equal(restarted.state, 'stopped');
  assert.equal(gdbs.length, 2, 'restart creates a fresh gdb');
  assert.equal(gdbs[1].startCount, 1);
});

// ------------------------------------------------------------------ discover

test('discover lists probes/profiles/backends and builds a plan', async () => {
  const { manager } = makeHarness();
  const list = await manager.handlers.discover({ action: 'list' }, { clientId: 'client-a' });
  assert.equal(list.ok, true);
  assert.equal(list.daemon.proto, 1);
  assert.equal(list.daemon.mode, 'daemon');
  assert.equal(list.probes[0].key, 'stlink:ABC');
  assert.ok(list.profiles.some((p) => p.name === 'native'));
  assert.ok(list.profiles.some((p) => p.name === 'embedded'));
  assert.equal(list.backends[0].id, 'openocd');
  assert.deepEqual(list.warnings, []);

  const plan = await manager.handlers.discover({ action: 'plan', profile: 'embedded' }, { clientId: 'client-a' });
  assert.equal(plan.plan.probe, 'stlink:ABC');
  assert.equal(plan.plan.backend, 'openocd');

  const doctor = await manager.handlers.discover({ action: 'doctor' }, { clientId: 'client-a' });
  assert.ok(Array.isArray(doctor.issues));
  assert.equal(doctor.toolchains[0].id, 'gdb');
});

test('sessions action=status returns one summary; missing sid errors when ambiguous', async () => {
  const { manager, ctx } = makeHarness();
  const a = await manager.handlers.open(openNative, ctx);
  const b = await manager.handlers.open({ profile: 'native', program: 'D:/ws/two.elf', wait_ms: 2000 }, ctx);
  const status = await manager.handlers.sessions({ action: 'status', sid: a.sid }, ctx);
  assert.equal(status.session.sid, a.sid);

  const ambiguous = await manager.handlers.state({}, ctx);
  assert.equal(ambiguous.error.code, 'E_NO_SESSION');
  assert.match(ambiguous.error.hint, new RegExp(`${a.sid}|${b.sid}`));
});

test('closeAll releases every session', async () => {
  const { manager, ctx } = makeHarness();
  await manager.handlers.open(openNative, ctx);
  await manager.handlers.open({ profile: 'native', program: 'D:/ws/two.elf', wait_ms: 2000 }, ctx);
  assert.equal(manager.sessionCount, 2);
  await manager.closeAll();
  assert.equal(manager.sessionCount, 0);
  assert.deepEqual((await manager.handlers.sessions({ action: 'list' }, ctx)).sessions, []);
});
