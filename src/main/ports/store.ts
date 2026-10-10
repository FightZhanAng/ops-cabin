import { app } from 'electron'
import { existsSync, readFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import type { WatchItem } from '../../shared/ports'
import { writeFileAtomic } from '../atomic'

const MAX_ITEMS = 100

/** 关注清单的持久化（userData/watchlist.json，原子写；损坏时留档回退空表） */
export class WatchlistStore {
  readonly dataFile: string
  #items: WatchItem[]

  constructor() {
    this.dataFile = join(app.getPath('userData'), 'watchlist.json')
    this.#items = this.#load()
  }

  get all(): WatchItem[] {
    return [...this.#items]
  }

  has(port: number): boolean {
    return this.#items.some((item) => item.port === port)
  }

  add(port: number, label: string, note?: string): WatchItem[] {
    if (this.has(port) || this.#items.length >= MAX_ITEMS) return this.all
    this.#items.push({
      port,
      label: label.slice(0, 40) || `端口 ${port}`,
      ...(note ? { note: note.slice(0, 200) } : {}),
      addedAt: Date.now()
    })
    this.#write()
    return this.all
  }

  remove(port: number): WatchItem[] {
    this.#items = this.#items.filter((item) => item.port !== port)
    this.#write()
    return this.all
  }

  update(port: number, patch: { label?: string; note?: string }): WatchItem[] {
    const item = this.#items.find((i) => i.port === port)
    if (item) {
      if (typeof patch.label === 'string' && patch.label.length > 0) {
        item.label = patch.label.slice(0, 40)
      }
      if (typeof patch.note === 'string') {
        item.note = patch.note.slice(0, 200)
      }
      this.#write()
    }
    return this.all
  }

  #load(): WatchItem[] {
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

function isValidItem(raw: unknown): raw is WatchItem {
  if (raw === null || typeof raw !== 'object') return false
  const rec = raw as Record<string, unknown>
  return (
    Number.isInteger(rec.port) &&
    (rec.port as number) > 0 &&
    (rec.port as number) <= 65535 &&
    typeof rec.label === 'string' &&
    typeof rec.addedAt === 'number'
  )
}
