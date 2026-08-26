#!/usr/bin/env node
/**
 * dsh-tui — 双态启动器（delegating launcher，0.9.2）。
 *
 * 同一个文件按“自己住在哪”决定扮演的角色：
 *
 *   全局安装副本（npm i -g 得到的 `dsh-tui` 命令）→ 瘦壳：
 *     1. 找到 $DSH_HOME/profiles/dsh-tui 里的同包 bin；
 *     2. 可读 → 原样转发 argv 委托它执行（完整逻辑永远来自 profile 副本，
 *        版本随 /update 一起前进，启动器滞后问题从结构上消失）；
 *     3. 不可读（首次运行）→ 探测 dsh/pnpm 后自举
 *        `dsh plugin --profile dsh-tui add <本包>@<本包版本>`，成功后委托。
 *
 *   profile 内副本（被委托执行，或 junction/源码目录里直接运行）→ 完整
 *   启动逻辑（与 0.8.6 及之前一致）：
 *     dsh 预检 / profile 版本核对 / --resume 与工作区目标拦截 /
 *     旧环境变量警告 / `dsh --profile dsh-tui` 启动与退出码透传。
 *
 * 自举角色判定用 realpath：Windows Junction 轨（profile 指回仓库）与
 * `pnpm run dev` 源码运行都会折叠成同一物理目录 → 走完整逻辑，不会
 * 自己委托自己形成循环。
 *
 * 本文件必须保持零 lib/ 依赖：/update 的启动器迁移只覆写这一个文件
 * （外加 package.json 的版本号），旧全局安装里不存在新 lib 助手时同样
 * 可用。shellQuote 等小工具在此内联。
 *
 * 面向用户的消息走 MSG 双语表：与 TUI 的语言契约一致——
 * `DSH_TUI_LANG` 显式指定时从其值，否则默认中文（同 src/i18n.ts 的缺省）。
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

if (process.platform === 'win32') {
  try {
    const oldBinary = `${process.execPath}.old`
    if (existsSync(oldBinary)) rmSync(oldBinary, { force: true })
  } catch {
    // Best effort cleanup.
  }
}

/**
 * Read and parse a JSON file safely.
 *
 * @param {string} p - File path to parse.
 * @returns {any} Parsed JSON content or undefined.
 */
const readJson = p => {
  try {
    return JSON.parse(readFileSync(p, 'utf8'))
  } catch {
    return undefined
  }
}
const ownPackage = readJson(join(ownDir, 'package.json'))
const ownVersion = ownPackage?.name === '@deepseek-harness-tui/dsh-tui' ? ownPackage.version : undefined
const PACKAGE = '@deepseek-harness-tui/dsh-tui'
const PROFILE = 'dsh-tui'

// --- 内联小工具（见文件头：零 lib 依赖是迁移契约的一部分）---------------------
// 与 lib/types/utils/shellQuote.js 同语义的最小实现：cmd.exe 以空格拼接参数
// 且不做转义，含空格/引号的参数必须整体加引号（内层引号与反斜杠转义）。
/**
 * Quote an array of arguments for cmd.exe.
 *
 * @param {string[]} args - Argument tokens.
 * @returns {string[]} Quoted argument tokens.
 */
const shellQuote = args =>
  args.map(arg => {
    const s = String(arg)
    if (s === '') return '""'
    if (!/[\s"^]/.test(s)) return s
    return `"${s.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`
  })
const isWin = process.platform === 'win32'
const shellOpt = isWin ? { shell: true } : {}
// DEP0190（issue #148）：shell:true + 非空参数数组触发语法级弃用告警——
// 转义后拼进命令字符串（空参数数组不触发），非 Windows 保持数组直传。
const cmd = (command, args) =>
  isWin ? [`${command} ${shellQuote(args).join(' ')}`, []] : [command, args]

// 内联 semver（解析 + 严格大于）：启动器可能在依赖不完整的环境里被执行
// （迁移、半损坏安装、测试沙箱），零外部依赖是自保底线。覆盖 semver 的
// 核心-先行版比较规则：先行版标识符逐段比（数字段按数值、小于字母段），
// 前缀相同时段数少者更旧，无先行版者最新。
const parseVersion = v => {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(String(v).trim())
  return m
    ? { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre: m[4] === undefined ? null : m[4].split('.') }
    : null
}
const isVersionNewer = (a, b) => {
  const A = parseVersion(a)
  const B = parseVersion(b)
  if (A === null || B === null) return false
  for (const key of ['major', 'minor', 'patch']) {
    if (A[key] !== B[key]) return A[key] > B[key]
  }
  if (A.pre === null) return B.pre !== null
  if (B.pre === null) return false
  for (let i = 0; i < Math.max(A.pre.length, B.pre.length); i++) {
    const x = A.pre[i]
    const y = B.pre[i]
    if (x === undefined) return false
    if (y === undefined) return true
    if (x === y) continue
    const xn = /^\d+$/.test(x)
    const yn = /^\d+$/.test(y)
    if (xn && yn) return Number(x) > Number(y)
    if (xn !== yn) return yn
    return x > y
  }
  return false
}

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
  bootstrapUnreadable: {
    en: dir =>
      `[dsh-tui] install reported success but the plugin package is still unreadable under:\n` +
      `  ${dir}\n` +
      `  pnpm treats this half-installed profile as already up to date, so every retry\n` +
      `  reports success while boot keeps failing. Recovery:\n` +
      `  rm -rf ${dir} && dsh-tui`,
    zh: dir =>
      `[dsh-tui] 安装报告成功，但插件包仍不可读：\n` +
      `  ${dir}\n` +
      `  pnpm 把半残的 profile 视为已装好，重试永远「成功」而启动照旧崩溃。\n` +
      `  恢复方法：\n` +
      `  rm -rf ${dir} 后重新运行 dsh-tui`,
  },
  launchFailed: {
    en: err => `[dsh-tui] Failed to launch: ${err.message}`,
    zh: err => `[dsh-tui] 启动失败：${err.message}`,
  },
  delegateFailed: {
    en: path =>
      `[dsh-tui] cannot launch the profile copy:\n  ${path}\nReinstall the global launcher:\n  npm install -g --legacy-peer-deps ${PACKAGE}@latest\n(--legacy-peer-deps avoids an npm 12 peer-resolution crash; the launcher is a thin shim, so skipping global peer resolution is safe.)`,
    zh: path =>
      `[dsh-tui] 无法启动 profile 内副本：\n  ${path}\n请重装全局启动器：\n  npm install -g --legacy-peer-deps ${PACKAGE}@latest\n（--legacy-peer-deps 可绕过 npm 12 的 peer 解析崩溃；启动器是瘦壳，跳过全局 peer 解析是安全的。）`,
  },
  profileExited: {
    en: code => `[dsh-tui] dsh profile exited with code ${code}. Run it directly for diagnostics:\n  dsh --profile ${PROFILE}`,
    zh: code => `[dsh-tui] dsh profile 已退出（退出码 ${code}）。可直接运行以下命令查看诊断：\n  dsh --profile ${PROFILE}`,
  },
  legacyEnv: {
    en: (oldName, newName) => `[dsh-tui] note: env ${oldName} was renamed to ${newName}; the old name no longer takes effect.`,
    zh: (oldName, newName) => `[dsh-tui] 提示：环境变量 ${oldName} 已更名为 ${newName}，旧名不再生效。`,
  },
  notInstalled: {
    en: '(not installed)',
    zh: '（未安装）',
  },
  doctorLabels: {
    en: {
      dshMissing: 'not found — install it first:  npm install -g @deepseek-ai/dsh',
      pnpmMissing: 'not found — needed for install/update:  npm install -g pnpm',
      profileMissing: 'not installed — run `dsh-tui` once to bootstrap it',
      aligned: 'aligned',
      profileNewer: v => `profile is newer — align the launcher:  npm install -g ${PACKAGE}@${v}`,
      profileOlder: v => `profile is older — align it:  dsh plugin --profile ${PROFILE} add ${PACKAGE}@${v}`,
      keySet: 'set',
      keyMissing: 'not set — interactive launch reads DEEPSEEK_API_KEY',
      missing: 'missing',
    },
    zh: {
      dshMissing: '未找到——请先安装：  npm install -g @deepseek-ai/dsh',
      pnpmMissing: '未找到——安装/升级需要它：  npm install -g pnpm',
      profileMissing: '未安装——运行一次 `dsh-tui` 即可自举',
      aligned: '已对齐',
      profileNewer: v => `profile 较新——对齐启动器：  npm install -g ${PACKAGE}@${v}`,
      profileOlder: v => `profile 较旧——对齐它：  dsh plugin --profile ${PROFILE} add ${PACKAGE}@${v}`,
      keySet: '已设置',
      keyMissing: '未设置——交互启动读取 DEEPSEEK_API_KEY',
      missing: '缺失',
    },
  },
  updateUnavailable: {
    en:
      `[dsh-tui] \`update\` needs the profile's compiled copy, but it is missing or too old to carry the CLI entry.\n` +
      `Update manually instead:\n  dsh plugin --profile ${PROFILE} add ${PACKAGE}@latest`,
    zh:
      `[dsh-tui] \`update\` 需要 profile 的编译产物，但它缺失或版本过旧、不含 CLI 入口。\n` +
      `请改用手工升级：\n  dsh plugin --profile ${PROFILE} add ${PACKAGE}@latest`,
  },
  helpText: {
    en:
      `Usage: dsh-tui|dst [command] [options] [path|url]\n\n` +
      `Commands:\n` +
      `  update                 Update the ${PROFILE} profile to the latest release\n` +
      `  doctor                 Pre-flight environment checks (dsh/pnpm/profile/key)\n` +
      `  version                Show launcher and profile versions\n` +
      `  help                   Show this help\n\n` +
      `Options:\n` +
      `  --resume [id]          Resume the last (or the given) session\n` +
      `  -c, --continue         Same as --resume\n` +
      `  <path|url>             Open with the given workspace target\n\n` +
      `Any other argument is forwarded to \`dsh --profile ${PROFILE}\`.`,
    zh:
      `用法：dsh-tui|dst [命令] [选项] [路径|URL]\n\n` +
      `命令：\n` +
      `  update                 将 ${PROFILE} profile 升级到最新版本\n` +
      `  doctor                 启动前环境诊断（dsh/pnpm/profile/密钥）\n` +
      `  version                显示启动器与 profile 版本\n` +
      `  help                   显示本帮助\n\n` +
      `选项：\n` +
      `  --resume [id]          恢复上次（或指定 id 的）会话\n` +
      `  -c, --continue         同 --resume\n` +
      `  <路径|URL>             以指定工作区目标启动\n\n` +
      `其余参数原样转发给 \`dsh --profile ${PROFILE}\`。`,
  },
}
const msg = key => MSG[key][lang]

// React 开发构建会把每次渲染的 performance.measure() 堆进无界缓冲区导致
// 长会话 OOM——与仓库根 dsh-tui.cmd 保持一致，强制 production。
process.env.NODE_ENV ??= 'production'

const sameDir = (a, b) => {
  try {
    return realpathSync(resolve(a)) === realpathSync(resolve(b))
  } catch {
    return resolve(a) === resolve(b)
  }
}

const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
const profileDir = join(dshHome, 'profiles', PROFILE)
const profilePkgDir = join(profileDir, 'node_modules', '@deepseek-harness-tui', 'dsh-tui')
const profileBin = join(profilePkgDir, 'bin', 'dsh-tui.js')
const installedPkgPath = join(profilePkgDir, 'package.json')
const runningInsideProfile = sameDir(ownDir, profilePkgDir)

// ─── 子命令：version / help ──────────────────────────────────────────────────
// 只认第一个参数，且在角色分支之前应答：两种角色都不经过委托与自举——
// `dsh-tui --help` 在没装 dsh、profile 残缺时也必须能出（否则求助命令
// 本身先触发一轮安装）。后续位置的同名字符串不截获，保持既有透传与
// 工作区目标嗅探行为不变。
const subcommand = process.argv[2]
if (subcommand === 'version' || subcommand === '--version' || subcommand === '-v') {
  const role = runningInsideProfile ? 'profile' : 'launcher'
  console.log(`${PACKAGE} ${ownVersion ?? 'unknown'} (${role})`)
  const profileVersion = readJson(installedPkgPath)?.version
  console.log(`profile: ${profileVersion ?? msg('notInstalled')}  ${profilePkgDir}`)
  process.exit(0)
}
if (subcommand === 'help' || subcommand === '--help' || subcommand === '-h') {
  console.log(msg('helpText'))
  process.exit(0)
}
// ─── 子命令：doctor ──────────────────────────────────────────────────────────
// 启动前环境诊断——针对「TUI 起不来」的故障域（装不上、update 后版本不
// 同步、密钥没配），与 TUI 内 /doctor 的会话内诊断互补。零 lib 依赖、
// 不委托、不自举：profile 残缺时它必须还能跑。密钥红线：只报告是否已
// 设置，绝不输出值。仅 dsh 缺失记为硬失败（其余检查全部照常打印后再
// 以退出码 1 收束）。
if (subcommand === 'doctor') {
  const L = msg('doctorLabels')
  let hardFailure = false
  const report = (ok, label, detail) => console.log(`${ok ? '✓' : '✗'} ${label}: ${detail}`)
  console.log(`dsh-tui doctor · ${PACKAGE} ${ownVersion ?? 'unknown'}`)
  report(true, 'node', `${process.version} · ${process.platform} ${process.arch}`)
  const probeVersion = command => {
    const probe = spawnSync(...cmd(command, ['--version']), { stdio: 'pipe', encoding: 'utf8', ...shellOpt })
    if (probe.error || probe.status !== 0) return undefined
    // 白名单校验：只回显版本号形状的首行。诊断输出的红线是绝不泄露密钥，
    // 而 PATH 上的 wrapper 理论上可以把任意环境变量 echo 进 --version——
    // 不匹配版本形状的输出一律不转印。
    const line = String(probe.stdout ?? '').trim().split('\n')[0] ?? ''
    return /^v?\d[\w.+-]*$/.test(line) ? line : '(version unreadable)'
  }
  const dshVersion = probeVersion('dsh')
  if (dshVersion === undefined) {
    hardFailure = true
    report(false, 'dsh', L.dshMissing)
  } else {
    report(true, 'dsh', dshVersion)
  }
  const pnpmVersion = probeVersion('pnpm')
  report(pnpmVersion !== undefined, 'pnpm', pnpmVersion ?? L.pnpmMissing)
  const profileVersion = readJson(installedPkgPath)?.version
  if (profileVersion === undefined) {
    report(false, 'profile', `${L.profileMissing}  (${profileDir})`)
  } else {
    report(true, 'profile', `${profileVersion}  (${profileDir})`)
    if (ownVersion !== undefined && !runningInsideProfile) {
      if (profileVersion === ownVersion) {
        report(true, 'launcher ↔ profile', L.aligned)
      } else if (isVersionNewer(profileVersion, ownVersion)) {
        report(false, 'launcher ↔ profile', L.profileNewer(profileVersion))
      } else {
        report(false, 'launcher ↔ profile', L.profileOlder(ownVersion))
      }
    }
  }
  // truthiness 而非 !== undefined：空字符串的 key 同样发不了请求，且 TUI 内
  // /doctor（channel.doctorInfo）按 truthiness 报告——两个 doctor 不许分叉。
  const keySet = Boolean(process.env.DEEPSEEK_API_KEY)
  report(keySet, 'DEEPSEEK_API_KEY', keySet ? L.keySet : L.keyMissing)
  for (const candidate of [join(homedir(), '.dsh-tui', 'cordis.yml'), join(profileDir, 'cordis.patch.yml')]) {
    report(existsSync(candidate), 'config', `${candidate}${existsSync(candidate) ? '' : `  ${L.missing}`}`)
  }
  process.exit(hardFailure ? 1 : 0)
}

const forwardExit = child => {
  child.on('error', err => {
    console.error(msg('launchFailed')(err))
    process.exit(1)
  })
  child.on('exit', (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal)
    } else {
      if (code !== null && code !== 0) console.error(msg('profileExited')(code))
      process.exit(code ?? 0)
    }
  })
}

// 首次运行自举：探测 dsh 与 pnpm，随后 `dsh plugin add` 固定到与启动器一
// 致的版本（避免 pnpm store 缓存带来的旧版漂移）。-w 重试（issue #239）与
// 「no-op 假成功」复查（issue #209）在此集中实现，瘦壳与完整逻辑共用。
const profileReady = () => {
  try {
    readFileSync(installedPkgPath, 'utf8')
    return true
  } catch {
    return false
  }
}
const bootstrapProfile = () => {
  const probe = spawnSync(...cmd('dsh', ['--version']), { stdio: 'pipe', ...shellOpt })
  if (probe.error || probe.status !== 0) {
    console.error(msg('noDsh'))
    process.exit(1)
  }
  const pnpmProbe = spawnSync(...cmd('pnpm', ['--version']), { stdio: 'pipe', ...shellOpt })
  if (pnpmProbe.error || pnpmProbe.status !== 0) {
    console.error(msg('noPnpm'))
    process.exit(1)
  }
  console.log(msg('bootstrapStart'))
  const runAdd = (extraArgs, capture) => spawnSync(
    ...cmd('dsh', ['plugin', '--profile', PROFILE, 'add', ...extraArgs, `${PACKAGE}@${ownVersion}`]),
    { stdio: capture ? ['inherit', 'pipe', 'pipe'] : 'inherit', ...shellOpt },
  )
  let add = runAdd([], true)
  if (add.status !== 0) {
    const captured = `${add.stdout ?? ''}${add.stderr ?? ''}`
    process.stderr.write(captured)
    if (captured.includes('ERR_PNPM_ADDING_TO_ROOT')) {
      console.log(msg('bootstrapRetryW'))
      add = runAdd(['-w'], false)
    }
  } else {
    process.stdout.write(`${add.stdout ?? ''}${add.stderr ?? ''}`)
  }
  if (add.status !== 0) {
    console.error(msg('installFailed'))
    process.exit(add.status ?? 1)
  }
  if (!profileReady()) {
    console.error(msg('bootstrapUnreadable')(profileDir))
    process.exit(1)
  }
}

// ─── 子命令：update ──────────────────────────────────────────────────────────
// 顶层处理、两种角色同一条路径——不放进委托链。委托会把 update 交给
// profile 内的旧 bin：旧副本不认识这个词，只会当参数透传，恰好是「profile
// 落后、最需要升级」的用户永远到不了新入口。这里统一动态 import **profile
// 的**编译产物（不是本副本的——DSH_TUI_NO_DELEGATE 下两者不同包，读本副本
// 会拿全局包版本误判 already-latest/half-updated）；瘦壳零 lib 静态依赖的
// 迁移契约不变。profile 未初始化时先走既有自举（dsh/pnpm 预检在其中）；
// 编译产物缺失或没有 cliUpdate 导出（半更新的旧版）给手工升级指引退出 1。
// 判定先于工作区目标嗅探：cwd 里名为 update 的文件不再被当成路径。
if (subcommand === 'update') {
  if (!profileReady()) bootstrapProfile()
  {
    const probe = spawnSync(...cmd('dsh', ['--version']), { stdio: 'pipe', ...shellOpt })
    if (probe.error || probe.status !== 0) {
      console.error(msg('noDsh'))
      process.exit(1)
    }
  }
  let cliUpdate
  try {
    ;({ cliUpdate } = await import(pathToFileURL(join(profilePkgDir, 'lib', 'types', 'update.js')).href))
  } catch {
    cliUpdate = undefined
  }
  if (typeof cliUpdate !== 'function') {
    console.error(msg('updateUnavailable'))
    process.exit(1)
  }
  process.exit(await cliUpdate(PROFILE))
}

// ─── 全局副本：瘦壳角色 ───────────────────────────────────────────────────────
// DSH_TUI_NO_DELEGATE=1 是测试/调试逃生口：强制走完整逻辑（verify-launcher
// 的沙箱用它直接驱动全量路径；现场排查委托链时同样可用）。
if (!runningInsideProfile && ownVersion !== undefined && process.env.DSH_TUI_NO_DELEGATE !== '1') {
  if (!profileReady()) bootstrapProfile()
  // 委托 profile 内副本执行全部启动逻辑。外层代际通过
  // DSH_TUI_LAUNCHER_VERSION 交代（/update 的对齐诊断沿用该契约）。
  try {
    readFileSync(profileBin, 'utf8')
  } catch {
    console.error(msg('delegateFailed')(profileBin))
    process.exit(1)
  }
  process.env.DSH_TUI_LAUNCHER_VERSION = ownVersion
  const child = spawn(process.execPath, [profileBin, ...process.argv.slice(2)], {
    stdio: 'inherit',
    env: process.env,
  })
  forwardExit(child)
} else {
  // ─── profile 副本（或源码运行）：完整启动逻辑 ─────────────────────────────
  // dsh CLI 预检（缺失时给安装指引，先于一切 profile 逻辑）。
  {
    const probe = spawnSync(...cmd('dsh', ['--version']), { stdio: 'pipe', ...shellOpt })
    if (probe.error || probe.status !== 0) {
      console.error(msg('noDsh'))
      process.exit(1)
    }
  }

  let installedVersion
  try {
    installedVersion = JSON.parse(readFileSync(installedPkgPath, 'utf8')).version
  } catch {
    installedVersion = undefined
  }
  // 残骸/未初始化 profile：与旧启动器一致地就地自举（add 固定到本包版
  // 本，成功后版本天然对齐），而不是拒绝启动。
  if (installedVersion === undefined) {
    bootstrapProfile()
    try {
      installedVersion = JSON.parse(readFileSync(installedPkgPath, 'utf8')).version
    } catch {
      installedVersion = undefined
    }
  }
  if (installedVersion !== undefined && ownVersion !== undefined && installedVersion !== ownVersion && !runningInsideProfile) {
    const majorMinor = v => v.split('-')[0].split('.').slice(0, 2).map(Number)
    const [installedMajor, installedMinor] = majorMinor(installedVersion)
    const [ownMajor, ownMinor] = majorMinor(ownVersion)
    if (installedMajor < ownMajor || (installedMajor === ownMajor && installedMinor < ownMinor)) {
      console.error(
        `[dsh-tui] cannot start: the profile runs v${installedVersion} but this launcher is v${ownVersion}.\n` +
          `  dsh plugin --profile ${PROFILE} add ${PACKAGE}@${ownVersion}`,
      )
      process.exit(1)
    }
    const installedNewer = installedVersion !== undefined && ownVersion !== undefined && isVersionNewer(installedVersion, ownVersion)
    if (installedNewer) {
      console.error(
        `[dsh-tui] note: the profile is already v${installedVersion}; this launcher copy is v${ownVersion}.\n` +
          `  npm install -g --legacy-peer-deps ${PACKAGE}@${installedVersion}\n` +
          `(--legacy-peer-deps avoids an npm 12 peer-resolution crash, see issue #459)`,
      )
    } else {
      // profile 更旧但同 minor（patch 级错位）：允许启动，指引用 add 把
      // profile 对齐到启动器版本（精确版本，@latest 可能越过对齐点）。
      console.error(
        `[dsh-tui] note: the profile is running v${installedVersion} but this launcher is v${ownVersion}.\n` +
          `  dsh plugin --profile ${PROFILE} add ${PACKAGE}@${ownVersion}`,
      )
    }
  }

  // --resume / 工作区目标拦截（issue #120/#53 的启动器契约）。
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
      if (!sessionId) sessionId = readLastResumeTarget()
      if (sessionId) setResumeEnv(sessionId)
    } else if (
      process.env.DSH_TUI_WORKSPACE_TARGET === undefined
      && !a.startsWith('-')
      && (isAbsolute(a) || /^[a-z][a-z0-9+.-]*:\/\//iu.test(a) || existsSync(resolve(a)))
    ) {
      process.env.DSH_TUI_WORKSPACE_TARGET = a
    } else {
      args.push(a)
    }
  }

  // 旧环境变量警告（必须在 TUI 渲染前输出，fullscreen 下写 stderr 会破坏
  // 界面）。与 utils/paths 的 RENAMED_ENV 同表，内联以维持零 lib 依赖。
  const RENAMED_ENV = {
    CC_TUI_THEME: 'DSH_TUI_THEME',
    CC_TUI_LANG: 'DSH_TUI_LANG',
    CC_TUI_PERSONA: 'DSH_TUI_PERSONA',
    CC_TUI_PRESET: 'DSH_TUI_PRESET',
    CC_TUI_DISABLE_MOUSE: 'DSH_TUI_DISABLE_MOUSE',
    CC_TUI_DEBUG: 'DSH_TUI_DEBUG',
    CC_TUI_COMPACT_RATIO: 'DSH_TUI_COMPACT_RATIO',
    CC_TUI_COMPACT_RETAIN: 'DSH_TUI_COMPACT_RETAIN',
    DSH_CC_UPDATED_FROM: 'DSH_TUI_UPDATED_FROM',
    DSH_CC_RENDER_LOG: 'DSH_TUI_RENDER_LOG',
    DSH_CC_SESSION_ROOT: 'DSH_TUI_SESSION_ROOT',
    DSH_CC_WORKSPACE: 'DSH_TUI_WORKSPACE',
  }
  for (const oldName of Object.keys(RENAMED_ENV)) {
    if (process.env[oldName] !== undefined) {
      console.error(msg('legacyEnv')(oldName, RENAMED_ENV[oldName]))
    }
  }

  // 启动：被委托场景下本副本自己的版本即对齐诊断所见的启动器代际。
  if (process.env.DSH_TUI_LAUNCHER_VERSION === undefined && ownVersion !== undefined) {
    process.env.DSH_TUI_LAUNCHER_VERSION = ownVersion
  }

  const child = spawn(...cmd('dsh', ['--profile', PROFILE, ...args]), {
    stdio: 'inherit',
    env: process.env,
    ...shellOpt,
  })
  forwardExit(child)
}
