import type { PortChange, PortsSnapshot, WatchItem } from '../../shared/ports'
import { collectPorts } from './collect'

/** 有界面订阅时的采样间隔 */
const ACTIVE_INTERVAL = 2000
/** 只在后台盯关注端口时的采样间隔 */
const IDLE_INTERVAL = 5000
/**
 * 「最近快照」能当基线依据的最长年龄。
 *
 * 比一个采样周期长一点，容忍采集本身的耗时；再旧就不能信了 ——
 * 见 setWatchlist 里那段关于「陈旧快照会把一直占着读成刚被占用」的说明。
 */
const BASELINE_MAX_AGE = 10_000

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
  /**
   * 新关注、但手上没有可靠快照可依据的端口：下一拍只记基线，不报变化。
   *
   * 存在的理由是「快照不含某端口」这句话有两种相反的读法：它当时确实没在监听
   * （那么后来被占用就是真变化，该报），还是快照太旧、采集时它还没起来
   * （那么它其实一直占着，报出来就是假警报）。这两种读法无法从数据上区分，
   * 所以在没有**新鲜**快照时只能延迟一拍 —— 少报一次边缘情况，好过报一次假的。
   */
  #pendingBaseline = new Set<number>()
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
    for (const port of [...this.#pendingBaseline]) {
      if (!ports.has(port)) this.#pendingBaseline.delete(port)
    }
    /*
     * 新关注项尽量用「最近一次快照」立即建立基线 —— 不能一律等下一个采样：
     * 否则「关注后几秒内发生的状态变化」会被基线建立吞掉。
     *
     * 但只有当快照足够新时才敢这么做。用户从端口页点关注时快照必然是新的
     * （页面显示的就是它，一两秒内采的）；而「应用刚起来就关注」或自检里
     * 批量关注时，快照可能已经放了很久 —— 拿它当依据会把「其实一直占着」
     * 记成「没在监听」，紧接着的第一次采样就会报出一条假警报（真踩过：
     * 自检里三条新关注的端口齐刷刷报「被占用」）。
     */
    const fresh = this.#latest !== null && Date.now() - this.#latest.at <= BASELINE_MAX_AGE
    if (fresh && this.#latest) {
      for (const item of items) {
        if (this.#lastSeen.has(item.port)) continue
        const entry = this.#latest.entries.find((e) => e.port === item.port)
        this.#lastSeen.set(item.port, entry ? describeOccupant(entry) : null)
      }
    } else {
      for (const item of items) {
        if (!this.#lastSeen.has(item.port)) this.#pendingBaseline.add(item.port)
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
      // 刚关注、还没建立可靠基线：这一拍只补基线，不报变化（见 #pendingBaseline 的说明）
      if (this.#pendingBaseline.has(item.port)) {
        this.#pendingBaseline.delete(item.port)
        this.#lastSeen.set(item.port, now)
        continue
      }
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
