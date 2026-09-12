#!/usr/bin/env node
/**
 * verify-safe-mode.mjs — 安全模式（PR①）回归。
 *
 * 覆盖：safe 子命令零环境可用与非 TTY 降级、控制面只读（文件系统快照）、
 * profile 插件清单解析矩阵、fallback 触发矩阵（非 TTY）、doctor 提取的
 * 行为等价（完整期望值，仅规范化临时路径）。
 *
 * 运行：node scripts/verify-safe-mode.mjs（不依赖 lib/ 构建产物）
 */
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const bin = join(root, 'bin', 'dsh-tui.js')
const ownVersion = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version

let failures = 0
function check(name, ok, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failures++
}

if (process.platform === 'win32') {
  console.log('SKIP: POSIX-only sandbox (Windows CI runs compile/import smoke only)')
  process.exit(0)
}

const tmp = mkdtempSync(join(tmpdir(), 'verify-safe-'))
const emptyHome = join(tmp, 'dsh-home')
mkdirSync(emptyHome, { recursive: true })
const fakeUserHome = join(tmp, 'user-home')
mkdirSync(fakeUserHome, { recursive: true })
const noBin = join(tmp, 'no-bin')
mkdirSync(noBin, { recursive: true })
const run = (args, env = {}) =>
  spawnSync(process.execPath, [bin, ...args], {
    encoding: 'utf8',
    env: {
      PATH: noBin,
      DSH_HOME: emptyHome,
      HOME: fakeUserHome,
      USERPROFILE: fakeUserHome,
      DSH_TUI_LANG: 'zh',
      ...env,
    },
  })

// 递归快照：路径 → 类型/大小。只读断言的证据来源。
const snapshot = dir => {
  const out = {}
  const walk = (d, prefix) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name)
      const key = prefix + e.name
      if (e.isDirectory()) { out[key] = 'dir'; walk(p, key + '/') }
      else { const s = statSync(p); out[key] = `file:${s.size}` }
    }
  }
  walk(dir, '')
  return out
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
  const stubDir = join(tmp, 'fb-stub')
  mkdirSync(stubDir, { recursive: true })
  writeFileSync(join(stubDir, 'dsh'), '#!/bin/sh\nif [ "$1" = "--profile" ]; then exit "${DSH_STUB_EXIT:-0}"; fi\nexit 0\n')
  chmodSync(join(stubDir, 'dsh'), 0o755)
  // profile 已装且与启动器同版：版本核对不产生额外输出，stderr 断言干净。
  const profHome = join(tmp, 'fb-home')
  const pkgDir = join(profHome, 'profiles', 'dsh-tui', 'node_modules', '@deepseek-harness-tui', 'dsh-tui')
  mkdirSync(pkgDir, { recursive: true })
  writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: '@deepseek-harness-tui/dsh-tui', version: ownVersion }))
  const runFb = (env = {}) => run([], { PATH: stubDir, DSH_HOME: profHome, DSH_TUI_NO_DELEGATE: '1', ...env })
  {
    const r = runFb()
    check('fallback: exit 0 无提示', r.status === 0 && !r.stderr.includes('safe'), `status=${r.status}`)
  }
  {
    const r = runFb({ DSH_STUB_EXIT: '42' })
    check(
      'fallback: exit 42 → 保留 profileExited 诊断 + 追加 safeHint + 退出码保真',
      r.status === 42 && r.stderr.includes('退出码 42') && r.stderr.includes('dsh-tui safe') && r.stderr.indexOf('已退出') < r.stderr.indexOf('safe'),
      `status=${r.status}`,
    )
  }
  {
    const r = runFb({ DSH_STUB_EXIT: '42', DSH_TUI_LANG: 'en' })
    check('fallback: safeHint 双语', r.stderr.includes('Run dsh-tui safe'), `status=${r.status}`)
  }
  {
    // 信号场景：stub 自杀 SIGINT → 启动器 self-kill 透传，无提示。
    writeFileSync(join(stubDir, 'dsh'), '#!/bin/sh\nif [ "$1" = "--profile" ]; then kill -INT $$; fi\nexit 0\n')
    const r = runFb()
    check('fallback: 信号透传且无 safe 提示', r.status === null && r.signal === 'SIGINT' && !r.stderr.includes('safe'), `signal=${r.signal}`)
    writeFileSync(join(stubDir, 'dsh'), '#!/bin/sh\nif [ "$1" = "--profile" ]; then exit "${DSH_STUB_EXIT:-0}"; fi\nexit 0\n')
  }
}

// --- safe 手动入口：零环境 + 非 TTY 降级 + 控制面只读 --------------------------
{
  const freshHome = join(tmp, 'safe-home')
  mkdirSync(freshHome, { recursive: true })
  const before = snapshot(freshHome)
  const r = run(['safe'], { DSH_HOME: freshHome })
  const after = snapshot(freshHome)
  check('safe: 零环境非 TTY 退出 0', r.status === 0, `status=${r.status}`)
  check('safe: 打印标题', r.stdout.includes('安全模式'))
  check('safe: 内嵌 doctor 诊断', r.stdout.includes('✗ dsh'))
  check('safe: 打印修复指引', r.stdout.includes('dsh plugin --profile dsh-tui'))
  check('safe: 清单不可读降级（空 profile）', r.stdout.includes('清单不可读'))
  check('safe: 控制面只读（DSH_HOME 无任何新增/修改）', JSON.stringify(before) === JSON.stringify(after))
}
{
  const r = run(['safe', 'extra1', 'extra2'], { DSH_HOME: join(tmp, 'safe-home') })
  check('safe: 附加参数提示忽略', r.stdout.includes('已忽略附加参数：2 个'), `status=${r.status}`)
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
      dependencies: { '@deepseek-harness-tui/dsh-tui': '1.0.0', '@deepseek-ai/dsh-base': '1.0.0', 'cool-plugin': '0.1.0' },
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-harness-tui/dsh-tui'] } },
    }))
    const r = run(['safe'], { DSH_HOME: invHome })
    check('清单: bundles 与 dependencies 两维度分列', r.stdout.includes('组合层') && r.stdout.includes('直接依赖'))
    check('清单: 第三方依赖列出', r.stdout.includes('cool-plugin'))
    check('清单: 保护包标注内置', r.stdout.includes('内置') && r.stdout.includes('@deepseek-ai/dsh-base'))
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

// --- 交互菜单的 PTY 子集（本套件不覆盖，手动演练兜底）--------------------------
// readline 菜单（选项 1-5 动作、无效输入 3 次重印、SIGINT/EOF 取消、重试
// 前终端交接与结束后重建输入）需要真实 TTY/PTY 驱动，不依赖外部原生模块
// 时无法在此自动化；逐项演练清单见 spec §8 与任务简报 Step 5，结果记录在
// PR 描述。

rmSync(tmp, { recursive: true, force: true })
console.log('SKIP: PTY interactive subset — manual drill per spec §8 (deferred, see PR description)')
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
