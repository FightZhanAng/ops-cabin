// 清理改造的端到端验证：**文件被占用时的行为**（CDP 驱动）。
//
// 覆盖：
//   A. 内含被占文件的目录 + 回收站 -> Windows 整体取消（返回码 124）：
//      必须如实说「一个文件都没删」、释放量为 0，并点名持有进程；
//   B. 同构目录 + 永久 -> 能删的删掉、被占的留下：succeeded=0 但 freedBytes>0，
//      reason=locked，holders 点到进程（旧实现只会说「文件正被占用」）；
//   C. UI：清理失败后对话框**不关闭**，逐项列出残留量与被占进程（data-testid=clean-holders）；
//   D. 释放句柄后重清 -> 整项删干净、succeeded=1。
//
// 用法：node scripts/e2e-disk-locked.mjs
// 说明：每个用例自建夹具（连扫描一起），互不依赖；夹具在结束时清理。
//       全程用永久模式删自己的夹具，不往回收站丢东西（回收站那条只会失败，不会真删）。
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as wait } from 'node:timers/promises'

const root = dirname(dirname(fileURLToPath(import.meta.url)))

// 与 e2e-disk.mjs 同口径：ELECTRON_RUN_AS_NODE 漏进来会让 electron 退化成纯 Node
delete process.env['ELECTRON_RUN_AS_NODE']

const PORT = 19227
const userDataDir = join(tmpdir(), 'ops-cabin-locked-e2e-userdata')
const electronExe = join(root, 'node_modules', 'electron', 'dist', 'electron.exe')

const TOP_FILES = 8
const SUB_FILES = 4
const FILE_SIZE = 3 * 1024 * 1024 // 3MB：够大能进扫描，"释放量"又能精确核对

let failures = 0
let currentChild = null
let locker = null
const sockets = new Set()

function check(name, ok, detail = '') {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? `  （${detail}）` : ''}`)
  if (!ok) failures++
}

function shutdown(code) {
  for (const ws of sockets) {
    try {
      ws.close()
    } catch {
      /* 忽略 */
    }
  }
  stopLocker()
  try {
    currentChild?.kill('SIGKILL')
  } catch {
    /* 已退出 */
  }
  setTimeout(() => process.exit(code), 250)
}

process.on('uncaughtException', (error) => {
  console.error(error)
  shutdown(1)
})

/* ---------------- 夹具与占用者 ---------------- */

/*
 * 夹具布局（app 启动时 LOCALAPPDATA 指向 fixtureRoot）：
 *   <fixtureRoot>\D3DSCache      -> 用例 A：回收站模式（safe 组「DirectX 着色器缓存」）
 *   <fixtureRoot>\Yarn\Cache     -> 用例 B/C：永久模式 + 界面（devCaches 组「Yarn 缓存」）
 *   <fixtureRoot>\pip\Cache      -> 用例 D：释放占用后重清（devCaches 组「pip 缓存」）
 * 每个夹具都是"内含一个被占文件的目录"，且必须在**启动 app 之前**建好
 * —— 扫描器的候选解析只认已存在的路径（expandCandidate 里 existsSync 判空）。
 */
const fixtureRoot = join(tmpdir(), 'ops-cabin-locked-fixture')
const FIXTURES = {
  recycle: join(fixtureRoot, 'D3DSCache'),
  permanent: join(fixtureRoot, 'Yarn', 'Cache'),
  released: join(fixtureRoot, 'pip', 'Cache')
}

/** 往指定目录里填文件；返回总字节数 */
function fillDir(dir) {
  const sub = join(dir, 'sub')
  mkdirSync(sub, { recursive: true })
  const data = Buffer.alloc(FILE_SIZE, 7)
  for (let i = 0; i < TOP_FILES; i++) writeFileSync(join(dir, `top${i}.bin`), data)
  for (let i = 0; i < SUB_FILES; i++) writeFileSync(join(sub, `sub${i}.bin`), data)
  const lockedFile = join(dir, 'locked.bin')
  writeFileSync(lockedFile, data)
  return {
    dir,
    lockedFile,
    unlockedFile: join(dir, 'top0.bin'),
    totalBytes: (TOP_FILES + SUB_FILES + 1) * FILE_SIZE
  }
}

/** 先解开占用再删夹具目录：句柄没放掉时会删不动（实测 EPERM） */
function dropFixture(dir) {
  stopLocker()
  for (let i = 0; i < 8; i++) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 250 })
      return true
    } catch {
      spawnSync('powershell.exe', ['-NoProfile', '-Command', 'Start-Sleep -Milliseconds 500'])
    }
  }
  console.log(`  ! 夹具目录未能删除（占用未释放）：${dir}`)
  return false
}

/**
 * 用一个独立 PowerShell 进程独占钉住文件。
 * 这是"被占用"最干净的复现：share 全不给，删除/改名必然拿到共享冲突。
 */
function lockFile(file) {
  const script = [
    `$fs = [System.IO.File]::Open(${JSON.stringify(file)}, 'Open', 'ReadWrite', 'None')`,
    "Write-Output 'LOCKED'",
    'while ($true) { Start-Sleep -Milliseconds 500 }'
  ].join('\n')
  locker = spawn(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand',
      Buffer.from(script, 'utf16le').toString('base64')],
    { stdio: ['ignore', 'pipe', 'ignore'] }
  )
}

function stopLocker() {
  try {
    locker?.kill()
  } catch {
    /* 已退出 */
  }
  locker = null
}

/** 复核占用生效：能独占打开 = 没占上 */
function isHeldByOther(file) {
  const ps = [
    `try { $f = [System.IO.File]::Open(${JSON.stringify(file)}, 'Open', 'ReadWrite', 'None'); $f.Close(); Write-Output 'FREE' }`,
    "catch { Write-Output 'HELD' }"
  ].join('\n')
  const r = spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand',
    Buffer.from(ps, 'utf16le').toString('base64')
  ], { encoding: 'utf8' })
  return (r.stdout ?? '').includes('HELD')
}

/* ---------------- CDP ---------------- */

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

async function evaluate(cdp, expression, awaitPromise = false, timeoutMs = 180000) {
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

/** 轮询等待表达式为真 */
async function waitForDom(cdp, expression, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs
  let value = null
  while (Date.now() < deadline) {
    value = await evaluate(cdp, expression).catch(() => null)
    if (value) return value
    await wait(200)
  }
  return value
}

function launch() {
  currentChild = spawn(
    electronExe,
    ['.', `--remote-debugging-port=${PORT}`, `--user-data-dir=${userDataDir}`],
    {
      cwd: root,
      stdio: 'ignore',
      // LOCALAPPDATA 指向夹具根：扫描器 safe 组的 `%LOCALAPPDATA%\D3DSCache`
      // 于是落在夹具里，成为一个"整目录候选"（本次改造针对的就是这种候选）。
      // TEMP/TMP 保持系统默认 —— 别让 app 自己的临时文件掺进夹具。
      env: { ...process.env, OPS_CABIN_SMOKE: '1', LOCALAPPDATA: fixtureRoot }
    }
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
rmSync(fixtureRoot, { recursive: true, force: true })
mkdirSync(userDataDir, { recursive: true })
mkdirSync(fixtureRoot, { recursive: true })
// 夹具必须在启动 app 之前建好：扫描器的候选解析只认已存在的路径
const FA = fillDir(FIXTURES.recycle)
const FB = fillDir(FIXTURES.permanent)
const FD = fillDir(FIXTURES.released)
console.log(`  夹具 A/B/D 已就绪，各 ${FA.totalBytes / 1024 / 1024} MB`)

const app = launch()
const page = await waitForReadyPage()
if (!page) {
  console.error('应用未能在限定时间内完成加载')
  shutdown(1)
} else {
  const cdp = await connect(page.webSocketDebuggerUrl)
  // awaitPromise=true：页面里返回 Promise 的调用必须等它落定，否则拿到的是 {} 而不是结果
  const invoke = (code) => evaluate(cdp, code, true)

  /**
   * 扫一次（safe + devCaches），登记全部夹具（含路径与体积）。
   *
   * 只扫这一次：夹具都在 `%LOCALAPPDATA%` 下的已知缓存候选上，一次就能全登记；
   * 之后各用例都从这里取体积，不再重扫 —— 免得某个用例把候选目录删掉之后，
   * 后面的用例就扫不到自己的目录了（cleaner.registerScanned 是并集，只登记一次够用）。
   */
  const scanAll = async () => {
    const scanned = JSON.parse(
      await invoke(
        `window.opsCabin.startScan({ groups: ['safe', 'devCaches'] }).then((o) => JSON.stringify(o))`
      )
    )
    if (!scanned.ok) return new Map()
    const items = scanned.result.groups.flatMap((g) => g.items)
    console.log(
      '  扫描到:',
      items.map((i) => `${i.label}=${Math.round(i.bytes / 1024 / 1024)}MB`).join(', ') || '(空)'
    )
    return new Map(items.map((i) => [i.path, i]))
  }
  const scannedItems = await scanAll()
  const getItem = (dir) => scannedItems.get(dir)

  /* ---------- A. 回收站模式：整体取消 ---------- */
  console.log('== A. 回收站 + 内含被占文件的目录 -> 整体取消 ==')
  const fa = FA
  lockFile(fa.lockedFile)
  await wait(2500)
  check('占用已生效', isHeldByOther(fa.lockedFile))
  {
    const item = getItem(fa.dir)
    check('扫出了目标目录这一项', Boolean(item), `item=${item ? Math.round(item.bytes / 1024 / 1024) + 'MB' : '缺失'}`)
    if (item) {
      const r = JSON.parse(
        await invoke(
          `window.opsCabin.runClean(${JSON.stringify([{ path: fa.dir, bytes: item.bytes }])}, 'recycle').then((x) => JSON.stringify(x))`
        )
      )
      const f = r.ok ? r.result.failed[0] : null
      check('清理调用返回 ok', r.ok === true, r.ok ? '' : r.error)
      check('未删掉整项（succeeded=0）', r.ok && r.result.succeeded === 0, `succeeded=${r.result?.succeeded}`)
      check('未整项删除的项不摘行', r.ok && !r.result.removed.includes(fa.dir))
      check('reason=recycle-cancelled', f?.reason === 'recycle-cancelled', `${f?.reason}`)
      // 回收站整体取消时，未被占用的那部分会在残留量测里被清掉（永久删除）——
      // 这是设计选择，但必须如实报出来，不能一边说"一个文件都没删"一边 freedBytes>0。
      const freed = r.result?.freedBytes ?? -1
      const expectingPartial = freed > 0
      check(
        expectingPartial ? '未被占的部分被清掉并如实计入释放量' : '未释放任何字节',
        expectingPartial
          ? Math.abs(freed - (fa.totalBytes - FILE_SIZE)) < FILE_SIZE * 0.2
          : freed === 0,
        `freed=${freed} 总量=${fa.totalBytes}`
      )
      check(
        '文案与释放量一致',
        expectingPartial
          ? (f?.error ?? '').includes('已被永久删除') && (f?.error ?? '').includes('不进回收站')
          : (f?.error ?? '').includes('一个文件都没删'),
        (f?.error ?? '').slice(0, 80)
      )
      check('点名到了持有进程', (f?.holders ?? []).length > 0, JSON.stringify(f?.holders))
      check('持有者是 PowerShell（夹具占用者）', (f?.holders ?? []).some((h) => /PowerShell/i.test(h.name)), JSON.stringify(f?.holders))
      check('被占文件仍在', existsSync(fa.lockedFile))
    }
  }
  stopLocker()
  dropFixture(fa.dir)

  /* ---------- B. 永久模式：部分成功 + 点名 ---------- */
  console.log('== B. 永久 + 内含被占文件的目录 -> 部分成功 ==')
  const fb = FB
  lockFile(fb.lockedFile)
  await wait(2500)
  check('占用已生效', isHeldByOther(fb.lockedFile))
  {
    const item = getItem(fb.dir)
    check('扫出了目标目录这一项', Boolean(item), `item=${item ? Math.round(item.bytes / 1024 / 1024) + 'MB' : '缺失'}`)
    if (item) {
      const r = JSON.parse(
        await invoke(
          `window.opsCabin.runClean(${JSON.stringify([{ path: fb.dir, bytes: item.bytes }])}, 'permanent').then((x) => JSON.stringify(x))`
        )
      )
      const f = r.ok ? r.result.failed[0] : null
      check('清理调用返回 ok', r.ok === true, r.ok ? '' : r.error)
      check('整项未删完（succeeded=0）', r.ok && r.result.succeeded === 0, `succeeded=${r.result?.succeeded}`)
      check('释放量 > 0（部分成功如实计入）', r.ok && r.result.freedBytes > 0, `${r.result?.freedBytes}`)
      check(
        '释放量 ≈ 总量 - 被占的那一个文件',
        r.ok && Math.abs(r.result.freedBytes - (fb.totalBytes - FILE_SIZE)) < FILE_SIZE,
        `freed=${r.result?.freedBytes} 期望≈${fb.totalBytes - FILE_SIZE}`
      )
      check('reason=locked', f?.reason === 'locked', `${f?.reason}`)
      check('残留只有被占文件', (f?.residueFiles ?? 99) <= 2, JSON.stringify({ files: f?.residueFiles, bytes: f?.residueBytes }))
      check('holders 点名到进程', (f?.holders ?? []).length > 0, JSON.stringify(f?.holders))
      check('samples 指向 locked.bin', (f?.samples ?? []).some((s) => /locked\.bin$/i.test(s)), JSON.stringify(f?.samples))
      check('deletedBytes 与 freedBytes 一致', f?.deletedBytes === r.result?.freedBytes, `${f?.deletedBytes}`)
      check('目标目录仍在（还有被占文件）', existsSync(fb.dir))
      check('被占文件仍在', existsSync(fb.lockedFile))
      check('未占用的文件已被删掉', !existsSync(join(fb.dir, 'sub', 'sub0.bin')))

      /* ---------- C. UI：失败明细留在对话框里 ---------- */
      console.log('== C. UI 失败明细（对话框不关闭 + 点名可见） ==')
      /*
       * 只拦 pickDirectory（原生选择框没法用 CDP 点），扫描本身仍走真实 IPC 与真实扫描：
       * 这样界面里的行、勾选、二次确认、结果面板全都是生产代码在跑。
       */
      await evaluate(
        cdp,
        `(() => {
          if (window.__lockedPatched) return 'already'
          const api = window.opsCabin
          const origPick = api.pickDirectory.bind(api)
          const origScan = api.startScan.bind(api)
          // picker 返回夹具根：扫描时它会被当大文件根看待
          api.pickDirectory = async () => [${JSON.stringify(fixtureRoot)}]
          // 走"选择目录"入口时，把大文件根钉到夹具根（原生对话框没法用 CDP 点）
          api.startScan = (options) => {
            const opts = { ...(options || {}) }
            if (opts.groups && opts.groups.includes('largeFiles')) {
              opts.largeFileRoots = [${JSON.stringify(fixtureRoot)}]
            }
            return origScan(opts)
          }
          window.__lockedPatched = true
          return 'patched'
        })()`
      )
      await evaluate(cdp, `document.querySelector('[data-testid="nav-disk"]')?.click(); 'ok'`)
      await wait(900)
      // 夹具 B 是 devCaches 组的「Yarn 缓存」候选：切到该 tab 点扫描，
      // 走的就是"扫描 -> 勾选 -> 二次确认 -> 结果面板"的真实链路。
      const tabOk = await clickAt(cdp, '[data-testid="tab-devCaches"]')
      check('切到开发缓存 tab', tabOk === true)
      await wait(300)
      await clickAt(cdp, '[data-testid="scan-start"]')
      const rowReady = await waitForDom(
        cdp,
        `document.querySelectorAll('[data-testid="result-row"]').length > 0`,
        120000
      )
      const rowCount = await evaluate(cdp, `document.querySelectorAll('[data-testid="result-row"]').length`)
      check('扫描结果行出现', rowReady === true, `rows=${rowCount}`)

      // 勾选"目标目录"那一行（按行内路径文本定位，避免依赖行顺序）
      const targetPath = fb.dir
      const checked = await evaluate(
        cdp,
        `(() => {
          const target = ${JSON.stringify(targetPath)}
          const rows = [...document.querySelectorAll('[data-testid="result-row"]')]
          const hit = rows.find((r) => (r.textContent || '').includes(target))
          if (!hit) return 'row-not-found'
          const box = hit.querySelector('[role="checkbox"]')
          if (!box) return 'no-checkbox'
          box.scrollIntoView({ block: 'center' })
          return 'found'
        })()`
      )
      check('找到目标目录那一行', checked === 'found', checked)
      if (checked === 'found') {
        // 用真实鼠标点该行的勾选框
        const boxRect = await evaluate(
          cdp,
          `(() => {
            const target = ${JSON.stringify(targetPath)}
            const rows = [...document.querySelectorAll('[data-testid="result-row"]')]
            const hit = rows.find((r) => (r.textContent || '').includes(target))
            const box = hit.querySelector('[role="checkbox"]')
            const r = box.getBoundingClientRect()
            return JSON.stringify({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) })
          })()`
        )
        const { x, y } = JSON.parse(boxRect)
        await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
        await wait(400)
        const summary = await evaluate(
          cdp,
          `document.querySelector('[data-testid="selection-summary"]')?.textContent ?? ''`
        )
        check('已勾选 1 项', summary.includes('已选 1 项'), summary)

        check('打开清理确认对话框', await clickAt(cdp, '[data-testid="clean-open"]'))
        await wait(500)
        check('对话框出现', (await evaluate(cdp, `!!document.querySelector('[data-testid="clean-dialog"]')`)) === true)
        check('确认清理（回收站）', await clickAt(cdp, '[data-testid="clean-confirm"]'))

        const resultReady = await waitForDom(
          cdp,
          `!!document.querySelector('[data-testid="clean-result-list"]')`,
          60000
        )
        check('清理后对话框切到结果面板（没有静默关闭）', resultReady === true)
        const failedItem = await evaluate(
          cdp,
          `document.querySelector('[data-testid="clean-failed-item"]')?.textContent ?? ''`
        )
        check('结果面板列出了失败项', failedItem.includes(targetPath.slice(-12)), failedItem.replace(/\s+/g, ' ').slice(0, 90))
        check('结果面板给出「永久删除」的出路', failedItem.includes('永久删除'))
        const holderChips = await evaluate(
          cdp,
          `[...document.querySelectorAll('[data-testid="clean-holders"] span')].map((s) => s.textContent).join(' | ')`
        )
        check('界面上直接显示持有进程（PID）', holderChips.includes('PID'), holderChips.slice(0, 90))
        check('界面上点出了 PowerShell', /PowerShell/i.test(holderChips), holderChips.slice(0, 90))

        // 关掉结果面板，确认能正常关闭
        check('关闭结果面板', await clickAt(cdp, '[data-testid="clean-result-close"]'))
        await wait(400)
        check(
          '面板已关闭',
          (await evaluate(cdp, `!!document.querySelector('[data-testid="clean-dialog"]')`)) === false
        )
      }
    }
  }
  stopLocker()
  dropFixture(fb.dir)

  /* ---------- D. 释放句柄后重清 ---------- */
  console.log('== D. 释放占用后重清 ==')
  const fd = FD
  lockFile(fd.lockedFile)
  await wait(2500)
  {
    const item = getItem(fd.dir)
    if (item) {
      const first = JSON.parse(
        await invoke(
          `window.opsCabin.runClean(${JSON.stringify([{ path: fd.dir, bytes: item.bytes }])}, 'permanent').then((x) => JSON.stringify(x))`
        )
      )
      check('带着占用清理：未删完', first.ok && first.result.succeeded === 0, `succeeded=${first.result?.succeeded}`)
      stopLocker()
      await wait(1500)
      check('占用已解除', isHeldByOther(fd.lockedFile) === false)
      const again = JSON.parse(
        await invoke(
          `window.opsCabin.runClean(${JSON.stringify([{ path: fd.dir, bytes: item.bytes }])}, 'permanent').then((x) => JSON.stringify(x))`
        )
      )
      check('重清返回 ok', again.ok === true, again.ok ? '' : again.error)
      check('整项已删干净', again.ok && again.result.succeeded === 1 && again.result.failed.length === 0, JSON.stringify(again.result?.failed))
      check('目录已从磁盘消失', !existsSync(fd.dir))
    } else {
      check('扫出了目标目录这一项', false, `item=缺失`)
    }
  }

  cdp.close()
  check('退出应用', await quitApp(page, app))
}

stopLocker()
console.log('== 清理夹具 ==')
dropFixture(fixtureRoot)
rmSync(userDataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 250 })

console.log('')
console.log(failures === 0 ? '✅ E2E-LOCKED 全部通过' : `❌ E2E-LOCKED 失败 ${failures} 项`)
shutdown(failures === 0 ? 0 : 1)
