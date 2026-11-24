import test from 'node:test';
import assert from 'node:assert/strict';
import { listTasks, faultStatus, decodeCortexM3Context, FREERTOS_LAYOUT } from '../../src/rtos/freertos.mjs';

const BASE = 0x20000000;
const LIST = FREERTOS_LAYOUT.LIST_SIZE;
const TCB = FREERTOS_LAYOUT.TCB;

function makeIo() {
  const mem = Buffer.alloc(0x8000);
  const u32 = (addr, v) => mem.writeUInt32LE(v >>> 0, addr - BASE);
  const u16 = (addr, v) => mem.writeUInt16LE(v & 0xffff, addr - BASE);
  const bytes = (addr, buf) => buf.copy(mem, addr - BASE);
  const regs = new Map();

  function initList(addr, count = 0) {
    u32(addr, count);
    const end = addr + 8;
    u32(addr + 4, count ? 0 : end); // pxIndex
    u32(end, 0);
    u32(end + 4, end);
    u32(end + 8, end);
    return end;
  }
  function linkItem(listAddr, itemAddr, owner, itemValue = 0) {
    const end = listAddr + 8;
    u32(itemAddr, itemValue);
    u32(itemAddr + 4, end);
    u32(itemAddr + 8, end);
    u32(itemAddr + 12, owner);
    u32(itemAddr + 16, listAddr);
    u32(end + 4, itemAddr);
    u32(end + 8, itemAddr);
    u32(listAddr, u32(listAddr, 0) + 1);
  }
  function initTcb(addr, { stack, top, prio, name }) {
    u32(addr, top);
    // xStateListItem @ +4 (owner/container filled by linkItem)
    u32(addr + TCB.stateItem + 12, addr); // pvOwner
    // xEventListItem @ +24 stays zero
    u32(addr + TCB.priority, prio);
    u32(addr + TCB.stack, stack);
    const nameBuf = Buffer.alloc(12);
    nameBuf.write(name, 0, 'ascii');
    bytes(addr + TCB.name, nameBuf);
    // stack fill / used
    if (top > stack) {
      mem.fill(0xa5, stack - BASE, top - BASE);
    }
  }
  return {
    mem,
    regs,
    u32,
    initList,
    linkItem,
    initTcb,
    io: {
      async symbol(name) {
        const m = {
          pxCurrentTCB: 0x20000000,
          pxReadyTasksLists: 0x20000100,
          pxDelayedTaskList: 0x20000200,
          xSuspendedTaskList: 0x20000400,
          xPendingReadyList: 0x20000500,
          xSchedulerRunning: 0x20000600,
        };
        if (!(name in m)) throw new Error(`no symbol ${name}`);
        return m[name];
      },
      async evalInt(expr) {
        if (expr.includes('pxReadyTasksLists')) return 7;
        return 0;
      },
      async readMemory(addr, len) {
        if (addr >= 0xe000e000) {
          const b = Buffer.alloc(len);
          for (let i = 0; i < len; i += 4) {
            b.writeUInt32LE(regs.get(addr + i) || 0, i);
          }
          return b;
        }
        return Buffer.from(mem.subarray(addr - BASE, addr - BASE + len));
      },
    },
  };
}

test('listTasks walks ready lists, derives state/priority/name/stack', async () => {
  const t = makeIo();
  // vars
  t.u32(0x20000000, 0x20001100); // pxCurrentTCB -> worker
  t.u32(0x20000200, 0x20000300); // pxDelayedTaskList -> delayed list
  t.u32(0x20000600, 1);          // xSchedulerRunning

  // lists
  for (let i = 0; i < 7; i++) t.initList(0x20000100 + i * LIST);
  t.initList(0x20000300);
  t.initList(0x20000400);
  t.initList(0x20000500);

  t.initTcb(0x20001000, { stack: 0x20002000, top: 0x20002400, prio: 0, name: 'IDLE' });
  t.initTcb(0x20001100, { stack: 0x20003000, top: 0x20003200, prio: 3, name: 'worker' });

  t.linkItem(0x20000100 + 0 * LIST, 0x20001000 + TCB.stateItem, 0x20001000);
  t.linkItem(0x20000100 + 3 * LIST, 0x20001100 + TCB.stateItem, 0x20001100);

  const r = await listTasks(t.io);
  assert.equal(r.rtos.kind, 'freertos');
  assert.equal(r.rtos.current, 'worker');
  assert.equal(r.rtos.scheduler, 'running');
  assert.equal(r.count, 2);
  const byName = Object.fromEntries(r.tasks.map((x) => [x.name, x]));
  assert.equal(byName.worker.state, 'running');
  assert.equal(byName.worker.prio, 3);
  assert.equal(byName.worker.stack.headroom, 512);
  assert.equal(byName.worker.stack.peak_free, 512);
  assert.equal(byName.IDLE.state, 'ready');
  assert.equal(byName.IDLE.prio, 0);
  assert.equal(byName.IDLE.stack.headroom, 1024);
});

test('listTasks reports blocked task on delayed list with wake tick', async () => {
  const t = makeIo();
  t.u32(0x20000000, 0x20001000);
  t.u32(0x20000200, 0x20000300);
  for (let i = 0; i < 7; i++) t.initList(0x20000100 + i * LIST);
  t.initList(0x20000300);
  t.initList(0x20000400);
  t.initList(0x20000500);
  t.initTcb(0x20001000, { stack: 0x20002000, top: 0x20002400, prio: 2, name: 'blocked' });
  t.linkItem(0x20000300, 0x20001000 + TCB.stateItem, 0x20001000, 1234);

  const r = await listTasks(t.io);
  assert.equal(r.tasks[0].state, 'blocked');
  assert.equal(r.tasks[0].wake_tick, 1234);
});

test('faultStatus decodes CFSR/HFSR bits', async () => {
  const t = makeIo();
  t.regs.set(0xe000ed28, 0x00008200); // PRECISERR | STKOF? bit 13 is LSPERR; 0x2000 = STKERR? check decode
  t.regs.set(0xe000ed2c, 0x40000000); // FORCED
  const f = await faultStatus(t.io);
  assert.equal(f.hfsr.bits.includes('FORCED'), true);
  assert.ok(f.cfsr.raw.startsWith('0x'));
});

test('decodeCortexM3Context decodes saved r4-r11 + exception frame', () => {
  const buf = Buffer.alloc(64);
  for (let i = 0; i < 16; i++) buf.writeUInt32LE(0x100 + i, i * 4);
  const c = decodeCortexM3Context(buf);
  assert.equal(c.r4, 0x100);
  assert.equal(c.r11, 0x107);
  assert.equal(c.r0, 0x108);
  assert.equal(c.lr, 0x10d);
  assert.equal(c.pc, 0x10e);
  assert.equal(c.xpsr, 0x10f);
  assert.throws(() => decodeCortexM3Context(Buffer.alloc(32)), /short task context/);
});
