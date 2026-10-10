import { app, shell } from 'electron'
import electronUpdater from 'electron-updater'
import type { UpdateState } from '../shared/update'

const { autoUpdater } = electronUpdater

/** 自动检查的间隔（每天一次） */
const AUTO_CHECK_INTERVAL = 24 * 60 * 60 * 1000
/** 启动后第一次自动检查的延迟（让首屏先立起来） */
const STARTUP_DELAY = 30 * 1000

export interface UpdateControllerDeps {
  getAutoCheck: () => boolean
  onChange: (state: UpdateState) => void
  releasePage: string
}

/** 免安装版（portable）没有稳定安装目录，electron-builder 用该环境变量标记运行时 */
function isPortable(): boolean {
  return Boolean(process.env['PORTABLE_EXECUTABLE_DIR'])
}

/**
 * 更新控制器：检查 / 下载 / 安装三段式，下载与安装从不自动发生。
 * `OPS_CABIN_FAKE_UPDATE=x.y.z` 注入假版本，可在不联网的情况下驱动整个界面流程（自检用）。
 */
export class UpdateController {
  #deps: UpdateControllerDeps
  #state: UpdateState
  #fakeVersion: string | null
  #timer: ReturnType<typeof setInterval> | null = null
  #startupTimer: ReturnType<typeof setTimeout> | null = null

  constructor(deps: UpdateControllerDeps) {
    this.#deps = deps
    this.#fakeVersion = process.env['OPS_CABIN_FAKE_UPDATE'] ?? null
    this.#state = this.#base()

    autoUpdater.autoDownload = false
    autoUpdater.autoInstallOnAppQuit = false
    this.#wire()
  }

  describe(): UpdateState {
    return { ...this.#state }
  }

  check(): void {
    if (this.#state.status === 'unsupported') {
      this.#push()
      return
    }
    if (this.#state.status === 'checking' || this.#state.status === 'downloading') return

    if (this.#fakeVersion) {
      this.#set({ status: 'checking', message: '正在检查更新（模拟）…' })
      setTimeout(() => {
        this.#set({
          status: 'available',
          latest: this.#fakeVersion as string,
          message: `发现新版本 ${this.#fakeVersion}（模拟）`,
          canDownload: true
        })
      }, 300)
      return
    }

    this.#set({ status: 'checking', message: '正在检查更新…' })
    void autoUpdater.checkForUpdates().catch((error: Error) => {
      this.#set({ status: 'error', message: `检查更新失败：${error.message.slice(0, 200)}` })
    })
  }

  download(): void {
    if (this.#state.status !== 'available') return

    if (this.#fakeVersion) {
      this.#set({ status: 'downloading', percent: 0, message: '正在下载（模拟）…' })
      let percent = 0
      const tick = setInterval(() => {
        percent = Math.min(100, percent + 25)
        this.#set({ status: 'downloading', percent, message: `正在下载（模拟）… ${percent}%` })
        if (percent >= 100) {
          clearInterval(tick)
          this.#set({
            status: 'downloaded',
            percent: 100,
            message: '下载完成，重启后安装（模拟）',
            canDownload: false
          })
        }
      }, 200)
      return
    }

    this.#set({ status: 'downloading', percent: 0, message: '正在下载…' })
    void autoUpdater.downloadUpdate().catch((error: Error) => {
      this.#set({ status: 'error', message: `下载失败：${error.message.slice(0, 200)}` })
    })
  }

  install(): void {
    if (this.#state.status !== 'downloaded') return
    if (this.#fakeVersion) return // 模拟模式不真装
    autoUpdater.quitAndInstall()
  }

  openReleasePage(): void {
    void shell.openExternal(this.#deps.releasePage)
  }

  scheduleStartupCheck(): void {
    if (this.#startupTimer) return
    this.#startupTimer = setTimeout(() => {
      this.#startupTimer = null
      if (this.#deps.getAutoCheck()) this.check()
    }, STARTUP_DELAY)
  }

  startPeriodicCheck(): void {
    if (this.#timer) return
    this.#timer = setInterval(() => {
      if (this.#deps.getAutoCheck()) this.check()
    }, AUTO_CHECK_INTERVAL)
  }

  dispose(): void {
    if (this.#timer) {
      clearInterval(this.#timer)
      this.#timer = null
    }
    if (this.#startupTimer) {
      clearTimeout(this.#startupTimer)
      this.#startupTimer = null
    }
  }

  #base(): UpdateState {
    const current = app.getVersion()
    if (this.#fakeVersion) {
      // 冒烟注入假版本：无视打包形态（开发模式也能跑完整更新流程）
      return {
        status: 'idle',
        current,
        latest: '',
        percent: 0,
        message: '模拟更新模式（自检）',
        checkedAt: 0,
        canDownload: false
      }
    }
    if (!app.isPackaged) {
      return {
        status: 'unsupported',
        current,
        latest: '',
        percent: 0,
        message: '开发模式：自动更新在打包后才生效',
        checkedAt: 0,
        canDownload: false
      }
    }
    if (isPortable()) {
      return {
        status: 'unsupported',
        current,
        latest: '',
        percent: 0,
        message: '免安装版没有固定安装目录，请到发布页下载新版',
        checkedAt: 0,
        canDownload: false
      }
    }
    return {
      status: 'idle',
      current,
      latest: '',
      percent: 0,
      message: '',
      checkedAt: 0,
      canDownload: false
    }
  }

  #set(patch: Partial<UpdateState>): void {
    this.#state = { ...this.#state, ...patch }
    this.#push()
  }

  #push(): void {
    this.#deps.onChange(this.describe())
  }

  #wire(): void {
    autoUpdater.on('update-available', (info) => {
      this.#set({
        status: 'available',
        latest: info.version,
        message: `发现新版本 ${info.version}`,
        canDownload: true,
        checkedAt: Date.now()
      })
    })
    autoUpdater.on('update-not-available', () => {
      this.#set({
        status: 'idle',
        message: '已是最新版本',
        canDownload: false,
        checkedAt: Date.now()
      })
    })
    autoUpdater.on('download-progress', (progress) => {
      const percent = Math.round(progress.percent)
      this.#set({ status: 'downloading', percent, message: `正在下载… ${percent}%` })
    })
    autoUpdater.on('update-downloaded', (info) => {
      this.#set({
        status: 'downloaded',
        latest: info.version,
        percent: 100,
        message: '下载完成，重启后安装',
        canDownload: false
      })
    })
    autoUpdater.on('error', (error) => {
      this.#set({
        status: 'error',
        message: `更新出错：${error.message.slice(0, 200)}`,
        canDownload: false
      })
    })
  }
}
