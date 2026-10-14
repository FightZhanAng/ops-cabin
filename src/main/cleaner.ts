import { app } from 'electron'
import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type {
  CleanFailure,
  CleanHistoryEntry,
  CleanMode,
  CleanOutcome,
  CleanRequestItem
} from '../shared/disk'
import { writeFileAtomic } from './atomic'
import { runPowerShell } from './powershell'
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

/**
 * 清理执行。
 *
 * 三层安全防线（缺一不可）：
 *   1. 路径必须出现在本会话最近一次扫描结果里 —— 渲染层被攻破也无法删任意文件；
 *   2. 白名单（设置里的保护目录）与系统保护名单二次拦截；
 *   3. 默认走回收站（SHFileOperation + FOF_ALLOWUNDO），可以还原。
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
   * 也删不了任意文件。并集只是让这个集合不随下一次扫描缩小。
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
        failures.push({ path: item.path, error: veto })
        continue
      }
      if (!existsSync(item.path)) {
        // 已经不在了：目标达成，不当作失败，也不计释放量
        removed.push(item.path)
        continue
      }
      accepted.push(item)
    }

    if (accepted.length > 0) {
      failures.push(...(await deletePaths(accepted.map((item) => item.path), mode === 'recycle')))
    }

    const failed = new Set(failures.map((f) => normalizeForCompare(f.path)))
    const succeeded = accepted.filter((item) => !failed.has(normalizeForCompare(item.path)))
    const freedBytes = succeeded.reduce((sum, item) => sum + item.bytes, 0)
    for (const item of succeeded) removed.push(item.path)

    const result = {
      at: Date.now(),
      mode,
      succeeded: succeeded.length,
      failed: failures,
      freedBytes,
      removed
    }
    this.#appendHistory({ at: result.at, mode, freedBytes, itemCount: succeeded.length })
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
 * 批量删除。走 shell32 的 SHFileOperation（Windows 官方删除路径）：
 * 全程静默（FOF_SILENT | FOF_NOERRORUI | FOF_NOCONFIRMATION），
 * 逐个执行以便拿到逐项结果；toRecycleBin 为真时加 FOF_ALLOWUNDO 进回收站。
 *
 * 注：SHFileOperation 不支持超长路径（>260），清理目标都是常见缓存路径，不受影响。
 *
 * 这个函数对外的契约是「永远回一个 CleanFailure[]」—— 所以**任何**可能抛错的
 * 步骤（含写清单文件）都必须在这里收住。早前 `writeFileSync` 在 try 之外，
 * 抛错会一路穿透到渲染层变成 unhandled rejection：用户走完二次确认后
 * 对话框停在原地、按钮恢复可点、没有任何提示，只会以为界面卡了。
 */
async function deletePaths(paths: string[], toRecycleBin: boolean): Promise<CleanFailure[]> {
  const failAll = (reason: string): CleanFailure[] =>
    paths.map((p) => ({ path: p, error: reason }))

  // 清单文件带随机后缀：同秒内两次清理不会撞同一个名字
  const listFile = join(
    app.getPath('temp'),
    `ops-cabin-clean-${Date.now()}-${randomBytes(4).toString('hex')}.txt`
  )
  try {
    writeFileSync(listFile, paths.join('\n'), 'utf8')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return failAll(`无法准备删除清单（${message}）`)
  }

  /*
   * 清单文件路径**不能裸拼进 PowerShell 单引号字符串**。
   *
   * Windows 用户名与临时目录都允许含单引号（`C:\Users\O'Brien\...`），裸拼会让
   * 脚本出现「字符串缺少终止符」的解析错误 —— 这类机器上清理 100% 失败，而报错
   * 是 CLIXML 原文，用户完全读不懂。这里走**环境变量**传参：路径不经脚本源码，
   * 解析层无从被破坏（与 services/collect.ts 用 base64 传数据同一思路）。
   */
  const script = [
    "Add-Type -TypeDefinition @'",
    'using System;',
    'using System.Runtime.InteropServices;',
    'public static class OpsCabinDelete {',
    '  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]',
    '  private struct SHFILEOPSTRUCT {',
    '    public IntPtr hwnd;',
    '    public uint wFunc;',
    '    public string pFrom;',
    '    public string pTo;',
    '    public ushort fFlags;',
    '    public bool fAnyOperationsAborted;',
    '    public IntPtr hNameMappings;',
    '    public string lpszProgressTitle;',
    '  }',
    '  [DllImport("shell32.dll", CharSet = CharSet.Unicode)]',
    '  private static extern int SHFileOperation(ref SHFILEOPSTRUCT lpFileOp);',
    '  public static int Delete(string path, bool toRecycleBin) {',
    '    var op = new SHFILEOPSTRUCT();',
    '    op.wFunc = 0x0003;',
    '    op.pFrom = path + "\\0\\0";',
    '    ushort flags = 0x0010 | 0x0004 | 0x0400 | 0x0200;',
    '    if (toRecycleBin) flags |= 0x0040;',
    '    op.fFlags = flags;',
    '    return SHFileOperation(ref op);',
    '  }',
    '}',
    "'@",
    // 路径经环境变量进来，不参与脚本源码拼接
    '$paths = Get-Content -LiteralPath $env:OPS_CABIN_CLEAN_LIST -Encoding UTF8',
    'foreach ($p in $paths) {',
    '  if ([string]::IsNullOrWhiteSpace($p)) { continue }',
    `  try { $code = [OpsCabinDelete]::Delete($p, $${toRecycleBin ? 'true' : 'false'}) } catch { $code = -1 }`,
    "  if ($code -eq 0) { Write-Output ('OK|' + $p) } else { Write-Output ('ERR' + $code + '|' + $p) }",
    '}'
  ].join('\n')

  let output = ''
  try {
    output = await runPowerShell(script, 120000, { OPS_CABIN_CLEAN_LIST: listFile })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return failAll(`删除执行失败：${message}`)
  } finally {
    try {
      unlinkSync(listFile)
    } catch {
      /* 清理临时文件失败可忽略 */
    }
  }

  const failures: CleanFailure[] = []
  for (const line of output.split(/\r?\n/)) {
    const sep = line.indexOf('|')
    if (sep <= 0) continue
    const status = line.slice(0, sep)
    const pathValue = line.slice(sep + 1)
    if (status === 'OK') continue
    failures.push({ path: pathValue, error: explainDeleteError(status) })
  }
  return failures
}

function explainDeleteError(status: string): string {
  const code = Number(status.replace(/^ERR/, ''))
  if (code === 2) return '文件不存在或已被移动'
  if (code === 5) return '拒绝访问（可能被占用或需要管理员权限）'
  if (code === 32) return '文件正被占用'
  if (code === -1) return '删除调用异常'
  return `删除失败（错误码 ${status.replace(/^ERR/, '')}）`
}
