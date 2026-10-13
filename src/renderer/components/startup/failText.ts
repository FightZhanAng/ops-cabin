/**
 * 写操作失败的人话提示 —— 启动项页与计划任务页共用一份。
 *
 * 两页的交互与提示必须同口径（M15 规格 S8/S10）：同一类失败在哪个页面
 * 都应该是同一句话。
 */
export function failText(result: { reason: string; message?: string }): string {
  switch (result.reason) {
    case 'needs-admin':
      return result.message ?? '这一项需要管理员权限'
    case 'stale':
      return '条目已变化，请刷新后重试'
    case 'cancelled':
      return '已取消（未提权）'
    case 'denied':
      return result.message ?? '操作被拒绝'
    default:
      return result.message ?? '操作未完成'
  }
}
