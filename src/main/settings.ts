import { app } from 'electron'
import { existsSync, readFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { sanitizeSettings } from '../shared/settings'
import type { Settings } from '../shared/types'
import { writeFileAtomic } from './atomic'

/**
 * 设置的持久化（userData/settings.json）。
 * 每次 patch 都同步原子写（见 writeFileAtomic）——设置体量小、写入频率低，
 * 同步写换来的确定性比异步更值。
 */
export class SettingsStore {
  readonly dataFile: string
  #settings: Settings

  constructor() {
    this.dataFile = join(app.getPath('userData'), 'settings.json')
    this.#settings = this.#load()
  }

  get settings(): Settings {
    return this.#settings
  }

  patch(patch: Partial<Settings>): Settings {
    this.#settings = sanitizeSettings({ ...this.#settings, ...patch })
    this.#write()
    return this.#settings
  }

  #load(): Settings {
    if (!existsSync(this.dataFile)) return sanitizeSettings(null)
    try {
      return sanitizeSettings(JSON.parse(readFileSync(this.dataFile, 'utf8')))
    } catch {
      // 文件损坏（手工编辑 / 断电写坏）：留一份现场副本，回退默认值继续启动
      try {
        renameSync(this.dataFile, `${this.dataFile}.bad`)
      } catch {
        /* 留档失败不阻塞启动 */
      }
      return sanitizeSettings(null)
    }
  }

  #write(): void {
    try {
      writeFileAtomic(this.dataFile, `${JSON.stringify(this.#settings, null, 2)}\n`)
    } catch {
      /* 写失败不该让应用崩掉 —— 内存里的设置仍然有效，等下一次 patch 再落盘 */
    }
  }
}
