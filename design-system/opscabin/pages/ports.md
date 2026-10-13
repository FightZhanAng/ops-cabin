# 端口页（Ports）· v2 页面规范

> 覆盖 Master 的页面级规则；其余一切以 `MASTER.md` 为准。

## 页面职责

雷达页：哪些关注端口被占用（亮灯）、关注的服务该不该在跑、全部监听端口一览、变化时间线。

**端口回答「谁在听」，服务回答「该不该在跑」** —— 两者放同一页，因为绝大多数服务后面就挂着一个端口：端口没了往往是因为服务停了，先看哪一边都行。

## 版式（目标）

```
┌ Plate: RADAR · WATCH 关注端口 (1fr) ───────────────┬ SCOPE 雷达底座 (212px) ──┐
│ 每 2 秒刷新 · 更新于 15:59:39（ports-status）      │     (雷达 Scope)         │
│ [5173 ● 占用中] [8080 ○ 空闲] [＋ 关注端口]        │  61 监听 · 2 关注 · 1 占用 │
│                                                    │  内环 TCP · 外环 UDP      │
└────────────────────────────────────────────────────┴──────────────────────────┘
┌ Plate: SERVICE · WATCH 服务关注 ────────────────────────────────── [＋ 关注服务]┐
│ 3 个关注 · 1 个不在跑                                                          │
│ ○ WMI 提供程序       Windows Management Instrumentation · Auto      在跑       │
│ ● 已被卸载的服务     DefinitelyNotARealService99 · 未知             不在了  ×  │
└────────────────────────────────────────────────────────────────────────────────┘
┌ Plate: LISTENERS 全部监听端口 ────── 51 / 51 条 ─────────────────────────────┐
│ [⌕ 搜索端口 / 进程 / 路径]  [全部|TCP|UDP]                                    │
│ 端口↑ 协议 监听地址 进程 PID 内存 运行时长 ★                                 │
│ 80    TCP 0.0.0.0   Steam++…  17112 84.7 MB 4h 48m  ☆                      │
└──────────────────────────────────────────────────────────────────────────────┘
右轨 EVENTS 变化记录 (264px，独立滚动)                     ← ChangeTimeline
```

## 零件用法

- 雷达 `Scope`（`@/components/instrument/scope`，props：`watchlist`、`entries`）：放进 `Bay`，body 用 `bg-panel-2` 凹槽（内嵌 1px `line`）居中；雷达是**唯一**允许的常驻动效。
- 关注卡片：`bg-panel-2` 底、`border-line` 边、`rounded-md`；顶行 `.num text-[18px] font-bold` 端口 + `Lamp` + 状态词（占用中 = ok；空闲 = idle）；次行 label 13px；末行 `.num text-[10.5px] text-faint`（`node.exe · PID 4321` 或「未监听」）；`watch-remove` 为 `icon-xs ghost`（hover 显现，title「取消关注」）；空态 = 虚线添加卡（`watch-add`）。
- 全部监听表：搜索框 `h-7 rounded-sm border-line-2 bg-panel-2`（带 Search 图标）；协议筛选用 `Rocker`（全部 / TCP / UDP）；端口列可排序（`.num font-bold`，箭头用 Lucide `ArrowUp/ArrowDown`，别用字符箭头）；数字列（PID / 内存 / 运行时长）`.num` 右对齐；`port-watch-toggle` 是星形 `icon-xs`（已关注 = 实心星 + `text-fg`，未关注 = 空心星 + `text-dim`）。
- 服务关注 `ServiceWatch`（整行 Plate）—— 状态分**六档而不是「跑 / 没跑」**，因为有两档最容易被误报成故障：
  - **已禁用（`Disabled`）**：停着是**正常**状态，走 `idle` 灯 + `text-dim`。并进「停了」会让每一个 Disabled 的驱动服务天天亮灯。
  - **不在了（`missing`）**：服务被卸载了，关注项成了空壳 —— 要提醒的不是「服务挂了」，而是「该清关注了」。查不到也要**返回条目**，不能从清单里静默消失（否则用户以为自己从没关注过它）。
  - **切换中（`pending`）**：过渡态，走 `idle` 灯。亮警示灯会把「正在重启」当故障，而且它一会儿就自己变回在跑。
  - 面板的「N 个不在跑」= `down` ∪ `missing`，**与侧栏徽标逐字同一套判据**（见 `MASTER.md` 的「侧栏常驻状态」）。禁用与切换中都不计。
  - 每 30 秒一拍（比端口慢：服务状态变得慢，而每次要起一次 PowerShell）。
- 关注服务对话框 `AddServiceDialog`：**搜索式**而不是滚动列表 —— 本机有 300 多个服务，滚着找不现实。在跑的排前面；最多列 60 条并写明「匹配 N 个，只列出前 60 个」（静默截断会让人以为搜不到）。
- 变化记录右轨：`border-l bg-panel`；标题 `eyebrow EVENTS` + 「变化记录」+ 计数；每条 `change-entry`：`.num` 时钟（faint）+ `.num` 端口 + 类型词（occupy=`ink`，release=`dim`，change=`warn`）+ 进程 `.num text-dim`；空态「还没有变化记录 —— 关注的端口有变化时会记在这里。」。
- ProcDialog：头部大号 `.num` 端口 + 协议 chip + 状态 `Lamp`；读数行两列（PID / 内存 / 运行时长 / 启动时间）；命令行块 = `bg-panel-2` 凹槽 + `.num break-all` + `max-h-32 overflow-auto`；`结束进程` = `destructive`（触发带「未保存的数据」警示的确认）。
- AddWatchDialog：端口/名称/备注三行；输入框 `num`（端口）、`h-7`；「常用端口」快捷 chips 可保留。

## e2e 契约（不许动）

- 元素：`watch-grid`、`port-table`、`change-timeline`、`port-row`（>10 条，且带 `data-port`）、`port-watch-toggle`、`watch-card` + `data-port` + **`data-occupied`（`'true'`/`'false'` 字符串）**、`watch-add`、`watch-remove`、`add-watch-dialog`、`watch-port-input`、`watch-label-input`、`watch-submit`、`proc-dialog`、`kill-open`、`kill-confirm`、`change-entry`、`ports-status`。
- 服务关注段：`ports-services`、`service-watch`（`data-count` / `data-down`）、`service-row`（`data-state` ∈ `running|down|disabled|missing|pending|unknown`、`data-name`）、`service-add`、`service-remove`、`add-service-dialog`、`service-search`、`service-option`（`data-name` / `data-already`）。**`data-down` === 行内 `down` ∪ `missing` 的条数**，且必须与侧栏 `nav-badge-ports` 的数字一致。
- 结构：`port-row` 必须是 `<tr>`，首列是 `<td>` 且点击可打开详情对话框；`role="alertdialog"`（确认框）保留；`role="checkbox"` 保留。
- 文案：`PID`、`结束进程`、`未保存的数据`、`已结束`（toast）、`已释放`（变化条目）。
- toast 由 sonner 渲染（`[data-sonner-toast]` 选择器不能丢）。
