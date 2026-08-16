#!/usr/bin/env node
/**
 * verify-launcher.mjs — bin/dsh-tui.js 直达启动器回归（issue #108）。
 *
 * PATH 上放一个逐参数记录 argv 的 dsh stub（外加空 pnpm stub），覆盖：
 *   - 参数原样透传给 `dsh --profile dsh-tui`（含空格参数不拆分）
 *   - 残骸 profile（目录在、package.json 不可读）触发重新自举，且版本号
 *     与本包对齐
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
// 的 profile 子进程失败，`dsh --version` 预检始终成功。
writeFileSync(join(stubDir, 'dsh'), '#!/bin/sh\nfor a in "$@"; do printf \'<%s>\' "$a"; done >> "$DSH_STUB_LOG"\nprintf \'\\n\' >> "$DSH_STUB_LOG"\nif [ "$1" = "--profile" ]; then exit "${DSH_STUB_EXIT:-0}"; fi\nexit 0\n')
writeFileSync(join(stubDir, 'pnpm'), '#!/bin/sh\nexit 0\n')
chmodSync(join(stubDir, 'dsh'), 0o755)
chmodSync(join(stubDir, 'pnpm'), 0o755)
// Windows：启动器经 shell:true 走 cmd，只认 .cmd/.bat，扩展名无关的 sh 脚本
// 不可见——需要 .cmd stub。日志格式与 sh stub 逐字节一致（角度编码 + 换行），
// 新言共用同一套断言。cmd 必须纯 ASCII + CRLF；node 由 runBin 的 PATH 提供。
if (isWin) {
  writeFileSync(
    join(stubDir, 'dsh.cmd'),
    '@echo off\r\nnode -e "const fs=require(\'fs\');const a=process.argv.slice(1);fs.appendFileSync(process.env.DSH_STUB_LOG,a.map(v=>\'<\'+v+\'>\').join(\'\')+\'\\n\');process.exit(a[0]===\'--profile\'?Number(process.env.DSH_STUB_EXIT||0):0)" -- %*\r\n@exit /b %errorlevel%\r\n',
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
}
function stubCalls() {
  return readFileSync(stubLog, 'utf8').trim().split('\n').filter(Boolean)
}

function runBin(args, extraEnv = {}) {
  return spawnSync(process.execPath, [bin, ...args], {
    env: {
      PATH: stubPath,
      HOME: tmp,
      DSH_HOME: home,
      DSH_STUB_LOG: stubLog,
      // 启动器 spawn(shell:true) 在 Windows 触 DEP0190 弃用警告，
      // 会污染「静默启动」类断言的 stderr——测试环境下关掉。
      NODE_OPTIONS: '--no-deprecation',
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

// --- 3. 前向错位（profile 更新）：打印提示但不阻塞启动（0.7.2 起降级可用）---
const [ownMajor, ownMinor] = ownVersion.split('-')[0].split('.').map(Number)
const newerProfile = `${ownMajor}.${ownMinor + 1}.0`
setProfileVersion(newerProfile)
resetStubLog()
r = runBin([])
check('mismatch: hint names both versions', r.stderr.includes(`v${newerProfile}`) && r.stderr.includes(`v${ownVersion}`))
check('mismatch: still launches', stubCalls().at(-1) === '<--profile><dsh-tui>' && r.status === 0)

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
