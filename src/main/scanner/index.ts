import { utilityProcess, type UtilityProcess } from 'electron'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ScanGroupKey, ScanOptions, ScanOutcome, ScanProgress } from '../../shared/disk'
import {
  LARGE_FILE_MIN_BYTES,
  LARGE_FILE_TOP_N,
  coversExcluded,
  isExcluded,
  normalizeForCompare,
  resolveTargets
} from './categories'
import type { WorkerMessage, WorkerTask } from './protocol'

export interface ScannerCallbacks {
  onProgress: (progress: ScanProgress) => void
}

/**
 * 整条扫描链的兜底超时。
 *
 * worker 卡住（网络盘 / 挂载点不返回、子进程死锁）时 `Scanner.start` 永不 settle：
 * 进度条一直转，而 `busy` 恒为真会让后续每次「重新扫描」只是在取消一个已经卡死
 * 的任务。10 分钟对正常扫描足够宽松（本机几秒到几十秒），超时按失败上报并杀进程。
 */
const SCAN_TIMEOUT_MS = 10 * 60_000

/** 校验并收敛渲染层传来的扫描参数 */
export function parseScanOptions(raw: unknown): ScanOptions {
  const out: ScanOptions = {}
  if (raw === null || typeof raw !== 'object') return out
  const obj = raw as Record<string, unknown>

  if (Array.isArray(obj.groups)) {
    const valid = obj.groups.filter(
      (g): g is ScanGroupKey => g === 'safe' || g === 'devCaches' || g === 'largeFiles'
    )
    if (valid.length > 0) out.groups = valid
  }
  if (Array.isArray(obj.largeFileRoots)) {
    const roots = obj.largeFileRoots.filter(
      (p): p is string => typeof p === 'string' && p.length > 0 && p.length <= 1024
    )
    if (roots.length > 0) out.largeFileRoots = roots.slice(0, 8)
  }
  if (typeof obj.largeFileMinBytes === 'number' && Number.isFinite(obj.largeFileMinBytes)) {
    out.largeFileMinBytes = Math.min(Math.max(Math.floor(obj.largeFileMinBytes), 1024), 1024 ** 4)
  }
  return out
}

/**
 * 扫描任务管理：同一时刻最多一个扫描进程。
 * 新的 start 会先取消旧任务（「重新扫描」语义）；取消手段就是终止进程 ——
 * 进程一死，它占着的遍历与文件句柄全部立即释放。
 */
export class Scanner {
  #callbacks: ScannerCallbacks
  #child: UtilityProcess | null = null
  /** 被主动取消的子进程 —— exit 时据此区分「取消」与「意外退出」 */
  #cancelled = new WeakSet<UtilityProcess>()

  constructor(callbacks: ScannerCallbacks) {
    this.#callbacks = callbacks
  }

  get busy(): boolean {
    return this.#child !== null
  }

  start(options: ScanOptions, whitelist: string[]): Promise<ScanOutcome> {
    this.cancel()

    const task = buildTask(options, whitelist)
    return new Promise((resolve) => {
      let settled = false

      // UV_THREADPOOL_SIZE 调大：扫描是纯 IO 操作，线程池大则 stat 并发高
      // （只影响扫描进程自身，不动主进程）
      const child = utilityProcess.fork(join(__dirname, 'scanner.js'), [], {
        env: { ...process.env, UV_THREADPOOL_SIZE: '16' } as Record<string, string>
      })
      this.#child = child

      /*
       * 整条扫描链的兜底超时。
       *
       * 没有它的话，worker 卡住（某个网络盘 / 挂载点不返回、子进程死锁）就永远
       * 不 settle：界面上的进度条一直转，而 `busy` 恒为真会让后续每次「重新扫描」
       * 都只是取消一个已经卡死的任务。超时按失败上报，并把子进程杀掉 ——
       * 进程一死，它占着的遍历与句柄全部释放（与 cancel 同一手段）。
       *
       * 取值：单次扫描的正常耗时在本机是几秒到几十秒（大文件遍历通常最长），
       * 10 分钟足够宽松，不会误杀正常扫描。
       */
      const timeout = setTimeout(() => {
        settle({
          ok: false,
          cancelled: false,
          error: `扫描超时（超过 ${Math.round(SCAN_TIMEOUT_MS / 60_000)} 分钟未完成）`
        })
      }, SCAN_TIMEOUT_MS)
      timeout.unref?.()

      const settle = (outcome: ScanOutcome): void => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        if (this.#child === child) this.#child = null
        try {
          child.kill()
        } catch {
          /* 已退出 */
        }
        resolve(outcome)
      }

      child.on('spawn', () => {
        child.postMessage(task)
      })

      child.on('message', (message: WorkerMessage) => {
        if (message.type === 'progress') this.#callbacks.onProgress(message.value)
        else if (message.type === 'done') settle({ ok: true, result: message.value })
        else settle({ ok: false, cancelled: false, error: message.message })
      })

      child.on('exit', (code) => {
        settle(
          this.#cancelled.has(child)
            ? { ok: false, cancelled: true }
            : { ok: false, cancelled: false, error: `扫描进程意外退出（code=${code ?? 'null'}）` }
        )
      })
    })
  }

  cancel(): void {
    const child = this.#child
    if (!child) return
    this.#cancelled.add(child)
    child.kill()
  }
}

/** 把渲染层参数展开成扫描进程的任务 */
function buildTask(options: ScanOptions, whitelist: string[]): WorkerTask {
  const groups = options.groups ?? ['safe', 'devCaches']
  const exclude = whitelist.map((p) => normalizeForCompare(p)).filter((p) => p.length > 0)
  // 大文件组没给根目录时默认扫用户主目录（「扫描主目录」按钮的语义）
  let roots: string[] = []
  if (groups.includes('largeFiles')) {
    roots =
      options.largeFileRoots && options.largeFileRoots.length > 0
        ? options.largeFileRoots
        : [homedir()]
  }
  return {
    // 两道过滤，方向相反、缺一不可：
    //   · isExcluded    —— 候选自身就在白名单里（或在其下），跳过；
    //   · coversExcluded —— 候选**包含**白名单目录（例如白名单设了 %TEMP%\keep，
    //     而候选是整个 %TEMP%）。这种整目录候选删的时候是递归删除，会把受保护
    //     目录一起带走；而测体积时已经跳过了它，于是「预计释放」还偏小。
    //     直接剔除，别让界面给出一个注定会误删的候选。
    targets: resolveTargets(groups).filter(
      (t) => !isExcluded(t.path, exclude) && !coversExcluded(t.path, exclude)
    ),
    largeFileRoots: roots,
    largeFileMinBytes: options.largeFileMinBytes ?? LARGE_FILE_MIN_BYTES,
    exclude,
    largeTopN: LARGE_FILE_TOP_N
  }
}
