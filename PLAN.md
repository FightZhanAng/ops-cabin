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

## 3. M2 磁盘扫描引擎（纯主进程侧，无 UI 闭环）

**目标**：给定目录集合，产出分级清理候选列表，可取消、可看进度、不卡 UI。

**文件**：
- 新建 `src/main/scanner/scan.ts`：扫描任务本体（递归遍历、大小统计、跳过名单、取消信号、进度节流推送）
- 新建 `src/main/scanner/categories.ts`：分级规则表——安全清理（临时文件 / 回收站 / 缩略图缓存）、开发缓存（npm / pnpm / pip / cargo / go / IDE 缓存）、大文件（>100MB Top N）
- 新建 `src/main/scanner/index.ts`：任务管理（同一时刻一个任务；start / cancel / 状态查询）
- 新建 `src/shared/disk.ts`：`ScanItem` / `ScanGroup` / `ScanProgress` 类型（渲染层复用）
- 修改 `electron.vite.config.ts`：main 增加扫描进程入口（`utilityProcess` 多入口构建）

**实现要点**：
- 扫描跑在 `utilityProcess`（独立进程 + postMessage），进度每 200ms 节流一条
- 白名单（设置里的保护目录）+ 系统黑名单（`C:\Windows`、`Program Files` 等）在遍历层直接跳过
- 权限拒绝的目录：记录 `skipped` 计数继续，不中断
- 扫描产物：分组候选列表（每组含条目数、总大小、风险等级）

**验收**：
- 扫描本机 Temp + 开发缓存目录，产物条目与手工核对一致
- 10 万文件级扫描期间 UI 可交互、可取消（取消后 1s 内停止）
- 白名单目录不出现在结果里

---

## 4. M3 磁盘页（第一个完整闭环）

**目标**：扫描 → 勾选 → 预览 → 清理 → 反馈，全流程可用。
**设计依据**：`design-system/opscabin/pages/disk.md`。

**文件**：
- 新建 `src/main/cleaner.ts`：清理执行——删除进**回收站**（`trash` 包或 PowerShell Shell.Application）；永久删除独立选项；写清理历史
- 新建 `src/renderer/views/DiskView.tsx`（替换 App 占位）
- 新建 `src/renderer/components/disk/`：`PartitionList`（分区占用横条）、`ScanTabs`（安全/开发缓存/大文件）、`ResultTable`（多选 + 排序，虚拟化）、`DetailDrawer`（路径/大小/风险/打开所在目录）、`ScanProgress`（进度 + 当前路径 + 取消）、`CleanConfirmDialog`（AlertDialog：删除什么/多少/去向回收站）
- shadcn 组件引入（第一批）：`button` `dialog`/`alert-dialog` `table` `tabs` `checkbox` `progress` `sonner`（`pnpm dlx shadcn@latest add ...`）
- IPC：`scan:start` `scan:cancel` `scan:progress`（推送）`scan:result` `clean:preview` `clean:run` `clean:open-dir`

**交互硬规则（来自技能）**：
- 危险操作确认；成功必 toast（"已释放 3.2 GB"）；批量多选；表格不横向溢出（滚动容器 + 数字列右对齐）

**验收**：
- 完整闭环：扫描 → 多选 → 预览 → 清理 → toast + 释放数字
- 删除内容可在回收站还原；黑名单/白名单保护生效（造一个受保护文件测）
- 扫描结果 5 千条时表格滚动流畅（虚拟化生效）

---

## 5. M4 端口采集引擎

**目标**：1-2 秒轮询出全量监听端口 + 进程详情 + 关注端口变化检测。

**文件**：
- 新建 `src/main/ports/collect.ts`：数据源 `netstat -ano`（解析 LISTENING + 进程 PID）合并 `Get-CimInstance Win32_Process`（一次拿全部进程名/路径/命令行，缓存 10s）；进程内存/启动时间来自 `Get-Process`
- 新建 `src/main/ports/watch.ts`：轮询调度（默认 2s，页面不可见时降频到 10s）、与关注清单比对产生变化事件（occupy / release / change）
- 新建 `src/main/ports/store.ts`：关注清单持久化（`watchlist.json`，复用原子写）
- 新建 `src/shared/ports.ts`：`PortEntry` / `PortChange` / `WatchItem` 类型
- IPC：`ports:list`、`ports:subscribe`（推送刷新）、`ports:watch:add/remove/update`

**实现要点**：
- PowerShell 调用集中在启动时（拿进程表）+ 30s 刷新；`netstat` 每 2s 跑
- 关注端口变化 → 主进程记事件 + `Notification`（开关在设置）

**验收**：
- 端口列表与 `netstat -ano | findstr LISTENING` 条数一致
- `pnpm dev` 起一个 vite 服务占 5173 → 页面 2s 内出现该端口与 node 进程
- 关注 5173 → 关掉服务 → 收到"释放"通知（通知开关打开时）

---

## 6. M5 端口页 + 通知

**目标**：雷达界面成型。
**设计依据**：`design-system/opscabin/pages/ports.md`。

**文件**：
- 新建 `src/renderer/views/PortsView.tsx`
- 新建 `src/renderer/components/ports/`：`WatchGrid`（关注端口卡片阵：端口号等宽大字 + 状态灯 + 进程 + 时长 + 处置）、`PortTable`（全部监听端口，虚拟化 + 搜索 + 排序 + 筛选）、`ProcDrawer`（进程详情 + 结束进程）、`ChangeTimeline`（变化记录）
- shadcn：`command`（搜索）、`switch`、`select`、`tooltip`、`scroll-area`
- IPC：`ports:kill`（优雅 `taskkill /PID` → 失败后强制 `/F`，需确认对话框）

**交互硬规则**：
- 结束进程 = 危险动作，确认对话框写明进程名/PID/后果；结果 toast
- 高频刷新下滚动位置与选中态保持（避免整表重挂载）
- 状态灯配文字（双通道），"端口被占用"不用红色

**验收**：
- 卡片阵实时反映关注端口状态；增删改关注项即时落盘
- 结束一个测试进程（如 `node --watch`）成功且表格 2s 内更新
- 虚拟化表格千行滚动无卡顿

---

## 7. M6 总览页（首页）

**目标**：一屏回答"现在什么状况"。
**设计依据**：`design-system/opscabin/pages/overview.md`。

**文件**：
- 新建 `src/main/metrics.ts`：CPU（`os.cpus()` 差值采样）、内存（`os.totalmem/freemem`）、磁盘 IO 与网络（`systeminformation` 包；引入前确认打包无原生依赖问题）、分区信息（PowerShell `Get-Volume` 或 `systeminformation`）
- 新建 `src/renderer/views/OverviewView.tsx` + `components/overview/`：`PartitionBars`、`WatchCards`（复用 M5 卡片）、`MetricCard`（KPI 大字 + sparkline ≤60 点）、`AlertFeed`（提醒流：磁盘将满 / 端口变化 / 上次扫描）
- IPC：`metrics:subscribe`（1s 推送一次采样）

**验收**：
- 总览 2s 内出数据；读数与任务管理器同量级（允许采样误差）
- 每块面板点击可跳转对应页
- 断网环境下不报错（网络读数降级显示）

---

## 8. M7 设置页

**目标**：白名单 / 通知 / 清理计划 / 更新 / 关于。
**设计依据**：`design-system/opscabin/pages/settings.md`。

**文件**：
- 新建 `src/renderer/views/SettingsView.tsx`（分组表单：通用 / 通知 / 白名单 / 清理计划 / 更新 / 关于；危险区置底）
- shadcn：`form`（react-hook-form 或受控）+ `switch` / `select` / `separator`
- 主进程：清理计划调度器（每日/每周 + 启动时补扫；MVP 用主进程定时器，不写系统计划任务）

**验收**：
- 每个开关即改即存（重启保留）；白名单增删即生效于下次扫描
- 校验错误显示在字段旁；危险区操作二次确认

---

## 9. M8 打包发版 + 冒烟自检

**目标**：能安装、能更新、能自检。

**文件**：
- 新建 `electron-builder.yml` + `scripts/dist.mjs`（`--win --publish never`；NSIS 安装版 + portable）
- 新建 `scripts/gen-icons.mjs`（图标）
- 新建 `.github/workflows/release.yml`（tag → typecheck + 打包 + Release 上传 `latest.yml` + blockmap）
- 接入 `electron-updater`（三段式：检查/下载/安装分离，从不自动安装）
- 冒烟自检（复刻参考项目模式，环境变量 `OPS_CABIN_SMOKE=1`）：落盘 `window.json`、`view-*.json`（DOM 事实）、`screen-*.png`；磁盘自检在 Temp 造固定测试文件断言扫描结果；端口自检断言"能列出当前监听端口且包含自检自己开的端口"

**验收**：
- `pnpm dist` 产出 setup 与 portable；安装版可启动
- 冒烟自检一轮全绿（含 `api-failures` 为空这类对账文件）

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

约定：所有主进程入参过白名单校验（参考 `openExternal` 的模式）；推送通道名不带冒号后缀歧义；渲染层只经 preload 显式方法。

---

## 11. 数据模型（落 `userData/`）

- `settings.json`：`{ theme, windowBounds, notifyOnPortChange, scanPlan: { mode, time }, whitelist: string[] }`
- `watchlist.json`：`{ port: number, label: string, note?: string, addedAt: number }[]`
- `clean-history.json`：`{ at, freedBytes, itemCount, restored: boolean }[]`（限量 200 条）
- `port-events.json`：`{ at, port, type: 'occupy' | 'release' | 'change', process?: string }[]`（限量 1000 条）

全部原子写（tmp + fsync + rename）；损坏时回退默认值并保留坏文件副本（`*.bad`）。

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

## 13. 下一里程碑的入口

- 托盘图标资源：用临时占位图标（M8 换正式图标）
- shadcn 组件一律用 `pnpm dlx shadcn@latest add <组件> --yes` 获取（已验证可用，见 §14），不手抄源码

---

## 14. 环境与运行备忘（M0 验证记录）

**运行命令**：
- `pnpm dev`（开发，HMR）/ `pnpm build` / `pnpm typecheck`
- `pnpm exec install-electron`：`node_modules/electron/dist` 缺失时补装二进制（幂等）

**electron 二进制（本机特殊）**：本机 hosts 屏蔽了 GitHub，electron 直连下载不可达。已配两层：
- `.npmrc`：`electron_mirror=https://npmmirror.com/mirrors/electron/`
- `package.json` 的 `postinstall`：`node node_modules/electron/install.js` —— electron 43 的 npm 包自带安装脚本但无 postinstall 钩子，装完若缺 `dist/`，跑 `pnpm exec install-electron`

**shadcn CLI（已验证可用）**：
1. 根 `tsconfig.json` 必须含 paths（`@/*` → `src/renderer/*`）——CLI 从它解析别名；编译实际走 tsconfig.node/web
2. 2026 版 registry 用 `cn` + `radix-ui` 统一包（替代手写 `@/lib/utils` 与分散的 `@radix-ui/react-*`），`cn` 是官方发布的类名合并包；组件依赖由 CLI 装入 `dependencies`（接受此默认）；`src/renderer/lib/utils.ts` 保留为 `export { cn } from 'cn'` 的统一出口

**M0 验证结果（全绿）**：
- `pnpm typecheck` ✓ / `pnpm build` ✓
- 生产形态冒烟：窗口标题「运维舱」、React 渲染出侧栏（总览/磁盘/端口/设置）、`window.opsCabin` 桥存在、`app:info` 返回 v0.1.0 / Electron 43.3.0
- 开发模式冒烟：加载 `http://localhost:5173/`，DOM 与桥同上（验证用的外部临时脚本已删除，M8 正式化冒烟机制）

**M1 验证结果（e2e 全绿，15 项）**：`node scripts/e2e-check.mjs` 覆盖 ——
损坏设置回退与 `.bad` 留档 / 设置原子写盘 / 窗口移动 → 关窗保存 → 重启恢复 /
关窗隐藏不退出 / 托盘图标非空 / `app:quit` 出口。冒烟产物落在 `%TEMP%/ops-cabin-smoke/`
（`OPS_CABIN_SMOKE=1` 时生成）。

**git**：已 `git init`（main 分支），尚无提交 —— 建议尽快打基线提交（M0 + M1 已形成可回归的完整节点）。

