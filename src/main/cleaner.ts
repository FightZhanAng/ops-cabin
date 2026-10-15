import { app } from 'electron'
import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type {
  CleanFailure,
  CleanHistoryEntry,
  CleanHolder,
  CleanMode,
  CleanOutcome,
  CleanRequestItem
} from '../shared/disk'
import { writeFileAtomic } from './atomic'
import { runPowerShell } from './powershell'
import { CLEAN_LIST_ENV, buildCleanScript } from './cleaner/script'
import { HOLDER_LIST_ENV, HOLDER_SCRIPT } from './cleaner/holder'
import { coversExcluded, isExcluded, normalizeForCompare } from './scanner/categories'

/** 系统保护名单：即使出现在扫描结果里也绝不允许删除（精确匹配） */
const PROTECTED_PATHS = [
  'c:\\windows',
  'c:\\program files',
  'c:\\program files (x86)',
  'c:\\programdata',
  'c:\\users'
]

const HISTORY_LIMIT = 200
const MAX_ITEMS_PER_RUN = 500

/**
 * 删除脚本的超时。
 *
 * 逐条目判定比"一次性把整棵树交给系统"慢得多：每个条目都要遍历 + 清理残留 + 必要时
 * 问 Restart Manager，实测 766 个顶层条目（含 3 万文件的 Temp）在 1 分钟内跑完。
 * 原实现给的 120s 对"逐条目 + 残留量测"偏紧，这里放到 5 分钟。
 */
const DELETE_TIMEOUT_MS = 300000

/** 点名脚本的超时（只问几个文件，给 60s 足够） */
const HOLDER_TIMEOUT_MS = 60000

/**
 * 一次清理最多拿几个残留文件去点名。
 * 每个文件都要单独开一次 Restart Manager 会话；而且同一条目里的残留文件几乎总是
 * 同一批进程开着的，问几个就足以说明是谁。
 */
const HOLDER_QUERY_MAX = 6

/** 读历史文件（损坏 / 缺字段的条目直接丢弃：统计图宁少勿错；一律返回时间升序） */
function readHistory(file: string): CleanHistoryEntry[] {
  try {
    if (!existsSync(file)) return []
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
    if (!Array.isArray(parsed)) return []
    // 排序不靠写入顺序兜底：文件被手工改过 / 系统时间回拨时，「最近一次」仍要对
    return parsed.filter(isHistoryEntry).sort((a, b) => a.at - b.at)
  } catch {
    return []
  }
}

function isHistoryEntry(value: unknown): value is CleanHistoryEntry {
  if (value === null || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return (
    typeof record.at === 'number' &&
    Number.isFinite(record.at) &&
    (record.mode === 'recycle' || record.mode === 'permanent') &&
    typeof record.freedBytes === 'number' &&
    Number.isFinite(record.freedBytes) &&
    record.freedBytes >= 0 &&
    typeof record.itemCount === 'number' &&
    Number.isFinite(record.itemCount) &&
    record.itemCount >= 0
  )
}

/** 判定脚本回传的一条结果（与 src/main/cleaner/script.ts 的 ToJson 一一对应） */
interface ProbeRecord {
  path: string
  /** SHFileOperation 返回码：0 成功 / 32 部分失败 / 124 回收站整体取消 */
  code: number
  /** 条目本身已经不在了 */
  ok: boolean
  isDir: boolean
  /** 残留字节 */
  bytes: number
  /** 残留文件数 */
  files: number
  /** 残留顶层条目数 */
  residueItems: number
  /** 有内容被删掉、也有内容残留 */
  partial: boolean
  /**
   * 残留量测阶段确实删掉了文件。
   * 回收站模式被整体取消时，没被占的那部分就是在这一步被清掉的 ——
   * 属**永久删除**，与界面上选的"回收站"不同，必须让用户看见。
   */
  pruned: boolean
  /** 残留枚举被截断 */
  truncated: boolean
  /** 残留项上撞到的 Win32 错误码（32 被占 / 5 拒绝访问 …） */
  errs: number[]
  /** 被占 / 受限的具体文件（由第二段脚本补上 holders） */
  samples: string[]
  /** 点名到的持有进程（未查到时为空数组） */
  holders: CleanHolder[]
}

/**
 * 解析判定脚本的输出：只认 `{` 开头的行，脏行丢弃（CLIXML 之类的噪音不进结果）。
 * 返回按 normalizeForCompare(path) 索引的映射。
 */
export function parseCleanerOutput(output: string): Map<string, ProbeRecord> {
  const byPath = new Map<string, ProbeRecord>()
  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{')) continue
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>
      const path = parsed.path
      if (typeof path !== 'string' || path.length === 0) continue
      byPath.set(normalizeForCompare(path), {
        path,
        code: typeof parsed.code === 'number' ? parsed.code : -1,
        ok: parsed.ok === true,
        isDir: parsed.isDir === true,
        bytes: typeof parsed.bytes === 'number' ? parsed.bytes : 0,
        files: typeof parsed.files === 'number' ? parsed.files : 0,
        residueItems: typeof parsed.residueItems === 'number' ? parsed.residueItems : 0,
        partial: parsed.partial === true,
        pruned: parsed.pruned === true,
        truncated: parsed.truncated === true,
        errs: Array.isArray(parsed.errs) ? parsed.errs.filter((e) => typeof e === 'number') : [],
        samples: Array.isArray(parsed.samples)
          ? parsed.samples.filter((s): s is string => typeof s === 'string')
          : [],
        holders: []
      })
    } catch {
      /* 单行坏了不影响其余条目 */
    }
  }
  return byPath
}

/** 把 "进程名|PID" 解析成 CleanHolder（解析不了的丢弃，不让脏数据进界面） */
function parseHolders(raw: string[]): CleanHolder[] {
  const byPid = new Map<number, CleanHolder>()
  for (const entry of raw) {
    const sep = entry.lastIndexOf('|')
    if (sep <= 0) continue
    const pid = Number(entry.slice(sep + 1))
    if (!Number.isInteger(pid) || pid <= 0) continue
    const name = entry.slice(0, sep)
    const existing = byPid.get(pid)
    if (existing) {
      // 同一个进程可能以不同别名反复出现：名字取最长的那份
      if (name.length > existing.name.length) existing.name = name
      continue
    }
    byPid.set(pid, { pid, name })
  }
  return [...byPid.values()].sort((a, b) => a.name.localeCompare(b.name) || a.pid - b.pid)
}

/** 单个条目的失败说明：把返回码翻成人话，并带上点名结果 */
function explainFailure(
  record: ProbeRecord,
  holders: CleanHolder[],
  deletedBytes: number
): { reason: CleanFailure['reason']; error: string } {
  const names = holders.map((h) => `${h.name || '未知程序'}（PID ${h.pid}）`)
  const who = names.length > 0 ? `：${names.slice(0, 3).join('、')}${names.length > 3 ? ` 等 ${names.length} 个进程` : ''}` : ''

  if (record.code === 124) {
    // 回收站模式下 Windows 会为整个目录放弃操作。但没被占的那部分在量测残留时
    // 已经被清掉了（永久删除），所以这里要分开说清"哪部分没了、哪部分还在"。
    const freed = deletedBytes > 0 ? formatBytes(deletedBytes) : ''
    const head =
      deletedBytes > 0
        ? `删除到回收站被整体取消（这项里有文件正被占用），但未被占用的 ${freed} 已被永久删除（不进回收站）。`
        : '删除到回收站被整体取消（这项里有文件正被占用），一个文件都没删。'
    return {
      reason: 'recycle-cancelled',
      error: `${head}仍占用、删不掉的${who}。先关闭上述程序再重试即可清掉剩余部分。`
    }
  }
  // 残留项上撞到的 Win32 错误码比 SHFileOperation 的返回码更能说明问题：
  // 32 = 别人拿着句柄、5 = 拒绝访问、19 = 写保护。
  const residueErr = record.errs.find((e) => e === 5 || e === 19) ?? record.errs[0] ?? 0
  if (residueErr === 5) {
    const remaining = record.bytes > 0 ? `，剩余约 ${formatBytes(record.bytes)}（${record.files} 个文件）` : ''
    return { reason: 'denied', error: `拒绝访问${remaining}：需要管理员权限，或目标被系统保护` }
  }
  if (residueErr === 19) {
    return { reason: 'denied', error: '目标所在卷写保护，无法删除' }
  }
  if (record.code === 32 || record.code === 5 || record.code === 19 || residueErr === 32) {
    if (record.files > 0) {
      const remaining = `，剩余约 ${formatBytes(record.bytes)}（${record.files} 个文件）`
      const freed = deletedBytes > 0 ? `已删除 ${formatBytes(deletedBytes)}` : '未能删除任何内容'
      return {
        reason: 'locked',
        error: `${freed}${remaining}；剩这些删不掉，文件正被占用${who}`
      }
    }
    return {
      reason: record.code === 5 && residueErr === 0 ? 'denied' : 'locked',
      error:
        record.code === 5 && residueErr === 0
          ? '拒绝访问：需要管理员权限，或该文件正被占用'
          : `文件正被占用${who}`
    }
  }
  if (record.truncated) {
    return { reason: 'error', error: '残留项过多，已停止统计（结果不小于实际情况）' }
  }
  if (record.code === -1) return { reason: 'error', error: '删除调用异常' }
  // 删除调用整体失败、但残留量测把能删的清掉了：别报成"什么都没发生"。
  if (record.pruned && deletedBytes > 0) {
    const remaining = record.files > 0 ? `；仍有 ${record.files} 个文件（约 ${formatBytes(record.bytes)}）删不掉${who}` : ''
    return { reason: 'locked', error: `已删除 ${formatBytes(deletedBytes)}${remaining}` }
  }
  return { reason: 'error', error: `删除失败（返回码 ${record.code}）` }
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let index = 0
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024
    index++
  }
  return `${value >= 100 || index === 0 ? Math.round(value) : value.toFixed(1)} ${units[index]}`
}

/**
 * 清理执行。
 *
 * 四层安全防线（缺一不可）：
 *   1. 路径必须出现在本会话最近一次扫描结果里 —— 渲染层被攻破也无法删任意文件；
 *   2. 白名单（设置里的保护目录）与系统保护名单二次拦截；
 *   3. 默认走回收站（SHFileOperation + FOF_ALLOWUNDO），可以还原；
 *   4. **逐条目**判定并如实回报：删不掉的条目必须原样留在磁盘上，
 *      且必须说清是被哪个进程占着 —— 不能因为"反正删不掉"就顺手降级成永久删除。
 */
export class Cleaner {
  #historyFile: string
  #scanned = new Set<string>()

  constructor() {
    this.#historyFile = join(app.getPath('userData'), 'clean-history.json')
  }

  /**
   * 扫描完成时登记可删除路径 —— clean:run 只认登记过的路径。
   *
   * 用**并集**而不是整体替换：界面是按组合并的（DiskView 只替换本次扫过的那些组，
   * 其余组的行继续留在表格里可勾选），若这里整体替换，先扫 A 组再扫 B 组之后，
   * 界面上仍显示、仍可勾选的 A 组行会被逐项拒绝 —— 用户走完二次确认却一项都删不掉。
   * 后台的计划扫描（只扫 safe + devCaches）也会造成同样的「无操作却失效」。
   *
   * 安全性质不变：仍然只认「本会话某次扫描结果里出现过」的路径，渲染层被攻破
   * 也删不了任意路径。并集只是让这个集合不随下一次扫描缩小。
   */
  registerScanned(paths: string[]): void {
    for (const path of paths) this.#scanned.add(normalizeForCompare(path))
  }

  /** 清理历史（按时间升序；总览的统计图消费） */
  history(): CleanHistoryEntry[] {
    return readHistory(this.#historyFile)
  }

  async run(items: CleanRequestItem[], mode: CleanMode, whitelist: string[]): Promise<CleanOutcome> {
    if (items.length === 0) return { ok: false, error: '没有选中任何要清理的项' }
    if (items.length > MAX_ITEMS_PER_RUN) {
      return { ok: false, error: `单次清理项数过多（上限 ${MAX_ITEMS_PER_RUN}）` }
    }

    const whitelistNorm = whitelist.map((p) => normalizeForCompare(p)).filter((p) => p.length > 0)
    const homeLower = normalizeForCompare(homedir())

    const accepted: CleanRequestItem[] = []
    const failures: CleanFailure[] = []
    const removed: string[] = []
    for (const item of items) {
      const veto = this.#veto(item.path, whitelistNorm, homeLower)
      if (veto) {
        failures.push({ path: item.path, error: veto, reason: 'denied' })
        continue
      }
      if (!existsSync(item.path)) {
        // 已经不在了：目标达成，不当作失败，也不计释放量
        removed.push(item.path)
        continue
      }
      accepted.push(item)
    }

    const { records: probes, executionError } =
      accepted.length > 0
        ? await deletePaths(
            accepted.map((item) => item.path),
            mode === 'recycle'
          )
        : { records: new Map<string, ProbeRecord>(), executionError: null }

    let freedBytes = 0
    let succeededCount = 0
    for (const item of accepted) {
      const record = probes.get(normalizeForCompare(item.path))
      if (!record) {
        failures.push({
          path: item.path,
          error: executionError ?? '删除脚本没有回报这一项的结果',
          reason: 'error'
        })
        continue
      }

      if (record.ok) {
        // 整项已经不在磁盘上：可能是被删掉了，也可能是被别的程序顺手清掉了。
        // 两种情况都算"目的达成"，释放量按扫描值计（原实现同此口径）。
        succeededCount++
        freedBytes += item.bytes
        removed.push(item.path)
        continue
      }

      // 没删干净：如实算账 —— 删掉的那部分要计入释放量，残留量要报给用户
      const residueBytes = Math.max(0, record.bytes)
      const deletedBytes = Math.max(0, item.bytes - residueBytes)
      freedBytes += deletedBytes
      const holders = record.holders
      const { reason, error } = explainFailure(record, holders, deletedBytes)
      failures.push({
        path: item.path,
        error,
        reason,
        deletedBytes,
        residueBytes,
        residueFiles: Math.max(0, record.files),
        holders,
        samples: record.samples.slice(0, 12)
      })
    }

    const result = {
      at: Date.now(),
      mode,
      succeeded: succeededCount,
      failed: failures,
      freedBytes,
      removed
    }
    this.#appendHistory({ at: result.at, mode, freedBytes, itemCount: succeededCount })
    return { ok: true, result }
  }

  /** 逐项安全校验：返回拒绝原因，通过则返回 null */
  #veto(pathValue: string, whitelistNorm: string[], homeLower: string): string | null {
    const lower = normalizeForCompare(pathValue)
    if (!this.#scanned.has(lower)) return '不在本次扫描结果中，已拒绝'
    // 自身落进白名单，或者**包含**白名单目录（整目录候选递归删除会把它一起删掉）
    if (isExcluded(pathValue, whitelistNorm)) return '位于保护目录（白名单）中'
    if (coversExcluded(pathValue, whitelistNorm)) return '这一项里有受保护目录（白名单），已拒绝'
    if (/^[a-z]:\\?$/.test(lower)) return '不允许删除磁盘根目录'
    if (PROTECTED_PATHS.includes(lower)) return '系统保护目录，已拒绝'
    if (lower === homeLower) return '不允许删除用户主目录'
    return null
  }

  #appendHistory(entry: CleanHistoryEntry): void {
    try {
      const list = readHistory(this.#historyFile)
      list.push(entry)
      writeFileAtomic(
        this.#historyFile,
        `${JSON.stringify(list.length > HISTORY_LIMIT ? list.slice(-HISTORY_LIMIT) : list, null, 2)}\n`
      )
    } catch {
      /* 历史落盘失败不影响清理结果 */
    }
  }
}

/**
 * 批量删除 + 点名。分两段 PowerShell 跑：
 *
 *   第一段（script.ts）：逐条目 SHFileOperation 删除 + 残留量测。
 *     全程静默（FOF_SILENT | FOF_NOERRORUI | FOF_NOCONFIRMATION），
 *     toRecycleBin 为真时加 FOF_ALLOWUNDO 进回收站。
 *     **为什么必须逐条目**（这一步是清理可靠性的关键）：
 *     SHFileOperation 对"部分失败"只回一个非 0，看不出删掉了多少、也看不出卡在哪个文件上；
 *     反过来，回收站模式（FOF_ALLOWUNDO）遇到内含被占用文件的目录会返回 124 并**整体取消**，
 *     一个字节都不删 —— 早期实现把整棵目录树交给它，于是"3.5 GB 只因为 20 个小文件被占
 *     就一项都没删成，界面还显示『1 项失败（文件正被占用）』"。
 *
 *   第二段（holder.ts）：拿第一段量出的残留文件去问 Restart Manager，点名持有进程。
 *     分两段跑是因为整段脚本上限 32767 字符（实测合并后报 `spawn ENAMETOOLONG`）。
 *
 * 这个函数对外的契约是「永远回一个结果」—— 所以**任何**可能抛错的步骤
 * （含写清单文件、起 PowerShell、解析输出）都必须在这里收住。
 */
async function deletePaths(
  paths: string[],
  toRecycleBin: boolean
): Promise<{ records: Map<string, ProbeRecord>; executionError: string | null }> {
  const deleteRun = await withPathList<{ records: Map<string, ProbeRecord>; executionError: string | null }>(
    paths,
    async (listFile) => {
      const output = await runPowerShell(
        buildCleanScript({ toRecycleBin }),
        DELETE_TIMEOUT_MS,
        { [CLEAN_LIST_ENV]: listFile }
      )
      return { records: parseCleanerOutput(output), executionError: null }
    },
    (message) => ({ records: new Map<string, ProbeRecord>(), executionError: message })
  )
  if (deleteRun.executionError) return deleteRun
  return { records: await attachHolders(deleteRun.records, paths), executionError: null }
}

/**
 * 把待处理路径写进一个清单文件，跑完删掉（环境变量由调用方自己设）。
 * 清单文件而不是命令行参数：路径可能很长、含中文与单引号，塞进命令行会撞长度与转义。
 */
async function withPathList<T>(
  paths: string[],
  run: (listFile: string) => Promise<T>,
  onPrepareError: (message: string) => T
): Promise<T> {
  // 清单文件带随机后缀：同秒内两次清理不会撞同一个名字
  const listFile = join(
    app.getPath('temp'),
    `ops-cabin-clean-${Date.now()}-${randomBytes(4).toString('hex')}.txt`
  )
  try {
    writeFileSync(listFile, paths.join('\n'), 'utf8')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return onPrepareError(`无法准备删除清单（${message}）`)
  }
  try {
    return await run(listFile)
  } finally {
    try {
      rmSync(listFile, { force: true })
    } catch {
      /* 清理临时文件失败可忽略 */
    }
  }
}

/**
 * 给残留文件补上"谁占着"。
 *
 * 只对还没销案的条目、且只用它命中的那几个残留样本去问 —— 每个文件要单独开一次
 * Restart Manager 会话，问得越少越快。这一段失败不影响清理结论本身：
 * 拿不到进程名时，界面仍然如实说"文件正被占用"。
 */
async function attachHolders(
  records: Map<string, ProbeRecord>,
  paths: string[]
): Promise<Map<string, ProbeRecord>> {
  const pending: string[] = []
  for (const path of paths) {
    const record = records.get(normalizeForCompare(path))
    if (!record || record.ok) continue
    for (const sample of record.samples) {
      if (pending.length >= HOLDER_QUERY_MAX) break
      pending.push(sample)
    }
    if (pending.length >= HOLDER_QUERY_MAX) break
  }
  if (pending.length === 0) return records

  let output = ''
  try {
    output = await withPathList(
      pending,
      (listFile) => runPowerShell(HOLDER_SCRIPT, HOLDER_TIMEOUT_MS, { [HOLDER_LIST_ENV]: listFile }),
      () => ''
    )
  } catch {
    return records // 点名失败不影响"哪些没删掉"这个结论
  }

  const byPath = new Map<string, CleanHolder[]>()
  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{')) continue
    try {
      const parsed = JSON.parse(trimmed) as { path?: unknown; holders?: unknown }
      if (typeof parsed.path !== 'string') continue
      const raw = Array.isArray(parsed.holders)
        ? parsed.holders.filter((h): h is string => typeof h === 'string')
        : []
      const holders = parseHolders(raw)
      if (holders.length > 0) byPath.set(normalizeForCompare(parsed.path), holders)
    } catch {
      /* 单行坏了不影响其余 */
    }
  }

  for (const record of records.values()) {
    const holders: CleanHolder[] = []
    const seen = new Set<number>()
    for (const sample of record.samples) {
      for (const holder of byPath.get(normalizeForCompare(sample)) ?? []) {
        if (seen.has(holder.pid)) continue
        seen.add(holder.pid)
        holders.push(holder)
      }
    }
    record.holders = holders.sort((a, b) => a.name.localeCompare(b.name) || a.pid - b.pid)
  }
  return records
}
