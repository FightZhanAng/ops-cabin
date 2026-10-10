import { spawn } from 'node:child_process'

/**
 * 跑一段 PowerShell 脚本并取回 stdout。
 *
 * 脚本用 -EncodedCommand（UTF-16LE base64）传入 —— 中文路径与特殊字符
 * 不会在命令行参数任何一层被转义搞坏；脚本内先切 UTF-8 输出编码，
 * 拿回的中文才不会变成乱码。全程无窗口、非交互。
 */
export function runPowerShell(script: string, timeoutMs = 20000): Promise<string> {
  return new Promise((resolve, reject) => {
    const wrapped = [
      '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
      script
    ].join('\n')
    const encoded = Buffer.from(wrapped, 'utf16le').toString('base64')

    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { windowsHide: true }
    )

    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill()
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
      reject(error)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve(stdout)
      else reject(new Error(stderr.trim() || `PowerShell 退出码 ${code}`))
    })
  })
}
