# 运维舱（ops-cabin）MVP 实施计划

> 制定：2026-10-10 · 骨架已就绪（M0 已完成）
> 设计系统：`design-system/opscabin/MASTER.md` —— 实现任何页面前，先读 `design-system/opscabin/pages/<page>.md`，存在则覆盖 MASTER。
> 规则来源：ui-ux-pro-max 技能（ux / chart / react / shadcn 域检索在实现时现场跑）。

---

## 0. 已定项与范围

- **平台**：仅 Windows（端口采集 / 磁盘路径 / 回收站均按 Windows 讲）
- **形态**：托盘常驻桌面应用；关闭窗口不退出（M1 落地）
- **首页**：系统资源总览（磁盘分区条 + 关注端口卡片阵 + 资源读数 + 提醒流）
- **技术栈**：Electron 43 + electron-vite 5 + React 19 + TypeScript + Tailwind v4 + shadcn/ui
- **架构**：`main / preload / shared / renderer` 四层；preload 显式桥（无通用 invoke）；扫描与采集一律离开主进程

### 范围对照（头脑风暴 → 里程碑）

| 优先级 | 功能 | 里程碑 |
|--------|------|--------|
| P0 | 托盘常驻 + 设置落盘 + 窗口记忆 | M1 |
| P0 | 磁盘分级扫描引擎（安全清理 / 开发缓存 / 大文件） | M2 |
| P0 | 磁盘页：结果表 + 多选 + 预览 + 清理（回收站） | M3 |
| P0 | 端口采集引擎（实时表 + 进程信息） | M4 |
| P0 | 端口页：关注清单卡片阵 + 全表 + 处置 + 变化通知 | M5 |
| P0 | 系统资源总览（首页） | M6 |
| — | 设置页（白名单 / 通知 / 清理计划 / 更新） | M7 |
| — | 打包发版 + 冒烟自检 | M8 |
| P1（MVP 后） | 重复文件检测、清理历史统计、端口历史时间线、启动项管理、大目录迁移、体检报告 | M9+ |

---

## 1. M0 骨架（已完成）

产出：electron-vite 四层工程、Tailwind v4 + 设计令牌（`src/renderer/index.css`）、
设计系统持久化（MASTER + 4 页面覆盖）、单实例 + 主题跟随系统 + 窗口安全加固。

验收基线：`pnpm typecheck` 与 `pnpm build` 通过；`pnpm dev` 出窗口（深色系统下深色首帧，无白闪）。

---

## 2. M1 主进程地基（托盘 / 设置落盘 / 窗口记忆）—— 已完成（2026-10-10）

**产出**：
- `src/main/settings.ts`：`SettingsStore` 原子写（tmp + fsync + rename）；损坏文件留档 `.bad` 并回退默认值；落 `userData/settings.json`
- `src/shared/settings.ts`：`DEFAULT_SETTINGS` + `sanitizeSettings`（纯函数逐字段收敛）
- `src/main/tray.ts`：托盘控制器（左键切换面板、右键菜单、退出）；`iconInfo()` 供自检
- `src/main/paths.ts`：资源 / preload 路径集中管理
- `src/main/index.ts`：关窗进托盘（`isQuitting`）、窗口位置记忆（含多显示器可见性校验）、设置 IPC（get / update / 推送）、冒烟探针（`OPS_CABIN_SMOKE=1` 写 `%TEMP%/ops-cabin-smoke/`）
- `scripts/gen-icons.mjs` + `resources/{icon,tray}.png`：手写 PNG 生成（无外部依赖）
- `scripts/e2e-check.mjs`：CDP + Win32 的端到端检查（可重复运行）

**验收（e2e 15 项全绿）**：关窗隐藏不退出 ✓ / 窗口移动 → 关窗保存 → 重启恢复（370,120 移动 120,80 后 490,200 分毫不差）✓ / 损坏设置回退并留档 ✓ / 设置原子写盘 ✓ / 托盘图标非空 ✓ / `app:quit` 出口 ✓。
**待人工过目**：托盘的单击呼出与右键菜单（自动化验证了图标与控制器创建，未模拟鼠标点击托盘）。

---

## 3. M2 磁盘扫描引擎 —— 已完成（2026-10-10）

**产出**：
- `src/shared/disk.ts`：`ScanItem` / `ScanGroupResult` / `ScanProgress` / `ScanResult` / `ScanOutcome` / `ScanOptions`
- `src/main/scanner/categories.ts`：分级位置清单（安全清理 4 处 + 开发缓存 10 处）、`%ENV%`/`~` 展开、白名单前缀归一、大文件遍历跳过名单
- `src/main/scanner/worker.ts`：扫描执行（utilityProcess 入口）——迭代式遍历、目录链接/junction 不跟进、权限拒绝计数不中断、进度 200ms 节流、同目录文件 stat 批量并发
- `src/main/scanner/index.ts`：`Scanner` 任务管理（同一时刻一个任务；新 start 自动接管旧任务；取消 = 终止进程）+ `parseScanOptions` 入参收敛
- `electron.vite.config.ts` 多入口（产出 `out/main/scanner.js`）；IPC `scan:start` / `scan:cancel` + `scan:progress` 推送；preload 桥 `startScan` / `cancelScan` / `onScanProgress`

**与计划的差异**：不做「回收站」目标（删除语义特殊，与 M3 清理动作一起做）；原计划的单文件 `scan.ts` 合并进 `worker.ts`。

**验收（`scripts/e2e-scan.mjs`，21 项全绿）**：
- 产物精确核对：夹具 4 个大文件逐个命中（2MB×4，合计 8MB），128B 小文件不入榜
- 白名单目录不出现在结果里（4 → 3）
- 3 万文件级扫描期间渲染进程响应 3ms；取消 166ms 内结束；接管语义正确
- 性能：stat 批量并发 + `UV_THREADPOOL_SIZE=16`，本机 %TEMP% 全量扫描 21.6s → 8.9s

---

## 4. M3 磁盘页（第一个完整闭环）—— 已完成（2026-10-10）

**产出**：
- 主进程：
  - `src/main/powershell.ts`：PowerShell 执行工具（-EncodedCommand 传脚本、UTF-8 输出、超时、无窗口）
  - `src/main/volumes.ts`：分区列表（Get-PSDrive）
  - `src/main/cleaner.ts`：清理执行 —— SHFileOperation 静默删除（回收站 / 永久）、三层安全防线、清理历史落盘
  - `src/main/atomic.ts`：原子写抽为公共函数（settings / cleaner 共用）
  - IPC：`clean:run` / `volumes:list` / `app:show-in-folder` / `app:pick-directory`
- 渲染层：
  - `views/DiskView.tsx` + `components/disk/`（PartitionList / ResultTable / DetailPanel / ScanProgressBar / CleanDialog）
  - shadcn 第一批：`alert-dialog` `table` `tabs` `checkbox` `progress` `badge` `separator` + sonner Toaster
  - `shared/format.ts`（formatBytes / formatCount）；「扫描主目录」默认扫用户主目录，「选择目录…」走系统目录选择器
- 安全设计：`clean:run` 只允许删除本会话最近一次扫描结果中的路径（渲染层被攻破也无法删任意文件）；白名单与系统保护名单二次拦截；默认进回收站

**验收（e2e 34 项全绿，`scripts/e2e-disk.mjs`）**：
- 伪造路径（未扫描过的系统文件）被拒且未被触碰；白名单路径被拒
- 回收站删除：2 项成功、字节数正确、**枚举回收站确认可还原**；永久删除成功；重复清理记入 removed 不算失败
- UI 全流程：磁盘页渲染、tab 切换、扫描出结果行、勾选计数更新、确认对话框（含去向说明）、取消关闭、扫描可取消

---

## 5. M4 端口采集引擎 —— 已完成（2026-10-10）

**产出**：
- `src/shared/ports.ts`：`PortEntry` / `WatchItem` / `PortChange` / `PortsSnapshot` 类型
- `src/main/ports/collect.ts`：采集引擎 —— netstat -ano（TCP LISTENING + UDP）与进程表（Get-CimInstance Win32_Process）合并；进程表 10s 缓存、遇到未知 PID 立即刷新；同协议同端口多地址合并
- `src/main/ports/watch.ts`：`PortsMonitor` 懒轮询调度（有订阅 2s / 仅后台关注 5s / 都没有则停）、变化检测（occupy / release / change；首次观察只建基线，不把「刚关注」当变化）
- `src/main/ports/store.ts`：关注清单持久化（watchlist.json，原子写，损坏留档回退）
- `src/main/ports/events.ts`：变化历史落盘（port-events.json，限量 1000 条）
- 主进程接线：IPC（`ports:list/subscribe/unsubscribe/watch:*/events`）+ 变化系统通知（多条聚合、可关）+ preload 桥

**与计划的差异**：进程内存 / 启动时间并入 Win32_Process 一次查询（不再单独跑 Get-Process）；「页面不可见降频」改为「无订阅即降频/停止」（可见性交给 M5 的 UI 生命周期管理）。

**验收（e2e 22 项全绿，`scripts/e2e-ports.mjs`）**：
- 与外部 netstat 两次采样的集合对比：不多报、不遗漏（52 条监听）
- 真实服务：启动后 2s 内出现、PID 精确匹配、进程名识别为 node.exe、监听地址正确
- 双栈服务多地址合并为一条；订阅推送 2s 周期、退订即停
- 关注 51733：启动 → occupy（带进程信息）推送 + 落盘；停止 → release 推送 + 落盘

---

## 6. M5 端口页 + 通知 —— 已完成（2026-10-10）

**产出**：
- `src/renderer/views/PortsView.tsx` + `components/ports/`：`WatchGrid`（关注端口卡片阵：端口号等宽大字 + 状态灯 + 占用进程与运行时长）、`PortTable`（搜索 / 协议筛选 / 三列排序 / 星标关注）、`ProcDialog`（进程详情 + 危险操作）、`ChangeTimeline`（右侧变化时间线）、`AddWatchDialog`（端口 + 名称 + 备注，错误就近提示）
- `src/main/ports/kill.ts`：结束进程（先优雅 taskkill，800ms 未死则强制 /F）+ IPC `ports:kill`（安全边界：只允许结束最近快照里正在监听端口的进程，PID ≤ 4 拒绝）
- 订阅生命周期：进入页面 subscribe（2s 推送），离开 unsubscribe（主进程随之降频 / 停止）
- 新增 shadcn 组件：`dialog` / `tooltip`；`shared/format.ts` 增 `formatDuration` / `formatClock`

**与计划的差异**：搜索用样式化原生输入（不引入 command/cmdk）；筛选用 pill 按钮组（不引 select）；详情用 Dialog（不另做 ProcDrawer）；虚拟化延后（数据源为监听端口，规模 <200 行，天然流畅，见 §12）。

**验收（e2e 35 项全绿，`scripts/e2e-ports-m5.mjs`）**：
- 页面渲染、真实服务 2s 内入表、星标关注出卡片（占用中 + 进程名）
- 详情含 PID 与命令行；结束进程全链（二次确认 → 进程死 → toast → 表格行消失 → 卡片转空闲）
- kill 安全边界（未在快照的 PID、系统 PID 均拒绝）
- 添加关注对话框（输入 → 提交 → 空闲卡片）、移除关注、页面切换重订阅、时间线记录 release

**修复记录（M5 期间的产品级修复）**：`PortsMonitor.setWatchlist` 改为用「最近一次快照」立即建立新关注项的基线 —— 原逻辑等下一个采样，而「关注后几秒内发生的状态变化」会被基线建立吞掉（采样被忙合流跳过时窗口还会推得更晚）。这是 M5 e2e 抓出的真实缺陷，已由 diag 脚本的镜像场景（关注后立刻杀 / 关注后 1 秒内启动）双向验证修复。

---

## 7. M6 总览页（首页）—— 已完成（2026-10-10）

**产出**：
- `src/main/metrics.ts`：`MetricsMonitor` —— CPU（`os.cpus()` 计数差分，带 2s 空闲心跳让差分窗口始终新鲜）、内存（`os.totalmem/freemem`）；有订阅时 1s 推送、无订阅即停
- `src/renderer/views/OverviewView.tsx` + `components/overview/`：`PartitionBars`（分区占用条）、`MetricsPanel`（CPU/内存 KPI 大字 + `Sparkline` ≤60 点）、`AlertFeed`（磁盘将满 + 端口变化，点条目跳页）；关注端口区复用 M5 的 `WatchGrid`
- 面板即入口：分区条 → 磁盘页、端口卡片区 → 端口页；IPC `metrics:sample/subscribe/unsubscribe` + 推送

**与计划的差异**：磁盘 IO / 网络速率不做（`systeminformation` 引入与采样成本评估后延后，见 §12）；提醒流不做「上次扫描」项（扫描状态未持久化，等设置页的调度落地后补）。

**验收（e2e 22 项全绿，`scripts/e2e-overview.mjs`）**：
- 一屏渲染（分区剩余 / 关注端口卡片占用中 / 指标 / 提醒流）
- CPU 与内存读数与任务管理器同量级；走势线持续积累数据点
- 面板导航（分区条 → 磁盘页、端口区 → 端口页）与返回后重订阅

---

## 8. M7 设置页 —— 已完成（2026-10-10）

**产出**：
- `src/renderer/views/SettingsView.tsx` + `components/settings/`：分组表单（通用 / 通知 / 白名单 / 清理计划 / 关于 / 危险区）——`ThemePicker`（三档，写入 nativeTheme）、通知开关、`WhitelistEditor`（系统目录选择器 + 逐项移除）、`ScanPlanEditor`（手动 / 每天 / 每周 + 时刻，失焦落盘、错误就近）、`DangerZone`（二次确认）；全局「已保存」闪现反馈
- `src/main/scheduler.ts`：`ScanScheduler` —— 每分钟检查 + 启动补扫；计划触发「安全清理 + 开发缓存」扫描（**只扫不删**），完成后发系统通知；状态落 `scheduler-state.json`；`OPS_CABIN_SCHEDULER_TICK_MS` 可加速（自检用）
- 新 IPC：`settings:reset`（重置保留窗口位置）/ `app:open-data-dir` / `ports:events:clear` / `scheduler:check-now`；`scan:start` 与计划任务共用 `runScanAndRegister`（结果登记给清理器）

**与计划的差异**：「更新」分组延后到 M8（与 electron-updater 一起做，避免两次返工）；表单用受控组件 + 自写校验（不引 react-hook-form，字段量小）。

**验收（e2e 37 项全绿，`scripts/e2e-settings.mjs`）**：
- 分组渲染；主题即时生效（落盘 + 渲染层媒体查询变深色）；通知开关落盘
- 白名单增删落盘；清理计划 mode / time 落盘
- 计划触发全链：`check-now` → 真实扫描（冒烟探针 `scheduled-scan.json`：7 项 / 约 6.3 GB）→ 当天不重复触发
- 危险区：清空变化记录（有 → 无）、重置设置（恢复默认 + 窗口位置保持原值）

---

## 9. M8 打包发版 + 冒烟自检 —— 已完成（2026-10-10）

**产出**：
- `electron-builder.yml` + `scripts/dist.mjs`：NSIS 安装版 + portable；dist 经 `pnpm exec` 调 electron-builder（项目路径含空格与中文，直接拼 cmd 命令会被截断），并为工具链设 npmmirror 镜像
- `scripts/gen-icons.mjs` 扩展出手写 ICO（16/32/48/64/128/256，无外部依赖）→ `build/icon.ico`
- `src/main/updater.ts`：`UpdateController` —— 检查 / 下载 / 安装三段式（下载与安装从不自动发生）；每天自动检查（可在设置关闭）；免安装版与开发模式显示「不支持」并给出去处；`OPS_CABIN_FAKE_UPDATE=x.y.z` 可在不联网时驱动整个更新界面（自检用）
- 设置页「更新」分组：当前版本、检查更新、下载进度、重启并安装、发布页、自动检查开关
- `src/main/smoke.ts`：应用内冒烟 —— 探针写文件（`OPS_CABIN_SMOKE=1`）与驱动界面（`OPS_CABIN_SMOKE_DRIVE=1`）分离；驱动模式走一遍四个页面、真实磁盘扫描、**自开一个端口并在端口页找回来**、落 DOM 事实与截图；`OPS_CABIN_SMOKE_THEME` 支持深浅两轮
- `.github/workflows/release.yml`：tag → typecheck → 打包 → Release（含 latest.yml 与 blockmap；**未在真实 CI 实跑过**）

**与计划的差异**：不做 `api-failures` 全局对账（数据源是本机系统命令，失败会体现在视图事实里）；「安装版可启动」用 win-unpacked 验证（NSIS 安装流程留人工）。

**验收（e2e 全绿）**：
- `pnpm dist` 产出 `ops-cabin-0.1.0-setup.exe`（96MB）/ `-portable.exe`（96MB）/ `latest.yml` / `setup.exe.blockmap`
- 打包产物启动：React 渲染、版本 0.1.0、更新分组在打包形态下可用（e2e-portable 12 项）
- 冒烟两轮（浅色 / 深色）30 项：四个页面 DOM 事实、**自检端口被端口页列出**、四张截图各一轮
- 更新流程 22 项（fake 版本驱动：检查 → 发现 → 下载进度 → 已就绪）

---

## 10. IPC 契约（累计）

| 通道 | 方向 | 形状 | 里程碑 |
|------|------|------|--------|
| `app:info` / `app:open-external` | invoke | 已有 | M0 |
| `settings:get` / `settings:update` / `settings`（推送） | invoke / 推送 | `Settings` | M1 |
| `scan:start` / `scan:cancel` | invoke | `{ groups }` / `void` | M2 |
| `scan:progress` / `scan:result` | 推送 | `ScanProgress` / `ScanGroup[]` | M2 |
| `clean:preview` / `clean:run` | invoke | `CleanPlan` / `CleanResult` | M3 |
| `ports:list` | invoke | `PortEntry[]` | M4 |
| `ports:subscribe` / `ports:update` | invoke / 推送 | `PortEntry[]` | M4 |
| `ports:watch:add/remove/update` | invoke | `WatchItem[]` | M4 |
| `ports:kill` | invoke | `{ ok, error? }` | M5 |
| `metrics:subscribe` / `metrics:update` | invoke / 推送 | `MetricsSample` | M6 |
| `clean:history` | invoke | `CleanHistoryEntry[]` | M10 |
| `trend:list` | invoke | `TrendPoint[]` | M10 |
| `processes:top` | invoke | `ProcEntry[]`（内存 Top N ∪ CPU Top N） | M10 |
| `netcheck:run` | invoke | `NetCheckReport`（6 条探针，并行） | M10 |
| `win:minimize` / `win:toggle-maximize` / `win:close` / `win:state` | invoke | `void` / `boolean` / `void` / `WindowState` | M11 |
| `win:state` | 推送 | `WindowState` | M11 |
| `hosts:read` | invoke | `HostsReport` | M12 |
| `startup:list` | invoke | `StartupReport`（TTL 30s） | M12 |
| `services:status` / `services:candidates` | invoke | `ServiceStatus[]` / `ServiceCandidate[]`（TTL 15s） | M12 |
| `services:watch:list/add/remove/update` | invoke | `ServiceWatchItem[]` | M12 |
| `ports:events` / `ports:events:clear` | invoke | `PortChange[]` / `void` | M12 |
| `startup:list`（Tab 宿主页复用） | invoke | `StartupReport` | M13 |
| `tasks:list` | invoke | `TaskReport`（TTL 60s） | M13 |
| `health:read` | invoke | `HealthReport`（TTL 60s，四段并发采集） | M13 |
| `update:*`（get / check / download / install / open-page / 推送） | invoke / 推送 | `UpdateState` | M9 |

约定：所有主进程入参过白名单校验（参考 `openExternal` 的模式）；推送通道名不带冒号后缀歧义；渲染层只经 preload 显式方法（**刻意不暴露通用 `invoke`**）。

**M14 没有新增通道**：通知出口（`Notifier`）与四类信号的判定全在主进程内部，渲染层只是
`settings:update` 的既有消费者；通知留档（`notify-log.json`）是自检产物，不是 IPC 接口。

---

## 11. 数据模型（落 `userData/`）

- `settings.json`：`{ theme, windowBounds, sidebarCollapsed, notifyOnPortChange, notifyOnScanDone, notifyOnServiceDown, notifyOnUpdate, notifySustained, quietHours: { enabled, start, end }, autoCheckUpdate, scanPlan: { mode, time }, whitelist: string[] }`
- `watchlist.json`：`{ port: number, label: string, note?: string, addedAt: number }[]`
- `service-watch.json`：`{ name: string, label: string, note?: string, addedAt: number }[]`（M12）
- `clean-history.json`：`{ at, freedBytes, itemCount, restored: boolean }[]`（限量 200 条）
- `port-events.json`：`{ at, port, type: 'occupy' | 'release' | 'change', process?: string }[]`（限量 1000 条）
- `trend.json`：`{ at, cpuPercent, memUsed, memTotal, rxBps, txBps }[]`（每 5 分钟一个点，保留 7 天 / 上限 3000 点）

全部原子写（tmp + fsync + rename）；损坏时回退默认值并保留坏文件副本（`*.bad`）。

**刻意不落盘的**：启动项、计划任务、体检三份报告都只在内存里带 TTL 缓存（30s / 60s / 60s）——
它们描述的是「这台机器此刻的状态」，落盘只会让下次启动读到一个过期的世界，而采集成本
（1.3s / 1.5s / 3.8s）还没高到需要为它做持久缓存。

---

## 12. 风险与对策

| 风险 | 对策 |
|------|------|
| `netstat` 解析在端口多时慢 | 只解析 LISTENING；2s 轮询跑在子进程；结果 diff 推送 |
| PowerShell 每次启动慢（300-800ms） | 进程表启动时拉一次 + 30s 刷新，不与 2s 轮询耦合 |
| 从 GPU/系统进程误报 | 服务识别只做"建议"，不做自动处置 |
| 删错文件不可恢复 | 默认回收站；永久删除是独立选项且更强确认；黑名单 + 白名单双层 |
| 扫描期间磁盘压力 | 单文件流式统计（不整读）；可取消；进度节流 |
| 原生模块（systeminformation 等）与 Electron ABI | 优先纯 JS 方案；必须引入时验证 `electron-rebuild` 流程后再纳入 |
| 权限拒绝目录 | 跳过并计数，结果页显示"已跳过 N 个受限目录" |

---

## 13. 里程碑路线图状态

- **M0–M8 全部完成 ✓（2026-10-10）** —— 「运维舱」具备：系统资源总览、磁盘分级扫描与安全清理（回收站可恢复）、端口雷达（关注清单 + 变化通知）、设置与清理计划、打包发版与自动更新
- **M9 已完成 ✓（2026-10-10）** —— 界面重设计（仪器面板 v2）、自绘标题栏与关于弹窗
- **M10 / M11 已完成 ✓（2026-10-12）** —— 总览补齐运维视角（清理记录统计、网络吞吐、长期趋势、进程榜、联网体检）、自绘外壳、侧栏主题三档
- **M12 已完成 ✓（2026-10-12）** —— 侧栏常驻状态（`NavBadge`）+ 三项清单式体检（hosts 域名改写、启动项、服务关注）
- **M13 已完成 ✓（2026-10-12）** —— 计划任务清单（启动项页第二档）+ 系统体检页（开机时长 / 待重启 / 磁盘 / 设备 / 事件日志 / 意外关机）
- **M14 已完成 ✓（2026-10-12）** —— 通知扩展：统一通知出口（四类信号各自开关）+ 服务后台盯梢 + 持续异常重复提醒 + 安静时段 + 更新可用落点
- 下一批候选：磁盘 I/O、SMART 磨损度与温度（需另走厂商接口）、系统事件台账、重复文件检测、大目录迁移、托盘菜单快捷扫描；
  以及**押后项**：README 换图（三张 `docs/screenshot-*.png` 全部过期，最早那张是自绘标题栏**之前**拍的）

---

## 14. 环境与运行备忘（验证记录）

**运行命令**：
- `pnpm dev`（开发，HMR）/ `pnpm build` / `pnpm typecheck`
- `pnpm exec install-electron`：`node_modules/electron/dist` 缺失时补装二进制（幂等）
- `node scripts/e2e-check.mjs`：M1 端到端检查（设置 / 窗口记忆 / 托盘 / 退出）
- `node scripts/e2e-scan.mjs`：M2 端到端检查（扫描产物 / 白名单 / 取消 / 接管 / 进度）

**electron 二进制（本机特殊）**：本机 hosts 屏蔽了 GitHub，electron 直连下载不可达。已配两层：
- `.npmrc`：`electron_mirror=https://npmmirror.com/mirrors/electron/`
- `package.json` 的 `postinstall`：`node node_modules/electron/install.js` —— electron 43 的 npm 包自带安装脚本但无 postinstall 钩子，装完若缺 `dist/`，跑 `pnpm exec install-electron`

**shadcn CLI（已验证可用）**：
1. 根 `tsconfig.json` 必须含 paths（`@/*` → `src/renderer/*`）——CLI 从它解析别名；编译实际走 tsconfig.node/web
2. 2026 版 registry 用 `cn` + `radix-ui` 统一包（替代手写 `@/lib/utils` 与分散的 `@radix-ui/react-*`），`cn` 是官方发布的类名合并包；组件依赖由 CLI 装入 `dependencies`（接受此默认）；`src/renderer/lib/utils.ts` 保留为 `export { cn } from 'cn'` 的统一出口

**M0 验证结果（全绿）**：
- `pnpm typecheck` ✓ / `pnpm build` ✓
- 生产形态冒烟：窗口标题「运维舱」、React 渲染出侧栏（总览/磁盘/端口/设置）、`window.opsCabin` 桥存在、`app:info` 返回 v0.1.0 / Electron 43.3.0
- 开发模式冒烟：加载 `http://localhost:5173/`，DOM 与桥同上

**M1 验证结果（e2e 全绿，15 项）**：`node scripts/e2e-check.mjs` 覆盖 ——
损坏设置回退与 `.bad` 留档 / 设置原子写盘 / 窗口移动 → 关窗保存 → 重启恢复 /
关窗隐藏不退出 / 托盘图标非空 / `app:quit` 出口。冒烟产物落在 `%TEMP%/ops-cabin-smoke/`。

**M2 验证结果（e2e 全绿，21 项）**：`node scripts/e2e-scan.mjs` 覆盖 ——
夹具大文件精确核对 / 白名单排除 / 3 万文件级取消（166ms）/ 接管语义 / 进度推送 /
扫描期间渲染进程响应 3ms。性能基线：本机 %TEMP% 全量扫描 8.9s（优化前 21.6s）。

**M3 验证结果（e2e 全绿，34 项）**：`node scripts/e2e-disk.mjs` 覆盖 ——
伪造路径防护 / 白名单防护 / 回收站删除（枚举回收站确认可还原）/ 永久删除 /
重复清理语义 / UI 全流程（渲染、tab 切换、真实鼠标点击、确认对话框、取消扫描）。
注：UI 自动化里 radix 的 Tabs / 对话框需用 CDP 真实鼠标事件（mousedown），
程序化 `.click()` 不触发；Cancel 按钮按 `data-slot="alert-dialog-cancel"` 精确命中。

**M4 验证结果（e2e 全绿，22 项）**：`node scripts/e2e-ports.mjs` 覆盖 ——
外部 netstat 集合对比（不多报 / 不遗漏，52 条监听）/ 真实服务端口与 PID 精确匹配 /
双栈多地址合并 / 订阅推送与退订停止 / 关注清单 CRUD 与落盘 /
occupy + release 变化检测与事件落盘。

**M5 验证结果（e2e 全绿，35 项）**：`node scripts/e2e-ports-m5.mjs` 覆盖 ——
页面渲染 / 真实服务入表 / 星标关注 / 进程详情 / 结束进程全链（二次确认 + toast）/
kill 安全边界 / 添加与移除关注 / 页面切换重订阅 / 时间线记录。
**UI 自动化的三条经验（后续脚本复用）**：等 React 挂载（title 就绪 ≠ React 就绪）；
点击前 `scrollIntoView`（长列表目标常在视口外）；注入「禁用动画」样式
（radix 入场动画会让坐标在取用瞬间仍在移动，偶发点歪）。
**产品级修复**：`PortsMonitor.setWatchlist` 用最近快照立即建立新关注基线（防「关注后
快速变化被基线吞掉」），由镜像场景诊断（关注后立刻杀 / 关注后 1 秒内启动）双向验证。

**M6 验证结果（e2e 全绿，22 项）**：`node scripts/e2e-overview.mjs` 覆盖 ——
一屏渲染 / 指标推送与走势线 / 关注端口卡片 / 提醒流 / 面板导航 / 重进重订阅。
**回归适配（M6 上线后发现的既有测试脆弱点）**：总览成为默认页并常驻订阅端口推送，
M4 的 e2e 需要适配 —— 开头先离开总览页（订阅计数才干净）、服务端口改为轮询等待
（容忍 node 冷启动与端口竞争）、退订断言窗口放宽（等在途采样完成）。

**M7 验证结果（e2e 全绿，37 项）**：`node scripts/e2e-settings.mjs` 覆盖 ——
分组渲染 / 主题即时生效 / 通知开关 / 白名单增删 / 清理计划落盘 /
计划触发全链（冒烟探针） / 危险区（清空记录、重置设置）。

**连跑稳定性修复（2026-10-10 全量回归时暴露）**：六套连跑时出现两处「系统负载下才现形」
的测试时序问题（均为测试层修复）：M1 的窗口移动遇到「窗口尚未对 Win32 可见」需重试；
M4 的「离开总览页」在 React 挂载前点击会落空，导致总览常驻订阅干扰订阅计数。
修复后六套连跑全绿。

**git**：已提交 `a50873e`（M0+M1）、`3a0ebb8`（M2）、`be1f35e`（M3）、`a1f83a5`（M4）、`7f8081d`（M5）、`5004345`（M6）、`e251942`（M7）；M8 改动待提交（最后一批）。

---

## 15. 项目收官状态（2026-10-10）

**九套 e2e 全绿，共 229 项断言**：`e2e-check`(15) / `e2e-disk`(34) / `e2e-ports`(22) /
`e2e-ports-m5`(35) / `e2e-overview`(22) / `e2e-settings`(37) / `e2e-update`(22) /
`e2e-smoke`(30，深浅两轮) / `e2e-portable`(12)。

**M8 期间的产品级修复**：`sanitizeSettings` 漏了 `autoCheckUpdate` 字段 ——
「关闭自动检查更新」在设置页切了也写不进去（被 sanitize 丢回默认值），由 e2e-update 抓出并修复。

**打包链路三个坑（均已解决、已记录）**：
1. 项目路径含空格与中文 → `scripts/dist.mjs` 经 `pnpm exec` 调 electron-builder（避免 cmd 传参被截断）；
2. electron-builder 工具链下载需 npmmirror 镜像（本机 GitHub 不可达）；
3. 冒烟「驱动界面」与普通 e2e 的操作互相抢戏 → 拆成 `OPS_CABIN_SMOKE_DRIVE` 独立开关（普通 e2e 只保留无害的探针写文件）。

**人工待办（自动化覆盖不到）**：双击 `ops-cabin-0.1.0-setup.exe` 走一遍安装/卸载；
双击 portable 版体验免安装形态；真实 GitHub 发版（需先建 `FightZhanAng/ops-cabin` 仓库，
CI 文件已就绪但未实跑）。


---

## 16. M9：界面重设计 —— 仪器面板 v2（2026-10-10）

**背景**：v1 观感被评审否决（原话「页面太丑」）。以产品名里的「舱」为设计论点整体推翻重做：
**这不是一块仪表盘（dashboard），是一台仪表（instrument）**。

**三块基石**

1. 颜色是信号，不是装饰 —— 全站没有蓝、没有品牌色；交互动作一律石墨墨阶（`btn` 系）；
   绿 / 黄 / 红只表示状态与风险，且永远配文字（色盲双通道）；只有危险动作用红。
2. 数据是读数 —— 数字 / 端口 / 地址 / 路径 / 时间 / 微标签一律 `B612 Mono`（空客为驾驶舱
   显示屏委托设计的字体，内嵌 woff2，离线可用）+ tabular-nums，成列右对齐。
3. 结构是仪器面板 —— `Plate`（整板）+ `Bay`（格）用 1px 发丝线拼合，取代漂浮的圆角卡片。

**四种新零件**（`src/renderer/components/instrument/`）：`Lamp` 仪表灯（7px，夜间带辉光，
全站唯一允许的光）/ `SegBar` 分段仪表条（26–32 格 LED，扫描时叠加扫掠，色调由
`freeTone`/`loadTone` 决定）/ `Plate` + `Bay` / `Rocker` 拨档。
**签名元素**：`Scope` 端口雷达 —— 端口按 √ 刻度落到方位角、TCP 内环 UDP 外环、amber 扫描线
4.5s 一圈（全站唯一常驻动效，尊重 `prefers-reduced-motion`），悬停读出目标详情。

**双主题**：昼间「冷钢工作台」/ 夜间「驾驶舱夜航」；主题机制不变（`nativeTheme` +
`prefers-color-scheme`）。`--faint` 两主题都提到 ≥4.5:1（仪表刻印必须读得清）。

**改动面**：43 个文件（38 渲染层 + `index.css`/`main.tsx`/`volumes.ts` + 4 份设计文档 + 时序适配）；
`design-system/opscabin/MASTER.md` 与 `pages/*.md` 全部重写为 v2（含每页 e2e 契约清单）。

**回归暴露并修复的三个真实问题**

1. **首屏双重 PowerShell**：仪表轨曾加过一次 `listVolumes`（每次切页刷新），与页面自身请求并发
   抢 PowerShell 冷启动，压垮 smoke / disk 的固定窗口读数 → 删掉该读数，回到 v1 的 IPC 时序。
2. **`listVolumes` 改走 `fs.statfs` 快路径**：PowerShell 冷启动 1.2–1.6s，让「首屏 2.5s 内看到
   分区」长期贴边（M8 之前只是勉强绿）→ statfs 毫秒级、数值与 Get-PSDrive 完全一致（total 精确
   相同、free 差 10KB 级），缺盘 ENOENT 跳过，一块盘都拿不到才回退原 PowerShell 实现。
3. **端口页首屏**：离开总览后监控器停采，首屏现采冷启动 >2s。曾让 `ports:list` 优先返回最近快照，
   被 e2e-ports 抓住语义损失（「新服务端口出现」失败）→ 已回滚为「每次现采」；smoke 驱动的
   等待窗口 2s→5s（测试层适配，与 §14 的 M6 先例一致）。

**测试层修的两个既有脆弱点（与改版无关，但同批修掉）**

1. `e2e-scan`（M2 遗留套件，不在九套回归清单内）：进度断言「350ms 内收到首条进度」与 M3+ 引擎
   演进脱节（worker 启动 + 测量阶段 > 350ms）→ 改为轮询等待（≤5s）；单独运行全绿，
   在高负载连跑下该套件偶发 fixture/worker 抖动（已记录）。
2. `e2e-check`「重启恢复窗口位置」：探针助手只等「文件存在」不等「文件更新」，重启阶段可能读到
   上一轮的 `window.json`（默认坐标 370,120）→ 重启前先删该探针，连跑 3/3 全绿。

两处的定性均由 `git diff 1a727e0 -- src/main` 佐证：M9 对主进程的改动面只有 `volumes.ts`
与 `index.ts` 里一行注释，窗口/扫描路径一行未碰。

**验证（最终树）**

- 九套 e2e 全绿：`e2e-check`(15) / `e2e-disk`(34) / `e2e-ports`(22) / `e2e-ports-m5`(35) /
  `e2e-overview`(22) / `e2e-settings`(37) / `e2e-update`(22) / `e2e-smoke`(30，深浅两轮) /
  `e2e-portable`(12)；
- `pnpm dist` 出安装包（setup / portable / `latest.yml` / blockmap），`e2e-portable` 全绿；
- `e2e-scan` 全绿（单独运行）；
- 冒烟截图留档：`%TEMP%/ops-cabin-smoke-light`、`-dark`（四页 × 深浅两轮，人工目检过：
  分区读数与走势痕迹、雷达底座与图例、监听表定宽不溢出、设置分组行距与对比度）。

**已知遗留（后续候选，未拍板）**

- 端口页首屏现采冷启动 2–4s：可考虑新增 `ports:last` 通道让页面先用最近快照立即可视（保持
  `ports:list` 的「现采」语义不变），或并行化 `collectPorts`；
- `e2e-ports` 的「变化检测」段在系统负载下偶发红（M4/M6 已知敏感性，与本次改版无关）；
- 上一节 §15 的人工待办（安装包双击实测、真实 GitHub 发版）仍然有效。

---

## 17. 首次发版（2026-10-10）

**仓库**：`github.com/FightZhanAng/ops-cabin`（新建，与 electron-builder 的 `publish.owner/repo` 对齐）。
**版本**：`0.2.0`（M9 界面重设计随版发布）；tag `v0.2.0`。

**发版链路**：tag `v*` → GitHub Actions（`.github/workflows/release.yml`）→ windows-latest 上
`pnpm typecheck` → `pnpm dist` → `softprops/action-gh-release` 上传四类资产：
`*-setup.exe` / `*-portable.exe` / `latest.yml` / `*.blockmap`。

**版本纪律（本次落地）**：测试脚本里的版本断言全部改为读 `package.json`
（`e2e-update`、`e2e-portable`）—— 以后升版本只改 `package.json` 一处。

**本地预验**：`pnpm dist`（0.2.0 产物）+ `e2e-portable` + `e2e-update` + `e2e-check` + `e2e-smoke` 全绿。

**本机推送通道（备忘）**：22 端口被拒，`~/.ssh/config` 把 `github.com` 的 SSH 改走
`ssh.github.com:443`；`gh` CLI 已登录 `FightZhanAng`（`gh api` 可用，`api.github.com` 虽在 hosts 里）。

**首次实跑 CI 的注意点**：Release 资产缺 `latest.yml` / `*.blockmap` 会让应用内检查更新持续报错；
若 runner 上 electron 二进制下载缓慢，可在工作流里改 `ELECTRON_MIRROR` 镜像地址。

**首跑结果（2026-10-10）**：tag `v0.2.0` → run
[38043172973](https://github.com/FightZhanAng/ops-cabin/actions/runs/38043172973) 全程 **2 分 0 秒
全绿**（Checkout → pnpm/Node → install → typecheck → dist → 上传资产）；
Release [v0.2.0](https://github.com/FightZhanAng/ops-cabin/releases/tag/v0.2.0) 四类资产齐备
（setup 96.1MB / portable 95.9MB / `latest.yml` / `.blockmap`）。CI 唯一提示是
`actions/*` 的 Node 20 运行时弃用警告（不影响）。本地十套 e2e 在 0.2.0 上全绿。

---

## 18. 开源化：README / LICENSE / 第三方声明（2026-10-10）

**补的是什么**：`README.md`（功能 / 下载安装 / 磁盘清理的三道安全防线 / 端口雷达用法 / 开发与十套 e2e /
设计说明 / 隐私）、`LICENSE`（**MIT**，版权人 FightZhanAng —— 参考项目 aihot-desk 未带许可，此为项目自定）、
`THIRD-PARTY-NOTICES.md`（运行期内嵌组件表 + **B612 Mono 的 SIL OFL 1.1 全文**，逐字取自
`@fontsource/b612-mono/LICENSE`）。

**合规要点**：内嵌字体 OFL-1.1 要求分发时**随附许可文本** —— 因此 `electron-builder.yml` 的
`extraResources` 增加 `LICENSE` 与 `THIRD-PARTY-NOTICES.md`，二者随安装包落到应用 `resources/` 目录；
Chromium / Electron 的许可由 Electron 自身随包提供（`LICENSE.electron.txt`、`LICENSES.chromium.html`）。
lucide 为 ISC、class-variance-authority 与 TypeScript 为 Apache-2.0（构建期，不随包），其余运行期组件为 MIT。

**package.json**：补 `license`、`repository` 字段；版本 `0.2.0 → 0.2.1` —— 发布物内容发生变化
（多了许可文件与说明文档），以补丁版经 CI 重出安装包与 Release。

**验证**：`pnpm dist` 后核对 `release/win-unpacked/resources/{LICENSE,THIRD-PARTY-NOTICES.md}` 存在；
`e2e-portable` 全绿；README 截图取自 0.2.1 冒烟（浅色总览、浅色端口、深色总览）。

**附带的测试基建修复**：冒烟驱动 `capturePage()` 偶发拿到「导航前的陈旧帧」（深色轮把端口页截成了磁盘页
——被遮挡的窗口可能停更合成帧）→ `src/main/smoke.ts` 的 capture 改为「窗口移到最前 + 等一帧 + 取两次」；
重跑冒烟，深浅两轮八张截图全部正确（该函数只在 `OPS_CABIN_SMOKE_DRIVE=1` 时执行，普通 e2e 不受影响）。

**发布**：`v0.2.1`（run 38044051256，2m0s 全绿）→ Release 四类资产齐备；仓库设 7 个 topics
（windows / electron / react / desktop-app / disk-cleaner / port-monitor / developer-tools）。

---

## 19. M10 / M11：总览补齐运维视角 + 自绘外壳（2026-10-12）

**本轮定位**：M9 把界面语言立住了（仪器面板 v2），但总览只有「当前一瞬」的四条读数 + 两个列表。
M10 把总览从「快照」补成「有时间轴、有横向对照、有连通性结论」的运维视角；
M11 把「系统标题栏 + 侧栏底部版本号」这套默认外壳换成自绘。

### 19.1 M10 五项

**① 清理记录统计**（`overview-clean-stats`）
只读消费既有的 `clean-history.json`，不改写数据链路。柱（每次释放量）+ 折线（累计）+ 读数三件套；
时间窗与「最近 N 次」由 `Rocker` 拨档。

**② 网络吞吐**（`src/main/net.ts`）
数据源是 `netstat -e`，2s 采样、差分算速率、负增量归零（网卡计数器回绕或重置时）、读不到时沿用旧读数
（不把「命令失败」渲染成「网速 0」）。
**本地化陷阱**：`netstat -e` 的行标签随系统语言变（中文是「字节 / 接收的 / 发送的」，英文是
`Bytes / Unicast packets / ...`），只有数字稳定。`parseNetstatBytes()` 因此**按位置取第一行「含 ≥2 个纯数字」
的数据行**，不做标签匹配 —— 标签匹配在任何一次系统语言变化后都会静默失效。
界面：`MetricsPanel` 加「网络」读数行，**不给 SegBar**（吞吐没有分母，画成百分比条是假信息），
走势线按窗口峰值自定标。

**③ 长期趋势落盘**（`src/main/trend.ts` + `overview-trend`）
`TrendStore` 每 5 分钟落一点、保留 7 天、上限 3000 点；`writeFileAtomic`（tmp + fsync + rename）落
`trend.json`；`readTrend()` 读时过滤越界点 + 排序（磁盘上可能有手改或旧版本残留）。
采样间隔可用 `OPS_CABIN_TREND_SAMPLE_MS` 注入，`tick()` 对外暴露供自检手动推点 —— 否则「5 分钟一点」
这个节奏在测试里无法验证。
**画图两条硬约束**：`preserveAspectRatio="none"` 会把 SVG 内的文字一起横向拉伸，所以**刻度必须画在 SVG 外面**；
CPU 与内存**共用一根 0–100% 轴**（双轴会把两条不同量纲的线缩放成差不多高，视觉上暗示它们可比）。

**④ 进程榜**（`src/main/processes.ts` + `overview-processes`）
把原在 `ports/collect.ts` 里的进程表抽成共享模块（端口页与总览复用同一份缓存，避免两处各拉一次 PowerShell）。
CPU 口径：`Win32_Process` 自带 `KernelModeTime` / `UserModeTime`（累计 100ns），两次采样差分 ÷ 墙钟 ÷ 逻辑核数
= 占总 CPU%（与任务管理器同口径）。
**不选 `Win32_PerfFormattedData_PerfProc_Process`**：它要额外等一个完整性能计数器周期（实测 +2.5s）才出数，
对 20s 刷新一次的榜单代价过高。
排序取「内存 Top N ∪ CPU Top N」并集 —— 只按单列取会让另一列的高占用进程完全消失。
界面用 `Rocker` 切档（内存 / CPU）；相对量级用中性 `SegBar tone="ink"`（不用信号色，这里没有「好/坏」）。

**⑤ 联网体检**（`src/main/netcheck.ts` + `overview-netcheck`）
6 条并行探针：DNS 解析 / GitHub 443 / GitHub 22 / `ssh.github.com:443` / API 可达 / 代理环境。
三个判据上的讲究：
- **证书失败 ≠ 通道不通**：本地代理做 TLS 拦截时严格校验必然失败，但通道是可用的。`probeApi()` 在证书
  错误时用 `rejectUnauthorized: false` **重试一次**，成功则返回 `untrusted: true` → `state: 'info'`（不是 `fail`），
  文案「证书不受信任但通道可用（本地代理 TLS 拦截）」。
- **`isCertError()` 要同时看 message 与 `error.code` 并归一化连字符**：Node 给的是
  `self-signed certificate`（连字符）+ `DEPTH_ZERO_SELF_SIGNED_CERT`，只按空格写法匹配会漏（本轮踩过）。
- **`describeNetworkError()`** 把 Node 原始报文（`ECONNREFUSED` / `ETIMEDOUT` / `EAI_AGAIN`）转成人话；
  回环地址额外加注「指向本机 · hosts 改写或本地代理」。

**本机实测结论**（已固化进文档）：`github.com` 被解析到 `127.0.0.1`（hosts 改写或本地代理），
443 有本地监听、22 是 `ECONNREFUSED`；`api.github.com` 间歇性证书不受信任 —— 与 §17「本机推送通道」的
备忘一致。

### 19.2 M11 三项

- **自绘标题栏**：`frame: false` + `-webkit-app-region: drag / no-drag`；`win:minimize` /
  `win:toggle-maximize` / `win:close` 三个 IPC，外加 `win:state` 主动推送
  （`maximize` / `unmaximize` / `restore` 事件），否则最大化按钮图标不会跟着窗口状态翻。
- **关于弹窗**：版本号从标题栏文字改为**点击弹窗**，弹出层内含版本号 + GitHub 项目页快捷入口。
- **侧栏**：菜单补图标、支持收起（收起后只留图标）；底部**去掉 Electron 版本号**，换成主题三档切换。

### 19.3 e2e 契约扩展（64 项全绿）

`src/main/smoke.ts` 的 `view-overview` 段新增 `netText` / `trendPlate` / `trendPoints` / `trendRange` /
`trendCpuPeak` / `trendCpuLine` / `trendMemLine` / `processPlate` / `netcheckPlate`；
新增三段驱动：`view-processes`（切档前后行序）、`view-trend`（24h vs 7d）、`view-netcheck`（真实探测）。
截图新增 `screen-overview-trend` / `screen-overview-netcheck`（深浅各一）。

新增 5 条断言：清理统计形状与排序、网络读数单位、趋势出线、7 天窗差值 = 7、进程榜切档降序且 ≤100%、
体检结果形状。趋势种子用 12 点带起伏 + 7 个窗外点，`data-cpu-peak` 断言用 `>=`（应用启动会自补一点）。

### 19.4 测试基建两处改进

1. **冒烟断言改 ASCII 标记 + 结果落盘**：`check()` 的 `✓/✗` 改 `[ok]/[FAIL]`，逐项结果写
   `ops-cabin-e2e-result.json`。原因：PowerShell `Out-File` 把 node 的 UTF-8 输出按 GBK 解码再编码，
   `✓/✗` 全变成 `鉁?`，**失败项无法定位**。同时驱动命令前设 `[Console]::OutputEncoding = UTF8`。
2. **总览等待改「一次等齐三件事」**：原来分三次轮询（清理统计 / 网络 / 进程），串行等待把每轮冒烟的
   固定开销拉长；改为单次轮询同时等 `data-runs` + 网络读数含 `/s` + 进程行 > 0（最多 60×250ms）。

### 19.5 本轮踩到的两个真 bug

| 现象 | 根因 | 修复 |
|------|------|------|
| 进程榜 CPU 列**整列 null** | `top()` 建基线后快照只隔 1.2s，被 TTL(10s) 判为「新鲜」，第二次采样根本没发生 —— 缓存新鲜 ≠ CPU 可用 | `Snapshot` 加 `hasCpu` 字段，刷新判定改为 `!hasCpu \|\| 超过 TTL`；`BASELINE_WAIT` 1200 → 300（真正决定差分窗口的是两次 PowerShell 采集之间的间隔，不是这个等待） |
| 体检把「证书不受信任」误报成「不通」，且文案被截断（`certificate signatu...`） | 未区分「严格校验失败」与「通道不可用」 | 见 19.1 ⑤ 的重试策略 |

另有 `isCertError()` 漏匹配连字符、趋势图纵轴 `0%` 与横轴标签撞行（纵轴列改为只与 SVG 同一行，
横轴与图例用 `ml-11` 与图左边缘对齐 —— 靠布局对齐，不用 `padding` 硬凑）两处修正。

**验证**：`pnpm typecheck` 通过；两轮 e2e（浅色 / 深色）**64/64 全绿**；
四份一次性隔离单测全过 —— netstat 解析 5 项 / 进程榜 7 项 / 体检探针 6 项 / 证书分支 6 项。
证书分支曾因本机 badssl 被 `ECONNRESET` 拦掉而无法复现，改用 `openssl` 自签证书 + 本地
`https.createServer` 做到确定性复现（严格请求报 `self-signed certificate`、放宽后 HTTP 200）。

## 20. M12：侧栏常驻状态 + 三项清单式体检（2026-10-12）

**本轮定位**：M10 把总览补成了「打开能看全」，但**只要不打开那个页面就一无所知** ——
侧栏补的就是这个缺口。另加三项「该不该在跑 / 有没有被改写」的清单：它们都是**只读**的，
共同点是「事实早就摆在本机某个文件里，只是没人会主动去看」。

### 20.1 四项

**① 侧栏常驻状态**（`components/layout/useSidebarStatus.ts` + `nav-badge-*` / `nav-dot-*`）
导航项上直接挂读数：磁盘余量、服务异常数、自启残留数、窗口内的端口变化数。收起态退化成灯点，
读数折进 `aria-label` + `title`。规则见 `design-system/opscabin/MASTER.md` 的「侧栏常驻状态」。
**硬约束：不许为徽标新增任何轮询** —— 端口那部分只监听 `ports:snapshot` / `ports:changes`，
刻意不调 `subscribePorts()`（那会把 netstat 提到 2 秒常驻，为了几个徽标让一个采集永远跑着，这是最容易走歪的地方）。

**② hosts 文件体检**（`src/main/hosts.ts` + `overview-hosts`，整行 Plate）
§19 的联网体检已经能说出「`github.com` 解析到 `127.0.0.1`」，却**看不到是谁改的**；这一格补上后半句。
- 编码按 BOM 判（无 BOM UTF-8 / 带 BOM UTF-8 / UTF-16LE —— PowerShell `Out-File` 默认写过第三种），不猜。
- **只报三件确定的事**：指向回环 / 指向黑洞（`0.0.0.0`）/ 命中发布链路域名。局域网映射一律不报 ——
  报得越宽，真正要看的那几条越容易被淹掉。
- **排序「发布链路优先」**：本机 hosts 有 60 条异常、面板只列 40 条，不排序那条 `github.com` 会被埋掉。
  判定顺序 = `watched` → `kind` → 行号，两处采样（总览格与独立段）读数一致。

**③ 服务关注清单**（`src/main/services/{collect,store}.ts` + `ports-services`）
端口回答「谁在听」，服务回答「该不该在跑」。六档状态而不是「跑 / 没跑」，两档最容易被误报：
`Disabled` 停着是**正常**（并进「停了」会让每个被禁用的驱动服务天天亮灯）、`missing` 要提醒的是
**「该清关注了」而不是「服务挂了」**（查不到也必须返回条目，静默丢弃会让用户以为自己从没关注过它）。
`pending` 是过渡态，走中性灯、不计入「不在跑」。
候选是 300+ 个服务，所以添加走**搜索式对话框**（滚动列表不现实），最多列 60 条并写明截断。

**④ 启动项清单**（`src/main/startup.ts` + 独立页 `startup`）
五个来源一次读全（`HKCU\...\Run` / `HKLM\...\Run` / `HKLM\Wow6432Node\...\Run` + 两个启动文件夹）。
两处判定是这一页的全部价值：
- **读 `StartupApproved` 的启用位**（值首字节 `0x03` = 禁用，`0x02/0x06` = 启用）。不读它就会把已经
  禁掉的自启项继续当成「每次开机都在跑」，用户会去清一个根本没在跑的东西。
- **`invalid` 只算「启用中」且路径不存在的项**，行状态必须与它同义。
- 裸命令名（无盘符 / 无分隔符）按**有效**处理（走 PATH 解析），判成失效是假警报。

### 20.2 采集层的结构性改动：TTL 缓存 + 并发合流

自启项要起 PowerShell（实测 1.3s），而侧栏与页面会**几乎同时挂载**。加了带 TTL 的缓存之后
又出现新问题：两个请求同时发现缓存为空，于是各起一次 PowerShell —— 缓存在这种情况下等于没做。
所以每个采集器都是「TTL 缓存 + inflight 合流」：

```ts
function startupReport(force = false): Promise<StartupReport> {
  if (!force && startupCache && Date.now() - startupCache.at < STARTUP_TTL) {
    return Promise.resolve(startupCache.report)   // 命中缓存
  }
  if (startupInflight) return startupInflight     // 有人正在采，搭他的车
  startupInflight = collectStartup()...
}
```

`STARTUP_TTL` 30s / `SERVICES_TTL` 15s；服务关注清单为空时**直接返回空数组，不起 PowerShell**。
三个写操作（加 / 删 / 改关注）后把服务缓存置空。

### 20.3 本轮踩到的真 bug

| 现象 | 根因 | 修复 |
|------|------|------|
| **「列出全部服务」一个都拿不到**（304 → 0） | 空 filter 分支被写成 `$items = @()`，等于把整条路径静默做废 —— 给 `-Filter` 传空串会报错，于是「干脆返回空数组」，但那是**全量查询**那条路 | 空 filter 走**不带 `-Filter`** 的全量查询；一次性单测复跑得到 304 个 |
| **启动项：灯比数字多** | 统计块的「路径失效」只算启用中的项，而行的灯按「路径没了就亮」判 —— 一条「已禁用且路径也没了」的项会让灯亮成「路径失效」，点「仅失效」看到的行数与上面的读数对不上 | 加第四档 `stale`（`idle` 灯 / 「已禁用 · 残留」），两个事实都留住；`data-disabled` 改为直接按 `item.disabled` 数 |
| **服务：侧栏说 1、面板说 2** | 「不在跑」有三处口径：面板把 `pending` 算进去、侧栏不算 | 统一成 `down ∪ missing`；`pending` 改中性灯 + 「切换中」，不计入任何计数 |
| **e2e 94 项全红且毫无线索** | 宿主环境带着 `ELECTRON_RUN_AS_NODE`，`electron.exe` 因此**退化成纯 Node**（没有 `app`），主进程加载到 electron-updater 就炸；而 harness 用 `stdio: 'ignore'` 把崩溃栈丢了 | 脚本里 `delete env.ELECTRON_RUN_AS_NODE`（环境的事不该要求每次调用都记得清）；子进程输出落日志，一个冒烟文件都没产出时打印日志尾巴 |

顺带修掉一处**潜伏的假通过**：启动项页的就绪轮询写成
`!document.querySelector('[data-testid="startup-refresh"]')?.textContent.includes('读取中')`，
元素还没挂载时可选链给出 `undefined`，取反就是「已就绪」—— 会在视图挂载前退出，把「还没渲染」当成「读完了」。
改成显式判元素存在。

### 20.4 e2e 契约扩展

`view-overview` 新增 `hostsPlate` / `hostsFlags` / `hostsWatched` / `hostsReadable` / `navCount` /
`navLabels` / `navBadges`（带 `data-testid` 与 `data-tone`）；`sidebar` 段新增收起态
`collapsed: { badges, dots, labels }`；`view-ports` 新增 `servicesPlate` / `servicePanel` /
`serviceCount` / `serviceDown` / `serviceRows` / `serviceStates` / `serviceNames`。
新增三段驱动与截图：`view-hosts`（+`screen-overview-hosts`）、启动项页（+`screen-startup`）。

新增 13 条断言，核心是**关系**而不是机器相关的数字：hosts 行数 === `data-flags`（截断在后端做、DOM 不丢行）、
`data-watched` 的行构成**前缀**、两处采样读数一致；导航 5 项且原四项仍在、徽标 tone 属四档且读数非空、
端口徽标 === 面板的 `data-down`、收起态徽标归零且灯点补位、`aria-label` 读得出读数；
服务三行 `running,running,missing` 与 `data-down` 一致；启动项 `data-invalid` === 行内 `invalid` 的条数、
`data-disabled` === `disabled + stale`、「仅失效」档行数 === 统计块的失效数、分组是固定顺序的子序列。

**种子环境新增 `service-watch.json`**：`Winmgmt` / `EventLog`（受保护服务，必然在跑 —— WMI 提供程序
自己就在响应这次查询，是自证式确定）+ 一个**故意不存在的服务名**（确定性覆盖 `missing` 那一档，
真实环境里要靠卸载软件才能碰到）。不种「已禁用」的服务：哪台机器上有、什么状态全看运气，
种进去只会得到随机器飘的断言。

### 20.5 测试基建改进

- **子进程输出不再丢弃**（见 20.3 第 4 行）：`ops-cabin-smoke-<theme>.log`，无产出时自动打印尾巴。
- **e2e 启动前删 `ELECTRON_RUN_AS_NODE`**：这个变量是宿主环境的事，不该由调用方每次记得清。
- 采集器另有一份一次性隔离单测（`--experimental-strip-types` + 自制 loader 补 `.ts` 扩展名）：
  启动项 5 项 / hosts 5 项 / 服务 5 项，全过。

**本机实测结论**（已固化进文档）：启动项 14 条 / 残留 0 条（来源分布 4+6+1+2+1），耗时 1305ms；
hosts 212 行 / 生效 63 条 / 异常 60 条（列 40 条、省略 20 条），其中 **11 个域名被指到 `127.0.0.1`**；
服务候选 304 个（2160ms），按名采集 3 个（1659ms）。

## 21. M13：计划任务清单 + 系统体检（2026-10-12）

**本轮定位**：M12 之后剩下的三件事里，这两件都是「**别处的真相，汇总到一处**」：

- **计划任务**补的是启动项页的缺口 —— Run 键只管开机那一瞬，真正在后台**按时**联网的大头
  （遥测上报、自动更新、定时检查）全在任务计划程序里，而那里没有人会主动去看。
- **系统体检**补的是「整体还好吗」这个问题的缺口 —— 故障盘、待重启、报错设备、事件日志、
  上次是不是没好好关机，原本要分别去「优化驱动器」「Windows 更新」「设备管理器」
  「事件查看器」各看一处。

第三项（通知扩展）留到下一批。

### 21.1 计划任务：加在启动项页做 Tab，不新开页

两者同族（都在回答「谁在开机 / 按时自己跑」），而侧栏项数是 e2e 的精确契约、每加一项都要
付契约成本。**决定性理由是数据本身**：Run 键与计划任务是同一个问题的两面，分开两页反而
让人要来回翻。于是「启动项」页成为页级 Tab 宿主（`data-tab`），两档**按需挂载** ——
计划任务那份要起一次 COM 枚举（本机 1.5 秒），没切过去就不采。

### 21.2 本轮最重的三条判定

**① `LastTaskResult` 不能按 `!= 0` 判失败。**
调度器把自己的状态也记在这同一个字段上：`0x41300` 就绪 / `0x41301` 正在运行 /
`0x41302` 已禁用 / `0x41303` 尚未运行 / `0x41304` 没有更多运行。**本机 17 个任务里有 6 个是
这两个值** —— 判错就让假警报占多数。入参一律 `>>> 0` 归一化。

**② `0x8007xxxx` 的低 16 位才是 Win32 错码，掩码必须 `>>> 0`。**
JS 的 `&` 走有符号 32 位：`0x80070002 & 0xffff0000` 得到 `-2147024896`，与字面量
`0x80070000`（`2147942400`）永不相等 —— 少了 `>>> 0`，整张 Win32 文案表就是**死代码**。
这个 bug 真的写进去了，靠自检的「结果码解码」那一组抓出来。

**③ 待处理文件队列不是「要求重启」（体检页最要紧的一条）。**
`PendingFileRenameOperations` 常被当成重启标记。实测本机 24 个槽位（12 条操作，
配对里的空串是「目标为空」即删除）里实打实只有 8 个文件，而 `.atrust.running` 被登记了
**3 次**、`force_show` **3 次** —— **同一个操作重复登记，说明写队列的人根本没把它当重启要求**，
只是用 `MoveFileEx(MOVEFILE_DELAY_UNTIL_REBOOT)` 排了个「下次开机顺手删」。
按「有 N 条待替换文件 ⇒ 要求重启」报警，等于叫用户白重启一次。
→ 只有 CBS 与 Windows 更新两处注册表键算 `required`，这一项**永远**是 `advisory`。

### 21.3 性能：串行 11.1 秒 → 并发 3.8 秒

体检页全量串行量到 **11.1 秒**（命令行进程冷启动 5×0.65s + 设备枚举 3.7s + 磁盘 1.07s +
开机时刻 1.28s，各算各的）。四段之间没有任何依赖，`Promise.allSettled` 并发之后墙钟取决于
最慢的那一段。每一段的取数路径都是量过的：

| 段 | 取的 | 弃的 | 差 |
|----|------|------|----|
| 磁盘 | `MSFT_PhysicalDisk`（CIM 直查） | `Get-PhysicalDisk` 4.73s | **4.4 倍** |
| 设备 | `Win32_PnPEntity -Filter "ConfigManagerErrorCode <> 0"` | `Get-PnpDevice -PresentOnly` 5301ms | **2.5 倍** |
| 计划任务 | COM `Schedule.Service` | `Get-ScheduledTask` 3.7s | **2.4 倍** |

### 21.4 本轮踩到的真 bug

| 现象 | 根因 | 修复 |
|------|------|------|
| **`0x8007xxxx` 的 Win32 文案从未生效** | 掩码结果是有符号数，与无符号字面量永不相等（见 21.2 ②） | 补 `>>> 0`，并加 `win32 !== 0` 防止印出「Win32 错误 0」 |
| **任务「路径失效」100% 误报** | 有的安装程序把引号写进了任务 XML 的 `<Command>`（本机 WPS、Snipaste），`existsSync('"D:\...exe"')` 必假 | 抽出共用模块 `execpath.ts` 走 `parseExecPath`；`%SystemRoot%` 类变量先展开 |
| **计划任务采集 3.7 秒**（探针预估 0.45s） | `Get-ScheduledTask` 逐任务走一次 WMI 往返（180 个任务 = 180 次） | 换 COM 枚举 → 1.5s；映射表先在本机 180 个任务上与 cmdlet 类名**逐条对齐**才敢用 |
| **「每个任务都必须有触发器」是错误断言** | 本机 Snipaste 是手动任务，本来就没有触发器 | 改断言为「无触发器的任务按『手动』呈现而不是崩掉」 |
| **已禁用任务仍显示「下次 10-12 20:00」** | 禁用的任务可能留着一个陈旧的 `NextRunTime`，但不会在那个点跑 | `showNext = state !== 'disabled' && nextRunAt !== null`；登录/开机触发的任务同样省略（「下次 —」读起来像出错），加两条 e2e 契约防回归 |
| **体检的 53264 会被显示成「原始值 53264」** | `Storage.types.ps1xml` 里有 **18 个类**各带一份 `OperationalStatus` 且**内容互不相同**；差点抓错属主 | 逐类定位后只认 `MSFT_PhysicalDisk` 那一段（第 689 行）；自检钉了一条断言把它钉住 |
| **枚举提取器静默返回 0 项** | 双引号正则里 `$_status` 被当变量展开成空串，正则失配 | 正则改用**单引号**字符串；这条教训写进了 `shared/health.ts` 与 `pages/health.md` |
| **`Get-PnpDevice` 报出 271 个「问题设备」** | 它枚举整个驱动仓库；不带 `-PresentOnly` 时本机 443 台里 270 台是 `CM_PROB_PHANTOM` 幽灵设备 | 改用 `Win32_PnPEntity`（只枚举在位设备：173 台 = `Get-PnpDevice -PresentOnly` 的 173） |
| **探针被 CLIXML 进度流打挂** | 首次使用模块时 shell 会往 stderr 写「正在准备首次使用模块。」的进度记录 | 四段脚本统一设 `$ProgressPreference = "SilentlyContinue"` |
| **体检页双列布局永远不生效** | 写的是 `xl:grid-cols-2`（1280px），而默认窗口宽 1180px | 门槛改 `lg`（1024px） |
| **导航项数断言挂了 2 项** | 断言写死 5 项，本轮加了「体检」变 6 项 —— **断言需要跟着改，不是代码 bug** | 改成 6 项并同时钉住「原五项仍在」（`5+1-1` 还是 5，只判计数抓不到挤掉一项的情况） |

### 21.5 界面上的两条诚实性修正

- **「已禁用」不算故障**（服务 → 自启项 → 计划任务 → 设备，第五次）。设备侧三条独立证据：
  ① 本机那块 Sangfor aTrust VNIC 的 Problem 就是 22；② 系统自带的
  `pnputil /enum-devices /problem` 报「**No devices were found on the system.**」——
  Windows 自己也不把被禁用的设备算作问题设备；③ `PnpDevice.Types.ps1xml` 的 CM_PROB 全表里
  `DISABLED`(22) 之外还有 `HARDWARE_DISABLED`(29) 与 `DISABLED_SERVICE`(32) ——
  那两个是「BIOS 里关了」「驱动服务被禁了」，属真问题，**不能一起并进这一档**。
  所以只认 22，多一个都不认。
- **拿不到就说拿不到**。SMART 磨损度与温度在本机读不出来
  （`Get-StorageReliabilityCounter` 报「无法使用指定的命名参数解析参数集」、
  `MSStorageDriver_FailurePredictStatus` 报「不支持」），所以只给粗粒度健康档并在界面上写出来。
  磁盘健康**只有 `HealthStatus === 0` 才算通过** —— `null`（读不到）与 `5`（未知）都不算，
  且界面上「读不到」与「未知」分开写。

### 21.6 自检与 e2e 扩展

**采集器真机自检**（`.workbuddy/tools/collectors-check.mjs`）新增三组：
体检 21 项 + 磁盘枚举映射 16 项 + 设备分档 5 项。其中两条是**关键回归**：
`diskOperationalText([53264]) === '原始值 53264'`（这个码属于 `MSFT_Disk`，不属于
`MSFT_PhysicalDisk`）、非法枚举显示原始数字而不猜名字。

**e2e** 新增 `view-health` 驱动段与 **11 条断言**，全部断言**关系**而不是机器相关的数字；
外加两张截图。新加的一条基建规则：**首屏之下的内容必须单独截一次**
（`scrollTo(0, 99999)` + `screen-health-logs`）—— 断言全绿和「这一页好不好看」是两件事。

`view-tasks` 段的 11 条断言（上一节已加）本轮一并跑通。

**验证**：`pnpm typecheck` 通过；`pnpm build` 通过；两轮 e2e（浅色 / 深色）**129/129 全绿**；
采集器真机自检全绿；截图自审通过（`screen-health` / `screen-health-logs` 深浅各一张）。

### 21.7 本机实测结论（已固化进代码注释与断言）

- **计划任务**：180 总数 / 163 跳过（`\Microsoft\*`）/ **17 列出** / 1 需留意 / 7 已禁用 /
  10 启用 / **1527ms**。真凶是 NVIDIA 遥测 ×5、Edge 更新 ×5、WPS 定时联网 ×3（全已禁用）、
  Snipaste 手动任务上次被强制结束（`0x40010004`）。
- **体检**：**3842ms** / 要求重启 **0** 处 / 待处理文件 8 个（12 条登记，有重复）→ `advisory` /
  磁盘 1 块 `NVMe SAMSUNG MZVLW256`（系统盘）256GB 健康 · 固态硬盘 · NVMe · OK /
  设备 1 台 `Sangfor aTrust VNIC / Net / 代码 22` → `disabled` /
  System 近 7 天 16 条 5 来源（`Netwtw06` ×8 —— Intel 无线网卡驱动反复报）/
  Application 近 7 天 189 条 5 来源（`.NET Runtime` ×182 —— Steam++ 在刷日志）/
  意外关机 2 次（30 天）：`09-29 12:56 Kernel-Power 41` + `09-29 12:57 EventLog 6008`。

---

## 22. M14：通知扩展（2026-10-12）

### 22.1 四项交付

| # | 内容 | 说明 |
|---|------|------|
| 1 | **统一通知出口** `src/main/notify.ts` | 四类信号（`port` / `scan` / `service` / `update`）各一个开关；开关判定与安静时段判定都收在这一处；**每一次调用都留档**（含被拦下的） |
| 2 | **服务后台盯梢** `src/main/services/monitor.ts` | 60 秒一拍、无关注项不跑、复用 `servicesCache`；变化检测是纯函数 `diffServices`（可脱机验证）；`add/remove` 关注时立即对齐基线 |
| 3 | **持续异常重复提醒** | 挂起且**已通知过**、满 30 分钟仍未恢复 → 再提醒一次（`notifySustained`） |
| 4 | **安静时段 + 更新落点** | `QuietHours { enabled, start, end }`（默认关闭、支持跨午夜）；设置页通知分组重做；「发现新版本」补上侧栏徽标 |

改动前的状态是：端口变化有通知（有开关）、计划扫描完成有通知（**没开关**）、服务与更新**完全没有**；
且两个 `new Notification(...)` 各自为政，任何「统一判定」都无处落脚。

### 22.2 三条最要紧的口径

1. **开关与抑制判定只在出口做。** 散在各调用点判是漏判的温床，而且被拦下的那些不留档 ——
   「为什么没收到通知」就永远答不上来。现在每一次调用都落一条记录（`shown` / `off` / `quiet` / `failed`），
   `quiet` 那条还写明当时的区间。
2. **安静时段内丢弃，不延后。** 四类信号在界面里各有各的家（端口事件流水账 / 服务面板与侧栏
   徽标 / 磁盘页扫描记录 / 更新区块与侧栏徽标），静默 ≠ 丢失；延后反而会把一小时前的消息
   伪装成刚发生的。**做静音之前先确认这条消息在别处还有个家**，没有就别静音 —— 先补落点。
3. **两道判定都 fail-open。** 设置还没装载好、时段格式坏掉、`start === end`（零长度）一律按
   「不静音」处理：宁可吵，不可哑。方向搞反了会静默吃掉**所有**通知，而且没人会发现。

配套的三条服务判据纪律：`serviceDown()` 只有一份（侧栏 / 服务面板 / 盯梢三处共用）；
`stopped` 且启动类型是 `Disabled` 不算异常（本会话第五次同一条纪律）；
**「已恢复」只在发过「挂了」之后才说** —— 启动时就是停着的服务后来自行起来了，
那是「刚起来」而不是「恢复」，报出去只会让人去找一条并不存在的警报。

### 22.3 本轮踩到的真 bug：陈旧快照把「一直占着」读成「刚被占用」

自检第一版跑完，通知留档里多出一条**不是我造的变化**：

```
"1719 被占用；1720 被占用；1721 被占用"   ← 三条新关注的端口齐刷刷报占用
```

根因在 `PortsMonitor.setWatchlist()`：新关注项的基线取自「最近一次快照」，但**没有校验快照的年龄**。
应用刚起来就关注、或自检里批量关注时，快照可能已经放了几分钟（里面还没有这些端口），
于是「快照里找不到」被当成「它没在监听」，紧接着的第一次采样就把「其实一直占着」报成「刚被占用」。

两种修法里选了语义更清楚的那个：给快照加年龄上限（10 秒，比一个采样周期长一点），
**过旧的快照不再当基线依据**，改为 `#pendingBaseline` 标记 —— 下一拍只补基线、不报变化。

```
快照新鲜（用户从端口页点关注：页面显示的就是它）→ 立刻建基线 → 保留「不吞掉关注后几秒内的变化」
快照过期 / 没有（应用刚起来、批量关注）      → 标 pending → 下一拍只补基线，绝不凭空报一条变化
```

这条修复不是为自检改的：同样的路径在真实使用中也会踩（打开端口页、页面首拍还没回来就点关注）。
自检只是把它放大成了必现。e2e 里加了对应的回归断言 —— **恰好三条**，一条不多。

### 22.4 自检与 e2e 扩展

**通知端到端验证**（`smoke.ts` 内新增一段）走的是真实路径，不是直接调 `notify()`：

```
起三条真在监听的端口服务器 → 订阅 + 刷新快照 → 加关注（建基线）
  → 关 A：期望 shown          （正常路径）
  → 开安静时段（覆盖此刻）→ 关 B：期望 quiet
  → 关端口开关 → 关 C：期望 off
  → checkUpdate()：期望 update/shown（同一个版本号只通知一次）
```

安静区间取「此刻前后各一小时」：长度 120 分钟必然覆盖当前分钟，且当测试跑在 23 点或 0 点
前后时 `start > end`，**顺带把跨午夜分支也走一遍**（写死 22:00–08:00 就永远只测到一种形态）。

e2e 新增 7 条断言（含「恰好三条」那条假警报回归）与 `OPS_CABIN_FAKE_UPDATE` 注入
（假版本号让更新分支不必真联网）；采集器真机自检新增 **24 项**真值表
（安静时段 7 项含跨午夜 / 零长度 / fail-open；服务判据 5 项；盯梢判定 11 项含基线、
恢复、重复提醒阈值、删项清状态；聚合文案 1 项）。

服务「挂起」这条路径**没有端到端自检**：没有可靠的办法让一个真服务中途挂掉
（`Winmgmt` 停不掉，能动的手动服务各台机器都不一样）。它由纯函数真值表兜住，
这是这一批唯一一处「验证强度低于其余部分」的地方，写在这里以免下次误以为它也验过了。

### 22.5 性能与本机实测

- 服务盯梢：**无关注项时不跑**；有关注项时 60 秒一拍，且吃 `servicesCache`（15 秒 TTL）——
  窗口开着时侧栏本来也在拉同一份，实际很少真的多起一次 PowerShell。
- 通知本身零采集成本：四类信号全部搭在已有的采集/推送路径上（端口盯梢、扫描调度、
  服务盯梢、更新检查），没有任何为通知新增的轮询。
- 本机实测（自检留档）：三条 probe 记录 `shown / quiet / off` 各一条、**总计恰好三条**；
  更新通知恰好 1 条；侧栏出现 `nav-badge-settings:warn=有新版本`。
- **验证**：`pnpm typecheck` 通过；`pnpm build` 通过；两轮 e2e（浅色 / 深色）**164/164 全绿**
  （含 8 条通知断言与新增的 `screen-settings-quiet` 状态截图）；采集器真机自检全绿（新增 24 项）。

---

## 23. M15：启动项可写化与磁盘扫描扩展（2026-10-13）

**背景**：启动项与计划任务两页此前只读 —— 看得到「谁在开机时跑」，接不上「把它关掉」；
大文件扫描的入口只放开单目录；清理位置清单停在 14 个老位置。本批正面解决这三件事
（旧设计注释里「写要等先有备份与一键还原」的押后条件，由「禁用/启用天然可逆 + 删除只对
零恢复价值的失效项开放」替代满足）。术语见 `CONTEXT.md`；不可逆取舍见
`docs/adr/0001-写操作提权.md`；规格与任务见 `docs/specs/2026-10-13-M15-启动项可写化与磁盘扫描扩展.md`
与 `.scratch/M15/tickets/`。实现链：grill-with-docs → to-spec → to-tickets → implement → 全量回归。

### 23.1 A 线：可写化（启动项 + 计划任务）

- **启动项开关（S1–S4）**：行内开关直接禁用/启用。禁用只写 `StartupApproved` 首字节
  （0x03 禁用 / 0x02 启用），其余 11 字节（时间戳）原样保留 —— e2e 用带自定义尾字节的夹具
  做了字节级往返断言。HKCU 项与用户启动文件夹全程无 UAC；HKLM / 公共启动文件夹走按次提权。
- **删除登记（S5–S7）**：只有「路径失效」的条目出现删除入口（含「已禁用 · 残留」档）；
  二次确认（不可撤销、只删登记不碰程序本体）→ 直接删除不进回收站（D7）→ 强制重读。
  注册表来源删 Run 值并尽力清理启用位；文件夹来源删 .lnk（防御性分支，见 23.3-6）。
- **计划任务开关（S8/S10）**：`schtasks /Change /ENABLE|/DISABLE`；**先直写、失败才提权**
  （用户自建任务多数免 UAC，任务 ACL 不放开的才弹一次）。「已禁用」不进「需留意」的
  既有判据不变 —— e2e 断言「已禁用读数 +1 且需留意不动」。
- **任务删除（S9）**：只对 `missing` 档开放；`schtasks /Delete /F`；找不到=已达标（幂等成功）。
- **两页同口径**：开关防连点、失败文案（needs-admin / stale / cancelled / denied）、
  强制重读、删除确认框全部共用同一份实现（`failText.ts` / `DeleteConfirmDialog.tsx`）。

### 23.2 按需提权与安全边界（ADR 0001）

- 渲染层只传 `id`（D8）；主进程从**刚重采集的报告**重建执行参数，id 对不上直接 stale ——
  渲染层被攻破也改不了/删不掉任何报告之外的对象。
- 需要管理员的动作：`Start-Process -Verb RunAs` 以 `--apply-op` 再启动一个本应用实例
  （**受控助手**）→ 助手按 `executeStartupOp / executeTaskOp` 执行、写回结果文件、退出。
  弹窗身份是「运维舱」而不是 PowerShell；**不常驻高权限、不重启提权**。
- 封闭操作集（D4）：启动项改/删 + 任务改/删，四类动作之外一律拒绝；助手请求文件必须位于
  系统临时目录、文件名符合 nonce 形态、体积 ≤64KB、时间戳在 5 分钟窗内 —— 从离线探针到
  e2e 直调都有伪造用例（非约定文件名 / tmpdir 之外 / 陈旧时间戳 / 未知域 → 全拒）。
- 自检模式下提权短路为 `needs-admin`（自动化里没人应答 UAC，弹窗会把 e2e 挂死）；
  真实弹窗链路进人工清单（23.6）。

### 23.3 本轮踩到的真问题（全部有 e2e 或离线探针佐证）

1. **`(Get-Item $key).SetValue()` 写不进去**：Get-Item 拿到的注册表句柄没有写权限
   （报「无法写入到注册表项」，本机实测）→ 改走 `Set-ItemProperty`。001 首跑全红的根因，
   靠离线探针（diag-enable / diag-acl）逐层定位。
2. **schtasks 输出是 OEM 代码页**（中文机器 GBK），而 runPowerShell 会把控制台换成 UTF-8 ——
   中文错误信息过那条通道全是乱码，「拒绝访问」与「找不到了」无法分类 → 改直接 execFile +
   显式 GBK 解码（英文系统上 GBK 对 ASCII 无损，英文关键词照样能匹配）。
3. **e2e-settings G 与 M14 的基线语义冲突**：`#pendingBaseline`（M14：新关注时已被占用的
   端口不报变化）让「先起服务再关注」的旧测试等不到事件 → 测试改为「先关注 → 过一拍建基线
   → 再起服务」。（M14 当时只跑了冒烟、没跑九套回归，所以当时没暴露。）
4. **侧栏徽标打断旧导航点击**：e2e-disk / e2e-ports / e2e-ports-m5 用 `textContent === '磁盘'`
   找 nav 按钮，M14 的徽标文字（「剩 12.2 GB」）让精确匹配落空 → 全部改按 `data-testid="nav-*"`。
5. **e2e-scan A 节扫描根与新夹具互相干扰**：A 扫整个 fixtureRoot，M15-006 新增的 second 根
   把「4 个 × 2MB」精确断言弄脏 → 收窄到本节目录；同时把取消等待从固定 1.5s / 900ms 放宽为
   轮询（5s 上限；高负载实测 0.9–2.9s，PLAN §14 已记录过该套件的负载敏感性）。
6. **文件夹来源的删除分支在采集口径下不可达**：.lnk 存在即「路径有效」，所以「失效 .lnk」
   这一态不存在（ticket 里的夹具预期按现实修正并留注释）；executor 的 .lnk 删除分支保留为
   防御性实现，由守卫（仅失效项可删）挡在前面。

### 23.4 B 线：磁盘扫描扩展

- **盘符快捷（S11）**：分区列表每颗盘（含映射盘——列表里有什么就开放什么）一个「扫这颗盘」
  → 以盘根为根跑大文件扫描；e2e 点 C: 断言进入扫描态后取消（不真等整盘）。
- **多目录（S12）**：`pickDirectory` 改 `multiSelections` 返回数组（渲染层 ≤8 截断），
  `parseScanOptions` 侧再截 8（双保险）；多根结果合并按大小降序 —— e2e 断言
  「两根合并口径 + 排序 + 覆盖 + 9 根只取前 8」。
- **清理位置扩展（S13）**：新增 11 个低风险位置（14 → 25 条定义）—— Chrome / Edge 各 profile 的
  `Cache` / `Code Cache` / `GPUCache`（**通配候选按 profile 各自成条目**，条目名带 `· <目录名>`
  后缀）、`D3DSCache`、NVIDIA `DXCache` / `GLCache`、VS Code `Cache` / `CachedData`。
  逐条标 `safe` 档与「自动重建 / 运行中可能锁住文件」的口径；白名单、系统保护名单、
  回收站等既有防线不变（S14）。
- **resolveTargets 能力扩展**：候选路径支持一段 `*`（profile 枚举 —— 需要的是 profile，
  不是通用 glob）；无通配时保持旧语义（取第一个存在的候选；文件夹/多 profile 各自成条目）。
- **本机实测**（2026-10-13）：safe 组解析出 8 处（含 Edge Default ×3：256M / 156M / 6.2M、
  D3DSCache 2.8M、GLCache 670K）；devCaches 7 处（VS Code 11M / 27M、pnpm / pip / uv / Yarn /
  Electron 等）。本机未装 Chrome、无 NVIDIA DXCache —— 如实不出现（缺失即跳过）。
  多 profile 枚举在 e2e 里用 LOCALAPPDATA / APPDATA 覆盖到夹具验证（2 个 profile 各自成条目、
  无重复、不碰真实用户目录）。

### 23.5 验证

- `pnpm typecheck` 通过；`pnpm build` 通过；
- 十一套 e2e 全绿（每套自带构建）：e2e-check(15) / e2e-disk(41) / e2e-ports(23) /
  e2e-ports-m5(35) / e2e-overview(19) / e2e-settings(39) / e2e-update(18) /
  e2e-smoke(164 × 深浅两轮) / e2e-scan(35) / e2e-autostart(100) / e2e-portable(12)；
- 冒烟截图重拍并更新 README 三张（浅色总览 / 浅色端口 / 深色总览）。

### 23.6 人工待办（自动化覆盖不到）

- **真实 UAC 全链**（自检下短路，e2e 只直调「提权后真正执行的那份代码」）：
  1. HKLM Run 项开关 → 同意：状态翻转；取消：行状态不变 + 提示「已取消（未提权）」；
  2. HKLM 失效项的**删除**经 UAC（003 的删除 + 002 的提权合流）；
  3. 公共启动文件夹 .lnk 项开关；
  4. 需要管理员的任务（任务 ACL 不放开的）开关 → UAC；
  5. **打包版**验证弹窗身份显示「运维舱」（需 dist 产物）。
- 安装包双击实测 / 真实 GitHub 发版（§15 起的历史待办仍然有效）。

---

## 24. 发版 v0.3.0（2026-10-13）

**版本**：`0.3.0`（M10–M15 六个里程碑随版发布）；tag `v0.3.0`。

**发版链路**：不变 —— tag `v*` → GitHub Actions（`.github/workflows/release.yml`）→
windows-latest 上 `pnpm typecheck` → `pnpm dist` → `softprops/action-gh-release` 上传
四类资产：`*-setup.exe` / `*-portable.exe` / `latest.yml` / `*.blockmap`。

**本地预验**：`pnpm dist` 出 0.3.0 全量产物；十一套 e2e 全绿（清单见 §23.5）；
README 三张截图取自 0.3.0 冒烟（浅色总览 / 浅色端口 / 深色总览）。

**版本纪律**：测试脚本版本断言自 0.2.0 起统一读 `package.json`（§17），本次升版只改一处。

**上一轮人工待办的进展**：§23.6 的真实 UAC 全链清单仍待人工执行（自检模式下短路提权，
自动化覆盖不到）；「安装包双击实测」仍有效 —— 本版新增的写操作在安装版上的表现值得一并过。

**首跑结果（2026-10-13）**：tag `v0.3.0` → run
[38358380094](https://github.com/FightZhanAng/ops-cabin/actions/runs/38358380094) 在 typecheck
阶段红 —— `scanner/categories.ts` 的 `readdirSync` 返回类型（`ReturnType<typeof readdirSync>`
取到的是重载表里的 Buffer 变体，与 `{ withFileTypes: true }` 的实际返回对不上）。
修复（`180344f`）后重打同一 tag（该版本未产生 Release），二跑 run
[38358693144](https://github.com/FightZhanAng/ops-cabin/actions/runs/38358693144)
**2 分 19 秒全绿**（typecheck → dist → 资产上传）；Release
[v0.3.0](https://github.com/FightZhanAng/ops-cabin/releases/tag/v0.3.0) 四类资产齐备
（setup 96.28MB / portable 96.07MB / `latest.yml` / `.blockmap`）。CI 唯一提示仍是
`actions/*` 的 Node 20 运行时弃用警告（不影响）。

**教训一条**：本地 e2e 跑的是不带类型检查的构建（esbuild 剥类型），「构建绿」≠
「typecheck 绿」—— 发版前本地必须补跑一次 `pnpm typecheck`（本次它被 CI 拦住，
本地断言「typecheck 通过」的书面记录早于最后一次改动，属漏跑）。
