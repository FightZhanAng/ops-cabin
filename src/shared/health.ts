/*
 * 系统体检的共享类型与枚举映射。
 *
 * 这些枚举值全部取自本机的定义文件 `Storage.types.ps1xml`（`Get-PhysicalDisk` /
 * `Get-Disk` 渲染名字用的就是这一段），不是照文档默写的 —— 采集走的是底层 CIM 类
 * `MSFT_PhysicalDisk`（本机 1.07s，比 `Get-PhysicalDisk` 的 4.73s 快 4 倍），
 * 它只给裸数字，映射必须自己带。
 *
 * 提取时踩过的两个坑，写在这里免得下次重犯：
 *   1. `Storage.types.ps1xml` 里有 18 个类各自带一份 `OperationalStatus`，而且
 *      **内容不一样**：`MSFT_Disk` 是 53264=Online 那套，`MSFT_VirtualDisk` 是
 *      53252=Failed Media 那套，`MSFT_PhysicalDisk` 又是另一套。抓错属主就等于
 *      把别的类的码表贴到这块盘上。下面四张表都只认 `MSFT_PhysicalDisk` 那一段
 *      （本机第 689 / 757 / 770 / 856 行）。
 *   2. 用正则从 ps1xml 里抠 switch 时，正则必须写在 PowerShell 的**单引号**字符串里 ——
 *      双引号里 `$_status` 会被当变量展开成空串，正则静默失配、结果全是 0 项，
 *      看起来像「本机没有这张表」。
 */

/* ------------------------------------------------------------ 待重启 */

/**
 * 三处独立的「要不要重启」标记。
 *
 * 分开列而不是合成一个布尔：三者的含义完全不同，用户看到的应该是
 * 「哪件事在等重启」，而不是一个没有下文的「需要重启」。
 */
export type RebootSource = 'cbs' | 'windows-update' | 'file-rename'

/**
 * 这一项的性质。
 *
 * `required` 与 `advisory` 的区分是本页最要紧的一条口径。
 * 前两处（CBS / Windows 更新）是 **Windows 自己写的「必须重启」标记**，
 * 用户该看到「要求重启」。第三处 `PendingFileRenameOperations` 常被当成
 * 「要求重启」来用，但**它不是** —— 详见 file-rename 那段的说明。
 */
export type RebootLevel = 'required' | 'advisory' | 'clear'

export const REBOOT_SOURCE_LABEL: Record<RebootSource, string> = {
  cbs: '组件服务（CBS）',
  'windows-update': 'Windows 更新',
  'file-rename': '重启时待处理的文件'
}

export const REBOOT_SOURCE_NOTE: Record<RebootSource, string> = {
  cbs: '系统装了一个组件更新，要重启才能收尾',
  'windows-update': 'Windows 更新在等一次重启',
  /*
   * 为什么这一项永远不算「要求重启」：
   *
   * 实测本机 24 个槽位（= 12 条操作，配对里的空串是「目标为空」即删除）里，
   * 实打实只有 6 个文件，而 `.atrust.running` 被登记了 **3 次**、`force_show`
   * **3 次** —— 同一个操作重复登记，说明写队列的人（Sangfor aTrust、腾讯 TAO、
   * 以及三个 `~$Kvp` 临时文件）根本没把这个队列当成重启要求，只是用
   * `MoveFileEx(MOVEFILE_DELAY_UNTIL_REBOOT)` 排了个「下次开机顺手删」。
   * 按「有 N 条待替换文件 ⇒ 要求重启」报警，等于叫用户白重启一次。
   */
  'file-rename': '应用自己排的「下次开机顺手删」队列 —— 它本身不是重启要求'
}

export const REBOOT_LEVEL_TEXT: Record<RebootLevel, string> = {
  required: '要求重启',
  advisory: '不必为此重启',
  clear: '无'
}

export interface RebootCheck {
  source: RebootSource
  level: RebootLevel
  /** 一句话说明（例如「6 个文件排队」）；没有就是 null */
  detail: string | null
  /** file-rename 专属：排队的文件路径样本（最多 5 条），其它来源为空数组 */
  paths: string[]
}

/* ------------------------------------------------------------ 事件日志 */

/** 按来源聚合的一行（同一个来源反复报，比「到处都在报」更容易定位） */
export interface LogProvider {
  name: string
  count: number
  lastAt: number | null
  lastId: number | null
  /** 最近一条的消息摘要（原文，已压平换行） */
  sample: string | null
}

export interface HealthLog {
  logName: string
  /** 统计窗口（天）——界面必须写出来，否则「16 条」没有意义 */
  windowDays: number
  total: number
  /**
   * 条数被采集上限截断了。
   *
   * 真时 `total` 是「至少这么多」，界面要按 `≥` 呈现 —— 一台日志刷屏的机器
   * 能在一个窗口里堆出几十万条，不设上限会把采集拖垮，但设了上限还报精确值
   * 就是在说谎。
   */
  truncated: boolean
  providers: LogProvider[]
  /** 读取异常时的人话原因（此时 total 通常为 0） */
  error?: string
}

/** 意外关机 / 断电 / 蓝屏这类非正常关机（System 日志里的 Kernel-Power 41 与 EventLog 6008） */
export interface CrashEvent {
  at: number
  source: string
  id: number
  /** 事件原文摘要 —— 用系统自己的话，不自己编解释 */
  message: string
}

/* ------------------------------------------------------------ 磁盘 */

/**
 * `MSFT_PhysicalDisk.HealthStatus`（ps1xml 里 0/1/2/5 四档 + Default→Unknown）。
 *
 * 这里是**唯一**给健康档下判断的地方，所以四个值的映射逐条对本机定义文件核过。
 */
export const DISK_HEALTH_LABEL: Record<number, string> = {
  0: '健康',
  1: '警告',
  2: '不健康',
  5: '未知'
}

/** `MSFT_PhysicalDisk.MediaType`（0 官方叫 Unspecified —— 是「没填」，不是「读不出来」） */
export const DISK_MEDIA_LABEL: Record<number, string> = {
  0: '未指定',
  3: '机械硬盘',
  4: '固态硬盘',
  5: '存储级内存'
}

/** `MSFT_PhysicalDisk.BusType`（术语本身是专有名词，保持原文） */
export const DISK_BUS_LABEL: Record<number, string> = {
  0: 'Unknown',
  1: 'SCSI',
  2: 'ATAPI',
  3: 'ATA',
  4: '1394',
  5: 'SSA',
  6: 'Fibre Channel',
  7: 'USB',
  8: 'RAID',
  9: 'iSCSI',
  10: 'SAS',
  11: 'SATA',
  12: 'SD',
  13: 'MMC',
  14: 'Virtual',
  15: 'File Backed Virtual',
  16: 'Spaces',
  17: 'NVMe',
  18: 'SCM',
  19: 'UFS'
}

/**
 * `MSFT_PhysicalDisk.OperationalStatus`（数组，可能出现多个）。
 *
 * 表是从本机 `Storage.types.ps1xml` 第 689 行那一段**整段抄下来**的 34 项，
 * 注意 `11` 官方写的就是「In Service」（带空格），`53276/53277/53285/53286`
 * 官方写法尾部**没有**空格 —— 原样保留，不做「顺手统一」。
 */
export const DISK_OPERATIONAL_LABEL: Record<number, string> = {
  1: 'Other',
  2: 'OK',
  3: 'Degraded',
  4: 'Stressed',
  5: 'Predictive Failure',
  6: 'Error',
  7: 'Non-Recoverable Error',
  8: 'Starting',
  9: 'Stopping',
  10: 'Stopped',
  11: 'In Service',
  12: 'No Contact',
  13: 'Lost Communication',
  14: 'Aborted',
  15: 'Dormant',
  16: 'Supporting Entity in Error',
  17: 'Completed',
  18: 'Power Mode',
  19: 'Relocating',
  53252: 'Failed Media',
  53253: 'Split',
  53254: 'Stale Metadata',
  53255: 'IO Error',
  53256: 'Unrecognized Metadata',
  53269: 'Removing From Pool',
  53270: 'In Maintenance Mode',
  53271: 'Updating Firmware',
  53272: 'Device Hardware Error',
  53273: 'Not Usable',
  53274: 'Transient Error',
  53276: 'Starting Maintenance Mode',
  53277: 'Stopping Maintenance Mode',
  53285: 'Threshold Exceeded',
  53286: 'Abnormal Latency'
}

/**
 * 认不出的枚举值：显示原始数字，绝不猜一个名字出来。
 *
 * 这里刻意**不照抄** Windows 自己的行为。ps1xml 里每个 switch 都带
 * `Default { ... "Unknown" }`，但 `OperationalStatus` 那一段的 Default 分支
 * 写的是 `Default { "Unknown" }` —— 没有 `+=`，结果被丢进管道，`$_status`
 * 什么都没有，最后渲染出一个**空字符串**（这是微软自己文件里的笔误）。
 * 换成我们这边的取舍：`原始值 53299` 虽然不好看，但用户拿着这个数字能搜到东西；
 * 「Unknown」是条死路。
 */
function lookup(table: Record<number, string>, code: number | null): string | null {
  if (code === null) return null
  return table[code] ?? `原始值 ${code}`
}

export function diskHealthText(code: number | null): string | null {
  return lookup(DISK_HEALTH_LABEL, code)
}

export function diskMediaText(code: number | null): string | null {
  return lookup(DISK_MEDIA_LABEL, code)
}

export function diskBusText(code: number | null): string | null {
  return lookup(DISK_BUS_LABEL, code)
}

export function diskOperationalText(codes: number[]): string | null {
  if (codes.length === 0) return null
  return codes.map((code) => lookup(DISK_OPERATIONAL_LABEL, code)).join(' · ')
}

export interface DiskHealth {
  name: string
  /** 健康档（0 健康 / 1 警告 / 2 不健康 / 5 未知） */
  healthRaw: number | null
  mediaRaw: number | null
  busRaw: number | null
  operationalRaw: number[]
  sizeBytes: number | null
  /** 系统盘 */
  system: boolean
}

/**
 * 健康档是否能判成「没问题」。
 *
 * 只认 0（Healthy）。`null`（读不到）与 5（Unknown）都不算通过 ——
 * 「没读到」和「健康」是两件事，把前者当后者会让体检报告给出一个它并不知道的结论。
 */
export function diskLooksHealthy(disk: DiskHealth): boolean {
  return disk.healthRaw === 0
}

/* ------------------------------------------------------------ 设备 */

/**
 * 问题设备的 `ConfigManagerErrorCode`。
 *
 * 22（`CM_PROB_DISABLED`）是**用户自己禁用的设备**，不是故障 ——
 * 「已禁用不算异常」在服务、自启项、计划任务之后第五次出现。
 *
 * 本机有三条独立证据：
 *   1. 设备管理器里那块 Sangfor aTrust VNIC 的 Problem 就是 22
 *      （`Get-PnpDevice` 渲染出的符号名正是 `CM_PROB_DISABLED`）；
 *   2. 系统自带的 `pnputil /enum-devices /problem` 报的是
 *      「No devices were found on the system.」—— **Windows 自己不把
 *      被禁用的设备算作「有问题的设备」**；
 *   3. 本机 `PnpDevice.Types.ps1xml` 的 CM_PROB 全表里，`DISABLED` 之外还有
 *      `HARDWARE_DISABLED`(29) 与 `DISABLED_SERVICE`(32) —— 那两个是「BIOS 里
 *      关了」「驱动服务被禁了」，属于**真问题**，不能一起并进这一档。
 *      所以下面只认 22，多一个都不认。
 */
export const CM_PROB_DISABLED = 22

export interface ProblemDevice {
  name: string
  pnpClass: string
  /** 设备管理器的「代码 N」 */
  code: number
  status: string
}

export type DeviceLevel = 'disabled' | 'problem'

/** 设备分档：唯一判据，界面与计数都走它，不许各写一份 */
export function deviceLevel(code: number): DeviceLevel {
  return code === CM_PROB_DISABLED ? 'disabled' : 'problem'
}

export const DEVICE_LEVEL_TEXT: Record<DeviceLevel, string> = {
  disabled: '已禁用',
  problem: '有问题'
}

/* ------------------------------------------------------------ 报告 */

export interface HealthReport {
  at: number
  durationMs: number
  /** 开机时刻（Unix 毫秒） */
  bootedAt: number | null
  /** 已运行时长（毫秒） */
  uptimeMs: number | null
  reboot: RebootCheck[]
  /** 明确要求重启的处数（只有 cbs / windows-update 算，advisory 不算） */
  rebootRequired: number
  logs: HealthLog[]
  /** 近若干天的意外关机（新的在前） */
  crashes: CrashEvent[]
  /** 意外关机的统计窗口（天）——界面必须写出来 */
  crashWindowDays: number
  disks: DiskHealth[]
  /** 有问题码的设备（含被禁用的；界面按 deviceLevel 分档） */
  devices: ProblemDevice[]
  /** 真正的问题设备数（不含被禁用的） */
  deviceProblems: number
  /** 被禁用的设备数（不算异常，单独一档） */
  deviceDisabled: number
  degraded: boolean
  error?: string
}
