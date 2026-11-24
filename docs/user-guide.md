# dbghub 使用手册（v0.2）

> 面向使用 DSH（或其他支持 MCP 的客户端）的 Agent 与开发者。
> 目标：用最少的 token 完成“连接目标 → 下断点 → 运行/单步 → 看栈/变量/寄存器/内存/RTOS 任务栈 → 结束”的闭环。
> 设计稿见 [design.md](design.md)，工具契约见 [contract-v1.md](contract-v1.md)，无硬件仿真见 [renode.md](renode.md)。
> 最近更新：2026-11-21（新增 RTOS 按任务调用栈 A/B、断点 file+line、discover targets、真机验证）。

## 目录

1. 安装与启动
2. 5 分钟上手
3. 核心概念
4. 工具参考（12 个）
5. 断点专题
6. 符号、源码与路径
7. RTOS 调试
8. 会话、独占与共享
9. 探针、后端与目标发现
10. 配置与环境变量
11. CLI 与运维
12. 安全边界
13. 错误码与排障
14. 已知限制与最佳实践
15. 附录：DSH / Renode 速查
16. 更新记录

---

## 1. 安装与启动

### 1.1 依赖

| 依赖 | 用途 | 说明 |
|---|---|---|
| Node ≥ 20 | daemon + MCP 薄壳 | 零第三方依赖 |
| gdb / arm-none-eabi-gdb | 本地/嵌入式调试前端 | 嵌入式需要 Arm GNU Toolchain |
| OpenOCD | ST-LINK/J-Link/CMSIS-DAP 等后端 | 或 JLinkGDBServer/pyOCD/st-util |
| Renode/QEMU（可选） | 无硬件仿真目标 | Renode 通过 GDB stub 接入 |

### 1.2 启动方式

**方式 A：DSH 托管（推荐）**——写到 DSH profile，DSH 启动 MCP 薄壳，薄壳首次调用自动拉起 daemon：

```yaml
- insert:
    - id: dbghub-mcp
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: dbg
        transport: stdio
        command: 'C:\Program Files\nodejs\node.exe'
        args: ['/path/to/dbghub/bin/dbghub.mjs', 'mcp']
        env:
          DBGHUB_SOCKET: 'tcp://127.0.0.1:45733'
          DBGHUB_LOG_LEVEL: 'error'
        toolCallTimeoutMs: 60000
        failOnStartupError: false
```

保存后热重载；工具以 `mcp__dbg__*` 出现。

**方式 B：手动起 daemon**（适合调试/测试）：

```powershell
node bin/dbghub.mjs serve --socket tcp://127.0.0.1:45733 --idle 0
$env:DBGHUB_SOCKET = 'tcp://127.0.0.1:45733'
node bin/dbghub.mjs mcp     # 供客户端 spawn，stdout 只有 MCP JSON
```

**命名管道**：不设 `DBGHUB_SOCKET` 时默认 Windows `\\.\pipe\dbghub-<user>` / Unix `$XDG_RUNTIME_DIR/dbghub.sock`。命名管道被宿主沙箱拒绝时，改用 `tcp://` 回环。

**inline 模式**：设 `DBGHUB_INLINE=1` 或客户端起不来 daemon 时，薄壳进程内直接跑会话管理（不跨宿主、daemon 重启即丢会话）。

### 1.3 自检

```powershell
node bin/dbghub.mjs doctor --json
```

检查 gdb/openocd/arm-gdb 路径、探针、驱动提示。无硬件时 `probes=[]` 正常。

---

## 2. 5 分钟上手

### 2.1 有硬件（ST-LINK + STM32F103C8）

```text
1) mcp__dbg__discover {action:"doctor", profile:"stm32f103-openocd"}
   → probes 里应看到 stlink:0483:3748、FW V2J37S7、电压、DPIDR

2) mcp__dbg__open {
     profile:"stm32f103-openocd",
     program:"/path/to/build/RelWithDebInfo/app.elf",
     symbols:["/path/to/build/RelWithDebInfo/app.map"],
     flash:true,
     stop_at_entry:true
   }
   → 返回 sid、StopCard（停在 main 或 entry）、symbols 摘要

3) mcp__dbg__break {sid, action:"set", file:"Core/Src/main.c", line:42}
   → created:[1]，breakpoints[].file/line 已解析

4) mcp__dbg__run {sid, action:"continue", timeout_ms:15000}
   → 命中后返回 StopCard（reason=breakpoint-hit，含源码行/locals）

5) mcp__dbg__inspect {sid, what:"frames", count:10}
   mcp__dbg__inspect {sid, what:"vars", frame:0}
   mcp__dbg__inspect {sid, what:"registers"}       // 默认给全 r0-r15/sp/lr/pc/xpsr
   mcp__dbg__inspect {sid, what:"memory", addr:"0x20000000", count:32}

6) RTOS（FreeRTOS）任务与调用栈：
   mcp__dbg__inspect {sid, what:"rtos", kind:"tasks"}
   mcp__dbg__inspect {sid, what:"rtos", kind:"stacks", task:"wind_spd", count:10}
   mcp__dbg__inspect {sid, what:"frames", thread:5}   // task.thread

7) mcp__dbg__session_ctl {sid, action:"close", kill:false}   // detach，不杀目标；kill:true 才杀
```

> 真机验证（2026-11-21，ST-LINK V2 + STM32F103C8 + P01 FreeRTOS 固件）：
> `discover` 识别 `stlink:0483:3748 / V2J37S7 / 3.22V / DPIDR 0x2ba01477`；
> `open(flash:false)` 成功；行断点 `app_wind.c:211` 命中；`inspect rtos kind:"tasks"` 返回 6 个任务（IDLE/wind_dir/wind_spd/disp_draw/hb/disp_send）；`kind:"stacks"` 返回任务调用栈。
> 若只想连接/查看、不覆盖板子固件，请使用 `flash:false`。

### 2.2 无硬件（Renode 仿真）

```powershell
# 终端 1：启动 Renode（GDB stub 127.0.0.1:3333）
renode --disable-gui --plain test/fixtures/renode-testfw.resc

# 终端 2：daemon
node bin/dbghub.mjs serve --socket tcp://127.0.0.1:45733 --idle 0
```

```text
mcp__dbg__discover {action:"list"}
→ targets 会显示 {"endpoint":"127.0.0.1:3333","process":"renode.exe","role":"gdb"}

mcp__dbg__open {profile:"renode", target:"127.0.0.1:3333",
                program:"test/fixtures/testfw/testfw.elf", stop_at_entry:false}
mcp__dbg__break {sid, action:"set", function:"tick"}
mcp__dbg__run {sid, action:"continue", timeout_ms:15000}
mcp__dbg__inspect {sid, what:"frames"}
```

> Renode 的 `1234` 是 monitor，不是 GDB stub；连错返回 `E_TARGET_PROTOCOL`，按提示换 `3333`。
> Renode/QEMU 可能不支持异步中断：`run action=pause` 返回 `E_INTERRUPT_UNSUPPORTED`，用 `run action=restart` 恢复控制。

---

## 3. 核心概念

| 概念 | 说明 |
|---|---|
| daemon | 常驻进程，持有 gdb/server/探针和目标状态；跨宿主存活 |
| 薄壳（mcp） | 无状态 stdio MCP 进程；可被宿主随时杀/重启；首次调用自动拉起 daemon |
| session / `sid` | 一次调试会话；所有工具用它路由；省略时仅在“唯一会话”下推断 |
| profile | 目标/板级配置（gdb、后端、连接命令、flash 命令、RTOS） |
| probe | 硬件调试器（ST-LINK/J-Link/CMSIS-DAP/...）；`probeKey` 级独占 |
| backend | 驱动探针的 server（OpenOCD/JLinkGDBServer/pyOCD/...） |
| symbols | ELF/AXF（DWARF）+ MAP；AI 只传路径，daemon 解析/校验/加载 |
| StopCard | 命中/停止时返回的紧凑状态卡（函数、文件行、源码片段、locals、ev/epoch） |

---

## 4. 工具参考（12 个）

> 所有工具返回 `{ok:true,...}` 或 `{ok:false,error:{code,message,hint?}}`。字段含义以契约 [contract-v1.md](contract-v1.md) 为准。
> 通用参数：`sid`（除 discover/sessions/session_ctl 外都可省略，仅唯一会话时推断）。

### 4.1 `discover` —— 诊断 + 目标发现

```json
{"action":"list|scan|doctor|plan", "probe":"可选", "profile":"可选", "backend":"可选"}
```

| action | 作用 |
|---|---|
| `list` | 列 profiles/backends/toolchains，扫描本机监听中的调试目标（**不短暂占用探针**） |
| `scan` | 同 list，并主动探测探针（会短暂占用 ST-LINK/OpenOCD，约 1–2s） |
| `doctor` | 工具链/驱动/固件/电压/DPIDR 体检，返回 `issues[]`（含修复 hint） |
| `plan` | 给定 profile/probe 返回选哪个后端、理由、备选 |

返回 `{probes[], profiles[], backends[], toolchains[], targets[], warnings[]}`。
`targets[]` 示例：`{"endpoint":"127.0.0.1:3333","process":"renode.exe","role":"gdb"}`；`role=monitor/telnet` 的端口不是 GDB stub。
**建议**：open 前先 discover；无探针但 `targets` 非空时，用 `profile=renode/remote + target=<endpoint>`。

### 4.2 `sessions` —— 列会话（只读）

```json
{"action":"list|status", "sid":"可选", "all":false}
```

返回每个会话的 `sid/profile/probe/backend/state/owner/share/lease/workspace/ev/epoch/lastError`。
默认只看本客户端在相同 workspace 下的会话；`all=true` 列全部。

### 4.3 `session_ctl` —— 关闭/锁/解锁（破坏性）

```json
{"action":"close|lock|unlock", "sid":"s1abc", "kill":false, "force":false}
```

- `close`：默认优雅退出（detach）；`kill:true` 杀 gdb/目标。
- `lock`：接管控制租约（shared 会话用）；`force:true` 强制抢锁（审计）。
- 只读工具与写/杀工具分离，便于宿主审批策略放行只读。

### 4.4 `open` —— 打开调试会话

```json
{
  "profile":"stm32f103-openocd",
  "program":"D:/path/app.elf",          // 必填之一：可执行/ELF（远程目标只用于符号）
  "symbols":["app.map"],                // 可选：额外符号源（map/axf/debug/elf）
  "images":[{"file":"boot.elf","base":"0x08000000"}],
  "symbol_paths":["build/debug"],       // 分离调试文件搜索目录
  "source_map":[["D:/old","D:/new"]],   // DWARF/Keil 源码路径重写
  "target":"127.0.0.1:3333",            // 远程 gdb stub（或 pid/core）
  "pid":null, "core":null,
  "cwd":"D:/my/project",                // 相对路径基准
  "args":[], "stop_at_entry":true, "entry":"main", "mode":"launch|attach",
  "share":"exclusive|shared|observer",
  "reuse":false, "actor":null, "op_id":null,
  "wait_ms":20000, "flash":true
}
```

返回：`{sid,state,stop:StopCard,symbols,target:{mode,attached,reset,endpoint,flashed},program:{path,used_for},notes?,warnings?}`。
- `stop_at_entry` 默认 true，会停在入口符号（默认 `main`，可用 `entry` 改）；临时断点命中/超时后自动删除。
- **远程目标**（Renode/QEMU/gdbserver）：`flash` 默认 false，`program` 只加载符号、不写目标内存；`notes` 会说明。
- **嵌入式**：`profile.flash_on_open` + `flash=true` 时会执行 `load`。
- 相对路径按 `cwd` 解析；不传 `cwd` 时按 daemon cwd，可能不是你的 shell 目录 → 建议绝对路径。
- 同一 target 重复 open：默认 `reuse=false` 返回 `E_RESOURCE_BUSY`；`reuse=true` 且同 `(clientId,actor)` 才复用。
- 耗时超过 `wait_ms` 返回 `{state:"starting",job:"j1",progress}`，用 `state`/`wait` 继续。
- **`mode`**：`launch`（默认，按 profile 连接/复位、可 flash）/ `attach`（不复位、不写 flash，只 halt + 加载符号）。attach 示例：

```json
{"profile":"stm32f103-openocd", "mode":"attach",
 "program":".../app.elf", "symbols":[".../app.map"]}
```

- `stop_at_entry`（默认 true）：不再只是“等任意 stop”，而是设置**入口临时断点**（默认 `main`，可用 `entry` 或 `profile.entry` 覆盖），优先硬件断点、回退软件断点；命中或超时都会删除临时断点并返回（超时会 halt 当前 PC）。
- `entry`：入口符号名，默认 `main`；无符号/找不到时会 warning 并回退为当前 stop。
- attach 时 `target.attached=true, target.reset=false`；`flash:true` 与 attach 互斥，会返回 `E_INVALID_ARG`。
- attach 需要 profile 提供 `attach_connect`（嵌入式默认 `[]` + OpenOCD telnet halt；Renode 用 `target extended-remote`）；没有 `attach_connect` 的 profile 会退回复用 `connect` 并跳过其中的 reset 命令，同时给出 warning。

### 4.5 `run` —— 运行/单步/暂停/重启

```json
{"action":"continue|step_over|step_in|step_out|pause|restart|kill|detach",
 "thread":null, "timeout_ms":20000, "until":null, "expect_epoch":null, "op_id":null}
```

- `continue`：阻塞等到 stop（最多 `timeout_ms`）；未停返回 `{state:"running",timed_out:true}`。
- 单步：返回 StopCard。
- `thread`：先选中的 GDB 线程/RTOS 任务再执行（单步某任务栈时有用），id 来自 `inspect what=threads` 或 `tasks[].thread`。
- `pause`：带外中断；OpenOCD 真机自动回退 telnet `halt`；Renode/QEMU 等不支持时返回 `E_INTERRUPT_UNSUPPORTED`；真机 halt 后仍无 stop 事件会返回 `E_TARGET_UNRESPONSIVE`（目标可能死锁/低功耗），用 `restart` 或 `session_ctl close kill=true` 恢复。
- `restart`：重建 gdb/后端，沿用同一 sid；**默认沿用 open 时的 mode**（launch 会复位/可选烧录，attach 不会复位），也可传 `mode:"launch"` 强制复位重启、`mode:"attach"` 强制不复位重连。返回带 `restarted/mode/reset/attached`。GDB 侧断点会丢。
- 写操作可带 `expect_epoch`，过期返回 `E_STALE_STATE`（避免误操作已跑飞的目标）。

### 4.6 `wait` —— 事件长轮询

```json
{"after":0, "timeout_ms":10000, "events":["stop","output","exited"]}
```

返回自 `after` 起的 `events[]` 与 `stop?`；超时 `timed_out:true` 不是错误。用于异步/长任务，避免频繁 `state` 轮询。

### 4.7 `state` —— 当前状态

```json
{"detail":0|1|2, "thread":null}
```

- `detail=0`：`{state,ev}`（running 时最省）。
- `detail=1`：带 StopCard（当前帧、源码、locals）。
- `detail=2`：额外 epoch、断点列表。

### 4.8 `break` —— 断点（重点）

```json
{"action":"set|remove|list|enable|disable",
 "spec":"src/main.c:42", "file":"src/main.c", "line":42, "function":"app_main",
 "cond":"i==5", "hit":0, "kind":"sw|hw|watch", "temp":false, "log":null, "op_id":null}
```

**位置四选一**（`spec` 优先级最高）：
1. **行断点（推荐）**：`file` + `line`；
2. 只给 `line`：使用当前停点文件；
3. 函数入口：`function:"app_main"`；
4. 兼容写法：`spec:"src/main.c:42"`、`spec:"app_main"`、`spec:"*0x0800002c"`。

`kind`：`sw`（默认）/`hw`（硬件断点，数量有限）/`watch`（观察点，`spec` 为表达式）。
`cond`：条件；`temp`：命中一次自动删除；`log`：logpoint（不暂停，部分后端不支持）。
`remove/enable/disable` 用 `spec=<id>`（id 从 `list` 获取）。

返回：`{created:[id...], breakpoints:[{id,spec,enabled,file?,line?,func?,addr?,pending?,hits?,cond?,owner?}]}`。
- `created` 是本次创建的 id；`breakpoints` 是全量列表；
- `file/line/func/addr` 是 GDB 解析后的位置，**用来确认断点真的落在预期文件行**；
- `pending:true` 表示尚未解析到地址（符号/模块未加载），需要继续/加载后确认。

### 4.9 `inspect` —— 只读查看

```json
{"what":"frames|vars|args|globals|registers|threads|modules|memory|disasm|source|symbols|rtos|fault",
 "frame":0, "thread":null, "task":null, "path":null, "name":null, "addr":null,
 "range":null, "count":null, "cursor":null, "view":"gdb|rtos", "kind":"tasks|stacks|queues|..."}
```

| what | 返回 | 说明 |
|---|---|---|
| `frames` | 帧列表 `{i,fn,file,line,pc}` | 默认 20，分页；可带 `thread=<gdb线程id>` |
| `vars` | 当前帧局部变量 `{name,value,type?}` | `optimized_out` 会保留 |
| `args` | 当前帧参数 | |
| `registers` | `{name,value}` | 默认给全（ARM r0-r15/sp/lr/pc/xpsr…） |
| `threads` | gdb 线程 `{id,name,state,frame?}` | 启用 OpenOCD RTOS 后每个任务一个线程 |
| `memory` | `{addr,hex}` | `addr`+`count` 字节；上限受控 |
| `disasm` | `{addr,insn,fn?,src?}` | `addr`+`count` 或 `range="0xstart-0xend"` |
| `source` | 源码行 | `path`+`range`（起始行）+`count` |
| `symbols` | 单条符号查询 | `name` 或 `addr`；MAP 兜底 |
| `rtos` | FreeRTOS 任务/任务栈 | `kind:"tasks"` 任务列表；`kind:"stacks"` + `task:"name"` 单任务调用栈 |
| `fault` | CFSR/HFSR/DFSR/MMFAR/BFAR/SHCSR | Cortex-M 故障现场 |

RTOS 返回字段说明：
- `kind:"tasks"`：`summary`（任务数/running/blocked/GDB 线程数）、`rtos`、`tasks[]`（含 `sp`、`thread` 映射）。
- `kind:"stacks"`：`task:{name,state,prio,thread}`、`frames[]`、`source`（`gdb-thread|current-task|tcb-unwind`）、`confidence`（`high|medium`）。

### 4.10 `eval` —— 批量求值

```json
{"exprs":["counter","p.x"], "frame":0, "thread":null, "fmt":null}
```

返回对齐的 `{expr,value,type?}`。默认禁止 `call`/`set`（写目标/调函数）→ `E_ATTACH_DENIED`；需要时配置 `daemon.allow_eval_call=true`。

### 4.11 `output` —— 目标输出

```json
{"after":0, "limit":100, "streams":"target|console|log|all", "filter":null}
```

按 `seq` 游标增量读取（不重复消费）；`filter` 为正则。用于串口/printf/gdb console 输出。

### 4.12 `raw` —— 裸 GDB 命令（默认关）

```json
{"cmd":"info registers", "op_id":null}
```

`daemon.allow_raw=false` 时返回 `E_RAW_DISABLED`；开启后仅 allowlist（info/print/x/bt/thread/frame/list/disassemble/monitor/ptype/whatis/show），拒绝 `shell/source/define/set exec-wrapper` 等。输出 64KB 截断。

---

## 5. 断点专题

### 5.1 行断点（推荐写法）

```json
{"sid":"s1abc","action":"set","file":"Core/Src/main.c","line":42}
```

只给行号（当前停点文件）：

```json
{"sid":"s1abc","action":"set","line":42}
```

兼容写法：

```json
{"sid":"s1abc","action":"set","spec":"Core/Src/main.c:42"}
```

**如何确认落点**：看返回的 `breakpoints[].file/line/func/addr`。如果 `pending:true`，说明 GDB 还没解析到地址（共享库/固件未加载），`continue` 后再 `list` 确认。

### 5.2 函数/地址

```json
{"action":"set","function":"app_main"}
{"action":"set","spec":"*0x0800382c"}
```

无符号（只有 HEX/BIN）时只能用 `*0x...`，并用 `symbols` 传 `.map` 让 daemon 辅助解析。

### 5.3 条件/临时/观察点

```json
{"action":"set","file":"main.c","line":42,"cond":"i==5"}
{"action":"set","file":"main.c","line":42,"temp":true}
{"action":"set","spec":"counter","kind":"watch"}     // 写观察点；读观察点用 raw "rwatch" 或后续扩展
```

### 5.4 源码路径不匹配

DWARF 里是编译机路径（Keil `C:\Keil_v5\...`、容器 `/build/src`）时：

```json
open({..., "source_map":[["/old/src","/new/src"]]})
```

之后行断点和 StopCard 源码行都会按新路径解析。也推荐编译时用 `-fdebug-prefix-map`。

### 5.5 断点“只回一条/被覆盖”的误解

`break set` 返回的是**全量** `breakpoints[]` + 本次 `created[]`；如果 `restart` 过，GDB 侧断点会重建/丢失，id 会重排。以 `break action=list` 为准。

---

### 5.6 attach（不复位连接）

用于“目标已经在跑，只想附加进去看现场”，不 reset、不烧录，保留外设/RTOS 状态：

```json
// ST-LINK/OpenOCD：只 halt 当前现场
{"profile":"stm32f103-openocd", "mode":"attach",
 "program":".../RelWithDebInfo/app.elf", "symbols":[".../app.map"]}

// Renode/QEMU：本来就是 remote attach
{"profile":"renode", "mode":"attach", "target":"127.0.0.1:3333",
 "program":".../app.elf"}
```

行为与返回：
- 跳过 launch 的 `monitor reset halt`；OpenOCD 走 telnet `halt`，Renode/QEMU 用 `target extended-remote`；
- 返回 `target:{mode:"embedded|remote", attached:true, reset:false, flashed:false}`；
- `notes` 会说明“attached without reset；程序只用于符号”；
- 需要恢复运行：`run action="continue"`；`close` 不杀目标。

profile 可显式控制 attach 序列：

```yaml
attach_connect: []          # 嵌入式默认：只依赖 OpenOCD telnet halt
attach_after: []            # 不要放 reset
```

注意：
- attach 不 flash，`flash:true` 会报 `E_INVALID_ARG`；
- ELF 必须与目标里正在跑的固件一致；
- 目标在 WFI/低功耗/关闭调试时钟时可能 halt 失败，此时才需要 `connect_under_reset` 或 `mode:"launch"`；
- attach 后看 RTOS 任务栈同样用 `inspect what="rtos"`；
- 关闭 attach 会话前如果希望目标继续跑，先 `run action="continue"`；直接 close 可能让目标停在 halt 状态（取决于后端 detach 行为）。

### 5.7 入口断点（stop_at_entry）

`open(..., stop_at_entry:true)` 的语义现在是“**停在入口符号**”，不是“等任意一次 stop”：

```json
{"profile":"stm32f103-openocd", "program":".../app.elf",
 "stop_at_entry":true}
// 可指定入口
{"profile":"stm32f103-openocd", "program":".../app.elf",
 "stop_at_entry":true, "entry":"app_main"}
```

流程：
1. flash/reset 后优先在 `entry`（默认 `main`）下**临时硬件断点**（`-break-insert -t -h`），硬件断点不足/不支持时回退软件断点；
2. `continue` 等命中；
3. 命中 → 删除临时断点，返回 `reason:"breakpoint-hit", loc.fn:"main"` 的 StopCard；
4. 10s 未命中 → 删临时断点，用 backend halt 停住当前 PC，warning 说明未到入口；
5. `entry` 不存在 → warning，回退“当前 stop”语义。

这解决了“flash 后已经跑到 ISR，stop_at_entry 返回的是 ISR”的问题：之前的实现只是 `ensureStopped()`，并不认识“入口函数”。

## 6. 符号、源码与路径

- **AI 只传路径**，不要把 ELF/MAP 内容贴进对话。
- `program` 支持 `.elf/.axf/.out`；`.hex/.bin` 本身无符号，需同时传 `.elf`/`.axf`/`.map`。
- `.map` 在无 DWARF 时提供函数/全局符号和段布局；没有局部变量/类型/源码行。
- Keil AXF：AC6（armclang，DWARF4/5）通常可直接用；AC5 可能只读到部分符号，优先 MAP 兜底。
- `inspect what=symbols` 做单条查询（`name` 或 `addr`），不返回整表。
- `symbol_paths` 用于找分离 `.debug` 文件（按同名 basename；build-id 跨目录查找尚未实现）。

---

## 7. RTOS 调试（FreeRTOS）

### 7.1 任务列表

```json
{"sid":"s1abc","what":"rtos","kind":"tasks","count":20}
```

返回：
- `rtos:{kind,cores,scheduler,current}`
- `summary`：`"6 task(s): 1 running, 5 blocked; 6 GDB thread(s)"`（一眼看清规模）
- `tasks[]`：`{id(TCB 地址), name, state(running/blocked/suspended/dead), prio, sp, stack, blocked_on?, wake_tick?, current?, thread?(GDB 线程 id)}`

`stack` 字段：`base/top/headroom/peak_free/fill/overflow`。`headroom` 是当前 SP 到栈底的剩余空间；`peak_free` 是从栈底向上扫 `0xA5` 得到的“历史最低剩余”；没有 `configRECORD_STACK_HIGH_ADDRESS` 时无法得到栈总量，只能看 headroom/overflow。

### 7.2 单任务调用栈（核心）

```json
{"sid":"s1abc","what":"rtos","kind":"stacks","task":"wind_spd","count":10}
```

返回：

```json
{"ok":true,"task":{"name":"wind_spd","state":"blocked","prio":3,"thread":5},
 "frames":[{"i":0,"fn":"xQueueSemaphoreTake","file":"queue.c","line":1811,"pc":"0x08006bec"},
           {"i":1,"fn":"mb_port_recv","file":"drv_modbus_port_stm32.c","line":212,"pc":"0x0800523a"},
           {"i":2,"fn":"wind_speed_task","file":"app_wind.c","line":193,"pc":"0x0800490c"}],
 "source":"gdb-thread","confidence":"high"}
```

`source` 说明栈是怎么来的：
| source | 含义 | confidence |
|---|---|---|
| `gdb-thread` | OpenOCD/J-Link 暴露了 RTOS 线程，直接切线程取栈（首选） | high |
| `current-task` | 查询的就是当前正在跑的任务 | high |
| `tcb-unwind` | 后端没有 RTOS 线程，daemon 读 TCB 保存的 Cortex-M3 上下文、临时切寄存器取栈再恢复（兜底） | medium |

### 7.3 两种模式怎么选

- **A（推荐）**：profile 里设置 `openocd_rtos: "FreeRTOS"`（可选 `openocd_target: "stm32f1x.cpu"`），OpenOCD 会把每个任务暴露成 GDB 线程；`inspect what=threads` 能看到 6 个线程，`what=rtos kind=tasks` 的 `task.thread` 有值，`kind=stacks` 返回 `source=gdb-thread`。
- **B（兜底）**：不设置 `openocd_rtos`（例如 `stm32f103-walker` profile），daemon 自己解 TCB 上下文；只支持 Cortex-M3（无 FPU 扩展帧），结果标 `source=tcb-unwind, confidence=medium`。

```json
// A：OpenOCD 线程感知
{"profile":"stm32f103-openocd", "...":"..."}
// B：仅 daemon walker（无 RTOS 插件）
{"profile":"stm32f103-walker", "...":"..."}
```

### 7.4 任意 GDB 线程的栈/单步

```json
{"sid":"s1abc","what":"frames","thread":5,"count":10}
{"sid":"s1abc","action":"step_over","thread":5}
```

`thread` 来自 `inspect what=threads` 的 `id`，或 `kind=tasks` 里 `task.thread`。

### 7.5 HardFault

```json
{"sid":"s1abc","what":"fault"}
```

返回 CFSR/HFSR/DFSR/MMFAR/BFAR/SHCSR 原始值与位解码（Cortex-M），需目标停在异常处。

### 7.6 限制

- 队列/信号量/定时器对象、Zephyr/ThreadX/RT-Thread 任务视图仍在 P2。
- B 兜底只支持 Cortex-M3 布局；Cortex-M4F 的 FPU 扩展帧未解码（会用 `E_RTOS_STACK`/错误提示）。
- 任务名依赖符号表；优化等级过高时局部变量/参数可能 `<optimized out>`。

---

## 8. 会话、独占与共享

- 默认 `share=exclusive`：仅 owner 可操作，其他客户端看不到该会话（防跨 workspace 泄露）。
- `shared`：其他客户端可读，写操作需控制租约（`session_ctl action=lock`，TTL 90s）。
- `observer`：只读。
- `open` 默认不复用同 target 会话；`reuse=true` 且同 `(clientId,actor)` 才复用。
- 会话有 `epoch`（每次 stop/continue 递增）和 `ev`（事件游标）；写命令带 `expect_epoch` 可拒绝过期操作。
- 关闭：`session_ctl action=close kill=false` 保留目标；`kill=true` 杀目标。
- daemon 空闲退出、max_sessions 淘汰、client 心跳等治理见设计稿。

---

## 9. 探针、后端与目标发现

- `discover` 的 `targets[]` 来自本机监听端口 + 进程名：Renode（3333 gdb / 1234 monitor）、OpenOCD（3333 gdb / 4444 telnet）、J-Link（2331 gdb）、QEMU 等。
- 连到 monitor/telnet 端口时返回 `E_TARGET_PROTOCOL`，不要把它当“连接失败”。
- ST-LINK 已被占用时返回 `E_PROBE_BUSY`；驱动/权限问题返回 `E_PROBE_PERMISSION`；固件过旧返回 `E_PROBE_FIRMWARE`。
- 同一探针同一时刻只允许一个 session 持有（probeKey 独占）；同一目标也只允许一个 session（resourceKey）。
- 后端选择：ST-LINK → OpenOCD；J-Link → JLinkGDBServer；CMSIS-DAP → OpenOCD/pyOCD；Renode/QEMU → 直接 GDB remote。
- 嵌入式 profile 默认 `flash_on_open=true`（`load`）；远程 profile 默认 false。

---

## 10. 配置与环境变量

### 10.1 配置文件

- 用户级：`~/.dbghub/config.json`（Windows：`C:\Users\<you>\.dbghub\config.json`）
- 环境变量 `DBGHUB_CONFIG` 可指定另一个 JSON。
- 项目级：`.dbghub.json`（向上查找；只允许安全键：`program/symbols/source_map/symbol_paths/profile/images`，不允许改命令/权限）。

最小示例：

```json
{
  "daemon": {"mode": "auto", "allow_raw": false, "allow_attach": false},
  "profiles": {
    "stm32f103-openocd": {
      "adapter": "gdbmi", "gdb": "arm-none-eabi-gdb",
      "probe": "auto", "backend": "openocd",
      "interface": "stlink", "target": "stm32f1x", "transport": "swd", "speed_khz": 480,
      "connect": ["monitor reset halt"], "flash": ["load"], "after": ["monitor reset halt"],
      "stop_at_entry": true, "flash_on_open": true, "rtos": "auto",
      "openocd_target": "stm32f1x.cpu",
      "openocd_rtos": "FreeRTOS"
    },
    "stm32f103-walker": {
      "adapter": "gdbmi", "gdb": "arm-none-eabi-gdb",
      "probe": "auto", "backend": "openocd",
      "interface": "stlink", "target": "stm32f1x", "transport": "swd", "speed_khz": 480,
      "connect": ["monitor reset halt"], "flash": ["load"], "after": ["monitor reset halt"],
      "stop_at_entry": true, "flash_on_open": true, "rtos": "walker"
    }
  }
}
```

- `openocd_rtos:"FreeRTOS"`：让 OpenOCD 暴露 RTOS 线程（A 方案；需要固件含 `uxTopUsedPriority`）。
- 不写 `openocd_rtos`（如 `stm32f103-walker`）：daemon 自己解 TCB 上下文（B 方案，Cortex-M3 兜底）。
- `attach_connect`：`mode:"attach"` 时执行的连接/halt 序列（嵌入式默认 `[]`，由 OpenOCD telnet halt 兜底；Renode 用 `target extended-remote`）；不要在这里放 reset。
- 真实板卡调试建议先用 `flash:false` 只加载符号；确认后再 `flash:true`。

### 10.2 环境变量

| 变量 | 作用 |
|---|---|
| `DBGHUB_SOCKET` | daemon 端点（`tcp://host:port` / 管道路径 / socket 路径） |
| `DBGHUB_INLINE` | `1` 强制 inline 模式 |
| `DBGHUB_CONFIG` | 用户配置文件路径 |
| `DBGHUB_LOG_LEVEL` | MCP 薄壳日志级别（默认 error） |
| `DBGHUB_ARM_GDB` / `DBGHUB_GDB` / `DBGHUB_OPENOCD` / `DBGHUB_OPENOCD_SCRIPTS` | 覆盖工具路径 |

---

## 11. CLI 与运维

```powershell
node bin/dbghub.mjs doctor [--json]        # 诊断
node bin/dbghub.mjs serve [--socket ...] [--idle N]   # 前台 daemon
node bin/dbghub.mjs serve --daemon          # 后台 daemon
node bin/dbghub.mjs mcp [--inline] [--socket ...]     # MCP stdio（stdout 只放 JSON-RPC）
```

- daemon 发现：`%LOCALAPPDATA%\dbghub\run\daemon.json`（pid/socket/version）。
- 日志：daemon 模式写 `%LOCALAPPDATA%\dbghub\run\daemon.log`；MCP 薄壳日志走 stderr。
- 停 daemon：结束 `daemon.json` 里的 pid；下次工具调用会自动重启。
- 端口冲突：改 `DBGHUB_SOCKET` 的端口，DSH profile 保存后热重载。

---

## 12. 安全边界

- 调试器 = 任意代码执行；`raw` 默认关闭，`eval` 默认禁 `call/set`。
- 项目级配置只接受安全键，防止“克隆仓库即 RCE”。
- `attach` 默认关闭（`daemon.allow_attach=true` 才允许），避免任意 pid 读内存。
- 只读工具与写/杀工具分离，宿主可分别审批。
- 本地 IPC 使用命名管道/Unix socket；TCP 仅回环，远程模式需 token/TLS（P3）。
- 不要用 `force` 抢正在烧录的探针。

---

## 13. 错误码与排障

| 错误码 | 含义 | 处理 |
|---|---|---|
| `E_TARGET_PROTOCOL` | 连到了非 GDB stub（monitor/telnet） | 换成 `discover` 里 `role=gdb` 的 endpoint |
| `E_TARGET_UNREACHABLE` | 端口不可达/主机名错 | 检查 OpenOCD/Renode 是否启动、host:port |
| `E_INTERRUPT_UNSUPPORTED` | 该 stub 不支持异步中断 | 用 `run action=restart` 拿回控制 |
| `E_TARGET_UNRESPONSIVE` | halt/interrupt 后没有 stop 事件 | 目标可能死锁/WFI/调试锁死；`run action=restart` 或 `session_ctl close kill=true` 后重开 |
| `E_PROBE_BUSY` | 探针被其他进程/会话占用 | 关闭 IDE/其他 OpenOCD，或换探针 |
| `E_PROBE_PERMISSION` | USB 驱动/udev 权限 | Windows 装 WinUSB/Zadig/厂商驱动；Linux udev |
| `E_SYMBOL_NOT_FOUND` | 程序/符号路径找不到 | 绝对路径、传 `cwd`、检查 `.elf/.map` 是否存在 |
| `E_SYMBOL_NO_DEBUG` | ELF 无 DWARF | 重编 `-g`，或传 `.map` 做函数级兜底 |
| `E_SYMBOL_MISMATCH` | ELF 与 MAP 地址不一致 | 确认同一构建，或 `strict=false` 仅警告 |
| `E_STALE_STATE` | expect_epoch 过期 | `state` 重新同步后再写 |
| `E_RESOURCE_BUSY` | 同 target 已有会话 | `sessions` 查看、`reuse=true`/关闭旧会话 |
| `E_DAEMON_DOWN` | daemon 不可达 | 检查 socket/端口；会自动重启 daemon |
| `E_RAW_DISABLED` | raw 未开启 | 用户配置 `daemon.allow_raw=true` |
| `E_RTOS_NOT_FOUND` | 未找到 FreeRTOS 符号 | 确认固件含调试符号（`pxCurrentTCB`/`pxReadyTasksLists`） |
| `E_RTOS_STACK` | 无法解某个任务的栈 | Cortex-M4F FPU 帧暂不支持；改用 OpenOCD RTOS 线程（A 方案） |

常见坑：

1. **相对路径**：按 daemon cwd 解析，不是你 shell 的目录 → 绝对路径或 `open.cwd`。
2. **源路径不匹配**：`source_map` 或编译 `-fdebug-prefix-map`。
3. **ELF 与目标镜像不一致**：远程目标只加载符号；传错 ELF 会“看起来合理但断点不命中”，`open.notes` 会提醒。
4. **Renode 1234 vs 3333**：1234 monitor，3333 GDB。
5. **pause 失败**：Renode/QEMU 限制，用 restart。

---

## 14. 已知限制与最佳实践

限制：
- v1 配置仅 JSON（YAML 计划中）；共享会话跨客户端控制为最小实现。
- 远程目标无法自动校验 ELF 与已加载镜像一致（`open.notes` 会提醒）。
- DAP/lldb-dap、Windows PDB、RTOS 对象视图（L2）未实现。
- 真机 ST-LINK V2 + STM32F103C8 已验证（discover/open/行断点/RTOS 任务栈/pause）；J-Link、CMSIS-DAP 等探针仍待硬件验证。
- B 方案（TCB 解帧）只支持 Cortex-M3，Cortex-M4F FPU 扩展帧暂不支持；结果标 `confidence=medium`。

最佳实践：
1. 先 `discover`，再 `open`；无探针看 `targets[]`，不要盲扫端口。
2. 符号只传路径；尽量绝对路径；路径不一致用 `source_map`。
3. 行断点用 `file`+`line`，设完看 `breakpoints[].file/line` 确认。
4. `continue` 用 `timeout_ms`，超时用 `state`/`wait`；不要频繁轮询。
5. 大输出用 `output` 游标或 `inspect` 分页；不要把整表塞进上下文。
6. 结束会话 `kill=false` 保留目标；需要重来用 `restart`。
7. RTOS 看任务栈：优先 `profile.openocd_rtos:"FreeRTOS"`（A，high）；没有线程感知时用 `kind:"stacks"`（B，medium），两者都返回 `source/confidence` 以便判断可信度。

---

## 15. 附录：DSH / Renode 速查

DSH 配置、Renode 启动、e2e 脚本见 [README](../README.md) 与 [renode.md](renode.md)。

```powershell
# Renode（无硬件）
renode --disable-gui --plain test/fixtures/renode-testfw.resc
# daemon
node bin/dbghub.mjs serve --socket tcp://127.0.0.1:45733 --idle 0
# 端到端脚本
node scripts/e2e-renode.mjs
```

---

## 16. 更新记录

| 日期 | 变更 |
|---|---|
| 2026-11-24 | stop_at_entry 改为入口临时断点（默认 main，硬件优先/软件回退，命中或超时删除）；open 增加 entry 参数 |
| 2026-11-23 | open 增加 `mode="launch|attach"`；`run restart` 支持沿用/覆盖 mode；pause 无 stop 事件返回 `E_TARGET_UNRESPONSIVE`；真机 attach/restart 验证 |
| 2026-11-21 | RTOS 按任务调用栈（A：OpenOCD RTOS 线程 / B：TCB 解帧）；tasks 增加 summary/thread/sp；`frames`/`run` 支持 thread；断点支持 `file`+`line`/`function` 与结构化返回；`discover` 增加运行中 target 列表；**open 增加 mode="attach"（不复位附加）**；真机 ST-LINK V2 + STM32F103C8 验证 |
| 2026-11-20 | 初版：daemon+MCP、GDB/MI、OpenOCD、符号、基础 RTOS 任务列表 |
