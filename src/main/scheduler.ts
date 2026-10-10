import { app } from 'electron'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ScanPlan } from '../shared/types'
import { writeFileAtomic } from './atomic'

/** 检查间隔（自检可注入更快的节奏） */
const TICK_MS = Number(process.env['OPS_CABIN_SCHEDULER_TICK_MS']) || 60_000

interface SchedulerState {
  lastRunDay: string | null
  lastRunWeek: string | null
}

export interface ScheduledScanSummary {
  at: number
  items: number
  bytes: number
}

export interface ScanSchedulerCallbacks {
  /** 触发一次「安全清理 + 开发缓存」扫描；返回 null 表示没跑成（例如扫描器忙） */
  runScan: () => Promise<{ items: number; bytes: number } | null>
  onDone: (summary: ScheduledScanSummary) => void
  onError: (message: string) => void
}

function dayKey(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** 以「本周一」标识一周 */
function weekKey(date: Date): string {
  const monday = new Date(date)
  const day = monday.getDay() // 0 = 周日
  const offset = day === 0 ? 6 : day - 1
  monday.setDate(monday.getDate() - offset)
  return dayKey(monday)
}

/**
 * 扫描计划调度器。
 *
 * 每分钟检查一次：过了计划点且当天（周）还没跑过 → 触发一次「安全清理 + 开发缓存」
 * 扫描，完成后由上层发系统通知。**不做自动删除** —— 删除永远要人确认。
 * 启动时补扫：今天已过点但没跑过 → 立即跑一次。weekly 的语义是「每周一」。
 */
export class ScanScheduler {
  #callbacks: ScanSchedulerCallbacks
  #plan: ScanPlan
  #stateFile: string
  #state: SchedulerState
  #timer: ReturnType<typeof setInterval> | null = null
  #running = false

  constructor(callbacks: ScanSchedulerCallbacks, plan: ScanPlan) {
    this.#callbacks = callbacks
    this.#plan = plan
    this.#stateFile = join(app.getPath('userData'), 'scheduler-state.json')
    this.#state = this.#load()
  }

  start(): void {
    if (this.#timer) return
    this.#timer = setInterval(() => void this.checkNow(), TICK_MS)
    // 启动补扫（今天过了点但没跑过）
    void this.checkNow()
  }

  setPlan(plan: ScanPlan): void {
    this.#plan = plan
  }

  dispose(): void {
    if (this.#timer) {
      clearInterval(this.#timer)
      this.#timer = null
    }
  }

  /** 立即执行一次「到点检查」；返回本次是否触发了扫描（设置页与自检都用它） */
  async checkNow(now = new Date()): Promise<boolean> {
    if (this.#plan.mode === 'manual') return false
    if (this.#running) return false
    if (!this.#due(now)) return false

    // 标记先行：扫描期间不重入，失败也不当天重试（由通知与冒烟探针暴露）
    if (this.#plan.mode === 'daily') this.#state.lastRunDay = dayKey(now)
    else this.#state.lastRunWeek = weekKey(now)
    this.#save()

    this.#running = true
    try {
      const result = await this.#callbacks.runScan()
      if (result) {
        this.#callbacks.onDone({ at: Date.now(), items: result.items, bytes: result.bytes })
      }
    } catch (error) {
      this.#callbacks.onError(error instanceof Error ? error.message : String(error))
    } finally {
      this.#running = false
    }
    return true
  }

  /** 到点判定：本地时间已过 HH:mm，且当天（周）还没跑过；weekly 只在周一 */
  #due(now: Date): boolean {
    const [hh, mm] = this.#plan.time.split(':').map((value) => Number(value))
    if (!Number.isInteger(hh) || !Number.isInteger(mm)) return false
    const minutesNow = now.getHours() * 60 + now.getMinutes()
    if (minutesNow < hh * 60 + mm) return false

    if (this.#plan.mode === 'daily') {
      return this.#state.lastRunDay !== dayKey(now)
    }
    if (now.getDay() !== 1) return false
    return this.#state.lastRunWeek !== weekKey(now)
  }

  #load(): SchedulerState {
    try {
      if (!existsSync(this.#stateFile)) return { lastRunDay: null, lastRunWeek: null }
      const parsed: unknown = JSON.parse(readFileSync(this.#stateFile, 'utf8'))
      if (parsed !== null && typeof parsed === 'object') {
        const rec = parsed as Record<string, unknown>
        return {
          lastRunDay: typeof rec.lastRunDay === 'string' ? rec.lastRunDay : null,
          lastRunWeek: typeof rec.lastRunWeek === 'string' ? rec.lastRunWeek : null
        }
      }
    } catch {
      /* 状态损坏就当没跑过 */
    }
    return { lastRunDay: null, lastRunWeek: null }
  }

  #save(): void {
    try {
      writeFileAtomic(this.#stateFile, `${JSON.stringify(this.#state, null, 2)}\n`)
    } catch {
      /* 落盘失败不阻塞 */
    }
  }
}
