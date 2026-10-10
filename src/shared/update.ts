/** 更新状态机（三段式：检查 / 下载 / 安装分离，安装永远由用户点） */
export interface UpdateState {
  status:
    | 'idle'
    | 'checking'
    | 'available'
    | 'downloading'
    | 'downloaded'
    | 'error'
    | 'unsupported'
  /** 当前版本 */
  current: string
  /** 可用版本（未知为空串） */
  latest: string
  /** 下载进度 0-100 */
  percent: number
  /** 提示信息（错误或说明） */
  message: string
  /** 最近一次检查时间（0 表示从未） */
  checkedAt: number
  /** 当前是否允许点「下载」 */
  canDownload: boolean
}
