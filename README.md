# dbghub

面向 AI Agent 的 C/C++ 调试 MCP 服务：常驻调试 daemon + 无状态 MCP 薄壳。覆盖本地 gdb/lldb、嵌入式调试探针与 RTOS 感知调试。

> 状态：**MVP（v0.1）**。本地/模拟器链路、真实 ST-LINK V2 + STM32F103C8 链路均已验证。
> 使用手册：[docs/user-guide.md](docs/user-guide.md) · API 契约：[docs/contract-v1.md](docs/contract-v1.md) · Renode 仿真：[docs/renode.md](docs/renode.md)
> 许可证：[MIT](LICENSE)

## 已实现

- **MCP stdio 服务**（12 工具，手写协议，零依赖）：`discover / sessions / session_ctl / open / run / wait / state / break / inspect / eval / output / raw`
- **常驻 daemon**：命名管道 / Unix socket / `tcp://` 回环；自动拉起、空闲退出、多连接、优雅关闭
- **GDB/MI 引擎**：自写 MI 解析器、命令队列/token 匹配、异步事件、StopCard、`pause` 带外、Windows 沙箱下的 PowerShell relay 兜底
- **后端**：OpenOCD 进程管理（自动端口、就绪探测、错误分类、幂等 stop）；本地/远程 GDB stub（Renode/QEMU/remote）
- **探针/目标发现**：ST-LINK/J-Link/CMSIS-DAP 扫描、doctor（工具链/驱动/固件/电压/DPIDR）、plan；`discover` 还会列出本机监听中的 GDB stub/monitor（Renode/OpenOCD/QEMU，带 role 提示）
- **符号**：ELF32/64（DWARF 版本/build-id/stripped）、GNU ld 与 Keil Armlink MAP、ELF↔MAP 校验、sourceMap、`inspect(what=symbols)`
- **RTOS**：FreeRTOS 任务列表（状态/优先级/栈用量/阻塞对象）+ **按任务查看调用栈**（OpenOCD RTOS 线程优先，daemon TCB 解帧兜底）；HardFault CFSR/HFSR 诊断卡
- **会话治理**：显式 sid、exclusive/shared/observer、lease、probeKey/resourceKey 独占、epoch/ev、op_id 幂等
- **launch / attach**：`open(mode:"launch")` 按 profile 连接/复位/可选烧录；`open(mode:"attach")` 不复位、不写目标，只 halt + 加载符号
- **入口断点**：`stop_at_entry` 用临时硬件断点（回退软件）停在 `main`（可用 `entry` 指定），命中/超时后自动删除
- **安全基线**：项目配置只读安全键、`raw` 默认关、attach 门禁、读/写工具分离

## 快速开始

要求：Node ≥ 20；嵌入式调试需要 `openocd` + `arm-none-eabi-gdb`；本地调试需要 `gdb`。

```powershell
git clone <this-repo>
cd dbghub
npm test                 # 180 tests；缺少本机 gdb/Renode/硬件样本的用例会自动 skip
node bin/dbghub.mjs doctor --json
```

启动 daemon（生产默认命名管道；测试/沙箱可用 TCP 回环）：

```powershell
node bin/dbghub.mjs serve --socket tcp://127.0.0.1:45733 --idle 0
# 另一个终端：
$env:DBGHUB_SOCKET='tcp://127.0.0.1:45733'
node bin/dbghub.mjs mcp   # 供 MCP 宿主 spawn，stdout 只有 JSON-RPC
```

DSH 配置（`~/.dsh/profiles/<profile>/cordis.patch.yml`，**已于 2026-11-21 实测接入**）：

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
          DBGHUB_SOCKET: 'tcp://127.0.0.1:45733'   # 或留空走命名管道
          DBGHUB_LOG_LEVEL: 'error'
        toolCallTimeoutMs: 60000
        failOnStartupError: false
```

保存后 DSH 热重载；工具以 `mcp__dbg__*` 出现，`mcp__dbg__discover`、`open`、`break`、`run`、`eval`、`session_ctl` 已在本会话实测通过。网络/端口占用时改 `DBGHUB_SOCKET`，daemon 由 MCP 薄壳首次调用自动拉起。

## Renode 仿真验收（无硬件）

```powershell
# 1) 最小 Cortex-M3 固件：test/fixtures/testfw/（源码 + ELF + MAP）
# 2) 启动 Renode：GDB 在 127.0.0.1:3333
renode --disable-gui --plain test/fixtures/renode-testfw.resc
# 3) 启动 daemon 后执行端到端脚本（MCP 全链路：initialize→tools→open→break→run→inspect→close）
node scripts/e2e-renode.mjs
```

最近一次结果：`E2E PASS`（open/break/continue/state/frames/eval/memory/close 全部通过，gdb 通过 relay 模式通信）。

## 真实硬件（ST-LINK V2 + STM32F103C8，已验证）

```powershell
node bin/dbghub.mjs doctor --json        # 应看到 stlink:0483:3748 / V2J37S7 / 3.2V / DPIDR
# MCP 中：
# discover action=doctor profile=stm32f103-openocd
# open profile=stm32f103-openocd program=".../RelWithDebInfo/app.elf"
#        symbols=[".../app.map"] flash=true stop_at_entry=true
# state / break action=set file=".../main.c" line=42 / run action=continue
# inspect what=rtos kind=tasks
# inspect what=rtos kind=stacks task="wind_spd"   # 单任务调用栈
```

已验证：ST-LINK V2（FW V2J37S7）识别、OpenOCD 启停、flash、入口断点、行断点、FreeRTOS 6 任务列表、任务调用栈、pause/restart、attach 模式。默认 `stop_at_entry` 通过临时硬件断点停在 `main`；`mode="attach"` 可无复位附加。

## 代码结构

```
bin/dbghub.mjs              CLI/MCP 入口
src/app/runtime.mjs         生产装配（config + 实现 → SessionManager）
src/protocol/               MCP stdio、工具 schema、daemon 客户端/路径
src/daemon/                 daemon IPC server、会话管理（open/run/inspect/…）
src/gdb/                    MI 解析器、GdbSession、spawn/relay
src/backends/               OpenOCD 进程管理
src/probes/                 探针扫描/doctor/plan
src/symbols/                ELF、MAP、符号索引/源码映射
src/rtos/freertos.mjs       FreeRTOS walker + fault 解码
src/config/                 默认配置与加载
test/                       180 个单测（node:test）
scripts/                    Renode e2e、硬件 discover
```

## 已知限制（v0.1）

- 真机 ST-LINK V2 + STM32F103C8 已验证；J-Link/CMSIS-DAP 等探针矩阵仍待硬件验证。
- 远程 GDB stub（Renode/QEMU）可能不支持异步中断：`run action=pause` 会返回 `E_INTERRUPT_UNSUPPORTED`，用 `restart` 拿回控制；Renode 的 monitor 端口（1234）不是 GDB stub，连错会得到 `E_TARGET_PROTOCOL`。OpenOCD 真机走 telnet halt 回退。
- 按任务调用栈：A（OpenOCD RTOS 线程）返回 `confidence=high`；B（daemon TCB 解帧）只支持 Cortex-M3，返回 `confidence=medium`。
- `open` 不会校验传入 ELF 是否匹配目标里已加载的镜像（远程目标只加载符号）；传错 ELF 会得到“看起来合理但错误”的符号，`open` 的 `notes` 会提示这一点。
- `open` 的相对路径由 daemon 解析，可能不是你的 shell cwd；建议传绝对路径或 `cwd=<项目目录>`。
- RTOS 已支持 FreeRTOS 任务/HardFault；队列/信号量/定时器对象（L2）与 Zephyr/ThreadX/RT-Thread 待 P2。
- DAP（lldb-dap）适配器未实现；桌面 Windows PDB 暂不支持（gdb 不读 PDB）。
- 共享会话的跨客户端控制为最小实现（exclusive 会话对其他客户端不可见；shared 需 lease）。
- Windows 沙箱下 Node 匿名管道被禁，gdb 走 PowerShell relay；生产环境优先普通 pipe。
- 命名管道在本会话沙箱被 EPERM，测试用 `tcp://` 回环；生产默认仍为命名管道/Unix socket。

## 文档

- [用户手册](docs/user-guide.md)：安装、12 个 MCP 工具、断点、RTOS、attach、错误码
- [API 契约](docs/contract-v1.md)：工具参数/返回/错误码的稳定接口
- [Renode 仿真](docs/renode.md)：无硬件跑通全链路

## 许可证

[MIT](LICENSE) © 2026 dbghub contributors
