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
└─────────────────────────────────────────┴─────────────────────────┘
┌ Plate: RADAR · WATCH 关注端口（整格可点 → 端口页）──────────────—┐
│ [卡 5173 ●占用中] [卡 8080 ○空闲] …   / 空态：还没有关注任何端口… │
└──────────────────────────────────────────────────────────────────┘
```

## 零件用法

- `AlertFeed` 是信号条：`Plate` 同构（gap-px + line-2 外框），每盏报警是一个 `alert-item` 按钮（`Lamp` + 粗体结论 + `.num` 事实）。**端口被占用是中性事实**：`occupy/change` 用 `ink` 灯，`release` 用 `idle` 灯；磁盘将满用 `warn` 灯 + `pulse`。
- 磁盘格：`PartitionBars` 每盘一条 `SegBar`（26 格，`freeTone`：剩余 <5GB 红 / <10GB 黄 / 其余绿）。
- 资源格：CPU / 内存 大字读数（`.num text-[24px] font-bold`）+ `Sparkline`（polyline，`var(--dim)`）+ `SegBar`（32 格，`loadTone`）。
- 关注端口格：复用 `WatchGrid`（端口页同一组件）。

## e2e 契约（不许动）

- `overview-view`、`overview-volume`（首个文本含「剩余」）、`partition-bars`（可点 → 磁盘页）、`overview-watch`（可点 → 端口页）、`alert-feed`、`alert-item`（有变化时 ≥1）、`metrics-panel`、`metric-cpu` / `metric-mem`（文本含 `%`；mem 含 `/`）、**`metric-cpu` 内必须有 SVG `<polyline>` 且 ≥3 点**、`watch-card` + `data-port` + `data-occupied`、`nav button` 精确 4 个文本。
- 主题机制：`prefers-color-scheme`（禁止改成 class 切换）。
