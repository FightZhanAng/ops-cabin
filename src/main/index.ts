import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  type IpcMainInvokeEvent,
  Menu,
  nativeTheme,
  screen,
  shell
} from 'electron'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
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
import type { ServiceCandidate, ServiceStatusReport } from '../shared/services'
import type { StartupReport } from '../shared/startup'
import type { TaskReport } from '../shared/tasks'
import type { TrendPoint } from '../shared/trend'
import { DEFAULT_SETTINGS } from '../shared/settings'
import type { AppInfo, Settings, WindowBounds, WindowState } from '../shared/types'
import { applyAutoOp } from './autoapply'
import { createCachedCollector } from './cached'
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

/*
 * 四份采集（启动项 / 关注服务 / 计划任务 / 系统体检）全部由 createCachedCollector
 * 生成（见 cached.ts）。TTL、并发合流、失败降级这三件事只有一套实现 —— 每份
 * 采集在这里只声明「多久算旧」和「结果依赖什么输入」。原先四份各自手写的版本
 * 已经分叉过一次（服务那条把 degraded 丢了），工厂化就是为了让分叉不再可能。
 */

/**
 * 启动项采集的缓存时长。
 *
 * 侧栏徽标、启动项页都会要这份数据，而它每次都要起一次 PowerShell（冷启动 1–2 秒）。
 * 不开缓存的话，切一次页面就重跑一次。30 秒的 TTL 足够：自启项只在装/卸软件时才变。
 */
const STARTUP_TTL = 30_000

/**
 * 允许用「最近一次端口快照」去结束进程的最长快照年龄。
 *
 * 端口页每 2 秒推一拍，正常操作时快照必然是这个量级；给到 30 秒是留出采集偶发
 * 变慢的余量。再旧的快照不能作为杀进程的依据：采集连续失败时 `latest` 不会更新，
 * 期间目标 PID 可能退出并被新进程复用 —— 拿旧快照去 kill 就是误杀。
 */
const KILL_SNAPSHOT_MAX_AGE = 30_000

/** 关注服务状态的缓存时长：状态会变（服务可能停），TTL 比启动项短得多 */
const SERVICES_TTL = 15_000

/**
 * 计划任务的缓存时长。
 *
 * 这份数据是本批最贵的一次采集（本机 1.5 秒，全是 COM 枚举的固定开销），
 * 但内容变得很慢：「下次运行时间」要等任务跑过一轮才变。60 秒的 TTL 足够，
 * 而用户点「重新读取」时走 force 绕开。
 */
const TASKS_TTL = 60_000

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
const startupReport = createCachedCollector<StartupReport>({
  ttl: STARTUP_TTL,
  collect: () => collectStartup(),
  fallback: (error) => emptyStartup(error)
})

/**
 * 关注服务的当前状态（清单标签合进来）。
 *
 * `key` 是关注清单的指纹：加/删关注项、或改标签备注，都会让上一份缓存失效。
 * 这一点必须自动 —— 早前是在三个 handler 里手写 `servicesCache = null`，
 * 漏一处就会出现「刚加的关注项 15 秒内不显示」，而那种缺陷只在特定操作顺序下复现。
 *
 * 无关注项时 `collectServices([])` 会立刻返回空（不起 PowerShell），
 * 所以这里不需要额外的短路分支。
 */
const serviceStatuses = createCachedCollector<ServiceStatusReport>({
  ttl: SERVICES_TTL,
  key: () => JSON.stringify((serviceWatchStore?.all ?? []).map((item) => [item.name, item.label, item.note ?? ''])),
  collect: async () => {
    const watch = serviceWatchStore?.all ?? []
    const { items, degraded, error } = await collectServices(watch.map((item) => item.name))
    const byName = new Map(watch.map((item) => [item.name.toLowerCase(), item]))
    const merged = items.map((item) => {
      const saved = byName.get(item.name.toLowerCase())
      return {
        ...item,
        label: saved?.label ?? item.label,
        ...(saved?.note ? { note: saved.note } : {})
      }
    })
    // 带上采集器给出的原因：界面上「读不到」后面那句「为什么」靠它
    return { at: Date.now(), items: merged, degraded, ...(error !== undefined ? { error } : {}) }
  },
  // 采集失败：如实说「读不到」，而不是回一个空数组 —— 空数组在界面上与
  // 「没有关注项」同形，会被显示成「全部在跑」（见 shared/services.ts 的说明）
  fallback: (error) => ({ at: Date.now(), items: [], degraded: true, error })
})

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
const taskReport = createCachedCollector<TaskReport>({
  ttl: TASKS_TTL,
  collect: () => collectTasks(),
  fallback: (error) => emptyTasks(error)
})

/**
 * 系统体检的缓存时长。
 *
 * 这份数据是四段 PowerShell **并发**跑出来的（本机 3.8 秒；串行要 11.1 秒），
 * 代价不小但内容变得很慢：磁盘健康、设备错误码、开机时刻都是按小时乃至按天变的。
 * 60 秒的 TTL 足够，用户点「重新体检」时走 force 绕开。
 */
const HEALTH_TTL = 60_000

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
const healthReport = createCachedCollector<HealthReport>({
  ttl: HEALTH_TTL,
  collect: () => collectHealth(),
  fallback: (error) => emptyHealth(error)
})

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

/**
 * 本应用自己的入口文档 URL（导航白名单与 IPC 来源校验共用）。
 *
 * 生产下是 `file://.../out/renderer/index.html`；开发下由 electron-vite 提供
 * dev server 地址。只放行**这一个文档**，而不是整个 `file:` 协议 ——
 * 放行整个协议等于把用户磁盘上任意 .html 都变成了合法的应用页面。
 */
function entryDocumentUrl(): string | null {
  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl !== undefined && !app.isPackaged) {
    try {
      return new URL(devUrl).toString()
    } catch {
      return null
    }
  }
  try {
    return pathToFileURL(join(__dirname, '../renderer/index.html')).toString()
  } catch {
    return null
  }
}

/** 去掉 hash / query 后的 URL，用于和入口文档比对 */
function withoutFragment(raw: string): string | null {
  try {
    const url = new URL(raw)
    url.hash = ''
    url.search = ''
    return url.toString()
  } catch {
    return null
  }
}

function hardenWindow(win: BrowserWindow): void {
  // 页面里的 target=_blank / window.open 一律转给系统浏览器
  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url)
    return { action: 'deny' }
  })
  /*
   * 导航白名单：只允许停留在本应用自己的那个文档上。
   *
   * 早前判据是 `url.startsWith('file://')` —— 放行的是**整个 file: 协议**，
   * 用户下载目录里的任意 .html 都算「合法页面」；而 Electron 对 webContents 的
   * 每次导航都会重新执行 preload，且 contextBridge 注入不受页面自身 CSP 约束，
   * 于是那个页面同样拿到完整的 window.opsCabin（含永久删除、结束进程、UAC 提权、
   * 安装更新）。dev 分支的裸前缀匹配同理（`http://localhost:5173@evil.com/` 能命中）。
   *
   * 现在按「入口文档精确比对」放行，dev 下额外允许同源（HMR 需要）。
   */
  win.webContents.on('will-navigate', (event, url) => {
    const target = withoutFragment(url)
    const entry = entryDocumentUrl()
    if (target !== null && entry !== null && target === entry) return

    const devUrl = process.env['ELECTRON_RENDERER_URL']
    if (devUrl !== undefined && !app.isPackaged) {
      try {
        if (target !== null && new URL(target).origin === new URL(devUrl).origin) return
      } catch {
        /* dev 地址解析失败：按不放行处理 */
      }
    }

    event.preventDefault()
    openExternal(url)
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
      /*
       * 沙箱暂不开（原审查条目 #7）—— 这里记录实测结论，别再顺手打开。
       *
       * preload 本身满足沙箱化前提（产物只有一处 `require("electron")`，全仓没有
       * node: 内建依赖），所以打开它不会白屏。但打开之后**渲染层的 window.close()
       * 会变成销毁窗口**：实测事件序列是
       *     [probe] webContents destroyed
       *     [probe] win closed event
       * 也就是说可取消的 `close` 事件根本不发，主进程没有机会 preventDefault。
       * 实测对照（同一份代码、只切这一个布尔值）：sandbox:false 时 `close` 正常触发
       * 并能把它改成「隐藏」；sandbox:true 时窗口被销毁、只剩托盘。
       *
       * 本应用的窗口契约是「关窗 = 隐藏、托盘常驻」，而这条路径无法拦截。真实交互
       * （标题栏按钮走 win:close IPC）不受影响 —— 已实测该路径在两种设置下都正确；
       * 受影响的是渲染层里任何 window.close() 调用（当前源码里没有，但项目自带的
       * e2e-check.mjs 正是用它模拟「点关闭按钮」，打开沙箱后那条套件会挂住）。
       *
       * 要启用的话请作为一次独立决定：确认渲染层不再有 window.close()、把 e2e-check
       * 改成驱动真实路径（closeWindow），并接受「窗口被销毁后由托盘唤回」这一形态。
       */
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

  /*
   * 关闭 = 隐藏：这是个托盘常驻应用，关窗不该退出。
   *
   * 例外是**托盘不可用**时。隐藏窗口会让应用变成看不见也点不开的孤儿进程（没有
   * 托盘、没有窗口，只剩后台在跑），所以那时放行这次关闭 —— 窗口真的关掉，
   * `window-all-closed` 随之触发并退出。这条路径正是那句兜底注释所描述的场景，
   * 之前因为无条件 preventDefault 而永远走不到（`tray` 非空不代表托盘可见：图标
   * 载入失败时 Electron 不抛异常，只表现为托盘区空白，见 trayUsable 的说明）。
   *
   * 先 preventDefault 再记账：记账要写设置文件，而写盘是会失败的（只读、被占用、
   * 磁盘满）。把记账排在前面的话，一次写盘异常就会让 preventDefault 轮不到执行，
   * 于是「关窗 = 隐藏」变成「窗口凭空消失」。记账本身也包上 try，理由相同。
   */
  win.on('close', (event) => {
    if (isQuitting) return
    const hide = trayUsable()
    if (hide) event.preventDefault()
    try {
      rememberBounds()
    } catch {
      /* 记不住窗口位置不该影响关窗语义 */
    }
    if (hide) win.hide()
  })

  win.on('closed', () => {
    mainWindow = null
  })

  // 渲染进程消失（崩溃、强杀、导航失败）：订阅计数清零，
  // 否则端口采集会以 2 秒节奏永远跑下去（见 resetSubscribers 的说明）
  win.webContents.on('render-process-gone', () => {
    resetSubscribers()
  })
  win.webContents.on('destroyed', () => {
    resetSubscribers()
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

/**
 * 把「按订阅才采集」的计数清零 —— 渲染进程消失时调用。
 *
 * 订阅计数原本完全依赖渲染层成对调用 subscribe / unsubscribe：页面异常卸载
 * （渲染进程崩溃后重载、React 抛错导致 effect 清理没跑、热更新）会让计数永远
 * 停在 1，于是端口采集以 2 秒节奏常驻 —— 用户既没开着端口页，也丢了「关了就不跑」
 * 的省电语义。这里在渲染进程消失时清零，让调度重新按「有无订阅、有无关注项」决定。
 */
function resetSubscribers(): void {
  portsMonitor?.resetSubscribers()
  metricsMonitor?.resetSubscribers()
}

/**
 * 托盘是否真的能用来唤回窗口。
 *
 * `tray` 非空**不代表**托盘可用：图标加载失败时 Electron 不抛异常，只是托盘区
 * 什么都看不见（`TrayController.isUsable()` 就是为这件事存在的）。所以判据要看
 * 「图标不是空图」，而不是只看对象建没建起来。
 */
function trayUsable(): boolean {
  return tray !== null && tray.isUsable()
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

/**
 * 发起这次 IPC 的是不是本应用自己的页面。
 *
 * 为什么需要：Electron 对 webContents 的**每次导航都会重新执行 preload**，
 * 而 contextBridge 注入不受页面自身 CSP 约束 —— 只要窗口被导航到别的文档，
 * 那个文档就拿到了完整的 window.opsCabin（含永久删除、结束进程、UAC 提权、
 * 下载并安装更新）。页面自身没有注入点也不该把这一层省掉：它是纵深防御，
 * 且后来者重构界面时很难不踩。
 *
 * 判定口径与 will-navigate 的白名单一致：比对入口文档（去 hash/query）。
 * 拿不到 senderFrame 时**放行**（宁可漏挡也不误伤：这里没有已证实的攻击链，
 * 而误判会让整个界面失灵）。
 */
function isTrustedSender(event: IpcMainInvokeEvent): boolean {
  let senderUrl: string
  try {
    senderUrl = event.senderFrame?.url ?? ''
  } catch {
    // senderFrame 在帧已销毁时会抛 —— 无从判定，按放行处理
    return true
  }
  if (senderUrl.length === 0) return true

  const entry = entryDocumentUrl()
  if (entry === null) return true

  const target = withoutFragment(senderUrl)
  if (target !== null && target === entry) return true

  // 开发模式：HMR 与 vite 客户端在同源下取页面，放行同源
  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl !== undefined && !app.isPackaged) {
    try {
      if (target !== null && new URL(target).origin === new URL(devUrl).origin) return true
    } catch {
      /* 解析失败：落到下面的拒绝 */
    }
  }
  return false
}

/**
 * 所有 IPC 的统一注册入口 —— 与裸 `ipcMain.handle` 的唯一区别是来源校验。
 *
 * 用统一入口而不是逐个 handler 手写校验：漏一个就等于没做，而后来者新加通道时
 * 也会自然地走这里。
 */
function handle<Args extends unknown[], R>(
  channel: string,
  listener: (event: IpcMainInvokeEvent, ...args: Args) => R
): void {
  ipcMain.handle(channel, (event, ...args: unknown[]) => {
    if (!isTrustedSender(event)) {
      throw new Error(`已拒绝来自非应用页面的 IPC 调用（${channel}）`)
    }
    return listener(event, ...(args as Args))
  })
}

function registerIpc(): void {
  handle(
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
  handle('app:open-external', (_event, url: unknown) => openExternal(url))
  handle('app:quit', () => {
    isQuitting = true
    app.quit()
  })
  handle('app:show-in-folder', (_event, path: unknown) => {
    if (typeof path === 'string' && path.length > 0 && path.length <= 1024) {
      shell.showItemInFolder(path)
    }
  })
  handle('app:pick-directory', async (): Promise<string[]> => {
    if (!mainWindow || mainWindow.isDestroyed()) return []
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择要扫描大文件的目录（可多选，最多 8 个）',
      properties: ['openDirectory', 'multiSelections']
    })
    if (result.canceled) return []
    return result.filePaths.slice(0, 8)
  })

  /* 窗口控制（自绘标题栏的三个按钮 + 状态查询） */
  handle('win:minimize', () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.minimize()
  })
  handle('win:toggle-maximize', (): boolean => {
    const win = mainWindow
    if (!win || win.isDestroyed()) return false
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
    return win.isMaximized()
  })
  // 与原来点系统关闭按钮同一条路径：close 事件里 preventDefault + hide（托盘常驻）
  handle('win:close', () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close()
  })
  handle('win:state', (): WindowState => ({
    maximized: mainWindow?.isMaximized() ?? false
  }))

  handle('settings:get', () => settingsStore?.settings ?? null)
  handle('settings:update', (_event, patch: unknown) => {
    // 与上一行的 settings:get 同一口径：store 没就绪就什么都不做。
    // 早前这里用 `as SettingsStore` 把空值保护绕了过去 —— 类型断言能让编译过，
    // 却让「启动尚未完成时收到 update」变成一次空指针崩溃。
    if (!settingsStore) return null
    if (!patch || typeof patch !== 'object') return settingsStore.settings
    const applied = settingsStore.patch(patch as Partial<Settings>)
    applyTheme(applied.theme)
    scheduler?.setPlan(applied.scanPlan)
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('settings', applied)
    }
    return applied
  })
  handle('settings:reset', () => {
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
  handle('scan:start', (_event, raw: unknown) => runScanAndRegister(parseScanOptions(raw)))
  handle('scan:cancel', () => scanner?.cancel())

  handle('clean:run', (_event, rawItems: unknown, rawMode: unknown): Promise<CleanOutcome> => {
    if (!cleaner) return Promise.resolve({ ok: false, error: '清理器未就绪' })
    const mode: CleanMode = rawMode === 'permanent' ? 'permanent' : 'recycle'
    return cleaner.run(
      parseCleanItems(rawItems),
      mode,
      settingsStore?.settings.whitelist ?? []
    )
  })

  /** 清理历史（总览的统计图） */
  handle('clean:history', (): CleanHistoryEntry[] => cleaner?.history() ?? [])

  /* 分区 */
  handle('volumes:list', () => listVolumes())

  /* 端口雷达 */
  // 语义是「现在有什么在监听」：每次现采一次（监控器会把并发采样合流）
  handle('ports:list', async (): Promise<PortsSnapshot | null> => {
    if (!portsMonitor) return null
    try {
      return await portsMonitor.sampleNow()
    } catch {
      return null
    }
  })
  handle('ports:subscribe', () => {
    portsMonitor?.addSubscriber()
  })
  handle('ports:unsubscribe', () => {
    portsMonitor?.removeSubscriber()
  })

  handle('ports:watch:list', () => watchlistStore?.all ?? [])
  handle('ports:watch:add', (_event, raw: unknown) => {
    const input = parseWatchInput(raw)
    if (!input || !watchlistStore) return watchlistStore?.all ?? []
    const items = watchlistStore.add(input.port, input.label, input.note)
    portsMonitor?.setWatchlist(items)
    return items
  })
  handle('ports:watch:remove', (_event, rawPort: unknown) => {
    const port = parsePort(rawPort)
    if (port === null || !watchlistStore) return watchlistStore?.all ?? []
    const items = watchlistStore.remove(port)
    portsMonitor?.setWatchlist(items)
    return items
  })
  handle('ports:watch:update', (_event, rawPort: unknown, rawPatch: unknown) => {
    const port = parsePort(rawPort)
    if (port === null || !watchlistStore) return watchlistStore?.all ?? []
    const items = watchlistStore.update(port, parseWatchPatch(rawPatch))
    portsMonitor?.setWatchlist(items)
    return items
  })

  handle('ports:events', () => portEvents?.recent(200) ?? [])

  /*
   * 结束进程：安全边界 —— 只允许结束「最近一次端口快照里正在监听」的进程。
   *
   * 两条校验缺一不可：
   *   · 目标必须出现在快照里（防止渲染层伪造任意 PID）；
   *   · 快照必须是**新鲜的**。`portsMonitor.latest` 在采集连续失败时不会更新，
   *     于是它可以是几分钟甚至几小时前的 —— 期间那个 PID 早可能退出并被新进程
   *     复用（Windows 的 PID 复用相当积极），照着旧快照去 kill 就是误杀无关进程。
   *     过期一律拒绝，让用户刷新后重试。
   */
  handle('ports:kill', async (_event, rawPid: unknown): Promise<KillResult> => {
    const pid = Number(rawPid)
    if (!Number.isInteger(pid) || pid <= 4) {
      return { ok: false, forced: false, error: '无效的进程号' }
    }
    const snapshot = portsMonitor?.latest ?? null
    if (snapshot === null) {
      return { ok: false, forced: false, error: '还没有端口快照，请先刷新端口页' }
    }
    if (Date.now() - snapshot.at > KILL_SNAPSHOT_MAX_AGE) {
      return {
        ok: false,
        forced: false,
        error: '端口快照已过期，请刷新后再试（避免误杀复用同一进程号的进程）'
      }
    }
    const allowed = snapshot.entries.some((entry) => entry.pid === pid)
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
  handle('metrics:sample', (): MetricsSample | null => metricsMonitor?.sampleNow() ?? null)
  handle('metrics:subscribe', () => {
    metricsMonitor?.addSubscriber()
  })
  handle('metrics:unsubscribe', () => {
    metricsMonitor?.removeSubscriber()
  })

  /* 长期趋势（总览的趋势图） */
  handle('trend:list', (): TrendPoint[] => trendStore?.list() ?? [])

  /* 进程榜（总览；与端口页共用一份进程表采集） */
  handle('processes:top', (_event, rawLimit: unknown): Promise<ProcEntry[]> => {
    const limit = Number(rawLimit)
    return processTable.top(Number.isInteger(limit) && limit > 0 ? Math.min(limit, 50) : 12)
  })

  /* 联网体检（按需触发，5 秒左右出结果） */
  handle('netcheck:run', (): Promise<NetCheckReport> => runNetCheck())

  /* hosts 文件体检（只读：读文件 + 判定，从不写回） */
  handle('hosts:read', (): HostsReport => readHosts())

  /* 开机自启清单（只读；带 TTL 缓存，侧栏与页面共用一份） */
  handle(
    'startup:list',
    (_event, rawForce: unknown): Promise<StartupReport> => startupReport(rawForce === true)
  )

  /* 计划任务清单（只读；带 TTL 缓存 + 并发合流） */
  handle(
    'tasks:list',
    (_event, rawForce: unknown): Promise<TaskReport> => taskReport(rawForce === true)
  )

  /* 可写操作（启动项/计划任务的禁用启用与删除登记；唯一写实现方见 autoapply.ts） */
  handle(
    'auto:apply',
    (_event, raw: unknown): Promise<AutoResult> =>
      applyAutoOp(raw, { startupReport, taskReport, elevate: elevateAutoOp })
  )

  /* 系统体检（只读；四段 PowerShell 并发采集，带 TTL 缓存 + 并发合流） */
  handle(
    'health:read',
    (_event, rawForce: unknown): Promise<HealthReport> => healthReport(rawForce === true)
  )

  /* 服务关注清单；带 TTL 缓存 + 并发合流，读数里带 degraded（失败不伪装成「没有」） */
  handle('services:status', (): Promise<ServiceStatusReport> => serviceStatuses())
  handle(
    'services:candidates',
    (): Promise<ServiceCandidate[]> => listServiceCandidates()
  )
  handle('services:watch:list', () => serviceWatchStore?.all ?? [])
  /*
   * 关注清单的三个写操作都不需要手动清缓存：serviceStatuses 的缓存以清单指纹为
   * 身份（见 createCachedCollector 的 key），清单一变，上一份读数自动作废。
   */
  handle('services:watch:add', (_event, rawName: unknown, rawLabel: unknown, rawNote: unknown) => {
    const name = parseServiceName(rawName)
    if (name === null || !serviceWatchStore) return serviceWatchStore?.all ?? []
    const label = typeof rawLabel === 'string' ? rawLabel : ''
    const note = typeof rawNote === 'string' ? rawNote : undefined
    const items = serviceWatchStore.add(name, label, note)
    // 立即建立基线：新关注的服务当下是什么状态就是什么状态，绝不把「刚关注」当变化
    void serviceMonitor?.syncNow()
    return items
  })
  handle('services:watch:remove', (_event, rawName: unknown) => {
    const name = parseServiceName(rawName)
    if (name === null || !serviceWatchStore) return serviceWatchStore?.all ?? []
    const items = serviceWatchStore.remove(name)
    void serviceMonitor?.syncNow()
    return items
  })
  handle('services:watch:update', (_event, rawName: unknown, rawPatch: unknown) => {
    const name = parseServiceName(rawName)
    if (name === null || !serviceWatchStore) return serviceWatchStore?.all ?? []
    const items = serviceWatchStore.update(name, parseLabelPatch(rawPatch))
    return items
  })

  /* 设置与维护 */
  handle('app:open-data-dir', () => {
    const file = settingsStore?.dataFile
    if (file) shell.showItemInFolder(file)
    return file ?? ''
  })
  handle('ports:events:clear', () => {
    portEvents?.clear()
  })
  handle('scheduler:check-now', () => scheduler?.checkNow() ?? Promise.resolve(false))

  /* 版本更新 */
  handle('update:get', () => updater?.describe() ?? null)
  handle('update:check', () => {
    updater?.check()
    return updater?.describe() ?? null
  })
  handle('update:download', () => {
    updater?.download()
    return updater?.describe() ?? null
  })
  handle('update:install', () => updater?.install())
  handle('update:open-page', () => updater?.openReleasePage())
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
     * 空转，有关注项时 60 秒一拍、复用主进程那份带 TTL 的读数 —— 窗口开着时
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
  }).catch((error: unknown) => {
    /*
     * 启动链兜底。
     *
     * 整条 whenReady 链（SettingsStore → Notifier → Scanner/Cleaner → Scheduler →
     * Updater → 各 Monitor → createMainWindow → registerIpc）里任何一步抛出，
     * 原先都会变成一个无人处理的 Promise rejection：应用既不弹窗、也不退出、
     * 也没有托盘 —— 用户看到的是「双击了图标，什么都没发生」，而日志里一无所有。
     *
     * 启动期出错无法继续（后面每一步都依赖前面），如实记录后退出，并在有窗口时
     * 弹一条错误框说明原因，避免进程以「半启动」状态留在后台。
     */
    const message = error instanceof Error ? error.message : String(error)
    console.error('[ops-cabin] 启动失败：', error)
    try {
      dialog.showErrorBox('运维舱启动失败', `${message}\n\n应用即将退出，请检查日志或重新安装。`)
    } catch {
      /* 连错误框都弹不出来（更早的失败）时只能静默退出 */
    }
    app.exit(1)
  })

  // 全局兜底：未处理的 rejection 记一笔。
  // 主进程里有多处 `void x()` 的发射后不管调用（监控循环、通知、重采），
  // 漏 catch 时原先只能靠 Electron 的默认行为，日志里留不下线索。
  // 刻意**不**接管 uncaughtException：那会把真正的崩溃改成「带着坏状态继续跑」，
  // 对这个托盘常驻应用反而更危险。
  process.on('unhandledRejection', (reason) => {
    console.error('[ops-cabin] 未处理的 Promise rejection：', reason)
  })

  /*
   * 托盘常驻：窗口全关也不退出；退出由托盘菜单与 app:quit 决定。
   *
   * 但**托盘不可用时必须退出**，不能留孤儿进程：那样用户既没有托盘可点，也没有
   * 窗口可开，进程却还在后台跑。原判据是 `if (!tray)` —— 它不可达：图标加载失败时
   * Electron 不抛异常、`tray` 字段照样非空，而窗口关闭只是被隐藏（见 createMainWindow
   * 的 close 处理），`window-all-closed` 永远不触发。现在判据换成「托盘真的可用」，
   * 并在窗口关闭时放行这次关闭（同样见 close 处理），这条兜底才真正接得上。
   */
  app.on('window-all-closed', () => {
    if (!trayUsable()) app.quit()
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
