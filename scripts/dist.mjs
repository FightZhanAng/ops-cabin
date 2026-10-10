// 打包脚本：为 electron-builder 的工具链设置国内镜像（本机 GitHub 不可达），
// 然后经 `pnpm exec` 调 electron-builder —— 由 pnpm 解析 .bin 的路径，
// 避免项目路径里的空格与中文在 cmd 传参时被截断。
//
// 用法：node scripts/dist.mjs --win --publish never
import { spawn } from 'node:child_process'

process.env.ELECTRON_BUILDER_BINARIES_MIRROR ||=
  'https://npmmirror.com/mirrors/electron-builder-binaries/'

const child = spawn('pnpm', ['exec', 'electron-builder', ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: process.env,
  shell: true
})
child.on('close', (code) => process.exit(code ?? 1))
