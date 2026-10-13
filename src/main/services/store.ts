import { app } from 'electron'
import { existsSync, readFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import type { ServiceWatchItem } from '../../shared/services'
import { writeFileAtomic } from '../atomic'

const MAX_ITEMS = 60

/** 服务名上限：Windows 服务名最长 256，截到 128 足够且能挡住畸形输入 */
const MAX_NAME = 128

/** 关注服务的持久化（userData/service-watch.json，原子写；损坏时留档回退空表） */
export class ServiceWatchStore {
  readonly dataFile: string
  #items: ServiceWatchItem[]

  constructor() {
    this.dataFile = join(app.getPath('userData'), 'service-watch.json')
    this.#items = this.#load()
  }

  get all(): ServiceWatchItem[] {
    return [...this.#items]
  }

  has(name: string): boolean {
    return this.#items.some((item) => item.name.toLowerCase() === name.toLowerCase())
  }

  add(name: string, label: string, note?: string): ServiceWatchItem[] {
    const clean = name.trim().slice(0, MAX_NAME)
    if (clean.length === 0 || this.has(clean) || this.#items.length >= MAX_ITEMS) return this.all
    this.#items.push({
      name: clean,
      label: label.trim().slice(0, 40) || clean,
      ...(note ? { note: note.slice(0, 200) } : {}),
      addedAt: Date.now()
    })
    this.#write()
    return this.all
  }

  remove(name: string): ServiceWatchItem[] {
    this.#items = this.#items.filter((item) => item.name.toLowerCase() !== name.toLowerCase())
    this.#write()
    return this.all
  }

  update(name: string, patch: { label?: string; note?: string }): ServiceWatchItem[] {
    const item = this.#items.find((i) => i.name.toLowerCase() === name.toLowerCase())
    if (item) {
      if (typeof patch.label === 'string' && patch.label.trim().length > 0) {
        item.label = patch.label.trim().slice(0, 40)
      }
      if (typeof patch.note === 'string') {
        item.note = patch.note.slice(0, 200)
      }
      this.#write()
    }
    return this.all
  }

  #load(): ServiceWatchItem[] {
    if (!existsSync(this.dataFile)) return []
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.dataFile, 'utf8'))
      if (!Array.isArray(parsed)) return []
      return parsed.filter(isValidItem).slice(0, MAX_ITEMS)
    } catch {
      try {
        renameSync(this.dataFile, `${this.dataFile}.bad`)
      } catch {
        /* 留档失败不阻塞启动 */
      }
      return []
    }
  }

  #write(): void {
    try {
      writeFileAtomic(this.dataFile, `${JSON.stringify(this.#items, null, 2)}\n`)
    } catch {
      /* 落盘失败不阻塞 —— 内存里的清单仍然有效 */
    }
  }
}

function isValidItem(raw: unknown): raw is ServiceWatchItem {
  if (raw === null || typeof raw !== 'object') return false
  const rec = raw as Record<string, unknown>
  return (
    typeof rec.name === 'string' &&
    rec.name.trim().length > 0 &&
    typeof rec.label === 'string' &&
    typeof rec.addedAt === 'number'
  )
}
