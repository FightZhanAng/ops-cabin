# 运维舱（Ops Cabin）设计系统 · Master v2 —— 仪器面板（Instrument Panel）

> **LOGIC:** 落地某个页面前，先读 `design-system/opscabin/pages/[page].md`；页面文件与本文冲突时，以页面文件为准。
>
> **版本说明：** v1（Modern Dark + 信号绿）被判为「太像通用后台」，2026-10-10 整体推翻。
> v2 的设计论点一句话：**这不是一块仪表盘（dashboard），是一台仪表（instrument）**——产品名里的「舱」就是驾驶舱。

## 三块基石（改任何样式前先读）

1. **颜色是信号，不是装饰。** 全站没有品牌色、没有蓝。一切交互动作走石墨墨阶（`btn` 系）；绿 / 黄 / 红只表示状态与风险，且永远同时有文字（色盲双通道）。被选中用中性钢灰 `sel`。
2. **数据是读数。** 数字、端口号、地址、路径、时间戳、微标签一律等宽 `font-mono`（B612 Mono，内嵌 woff2）+ `tabular-nums`，成列右对齐。中文落系统黑体。
3. **结构是仪器面板。** `Plate`（整块面板）+ `Bay`（格）用 1px 发丝线拼合，不是漂浮的圆角卡片。四种基本零件：仪表灯 `Lamp`、分段仪表条 `SegBar`、拨档 `Rocker`、端口雷达 `Scope`。

**Design Dials:** Variance 6/10（偏仪器的直线与方角） | Motion 3/10（克制：只做状态与进行中） | Density 8/10（桌面工具密度）

---

## Color Palette

**昼间（浅色）· 冷钢工作台：**

| Role | Hex | 变量 | 用途 |
|------|-----|------|------|
| Canvas | `#E7EBED` | `--bg` | 窗口底 |
| Panel | `#FFFFFF` | `--panel` | 面板格（bay） |
| Panel 2 | `#F2F4F5` | `--panel-2` | 表头 / 凹槽 / hover 底 |
| Hairline | `#D5DBDF` | `--line` | 发丝分隔线 |
| Hairline 2 | `#BAC4CA` | `--line-2` | 外框、输入框边、强调线 |
| Ink | `#14181B` | `--fg` | 主文字、石墨按钮底 |
| Dim | `#5A646C` | `--dim` | 次级文字（对比度 ≥5:1） |
| Faint | `#8B959C` | `--faint` | 刻度、最弱提示（不承载正文） |
| Selected | `#DEE6EB` | `--sel` | 当前导航底、选中行底 |
| OK ink / soft | `#1A8A4B` / `#3FB56D` | `--ok` / `--ok-soft` | 文字用 ink；灯与色块用 soft |
| Warn ink / soft | `#9A6708` / `#E0A22A` | `--warn` / `--warn-soft` | 注意：磁盘将满、风险条目 |
| Danger ink / soft | `#BC3B22` / `#E2543A` | `--danger` / `--danger-soft` | 危险动作、永久删除、冲突 |

**夜间 · 驾驶舱夜航（近黑蓝灰，非纯黑）：**

| Role | Hex | 变量 |
|------|-----|------|
| Canvas | `#0D1114` | `--bg` |
| Panel | `#151A1E` | `--panel` |
| Panel 2 | `#1C2226` | `--panel-2` |
| Hairline / 2 | `#262E33` / `#39434A` | `--line` / `--line-2` |
| Ink | `#E7ECEF` | `--fg` |
| Dim / Faint | `#98A3AB` / `#6C777F` | `--dim` / `--faint` |
| Selected | `#1E272D` | `--sel` |
| OK / Warn / Danger | `#4CC97F` / `#E2AE4E` / `#F4694F` | `--ok` / `--warn` / `--danger` |

**动作墨阶：** 主按钮 = 石墨实底（昼 `#1B2227` 底 + `#F3F6F7` 字；夜反相为亮底深字）。危险按钮才用红（`--btn-danger`）。
**夜间唯一允许的光：** `.lamp` 的 7px 辉光。其他一切不发光、不投影（浮层用边线分层）。
**主题机制（硬约束）：** 只有 `prefers-color-scheme`（主进程 `nativeTheme.themeSource`），渲染层不持有主题状态。

## Typography

- **中文 / 拉丁 UI：** `'Microsoft YaHei UI', 'Microsoft YaHei', 'Segoe UI', sans-serif`
- **数据（数字/端口/地址/路径/时间/微标签）：** `'B612 Mono', Consolas, 'Cascadia Mono', 'Microsoft YaHei UI', ui-monospace, monospace`
  —— B612 由空客为驾驶舱显示屏委托设计，这就是「舱」的字面来源；内嵌于应用，离线可用。
- 工具类：`.eyebrow`（10.5px 等宽大写 + 0.12em 字距，配 `text-faint`/`text-dim`）、`.num`（等宽 + tabular）。
- 字号阶梯：`10.5` 微标签 · `11` 辅助 · `12` 表格/按钮 · `12.5` 表格正文 · `13` 正文/按钮 · `15` 页标题 · `24` 大字读数。**任何位置不得 <10.5px。**
- 数字永远成列右对齐；单位与数字之间空一格（`12.5 GB`）。

## 四种基本零件（`@/components/instrument/*`）

| 零件 | 文件 | 规则 |
|------|------|------|
| `Lamp` 仪表灯 | `lamp.tsx` | 7px 圆点；状态 `ok/warn/danger/idle/ink`；进行中用 `pulse`。**灯旁必须有文字**，不许只靠颜色。 |
| `SegBar` 分段条 | `seg-bar.tsx` | 离散 LED 格（`segments` 26–32），不是连续进度条；`tone` 由 `freeTone()`（磁盘按剩余 5/10GB）或 `loadTone()`（负载 80/92%）决定；`sweep` 只在扫描进行中用。 |
| `Plate` + `Bay` | `plate.tsx` | 页面分区必须用 Plate（`grid gap-px bg-line`，整板 6px 圆角 + `line-2` 外框）+ Bay（`bg-panel`，含 `eyebrow`/`title`/`aside`）。**不要再写 `rounded-[10px] border bg-panel` 的漂浮卡片。** |
| `Rocker` 拨档 | `rocker.tsx` | 2–4 档的横向档位开关（主题、协议筛选、计划模式）；活动档 = `bg-panel` + `line-2` 内描边。 |
| `Scope` 端口雷达 | `scope.tsx` | 唯一的「签名」动效：amber 扫描线 4.5s 一圈 + 目标亮点。仅端口页使用。 |

## 组件规范

- **Button**：`default` 石墨实底（= 关键动作：开始扫描、清理选中项）；`outline`（次要）；`ghost`（弱操作）；`destructive` 只在不可逆动作（永久删除 / 结束进程 / 重置设置）。高度默认 32 / `sm` 28 / `xs` 24。圆角 4px。
- **Badge（chip）**：`ok` / `warn` / `destructive` 三个语义档（`.chip-*`），用于风险等级、协议、状态标签；高度 19px，圆角 3px。
- **Table**：表头 = `panel-2` 底 + 11px dim 微标签；行高 32–36px，hover `panel-2/70`；数字列 `.num` 右对齐；路径列等宽 + truncate，别换行撑高。
- **Tabs**：档位开关观感（与 Rocker 同构），活动档白底内描边；保留 radix 行为（mousedown 激活）。
- **Switch / Checkbox**：选中 = 石墨（昼）/ 亮底（夜）；Checkbox 是 4px 小方角，不用圆点。
- **Dialog / AlertDialog**：`panel` 实底 + `line-2` 边 + 6px 圆角；标题 14px 粗体，左上角带 `eyebrow`；危险确认必须有后果说明。遮罩 `rgba(13,17,20,.5)`。
- **Toast（sonner）**：`panel` 底 + 边线，12.5px；成功文案用完成态动词（「已清理 3 项」）。

## Motion

- 状态切换 150–200ms；**数字变化不做动画**（仪表读数瞬变）。
- 扫描进行中：`SegBar sweep` + 顶栏读数；雷达扫描线常驻（这是它存在的意义）。
- `prefers-reduced-motion`：关闭全部动画（含扫描线）。
- 禁止：入场 stagger 雨、hover 位移、scale press、装饰性循环动效（除雷达扫描线）。

## 文案纪律（界面上的字也是设计材料）

- 从用户侧命名：说「关注端口」，不说「watchlist 配置」。
- 主动语态、按钮名贯穿流程：「开始扫描」→ toast「扫描完成 · 找到 7 项」。
- 空态是邀请：说清楚「这里会有什么 + 怎么让它出现」。
- 错误给方向：说清发生了什么 + 怎么修，不卖萌、不道歉成瘾。

## Anti-Patterns（不要用）

- ❌ 品牌蓝 / 装饰性彩色（颜色只能来自信号语义）
- ❌ 漂浮圆角卡片堆叠（用 Plate + Bay）
- ❌ 连续圆角进度条（用 `SegBar`；唯一例外：扫描进度 `Progress`）
- ❌ emoji 图标（一律 Lucide SVG）
- ❌ hover 引起布局位移、无 `cursor-pointer`、不可见焦点
- ❌ 正文 <10.5px、灰压灰（正文对比度 <4.5:1）
- ❌ 只靠颜色传达状态（必须配文字）
- ❌ 危险操作无确认、操作完成无反馈

## Pre-Delivery Checklist

- [ ] 没有蓝、没有装饰色；状态色全部带文字
- [ ] 所有数字/时间/地址是 `.num`，成列右对齐
- [ ] 分区用 Plate+Bay，不再有旧卡片样式
- [ ] 扫描进行中能看到 sweep；结束即停
- [ ] 两主题下正文 ≥4.5:1；键盘焦点可见；`prefers-reduced-motion` 生效
- [ ] 危险操作过确认，说明后果；操作完成有 toast 或状态变化
- [ ] 960px 窗口宽下无横向滚动，长表格可滚
- [ ] 所有 `data-testid` 与既有文案契约未破坏（见各 pages/*.md 的「e2e 契约」节）
