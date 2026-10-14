import { spawn } from 'node:child_process'
import type { KillResult } from '../../shared/ports'

interface TaskkillResult {
  code: number
  output: string
}

/**
 * taskkill 的输出是 OEM 代码页（中文机器上是 GBK），按 UTF-8 解出来的中文全是乱码，
 * 「拒绝访问」和「找不到」就分不开。显式按 GBK 解码；英文系统上 GBK 解码对 ASCII
 * 无损，英文关键词照样匹配。与 autoapply.ts 的 runSchtasks 同一口径。
 */
function decodeConsole(buffer: Buffer): string {
  try {
    return new TextDecoder('gbk').decode(buffer)
  } catch {
    return buffer.toString('utf8')
  }
}

function runTaskkill(args: string[], timeoutMs = 8000): Promise<TaskkillResult> {
  return new Promise((resolve) => {
    const child = spawn('taskkill.exe', args, { windowsHide: true })
    const chunks: Buffer[] = []
    let settled = false
    const finish = (result: TaskkillResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }
    const timer = setTimeout(() => {
      child.kill()
      finish({ code: -1, output: 'taskkill 超时' })
    }, timeoutMs)
    child.stdout.on('data', (chunk: Buffer) => {
      chunks.push(chunk)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      chunks.push(chunk)
    })
    child.on('error', (error) => {
      finish({ code: -1, output: error.message })
    })
    child.on('close', (code) => {
      finish({ code: code ?? -1, output: decodeConsole(Buffer.concat(chunks)) })
    })
  })
}

/**
 * 进程是否还在。
 *
 * **只有 ESRCH 才算「已退出」**：Windows 上对没有权限打开的目标（SYSTEM / 服务 / PPL
 * 进程 —— 135、445、49664 这些端口的属主基本都是这类）`process.kill(pid, 0)` 抛的是
 * EPERM 而不是 ESRCH。早前把任何异常都当成「已退出」，于是非提权会话下点「结束进程」
 * 对这些进程**假报成功**：进程还在、端口还占着，界面却弹「已结束」。
 *
 * EPERM（及未知错误）一律按「还活着」处理 —— 让它继续走 /F 与失败分支，把真实原因报出来。
 */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

/** taskkill 明确说「找不到这个进程」 */
function reportsMissing(output: string): boolean {
  return /没有找到|not found|no such process/i.test(output)
}

/** taskkill 明确说「拒绝访问」—— 这才是真的权限不足 */
function reportsDenied(output: string): boolean {
  return /拒绝访问|access is denied/i.test(output)
}

/** 失败原因：能归类就归类成人话，归不了类才回落原始输出（截断，别糊一屏） */
function describeFailure(result: TaskkillResult): string {
  if (result.code === -1) return result.output
  if (reportsDenied(result.output)) return '权限不足（该进程受系统保护或属于其他用户）'
  if (reportsMissing(result.output)) return '进程已不存在'
  if (result.code === 0) return '进程未响应结束请求（可能正在退出，或受系统保护）'
  const text = result.output.trim().replace(/\s+/g, ' ')
  return text.length > 0 ? text.slice(0, 200) : `taskkill 退出码 ${result.code}`
}

/** 结束进程的两段等待与轮询间隔 */
const GRACEFUL_WAIT_MS = 1200
const FORCE_WAIT_MS = 1500
const POLL_MS = 60

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 等进程真的退出，退出就立刻返回。`timeoutMs` 为 0 时只查一次、不等。
 *
 * 早前这里是「固定睡 800ms 再看一眼」：绝大多数进程几十毫秒内就没了，用户却每次
 * 都要白等那 800ms（加上强制的 400ms，一次「结束进程」固定花掉 1.2 秒）；而
 * 真遇到退得慢的进程，800ms 又可能不够，于是被误判成「没退」而多挨一次 /F。
 * 等待时长因此挂在工作量上，而不是挂在真实状态上。
 *
 * 改成轮询后两头都对了：正常情况下立即返回，慢的情况下有更长的观察窗。
 * 轮询用的是 isAlive（进程是否还在），不看 taskkill 的输出。
 */
async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (!isAlive(pid)) return true
    if (Date.now() >= deadline) return false
    await sleep(POLL_MS)
  }
}

/**
 * 结束进程：先优雅（taskkill /PID，无窗口的进程通常不受理，无妨），
 * 限时内没退就强制 /F。
 *
 * 判定成功一律以「进程真的不在了」为准，不看 taskkill 的退出码 —— 反过来，
 * 失败时把真实原因带出来，用户才知道该怎么处理（提权运行 / 该进程受保护）。
 */
export async function killProcess(pid: number): Promise<KillResult> {
  // taskkill 说「找不到」不等于进程真的没了（可能只是没权限看到），一律以 isAlive 复核
  const graceful = await runTaskkill(['/PID', String(pid)])
  /*
   * 要不要等，由 taskkill 自己的答复决定 —— 这才是「挂在真实状态上」。
   *
   * 无窗口的控制台进程收到 WM_CLOSE 无处可送，taskkill 会明确回「只能强制终止」
   * 并带非 0 退出码：这种进程等多久都不会退，白等一场（实测固定等 1200ms 反而比
   * 原先的 800ms 更慢）。所以只有它**报了成功**时才进入等待窗；否则只瞬查一次，
   * 免得「进程恰好在收到请求的同时自己退了」被漏掉。
   */
  if (await waitForExit(pid, graceful.code === 0 ? GRACEFUL_WAIT_MS : 0)) {
    return { ok: true, forced: false }
  }

  const forced = await runTaskkill(['/F', '/PID', String(pid)])
  if (await waitForExit(pid, FORCE_WAIT_MS)) return { ok: true, forced: true }

  // 到这儿进程还活着。/F 的原因优先（它是最后一击）；说不清时回落到优雅那次的原因。
  const reason =
    reportsDenied(forced.output) || forced.code === 0
      ? describeFailure(forced)
      : describeFailure(graceful)
  return { ok: false, forced: true, error: `结束进程失败：${reason}` }
}
