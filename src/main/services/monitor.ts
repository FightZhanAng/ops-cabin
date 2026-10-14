import { SUSTAINED_REPEAT_MINUTES } from '../../shared/notify'
import { serviceDown, type ServiceStatus, type ServiceStatusReport } from '../../shared/services'

/*
 * 关注服务的后台盯梢。
 *
 * 为什么主进程要自己跑一个循环：应用常驻托盘（关窗只是隐藏），窗口不在时
 * 渲染层的 useSidebarStatus 也停了 —— 而「服务挂了要早知道」恰好是关注服务
 * 的全部价值。只靠界面拉取的话，真正需要它的时刻（你没在看窗口）它不在。
 *
 * 成本控制两件事：
 *   - 无关注项时完全不跑（采集成空数组，不起 PowerShell）；
 *   - 采集复用主进程那份带 TTL 的 servicesCache，侧栏刚拉过时这一拍零成本。
 */

/** 首拍延迟：让启动时的首屏先立起来（无关注项时这一拍本来就是空转） */
const FIRST_TICK_MS = 20_000
/** 常规盯梢间隔（与侧栏的刷新间隔一致） */
const TICK_MS = 60_000
/** 持续异常重复提醒的间隔（分钟数在 shared 里，设置页的文案引用同一份） */
const REPEAT_MS = SUSTAINED_REPEAT_MINUTES * 60_000

/** 一次盯梢判定出来的一条提醒（纯数据，发不发、怎么发由调用方决定） */
export interface ServiceAlert {
  kind: 'down' | 'up' | 'repeat'
  name: string
  label: string
  /** 不在跑的具体形态（down/repeat 才有） */
  reason?: string
}

/** 盯梢跨拍保持的状态（抽出来是为了让判定成为纯函数，可脱机验证） */
export interface WatchState {
  /** 小写服务名 → 最近一次观察到的「不在跑」；**值的"存在与否"就是基线标志** */
  seen: Map<string, boolean>
  /** 已发过「挂了」的服务名 → 最近一次提醒时刻（决定重复提醒的节流） */
  alerted: Map<string, number>
}

export function createWatchState(): WatchState {
  return { seen: new Map(), alerted: new Map() }
}

function downReason(item: ServiceStatus): string {
  return item.missing ? '本机已没有这个服务' : '已停止'
}

/**
 * 与上一拍对比，判定这一拍该发哪些提醒（**纯函数**：状态进、提醒出）。
 *
 * 三条规则都是刻意的：
 *   - **第一次观察只建基线**，绝不发通知。「刚把某个服务加入关注」不是变化 ——
 *     与端口盯梢同构，否则每加一个当下停着的服务都会立刻收到一条假警报。
 *   - **「已恢复」只在发过「挂了」之后才说。** 启动时就是停着的服务（基线即停）
 *     后来自行起来了，那不是「恢复」而是「刚起来」：用户没收到过它有事的消息，
 *     现在告诉他「恢复了」只会让人翻上去找那条并不存在的警报。
 *   - **重复提醒只对已经通知过、且仍未恢复的服务生效。** 一直停着但用户从没见过
 *     通知的服务，不该因为「持续」就突然开始提醒。
 */
export function diffServices(
  state: WatchState,
  items: readonly ServiceStatus[],
  now: number,
  opts: { repeat: boolean }
): ServiceAlert[] {
  const alerts: ServiceAlert[] = []
  const live = new Set<string>()

  for (const item of items) {
    const key = item.name.toLowerCase()
    live.add(key)
    const down = serviceDown(item)
    const hasBaseline = state.seen.has(key)
    const wasDown = state.seen.get(key) ?? false
    state.seen.set(key, down)
    if (!hasBaseline) continue

    if (down && !wasDown) {
      alerts.push({ kind: 'down', name: item.name, label: item.label, reason: downReason(item) })
      state.alerted.set(key, now)
      continue
    }
    if (!down && wasDown) {
      // 没发过「挂了」就起来了：静默收回基线，不打扰
      if (state.alerted.has(key)) {
        alerts.push({ kind: 'up', name: item.name, label: item.label })
        state.alerted.delete(key)
      }
      continue
    }
    if (down && wasDown && opts.repeat && state.alerted.has(key)) {
      const last = state.alerted.get(key) ?? 0
      if (now - last >= REPEAT_MS) {
        alerts.push({ kind: 'repeat', name: item.name, label: item.label, reason: downReason(item) })
        state.alerted.set(key, now)
      }
    }
  }

  // 关注清单里被删掉的服务：清干净，别让旧基线在下一次重新关注时冒充历史
  for (const key of [...state.seen.keys()]) {
    if (!live.has(key)) {
      state.seen.delete(key)
      state.alerted.delete(key)
    }
  }

  return alerts
}

/** 把这一拍的提醒聚合成一条通知（多条时只列前几项，避免通知篇幅失控） */
export function describeServiceAlerts(
  alerts: readonly ServiceAlert[]
): { title: string; body: string } | null {
  if (alerts.length === 0) return null
  if (alerts.length > 1) {
    const down = alerts.filter((alert) => alert.kind !== 'up').length
    const title =
      down === 0
        ? `${alerts.length} 个关注服务已恢复`
        : down === alerts.length
          ? `${alerts.length} 个关注服务不在跑`
          : `${alerts.length} 个关注服务有变化`
    return { title, body: alerts.slice(0, 5).map(describeAlert).join('；') }
  }
  const alert = alerts[0]
  return { title: ALERT_TITLE[alert.kind], body: describeAlert(alert) }
}

const ALERT_TITLE: Record<ServiceAlert['kind'], string> = {
  down: '关注的服务挂起',
  up: '关注的服务已恢复',
  repeat: '关注的服务仍未恢复'
}

function describeAlert(alert: ServiceAlert): string {
  if (alert.kind === 'up') return `${alert.label}（${alert.name}）重新在跑`
  if (alert.kind === 'repeat') return `${alert.label}（${alert.name}）${alert.reason}`
  return `${alert.label}（${alert.name}）${alert.reason ?? '不在运行'}`
}

export interface ServiceMonitorDeps {
  /**
   * 取当前关注服务的读数（复用主进程那份带 TTL 与合流的采集）。
   *
   * 要整份报告而不是裸数组：`degraded` 是「这一拍没读到」的权威判据。
   */
  collect: () => Promise<ServiceStatusReport>
  /** 关注清单是不是非空 —— 用来区分「没有关注项」与「这一拍采集失败」 */
  hasWatch: () => boolean
  /** 判出提醒后交给调用方（走统一通知出口） */
  onAlerts: (alerts: ServiceAlert[]) => void
  /** 「持续异常重复提醒」是否开启 —— 每拍重新读，设置改了立刻生效 */
  isRepeatEnabled: () => boolean
}

export class ServiceMonitor {
  #deps: ServiceMonitorDeps
  #state = createWatchState()
  #timer: ReturnType<typeof setTimeout> | null = null
  #busy = false
  /** 正在飞的那一拍：syncNow 要等它收尾，避免与它交错 */
  #inflight: Promise<void> | null = null

  constructor(deps: ServiceMonitorDeps) {
    this.#deps = deps
  }

  /** 启动（幂等）。无关注项时每拍是空转，成本可忽略 */
  start(): void {
    if (this.#timer) return
    this.#schedule(FIRST_TICK_MS)
  }

  stop(): void {
    if (this.#timer) {
      clearTimeout(this.#timer)
      this.#timer = null
    }
  }

  /**
   * 立即对齐一次基线 —— 关注清单变了就调。
   *
   * 不这么做的话，新加的关注项要等到下一拍才有基线：这期间的任何变化都会被
   * 「建立基线」吞掉（恰好是最容易发生的时刻 —— 你刚加完关注就会盯着它看）。
   *
   * 撞上正在飞的那一拍时**等它结束再补一拍**，而不是直接返回：`#tick` 在
   * `#busy` 时只把下一拍推到 60 秒后，于是「刚加完关注」到「基线建立」之间
   * 会有最长一分钟的空窗 —— 而这一分钟恰是用户盯着新服务看的时刻，期间的
   * 挂掉/恢复会被建立基线吞掉，从此那一拍的变化永远丢了。
   */
  async syncNow(): Promise<void> {
    // 等在飞的那一拍收尾（若没有则是 no-op），再补一拍，保证这次调用真的对齐了基线
    while (this.#inflight !== null) {
      await this.#inflight
    }
    await this.#tick()
  }

  #schedule(ms: number): void {
    if (this.#timer) clearTimeout(this.#timer)
    this.#timer = setTimeout(() => void this.#tick(), ms)
  }

  async #tick(): Promise<void> {
    if (this.#busy) {
      this.#schedule(TICK_MS)
      return
    }
    const running = this.#runTick()
    this.#inflight = running
    try {
      await running
    } finally {
      if (this.#inflight === running) this.#inflight = null
    }
  }

  async #runTick(): Promise<void> {
    this.#busy = true
    try {
      const report = await this.#deps.collect()
      /*
       * 「这一拍没读到」时**必须原样保留基线**：把空结果喂给 diffServices 会把
       * 所有 seen/alerted 清掉，下一拍全变成「第一次观察」—— 真正的那个变化
       * （也就是这一拍该报的）就永远丢了，而且此后每一拍都静默。
       *
       * 两条判据并用：`degraded` 是采集器给出的权威结论；「关注清单非空却一条
       * 都没采到」是同义的兜底（collectServices 对每个 wanted 名字都会回一条，
       * 哪怕是 missing），留着它以防将来某个采集器忘了置 degraded。
       */
      if (report.degraded || (report.items.length === 0 && this.#deps.hasWatch())) {
        return
      }
      const alerts = diffServices(this.#state, report.items, Date.now(), {
        repeat: this.#deps.isRepeatEnabled()
      })
      if (alerts.length > 0) this.#deps.onAlerts(alerts)
    } catch {
      /* 采集失败：这一拍跳过，下一拍再试（状态不动，避免把「读不到」当成变化） */
    } finally {
      this.#busy = false
      this.#schedule(TICK_MS)
    }
  }
}
