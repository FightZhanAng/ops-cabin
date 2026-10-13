/*
 * 通知的共享定义（四类信号 + 安静时段）。
 *
 * 安静时段的判定放在 shared 而不是主进程：渲染层要用同一套判据在设置页
 * 给出「现在正处于安静时段」的提示 —— 两处各写一份「现在算不算安静」
 * 迟早会不一致，而那种不一致恰好出现在用户最想确认的时刻。
 */

/** 四类通知信号（每一类在设置页有自己的开关） */
export type NotifyKind = 'port' | 'scan' | 'service' | 'update'

/** 信号在设置页与通知记录里的名字（一份措辞，两处共用） */
export const NOTIFY_KIND_LABEL: Record<NotifyKind, string> = {
  port: '关注端口变化',
  scan: '计划扫描完成',
  service: '关注服务异常',
  update: '发现新版本'
}

/**
 * 安静时段：这个区间内不推系统通知（信号本身照常产生，页面里照常看得到）。
 *
 * 默认关闭 —— 默认开启会把「为什么昨晚没收到通知」变成一个要翻设置才能
 * 回答的问题；而想安静属于用户明确的意图，不该由应用替他先静音。
 */
export interface QuietHours {
  enabled: boolean
  /** 'HH:mm'；与 end 相同表示零长度（不生效） */
  start: string
  /** 'HH:mm'；小于 start 表示跨午夜 */
  end: string
}

export const DEFAULT_QUIET_HOURS: QuietHours = { enabled: false, start: '22:00', end: '08:00' }

/** 'HH:mm' 校验（时刻输入的唯一格式定义，渲染层两处共用） */
export const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/

/**
 * 「持续异常重复提醒」的间隔（分钟）。
 *
 * 定时器与设置页的文案共用这一份 —— 写两遍的话，改了代码忘了改文案，
 * 设置页就会长期地对着用户撒谎。
 */
export const SUSTAINED_REPEAT_MINUTES = 30

/** 解析 'HH:mm' 成一天内的分钟数；格式不对给 null */
export function parseClock(value: string): number | null {
  if (!TIME_PATTERN.test(value)) return null
  const hour = Number(value.slice(0, 2))
  const minute = Number(value.slice(3, 5))
  return hour * 60 + minute
}

/**
 * 此刻是否落在安静时段内。
 *
 * 三条边界都是刻意的：
 *   - **配置读不出来（格式坏了）时返回 false —— 宁可吵，不可哑。** 一个被手改坏的
 *     时间不该让所有通知从此消失：那种沉默根本不会被发现，等发现时已经错过了
 *     一整轮「服务挂了 / 有新版本」。
 *   - start === end 视为零长度区间（不生效），而不是「全天」：写 22:00–22:00 的人
 *     想要的多半是「还没设好」，按「全天」执行会静悄悄地吃掉所有通知。
 *   - 含 start、不含 end（[start, end)）：08:00 整就该恢复通知 —— 否则「到 08:00 为止」
 *     会比用户预期多静音一分钟。
 */
export function isWithinQuietHours(now: Date, quiet: QuietHours): boolean {
  if (!quiet.enabled) return false
  const start = parseClock(quiet.start)
  const end = parseClock(quiet.end)
  if (start === null || end === null || start === end) return false
  const cur = now.getHours() * 60 + now.getMinutes()
  // start > end = 跨午夜（22:00 → 次日 08:00 是主用法）
  return start < end ? cur >= start && cur < end : cur >= start || cur < end
}

/** 安静时段的一句话说明（设置页的提示与通知记录共用） */
export function describeQuietHours(quiet: QuietHours): string {
  if (!quiet.enabled) return '未启用'
  const start = parseClock(quiet.start)
  const end = parseClock(quiet.end)
  if (start === null || end === null) return '时间格式无效，未生效'
  if (start === end) return '起止相同，未生效'
  return start < end ? `${quiet.start} – ${quiet.end}` : `${quiet.start} – 次日 ${quiet.end}`
}
