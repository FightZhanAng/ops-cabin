# 磁盘页（Disk）· v2 页面规范

> 覆盖 Master 的页面级规则；其余一切以 `MASTER.md` 为准。

## 页面职责

扫描 → 勾选 → 预览 → 清理 → 反馈。一条流水线，界面自上而下就是这条流水线。

## 版式（目标）

```
┌ VOLUMES 左轨 (184px) ┬ 工具条: [开始扫描] [取消]        已跳过 1 个受限条目 · 共 7 项候选 ┐
│ 磁盘分区        ⟳   │ ──────────────────────────────────────────────────────────────── │
│ C:  ▮▮▮▮▮▮▮▮▯▯ 91%  │ [安全清理 3 | 开发缓存 4 | 大文件]   （大文件页签时右侧：扫描主目录 / 选择目录…）│
│ 剩余 12.5 GB / 共 136 GB │  表头(bg-panel-2)：☐ 名称 路径 大小 文件数 风险                │
│ D:  ▮▮▮▮▮▮▮▯▯▯ 87%  │  行：☐ 用户临时文件  C:\…\Temp   3.3 GB  29,154  [安全]        │
│ …                    │  …                                                              │
├──────────────────────┴─────────────────────────────────────────────────────────────────┤
│ 已选 3 项 · 预计释放 1.2 GB                      [清除选择] [清理选中项]                │
└────────────────────────────────────────────────────────────────────────────────────────↵
选中条目时右侧滑出 DetailPanel (264px)：FILE 名称 / 读数行 / 路径凹槽 / [定位文件] [关闭]
```

## 零件用法

- 左轨：`border-r border-line bg-panel`；头部 = `eyebrow VOLUMES` + 「磁盘分区」+ 刷新 `icon-xs ghost`；每行 `volume-row`：`.num` 盘符 + `SegBar`(xs, 26, freeTone) + `.num` 小读行（`已用 X%` / `剩余 X / 共 Y`），hover `bg-panel-2`。
- 工具条：`开始扫描` = `Button default`（石墨）；`取消` = `outline`（仅扫描中）；右侧 `.num text-[11px] text-dim` 读数（`已跳过 N 个受限条目`、`共 N 项候选`）；扫描错误 `text-danger`。
- 页签：`Tabs`（已重做为档位观感），标签 = 名称 + `<span className="num text-dim">N</span>` 计数；大文件页签同排右侧两个 `outline sm` 按钮。
- 结果表：`Table`；表头 sticky（`bg-panel-2`）；大小为 `.num` 右对齐、文件数 `.num` 右对齐、路径 `.num text-dim` 截断（`title` 给全路径）；风险 = `Badge ok`「安全」/ `Badge warn`「谨慎」；行可点（打开 DetailPanel）、hover；勾选用 radix `Checkbox`（保留 `role="checkbox"`）。
- 底栏：`border-t`，左侧 `.num text-dim`「已选 N 项 · 预计释放 X」，右侧 `清除选择`（ghost，选中 >0 时出现）+ `清理选中项`（default，0 选中时 disabled）。
- DetailPanel：`border-l bg-panel` 264px；路径块 = `bg-panel-2` 凹槽 + `.num break-all select-text`。
- 清理对话框：标题「清理 N 项」；列表项 `.num` 路径截断 + 大小右对齐（超长滚动，max-h-[240px]）；回收站/永久删除二选一（永久删除选中时显示 danger 提示行）；确认按钮：回收站 = `default`，永久删除 = `destructive`。

## e2e 契约（不许动）

- 元素：`scan-start`、`scan-cancel`、`scan-home`、`scan-pick`、`scan-progress`（出现又消失）、`tab-safe`、`tab-devCaches`、`tab-largeFiles`、`result-row`、`empty-state`（文本含「选择目录」）、`selection-summary`（文本含「已选 1 项」）、`clean-open`、`clean-dialog`（文本含「清理」与「回收站」）、`volume-row`（≥1）、`[data-slot="alert-dialog-cancel"]`、`[role="checkbox"]`。
- 文案：`开始扫描`、`清理`、`回收站`、`选择目录`、`已选 N 项`。
- 导航依赖：`nav button` 中文本精确「磁盘」的那个按钮可被 `.click()` 程序化点击（App 负责，勿改 `App.tsx`）。
