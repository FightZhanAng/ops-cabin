/** 计划任务的触发类型（认不出的一律归 other，界面用「其他」兜底） */
export type TaskTrigger =
  | 'time'
  | 'daily'
  | 'weekly'
  | 'monthly'
  | 'logon'
  | 'boot'
  | 'idle'
  | 'event'
  | 'registration'
  | 'session'
  | 'other'

export const TASK_TRIGGER_LABEL: Record<TaskTrigger, string> = {
  time: '定时',
  daily: '每天',
  weekly: '每周',
  monthly: '每月',
  logon: '登录时',
  boot: '开机时',
  idle: '空闲时',
  event: '事件触发',
  registration: '注册时',
  session: '会话变化',
  other: '其他'
}

/**
 * 一行任务的显示状态。
 *
 * 「已禁用不算异常」是第四次出现同一条纪律（服务 / 自启项 / 设备 / 计划任务）——
 * 把禁用的任务并进「失败」会让用户去修一个本来就没在跑的东西。
 */
export type TaskState = 'ok' | 'disabled' | 'failing' | 'missing'

/** 上一次运行的结果（已解码） */
export interface TaskResult {
  code: number
  ok: boolean
  /** 人话结论（成功 / 正在运行 / 尚未运行 / 失败 · 找不到文件…） */
  text: string
}

/** 一条计划任务 */
export interface TaskItem {
  /** 稳定标识：所在文件夹 + 名字 */
  id: string
  name: string
  /** 所在文件夹（`\` 表示根目录） */
  folder: string
  state: TaskState
  /** 此刻正在执行（来自调度器状态，与 state 无关） */
  running: boolean
  triggers: TaskTrigger[]
  /** 有认不出的触发类型（界面据此提示「其他」里有东西） */
  hasUnknownTrigger: boolean
  lastRunAt: number | null
  nextRunAt: number | null
  /** 上一次运行结果；null = 还没跑过 */
  lastResult: TaskResult | null
  /** 要执行的东西（第一个动作的 Execute + Arguments，已展开环境变量） */
  action: string | null
  /**
   * 可执行文件是否还在。
   *
   * 没有可判路径的动作（COM 处理程序、或压根没有动作）按「有效」处理 ——
   * 判不了的事不能当成问题报出去。
   */
  pathExists: boolean
  /** 作者（多数是装它的那个软件） */
  author: string | null
}

export interface TaskReport {
  at: number
  items: TaskItem[]
  /** 本机任务总数（含跳过的系统任务） */
  scanned: number
  /** 跳过的系统任务数（`\Microsoft\*` 下的） */
  systemSkipped: number
  /** 需要留意：启用中且（上次运行失败 或 可执行文件不在）—— 等于行上亮灯的数量 */
  attention: number
  /** 启用中的条数 */
  enabled: number
  durationMs: number
  degraded: boolean
  error?: string
}

/**
 * 任务所在文件夹的显示名。
 *
 * 每用户任务目录是个 SID（`\S-1-5-21-…\`），一长串数字对人没有信息量，
 * 归成「用户目录」—— 分组标题的意义是让人一眼分清「我装的」和「系统塞的」。
 */
export function taskFolderLabel(folder: string): string {
  if (folder === '\\') return '根目录'
  const trimmed = folder.replace(/^\\+/, '').replace(/\\+$/, '')
  if (/^S-1-5-/i.test(trimmed)) return '用户目录'
  return trimmed.length > 0 ? trimmed : '根目录'
}

const WIN32_TEXT: Record<number, string> = {
  1: '函数不正确',
  2: '找不到文件',
  3: '找不到路径',
  5: '拒绝访问',
  87: '参数不正确',
  1053: '服务没有及时响应',
  1055: '服务被系统关闭',
  1056: '服务已在运行',
  1060: '指定的服务未安装',
  1067: '进程意外终止',
  1077: '从未尝试启动服务'
}

/**
 * NTSTATUS 里几个常见于计划任务结果的值。
 *
 * 这些码不在 0x8007xxxx 家族里，低 16 位那条捷径对它们无效 —— 不单列出来，
 * 界面上就只剩「失败 · 0xC0000005」这种谁也读不懂的十六进制。
 * 名字取自 MS-ERREF（NTSTATUS Values），0x40010004 的含义另经查证：
 * 它表示进程是被结束的而不是自己退出的，实际多因关机/注销打断或触发「超时则停止」。
 */
const STATUS_TEXT: Record<number, string> = {
  0x40010004: '被强制结束（关机/注销或超时打断）',
  0xc0000005: '程序越界访问（崩溃）',
  0xc000013a: '被 Ctrl+C 或控制台关闭打断',
  0xc0000142: '程序初始化失败（DLL 未就绪）',
  0xe0434352: '程序抛出未处理异常'
}

/**
 * 解码计划任务的运行结果码。
 *
 * **不能按 `code !== 0` 判失败**：任务计划程序把「状态」也记在这同一个字段里 ——
 *   0x41301 = 正在运行、0x41302 = 已禁用、0x41303 = 尚未运行、0x41304 = 没有更多运行
 * 直接判非零，会把「正在运行」和「从未运行」全报成故障。本机 17 个任务里有一半
 * 是这两个值，也就是说这条判据错了会让假警报占多数。
 *
 * 入参先做 `>>> 0`：PowerShell 可能把 UInt32 读成负数（0x80070002 → -2147024894），
 * 不归一化的话掩码全错。
 */
export function decodeTaskResult(code: number): TaskResult {
  const value = code >>> 0
  if (value === 0) return { code: value, ok: true, text: '成功' }

  // 调度器自己的状态码：都不是失败
  // 取值依据 WinError.h（SCHED_S_* 全是「成功常量」，见
  // https://learn.microsoft.com/windows/win32/taskschd/task-scheduler-error-and-success-constants）
  const STATE: Record<number, string> = {
    0x41300: '就绪',
    0x41301: '正在运行',
    0x41302: '已禁用',
    0x41303: '尚未运行',
    0x41304: '没有更多运行',
    // 下面三个原表里漏了，会落到兜底分支被印成「失败 · 0x00041305」这类假警报。
    // 它们同样是成功常量：0x41305 = 缺少排期所需属性；0x41306 = 上次运行被用户
    // 终止（关机/注销打断也算）；0x41307 = 没有触发器、触发器被禁用或未设置。
    // 本机 142 个任务里 0x41303 出现 65 次，说明这张表命中的都是常见值 ——
    // 漏一个就是一批假警报。
    0x41305: '未排期（缺少排期属性）',
    0x41306: '上次运行被终止',
    0x41307: '没有有效触发器',
    0x41308: '事件触发（无固定运行时间）',
    0x41325: '已排队等待运行'
  }
  const state = STATE[value]
  if (state !== undefined) return { code: value, ok: true, text: state }

  const status = STATUS_TEXT[value]
  if (status !== undefined) return { code: value, ok: false, text: `失败 · ${status}` }

  // 0x8007xxxx 的低 16 位就是 Win32 错码；裸的小整数也是 Win32 码。
  // 掩码结果必须 `>>> 0` 拉回无符号再比：JS 的 `&` 走有符号 32 位，
  // `0x80070002 & 0xffff0000` 得到的是 -2147024896，和字面量 0x80070000
  // （2147942400）永不相等 —— 少了这一步，整张 Win32 表就是死代码。
  let win32: number | null = null
  if ((value & 0xffff0000) >>> 0 === 0x80070000) win32 = value & 0xffff
  else if (value > 0 && value < 0x10000) win32 = value
  // 低 16 位为 0 的话不是 Win32 错码，落下去走通用分支，别印出「Win32 错误 0」
  if (win32 !== null && win32 !== 0) {
    const known = WIN32_TEXT[win32]
    return { code: value, ok: false, text: `失败 · ${known ?? `Win32 错误 ${win32}`}` }
  }

  /*
   * 兜底前先看 HRESULT 的严重性位（bit 31）：**为 0 表示成功/信息级**。
   *
   * 不看这一位会把「任务自己返回的自定义非零结果」一律印成失败。本机实测就有
   * 两例：0x10000000（BitLocker 维护任务）被报「失败 · 0x10000000」，而该任务的
   * bit31 为 0 —— 按微软的 HRESULT 规范属于成功级；运维舱的判据原则是「误报让人
   * 去修一个其实正常的东西」，这类假警报必须挡掉。
   *
   * 措辞刻意保守：只说「完成（自定义结果）」而不宣称「成功」—— bit31 只能证明
   * 它不是失败级，证明不了业务上一定成功。已知的失败形态（0x8007xxxx、
   * STATUS_TEXT 里那批、以及 bit31 为 1 的）都在上面被拦住了。
   */
  if ((value & 0x80000000) >>> 0 === 0) {
    return {
      code: value,
      ok: true,
      text: `完成（自定义结果 0x${value.toString(16).toUpperCase().padStart(8, '0')}）`
    }
  }

  return { code: value, ok: false, text: `失败 · 0x${value.toString(16).toUpperCase().padStart(8, '0')}` }
}
