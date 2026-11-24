/**
 * FreeRTOS state walker for dbghub.
 *
 * Works purely through GDB/MI-backed IO (no gdb Python):
 *   io.symbol(name) -> number            address of a symbol
 *   io.evalInt(expr) -> number            evaluate an integer expression
 *   io.readMemory(addr, len) -> Buffer    read target memory
 *
 * FreeRTOS layout (v10/v11, Cortex-M, 32-bit):
 *   List_t:        uxNumberOfItems(0), pxIndex(4), xListEnd(8)  // 20 bytes
 *   ListItem_t:    xItemValue(0), pxNext(4), pxPrevious(8), pvOwner(12), pvContainer(16)
 *   TCB_t:         pxTopOfStack(0), xStateListItem(4), xEventListItem(24),
 *                  uxPriority(44), pxStack(48), pcTaskName(52[12])  // sizeof 84
 *
 * The task list is derived from the ready/delayed/suspended/pending lists; a task's
 * current state is which list its xStateListItem.pvContainer points at.
 */

const LIST_SIZE = 20;
const LIST_END_OFF = 8;
const ITEM_SIZE = 20;
const TCB_SIZE = 84;
const TCB = { topOfStack: 0, stateItem: 4, eventItem: 24, priority: 44, stack: 48, name: 52 };
const TASK_NAME_LEN = 12;
const STACK_FILL_BYTE = 0xa5;
const MAX_WALK = 512;

export class RtosError extends Error {
  constructor(code, message, hint = '') {
    super(message);
    this.code = code;
    this.hint = hint;
  }
}

function u32(buf, off) {
  return buf.readUInt32LE(off);
}

function hex(n) {
  return '0x' + (n >>> 0).toString(16).padStart(8, '0');
}

async function readU32(io, addr) {
  const b = await io.readMemory(addr, 4);
  if (!b || b.length < 4) throw new RtosError('E_RTOS_WALK', `short memory read at ${hex(addr)}`);
  return u32(b, 0);
}

async function readListHead(io, listAddr) {
  const b = await io.readMemory(listAddr, LIST_SIZE);
  if (!b || b.length < LIST_SIZE) throw new RtosError('E_RTOS_WALK', `short list read at ${hex(listAddr)}`);
  return { addr: listAddr, count: u32(b, 0), end: listAddr + LIST_END_OFF };
}

async function readTcb(io, addr) {
  const b = await io.readMemory(addr, TCB_SIZE);
  if (!b || b.length < TCB_SIZE) throw new RtosError('E_RTOS_WALK', `short TCB read at ${hex(addr)}`);
  const nameBuf = b.subarray(TCB.name, TCB.name + TASK_NAME_LEN);
  let name = '';
  for (const c of nameBuf) {
    if (c === 0) break;
    name += c >= 32 && c < 127 ? String.fromCharCode(c) : '?';
  }
  return {
    addr,
    topOfStack: u32(b, TCB.topOfStack),
    stateItem: u32(b, TCB.stateItem + 16), // pvContainer of xStateListItem (TCB+4+16=TCB+20)
    eventItem: u32(b, TCB.eventItem + 16), // pvContainer of xEventListItem (TCB+24+16=TCB+40)
    priority: u32(b, TCB.priority),
    stack: u32(b, TCB.stack),
    name: name || `task@${hex(addr)}`,
  };
}

/** Walk one circular list and yield pvOwner TCB addresses (plus item tick value). */
async function walkList(io, listAddr, limit = MAX_WALK) {
  const head = await readListHead(io, listAddr);
  const out = [];
  if (head.count === 0) return out;
  const end = head.end;
  let cursor = await readU32(io, end + 4); // xListEnd.pxNext
  let guard = 0;
  while (cursor && cursor !== end && guard++ < limit) {
    const b = await io.readMemory(cursor, ITEM_SIZE);
    if (!b || b.length < ITEM_SIZE) throw new RtosError('E_RTOS_WALK', `short list item read at ${hex(cursor)}`);
    const itemValue = u32(b, 0);
    const next = u32(b, 4);
    const owner = u32(b, 12);
    const container = u32(b, 16);
    if (owner) out.push({ owner, itemValue, container, itemAddr: cursor });
    if (next === cursor) break;
    cursor = next;
  }
  return out;
}

/**
 * Collect FreeRTOS tasks.
 * @returns {Promise<{rtos:object, tasks:Array, warnings:string[]}>}
 */
export async function listTasks(io, { cap = 20, includeSp = false } = {}) {
  const warnings = [];
  let sym;
  try {
    sym = {
      current: await io.symbol('pxCurrentTCB'),
      ready: await io.symbol('pxReadyTasksLists'),
      suspended: await io.symbol('xSuspendedTaskList'),
      pending: await io.symbol('xPendingReadyList'),
      delayedPtr: await io.symbol('pxDelayedTaskList'),
    };
  } catch (e) {
    throw new RtosError('E_RTOS_NOT_FOUND', 'FreeRTOS symbols not found (pxCurrentTCB/pxReadyTasksLists)', 'build with debug info or pass rtos.kind=none');
  }

  let priorities = 0;
  try {
    priorities = await io.evalInt('(int)(sizeof(pxReadyTasksLists)/sizeof(pxReadyTasksLists[0]))');
  } catch {
    priorities = 7;
    warnings.push('configMAX_PRIORITIES expression failed; assuming 7');
  }
  const delayedAddr = await readU32(io, sym.delayedPtr);
  const currentTcb = await readU32(io, sym.current);
  const schedulerRunning = await readU32(io, await io.symbol('xSchedulerRunning').catch(() => 0));

  const lists = [];
  for (let i = 0; i < priorities; i++) {
    lists.push({ kind: 'ready', prio: i, addr: sym.ready + i * LIST_SIZE });
  }
  lists.push({ kind: 'blocked', prio: null, addr: delayedAddr });
  lists.push({ kind: 'suspended', prio: null, addr: sym.suspended });
  lists.push({ kind: 'pending', prio: null, addr: sym.pending });

  const byOwner = new Map();
  for (const list of lists) {
    let entries;
    try {
      entries = await walkList(io, list.addr);
    } catch (e) {
      warnings.push(`list ${list.kind}@${hex(list.addr)}: ${e.message}`);
      continue;
    }
    for (const ent of entries) {
      const prev = byOwner.get(ent.owner) || {};
      byOwner.set(ent.owner, { ...prev, owner: ent.owner, itemValue: ent.itemValue, list });
    }
  }

  const tasks = [];
  for (const [owner, meta] of byOwner) {
    let tcb;
    try {
      tcb = await readTcb(io, owner);
    } catch (e) {
      warnings.push(e.message);
      continue;
    }
    const listMeta = meta.list;
    let state;
    let prio = tcb.priority;
    if (listMeta.kind === 'ready') { state = 'ready'; prio = listMeta.prio; }
    else if (listMeta.kind === 'blocked') state = 'blocked';
    else if (listMeta.kind === 'suspended') state = 'suspended';
    else state = 'ready';
    if (owner === currentTcb && (state === 'ready')) state = 'running';
    const stack = await stackInfo(io, tcb);
    tasks.push({
      id: hex(owner),
      name: tcb.name,
      state,
      prio,
      ...(includeSp ? { sp: hex(tcb.topOfStack) } : {}),
      stack,
      blocked_on: tcb.eventItem ? hex(tcb.eventItem) : undefined,
      wake_tick: listMeta.kind === 'blocked' ? meta.itemValue : undefined,
      current: owner === currentTcb,
    });
  }

  tasks.sort((a, b) => Number(b.current) - Number(a.current) || b.prio - a.prio || a.name.localeCompare(b.name));
  const current = tasks.find((t) => t.current);
  return {
    rtos: {
      kind: 'freertos',
      cores: 1,
      scheduler: schedulerRunning ? 'running' : 'stopped',
      current: current ? current.name : null,
    },
    tasks: tasks.slice(0, cap),
    count: tasks.length,
    has_more: tasks.length > cap,
    warnings,
  };
}

/**
 * Decode the FreeRTOS Cortex-M3 software-saved context at `pxTopOfStack`.
 * Layout (low -> high): r4..r11, r0..r3, r12, lr, pc, xpsr.
 * Only valid for Cortex-M3 (no FPU extended frame); callers must mark confidence.
 */
export function decodeCortexM3Context(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 64) {
    throw new RtosError('E_RTOS_WALK', 'short task context (need 64 bytes)', 'the target may use an FPU-extended frame (Cortex-M4F), which this fallback does not decode');
  }
  const w = (i) => buf.readUInt32LE(i * 4);
  return {
    r4: w(0), r5: w(1), r6: w(2), r7: w(3), r8: w(4), r9: w(5), r10: w(6), r11: w(7),
    r0: w(8), r1: w(9), r2: w(10), r3: w(11), r12: w(12), lr: w(13), pc: w(14), xpsr: w(15),
    spAfterRestore: 0, // filled by caller: top + 32
  };
}

async function stackInfo(io, tcb) {
  const headroom = (tcb.topOfStack - tcb.stack) | 0;
  let peakFree = null;
  try {
    const scanLen = Math.max(0, Math.min(2048, headroom));
    if (scanLen > 0) {
      const b = await io.readMemory(tcb.stack, scanLen);
      let n = 0;
      while (n < b.length && b[n] === STACK_FILL_BYTE) n++;
      peakFree = n;
    }
  } catch {
    peakFree = null;
  }
  return {
    base: hex(tcb.stack),
    top: hex(tcb.topOfStack),
    headroom,
    peak_free: peakFree,
    fill: peakFree == null ? 'unknown' : STACK_FILL_BYTE === 0xa5 ? 'a5' : 'unknown',
    overflow: headroom < 0,
  };
}

/** Decode Cortex-M fault status registers; returns a compact card. */
export async function faultStatus(io) {
  const regs = [
    ['cfsr', 0xe000ed28, CFSR_BITS],
    ['hfsr', 0xe000ed2c, HFSR_BITS],
    ['dfsr', 0xe000ed30, DFSR_BITS],
    ['mmfar', 0xe000ed34, null],
    ['bfar', 0xe000ed38, null],
    ['shcsr', 0xe000ed24, SHCSR_BITS],
  ];
  const out = {};
  for (const [name, addr, bits] of regs) {
    try {
      const b = await io.readMemory(addr, 4);
      const v = b.readUInt32LE(0);
      out[name] = bits ? { raw: hex(v), bits: decodeBits(v, bits) } : hex(v);
    } catch {
      /* ignore unreadable register */
    }
  }
  return out;
}

function decodeBits(value, table) {
  const out = [];
  for (const [bit, name] of table) if (value & (1 << bit)) out.push(name);
  return out;
}

const CFSR_BITS = [
  [0, 'IACCVIOL'], [1, 'DACCVIOL'], [3, 'MUNSTKERR'], [4, 'MSTKERR'], [5, 'MLSPERR'],
  [7, 'MMARVALID'], [8, 'IBUSERR'], [9, 'PRECISERR'], [10, 'IMPRECISERR'], [11, 'UNSTKERR'],
  [12, 'STKERR'], [13, 'LSPERR'], [15, 'BFARVALID'], [16, 'UNDEFINSTR'], [17, 'INVSTATE'],
  [18, 'INVPC'], [19, 'NOCP'], [24, 'UNALIGNED'], [25, 'DIVBYZERO'],
];
const HFSR_BITS = [[1, 'VECTTBL'], [30, 'FORCED'], [31, 'DEBUGEVT']];
const DFSR_BITS = [[1, 'HALTED'], [2, 'BKPT'], [3, 'DWTTRAP'], [4, 'VCATCH'], [5, 'EXTERNAL']];
const SHCSR_BITS = [[16, 'MEMFAULTACT'], [17, 'BUSFAULTACT'], [18, 'USGFAULTACT'], [24, 'SVCALLACT'], [27, 'USGFAULTENA'], [28, 'BUSFAULTENA'], [29, 'MEMFAULTENA']];

export const FREERTOS_LAYOUT = { LIST_SIZE, ITEM_SIZE, TCB_SIZE, TCB, TASK_NAME_LEN };
