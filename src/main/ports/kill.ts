import { spawn } from 'node:child_process'
import type { KillResult } from '../../shared/ports'

interface TaskkillResult {
  code: number
  output: string
}

function runTaskkill(args: string[], timeoutMs = 8000): Promise<TaskkillResult> {
  return new Promise((resolve) => {
    const child = spawn('taskkill.exe', args, { windowsHide: true })
    let output = ''
    const timer = setTimeout(() => {
      child.kill()
      resolve({ code: -1, output: 'taskkill 超时' })
    }, timeoutMs)
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8')
    })
    child.stderr.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8')
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({ code: -1, output: error.message })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code: code ?? -1, output })
    })
  })
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * 结束进程：先优雅（taskkill /PID，无窗口的进程通常不受理，无妨），
 * 800ms 内没退就强制 /F。失败原因用统一文案 —— taskkill 的原文
 * 是系统编码的中文，直接透出会乱码，也不适合展示给用户。
 */
export async function killProcess(pid: number): Promise<KillResult> {
  await runTaskkill(['/PID', String(pid)])
  await new Promise((resolve) => setTimeout(resolve, 800))
  if (!isAlive(pid)) return { ok: true, forced: false }

  await runTaskkill(['/F', '/PID', String(pid)])
  await new Promise((resolve) => setTimeout(resolve, 400))
  if (!isAlive(pid)) return { ok: true, forced: true }

  return { ok: false, forced: true, error: '结束进程失败：可能权限不足或进程受系统保护' }
}
