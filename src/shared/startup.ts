import type { PathVerdict } from './types'

/** 启动项的来源位置 */
export type StartupSource =
  | 'registry-hkcu'
  | 'registry-hklm'
  | 'registry-hklm-wow'
  | 'folder-user'
  | 'folder-common'

/** 来源在界面上的名字（与本机语言无关，不读系统标签） */
export const STARTUP_SOURCE_LABEL: Record<StartupSource, string> = {
  'registry-hkcu': '注册表 · 当前用户',
  'registry-hklm': '注册表 · 本机',
  'registry-hklm-wow': '注册表 · 本机 32 位',
  'folder-user': '启动文件夹 · 当前用户',
  'folder-common': '启动文件夹 · 公共'
}

/** 一条开机自启项 */
export interface StartupItem {
  /** 稳定标识：来源 + 值名（或文件名）—— 注册表值名在同一来源内唯一 */
  id: string
  /** 界面显示名 */
  name: string
  source: StartupSource
  /** 注册表值名 / 启动文件夹里的文件名 */
  entryName: string
  /** 命令行原文（注册表值，或 .lnk 的完整路径） */
  command: string
  /** 从命令行里解析出的可执行文件路径；解析不出为 null */
  path: string | null
  /**
   * 路径判定结果（存在 / 确认不存在 / 判不了）。
   *
   * 这是本页最有用的一列：卸载软件时经常只删程序、忘了删自启项，
   * 于是每次开机都白白跑一次「找不到文件」。
   *
   * 三态而不是布尔：它同时是「删除登记」的闸门（删除不可逆），所以「确证不存在」
   * 与「判不了」必须分开 —— 拿不到不等于不存在，判不了就不该给删除入口。
   */
  pathVerdict: PathVerdict
  /**
   * 路径是否可用（兼容既有消费点的布尔投影）。
   *
   * 语义：`true` = 路径在**或判不了**（按有效算）；`false` = **确证不存在**。
   * 即恒等于 `pathVerdict !== 'missing'`。判断「能不能删」请直接用 `pathVerdict`，
   * 不要用这个布尔 —— 它把「判不了」并进了「有效」这一侧。
   */
  pathExists: boolean
  /**
   * 是否被任务管理器禁用过（`StartupApproved` 里的启用位）。
   *
   * 不读这个位就会把已经禁掉的自启项继续当成「每次开机都在跑」，
   * 用户会去清一个根本不在跑的项。缺省（字段不存在）= 启用。
   */
  disabled?: boolean
}

export interface StartupReport {
  at: number
  items: StartupItem[]
  /**
   * 残留自启条数：**启用中**且路径不存在（或解析不出）的项。
   *
   * 刻意不含已禁用的项 —— 禁用的项路径丢了也无害，把它算进去会让这个
   * 数字虚高，而用户会照着这个数字去清理，清完发现没变化。
   */
  invalid: number
  /** 按来源分组的条数（界面分组标题用） */
  bySource: Record<StartupSource, number>
  durationMs: number
  /** 有来源读取失败时为 true（降级但可用） */
  degraded: boolean
  /** 整次采集失败时的人话原因（此时 items 为空） */
  error?: string
}
