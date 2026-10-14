import { Menu, Tray, nativeImage, type NativeImage } from 'electron'
import { trayIconPath } from './paths'

export interface TrayCallbacks {
  onTogglePanel: () => void
  onQuit: () => void
}

/**
 * 托盘常驻控制器 —— 托盘是应用的「主场」，窗口只是它拉开的窗帘。
 *
 * 左键单击切换面板；右键弹菜单。刻意不用 setContextMenu：
 * Windows 下它会把左键点击也吞进菜单，单击呼出就不再灵敏。
 */
export class TrayController {
  #tray: Tray
  #image: NativeImage

  constructor(callbacks: TrayCallbacks) {
    this.#image = nativeImage.createFromPath(trayIconPath())
    this.#tray = new Tray(this.#image)
    this.#tray.setToolTip('运维舱')

    const menu = Menu.buildFromTemplate([
      { label: '显示 / 隐藏面板', click: callbacks.onTogglePanel },
      { type: 'separator' },
      { label: '退出运维舱', click: callbacks.onQuit }
    ])
    this.#tray.on('click', callbacks.onTogglePanel)
    this.#tray.on('right-click', () => this.#tray.popUpContextMenu(menu))
  }

  /** 供冒烟自检核对图标不是空图 —— 载入失败不抛异常，只表现为托盘里什么都看不见 */
  iconInfo(): { empty: boolean; size: { width: number; height: number } } {
    return { empty: this.#image.isEmpty(), size: this.#image.getSize() }
  }

  /**
   * 托盘是不是真的可用（图标不是空图）。
   *
   * 图标加载失败时 Electron **不抛异常**，只是托盘区什么都看不见 —— 于是
   * `tray` 这个字段非空、`new TrayController()` 也算成功，但用户既看不到托盘、
   * 也没法通过它唤回窗口。把这个「看得见」的判据暴露出来，窗口关闭逻辑才能
   * 区分「托盘常驻」与「关掉就再也找不回来」。
   */
  isUsable(): boolean {
    return !this.#image.isEmpty()
  }

  destroy(): void {
    this.#tray.destroy()
  }
}
