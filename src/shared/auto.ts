/** 可写操作的域：开机自启 / 计划任务 */
export type AutoTarget = 'startup' | 'task'

/** 可写动作：翻转启用位（可逆）/ 删除登记（不可逆，仅失效项） */
export type AutoAction = 'toggle' | 'delete'

/**
 * 一条可写操作。
 *
 * 渲染层只负责说「对哪一条、做什么」—— id 是采集报告里的稳定标识；
 * 注册表键路径、值名、文件路径、任务路径全部由主进程从**自己刚采集的数据**重建，
 * 绝不用渲染层传的字符串拼命令（见 docs/adr/0001-写操作提权.md）。
 */
export interface AutoOp {
  target: AutoTarget
  action: AutoAction
  /** 采集报告里的条目 id（启动项为 `source|entryName`；计划任务为任务全路径） */
  id: string
  /** action = toggle 时必填：目标是否启用 */
  enabled?: boolean
}

/** 失败原因（界面按它给不同提示；不静默降级） */
export type AutoFailReason =
  | 'invalid' // 参数不合法（形状错 / 缺字段 / 尚未接入的动作）
  | 'stale' // 条目对不上（已变化或伪造）—— 刷新后重试
  | 'needs-admin' // 需要管理员权限（提权通道未接入前的诚实回答）
  | 'cancelled' // 用户在 UAC 处取消
  | 'denied' // 复核拒绝（如删除非失效项）
  | 'failed' // 其它失败（含写入校验失败），message 带人话原因

export type AutoResult =
  | { ok: true }
  | { ok: false; reason: AutoFailReason; message?: string }
