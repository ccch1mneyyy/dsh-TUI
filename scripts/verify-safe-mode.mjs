#!/usr/bin/env node
/**
 * verify-safe-mode.mjs — 安全模式（PR①）回归。
 *
 * 覆盖：
 *   - safe 子命令零环境可用与非 TTY 降级（不触发自举/委托）；
 *   - 控制面只读：DSH_HOME 与 HOME **双**快照、逐文件 sha256（同尺寸原地改写
 *     也算改动——只比 size 会漏），且 dsh 探测**真的在跑**（PATH 上有 stub，
 *     断言探测结果被回显），不是「PATH 空目录所以探测必然 ENOENT」；
 *   - profile 插件清单解析矩阵；分类断言（内置/第三方）限定在「直接依赖」
 *     自己的区段里——bundles 区段的同名串不能顶替（旧版用它假通过）；
 *   - fallback 触发矩阵（非 TTY）；
 *   - 救援动作的非交互入口 `safe --rescue`：干净性门禁（home 层补丁存在 /
 *     目录无法识别 / 既有 profile 含第三方插件 → 一律拒绝且一个字节都不写）、
 *     创建、已存在则复用、半装清理、no-op 假成功清理、ERR_PNPM_ADDING_TO_ROOT
 *     的 -w 重试、以及救援环境的显式构造（宿主会话控制变量被剥离）；
 *   - doctor 提取的行为等价（完整期望值，仅规范化临时路径）。
 *
 * 平台：**全平台可跑**。stub dsh 按平台写成 POSIX sh 或 Windows 批处理
 * （dsh.cmd）——旧版在 win32 上整包 `exit 0`（组计绿），而 required CI 只在
 * ubuntu 跑，等于这项门禁在 Windows 上根本不存在。只有「信号透传」一项是
 * POSIX-only：在 Windows 上打印显式 SKIP 行并计入结尾的 SKIPPED 汇总，
 * 不再用整包 skip 冒充通过。
 *
 * 未覆盖（本套件不假装覆盖）：readline 菜单本身的按键交互、fallback 的 TTY
 * 询问、以及救援**启动**后的会话——它们需要真实 PTY；仓库的 PTY 探针
 * （scripts/pty-conpty-probe.mjs）依赖 node-pty，node-pty 不是本仓库依赖。
 * 菜单选项 5 与 `safe --rescue` 共用 createRescueProfile/runRescue，因此
 * 门禁与创建逻辑由本套件覆盖，未覆盖的只剩菜单外壳。
 *
 * 运行：node scripts/verify-safe-mode.mjs（不依赖 lib/ 构建产物）
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const bin = join(root, 'bin', 'dsh-tui.js')
const ownVersion = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version
const PACKAGE = '@deepseek-harness-tui/dsh-tui'
const isWin = process.platform === 'win32'

let failures = 0
function check(name, ok, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failures++
}
let skips = 0
function skip(name, reason) {
  console.log(`SKIP: ${name}  (${reason})`)
  skips++
}

const tmp = mkdtempSync(join(tmpdir(), 'verify-safe-'))
const emptyHome = join(tmp, 'dsh-home')
mkdirSync(emptyHome, { recursive: true })
const fakeUserHome = join(tmp, 'user-home')
mkdirSync(fakeUserHome, { recursive: true })
const noBin = join(tmp, 'no-bin')
mkdirSync(noBin, { recursive: true })

// 子进程环境：沙箱外的键一个不带（尤其是宿主可能残留的 DSH_TUI_*），但
// Windows 上 cmd.exe 自身要靠 ComSpec/SystemRoot 才能起来——PATH 被换成
// stub 目录后「找 cmd.exe」这一步不能靠 PATH。
const baseEnv = env => {
  const base = { PATH: noBin, DSH_HOME: emptyHome, HOME: fakeUserHome, USERPROFILE: fakeUserHome, DSH_TUI_LANG: 'zh' }
  if (isWin) {
    for (const key of ['ComSpec', 'SystemRoot', 'windir']) if (process.env[key] !== undefined) base[key] = process.env[key]
    base.PATHEXT = process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD'
  }
  for (const [key, value] of Object.entries(env)) if (value !== undefined) base[key] = value
  return base
}
const run = (args, env = {}) =>
  spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8', env: baseEnv(env) })

// --- stub dsh（一份逻辑，两种外壳）--------------------------------------------
// 一个 stub 承担三种调用，覆盖启动器真正发出的命令形状：
//   dsh --version                      → 版本探测（回显可被断言 → 证明真的跑了）
//   dsh --profile <name> [...]         → 会话启动（退出码由 DSH_STUB_PROFILE_EXIT 控制）
//   dsh plugin --profile <n> add ...   → 安装（可选真的「装出」插件包与根 manifest）
// 每次调用把 argv 与「救援控制变量是否被剥离」记录到 state 目录，供断言取证。
// stub 的「安装」模拟真实 `dsh plugin add` 的两个落点：profile 根 package.json
// 与 node_modules 深处的插件包——启动器的就绪判定与救援干净性门禁分别读这两处。
//
// 逻辑只有一份（Node 模块），外壳按平台分两种：POSIX 用 sh 转发，Windows 用
// 批处理转发。两者都用**绝对路径**调 node（POSIX 用 sh 内建的 exec，Windows 直接
// 引号调用），因此 stub 不需要 PATH 上有任何东西——PATH 必须保持「只有 stub
// 目录」才能保证沙箱里看不到宿主真的 dsh，而 sh/批处理里那些 coreutils
// （cat/mkdir/cp）恰恰不在里面。第一版把逻辑写在 sh/批处理里就踩了这个坑：
// Windows 绿、Linux/macOS 红。
//
// 替身必须**真的造出半成品**（半装与 no-op 两种模式都写盘），否则「清理」类
// 断言会因为 `!existsSync(...)` 恒真而空转（变异测试实证：删掉实现的 rmSync，
// 套件照样全绿——那是假通过）。
const STUB_MODULE = `import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const state = process.env.DSH_STUB_STATE
const argv = process.argv.slice(2)
const read = name => (existsSync(join(state, name)) ? readFileSync(join(state, name), 'utf8').trim() : '')
const bump = name => {
  const next = Number(read(name) || 0) + 1
  writeFileSync(join(state, name), String(next))
  return next
}
const place = (from, to) => {
  if (existsSync(from)) copyFileSync(from, to)
}
bump('calls')
appendFileSync(join(state, 'argv'), argv.join(' ') + '\\n')
// 被剥离的会话控制变量**两个都**记，且记在同一行：argv 与 env 两个文件是按行
// 号一一配对的（见 stubCalls），一个调用占两行会让后面每次配对整体错位。
appendFileSync(join(state, 'env'), 'resume=' + (process.env.DSH_TUI_RESUME_SESSION ?? 'none') + ' workspace=' + (process.env.DSH_TUI_WORKSPACE_TARGET ?? 'none') + '\\n')

const [command] = argv
if (command === '--version') {
  process.stdout.write((process.env.DSH_STUB_VERSION ?? '9.9.9') + '\\n')
  process.exit(Number(process.env.DSH_STUB_PROBE_EXIT ?? 0))
}
if (command === '--profile') {
  const signal = process.env.DSH_STUB_PROFILE_SIGNAL
  if (signal !== undefined && signal !== '') {
    process.kill(process.pid, signal)
    // 信号默认处置会立刻终止本进程；万一没有，限时退出让断言明确失败而不是挂住。
    setTimeout(() => process.exit(0), 200)
    await new Promise(() => {})
  }
  process.exit(Number(process.env.DSH_STUB_PROFILE_EXIT ?? 0))
}
if (command === 'plugin') {
  const adds = bump('adds')
  if (process.env.DSH_STUB_ADDING_TO_ROOT && adds === 1) {
    process.stderr.write('ERR_PNPM_ADDING_TO_ROOT stub\\n')
    process.exit(1)
  }
  if (process.env.DSH_STUB_PLUGIN_EXIT) process.exit(Number(process.env.DSH_STUB_PLUGIN_EXIT))
  const root = join(process.env.DSH_HOME, 'profiles', 'dsh-tui-safe')
  // pnpm 的「已是最新」：profile 根 manifest 已经在了就地不再装（issue #209 /
  // bootstrapUnreadable 记录的正是这个失败模式）。没有这条，半装清理的断言
  // 就杀不掉「删掉实现」的变异。
  if (existsSync(join(root, 'package.json'))) process.exit(0)
  mkdirSync(join(root, 'node_modules'), { recursive: true })
  place(join(state, 'manifest.json'), join(root, 'package.json'))
  place(join(state, 'cordis.patch.yml'), join(root, 'cordis.patch.yml'))
  place(join(state, 'pnpm-workspace.yaml'), join(root, 'pnpm-workspace.yaml'))
  if (process.env.DSH_STUB_NOOP) process.exit(0)
  const pkgDir = join(root, 'node_modules', '@deepseek-harness-tui', 'dsh-tui')
  mkdirSync(pkgDir, { recursive: true })
  writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: '@deepseek-harness-tui/dsh-tui', version: 'stub' }))
  process.exit(0)
}
process.exit(0)
`
// 外壳只做转发，两个平台都不依赖 PATH：POSIX 用 sh 内建 exec，Windows 直接
// 引号调用（批处理里不要用嵌套括号块——`exit /b` 落在嵌套块里退出码会被吞）。
const shellFor = modulePath =>
  isWin
    ? ['@echo off', `"${process.execPath}" "${modulePath}" %*`, 'exit /b %ERRORLEVEL%', ''].join('\r\n')
    : ['#!/bin/sh', `exec "${process.execPath}" "${modulePath}" "$@"`, ''].join('\n')

// 真实 `dsh plugin add` 在全新 profile 里生成的两个配置文件（本机实测原文，
// 2026-09-21 抓取）——替身按同样内容落盘，救援的复用路径才是真实形态的回归
// 夹具：救援门禁必须放过 dsh 自己的默认文件。
const REAL_PATCH_LAYER = [
  '# Your patch layer for this dsh profile, applied after every bundle layer:',
  '# a top-level YAML array of loader patch entries (id-targeted config',
  '# overrides, disables, and insert lists; `!!js` expressions allowed).',
  '[]',
  '',
].join('\n')
const REAL_WORKSPACE = ['packages:', '  - .', '', 'nodeLinker: hoisted', 'autoInstallPeers: false', ''].join('\n')

let stubSeq = 0
const makeStub = () => {
  const dir = join(tmp, `stub-${stubSeq}`)
  const state = join(tmp, `stub-state-${stubSeq}`)
  stubSeq++
  mkdirSync(dir, { recursive: true })
  mkdirSync(state, { recursive: true })
  const module = join(dir, 'stub.mjs')
  writeFileSync(module, STUB_MODULE)
  const file = join(dir, isWin ? 'dsh.cmd' : 'dsh')
  writeFileSync(file, shellFor(module))
  // stub「安装」时落到 profile 里的那几份内容（真实 dsh 也这么写）。
  writeFileSync(join(state, 'manifest.json'), JSON.stringify(cleanManifest))
  writeFileSync(join(state, 'cordis.patch.yml'), REAL_PATCH_LAYER)
  writeFileSync(join(state, 'pnpm-workspace.yaml'), REAL_WORKSPACE)
  if (!isWin) chmodSync(file, 0o755)
  return { dir, state }
}
// stub 的调用记录：argv 与 env 两个文件逐行同序，按下标配对。
const stubCalls = state => {
  const read = name => {
    try {
      return readFileSync(join(state, name), 'utf8').split('\n').map(l => l.trim()).filter(l => l !== '')
    } catch {
      return []
    }
  }
  const argv = read('argv')
  const env = read('env')
  return argv.map((line, i) => ({ argv: line, env: env[i] ?? '' }))
}
const pluginCalls = state => stubCalls(state).filter(c => c.argv.startsWith('plugin '))

// 递归快照：路径 → 类型 + 内容摘要。只读断言的证据来源；比 size 强——
// 同尺寸的原地改写会被 sha256 抓到。
const snapshot = dir => {
  const out = {}
  const walk = (d, prefix) => {
    const entries = readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const e of entries) {
      const p = join(d, e.name)
      const key = prefix + e.name
      if (e.isDirectory()) { out[key] = 'dir'; walk(p, `${key}/`) }
      else if (e.isSymbolicLink()) out[key] = 'link'
      else out[key] = `file:${statSync(p).size}:${createHash('sha256').update(readFileSync(p)).digest('hex')}`
    }
  }
  walk(dir, '')
  return out
}
const sameSnapshot = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const diffOf = (a, b) => [...new Set([...Object.keys(a), ...Object.keys(b)])].filter(k => a[k] !== b[k])
// 断言里的读取一律走它：文件缺失/读不到要变成 FAIL，而不是把套件从「列 FAIL
// 继续跑」变成「ENOENT 栈中途中止」——复测在 M6 变异下实证过：第 3 条断言抛栈
// 之后，后面约 34 条断言根本没跑。
const readTextOr = path => {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
}

// 取 stdout 里某个区段（排除另一区段的同名串）——分类断言必须落在自己的区段。
const section = (text, start, end) => {
  const from = text.indexOf(start)
  if (from === -1) return ''
  const rest = text.slice(from + start.length)
  const to = rest.indexOf(end)
  return to === -1 ? rest : rest.slice(0, to)
}

// 结论行 = stdout 最后一条非空行。非交互救援的结论文案必须钉在这一行上：
// 整段 stdout 里 renderGuide 早就打过 `dsh --profile dsh-tui-safe`，拿整段
// includes 比「有没有给出启动命令」会被指引区段顶替（假通过）。
const lastLine = text => text.split('\n').map(l => l.trim()).filter(l => l !== '').pop() ?? ''

// 在指定 home 下预置救援 profile 的脚手架。
const rescueDirOf = home => join(home, 'profiles', 'dsh-tui-safe')
const rescuePkgOf = home => join(rescueDirOf(home), 'node_modules', '@deepseek-harness-tui', 'dsh-tui', 'package.json')
const writeRescueManifest = (home, manifest) => {
  mkdirSync(rescueDirOf(home), { recursive: true })
  writeFileSync(join(rescueDirOf(home), 'package.json'), JSON.stringify(manifest))
}
const cleanManifest = {
  name: 'dsh-profile-dsh-tui-safe',
  private: true,
  dependencies: { [PACKAGE]: ownVersion },
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', PACKAGE], patchReload: 'live' } },
}

// --- doctor 提取等价：完整期望值（仅 doctor 行，空 profile 场景）--------------
{
  const r = run(['doctor'])
  const expected = [
    `dsh-tui doctor · @deepseek-harness-tui/dsh-tui ${ownVersion}`,
    `✓ node: ${process.version} · ${process.platform} ${process.arch}`,
    `✗ dsh: 未找到——请先安装：  npm install -g @deepseek-ai/dsh`,
    `✗ pnpm: 未找到——安装/升级需要它：  npm install -g pnpm`,
    `✗ profile: 未安装——运行一次 \`dsh-tui\` 即可自举  (${join(emptyHome, 'profiles', 'dsh-tui')})`,
    `✗ DEEPSEEK_API_KEY: 未设置——环境变量与 DSH 凭据库中都没有 DEEPSEEK_API_KEY`,
    `✗ config: ${join(fakeUserHome, '.dsh-tui', 'cordis.yml')}  缺失`,
    `✗ config: ${join(emptyHome, 'profiles', 'dsh-tui', 'cordis.patch.yml')}  缺失`,
  ]
  const actual = r.stdout.split('\n').filter(l => l !== '')
  check(
    'doctor 输出逐行等于期望值（提取前 golden，之后任何任务不得漂移）',
    r.status === 1 && actual.length === expected.length && expected.every((l, i) => l === actual[i]),
    `lines=${actual.length}`,
  )
}

// --- fallback 触发矩阵（非 TTY：spawnSync 默认管道，stdin 非 TTY）--------------
{
  const stub = makeStub()
  // profile 已装且与启动器同版：版本核对不产生额外输出，stderr 断言干净。
  const profHome = join(tmp, 'fb-home')
  const pkgDir = join(profHome, 'profiles', 'dsh-tui', 'node_modules', '@deepseek-harness-tui', 'dsh-tui')
  mkdirSync(pkgDir, { recursive: true })
  writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: PACKAGE, version: ownVersion }))
  const runFb = (env = {}) => run([], { PATH: stub.dir, DSH_STUB_STATE: stub.state, DSH_HOME: profHome, DSH_TUI_NO_DELEGATE: '1', ...env })
  {
    const r = runFb()
    // 判「有没有 safe 提示」必须断真正的提示串：沙箱临时目录叫 verify-safe-*，
    // 用 includes('safe') 会把任何带路径的子进程噪声当成提示（假敏感）。
    check('fallback: exit 0 无提示', r.status === 0 && !r.stderr.includes('dsh-tui safe'), `status=${r.status}`)
  }
  {
    const r = runFb({ DSH_STUB_PROFILE_EXIT: '42' })
    check(
      'fallback: exit 42 → 保留 profileExited 诊断 + 追加 safeHint + 退出码保真',
      r.status === 42 && r.stderr.includes('退出码 42') && r.stderr.includes('dsh-tui safe') && r.stderr.indexOf('已退出') < r.stderr.indexOf('safe'),
      `status=${r.status}`,
    )
  }
  {
    const r = runFb({ DSH_STUB_PROFILE_EXIT: '42', DSH_TUI_LANG: 'en' })
    check('fallback: safeHint 双语', r.stderr.includes('Run dsh-tui safe'), `status=${r.status}`)
  }
  if (isWin) {
    skip('fallback: 信号透传且无 safe 提示', 'Windows has no POSIX signal semantics (Node turns kill into TerminateProcess, so spawnSync reports a code, never a signal)')
  } else {
    // 信号场景：替身自杀 SIGINT → 启动器 self-kill 透传，无提示。
    // 信号名必须是 'SIGINT'：Node 的 process.kill 不做前缀补全，裸 'INT' 直接
    // 抛 ERR_UNKNOWN_SIGNAL（实测）。
    const r = runFb({ DSH_STUB_PROFILE_SIGNAL: 'SIGINT' })
    check('fallback: 信号透传且无 safe 提示', r.status === null && r.signal === 'SIGINT' && !r.stderr.includes('dsh-tui safe'), `signal=${r.signal}`)
  }
}

// --- safe 手动入口：零环境 + 非 TTY 降级 + 控制面只读 --------------------------
{
  const freshHome = join(tmp, 'safe-home')
  mkdirSync(freshHome, { recursive: true })
  const before = snapshot(freshHome)
  const beforeHome = snapshot(fakeUserHome)
  const r = run(['safe'], { DSH_HOME: freshHome })
  const after = snapshot(freshHome)
  const afterHome = snapshot(fakeUserHome)
  check('safe: 零环境非 TTY 退出 0', r.status === 0, `status=${r.status}`)
  check('safe: 打印标题', r.stdout.includes('安全模式'))
  check('safe: 内嵌 doctor 诊断', r.stdout.includes('✗ dsh'))
  check('safe: 打印修复指引', r.stdout.includes('dsh plugin --profile dsh-tui'))
  check('safe: 清单不可读降级（空 profile）', r.stdout.includes('清单不可读'))
  check('safe: 控制面只读（DSH_HOME 逐文件 sha256 不变）', sameSnapshot(before, after), diffOf(before, after).join(','))
  check('safe: 控制面只读（HOME 逐文件 sha256 不变）', sameSnapshot(beforeHome, afterHome), diffOf(beforeHome, afterHome).join(','))
}
{
  // 探测真的执行：PATH 上有 stub，doctor 必须回显 stub 的版本号——旧版把
  // PATH 指向空目录，`dsh --version` 必然 ENOENT，「探测」这一支从未跑过。
  const stub = makeStub()
  const freshHome = join(tmp, 'probe-home')
  mkdirSync(freshHome, { recursive: true })
  const before = snapshot(freshHome)
  const r = run(['safe'], { PATH: stub.dir, DSH_STUB_STATE: stub.state, DSH_HOME: freshHome })
  const after = snapshot(freshHome)
  check(
    'safe: dsh 探测真的执行（stub 版本被回显）',
    r.status === 0 && r.stdout.includes('✓ dsh: 9.9.9'),
    r.stdout.split('\n').find(l => l.includes(' dsh:')) ?? 'no dsh line',
  )
  check('safe: 探测真的跑过但没有写入（只读）', sameSnapshot(before, after) && stubCalls(stub.state).some(c => c.argv === '--version'), diffOf(before, after).join(','))
}
{
  const r = run(['safe', 'extra1', 'extra2'], { DSH_HOME: join(tmp, 'safe-home') })
  check('safe: 附加参数提示忽略', r.stdout.includes('已忽略附加参数：2 个'), `status=${r.status}`)
}
{
  const r = run(['safe', '--rescue', 'extra1'], { DSH_HOME: join(tmp, 'safe-home') })
  check('safe: --rescue 之外的附加参数仍提示忽略', r.stdout.includes('已忽略附加参数：1 个'), `status=${r.status}`)
}
{
  const r = run(['safe'], { DSH_HOME: join(tmp, 'safe-home'), DSH_TUI_LANG: 'en' })
  check('safe: 标题双语', r.stdout.includes('safe mode'), `status=${r.status}`)
}

// --- 菜单交互边界（非 TTY 不进交互；PTY 子集见文件尾说明）-----------------------
{
  const r = run(['safe'], { DSH_HOME: join(tmp, 'safe-home') })
  check('safe: 非 TTY 不进入交互菜单（无 safe> 提示符）', r.status === 0 && !r.stdout.includes('safe>'))
}
{
  // 后位 `safe` 不截获：复刻 verify-cli-subcommands.mjs 的同名断言，让它在
  // Windows 上也有真实执行（那个脚本自身仍在 win32 上整包 skip，见文件头
  // 「未覆盖」说明）。走到启动路径 → 无 dsh 沙箱里止于预检。
  const home = join(tmp, 'pos-safe-home')
  mkdirSync(home, { recursive: true })
  const r = run(['/no/such/path', 'safe'], { DSH_HOME: home })
  check(
    'safe: 后位 safe 不截获（走启动路径，止于 dsh 预检）',
    r.status !== 0 && !r.stdout.includes('安全模式') && r.stderr.includes('dsh'),
    `status=${r.status}`,
  )
}

// --- 救援动作（`safe --rescue`：门禁 + 创建 + 复用 + 清理）---------------------
{
  // 1) 干净空 home：创建成功，安装钉到本副本版本且是官方 dsh plugin add。
  const stub = makeStub()
  const home = join(tmp, 'rescue-create')
  mkdirSync(home, { recursive: true })
  const r = run(['safe', '--rescue'], { PATH: stub.dir, DSH_STUB_STATE: stub.state, DSH_HOME: home })
  const adds = pluginCalls(stub.state)
  check('救援: 创建成功且退出 0', r.status === 0 && r.stdout.includes('救援 profile 已创建'), `status=${r.status}`)
  // 非交互路径到此为止，没有 startDshSession——结论行不许出现「启动」承诺，
  // 而要把启动动作交回用户（含可直接粘贴的命令）。
  check(
    '救援: 非交互结论行不承诺启动、并给出启动命令',
    !lastLine(r.stdout).includes('正在启动') &&
      !lastLine(r.stdout).includes('直接启动') &&
      lastLine(r.stdout).includes('未启动任何会话') &&
      lastLine(r.stdout).includes(`dsh --profile dsh-tui-safe`),
    lastLine(r.stdout),
  )
  check('救援: 插件包落位（安装判定文件可读）', existsSync(rescuePkgOf(home)))
  check(
    '救援: 走官方 dsh plugin add 且钉本副本版本',
    adds.length === 1 && adds[0].argv === `plugin --profile dsh-tui-safe add ${PACKAGE}@${ownVersion}`,
    adds[0]?.argv ?? 'no add call',
  )
  // 2) 再跑一次：已存在 → 复用，绝不覆盖重装。
  const second = run(['safe', '--rescue'], { PATH: stub.dir, DSH_STUB_STATE: stub.state, DSH_HOME: home })
  check('救援: 已存在时按现状复用', second.status === 0 && second.stdout.includes('救援 profile 已存在'), `status=${second.status}`)
  check(
    '救援: 复用时的非交互结论行同样不承诺启动、并给出启动命令',
    !lastLine(second.stdout).includes('正在启动') &&
      !lastLine(second.stdout).includes('直接启动') &&
      lastLine(second.stdout).includes('未启动任何会话') &&
      lastLine(second.stdout).includes(`dsh --profile dsh-tui-safe`),
    lastLine(second.stdout),
  )
  check('救援: 复用不重复 add', pluginCalls(stub.state).length === 1, `adds=${pluginCalls(stub.state).length}`)
  // 3) 英文路径同样要锁：baseEnv 默认 zh，只断中文时英文文案哪天退回「starting it」
  //    本套件照样全绿（review 指出）。用独立 home 走创建分支，避免与复用文案混淆。
  const enHome = join(tmp, 'rescue-en')
  mkdirSync(enHome, { recursive: true })
  const ren = run(['safe', '--rescue'], {
    PATH: stub.dir, DSH_STUB_STATE: stub.state, DSH_HOME: enHome, DSH_TUI_LANG: 'en',
  })
  const enLine = lastLine(ren.stdout)
  check(
    '救援: 英文非交互结论行同样不承诺启动、并给出启动命令',
    ren.status === 0 &&
      !enLine.includes('starting it') &&
      enLine.includes('nothing was started here') &&
      enLine.includes(`dsh --profile dsh-tui-safe`),
    enLine,
  )
}
{
  // 3) home 层补丁存在 → 干净不可证明，拒绝且不写盘。
  const stub = makeStub()
  const home = join(tmp, 'rescue-homepatch')
  mkdirSync(home, { recursive: true })
  writeFileSync(join(home, 'cordis.patch.yml'), '[]\n')
  const before = snapshot(home)
  const r = run(['safe', '--rescue'], { PATH: stub.dir, DSH_STUB_STATE: stub.state, DSH_HOME: home })
  const after = snapshot(home)
  check('救援: home 层补丁存在时拒绝（退出 1）', r.status === 1, `status=${r.status}`)
  check('救援: 拒绝原因指向 home 层文件', r.stderr.includes('救援被拒绝') && r.stderr.includes(join(home, 'cordis.patch.yml')))
  check('救援: 指引也点明 home 层会叠加到每个 profile', r.stdout.includes('会叠加到每个 profile'))
  check('救援: 拒绝时不写盘、不调用安装', sameSnapshot(before, after) && pluginCalls(stub.state).length === 0, diffOf(before, after).join(','))
}
{
  // 4) 目录存在但无法识别（无根 manifest）→ 拒绝，绝不往未知目录里装。
  const stub = makeStub()
  const home = join(tmp, 'rescue-unknown')
  mkdirSync(rescueDirOf(home), { recursive: true })
  writeFileSync(join(rescueDirOf(home), 'user-notes.txt'), 'not a profile\n')
  const before = snapshot(home)
  const r = run(['safe', '--rescue'], { PATH: stub.dir, DSH_STUB_STATE: stub.state, DSH_HOME: home })
  const after = snapshot(home)
  check('救援: 目录无法识别时拒绝（退出 1）', r.status === 1 && r.stderr.includes('不是可识别的 profile'), `status=${r.status}`)
  check('救援: 拒绝时不写盘、不调用安装', sameSnapshot(before, after) && pluginCalls(stub.state).length === 0, diffOf(before, after).join(','))
}
{
  // 5) 既有救援 profile 声明了第三方插件 → 启动它就不干净，拒绝。
  const stub = makeStub()
  const home = join(tmp, 'rescue-unclean')
  writeRescueManifest(home, {
    ...cleanManifest,
    dependencies: { ...cleanManifest.dependencies, 'cool-plugin': '0.1.0' },
  })
  const before = snapshot(home)
  const r = run(['safe', '--rescue'], { PATH: stub.dir, DSH_STUB_STATE: stub.state, DSH_HOME: home })
  const after = snapshot(home)
  check('救援: 既有 profile 含第三方插件时拒绝（退出 1）', r.status === 1 && r.stderr.includes('cool-plugin'), `status=${r.status}`)
  check('救援: 拒绝时不写盘、不调用安装', sameSnapshot(before, after) && pluginCalls(stub.state).length === 0, diffOf(before, after).join(','))
}
{
  // 6) 半装（根 manifest 干净但插件包不可读）→ 清掉重建，而不是让 pnpm
  //    的「已是最新」把选项 5 永久锁死。夹具按真实半装形态铺：根 manifest +
  //    dsh 生成的两个配置文件 + node_modules 目录 + dsh 每次启动都会建的
  //    .dsh-module-fallback 目录，缺插件包。
  const stub = makeStub()
  const home = join(tmp, 'rescue-half')
  writeRescueManifest(home, cleanManifest)
  writeFileSync(join(rescueDirOf(home), 'cordis.patch.yml'), REAL_PATCH_LAYER)
  writeFileSync(join(rescueDirOf(home), 'pnpm-workspace.yaml'), REAL_WORKSPACE)
  writeFileSync(join(rescueDirOf(home), 'cordis.yml'), '# dsh profile root\n[]\n')
  mkdirSync(join(rescueDirOf(home), 'node_modules'), { recursive: true })
  mkdirSync(join(rescueDirOf(home), '.dsh-module-fallback', 'node_modules'), { recursive: true })
  const halfBefore = snapshot(rescueDirOf(home))
  check('救援: 半装夹具确实落了盘（断言非空转）', Object.keys(halfBefore).length >= 6, Object.keys(halfBefore).join(','))
  const r = run(['safe', '--rescue'], { PATH: stub.dir, DSH_STUB_STATE: stub.state, DSH_HOME: home })
  // 这一条是功能性的：`.dsh-module-fallback` 是 dsh 每次 profile 启动都会建的
  // 目录（「装坏了 → 启动过一次 → 再来救援」正长这样）。白名单漏掉它，自愈
  // 路径就被堵死，而且用户按提示移走后下次启动又会被重新生成。
  check('救援: 半装且含 .dsh-module-fallback 时走清理重建（不误拒）', r.status === 0 && r.stdout.includes('已清理半装的 profile') && r.stdout.includes('救援 profile 已创建'), `status=${r.status}`)
  check('救援: 重建后安装判定文件可读', existsSync(rescuePkgOf(home)))
  // 重建出来的必须是真实形态（含 dsh 默认补丁层与 pnpm-workspace），
  // 否则下一次复用会被门禁误拒。
  check(
    '救援: 重建后是真实 dsh 形态（默认补丁层 + pnpm-workspace）',
    readTextOr(join(rescueDirOf(home), 'cordis.patch.yml')) === REAL_PATCH_LAYER &&
      readTextOr(join(rescueDirOf(home), 'pnpm-workspace.yaml')) === REAL_WORKSPACE,
  )
  const again = run(['safe', '--rescue'], { PATH: stub.dir, DSH_STUB_STATE: stub.state, DSH_HOME: home })
  check('救援: 重建后再次运行按现状复用（门禁不误拒默认补丁层）', again.status === 0 && again.stdout.includes('救援 profile 已存在'), `status=${again.status}`)
}
{
  // 6b) 形态不符也要拒绝：把生成物名字做成**目录**再往里放东西，只比名字的
  //     白名单会把它当生成物一起删掉（复测 S6）。这里 cordis.yml 是目录。
  const stub = makeStub()
  const home = join(tmp, 'rescue-shape')
  const dir = rescueDirOf(home)
  writeRescueManifest(home, cleanManifest)
  writeFileSync(join(dir, 'cordis.patch.yml'), REAL_PATCH_LAYER)
  mkdirSync(join(dir, 'cordis.yml'), { recursive: true })
  writeFileSync(join(dir, 'cordis.yml', 'mine.txt'), 'keep me\n')
  mkdirSync(join(dir, 'node_modules'), { recursive: true })
  const before = snapshot(dir)
  const r = run(['safe', '--rescue'], { PATH: stub.dir, DSH_STUB_STATE: stub.state, DSH_HOME: home })
  const after = snapshot(dir)
  check('救援: 生成物名字形态不符（cordis.yml 是目录）时拒绝且不删', r.status === 1 && r.stderr.includes('cordis.yml'), `status=${r.status}`)
  check('救援: 形态不符拒绝时目录原样保留', sameSnapshot(before, after), diffOf(before, after).join(','))
}
{
  // 7) no-op 假成功（add 报成功但包仍不可读）→ 清理半成品并给出路径，
  //    下一次尝试才能真的从零开始。替身在 no-op 模式下**真的建出半成品**，
  //    否则「已清理」的断言会因为 !existsSync 恒真而空转（变异实证过）。
  const stub = makeStub()
  const home = join(tmp, 'rescue-noop')
  mkdirSync(home, { recursive: true })
  const r = run(['safe', '--rescue'], { PATH: stub.dir, DSH_STUB_STATE: stub.state, DSH_HOME: home, DSH_STUB_NOOP: '1' })
  check('救援: no-op 假成功报失败（退出 1）', r.status === 1 && r.stderr.includes('no-op install'), `status=${r.status}`)
  check('救援: no-op 后清掉半成品（不再永久锁死选项 5）', !existsSync(rescueDirOf(home)) && r.stderr.includes(join(home, 'profiles', 'dsh-tui-safe')))
  // 清理之后紧接着再跑一次必须能成功（旧版这里会一直失败）。
  const retry = run(['safe', '--rescue'], { PATH: stub.dir, DSH_STUB_STATE: stub.state, DSH_HOME: home })
  check('救援: no-op 清理后重试即可成功', retry.status === 0 && retry.stdout.includes('救援 profile 已创建'), `status=${retry.status}`)
}
{
  // 7b) 变体：no-op 时目录里除了生成物还有别的东西 → 不静默删，改成拒绝。
  //     （替身的 no-op 半成品 + 一个用户文件）
  const stub = makeStub()
  const home = join(tmp, 'rescue-noop-stray')
  mkdirSync(join(rescueDirOf(home), 'node_modules'), { recursive: true })
  writeFileSync(join(rescueDirOf(home), 'package.json'), JSON.stringify(cleanManifest))
  writeFileSync(join(rescueDirOf(home), 'my-notes.txt'), 'keep me\n')
  const before = snapshot(rescueDirOf(home))
  const r = run(['safe', '--rescue'], { PATH: stub.dir, DSH_STUB_STATE: stub.state, DSH_HOME: home })
  const after = snapshot(rescueDirOf(home))
  check('救援: 目录里有非生成物时拒绝且不删（失败信息可读）', r.status === 1 && r.stderr.includes('my-notes.txt'), `status=${r.status}`)
  check('救援: 拒绝时目录原样保留', sameSnapshot(before, after), diffOf(before, after).join(','))
}
{
  // 7c) profile 层补丁层里有条目（dsh 会把它组合进 profile）→ 与 home 层
  //     同款处置：拒绝，一个字节都不写。夹具**真的创建该文件**。
  const stub = makeStub()
  const home = join(tmp, 'rescue-patched')
  const dir = rescueDirOf(home)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify(cleanManifest))
  writeFileSync(join(dir, 'cordis.patch.yml'), [...REAL_PATCH_LAYER.split('\n').slice(0, 3), '- id: cool-plugin', '  disabled: true', ''].join('\n'))
  mkdirSync(join(dir, 'node_modules', '@deepseek-harness-tui', 'dsh-tui'), { recursive: true })
  writeFileSync(rescuePkgOf(home), JSON.stringify({ name: PACKAGE, version: ownVersion }))
  const before = snapshot(home)
  const r = run(['safe', '--rescue'], { PATH: stub.dir, DSH_STUB_STATE: stub.state, DSH_HOME: home })
  const after = snapshot(home)
  check('救援: profile 层补丁有条目时拒绝（退出 1）', r.status === 1 && r.stderr.includes('补丁层里有条目'), `status=${r.status}`)
  check('救援: 拒绝原因指向 profile 补丁文件', r.stderr.includes(join(dir, 'cordis.patch.yml')))
  check('救援: profile 补丁拒绝时不写盘、不调用安装', sameSnapshot(before, after) && pluginCalls(stub.state).length === 0, diffOf(before, after).join(','))
}
{
  // 7d) 反向回归：真实 dsh 生成的 profile（含默认补丁层与 pnpm-workspace.yaml）
  //     必须原样复用——门禁不能把 dsh 自己的默认文件当成脏。
  const stub = makeStub()
  const home = join(tmp, 'rescue-real')
  const dir = rescueDirOf(home)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify(cleanManifest))
  writeFileSync(join(dir, 'cordis.patch.yml'), REAL_PATCH_LAYER)
  writeFileSync(join(dir, 'pnpm-workspace.yaml'), REAL_WORKSPACE)
  mkdirSync(join(dir, 'node_modules', '@deepseek-harness-tui', 'dsh-tui'), { recursive: true })
  writeFileSync(rescuePkgOf(home), JSON.stringify({ name: PACKAGE, version: ownVersion }))
  const before = snapshot(home)
  const r = run(['safe', '--rescue'], { PATH: stub.dir, DSH_STUB_STATE: stub.state, DSH_HOME: home })
  const after = snapshot(home)
  check('救援: 真实 dsh 形态（默认补丁层/workspace）按现状复用', r.status === 0 && r.stdout.includes('救援 profile 已存在'), `status=${r.status}`)
  check('救援: 复用真实形态时零写盘零 add', sameSnapshot(before, after) && pluginCalls(stub.state).length === 0, diffOf(before, after).join(','))
}
{
  // 7e) 注释里出现 `#` 的正常 YAML 也算有内容（fail-closed），但不该误伤
  //     注释 + [] 的默认形态（已由 7d 覆盖）。
  const stub = makeStub()
  const home = join(tmp, 'rescue-patched-list')
  const dir = rescueDirOf(home)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify(cleanManifest))
  writeFileSync(join(dir, 'cordis.patch.yml'), '[\n]\n')
  mkdirSync(join(dir, 'node_modules', '@deepseek-harness-tui', 'dsh-tui'), { recursive: true })
  writeFileSync(rescuePkgOf(home), JSON.stringify({ name: PACKAGE, version: ownVersion }))
  const r = run(['safe', '--rescue'], { PATH: stub.dir, DSH_STUB_STATE: stub.state, DSH_HOME: home })
  check('救援: 多行空数组（[] 折行）仍算无补丁层', r.status === 0 && r.stdout.includes('救援 profile 已存在'), `status=${r.status}`)
}
{
  // 8) pnpm 拒绝写入 workspace 根 → 必须带 -w 重试，且重试真的带上了 -w。
  const stub = makeStub()
  const home = join(tmp, 'rescue-w')
  mkdirSync(home, { recursive: true })
  const r = run(['safe', '--rescue'], { PATH: stub.dir, DSH_STUB_STATE: stub.state, DSH_HOME: home, DSH_STUB_ADDING_TO_ROOT: '1' })
  const adds = pluginCalls(stub.state)
  check('救援: ERR_PNPM_ADDING_TO_ROOT 经 -w 重试后成功', r.status === 0 && adds.length === 2, `status=${r.status} adds=${adds.length}`)
  check('救援: 重试确实带 -w 且首次失败原样转印', adds[1]?.argv.includes(' add -w ') === true && r.stderr.includes('ERR_PNPM_ADDING_TO_ROOT'), adds[1]?.argv ?? 'no retry call')
}
{
  // 9) 救援环境是显式构造的：宿主残留的会话控制变量不得被带进救援的安装/启动。
  const stub = makeStub()
  const home = join(tmp, 'rescue-env')
  mkdirSync(home, { recursive: true })
  const r = run(['safe', '--rescue'], {
    PATH: stub.dir, DSH_STUB_STATE: stub.state, DSH_HOME: home,
    DSH_TUI_RESUME_SESSION: 'leaked-session-id', DSH_TUI_WORKSPACE_TARGET: '/leaked/target',
  })
  const addCall = pluginCalls(stub.state)[0]
  // 两个会话控制变量都在被剥离之列（实现侧 RESCUE_DROPPED_ENV），所以两个都
  // 断言：只断 resume 时，第二个键哪天从剥离清单里掉出去本套件照样全绿。
  check(
    '救援: 显式环境剥离宿主会话控制变量（resume 与 workspace 两键）',
    r.status === 0 && addCall?.env === 'resume=none workspace=none',
    addCall?.env ?? 'no call',
  )
}

// --- 插件清单解析矩阵（伪 profile 根 package.json）------------------------------
{
  const invHome = join(tmp, 'inv-home')
  // 正常清单：bundles 两项 + dependencies 三项（含一个保护包）
  {
    rmSync(invHome, { recursive: true, force: true })
    const profDir = join(invHome, 'profiles', 'dsh-tui')
    mkdirSync(profDir, { recursive: true })
    writeFileSync(join(profDir, 'package.json'), JSON.stringify({
      name: 'dsh-profile-dsh-tui',
      dependencies: { [PACKAGE]: '1.0.0', '@deepseek-ai/dsh-base': '1.0.0', 'cool-plugin': '0.1.0' },
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', PACKAGE] } },
    }))
    const r = run(['safe'], { DSH_HOME: invHome })
    check('清单: bundles 与 dependencies 两维度分列', r.stdout.includes('组合层') && r.stdout.includes('直接依赖'))
    // 分类断言只看「直接依赖」区段：bundles 区段里同样有 @deepseek-ai/dsh-base
    // 与 @deepseek-harness-tui/dsh-tui，跨区段取串会假通过。
    const deps = section(r.stdout, '直接依赖（第三方为可卸载候选）：', '修复命令')
    check('清单: 直接依赖区段非空（断言限定在自己的区段里）', deps.includes(`${PACKAGE}`) && deps.includes('cool-plugin'), JSON.stringify(deps.slice(0, 80)))
    check(
      '清单: 保护包在直接依赖区段标注内置',
      deps.includes(`· ${PACKAGE}  (内置)`),
      deps,
    )
    check('清单: 第三方依赖在直接依赖区段标注第三方', /· cool-plugin {2}\(第三方\)/u.test(deps), deps)
    check('清单: 组合层区段独立标注内置', section(r.stdout, '组合层（dsh.profile.bundles，有序）：', '直接依赖').includes('(内置)'))
    check('清单: 第三方依赖列出', r.stdout.includes('cool-plugin'))
    // 指引的卸载候选 = 第三方直接依赖
    check('指引: 卸载候选只列第三方', r.stdout.includes('dsh plugin --profile dsh-tui remove cool-plugin'))
    // 救援 profile（最小可用）：指引须给出干净环境的手动命令——非交互
    // 用户即使不进菜单也能看到这条路。
    check('指引: 含救援 profile 创建与启动命令', r.stdout.includes('dsh plugin --profile dsh-tui-safe add') && r.stdout.includes('dsh --profile dsh-tui-safe'))
    // 双语契约：en 模式指引全量英文，不得残留中文指引串。
    const ren = run(['safe'], { DSH_HOME: invHome, DSH_TUI_LANG: 'en' })
    check('指引: 英文模式输出英文指引且无中文残留', ren.stdout.includes('# Remove third-party plugins') && !ren.stdout.includes('卸载第三方插件'))
    // en 零 CJK 正式断言：对完整 stdout 扫描 CJK 统一表意文字（U+4E00–U+9FFF），
    // 零命中——夹具含第三方依赖，标题/诊断/清单/卸载指引全分支均被覆盖。
    {
      const hits = ren.stdout
        .split('\n')
        .map((line, i) => ({ no: i + 1, line, chars: [...new Set(line.match(/[一-鿿]/g) ?? [])] }))
        .filter(h => h.chars.length > 0)
      check(
        '指引: en 模式完整输出零 CJK（U+4E00–U+9FFF 零命中）',
        hits.length === 0,
        hits.map(h => `L${h.no} [${h.chars.join('')}] ${h.line.trim()}`).join(' | '),
      )
    }
    // en 模式的救援拒绝文案同样零 CJK（门禁在 en 下也必须全英文）。
    {
      const renHome = join(tmp, 'inv-home-en')
      mkdirSync(renHome, { recursive: true })
      writeFileSync(join(renHome, 'cordis.patch.yml'), '[]\n')
      const rr = run(['safe', '--rescue'], { DSH_HOME: renHome, DSH_TUI_LANG: 'en' })
      const cjk = (rr.stdout + rr.stderr).match(/[一-鿿]/gu) ?? []
      check('指引: en 模式救援拒绝文案零 CJK', rr.status === 1 && cjk.length === 0, `status=${rr.status} cjk=${cjk.join('')}`)
    }
  }
  // 字段缺失：无 dsh.profile.bundles
  {
    rmSync(invHome, { recursive: true, force: true })
    const profDir = join(invHome, 'profiles', 'dsh-tui')
    mkdirSync(profDir, { recursive: true })
    writeFileSync(join(profDir, 'package.json'), JSON.stringify({ name: 'dsh-profile-dsh-tui', dependencies: {} }))
    const r = run(['safe'], { DSH_HOME: invHome })
    check('清单: 字段缺失降级', r.stdout.includes('清单不可读'))
  }
  // 字段类型错误：bundles 为字符串
  {
    rmSync(invHome, { recursive: true, force: true })
    const profDir = join(invHome, 'profiles', 'dsh-tui')
    mkdirSync(profDir, { recursive: true })
    writeFileSync(join(profDir, 'package.json'), JSON.stringify({ dependencies: {}, dsh: { profile: { bundles: 'oops' } } }))
    const r = run(['safe'], { DSH_HOME: invHome })
    check('清单: 字段类型错误降级', r.stdout.includes('清单不可读'))
  }
  // 字段类型错误：dependencies 为数组（仅该字段非法，dsh 保持合法）
  {
    rmSync(invHome, { recursive: true, force: true })
    const profDir = join(invHome, 'profiles', 'dsh-tui')
    mkdirSync(profDir, { recursive: true })
    writeFileSync(join(profDir, 'package.json'), JSON.stringify({ dependencies: [], dsh: { profile: { bundles: [] } } }))
    const r = run(['safe'], { DSH_HOME: invHome })
    check('清单: dependencies 为数组降级', r.stdout.includes('清单不可读'))
  }
  // 字段类型错误：dsh 为 null（仅该字段非法，dependencies 保持合法）
  {
    rmSync(invHome, { recursive: true, force: true })
    const profDir = join(invHome, 'profiles', 'dsh-tui')
    mkdirSync(profDir, { recursive: true })
    writeFileSync(join(profDir, 'package.json'), JSON.stringify({ dependencies: {}, dsh: null }))
    const r = run(['safe'], { DSH_HOME: invHome })
    check('清单: dsh 为 null 降级', r.stdout.includes('清单不可读'))
  }
  // 边角：bundles 混入非字符串项 → 非字符串被过滤，合法字符串项正常列出
  {
    rmSync(invHome, { recursive: true, force: true })
    const profDir = join(invHome, 'profiles', 'dsh-tui')
    mkdirSync(profDir, { recursive: true })
    writeFileSync(join(profDir, 'package.json'), JSON.stringify({ dependencies: { 'cool-plugin': '0.1.0' }, dsh: { profile: { bundles: [1, 'x'] } } }))
    const r = run(['safe'], { DSH_HOME: invHome })
    check('清单: bundles 非字符串项被过滤且字符串项正常列出', r.stdout.includes('· x  (内置)') && !r.stdout.includes('· 1'))
  }
  // 损坏 JSON：文件存在但非法
  {
    rmSync(invHome, { recursive: true, force: true })
    const profDir = join(invHome, 'profiles', 'dsh-tui')
    mkdirSync(profDir, { recursive: true })
    writeFileSync(join(profDir, 'package.json'), '{oops')
    const r = run(['safe'], { DSH_HOME: invHome })
    check('清单: 损坏 JSON 降级且不崩溃', r.status === 0 && r.stdout.includes('清单不可读'))
  }
}

rmSync(tmp, { recursive: true, force: true })
console.log(
  `\nNOTE: not covered here (needs a real PTY; node-pty is not a repo dependency): ` +
    `readline menu keystrokes, the TTY fallback prompt, and the rescue session itself.`,
)
if (skips > 0) console.log(`SKIPPED: ${skips} (platform-conditioned, listed above)`)
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
