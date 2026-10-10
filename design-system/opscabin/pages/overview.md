# Overview（总览）Page Overrides

> **PROJECT:** OpsCabin · **Page Type:** 桌面应用内页面（一屏仪表）
> 本文件规则**覆盖** MASTER.md；仅记录页面级增量与偏离。
>
> **校正说明：** 技能自动生成的版本基于 landing page 模板（Hero/CTA/How it works），与本应用场景不符，已人工重写。
> 条目依据本会话内技能检索：ux 域（loading feedback、状态双通道、reduced-motion）、
> chart 域（当前值用大字 KPI、≥1Hz 才用 stream 动画）、react 域（derived state、keys）。

---

## 布局

- 单屏仪表，尽量不滚动：顶部**磁盘分区条**（每分区一段占用量横条），中部左**关注端口卡片阵**、中部右**系统资源**（CPU / 内存 / 磁盘 IO / 网络），底部**提醒流**
- 卡片阵用栅格自适应；窗口 960px 宽下不出现横向滚动
- 每块面板都是入口：点磁盘条 → 磁盘页，点端口卡 → 端口页

## 组件

- 状态卡：KPI 大字（等宽数字）+ 单位（Dim 小字）+ 状态指示；"活跃/空闲"用状态灯 + 文字双通道
- sparkline：≤60 采样点即可，SVG 手写；当前值必须以大字文本呈现（chart 域要求"当前值作为大写字 KPI"）
- 提醒流条目：图标 + 一句话 + 时间 + 跳转锚点

## 交互规则

- 任何操作超过 300ms 给 skeleton 或 spinner（ux：loading feedback）
- 实时数据的刷新周期在界面上可见（如"每 2 秒"）；数据陈旧时显示"最后更新时间"
- 状态不只靠颜色：配图标或文字
- 数字等宽、右对齐；单位用 Dim 色

## 避免

- ❌ 装饰性闪烁/脉冲动画当氛围（技能：闪烁类动效必须尊重 `prefers-reduced-motion`，默认不用）
- ❌ 把总览做成营销式 Hero —— 它回答"现在什么状况"，不推销
