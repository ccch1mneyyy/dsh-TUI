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
 *   3. 已初始化但版本与本包不一致时打印一行提示（TUI 内 /update 或重新 add）；
 *   4. 透传全部参数启动 `dsh --profile dsh-tui`。
 *
 * `--resume` 由本启动器拦截：读取 TUI 保留的兼容路径 ~/.dsh-cc/resume.txt，
 * 以 DSH_CC_RESUME_SESSION 环境变量喂回（见 src/sessionHistory.ts 的
 * 启动器契约），该 flag 本身不再传给 dsh。
 *
 * 面向用户的消息走下方 MSG 双语表：与 TUI 的语言契约一致——
 * `CC_TUI_LANG` 显式指定时从其值，否则默认中文（同 src/i18n.ts 的缺省）。
 */
import { spawn, spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { shellQuote } from '../lib/types/utils/shellQuote.js'

const here = fileURLToPath(new URL('.', import.meta.url))
const ownVersion = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8')).version
const PACKAGE = '@deepseek-harness-tui/dsh-tui'
const PROFILE = 'dsh-tui'

// --- 双语消息表（启动器跑在 TUI boot 之前，无法复用 src/i18n.ts）-------------
// 与 TUI 一致：CC_TUI_LANG 显式指定才生效，否则默认中文。
const lang = process.env.CC_TUI_LANG === 'en' ? 'en' : 'zh'
const MSG = {
  noDsh: {
    en: '[dsh-tui] dsh CLI not found. Install the official client first:\n  npm install -g @deepseek-ai/dsh',
    zh: '[dsh-tui] 未检测到 dsh CLI。请先安装官方客户端：\n  npm install -g @deepseek-ai/dsh',
  },
  noPnpm: {
    en: '[dsh-tui] The first-time setup needs pnpm (dsh plugin delegates installs to it):\n  npm install -g pnpm   (or via corepack: corepack enable pnpm)',
    zh: '[dsh-tui] 首次安装需要 pnpm（dsh plugin 会把安装转发给它）：\n  npm install -g pnpm   （或启用 corepack：corepack enable pnpm）',
  },
  bootstrapStart: {
    en: `[dsh-tui] First run — initializing the ${PROFILE} profile (${PACKAGE}@${ownVersion})…`,
    zh: `[dsh-tui] 首次运行，正在初始化 ${PROFILE} profile（${PACKAGE}@${ownVersion}）…`,
  },
  installFailed: {
    en: `[dsh-tui] Plugin install failed. Retry manually later:\n  dsh plugin --profile ${PROFILE} add ${PACKAGE}@${ownVersion}`,
    zh: `[dsh-tui] 插件安装失败。可稍后手工重试：\n  dsh plugin --profile ${PROFILE} add ${PACKAGE}@${ownVersion}`,
  },
  versionMismatch: {
    en: (installed, own) =>
      `[dsh-tui] note: the profile is running v${installed} but this launcher is v${own}.\n` +
      `  To update the profile: run /update inside the TUI, or:\n` +
      `  dsh plugin --profile ${PROFILE} add ${PACKAGE}@latest`,
    zh: (installed, own) =>
      `[dsh-tui] 提示：profile 内运行的是 v${installed}，而启动器是 v${own}。\n` +
      `  更新 profile：在 TUI 内执行 /update，或运行：\n` +
      `  dsh plugin --profile ${PROFILE} add ${PACKAGE}@latest`,
  },
  launchFailed: {
    en: err => `[dsh-tui] Failed to launch: ${err.message}`,
    zh: err => `[dsh-tui] 启动失败：${err.message}`,
  },
}
const msg = key => MSG[key][lang]

// React 开发构建会把每次渲染的 performance.measure() 堆进无界缓冲区导致
// 长会话 OOM——与仓库根 dsh-tui.cmd 保持一致，强制 production。
process.env.NODE_ENV ??= 'production'

const isWin = process.platform === 'win32'
// Windows 上 .cmd shim 必须经 shell 启动（Node ≥18.20.2 的安全限制）；
// 其余平台直接 spawn 无后缀的 dsh。cmd.exe 以空格拼接参数且 Node 不做
// 转义——shell 路径的所有参数必须先过 shellQuote（同 src/update.ts 的
// /update 重启路径），否则含空格/引号的参数会被拆断。
const shellOpt = isWin ? { shell: true } : {}
const q = args => (isWin ? shellQuote(args) : args)

// --- 1. dsh CLI 预检 ---------------------------------------------------------
const probe = spawnSync('dsh', q(['--version']), { stdio: 'pipe', ...shellOpt })
if (probe.error || probe.status !== 0) {
  console.error(msg('noDsh'))
  process.exit(1)
}

// --- 2. profile 自举与版本检查 -------------------------------------------------
const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
const profileDir = join(dshHome, 'profiles', PROFILE)
// 以已装包的 package.json 可读为准（而非目录存在）：安装中途失败留下的
// 残骸目录会触发重新安装，而不是以坏 profile 直接启动。
let installedVersion
try {
  installedVersion = JSON.parse(
    readFileSync(join(profileDir, 'node_modules', '@deepseek-harness-tui', 'dsh-tui', 'package.json'), 'utf8'),
  ).version
} catch {
  installedVersion = undefined
}
if (installedVersion === undefined) {
  const pnpmProbe = spawnSync('pnpm', q(['--version']), { stdio: 'pipe', ...shellOpt })
  if (pnpmProbe.error || pnpmProbe.status !== 0) {
    console.error(msg('noPnpm'))
    process.exit(1)
  }
  console.log(msg('bootstrapStart'))
  const add = spawnSync('dsh', q(['plugin', '--profile', PROFILE, 'add', `${PACKAGE}@${ownVersion}`]), { stdio: 'inherit', ...shellOpt })
  if (add.status !== 0) {
    console.error(msg('installFailed'))
    process.exit(add.status ?? 1)
  }
} else if (installedVersion !== ownVersion) {
  console.error(MSG.versionMismatch[lang](installedVersion, ownVersion))
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
const child = spawn('dsh', q(['--profile', PROFILE, ...args]), {
  stdio: 'inherit',
  env: process.env,
  ...shellOpt,
})
child.on('error', err => {
  console.error(MSG.launchFailed[lang](err))
  process.exit(1)
})
child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal)
  } else {
    process.exit(code ?? 0)
  }
})
