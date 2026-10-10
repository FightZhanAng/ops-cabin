// 扫描执行进程（utilityProcess 入口）——只在独立进程里跑 fs 遍历：
// 主进程保持轻快，扫描多大都不卡 UI；取消 = 主进程直接终止本进程。
//
// 注意：utilityProcess 里没有 Electron API，只有 Node 能力 + process.parentPort。
import { lstat, readdir, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type {
  ScanGroupKey,
  ScanGroupResult,
  ScanItem,
  ScanProgress,
  ScanResult
} from '../../shared/disk'
import { WALK_SKIP_DIRS, isExcluded } from './categories'
import type { WorkerMessage, WorkerTask } from './protocol'

const PROGRESS_INTERVAL_MS = 200

interface ParentPortLike {
  postMessage: (message: unknown) => void
  on: (event: 'message', listener: (event: { data: unknown }) => void) => void
}

const parentPort = (process as unknown as { parentPort: ParentPortLike }).parentPort

function post(message: WorkerMessage): void {
  parentPort.postMessage(message)
}

/* ------------------------------------------------------------ 进度 */

let scannedFiles = 0
let found = 0
let phase: ScanProgress['phase'] = 'measuring'
let currentPath = ''
let lastProgressAt = 0

function tick(path: string, countFile = false): void {
  currentPath = path
  if (countFile) scannedFiles++
  const now = Date.now()
  if (now - lastProgressAt >= PROGRESS_INTERVAL_MS) {
    lastProgressAt = now
    report()
  }
}

function report(): void {
  post({
    type: 'progress',
    value: { phase, current: currentPath, scannedFiles, found }
  })
}

/* ------------------------------------------------------------ 目录遍历 */

interface WalkOptions {
  /** 按目录名跳过的（小写） */
  skipDirs?: Set<string>
  /** 按路径前缀跳过的（小写规范化） */
  exclude?: string[]
  /** 每个文件回调（大文件收集用） */
  onFile?: (filePath: string, size: number) => void
}

interface WalkStats {
  bytes: number
  files: number
  skipped: number
}

/**
 * 迭代式深度优先遍历（显式栈，避免递归爆栈）。
 * 目录链接（含 Windows junction）一律不跟进 —— 系统盘里的
 * 「Application Data」这类自指 junction 会让盲跟的遍历原地打转。
 */
async function walk(root: string, options: WalkOptions): Promise<WalkStats> {
  const stats: WalkStats = { bytes: 0, files: 0, skipped: 0 }
  const stack: string[] = [root]

  while (stack.length > 0) {
    const dir = stack.pop() as string
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      stats.skipped++
      continue
    }

    const files: string[] = []
    for (const entry of entries) {
      const full = join(dir, entry.name)

      if (entry.isDirectory()) {
        const name = entry.name.toLowerCase()
        if (options.skipDirs?.has(name)) {
          stats.skipped++
          continue
        }
        if (options.exclude && options.exclude.length > 0 && isExcluded(full, options.exclude)) {
          stats.skipped++
          continue
        }
        try {
          const link = await lstat(full)
          if (link.isSymbolicLink()) {
            stats.skipped++
            continue
          }
        } catch {
          stats.skipped++
          continue
        }
        stack.push(full)
      } else if (entry.isFile()) {
        files.push(full)
      }
      // 其它类型（链接文件等）直接忽略
    }

    // 同目录文件批量提交 stat —— 填满 libuv 线程池（worker 启动时已调大）。
    // 逐个 await 的串行 stat 是扫描大目录的主要瓶颈。
    if (files.length > 0) {
      const results = await Promise.all(
        files.map(async (filePath) => {
          try {
            const size = (await stat(filePath)).size
            // 完成一个就 tick 一次 —— 整批等待期间进度也要持续流动
            tick(filePath, true)
            return { filePath, size }
          } catch {
            tick(filePath, true)
            return { filePath, size: null }
          }
        })
      )
      for (const { filePath, size } of results) {
        if (size === null) {
          stats.skipped++
          continue
        }
        stats.bytes += size
        stats.files++
        options.onFile?.(filePath, size)
      }
    }
  }
  return stats
}

/* ------------------------------------------------------------ 主流程 */

async function runScan(task: WorkerTask): Promise<ScanResult> {
  const startedAt = Date.now()
  const items: ScanItem[] = []
  let skipped = 0

  /* 固定位置：逐个测量 */
  phase = 'measuring'
  for (const target of task.targets) {
    tick(target.path)
    const stats = await walk(target.path, { exclude: task.exclude })
    skipped += stats.skipped
    if (stats.files === 0 && stats.bytes === 0) continue
    items.push({
      id: target.path,
      label: target.label,
      path: target.path,
      group: target.group,
      risk: target.risk,
      bytes: stats.bytes,
      files: stats.files,
      note: target.note
    })
    found = items.length
  }

  /* 大文件：遍历指定根，收集超过阈值的文件 */
  if (task.largeFileRoots.length > 0) {
    phase = 'largeFiles'
    report()
    const large: { path: string; size: number }[] = []
    for (const rootPath of task.largeFileRoots) {
      tick(rootPath)
      if (isExcluded(rootPath, task.exclude)) {
        skipped++
        continue
      }
      const stats = await walk(rootPath, {
        skipDirs: WALK_SKIP_DIRS,
        exclude: task.exclude,
        onFile: (filePath, size) => {
          if (size >= task.largeFileMinBytes) large.push({ path: filePath, size })
        }
      })
      skipped += stats.skipped
    }
    large.sort((a, b) => b.size - a.size)
    for (const file of large.slice(0, task.largeTopN)) {
      items.push({
        id: file.path,
        label: basename(file.path),
        path: file.path,
        group: 'largeFiles',
        risk: 'careful',
        bytes: file.size,
        files: 1,
        note: '大文件 —— 删除前请确认用途'
      })
    }
    found = items.length
  }

  /* 组装分组 */
  const groupKeys: ScanGroupKey[] = ['safe', 'devCaches', 'largeFiles']
  const groups: ScanGroupResult[] = []
  for (const key of groupKeys) {
    const groupItems = items.filter((item) => item.group === key)
    if (groupItems.length === 0) continue
    groups.push({
      group: key,
      items: groupItems,
      bytes: groupItems.reduce((sum, item) => sum + item.bytes, 0)
    })
  }

  return { at: Date.now(), durationMs: Date.now() - startedAt, groups, skipped }
}

/* ------------------------------------------------------------ 入口 */

parentPort.on('message', (event) => {
  const task = event.data as WorkerTask
  runScan(task)
    .then((result) => {
      post({ type: 'done', value: result })
      // 留一拍把消息 flush 出去再退出
      setTimeout(() => process.exit(0), 50)
    })
    .catch((error: unknown) => {
      post({ type: 'fatal', message: error instanceof Error ? error.message : String(error) })
      setTimeout(() => process.exit(1), 50)
    })
})

process.on('uncaughtException', (error) => {
  try {
    post({ type: 'fatal', message: error.message })
  } finally {
    process.exit(1)
  }
})
