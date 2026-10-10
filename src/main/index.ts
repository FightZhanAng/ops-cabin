import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, screen, shell } from 'electron'
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CleanMode, CleanOutcome, CleanRequestItem, ScanOutcome } from '../shared/disk'
import type { AppInfo, Settings, WindowBounds } from '../shared/types'
import { Cleaner } from './cleaner'
import { appIconPath, preloadPath } from './paths'
import { Scanner, parseScanOptions } from './scanner'
import { SettingsStore } from './settings'
import { TrayController } from './tray'
import { listVolumes } from './volumes'

const APP_ID = app.isPackaged ? 'com.tomcato.ops-cabin' : 'com.tomcato.ops-cabin.dev'

/**
 * 两套主题下的窗口底色 —— 必须和 index.css 的 --bg 保持一致，否则首帧会闪一下。
 */
const WINDOW_BG = { light: '#f1f5f9', dark: '#0f172a' }

const DEFAULT_BOUNDS = { width: 1180, height: 800 }
const MIN_WINDOW = { width: 960, height: 660 }

let mainWindow: BrowserWindow | null = null
let tray: TrayController | null = null
let settingsStore: SettingsStore | null = null
let scanner: Scanner | null = null
let cleaner: Cleaner | null = null
let isQuitting = false

/* ------------------------------------------------------------ 冒烟自检 */

// 结论写磁盘而不是 console.log —— Windows 上 GUI 进程不挂控制台，
// 只靠 stdout 经常什么都看不到，"跑没跑起来"都判断不了。
const SMOKE = process.env['OPS_CABIN_SMOKE'] === '1'

function smokeDir(): string {
  return join(tmpdir(), 'ops-cabin-smoke')
}

function smoke(name: string, payload: unknown): void {
  if (!SMOKE) return
  try {
    mkdirSync(smokeDir(), { recursive: true })
    writeFileSync(join(smokeDir(), `${name}.json`), JSON.stringify(payload, null, 2), 'utf8')
  } catch {
    /* 自检失败不该影响主流程 */
  }
}

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
    webPreferences: {
      preload: preloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  hardenWindow(win)

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

/* ------------------------------------------------------------ IPC */

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

function registerIpc(): void {
  ipcMain.handle(
    'app:info',
    (): AppInfo => ({
      name: '运维舱',
      version: app.getVersion(),
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node
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
  ipcMain.handle('app:pick-directory', async () => {
    if (!mainWindow || mainWindow.isDestroyed()) return null
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择要扫描大文件的目录',
      properties: ['openDirectory']
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  ipcMain.handle('settings:get', () => settingsStore?.settings ?? null)
  ipcMain.handle('settings:update', (_event, patch: unknown) => {
    if (!patch || typeof patch !== 'object') return settingsStore?.settings ?? null
    const applied = (settingsStore as SettingsStore).patch(patch as Partial<Settings>)
    applyTheme(applied.theme)
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('settings', applied)
    }
    return applied
  })

  /* 磁盘扫描与清理 */
  ipcMain.handle('scan:start', async (_event, raw: unknown): Promise<ScanOutcome> => {
    if (!scanner) {
      return { ok: false, cancelled: false, error: '扫描器未就绪' }
    }
    const outcome = await scanner.start(
      parseScanOptions(raw),
      settingsStore?.settings.whitelist ?? []
    )
    // 扫描结果同时登记给清理器：clean:run 只允许删除这份结果里的路径
    if (outcome.ok) {
      cleaner?.registerScanned(outcome.result.groups.flatMap((g) => g.items.map((i) => i.path)))
    }
    return outcome
  })
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

  /* 分区 */
  ipcMain.handle('volumes:list', () => listVolumes())
}

/* ------------------------------------------------------------ 启动 */

// 单实例：第二次启动把已有窗口唤到前面，而不是开两个运维舱
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
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

    scanner = new Scanner({
      onProgress: (progress) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('scan:progress', progress)
        }
      }
    })
    cleaner = new Cleaner()

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
    scanner?.cancel()
    tray?.destroy()
  })
}
