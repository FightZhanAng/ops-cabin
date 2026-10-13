import type { QuietHours } from './notify'

/** 渲染层可见的应用信息（preload 桥 app:info 的返回形状） */
export interface AppInfo {
  name: string
  version: string
  electron: string
  chrome: string
  node: string
  /** GitHub 项目主页（关于弹窗的快捷入口） */
  repo: string
}

/** 窗口位置与尺寸（DIP 坐标） */
export interface WindowBounds {
  x: number
  y: number
  width: number
  height: number
}

/** 窗口状态（自绘标题栏用：按钮图标要跟着最大化/还原切换） */
export interface WindowState {
  maximized: boolean
}

/** 主题档位：跟随系统 / 固定浅色 / 固定深色 */
export type ThemeMode = 'system' | 'light' | 'dark'

/** 磁盘清理计划（M2 引擎、M7 设置页使用） */
export interface ScanPlan {
  mode: 'manual' | 'daily' | 'weekly'
  /** 'HH:mm'；mode 为 manual 时忽略 */
  time: string
}

/** 应用设置（userData/settings.json 的形状） */
export interface Settings {
  theme: ThemeMode
  windowBounds: WindowBounds | null
  /** 左侧导航栏是否收起为图标态 */
  sidebarCollapsed: boolean
  /** 关注端口变化时推系统通知 */
  notifyOnPortChange: boolean
  /** 计划扫描完成时推系统通知（关掉只是不推，扫描记录照常落盘） */
  notifyOnScanDone: boolean
  /** 关注的服务挂起或恢复时推系统通知 */
  notifyOnServiceDown: boolean
  /** 自动检查发现新版本时推系统通知 */
  notifyOnUpdate: boolean
  /**
   * 异常一直没恢复时重复提醒（目前作用于关注的服务：每 30 分钟再提醒一次）。
   *
   * 关掉后只在「刚挂」那一刻说一次 —— 那一次如果正好没看见，就再也不会知道。
   * 开着则像值班表：没人修就一直提，忍不了的人会去修或者关掉它。
   */
  notifySustained: boolean
  /** 安静时段：区间内不推通知（信号本身仍照常产生，页面里看得到） */
  quietHours: QuietHours
  /** 每天自动检查一次新版本（发现后也要手动点下载） */
  autoCheckUpdate: boolean
  scanPlan: ScanPlan
  /** 永不清理的保护目录（扫描与清理都跳过） */
  whitelist: string[]
}
