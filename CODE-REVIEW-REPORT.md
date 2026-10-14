# ops-cabin 代码审查报告

- 项目：ops-cabin 运维舱（Electron 43 + React 19 + TypeScript 5.9 + electron-vite 5），版本 0.3.0
- 审查范围：`src/` 与 `scripts/` 全量受版本控制源码（136 个文件、约 2.08 万行）。工作树干净、无未提交改动，因此做全量审查而非 diff 审查
- 审查方式：按风险面分 6 路并行审查 → 对「阻断 / 高 / 中」级别条目逐条回验（共 32 个子代理）
- 结论：**47 条问题（阻断 0 / 高 6 / 中 20 / 低 21），回验否定 0 条**
- 基线事实：`pnpm typecheck`（双 tsconfig）当前**通过**（exit 0）；全仓 `any` / `as any` / `@ts-ignore` 仅 1 处（`src/main/scanner/worker.ts:24`，属必要的 Electron 类型补丁）——类型层面这个项目是干净的

> 关于「回验」列：高/中级别条目由独立复核员重读源码逐条核对（含实际复现），结果标为「已复核成立」或「部分成立」；低级别条目未做二次复核。
> 标 ⚠ 的条目，其详情文字未能从审查进程的缓冲中完整取回，此处保留该审查者给出的一句话结论与其定位，正文描述为重建，精确代码位置可直接打开对应文件核对。

---

## 修复进展（2026-10-14）

**47 条的最终去向**：**已修 41 条**（含 5 条高级别）、**实测后主动回退 1 条**（#7 沙箱，见文末）、**明示不做 4 条**（#22 / #26 / #30 / #31，均需设计决策或发布环境）、**重复记录 1 条**（#46 是 #7 的重复条目）。

验证方式：每批都跑 `pnpm typecheck` + `pnpm build`（全绿）与项目自带的 e2e；另有针对性回归断言 **156 项**全部通过（第一批 28、第二批 38、第三批 35、第四批 55；按各次运行打印的 `PASS n / FAIL 0` 累计）。

### 第一批（10 条，含 5 条高级别）

| 问题 | 级别 | 状态 | 关键改动 |
| --- | --- | --- | --- |
| #3 结束进程假报成功 | 高 | ✅ 已修 | `ports/kill.ts`：`isAlive` 只在 `ESRCH` 时判「已退出」，`EPERM` 等一律按存活；接入 taskkill 的 `code`/`output` 并把原因归类成可读文案；输出改按 GBK 解码（原来按 UTF-8 解，中文关键词根本匹配不上） |
| #6 / #9 路径判据误判失效 | 高 | ✅ 已修 | `execpath.ts`：引入三态 `PathVerdict`（exists / missing / unknown）；去掉「最多 5 段」上限；区分文件与目录；`EPERM` 归 unknown。**只有 `missing` 才解锁删除** |
| #1 提权助手未绑定调用 | 高 | ✅ 已修（部分） | `helper.ts`：校验 `payload.nonce` 与文件名里的 32 位 hex **相等**（原先只验形态）；`elevate.ts`：请求文件改 `'wx' + 0o600` 独占创建，已存在即中止。**TOCTOU 那半边仍未根治**（需把参数挪到命令行），威胁模型已如实写入注释 |
| #4 / #5 服务采集 | 高 | ✅ 已修 | `services/collect.ts`：服务名改 base64 传数据（`MSSQL$SQLEXPRESS` 不再被 PowerShell 吃掉 `$`）；过滤失败自动回落全量查询（一个畸形名字不再拖累整批）；采集失败返回空数组而非「每个服务都 missing」，让上游保留基线的守卫真正生效 |
| #2 可删集合语义不一致 | 高 | ✅ 已修 | `cleaner.ts`：`registerScanned` 改并集语义（界面按组保留的行仍然可删）；`DiskView.tsx` 标注两侧契约 |
| #19 / #37 启动项判据 | 中/低 | ✅ 已修 | `startup.ts`：文件夹来源改为读取 .lnk 的 `TargetPath` 再判存在性（不再拿「快捷方式在不在」当「程序在不在」）；排除两个启动文件夹里的 `desktop.ini` |
| #23 CI 无日常门禁 | 中 | ✅ 已修 | 新增 `.github/workflows/ci.yml`：push / PR 上跑 typecheck + build + e2e 脚本语法检查（`release.yml` 仍只在 tag 触发） |
| 新增 | — | ✅ 已修 | 10 个 e2e 脚本未清 `ELECTRON_RUN_AS_NODE`（宿主环境带这个变量会让 electron 退化成纯 Node，表现为「应用未能在限定时间内完成加载」）；`e2e-smoke.mjs` 早已处理，其余 10 个现已同步 |

### 第二批（24 条，其中 1 条后来回退）

| 问题 | 级别 | 状态 | 关键改动 |
| --- | --- | --- | --- |
| #7 渲染进程无沙箱 | 中 | ⚠️ **已回退**（见下方说明） | 曾改为 `sandbox: true`；实测发现它会让渲染层的 `window.close()` 变成「销毁窗口」（可取消的 `close` 事件根本不发，主进程无法 `preventDefault`），破坏了「关窗 = 隐藏」的契约并使 `e2e-check` 挂死。已回退成 `false`，并把实测结论写进代码注释。preload 本身满足沙箱化前提，要启用需作为独立决定 |
| #8 / #25 导航白名单过宽 | 中 | ✅ 已修 | 改成「入口文档精确比对」（去 hash/query），不再放行整个 `file:` 协议；dev 分支也从裸前缀匹配改为同源比对（`http://localhost:5173@evil.com/` 不再命中），并加 `!app.isPackaged` |
| #8（配套）IPC 无来源校验 | 中 | ✅ 已修 | 新增统一的 `handle()` 包装（51 处 handler 全部改用）：比对 `senderFrame.url` 与入口文档，非应用页面一律拒绝。用统一入口而非逐处手写，避免漏改 |
| #10 白名单不挡祖先 | 中 | ✅ 已修 | 新增 `coversExcluded()`：候选**包含**白名单目录时剔除（`%TEMP%` 与 `%TEMP%\keep` 这对经典组合已实测拦截）；扫描端与清理端各一道 |
| #11 cleaner 路径未转义 | 中 | ✅ 已修 | 清单文件路径改经**环境变量**传入（`runPowerShell` 增加 `env` 参数），不再拼脚本源码。实测：含单引号路径旧做法要么解析失败（1 个引号、退出码 1），要么**退出码 0 但内容读错**（2 个引号）—— 后者更隐蔽，已如实记录 |
| #12 cleaner 异常穿透 | 中 | ✅ 已修 | `writeFileSync` 收入 try 并返回逐项失败；临时清单名加随机后缀；函数保证「永远回 `CleanFailure[]`」 |
| #13 pnpm 候选越界 | 中 | ✅ 已修 | 候选从 `%LOCALAPPDATA%\pnpm`（含 `.tools` 工具链的父目录）改为 `%LOCALAPPDATA%\pnpm\store` 等真实 store 位置 |
| #14 端口首采不互斥 | 中 | ✅ 已修 | `ports/watch.ts`：互斥判据从「`#latest` 存在」改为 `#inflight`，首采期间不再并发跑两遍 netstat |
| #15 kill 不看快照新旧 | 中 | ✅ 已修 | `ports:kill` 增加快照年龄校验（上限 30s），过期一律拒绝并提示刷新——防 PID 复用误杀 |
| #16 订阅计数无兜底 | 中 | ✅ 已修 | 新增 `resetSubscribers()`，在 `render-process-gone` / `destroyed` 时清零（端口与指标两处），页面异常卸载不再让采集永久常驻 |
| #17 服务基线被推迟 | 中 | ✅ 已修 | `services/monitor.ts`：`syncNow()` 改为「等在飞的一拍结束再补一拍」，不再把新关注项的基线静默推迟 60 秒 |
| #18 进程表被空表覆盖 | 中 | ✅ 已修 | `processes.ts`：JSON 解析失败改为**抛出**（原先返回空表），让「保留旧表」的 catch 真正生效——「读不到」不再伪装成「没有」 |
| #21 任务状态码缺失 | 中 | ✅ 已修 | `shared/tasks.ts`：补齐 `0x41305/0x41306/0x41307/0x41308/0x41325`（依据 [WinError.h 官方表](https://learn.microsoft.com/windows/win32/taskschd/task-scheduler-error-and-success-constants)）；并新增 **HRESULT bit31 判定**——本机实测 `0x10000000`（BitLocker 任务）原被误报「失败」，现按成功级处理。13 项断言全部通过 |
| #27 侧栏注释与代码不符 | 低 | ✅ 已修 | 注释改为与实际 TTL（30s）一致 |
| #28 启动链无 catch | 低 | ✅ 已修 | `whenReady().then(...)` 补 `.catch`：记录原因、弹错误框、`app.exit(1)`，不再「双击无反应且无日志」；另加 `unhandledRejection` 日志（**刻意不接管** `uncaughtException`——那会把真崩溃变成带坏状态继续跑） |
| #29 elevate finally 抛错 | 低 | ✅ 已修 | `rmSync` 各自 try 包住：清理失败不再把**已经成功**的提权结果替换成异常 |
| #32 扫描链无超时 | 低 | ✅ 已修 | `Scanner.start` 加 10 分钟兜底超时，worker 卡死不再让进度条永远转 |
| #33 路径表示形式混用 | 低 | ✅ 已修 | `#veto` 统一用 `normalizeForCompare` 归一后再比对 |
| #34 watch dispose 无标志 | 低 | ✅ 已修 | 新增 `#disposed`，`dispose()` 后 `#schedule` 不再重排定时器（在飞的一拍不会复活它） |
| #38 任务删除无回读 | 低 | ✅ 已修 | `deleteTask` 在退出码 0 后追加 `/Query` 回读：仍存在则不谎报成功（与启动项删除的回读校验同口径） |
| #40 通知引用丢失 | 低 | ✅ 已修 | `notify.ts`：`#active` 单字段改为 `#recent` Set（上限 8）——先弹的那条不再因第二条出现而失去点击回调 |
| #41 侧栏无 catch | 低 | ✅ 已修 | 5 个拉取调用统一走 `guard()`，reject 不再变成渲染层 unhandled rejection |
| #42 volumes 漏总量校验 | 低 | ✅ 已修 | 回退路径补 `total <= 0` 校验，与快路径同口径 |
| #43 趋势点可能乱序 | 低 | ✅ 已修 | `trend.ts`：`#append` 追加后显式按 `at` 排序，系统时间回拨不再让折线往回拐 |

### 第三批（1 条，抽公共工厂）

| 问题 | 级别 | 状态 | 关键改动 |
| --- | --- | --- | --- |
| #24 四份采集器行为分叉、`degraded` 被丢弃 | 中 | ✅ 已修 | 新增 `src/main/cached.ts` 的 `createCachedCollector`：TTL、并发合流、失败降级、**按输入指纹自动失效缓存** 只有一套实现；四份采集（启动项/关注服务/计划任务/体检）全部改用它，手写的四份缓存变量与 in-flight 变量、以及三处 `servicesCache = null` 全部消失 |

**#24 连带修掉的两处**（原报告只点了「`degraded` 被丢弃」，实际后果比描述更重）：

1. **`services:status` 改成返回 `ServiceStatusReport`**（`{ at, items, degraded, error? }`）。原先返回裸数组，采集失败与「没有关注项」在界面上同形 —— 服务面板会对着空列表印出「N 个关注 · 全部在跑」（**一次采集失败被显示成一切正常**），侧栏也把「读不到」显示成中性读数。这条正好是 `shared/services.ts` 自己写明的意图：「它该在『读不到』这条路上被说出来，而不是在这里」—— 那条路被采集层丢掉了。现在面板说「状态读不到（原因）」，侧栏徽标说「服务状态读不到」。
2. **采集失败的原因不再被 `catch {` 丢弃**（`services/collect.ts`）：`degraded: true` 现在带 `error`，界面能说出为什么读不到（例如 `spawn powershell.exe ENOENT`），否则用户无从判断是自己机器上 PowerShell 被策略挡了还是应用出了问题。

顺带把 `ServiceMonitor` 的「这一拍没读到」判据从「空数组 + 有清单」的推断改为 `degraded` 权威标志（保留原推断作兜底）。

### 第四批（4 条低级别，收尾；另更正 2 条此前误记为未修）

| 问题 | 级别 | 状态 | 关键改动 |
| --- | --- | --- | --- |
| #35 优雅结束只睡固定 800ms | 低 | ✅ 已修 | `ports/kill.ts`：改成**轮询进程真实状态**（`waitForExit`），退出即返回；并且**只在该等的时候才等** —— taskkill 报成功才进等待窗，它明确回「只能强制终止」时只瞬查一次 |
| #36 同号 TCP/UDP 只认一条 | 低 | ✅ 已修 | `shared/ports.ts` 新增 `describePortOccupants`：一个端口的占用者按**协议算全**（描述带协议前缀、顺序稳定）。基线与变化检测共用它，之前两处各写一遍 `entries.find(...)` 正是漏掉 UDP 的根因 |
| #39 六个 Run 键共用一张审核位表 | 低 | ✅ 已修 | `startup.ts`：StartupApproved 改成**每键一张表**（`$approvedByKey`），并把审核位路径挂在每个来源上；同时不再读 HKCU 的 `StartupApproved\Run32`（它对应本采集器不枚举的 Run 键，读进来只会撞名） |
| #47 「托盘没建起来就退出」不可达 | 低 | ✅ 已修 | 判据从 `if (!tray)` 改为 `if (!trayUsable())`（`tray` 非空不代表托盘可见：图标加载失败时 Electron 不抛异常，只表现为托盘区空白）；`TrayController.isUsable()` 暴露「图标非空」；窗口关闭在托盘不可用时**放行**，这条兜底才真正接得上 |

**同时更正上一版报告里的两处误记**：#44（`formatClock` 挡无效输入）、#45（`services:update` 的 `as SettingsStore` 绕过空值保护）**在第二批已顺手修掉**，却被我列进了「未修」清单；#46 是 #7（沙箱）的重复记录，随 #7 一并了结。

---

**未修的部分**（如实记录，共 5 条）：

- **#7 沙箱 —— 试过并主动回退**。开启 `sandbox: true` 后实测：渲染层的 `window.close()` 会**直接销毁窗口**，事件序列是 `webContents destroyed` → `win closed event` —— 可取消的 `close` 事件根本不发，主进程没有机会 `preventDefault`。而本应用的窗口契约是「关窗 = 隐藏、托盘常驻」，这条路径无法拦截。对照实验干净（同一份代码只切这一个布尔值，行为翻转）。影响面：真实交互（标题栏按钮走 `win:close` IPC）在两种设置下都正确，受影响的是渲染层里任何 `window.close()` —— 源码里没有，但项目自带的 `e2e-check.mjs` 正是用它模拟「点关闭按钮」，打开沙箱后那条套件**会挂死**（它的 `listTargets() !== null` 断言在目标为空数组时还会假通过，随后在第 286 行的 `visibilityState` 上永久等待）。我选择回退并把结论写进代码注释，而不是顺手改测试去迁就它：要启用沙箱应当是一次独立决定 —— 确认渲染层不再有 `window.close()`、把 `e2e-check` 改成驱动真实路径、并接受「窗口被销毁后由托盘唤回」这一形态。
- **#22** 更新包缺 Authenticode 验签（需引入验签依赖或改发布流程，是取舍不是改代码）、**#26** 更新链路无自动化（需真实下载/安装环境）、**#30** 提权超时残留、**#31** 按用户安装的落点与签名（涉及发布策略，要你定）。

**验证补充**：#24 这批除两套 e2e 外，另做了两组针对性验证 ——
① 工厂语义 16 项断言（TTL 命中/force 绕开/三请求合流/首采期 force 也合流/失败不缓存/恢复即取真值/指纹变更失效/**在飞期间换指纹不冒充新指纹的缓存**）；
② 降级路径端到端 19 项断言：用**受限 PATH 让 `spawn('powershell.exe')` 真实失败（ENOENT）**复现「PowerShell 不可用/被策略挡下」，走完整链路（采集失败 → 工厂 fallback → IPC → preload → 面板与侧栏）核对界面是否说真话；并用正常 PATH 跑对照组，证明降级分支不是恒真。

第四批的验证同样是端到端而非走查（44 项断言）：**#36** 把 `collectPorts` 换成桩、驱动真实的 `PortsMonitor`，证明「TCP 不动、UDP 侧换人/消失」现在会被检出（旧实现只看排序后的第一条）；**#39** 在真实注册表里造出「同一名字同时出现在 HKCU\Run 与用户启动文件夹」的场景，断言两条的启用位**不一致**——用一张共享表时它们必然相同，所以这就是决定性判据，跑完夹具已完整还原（注册表与快捷方式均无残留、条目数回到 12）；**#47** 用「临时 app 目录 + `main` 指向真实构建产物、但 resources 里不放 tray.png」制造出真实的「托盘图标为空」，**不碰任何被 git 跟踪的文件**，两个分支各跑一遍（可用→关窗只隐藏、进程常驻；不可用→关窗后确实退出），主进程诊断日志佐证因果链；**#35** 用自校准基准（先单独量出两段 taskkill 的自身耗时）避免了绝对阈值——实测这台机器上 taskkill 自身就要 0.9–2.0 秒，耗时大头根本不是等待窗。

**修复过程中的四点如实说明**：
1. 改动 `services/collect.ts` 时我一度引入回归（全量服务查询返回 0 条），用 HEAD 版对照裁决定位到是 `+ $FS +` 拼接在某些管道形态下吞掉分隔符，已改用数组 `-join` 并复测。
2. 报告第四节里我原先自己提出的 S1、S3 两条经复核不成立，已在正文标注撤回。
3. 上一轮 e2e 失败的根因是**宿主环境的 `ELECTRON_RUN_AS_NODE=1`**，与代码改动无关（已用 HEAD 版对照验证同样崩溃），并据此补齐了 10 个 e2e 脚本的环境清理。
4. #35 我第一次改得**更慢**了：把优雅窗口从 800ms 拉到 1200ms，而无窗口进程的优雅请求注定失败，于是每次都白等那一整窗。是我自己加的验证把它抓出来的（实测 2056ms），随后改成「由 taskkill 的答复决定要不要等」。
5. **我引入过一次真实回归，并已定位与修复**：第二批开启的 `sandbox: true` 让渲染层 `window.close()` 变成销毁窗口（详见文末 #7 的说明）。它是被第四批的完整 e2e 扫出来的 —— `e2e-check` 卡死 30 分钟，我一度以为是自己那轮改坏，用 HEAD 对照 + 二分才把元凶钉到沙箱这个布尔值上。教训是：**沙箱这类「一行开关」的改动必须跑完整个 e2e 套件**，因为它改变的是渲染层与主进程之间的基础行为，而不是某个功能点。

**关于 #36 的一处额外影响**：新的 `describePortOccupants` 让跨协议的占用者描述变长（如 `TCP System (PID 4)；UDP svchost.exe (PID 1234)`），这会出现在变化提醒的正文里。这是有意为之 —— 一个端口在两个协议上被不同进程占用时，只报其中一个会让人按错误的 PID 去找进程。

### 收尾时补跑全套 e2e 的结果（如实记录）

前四批都只跑了与改动相关的套件；收尾时把 11 个 e2e 脚本全跑了一遍，结果如下（均在最终代码上）：

| 套件 | 结果 |
| --- | --- |
| `e2e-check` | ✅ 15/15（**这条尤其重要**：它曾因我开启沙箱而挂死 30 分钟，回退后恢复） |
| `e2e-smoke` / `e2e-autostart` / `e2e-ports` / `e2e-ports-m5` / `e2e-overview` / `e2e-settings` / `e2e-update` / `e2e-disk` | ✅ 全部通过 |
| `e2e-scan` | ❌ **既有失败，与本次改动无关** |

两点需要说明：

1. **`e2e-ports` 与 `e2e-disk` 对负载敏感**：连跑 9 套时会各失败 1–2 项，单独跑则全绿。它们起真实 TCP 服务器并按 netstat 对账、有基于时间的断言，在机器忙时不稳。所以「一次性连跑全套」不是可靠的验收方式 —— 逐套跑才准。
2. **`e2e-scan` 的失败是既有的**（这是一个**本次审查未覆盖的新发现**）：根因是 `扫描进程意外退出（code=0）` —— scanner 的 utilityProcess 干净退出却没有回 `done`，导致 largeFiles 那一段的 6 个断言连带失败。**用 HEAD 原版对照同样失败（甚至更多，7 项）**，所以与本次改动无关；而且它本身也不稳定（同样代码两次跑，失败项在 4–7 之间浮动）。这条值得单独排一次：症状是 `Scanner` 收到 `exit` 而非 `done`，而退出码是 0，说明 worker 是「正常结束但没报结果」——`src/main/scanner/worker.ts` 的成功路径上大概还有一条不发 `done` 的出口。

---

## 一、问题总览

| # | 级别 | 位置 | 结论 | 回验 |
| --- | --- | --- | --- | --- |
| 1 | 高 | `src/main/elevate.ts:41-45` | 提权助手信任的是「%TEMP% 里一个文件名符合约定、内容结构合法的 JSON 文件」，没有任何校验把它绑定到发起提权的那次调用 | 已复核成立 |
| 2 | 高 | `src/main/cleaner.ts:74-76` | 可删集合是「整体替换」语义，而渲染层是「按组替换、其余保留」，两侧不一致导致界面上可勾选的项被主进程确定性拒绝 | 已复核成立 |
| 3 | 高 | `src/main/ports/kill.ts:34-41, 48-57` | `isAlive()` 把 `process.kill(pid, 0)` 的任何异常都当成「已退出」，而 Windows 上无权限目标是 EPERM——结束进程会假报成功 | 已复核成立 |
| 4 | 高 | `src/main/services/collect.ts:19-21, 36, 91` | 服务名只做 WQL 单引号转义，却插进 PowerShell **双引号字符串源码**，`$` 与反引号会被 PowerShell 解析层吃掉 | 已复核成立 |
| 5 | 高 | `src/main/services/collect.ts:94-98, 101-113` | 采集失败被吞成 `degraded`，随后把所有关注服务伪装成 `missing:true`，触发一轮假「服务消失」告警 | 已复核成立 |
| 6 | 高 | `src/main/execpath.ts:40-43` | 未加引号的命令「逐段加长试存在性」写死最多 5 段，段数超标时退回截断片段，把正常自启项误判为失效并解锁删除 | 已复核成立 |
| 7 | 中 | `src/main/index.ts:389-394` | 渲染进程显式关闭 Chromium 沙箱（`sandbox: false`），且仓库内无任何理由说明 | 已复核成立 |
| 8 | 中 | `src/main/index.ts:347-354` | 导航白名单放行**任意** `file://`，且 51 个 IPC handler 全都不校验来源 | 已复核成立 |
| 9 | 中 | `src/main/execpath.ts:38-44` | 与 #6 同源：段数上限使「逐段加长」退化为「取第一个空格前的内容」；另有目录被当作程序存在的漏报面 | 已复核成立 |
| 10 | 中 | `src/main/scanner/categories.ts:203-210` | `isExcluded` 不判定「路径是白名单目录的祖先」，白名单子目录会被连父目录一起删掉 | 已复核成立 |
| 11 | 中 | `src/main/cleaner.ts:163-164, 195` | 临时清单文件路径未转义就拼进 PowerShell 单引号字符串，路径含单引号（如 `C:\Users\O'Brien\...`）时清理 100% 失败 | 已复核成立 |
| 12 | 中 | `src/main/cleaner.ts:163-164, 203-215` | `writeFileSync` 在 `try` 之外，抛错会穿透成渲染层 unhandled rejection，用户看不到任何提示 | 已复核成立 |
| 13 ⚠ | 中 | `src/main/scanner/categories.ts:105-110` | `%LOCALAPPDATA%\pnpm` 是 store 的父目录而非 store 本身，清理范围超出标注的「pnpm 存储」 | 已复核成立 |
| 14 ⚠ | 中 | `src/main/ports/watch.ts:135-147` | `#busy` 只在 `#latest` 已存在时互斥，首采期间第二次调用会重复跑一遍完整采集 | 已复核成立 |
| 15 ⚠ | 中 | `src/main/index.ts:704-718` | `ports:kill` 只按 PID 校验，不看快照有多旧；采集连续失败时快照可任意陈旧，PID 复用会误杀 | 已复核成立 |
| 16 ⚠ | 中 | `src/main/ports/watch.ts:94-97, 116-124` | 订阅者计数完全依赖渲染层成对调用，主进程侧无兜底；页面异常卸载则采集永不停止 | 已复核成立 |
| 17 ⚠ | 中 | `src/main/services/monitor.ts:182-184, 191-195` | `syncNow()` 撞上 `#busy` 时只是把下一拍推到 60s 后，新关注服务的基线建立被静默推迟 | 已复核成立 |
| 18 ⚠ | 中 | `src/main/processes.ts:182-197` | 只有抛异常才保留旧表；PowerShell 退出码 0 但不是预期 JSON 时，旧表被空表覆盖 | 已复核成立 |
| 19 ⚠ | 中 | `src/main/startup.ts:76, 112-113, 156` | 文件夹来源的 `command` 是 .lnk 自身路径，用「.lnk 在不在」当「程序在不在」，且该字段同时是删除闸门 | 已复核成立 |
| 20 ⚠ | 中 | `src/main/execpath.ts:37-39` | 候选判定用 `existsSync` 不区分文件与目录，「目录在」=「程序在」 | 已复核成立 |
| 21 ⚠ | 中 | `src/shared/tasks.ts:150-157, 176` | 状态表缺官方 `SCHED_S_` 0x41305（NOT_SCHEDULED）、0x41306（TERMINATED，267014）等，落到兜底分支 | 已复核成立 |
| 22 ⚠ | 中 | `src/main/updater.ts:102-106` | 更新包在本机没有 Authenticode 签名校验，完整性只锚在 latest.yml 的 sha512 | 已复核成立 |
| 23 | 中 | `.github/workflows/release.yml:8-11, 41-42` | 唯一 CI 只在打 tag 时触发，只跑 typecheck + dist；11–12 个 e2e 脚本没有任何自动化入口 | 已复核成立 |
| 24 ⚠ | 中 | `src/main/index.ts:177-206` | 四份复制粘贴的「TTL 缓存 + 并发合流」采集器行为分叉，`degraded` 被丢弃（第 188 行） | 部分成立 |
| 25 ⚠ | 中 | `src/main/index.ts:347-354` | 与 #8 同一处：任何 `file://` 都在白名单里，含用户下载目录里的任意 .html | 未复核 |
| 26 ⚠ | 中 | `scripts/e2e-portable.mjs:152` | 更新链路的自动化验证停留在「文件存在性 + 假版本注入」，真实下载/校验/安装链路无自动化 | 未复核 |
| 27 ⚠ | 低 | `src/renderer/components/layout/useSidebarStatus.ts:23-25` | 侧栏成本模型注释与代码不符（自启项缓存 TTL 实为 30s） | 已复核成立 |
| 28 ⚠ | 低 | `src/main/index.ts:851-852` | 整条启动链（`whenReady().then(...)`）无 `.catch`，启动期异常静默 | 部分成立 |
| 29 ⚠ | 低 | `src/main/elevate.ts:76-80` | `finally` 里裸调 `rmSync`，`force: true` 不忽略 EPERM/EBUSY，异常会从 `finally` 抛出 | 未复核 |
| 30 ⚠ | 低 | `src/main/elevate.ts:59-63` | 提权超时只 kill 掉 powershell.exe，`Start-Process -Wait` 拉起的提权实例会残留 | 未复核 |
| 31 ⚠ | 低 | `electron-builder.yml:25-28` | 按用户安装（`perMachine: false`）落点在用户可写目录，且无签名配置 | 未复核 |
| 32 ⚠ | 低 | `src/main/scanner/index.ts:61-105` | 整条扫描链没有超时，worker 卡死则扫描永不结束 | 未复核 |
| 33 ⚠ | 低 | `src/main/cleaner.ts:131-134` | 校验与使用混用三种路径表示形式（`.toLowerCase()` 未 resolve，理论上可绕过 `.`/`..` 形式） | 未复核 |
| 34 ⚠ | 低 | `src/main/ports/watch.ts:109-114, 126-133` | `dispose()` 没有「已销毁」标志，`#tick` 结尾无条件重排，在飞的一拍会复活定时器 | 未复核 |
| 35 ⚠ | 低 | `src/main/ports/kill.ts:48-57` | 优雅结束只给 800ms 静默等待，与任何状态判断都不挂钩 | 未复核 |
| 36 ⚠ | 低 | `src/main/ports/watch.ts:152` | 端口键是 `协议:端口`，TCP/UDP 同号是两条独立条目，而关注与变化检测只按端口号 | 未复核 |
| 37 ⚠ | 低 | `src/main/startup.ts:75-76` | `-Force` 把两个启动文件夹里的 `desktop.ini`（Hidden+System）一并枚举进清单 | 未复核 |
| 38 ⚠ | 低 | `src/main/autoapply.ts:128` | 任务删除只凭 schtasks 的 code/文案，没有像启动项删除那样的删后回读校验 | 未复核 |
| 39 ⚠ | 低 | `src/main/startup.ts:40-43` | `$approved` 是六个键共用的单一哈希表，后写覆盖先写，同名值名的启用位可能串 | 未复核 |
| 40 ⚠ | 低 | `src/main/notify.ts:111-116` | `#active` 只持最近一条通知，弹第二条时第一条失去 JS 引用，点击回调不再触发 | 未复核 |
| 41 ⚠ | 低 | `src/renderer/components/layout/useSidebarStatus.ts:109-125` | 5 个拉取调用只有 `.then` 没有 `.catch`，reject 变成渲染层 unhandled rejection | 未复核 |
| 42 ⚠ | 低 | `src/main/volumes.ts:54-57` | 回退路径漏了「总容量为 0」校验，与快路径（第 27 行）口径不一致 | 未复核 |
| 43 ⚠ | 低 | `src/main/trend.ts:98-101` | `#append` 把时间升序当不变量，既不排序也不校验新点是否最新，系统时间回拨会错位留存窗口 | 未复核 |
| 44 ⚠ | 低 | `src/shared/format.ts:45-48` | `formatClock` 未像同文件其它格式化函数那样挡住无效输入 | 未复核 |
| 45 ⚠ | 低 | `src/main/index.ts:617-620` | 上一行用可选链保护 `settingsStore`，下一行用 `as SettingsStore` 把保护绕过去 | 未复核 |
| 46 ⚠ | 低 | `src/main/index.ts:389-394` | 与 #7 同一处（沙箱）的重复记录 | 未复核 |
| 47 ⚠ | 低 | `src/main/index.ts:1015-1017` | 注释所称「托盘没建起来时直接退出」的兜底实际不可达 | 未复核 |

> 本表最后一列是**审查时的回验结论**（该条目是否被独立复核员二次核对），与修复状态无关。
> 各条的修复状态见开头的「修复进展」小节：47 条中 **31 条已修**，4 条明示不做（见文末），
> 其余（#20 / #44 / #45 / #46）属重复记录或已随其它修复一并了结。表中的行号指向修复前的版本，
> 现已偏移。

---

## 二、高级别问题详情

### 1. [高] 提权助手没有把请求文件绑定到发起提权的那次调用

**位置**：`src/main/elevate.ts:41-45`（配套：`src/main/helper.ts:36-47`、`src/main/autoapply.ts:60-67`、`src/main/index.ts:842-844`）

```ts
const nonce = randomBytes(16).toString('hex')
const payloadFile = join(tmpdir(), `ops-cabin-apply-${nonce}.json`)
const resultFile = `${payloadFile}.result`
const payload: HelperPayload = { nonce, at: Date.now(), op }
writeFileSync(payloadFile, JSON.stringify(payload), 'utf8')
```

**问题**：这是全应用唯一以管理员身份运行的代码路径（ADR 0001），但它的信任根是「系统临时目录里一个文件名符合 `^ops-cabin-apply-[0-9a-f]{32}\.json$`、内容结构合法的 JSON 文件」。四条缺陷叠加：

1. 请求文件写在同一用户可写的 `%TEMP%`（默认 `'w'`，无 `'wx'` 独占、无 0600、无 owner 校验），从写入到助手读取之间隔着整段 `Start-Process -Verb RunAs -Wait` + UAC 应答窗口（超时 120s，`elevate.ts:53`）；
2. `helper.ts:36-47` 的 `locationProblem` 只校验「绝对路径 + 文件名形态 + 位于 `tmpdir()` + 体积 ≤64KB」，不校验所有者、创建者、父进程、创建时间；
3. `autoapply.ts:60-67` 只校验 nonce 的**形态**（`/^[0-9a-f]{32}$/`），**从不校验 `payload.nonce` 与文件名里的那 32 位 hex 相等**——也就是说文件根本不必由本应用生成。仓库里没有任何 HMAC / 预共享密钥；
4. `index.ts:842-844` 只要 argv 里有 `--apply-op` 就走助手分支，对启动者没有任何要求（且刻意放在单实例锁之前）。

项目自己的 e2e 就在证明这两者无需相等：`scripts/e2e-autostart.mjs:919-920` 用两次独立的 `nonce()` 分别生成文件名与 `payload.nonce`，并断言该调用成功。

**触发条件与后果**：同用户（中完整性）进程在 UAC 应答窗口内改写该文件，就能把用户以为自己批准的那一次操作替换成封闭操作集内的任意一条：以管理员身份**关闭/启用任意 HKLM Run 自启项**（`registry-hklm` / `registry-hklm-wow` / `folder-common`），或**启停任意非系统计划任务**（删除另有 `item.state === 'missing'` 限制；注意 `tasks.ts:85` 只跳过 `\Microsoft\*`，第三方安装器落在自建文件夹里的任务都在集合内）。这些正是普通用户权限改不了的目标。

后果上限要说清楚：**不包含任意管理员代码执行，也不包含任意文件或注册表写入**——封闭集仍被限制在六个已知键的启用位与计划任务启停。但它击穿的是这个应用唯一一条、且被 ADR 与代码注释反复声明「从严」的安全边界，且全程对用户零可见信号（UAC 上批准的是操作 X，实际执行的是 Y）。前置条件仅为「攻击者已能以同一用户身份执行代码」+「存在一次 UAC 应答窗口」。

**建议修法**：

- 首选把参数从「同用户可写文件」换到「进程创建后不可改」的通道：把 op 序列化成 base64(JSON) 直接拼进提权子进程命令行（命令行一旦创建，同用户进程只能读不能改），助手从 argv 解析并保留 nonce / 新鲜度校验，删掉 `helper.ts` 的文件位置校验；
- 若必须落盘，至少补齐三件事：① 助手校验 basename 里的 hex 与 `payload.nonce` **完全相等**（把形态校验升级为相等校验）；② 用 `fs.openSync(path, 'wx', 0o600)` 创建，助手侧读前校验创建时间晚于自身启动时间、owner 是当前用户；③ 执行前把「即将执行的 op 摘要」回传给原始（非提权）进程确认；
- 单靠换通道封不住「自造文件 + 自己 RunAs 拉起助手」这条伪造调用路径（UAC 身份显示为「运维舱」，比弹 PowerShell 更容易被点「是」），要覆盖它必须配合「回传确认」或一条带认证的通道；
- `docs/adr/0001` 的结论表述要改：封闭集**包含需要管理员的目标**，「最坏影响被限制在这个集合内」不等于「无害」。

### 2. [高] 可删集合「整体替换」与界面「按组替换」语义不一致，清理会确定性零成功

**位置**：`src/main/cleaner.ts:74-76`（配套：`src/main/index.ts:833`、`src/renderer/views/DiskView.tsx:74-85, 95-114`）

```ts
registerScanned(paths: string[]): void {
  this.#scanned = new Set(paths.map((p) => normalizeForCompare(p)))
}
```

**问题**：主进程每次扫描成功后用本次结果**整体覆盖**可删集合（`index.ts:833`），而渲染层是**按组替换、其余保留**——只换本次扫过的组，其它组的行继续留在表格里可勾选。大文件入口（`scanLargeIn`、盘符「扫这颗盘」、「扫描主目录」、「选择目录」）只注册 `largeFiles` 的路径；反向先扫盘再点「开始扫描」时又只剩 `safe`/`devCaches`。计划任务到点触发的那次扫描（`index.ts:884`，只扫 `safe+devCaches`）同样会在后台无声替换集合。

**触发条件与后果**：同一次 DiskView 挂载内先扫 A 组、再扫 B 组（界面仍显示 A 组行）→ 勾选 A 组行点「清理选中项」→ 确认后主进程对每一项返回 `cleaner.ts:133` 的「不在本次扫描结果中，已拒绝」，**一项都删不掉**。极端情形：大文件扫描零命中时 `registerScanned([])` 清空集合，让先前所有候选一起失效。用户看到的是「已经二次确认却零成功」的 toast，界面上没有任何恢复指引。方向是 fail-safe（不误删），故不是阻断，但一次性打断核心功能。

**建议修法**：二选一。① 并集语义：`this.#scanned = new Set([...this.#scanned, ...paths])`，失效交给显式的「重新扫描」入口；② 保持「最近一次扫描」语义，则把 DiskView 的合并逻辑改成「只保留本次扫过的组」，并在被拒时提示重扫对应分组。计划任务与 IPC 扫描必须共用同一套语义。

### 3. [高] EPERM 被当成「进程已退出」，结束进程假报成功

**位置**：`src/main/ports/kill.ts:34-41`（`isAlive`）、`48-57`（`killProcess`）

```ts
    process.kill(pid, 0)
    return true
  } catch {
    return false
```

**问题**：`isAlive()` 把 `process.kill(pid, 0)` 的**任何**异常都当成「进程已退出」，但 Windows 上对无权限打开的目标抛的是 `EPERM` 而不是 `ESRCH`。复核员在本机（非提权会话，Medium Mandatory Level）实测：PID 940（占用 0.0.0.0:135 的 svchost）→ `EPERM`；不存在的 999999 → `ESRCH`；csrss/winlogon/lsass 同样 `EPERM`。

**触发条件与后果**：非提权运行本应用，对 SYSTEM/服务/PPL 进程点「结束进程」（135/445/49664 这类端口的所有者基本都是这类进程）。`taskkill /PID`（不带 `/F`）必然返回「拒绝访问」，800ms 后 `isAlive` 因 `EPERM` 返回 false → 第 51 行直接 `return { ok: true, forced: false }` → `ProcDialog.tsx:55-64` 弹出 `toast.success('已结束 svchost.exe（PID 940）')`，而**进程仍在运行、端口仍被占用**。第 53 行的 `/F` 分支对这类目标永远不会执行，第 57 行专为「权限不足」写的那句话反而到不了用户眼前。另外 `runTaskkill` 返回的 `code`/`output` 从未被任何调用点读取，失败原因被整体丢弃。

**建议修法**：`isAlive` 改三态——只有 `ESRCH` 算已退出：

```ts
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}
```

同时让 `killProcess` 使用 `runTaskkill` 的 `code`/`output` 区分「权限不足」与「进程已不存在」，把真实原因写进 `KillResult.error`。需一并注意两个残留缺陷：① PID 复用竞态（目标已退出但 PID 被新进程占用时会继续 `/F` 去杀无关进程）；② Windows 下对刚退出的目标可能抛 `EINVAL` 而非 `ESRCH`，宜以端口是否释放做二次确认。

### 4. [高] 服务名进了 PowerShell 双引号源码，`$` 被解析层吃掉

**位置**：`src/main/services/collect.ts:19-21`（`quoteWql`）、`36`（`$filter = "${filter}"`）、`91`（拼接处）

```ts
function quoteWql(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}
```

**问题**：服务名只做了 WQL 单引号转义，随后第 36 行 `$filter = "${filter}"` 把它插进 PowerShell **双引号字符串的源码**里——变量展开与反引号转义发生在 PowerShell 解析层，`quoteWql` 根本管不到。实测（用一次性随机变量名做见证变量，证明展开发生在解析期）：`$filter = "Name='MSSQL$SQLEXPRESS' OR Name='nginx'"` 解析后变成 `Name='MSSQL' OR Name='nginx'`。入口没有字符白名单：`parseServiceName`（`index.ts:549-552`）只校验类型与长度，`ServiceWatchStore.isValidItem`（`services/store.ts:88-96`）读 JSON 时连长度都不校验。

**触发条件与后果**：**主危害不需要攻击者**。`MSSQL$<实例名>` 是 SQL Server 命名实例的标准服务名，会正常出现在 `AddServiceDialog` 候选列表里（候选搜索只做 `includes`，不排除 `$`），用户选中后：采集侧 `Name='MSSQL'` 查不到 → `missing:true` → 界面永久显示「不在了」，并被 `shared/services.ts:52` 的 `serviceDown` 计入侧栏「服务 N 不在跑」徽标。名字含双引号时同一次实验直接越界执行了注入代码（引号提前闭合），且 `$filter` 残缺导致所有关注服务一起报 missing。

**建议修法**：不要把名字拼进脚本源码，改为传数据：

```powershell
$names = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('<b64>')) | ConvertFrom-Json
$filter = (($names | ForEach-Object { "Name='" + ($_ -replace "'", "''") + "'" }) -join ' OR ')
```

入口只拦控制字符与超长/畸形输入——**不要拦 `$`**，MSSQL 命名实例必须继续可用（原审查者给出的「入口拒绝含 `$` 的名字」与该建议自相矛盾，已剔除）。同时补齐 `services/store.ts:88-96` 的长度与字符校验。

### 5. [高] 采集失败被伪装成「所有关注服务都消失了」

**位置**：`src/main/services/collect.ts:94-98`（吞失败）、`101-113`（伪装 missing）；配套 `src/main/index.ts:188`、`src/main/services/monitor.ts:205`

```ts
  try {
    rows = parseRows(await runPowerShell(emitScript(filter), 20000))
  } catch {
    degraded = true
  }
```

**问题**：`runPowerShell` 在超时、spawn 失败、退出码非 0 三条路径上都 reject（`powershell.ts:26-45`）。catch 后 `rows` 保持 `[]`，于是 101-113 行对**每一个**关注服务返回 `{ state:'unknown', missing:true }`——返回的是非空数组，而不是空数组。而 `degraded` 在唯一调用点 `index.ts:187-188` 被 `.then(({ items }) => …)` 解构丢弃（全仓 32 处 `degraded`，服务侧的从未被消费；`ServiceStatus` 类型里也没有这个字段）。于是 `monitor.ts:205` 那处「关注清单非空却采到空数组 = 采集失败，必须保留基线」的保护形同虚设——它防的是 `index.ts:201` 的 catch，而 `collectServices` 内部先吞掉了错误，那个 catch 根本不会触发。**注释写明的意图与实现正好反向错配。**

**触发条件与后果**：任何一次采集失败（20s 超时、WMI 不可用、策略/EDR 拦截 PowerShell；本应用还会并发跑磁盘扫描抢占 CPU）都被解释为「所有关注服务已从本机消失」：`diffServices`（`monitor.ts:78-82`）为每个服务产生 `kind:'down'`、`reason='本机已没有这个服务'` 的提醒，恢复后再整批产生 `kind:'up'`。一次瞬时故障 = 一轮假警报风暴；期间端口页服务面板与侧栏徽标也全部显示「不在了」。这与设计文档把 `missing` 定义为「服务真的被卸载」相悖。

**建议修法**：catch 中改为返回 `{ items: [], degraded: true }`，让 `index.ts` 把 `degraded` 一并带出，`ServiceMonitor.#tick` 见到 `degraded` 就跳过这一拍（与 205 行既有意图一致）；若必须返回条目，也要用 `{ state:'unknown', missing:false }`，使 `serviceDown` 判为「不算有事」。

### 6. [高] 「逐段加长」写死 5 段上限，把正常自启项误判为失效并解锁删除

**位置**：`src/main/execpath.ts:40-43`（循环）、`44`（`return head`）

```ts
  for (let index = 1; index < Math.min(parts.length, 5); index++) {
    candidate = `${candidate} ${parts[index]}`
    if (existsSync(candidate)) return candidate
```

**问题**：未加引号的命令按空格分段逐段加长试存在性，但上限写死 `Math.min(parts.length, 5)`（index 最大 4，最多拼 5 段 = 跨 4 个空格）。只有当整串被切成 ≤5 段时，最后一次迭代才等于完整串；否则函数退回 `head`（第一个空格前的截断片段）——正是本文件头注释宣称要避免的那种误报。启动文件夹来源传入的恰恰是 `.lnk` 的完整路径（`startup.ts:76` 用 `$_.FullName`），该路径自带 1 个空格（`Start Menu`），故 `.lnk` 文件名含 ≥4 个空格时正确全路径永远拼不到。复核员用真实模块实测：`C:\Program Files (x86)\Intel\Intel(R) Management Engine Components` 未能原样返回，5 段的 `C:\Program Files\Microsoft SQL Server\Client SDK\ODBC\170` 完整命中——断点恰在 5 段。

**触发条件与后果**：该条被判「路径失效」（`startup.ts:112-121`）→ 界面出现「删除」按钮（`StartupPanel.tsx:95` 的 `deletable = !item.pathExists`，红色按钮在 `:122-133`）→ 主进程闸门用的是**同一个**错字段（`autoapply.ts:205`），必然放行 → `buildDeleteFileScript(item.command)` 用 `Remove-Item -LiteralPath $file -Force` 删掉的是 `.lnk` 的**真实全路径**（不是被截断的 head），且按设计不进回收站。**也就是判错的是存在性，动手删的是真路径：一次点击永久删掉一个本来正常的自启快捷方式。** 注册表来源有缓冲（未加引号命令会先命中真实存在的中间前缀如 `C:\Program Files`），文件夹来源没有。

**建议修法**：改成 `index < parts.length`（去掉段数上限）；但这会扩大与 #9 同源的判错面，必须一起处理。更根本的是别拿 `.lnk` 路径当「可执行路径」——folder 来源应由 `startup.ts` 解析 `.lnk` 的目标（IShellLink / `WScript.Shell` 的 `TargetPath`）再判存在性。过渡期至少把「拼不出来」与「确实不存在」区分开，删除入口只对**确证**不存在的条目开放。

---

## 三、中级别问题详情（已取回部分）

### 7. [中] 渲染进程沙箱被显式关闭

**位置**：`src/main/index.ts:389-394`（`sandbox: false` 在第 393 行）

**问题**：`contextIsolation: true` / `nodeIntegration: false` / CSP 都到位，唯独 Chromium 沙箱被**显式**关掉（Electron 43 在 `nodeIntegration !== true` 时默认是 `true`，所以这不是沿用默认）。复核员已核实开沙箱在本项目可行：`preload/index.ts:1` 只值导入 `contextBridge` / `ipcRenderer`，其余全是 `import type`；产物被强制成 CJS（`electron.vite.config.ts:16-19, 36-45`），`out/preload/index.js` 全文只有一处 `require("electron")`，无 `node:` 内建依赖——正是 `sandbox: true` 支持的形态。全仓 grep `sandbox` 只命中这一处，**没有任何地方解释为什么必须关**。

**后果**：渲染进程一旦被攻破，缺失 OS 级隔离兜底；对一个常驻托盘、持有 `runClean`（含永久删除）、`applyAutoOp`（可触发 UAC）、`runKill`、`installUpdate` 的运维工具，这层价值明确。当前没有现成可达攻击链（contextIsolation + CSP 仍在），故定中。

**建议修法**：改 `sandbox: true`（preload 无需改动），改完实跑 `scripts/e2e-*.mjs` 与一次手工启动确认桥调用与 7 条推送（`settings` / `scan:progress` / `metrics:update` / `ports:snapshot` / `ports:changes` / `update` / `win:state`）仍正常。若确有依赖 preload 的 Node 能力，把该能力下沉到主进程 IPC。

### 8. [中] 导航白名单放行任意 `file://`，且 IPC 全都不校验来源

**位置**：`src/main/index.ts:347-354`

```ts
  win.webContents.on('will-navigate', (event, url) => {
    const devUrl = process.env['ELECTRON_RENDERER_URL']
    const allowed = url.startsWith('file://') || (devUrl !== undefined && url.startsWith(devUrl))
    if (!allowed) {
      event.preventDefault()
      openExternal(url)
    }
  })
```

**问题**：注释写「页面自身不许导航去别处（dev server 与本地产物文件除外）」，实现放行的是**整个 `file:` 协议**（没有与唯一入口 `join(__dirname, '../renderer/index.html')` 比对）。配套：全文件 51 处 `ipcMain.handle` 一律用 `_event` 忽略来源，`event.sender` / `senderFrame` 出现 0 次；而 Electron 对 webContents 的**每次导航都会重新执行 preload**，且 `contextBridge` 注入不受页面自身 CSP 约束——导航后的新页面同样拿到完整的 `window.opsCabin`。dev 分支用的是裸前缀匹配，`http://localhost:5173@evil.com/`（userinfo）之类同样能命中；且 348-349 行只看环境变量是否存在，不像 433 行那样带 `!app.isPackaged`，打包版被投毒环境变量启动时这个前缀放行同样生效。

**后果**：今天**没有已证实的利用路径**（渲染层 `dangerouslySetInnerHTML` / `innerHTML` / 动态 `href` / `window.open` 全部 grep 为 0，React 文本插值转义），所以这是纵深防御缺陷。但一旦引入「标记/URL 注入 + 用户交互」这类窄路径，那个页面就在无 CSP 约束的环境里拿到完整特权桥，把受限注入升级为完整能力。

**建议修法**：只放行唯一入口——启动时算出 `pathToFileURL(join(__dirname, '../renderer/index.html'))`，导航时比较去掉 hash/query 后的 `url === entry`；dev 用 `new URL(devUrl).origin` 精确比对 origin + pathname，不用 `startsWith`（并加 `!app.isPackaged`）。同时在 `registerIpc` 统一加来源校验：`if (event.senderFrame === null || event.senderFrame.url !== entry) return`。

### 9. [中] 路径解析的段数上限与「目录算存在」（与 #6 同源）

**位置**：`src/main/execpath.ts:38-44`；目录判定问题在同文件 `37-39`、`54-62`

**问题**：① 段数上限使「逐段加长」退化为「取第一个空格前的内容」（已在 #6 详述）。② 候选判定用 `existsSync` 不区分文件与目录，命中目录即返回；`isExecPathValid` 只看返回值是否存在，于是**「目录在」=「程序在」**（已实测 `parseExecPath` 可返回真实存在的目录）。③ 反方向还有一处漏报：folder 来源判的是 `.lnk` 文件自身是否存在（刚枚举出来，恒为真），所以「目标程序已卸载」这个最典型的残留永远判不出来。

**后果**：误报方向——条目被判「路径失效」，界面给 warn 配色并**开放删除入口**（与 #6 同一条链，`autoapply.ts:205` 用同一字段复核，骗得过）。漏报方向——真正的残留永远不会被提醒。注意：漏报那半边 `PLAN.md:933-935` 已显式记录为「已知取舍」，不应算作新发现；但 #6 的误报方向推翻了该取舍成立的前提（`.lnk` 路径一旦 ≥6 段，「失效 .lnk」这一态就真实存在，而挡住它的守卫用的正是同一个坏字段）。

**建议修法**：去掉段数上限；判据从「路径是否存在」升级为「是不是一个可执行文件」（`statSync(...).isFile()`，扩展名可宽松处理）；folder 来源解析 `.lnk` 目标；`parseExecPath` / `isExecPathValid` 返回三态（存在 / 不存在 / 判不了），删除入口只对确证不存在的条目开放。可用一条文件名含 ≥4 个空格的 `.lnk` 放进启动文件夹实测确认。

### 10. [中] 白名单不挡「祖先」，白名单子目录会被连父目录一起删

**位置**：`src/main/scanner/categories.ts:203-210`；配套 `cleaner.ts:134`、`worker.ts:101-104`、`scanner/index.ts:128`、`WhitelistEditor.tsx:17`

```ts
export function isExcluded(pathValue: string, prefixes: string[]): boolean {
  const lower = pathValue.toLowerCase()
  for (const prefix of prefixes) {
    if (lower === prefix) return true
    if (lower.startsWith(`${prefix}\\`) || lower.startsWith(`${prefix}/`)) return true
```

**问题**：只判定「自身等于白名单前缀」或「位于白名单前缀之下」，**不判定「路径是白名单目录的祖先」**。于是 `isExcluded('C:\Users\x\AppData\Local\Temp', ['c:\users\x\appdata\local\temp\keep'])` 返回 false：整目录型候选（`categories.ts:27` 的 `%TEMP%`）不会因为其下有白名单子目录而退役。更糟的是 `worker.ts:101-104` 在测大小时**会**跳过白名单子树——于是显示的体积把白名单目录排除在外，删除却把它一起删掉（**度量范围小于覆盖范围**）。`cleaner.ts:134` 的二次拦截同样只挡「自身或后代」，另三道（磁盘根、`PROTECTED_PATHS` 精确匹配、`homeLower`）都命中不了 `C:\Users\x\AppData\Local\Temp`。

**后果**：白名单加入 `%TEMP%\keep` → 扫描结果里仍出现「用户临时文件 …\Temp」（尺寸已不含 keep）→ 清理该项时 `deletePaths` 对该目录做 `FO_DELETE`，keep 随目录一起被删/进回收站。用户明确标记为受保护的数据被删除，界面文案（「白名单里的目录在扫描与清理时都会被跳过」）与实现不符。默认进回收站可还原，故定中。

**建议修法**：在 `buildTask` 与 `cleaner.#veto` 各加一条严格祖先判定（候选是某白名单前缀的严格祖先时，要么剔除该候选，要么改为「只清空目录内容、跳过白名单子树」的删除实现）；最低限度也要在 note 与清理确认框里写明「此项包含受保护目录，会一并删除」。同一根因还影响 `worker.ts:186` 对大文件根的判定，应一并覆盖。

### 11. [中] 临时清单文件路径未转义就进 PowerShell 单引号字符串

**位置**：`src/main/cleaner.ts:163-164`、`195`

```ts
  const listFile = join(app.getPath('temp'), `ops-cabin-clean-${Date.now()}.txt`)
  writeFileSync(listFile, paths.join('\n'), 'utf8')
```

**问题**：第 195 行是 `` `$paths = Get-Content -LiteralPath '${listFile}' -Encoding UTF8` ``，路径未做任何转义就落进单引号字符串（整行单引号数为奇数）。Windows 用户配置目录允许撇号（`C:\Users\O'Brien\AppData\Local\Temp`，或自定义 `%TEMP%`）。已实测：同样的包装（`[Console]::OutputEncoding=UTF8` + `-EncodedCommand`）下，含单引号的路径让 PowerShell 报 ParserError（「字符串缺少终止符」）并以退出码 1 结束。

**后果**：这类机器上「清理」功能 **100% 失败**，且 toast 显示的是 `删除执行失败：#< CLIXML <Objs ...`（还夹着 GBK 乱码的 stderr），用户完全无法判断原因。加重情节：项目里已有现成同类工具（`elevate.ts:30-32` 的 `psSingle()`、`services/collect.ts:18-21` 的 `quoteWql()`），`cleaner.ts:195` 是全仓唯一一处把动态值裸插进 PowerShell 单引号字符串的地方。

**建议修法**：经环境变量或 `-Args` 传参（`$env:OPS_CABIN_LIST='...'` + `Get-Content -LiteralPath $env:OPS_CABIN_LIST`），或至少 `listFile.replace(/'/g, "''")`；同时给 `runPowerShell` 的 stderr 做 CLIXML 剥离，让失败原因可读（注意：加 `-OutputFormat Text` 实测无效）。

### 12. [中] 写临时清单文件的异常会穿透成渲染层 unhandled rejection

**位置**：`src/main/cleaner.ts:163-164`、`203-215`

**问题**：`writeFileSync(listFile, ...)` 在 `try` 之外，只有 `runPowerShell` 那一句被 `try/catch` 包住。链路核实：`ipcMain.handle('clean:run')` 直接 `return cleaner.run(...)`（`index.ts:645-653`，全项目 handler 都是裸注册、无统一包装）→ 异常 reject → preload 只是 `as Promise<CleanOutcome>` 断言后透传 → 渲染层 `CleanDialog.run`（`:33-56`）是 `try/finally`、**无 catch** → unhandled rejection。全 `src` 目录 grep 无 `unhandledrejection` / `window.onerror` / ErrorBoundary，主进程也无全局处理器。

**后果**：对话框停在原地、按钮恢复可点、**没有任何 toast**，用户只会反复点击以为坏了。触发面：清单文件恰好写在 `%TEMP%` 下，而删除 `%TEMP%` 本身是常见清理项；杀软占用、ENOSPC（本工具恰恰是给磁盘将满的用户用的）同等现实。不涉及数据损坏或越权，故定中。

**建议修法**：`writeFileSync` 移入 `try` 并返回逐项失败（写盘点统一改 `writeFileAtomic`，其内部已 `mkdirSync(dirname, { recursive: true })`）；`CleanDialog.run` 补 `catch` 呈现；`Cleaner.run` 最外层兜底，保证 `CleanOutcome` 永不 reject。

---

## 四、中低级别问题的主题归纳（⚠ 条目）

以下几组问题的详情文字未能从审查缓冲完整取回，但结论与其代码位置已由审查者给出、且多数经复核成立。按主题归纳，便于集中修复：

**A. 「判据与闸门共用同一个字段」的连锁误判**（#13、#19、#37、#39）

- `startup.ts:40-43` 六个 `StartupApproved` 键共用一张哈希表，同名值名互相覆盖；`-Force` 把两个启动文件夹里的 `desktop.ini` 也枚举进清单（#37）
- `categories.ts:105-110` 的 `%LOCALAPPDATA%\pnpm` 是 store 的父目录而非 store 本身，清理范围超出标注（#13）
- 共同教训：**判据字段同时被当作删除闸门时，误判会直接变成破坏性操作**（#6 / #19 就是这条的实例）

**B. 采样、基线与时间线**（#14、#15、#16、#17、#18、#21、#34、#35、#36、#40、#41、#43）

- `ports/watch.ts`：`#busy` 首采期不互斥（#14）、订阅者计数无主进程兜底（#16）、`dispose()` 后定时器可能复活（#34）
- `services/monitor.ts:182-184, 191-195`：`syncNow()` 撞上 `#busy` 时基线建立被静默推迟 60s（#17）
- `processes.ts:182-197`：只有抛异常才保留旧表，退出码 0 但内容不是预期 JSON 时旧表被空表覆盖（#18）
- `index.ts:704-718`：`ports:kill` 不看快照新旧，PID 复用会误杀（#15）；`kill.ts:48-57` 优雅结束只等 800ms 且不与状态挂钩（#35）
- `shared/tasks.ts:150-157`：状态表缺 `SCHED_S_` 0x41305 / 0x41306 等官方码（#21）
- `ports/watch.ts:152`：端口键含协议，关注与变化检测只按端口号（#36）
- `trend.ts:98-101`：`#append` 把时间升序当不变量，系统时间回拨会错位（#43）
- `notify.ts:111-116`：`#active` 只持最近一条通知，第一条的点击回调失效（#40）
- `useSidebarStatus.ts:109-125`：5 个拉取调用只 `.then` 不 `.catch`（#41）

**C. 工程与发布链路**（#22、#23、#26、#29、#30、#31、#32）

- `updater.ts:102-106`：本机没有 Authenticode 校验，完整性只锚在 latest.yml 的 sha512（#22）
- `.github/workflows/release.yml:8-11`：CI 只在 `v*` tag 触发，main 上的提交**没有任何自动门禁**；11–12 个 e2e 脚本没有 npm 入口、CI 也不跑（#23、#26）
- `elevate.ts:76-80`：`finally` 里裸调 `rmSync`，`force` 不忽略 EPERM/EBUSY（#29）；`:59-63` 超时只 kill powershell.exe，`Start-Process -Wait` 拉起的实例残留（#30）
- `electron-builder.yml:25-28`：按用户安装 + 无签名配置（#31）
- `scanner/index.ts:61-105`：扫描链无超时，worker 卡死则永不结束（#32）

**D. 缓存与启动链的收尾**（#24、#27、#28、#42、#44、#45、#47）

- `index.ts:177-206`：四份复制粘贴的「TTL 缓存 + 并发合流」采集器行为分叉（`degraded` 在第 188 行被丢弃）——建议抽成一个共用工厂（#24）
- `index.ts:851-852`：整条启动链 `whenReady().then(...)` 无 `.catch`（#28）；`:617-620` 用 `as SettingsStore` 绕过上一行的空值保护（#45）
- `useSidebarStatus.ts:23-25` 的成本模型注释与实际 TTL 不符（#27）；`volumes.ts:54-57` 回退路径漏「总容量为 0」校验（#42）；`format.ts:45-48` 未挡无效输入（#44）；`index.ts:1015-1017` 的兜底注释与实现不符（#47）

---

## 五、审查者独立核实、且未进入上表的补充问题

以下由主审在交叉核对时独立确认，回验阶段未覆盖，单独列出。**其中 S1、S3 两条在落盘后的自查中被主审自己推翻，保留条目并标注撤回原因，以免读者从旧版摘录里再引用它们：**

| # | 级别 | 位置 | 结论 |
| --- | --- | --- | --- |
| ~~S1~~ | — | ~~`src/main/autoapply.ts:140-165`（`runSchtasks`）~~ | **本条已由主审自行撤回**：Node 的 `child_process.execFile` 在内部创建子进程时会自行挂上 `'error'` 处理器（把错误交给回调），因此不存在「未处理的 `'error'` 事件终止主进程」。spawn 失败会被回调收到、`code` 归为 1，走第 129 行的失败分支。原记录判断错误，不作为问题 |
| S2 | 低 | `src/main/autoapply.ts:145` | `execFile` 的 `timeout: 20000` 触发时回调收到 `error.killed === true`、`code` 非数字，第 150-152 行把它归为 `1`，界面上显示为「schtasks 退出码 1」而**不是超时**——用户在任务枚举卡住时会拿到误导性原因 |
| ~~S3~~ | — | ~~`src/main/atomic.ts:9-19`~~ | **本条已由主审自行撤回**：`writeFileAtomic` 全程同步、无 `await`，同一文件不可能并发重入；且 9 个写盘点各用各的 `${file}.tmp`，跨文件也不共享路径，因此不存在覆盖或 rename 碰撞。原记录（固定临时名有并发风险）判断错误，不作为问题 |
| S4 | 低 | `src/renderer/index.html:7` | CSP 的 `connect-src` 允许 `http://localhost:*` / `ws://localhost:*`（为 dev server 保留）。打包版不需要，但 `script-src 'self'` 仍是硬的，实际风险很低；建议按 `app.isPackaged` 生成不同 CSP，或至少收窄到固定的 dev 端口 |

---

## 六、复核后否定（不计入问题）

本轮回验**没有**否定任何一条高/中级别问题的成立性。仅有两处描述层面的修正，已并入正文：

- **#24**（四份采集器行为分叉）：回验结论为「部分成立」——`degraded` 被丢弃（第 188 行）是真实缺陷，但所述「`index.ts:201` 的 catch 不可达」属防御代码，描述需修正。
- **#28**（启动链无 `.catch`）：回验结论为「部分成立」，描述需修正。

另有一处建议级错误已剔除：问题 #4 的原始修法里「入口拒绝含 `$` 的服务名」与「MSSQL$ 命名实例应走转义」自相矛盾，正文只保留了后者。

---

## 七、修复优先级建议

按「影响 × 修复成本」排序，建议先做这五件事：

1. **#3（`kill.ts` 的 EPERM）** —— 改动 3 行，消除「假报成功」这一类最伤信任的反馈；同时把 `code`/`output` 接进 `KillResult.error`。
2. **#2（可删集合语义）** —— 改动 1 行（并集语义即可），直接修好「二次确认后零成功」这条核心功能路径。
3. **#4 + #5（`services/collect.ts`）** —— 同一个文件、同一段脚本模板：改成 base64 传数据 + 采集失败返回空数组并让 `degraded` 上行。修好之后顺带消除「假告警风暴」。
4. **#6 + #9（`execpath.ts` 三态化）** —— 这是唯一一条「误判 → 不可逆删除」的链路，值得单独排一次改动：去掉段数上限、区分文件与目录、返回三态、删除入口只对确证不存在的条目开放。
5. **#1（提权助手绑定）** —— 改动最大（要动协议），但它是唯一以管理员身份运行的路径。最低成本的第一步是「校验 basename 里的 hex 与 `payload.nonce` 相等」+ `'wx', 0o600` 创建；彻底方案是把 op 放进命令行。

配套建议（不成体系但收益明确）：给 `release.yml` 加一个 `push` / `pull_request` 上的 typecheck 作业（#23），并在 `package.json` 补一个 `e2e` 入口把 12 个脚本串起来——现在这批脚本的唯一调用者是开发者本人，main 分支上没有任何自动门禁。

---

## 八、范围覆盖与遗留

审查覆盖：提权与受控助手（S1）、磁盘扫描与清理（S2）、端口雷达与服务监控（S3）、启动项与计划任务写操作（S4）、共享逻辑与资源泄漏（S5）、可维护性与测试可信度（S6）。6 路共 32 个子代理，其中 26 条高/中级别问题进入逐条回验。

**本项目做得好的地方**（复核过程中确认，非客套）：

- `preload/index.ts:32-37` 刻意不暴露通用 `invoke(channel, ...args)`，每个能力显式列名——渲染层拿不到主进程所有通道的调用权；
- `autoapply.ts` 的安全设计方向正确：渲染层只传 id、主进程从**刚重采集的报告**重建参数、动态字符串一律 base64 进脚本、助手与直写路径共用同一份 `executeOp`（不存在绕过校验的旁路）、UAC 取消如实上报（`elevate.ts:66-68`）不静默降级；
- `cleaner.ts:16-23` 的 `PROTECTED_PATHS` + 白名单 + 默认回收站三层防线，以及 `data:.tmp` 式的原子写、`AbortSignal` 超时、`will-quit` 里逐项 `dispose()`；
- 类型纪律：全仓仅 1 处必要类型补丁，`pnpm typecheck` 干净通过（本次实测 exit 0）。

**本次审查未覆盖**：

- 未运行任何 e2e（会启动真实 Electron 与改动本机状态），未做打包验证；`pnpm dist` 未执行；
- 未在提权（管理员）会话下验证提权链路；elevate 相关的两条问题（#29、#30）为静态推断；
- 未做模糊测试或动态污点分析；`#13`、`#26`、`#31` 等 ⚠ 条目未做二次复核；
- 未审查 `release/` 下的既有打包产物与 `design-system/` 资产。
