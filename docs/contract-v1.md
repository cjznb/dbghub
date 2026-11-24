# dbghub v1 契约（实现冻结版）

> 本文件是实现与测试的唯一契约。工具名、字段名、错误码在 v1 内只增不改；改契约必须同步 `docs/design.md` 与测试。
> 所有工具返回 `{ok:true, ...}` 或 `{ok:false, error:{code,message,hint?}}`；**不抛异常给 MCP**。

## 1. 工具（12 个）

### 1.1 `discover`
```json
{ "action": "list|scan|doctor|plan", "probe": "可选", "profile": "可选", "backend": "可选" }
```
返回：
```json
{ "ok": true,
  "daemon": { "version": "0.1.0", "proto": 1, "pid": 1234, "mode": "daemon|inline", "socket": "..." },
  "probes": [ { "key": "stlink:37FF...", "kind": "stlink", "serial": "...", "firmware": "V2J37S7",
                "vid": 1155, "pid": 14152, "model": "ST-LINK/V2", "transport": "swd",
                "status": "ready|busy|permission|firmware|unknown", "servers": ["openocd"],
                "capabilities": { "swo": false, "rtt": false, "connectUnderReset": true, "multicore": false, "rtos": true } } ],
  "profiles": [ { "name": "stm32f103-openocd", "adapter": "gdbmi", "gdb": "arm-none-eabi-gdb", "target": "stm32f1x", "probe": "auto", "backend": "auto" } ],
  "backends": [ { "id": "openocd", "available": true, "path": "...", "version": "0.12.0" } ],
  "toolchains": [ { "id": "arm-none-eabi-gdb", "available": true, "path": "...", "version": "15.2" } ],
  "targets": [ { "endpoint": "127.0.0.1:3333", "host": "127.0.0.1", "port": 3333,
                 "process": "renode.exe", "pid": 12124, "role": "gdb|monitor|telnet|swo|unknown",
                 "confidence": "process|port|declared", "source": "process|profile", "profile": "renode?" } ],
  "plan": { "probe": "stlink:...", "backend": "openocd", "profile": "stm32f103-openocd", "reasons": ["..."], "alternatives": [...] },
  "warnings": [ "..." ] }
```
- `plan` 仅在 `action=plan` 时返回；`doctor` 额外返回 `issues:[{level,code,message,hint}]`。
- 没有探针时 `probes:[]`，不报错。

### 1.2 `sessions`
```json
{ "action": "list|status", "sid": "可选", "all": false }
```
返回 `{ok:true, sessions:[SessionSummary]}`（status 时 `session:SessionSummary`）。
`SessionSummary = { sid, profile, probe, backend, state, owner:{clientId,actor?,label?}, share, lease:{holder,expiresAt}|null, workspace, ev, epoch, rtos?, lastError? }`

### 1.3 `session_ctl`
```json
{ "action": "close|lock|unlock", "sid": "s3f9a", "kill": false, "force": false }
```
返回 `{ok:true, sid, action, state?, lease?}`。

### 1.4 `open`
```json
{ "profile": "stm32f103-openocd", "program": "path/to/app.elf",
  "symbols": ["app.map"], "images": [{"file":"boot.elf","base":"0x08000000"}],
  "symbol_paths": ["build/debug"], "source_map": [["old","new"]],
  "pid": null, "target": null, "core": null,
  "cwd": null, "args": [], "stop_at_entry": true, "entry": "main",
  "mode": "launch|attach",
  "share": "exclusive", "reuse": false, "actor": null, "op_id": null,
  "wait_ms": 20000, "flash": true }
```
返回：
- 成功到停：`{ok:true, sid, state:"stopped", stop:StopCard, symbols:SymbolSummary, probe, backend}`
- 启动中（超时）：`{ok:true, sid, state:"starting", job:"j1", progress:"...", symbols?}`
- 失败：`{ok:false,error:{...}}`

`StopCard = { sid, state:"stopped", reason:"breakpoint|step|signal|entry|pause|watchpoint|exited|error",
  bp?:number, signal?:string, epoch, thread:number, frame:number,
  loc:{fn,file?,line?,pc}, src?:{from,lines:[string]}, frames:number,
  locals?:{name:string,value:string}[], task?:{name,state,prio,stack},
  out?:string[], ev:number }`

`SymbolSummary = { sources:[{path,kind:"elf|axf|map|debug|hex|bin",arch?,dwarf?,syms?,src?:bool,addr_match?:bool}], warnings:string[] }`

附加字段（v1 增量）：
- `target: { mode:"local|remote|embedded", attached:boolean, reset:boolean, endpoint:string|null, flashed:boolean }`
- `program: { path, used_for:"symbols|flash+symbols" }`（远程/attach 目标未 flash 时仅用于符号）
- `notes?: string[]`（例如“attached without reset”“remote target memory was not modified”“无法校验 ELF 是否匹配目标已加载镜像”）
- `mode:"attach"` 时不执行 reset、不 flash；使用 `profile.attach_connect`（缺省 `[]` + OpenOCD telnet halt），`flash:true` 会报 `E_INVALID_ARG`。
- `stop_at_entry:true`（默认）会设置入口**临时断点**（`entry` 默认 `main`；优先 `-break-insert -t -h` 硬件断点，回退软件断点）；命中或 10s 超时后删除断点；超时会 halt 当前 PC 并给 warning。

### 1.5 `run`
```json
{ "sid": "可选", "action": "continue|step_over|step_in|step_out|pause|restart|kill|detach",
  "thread": null, "timeout_ms": 20000, "until": null, "expect_epoch": null, "op_id": null,
  "mode": "launch|attach（仅 restart；覆盖 open 模式）" }
```
返回：StopCard / `{ok:true,sid,state:"running",timed_out:true,ev}` / `{ok:true,sid,state:"exited",...}`。
- `pause` 走带外通道（不等命令队列），仍返回 StopCard 或 running；若 halt/interrupt 后无 stop 事件返回 `E_TARGET_UNRESPONSIVE`。
- `restart` 返回 `{restarted:true,mode:"launch|attach",reset:boolean,attached?:true,...}`；默认沿用 open 的 mode，可用 `mode` 覆盖（launch 复位，attach 不复位）。

### 1.6 `wait`
```json
{ "sid": "可选", "after": 0, "timeout_ms": 10000, "events": ["stop","output","exited"] }
```
返回 `{ok:true, sid, state, ev, events:[{ev,type,...}], stop?:StopCard, timed_out?:true}`。

### 1.7 `state`
```json
{ "sid": "可选", "detail": 1, "thread": null }
```
返回 `{ok:true, sid, state, ev, stop?:StopCard}`；running 时 `{ok:true,sid,state:"running",ev}`。

### 1.8 `break`
```json
{ "sid": "可选", "action": "set|remove|list|enable|disable",
  "spec": "src/main.c:42 | func | *0x08000000",
  "file": "src/main.c", "line": 42, "function": "app_main",
  "cond": null, "hit": null,
  "kind": "sw|hw|watch", "temp": false, "log": null, "op_id": null }
```
- `set` 位置四选一：`file`+`line`（推荐，行断点）、只给 `line`（当前停点文件）、`function`、`spec`（`file:line`/函数/`*addr`）。`spec` 优先级最高。
- `remove/enable/disable` 用 `spec=<id>`；`list` 返回全量。
返回 `{ok:true, sid, created:[id...], breakpoints:[{id,spec,enabled,file?,line?,func?,addr?,pending?,hits?,cond?,owner?}]}`。
行断点示例：`{"sid":"...","action":"set","file":"Core/Src/main.c","line":42}`。

### 1.9 `inspect`
```json
{ "sid": "可选",
  "what": "frames|vars|args|globals|registers|threads|modules|memory|disasm|source|symbols|rtos|fault",
  "view": "gdb|rtos", "kind": "tasks|stacks|queues|mutexes|timers|heap|health",
  "frame": null, "thread": null, "task": null, "path": null, "name": null, "addr": null,
  "range": null, "count": null, "cursor": null }
```
返回分页：`{ok:true, sid, what, items:[...], next?, has_more?}`；`symbols` 为单条查询结果。
- frames item: `{i,fn,file?,line?,pc,args?}`；`thread` 可指定 GDB 线程 id。
- vars item: `{name,value,type?,optimized_out?}`
- registers item: `{name,value}`
- threads item: `{id,name?,state?,frame?}`
- memory: `{addr,hex,ascii?}`
- disasm item: `{addr,insn,fn?,src?}`
- rtos `kind=tasks`：`{ok,sid,what:"rtos",kind:"tasks",rtos:{kind,cores,scheduler,current},summary,tasks:[{id,name,state,prio,sp,stack,blocked_on?,wake_tick?,current?,thread?}],count,has_more,warnings?}`；`thread` 为 OpenOCD/J-Link RTOS 线程 id（无插件时省略）。
- rtos `kind=stacks`：`{ok,sid,what:"rtos",kind:"stacks",task:{name,state,prio,thread},frames:[{i,fn,file?,line?,pc}],source:"gdb-thread|current-task|tcb-unwind",confidence:"high|medium"}`；`task` 必填（任务名或 TCB id）。
- rtos `kind=fault` 用 `what:"fault"`：`{fault:{cfsr,hfsr,dfsr,mmfar,bfar,shcsr}}`。

### 1.10 `eval`
```json
{ "sid": "可选", "exprs": "x" | ["x","y"], "frame": null, "thread": null, "fmt": null }
```
返回 `{ok:true, sid, results:[{expr,value,type?}]}`。

### 1.11 `output`
```json
{ "sid": "可选", "after": 0, "limit": 100, "streams": "target|console|log|all", "filter": null }
```
返回 `{ok:true, sid, lines:[{seq,stream,text}], next, has_more}`。

### 1.12 `raw`
```json
{ "sid": "可选", "cmd": "info registers", "op_id": null }
```
默认关闭：`E_RAW_DISABLED`；启用时仅允许 allowlist，返回 `{ok:true, output, truncated?}`。

## 2. 错误码

`E_NO_SESSION`, `E_SESSION_BUSY`, `E_LEASE_HELD`, `E_RESOURCE_BUSY`, `E_PROBE_BUSY`, `E_STALE_STATE`,
`E_TOOLCHAIN_MISSING`, `E_SERVER_START`, `E_DAEMON_STARTING`, `E_TIMEOUT`, `E_NOT_STOPPED`,
`E_INVALID_ARG`, `E_RAW_DISABLED`, `E_ATTACH_DENIED`, `E_DAEMON_DOWN`,
`E_SYMBOL_NOT_FOUND`, `E_SYMBOL_ARCH`, `E_SYMBOL_NO_DEBUG`, `E_SYMBOL_MISMATCH`, `E_MAP_PARSE`, `E_SYMBOL_PARSE`,
`E_PROBE_NOT_FOUND`, `E_PROBE_PERMISSION`, `E_PROBE_FIRMWARE`, `E_SERVER_UNSUPPORTED`, `E_TARGET_UNKNOWN`,
`E_TARGET_PROTOCOL`, `E_TARGET_UNREACHABLE`, `E_INTERRUPT_UNSUPPORTED`.

每个错误：`{code, message, hint?}`；message 一句话；hint 可执行建议。

## 3. 配置（`~/.dbghub/config.yaml`，项目级 `.dbghub.yaml` 只允许安全键）

v1 支持 JSON（`.json`）与 YAML 的极简子集；默认配置内置于 `src/config/defaults.mjs`（实现者可用 JSON 解析器，不引入依赖）。
关键结构：
```json
{
  "daemon": { "mode": "auto", "idle_exit_min": 0, "max_sessions": 8, "allow_raw": false, "allow_attach": false },
  "profiles": {
    "native": { "adapter": "gdbmi", "gdb": "gdb", "launch": { "stop_at_entry": true } },
    "stm32f103-openocd": {
      "adapter": "gdbmi", "gdb": "arm-none-eabi-gdb",
      "probe": "auto", "backend": "auto",
      "target": "stm32f1x", "interface": "stlink", "transport": "swd", "speed_khz": 480,
      "connect": ["monitor reset halt"], "flash": ["load"], "after": ["monitor reset init"]
    }
  },
  "backends": { "openocd": { "command": "openocd", "search": ".../scripts" } }
}
```
项目级配置文件只接受：`source_map`, `symbol_paths`, `program`, `profiles` 的引用名；出现敏感键（`server.command`, `hooks`, `allow_raw`, `allow_attach`, `pid/program`）→ 忽略并 warning。

## 4. 停止事件与 epoch

- 每次 `*stopped`/`*running`/exit → `epoch += 1`，事件 `ev += 1`。
- StopCard 必带 `epoch` 与 `ev`；带 `expect_epoch` 的写命令过期 → `E_STALE_STATE`（附当前 epoch）。
- `op_id`：同 `(sid, tool, op_id)` 10 分钟内返回缓存结果，不重复执行。

## 5. 验收（P0/P1 本会话）

1. `node --test test/` 全绿。
2. 无硬件：fake-gdb 回放 MI 转录，覆盖 stop/step/break/stack/vars/eval/output。
3. 有硬件（ST-LINK V2 + STM32F103C8）：
   - `discover action=doctor` 正确识别 ST-LINK 与工具链；
   - `open(profile="stm32f103-openocd", program="<RelWithDebInfo ELF>")` 能 halt/连上；
   - 下断点、continue、step、`state` 返回源码位置/局部变量；
   - `inspect` 读寄存器/内存/栈；`eval` 求值；`close` 清理；
   - `inspect(what="rtos",kind="tasks")` 在目标 FreeRTOS 固件上返回任务列表（P1 增强，允许随后补）。
