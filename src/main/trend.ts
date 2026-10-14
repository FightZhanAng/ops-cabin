import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { writeFileAtomic } from './atomic'
import type { TrendPoint } from '../shared/trend'

/*
 * 长期趋势存储：每 5 分钟一个点，保留 7 天。
 *
 * 5 分钟 × 7 天 = 2016 个点，文件约 200 KB —— 够画「这一周内存是不是在涨」，
 * 又不至于像 1 分钟粒度那样把文件撑到 1.4 MB 并频繁写盘（开发机的 SSD 寿命
 * 也是运维要照顾的东西）。
 */

/** 采样间隔（自检可注入更快的节奏） */
const SAMPLE_MS = Number(process.env['OPS_CABIN_TREND_SAMPLE_MS']) || 5 * 60_000
/** 保留窗口 */
const RETENTION_MS = 7 * 24 * 3600_000
/** 文件上限：再多也不留（防止注入更短间隔的自检把文件写爆） */
const MAX_POINTS = 3000

export interface TrendSource {
  /** 取一个采样点；读不到返回 null（这一拍就跳过，不落空点） */
  sample: () => Promise<Omit<TrendPoint, 'at'>> | Omit<TrendPoint, 'at'> | null
}

function isTrendPoint(value: unknown): value is TrendPoint {
  if (value === null || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  const num = (input: unknown): boolean => typeof input === 'number' && Number.isFinite(input)
  return (
    num(record.at) &&
    num(record.cpuPercent) &&
    num(record.memUsed) &&
    num(record.memTotal) &&
    (record.rxBps === null || num(record.rxBps)) &&
    (record.txBps === null || num(record.txBps))
  )
}

/** 读趋势文件（损坏条目直接丢弃：图宁少勿错；一律返回时间升序） */
function readTrend(file: string): TrendPoint[] {
  try {
    if (!existsSync(file)) return []
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
    if (!Array.isArray(parsed)) return []
    return parsed.filter(isTrendPoint).sort((a, b) => a.at - b.at)
  } catch {
    return []
  }
}

export class TrendStore {
  #file: string
  #source: TrendSource | null = null
  #points: TrendPoint[]
  #timer: ReturnType<typeof setInterval> | null = null

  constructor() {
    this.#file = join(app.getPath('userData'), 'trend.json')
    this.#points = readTrend(this.#file)
  }

  /** 全部采样点（时间升序）—— 渲染层按窗口自行裁剪 */
  list(): TrendPoint[] {
    return this.#points
  }

  /** 开始按间隔采样 */
  start(source: TrendSource): void {
    this.#source = source
    if (this.#timer) return
    this.#timer = setInterval(() => void this.tick(), SAMPLE_MS)
    void this.tick()
  }

  dispose(): void {
    if (this.#timer) {
      clearInterval(this.#timer)
      this.#timer = null
    }
  }

  /** 落一个点；返回是否落成（自检也用它手动推点） */
  async tick(): Promise<boolean> {
    if (!this.#source) return false
    try {
      const partial = await this.#source.sample()
      if (!partial) return false
      this.#append({ at: Date.now(), ...partial })
      return true
    } catch {
      /* 采样失败不写盘：趋势缺一拍比落一个假点好 */
      return false
    }
  }

  #append(point: TrendPoint): void {
    /*
     * 不能把「#points 已按时间升序」当成不变量：系统时间回拨（NTP 校时、手动改
     * 时钟、跨时区）会让新点的 at 小于表里最后一个点。原先只按 `point.at` 算留存
     * 窗口、filter 完直接 push，于是那一点会插在错误的位置：图上的折线会往回拐，
     * 而按 at 取「最近 N 个点」的消费方也会拿到错序数据。
     *
     * 这里显式按 at 归一：过滤 → 追加 → 排序 → 保留末尾 MAX_POINTS 个。
     * 点数上限 2000 出头，排序成本可忽略。
     */
    const cutoff = point.at - RETENTION_MS
    const next = this.#points.filter((item) => item.at >= cutoff)
    next.push(point)
    next.sort((a, b) => a.at - b.at)
    this.#points = next.length > MAX_POINTS ? next.slice(next.length - MAX_POINTS) : next
    try {
      mkdirSync(dirname(this.#file), { recursive: true })
      writeFileAtomic(this.#file, JSON.stringify(this.#points))
    } catch {
      /* 落盘失败不影响界面：内存里这一拍还在 */
    }
  }
}
