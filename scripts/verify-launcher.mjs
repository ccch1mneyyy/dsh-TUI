#!/usr/bin/env node
/**
 * verify-launcher.mjs — bin/dsh-tui.js 直达启动器回归（issue #108）。
 *
 * PATH 上放一个逐参数记录 argv 的 dsh stub（外加空 pnpm stub），覆盖：
 *   - 参数原样透传给 `dsh --profile dsh-tui`（含空格参数不拆分）
 *   - 残骸 profile（目录在、package.json 不可读）触发重新自举，且版本号
 *     与本包对齐
 *   - ERR_PNPM_ADDING_TO_ROOT 签名在 stdout（issue #239 / PR #241 回归）：
 *     识别后带 -w 恰好重试一次；无签名失败不盲重试
 *   - no-op 假成功（add 成功但判定文件缺失）：fail loud 给出删 profile
 *     重建的恢复路径，而不是继续启动后 opaque 崩溃
 *   - profile 已装版本与启动器不一致时打印提示；前向错位（profile 更新）
 *     不阻塞启动（0.7.2 起 TUI 降级可用），反向错位（profile 更旧，issue
 *     #183）拒绝启动并给出对齐命令——dsh CLI 会从启动器拷贝读 bundle
 *     patch 套到 profile 旧包上，启动必然 opaque 崩溃
 *   - profile 子进程非零退出时保留退出码与直跑诊断命令
 *   - 面向用户的消息双语：DSH_TUI_LANG=zh 输出中文，否则默认英文
 *   - shellQuote 单元（win32 的 shell:true 路径 CI 跑不到 Windows，只能靠
 *     单测覆盖转义规则本身）
 *
 * 运行：pnpm build && node scripts/verify-launcher.mjs
 */
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { shellQuote } from '../lib/types/utils/shellQuote.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const bin = join(root, 'bin', 'dsh-tui.js')
const ownVersion = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version
const PROFILE = 'dsh-tui'
const PACKAGE = '@deepseek-harness-tui/dsh-tui'
const PKG_DIR = join('profiles', 'dsh-tui', 'node_modules', '@deepseek-harness-tui', 'dsh-tui')

let failures = 0
function check(name, ok) {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}`)
  if (!ok) failures++
}

// --- 测试环境：临时 DSH_HOME + 记录 argv 的 dsh stub ----------------------------
const tmp = mkdtempSync(join(tmpdir(), 'verify-launcher-'))
const home = join(tmp, 'home')
const stubDir = join(tmp, 'stub-bin')
const stubLog = join(tmp, 'stub.log')
const isWin = process.platform === 'win32'
mkdirSync(stubDir, { recursive: true })
// argv 逐参数 <angle> 编码，参数被拆分时一目了然；DSH_STUB_EXIT 只让真正
// 的 profile 子进程失败，`dsh --version` 预检始终成功。plugin add 可控：
// DSH_STUB_ADD_FAILS=N 让前 N 次 add 失败——DSH_STUB_ADD_SIG 写到 stdout、
// DSH_STUB_ADD_EXIT_CODE 定退出码（签名在 stdout 对齐 pnpm/dsh 真实转发
// 行为；PR #241 的回归正是把签名当成了 stderr，故必须断言 stdout 路径）；
// 成功路径模拟真实安装创建判定文件（DSH_STUB_PKG_VERSION），DSH_STUB_ADD_
// NOCREATE=1 模拟 no-op 假成功（pnpm 对残缺 profile 的 already-up-to-date
// 行为：报告成功、什么都不装）。
writeFileSync(join(stubDir, 'dsh'), '#!/bin/sh\nfor a in "$@"; do printf \'<%s>\' "$a"; done >> "$DSH_STUB_LOG"\nprintf \'\\n\' >> "$DSH_STUB_LOG"\nif [ "$1" = "plugin" ]; then\n  c="$DSH_STUB_LOG.count"\n  n=$(cat "$c" 2>/dev/null || echo 0); n=$((n+1)); echo "$n" > "$c"\n  if [ "$n" -le "${DSH_STUB_ADD_FAILS:-0}" ]; then\n    [ -n "$DSH_STUB_ADD_SIG" ] && printf \'%s\\n\' "$DSH_STUB_ADD_SIG"\n    exit "${DSH_STUB_ADD_EXIT_CODE:-1}"\n  fi\n  if [ -z "$DSH_STUB_ADD_NOCREATE" ]; then\n    d="$DSH_HOME/profiles/dsh-tui/node_modules/@deepseek-harness-tui/dsh-tui"\n    mkdir -p "$d" && printf \'{"version":"%s"}\' "${DSH_STUB_PKG_VERSION:-0.0.0-stub}" > "$d/package.json"\n  fi\n  exit 0\nfi\nif [ "$1" = "--profile" ]; then exit "${DSH_STUB_EXIT:-0}"; fi\nexit 0\n')
writeFileSync(join(stubDir, 'pnpm'), '#!/bin/sh\nexit 0\n')
chmodSync(join(stubDir, 'dsh'), 0o755)
chmodSync(join(stubDir, 'pnpm'), 0o755)
// Windows：启动器经 shell:true 走 cmd，只认 .cmd/.bat，扩展名无关的 sh 脚本
// 不可见——需要 .cmd stub。日志格式与 sh stub 逐字节一致（角度编码 + 换行），
// 新言共用同一套断言。cmd 必须纯 ASCII + CRLF；node 由 runBin 的 PATH 提供。
if (isWin) {
  writeFileSync(
    join(stubDir, 'dsh.cmd'),
    '@echo off\r\nnode -e "const fs=require(\'fs\');const a=process.argv.slice(1);fs.appendFileSync(process.env.DSH_STUB_LOG,a.map(v=>\'<\'+v+\'>\').join(\'\')+\'\\n\');if(a[0]===\'plugin\'){const c=process.env.DSH_STUB_LOG+\'.count\';let n=0;try{n=Number(fs.readFileSync(c,\'utf8\'))||0}catch(e){}n++;fs.writeFileSync(c,String(n));if(n<=Number(process.env.DSH_STUB_ADD_FAILS||0)){if(process.env.DSH_STUB_ADD_SIG)console.log(process.env.DSH_STUB_ADD_SIG);process.exit(Number(process.env.DSH_STUB_ADD_EXIT_CODE||1));}if(!process.env.DSH_STUB_ADD_NOCREATE){const d=process.env.DSH_HOME+\'/profiles/dsh-tui/node_modules/@deepseek-harness-tui/dsh-tui\';fs.mkdirSync(d,{recursive:true});fs.writeFileSync(d+\'/package.json\',JSON.stringify({version:process.env.DSH_STUB_PKG_VERSION||\'0.0.0-stub\'}));}process.exit(0);}process.exit(a[0]===\'--profile\'?Number(process.env.DSH_STUB_EXIT||0):0)" -- %*\r\n@exit /b %errorlevel%\r\n',
    'ascii',
  )
  writeFileSync(join(stubDir, 'pnpm.cmd'), '@echo off\r\n@exit /b 0\r\n', 'ascii')
}
// cmd.exe 需要 PATH 里的 node（stub 依赖）与 System32（shell 解释器）；
// PATH 分隔符平台不同。
const sep = isWin ? ';' : ':'
const winBasics = ['C:\\Windows\\System32', 'C:\\Windows']
const stubPath = [stubDir, ...(isWin ? [dirname(process.execPath), ...winBasics] : ['/usr/bin', '/bin'])].join(sep)
// 无 dsh 环境：绝不能含 node 目录——本机 node 与 dsh 同目录（D:\\node）时会把真 dsh 带进来。
// bin 自身经绝对路径 spawn，不需要 PATH 里的 node；仅需 cmd.exe（System32）。
const noDshPath = (isWin ? winBasics : ['/usr/bin', '/bin']).join(sep)

function setProfileVersion(version) {
  const dir = join(home, PKG_DIR)
  mkdirSync(dir, { recursive: true })
  if (version === undefined) rmSync(join(dir, 'package.json'), { force: true })
  else writeFileSync(join(dir, 'package.json'), JSON.stringify({ version }))
}

function resetStubLog() {
  writeFileSync(stubLog, '')
  rmSync(`${stubLog}.count`, { force: true })
}
function stubCalls() {
  return readFileSync(stubLog, 'utf8').trim().split('\n').filter(Boolean)
}

function runBin(args, extraEnv = {}, { delegating = false } = {}) {
  return spawnSync(process.execPath, [bin, ...args], {
    env: {
      PATH: stubPath,
      HOME: tmp,
      DSH_HOME: home,
      DSH_STUB_LOG: stubLog,
      // stub 安装创建的判定文件版本默认与启动器对齐——否则自举后的版本
      // 比较会以错位提示污染「静默启动」类断言。
      DSH_STUB_PKG_VERSION: ownVersion,
      // 启动器 spawn(shell:true) 在 Windows 触 DEP0190 弃用警告，
      // 会污染「静默启动」类断言的 stderr——测试环境下关掉。
      NODE_OPTIONS: '--no-deprecation',
      // 0.8.7 双态启动器：默认强制完整逻辑（本套回归覆盖的全量路径）；
      // 委托角色的专门用例按需放开（见第 4 节）。
      ...(delegating ? {} : { DSH_TUI_NO_DELEGATE: '1' }),
      ...extraEnv,
    },
    encoding: 'utf8',
  })
}

// --- 1. 残骸 profile 触发重新自举，版本号与本包对齐 ----------------------------
setProfileVersion(undefined) // 目录在、package.json 不可读
resetStubLog()
let r = runBin([])
check('bootstrap: broken profile triggers reinstall', stubCalls().some(c => c.includes('<plugin>') && c.includes('<add>')))
check('bootstrap: pinned to the launcher version', stubCalls().some(c => c.includes(`<@deepseek-harness-tui/dsh-tui@${ownVersion}>`)))
check('bootstrap: launches after reinstall', stubCalls().at(-1) === '<--profile><dsh-tui>')
check('bootstrap: exits 0', r.status === 0)

// --- 1.5 ERR_PNPM_ADDING_TO_ROOT 签名在 stdout（issue #239 / PR #241 回归）：
// 签名经 dsh 的 stdout 转发（pnpm 错误报告写 stdout），#241 只查 stderr 导致
// 识别永不触发、全新自举仍必败——识别必须覆盖捕获的 stdout，重试后安装成功。
setProfileVersion(undefined)
resetStubLog()
r = runBin([], {
  DSH_STUB_ADD_FAILS: '1',
  DSH_STUB_ADD_SIG: 'ERR_PNPM_ADDING_TO_ROOT Running this command will add the dependency to the workspace root',
  DSH_TUI_LANG: 'en',
})
const addCalls = () => stubCalls().filter(c => c.includes('<plugin>') && c.includes('<add>'))
const launchCalls = () => stubCalls().filter(c => c.startsWith('<--profile>'))
check('root-refusal: retries exactly once with -w', addCalls().length === 2 && addCalls()[1].includes('<-w>'))
check('root-refusal: retry notice printed', r.stdout.includes('retrying with -w'))
check('root-refusal: captured refusal replayed to the user', r.stderr.includes('ERR_PNPM_ADDING_TO_ROOT'))
check('root-refusal: launches after the retry', stubCalls().at(-1) === '<--profile><dsh-tui>' && r.status === 0)

// --- 1.6 无签名的失败：不盲目 -w 重试，按普通安装失败处理 -------------
setProfileVersion(undefined)
resetStubLog()
r = runBin([], { DSH_STUB_ADD_FAILS: '9', DSH_STUB_ADD_EXIT_CODE: '3', DSH_TUI_LANG: 'en' })
check('other failure: no -w retry without the signature', addCalls().length === 1 && !addCalls()[0].includes('<-w>'))
check('other failure: manual hint kept', r.stderr.includes('Retry manually'))
check('other failure: exit code preserved', r.status === 3)

// --- 1.7 no-op 假成功（自举后复查）：add 报告成功但判定文件依旧缺失——
// pnpm 把包文件残缺的 profile 视为 already up to date，重试永远「成功」而
// 启动必崩（cannot resolve profile bundle），且崩溃提示的 plugin install
// 同样 no-op。fail loud 给出删 profile 重建的恢复路径，而不是继续启动。
setProfileVersion(undefined)
resetStubLog()
r = runBin([], { DSH_STUB_ADD_NOCREATE: '1', DSH_TUI_LANG: 'en' })
check('no-op install: fails loud instead of launching', r.status === 1 && launchCalls().length === 0)
check('no-op install: names the unreadable package', r.stderr.includes('still unreadable'))
check('no-op install: gives the rm -rf recovery', r.stderr.includes('rm -rf'))
r = runBin([], { DSH_STUB_ADD_NOCREATE: '1', DSH_TUI_LANG: 'zh' })
check('no-op install: Chinese message', r.stderr.includes('仍不可读'))

// --- 2. 版本一致：参数原样透传，无提示 ----------------------------------------
setProfileVersion(ownVersion)
resetStubLog()
r = runBin(['foo', 'a b'])
check('passthrough: args forwarded after --profile', stubCalls().at(-1) === '<--profile><dsh-tui><foo><a b>')
check('passthrough: silent when aligned', r.stderr.trim() === '')

// --- 2.5 profile 非零退出：保留退出码与可直接复现的命令（须在版本对齐时测，
// 错位提示/拒绝会干扰退出码与 stderr 断言）-------------------------------------
resetStubLog()
r = runBin([], { DSH_STUB_EXIT: '42', DSH_TUI_LANG: 'en' })
check('nonzero exit: launcher preserves the child status', r.status === 42)
check('nonzero exit: stderr names the status', r.stderr.includes('profile exited with code 42'))
check('nonzero exit: stderr gives the direct command', r.stderr.includes('dsh --profile dsh-tui'))
r = runBin([], { DSH_STUB_EXIT: '42', DSH_TUI_LANG: 'zh' })
check('nonzero exit: Chinese message names the status', r.stderr.includes('退出码 42'))

// --- 3. 前向错位（profile 更新）：必须指向「更新全局 Launcher」------------
// 0.8.3 起修复方向按版本方向区分：profile 比 Launcher 新时再让用户跑
// /update 会得到 "Already up to date" 循环——必须给精确的全局升级命令。
const [ownMajor, ownMinor] = ownVersion.split('-')[0].split('.').map(Number)
const newerProfile = `${ownMajor}.${ownMinor + 1}.0`
setProfileVersion(newerProfile)
resetStubLog()
r = runBin([])
check('forward skew: hint names both versions', r.stderr.includes(`v${newerProfile}`) && r.stderr.includes(`v${ownVersion}`))
check(
  'forward skew: tells user to align the global launcher',
  r.stderr.includes(`npm install -g --legacy-peer-deps ${PACKAGE}@${newerProfile}`),
)
check(
  'forward skew: never tells user to update the profile again',
  !r.stderr.includes('/update') && !r.stderr.includes(`plugin --profile ${PROFILE}`),
)
check('forward skew: still launches', stubCalls().at(-1) === '<--profile><dsh-tui>' && r.status === 0)

// --- 3.5 反向错位（profile 更旧，issue #183）：拒绝启动并给出对齐命令 --------
// dsh CLI 的 bundle patch 取自启动器拷贝、插件模块取自 profile 拷贝；启动器
// 次版本更新时 patch 可能引用旧包没有的子路径导出，启动必然 opaque 崩溃——
// 启动器必须先于 dsh 拦截。
setProfileVersion('0.0.0')
resetStubLog()
r = runBin([])
check('reverse skew: refuses to launch', r.status === 1 && !stubCalls().some(c => c.includes('<--profile>')))
check('reverse skew: names both versions', r.stderr.includes('v0.0.0') && r.stderr.includes(`v${ownVersion}`))
check('reverse skew: prints the align command', r.stderr.includes(`add @deepseek-harness-tui/dsh-tui@${ownVersion}`))
r = runBin([], { DSH_TUI_LANG: 'en' })
check('reverse skew: English message', r.stderr.includes('cannot start'))

// --- 3.6 同 minor 反向 patch-skew（0.8.2 Launcher / 0.8.1 Profile）---------
// 非致命：允许启动，但应把 profile 对齐到启动器。构造"同 core、较旧"的
// semver：稳定发布 x.y.z 用 x.y.z-0（prerelease 一定更旧且 major/minor
// 相同）；ownVersion 自身是 prerelease（x.y.z-beta.1）时把末段数字减一
// （beta.1 → beta.0）。末段已是 0 时不存在更旧的同 core prerelease，
// 该组断言退化为恒真（skip）。
const olderSameMinorProfile = ownVersion.includes('-')
  ? ownVersion.replace(/\.(\d+)$/, (_, n) => (Number(n) > 0 ? `.${Number(n) - 1}` : `.${n}`))
  : `${ownVersion}-0`
const patchSkewOlderExists = olderSameMinorProfile !== ownVersion
setProfileVersion(olderSameMinorProfile)
resetStubLog()
r = runBin([])
check(
  'patch skew: older profile still launches',
  stubCalls().at(-1) === '<--profile><dsh-tui>' && r.status === 0,
)
check(
  'patch skew: tells user to align the profile to the launcher',
  !patchSkewOlderExists || r.stderr.includes(`dsh plugin --profile ${PROFILE} add ${PACKAGE}@${ownVersion}`),
)
check(
  'patch skew: does not tell user to update the global launcher',
  !patchSkewOlderExists || !r.stderr.includes('npm install -g'),
)

// --- 3.7 Launcher→runtime 契约：子进程必须收到 DSH_TUI_LAUNCHER_VERSION ---
// 让 /update 能诊断「全局 Launcher 是否落后于刚装的 profile」。先做源码
// 静态断言，更强的 e2e（stub 记录子进程 env）后续再补。
const launcherSource = readFileSync(bin, 'utf8')
check(
  'launcher env: child receives DSH_TUI_LAUNCHER_VERSION',
  launcherSource.includes('process.env.DSH_TUI_LAUNCHER_VERSION = ownVersion'),
)

// --- 4. 委托角色（0.8.7 双态启动器）：全局副本 → profile 内副本 -------------
// 真实 bin + 假 DSH_HOME：repo 目录与假 profile 不是同一物理目录 → 走瘦壳
// 角色。把真实 bin 预放进假 profile（模拟一次完成的安装），验证：
//   - 委托后由 profile 内副本执行完整逻辑（argv 原样两跳转发）
//   - 判定文件缺失（残骸 profile）时瘦壳先自举再委托
//   - profile 有判定文件但没有 bin 时 fail loud 给重装指引
const placeProfileBin = () => {
  const dir = join(home, PKG_DIR, 'bin')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'dsh-tui.js'), readFileSync(bin, 'utf8'))
}

setProfileVersion(ownVersion)
placeProfileBin()
resetStubLog()
r = runBin(['foo', 'a b'], {}, { delegating: true })
check('shim: delegates argv through to the profile copy', stubCalls().at(-1) === '<--profile><dsh-tui><foo><a b>')
check('shim: silent + exit 0 when aligned', r.status === 0 && r.stderr.trim() === '')

setProfileVersion(undefined)
placeProfileBin() // add stub 只创建 package.json——bin 是预放好的“已安装”产物
resetStubLog()
r = runBin([], {}, { delegating: true })
check(
  'shim: bootstraps a broken profile before delegating',
  stubCalls().some(c => c.includes('<plugin>') && c.includes('<add>'))
    && stubCalls().at(-1) === '<--profile><dsh-tui>'
    && r.status === 0,
)

// 判定文件在、bin 缺失：委托目标不可读——给出全局重装指引而非 opaque 崩溃。
setProfileVersion(ownVersion)
rmSync(join(home, PKG_DIR, 'bin'), { recursive: true, force: true })
resetStubLog()
r = runBin([], { DSH_TUI_LANG: 'en' }, { delegating: true })
check('shim: no bin fails loud with the reinstall hint', r.status === 1 && r.stderr.includes(`Reinstall the global launcher`))
check('shim: reinstall hint names the npm command', r.stderr.includes(`npm install -g --legacy-peer-deps ${PACKAGE}`))


// --- 5. 消息双语：缺 dsh 时的报错（契约同 TUI：DSH_TUI_LANG 指定才生效，否则默认中文）
const envNoDsh = { PATH: noDshPath }
r = runBin([], { ...envNoDsh, DSH_TUI_LANG: 'en' })
check('i18n: DSH_TUI_LANG=en prints English', r.stderr.includes('dsh CLI not found'))
r = runBin([], { ...envNoDsh, DSH_TUI_LANG: 'zh' })
check('i18n: DSH_TUI_LANG=zh prints Chinese', r.stderr.includes('未检测到 dsh CLI'))
r = runBin([], envNoDsh)
check('i18n: default (unset) prints Chinese', r.stderr.includes('未检测到 dsh CLI'))

// --- 6. shellQuote 单元（win32 shell:true 路径的转义规则）---------------------
check('shellQuote: plain tokens pass through', shellQuote(['plugin', '--profile', 'dsh-tui']).join(' ') === 'plugin --profile dsh-tui')
check('shellQuote: spaces get quoted', shellQuote(['a b']).join(' ') === '"a b"')
check('shellQuote: embedded quotes are doubled', shellQuote(['a"b c']).join(' ') === '"a""b c"')

rmSync(tmp, { recursive: true, force: true })
if (failures > 0) {
  console.error(`${failures} check(s) failed`)
  process.exit(1)
}
console.log('all checks passed')
