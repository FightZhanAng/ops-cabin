# 总览页（Overview）· v2 页面规范

> 覆盖 Master 的页面级规则；其余一切以 `MASTER.md` 为准。

## 页面职责

一屏回答「现在什么状况」。每个 bay 都是入口（点击进入对应页），不是信息终点。

## 版式（已按此实现，改动需同步文档）

```
┌ 信号条 AlertFeed（annunciator：有情况才亮灯成条）────────────────┐
│ [⚠ 磁盘将满 · C: 剩余 8.2 GB] [● 19:31:02 5173 已释放]           │  一切正常时：○ 一切正常 —— 磁盘余量充足，关注端口没有新变化。
└──────────────────────────────────────────────────────────────────┘
┌ Plate: STORAGE 磁盘 (3fr) ──────────────┬ SYSTEM 资源 (2fr) ──────┐
│ C:  剩余 12.5 GB                        │ CPU  ▁▂▃  90.5%         │
│ ▮▮▮▮▮▮▮▮▮▮▯▯▯▯▯ (26 格)                │ ▮▮▮▮▮▮▮▮▮▮▯▯ (32 格)   │
│ 已用 91%                    共 136 GB   │ 内存 ▁▁▂▃ 76.2%         │
│ （整格可点 → 磁盘页）                    │ 6.0 GB / 7.9 GB         │
│                                         │ 网络 ▁▂▅▃ 1.2 MB/s      │
│                                         │ ↑ 15.3 KB/s             │
└─────────────────────────────────────────┴─────────────────────────┘
┌ Plate: TREND · 7 DAYS 长期趋势（CPU / 内存双线，0–100% 共用一根轴）┐
│ 13 个采样点 · 每 5 分钟一个              [24 小时 | 7 天]          │
│ 100%┤      ╱╲___╱                                               │
│  50%┤  ___╱      （CPU = --fg，内存 = --dim，图例带文字）        │
│   0%└────────────────────────────────  24 小时前        14:35    │
└──────────────────────────────────────────────────────────────────┘
┌ Plate: CLEANUP · HISTORY 清理记录 ──────────────────────────────┐
│ 累计释放 4.8 GB  4 次  22 条  最近 10-12 10:25 · 256 MB          │
│ 近 14 天柱状图（每天释放）        │ 近 30 天累计折线              │
└──────────────────────────────────────────────────────────────────┘
┌ Plate: PROCESS · TOP 进程榜 (3fr) ───────┬ NET · DIAG 联网体检 (2fr)┐
│ 12 个候选 · 每 20 秒刷新  [按内存|按CPU] │ 3 / 4 项通过 · 2 项读数   │
│ 1 chrome    18536  ▮▮▮▮▮▯ 689 MB        │ ● 域名解析  → 127.0.0.1  │
│ 2 msedge    21572  ▮▮▮▯▯▯ 187 MB        │    · 本机代理或 hosts 改写│
│ （只读：结束进程在端口页）               │ ● GitHub SSH  22 连接被拒│
│                                          │    —— 没有进程在监听     │
│                                          │ [再测一次]               │
└──────────────────────────────────────────┴────────────────────────┘
┌ Plate: HOSTS · FILE 域名改写 ────────────────────────────────────┐
│ C:\Windows\...\etc\hosts · 共 212 行 · 生效 63 条 · 改于 09-30  │
│ ● 第 201 行  github.com → 127.0.0.1      指向本机 · 发布链路     │
│ ● 第 181 行  api.github.com → 127.0.0.1  指向本机 · 发布链路     │
│   另有 20 条未列出（按「发布链路优先」排序后截断）                │
└──────────────────────────────────────────────────────────────────┘
┌ Plate: RADAR · WATCH 关注端口（整格可点 → 端口页）──────────────—┐
│ [卡 5173 ●占用中] [卡 8080 ○空闲] …   / 空态：还没有关注任何端口… │
└──────────────────────────────────────────────────────────────────┘
```

## 零件用法

- `AlertFeed` 是信号条：`Plate` 同构（gap-px + line-2 外框），每盏报警是一个 `alert-item` 按钮（`Lamp` + 粗体结论 + `.num` 事实）。**端口被占用是中性事实**：`occupy/change` 用 `ink` 灯，`release` 用 `idle` 灯；磁盘将满用 `warn` 灯 + `pulse`。
- 磁盘格：`PartitionBars` 每盘一条 `SegBar`（26 格，`freeTone`：剩余 <5GB 红 / <10GB 黄 / 其余绿）。
- 资源格：CPU / 内存 / 网络 大字读数（`.num text-[24px] font-bold`）+ `Sparkline`（polyline，`var(--dim)`）+ `SegBar`（32 格，`loadTone`）。**网络没有 SegBar** —— 吞吐没有天然满量程，给条 LED 会暗示一个不存在的上限；它的走势线按窗口峰值自定标（与任务管理器同一路子）。
  - 网络是唯一有**两个方向**的读数：下行做 24px 大字，`↓` 必须**紧贴数字同行**（`items-baseline` 包一层），上行放下一行右对齐。把 `↓ 下行` 单独占一行会变成「图例」——两个方向各占一行两端时，读者无法判断上面那个数字属于哪个方向。
- 趋势格：`ResourceTrend` —— CPU（`--fg`）与内存（`--dim`）两条 polyline，**共用 0–100% 一根轴**（双轴会把两条不同的线缩放成差不多高，属于骗人的图）；纵轴刻度放在 SVG 外面，因为 `preserveAspectRatio="none"` 会把 SVG 里的文字也拉伸变形。
- 清理格：`CleanupStats` —— 14 天柱（直角方柱，今天用 `--fg` 实色、往日 62% 墨）+ 30 天累计折线。
- 进程榜：`TopProcesses` —— 行内 `SegBar`（16 格，`tone="ink"`：这是相对量级，不是负载告警，**不能借用信号色**）；内存与 CPU 用 `Rocker` 切档而不是并排两列，否则两条不同量纲的条会被读成「两个都高」。
- 联网体检：`NetCheckPanel` —— 每条探针是 `Lamp` + 名称 + `.num` 判据 + 耗时；映射 `ok→ok / fail→danger / info→idle`（代理是读数不是好坏）。结论随网络状况变，文案必须自带数字（「ECONNREFUSED」比「失败」有用）。
  - **判据列不许 `truncate`**：这一列写的正是结论的依据（「已连通 · HTTPS 抓取」「连接被拒 —— 没有进程在监听」「证书不受信任但通道可用」），截掉半句就只剩结论没有依据 —— 而结论恰恰是最不需要看的那半。面板只占一行 Plate 的 2/5，最长的判据要三行才放得下，故 `line-clamp-3` 兜底 + 原文留 `title`。
  - **「通过数」的分母要写清**：`info` 项（API 证书不受信任但通道可用、代理配置）不计入 `passed / total`，所以 6 行结论会配出「3 / 4 项通过」。必须在同一行补「· N 项读数」，否则看起来像漏算了。
  - 判据文案**先给事实再给解读**：「`github.com:22` 连接被拒」比「端口不可用」有用；域名叫到本机时补「本机代理或 hosts 改写」，否则下一行 443 通不通无法归因。
- 域名改写格：`HostsPanel`（整行 Plate）—— 与联网体检是**配套的两半**：那边说「`github.com` 解析到 `127.0.0.1`」，这边说**是谁改的**。少了这一半，用户知道症状却找不到病灶，而 hosts 文件平时没人会主动去看。
  - **判定只报三件确定的事**：指向回环（`127.0.0.1` / `::1`）/ 指向黑洞（`0.0.0.0`）/ 命中发布链路域名。**局域网映射一律不报** —— 报得越宽，真正要看的那几条越容易被淹掉。
  - **排序按「发布链路优先」**：本机 hosts 里常有成百条广告拦截（种子环境就是 40 条里 11 条命中），不排序那条 `github.com` 会被埋到看不见。命中发布链路域名的一律 `warn` 灯（这几条直接决定这台机器能不能发版）。
  - 三个数**不能混成一个**：`data-flags` 是面板收到的判定数（主进程已按 40 条上限截断），渲染行数 === 它；被截掉的另记 `data-omitted`，在列表底部单独说明。把两者相加当成「异常总数」就错了。
  - 只读：这一版不改 hosts。改写要管理员权限且影响所有程序，属于「写系统状态」，留到有备份与还原之后。
- 关注端口格：复用 `WatchGrid`（端口页同一组件）。

## e2e 契约（不许动）

- `overview-view`、`overview-volume`（首个文本含「剩余」）、`partition-bars`（可点 → 磁盘页）、`overview-watch`（可点 → 端口页）、`alert-feed`、`alert-item`（有变化时 ≥1）、`metrics-panel`、`metric-cpu` / `metric-mem`（文本含 `%`；mem 含 `/`）、**`metric-cpu` 内必须有 SVG `<polyline>` 且 ≥3 点**、`watch-card` + `data-port` + `data-occupied`。
- 侧栏（全局，在此登记）：`nav-<key>` 五项（overview / disk / ports / startup / settings），**`nav button` 文本数精确 5**；`nav-badge-<key>`（`data-tone` ∈ `ok|warn|danger|idle`，文本非空）；收起态 `nav-dot-<key>`（只有 warn / danger 才有）且 `aria-label` 带读数。口径规则见 `MASTER.md` 的「侧栏常驻状态」。
- 本轮新增（同样不许动）：`metric-net`（文本含 `/s`）、`overview-trend`、`resource-trend`（`data-range` / `data-points` / `data-cpu-peak`）、`trend-line-cpu` / `trend-line-mem`（polyline）、`trend-range-24h` / `trend-range-7d`、`overview-processes`、`process-top`（`data-sort`）、`process-row`（`data-value` 为当前档位的数值）、`process-sort-mem` / `process-sort-cpu`、`overview-netcheck`、`netcheck-panel`（`data-running` / `data-passed`）、`netcheck-run`、`netcheck-item`。
- hosts 段：`overview-hosts`、`hosts-panel`（`data-flags` / `data-watched` / `data-omitted` / `data-readable`）、`hosts-flag`（`data-kind` ∈ `loopback|null|other`、`data-watched`）、`hosts-refresh`。**行数 === `data-flags`（截断在后端做，DOM 不丢行）**；`data-watched="true"` 的行构成前缀。
- 主题机制：`prefers-color-scheme`（禁止改成 class 切换）。
