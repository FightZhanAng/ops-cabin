/** 关注的服务（与关注端口同构：名称 + 标签 + 备注） */
export interface ServiceWatchItem {
  /** Windows 服务名（Get-Service -Name 用的那个，不是显示名） */
  name: string
  label: string
  note?: string
  addedAt: number
}

/** 服务的运行状态（把 Win32_Service 的 State 归成四档） */
export type ServiceRunState = 'running' | 'stopped' | 'pending' | 'unknown'

/** 一个被关注的服务当前的样子 */
export interface ServiceStatus {
  name: string
  label: string
  /** 服务显示名；本机查不到时回退成 name */
  displayName: string
  state: ServiceRunState
  /** 启动类型原值：Auto / Manual / Disabled / Boot / System */
  startMode: string
  /** 服务二进制路径（Win32_Service 的 PathName，含参数） */
  path: string | null
  /** 这个服务名在本机不存在 —— 服务被卸载了，或当初名字写错了 */
  missing: boolean
  note?: string
}

/** 添加对话框里的候选项（全量服务，只在打开对话框时取一次） */
export interface ServiceCandidate {
  name: string
  displayName: string
  state: ServiceRunState
  startMode: string
}

/**
 * 「这个被关注的服务现在有没有事」的**唯一判据**。
 *
 * 侧栏徽标、端口页服务面板、后台盯梢的通知三处共用它 —— 三处各写一份的话，
 * 面板上的读数与推给你的通知迟早会对不上，而那种不一致比只给一处更糟。
 *
 * 四档里只有两档算「有事」，两处排除都是刻意的：
 *   - missing（本机已经查不到这个服务）**算**有事：关注的东西不见了就是异常，
 *     静默地从列表里消失会让人以为关注清单坏了。
 *   - stopped 且启动类型是 Disabled **不算**：它本来就不该在跑。这条纪律已经
 *     踩过很多次了（禁用的服务/自启项/计划任务/设备都不是异常）。
 *   - pending（启动中/停止中）**不算**：过渡态，过一拍就稳定了。
 *   - unknown（读不出来）**不算**：拿不到不等于有事，把它算进来会让一次采集
 *     失败变成一串假警报。它该在「读不到」这条路上被说出来，而不是在这里。
 */
export function serviceDown(item: ServiceStatus): boolean {
  return item.missing || (item.state === 'stopped' && item.startMode.toLowerCase() !== 'disabled')
}
