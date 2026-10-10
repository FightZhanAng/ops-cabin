# 运维舱（OpsCabin）设计系统 · Master

> **LOGIC:** When building a specific page, first check `design-system/opscabin/pages/[page-name].md`.
> If that file exists, its rules **override** this Master file. If not, strictly follow the rules below.
>
> **校正说明：** 本文件由 ui-ux-pro-max 技能生成后人工校正（2026-10-10）。技能自动检索命中的风格为 Modern Dark，
> 但其自动配色候选与风格条目不一致（生成了一版浅底蓝板），且产品定位（Windows 系统工具、深色仪表盘、常驻托盘）
> 明确要求深色为设计基准。故色板与组件规范部分按「Modern Dark」风格条目人工定版，双主题完整给出。

**Project:** 运维舱 OpsCabin
**Category:** Developer System Utility / Desktop Dashboard（Windows 桌面，深色为设计基准）
**Design Dials:** Variance 5/10 (Balanced / Modern) | Motion 4/10 (Standard) | Density 8/10 (Dense / Dashboard)

---

## Global Rules

### Color Palette

**深色（设计基准）：**

| Role | Hex | CSS Variable | 用途 |
|------|-----|--------------|------|
| Background | `#0F172A` | `--bg` | 窗口底 |
| Panel | `#1E293B` | `--panel` | 侧栏、卡片 |
| Panel 2 | `#272F42` | `--panel-2` | 浮起面板、抽屉、hover 底 |
| Border | `#334155` | `--line` | 分隔线、边框 |
| Foreground | `#F8FAFC` | `--fg` | 主文字 |
| Dim | `#94A3B8` | `--dim` | 次级文字、单位 |
| Signal | `#22C55E` | `--signal` | 活跃/安全/关键动作（全站唯一强调色） |
| Warn | `#F59E0B` | `--warn` | 警告：磁盘将满、关注端口变化 |
| Danger | `#EF4444` | `--danger` | 危险动作与冲突：删除、端口冲突 |

**浅色（跟随系统时启用）：**

| Role | Hex | CSS Variable |
|------|-----|--------------|
| Background | `#F1F5F9` | `--bg` |
| Panel | `#FFFFFF` | `--panel` |
| Panel 2 | `#F8FAFC` | `--panel-2` |
| Border | `#E2E8F0` | `--line` |
| Foreground | `#0F172A` | `--fg` |
| Dim | `#64748B` | `--dim` |
| Signal | `#16A34A` | `--signal` |
| Warn | `#D97706` | `--warn` |
| Danger | `#DC2626` | `--danger` |

**颜色纪律（硬规则）：**

- 状态语义：绿=活跃/运行中/安全；琥珀=警告；红=危险动作与冲突。"端口被占用"是中性事实，用墨阶表达，不用红。
- 全站只有一个强调色（signal 绿），只出现在"当前导航、运行状态灯、关键动作"。
- 分级（清理安全等级、端口变化程度）用墨的深浅与形状表达，不滥用彩色。
- 任何状态都不许只靠颜色传达——必须配文字标签或图标（色盲可达）。
- 正文/背景对比度 ≥4.5:1；次要用 Dim 色，仅用于辅助信息。

### Typography

- **Heading / Body:** Inter（拉丁与数字）；中文落系统黑体栈：`'Microsoft YaHei UI', 'Microsoft YaHei', 'Noto Sans SC', 'Segoe UI', sans-serif`
- **数据字体（端口号/PID/文件大小/时间戳）:** 等宽 `'Cascadia Mono', 'JetBrains Mono', Consolas, ui-monospace, monospace`，数值列右对齐成列
- 桌面应用不引 CDN 字体（离线可用是硬需求）；Inter 以内嵌 woff2 引入，中文交给系统字
- 正文字号基准 13.5px 上下（桌面工具密度），正文行高 1.5

### Spacing（Density 8/10 — Dense / Dashboard）

| Token | Value | Usage |
|-------|-------|-------|
| `--space-xs` | `2px` | 紧贴间隙 |
| `--space-sm` | `4px` | 图标间隙、行内间距 |
| `--space-md` | `8px` | 标准内边距、表格行内 |
| `--space-lg` | `12px` | 区块内边距 |
| `--space-xl` | `16px` | 大区块间距 |
| `--space-2xl` | `24px` | 分区间距 |
| `--space-3xl` | `32px` | 页面级留白 |

### Shadow Depths

| Level | Value | Usage |
|-------|-------|-------|
| `--shadow-sm` | `0 1px 2px rgba(0,0,0,0.05)` | 浅色下的轻微抬升 |
| `--shadow-md` | `0 4px 6px rgba(0,0,0,0.1)` | 浅色下的卡片 |
| `--shadow-lg` | `0 10px 15px rgba(0,0,0,0.1)` | 浅色下的对话框 |

**深色下阴影是黑投黑、等于没投**——"抬起来"靠"比底色亮一档 + 一道亮边"（`--panel-2` + `--line`）。

---

## Component Specs

### Buttons

```css
/* 主按钮 —— signal 绿底、深绿字（对比度合格） */
.btn-primary {
  background: #22C55E;
  color: #052E16;
  padding: 8px 16px;
  border-radius: 8px;
  font-weight: 600;
  transition: all 200ms ease;
  cursor: pointer;
}
.btn-primary:hover { filter: brightness(1.08); }

/* 次按钮 —— 幽灵样式 */
.btn-ghost {
  background: transparent;
  color: inherit;
  border: 1px solid var(--line);
  padding: 8px 16px;
  border-radius: 8px;
  transition: all 200ms ease;
  cursor: pointer;
}
.btn-ghost:hover { background: var(--panel-2); }

/* 危险按钮 —— 红描边，hover 实心；点击必须过确认对话框 */
.btn-danger {
  background: transparent;
  color: var(--danger);
  border: 1px solid var(--danger);
  padding: 8px 16px;
  border-radius: 8px;
  transition: all 200ms ease;
  cursor: pointer;
}
.btn-danger:hover { background: rgba(239, 68, 68, 0.12); }
```

### Cards / 面板

```css
.card {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 10px;
  padding: 16px;
  /* 深色下不投阴影，靠边线分层 */
}
```

### Inputs

```css
.input {
  background: var(--panel-2);
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 8px 12px;
  font-size: 13.5px;
  transition: border-color 200ms ease;
}
.input:focus-visible {
  border-color: var(--signal);
  outline: 2px solid color-mix(in srgb, var(--signal) 35%, transparent);
  outline-offset: 1px;
}
```

### Modals / 对话框

```css
.modal-overlay { background: rgba(0, 0, 0, 0.6); }
.modal {
  background: var(--panel-2);
  border: 1px solid var(--line);
  border-radius: 12px;
  padding: 20px;
  max-width: 480px;
  /* 危险确认对话框：标题写明动作与对象，正文给"将删除什么、多少空间"的事实 */
}
```

---

## Style Guidelines

**Style:** Modern Dark（技能 style 库命中条目）

**Keywords:** dark mode, cinematic, ambient light, glassmorphism, deep black, indigo, glow, blur, atmospheric, premium, layered

**Best For:** Developer tools, pro productivity apps, fintech/trading dashboards, media/streaming platforms, AI tool interfaces

**桌面工具落地注意（人工补充）：**

- 玻璃拟态/blur 在 Electron 里是真实性能成本，只在对话框 overlay 等低频场景少量使用；常驻面板一律实底
- `scale press 0.97 → 1.0`、`cubic-bezier(0.16,1,0.3,1)` 缓动可以用，但持续动效必须支持 `prefers-reduced-motion`
- 避免纯黑 `#000000`（OLED smear），底色用 `#0F172A`

### Page Pattern

**Pattern Name:** Real-Time / Operations

- 面向运维/监控场景：首屏回答"现在什么状况"，实时数值优先于叙述文本
- 关键指标前置（磁盘余量、关注端口状态灯、资源读数），操作入口挨着数据（就地处置）
- 对应用内页面：技能生成的 landing 版式仅作气质参考，布局按桌面工具骨架（侧栏 + 主区）执行

---

## Motion

**Stagger List** (Standard) — Trigger: load or scroll | Duration: 300-450ms | Easing: `cubic-bezier(0.16,1,0.3,1)`

- 卡片阵（关注端口卡片、磁盘分区卡）入场可用 stagger；**数据表格不要回弹/overshoot**，密集信息区只做 150-200ms 淡入
- 动效只传达意义（状态变化、层级出现），不做纯装饰动画
- 遵守 `prefers-reduced-motion`：关闭位移与缩放，只保留状态切换

---

## Anti-Patterns (Do NOT Use)

- ❌ 慢更新（实时数据必须及时刷新，轮询周期要可见于界面）
- ❌ 无自动化（能自动完成的事不要让用户手工重复）

### Additional Forbidden Patterns

- ❌ **Emojis as icons** — 图标一律 SVG（Lucide）
- ❌ **Missing cursor:pointer** — 可点击元素必须有手型光标
- ❌ **Layout-shifting hovers** — hover 不许引起布局位移
- ❌ **Low contrast text** — 正文对比度 ≥4.5:1
- ❌ **Instant state changes** — 状态切换必须有过渡（150-300ms）
- ❌ **Invisible focus states** — 键盘焦点必须可见
- ❌ **静默的成功** — 任何操作完成必须有反馈（toast/状态变化）
- ❌ **无确认的危险操作** — 删除、结束进程必须二次确认并说明后果
- ❌ **单行操作** — 批量场景（清理多个条目）必须支持多选与批量动作

---

## Pre-Delivery Checklist

Before delivering any UI code, verify:

- [ ] 无 emoji 图标，全部 Lucide SVG
- [ ] 可点击元素均有 `cursor-pointer`
- [ ] hover/active 都有 150-300ms 过渡动画
- [ ] 两种主题下正文对比度 ≥4.5:1
- [ ] 键盘导航焦点可见（focus-visible 环）
- [ ] 遵守 `prefers-reduced-motion`
- [ ] 危险操作过确认对话框，并给出具体后果信息
- [ ] 操作完成有成功反馈（toast 或状态标记）
- [ ] 长列表（扫描结果/端口表）虚拟化或分页，无一次性渲染万条
- [ ] 表格无横向溢出（或给滚动容器），数字列右对齐
- [ ] 状态不只靠颜色（配文字/图标）
- [ ] 窗口 960px 宽下不出现横向滚动
