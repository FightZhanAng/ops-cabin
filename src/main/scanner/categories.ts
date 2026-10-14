import { existsSync, readdirSync } from 'node:fs'
import type { Dirent } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import type { RiskLevel, ScanGroupKey } from '../../shared/disk'
import type { ResolvedTarget } from './protocol'

interface LocationDef {
  group: 'safe' | 'devCaches'
  label: string
  risk: RiskLevel
  /**
   * 候选路径（支持 %ENV% 与 ~），取第一个存在的。
   * 路径里允许出现一段 `*`（profile / 多实例目录）：命中的每个目录各自成条目，
   * 条目名是 `label · 目录名`。
   */
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

  /* 浏览器缓存与着色器缓存（低风险：自动重建 / 重新下载；运行中的浏览器会锁住部分文件） */
  {
    group: 'safe',
    label: 'Chrome 网页缓存',
    risk: 'safe',
    candidates: ['%LOCALAPPDATA%\\Google\\Chrome\\User Data\\*\\Cache'],
    note: '浏览器会自动重建；正在运行的浏览器可能锁住部分文件，登录状态不受影响'
  },
  {
    group: 'safe',
    label: 'Chrome 代码缓存',
    risk: 'safe',
    candidates: ['%LOCALAPPDATA%\\Google\\Chrome\\User Data\\*\\Code Cache'],
    note: '浏览器会自动重建；正在运行的浏览器可能锁住部分文件'
  },
  {
    group: 'safe',
    label: 'Chrome GPU 缓存',
    risk: 'safe',
    candidates: ['%LOCALAPPDATA%\\Google\\Chrome\\User Data\\*\\GPUCache'],
    note: '浏览器会自动重建；正在运行的浏览器可能锁住部分文件'
  },
  {
    group: 'safe',
    label: 'Edge 网页缓存',
    risk: 'safe',
    candidates: ['%LOCALAPPDATA%\\Microsoft\\Edge\\User Data\\*\\Cache'],
    note: '浏览器会自动重建；正在运行的浏览器可能锁住部分文件，登录状态不受影响'
  },
  {
    group: 'safe',
    label: 'Edge 代码缓存',
    risk: 'safe',
    candidates: ['%LOCALAPPDATA%\\Microsoft\\Edge\\User Data\\*\\Code Cache'],
    note: '浏览器会自动重建；正在运行的浏览器可能锁住部分文件'
  },
  {
    group: 'safe',
    label: 'Edge GPU 缓存',
    risk: 'safe',
    candidates: ['%LOCALAPPDATA%\\Microsoft\\Edge\\User Data\\*\\GPUCache'],
    note: '浏览器会自动重建；正在运行的浏览器可能锁住部分文件'
  },
  {
    group: 'safe',
    label: 'DirectX 着色器缓存',
    risk: 'safe',
    candidates: ['%LOCALAPPDATA%\\D3DSCache'],
    note: '游戏与应用会按需重新编译着色器'
  },
  {
    group: 'safe',
    label: 'NVIDIA DX 着色器缓存',
    risk: 'safe',
    candidates: ['%LOCALAPPDATA%\\NVIDIA\\DXCache'],
    note: '游戏与应用会按需重新编译着色器'
  },
  {
    group: 'safe',
    label: 'NVIDIA GL 着色器缓存',
    risk: 'safe',
    candidates: ['%LOCALAPPDATA%\\NVIDIA\\GLCache'],
    note: '游戏与应用会按需重新编译着色器'
  },

  /* ---------------- 开发缓存 ---------------- */
  { group: 'devCaches', label: 'npm 缓存', risk: 'safe', candidates: ['%LOCALAPPDATA%\\npm-cache'] },
  {
    group: 'devCaches',
    label: 'pnpm 存储',
    risk: 'safe',
    // 只指向 store 本身，**不要**指 %LOCALAPPDATA%\pnpm 这个父目录：
    // 那里除了 store 还放着 .tools（pnpm 自带的 node 等工具链）与 _tmp_ 临时目录，
    // 整个删掉会把 pnpm 自己的工具链一起清掉，而条目标注只承诺清理「存储」。
    // 真实 store 位置随配置而变（本机实测 pnpm store path = D:\.pnpm-store\v10），
    // 这里覆盖默认布局下的两个常见位置。
    candidates: [
      '%LOCALAPPDATA%\\pnpm\\store',
      '%LOCALAPPDATA%\\pnpm-store',
      '~/.pnpm-store'
    ]
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
    label: 'VS Code 缓存',
    risk: 'safe',
    candidates: ['%APPDATA%\\Code\\Cache'],
    note: 'VS Code 会自动重建；扩展与设置不受影响'
  },
  {
    group: 'devCaches',
    label: 'VS Code 数据缓存',
    risk: 'safe',
    candidates: ['%APPDATA%\\Code\\CachedData'],
    note: 'VS Code 会自动重建；扩展与设置不受影响'
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

/**
 * 路径是否落在排除前缀内（含自身）。
 *
 * 只判「自身」与「后代」—— 调用方若需要「祖先」语义（候选目录**包含**受保护
 * 目录），用 coversExcluded。
 */
export function isExcluded(pathValue: string, prefixes: string[]): boolean {
  const lower = pathValue.toLowerCase()
  for (const prefix of prefixes) {
    if (lower === prefix) return true
    if (lower.startsWith(`${prefix}\\`) || lower.startsWith(`${prefix}/`)) return true
  }
  return false
}

/** 两个已规范化的路径是否相等或是其祖先（严格包含） */
function isAncestorOf(ancestor: string, descendant: string): boolean {
  return (
    ancestor !== descendant &&
    (descendant.startsWith(`${ancestor}\\`) || descendant.startsWith(`${ancestor}/`))
  )
}

/**
 * 这个候选路径是否**覆盖**了某个受保护目录（即白名单目录在它之下）。
 *
 * 为什么需要单独一条：`%TEMP%` 这种整目录候选，删的时候是 `FO_DELETE` 递归删
 * 整个目录 —— 用户在 `%TEMP%\keep` 上设的白名单会被连父目录一起删掉。而扫描端
 * 在测体积时**已经**跳过了白名单子树（worker 的 walk），于是「预计释放」把
 * 受保护目录排除在外、删除却把它一起删了：**度量范围小于覆盖范围**。
 *
 * 调用方见到 true 时应剔除该候选（或至少明确告知用户），不能照删。
 */
export function coversExcluded(pathValue: string, prefixes: string[]): boolean {
  const lower = normalizeForCompare(pathValue)
  for (const prefix of prefixes) {
    if (prefix.length === 0) continue
    if (isAncestorOf(lower, prefix)) return true
  }
  return false
}

/**
 * 展开一个候选路径。
 *
 * 不带 `*`：存在即返回单个结果（旧语义）。
 * 带一段 `*`（profile / 多实例目录）：以星号前的部分为基目录枚举子目录，
 * 每个命中的目录各自成一条 —— 条目名带目录名后缀，多 profile 一眼分得清。
 * 只支持一段星号：需要的是 profile 枚举，不是通用 glob。
 */
function expandCandidate(candidate: string): { path: string; suffix?: string }[] {
  const expanded = expandPath(candidate)
  if (!expanded) return []
  const star = expanded.indexOf('*')
  if (star < 0) return existsSync(expanded) ? [{ path: expanded }] : []

  const base = expanded.slice(0, star).replace(/[\\/]+$/, '')
  const tail = expanded
    .slice(star + 1)
    .split(/[\\/]+/)
    .filter((segment) => segment.length > 0)
  if (base.length === 0 || !existsSync(base)) return []

  let entries: Dirent<string>[]
  try {
    entries = readdirSync(base, { withFileTypes: true })
  } catch {
    return []
  }
  const out: { path: string; suffix?: string }[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const path = join(base, entry.name, ...tail)
    if (existsSync(path)) out.push({ path, suffix: entry.name })
  }
  out.sort((a, b) => a.path.localeCompare(b.path))
  return out
}

/** 按分组展开固定扫描位置（只返回真实存在的路径；通配候选按目录各自成条目） */
export function resolveTargets(groups: ScanGroupKey[]): ResolvedTarget[] {
  const out: ResolvedTarget[] = []
  for (const def of DEFINITIONS) {
    if (!groups.includes(def.group)) continue
    for (const candidate of def.candidates) {
      const matches = expandCandidate(candidate)
      if (matches.length === 0) continue
      for (const match of matches) {
        out.push({
          group: def.group,
          label: match.suffix !== undefined ? `${def.label} · ${match.suffix}` : def.label,
          path: match.path,
          risk: def.risk,
          note: def.note
        })
      }
      // 候选是 fallback 语义：命中一个候选就不再试后面的（同旧行为）
      break
    }
  }
  return out
}
