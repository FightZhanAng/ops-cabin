import type { VolumeInfo } from '../shared/disk'
import { runPowerShell } from './powershell'

/**
 * 列出本机文件系统盘（固定盘 / 可移动盘 / 映射盘）。
 * 数据源 Get-PSDrive：Used/Free 单位是字节；没有容量信息的（光驱等）会被跳过。
 */
export async function listVolumes(): Promise<VolumeInfo[]> {
  const script =
    'Get-PSDrive -PSProvider FileSystem | ForEach-Object { if ($_.Used -ne $null -and $_.Free -ne $null) { "{0}|{1}|{2}" -f $_.Name, $_.Used, $_.Free } }'
  const output = await runPowerShell(script, 15000)

  const volumes: VolumeInfo[] = []
  for (const line of output.split(/\r?\n/)) {
    const [name, usedRaw, freeRaw] = line.trim().split('|')
    if (!name || !/^[A-Za-z]$/.test(name)) continue
    const used = Number(usedRaw)
    const free = Number(freeRaw)
    if (!Number.isFinite(used) || !Number.isFinite(free) || used < 0 || free < 0) continue
    volumes.push({ name: `${name.toUpperCase()}:`, used, free, total: used + free })
  }
  return volumes.sort((a, b) => a.name.localeCompare(b.name))
}
