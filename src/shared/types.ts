/** 渲染层可见的应用信息（preload 桥 app:info 的返回形状） */
export interface AppInfo {
  name: string
  version: string
  electron: string
  chrome: string
  node: string
}

/** 窗口位置与尺寸（DIP 坐标） */
export interface WindowBounds {
  x: number
  y: number
  width: number
  height: number
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
  /** 关注端口变化时推系统通知 */
  notifyOnPortChange: boolean
  /** 每天自动检查一次新版本（发现后也要手动点下载） */
  autoCheckUpdate: boolean
  scanPlan: ScanPlan
  /** 永不清理的保护目录（扫描与清理都跳过） */
  whitelist: string[]
}
