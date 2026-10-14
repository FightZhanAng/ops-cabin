import { cpus, freemem, totalmem } from 'node:os'
import type { MetricsSample } from '../shared/metrics'
import type { TrendPoint } from '../shared/trend'
import { NetMonitor } from './net'

/** 有订阅时的推送间隔：1s —— KPI 读数要跟手 */
const SAMPLE_INTERVAL = 1000

/** 空闲心跳：即使没人订阅也每 2s 读一次 CPU 计数 —— 纯内存读取，
 *  目的是让「差分窗口」任意时刻都不超过 2s，避免首次打开总览时
 *  拿到一段跨越几分钟的失真平均值 */
const IDLE_HEARTBEAT = 2000

interface CpuCounters {
  idle: number
  total: number
}

function readCpuCounters(): CpuCounters {
  let idle = 0
  let total = 0
  for (const cpu of cpus()) {
    const times = cpu.times
    idle += times.idle
    total += times.user + times.nice + times.sys + times.idle + times.irq
  }
  return { idle, total }
}

export interface MetricsMonitorCallbacks {
  onSample: (sample: MetricsSample) => void
}

/**
 * 资源采样调度：有订阅时 1s 一推，无订阅时只跑空闲心跳。
 *
 * 网卡吞吐由 NetMonitor 自己按 2s 采（外部进程比读 os 计数器贵一个数量级），
 * 结果挂在每一条 MetricsSample 上 —— 渲染层只订阅一条流，不必关心两侧节奏不同。
 */
export class MetricsMonitor {
  #callbacks: MetricsMonitorCallbacks
  #timer: ReturnType<typeof setTimeout> | null = null
  #heartbeat: ReturnType<typeof setInterval> | null = null
  #subscribers = 0
  #lastCpu = readCpuCounters()
  #net = new NetMonitor()

  constructor(callbacks: MetricsMonitorCallbacks) {
    this.#callbacks = callbacks
    this.#heartbeat = setInterval(() => {
      this.#lastCpu = readCpuCounters()
    }, IDLE_HEARTBEAT)
  }

  addSubscriber(): void {
    this.#subscribers++
    this.#net.start()
    this.#schedule()
  }

  removeSubscriber(): void {
    this.#subscribers = Math.max(0, this.#subscribers - 1)
    if (this.#subscribers === 0) {
      this.#stop()
      this.#net.stop()
    }
  }

  /**
   * 订阅计数清零并停采样 —— 渲染进程消失时由主进程调用。
   *
   * 与 removeSubscriber 的区别是「不管当前几」：页面异常卸载会让计数卡在 1，
   * 递减永远到不了 0，采样就常驻下去了。
   */
  resetSubscribers(): void {
    this.#subscribers = 0
    this.#stop()
    this.#net.stop()
  }

  /** 立即采样一次（渲染层首次打开总览时用） */
  sampleNow(): MetricsSample {
    return this.#sample()
  }

  /**
   * 取一个趋势点：先把网卡计数刷成当前值，再连同 CPU/内存一起读出。
   *
   * 刷新不能省 —— 没人看总览时 NetMonitor 的定时器是停的，不刷就等于拿
   * 几小时前的旧速率去画趋势。差值窗口 = 距上次读取的间隔，正是这一段的平均速率。
   */
  async sampleTrend(): Promise<Omit<TrendPoint, 'at'>> {
    await this.#net.sampleNow()
    const sample = this.#sample()
    return {
      cpuPercent: sample.cpuPercent,
      memUsed: sample.memUsed,
      memTotal: sample.memTotal,
      rxBps: sample.netRxBps,
      txBps: sample.netTxBps
    }
  }

  dispose(): void {
    this.#stop()
    if (this.#heartbeat) {
      clearInterval(this.#heartbeat)
      this.#heartbeat = null
    }
    this.#net.dispose()
  }

  #schedule(): void {
    if (this.#timer || this.#subscribers === 0) return
    this.#timer = setTimeout(() => {
      this.#timer = null
      this.#callbacks.onSample(this.#sample())
      this.#schedule()
    }, SAMPLE_INTERVAL)
  }

  #stop(): void {
    if (this.#timer) {
      clearTimeout(this.#timer)
      this.#timer = null
    }
  }

  #sample(): MetricsSample {
    const now = readCpuCounters()
    const idleDelta = now.idle - this.#lastCpu.idle
    const totalDelta = now.total - this.#lastCpu.total
    this.#lastCpu = now
    const raw = totalDelta > 0 ? (1 - idleDelta / totalDelta) * 100 : 0
    const net = this.#net.rate()
    return {
      at: Date.now(),
      cpuPercent: Math.round(Math.min(100, Math.max(0, raw)) * 10) / 10,
      memUsed: totalmem() - freemem(),
      memTotal: totalmem(),
      netRxBps: net?.rxBps ?? null,
      netTxBps: net?.txBps ?? null
    }
  }
}
