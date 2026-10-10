import { contextBridge, ipcRenderer } from 'electron'
import type {
  CleanMode,
  CleanOutcome,
  CleanRequestItem,
  ScanOptions,
  ScanOutcome,
  ScanProgress,
  VolumeInfo
} from '../shared/disk'
import type { AppInfo, Settings } from '../shared/types'

/*
 * 渲染层能碰到的全部能力 —— 就下面这些。
 *
 * 刻意不暴露通用的 invoke(channel, ...args)：那样渲染层等于拿到了主进程
 * 所有 IPC 通道的调用权。每一个能力都显式列出来，看一眼就知道界面能干哪些事。
 */
const api = {
  getAppInfo: (): Promise<AppInfo> => ipcRenderer.invoke('app:info') as Promise<AppInfo>,
  /** 在系统浏览器里打开链接。主进程只放行 http/https */
  openExternal: (url: string): Promise<void> =>
    ipcRenderer.invoke('app:open-external', url) as Promise<void>,
  /** 在资源管理器里定位到该路径 */
  showInFolder: (path: string): Promise<void> =>
    ipcRenderer.invoke('app:show-in-folder', path) as Promise<void>,
  /** 弹系统目录选择器，取消返回 null */
  pickDirectory: (): Promise<string | null> =>
    ipcRenderer.invoke('app:pick-directory') as Promise<string | null>,

  /* 设置 */
  getSettings: (): Promise<Settings | null> =>
    ipcRenderer.invoke('settings:get') as Promise<Settings | null>,
  updateSettings: (patch: Partial<Settings>): Promise<Settings | null> =>
    ipcRenderer.invoke('settings:update', patch) as Promise<Settings | null>,
  /** 主进程侧改了设置（托盘菜单等）会推过来，保证界面里的开关不落后 */
  onSettings: (handler: (settings: Settings) => void): (() => void) => {
    const listener = (_event: unknown, settings: Settings): void => handler(settings)
    ipcRenderer.on('settings', listener)
    return () => {
      ipcRenderer.off('settings', listener)
    }
  },

  /* 磁盘扫描与清理 */
  /** 启动扫描；已有任务会被「接管」（先取消旧的，再开新的） */
  startScan: (options: ScanOptions): Promise<ScanOutcome> =>
    ipcRenderer.invoke('scan:start', options) as Promise<ScanOutcome>,
  cancelScan: (): Promise<void> => ipcRenderer.invoke('scan:cancel') as Promise<void>,
  /** 扫描进度推送（约每 200ms 一条） */
  onScanProgress: (handler: (progress: ScanProgress) => void): (() => void) => {
    const listener = (_event: unknown, progress: ScanProgress): void => handler(progress)
    ipcRenderer.on('scan:progress', listener)
    return () => {
      ipcRenderer.off('scan:progress', listener)
    }
  },
  /** 执行清理。只允许删除最近一次扫描结果里的路径 */
  runClean: (items: CleanRequestItem[], mode: CleanMode): Promise<CleanOutcome> =>
    ipcRenderer.invoke('clean:run', items, mode) as Promise<CleanOutcome>,

  /* 分区 */
  listVolumes: (): Promise<VolumeInfo[]> =>
    ipcRenderer.invoke('volumes:list') as Promise<VolumeInfo[]>,

  /** 退出应用 —— 托盘常驻模式下这是正常的退出出口（关窗只是隐藏） */
  quit: (): Promise<void> => ipcRenderer.invoke('app:quit') as Promise<void>
}

contextBridge.exposeInMainWorld('opsCabin', api)

export type OpsCabinApi = typeof api
