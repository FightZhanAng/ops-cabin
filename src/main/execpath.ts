import { existsSync } from 'node:fs'

/*
 * 可执行路径解析与校验 —— 开机自启清单与计划任务清单共用。
 *
 * 两个采集器都在回答同一个问题：「这条记录指向的程序还在不在」。判错的代价不对称：
 * 漏报只是没提醒，误报会让用户去清一个其实正常的项 —— 而「残留/失效」这条判据的
 * 全部价值就在于不误报。所以裸命令名一律按有效处理。
 */

/**
 * 从命令行里解析出可执行文件路径。
 *
 * 分三种情况，顺序不能换：
 *   1. 带引号 —— 取引号内，这是最可靠的形态；
 *   2. 不带引号但含路径分隔符 —— 按空格逐段加长去试，命中真实存在的第一个前缀；
 *      直接取第一个空格前的内容会在 `C:\Program Files\...` 这种路径上切错；
 *   3. 裸命令名（无 `\`、无 `/`、无盘符）—— 走 PATH 解析，**一律视为有效**。
 *      把它标成失效会制造假警报，而「残留自启」这个判定的全部价值就在于不误报。
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

  // 逐段加长试存在性：命中即止，最多拼 5 段（够覆盖常见的长路径）
  let candidate = head
  if (existsSync(candidate)) return candidate
  for (let index = 1; index < Math.min(parts.length, 5); index++) {
    candidate = `${candidate} ${parts[index]}`
    if (existsSync(candidate)) return candidate
  }
  return head
}

/**
 * 路径是否有效。
 *
 * 裸命令名（`cmd.exe`、`powershell.exe` 这类）返回 true：它靠 PATH 解析，
 * 在这里判不了 —— 判成失效就是把正常的自启项/计划任务报成残留。
 * null（压根解析不出路径）算无效：调用方应把这种情况当成「不知道」而不是「正常」。
 */
export function isExecPathValid(path: string | null): boolean {
  if (path === null) return false
  const bare = !/[\\/]/.test(path) && !/^[A-Za-z]:/.test(path)
  if (bare) return true
  try {
    return existsSync(path)
  } catch {
    return false
  }
}
