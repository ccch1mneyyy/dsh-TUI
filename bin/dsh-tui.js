#!/usr/bin/env node
/**
 * dsh-tui — dsh-tui profile 的一键直达启动器。
 *
 * 全局安装 @deepseek-harness-tui/dsh-tui 后获得 `dsh-tui` 命令，免去手工
 * 输入 `dsh --profile dsh-tui`：
 *
 *   1. 检测 dsh CLI（缺失时提示安装 @deepseek-ai/dsh）；
 *   2. 检测 $DSH_HOME/profiles/dsh-tui 是否已初始化，未初始化则自动执行
 *      `dsh plugin --profile dsh-tui add @deepseek-harness-tui/dsh-tui@<本包版本>`
 *      自举——版本号与本包对齐，避免 pnpm store 缓存带来的旧版漂移；
 *   3. 透传全部参数启动 `dsh --profile dsh-tui`。
 *
 * `--resume` 由本启动器拦截：读取 TUI 保留的兼容路径 ~/.dsh-cc/resume.txt，
 * 以 DSH_CC_RESUME_SESSION 环境变量喂回（见 src/sessionHistory.ts 的
 * 启动器契约），该 flag 本身不再传给 dsh。
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))
const ownVersion = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8')).version
const PACKAGE = '@deepseek-harness-tui/dsh-tui'
const PROFILE = 'dsh-tui'

// React 开发构建会把每次渲染的 performance.measure() 堆进无界缓冲区导致
// 长会话 OOM——与仓库根 dsh-tui.cmd 保持一致，强制 production。
process.env.NODE_ENV ??= 'production'

const isWin = process.platform === 'win32'
// Windows 上 .cmd shim 必须经 shell 启动（Node ≥18.20.2 的安全限制）；
// 其余平台直接 spawn 无后缀的 dsh。
const shellOpt = isWin ? { shell: true } : {}

// --- 1. dsh CLI 预检 ---------------------------------------------------------
const probe = spawnSync('dsh', ['--version'], { stdio: 'pipe', ...shellOpt })
if (probe.error || probe.status !== 0) {
  console.error('[dsh-tui] 未检测到 dsh CLI。请先安装官方客户端：')
  console.error('  npm install -g @deepseek-ai/dsh')
  process.exit(1)
}

// --- 2. profile 自举 ----------------------------------------------------------
const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
const profileDir = join(dshHome, 'profiles', PROFILE)
if (!existsSync(join(profileDir, 'node_modules', '@deepseek-harness-tui', 'dsh-tui'))) {
  const pnpmProbe = spawnSync('pnpm', ['--version'], { stdio: 'pipe', ...shellOpt })
  if (pnpmProbe.error || pnpmProbe.status !== 0) {
    console.error('[dsh-tui] 首次安装需要 pnpm（dsh plugin 会把安装转发给它）：')
    console.error('  npm install -g pnpm   （或启用 corepack：corepack enable pnpm）')
    process.exit(1)
  }
  console.log(`[dsh-tui] 首次运行，正在初始化 ${PROFILE} profile（${PACKAGE}@${ownVersion}）…`)
  const add = spawnSync('dsh', ['plugin', '--profile', PROFILE, 'add', `${PACKAGE}@${ownVersion}`], { stdio: 'inherit', ...shellOpt })
  if (add.status !== 0) {
    console.error('[dsh-tui] 插件安装失败。可稍后手工重试：')
    console.error(`  dsh plugin --profile ${PROFILE} add ${PACKAGE}@${ownVersion}`)
    process.exit(add.status ?? 1)
  }
}

// --- 3. --resume 拦截 ---------------------------------------------------------
const args = []
for (const a of process.argv.slice(2)) {
  if (a === '--resume') {
    try {
      process.env.DSH_CC_RESUME_SESSION = readFileSync(join(homedir(), '.dsh-cc', 'resume.txt'), 'utf8').trim()
    } catch {
      // 没有历史会话可恢复——静默忽略，正常冷启动。
    }
  } else {
    args.push(a)
  }
}

// --- 4. 启动 ------------------------------------------------------------------
const child = spawn('dsh', ['--profile', PROFILE, ...args], {
  stdio: 'inherit',
  env: process.env,
  ...shellOpt,
})
child.on('error', (err) => {
  console.error(`[dsh-tui] 启动失败：${err.message}`)
  process.exit(1)
})
child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal)
  } else {
    process.exit(code ?? 0)
  }
})
