import { utilityProcess, type UtilityProcess } from 'electron'
import { join } from 'node:path'
import type { ScanGroupKey, ScanOptions, ScanOutcome, ScanProgress } from '../../shared/disk'
import {
  LARGE_FILE_MIN_BYTES,
  LARGE_FILE_TOP_N,
  isExcluded,
  normalizeForCompare,
  resolveTargets
} from './categories'
import type { WorkerMessage, WorkerTask } from './protocol'

export interface ScannerCallbacks {
  onProgress: (progress: ScanProgress) => void
}

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

      const settle = (outcome: ScanOutcome): void => {
        if (settled) return
        settled = true
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
  const roots = groups.includes('largeFiles') ? (options.largeFileRoots ?? []) : []
  return {
    targets: resolveTargets(groups).filter((t) => !isExcluded(t.path, exclude)),
    largeFileRoots: roots,
    largeFileMinBytes: options.largeFileMinBytes ?? LARGE_FILE_MIN_BYTES,
    exclude,
    largeTopN: LARGE_FILE_TOP_N
  }
}
