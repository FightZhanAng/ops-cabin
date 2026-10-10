import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import type { RiskLevel, ScanGroupKey } from '../../shared/disk'
import type { ResolvedTarget } from './protocol'

interface LocationDef {
  group: 'safe' | 'devCaches'
  label: string
  risk: RiskLevel
  /** 候选路径（支持 %ENV% 与 ~），取第一个存在的 */
  candidates: string[]
  note?: string
}

/*
 * 分级规则表 —— 「指哪扫哪」的固定位置清单，不做全盘盲扫。
 * 风险口径：safe = 删了会自动重建或重下成本低；careful = 重建成本高，需用户确认。
 */
const DEFINITIONS: LocationDef[] = [
  /* ---------------- 安全清理 ---------------- */
  { group: 'safe', label: '用户临时文件', risk: 'safe', candidates: ['%TEMP%'] },
  { group: 'safe', label: '系统临时文件', risk: 'safe', candidates: ['%SystemRoot%\\Temp'] },
  { group: 'safe', label: '崩溃转储', risk: 'safe', candidates: ['%LOCALAPPDATA%\\CrashDumps'] },
  {
    group: 'safe',
    label: '缩略图与图标缓存',
    risk: 'careful',
    candidates: ['%LOCALAPPDATA%\\Microsoft\\Windows\\Explorer'],
    note: '资源管理器会自动重建；清理时可能有文件正被占用'
  },

  /* ---------------- 开发缓存 ---------------- */
  { group: 'devCaches', label: 'npm 缓存', risk: 'safe', candidates: ['%LOCALAPPDATA%\\npm-cache'] },
  {
    group: 'devCaches',
    label: 'pnpm 存储',
    risk: 'safe',
    candidates: ['%LOCALAPPDATA%\\pnpm', '~/.pnpm-store']
  },
  { group: 'devCaches', label: 'pip 缓存', risk: 'safe', candidates: ['%LOCALAPPDATA%\\pip\\Cache'] },
  { group: 'devCaches', label: 'uv 缓存', risk: 'safe', candidates: ['%LOCALAPPDATA%\\uv\\cache'] },
  { group: 'devCaches', label: 'Yarn 缓存', risk: 'safe', candidates: ['%LOCALAPPDATA%\\Yarn\\Cache'] },
  {
    group: 'devCaches',
    label: 'Electron 下载缓存',
    risk: 'safe',
    candidates: ['%LOCALAPPDATA%\\electron\\Cache']
  },
  {
    group: 'devCaches',
    label: 'Cargo registry',
    risk: 'careful',
    candidates: ['~/.cargo/registry'],
    note: '清理后依赖需要重新下载与编译'
  },
  {
    group: 'devCaches',
    label: 'Go 模块缓存',
    risk: 'careful',
    candidates: ['~/go/pkg/mod'],
    note: '清理后依赖需要重新下载'
  },
  {
    group: 'devCaches',
    label: 'Gradle 缓存',
    risk: 'careful',
    candidates: ['~/.gradle/caches'],
    note: '清理后构建会重新下载依赖'
  },
  {
    group: 'devCaches',
    label: 'Maven 本地仓库',
    risk: 'careful',
    candidates: ['~/.m2/repository'],
    note: '清理后依赖需要重新下载'
  }
]

/** 大文件递归遍历时按目录名跳过的系统重地 / 噪音源 */
export const WALK_SKIP_DIRS = new Set([
  'windows',
  'program files',
  'program files (x86)',
  'programdata',
  '$recycle.bin',
  'system volume information',
  'recovery',
  'node_modules'
])

export const LARGE_FILE_MIN_BYTES = 100 * 1024 * 1024
export const LARGE_FILE_TOP_N = 100

/** %ENV% 与 ~ 展开；环境变量缺失时返回 null（该候选作废） */
export function expandPath(input: string): string | null {
  let out = input
  if (out === '~' || out.startsWith('~/') || out.startsWith('~\\')) {
    out = join(homedir(), out.slice(1))
  }
  let ok = true
  out = out.replace(/%([^%]+)%/g, (_match, name: string) => {
    const value = process.env[name]
    if (value === undefined) {
      ok = false
      return ''
    }
    return value
  })
  return ok ? out : null
}

/** 小写规范化（去尾部斜杠），用于白名单前缀比较 */
export function normalizeForCompare(input: string): string {
  return resolve(input).replace(/[\\/]+$/, '').toLowerCase()
}

/** 路径是否落在排除前缀内（含自身） */
export function isExcluded(pathValue: string, prefixes: string[]): boolean {
  const lower = pathValue.toLowerCase()
  for (const prefix of prefixes) {
    if (lower === prefix) return true
    if (lower.startsWith(`${prefix}\\`) || lower.startsWith(`${prefix}/`)) return true
  }
  return false
}

/** 按分组展开固定扫描位置（只返回真实存在的路径） */
export function resolveTargets(groups: ScanGroupKey[]): ResolvedTarget[] {
  const out: ResolvedTarget[] = []
  for (const def of DEFINITIONS) {
    if (!groups.includes(def.group)) continue
    for (const candidate of def.candidates) {
      const expanded = expandPath(candidate)
      if (!expanded || !existsSync(expanded)) continue
      out.push({ group: def.group, label: def.label, path: expanded, risk: def.risk, note: def.note })
      break
    }
  }
  return out
}
