import { app } from 'electron'
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync
} from 'node:fs'
import { dirname, join } from 'node:path'
import { sanitizeSettings } from '../shared/settings'
import type { Settings } from '../shared/types'

/**
 * 设置的持久化（userData/settings.json）。
 *
 * 每次 patch 都同步原子写：写临时文件 → fsync → rename 覆盖。
 * 断电或崩溃时要么是完整的旧文件、要么是完整的新文件，不会出现半截 JSON。
 * 设置体量小（几 KB）且写入频率低，同步写换来的确定性比异步更值。
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
    const file = this.dataFile
    const tmp = `${file}.tmp`
    try {
      mkdirSync(dirname(file), { recursive: true })
      const fd = openSync(tmp, 'w')
      try {
        writeFileSync(fd, `${JSON.stringify(this.#settings, null, 2)}\n`, 'utf8')
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }
      renameSync(tmp, file)
    } catch {
      /* 写失败不该让应用崩掉 —— 内存里的设置仍然有效，等下一次 patch 再落盘 */
    }
  }
}
