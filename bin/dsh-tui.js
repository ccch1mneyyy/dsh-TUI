#!/usr/bin/env node
/**
 * dsh-tui — 双态启动器（delegating launcher，0.9.3）。
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
 *     `dsh --profile dsh-tui` 启动与退出码透传。
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

if (process.platform === 'win32' && process.env.DSH_TUI_STANDALONE_BINARY && process.argv[2] !== 'safe') {
  try {
    const oldBinary = `${process.env.DSH_TUI_STANDALONE_BINARY}.old`
    if (existsSync(oldBinary)) rmSync(oldBinary, { force: true })
  } catch {
    // Best effort cleanup.
  }
}

const here = dirname(fileURLToPath(import.meta.url))
const ownDir = dirname(here)

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
// 救援 profile（最小可用）：同 home 下的空白 profile（仅 base+TUI，无第三方
// 插件），是主 profile 装炸时的干净启动通道——创建走官方 dsh plugin add
// （钉当前版本，同 bootstrap 语义），写操作只发生在这个新目录。
const RESCUE_PROFILE = 'dsh-tui-safe'

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

const lang = process.env.DSH_TUI_LANG === 'en' ? 'en' : 'zh'
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
  safeAsk: {
    en: code => `dsh-tui exited unexpectedly (code ${code}). Enter safe mode? [Y/n] `,
    zh: code => `dsh-tui 异常退出（码 ${code}）。进入安全模式？[Y/n] `,
  },
  safeHint: {
    en: code => `[dsh-tui] Exited with code ${code}. Run dsh-tui safe for diagnostics and repair guidance.`,
    zh: code => `[dsh-tui] 异常退出（码 ${code}）。可运行 dsh-tui safe 进入安全模式`,
  },
  safeRetrySignaled: {
    en: signal => `[dsh-tui] retry signaled: ${signal}`,
    zh: signal => `[dsh-tui] 重试被信号中断：${signal}`,
  },
  safeTitle: {
    en: role => `dsh-tui safe · safe mode (read-only control plane)  [${role}]`,
    zh: role => `dsh-tui safe · 安全模式（控制面只读）  [${role}]`,
  },
  safeIgnoredArgs: {
    en: n => `[dsh-tui] ignored ${n} extra argument(s) after \`safe\``,
    zh: n => `[dsh-tui] 已忽略附加参数：${n} 个`,
  },
  safeListUnreadable: {
    en: reason => `Profile inventory unreadable (${reason}). See repair guidance below.`,
    zh: reason => `清单不可读：<${reason}>。修复指引见下方。`,
  },
  safeGuideIntro: {
    en: 'Repair commands (run them yourself — safe mode is read-only):',
    zh: '修复命令（需自行执行——安全模式只读）：',
  },
  safeRescueCreating: {
    en: `[dsh-tui] Creating the blank rescue profile (${RESCUE_PROFILE})…`,
    zh: `[dsh-tui] 正在创建空白救援 profile（${RESCUE_PROFILE}）…`,
  },
  safeRescueExists: {
    en: `[dsh-tui] Rescue profile already exists — starting it as-is.`,
    zh: `[dsh-tui] 救援 profile 已存在——按现状直接启动。`,
  },
  safeRescueCreated: {
    en: `[dsh-tui] Rescue profile created (base + TUI only, no third-party plugins) — starting it.`,
    zh: `[dsh-tui] 救援 profile 已创建（仅 base + TUI，无第三方插件）——正在启动。`,
  },
  safeRescueFailed: {
    en: detail => `[dsh-tui] Rescue profile creation failed (${detail}). See the diagnostics above and the guidance (option 4).`,
    zh: detail => `[dsh-tui] 救援 profile 创建失败（${detail}）。请看上方诊断与指引（选项 4）。`,
  },
  safeMenuLabels: {
    en: {
      retry: 'Retry normal startup',
      doctor: 'Run environment diagnostics',
      inventory: 'Show profile plugin inventory (read-only)',
      guide: 'Show repair command guidance',
      rescue: 'Create blank rescue profile and start clean (dsh-tui-safe)',
      exit: code => `Exit (exit code ${code})`,
      prompt: 'safe> ',
      invalid: 'Invalid choice — enter 1-6:',
      replaySource: ' (replay)',
      coldStartSource: ' (cold start)',
      bundlesHeader: 'Composition layers (dsh.profile.bundles, ordered):',
      depsHeader: 'Direct dependencies (uninstallable candidates marked 3rd-party):',
      builtin: 'builtin',
      third: '3rd-party',
    },
    zh: {
      retry: '重试正常启动',
      doctor: '运行环境诊断',
      inventory: '查看 profile 插件清单（只读）',
      guide: '显示修复命令指引',
      rescue: '创建空白救援 profile 并干净启动（dsh-tui-safe）',
      exit: code => `退出（退出码 ${code}）`,
      prompt: 'safe> ',
      invalid: '无效选择——请输入 1-6：',
      replaySource: '（重放）',
      coldStartSource: '（冷启动）',
      bundlesHeader: '组合层（dsh.profile.bundles，有序）：',
      depsHeader: '直接依赖（第三方为可卸载候选）：',
      builtin: '内置',
      third: '第三方',
    },
  },
  // safe 指引与清单降级原因的文案（renderGuide / renderInventory 取用）：
  // zh 为收编前的字面文案；`@<版本>` 占位以 versionPlaceholder 拼接。
  safeGuideLabels: {
    en: {
      missingReason: 'package.json missing or corrupt',
      fieldsReason: 'required fields missing or wrong type',
      notReadyReason: 'profile not ready (missing or half-installed)',
      uninstallThird: '  # Remove third-party plugins (one by one):',
      nothingThird: '  # No third-party direct dependencies to uninstall',
      reinstallTui: '  # Reinstall/align the TUI (see dsh-tui doctor for the version):',
      versionPlaceholder: '<version>',
      diagnostics: '  # Environment diagnostics:',
      globalUpgrade: '  # Global upgrade when the launcher is too old:',
      rescueProfile: '  # Rescue profile (blank, no third-party plugins; also menu option 5):',
    },
    zh: {
      missingReason: 'package.json 缺失或损坏',
      fieldsReason: '必需字段缺失或类型错误',
      notReadyReason: 'profile 未就绪（未安装或残缺）',
      uninstallThird: '  # 卸载第三方插件（逐个执行）:',
      nothingThird: '  # 无第三方直接依赖可卸载',
      reinstallTui: '  # 重装/对齐 TUI（版本见 dsh-tui doctor）:',
      versionPlaceholder: '<版本>',
      diagnostics: '  # 环境诊断:',
      globalUpgrade: '  # 启动器过旧时的全局升级:',
      rescueProfile: '  # 救援 profile（空白，无第三方插件；也可用菜单选项 5 一键创建并启动）:',
    },
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
      keySetEnv: 'set (environment)',
      keySetStore: 'set (DSH credential store)',
      keyMissing: 'not set — neither DEEPSEEK_API_KEY nor a DSH credential-store ref',
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
      keySetEnv: '已设置（环境变量）',
      keySetStore: '已设置（DSH 凭据库）',
      keyMissing: '未设置——环境变量与 DSH 凭据库中都没有 DEEPSEEK_API_KEY',
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
      `  safe                   Safe mode: read-only diagnostics, inventory, repair guidance\n` +
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
      `  safe                   安全模式：只读诊断、插件清单与修复指引\n` +
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
/**
 * Whether the DSH credential store declares a reference by this name.
 *
 * The launcher stays dependency-free, so the YAML is read as text: only the
 * top-level `refs:` block maps reference names to stored secrets, and matching
 * the bare name anywhere else (grants, payloads) would false-positive. Reports
 * presence only — the value is never read, formatted, or printed. Mirrored by
 * the in-TUI `/doctor` in src/utils/credentials.ts; the two must not diverge.
 * @param home - The DSH home directory that holds `.credentials.yaml`.
 * @param name - Reference name to look for (e.g. `DEEPSEEK_API_KEY`).
 * @returns True when a `refs` entry with that name exists.
 */
const credentialRefDeclared = (home, name) => {
  try {
    const text = readFileSync(join(home, '.credentials.yaml'), 'utf8')
    const block = /^refs:[ \t]*\r?\n((?:[ \t]+\S.*(?:\r?\n|$))*)/mu.exec(text)
    if (block === null) return false
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
    return new RegExp(`^[ \t]+${escaped}[ \t]*:`, 'mu').test(block[1])
  } catch {
    return false
  }
}

// ─── doctor 检查逻辑（doctor 子命令与 safe 会话共用）──────────────────────────
// 输出与退出语义与单命令时代逐字一致：版本探针白名单回显、密钥只报
// truthiness（env 或凭据库 ref 任一命中即视为已设置）、仅 dsh 缺失为硬
// 失败。safe 复用同一函数——两个入口的 diagnostics 不许分叉（对齐 doctor
// 与 TUI 内 /doctor 的既有契约）。
const runDoctorChecks = () => {
  const L = msg('doctorLabels')
  const lines = []
  let hardFailure = false
  const report = (ok, label, detail) => lines.push(`${ok ? '✓' : '✗'} ${label}: ${detail}`)
  lines.push(`dsh-tui doctor · ${PACKAGE} ${ownVersion ?? 'unknown'}`)
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
  // truthiness 而非 !== undefined：空字符串的 key 同样发不了请求。TUI 内
  // /doctor（channel.doctorInfo）用同一判定——两个 doctor 不许分叉。
  // 只看环境变量会误报：dsh 在启动时才把凭据库里的 ref 解析进会话，而
  // doctor 跑在 dsh 之前，此时环境变量通常仍是空的。
  const keyFromEnv = Boolean(process.env.DEEPSEEK_API_KEY)
  const keyFromStore = credentialRefDeclared(dshHome, 'DEEPSEEK_API_KEY')
  report(
    keyFromEnv || keyFromStore,
    'DEEPSEEK_API_KEY',
    keyFromEnv ? L.keySetEnv : keyFromStore ? L.keySetStore : L.keyMissing,
  )
  for (const candidate of [join(homedir(), '.dsh-tui', 'cordis.yml'), join(profileDir, 'cordis.patch.yml')]) {
    report(existsSync(candidate), 'config', `${candidate}${existsSync(candidate) ? '' : `  ${L.missing}`}`)
  }
  return { hardFailure, lines }
}
// ─── safe 会话支撑（清单解析与报告渲染，交互/非交互共用）──────────────────────
// 保护包：组合层模板与 TUI 本体，不进入卸载候选。两维度分类是 PR② 卸载
// 功能将复用的唯一分类规则，不得合并简化（spec §6.1）。
const PROTECTED_PLUGINS = new Set(['@deepseek-ai/dsh-base', PACKAGE])
const readProfileInventory = () => {
  const pkg = readJson(join(profileDir, 'package.json'))
  if (pkg === undefined || typeof pkg !== 'object') return { error: 'missing' }
  const bundles = Array.isArray(pkg?.dsh?.profile?.bundles) ? pkg.dsh.profile.bundles.filter(x => typeof x === 'string') : undefined
  const deps = pkg?.dependencies && typeof pkg.dependencies === 'object' && !Array.isArray(pkg.dependencies)
    ? Object.keys(pkg.dependencies)
    : undefined
  if (bundles === undefined || deps === undefined) return { error: 'fields' }
  return { bundles, deps }
}
const renderInventory = lines => {
  const L = msg('safeMenuLabels')
  const G = msg('safeGuideLabels')
  const inv = readProfileInventory()
  if (inv.error) {
    lines.push(msg('safeListUnreadable')(inv.error === 'missing' ? G.missingReason : G.fieldsReason))
    return
  }
  lines.push(L.bundlesHeader)
  for (const b of inv.bundles) lines.push(`  · ${b}  (${L.builtin})`)
  lines.push(L.depsHeader)
  for (const d of inv.deps) lines.push(`  · ${d}  (${PROTECTED_PLUGINS.has(d) ? L.builtin : L.third})`)
}
const renderGuide = lines => {
  const L = msg('safeGuideLabels')
  lines.push(msg('safeGuideIntro'))
  const inv = readProfileInventory()
  const third = inv.error ? [] : inv.deps.filter(d => !PROTECTED_PLUGINS.has(d))
  if (third.length > 0) {
    lines.push(L.uninstallThird)
    for (const d of third) lines.push(`  dsh plugin --profile ${PROFILE} remove ${d}`)
  } else {
    lines.push(L.nothingThird)
  }
  lines.push(L.reinstallTui)
  lines.push(`  dsh plugin --profile ${PROFILE} add ${PACKAGE}@${L.versionPlaceholder}`)
  lines.push(L.diagnostics)
  lines.push(`  dsh-tui doctor`)
  lines.push(L.globalUpgrade)
  lines.push(`  npm install -g --legacy-peer-deps ${PACKAGE}@${L.versionPlaceholder}`)
  lines.push(L.rescueProfile)
  lines.push(`  dsh plugin --profile ${RESCUE_PROFILE} add ${PACKAGE}@${L.versionPlaceholder}`)
  lines.push(`  dsh --profile ${RESCUE_PROFILE}`)
}
const renderSafeReport = extraLines => {
  const lines = []
  lines.push(msg('safeTitle')(runningInsideProfile ? 'profile' : 'launcher'))
  for (const l of extraLines ?? []) lines.push(l)
  const { lines: doctorLines } = runDoctorChecks()
  for (const l of doctorLines) lines.push(l)
  renderInventory(lines)
  renderGuide(lines)
  return lines
}
// ─── 子命令：doctor ──────────────────────────────────────────────────────────
// 启动前环境诊断——针对「TUI 起不来」的故障域（装不上、update 后版本不
// 同步、密钥没配），与 TUI 内 /doctor 的会话内诊断互补。零 lib 依赖、
// 不委托、不自举：profile 残缺时它必须还能跑。密钥红线：只报告是否已
// 设置，绝不输出值。仅 dsh 缺失记为硬失败（其余检查全部照常打印后再
// 以退出码 1 收束）。
if (subcommand === 'doctor') {
  const { hardFailure, lines } = runDoctorChecks()
  for (const line of lines) console.log(line)
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

// ─── dsh 会话结果模型（fallback 与 safe 重试共用）─────────────────────────────
// 统一表示子进程结局；不在此处做任何退出决定——退出权在调用者（首启结算
// 或 safe 菜单）。Windows 经 cmd()/shell:true 启动（见 cmd 注释），壳层
// 观察到的 signal 不保证等同内部 dsh 的中断语义：判定一律只看数值 code，
// 不从数值反推信号（spec §5.1）。
const startDshSession = (dshArgs, profile = PROFILE) =>
  new Promise(resolve => {
    const child = spawn(...cmd('dsh', ['--profile', profile, ...dshArgs]), {
      stdio: 'inherit',
      env: process.env,
      ...shellOpt,
    })
    child.on('error', err => resolve({ kind: 'error', error: err }))
    child.on('exit', (code, signal) => {
      if (signal) resolve({ kind: 'signal', signal })
      else resolve({ kind: 'exit', code: code ?? 0 })
    })
  })

// TTY 判定：询问与菜单都要求 stdin/stdout 均可交互（readline 需要 stdin，
// 菜单可读需要 stdout）；任一非 TTY（脚本/管道/headless 宿主）走降级。
const isInteractive = () => Boolean(process.stdin.isTTY && process.stdout.isTTY)

// 子进程异常退出后终端可能停在脏状态（alt-screen/鼠标/隐藏光标——清理
// 责任在 TUI 的 ink 退出路径，不保证完成）。进入询问/菜单前做最小恢复，
// 仅为让后续界面可读，不承诺完整复原（spec §6.2）。
const restoreTerminalMinimal = () => {
  process.stdout.write('\x1b[?1049l\x1b[?1000l\x1b[?1006l\x1b[?25h')
}

const askSafeEntry = async pendingExitCode => {
  restoreTerminalMinimal()
  const readline = (await import('node:readline/promises')).default
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  let cancelled = false
  rl.on('SIGINT', () => { cancelled = true; rl.close() })
  // 与 runSafeSession.askChoice 同款 close 竞速：接口 close（上方 SIGINT
  // 处理器主动 close，或 TTY 的 Ctrl+D/EOF）时 question 可能永不结算——
  // 裸 await 会让 fallback 询问挂死（PTY 实测 Ctrl+C 下顶层 await 以退出
  // 码 13 异常中止）。close 一律按取消，对齐 spec §6.2：Ctrl+C/Ctrl+D/EOF
  // 等价拒绝（按原退出码收束）。
  let answer
  try {
    answer = await Promise.race([
      rl.question(msg('safeAsk')(pendingExitCode)),
      new Promise((_, reject) => rl.once('close', () => reject(new Error('closed')))),
    ])
  } catch { cancelled = true }
  try { rl.close() } catch { /* 已关闭 */ }
  if (cancelled || answer === undefined) return false
  const a = answer.trim().toLowerCase()
  return a === '' || a === 'y' || a === 'yes'
}

const runSafeSession = async ({ pendingExitCode = 0, retryDsh, extraLines } = {}) => {
  const L = msg('safeMenuLabels')
  let exitCode = pendingExitCode
  const readline = (await import('node:readline/promises')).default
  const doctorLines = () => runDoctorChecks().lines
  // 询问态跨问句共享：cancelled 只由用户中断（SIGINT/EOF）置位。handingOff
  // 在重试交接期置位；当前流程有效选择返回时接口已关闭，SIGINT/close 两处
  // handingOff 守卫实际不可达，属防御性——防未来流程中接口存活跨入交接期
  // 时，主动交接被误记为用户取消。
  const state = { cancelled: false, handingOff: false }
  const printMenu = () => {
    console.log(msg('safeTitle')(runningInsideProfile ? 'profile' : 'launcher'))
    for (const l of extraLines ?? []) console.log(l)
    for (const l of doctorLines()) console.log(l)
    console.log(`  1) ${L.retry}`)
    console.log(`  2) ${L.doctor}`)
    console.log(`  3) ${L.inventory}`)
    console.log(`  4) ${L.guide}`)
    console.log(`  5) ${L.rescue}`)
    console.log(`  6) ${L.exit(exitCode)}`)
  }
  const askChoice = async () => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    rl.on('SIGINT', () => { if (!state.handingOff) { state.cancelled = true; rl.close() } })
    // readline/promises 的 question 在接口 close（EOF/Ctrl+D，或上方 SIGINT
    // 处理器主动 close）时 promise 永不结算（Node v24 实测）——裸 await 会
    // 挂死。与 close 事件竞速，close 一律按用户取消收束。
    let value
    try {
      value = await Promise.race([
        rl.question(L.prompt),
        new Promise((_, reject) => rl.once('close', () => reject(new Error('closed')))),
      ])
    } catch { state.cancelled = true }
    if (!state.cancelled && !state.handingOff) { try { rl.close() } catch { /* 已关闭 */ } }
    return { cancelled: state.cancelled || value === undefined, value: String(value ?? '').trim() }
  }
  // 重试结果结算（重放与冷启动两来源共用）：exit 0 → 返回 0 收束会话；
  // 非零 exit → 更新退出码、保留 profileExited 诊断回菜单；signal → 提示
  // 后回菜单；error → launchFailed 后回菜单。返回 null 表示回菜单，菜单内
  // 不自动重试（防死循环：询问只发生在外层首次非零退出）。
  const settleRetry = result => {
    if (result.kind === 'exit') {
      if (result.code === 0) return 0
      exitCode = result.code
      console.error(msg('profileExited')(result.code))
      return null
    }
    if (result.kind === 'signal') {
      console.error(msg('safeRetrySignaled')(result.signal))
      return null
    }
    console.error(msg('launchFailed')(result.error))
    return null
  }
  // 无效输入重提示上限 3 次，之后重印完整菜单继续等待；有效选择后计数重置。
  const INVALID_LIMIT = 3
  for (;;) {
    printMenu()
    let invalid = 0
    let choice = ''
    for (;;) {
      const { cancelled, value } = await askChoice()
      if (cancelled) { choice = '6'; break }
      if (['1', '2', '3', '4', '5', '6'].includes(value)) { choice = value; break }
      invalid++
      if (invalid >= INVALID_LIMIT) break
      console.log(L.invalid)
    }
    if (choice === '') continue // 达无效上限：重印菜单继续等待（计数随轮重置）
    if (choice === '1') {
      // 分支开头区分来源提示：replay = fallback 携带的首启规范化 args 重放；
      // cold start = 手动入口无已规范化 args，按空参数冷启动。
      const replay = typeof retryDsh === 'function'
      console.log(L.retry + (replay ? L.replaySource : L.coldStartSource))
      // 两来源共用 profileReady 前置（spec §4：重试不得隐式自举）。
      if (!profileReady()) { console.error(msg('safeListUnreadable')(msg('safeGuideLabels').notReadyReason)); continue }
      state.handingOff = true // 主动交接：此刻起的中断不算用户取消
      const settled = settleRetry(replay ? await retryDsh() : await startDshSession([]))
      state.handingOff = false
      if (settled !== null) return settled
      continue
    }
    if (choice === '2') { for (const l of doctorLines()) console.log(l); continue }
    if (choice === '3') { const lines = []; renderInventory(lines); for (const l of lines) console.log(l); continue }
    if (choice === '4') { const lines = []; renderGuide(lines); for (const l of lines) console.log(l); continue }
    if (choice === '5') {
      // 救援动作（最小可用）：先展示 doctor 诊断（决策依据），再创建/复用
      // 空白救援 profile 并干净启动。创建失败回菜单并指向诊断与指引；
      // 启动结果与重试同一结算语义（exit 0 结束会话，其余回菜单）。
      for (const l of doctorLines()) console.log(l)
      const created = createRescueProfile()
      if (created.kind === 'failed') { console.error(msg('safeRescueFailed')(created.detail)); continue }
      console.log(created.kind === 'exists' ? msg('safeRescueExists') : msg('safeRescueCreated'))
      state.handingOff = true
      const settled = settleRetry(await startDshSession([], RESCUE_PROFILE))
      state.handingOff = false
      if (settled !== null) return settled
      continue
    }
    return exitCode
  }
}

// 救援 profile 创建（最小可用的显式救援动作，spec §4 边界的第二个例外——
// 写操作只发生在全新目录）。已存在时绝不重复 add（固定名 add 不清旧内容，
// 见调研报告 1.2）；失败返回原因供菜单提示转看诊断与指引。
const createRescueProfile = () => {
  // 就绪判定与 bootstrapProfile 同源：安装判定文件在 node_modules 深处
  // （真实 dsh plugin add 与测试 stub 都落这里），不是 profile 根 manifest。
  const rescueInstalledPkg = join(dshHome, 'profiles', RESCUE_PROFILE, 'node_modules', '@deepseek-harness-tui', 'dsh-tui', 'package.json')
  if (readJson(rescueInstalledPkg) !== undefined) return { kind: 'exists' }
  const probe = spawnSync(...cmd('dsh', ['--version']), { stdio: 'pipe', ...shellOpt })
  if (probe.error || probe.status !== 0) return { kind: 'failed', detail: 'dsh missing' }
  console.log(msg('safeRescueCreating'))
  const runAdd = extraArgs => spawnSync(
    ...cmd('dsh', ['plugin', '--profile', RESCUE_PROFILE, 'add', ...extraArgs, `${PACKAGE}@${ownVersion}`]),
    { stdio: ['inherit', 'pipe', 'pipe'], ...shellOpt },
  )
  let add = runAdd([])
  if (add.status !== 0) {
    const captured = `${add.stdout ?? ''}${add.stderr ?? ''}`
    process.stderr.write(captured)
    if (captured.includes('ERR_PNPM_ADDING_TO_ROOT')) add = runAdd(['-w'])
  }
  if (add.status !== 0) return { kind: 'failed', detail: `exit ${add.status ?? 1}` }
  if (readJson(rescueInstalledPkg) === undefined) return { kind: 'failed', detail: 'no-op install' }
  return { kind: 'created' }
}

// 首次启动的结算：signal 自杀透传；error 打印 launchFailed 后接 fallback
// （TTY 询问进入安全模式，非 TTY 追加 safeHint）并以 1 收束；非零退出保留
// profileExited 诊断、接 fallback 后按保真退出码收束。
const settleFirstResult = async (result, firstArgs) => {
  if (result.kind === 'signal') {
    process.kill(process.pid, result.signal)
    return
  }
  if (result.kind === 'error') {
    console.error(msg('launchFailed')(result.error))
    if (isInteractive()) {
      if (await askSafeEntry(1)) process.exit(await runSafeSession({ pendingExitCode: 1, retryDsh: () => startDshSession(firstArgs) }))
    } else {
      console.error(msg('safeHint')(1))
    }
    process.exit(1)
    return
  }
  if (result.code !== 0) {
    console.error(msg('profileExited')(result.code))
    if (isInteractive()) {
      if (await askSafeEntry(result.code)) {
        process.exit(await runSafeSession({ pendingExitCode: result.code, retryDsh: () => startDshSession(firstArgs) }))
      }
    } else {
      console.error(msg('safeHint')(result.code))
    }
  }
  process.exit(result.code)
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

/** Installed version of the profile copy, or undefined when it is absent/unreadable. */
const profileVersion = () => {
  try {
    return JSON.parse(readFileSync(installedPkgPath, 'utf8')).version
  } catch {
    return undefined
  }
}

/**
 * Guard the launcher/profile version boundary. The two copies ship in the same
 * npm package but are installed independently (`npm i -g` vs `dsh plugin add`),
 * so one of them being upgraded alone is a normal state. It must be caught
 * here: dsh composes the launcher's patch surface with the profile's packages,
 * and a skew fails deep inside the dsh loader
 * (`ERR_PACKAGE_PATH_NOT_EXPORTED` on a subpath the older copy does not
 * export) instead of with a message the user can act on. Runs on the
 * delegation path as well as the in-profile path, because the delegated child
 * is itself the profile copy and can no longer see the outer launcher.
 * @param installedVersion - The profile copy's version.
 */
const checkProfileAlignment = installedVersion => {
  if (installedVersion === undefined || ownVersion === undefined || installedVersion === ownVersion) return
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
  if (isVersionNewer(installedVersion, ownVersion)) {
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

// ─── 子命令：safe（安全模式入口，两种角色同一段代码）──────────────────────────
// 零 lib 依赖、不委托、不自举（对齐 doctor 的依赖边界，而非 update 的
// profile-lib 路径）：profile 损坏时它必须仍可达。控制面只读；重试与
// 修复动作语义见 safe 会话实现（spec §4/§5）。
if (subcommand === 'safe') {
  const extra = process.argv.slice(3)
  const extraLines = extra.length > 0 ? [msg('safeIgnoredArgs')(extra.length)] : []
  if (!isInteractive()) {
    for (const line of renderSafeReport(extraLines)) console.log(line)
    process.exit(0)
  }
  process.exit(await runSafeSession({ pendingExitCode: 0, retryDsh: null, extraLines }))
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
  // Refuse to delegate into a profile from an older release line: the profile
  // copy would launch `dsh --profile dsh-tui` against a composition built from
  // this launcher's patch surface and fail inside the loader.
  checkProfileAlignment(profileVersion())
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
  // 版本错位诊断与瘦壳委托路径共用同一实现（见 checkProfileAlignment）。
  // `!runningInsideProfile` 只在 DSH_TUI_NO_DELEGATE=1 的调试口下成立，因此
  // 该判定不能只留在这里——委派出去的子进程就是 profile 副本，看不到外层
  // 启动器版本。
  if (!runningInsideProfile) checkProfileAlignment(installedVersion)

  // --resume / 工作区目标拦截（launcher 契约，见 src/sessionHistory.ts）。
  const setResumeEnv = sessionId => {
    process.env.DSH_TUI_RESUME_SESSION = sessionId
  }
  const readLastResumeTarget = () => {
    try {
      return readFileSync(join(homedir(), '.dsh-tui', 'resume.txt'), 'utf8').trim()
    } catch {
      // 没有历史会话可恢复——静默忽略，正常冷启动。
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

  // 启动：被委托场景下本副本自己的版本即对齐诊断所见的启动器代际。
  if (process.env.DSH_TUI_LAUNCHER_VERSION === undefined && ownVersion !== undefined) {
    process.env.DSH_TUI_LAUNCHER_VERSION = ownVersion
  }

  const firstArgs = args
  settleFirstResult(await startDshSession(firstArgs), firstArgs)
}
