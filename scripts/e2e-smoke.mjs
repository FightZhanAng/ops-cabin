// M8 应用内冒烟自检的对账脚本（跑两轮：浅色 / 深色）。
//
// 应用以 OPS_CABIN_SMOKE=1 OPS_CABIN_SMOKE_EXIT=1 启动，主进程驱动界面走一圈
// （总览 → 磁盘扫描 → 端口 → 设置），把 DOM 事实与截图写进 %TEMP%/ops-cabin-smoke；
// 本脚本等待其退出后逐项断言，并把两轮结果分别留档。
//
// 用法：node scripts/e2e-smoke.mjs
import { spawn, spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as wait } from 'node:timers/promises'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const smokeDir = join(tmpdir(), 'ops-cabin-smoke')
const electronExe = join(root, 'node_modules', 'electron', 'dist', 'electron.exe')

let failures = 0

function check(name, ok, detail = '') {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? `  （${detail}）` : ''}`)
  if (!ok) failures++
}

function readSmoke(file) {
  try {
    return JSON.parse(readFileSync(join(smokeDir, file), 'utf8'))
  } catch {
    return null
  }
}

/** 跑一轮冒烟；返回是否正常退出 */
async function runRound(theme) {
  const userDataDir = join(tmpdir(), `ops-cabin-smoke-e2e-userdata-${theme}`)
  rmSync(userDataDir, { recursive: true, force: true })
  rmSync(smokeDir, { recursive: true, force: true })
  mkdirSync(userDataDir, { recursive: true })

  const env = {
    ...process.env,
    OPS_CABIN_SMOKE: '1',
    OPS_CABIN_SMOKE_DRIVE: '1',
    OPS_CABIN_SMOKE_EXIT: '1'
  }
  if (theme === 'light' || theme === 'dark') env['OPS_CABIN_SMOKE_THEME'] = theme

  const child = spawn(
    electronExe,
    ['.', `--user-data-dir=${userDataDir}`],
    { cwd: root, stdio: 'ignore', env }
  )

  const exited = await Promise.race([
    new Promise((resolve) => child.on('exit', () => resolve(true))),
    wait(180000).then(() => false)
  ])
  if (!exited) {
    try {
      child.kill('SIGKILL')
    } catch {
      /* 已退出 */
    }
    return false
  }
  return true
}

console.log('== 构建 ==')
const build = spawnSync('pnpm build', { cwd: root, shell: true, encoding: 'utf8' })
if (build.status !== 0) {
  console.log(build.stdout ?? '')
  console.error(build.stderr ?? '')
  console.error('构建失败，中止')
  process.exit(1)
}

for (const theme of ['light', 'dark']) {
  console.log(`== 冒烟轮次：${theme} ==`)
  const exited = await runRound(theme)
  check('冒烟完成后进程自动退出', exited)

  // 留档到独立目录（两轮不互相覆盖）
  const archive = join(smokeDir + `-${theme}`)
  rmSync(archive, { recursive: true, force: true })
  try {
    cpSync(smokeDir, archive, { recursive: true })
  } catch {
    /* 目录不存在也随之报后面对账 */
  }

  check('done.json 落盘', existsSync(join(smokeDir, 'done.json')))
  check('无 smoke-error', !existsSync(join(smokeDir, 'smoke-error.json')))

  const boot = readSmoke('boot.json')
  const windowInfo = readSmoke('window.json')
  const tray = readSmoke('tray.json')
  const selfPort = readSmoke('self-port.json')
  const overview = readSmoke('view-overview.json')
  const disk = readSmoke('view-disk.json')
  const ports = readSmoke('view-ports.json')
  const settings = readSmoke('view-settings.json')

  check('boot 探针', boot !== null && typeof boot.pid === 'number')
  check('窗口几何自洽', windowInfo !== null && windowInfo.bounds.width > 0 && windowInfo.bounds.height > 0)
  check('托盘图标非空', tray !== null && tray.empty === false)
  check('自检端口已开设', selfPort !== null && selfPort.port > 0, `port=${selfPort?.port}`)

  check(
    '总览：分区与指标可见',
    overview !== null && overview.volumes >= 1 && /\d/.test(overview.cpuText ?? ''),
    `volumes=${overview?.volumes} cpu=${(overview?.cpuText ?? '').replace(/\s+/g, ' ').slice(0, 20)}`
  )
  check('磁盘：真实扫描出结果', disk !== null && disk.rows >= 1, `rows=${disk?.rows}`)
  check(
    '端口：列出监听且包含自检端口',
    ports !== null && ports.rows > 10 && ports.sawSelfPort === true,
    `rows=${ports?.rows} self=${ports?.sawSelfPort}`
  )
  check(
    '设置：六个分组就位',
    settings !== null &&
      settings.themePicker &&
      settings.notifySwitch &&
      settings.whitelist &&
      settings.scanPlan &&
      settings.dangerZone,
    JSON.stringify(settings ?? {}).slice(0, 80)
  )

  for (const shot of ['screen-overview', 'screen-disk', 'screen-ports', 'screen-settings']) {
    check(`截图 ${shot}.png`, existsSync(join(smokeDir, `${shot}.png`)))
  }

  console.log(`  （留档于 ${archive}）`)
}

console.log('')
console.log(failures === 0 ? '✅ E2E-SMOKE 全部通过' : `❌ E2E-SMOKE 失败 ${failures} 项`)
process.exit(failures === 0 ? 0 : 1)
