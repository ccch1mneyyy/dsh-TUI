#!/usr/bin/env node
/**
 * verify-launcher.mjs — bin/dsh-tui.js 直达启动器回归（issue #108）。
 *
 * PATH 上放一个逐参数记录 argv 的 dsh stub（外加空 pnpm stub），覆盖：
 *   - 参数原样透传给 `dsh --profile dsh-tui`（含空格参数不拆分）
 *   - 残骸 profile（目录在、package.json 不可读）触发重新自举，且版本号
 *     与本包对齐
 *   - profile 已装版本与启动器不一致时打印提示，但不阻塞启动
 *   - 面向用户的消息双语：CC_TUI_LANG=zh 输出中文，否则默认英文
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
mkdirSync(stubDir, { recursive: true })
// argv 逐参数 <angle> 编码，参数被拆分时一目了然；退出码恒 0。
writeFileSync(join(stubDir, 'dsh'), '#!/bin/sh\nfor a in "$@"; do printf \'<%s>\' "$a"; done >> "$DSH_STUB_LOG"\nprintf \'\\n\' >> "$DSH_STUB_LOG"\nexit 0\n')
writeFileSync(join(stubDir, 'pnpm'), '#!/bin/sh\nexit 0\n')
chmodSync(join(stubDir, 'dsh'), 0o755)
chmodSync(join(stubDir, 'pnpm'), 0o755)

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
      PATH: `${stubDir}:/usr/bin:/bin`,
      HOME: tmp,
      DSH_HOME: home,
      DSH_STUB_LOG: stubLog,
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

// --- 3. 版本不一致：打印提示但不阻塞启动 --------------------------------------
setProfileVersion('0.0.0')
resetStubLog()
r = runBin([])
check('mismatch: hint names both versions', r.stderr.includes('v0.0.0') && r.stderr.includes(`v${ownVersion}`))
check('mismatch: still launches', stubCalls().at(-1) === '<--profile><dsh-tui>' && r.status === 0)

// --- 4. 消息双语：缺 dsh 时的报错（契约同 TUI：CC_TUI_LANG 指定才生效，否则默认中文）-
const envNoDsh = { PATH: '/usr/bin:/bin' }
r = runBin([], { ...envNoDsh, CC_TUI_LANG: 'en' })
check('i18n: CC_TUI_LANG=en prints English', r.stderr.includes('dsh CLI not found'))
r = runBin([], { ...envNoDsh, CC_TUI_LANG: 'zh' })
check('i18n: CC_TUI_LANG=zh prints Chinese', r.stderr.includes('未检测到 dsh CLI'))
r = runBin([], envNoDsh)
check('i18n: default (unset) prints Chinese', r.stderr.includes('未检测到 dsh CLI'))

// --- 5. shellQuote 单元（win32 shell:true 路径的转义规则）---------------------
check('shellQuote: plain tokens pass through', shellQuote(['plugin', '--profile', 'dsh-tui']).join(' ') === 'plugin --profile dsh-tui')
check('shellQuote: spaces get quoted', shellQuote(['a b']).join(' ') === '"a b"')
check('shellQuote: embedded quotes are doubled', shellQuote(['a"b c']).join(' ') === '"a""b c"')

rmSync(tmp, { recursive: true, force: true })
if (failures > 0) {
  console.error(`${failures} check(s) failed`)
  process.exit(1)
}
console.log('all checks passed')
