import { statSync } from 'node:fs'
import type { PathVerdict } from '../shared/types'

/*
 * 可执行路径解析与校验 —— 开机自启清单与计划任务清单共用。
 *
 * 两个采集器都在回答同一个问题：「这条记录指向的程序还在不在」。判错的代价不对称：
 * 漏报只是没提醒，误报会让用户去清一个其实正常的项 —— 而「残留/失效」这条判据的
 * 全部价值就在于不误报。
 *
 * 更要紧的是：**这个判据同时是「删除登记」的闸门**（启动项删自启登记、计划任务删
 * 任务定义，都不可逆）。所以这里返回三态而不是布尔 —— 「确证不存在」与「判不了」
 * 必须分开，否则一次解析失误就直接解锁一次不可逆删除。见 execPathVerdict。
 */

/** 单独抽出来：解析时逐段试探要区分「文件」与「目录」，判定时还要区分「不存在」与「读不到」 */
function probeKind(target: string): 'file' | 'dir' | 'none' | 'unknown' {
  try {
    const stat = statSync(target)
    if (stat.isFile()) return 'file'
    if (stat.isDirectory()) return 'dir'
    return 'unknown'
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    // 只有这两种是「确证不存在」；EPERM / EACCES / ELOOP 等一律算「读不到」
    if (code === 'ENOENT' || code === 'ENOTDIR') return 'none'
    return 'unknown'
  }
}

/**
 * 从命令行里解析出可执行文件路径。
 *
 * 分三种情况，顺序不能换：
 *   1. 带引号 —— 取引号内，这是最可靠的形态；
 *   2. 不带引号但含路径分隔符 —— 按空格**试遍所有切分点**，优先命中真实文件；
 *      直接取第一个空格前的内容会在 `C:\Program Files\...` 这种路径上切错。
 *   3. 裸命令名（无 `\`、无 `/`、无盘符）—— 走 PATH 解析，**一律视为判不了**。
 *      把它标成失效会制造假警报，而「残留自启」这个判定的全部价值就在于不误报。
 *
 * 两条刻意的设计（都是为了避免「误判失效 → 解锁不可逆删除」）：
 *
 *   · **不设段数上限。** 早前写死 `Math.min(parts.length, 5)`，于是「Start Menu」这类
 *     自带空格的路径 + 含空格的文件名一旦凑够 6 段就永远拼不到完整路径，函数退回
 *     截断片段 → 被判失效 → 界面出现「删除」按钮。而删除用的是 command 原文
 *     （buildDeleteFileScript 传的是 item.command），于是**判错的是存在性、动手删的
 *     却是真实路径**。试遍所有切分点之后，「整串不是文件」才真的等于「程序不在了」。
 *   · **读不到的候选优先返回。** 只要有任何切分点抛的是 EPERM / EACCES 这类
 *     「拿不到」而不是「不存在」，就返回那个候选，让 execPathVerdict 归为 unknown
 *     —— 拿不到不等于不存在，不能拿它去解锁删除。
 */
export function parseExecPath(command: string): string | null {
  const text = command.trim()
  if (text.length === 0) return null

  if (text.startsWith('"')) {
    const end = text.indexOf('"', 1)
    return end > 1 ? text.slice(1, end) : null
  }

  const parts = text.split(/\s+/).filter((part) => part.length > 0)
  const head = parts[0]
  if (head === undefined) return null

  const looksLikePath = /[\\/]/.test(head) || /^[A-Za-z]:/.test(head)
  if (!looksLikePath) return head

  let candidate = head
  let unreadable: string | null = null
  let wholeIsDir: string | null = null
  for (let index = 0; index < parts.length; index++) {
    if (index > 0) candidate = `${candidate} ${parts[index]}`
    const kind = probeKind(candidate)
    // 命中真实文件即止 —— 这是唯一能确证「程序在」的形态
    if (kind === 'file') return candidate
    if (kind === 'unknown' && unreadable === null) unreadable = candidate
    // 整串（不含参数时）本身是个目录：命令指向目录，判不出程序在不在
    if (kind === 'dir' && index === parts.length - 1) wholeIsDir = candidate
  }

  // 试遍所有切分点都没有文件命中。按「判不了」优先：
  //   整串是目录 → 命令指向目录，不是可执行文件；
  //   有读不到的候选 → EPERM/EACCES 不等于不存在；
  //   否则 → 返回 head（它的真实形态决定结论：head 不存在即 missing，head 是目录即 unknown）。
  return wholeIsDir ?? unreadable ?? head
}

/**
 * 判定一个解析出来的路径：它指向的程序还在不在。
 *
 * `missing` 只在**确证不存在**时给出，而只有这一态能解锁删除登记：
 *   · 解析不出路径（null）→ unknown：判不了的事不能当成「失效」（CONTEXT.md 明确定义）；
 *   · 裸命令名 → unknown：靠 PATH 解析，这里判不了；
 *   · 命中目录 → unknown：命令行里那个真实文件没拼出来，不代表东西没了；
 *   · EPERM / EACCES 等读不到 → unknown：**拿不到不等于不存在**；
 *   · 只有 ENOENT / ENOTDIR → missing。
 */
export function execPathVerdict(path: string | null): PathVerdict {
  if (path === null) return 'unknown'
  const bare = !/[\\/]/.test(path) && !/^[A-Za-z]:/.test(path)
  if (bare) return 'unknown'
  const kind = probeKind(path)
  if (kind === 'file') return 'exists'
  if (kind === 'none') return 'missing'
  // dir / unknown：指向的是个目录，或者压根读不到 —— 都判不了
  return 'unknown'
}

/**
 * 「这个可执行文件算不算有效」。
 *
 * 口径是**只有确证不存在才算无效** —— 判不了的按有效处理：报假失效比漏报危险得多，
 * 因为假失效会给出删除入口。判不了的条目在界面上显示为正常，这是刻意的取舍。
 */
export function isExecPathValid(path: string | null): boolean {
  return execPathVerdict(path) !== 'missing'
}
