import { statfs } from 'node:fs/promises'
import type { VolumeInfo } from '../shared/disk'
import { runPowerShell } from './powershell'

/** 单块盘的探测超时：断开的映射盘不该拖住整次读取 */
const PER_DRIVE_TIMEOUT_MS = 1500

/**
 * 快路径：fs.statfs 逐盘探测（毫秒级）。
 * 数值语义与 Get-PSDrive 一致（total/free 同源 GetDiskFreeSpaceEx），缺盘 ENOENT 直接跳过。
 */
async function listVolumesFast(): Promise<VolumeInfo[]> {
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('')
  const results = await Promise.all(
    letters.map(async (letter): Promise<VolumeInfo | null> => {
      const probe = statfs(`${letter}:/`)
      probe.catch(() => null) // 超时落败后的迟到拒绝不应冒泡成 unhandledRejection
      try {
        const stats = await Promise.race([
          probe,
          new Promise<never>((_resolve, reject) => {
            setTimeout(() => reject(new Error('statfs 超时')), PER_DRIVE_TIMEOUT_MS).unref()
          })
        ])
        const total = stats.bsize * stats.blocks
        const free = stats.bsize * stats.bavail
        if (!Number.isFinite(total) || !Number.isFinite(free) || total <= 0 || free < 0) {
          return null
        }
        return { name: `${letter}:`, used: total - free, free, total }
      } catch {
        return null
      }
    })
  )
  return results
    .filter((volume): volume is VolumeInfo => volume !== null)
    .sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * 回退路径：Get-PSDrive（固定盘 / 可移动盘 / 映射盘）。
 * Used/Free 单位是字节；没有容量信息的（光驱等）会被跳过。
 */
async function listVolumesViaPowerShell(): Promise<VolumeInfo[]> {
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

/**
 * 列出本机文件系统盘（固定盘 / 可移动盘 / 映射盘）。
 *
 * 先走 statfs 快路径（毫秒级）：PowerShell 冷启动要 1–2 秒，会让分区数据在
 * 首屏姗姗来迟。只有当快路径一块盘都没拿到（异常环境）时才回退 PowerShell。
 */
export async function listVolumes(): Promise<VolumeInfo[]> {
  const fast = await listVolumesFast()
  if (fast.length > 0) return fast
  return listVolumesViaPowerShell()
}
