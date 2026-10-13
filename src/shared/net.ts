/** 一条探测结论的状态：ok = 通；fail = 不通；info = 只是读数（如代理设置） */
export type NetCheckState = 'ok' | 'fail' | 'info'

export interface NetCheckItem {
  id: string
  /** 用户侧的叫法（「GitHub HTTPS」而不是「tcp:443」） */
  label: string
  state: NetCheckState
  /** 一句话事实，自带数字，不靠颜色传达结论 */
  detail: string
  /** 耗时毫秒；不适用（如读代理设置）为 null */
  ms: number | null
}

export interface NetCheckReport {
  at: number
  items: NetCheckItem[]
  /** 通过项数与计入项数（info 不计入分子分母） */
  passed: number
  total: number
}
