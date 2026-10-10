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

  destroy(): void {
    this.#tray.destroy()
  }
}
