# 系统体检页（Health）· v2 页面规范

> 覆盖 Master 的页面级规则；其余一切以 `MASTER.md` 为准。
> 设计系统里这张页面的「性格」最特殊：它**不修不改不动**，只把散在四五个系统工具里的
> 判断汇总到一处。所以它的第一原则不是「好看」，是**不撒谎**。

## 页面职责

回答一个问题：**这台机器整体还好吗**。

故障盘、待重启、报错设备、事件日志、上次是不是没好好关机 —— 原本要分别去
「优化驱动器」「Windows 更新」「设备管理器」「事件查看器」各看一处。

## 版式（目标）

```
┌ Plate: SYSTEM · HEALTH 体检结论 ─────────────────────── [⟳ 重新体检] ──────────┐
│ 只读体检 —— 不修、不改、不动任何系统设置。读数取自本机 WMI、事件日志与注册表。  │
│ ┌────────┬────────┬────────┬────────┐                                        │
│ │开机时长│ 待重启 │问题设备│  磁盘  │  有事的数字才用 warn 色                 │
│ │ 4d 6h  │   无   │   无   │  健康  │                                        │
│ └────────┴────────┴────────┴────────┘                                        │
│ 开机于 10-08 10:43 · 读于 17:24:05 · 3842ms                                    │
├ Bay: REBOOT 待重启 ──────────────────────────────────────────────────────────┤
│ 前两处是 Windows 自己写的「必须重启」标记；第三处只是文件队列，不是重启要求。    │
│     组件服务（CBS）        无                                                 │
│     系统装了一个组件更新，要重启才能收尾                                       │
│     Windows 更新           无                                                 │
│     Windows 更新在等一次重启                                                   │
│  ○  重启时待处理的文件  不必为此重启                                          │
│     8 个文件排队（12 条登记，有重复）                                          │
└──────────────────────────────────────────────────────────────────────────────┘
┌ Plate: STORAGE 磁盘健康 ────────────────────┬ Plate: EVENT LOG 事件日志摘要 ───┐
│ 只给健康档：SMART 磨损度与温度要另走厂商    │ 只取严重与错误两档，按来源聚合。  │
│ 接口，这一版没取。                          │  SYSTEM        近 7 天 · 16 条    │
│ ● NVMe SAMSUNG MZVLW256 系统盘      健康    │  Netwtw06 id 5010        8 次     │
│   固态硬盘 · NVMe · 238 GB · OK             │  Intel[R] Dual Band…  10-12 14:14│
├ Bay: DEVICE 报错设备 ───────────────────────┤  APPLICATION  近 7 天 · 189 条   │
│ 设备管理器里有错误码的设备。「已禁用」是你  │  .NET Runtime id 1000  182 次     │
│ 自己在设备管理器里关掉的。                  │  Category: BD.WTTS…   10-12 14:50│
│ ○ Sangfor aTrust VNIC        已禁用         ├ Bay: UNEXPECTED SHUTDOWN ────────┤
│   Net                        代码 22        │ 近 30 天里「没干净关机」的记录   │
│                                             │ ● 09-29 12:57 EventLog · id 6008 │
└─────────────────────────────────────────────┴──────────────────────────────────┘
```

两列的门槛是 **`lg`(1024px) 而不是 `xl`(1280px)**：默认窗口宽 1180px，写 `xl` 的话
这两列在默认尺寸下**永远不生效**，四格会一路竖着排下去。

## 零件用法

- 统计块四格（`health-stats`）：`StatGrid`（与启动项页同一个零件）。四个读数分别是
  开机时长 / 待重启 / 问题设备 / 磁盘，有事的走 `danger` 染 `warn`。
  **「无」「健康」不染绿** —— 走中性色（Master：颜色是信号不是装饰）。
- 待重启三行是**固定三项**（CBS / Windows 更新 / 待处理文件），恒显示，`clear` 档不亮灯。
  恒显示而不隐藏空项：这三项合起来才叫「待重启」，只显示有事的会让用户以为这一节坏了。
- 磁盘行：`Lamp` + 名字 + 「系统盘」微标签 + 副行（介质 · 总线 · 容量 · 运行状态，走 `.num`）+ 右侧健康档。
- 设备行：`Lamp` + 名字 + 类别 + 右侧「已禁用 / 有问题」+ 代码。**WMI 的 `Status` 对已禁用设备也报 `Error`**，
  所以它只留在 `title` 里，不摆到面上误导。
- 日志按 `provider` 聚合，块头写**统计窗口**（「近 7 天」）—— 不写窗口，「16 条」没有意义。
- 意外关机的正文用**系统自己的原话**，不另作解释（原文可能很长，`title` 里给全量）。

## 五条判定（改动前必读）

- **待处理文件队列不是「要求重启」。** `PendingFileRenameOperations` 常被当成重启标记，但
  实测本机 24 个槽位（12 条操作，配对里的空串是「目标为空」即删除）里实打实只有 8 个文件，
  而 `.atrust.running` 被登记了 **3 次**、`force_show` **3 次** —— 同一个操作重复登记，
  说明写队列的应用（Sangfor aTrust、腾讯 TAO、几个 `~$Kvp` 临时文件）只是用
  `MoveFileEx(MOVEFILE_DELAY_UNTIL_REBOOT)` 排了个「下次开机顺手删」，
  根本不是重启要求。按「有 N 条待替换文件 ⇒ 要求重启」报警，等于叫用户白重启一次。
  → 只有 CBS 与 Windows 更新两处注册表键算 `required`，这一项**永远**是 `advisory`。
- **「已禁用」设备不算故障**（同一套纪律第五次出现）。`CM_PROB_DISABLED = 22` 是唯一表示
  「用户自己在设备管理器里关掉」的码。三条本机证据：① 设备管理器里那块 Sangfor aTrust VNIC
  的 Problem 就是 22；② 系统自带的 `pnputil /enum-devices /problem` 报
  「No devices were found on the system.」—— **Windows 自己也不把被禁用的设备算作问题设备**；
  ③ `PnpDevice.Types.ps1xml` 的 CM_PROB 全表里，`DISABLED` 之外还有 `HARDWARE_DISABLED`(29)
  与 `DISABLED_SERVICE`(32) —— 那两个是「BIOS 里关了」「驱动服务被禁了」，属**真问题**，
  不能一起并进这一档。**所以只认 22，多一个都不认。**
- **设备枚举必须走 `Win32_PnPEntity`，不能走 `Get-PnpDevice`。** 前者只枚举**在位**设备，
  比 `Get-PnpDevice -PresentOnly` 又快又对（本机 2123ms vs 5301ms）。不带 `-PresentOnly` 的
  `Get-PnpDevice` 本机 443 台里 270 台是 `CM_PROB_PHANTOM` 幽灵设备（拔掉的罗技鼠标、
  用过的 USB 硬盘盒、外接显示器……），一按 `Problem <> 0` 过滤就是 **271 个假警报**，
  这一页会彻底废掉。对照：`Win32_PnPEntity` 总数 173 === `Get-PnpDevice -PresentOnly` 的 173。
- **磁盘健康只有 1 分（`HealthStatus === 0`）才算通过。** `null`（读不到）与 `5`（Unknown）
  都不算 —— 「没读到」和「健康」是两件事，把前者当后者会让体检报告给出一个它并不知道的结论。
  界面上「读不到」与「未知」也分开写：前者是我们没取到，后者是系统说不清。
- **拿不到就说拿不到。** SMART 磨损度与温度在本机读不出来
  （`Get-StorageReliabilityCounter` 报「无法使用指定的命名参数解析参数集」、
  `MSStorageDriver_FailurePredictStatus` 报「不支持」），所以这一页只给粗粒度健康档，
  并在界面上把这件事写出来。宁可少一个读数，不编一个读数。

## 枚举映射的权威来源（别凭记忆写）

四张磁盘表与设备错误码都取自**本机的定义文件**，不是文档默写：

| 属性 | 文件 | 段 |
|------|------|-----|
| `MSFT_PhysicalDisk.HealthStatus` | `…\Modules\Storage\Storage.types.ps1xml` | 第 757 行 |
| `MSFT_PhysicalDisk.MediaType` | 同上 | 第 856 行 |
| `MSFT_PhysicalDisk.BusType` | 同上 | 第 770 行 |
| `MSFT_PhysicalDisk.OperationalStatus` | 同上 | 第 689 行（34 项） |
| CM_PROB 符号名 | `…\Modules\PnpDevice\PnpDevice.Types.ps1xml` | 第 34–254 行 |

**两个踩过的坑，写在这里免得重犯：**

1. `Storage.types.ps1xml` 里有 **18 个类**各带一份 `OperationalStatus`，内容**互不相同**：
   `MSFT_Disk` 是 `53264=Online` 那套，`MSFT_VirtualDisk` 是 `53252=Failed Media` 那套，
   `MSFT_PhysicalDisk` 又是另一套。**抓错属主就等于把别的类的码表贴到这块盘上。**
   自检里钉了一条断言：`diskOperationalText([53264]) === '原始值 53264'`。
2. 用正则从 ps1xml 里抠 `switch` 时，正则必须写在 PowerShell 的**单引号**字符串里 ——
   双引号里 `$_status` 会被当变量展开成空串，正则静默失配、结果全是 0 项，
   看起来像「本机没有这张表」（真踩过，白绕了一圈）。

**认不出的枚举值显示原始数字，不猜名字。** 这里刻意不照抄 Windows 自己的行为：
ps1xml 里 `OperationalStatus` 的 `Default { "Unknown" }` 分支**漏了 `+=`**，
结果被丢进管道，实际渲染出一个空字符串（微软自己文件里的笔误）。我们这边
`原始值 53299` 虽然不好看，但用户拿着这个数字能搜到东西；「Unknown」是条死路。

## 性能：为什么切成四段并发

全量串行在本机量到 **11.1 秒**（PowerShell 进程冷启动 5×0.65s + 设备枚举 3.7s +
磁盘 1.07s + 开机时刻 1.28s，各算各的）。四段之间没有任何依赖，并发跑（`Promise.allSettled`）
之后墙钟取决于最慢的那一段：**3.8 秒**。

四段的取数路径都是量过的：

| 段 | 取数 | 本机耗时 |
|----|------|---------|
| 开机与待重启 | `Win32_OperatingSystem.LastBootUpTime` + 两处注册表键 + `Session Manager` | — |
| 磁盘 | `MSFT_PhysicalDisk`（CIM 直查），`Get-PhysicalDisk` 要 4.73s | 615ms |
| 设备 | `Win32_PnPEntity -Filter "ConfigManagerErrorCode <> 0"`，`Get-PnpDevice -PresentOnly` 要 5301ms | 2123ms |
| 事件日志 | `Get-WinEvent -FilterHashtable`（服务端过滤）+ `Group-Object` 在 PowerShell 侧先聚合 | — |

**开机时刻不走 Node 的 `os.uptime()` 反推**：本机两者吻合到 4 秒内，但 `os.uptime()` 算的是
时钟运行时长，睡眠 / 休眠之后会偏 —— 开机时刻是「这台机器稳不稳」的基准读数，值得为权威值付一次 WMI。

**日志有采集上限**（`LOG_CAP = 1000` / 条）：一台刷屏的机器能在 7 天里堆出几十万条。
落到上限时 `truncated = true`，界面按 **`≥N`** 呈现 —— 设了上限还报精确值就是在说谎。

**脚本必须设 `$ProgressPreference = "SilentlyContinue"`**：首次使用某个模块时 PowerShell
会往 stderr 写 CLIXML 进度记录（「正在准备首次使用模块。」），调用方看到非空 stderr
会把它当成错误文本（写探针时踩过）。

## 刻意不做的事

- **不加侧栏徽标。** 它的数据要起四段 PowerShell（本机 3.8 秒，是全应用最贵的一份），
  而侧栏每分钟刷一次 —— 挂上去等于每分钟白跑一次重活。而且它管的是按天变的东西。
  这不是「忘了加」，是有意的取舍（`useSidebarStatus.ts` 里有同样的注释）。**别在下一批顺手补上。**
- **不做修复动作。** 这一版只读：不重启、不启用/禁用设备、不删日志。第一原则是不撒谎，
  第二原则是不越界。

## e2e 契约（不许动）

- 元素：`health-view`（`data-state` = `loading` / `ready` / `error`）、
  `health-stats`（`data-uptime` / `data-reboot` / `data-device-problems` / `data-device-disabled` /
  `data-disks` / `data-bad-disks` / `data-logs` / `data-crashes`）、`health-refresh`、
  `health-reboot`、`reboot-row`（`data-source` / `data-level`）、
  `health-disks`、`disk-row`（`data-name` / `data-system` / `data-health`）、
  `health-devices`、`device-row`（`data-level` / `data-code` / `data-name`）、
  `health-logs`、`log-block`（`data-log` / `data-total` / `data-window` / `data-providers` / `data-truncated`）、
  `log-provider`（`data-name` / `data-count`）、`health-crashes`、`crash-row`（`data-id` / `data-source`）。
- 结构（断言的是**关系**，不是机器相关的数字）：
  `data-reboot` === `reboot-row[data-level="required"]` 的行数；
  `disk-row` 数 === `data-disks`；`data-bad-disks` === 健康档非 `0` 的盘数；
  `device-row` 数 === `data-device-problems` + `data-device-disabled`；
  `log-provider` 行数 === 各 `log-block` 的 `data-providers` 之和；
  `data-crashes` === `crash-row` 行数，且每行的 `data-id` ∈ {41, 6008}。
- **关键回归**（每条都对应一次真实踩坑）：
  `reboot-row[data-source="file-rename"]` 的 `data-level` **永不等于** `required`；
  `disk-row` 的 `data-health` ∈ {`none`,`0`,`1`,`2`,`5`}；
  `device-row` 的 `data-code` 都是正整数。
- 截图两张：`screen-health`（首屏）与 `screen-health-logs`（滚到底）。
  **首屏之下的部分必须单独截一次** —— 断言全绿和「这一页好不好看」是两件事，
  facts 取得到数据，取不到「渲染出来是不是一团糊」。

## 本机实测结论（2026-10-12）

- 耗时 **3842ms**，要求重启 **0** 处（CBS / WU 都没标记）
- 待处理文件 8 个（12 条登记，有重复）→ `advisory`
- 磁盘 1 块：`NVMe SAMSUNG MZVLW256`（系统盘）256GB · 健康 · 固态硬盘 · NVMe · OK
- 设备 1 台：`Sangfor aTrust VNIC / Net / 代码 22` → **disabled**（不算异常）
- System 近 7 天 16 条 / 5 个来源（`Netwtw06` ×8 —— Intel 无线网卡驱动反复报）
- Application 近 7 天 189 条 / 5 个来源（`.NET Runtime` ×182 —— Steam++ 在刷日志）
- 意外关机 2 次（30 天）：`09-29 12:56 Kernel-Power 41` + `09-29 12:57 EventLog 6008`
