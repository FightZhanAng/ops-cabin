import { spawn } from 'node:child_process'

/*
 * 网卡吞吐采样。
 *
 * 取数走 `netstat -e`（接口统计）：一行「字节 · 接收 · 发送」，读一次约 300ms，
 * 比 PowerShell 通道（冷启动 1–2s）便宜一个数量级。速率自己按两次计数差分算 ——
 * 系统给的每秒速率要额外挂性能计数器，反而更贵。
 *
 * 两个坑记在这里：
 *   1. netstat 的行标签是**本地化**的（中文系统上是「字节 / 接收的 / 发送的」），
 *      按文字匹配会在英文系统上失效 —— 只有表尾数字稳定。所以按位置取
 *      「第一行含 ≥2 个纯数字」的数据行（表头之后就是字节行，这个行序是
 *      netstat 的实现细节，各语言版本一致）。
 *   2. 计数是累计值，网卡重置/重连后会归零 —— 负增量一律当 0，否则图上会出现
 *      一根反向的巨型尖刺。
 */

/** 采样间隔：外部进程一次 300ms，2s 一次足够画出吞吐曲线 */
export const NET_SAMPLE_INTERVAL = 2000
/** netstat 单次超时：卡住的 netstat 不该拖住整个采样链 */
const NETSTAT_TIMEOUT = 4000

interface Counters {
  rx: number
  tx: number
}

/** 解析 netstat -e 的字节行；取不到返回 null */
export function parseNetstatBytes(output: string): Counters | null {
  for (const line of output.split(/\r?\n/)) {
    const tokens = line.trim().split(/\s+/)
    if (tokens.length < 2) continue
    const numbers = tokens.filter((token) => /^\d+$/.test(token))
    if (numbers.length < 2) continue
    // 第一行「含两个以上纯数字」的就是字节行：接收、发送
    return { rx: Number(numbers[0]), tx: Number(numbers[1]) }
  }
  return null
}

function runNetstat(): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('netstat.exe', ['-e'], { windowsHide: true })
    let stdout = ''
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error('netstat 超时'))
    }, NETSTAT_TIMEOUT)
    child.stdout.on('data', (chunk: Buffer) => {
      // 输出带本地化文字，编码不可靠；我们只取数字，按 latin1 直读即可
      stdout += chunk.toString('latin1')
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', () => {
      clearTimeout(timer)
      resolve(stdout)
    })
  })
}

export interface NetRate {
  /** 下行字节/秒 */
  rxBps: number
  /** 上行字节/秒 */
  txBps: number
}

/**
 * 网卡吞吐监视器。
 *
 * `rate()` 返回的是「最近两次计数读取之间的平均值」：界面开着时窗口约 2s
 * （接近瞬时），没人看时窗口就是两个趋势采样点之间的距离（约 5 分钟，
 * 正好是趋势图需要的平均速率）。两种都是真实测量值，不是插值。
 */
export class NetMonitor {
  #timer: ReturnType<typeof setInterval> | null = null
  #last: Counters | null = null
  #lastAt = 0
  #rate: NetRate | null = null
  #reading = false

  /** 读一次计数并更新速率；失败时保持上一次的读数（网络读数不该因为一次超时归零） */
  async sampleNow(): Promise<void> {
    if (this.#reading) return
    this.#reading = true
    try {
      const counters = parseNetstatBytes(await runNetstat())
      if (!counters) return
      const at = Date.now()
      if (this.#last) {
        const elapsed = (at - this.#lastAt) / 1000
        if (elapsed > 0) {
          this.#rate = {
            rxBps: Math.max(0, counters.rx - this.#last.rx) / elapsed,
            txBps: Math.max(0, counters.tx - this.#last.tx) / elapsed
          }
        }
      }
      this.#last = counters
      this.#lastAt = at
    } catch {
      /* 读不到就沿用旧读数 */
    } finally {
      this.#reading = false
    }
  }

  /** 最近一次算出的速率；还没有两次计数时返回 null */
  rate(): NetRate | null {
    return this.#rate
  }

  /** 开始按间隔采样（第一次订阅时） */
  start(): void {
    if (this.#timer) return
    void this.sampleNow()
    this.#timer = setInterval(() => void this.sampleNow(), NET_SAMPLE_INTERVAL)
  }

  stop(): void {
    if (this.#timer) {
      clearInterval(this.#timer)
      this.#timer = null
    }
  }

  dispose(): void {
    this.stop()
  }
}
