// M2 磁盘扫描引擎的端到端验证（CDP 驱动，跑真实应用与真实文件扫描）。
//
// 覆盖：largeFiles 产物精确核对 / 多根合并与排序（M15-006） / 白名单排除 / 取消（含耗时）/
//       接管语义 / 进度推送 / 扫描期间渲染进程响应 / safe 组真实位置结构 /
//       清理位置多 profile 枚举（M15-007，LOCALAPPDATA/APPDATA 覆盖到夹具）。
//
// 用法：node scripts/e2e-scan.mjs
// 说明：会在 %TEMP%/ops-cabin-scan-fixture 下生成约 3 万个测试文件（结束即清理）；
//       应用实例的 LOCALAPPDATA / APPDATA 指到夹具，不碰真实用户目录。
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
const PORT = 19225
const userDataDir = join(tmpdir(), 'ops-cabin-scan-e2e-userdata')
const smokeDir = join(tmpdir(), 'ops-cabin-smoke')
const fixtureRoot = join(tmpdir(), 'ops-cabin-scan-fixture')
const electronExe = join(root, 'node_modules', 'electron', 'dist', 'electron.exe')

const TWO_MB = 2 * 1024 * 1024
const THREE_MB = 3 * 1024 * 1024

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

/* ---------------- 测试夹具 ---------------- */

async function writeFiles(dir, count, size, prefix = 'f') {
  await mkdir(dir, { recursive: true })
  const data = Buffer.alloc(size, 7)
  const batch = 500
  for (let i = 0; i < count; i += batch) {
    const jobs = []
    for (let j = i; j < Math.min(i + batch, count); j++) {
      jobs.push(writeFile(join(dir, `${prefix}${j}.bin`), data))
    }
    await Promise.all(jobs)
  }
}

async function makeFixture() {
  rmSync(fixtureRoot, { recursive: true, force: true })
  const small = join(fixtureRoot, 'small')
  const big = join(fixtureRoot, 'big')
  const whitelisted = join(fixtureRoot, 'whitelisted')
  const huge = join(fixtureRoot, 'huge')
  const second = join(fixtureRoot, 'second')

  await writeFiles(small, 500, 128)
  await writeFiles(big, 200, 128)
  await writeFiles(big, 3, TWO_MB, 'big')
  await writeFiles(whitelisted, 50, 128)
  await writeFiles(whitelisted, 1, TWO_MB, 'big')
  await writeFiles(huge, 30000, 0)
  // 多根合并用（M15-006）：第二个根里放一个 3MB 与一个 1MB
  await writeFiles(second, 1, THREE_MB, 'secBig')
  await writeFiles(second, 1, TWO_MB / 2, 'secSmall')

  // ≤8 截断用（M15-006）：9 个各带一个大文件的根，最末一个必须被截掉
  const many = []
  for (let i = 1; i <= 9; i++) {
    const dir = join(fixtureRoot, `multi${i}`)
    await writeFiles(dir, 1, TWO_MB, `m${i}`)
    many.push(dir)
  }

  // M15-007：模拟「多 profile 浏览器缓存 / 编辑器缓存」。
  // 启动应用时用 LOCALAPPDATA / APPDATA 覆盖指向这两份夹具 —— resolveTargets 的
  // 通配候选就在这里枚举，一个真实的用户目录都不碰。
  const localAppData = join(fixtureRoot, 'localappdata')
  const roamingAppData = join(fixtureRoot, 'appdata')
  const edgeUserData = join(localAppData, 'Microsoft', 'Edge', 'User Data')
  await writeFiles(join(edgeUserData, 'Default', 'Cache'), 20, 128, 'edgeDefNet')
  await writeFiles(join(edgeUserData, 'Default', 'Code Cache'), 10, 128, 'edgeDefCode')
  await writeFiles(join(edgeUserData, 'Default', 'GPUCache'), 5, 128, 'edgeDefGpu')
  await writeFiles(join(edgeUserData, 'Profile 1', 'Cache'), 8, 128, 'edgeP1Net')
  await writeFiles(join(localAppData, 'D3DSCache'), 4, 256, 'd3d')
  await writeFiles(join(roamingAppData, 'Code', 'Cache'), 6, 128, 'vscCache')
  await writeFiles(join(roamingAppData, 'Code', 'CachedData'), 6, 128, 'vscData')

  return { small, big, whitelisted, huge, second, many, localAppData, roamingAppData }
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

/** 轮询等待渲染层某个表达式返回非空字符串 */
async function waitForValue(cdp, expression, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await evaluate(cdp, expression, false, 5000)
    if (value) return value
    await wait(150)
  }
  return null
}

function launch(envOverrides = {}) {
  currentChild = spawn(
    electronExe,
    ['.', `--remote-debugging-port=${PORT}`, `--user-data-dir=${userDataDir}`],
    {
      cwd: root,
      stdio: 'ignore',
      env: { ...process.env, OPS_CABIN_SMOKE: '1', ...envOverrides }
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

console.log('== 准备隔离环境与测试夹具 ==')
rmSync(userDataDir, { recursive: true, force: true })
rmSync(smokeDir, { recursive: true, force: true })
mkdirSync(userDataDir, { recursive: true })
const fixtureStarted = Date.now()
const fixture = await makeFixture()
console.log(`  （夹具就绪：${Date.now() - fixtureStarted}ms，3 万级文件）`)

const app = launch({
  // M15-007：让 %LOCALAPPDATA% / %APPDATA% 指向夹具 —— 多 profile 缓存在夹具里枚举
  LOCALAPPDATA: fixture.localAppData,
  APPDATA: fixture.roamingAppData
})
const page = await waitForReadyPage()
if (!page) {
  console.error('应用未能在限定时间内完成加载')
  shutdown(1)
} else {
  const cdp = await connect(page.webSocketDebuggerUrl)

  /* ---------- 测试 A：largeFiles 产物精确核对 ---------- */
  console.log('== A. largeFiles 扫描与产物核对 ==')
  // 只扫本节的目录（big + whitelisted）：fixtureRoot 下还有其它节的夹具（second / huge），
  // 整根扫会把它们的文件一并收进来，把「4 个 × 2MB」这类精确断言弄脏
  const scanA = JSON.stringify({
    groups: ['largeFiles'],
    largeFileRoots: [fixture.big, fixture.whitelisted],
    largeFileMinBytes: 1024
  })
  const outcomeA = JSON.parse(
    await evaluate(cdp, `window.opsCabin.startScan(${scanA}).then((o) => JSON.stringify(o))`, true)
  )
  check('扫描成功返回', outcomeA.ok === true, outcomeA.ok ? '' : outcomeA.error)
  const groupA = outcomeA.ok ? outcomeA.result.groups.find((g) => g.group === 'largeFiles') : null
  check('largeFiles 组存在', Boolean(groupA))
  check('命中 4 个大文件（big×3 + whitelisted×1）', groupA?.items.length === 4, `count=${groupA?.items.length}`)
  check('每个都是 2MB', groupA?.items.every((i) => i.bytes === TWO_MB) === true)
  check('合计 8MB', groupA?.bytes === 4 * TWO_MB, `bytes=${groupA?.bytes}`)
  check('128B 小文件未入榜', groupA?.items.every((i) => !i.path.includes('small')) === true)

  /* ---------- 测试 A2：多根合并（M15-006，选择目录可多选） ---------- */
  console.log('== A2. 多根合并与排序 ==')
  const multiScan = JSON.stringify({
    groups: ['largeFiles'],
    largeFileRoots: [fixture.big, fixture.second],
    largeFileMinBytes: 1024
  })
  const outcomeMulti = JSON.parse(
    await evaluate(cdp, `window.opsCabin.startScan(${multiScan}).then((o) => JSON.stringify(o))`, true)
  )
  check('多根扫描成功', outcomeMulti.ok === true, outcomeMulti.ok ? '' : outcomeMulti.error)
  const groupMulti = outcomeMulti.ok
    ? outcomeMulti.result.groups.find((g) => g.group === 'largeFiles')
    : null
  check(
    '两个根的结果合并（big×3 + 3MB + 1MB）',
    groupMulti?.items.length === 5,
    `count=${groupMulti?.items.length}`
  )
  const multiBytes = groupMulti?.items.map((item) => item.bytes) ?? []
  check(
    '合并后按大小降序',
    multiBytes.every((value, index) => index === 0 || multiBytes[index - 1] >= value) &&
      multiBytes[0] === THREE_MB &&
      multiBytes[multiBytes.length - 1] === TWO_MB / 2,
    `seq=${multiBytes.join(',')}`
  )
  check(
    '结果覆盖两个根',
    groupMulti?.items.some((i) => i.path.toLowerCase().startsWith(fixture.big.toLowerCase())) === true &&
      groupMulti?.items.some((i) => i.path.toLowerCase().startsWith(fixture.second.toLowerCase())) === true
  )

  // ≤8 根截断（S12 / parseScanOptions）：给 9 根只取前 8 —— 第 9 根的文件不得出现
  const capScan = JSON.stringify({
    groups: ['largeFiles'],
    largeFileRoots: fixture.many,
    largeFileMinBytes: 1024
  })
  const outcomeCap = JSON.parse(
    await evaluate(cdp, `window.opsCabin.startScan(${capScan}).then((o) => JSON.stringify(o))`, true)
  )
  const groupCap = outcomeCap.ok
    ? outcomeCap.result.groups.find((g) => g.group === 'largeFiles')
    : null
  const capPaths = (groupCap?.items ?? []).map((item) => item.path.toLowerCase())
  check(
    '多根 ≤8 截断：前 8 根纳入（首、末两根本身各命中）',
    capPaths.some((p) => p.startsWith(fixture.many[0].toLowerCase())) &&
      capPaths.some((p) => p.startsWith(fixture.many[7].toLowerCase())),
    `items=${capPaths.length}`
  )
  check(
    '多根 ≤8 截断：第 9 根被截掉',
    capPaths.every((p) => !p.startsWith(fixture.many[8].toLowerCase()))
  )

  /* ---------- 测试 B：白名单排除 ---------- */
  console.log('== B. 白名单排除 ==')
  await evaluate(
    cdp,
    `window.opsCabin.updateSettings({ whitelist: [${JSON.stringify(fixture.whitelisted)}] }).then((s) => JSON.stringify(s))`,
    true
  )
  const outcomeB = JSON.parse(
    await evaluate(cdp, `window.opsCabin.startScan(${scanA}).then((o) => JSON.stringify(o))`, true)
  )
  const groupB = outcomeB.ok ? outcomeB.result.groups.find((g) => g.group === 'largeFiles') : null
  check('白名单生效：只剩 3 个', groupB?.items.length === 3, `count=${groupB?.items.length}`)
  check(
    '白名单路径不出现在结果里',
    groupB?.items.every((i) => !i.path.toLowerCase().startsWith(fixture.whitelisted.toLowerCase())) === true
  )

  /* ---------- 测试 C：取消 / 进度 / UI 响应 ---------- */
  console.log('== C. 大目录扫描：取消 / 进度 / UI 响应 ==')
  await evaluate(cdp, 'window.__scanProgress = []; window.opsCabin.onScanProgress((p) => window.__scanProgress.push(p)); "ok"')
  const hugeScan = JSON.stringify({
    groups: ['largeFiles'],
    largeFileRoots: [fixture.huge],
    largeFileMinBytes: 1024
  })
  await evaluate(
    cdp,
    `window.__outcomeC = null; window.opsCabin.startScan(${hugeScan}).then((o) => { window.__outcomeC = o }); 'started'`
  )
  await wait(350)
  const pending = await evaluate(cdp, 'window.__outcomeC === null ? "pending" : "done"')
  check('大目录扫描未即时完成（取消有意义）', pending === 'pending')

  const pingStart = Date.now()
  await evaluate(cdp, '1 + 1')
  const rtt = Date.now() - pingStart
  check('扫描期间渲染进程响应即时（<150ms）', rtt < 150, `rtt=${rtt}ms`)

  // 第一条进度推送可能晚于 350ms 才到（worker 启动 + 测量阶段）：
  // 在扫描仍在进行的前提下轮询等待，最多 5 秒
  let progressCount = 0
  for (let i = 0; i < 20; i++) {
    progressCount = Number(await evaluate(cdp, 'window.__scanProgress.length'))
    if (progressCount >= 1) break
    await wait(250)
  }
  check('收到扫描进度推送', progressCount >= 1, `count=${progressCount}`)
  const lastProgress = JSON.parse(
    await evaluate(
      cdp,
      'JSON.stringify(window.__scanProgress[window.__scanProgress.length - 1] ?? null)'
    )
  )
  check(
    '进度结构完整',
    lastProgress !== null &&
      typeof lastProgress.current === 'string' &&
      typeof lastProgress.scannedFiles === 'number' &&
      (lastProgress.phase === 'measuring' || lastProgress.phase === 'largeFiles'),
    JSON.stringify(lastProgress)?.slice(0, 120)
  )

  const cancelStart = Date.now()
  await evaluate(cdp, 'window.opsCabin.cancelScan()', true, 5000)
  const settledC = await waitForValue(cdp, 'window.__outcomeC ? JSON.stringify(window.__outcomeC) : ""', 5000)
  const cancelMs = Date.now() - cancelStart
  // 取消是「杀扫描进程 → exit → outcome 回来」的链，高负载下本机实测 0.2–2.9s 都有
  // （PLAN §14 已记录过本套件在高负载连跑下的偶发抖动）—— 上限放到 5s，实测值照印
  check('取消后及时结束（≤5s）', cancelMs < 5000, `${cancelMs}ms`)
  check('结果是「已取消」', settledC !== null && JSON.parse(settledC).cancelled === true, settledC)

  /* ---------- 测试 D：接管语义（新扫描先取消旧任务） ---------- */
  console.log('== D. 接管语义 ==')
  await evaluate(
    cdp,
    `window.__outcomeD1 = null; window.opsCabin.startScan(${hugeScan}).then((o) => { window.__outcomeD1 = o }); 'started'`
  )
  await wait(300)
  const outcomeD2 = JSON.parse(
    await evaluate(cdp, `window.opsCabin.startScan(${scanA}).then((o) => JSON.stringify(o))`, true)
  )
  check('接管：新扫描正常完成', outcomeD2.ok === true)
  const d1 = await waitForValue(cdp, 'window.__outcomeD1 ? JSON.stringify(window.__outcomeD1) : ""', 3000)
  check('接管：旧扫描被取消', d1 !== null && JSON.parse(d1).cancelled === true, d1 ?? '仍为 pending')

  /* ---------- 测试 E：safe 组（真实系统位置） ---------- */
  console.log('== E. safe 组扫描（本机临时目录） ==')
  const outcomeE = JSON.parse(
    await evaluate(cdp, `window.opsCabin.startScan({ groups: ["safe"] }).then((o) => JSON.stringify(o))`, true, 120000)
  )
  check('safe 组扫描成功', outcomeE.ok === true, outcomeE.ok ? '' : outcomeE.error)
  const groupE = outcomeE.ok ? outcomeE.result.groups.find((g) => g.group === 'safe') : null
  check('safe 组有目标且数据有效', Boolean(groupE) && groupE.items.length >= 1 && groupE.items.every((i) => i.bytes > 0 && i.files >= 1), `items=${groupE?.items.length}`)
  check(
    '扫描耗时字段有效',
    outcomeE.ok && typeof outcomeE.result.durationMs === 'number' && outcomeE.result.durationMs > 0,
    outcomeE.ok ? `${outcomeE.result.durationMs}ms` : ''
  )
  check('跳过的受限条目已计数（≥0）', outcomeE.ok && typeof outcomeE.result.skipped === 'number')

  /* ---------- 测试 F：清理位置扩展 —— 多 profile 枚举（M15-007） ---------- */
  console.log('== F. 清理位置：多 profile 枚举 ==')
  const outcomeF = JSON.parse(
    await evaluate(cdp, `window.opsCabin.startScan({ groups: ["safe", "devCaches"] }).then((o) => JSON.stringify(o))`, true, 120000)
  )
  check('扩展清单扫描成功', outcomeF.ok === true, outcomeF.ok ? '' : outcomeF.error)
  const itemsF = outcomeF.ok ? outcomeF.result.groups.flatMap((g) => g.items) : []
  const labelsF = itemsF.map((item) => item.label)
  const labelSummary = (prefix) => labelsF.filter((l) => l.startsWith(prefix)).join(' / ')

  check(
    'Edge 网页缓存按 profile 各自成条目（Default + Profile 1）',
    labelsF.includes('Edge 网页缓存 · Default') && labelsF.includes('Edge 网页缓存 · Profile 1'),
    labelSummary('Edge')
  )
  check(
    'Edge 代码缓存 / GPU 缓存条目出现（label 带 profile 后缀）',
    labelsF.includes('Edge 代码缓存 · Default') && labelsF.includes('Edge GPU 缓存 · Default')
  )
  check('DirectX 着色器缓存条目出现', labelsF.includes('DirectX 着色器缓存'))
  check(
    'VS Code 两个缓存条目出现',
    labelsF.includes('VS Code 缓存') && labelsF.includes('VS Code 数据缓存')
  )
  const fixtureScoped = (path) =>
    path.toLowerCase().startsWith(fixture.localAppData.toLowerCase()) ||
    path.toLowerCase().startsWith(fixture.roamingAppData.toLowerCase())
  check(
    '新条目路径都落在夹具内（未碰真实用户目录）',
    itemsF
      .filter(
        (item) =>
          item.label.includes('Edge') ||
          item.label.includes('DirectX') ||
          item.label.includes('VS Code')
      )
      .every((item) => fixtureScoped(item.path))
  )
  check(
    '本机夹具没放 Chrome —— 不出现 Chrome 条目（缺失即跳过）',
    labelsF.every((label) => !label.includes('Chrome'))
  )
  check(
    '无重复条目（路径唯一）',
    new Set(itemsF.map((item) => item.path.toLowerCase())).size === itemsF.length,
    `items=${itemsF.length}`
  )

  cdp.close()
  check('退出应用', await quitApp(page, app))
}

console.log('== 清理夹具 ==')
rmSync(fixtureRoot, { recursive: true, force: true })

console.log('')
console.log(failures === 0 ? '✅ E2E-SCAN 全部通过' : `❌ E2E-SCAN 失败 ${failures} 项`)
shutdown(failures === 0 ? 0 : 1)
