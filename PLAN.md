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

## 13. 里程碑路线图状态

- M0 骨架 ✓ / M1 主进程地基 ✓ / M2 扫描引擎 ✓ / M3 磁盘页 ✓ / M4 端口引擎 ✓ / M5 端口页 ✓（均 2026-10-10）
- 下一个：**M6 总览页**（磁盘分区条 + 关注端口卡片 + 资源读数 + 提醒流）

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

**git**：已提交 `a50873e`（M0+M1）、`3a0ebb8`（M2）、`be1f35e`（M3）、`a1f83a5`（M4）；M5 改动待提交。

