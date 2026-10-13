import { DEFAULT_QUIET_HOURS, TIME_PATTERN } from './notify'
import type { Settings } from './types'

export const DEFAULT_SETTINGS: Settings = {
  theme: 'system',
  windowBounds: null,
  sidebarCollapsed: false,
  notifyOnPortChange: true,
  notifyOnScanDone: true,
  notifyOnServiceDown: true,
  notifyOnUpdate: true,
  notifySustained: true,
  quietHours: { ...DEFAULT_QUIET_HOURS },
  autoCheckUpdate: true,
  scanPlan: { mode: 'manual', time: '10:00' },
  whitelist: []
}

/**
 * 把任意来源的对象收敛成合法的 Settings —— 手工编辑过的设置文件
 * 不该让应用起不来：认不出的字段落回默认值，宁少勿错。
 */
export function sanitizeSettings(raw: unknown): Settings {
  const out: Settings = {
    ...DEFAULT_SETTINGS,
    quietHours: { ...DEFAULT_QUIET_HOURS },
    scanPlan: { ...DEFAULT_SETTINGS.scanPlan },
    whitelist: []
  }
  if (raw === null || typeof raw !== 'object') return out
  const obj = raw as Record<string, unknown>

  if (obj.theme === 'light' || obj.theme === 'dark' || obj.theme === 'system') {
    out.theme = obj.theme
  }

  const wb = obj.windowBounds
  if (wb !== null && typeof wb === 'object') {
    const { x, y, width, height } = wb as Record<string, unknown>
    if ([x, y, width, height].every((v) => typeof v === 'number' && Number.isFinite(v))) {
      out.windowBounds = {
        x: x as number,
        y: y as number,
        width: width as number,
        height: height as number
      }
    }
  }

  if (typeof obj.notifyOnPortChange === 'boolean') out.notifyOnPortChange = obj.notifyOnPortChange
  if (typeof obj.notifyOnScanDone === 'boolean') out.notifyOnScanDone = obj.notifyOnScanDone
  if (typeof obj.notifyOnServiceDown === 'boolean') out.notifyOnServiceDown = obj.notifyOnServiceDown
  if (typeof obj.notifyOnUpdate === 'boolean') out.notifyOnUpdate = obj.notifyOnUpdate
  if (typeof obj.notifySustained === 'boolean') out.notifySustained = obj.notifySustained
  if (typeof obj.autoCheckUpdate === 'boolean') out.autoCheckUpdate = obj.autoCheckUpdate
  if (typeof obj.sidebarCollapsed === 'boolean') out.sidebarCollapsed = obj.sidebarCollapsed

  // 安静时段：三项各自收敛。时间格式不合法就**保留默认值**而不是留个坏字符串 ——
  // 坏字符串到了判据里会走 fail-open（不静音），结果是「用户明明开了却毫无作用」，
  // 却看不出为什么；退回默认值至少描述的是「22:00–08:00」这个可解释的状态。
  const qh = obj.quietHours
  if (qh !== null && typeof qh === 'object') {
    const { enabled, start, end } = qh as Record<string, unknown>
    if (typeof enabled === 'boolean') out.quietHours.enabled = enabled
    if (typeof start === 'string' && TIME_PATTERN.test(start)) out.quietHours.start = start
    if (typeof end === 'string' && TIME_PATTERN.test(end)) out.quietHours.end = end
  }

  const sp = obj.scanPlan
  if (sp !== null && typeof sp === 'object') {
    const { mode, time } = sp as Record<string, unknown>
    if (mode === 'manual' || mode === 'daily' || mode === 'weekly') out.scanPlan.mode = mode
    if (typeof time === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(time)) out.scanPlan.time = time
  }

  if (Array.isArray(obj.whitelist)) {
    out.whitelist = obj.whitelist.filter(
      (p): p is string => typeof p === 'string' && p.length > 0 && p.length <= 512
    )
  }

  return out
}
