import type { PortChange, PortsSnapshot, WatchItem } from '../../shared/ports'
import { collectPorts } from './collect'

/** 有界面订阅时的采样间隔 */
const ACTIVE_INTERVAL = 2000
/** 只在后台盯关注端口时的采样间隔 */
const IDLE_INTERVAL = 5000

export interface PortsMonitorCallbacks {
  onSnapshot: (snapshot: PortsSnapshot) => void
  onChanges: (changes: PortChange[]) => void
}

/** 占用者描述：进程名 + PID —— 变化检测与界面展示共用它 */
export function describeOccupant(entry: { processName: string | null; pid: number }): string {
  return `${entry.processName ?? '未知进程'} (PID ${entry.pid})`
}

/**
 * 端口监控调度。
 *
 * 懒轮询：没有订阅、也没有关注项时完全不跑；有订阅 2s 一拍，
 * 只有关注项在后台盯梢时 5s 一拍。第一次观察某个关注端口只建立
 * 基线，不把「刚关注」当成变化。
 */
export class PortsMonitor {
  #callbacks: PortsMonitorCallbacks
  #timer: ReturnType<typeof setTimeout> | null = null
  #subscribers = 0
  #watchlist: WatchItem[] = []
  /** 每个关注端口最近一次观察到的占用者（值的"存在与否"就是基线标志） */
  #lastSeen = new Map<number, string | null>()
  #latest: PortsSnapshot | null = null
  #busy = false

  constructor(callbacks: PortsMonitorCallbacks) {
    this.#callbacks = callbacks
  }

  get latest(): PortsSnapshot | null {
    return this.#latest
  }

  setWatchlist(items: WatchItem[]): void {
    this.#watchlist = items
    const ports = new Set(items.map((item) => item.port))
    for (const port of [...this.#lastSeen.keys()]) {
      if (!ports.has(port)) this.#lastSeen.delete(port)
    }
    // 新关注项用「最近一次快照」立即建立基线 —— 不能等下一个采样：
    // 否则「关注后几秒内发生的状态变化」会被基线建立吞掉，而采样周期里
    // 的忙合流还会把基线窗口推得不可预测。
    if (this.#latest) {
      for (const item of items) {
        if (!this.#lastSeen.has(item.port)) {
          const entry = this.#latest.entries.find((e) => e.port === item.port)
          this.#lastSeen.set(item.port, entry ? describeOccupant(entry) : null)
        }
      }
    }
    this.#schedule()
  }

  addSubscriber(): void {
    this.#subscribers++
    this.#schedule()
  }

  removeSubscriber(): void {
    this.#subscribers = Math.max(0, this.#subscribers - 1)
    this.#schedule()
  }

  /** 立即采集一次（渲染层首次打开端口页时调用） */
  async sampleNow(): Promise<PortsSnapshot> {
    return this.#sample()
  }

  dispose(): void {
    if (this.#timer) {
      clearTimeout(this.#timer)
      this.#timer = null
    }
  }

  #schedule(): void {
    if (this.#timer) {
      clearTimeout(this.#timer)
      this.#timer = null
    }
    if (this.#subscribers === 0 && this.#watchlist.length === 0) return
    const interval = this.#subscribers > 0 ? ACTIVE_INTERVAL : IDLE_INTERVAL
    this.#timer = setTimeout(() => void this.#tick(), interval)
  }

  async #tick(): Promise<void> {
    try {
      await this.#sample()
    } catch {
      /* 采集失败：忽略，下一轮再试 */
    }
    this.#schedule()
  }

  async #sample(): Promise<PortsSnapshot> {
    if (this.#busy && this.#latest) return this.#latest
    this.#busy = true
    try {
      const snapshot = await collectPorts(this.#watchlist.map((item) => item.port))
      this.#latest = snapshot
      this.#callbacks.onSnapshot(snapshot)
      this.#detectChanges(snapshot)
      return snapshot
    } finally {
      this.#busy = false
    }
  }

  #detectChanges(snapshot: PortsSnapshot): void {
    const changes: PortChange[] = []
    for (const item of this.#watchlist) {
      const entry = snapshot.entries.find((e) => e.port === item.port)
      const now = entry ? describeOccupant(entry) : null
      const hasBaseline = this.#lastSeen.has(item.port)
      const before = this.#lastSeen.get(item.port) ?? null
      if (hasBaseline && before !== now) {
        const type: PortChange['type'] = !before && now ? 'occupy' : before && !now ? 'release' : 'change'
        changes.push({ at: snapshot.at, type, port: item.port, process: now, previous: before })
      }
      this.#lastSeen.set(item.port, now)
    }
    if (changes.length > 0) this.#callbacks.onChanges(changes)
  }
}
