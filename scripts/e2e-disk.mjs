// M3 磁盘页与清理闭环的端到端验证（CDP 驱动）。
//
// 覆盖：分区列表 / 伪造路径防护 / 白名单防护 / 回收站删除（含回收站枚举验证）/
//       永久删除 / removed 语义 / UI 交互（页面渲染、tab、扫描取消、勾选、确认对话框）。
//
// 用法：node scripts/e2e-disk.mjs
// 说明：会在 %TEMP%/ops-cabin-disk-fixture 造夹具（结束即清理）；
//       删除测试会让 2 个小文件（64KB）进入回收站，属预期行为。
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as wait } from 'node:timers/promises'

const root = dirname(dirname(fileURLToPath(import.meta.url)))

/*
 * ELECTRON_RUN_AS_NODE 从宿主环境漏进来会让 electron.exe 退化成纯 Node ——
 * 没有 app、没有 BrowserWindow，主进程加载到 electron-updater 就炸
 * （报 `Cannot read properties of undefined (reading 'getVersion')`，
 * 栈底会看到 Node.js 的版本号而不是 Electron），表现为「应用未能在限定时间内完成加载」。
 * 这是宿主环境的事，不该要求每次调用都记得清 —— 与 e2e-smoke.mjs 同口径。
 */
delete process.env['ELECTRON_RUN_AS_NODE']
const PORT = 19226
const userDataDir = join(tmpdir(), 'ops-cabin-disk-e2e-userdata')
const smokeDir = join(tmpdir(), 'ops-cabin-smoke')
const fixtureRoot = join(tmpdir(), 'ops-cabin-disk-fixture')
const electronExe = join(root, 'node_modules', 'electron', 'dist', 'electron.exe')

const FILE_SIZE = 65536 // 64KB：够大（超过扫描阈值）又不给回收站添负担

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

/* ---------------- 夹具 ---------------- */

async function writeFiles(dir, count, size, prefix) {
  await mkdir(dir, { recursive: true })
  const data = Buffer.alloc(size, 7)
  const jobs = []
  for (let i = 0; i < count; i++) {
    jobs.push(writeFile(join(dir, `${prefix}${i}.bin`), data))
  }
  await Promise.all(jobs)
}

async function makeFixture() {
  rmSync(fixtureRoot, { recursive: true, force: true })
  const big = join(fixtureRoot, 'big')
  const whitelisted = join(fixtureRoot, 'whitelisted')
  await writeFiles(big, 3, FILE_SIZE, 'big')
  await writeFiles(whitelisted, 1, FILE_SIZE, 'big')
  return { big, whitelisted }
}

/* ---------------- 回收站枚举（Shell.Application） ---------------- */

function listRecycleBin() {
  const ps = [
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
    '$shell = New-Object -ComObject Shell.Application',
    '$bin = $shell.Namespace(10)',
    'if ($bin -ne $null) { $bin.Items() | ForEach-Object { $_.Name } }'
  ].join('\n')
  const encoded = Buffer.from(ps, 'utf16le').toString('base64')
  const r = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
    { encoding: 'utf8' }
  )
  return (r.stdout ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
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
    const page = targets?.find((t) => t.type === 'page' && t.title)
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

async function evaluate(cdp, expression, awaitPromise = false, timeoutMs = 60000) {
  const race = await Promise.race([
    cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise }),
    wait(timeoutMs).then(() => {
      throw new Error(`evaluate 超时（${timeoutMs}ms）：${expression.slice(0, 80)}`)
    })
  ])
  if (race.exceptionDetails) {
    throw new Error(race.exceptionDetails.exception?.description ?? race.exceptionDetails.text)
  }
  return race.result?.value
}

/** 轮询等待表达式真值（超时返回最后一次取值）——取消链路的目标可能很重，不钉死固定等待 */
async function waitForDom(cdp, expression, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  let value = null
  while (Date.now() < deadline) {
    value = await evaluate(cdp, expression).catch(() => null)
    if (value) return value
    await wait(200)
  }
  return value
}

/**
 * 派发一次真实鼠标点击（mousedown + mouseup）。
 * radix 的 Tabs 在 mousedown 激活，程序化 element.click() 不触发它 —— 一律用真实点击。
 */
async function clickAt(cdp, selector) {
  const info = await evaluate(
    cdp,
    `(() => {
      const el = document.querySelector(${JSON.stringify(selector)})
      if (!el) return 'null'
      const r = el.getBoundingClientRect()
      return JSON.stringify({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) })
    })()`
  )
  if (info === 'null' || info === null) return false
  const { x, y } = JSON.parse(info)
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
  return true
}

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
    await evaluate(cdp, 'window.opsCabin.quit()', true, 5000)
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

/* ---------------- 主流程 ---------------- */

console.log('== 构建 ==')
const build = spawnSync('pnpm build', { cwd: root, shell: true, encoding: 'utf8' })
if (build.status !== 0) {
  console.log(build.stdout ?? '')
  console.error(build.stderr ?? '')
  console.error('构建失败，中止')
  process.exit(1)
}

console.log('== 准备隔离环境与夹具 ==')
rmSync(userDataDir, { recursive: true, force: true })
rmSync(smokeDir, { recursive: true, force: true })
mkdirSync(userDataDir, { recursive: true })
const fixture = await makeFixture()
const big0 = join(fixture.big, 'big0.bin')
const big1 = join(fixture.big, 'big1.bin')
const big2 = join(fixture.big, 'big2.bin')
const bigW = join(fixture.whitelisted, 'big0.bin')

const app = launch()
const page = await waitForReadyPage()
if (!page) {
  console.error('应用未能在限定时间内完成加载')
  shutdown(1)
} else {
  const cdp = await connect(page.webSocketDebuggerUrl)
  const invoke = (code) => evaluate(cdp, code, true)

  /* ---------- A. 分区列表 ---------- */
  console.log('== A. 分区列表 ==')
  const volumes = JSON.parse(await invoke('window.opsCabin.listVolumes().then((v) => JSON.stringify(v))'))
  check('返回至少一块盘', Array.isArray(volumes) && volumes.length >= 1, `count=${volumes.length}`)
  check(
    '分区字段自洽（total = used + free）',
    volumes.every((v) => v.total === v.used + v.free && v.total > 0 && v.free >= 0)
  )
  check('包含系统盘', volumes.some((v) => v.name === 'C:'))

  /* ---------- B. 伪造路径防护 ---------- */
  console.log('== B. 伪造路径防护（安全边界） ==')
  const forged = JSON.parse(
    await invoke(
      `window.opsCabin.runClean(${JSON.stringify([
        { path: 'C:\\Windows\\System32\\notepad.exe', bytes: 100 }
      ])}, 'recycle').then((r) => JSON.stringify(r))`
    )
  )
  check(
    '未扫描过的路径被拒绝',
    forged.ok === true &&
      forged.result.succeeded === 0 &&
      forged.result.failed[0]?.error?.includes('不在本次扫描结果'),
    forged.result?.failed?.[0]?.error
  )
  check('目标文件未被动过', existsSync('C:\\Windows\\System32\\notepad.exe'))

  /* ---------- C. 扫描夹具 + 白名单防护 ---------- */
  console.log('== C. 扫描夹具与白名单 ==')
  const scanExpr = JSON.stringify({
    groups: ['largeFiles'],
    largeFileRoots: [fixtureRoot],
    largeFileMinBytes: 1024
  })
  const scanned = JSON.parse(
    await invoke(`window.opsCabin.startScan(${scanExpr}).then((o) => JSON.stringify(o))`)
  )
  check('夹具扫描成功', scanned.ok === true, scanned.ok ? '' : scanned.error)
  const scanItems = scanned.ok ? scanned.result.groups[0].items : []
  check('命中 4 个夹具文件', scanItems.length === 4, `count=${scanItems.length}`)

  await invoke(
    `window.opsCabin.updateSettings({ whitelist: [${JSON.stringify(fixture.whitelisted)}] }).then((s) => JSON.stringify(s))`
  )
  const whitelisted = JSON.parse(
    await invoke(
      `window.opsCabin.runClean(${JSON.stringify([
        { path: bigW, bytes: FILE_SIZE }
      ])}, 'recycle').then((r) => JSON.stringify(r))`
    )
  )
  check(
    '白名单路径被拒绝',
    whitelisted.ok === true &&
      whitelisted.result.succeeded === 0 &&
      whitelisted.result.failed[0]?.error?.includes('白名单'),
    whitelisted.result?.failed?.[0]?.error
  )
  check('白名单文件仍在', existsSync(bigW))
  await invoke('window.opsCabin.updateSettings({ whitelist: [] }).then((s) => JSON.stringify(s))')

  /* ---------- D. 回收站删除 ---------- */
  console.log('== D. 回收站删除 ==')
  const cleaned = JSON.parse(
    await invoke(
      `window.opsCabin.runClean(${JSON.stringify([
        { path: big0, bytes: FILE_SIZE },
        { path: big1, bytes: FILE_SIZE }
      ])}, 'recycle').then((r) => JSON.stringify(r))`
    )
  )
  check('清理成功返回', cleaned.ok === true, cleaned.ok ? '' : cleaned.error)
  check(
    '两项删除成功',
    cleaned.result.succeeded === 2 && cleaned.result.failed.length === 0,
    JSON.stringify(cleaned.result.failed)
  )
  check('释放字节正确', cleaned.result.freedBytes === 2 * FILE_SIZE, `${cleaned.result.freedBytes}`)
  check('removed 列表含两项', cleaned.result.removed.length === 2)
  check('文件已从磁盘消失', !existsSync(big0) && !existsSync(big1))

  const recycleNames = listRecycleBin()
  check(
    '回收站里能找到被删文件（可还原）',
    recycleNames.includes('big0.bin') && recycleNames.includes('big1.bin'),
    `回收站共 ${recycleNames.length} 项`
  )

  /* ---------- E. 永久删除 ---------- */
  console.log('== E. 永久删除 ==')
  const permanent = JSON.parse(
    await invoke(
      `window.opsCabin.runClean(${JSON.stringify([
        { path: big2, bytes: FILE_SIZE }
      ])}, 'permanent').then((r) => JSON.stringify(r))`
    )
  )
  check(
    '永久删除成功',
    permanent.ok === true && permanent.result.succeeded === 1 && permanent.result.mode === 'permanent'
  )
  check('文件已消失', !existsSync(big2))

  /* ---------- F. removed 语义（重复清理） ---------- */
  console.log('== F. 重复清理语义 ==')
  const again = JSON.parse(
    await invoke(
      `window.opsCabin.runClean(${JSON.stringify([
        { path: big2, bytes: FILE_SIZE }
      ])}, 'recycle').then((r) => JSON.stringify(r))`
    )
  )
  check(
    '已不存在的目标记入 removed（不算失败）',
    again.ok === true &&
      again.result.removed.length === 1 &&
      again.result.failed.length === 0 &&
      again.result.succeeded === 0
  )

  /* ---------- G. UI 交互闭环 ---------- */
  console.log('== G. UI 交互 ==')
  await evaluate(
    cdp,
    // 按 testid 导航：侧栏按钮里现在还会渲染徽标文本（M14 起），按 textContent 精确匹配会落空
    `document.querySelector('[data-testid="nav-disk"]')?.click(); 'ok'`
  )
  await wait(1500)
  check('磁盘页渲染', (await evaluate(cdp, `!!document.querySelector('[data-testid="scan-start"]')`)) === true)
  const volumeRows = await evaluate(cdp, `document.querySelectorAll('[data-testid="volume-row"]').length`)
  check('分区列表有数据', volumeRows >= 1, `count=${volumeRows}`)

  check('切换大文件 tab', await clickAt(cdp, '[data-testid="tab-largeFiles"]'))
  await wait(500)
  const emptyText = await evaluate(
    cdp,
    `document.querySelector('[data-testid="empty-state"]')?.textContent ?? ''`
  )
  check('大文件 tab 空态提示引导', emptyText.includes('选择目录'), emptyText.slice(0, 40))

  // 扫描真实系统位置（safe + devCaches），等结果行出现
  check('切回安全清理 tab', await clickAt(cdp, '[data-testid="tab-safe"]'))
  await wait(300)
  check('点击开始扫描', await clickAt(cdp, '[data-testid="scan-start"]'))
  let rowCount = 0
  for (let i = 0; i < 90; i++) {
    await wait(500)
    rowCount = await evaluate(cdp, `document.querySelectorAll('[data-testid="result-row"]').length`)
    if (rowCount > 0) break
  }
  check('UI 扫描出结果行', rowCount > 0, `rows=${rowCount}`)

  if (rowCount > 0) {
    check('勾选第一行', await clickAt(cdp, '[data-testid="result-row"] [role="checkbox"]'))
    await wait(300)
    const summary = await evaluate(
      cdp,
      `document.querySelector('[data-testid="selection-summary"]')?.textContent ?? ''`
    )
    check('勾选后计数更新', summary.includes('已选 1 项'), summary)

    check('打开清理确认对话框', await clickAt(cdp, '[data-testid="clean-open"]'))
    await wait(500)
    const dialogText = await evaluate(
      cdp,
      `document.querySelector('[data-testid="clean-dialog"]')?.textContent ?? ''`
    )
    check(
      '确认对话框出现且说明去向',
      dialogText.includes('清理') && dialogText.includes('回收站'),
      dialogText.replace(/\s+/g, ' ').slice(0, 50)
    )

    // 不真清理系统文件：点取消关闭（按 data-slot 精确命中 Cancel ——
    // 对话框里的 radix Checkbox 也是 button，宽泛的 selector 会误点到它）
    check('取消对话框', await clickAt(cdp, '[data-slot="alert-dialog-cancel"]'))
    await wait(400)
    check(
      '对话框已关闭（未执行清理）',
      (await evaluate(cdp, `!!document.querySelector('[data-testid="clean-dialog"]')`)) === false
    )
  }

  // 扫描取消交互（点「扫描主目录」后立刻取消）。
  // 先按 Escape 兜底关闭可能遗留的 modal 对话框（modal 会拦截一切鼠标事件）
  await evaluate(
    cdp,
    `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); 'ok'`
  )
  await wait(300)
  await clickAt(cdp, '[data-testid="tab-largeFiles"]')
  await wait(400)
  check('点击扫描主目录', await clickAt(cdp, '[data-testid="scan-home"]'))
  await wait(700)
  check(
    '扫描进度条出现',
    (await evaluate(cdp, `!!document.querySelector('[data-testid="scan-progress"]')`)) === true
  )
  check('点击取消扫描', await clickAt(cdp, '[data-testid="scan-cancel"]'))
  // 取消是「杀扫描进程 → exit → outcome 回到渲染层 → finally 清进度」的链：
  // 高负载下退出确认到 2–3 秒都可能（本机实测）—— 轮询等它消失，不钉死 900ms
  check(
    '取消后进度条消失',
    (await waitForDom(cdp, `!document.querySelector('[data-testid="scan-progress"]')`, 5000)) === true
  )

  /* ---------- H. 盘符快捷入口（M15-006） ---------- */
  console.log('== H. 盘符快捷入口 ==')
  const volumeButtons = await evaluate(
    cdp,
    `document.querySelectorAll('[data-testid="scan-volume"]').length`
  )
  check('分区列表出现盘符入口', volumeButtons >= 1, `count=${volumeButtons}`)
  check('点击「扫这颗盘」（C:）', await clickAt(cdp, '[data-testid="scan-volume"][data-volume="C:"]'))
  await wait(700)
  check(
    '盘符扫描进入扫描态',
    (await evaluate(cdp, `!!document.querySelector('[data-testid="scan-progress"]')`)) === true
  )
  check('取消盘符扫描', await clickAt(cdp, '[data-testid="scan-cancel"]'))
  check(
    '取消后进度条消失',
    (await waitForDom(cdp, `!document.querySelector('[data-testid="scan-progress"]')`, 5000)) === true
  )

  cdp.close()
  check('退出应用', await quitApp(page, app))
}

console.log('== 清理夹具 ==')
rmSync(fixtureRoot, { recursive: true, force: true })

console.log('')
console.log(failures === 0 ? '✅ E2E-DISK 全部通过' : `❌ E2E-DISK 失败 ${failures} 项`)
shutdown(failures === 0 ? 0 : 1)
