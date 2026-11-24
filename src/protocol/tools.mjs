/**
 * The 12 dbghub MCP tools (docs/contract-v1.md §1). Schemas are part of the frozen
 * v1 contract: names/fields only grow. Descriptions are agent-facing usage discipline
 * (DSH does not surface MCP `instructions`, see design.md §8).
 */

const str = () => ({ type: 'string' });
const bool = () => ({ type: 'boolean' });
const num = () => ({ type: 'number' });
const int = () => ({ type: 'integer' });
const arr = (items) => ({ type: 'array', items });

function tool(name, description, properties, required = [], annotations = {}) {
  return {
    name,
    description,
    inputSchema: { type: 'object', properties, required },
    annotations,
  };
}

const READ_ONLY = { readOnlyHint: true };
const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true };

export const TOOLS = [
  tool(
    'discover',
    '诊断探针/后端/工具链/已在运行的调试目标并给出 open 计划（只读）。targets[] 会列出监听中的 GDB stub/monitor（try profile=renode 或 target=<endpoint>）；probes=[] 不报错。',
    {
      action: { type: 'string', enum: ['list', 'scan', 'doctor', 'plan'], default: 'list' },
      probe: str(),
      profile: str(),
      backend: str(),
    },
    [],
    READ_ONLY,
  ),
  tool(
    'sessions',
    '列出或查询调试会话（只读）。sid 省略时仅在“唯一可见会话”时推断；多会话并存时必须显式传 sid。',
    {
      action: { type: 'string', enum: ['list', 'status'], default: 'list' },
      sid: str(),
      all: { type: 'boolean', default: false },
    },
    [],
    READ_ONLY,
  ),
  tool(
    'session_ctl',
    '关闭/加锁/解锁会话（破坏性）。close 默认优雅退出；kill=true 才杀目标。force=true 立即抢锁，可能打断烧录。',
    {
      action: { type: 'string', enum: ['close', 'lock', 'unlock'] },
      sid: str(),
      kill: bool(),
      force: bool(),
    },
    ['action'],
    DESTRUCTIVE,
  ),
  tool(
    'open',
    '打开调试会话：按 profile 起后端+gdb、加载程序/符号、连接并返回 StopCard。mode="launch"（默认）按 profile 连接/复位、可 flash；mode="attach" 不复位、不写目标，只 halt + 加载符号（适合附加到正在运行的固件），两者互斥。符号只传路径；返回 target{mode,attached,reset,endpoint,flashed} 与 program.used_for。长任务超时返回 state=starting + job。',
    {
      profile: str(),
      program: { type: 'string', description: '可执行/ELF 路径；attach 时仅用于加载符号' },
      entry: { type: 'string', description: 'stop_at_entry=true 时的入口符号，默认 main（可用 profile.entry 覆盖）' },
      symbols: { type: 'array', items: str(), description: '额外符号源（map/axf/sep-debug），只传路径' },
      images: arr({ type: 'object', properties: { file: str(), base: str() }, required: ['file'] }),
      symbol_paths: arr(str()),
      source_map: arr(arr(str())),
      pid: { type: ['integer', 'null'], description: '本地进程 attach（需 daemon.allow_attach）' },
      target: { type: ['string', 'null'], description: '远程 GDB endpoint，如 127.0.0.1:3333' },
      core: { type: ['string', 'null'], description: 'core dump 路径' },
      cwd: { type: ['string', 'null'], description: '相对 program/symbols 的基准目录' },
      args: arr(str()),
      mode: { type: 'string', enum: ['launch', 'attach'], description: 'launch=复位/可选烧录（默认）；attach=不复位、不烧录，只 halt + 加载符号' },
      stop_at_entry: bool(),
      share: { type: 'string', enum: ['exclusive', 'shared', 'observer'] },
      reuse: bool(),
      actor: { type: ['string', 'null'] },
      op_id: { type: ['string', 'null'] },
      wait_ms: num(),
      flash: { type: 'boolean', description: 'launch 时是否烧录；attach 模式禁止 flash=true' },
    },
    [],
    DESTRUCTIVE,
  ),
  tool(
    'run',
    '继续/单步/暂停/重启/杀/断开，默认阻塞等到停止并返回 StopCard。restart 默认沿用 open 的 mode（launch 复位 / attach 不复位），可传 mode 覆盖；timeout_ms 内未停返回 state=running,timed_out=true；pause 停不下来时返回 E_TARGET_UNRESPONSIVE，可用 restart/close 恢复。',
    {
      sid: str(),
      action: {
        type: 'string',
        enum: ['continue', 'step_over', 'step_in', 'step_out', 'pause', 'restart', 'kill', 'detach'],
      },
      thread: { type: ['integer', 'null'], description: '先选中的 GDB 线程/RTOS 任务 id（step 用）' },
      mode: { type: 'string', enum: ['launch', 'attach'], description: '仅 restart：覆盖沿用 open 的模式；launch=复位重启，attach=不复位重连' },
      timeout_ms: num(),
      until: { type: ['string', 'null'], description: 'continue 时的临时断点位置，如 "main"' },
      expect_epoch: { type: ['integer', 'null'], description: '期望的 epoch；过期返回 E_STALE_STATE' },
      op_id: { type: ['string', 'null'], description: '幂等键' },
    },
    ['action'],
    DESTRUCTIVE,
  ),
  tool(
    'wait',
    '自 after 事件游标起等待停止/输出/退出事件（长轮询，替代轮询）。返回 events 与 stop。',
    {
      sid: str(),
      after: int(),
      timeout_ms: num(),
      events: arr({ type: 'string', enum: ['stop', 'output', 'exited', 'error', 'progress', 'thread'] }),
    },
    [],
    READ_ONLY,
  ),
  tool(
    'state',
    '查询当前状态与 StopCard（不改变状态）。running 时只回 state+ev（省 token）；detail 越大带越多上下文。',
    {
      sid: str(),
      detail: int(),
      thread: { type: ['integer', 'null'] },
    },
    [],
    READ_ONLY,
  ),
  tool(
    'break',
    '断点/观察点管理。行断点推荐 file+line（或 spec="src/main.c:42"）；函数入口 function="app_main"（或 spec="app_main"）；地址 spec="*0x08000000"；观察点 kind="watch"、spec="counter"。set 返回 created[] 和解析后的 file/line/func/addr/pending，可用 list 核对。',
    {
      sid: { type: 'string', description: '会话 id；仅一个会话时可省略' },
      action: { type: 'string', enum: ['set', 'remove', 'list', 'enable', 'disable'], description: 'set 新增；list 查看全部及 id；remove/enable/disable 用 id' },
      spec: { type: 'string', description: '位置速记：file:line | 函数名 | *0xADDR；与 file+line 二选一' },
      file: { type: 'string', description: '源文件路径或文件名；配合 line 使用（推荐）' },
      line: { type: 'integer', description: '行号；只给 line 时使用当前停点所在文件' },
      function: { type: 'string', description: '函数名入口断点（等价于 spec=函数名）' },
      cond: { type: ['string', 'null'], description: '条件表达式，例如 i==5；仅命中条件时停下' },
      hit: { type: ['integer', 'null'], description: '忽略前 N 次命中（hit count）' },
      kind: { type: 'string', enum: ['sw', 'hw', 'watch'], description: 'sw=软件断点（默认）；hw=硬件断点；watch=观察点（spec 为表达式）' },
      temp: { type: 'boolean', description: '临时断点：命中一次自动删除' },
      log: { type: ['string', 'null'], description: 'logpoint 输出表达式（不暂停；部分后端不支持）' },
      op_id: { type: ['string', 'null'], description: '幂等键：超时重试时传同一个值，避免重复下断点' },
    },
    ['action'],
  ),
  tool(
    'inspect',
    '分页读取栈/变量/参数/寄存器/线程/内存/反汇编/源码/符号（只读）。RTOS：what="rtos" kind="tasks" 看任务列表（含 GDB thread 映射）；kind="stacks" + task="wind_spd" 看单个任务的调用栈（优先 GDB RTOS 线程，否则 TCB 解帧兜底）。what="fault" 看 Cortex-M 故障寄存器。',
    {
      sid: { type: 'string', description: '会话 id；仅一个会话时可省略' },
      what: {
        type: 'string',
        enum: [
          'frames', 'vars', 'args', 'globals', 'registers', 'threads', 'modules',
          'memory', 'disasm', 'source', 'symbols', 'rtos', 'fault',
        ],
        description: 'frames 栈；vars/args 变量；registers 寄存器；threads GDB 线程；memory/disasm/source；symbols 符号；rtos 任务/任务栈；fault 故障寄存器',
      },
      view: { type: 'string', enum: ['gdb', 'rtos'], description: 'threads 视图；rtos 视图含任务名' },
      kind: { type: 'string', enum: ['tasks', 'stacks', 'queues', 'mutexes', 'timers', 'heap', 'health'], description: 'rtos 子类型：tasks 任务列表；stacks 单任务调用栈' },
      frame: { type: ['integer', 'null'], description: '帧号（vars/args 用）' },
      thread: { type: ['integer', 'null'], description: 'GDB 线程 id（frames 可指定；rtos tasks 返回的 thread 字段）' },
      task: { type: ['string', 'null'], description: '任务名或 TCB id（kind=stacks 必填，如 "wind_spd"）' },
      path: { type: ['string', 'null'], description: 'source 的文件路径' },
      name: { type: ['string', 'null'], description: 'symbols 查询名；rtos stacks 也可用 name 代替 task' },
      addr: { type: ['string', 'null'], description: 'memory/disasm/symbols 的地址' },
      range: { type: ['string', 'null'], description: 'disasm 地址范围，如 "0x08000000-0x08000040"' },
      count: { type: ['integer', 'null'], description: '返回条数（分页）' },
      cursor: { type: ['integer', 'null'], description: '分页游标' },
    },
    ['what'],
    READ_ONLY,
  ),
  tool(
    'eval',
    '批量求值表达式（exprs 可为数组），默认禁止 call/set 等写目标语义。',
    {
      sid: str(),
      exprs: { type: 'array', items: str(), description: '要批量求值的表达式列表，例如 ["counter","p.x"]' },
      frame: { type: ['integer', 'null'] },
      thread: { type: ['integer', 'null'] },
      fmt: { type: ['string', 'null'] },
    },
    ['exprs'],
  ),
  tool(
    'output',
    '按 seq 增量读取目标/console/log 输出（after 游标不重复消费）。',
    {
      sid: str(),
      after: int(),
      limit: int(),
      streams: { type: 'string', enum: ['target', 'console', 'log', 'all'] },
      filter: { type: ['string', 'null'] },
    },
    [],
    READ_ONLY,
  ),
  tool(
    'raw',
    '透传 GDB 控制台命令（默认关闭；启用后仅 allowlist；拒绝 shell/source/define 等）。',
    {
      sid: str(),
      cmd: str(),
      op_id: { type: ['string', 'null'] },
    },
    ['cmd'],
    DESTRUCTIVE,
  ),
];

export const TOOL_NAMES = TOOLS.map((t) => t.name);

export function getTool(name) {
  return TOOLS.find((t) => t.name === name) || null;
}
