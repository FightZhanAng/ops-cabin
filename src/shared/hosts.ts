/** 一条 hosts 条目的判定类型 */
export type HostsFlagKind =
  /** 指向本机（127.x / ::1）—— 域名被劫到本机，后面通不通全由本地服务决定 */
  | 'loopback'
  /** 指向黑洞地址（0.0.0.0 / ::）—— 广告拦截的常见手法，域名直接不可达 */
  | 'null'
  /** 命中发布链路域名，但指向的是别的真实地址 */
  | 'other'

/** 一条被判定为「改写过」的 hosts 条目 */
export interface HostsFlag {
  /** 文件里的行号（从 1 开始，方便用户去改） */
  line: number
  ip: string
  hostname: string
  kind: HostsFlagKind
  /** 是否命中内置的发布链路域名清单（github.com / npm 源等） */
  watched: boolean
}

export interface HostsReport {
  path: string
  exists: boolean
  readable: boolean
  /** 文件总行数（含注释与空行） */
  totalLines: number
  /** 生效条目数（去掉注释与空行之后） */
  entries: number
  /** 其中属于系统默认的 localhost 家族行数（不算异常） */
  defaults: number
  flags: HostsFlag[]
  /** flags 被截断时，未列出的条数（广告拦截清单动辄几千条） */
  omitted: number
  /** 文件最后修改时间（Unix 毫秒），读不到为 null */
  modifiedAt: number | null
  /** 读不到时的人话原因 */
  error?: string
}
