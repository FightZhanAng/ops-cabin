import { contextBridge, ipcRenderer } from 'electron'
import type { AutoOp, AutoResult } from '../shared/auto'
import type {
  CleanHistoryEntry,
  CleanMode,
  CleanOutcome,
  CleanRequestItem,
  ScanOptions,
  ScanOutcome,
  ScanProgress,
  VolumeInfo
} from '../shared/disk'
import type { HostsReport } from '../shared/hosts'
import type { HealthReport } from '../shared/health'
import type { MetricsSample } from '../shared/metrics'
import type { NetCheckReport } from '../shared/net'
import type {
  KillResult,
  PortChange,
  PortsSnapshot,
  WatchInput,
  WatchItem
} from '../shared/ports'
import type { ProcEntry } from '../shared/processes'
import type { ServiceCandidate, ServiceStatus, ServiceWatchItem } from '../shared/services'
import type { StartupReport } from '../shared/startup'
import type { TaskReport } from '../shared/tasks'
import type { TrendPoint } from '../shared/trend'
import type { AppInfo, Settings, WindowState } from '../shared/types'
import type { UpdateState } from '../shared/update'

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
  /** 弹系统目录选择器（可多选，最多 8 个）；取消返回空数组 */
  pickDirectory: (): Promise<string[]> =>
    ipcRenderer.invoke('app:pick-directory') as Promise<string[]>,

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
  /** 清理历史（按时间升序；总览统计图用） */
  listCleanHistory: (): Promise<CleanHistoryEntry[]> =>
    ipcRenderer.invoke('clean:history') as Promise<CleanHistoryEntry[]>,

  /* 分区 */
  listVolumes: (): Promise<VolumeInfo[]> =>
    ipcRenderer.invoke('volumes:list') as Promise<VolumeInfo[]>,

  /* 资源指标 */
  /** 立即采样一次（未就绪返回 null） */
  sampleMetrics: (): Promise<MetricsSample | null> =>
    ipcRenderer.invoke('metrics:sample') as Promise<MetricsSample | null>,
  /** 订阅 1s 采样推送（打开总览时调用，离开时 unsubscribeMetrics） */
  subscribeMetrics: (): Promise<void> =>
    ipcRenderer.invoke('metrics:subscribe') as Promise<void>,
  unsubscribeMetrics: (): Promise<void> =>
    ipcRenderer.invoke('metrics:unsubscribe') as Promise<void>,
  onMetricsSample: (handler: (sample: MetricsSample) => void): (() => void) => {
    const listener = (_event: unknown, sample: MetricsSample): void => handler(sample)
    ipcRenderer.on('metrics:update', listener)
    return () => {
      ipcRenderer.off('metrics:update', listener)
    }
  },
  /** 长期趋势的采样点（时间升序，最近 7 天） */
  listTrend: (): Promise<TrendPoint[]> =>
    ipcRenderer.invoke('trend:list') as Promise<TrendPoint[]>,

  /* 进程榜 */
  /** 取内存/CPU 的前若干名（并集），由渲染层决定按哪一列排 */
  listTopProcesses: (limit = 12): Promise<ProcEntry[]> =>
    ipcRenderer.invoke('processes:top', limit) as Promise<ProcEntry[]>,

  /* 联网体检 */
  /** 跑一次联网体检（探测 DNS / GitHub 443 / SSH 22 / SSH-over-443 / API / 代理） */
  runNetCheck: (): Promise<NetCheckReport> =>
    ipcRenderer.invoke('netcheck:run') as Promise<NetCheckReport>,

  /* hosts 文件体检（只读） */
  /** 读一次 hosts 文件并给出判定（域名被劫到本机 / 被屏蔽 / 命中发布链路域名） */
  readHosts: (): Promise<HostsReport> => ipcRenderer.invoke('hosts:read') as Promise<HostsReport>,

  /* 开机自启清单（只读） */
  /** 取自启清单；force=true 跳过 30 秒缓存 */
  listStartup: (force = false): Promise<StartupReport> =>
    ipcRenderer.invoke('startup:list', force) as Promise<StartupReport>,

  /* 计划任务清单（只读） */
  /** 取计划任务清单（已跳过系统自带任务）；force=true 跳过 60 秒缓存 */
  listTasks: (force = false): Promise<TaskReport> =>
    ipcRenderer.invoke('tasks:list', force) as Promise<TaskReport>,

  /* 可写操作（启动项/计划任务） */
  /**
   * 禁用/启用（toggle）与删除登记（delete）。
   * 只传采集报告里的 id —— 键路径与执行参数由主进程从自采集数据重建（见 autoapply.ts）。
   */
  applyAutoOp: (op: AutoOp): Promise<AutoResult> =>
    ipcRenderer.invoke('auto:apply', op) as Promise<AutoResult>,

  /* 系统体检（只读） */
  /** 跑一次系统体检（开机时长 / 待重启 / 磁盘 / 设备 / 事件日志 / 意外关机）；force=true 跳过 60 秒缓存 */
  readHealth: (force = false): Promise<HealthReport> =>
    ipcRenderer.invoke('health:read', force) as Promise<HealthReport>,

  /* 服务关注清单 */
  /** 被关注服务的当前状态（无关注项时返回空数组，不会起 PowerShell） */
  listServices: (): Promise<ServiceStatus[]> =>
    ipcRenderer.invoke('services:status') as Promise<ServiceStatus[]>,
  /** 本机全部服务（添加对话框的候选；只在打开对话框时调） */
  listServiceCandidates: (): Promise<ServiceCandidate[]> =>
    ipcRenderer.invoke('services:candidates') as Promise<ServiceCandidate[]>,
  getServiceWatch: (): Promise<ServiceWatchItem[]> =>
    ipcRenderer.invoke('services:watch:list') as Promise<ServiceWatchItem[]>,
  addServiceWatch: (
    name: string,
    label: string,
    note?: string
  ): Promise<ServiceWatchItem[]> =>
    ipcRenderer.invoke('services:watch:add', name, label, note) as Promise<ServiceWatchItem[]>,
  removeServiceWatch: (name: string): Promise<ServiceWatchItem[]> =>
    ipcRenderer.invoke('services:watch:remove', name) as Promise<ServiceWatchItem[]>,
  updateServiceWatch: (
    name: string,
    patch: { label?: string; note?: string }
  ): Promise<ServiceWatchItem[]> =>
    ipcRenderer.invoke('services:watch:update', name, patch) as Promise<ServiceWatchItem[]>,

  /* 端口雷达 */
  /** 立即采集一次端口快照（失败返回 null） */
  listPorts: (): Promise<PortsSnapshot | null> =>
    ipcRenderer.invoke('ports:list') as Promise<PortsSnapshot | null>,
  /** 订阅实时推送（进入端口相关页面时调用，离开时 unsubscribePorts） */
  subscribePorts: (): Promise<void> => ipcRenderer.invoke('ports:subscribe') as Promise<void>,
  unsubscribePorts: (): Promise<void> => ipcRenderer.invoke('ports:unsubscribe') as Promise<void>,
  /** 每次采样推送（约 2 秒一条） */
  onPortsSnapshot: (handler: (snapshot: PortsSnapshot) => void): (() => void) => {
    const listener = (_event: unknown, snapshot: PortsSnapshot): void => handler(snapshot)
    ipcRenderer.on('ports:snapshot', listener)
    return () => {
      ipcRenderer.off('ports:snapshot', listener)
    }
  },
  /** 关注端口的变化推送（occupy / release / change） */
  onPortsChanges: (handler: (changes: PortChange[]) => void): (() => void) => {
    const listener = (_event: unknown, changes: PortChange[]): void => handler(changes)
    ipcRenderer.on('ports:changes', listener)
    return () => {
      ipcRenderer.off('ports:changes', listener)
    }
  },

  /* 关注清单 */
  getWatchlist: (): Promise<WatchItem[]> =>
    ipcRenderer.invoke('ports:watch:list') as Promise<WatchItem[]>,
  addWatch: (input: WatchInput): Promise<WatchItem[]> =>
    ipcRenderer.invoke('ports:watch:add', input) as Promise<WatchItem[]>,
  removeWatch: (port: number): Promise<WatchItem[]> =>
    ipcRenderer.invoke('ports:watch:remove', port) as Promise<WatchItem[]>,
  updateWatch: (port: number, patch: { label?: string; note?: string }): Promise<WatchItem[]> =>
    ipcRenderer.invoke('ports:watch:update', port, patch) as Promise<WatchItem[]>,

  /** 关注端口的变化历史（新的在前） */
  listPortEvents: (): Promise<PortChange[]> =>
    ipcRenderer.invoke('ports:events') as Promise<PortChange[]>,

  /** 结束进程（只允许结束最近快照里正在监听端口的进程） */
  runKill: (pid: number): Promise<KillResult> =>
    ipcRenderer.invoke('ports:kill', pid) as Promise<KillResult>,

  /* 设置与维护 */
  /** 重置全部设置为默认值（保留窗口位置） */
  resetSettings: (): Promise<Settings | null> =>
    ipcRenderer.invoke('settings:reset') as Promise<Settings | null>,
  /** 在资源管理器里定位数据目录（settings.json 所在处） */
  openDataDir: (): Promise<string> =>
    ipcRenderer.invoke('app:open-data-dir') as Promise<string>,
  /** 清空关注端口的变化记录 */
  clearPortEvents: (): Promise<void> =>
    ipcRenderer.invoke('ports:events:clear') as Promise<void>,
  /** 立即执行一次「扫描计划到点检查」（设置页按钮与自检用） */
  checkScanPlanNow: (): Promise<boolean> =>
    ipcRenderer.invoke('scheduler:check-now') as Promise<boolean>,

  /* 版本更新 */
  getUpdate: (): Promise<UpdateState | null> =>
    ipcRenderer.invoke('update:get') as Promise<UpdateState | null>,
  checkUpdate: (): Promise<UpdateState | null> =>
    ipcRenderer.invoke('update:check') as Promise<UpdateState | null>,
  downloadUpdate: (): Promise<UpdateState | null> =>
    ipcRenderer.invoke('update:download') as Promise<UpdateState | null>,
  /** 下载完成后重启并安装（会退出应用） */
  installUpdate: (): Promise<void> => ipcRenderer.invoke('update:install') as Promise<void>,
  openReleasePage: (): Promise<void> => ipcRenderer.invoke('update:open-page') as Promise<void>,
  /** 更新状态推送（检查/下载/安装各阶段） */
  onUpdate: (handler: (state: UpdateState) => void): (() => void) => {
    const listener = (_event: unknown, state: UpdateState): void => handler(state)
    ipcRenderer.on('update', listener)
    return () => {
      ipcRenderer.off('update', listener)
    }
  },

  /* 窗口控制（自绘标题栏） */
  minimizeWindow: (): Promise<void> => ipcRenderer.invoke('win:minimize') as Promise<void>,
  /** 切换最大化/还原；返回操作后是否处于最大化态，供按钮图标回显 */
  toggleMaximizeWindow: (): Promise<boolean> =>
    ipcRenderer.invoke('win:toggle-maximize') as Promise<boolean>,
  /** 关窗 = 隐藏到托盘，与原来系统关闭按钮的行为一致 */
  closeWindow: (): Promise<void> => ipcRenderer.invoke('win:close') as Promise<void>,
  /** 查询当前窗口状态（标题栏按钮图标的初始态） */
  getWindowState: (): Promise<WindowState> =>
    ipcRenderer.invoke('win:state') as Promise<WindowState>,
  /** 最大化/还原状态推送（主进程在 maximize/unmaximize/restore 时发） */
  onWindowState: (handler: (state: WindowState) => void): (() => void) => {
    const listener = (_event: unknown, state: WindowState): void => handler(state)
    ipcRenderer.on('win:state', listener)
    return () => {
      ipcRenderer.off('win:state', listener)
    }
  },

  /** 退出应用 —— 托盘常驻模式下这是正常的退出出口（关窗只是隐藏） */
  quit: (): Promise<void> => ipcRenderer.invoke('app:quit') as Promise<void>
}

contextBridge.exposeInMainWorld('opsCabin', api)

export type OpsCabinApi = typeof api
