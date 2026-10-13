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
│ 四类信号各自开关；安静时段内不推 —— 信号照常产生   │
│ 端口变化通知                                    [开关] │
│ 服务异常通知                                    [开关] │
│ 计划扫描完成通知                                [开关] │
│ 新版本通知                                      [开关] │
│ 异常持续时重复提醒（每 30 分钟）                [开关] │
│ 安静时段                                        [开关] │
│ 静音区间   22:00 – 次日 08:00   [22:00] – [08:00] │
└───────────────────────────────────────────────┘
┌ PROTECTION 白名单（保护目录）─────────────────┐
│ [🔒 C:\…\项目]                                   [×] │
│ [添加目录…]                                    │
└───────────────────────────────────────────────┘
┌ SCHEDULE 清理计划 ─────────────────────────────┐
│ [手动|每天|每周（一）]   时间 [09:30]           │
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

- 每个分组 = 一个 `Bay`（`eyebrow` 用 GENERAL/NOTIFY/PROTECTION/SCHEDULE/UPDATE/ABOUT/DANGER），外层一个 `Plate`（单列，`max-w-[680px] mx-auto`）。
- 行模式：`SettingRow`（`components/settings/SettingRow.tsx`）—— `flex min-h-[38px] items-center justify-between gap-4 border-b border-line last:border-b-0`，左侧 12.5px 标签 + 可选 11px `text-dim` 提示，右侧控件。设置页的每一行都用它，别手写 div。
- 时刻输入 = `TimeField`（`components/settings/TimeField.tsx`）：`HH:mm` 校验 + 失焦/回车提交 + 就近报错。清理计划的触发时刻与安静时段的起止都用它 —— 校验规则与提交时机必须一模一样。
- 主题选择用 `Rocker`（档位带 Lucide 图标：Sun / Monitor / Moon，`size-3`）。
- 开关 = `Switch`；白名单条目行 = `FolderLock` 图标 + `.num truncate` 路径 + `whitelist-remove`（`icon-xs ghost`，title「移出白名单」）。
- 更新分组：状态行 = `Lamp`（ok=已最新 / warn=有更新 / pulse=下载中）+ 文案（`.num` 版本号）；按钮：`检查更新`（outline）、`发布页`（ghost）、`下载`/`安装`（default / destructive 语义按现有逻辑）。
- 危险区：Bay 加 `border-l-2 border-l-[var(--danger-soft)]` 之类的 danger 调；按钮 `destructive`（透明底 + 红描边 → hover 实底；确认按钮实底红）。
- 「已保存」闪现：右上角 `fixed right-6 top-16` chip（`Lamp ok` + 「已保存」），保留 1500ms + opacity 过渡。

## 通知分组：四类信号的判定与纪律

**四类信号**（各自一个开关，判定全在主进程的 `Notifier` 出口里，不在调用点）：

| kind | 开关字段 | 触发源 |
|---|---|---|
| `port` | `notifyOnPortChange` | 关注端口的占用 / 释放 / 换主 |
| `scan` | `notifyOnScanDone` | 计划扫描完成 |
| `service` | `notifyOnServiceDown` | 关注的服务挂起 / 恢复（后台盯梢） |
| `update` | `notifyOnUpdate` | 自动检查发现新版本 |

五条不做就会出错的事：

1. **开关判定必须只在出口做。** 散在各调用点判是漏判的温床，而且被关掉的那些不会留档 ——「为什么没收到通知」就再也答不上来了。出口对**每一次**调用都留档，包括 `off` 与 `quiet`。
2. **安静时段内丢弃，不延后。** 四类信号在界面里各有各的家（端口事件流水账 / 服务面板与侧栏徽标 / 磁盘页扫描记录 / 更新区块 + 设置徽标），静默 ≠ 丢失；延后发送反而会把一小时前的消息伪装成刚发生的。
3. **安静时段判定 fail-open。** 起止格式坏掉、`start === end`（零长度）都按「不静音」处理 —— 宁可吵，不可哑。方向搞反了会静默吃掉所有通知，而且没人会发现。
4. **「已禁用」不是异常**（本会话第五次）：`stopped` 且启动类型是 `Disabled` 的服务停着是正常状态。判据只有一份 —— `shared/services.ts` 的 `serviceDown()`，侧栏、服务面板、盯梢三处共用。
5. **「已恢复」只在发过「挂了」之后才说。** 启动时就是停着的服务后来自行起来了，那不是恢复而是「刚起来」：用户没收到过它有事的消息，此时告诉他「已恢复」只会让人翻上去找那条并不存在的警报。

重复提醒（`notifySustained`）：服务挂起且**已经通知过**、满 `SUSTAINED_REPEAT_MINUTES`（30 分钟）仍未恢复时再提醒一次。间隔分钟数只有一份定义（`shared/notify.ts`），设置页文案引用它 —— 写两遍就会出现「页面说 30 分钟、实际 60 分钟」这种长期撒谎。

更新通知按**版本号**去重（`notifiedUpdateVersion`），不是按「状态变成 available」：自动检查每天跑一次、用户还可能手点两回，按状态去重会让同一版本反复打扰。

## e2e 契约（不许动）

- 元素：`settings-view`、`saved-flash`、`theme-picker`、`theme-dark`、`theme-system`（`theme-light` 保留）、`notify-switch`、`notify-section`、`notify-service`、`notify-scan`、`notify-update`、`notify-sustained`、`quiet-switch`、`quiet-start`、`quiet-end`、`quiet-note`、`whitelist-editor`、`whitelist-item`、`whitelist-remove`、`scan-plan-editor`、`plan-daily`、`plan-time`、`update-section`、`update-check`、`update-download`、`update-install`、`update-release-page`、`update-message`、`auto-update-switch`、`danger-zone`、`danger-clear-events`、`danger-reset`、`danger-confirm`、`danger-confirm-btn`、`open-data-dir`。
- 通知留档：`notify-log.json`（通知出口每次调用都覆写，含 `outcome` 与 `quiet` 区间）；`notify-probe.json`（自检造的三次真实变化的端口号与安静时段区间）。二者是 e2e 断言通知判定的唯一依据。
- 文案：`模拟更新模式`（主进程 updater.ts 提供，勿动）、`下载完成`（同上）。
- 行为：`plan-time` 必须是受控 input（原生 setter + `input` 事件 + blur 可驱动）；`theme-dark` 点击后 `matchMedia('(prefers-color-scheme: dark)')` 必须为 true（主题走 `nativeTheme.themeSource`，不允许改成 class 切换）。
- 其他：`ui/*` 的 `data-slot` 属性保留（`alert-dialog-cancel` 等被 e2e 直接点击）。
