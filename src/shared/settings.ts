import type { Settings } from './types'

export const DEFAULT_SETTINGS: Settings = {
  theme: 'system',
  windowBounds: null,
  notifyOnPortChange: true,
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
