import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/*
 * PowerShell 调用方式有两条路，按脚本长度自动选：
 *
 *   -EncodedCommand（默认）：脚本经 UTF-16LE base64 传参。中文路径与特殊字符不会在
 *     命令行任何一层被转义搞坏，也不落任何临时文件。
 *
 *   脚本文件 + -File（超长时）：整条命令行在 Windows 上有 32767 字符硬上限，而
 *     base64 是脚本字节数的 2.67 倍（UTF-16 再 ×2）—— 实测一段 11.3 KB 的清理脚本
 *     编码后已经吃掉 92% 的额度，再加几行就会被 CreateProcess 拒掉，报的是很难看懂的
 *     `spawn ENAMETOOLONG`，而用户看到的是"清理失败"。所以超过阈值就改写临时脚本文件。
 */

/** 超过这个长度就不走 -EncodedCommand（留出 exe 路径与其它参数的余量） */
const ENCODED_COMMAND_MAX_CHARS = 10000

/**
 * 跑一段 PowerShell 脚本并取回 stdout。
 *
 * `env` 用于把**动态数据**送进脚本（例如待删除路径的清单文件位置）：
 * 走环境变量而不是拼脚本源码，路径里的引号/分号中文都破坏不了脚本。
 */
export function runPowerShell(
  script: string,
  timeoutMs = 20000,
  env?: Record<string, string>
): Promise<string> {
  return new Promise((resolve, reject) => {
    const wrapped = [
      '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
      script
    ].join('\n')

    let scriptFile: string | null = null
    let args: string[]
    if (wrapped.length <= ENCODED_COMMAND_MAX_CHARS) {
      const encoded = Buffer.from(wrapped, 'utf16le').toString('base64')
      args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded]
    } else {
      // 写 UTF-8 BOM：Windows PowerShell 5.1 与 7.x 都能正确识别脚本编码，
      // 不带 BOM 时 5.1 会按 ANSI 解读，中文注释/字符串会乱码。
      scriptFile = join(
        // 系统临时目录：与清理清单同一处，避免跨盘与权限差异
        tmpdir(),
        `ops-cabin-ps-${Date.now()}-${randomBytes(4).toString('hex')}.ps1`
      )
      try {
        writeFileSync(scriptFile, `\uFEFF${wrapped}`, 'utf8')
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)))
        return
      }
      args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptFile]
    }

    const child = spawn('powershell.exe', args, {
      windowsHide: true,
      ...(env !== undefined ? { env: { ...process.env, ...env } } : {})
    })

    let stdout = ''
    let stderr = ''
    let settled = false
    const cleanup = (): void => {
      if (scriptFile === null) return
      try {
        rmSync(scriptFile, { force: true })
      } catch {
        /* 临时脚本删不掉不影响结果 */
      }
      scriptFile = null
    }
    const timer = setTimeout(() => {
      child.kill()
      settled = true
      cleanup()
      reject(new Error(`PowerShell 超时（${timeoutMs}ms）`))
    }, timeoutMs)

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      cleanup()
      reject(error)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      cleanup()
      if (settled) return
      if (code === 0) resolve(stdout)
      else reject(new Error(stderr.trim() || `PowerShell 退出码 ${code}`))
    })
  })
}
