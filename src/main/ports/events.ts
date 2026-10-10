import { app } from 'electron'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { PortChange } from '../../shared/ports'
import { writeFileAtomic } from '../atomic'

const LIMIT = 1000

/** 关注端口变化历史的落盘（userData/port-events.json，限量滚动） */
export class PortEventsStore {
  #file: string

  constructor() {
    this.#file = join(app.getPath('userData'), 'port-events.json')
  }

  append(changes: PortChange[]): void {
    try {
      const list = this.#read()
      list.push(...changes)
      const trimmed = list.length > LIMIT ? list.slice(-LIMIT) : list
      writeFileAtomic(this.#file, `${JSON.stringify(trimmed, null, 2)}\n`)
    } catch {
      /* 落盘失败不影响推送与通知 */
    }
  }

  /** 最近的变化（新的在前） */
  recent(limit = 200): PortChange[] {
    return this.#read().slice(-limit).reverse()
  }

  /** 清空全部变化记录 */
  clear(): void {
    try {
      writeFileAtomic(this.#file, '[]\n')
    } catch {
      /* 忽略 */
    }
  }

  #read(): PortChange[] {
    try {
      if (!existsSync(this.#file)) return []
      const parsed: unknown = JSON.parse(readFileSync(this.#file, 'utf8'))
      return Array.isArray(parsed) ? (parsed as PortChange[]) : []
    } catch {
      return []
    }
  }
}
