import { app } from 'electron'
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { CleanFailure, CleanMode, CleanOutcome, CleanRequestItem } from '../shared/disk'
import { writeFileAtomic } from './atomic'
import { runPowerShell } from './powershell'
import { isExcluded, normalizeForCompare } from './scanner/categories'

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

interface HistoryEntry {
  at: number
  mode: CleanMode
  freedBytes: number
  itemCount: number
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

  /** 扫描完成时登记可删除路径 —— clean:run 只认这份集合里的路径 */
  registerScanned(paths: string[]): void {
    this.#scanned = new Set(paths.map((p) => normalizeForCompare(p)))
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
    if (isExcluded(pathValue, whitelistNorm)) return '位于保护目录（白名单）中'
    if (/^[a-z]:\\?$/.test(lower)) return '不允许删除磁盘根目录'
    if (PROTECTED_PATHS.includes(lower)) return '系统保护目录，已拒绝'
    if (lower === homeLower) return '不允许删除用户主目录'
    return null
  }

  #appendHistory(entry: HistoryEntry): void {
    try {
      let list: HistoryEntry[] = []
      if (existsSync(this.#historyFile)) {
        const parsed: unknown = JSON.parse(readFileSync(this.#historyFile, 'utf8'))
        if (Array.isArray(parsed)) list = parsed as HistoryEntry[]
      }
      list.push(entry)
      if (list.length > HISTORY_LIMIT) list = list.slice(-HISTORY_LIMIT)
      writeFileAtomic(this.#historyFile, `${JSON.stringify(list, null, 2)}\n`)
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
 */
async function deletePaths(paths: string[], toRecycleBin: boolean): Promise<CleanFailure[]> {
  const listFile = join(app.getPath('temp'), `ops-cabin-clean-${Date.now()}.txt`)
  writeFileSync(listFile, paths.join('\n'), 'utf8')

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
    `$paths = Get-Content -LiteralPath '${listFile}' -Encoding UTF8`,
    'foreach ($p in $paths) {',
    '  if ([string]::IsNullOrWhiteSpace($p)) { continue }',
    `  try { $code = [OpsCabinDelete]::Delete($p, $${toRecycleBin ? 'true' : 'false'}) } catch { $code = -1 }`,
    "  if ($code -eq 0) { Write-Output ('OK|' + $p) } else { Write-Output ('ERR' + $code + '|' + $p) }",
    '}'
  ].join('\n')

  let output = ''
  try {
    output = await runPowerShell(script, 120000)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return paths.map((p) => ({ path: p, error: `删除执行失败：${message}` }))
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
