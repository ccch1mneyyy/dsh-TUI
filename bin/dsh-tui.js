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
 *   3. 已初始化但版本与本包不一致时按方向处理（issue #183）：profile
 *      更新（前向错位）打印一行提示后继续启动（TUI 内 /update 或重新
 *      add）；profile 次版本更旧（反向错位）拒绝启动并给出对齐命令——
 *      该方向 dsh CLI 会把启动器的 bundle patch 套到 profile 旧包上，
 *      启动必然以模块解析错误崩溃；
 *   4. 透传全部参数启动 `dsh --profile dsh-tui`。
 *
 * `--resume` 由本启动器拦截：读取 TUI 保留的 ~/.dsh-tui/resume.txt
 * （旧路径 ~/.dsh-cc/resume.txt 兜底，直到旧版 TUI 退场——见
 * src/sessionHistory.ts 的启动器契约，issue #120），以
 * DSH_TUI_RESUME_SESSION（并兼容写 DSH_CC_RESUME_SESSION）环境变量喂回，
 * 该 flag 本身不再传给 dsh。
 *
 * 面向用户的消息走下方 MSG 双语表：与 TUI 的语言契约一致——
 * `DSH_TUI_LANG` 显式指定时从其值，否则默认中文（同 src/i18n.ts 的缺省）。
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gt, valid } from 'semver'
import { shellQuote } from '../lib/types/utils/shellQuote.js'
import { detectLegacyEnv, RENAMED_ENV } from '../lib/types/utils/paths.js'

const here = fileURLToPath(new URL('.', import.meta.url))
const ownVersion = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8')).version
const PACKAGE = '@deepseek-harness-tui/dsh-tui'
const PROFILE = 'dsh-tui'

// --- 双语消息表（启动器跑在 TUI boot 之前，无法复用 src/i18n.ts）-------------
// 与 TUI 一致：DSH_TUI_LANG 显式指定才生效，否则默认中文；旧名 CC_TUI_LANG
// 仅用于让警告本身以用户习惯的语言显示（配置不再从旧名生效）。
const lang = (process.env.DSH_TUI_LANG ?? process.env.CC_TUI_LANG) === 'en' ? 'en' : 'zh'
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
  bootstrapRetryW: {
    en: '[dsh-tui] pnpm refused to add to the workspace root (ERR_PNPM_ADDING_TO_ROOT) — retrying with -w…',
    zh: '[dsh-tui] pnpm 拒绝写入 workspace 根（ERR_PNPM_ADDING_TO_ROOT）——带 -w 重试…',
  },
  installFailed: {
    en: `[dsh-tui] Plugin install failed. Retry manually later:\n  dsh plugin --profile ${PROFILE} add -w ${PACKAGE}@${ownVersion}`,
    zh: `[dsh-tui] 插件安装失败。可稍后手工重试：\n  dsh plugin --profile ${PROFILE} add -w ${PACKAGE}@${ownVersion}`,
  },
  // Non-fatal skew comes in two directions and each needs its own repair:
  // a profile NEWER than the launcher (typical after /update) must point at
  // the global install, while a profile older only in patch must point back
  // at the profile. The old generic message told forward-skew users to run
  // /update again — an "Already up to date" loop.
  profileOutdated: {
    en: (installed, own) =>
      `[dsh-tui] note: the profile is running v${installed} but this launcher is v${own}.\n` +
      `  Align the profile to this launcher:\n` +
      `  dsh plugin --profile ${PROFILE} add ${PACKAGE}@${own}`,
    zh: (installed, own) =>
      `[dsh-tui] 提示：profile 内运行的是 v${installed}，启动器是 v${own}。\n` +
      `  请把 profile 对齐到启动器版本：\n` +
      `  dsh plugin --profile ${PROFILE} add ${PACKAGE}@${own}`,
  },
  launcherOutdated: {
    en: (installed, own) =>
      `[dsh-tui] note: the profile is already v${installed}, but the global launcher is still v${own}.\n` +
      `  Align the global dsh-tui launcher to the profile:\n` +
      `  npm install -g ${PACKAGE}@${installed}\n` +
      `  (if you installed it globally with pnpm: pnpm add -g ${PACKAGE}@${installed})`,
    zh: (installed, own) =>
      `[dsh-tui] 提示：profile 已是 v${installed}，但全局启动器仍是 v${own}。\n` +
      `  请把全局 dsh-tui 启动器对齐到 profile 版本：\n` +
      `  npm install -g ${PACKAGE}@${installed}\n` +
      `  （如果你使用 pnpm 全局安装：pnpm add -g ${PACKAGE}@${installed}）`,
  },
  // Reverse skew (issue #183): the dsh CLI reads the bundle patch from the
  // FIRST copy found from its own install anchor — this globally installed
  // launcher — while the plugin modules load from the profile's copy. A
  // launcher minor NEWER than the profile means the patch may reference
  // subpath exports the profile's older package does not have, and boot
  // crashes opaquely (ERR_PACKAGE_PATH_NOT_EXPORTED) before any TUI code
  // runs. Fail loud with the fix instead. (Forward skew degrades to a
  // working local-workspace fallback since 0.7.2 — soft note below.)
  profileOlderThanLauncher: {
    en: (installed, own) =>
      `[dsh-tui] cannot start: the profile runs v${installed} but this launcher is v${own}.\n` +
      `  The launcher's bundle patch would be applied to the profile's older package,\n` +
      `  which does not export everything the patch references — boot would crash.\n` +
      `  Align the profile with the launcher:\n` +
      `  dsh plugin --profile ${PROFILE} add ${PACKAGE}@${own}\n` +
      `  (or update everything to the latest release: dsh plugin --profile ${PROFILE} add ${PACKAGE}@latest)`,
    zh: (installed, own) =>
      `[dsh-tui] 无法启动：profile 内运行的是 v${installed}，而启动器是 v${own}。\n` +
      `  启动器的 bundle patch 会套用到 profile 里的旧版包上，其中缺少 patch 引用\n` +
      `  的子路径导出——启动会以模块解析错误崩溃。请让 profile 与启动器对齐：\n` +
      `  dsh plugin --profile ${PROFILE} add ${PACKAGE}@${own}\n` +
      `  （或全部升到最新：dsh plugin --profile ${PROFILE} add ${PACKAGE}@latest）`,
  },
  launchFailed: {
    en: err => `[dsh-tui] Failed to launch: ${err.message}`,
    zh: err => `[dsh-tui] 启动失败：${err.message}`,
  },
  profileExited: {
    en: code => `[dsh-tui] dsh profile exited with code ${code}. Run it directly for diagnostics:\n  dsh --profile ${PROFILE}`,
    zh: code => `[dsh-tui] dsh profile 已退出（退出码 ${code}）。可直接运行以下命令查看诊断：\n  dsh --profile ${PROFILE}`,
  },
  legacyEnv: {
    en: (oldName, newName) => `[dsh-tui] note: env ${oldName} was renamed to ${newName}; the old name no longer takes effect.`,
    zh: (oldName, newName) => `[dsh-tui] 提示：环境变量 ${oldName} 已更名为 ${newName}，旧名不再生效。`,
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
// DEP0190（issue #148）：Node ≥22 对「shell:true + 非空参数数组」的调用
// 发出弃用警告，判定是语法级的——参数已过 shellQuote 也一样告警；且未来
// 大版本可能升级为运行时错误。把转义后的参数拼进命令字符串传入
// （shell:true + 空参数数组不触发），非 Windows 路径保持数组直传。
const cmd = (command, args) =>
  isWin ? [`${command} ${shellQuote(args).join(' ')}`, []] : [command, args]

// --- 1. dsh CLI 预检 ---------------------------------------------------------
const probe = spawnSync(...cmd('dsh', ['--version']), { stdio: 'pipe', ...shellOpt })
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
  const pnpmProbe = spawnSync(...cmd('pnpm', ['--version']), { stdio: 'pipe', ...shellOpt })
  if (pnpmProbe.error || pnpmProbe.status !== 0) {
    console.error(msg('noPnpm'))
    process.exit(1)
  }
  console.log(msg('bootstrapStart'))
  // pnpm ≥11 在带 pnpm-workspace.yaml 的 profile 目录里可能拒绝向
  // workspace root 写依赖（ERR_PNPM_ADDING_TO_ROOT，issue #239）：识别该
  // 错误时带 -w 重试一次。stderr 走 pipe 捕获供识别，stdout 保持
  // inherit 让用户实时看到安装进度；手工重试提示同步带 -w。
  const runAdd = extraArgs => spawnSync(
    ...cmd('dsh', ['plugin', '--profile', PROFILE, 'add', ...extraArgs, `${PACKAGE}@${ownVersion}`]),
    { stdio: ['inherit', 'inherit', 'pipe'], ...shellOpt },
  )
  let add = runAdd([])
  if (add.status !== 0 && String(add.stderr).includes('ERR_PNPM_ADDING_TO_ROOT')) {
    console.log(msg('bootstrapRetryW'))
    add = runAdd(['-w'])
  }
  if (add.status !== 0) {
    console.error(msg('installFailed'))
    process.exit(add.status ?? 1)
  }
} else if (installedVersion !== ownVersion) {
  // Reverse skew is fatal (see MSG.profileOlderThanLauncher): compare
  // major/minor only — patch-level differences never move the patch surface.
  const majorMinor = v => v.split('-')[0].split('.').slice(0, 2).map(Number)
  const [installedMajor, installedMinor] = majorMinor(installedVersion)
  const [ownMajor, ownMinor] = majorMinor(ownVersion)
  if (installedMajor < ownMajor || (installedMajor === ownMajor && installedMinor < ownMinor)) {
    console.error(MSG.profileOlderThanLauncher[lang](installedVersion, ownVersion))
    process.exit(1)
  }

  // Non-fatal skew: repair in the direction the versions actually moved.
  // A profile NEWER than the launcher (e.g. right after /update) means the
  // GLOBAL launcher is stale — never point those users back at /update.
  // Exact versions only: @latest could skip past the alignment point if a
  // newer release or a mirror dist-tag is in play.
  const installedSemver = valid(installedVersion)
  const ownSemver = valid(ownVersion)
  if (installedSemver !== null && ownSemver !== null && gt(installedSemver, ownSemver)) {
    console.error(MSG.launcherOutdated[lang](installedVersion, ownVersion))
  } else {
    console.error(MSG.profileOutdated[lang](installedVersion, ownVersion))
  }
}

// --- 3. --resume 拦截 ---------------------------------------------------------
// 换名过渡（issue #120）：全局 bin 与 profile 内 TUI 包版本可能错位，所以
// env 双写（新旧名都设），文件读取新路径优先、旧路径兜底。
// 支持的形态（对齐 issue #53 的诉求）：
//   --resume <id> / --resume=<id>   恢复指定会话
//   --resume / -c / --continue      恢复最近一次会话（读 resume.txt）
// 其余位置参数原样透传给 dsh CLI，由插件经 ctx.cmdlineArgs 读取（初始 prompt）。
const setResumeEnv = sessionId => {
  process.env.DSH_TUI_RESUME_SESSION = sessionId
  process.env.DSH_CC_RESUME_SESSION = sessionId
}
const readLastResumeTarget = () => {
  for (const dir of ['.dsh-tui', '.dsh-cc']) {
    try {
      const sessionId = readFileSync(join(homedir(), dir, 'resume.txt'), 'utf8').trim()
      if (sessionId) return sessionId
    } catch {
      // 没有历史会话可恢复——静默忽略，正常冷启动。
    }
  }
  return ''
}
const args = []
const argv = process.argv.slice(2)
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (a === '--resume' || a === '-c' || a === '--continue' || a.startsWith('--resume=')) {
    let sessionId = ''
    if (a.startsWith('--resume=')) {
      sessionId = a.slice('--resume='.length).trim()
    } else if (a === '--resume' && argv[i + 1] !== undefined && !argv[i + 1].startsWith('-')) {
      sessionId = argv[++i].trim()
    }
    // 裸形态（含 -c/--continue）回退到 resume.txt。
    if (!sessionId) sessionId = readLastResumeTarget()
    if (sessionId) setResumeEnv(sessionId)
  } else if (
    process.env.DSH_TUI_WORKSPACE_TARGET === undefined
    && !a.startsWith('-')
    && (isAbsolute(a) || /^[a-z][a-z0-9+.-]*:\/\//iu.test(a) || existsSync(resolve(a)))
  ) {
    // A workspace target is launcher syntax, not an argument for the profile
    // app. The registry resolves local paths/file URLs and provider URIs.
    process.env.DSH_TUI_WORKSPACE_TARGET = a
  } else {
    args.push(a)
  }
}

// --- 3.5 旧环境变量警告（必须在 TUI 渲染前输出，fullscreen 下写 stderr 会破坏界面）
for (const oldName of detectLegacyEnv()) {
  console.error(MSG.legacyEnv[lang](oldName, RENAMED_ENV[oldName]))
}

// --- 4. 启动 ------------------------------------------------------------------
// Contract for the profile runtime: lets /update diagnose whether the
// global dsh-tui launcher is older than the profile it just installed.
// Not a one-shot marker — it must survive restarts so the runtime always
// knows the launcher generation it boots under.
process.env.DSH_TUI_LAUNCHER_VERSION = ownVersion

const child = spawn(...cmd('dsh', ['--profile', PROFILE, ...args]), {
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
    if (code !== null && code !== 0) console.error(MSG.profileExited[lang](code))
    process.exit(code ?? 0)
  }
})
