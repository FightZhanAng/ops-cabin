// M15-001/002/003/004/005 可写化打底的端到端验证（CDP + 真实窗口 + 真实注册表/任务夹具）。
//
// 覆盖：启动项开关（禁用/启用往返，HKCU Run 与用户启动文件夹两来源）/
//       启用位字节口径（首字节 02/03、时间戳字节原样保留、从无到有创建的形态）/
//       stale 与非法参数拒绝 / needs-admin 判定与「未写入」佐证 /
//       删除登记（失效行 / 残留行入口、取消不动、确认后值消失、统计回落、非失效项拒绝）/
//       计划任务开关（真实 schtasks 夹具，禁用 → 已禁用档 → 启用往返，COM 侧真值佐证）/
//       计划任务删除（missing 行入口、取消不动、确认后任务消失、非 missing 拒绝）/
//       受控助手直调（--apply-op：启动项与任务两域、陈旧请求、条目对不上、封闭操作集、位置/文件名拒绝）。
//
// 用法：node scripts/e2e-autostart.mjs
// 说明：会真实写 HKCU 注册表、用户启动文件夹与两条 schtasks 夹具任务（夹具带 OpsCabinE2E 前缀，
//       运行前后清理）；使用隔离的 user-data-dir，不碰真实用户数据。
import { spawn, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as wait } from 'node:timers/promises'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const PORT = 19225
const userDataDir = join(tmpdir(), 'ops-cabin-e2e-autostart-userdata')
const electronExe = join(root, 'node_modules', 'electron', 'dist', 'electron.exe')

const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'
const APPROVED_RUN = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run'
const APPROVED_FOLDER =
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\StartupFolder'
const STARTUP_FOLDER = join(
  process.env.APPDATA ?? join(tmpdir(), 'no-appdata'),
  'Microsoft\\Windows\\Start Menu\\Programs\\Startup'
)

/** 夹具 A：初始已禁用（启用位带自定义尾字节 —— 验证开关不损耗时间戳） */
const FIX_DISABLED = 'OpsCabinE2EToggle'
/** 夹具 B：初始无启用位（验证「从无到有」创建的形态） */
const FIX_FRESH = 'OpsCabinE2ENew'
/** 夹具 C：用户启动文件夹里的 .lnk（验证 StartupFolder 启用位的映射） */
const FIX_LNK = 'OpsCabinE2E.lnk'
/** 夹具 D：路径失效（指向不存在的程序）—— 删除登记的靶子 */
const FIX_DEAD = 'OpsCabinE2EDead'
/** 夹具 E：已禁用 · 残留（路径失效 + 任务管理器禁用过）—— 同样可删 */
const FIX_RESIDUE = 'OpsCabinE2EResidue'
/** 一个不存在于本机的路径（用于制造「路径失效」的条目） */
const GHOST = 'C:\\OpsCabinE2E\\ghost.exe'
/** 计划任务夹具（schtasks 创建在根文件夹，运行前后清理） */
const FIX_TASK = 'OpsCabinE2ETask'
/** 计划任务夹具（可执行文件不存在 → 「路径失效」档，删除登记的靶子） */
const FIX_TASK_DEAD = 'OpsCabinE2ETaskDead'
/** 自定义尾字节：11 字节，反复开关后必须原样保留 */
const TAIL = 'aabbccddeeff001122334455'

let failures = 0
let currentChild = null
const sockets = new Set()

function check(name, ok, detail = '') {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? `  （${detail}）` : ''}`)
  if (!ok) failures++
}

function closeSockets() {
  for (const ws of sockets) {
    try {
      ws.close()
    } catch {
      /* 忽略 */
    }
  }
}

function shutdown(code) {
  closeSockets()
  try {
    currentChild?.kill('SIGKILL')
  } catch {
    /* 已退出 */
  }
  setTimeout(() => process.exit(code), 220)
}

process.on('exit', closeSockets)
process.on('uncaughtException', (error) => {
  console.error(error)
  shutdown(1)
})

/* ---------------- 注册表 / 启动文件夹夹具 ---------------- */

function reg(args) {
  return spawnSync('reg.exe', args, { encoding: 'utf8' })
}

function setRunValue(name, data) {
  reg(['add', RUN_KEY, '/v', name, '/t', 'REG_SZ', '/d', data, '/f'])
}

function setApprovedBytes(key, name, hex) {
  reg(['add', key, '/v', name, '/t', 'REG_BINARY', '/d', hex, '/f'])
}

function deleteValue(key, name) {
  reg(['delete', key, '/v', name, '/f'])
}

/** 读 REG_BINARY 的十六进制（小写）；值不存在返回 null */
function readApprovedBytes(key, name) {
  const r = reg(['query', key, '/v', name])
  if (r.status !== 0) return null
  const line = (r.stdout ?? '')
    .split(/\r?\n/)
    .find((l) => l.includes(name) && l.includes('REG_BINARY'))
  if (!line) return null
  const m = line.match(/REG_BINARY\s+([0-9A-Fa-f]+)/)
  return m ? m[1].toLowerCase() : null
}

/** 读 Run 值的 REG_SZ 数据；值不存在返回 null */
function readRunValue(name) {
  const r = reg(['query', RUN_KEY, '/v', name])
  if (r.status !== 0) return null
  const line = (r.stdout ?? '')
    .split(/\r?\n/)
    .find((l) => l.includes(name) && l.includes('REG_SZ'))
  if (!line) return null
  const m = line.match(/REG_SZ\s+(.*)$/)
  return m ? m[1].trim() : null
}

function runPS(script) {
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  return spawnSync(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
    { encoding: 'utf8' }
  )
}

const lnkPath = join(STARTUP_FOLDER, FIX_LNK)

/** PowerShell 单引号字面量（单引号自身翻倍转义；路径里通常没有） */
function psQuote(text) {
  return `'${text.replace(/'/g, "''")}'`
}

function createLnkFixture() {
  runPS(
    [
      '$ws = New-Object -ComObject WScript.Shell',
      `$sc = $ws.CreateShortcut(${psQuote(lnkPath)})`,
      "$sc.TargetPath = 'C:\\Windows\\System32\\cmd.exe'",
      '$sc.Save()'
    ].join('\n')
  )
}

function cleanupFixtures() {
  deleteValue(RUN_KEY, FIX_DISABLED)
  deleteValue(RUN_KEY, FIX_FRESH)
  deleteValue(RUN_KEY, FIX_DEAD)
  deleteValue(RUN_KEY, FIX_RESIDUE)
  deleteValue(APPROVED_RUN, FIX_DISABLED)
  deleteValue(APPROVED_RUN, FIX_FRESH)
  deleteValue(APPROVED_RUN, FIX_RESIDUE)
  deleteValue(APPROVED_FOLDER, FIX_LNK)
  runPS(`Remove-Item -LiteralPath ${psQuote(lnkPath)} -Force -ErrorAction SilentlyContinue`)
  deleteTaskFixture(FIX_TASK)
  deleteTaskFixture(FIX_TASK_DEAD)
}

/* ---------------- 计划任务夹具（schtasks；真值读取走 COM，与界面语言无关） ---------------- */

function createTaskFixture(name = FIX_TASK, program = 'C:\\Windows\\System32\\cmd.exe /c exit') {
  // DAILY 而不是 ONCE：/ST 落在过去会让 ONCE 直接创建失败（跨午夜跑测试时踩得到）
  return spawnSync(
    'schtasks.exe',
    ['/Create', '/TN', `\\${name}`, '/TR', program, '/SC', 'DAILY', '/ST', '23:59', '/F'],
    { encoding: 'utf8' }
  )
}

function deleteTaskFixture(name = FIX_TASK) {
  return spawnSync('schtasks.exe', ['/Delete', '/TN', `\\${name}`, '/F'], { encoding: 'utf8' })
}

/** 直接问任务计划程序服务：夹具任务当前是否启用（'1' / '0'；读不到返回空串） */
function taskEnabled(name = FIX_TASK) {
  const r = runPS(
    [
      '$svc = New-Object -ComObject Schedule.Service',
      '$svc.Connect()',
      `$t = $svc.GetFolder("\\").GetTask("${name}")`,
      'if ($t.Enabled) { "1" } else { "0" }'
    ].join('\n')
  )
  return (r.stdout ?? '').trim()
}

/** 任务是否还在（'1' / '0'） */
function taskExists(name = FIX_TASK) {
  const r = runPS(
    [
      '$svc = New-Object -ComObject Schedule.Service',
      '$svc.Connect()',
      `try { $null = $svc.GetFolder("\\").GetTask("${name}"); "1" } catch { "0" }`
    ].join('\n')
  )
  return (r.stdout ?? '').trim()
}

/* ---------------- CDP 工具 ---------------- */

async function listTargets() {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/json`)
    return await res.json()
  } catch {
    return null
  }
}

async function waitForReadyPage(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const targets = await listTargets()
    const page = targets?.find((t) => t.type === 'page' && t.title && t.title !== 'index.html')
    if (page) return page
    await wait(400)
  }
  return null
}

async function connect(url) {
  const ws = new WebSocket(url)
  sockets.add(ws)
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true })
    ws.addEventListener('error', () => reject(new Error('CDP 连接失败')), { once: true })
  })
  let counter = 1
  const pending = new Map()
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data)
    if (msg.id && pending.has(msg.id)) {
      const entry = pending.get(msg.id)
      pending.delete(msg.id)
      if (msg.error) entry.reject(new Error(msg.error.message))
      else entry.resolve(msg.result)
    }
  })
  ws.addEventListener('close', () => {
    sockets.delete(ws)
    for (const entry of pending.values()) entry.reject(new Error('CDP 连接已关闭'))
    pending.clear()
  })
  return {
    send: (method, params) =>
      new Promise((resolve, reject) => {
        const id = counter++
        pending.set(id, { resolve, reject })
        ws.send(JSON.stringify({ id, method, params }))
      }),
    close: () => ws.close()
  }
}

async function evaluate(cdp, expression, awaitPromise = false) {
  const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise })
  if (r.exceptionDetails) {
    throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text)
  }
  return r.result?.value
}

/** 轮询直到表达式真值；超时返回最后一次取值（由调用方断言并给出事实） */
async function waitFor(cdp, expression, timeoutMs = 30000, interval = 400) {
  const deadline = Date.now() + timeoutMs
  let value = null
  while (Date.now() < deadline) {
    value = await evaluate(cdp, expression).catch(() => null)
    if (value) return value
    await wait(interval)
  }
  return value
}

/**
 * 一次真实鼠标点击（CDP Input.dispatchMouseEvent）。
 * radix 的开关对程序化 DOM 事件不响应（Tabs 的教训）—— 一律用真实点击；
 * 点击前先滚进视口（长列表里的目标可能在视口外）。
 */
async function clickAt(cdp, selector) {
  const ready = await evaluate(
    cdp,
    `(() => {
      const el = document.querySelector(${JSON.stringify(selector)})
      if (!el || el.disabled) return false
      el.scrollIntoView({ block: 'center' })
      return true
    })()`
  )
  if (ready !== true) return false
  await wait(250)
  const info = await evaluate(
    cdp,
    `(() => {
      const el = document.querySelector(${JSON.stringify(selector)})
      if (!el || el.disabled) return null
      const r = el.getBoundingClientRect()
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
    })()`
  )
  if (!info) return false
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: info.x,
    y: info.y,
    button: 'left',
    clickCount: 1
  })
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: info.x,
    y: info.y,
    button: 'left',
    clickCount: 1
  })
  return true
}

/* ---------------- 应用启动 / 退出 ---------------- */

function launch() {
  currentChild = spawn(
    electronExe,
    ['.', `--remote-debugging-port=${PORT}`, `--user-data-dir=${userDataDir}`],
    { cwd: root, stdio: 'ignore', env: { ...process.env, OPS_CABIN_SMOKE: '1' } }
  )
  return currentChild
}

async function quitApp(page, child) {
  try {
    const cdp = await connect(page.webSocketDebuggerUrl)
    await evaluate(cdp, 'window.opsCabin.quit()', true)
    cdp.close()
  } catch {
    /* 应用可能已在退出途中 */
  }
  for (let i = 0; i < 20; i++) {
    await wait(400)
    if (!(await listTargets())) return true
  }
  try {
    child.kill('SIGKILL')
  } catch {
    /* 已退出 */
  }
  await wait(800)
  return !(await listTargets())
}

/* ---------------- 002：受控助手直调（--apply-op） ---------------- */

// 真提权（UAC 弹窗）无法自动化 —— 这里直调「提权后真正执行的那份代码」：
// electron.exe . --apply-op <请求文件>，断言结果文件与注册表后效。
const helperUserDataDir = join(tmpdir(), 'ops-cabin-e2e-helper-userdata')
/** 请求文件与结果文件，统一登记、统一清理 */
const helperArtifacts = []

function callHelper(filePath) {
  return spawnSync(
    electronExe,
    ['.', '--apply-op', filePath, `--user-data-dir=${helperUserDataDir}`],
    { cwd: root, encoding: 'utf8', timeout: 60000 }
  )
}

/** 造一个请求文件（内容由调用方给全，便于构造非法形态） */
function makePayloadFile(fileName, payload) {
  const file = join(tmpdir(), fileName)
  writeFileSync(file, JSON.stringify(payload), 'utf8')
  helperArtifacts.push(file)
  return file
}

function nonce() {
  return randomBytes(16).toString('hex')
}

/** 读助手写回的结果文件；不存在返回 null */
function readHelperResult(filePath) {
  const resultPath = `${filePath}.result`
  if (!existsSync(resultPath)) return null
  try {
    return JSON.parse(readFileSync(resultPath, 'utf8'))
  } catch {
    return { parseError: true }
  }
}

/* ---------------- 主流程 ---------------- */

console.log('== 构建 ==')
const build = spawnSync('pnpm build', { cwd: root, shell: true, encoding: 'utf8' })
if (build.status !== 0) {
  console.log(build.stdout ?? '')
  console.error(build.stderr ?? '')
  console.error('构建失败，中止')
  process.exit(1)
}

console.log('== 准备注册表/启动文件夹夹具 ==')
cleanupFixtures()
setRunValue(FIX_DISABLED, 'C:\\Windows\\System32\\cmd.exe')
setApprovedBytes(APPROVED_RUN, FIX_DISABLED, `03${TAIL}`)
setRunValue(FIX_FRESH, 'C:\\Windows\\System32\\cmd.exe')
setRunValue(FIX_DEAD, GHOST)
setRunValue(FIX_RESIDUE, GHOST)
setApprovedBytes(APPROVED_RUN, FIX_RESIDUE, `03${TAIL}`)
createLnkFixture()
check('夹具就位（.lnk 已创建）', existsSync(lnkPath))
const taskCreate = createTaskFixture()
check(
  '任务夹具就位（schtasks 创建，COM 侧确认启用）',
  taskCreate.status === 0 && taskEnabled() === '1',
  `code=${taskCreate.status} enabled=${taskEnabled()}`
)
const deadTaskCreate = createTaskFixture(FIX_TASK_DEAD, GHOST)
check(
  '失效任务夹具就位（可执行文件不存在）',
  deadTaskCreate.status === 0 && taskExists(FIX_TASK_DEAD) === '1',
  `code=${deadTaskCreate.status} exists=${taskExists(FIX_TASK_DEAD)}`
)

rmSync(userDataDir, { recursive: true, force: true })
mkdirSync(userDataDir, { recursive: true })

let app = null
let exitCode = 1
try {
  console.log('== 启动应用 ==')
  app = launch()
  const page = await waitForReadyPage()
  if (!page) {
    console.error('应用未能在限定时间内完成加载')
    shutdown(1)
  }
  const cdp = await connect(page.webSocketDebuggerUrl)

  // title 就绪 ≠ React 就绪：等侧栏挂载出来再驱动（M5 的教训）
  const mounted = await waitFor(cdp, `!!document.querySelector('[data-testid="nav-startup"]')`)
  check('界面已挂载（侧栏导航可见）', mounted === true)

  // 打开启动项页并等夹具行出现（首次采集要起一次 PowerShell）
  await evaluate(cdp, `document.querySelector('[data-testid="nav-startup"]')?.click(); 'ok'`)
  const rowSel = (name) => `[data-testid="startup-row"][data-name=${JSON.stringify(name)}]`
  const rowReady = (name) => `!!document.querySelector('${rowSel(name)}')`
  const rowFactExpr = (name) => `(() => {
    const row = document.querySelector('${rowSel(name)}')
    if (!row) return null
    const sw = row.querySelector('[data-testid="startup-toggle"]')
    return {
      state: row.getAttribute('data-state'),
      checked: sw ? sw.getAttribute('data-checked') : null,
      disabled: sw ? sw.disabled : null
    }
  })()`
  const switchSel = (name) => `${rowSel(name)} [data-testid="startup-toggle"]`
  const waitForRowState = (name, expected) =>
    waitFor(
      cdp,
      `(() => {
        const row = document.querySelector('${rowSel(name)}')
        return row && row.getAttribute('data-state') === ${JSON.stringify(expected)}
      })()`
    )

  for (const name of [FIX_DISABLED, FIX_FRESH, FIX_LNK, FIX_DEAD, FIX_RESIDUE]) {
    const ok = await waitFor(cdp, rowReady(name))
    check(`夹具行可见：${name}`, ok === true)
  }

  /* ---- 夹具 A：HKCU Run，初始已禁用（带自定义尾字节） ---- */
  const a0 = await evaluate(cdp, rowFactExpr(FIX_DISABLED))
  check(
    '夹具 A 初始态：已禁用 + 开关关',
    a0?.state === 'disabled' && a0?.checked === '0',
    JSON.stringify(a0)
  )

  check('点击开关（启用）', (await clickAt(cdp, switchSel(FIX_DISABLED))) === true)
  await waitForRowState(FIX_DISABLED, 'ok')
  const aAfterEnable = await evaluate(cdp, rowFactExpr(FIX_DISABLED))
  check('启用后行状态翻转', aAfterEnable?.state === 'ok' && aAfterEnable?.checked === '1', JSON.stringify(aAfterEnable))
  const bytesEnabled = readApprovedBytes(APPROVED_RUN, FIX_DISABLED)
  check('启用写回首字节 0x02', bytesEnabled?.startsWith('02') === true, `bytes=${bytesEnabled}`)
  check('时间戳尾字节原样保留', bytesEnabled?.slice(2) === TAIL, `tail=${bytesEnabled?.slice(2)}`)

  check('再次点击（禁用）', (await clickAt(cdp, switchSel(FIX_DISABLED))) === true)
  await waitForRowState(FIX_DISABLED, 'disabled')
  const bytesDisabled = readApprovedBytes(APPROVED_RUN, FIX_DISABLED)
  check('禁用写回首字节 0x03', bytesDisabled?.startsWith('03') === true, `bytes=${bytesDisabled}`)
  check('尾字节仍然保留（往返不损耗）', bytesDisabled?.slice(2) === TAIL, `tail=${bytesDisabled?.slice(2)}`)

  /* ---- 夹具 B：HKCU Run，初始无启用位（从无到有） ---- */
  const b0 = await evaluate(cdp, rowFactExpr(FIX_FRESH))
  check('夹具 B 初始态：正常 + 开关开', b0?.state === 'ok' && b0?.checked === '1', JSON.stringify(b0))

  check('点击开关（首次禁用）', (await clickAt(cdp, switchSel(FIX_FRESH))) === true)
  await waitForRowState(FIX_FRESH, 'disabled')
  const freshBytes = readApprovedBytes(APPROVED_RUN, FIX_FRESH)
  check(
    '从无到有创建启用位（12 字节，首字节 0x03）',
    freshBytes?.length === 24 && freshBytes.startsWith('03'),
    `bytes=${freshBytes}`
  )

  /* ---- 夹具 C：用户启动文件夹（StartupFolder 启用位） ---- */
  check('点击开关（.lnk 禁用）', (await clickAt(cdp, switchSel(FIX_LNK))) === true)
  await waitForRowState(FIX_LNK, 'disabled')
  const lnkBytes = readApprovedBytes(APPROVED_FOLDER, FIX_LNK)
  check(
    '文件夹项写入 StartupApproved\\StartupFolder（首字节 0x03）',
    lnkBytes?.startsWith('03') === true,
    `bytes=${lnkBytes}`
  )

  /* ---- 003：删除登记（失效行 / 残留行可删；取消不动；统计回落） ---- */
  // 注：文件夹项的失效态在采集口径下不可达（.lnk 存在即为有效），所以「失效 .lnk」夹具
  // 不存在；删除入口只会在注册表失效行出现，executor 里的 .lnk 删除分支为防御性实现。
  const deleteSel = (name) => `${rowSel(name)} [data-testid="startup-delete"]`
  const deleteBtnNameExpr = (name) => `(() => {
    const row = document.querySelector('${rowSel(name)}')
    const btn = row ? row.querySelector('[data-testid="startup-delete"]') : null
    return btn ? btn.getAttribute('data-name') : null
  })()`
  const statsExpr = `(() => {
    const el = document.querySelector('[data-testid="startup-stats"]')
    return el
      ? {
          total: Number(el.getAttribute('data-total')),
          invalid: Number(el.getAttribute('data-invalid')),
          disabled: Number(el.getAttribute('data-disabled'))
        }
      : null
  })()`

  const d0 = await evaluate(cdp, rowFactExpr(FIX_DEAD))
  check('夹具 D 初始态：路径失效', d0?.state === 'invalid' && d0?.checked === '1', JSON.stringify(d0))
  const e0 = await evaluate(cdp, rowFactExpr(FIX_RESIDUE))
  check('夹具 E 初始态：已禁用 · 残留', e0?.state === 'stale' && e0?.checked === '0', JSON.stringify(e0))

  // S5/S6 的 UI 侧：失效行有删除入口；正常/已禁用行没有
  check('失效行出现删除入口', (await evaluate(cdp, deleteBtnNameExpr(FIX_DEAD))) === FIX_DEAD)
  check('残留行出现删除入口', (await evaluate(cdp, deleteBtnNameExpr(FIX_RESIDUE))) === FIX_RESIDUE)
  check('正常 .lnk 行没有删除入口', (await evaluate(cdp, deleteBtnNameExpr(FIX_LNK))) === null)
  check('已禁用的健康行没有删除入口', (await evaluate(cdp, deleteBtnNameExpr(FIX_FRESH))) === null)

  // 取消路径：对话框关掉，登记一个字节都不许动
  check('点击删除（残留行）', (await clickAt(cdp, deleteSel(FIX_RESIDUE))) === true)
  check(
    '出现二次确认框',
    (await waitFor(cdp, `!!document.querySelector('[data-testid="startup-delete-confirm"]')`, 5000)) === true
  )
  check('取消对话框', (await clickAt(cdp, '[data-slot="alert-dialog-cancel"]')) === true)
  check(
    '取消后确认框关闭',
    (await waitFor(cdp, `!document.querySelector('[data-testid="startup-delete-confirm"]')`, 5000)) === true
  )
  check('取消不动登记（Run 值仍在）', readRunValue(FIX_RESIDUE) === GHOST, `value=${readRunValue(FIX_RESIDUE)}`)
  check(
    '取消后行还在（仍是残留态）',
    (await evaluate(cdp, rowFactExpr(FIX_RESIDUE)))?.state === 'stale'
  )

  // 确认删除夹具 D：行消失、Run 值消失、「路径失效」读数回落 1
  const statsBefore = await evaluate(cdp, statsExpr)
  check('点击删除（失效行）', (await clickAt(cdp, deleteSel(FIX_DEAD))) === true)
  check(
    '出现二次确认框（失效行）',
    (await waitFor(cdp, `!!document.querySelector('[data-testid="startup-delete-confirm"]')`, 5000)) === true
  )
  check('确认删除', (await clickAt(cdp, '[data-testid="startup-delete-confirm-btn"]')) === true)
  check(
    '删除后行消失（强制重读）',
    (await waitFor(cdp, `!document.querySelector('${rowSel(FIX_DEAD)}')`, 30000)) === true
  )
  check('Run 值已从注册表删除', readRunValue(FIX_DEAD) === null, `value=${readRunValue(FIX_DEAD)}`)
  const statsAfterDead = await evaluate(cdp, statsExpr)
  check(
    '「路径失效」读数回落 1',
    statsBefore !== null && statsAfterDead?.invalid === statsBefore.invalid - 1,
    `${statsBefore?.invalid} → ${statsAfterDead?.invalid}`
  )

  // 确认删除夹具 E（残留）：Run 值与启用位都清掉，「已禁用」读数回落 1
  check('点击删除（残留行）', (await clickAt(cdp, deleteSel(FIX_RESIDUE))) === true)
  check(
    '出现二次确认框（残留行）',
    (await waitFor(cdp, `!!document.querySelector('[data-testid="startup-delete-confirm"]')`, 5000)) === true
  )
  check('确认删除（残留行）', (await clickAt(cdp, '[data-testid="startup-delete-confirm-btn"]')) === true)
  check(
    '删除后行消失（残留行）',
    (await waitFor(cdp, `!document.querySelector('${rowSel(FIX_RESIDUE)}')`, 30000)) === true
  )
  check('Run 值已从注册表删除（残留行）', readRunValue(FIX_RESIDUE) === null)
  check(
    '启用位随删除一并清理（尽力而为）',
    readApprovedBytes(APPROVED_RUN, FIX_RESIDUE) === null,
    `bytes=${readApprovedBytes(APPROVED_RUN, FIX_RESIDUE)}`
  )
  const statsAfterResidue = await evaluate(cdp, statsExpr)
  check(
    '「已禁用」读数回落 1',
    statsAfterResidue?.disabled === statsAfterDead?.disabled - 1,
    `${statsAfterDead?.disabled} → ${statsAfterResidue?.disabled}`
  )

  /* ---- 004：计划任务开关（真实 schtasks 夹具；真值直接问任务计划程序服务） ---- */
  const taskRowSel = `[data-testid="task-row"][data-name="${FIX_TASK}"]`
  const taskStateExpr = `(() => {
    const row = document.querySelector('${taskRowSel}')
    if (!row) return null
    const sw = row.querySelector('[data-testid="task-toggle"]')
    return {
      state: row.getAttribute('data-state'),
      checked: sw ? sw.getAttribute('data-checked') : null,
      disabled: sw ? sw.disabled : null
    }
  })()`
  const taskStatsExpr = `(() => {
    const el = document.querySelector('[data-testid="tasks-stats"]')
    return el
      ? {
          total: Number(el.getAttribute('data-total')),
          disabled: Number(el.getAttribute('data-disabled')),
          attention: Number(el.getAttribute('data-attention'))
        }
      : null
  })()`

  check('切到「计划任务」档', (await clickAt(cdp, '[data-testid="tab-tasks"]')) === true)
  check(
    '任务夹具行可见',
    (await waitFor(cdp, `!!document.querySelector('${taskRowSel}')`, 30000)) === true
  )
  const taskStatsBefore = await evaluate(cdp, taskStatsExpr)
  const t0 = await evaluate(cdp, taskStateExpr)
  check('任务夹具初始态：正常 + 开关开', t0?.state === 'ok' && t0?.checked === '1', JSON.stringify(t0))
  check('系统侧确认启用（COM）', taskEnabled() === '1', `enabled=${taskEnabled()}`)

  check('点击任务开关（禁用）', (await clickAt(cdp, `${taskRowSel} [data-testid="task-toggle"]`)) === true)
  check(
    '禁用后行状态翻转（已禁用）',
    (await waitFor(
      cdp,
      `(() => {
        const row = document.querySelector('${taskRowSel}')
        return row && row.getAttribute('data-state') === 'disabled'
      })()`,
      30000
    )) === true
  )
  check('系统侧确实被禁用（COM）', taskEnabled() === '0', `enabled=${taskEnabled()}`)
  const taskStatsDisabled = await evaluate(cdp, taskStatsExpr)
  check(
    '「已禁用」读数 +1 且「需留意」不动（S8）',
    taskStatsDisabled?.disabled === taskStatsBefore?.disabled + 1 &&
      taskStatsDisabled?.attention === taskStatsBefore?.attention,
    `${taskStatsBefore?.disabled}→${taskStatsDisabled?.disabled} attention ${taskStatsBefore?.attention}→${taskStatsDisabled?.attention}`
  )

  // S8：「已禁用」档里看得到它
  check('切到「已禁用」筛选', (await clickAt(cdp, '[data-testid="tasks-filter-disabled"]')) === true)
  check(
    '已禁用档里出现夹具任务',
    (await waitFor(cdp, `!!document.querySelector('${taskRowSel}')`, 5000)) === true
  )
  check('切回「全部」筛选', (await clickAt(cdp, '[data-testid="tasks-filter-all"]')) === true)
  check(
    '全部档里行仍在（筛选切换不丢行）',
    (await waitFor(cdp, `!!document.querySelector('${taskRowSel}')`, 5000)) === true
  )

  check('再次点击（启用）', (await clickAt(cdp, `${taskRowSel} [data-testid="task-toggle"]`)) === true)
  check(
    '启用后行状态恢复（正常）',
    (await waitFor(
      cdp,
      `(() => {
        const row = document.querySelector('${taskRowSel}')
        return row && row.getAttribute('data-state') === 'ok'
      })()`,
      30000
    )) === true
  )
  check('系统侧确实恢复启用（COM）', taskEnabled() === '1', `enabled=${taskEnabled()}`)
  const taskStatsRestored = await evaluate(cdp, taskStatsExpr)
  check(
    '「已禁用」读数回落原值',
    taskStatsRestored?.disabled === taskStatsBefore?.disabled,
    `${taskStatsDisabled?.disabled} → ${taskStatsRestored?.disabled}`
  )

  /* ---- 005：任务删除登记（仅 missing 行有入口；取消不动；确认后任务消失） ---- */
  const deadTaskRowSel = `[data-testid="task-row"][data-name="${FIX_TASK_DEAD}"]`
  const deadTaskFactExpr = `(() => {
    const row = document.querySelector('${deadTaskRowSel}')
    if (!row) return null
    const btn = row.querySelector('[data-testid="task-delete"]')
    const sw = row.querySelector('[data-testid="task-toggle"]')
    return {
      state: row.getAttribute('data-state'),
      checked: sw ? sw.getAttribute('data-checked') : null,
      deleteName: btn ? btn.getAttribute('data-name') : null
    }
  })()`

  const dead0 = await evaluate(cdp, deadTaskFactExpr)
  check(
    '失效任务行可见：路径失效 + 有删除入口',
    dead0?.state === 'missing' && dead0?.deleteName === FIX_TASK_DEAD,
    JSON.stringify(dead0)
  )
  check(
    '健康任务行没有删除入口（S9）',
    (await evaluate(
      cdp,
      `(() => {
        const row = document.querySelector('${taskRowSel}')
        return row ? !!row.querySelector('[data-testid="task-delete"]') : null
      })()`
    )) === false
  )

  // 取消路径：对话框关掉，任务定义一个字节都不许动
  check(
    '点击删除（失效任务）',
    (await clickAt(cdp, `${deadTaskRowSel} [data-testid="task-delete"]`)) === true
  )
  check(
    '出现二次确认框（任务）',
    (await waitFor(cdp, `!!document.querySelector('[data-testid="task-delete-confirm"]')`, 5000)) === true
  )
  check('取消对话框（任务）', (await clickAt(cdp, '[data-slot="alert-dialog-cancel"]')) === true)
  check(
    '取消后确认框关闭（任务）',
    (await waitFor(cdp, `!document.querySelector('[data-testid="task-delete-confirm"]')`, 5000)) === true
  )
  check('取消不动任务（COM 侧仍存在）', taskExists(FIX_TASK_DEAD) === '1')
  check(
    '取消后行还在（仍是路径失效档）',
    (await evaluate(cdp, deadTaskFactExpr))?.state === 'missing'
  )

  // 确认删除：行消失、任务从计划程序移除、「需留意」与总数各回落 1
  const taskStatsBeforeDelete = await evaluate(cdp, taskStatsExpr)
  check(
    '点击删除（失效任务，二次）',
    (await clickAt(cdp, `${deadTaskRowSel} [data-testid="task-delete"]`)) === true
  )
  check(
    '出现二次确认框（任务，二次）',
    (await waitFor(cdp, `!!document.querySelector('[data-testid="task-delete-confirm"]')`, 5000)) === true
  )
  check('确认删除任务', (await clickAt(cdp, '[data-testid="task-delete-confirm-btn"]')) === true)
  check(
    '删除后行消失（强制重读）',
    (await waitFor(cdp, `!document.querySelector('${deadTaskRowSel}')`, 30000)) === true
  )
  check(
    '任务已从计划程序移除（COM 佐证）',
    taskExists(FIX_TASK_DEAD) === '0',
    `exists=${taskExists(FIX_TASK_DEAD)}`
  )
  const taskStatsAfterDelete = await evaluate(cdp, taskStatsExpr)
  check(
    '「需留意」与总数各回落 1',
    taskStatsAfterDelete?.attention === taskStatsBeforeDelete?.attention - 1 &&
      taskStatsAfterDelete?.total === taskStatsBeforeDelete?.total - 1,
    `attention ${taskStatsBeforeDelete?.attention}→${taskStatsAfterDelete?.attention} total ${taskStatsBeforeDelete?.total}→${taskStatsAfterDelete?.total}`
  )

  /* ---- 拒绝路径：stale / invalid / needs-admin（直接走 IPC 的真接缝） ---- */
  const stale = await evaluate(
    cdp,
    `window.opsCabin.applyAutoOp({ target: 'startup', action: 'toggle', id: 'registry-hkcu|OpsCabinE2ENotExist', enabled: false })`,
    true
  )
  check('不存在的条目被拒（stale）', stale?.ok === false && stale?.reason === 'stale', JSON.stringify(stale))

  const invalid1 = await evaluate(cdp, `window.opsCabin.applyAutoOp({})`, true)
  check('空操作被拒（invalid）', invalid1?.ok === false && invalid1?.reason === 'invalid', JSON.stringify(invalid1))

  const invalid2 = await evaluate(
    cdp,
    `window.opsCabin.applyAutoOp({ target: 'startup', action: 'toggle', id: 'registry-hkcu|${FIX_DISABLED}' })`,
    true
  )
  check('缺 enabled 被拒（invalid）', invalid2?.ok === false && invalid2?.reason === 'invalid', JSON.stringify(invalid2))

  // S6/D8：伪造删除 —— 主进程按自采集数据复核，非失效项一律拒绝（UI 不给入口只是第一道）
  const forgedDelete = await evaluate(
    cdp,
    `window.opsCabin.applyAutoOp({ target: 'startup', action: 'delete', id: 'registry-hkcu|${FIX_FRESH}' })`,
    true
  )
  check(
    '非失效项的删除请求被拒（denied）',
    forgedDelete?.ok === false && forgedDelete?.reason === 'denied',
    JSON.stringify(forgedDelete)
  )

  const forgedLnk = await evaluate(
    cdp,
    `window.opsCabin.applyAutoOp({ target: 'startup', action: 'delete', id: 'folder-user|${FIX_LNK}' })`,
    true
  )
  check(
    '正常 .lnk 的删除请求被拒（denied）',
    forgedLnk?.ok === false && forgedLnk?.reason === 'denied',
    JSON.stringify(forgedLnk)
  )

  const forgedStaleDelete = await evaluate(
    cdp,
    `window.opsCabin.applyAutoOp({ target: 'startup', action: 'delete', id: 'registry-hkcu|OpsCabinE2ENotExist' })`,
    true
  )
  check(
    '对不上条目的删除请求被拒（stale）',
    forgedStaleDelete?.ok === false && forgedStaleDelete?.reason === 'stale',
    JSON.stringify(forgedStaleDelete)
  )

  // 计划任务域（004）：对不上的任务与缺 enabled 的请求
  const taskStale = await evaluate(
    cdp,
    `window.opsCabin.applyAutoOp({ target: 'task', action: 'toggle', id: ${JSON.stringify('\\OpsCabinE2ENotExist')}, enabled: false })`,
    true
  )
  check(
    '不存在的任务被拒（stale）',
    taskStale?.ok === false && taskStale?.reason === 'stale',
    JSON.stringify(taskStale)
  )

  const taskNoEnabled = await evaluate(
    cdp,
    `window.opsCabin.applyAutoOp({ target: 'task', action: 'toggle', id: ${JSON.stringify(`\\${FIX_TASK}`)} })`,
    true
  )
  check(
    '任务缺 enabled 被拒（invalid）',
    taskNoEnabled?.ok === false && taskNoEnabled?.reason === 'invalid',
    JSON.stringify(taskNoEnabled)
  )

  const forgedTaskDelete = await evaluate(
    cdp,
    `window.opsCabin.applyAutoOp({ target: 'task', action: 'delete', id: ${JSON.stringify(`\\${FIX_TASK}`)} })`,
    true
  )
  check(
    '健康任务的删除请求被拒（denied）',
    forgedTaskDelete?.ok === false && forgedTaskDelete?.reason === 'denied',
    JSON.stringify(forgedTaskDelete)
  )

  // needs-admin（002 起走提权通道；自检模式下主进程短路，避免把 e2e 挂在 UAC 弹窗上）。
  // 需要本机真的存在 HKLM 来源的项；没有就如实标注未覆盖。
  const hklmId = await evaluate(
    cdp,
    `(async () => {
       const report = await window.opsCabin.listStartup(false)
       const item = report.items.find((i) => i.source === 'registry-hklm' || i.source === 'registry-hklm-wow' || i.source === 'folder-common')
       return item ? item.id : null
     })()`,
    true
  )
  if (hklmId) {
    // 「未做任何写入」的佐证：HKLM 启用位读前后一致（读 HKLM 不需要管理员）
    const bar = hklmId.indexOf('|')
    const src = hklmId.slice(0, bar)
    const entryName = hklmId.slice(bar + 1)
    const adminKey = {
      'registry-hklm': 'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run',
      'registry-hklm-wow': 'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run32',
      'folder-common': 'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\StartupFolder'
    }[src]
    const adminBytesBefore = readApprovedBytes(adminKey, entryName)
    const admin = await evaluate(
      cdp,
      `window.opsCabin.applyAutoOp({ target: 'startup', action: 'toggle', id: ${JSON.stringify(hklmId)}, enabled: false })`,
      true
    )
    const adminBytesAfter = readApprovedBytes(adminKey, entryName)
    check(
      '需要管理员的来源走提权通道（自检短路 needs-admin，HKLM 启用位未发生写入）',
      admin?.ok === false && admin?.reason === 'needs-admin' && adminBytesAfter === adminBytesBefore,
      `${JSON.stringify(admin)} bytes ${adminBytesBefore}→${adminBytesAfter}`
    )
  } else {
    console.log('  ⚠ 本机没有 HKLM/公共启动项 —— needs-admin 分支未能在真机覆盖（如实记录）')
  }

  console.log('== 退出应用 ==')
  check('退出生效（app:quit）', await quitApp(page, app))

  /* ---- 002：助手直调（--apply-op） ---- */
  console.log('== 助手直调（--apply-op） ==')

  // ① 正常路：FIX_FRESH 此刻「已禁用」（上一节的产物）→ 助手启用它并写回结果
  const beforeRef = readApprovedBytes(APPROVED_RUN, FIX_FRESH)
  const okFile = makePayloadFile(`ops-cabin-apply-${nonce()}.json`, {
    nonce: nonce(),
    at: Date.now(),
    op: { target: 'startup', action: 'toggle', id: `registry-hkcu|${FIX_FRESH}`, enabled: true }
  })
  const okRun = callHelper(okFile)
  const okResult = readHelperResult(okFile)
  check(
    '助手正常路：退出码 0 且结果文件为 ok',
    okRun.status === 0 && okResult?.ok === true,
    `code=${okRun.status} result=${JSON.stringify(okResult)}`
  )
  const helperBytes = readApprovedBytes(APPROVED_RUN, FIX_FRESH)
  check(
    '助手写回启用位 0x02，尾字节与直写路径同口径保留',
    helperBytes?.startsWith('02') === true && helperBytes?.slice(2) === beforeRef?.slice(2),
    `bytes=${helperBytes}（前 ${beforeRef}）`
  )

  // ② 陈旧请求（at 超 5 分钟）：拒收且不执行（若执行了，FIX_FRESH 会变成 0x03）
  const staleFile = makePayloadFile(`ops-cabin-apply-${nonce()}.json`, {
    nonce: nonce(),
    at: Date.now() - 10 * 60_000,
    op: { target: 'startup', action: 'toggle', id: `registry-hkcu|${FIX_FRESH}`, enabled: false }
  })
  const staleRun = callHelper(staleFile)
  const staleResult = readHelperResult(staleFile)
  check(
    '助手拒绝陈旧请求（invalid）且未执行（启用位仍为 0x02）',
    staleRun.status === 0 &&
      staleResult?.reason === 'invalid' &&
      readApprovedBytes(APPROVED_RUN, FIX_FRESH)?.startsWith('02') === true,
    `code=${staleRun.status} result=${JSON.stringify(staleResult)}`
  )

  // ③ 条目对不上（id 不在当前报告里）：stale
  const missFile = makePayloadFile(`ops-cabin-apply-${nonce()}.json`, {
    nonce: nonce(),
    at: Date.now(),
    op: { target: 'startup', action: 'toggle', id: 'registry-hkcu|OpsCabinE2ENotExist', enabled: true }
  })
  callHelper(missFile)
  const missResultAfter = readHelperResult(missFile)
  check(
    '助手对不上的条目返回 stale',
    missResultAfter?.ok === false && missResultAfter?.reason === 'stale',
    JSON.stringify(missResultAfter)
  )

  // ④ 封闭操作集：未知域一律 invalid（助手只认 startup / task 两域）
  const unknownFile = makePayloadFile(`ops-cabin-apply-${nonce()}.json`, {
    nonce: nonce(),
    at: Date.now(),
    op: { target: 'widget', action: 'toggle', id: 'x', enabled: false }
  })
  callHelper(unknownFile)
  const unknownResult = readHelperResult(unknownFile)
  check(
    '助手拒绝封闭操作集之外的目标（未知域 → invalid）',
    unknownResult?.ok === false && unknownResult?.reason === 'invalid',
    JSON.stringify(unknownResult)
  )

  // ④b 任务域：助手路由到任务执行器，真实改到 schtasks（直调不涉及提权，真值走 COM）
  const taskOffFile = makePayloadFile(`ops-cabin-apply-${nonce()}.json`, {
    nonce: nonce(),
    at: Date.now(),
    op: { target: 'task', action: 'toggle', id: `\\${FIX_TASK}`, enabled: false }
  })
  callHelper(taskOffFile)
  const taskOffResult = readHelperResult(taskOffFile)
  check(
    '助手任务域：禁用夹具任务（COM 佐证）',
    taskOffResult?.ok === true && taskEnabled() === '0',
    `${JSON.stringify(taskOffResult)} enabled=${taskEnabled()}`
  )

  const taskOnFile = makePayloadFile(`ops-cabin-apply-${nonce()}.json`, {
    nonce: nonce(),
    at: Date.now(),
    op: { target: 'task', action: 'toggle', id: `\\${FIX_TASK}`, enabled: true }
  })
  callHelper(taskOnFile)
  const taskOnResult = readHelperResult(taskOnFile)
  check(
    '助手任务域：启用夹具任务（COM 佐证）',
    taskOnResult?.ok === true && taskEnabled() === '1',
    `${JSON.stringify(taskOnResult)} enabled=${taskEnabled()}`
  )

  // ④c 任务删除域：重建失效夹具 → 助手真实删除；健康任务的删除被守卫拒绝
  const deadCreateAgain = createTaskFixture(FIX_TASK_DEAD, GHOST)
  check(
    '助手段：失效任务夹具重建',
    deadCreateAgain.status === 0 && taskExists(FIX_TASK_DEAD) === '1',
    `code=${deadCreateAgain.status} exists=${taskExists(FIX_TASK_DEAD)}`
  )
  const taskDeleteFile = makePayloadFile(`ops-cabin-apply-${nonce()}.json`, {
    nonce: nonce(),
    at: Date.now(),
    op: { target: 'task', action: 'delete', id: `\\${FIX_TASK_DEAD}` }
  })
  callHelper(taskDeleteFile)
  const taskDeleteResult = readHelperResult(taskDeleteFile)
  check(
    '助手任务域：删除失效任务（COM 佐证）',
    taskDeleteResult?.ok === true && taskExists(FIX_TASK_DEAD) === '0',
    `${JSON.stringify(taskDeleteResult)} exists=${taskExists(FIX_TASK_DEAD)}`
  )

  const guardedDeleteFile = makePayloadFile(`ops-cabin-apply-${nonce()}.json`, {
    nonce: nonce(),
    at: Date.now(),
    op: { target: 'task', action: 'delete', id: `\\${FIX_TASK}` }
  })
  callHelper(guardedDeleteFile)
  const guardedDeleteResult = readHelperResult(guardedDeleteFile)
  check(
    '助手任务域：健康任务的删除被拒（denied，守卫在助手侧同样生效）',
    guardedDeleteResult?.ok === false && guardedDeleteResult?.reason === 'denied',
    JSON.stringify(guardedDeleteResult)
  )

  // ⑤ 文件名不符合约定：退出码非 0 且不落结果文件（绝不往任意位置写）
  const evilFile = makePayloadFile(`ops-cabin-evil-${nonce()}.json`, {
    nonce: nonce(),
    at: Date.now(),
    op: { target: 'startup', action: 'toggle', id: `registry-hkcu|${FIX_FRESH}`, enabled: false }
  })
  const evilRun = callHelper(evilFile)
  check(
    '助手拒绝非约定文件名（exit≠0，无结果文件）',
    evilRun.status !== 0 && readHelperResult(evilFile) === null,
    `code=${evilRun.status}`
  )

  // ⑥ 请求文件不在系统临时目录：同样拒绝
  const outsideFile = join(userDataDir, `ops-cabin-apply-${nonce()}.json`)
  writeFileSync(
    outsideFile,
    JSON.stringify({
      nonce: nonce(),
      at: Date.now(),
      op: { target: 'startup', action: 'toggle', id: `registry-hkcu|${FIX_FRESH}`, enabled: false }
    }),
    'utf8'
  )
  helperArtifacts.push(outsideFile)
  const outsideRun = callHelper(outsideFile)
  check(
    '助手拒绝 tmpdir 之外的请求文件（exit≠0，无结果文件）',
    outsideRun.status !== 0 && readHelperResult(outsideFile) === null,
    `code=${outsideRun.status}`
  )

  exitCode = failures === 0 ? 0 : 1
} finally {
  cleanupFixtures()
  for (const file of helperArtifacts) {
    rmSync(file, { force: true })
    rmSync(`${file}.result`, { force: true })
  }
  rmSync(helperUserDataDir, { recursive: true, force: true })
}

console.log('')
console.log(failures === 0 ? '✅ E2E 全部通过' : `❌ E2E 失败 ${failures} 项`)
shutdown(exitCode)
