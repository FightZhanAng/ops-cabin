import { app } from 'electron'
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, resolve } from 'node:path'
import type { AutoResult } from '../shared/auto'
import { executeStartupOp, executeTaskOp, isValidHelperPayload, type HelperPayload } from './autoapply'
import { collectStartup } from './startup'
import { collectTasks } from './tasks'

/*
 * 受控提权助手（--apply-op <payload 文件>）。
 *
 * 这是全应用唯一以管理员身份运行的代码路径，安全边界从严（见 docs/adr/0001）：
 *   · 请求文件必须落在系统临时目录、文件名符合 nonce 形态、体积 ≤64KB；
 *   · payload 结构严格校验（nonce / 新鲜度 / 封闭操作集）；
 *   · 执行按域路由到 executeStartupOp / executeTaskOp —— 与直写路径同一份实现，不存在旁路。
 * 就算被同用户级攻击者伪造调用，最坏影响也被限制在这个集合内。
 */

const PAYLOAD_NAME = /^ops-cabin-apply-([0-9a-f]{32})\.json$/
const MAX_PAYLOAD_BYTES = 64 * 1024

/** 从请求文件名里取出那 32 位 hex；名字不合法返回 null */
function nonceFromName(file: string): string | null {
  const matched = PAYLOAD_NAME.exec(basename(file))
  return matched === null ? null : matched[1]
}

function resultFileOf(file: string): string {
  return `${file}.result`
}

function writeResult(file: string, result: AutoResult): void {
  try {
    writeFileSync(resultFileOf(file), JSON.stringify(result), 'utf8')
  } catch {
    /* 写不回结果时主进程按「未返回结果」上报，不在助手里爆 */
  }
}

/** 位置级校验（不通过就不落结果文件 —— 绝不往任意位置写） */
function locationProblem(file: string): string | null {
  if (!isAbsolute(file)) return '请求文件必须是绝对路径'
  if (!PAYLOAD_NAME.test(basename(file))) return '请求文件名不符合助手约定'
  if (resolve(dirname(file)) !== resolve(tmpdir())) return '请求文件必须位于系统临时目录'
  if (!existsSync(file)) return '请求文件不存在'
  try {
    if (statSync(file).size > MAX_PAYLOAD_BYTES) return '请求文件过大'
  } catch {
    return '请求文件不可读'
  }
  return null
}

/**
 * 内容级校验；合法返回 payload，不合法返回人话原因。
 *
 * **必须同时校验「payload.nonce 与文件名里那 32 位 hex 相等」**。
 * 只校验 nonce 的形态（/^[0-9a-f]{32}$/）等于没校验这个文件是谁生成的：
 * 任何同用户进程都能自造一个同命名规则的文件、随手填一个 nonce，
 * 再自己 Start-Process -Verb RunAs 把助手拉起来 —— UAC 弹窗上写的还是
 * 「运维舱」。绑定之后，nonce 必须与文件名一致才算数，自造者仍然可以
 * 构造出这种文件（nonce 不是秘密），所以这只是第一层；但它让「文件名」
 * 与「内容」不再是两个互不相干的摆设，也为后续加 MAC 留了挂钩点。
 */
function loadPayload(file: string): HelperPayload | string {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return '请求文件不是合法 JSON'
  }
  if (!isValidHelperPayload(raw)) return '请求内容不合法（nonce / 时间戳 / 操作白名单）'
  const fromName = nonceFromName(file)
  if (fromName === null || fromName !== raw.nonce) {
    return '请求内容与文件名不匹配（nonce 绑定校验失败）'
  }
  return raw
}

async function executePayload(payload: HelperPayload): Promise<AutoResult> {
  if (payload.op.target === 'task') {
    // 提权后的任务操作：报告按「管理员视角」重采集，仍按 id 复核后才执行
    const report = await collectTasks()
    if (report.error !== undefined) {
      return { ok: false, reason: 'failed', message: `读取当前状态失败：${report.error}` }
    }
    const item = report.items.find((entry) => entry.id === payload.op.id)
    if (item === undefined) {
      return { ok: false, reason: 'stale', message: '条目已变化 —— 请刷新后重试' }
    }
    return executeTaskOp(item, payload.op)
  }
  const report = await collectStartup()
  if (report.error !== undefined) {
    return { ok: false, reason: 'failed', message: `读取当前状态失败：${report.error}` }
  }
  const item = report.items.find((entry) => entry.id === payload.op.id)
  if (item === undefined) {
    return { ok: false, reason: 'stale', message: '条目已变化 —— 请刷新后重试' }
  }
  return executeStartupOp(item, payload.op)
}

/** 助手入口（index.ts 在单实例锁/窗口之前分支到这里）；处理完直接退出 */
export function runApplyOpHelper(file: string): void {
  const problem = locationProblem(file)
  if (problem !== null) {
    app.exit(1)
    return
  }
  const payload = loadPayload(file)
  if (typeof payload === 'string') {
    writeResult(file, { ok: false, reason: 'invalid', message: payload })
    app.exit(0)
    return
  }
  void (async () => {
    const result = await executePayload(payload).catch(
      (error: unknown): AutoResult => ({
        ok: false,
        reason: 'failed',
        message: error instanceof Error ? error.message : String(error)
      })
    )
    writeResult(file, result)
    app.exit(0)
  })()
}
