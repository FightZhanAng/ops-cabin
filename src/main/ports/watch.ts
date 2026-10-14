import type { PortChange, PortsSnapshot, WatchItem } from '../../shared/ports'
import { describePortOccupants } from '../../shared/ports'
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
  /** 正在飞的那一次采集：首采期间也要互斥，否则会并发跑两遍 netstat */
  #inflight: Promise<PortsSnapshot> | null = null
  /** 已销毁标志：dispose 之后不再重排定时器（否则在飞的一拍会把定时器复活） */
  #disposed = false

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
      // 基线用与变化检测**同一个**描述函数：两处各写一遍正是 UDP 那半被漏掉的根因
      const latest = this.#latest
      for (const item of items) {
        if (this.#lastSeen.has(item.port)) continue
        this.#lastSeen.set(item.port, describePortOccupants(latest.entries, item.port))
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

  /**
   * 把订阅计数清零 —— 渲染进程消失（崩溃 / 重载 / 窗口销毁）时由主进程调用。
   *
   * 计数原本只靠渲染层成对调用维护，页面异常卸载就会永远停在 1，
   * 采集以 2 秒节奏常驻下去。清零让「没人看就不跑」这条语义真正成立。
   */
  resetSubscribers(): void {
    this.#subscribers = 0
    this.#schedule()
  }

  /** 立即采集一次（渲染层首次打开端口页时调用） */
  async sampleNow(): Promise<PortsSnapshot> {
    return this.#sample()
  }

  dispose(): void {
    this.#disposed = true
    if (this.#timer) {
      clearTimeout(this.#timer)
      this.#timer = null
    }
  }

  #schedule(): void {
    if (this.#disposed) return
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

  /**
   * 采一次并广播。
   *
   * 互斥判据是 `#inflight` 而不是「`#latest` 是否存在」—— 后者在**首采期间**
   * （`#latest` 仍是 null）不成立，于是同一时刻的第二次调用会放行，两遍完整
   * netstat + 进程表采集并发跑。首采恰恰是最容易并发的时刻：
   * `ports:subscribe` 与 `ports:list`（页面挂载时的两条路径）会几乎同时进来。
   */
  async #sample(): Promise<PortsSnapshot> {
    if (this.#inflight) return this.#inflight
    const running = (async (): Promise<PortsSnapshot> => {
      const snapshot = await collectPorts(this.#watchlist.map((item) => item.port))
      this.#latest = snapshot
      this.#callbacks.onSnapshot(snapshot)
      this.#detectChanges(snapshot)
      return snapshot
    })()
    this.#inflight = running
    try {
      return await running
    } finally {
      if (this.#inflight === running) this.#inflight = null
    }
  }

  #detectChanges(snapshot: PortsSnapshot): void {
    const changes: PortChange[] = []
    for (const item of this.#watchlist) {
      /*
       * 按端口号取**全部**协议的占用者（TCP 445 与 UDP 445 是两条独立条目）。
       * 早前用 `find` 只取第一条，同号的另一半永远不进变化检测。
       */
      const now = describePortOccupants(snapshot.entries, item.port)
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
