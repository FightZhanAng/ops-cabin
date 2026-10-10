import { app } from 'electron'
import { join } from 'node:path'

/**
 * 应用资源路径。
 * 开发时在项目根 resources/；打包后由 electron-builder 的 extraResources
 * 复制到「安装目录/resources/resources/」（M8 对齐该配置）。
 */
export function resourcePath(name: string): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'resources', name)
    : join(app.getAppPath(), 'resources', name)
}

export function appIconPath(): string {
  return resourcePath('icon.png')
}

export function trayIconPath(): string {
  return resourcePath('tray.png')
}

export function preloadPath(): string {
  return join(__dirname, '../preload/index.js')
}
