# Renode 仿真验收（无硬件）

前置：安装 Renode 1.17+（本机路径自行替换）。Renode 首次运行需要可写 `%APPDATA%\renode`（沙箱/受限账户下会报 `config.lock` / `history` 权限错误）。

## 1. 启动 Renode（GDB stub :3333）

在仓库根目录执行（Renode 的相对路径按当前目录解析）：

```powershell
renode --disable-gui --plain test/fixtures/renode-testfw.resc
```

等价脚本内容：

```
mach create "testfw"
machine LoadPlatformDescription @platforms/cpus/stm32f103.repl
sysbus LoadELF @test/fixtures/testfw/testfw.elf
machine StartGdbServer 3333
start
```

`test/fixtures/testfw/` 是最小 Cortex-M3 固件（源码 + ELF + MAP），循环调用 `tick(n++)`，无外设依赖。

## 2. 启动 daemon

```powershell
node bin/dbghub.mjs serve --socket tcp://127.0.0.1:45733 --idle 0
```

> 生产环境默认命名管道/Unix socket；在 Windows 沙箱里 Node 命名管道可能被 EPERM 拒绝，所以测试用 `tcp://` 回环。

## 3. 跑 MCP 全链路

```powershell
node scripts/e2e-renode.mjs
```

期望输出：

```
✓ initialize 2025-06-18 dbghub
✓ tools/list discover,sessions,session_ctl,open,run,wait,state,break,inspect,eval,output,raw
✓ discover profiles=3 probes=0
✓ open ... stopped main ...
✓ break ...:6
✓ run breakpoint-hit tick:6 epoch=3
✓ state tick locals=2
✓ inspect frames 0:tick 1:main
✓ eval tick_count=... last_value=...
✓ inspect memory ...
✓ close exited
E2E PASS
```

## 4. 手动 MCP 调用示例

```jsonc
// open
{"profile":"renode","program":"test/fixtures/testfw/testfw.elf",
 "symbols":["test/fixtures/testfw/testfw.map"],"stop_at_entry":false}
// break / run / state
{"sid":"...","action":"set","spec":"tick"}
{"sid":"...","action":"continue","timeout_ms":15000}
{"sid":"...","detail":1}
// inspect
{"sid":"...","what":"frames","count":10}
{"sid":"...","what":"registers","count":8}
{"sid":"...","what":"memory","addr":"0x20000000","count":32}
{"sid":"...","what":"rtos","kind":"tasks"}   // Renode testfw 非 RTOS → E_RTOS_NOT_FOUND
```

## 真机（ST-LINK V2 + STM32F103C8，已验证）

1. `node scripts/hw-discover.mjs --doctor --scan` 确认 `stlink:0483:3748`、电压、DPIDR。
2. `open(profile="stm32f103-openocd", program=".../RelWithDebInfo/*.elf", symbols=["...map"], flash=true, stop_at_entry=true)`。
3. FreeRTOS 固件就绪后：`inspect(what="rtos", kind="tasks")`，单任务栈 `inspect(what="rtos", kind="stacks", task="wind_spd")`；HardFault 用 `inspect(what="fault")`。
4. 无复位附加：`open(..., mode="attach")`（不 flash，只 halt + 加载符号）。

注意：真实探针一次只能被一个进程占用；`discover --scan` 会短暂占用，测试前先关闭其它 OpenOCD/IDE 调试会话。
