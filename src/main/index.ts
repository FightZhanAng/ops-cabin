import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeTheme,
  screen,
  shell
} from 'electron'
import { join } from 'node:path'
import type { AutoResult } from '../shared/auto'
import type {
  CleanHistoryEntry,
  CleanMode,
  CleanOutcome,
  CleanRequestItem,
  ScanOptions,
  ScanOutcome
} from '../shared/disk'
import { formatBytes } from '../shared/format'
import type { HealthReport } from '../shared/health'
import type { HostsReport } from '../shared/hosts'
import type { MetricsSample } from '../shared/metrics'
import type { NetCheckReport } from '../shared/net'
import type { KillResult, PortChange, PortsSnapshot, WatchInput } from '../shared/ports'
import type { ProcEntry } from '../shared/processes'
import type { ServiceCandidate, ServiceStatus } from '../shared/services'
import type { StartupReport } from '../shared/startup'
import type { TaskReport } from '../shared/tasks'
import type { TrendPoint } from '../shared/trend'
import { DEFAULT_SETTINGS } from '../shared/settings'
import type { AppInfo, Settings, WindowBounds, WindowState } from '../shared/types'
import { applyAutoOp } from './autoapply'
import { Cleaner } from './cleaner'
import { elevateAutoOp } from './elevate'
import { collectHealth } from './health'
import { runApplyOpHelper } from './helper'
import { readHosts } from './hosts'
import { MetricsMonitor } from './metrics'
import { Notifier } from './notify'
import { appIconPath, preloadPath } from './paths'
import { PortEventsStore } from './ports/events'
import { killProcess } from './ports/kill'
import { WatchlistStore } from './ports/store'
import { PortsMonitor } from './ports/watch'
import { Scanner, parseScanOptions } from './scanner'
import { ScanScheduler, type ScheduledScanSummary } from './scheduler'
import { collectServices, listServiceCandidates } from './services/collect'
import { ServiceMonitor, describeServiceAlerts } from './services/monitor'
import { ServiceWatchStore } from './services/store'
import { SettingsStore } from './settings'
import { SMOKE, SMOKE_DRIVE, SMOKE_THEME, runSmoke, smoke } from './smoke'
import { collectStartup } from './startup'
import { collectTasks } from './tasks'
import { TrayController } from './tray'
import { UpdateController } from './updater'
import { listVolumes } from './volumes'
import { processTable } from './processes'
import { runNetCheck } from './netcheck'
import { TrendStore } from './trend'

const APP_ID = app.isPackaged ? 'com.tomcato.ops-cabin' : 'com.tomcato.ops-cabin.dev'

/**
 * 两套主题下的窗口底色 —— 必须和 index.css 的 --bg 保持一致，否则首帧会闪一下。
 */
const WINDOW_BG = { light: '#f1f5f9', dark: '#0f172a' }

const DEFAULT_BOUNDS = { width: 1180, height: 800 }
const MIN_WINDOW = { width: 960, height: 660 }

/** 项目主页与发布页（关于弹窗的 GitHub 入口、更新失败与免安装版的兜底都指这里） */
const REPO_PAGE = 'https://github.com/FightZhanAng/ops-cabin'
const RELEASE_PAGE = `${REPO_PAGE}/releases`

let mainWindow: BrowserWindow | null = null
let tray: TrayController | null = null
let settingsStore: SettingsStore | null = null
let scanner: Scanner | null = null
let cleaner: Cleaner | null = null
let metricsMonitor: MetricsMonitor | null = null
let trendStore: TrendStore | null = null
let scheduler: ScanScheduler | null = null
let updater: UpdateController | null = null
let portsMonitor: PortsMonitor | null = null
let watchlistStore: WatchlistStore | null = null
let portEvents: PortEventsStore | null = null
let serviceWatchStore: ServiceWatchStore | null = null
let serviceMonitor: ServiceMonitor | null = null
/** 四类信号的通知出口（开关、安静时段、留档都在里面） */
let notifier: Notifier | null = null
/**
 * 上一个通知过的版本号。
 *
 * 去重按**版本**而不是按「status 变成 available」：自动检查每天跑一次，
 * 用户还可能手动点两回「检查更新」—— 按状态变化去重的话，同一个版本
 * 会因为中间穿插了一次 checking 而被反复通知。
 */
let notifiedUpdateVersion: string | null = null
let isQuitting = false

/* ------------------------------------------------ 带缓存与合流的采集（侧栏与页面会同时要） */

/**
 * 启动项采集的缓存。
 *
 * 侧栏徽标、启动项页都会要这份数据，而它每次都要起一次 PowerShell（冷启动 1–2 秒）。
 * 不开缓存的话，切一次页面就重跑一次。30 秒的 TTL 足够：自启项只在装/卸软件时才变。
 */
const STARTUP_TTL = 30_000
let startupCache: { at: number; report: StartupReport } | null = null
let startupInflight: Promise<StartupReport> | null = null

/** 服务状态的缓存：状态会变（服务可能停），TTL 比启动项短得多 */
const SERVICES_TTL = 15_000
let servicesCache: { at: number; items: ServiceStatus[] } | null = null
let servicesInflight: Promise<ServiceStatus[]> | null = null

/**
 * 计划任务的缓存。
 *
 * 这份数据是本批最贵的一次采集（本机 1.5 秒，全是 COM 枚举的固定开销），
 * 但内容变得很慢：「下次运行时间」要等任务跑过一轮才变。60 秒的 TTL 足够，
 * 而用户点「重新读取」时走 force 绕开。
 */
const TASKS_TTL = 60_000
let tasksCache: { at: number; report: TaskReport } | null = null
let tasksInflight: Promise<TaskReport> | null = null

/** 采集失败时的空报告：界面显示「读不到」，而不是一直转圈 */
function emptyStartup(error: string): StartupReport {
  return {
    at: Date.now(),
    items: [],
    invalid: 0,
    bySource: {
      'registry-hkcu': 0,
      'registry-hklm': 0,
      'registry-hklm-wow': 0,
      'folder-user': 0,
      'folder-common': 0
    },
    durationMs: 0,
    degraded: true,
    error
  }
}

/**
 * 取启动项报告（带 TTL 缓存 + 并发合流）。
 *
 * 合流是关键：侧栏和页面几乎同时挂载时会有两个请求打进来，
 * 没有合流就会起两次 PowerShell —— 而这正是这个缓存想避免的事。
 */
function startupReport(force = false): Promise<StartupReport> {
  const now = Date.now()
  if (!force && startupCache && now - startupCache.at < STARTUP_TTL) {
    return Promise.resolve(startupCache.report)
  }
  if (startupInflight) return startupInflight
  startupInflight = collectStartup()
    .then((report) => {
      startupCache = { at: Date.now(), report }
      return report
    })
    .catch((error: unknown) =>
      emptyStartup(error instanceof Error ? error.message : String(error))
    )
    .finally(() => {
      startupInflight = null
    })
  return startupInflight
}

/** 关注服务的当前状态（清单标签合进来；无关注项时直接返回空，不起 PowerShell） */
function serviceStatuses(force = false): Promise<ServiceStatus[]> {
  const watch = serviceWatchStore?.all ?? []
  if (watch.length === 0) return Promise.resolve([])

  const now = Date.now()
  if (!force && servicesCache && now - servicesCache.at < SERVICES_TTL) {
    return Promise.resolve(servicesCache.items)
  }
  if (servicesInflight) return servicesInflight

  servicesInflight = collectServices(watch.map((item) => item.name))
    .then(({ items }) => {
      const byName = new Map(watch.map((item) => [item.name.toLowerCase(), item]))
      const merged = items.map((item) => {
        const saved = byName.get(item.name.toLowerCase())
        return {
          ...item,
          label: saved?.label ?? item.label,
          ...(saved?.note ? { note: saved.note } : {})
        }
      })
      servicesCache = { at: Date.now(), items: merged }
      return merged
    })
    .catch(() => [] as ServiceStatus[])
    .finally(() => {
      servicesInflight = null
    })
  return servicesInflight
}

/** 采集失败时的空报告：界面显示「读不到」，而不是一直转圈 */
function emptyTasks(error: string): TaskReport {
  return {
    at: Date.now(),
    items: [],
    scanned: 0,
    systemSkipped: 0,
    attention: 0,
    enabled: 0,
    durationMs: 0,
    degraded: true,
    error
  }
}

/**
 * 取计划任务报告（带 TTL 缓存 + 并发合流）。
 *
 * 合流同样关键：启动项页的 Tab 切换、以及以后可能有的侧栏徽标会同时要这份数据，
 * 没有合流就会并发起两次 COM 枚举 —— 而这正是这个缓存想避免的事。
 */
function taskReport(force = false): Promise<TaskReport> {
  const now = Date.now()
  if (!force && tasksCache && now - tasksCache.at < TASKS_TTL) {
    return Promise.resolve(tasksCache.report)
  }
  if (tasksInflight) return tasksInflight
  tasksInflight = collectTasks()
    .then((report) => {
      tasksCache = { at: Date.now(), report }
      return report
    })
    .catch((error: unknown) =>
      emptyTasks(error instanceof Error ? error.message : String(error))
    )
    .finally(() => {
      tasksInflight = null
    })
  return tasksInflight
}

/**
 * 系统体检的缓存。
 *
 * 这份数据是四段 PowerShell **并发**跑出来的（本机 3.8 秒；串行要 11.1 秒），
 * 代价不小但内容变得很慢：磁盘健康、设备错误码、开机时刻都是按小时乃至按天变的。
 * 60 秒的 TTL 足够，用户点「重新体检」时走 force 绕开。
 */
const HEALTH_TTL = 60_000
let healthCache: { at: number; report: HealthReport } | null = null
let healthInflight: Promise<HealthReport> | null = null

/** 采集失败时的空报告：界面显示「读不到」，而不是一直转圈 */
function emptyHealth(error: string): HealthReport {
  return {
    at: Date.now(),
    durationMs: 0,
    bootedAt: null,
    uptimeMs: null,
    reboot: [],
    rebootRequired: 0,
    logs: [],
    crashes: [],
    crashWindowDays: 0,
    disks: [],
    devices: [],
    deviceProblems: 0,
    deviceDisabled: 0,
    degraded: true,
    error
  }
}

/** 取体检报告（带 TTL 缓存 + 并发合流） */
function healthReport(force = false): Promise<HealthReport> {
  const now = Date.now()
  if (!force && healthCache && now - healthCache.at < HEALTH_TTL) {
    return Promise.resolve(healthCache.report)
  }
  if (healthInflight) return healthInflight
  healthInflight = collectHealth()
    .then((report) => {
      healthCache = { at: Date.now(), report }
      return report
    })
    .catch((error: unknown) =>
      emptyHealth(error instanceof Error ? error.message : String(error))
    )
    .finally(() => {
      healthInflight = null
    })
  return healthInflight
}

/* ------------------------------------------------------------ 冒烟自检（实现见 smoke.ts） */

// 模块最顶层就落一个探针：只有它出现、后续报告缺失，
// 说明是 requestSingleInstanceLock 之后没走通，而不是代码没加载。
smoke('boot', {
  at: Date.now(),
  pid: process.pid,
  electron: process.versions.electron,
  node: process.versions.node
})

/* ------------------------------------------------------------ 主题 */

function currentBg(): string {
  return nativeTheme.shouldUseDarkColors ? WINDOW_BG.dark : WINDOW_BG.light
}

function applyTheme(mode: Settings['theme']): void {
  nativeTheme.themeSource = mode
}

/* ------------------------------------------------------------ 外部链接 */

/**
 * 打开外部链接。渲染层能把任意字符串递进来，所以这里是安全边界：
 * 只放行 http/https，其它协议（file:、自定义协议）一律丢弃。
 */
function openExternal(raw: unknown): void {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 2048) return
  try {
    const url = new URL(raw)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return
    void shell.openExternal(url.toString())
  } catch {
    /* 不是合法 URL，丢弃 */
  }
}

function hardenWindow(win: BrowserWindow): void {
  // 页面里的 target=_blank / window.open 一律转给系统浏览器
  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url)
    return { action: 'deny' }
  })
  // 页面自身不许导航去别处（dev server 与本地产物文件除外）
  win.webContents.on('will-navigate', (event, url) => {
    const devUrl = process.env['ELECTRON_RENDERER_URL']
    const allowed = url.startsWith('file://') || (devUrl !== undefined && url.startsWith(devUrl))
    if (!allowed) {
      event.preventDefault()
      openExternal(url)
    }
  })
}

/* ------------------------------------------------------------ 窗口 */

/** 恢复前校验：位置得落在某块显示器里，否则拔掉外接屏后会恢复到看不见的地方 */
function usableBounds(saved: Settings['windowBounds']): WindowBounds | null {
  if (!saved) return null
  const { x, y, width, height } = saved
  const visible = screen.getAllDisplays().some(
    (d) =>
      x + width > d.workArea.x + 40 &&
      x < d.workArea.x + d.workArea.width - 40 &&
      y + height > d.workArea.y + 20 &&
      y < d.workArea.y + d.workArea.height - 20
  )
  return visible ? { x, y, width, height } : null
}

function createMainWindow(): BrowserWindow {
  const bounds = usableBounds(settingsStore?.settings.windowBounds ?? null)

  const win = new BrowserWindow({
    width: bounds?.width ?? DEFAULT_BOUNDS.width,
    height: bounds?.height ?? DEFAULT_BOUNDS.height,
    ...(bounds ? { x: bounds.x, y: bounds.y } : {}),
    minWidth: MIN_WINDOW.width,
    minHeight: MIN_WINDOW.height,
    show: false,
    backgroundColor: currentBg(),
    title: '运维舱',
    icon: appIconPath(),
    // 无系统标题栏：标题栏、窗口按钮全部由渲染层自绘（见 renderer/components/layout/TitleBar.tsx）。
    // 缩放边框仍然保留（Windows 在 frame:false 下依旧给可缩放的窗口留原生 resize 边）。
    frame: false,
    webPreferences: {
      preload: preloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  hardenWindow(win)

  // 最大化/还原状态推给渲染层，标题栏按钮图标要跟着换
  const pushWindowState = (): void => {
    if (win.isDestroyed()) return
    win.webContents.send('win:state', { maximized: win.isMaximized() } satisfies WindowState)
  }
  win.on('maximize', pushWindowState)
  win.on('unmaximize', pushWindowState)
  win.on('restore', pushWindowState)

  // ready-to-show 才呈现，避免先白后内容的一帧闪烁
  win.once('ready-to-show', () => {
    win.show()
    smoke('window', {
      bounds: win.getBounds(),
      contentBounds: win.getContentBounds(),
      visible: win.isVisible(),
      restored: bounds !== null
    })
  })

  // 关闭 = 隐藏：这是个托盘常驻应用，关窗不该退出
  win.on('close', (event) => {
    if (isQuitting) return
    event.preventDefault()
    rememberBounds()
    win.hide()
  })

  win.on('closed', () => {
    mainWindow = null
  })

  // 开发模式走 vite dev server；打包后加载产物文件
  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (!app.isPackaged && devUrl) {
    void win.loadURL(devUrl)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return win
}

function rememberBounds(): void {
  if (!mainWindow || mainWindow.isDestroyed() || !settingsStore) return
  if (mainWindow.isMinimized() || mainWindow.isMaximized()) return
  const [x, y] = mainWindow.getPosition()
  const [width, height] = mainWindow.getSize()
  settingsStore.patch({ windowBounds: { x, y, width, height } })
}

function showPanel(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    mainWindow = createMainWindow()
    return
  }
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

function togglePanel(): void {
  if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible() && mainWindow.isFocused()) {
    rememberBounds()
    mainWindow.hide()
    return
  }
  showPanel()
}

/* ------------------------------------------------------------ 端口通知 */

const CHANGE_LABEL: Record<PortChange['type'], string> = {
  occupy: '被占用',
  release: '已释放',
  change: '换了占用者'
}

/**
 * 关注端口变化的系统通知（多条聚合成一条，避免通知轰炸）。
 *
 * 开关判断**不在这里**做 —— 出口（Notifier）统一判，这样被关掉的那些照样留档，
 * 「为什么没收到」永远答得上来。散在各调用点判是漏判的温床。
 */
function notifyPortChanges(changes: PortChange[]): void {
  const first = changes[0]
  const body =
    changes.length === 1
      ? `端口 ${first.port} ${CHANGE_LABEL[first.type]}${first.process ? `：${first.process}` : ''}`
      : `${changes
          .slice(0, 5)
          .map((c) => `${c.port} ${CHANGE_LABEL[c.type]}`)
          .join('；')}${changes.length > 5 ? ` 等 ${changes.length} 项` : ''}`
  notifier?.notify('port', '关注端口有变化', body)
}

/** 计划扫描完成的通知：点开面板去磁盘页确认（不做自动删除） */
function notifyScheduledScan(summary: ScheduledScanSummary): void {
  notifier?.notify(
    'scan',
    '计划扫描完成',
    summary.items > 0
      ? `发现 ${summary.items} 项可清理（约 ${formatBytes(summary.bytes)}）—— 去磁盘页确认后清理`
      : '这台机器很干净，没有发现可清理的项'
  )
}

/* ------------------------------------------------------------ IPC 入参 */

/** 校验渲染层传来的清理项（路径与字节数都要合理） */
function parseCleanItems(raw: unknown): CleanRequestItem[] {
  if (!Array.isArray(raw)) return []
  const out: CleanRequestItem[] = []
  for (const entry of raw) {
    if (entry === null || typeof entry !== 'object') continue
    const { path, bytes } = entry as Record<string, unknown>
    if (typeof path !== 'string' || path.length === 0 || path.length > 1024) continue
    if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) continue
    out.push({ path, bytes })
    if (out.length >= 500) break
  }
  return out
}

function parsePort(raw: unknown): number | null {
  const value = Number(raw)
  return Number.isInteger(value) && value > 0 && value <= 65535 ? value : null
}

function parseWatchInput(raw: unknown): WatchInput | null {
  if (raw === null || typeof raw !== 'object') return null
  const rec = raw as Record<string, unknown>
  const port = parsePort(rec.port)
  if (port === null) return null
  const label =
    typeof rec.label === 'string' && rec.label.trim().length > 0 ? rec.label.trim() : `端口 ${port}`
  const note = typeof rec.note === 'string' && rec.note.length > 0 ? rec.note : undefined
  return { port, label, note }
}

function parseWatchPatch(raw: unknown): { label?: string; note?: string } {
  if (raw === null || typeof raw !== 'object') return {}
  const rec = raw as Record<string, unknown>
  const patch: { label?: string; note?: string } = {}
  if (typeof rec.label === 'string' && rec.label.length > 0) patch.label = rec.label
  if (typeof rec.note === 'string') patch.note = rec.note
  return patch
}

/** 服务名：Windows 服务名上限 256，这里收得更紧（更长的都是畸形输入） */
function parseServiceName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const text = raw.trim()
  return text.length > 0 && text.length <= 128 ? text : null
}

function parseLabelPatch(raw: unknown): { label?: string; note?: string } {
  if (raw === null || typeof raw !== 'object') return {}
  const rec = raw as Record<string, unknown>
  const patch: { label?: string; note?: string } = {}
  if (typeof rec.label === 'string') patch.label = rec.label
  if (typeof rec.note === 'string') patch.note = rec.note
  return patch
}

/* ------------------------------------------------------------ IPC */

function registerIpc(): void {
  ipcMain.handle(
    'app:info',
    (): AppInfo => ({
      name: '运维舱',
      version: app.getVersion(),
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      repo: REPO_PAGE
    })
  )
  ipcMain.handle('app:open-external', (_event, url: unknown) => openExternal(url))
  ipcMain.handle('app:quit', () => {
    isQuitting = true
    app.quit()
  })
  ipcMain.handle('app:show-in-folder', (_event, path: unknown) => {
    if (typeof path === 'string' && path.length > 0 && path.length <= 1024) {
      shell.showItemInFolder(path)
    }
  })
  ipcMain.handle('app:pick-directory', async (): Promise<string[]> => {
    if (!mainWindow || mainWindow.isDestroyed()) return []
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择要扫描大文件的目录（可多选，最多 8 个）',
      properties: ['openDirectory', 'multiSelections']
    })
    if (result.canceled) return []
    return result.filePaths.slice(0, 8)
  })

  /* 窗口控制（自绘标题栏的三个按钮 + 状态查询） */
  ipcMain.handle('win:minimize', () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.minimize()
  })
  ipcMain.handle('win:toggle-maximize', (): boolean => {
    const win = mainWindow
    if (!win || win.isDestroyed()) return false
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
    return win.isMaximized()
  })
  // 与原来点系统关闭按钮同一条路径：close 事件里 preventDefault + hide（托盘常驻）
  ipcMain.handle('win:close', () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close()
  })
  ipcMain.handle('win:state', (): WindowState => ({
    maximized: mainWindow?.isMaximized() ?? false
  }))

  ipcMain.handle('settings:get', () => settingsStore?.settings ?? null)
  ipcMain.handle('settings:update', (_event, patch: unknown) => {
    if (!patch || typeof patch !== 'object') return settingsStore?.settings ?? null
    const applied = (settingsStore as SettingsStore).patch(patch as Partial<Settings>)
    applyTheme(applied.theme)
    scheduler?.setPlan(applied.scanPlan)
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('settings', applied)
    }
    return applied
  })
  ipcMain.handle('settings:reset', () => {
    if (!settingsStore) return null
    // 重置用户配置，但保留窗口位置（重置完窗口还在原地）
    const bound = settingsStore.settings.windowBounds
    const applied = settingsStore.patch({ ...DEFAULT_SETTINGS, windowBounds: bound })
    applyTheme(applied.theme)
    scheduler?.setPlan(applied.scanPlan)
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('settings', applied)
    }
    return applied
  })

  /* 磁盘扫描与清理 */
  ipcMain.handle('scan:start', (_event, raw: unknown) => runScanAndRegister(parseScanOptions(raw)))
  ipcMain.handle('scan:cancel', () => scanner?.cancel())

  ipcMain.handle('clean:run', (_event, rawItems: unknown, rawMode: unknown): Promise<CleanOutcome> => {
    if (!cleaner) return Promise.resolve({ ok: false, error: '清理器未就绪' })
    const mode: CleanMode = rawMode === 'permanent' ? 'permanent' : 'recycle'
    return cleaner.run(
      parseCleanItems(rawItems),
      mode,
      settingsStore?.settings.whitelist ?? []
    )
  })

  /** 清理历史（总览的统计图） */
  ipcMain.handle('clean:history', (): CleanHistoryEntry[] => cleaner?.history() ?? [])

  /* 分区 */
  ipcMain.handle('volumes:list', () => listVolumes())

  /* 端口雷达 */
  // 语义是「现在有什么在监听」：每次现采一次（监控器会把并发采样合流）
  ipcMain.handle('ports:list', async (): Promise<PortsSnapshot | null> => {
    if (!portsMonitor) return null
    try {
      return await portsMonitor.sampleNow()
    } catch {
      return null
    }
  })
  ipcMain.handle('ports:subscribe', () => {
    portsMonitor?.addSubscriber()
  })
  ipcMain.handle('ports:unsubscribe', () => {
    portsMonitor?.removeSubscriber()
  })

  ipcMain.handle('ports:watch:list', () => watchlistStore?.all ?? [])
  ipcMain.handle('ports:watch:add', (_event, raw: unknown) => {
    const input = parseWatchInput(raw)
    if (!input || !watchlistStore) return watchlistStore?.all ?? []
    const items = watchlistStore.add(input.port, input.label, input.note)
    portsMonitor?.setWatchlist(items)
    return items
  })
  ipcMain.handle('ports:watch:remove', (_event, rawPort: unknown) => {
    const port = parsePort(rawPort)
    if (port === null || !watchlistStore) return watchlistStore?.all ?? []
    const items = watchlistStore.remove(port)
    portsMonitor?.setWatchlist(items)
    return items
  })
  ipcMain.handle('ports:watch:update', (_event, rawPort: unknown, rawPatch: unknown) => {
    const port = parsePort(rawPort)
    if (port === null || !watchlistStore) return watchlistStore?.all ?? []
    const items = watchlistStore.update(port, parseWatchPatch(rawPatch))
    portsMonitor?.setWatchlist(items)
    return items
  })

  ipcMain.handle('ports:events', () => portEvents?.recent(200) ?? [])

  /* 结束进程：安全边界 —— 只允许结束「最近一次端口快照里正在监听」的进程 */
  ipcMain.handle('ports:kill', async (_event, rawPid: unknown): Promise<KillResult> => {
    const pid = Number(rawPid)
    if (!Number.isInteger(pid) || pid <= 4) {
      return { ok: false, forced: false, error: '无效的进程号' }
    }
    const allowed = portsMonitor?.latest?.entries.some((entry) => entry.pid === pid) ?? false
    if (!allowed) {
      return { ok: false, forced: false, error: '该进程不在最近一次端口快照中，已拒绝' }
    }
    const result = await killProcess(pid)
    // 立即重采一次，让界面尽快反映变化
    const monitor = portsMonitor
    if (monitor) void monitor.sampleNow().catch(() => {})
    return result
  })

  /* 资源指标 */
  ipcMain.handle('metrics:sample', (): MetricsSample | null => metricsMonitor?.sampleNow() ?? null)
  ipcMain.handle('metrics:subscribe', () => {
    metricsMonitor?.addSubscriber()
  })
  ipcMain.handle('metrics:unsubscribe', () => {
    metricsMonitor?.removeSubscriber()
  })

  /* 长期趋势（总览的趋势图） */
  ipcMain.handle('trend:list', (): TrendPoint[] => trendStore?.list() ?? [])

  /* 进程榜（总览；与端口页共用一份进程表采集） */
  ipcMain.handle('processes:top', (_event, rawLimit: unknown): Promise<ProcEntry[]> => {
    const limit = Number(rawLimit)
    return processTable.top(Number.isInteger(limit) && limit > 0 ? Math.min(limit, 50) : 12)
  })

  /* 联网体检（按需触发，5 秒左右出结果） */
  ipcMain.handle('netcheck:run', (): Promise<NetCheckReport> => runNetCheck())

  /* hosts 文件体检（只读：读文件 + 判定，从不写回） */
  ipcMain.handle('hosts:read', (): HostsReport => readHosts())

  /* 开机自启清单（只读；带 TTL 缓存，侧栏与页面共用一份） */
  ipcMain.handle(
    'startup:list',
    (_event, rawForce: unknown): Promise<StartupReport> => startupReport(rawForce === true)
  )

  /* 计划任务清单（只读；带 TTL 缓存 + 并发合流） */
  ipcMain.handle(
    'tasks:list',
    (_event, rawForce: unknown): Promise<TaskReport> => taskReport(rawForce === true)
  )

  /* 可写操作（启动项/计划任务的禁用启用与删除登记；唯一写实现方见 autoapply.ts） */
  ipcMain.handle(
    'auto:apply',
    (_event, raw: unknown): Promise<AutoResult> =>
      applyAutoOp(raw, { startupReport, taskReport, elevate: elevateAutoOp })
  )

  /* 系统体检（只读；四段 PowerShell 并发采集，带 TTL 缓存 + 并发合流） */
  ipcMain.handle(
    'health:read',
    (_event, rawForce: unknown): Promise<HealthReport> => healthReport(rawForce === true)
  )

  /* 服务关注清单 */
  ipcMain.handle('services:status', (): Promise<ServiceStatus[]> => serviceStatuses())
  ipcMain.handle(
    'services:candidates',
    (): Promise<ServiceCandidate[]> => listServiceCandidates()
  )
  ipcMain.handle('services:watch:list', () => serviceWatchStore?.all ?? [])
  ipcMain.handle('services:watch:add', (_event, rawName: unknown, rawLabel: unknown, rawNote: unknown) => {
    const name = parseServiceName(rawName)
    if (name === null || !serviceWatchStore) return serviceWatchStore?.all ?? []
    const label = typeof rawLabel === 'string' ? rawLabel : ''
    const note = typeof rawNote === 'string' ? rawNote : undefined
    const items = serviceWatchStore.add(name, label, note)
    servicesCache = null
    // 立即建立基线：新关注的服务当下是什么状态就是什么状态，绝不把「刚关注」当变化
    void serviceMonitor?.syncNow()
    return items
  })
  ipcMain.handle('services:watch:remove', (_event, rawName: unknown) => {
    const name = parseServiceName(rawName)
    if (name === null || !serviceWatchStore) return serviceWatchStore?.all ?? []
    const items = serviceWatchStore.remove(name)
    servicesCache = null
    void serviceMonitor?.syncNow()
    return items
  })
  ipcMain.handle('services:watch:update', (_event, rawName: unknown, rawPatch: unknown) => {
    const name = parseServiceName(rawName)
    if (name === null || !serviceWatchStore) return serviceWatchStore?.all ?? []
    const items = serviceWatchStore.update(name, parseLabelPatch(rawPatch))
    servicesCache = null
    return items
  })

  /* 设置与维护 */
  ipcMain.handle('app:open-data-dir', () => {
    const file = settingsStore?.dataFile
    if (file) shell.showItemInFolder(file)
    return file ?? ''
  })
  ipcMain.handle('ports:events:clear', () => {
    portEvents?.clear()
  })
  ipcMain.handle('scheduler:check-now', () => scheduler?.checkNow() ?? Promise.resolve(false))

  /* 版本更新 */
  ipcMain.handle('update:get', () => updater?.describe() ?? null)
  ipcMain.handle('update:check', () => {
    updater?.check()
    return updater?.describe() ?? null
  })
  ipcMain.handle('update:download', () => {
    updater?.download()
    return updater?.describe() ?? null
  })
  ipcMain.handle('update:install', () => updater?.install())
  ipcMain.handle('update:open-page', () => updater?.openReleasePage())
}

/** 跑一次扫描并把结果登记给清理器（IPC 与计划任务共用） */
async function runScanAndRegister(options: ScanOptions): Promise<ScanOutcome> {
  if (!scanner) return { ok: false, cancelled: false, error: '扫描器未就绪' }
  const outcome = await scanner.start(options, settingsStore?.settings.whitelist ?? [])
  if (outcome.ok) {
    cleaner?.registerScanned(outcome.result.groups.flatMap((g) => g.items.map((i) => i.path)))
  }
  return outcome
}

/* ------------------------------------------------------------ 启动 */

// 提权助手模式：被 UAC 提权拉起的那份进程只干一件事 —— 落一次写操作然后退出。
// 放在抢单实例锁之前：助手是另一个进程，不能因为「舱已开着」被单实例逻辑赶走。
const applyOpIndex = process.argv.indexOf('--apply-op')
if (applyOpIndex >= 0) {
  runApplyOpHelper(process.argv[applyOpIndex + 1] ?? '')
} else if (!app.requestSingleInstanceLock()) {
  // 单实例：第二次启动把已有窗口唤到前面，而不是开两个运维舱
  app.quit()
} else {
  app.on('second-instance', () => showPanel())

  void app.whenReady().then(() => {
    app.setAppUserModelId(APP_ID)

    // Windows 上不清空菜单的话，Electron 会自己挂一条 File/Edit/View 的菜单栏
    Menu.setApplicationMenu(null)

    settingsStore = new SettingsStore()
    applyTheme(settingsStore.settings.theme)
    smoke('settings', {
      file: settingsStore.dataFile,
      windowBounds: settingsStore.settings.windowBounds,
      theme: settingsStore.settings.theme
    })

    notifier = new Notifier({
      getSettings: () => settingsStore?.settings ?? null,
      onClick: () => showPanel(),
      // 自检下不真弹：几十秒内会触发好几条，弹出来会糊满屏幕并干扰截图
      silent: SMOKE
    })

    scanner = new Scanner({
      onProgress: (progress) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('scan:progress', progress)
        }
      }
    })
    cleaner = new Cleaner()

    scheduler = new ScanScheduler(
      {
        runScan: async () => {
          const outcome = await runScanAndRegister({ groups: ['safe', 'devCaches'] })
          if (!outcome.ok) return null
          const items = outcome.result.groups.reduce((sum, group) => sum + group.items.length, 0)
          const bytes = outcome.result.groups.reduce((sum, group) => sum + group.bytes, 0)
          smoke('scheduled-scan', {
            at: Date.now(),
            items,
            bytes,
            durationMs: outcome.result.durationMs
          })
          return { items, bytes }
        },
        onDone: (summary) => notifyScheduledScan(summary),
        onError: (message) => smoke('scheduled-scan-error', { at: Date.now(), message })
      },
      settingsStore.settings.scanPlan
    )
    scheduler.start()

    // 自检时允许强制主题（深浅两套配色各跑一轮）
    if (SMOKE && (SMOKE_THEME === 'light' || SMOKE_THEME === 'dark')) {
      settingsStore.patch({ theme: SMOKE_THEME })
      applyTheme(SMOKE_THEME)
    }

    updater = new UpdateController({
      getAutoCheck: () => settingsStore?.settings.autoCheckUpdate ?? true,
      onChange: (state) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('update', state)
        }
        /*
         * 新版本通知：这是四类信号里唯一的「好消息」，也是最容易被错过的 ——
         * 自动检查发生在启动 30 秒后，那时用户多半已经切走了。同一个版本只通知
         * 一次（见 notifiedUpdateVersion 的说明）。
         */
        if (
          state.status === 'available' &&
          state.latest.length > 0 &&
          state.latest !== notifiedUpdateVersion
        ) {
          notifiedUpdateVersion = state.latest
          notifier?.notify(
            'update',
            '发现新版本',
            `${state.current} → ${state.latest} —— 到设置页下载`
          )
        }
      },
      releasePage: RELEASE_PAGE
    })

    metricsMonitor = new MetricsMonitor({
      onSample: (sample) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('metrics:update', sample)
        }
      }
    })

    // 长期趋势：每 5 分钟落一个点（没人看的时候也在攒，否则「内存是不是在涨」无从回答）
    trendStore = new TrendStore()
    trendStore.start({
      sample: () => metricsMonitor?.sampleTrend() ?? null
    })

    watchlistStore = new WatchlistStore()
    serviceWatchStore = new ServiceWatchStore()
    portEvents = new PortEventsStore()
    portsMonitor = new PortsMonitor({
      onSnapshot: (snapshot) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('ports:snapshot', snapshot)
        }
      },
      onChanges: (changes) => {
        portEvents?.append(changes)
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('ports:changes', changes)
        }
        // 开关判在通知出口里（见 Notifier）：这里只负责「有没有变化」
        notifyPortChanges(changes)
      }
    })
    // 有关注项时监控自动开始后台盯梢（懒轮询）
    portsMonitor.setWatchlist(watchlistStore.all)

    /*
     * 关注服务的后台盯梢。
     *
     * 与端口同构的懒轮询，但节奏慢一倍（采集要起 PowerShell）：无关注项时每拍
     * 空转，有关注项时 60 秒一拍、复用主进程的 servicesCache —— 窗口开着时
     * 侧栏本来也在拉同一份，实际很少真的多起一次进程。
     */
    serviceMonitor = new ServiceMonitor({
      collect: () => serviceStatuses(),
      hasWatch: () => (serviceWatchStore?.all.length ?? 0) > 0,
      onAlerts: (alerts) => {
        const message = describeServiceAlerts(alerts)
        if (message) notifier?.notify('service', message.title, message.body)
      },
      isRepeatEnabled: () => settingsStore?.settings.notifySustained ?? true
    })
    serviceMonitor.start()

    registerIpc()
    mainWindow = createMainWindow()
    tray = new TrayController({
      onTogglePanel: () => togglePanel(),
      onQuit: () => {
        isQuitting = true
        app.quit()
      }
    })
    smoke('tray', tray.iconInfo())

    updater.scheduleStartupCheck()
    updater.startPeriodicCheck()

    // 冒烟驱动（只有对账脚本开启）：主进程侧驱动界面走一圈并落盘
    if (SMOKE_DRIVE && mainWindow) void runSmoke(mainWindow)

    nativeTheme.on('updated', () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.setBackgroundColor(currentBg())
      }
    })
  })

  // 托盘常驻：窗口全关也不退出；退出由托盘菜单与 app:quit 决定。
  // 托盘没建起来时不能留孤儿进程，直接退出。
  app.on('window-all-closed', () => {
    if (!tray) app.quit()
  })

  app.on('before-quit', () => {
    isQuitting = true
    rememberBounds()
  })

  app.on('will-quit', () => {
    updater?.dispose()
    scheduler?.dispose()
    metricsMonitor?.dispose()
    trendStore?.dispose()
    portsMonitor?.dispose()
    serviceMonitor?.stop()
    scanner?.cancel()
    tray?.destroy()
  })
}
