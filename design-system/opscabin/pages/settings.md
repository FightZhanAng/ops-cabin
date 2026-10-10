# 设置页（Settings）· v2 页面规范

> 覆盖 Master 的页面级规则；其余一切以 `MASTER.md` 为准。

## 页面职责

一块单列仪表板：每组一个 bay，改动即存（右上角「已保存」闪现）。

## 版式（目标）

```
┌ GENERAL 通用 ────────────────────────────────┐
│ 主题会立即生效（渲染层跟随系统媒体查询，无闪帧）。│
│ 主题                        [浅色|跟随系统|深色] │
└───────────────────────────────────────────────┘
┌ NOTIFY 通知 ──────────────────────────────────┐
│ 端口变化通知                                    [开关] │
└───────────────────────────────────────────────┘
┌ PROTECTION 白名单（保护目录）─────────────────┐
│ [🔒 C:\…\项目]                                   [×] │
│ [添加目录…]                                    │
└───────────────────────────────────────────────┘
┌ SCHEDULE 清理计划 ─────────────────────────────┐
│ [手动|每天|每周（一）]   时间 [09:07]           │
└───────────────────────────────────────────────┘
┌ UPDATE 更新 ───────────────────────────────────┐
│ ● 已是最新 v0.1.0            [检查更新] [发布页] │
└───────────────────────────────────────────────┘
┌ ABOUT 关于 ────────────────────────────────────┐
│ 版本 0.1.0 / 运行时 Electron 43.3.0 …          │
│ [打开数据目录]                                  │
└───────────────────────────────────────────────┘
┌ DANGER 危险区（danger 调：左侧 2px 红线）──────┐
│ 清空变化记录  [清空]   重置所有设置  [重置]     │
└───────────────────────────────────────────────┘
```

## 零件用法

- 每个分组 = 一个 `Bay`（`eyebrow` 用 GENERal/NOTIFY/PROTECTION/SCHEDULE/UPDATE/ABOUT/DANGER），外层一个 `Plate`（单列，`max-w-[680px] mx-auto`）。
- 行模式：`flex min-h-[38px] items-center justify-between gap-4 border-b border-line last:border-b-0`，左侧 12.5px 标签，右侧控件。
- 主题选择用 `Rocker`（档位带 Lucide 图标：Sun / Monitor / Moon，`size-3`）。
- 开关 = `Switch`；白名单条目行 = `FolderLock` 图标 + `.num truncate` 路径 + `whitelist-remove`（`icon-xs ghost`，title「移出白名单」）。
- 更新分组：状态行 = `Lamp`（ok=已最新 / warn=有更新 / pulse=下载中）+ 文案（`.num` 版本号）；按钮：`检查更新`（outline）、`发布页`（ghost）、`下载`/`安装`（default / destructive 语义按现有逻辑）。
- 危险区：Bay 加 `border-l-2 border-l-[var(--danger-soft)]` 之类的 danger 调；按钮 `destructive`（透明底 + 红描边 → hover 实底；确认按钮实底红）。
- 「已保存」闪现：右上角 `fixed right-6 top-16` chip（`Lamp ok` + 「已保存」），保留 1500ms + opacity 过渡。

## e2e 契约（不许动）

- 元素：`settings-view`、`saved-flash`、`theme-picker`、`theme-dark`、`theme-system`（`theme-light` 保留）、`notify-switch`、`whitelist-editor`、`whitelist-item`、`whitelist-remove`、`scan-plan-editor`、`plan-daily`、`plan-time`、`update-section`、`update-check`、`update-download`、`update-install`、`update-release-page`、`update-message`、`auto-update-switch`、`danger-zone`、`danger-clear-events`、`danger-reset`、`danger-confirm`、`danger-confirm-btn`、`open-data-dir`。
- 文案：`模拟更新模式`（主进程 updater.ts 提供，勿动）、`下载完成`（同上）。
- 行为：`plan-time` 必须是受控 input（原生 setter + `input` 事件 + blur 可驱动）；`theme-dark` 点击后 `matchMedia('(prefers-color-scheme: dark)')` 必须为 true（主题走 `nativeTheme.themeSource`，不允许改成 class 切换）。
- 其他：`ui/*` 的 `data-slot` 属性保留（`alert-dialog-cancel` 等被 e2e 直接点击）。
