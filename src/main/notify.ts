import { Notification } from 'electron'
import { describeQuietHours, isWithinQuietHours, type NotifyKind } from '../shared/notify'
import type { Settings } from '../shared/types'
import { appIconPath } from './paths'
import { smoke } from './smoke'

/*
 * 通知出口 —— 四类信号都从这里出去。
 *
 * 抽成一个出口有三个理由，缺一个都不值得重写这段：
 *
 *   1. **安静时段要一处生效。** 散在各处的 `new Notification(...)` 里做时段判断，
 *      迟早有一条会漏，而漏掉的那条偏偏又最难发现（它不是不弹，是不该弹的时候弹了）。
 *   2. **留档。** 每条通知都记下结局（弹了 / 关了 / 静音了 / 失败了）。
 *      「为什么我没收到通知」这个问题必须有地方能自答，否则只能靠猜。
 *   3. **自检。** 通知是极难自然触发的东西（要等一个真服务挂掉、真出现新版本），
 *      有了统一出口才能在冒烟里把三条判定分支都走一遍。
 */

/** 每次通知的结局 */
export type NotifyOutcome = 'shown' | 'off' | 'quiet' | 'failed'

/** 留档条数上限 */
const MAX_RECORDS = 50

export interface NotifyRecord {
  at: number
  kind: NotifyKind
  title: string
  body: string
  outcome: NotifyOutcome
  /** 被安静时段挡下时记下当时的区间 —— 「为什么没弹」要能自答 */
  quiet?: string
}

export interface NotifierDeps {
  /** 读当前设置；返回 null 表示还没装载好（此时按「放行」处理） */
  getSettings: () => Settings | null
  /** 点击通知时做什么（唤起主面板） */
  onClick: () => void
  /**
   * 自检模式：走完全部判定与留档，但不真的弹系统通知。
   * 冒烟里几十秒内会触发好几条通知，真弹出去会糊满屏幕并干扰截图。
   */
  silent?: boolean
}

/** 四类信号各自的开关字段（一处定义，避免手写的字符串在别处拼错） */
const KIND_SWITCH = {
  port: 'notifyOnPortChange',
  scan: 'notifyOnScanDone',
  service: 'notifyOnServiceDown',
  update: 'notifyOnUpdate'
} as const satisfies Record<NotifyKind, keyof Settings>

export class Notifier {
  #deps: NotifierDeps
  #records: NotifyRecord[] = []
  /** 通知对象要留引用：被 GC 掉后点击回调不再触发 */
  #active: Notification | null = null

  constructor(deps: NotifierDeps) {
    this.#deps = deps
  }

  /** 留档（自检与诊断用；调用方拿到的是副本） */
  get records(): NotifyRecord[] {
    return this.#records.map((record) => ({ ...record }))
  }

  /**
   * 四类信号统一出口：信号开关 → 安静时段 → 弹窗。
   *
   * 每一次调用都留档，**包括没弹出去的**：'off' 与 'quiet' 同样是有用的答案。
   * 两道判定都是 fail-open：设置还没装载好、时段格式坏掉，都按「放行」算。
   * 宁可吵，不可哑 —— 一个静悄悄失效的通知开关比没有这个开关更糟。
   */
  notify(kind: NotifyKind, title: string, body: string): NotifyOutcome {
    const settings = this.#deps.getSettings()
    let outcome: NotifyOutcome
    let quiet: string | undefined

    if (settings !== null && settings[KIND_SWITCH[kind]] !== true) {
      outcome = 'off'
    } else if (settings !== null && isWithinQuietHours(new Date(), settings.quietHours)) {
      outcome = 'quiet'
      quiet = describeQuietHours(settings.quietHours)
    } else {
      outcome = this.#deliver(title, body)
    }

    this.#records.push({
      at: Date.now(),
      kind,
      title,
      body,
      outcome,
      ...(quiet === undefined ? {} : { quiet })
    })
    if (this.#records.length > MAX_RECORDS) {
      this.#records.splice(0, this.#records.length - MAX_RECORDS)
    }
    // 自检下每次通知都覆写留档文件：外部脚本要在应用退出后对账
    smoke('notify-log', { records: this.#records })
    return outcome
  }

  #deliver(title: string, body: string): NotifyOutcome {
    if (this.#deps.silent) return 'shown'
    try {
      const notification = new Notification({ title, body, icon: appIconPath() })
      notification.on('click', () => this.#deps.onClick())
      notification.on('close', () => {
        if (this.#active === notification) this.#active = null
      })
      this.#active = notification
      notification.show()
      return 'shown'
    } catch {
      // 系统不支持通知（或被策略关掉）不该阻塞调用方：业务消息本身仍然成立
      return 'failed'
    }
  }
}
