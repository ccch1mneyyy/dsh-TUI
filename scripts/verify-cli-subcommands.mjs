#!/usr/bin/env node
/**
 * verify-cli-subcommands.mjs — bin/dsh-tui.js 子命令回归。
 *
 * 覆盖：
 *   - `help` / `--help` / `-h`：零环境应答——PATH 上没有 dsh/pnpm、
 *     DSH_HOME 指向空目录时也退出 0 并打印用法，绝不触发自举或委托
 *     （求助命令自己先跑一轮安装是反目标）；
 *   - `version` / `--version` / `-v`：打印本副本版本与角色；profile
 *     未安装时打印双语缺失标记，已安装时打印 profile 版本；
 *   - 双语：DSH_TUI_LANG=en 输出英文，缺省中文（与 bin 的 MSG 契约一致）；
 *   - 只认第一个参数：`dsh-tui <path> --help` 不截获（透传语义不变，
 *     由 verify-launcher.mjs 覆盖透传本身）。
 *
 * 运行：node scripts/verify-cli-subcommands.mjs（不依赖 lib/ 构建产物）
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const bin = join(root, 'bin', 'dsh-tui.js')
const ownVersion = JSON.parse(
  (await import('node:fs')).readFileSync(join(root, 'package.json'), 'utf8'),
).version

let failures = 0
function check(name, ok, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failures++
}

// 沙箱 stub 用 POSIX sh 脚本；Windows CI 只跑 compile + 入口 smoke import
// （ci.yml platform-smoke），本脚本不在其中——本地 Windows 直跑时明确跳
// 过，而不是伪装成红。
if (process.platform === 'win32') {
  console.log('SKIP: POSIX-only sandbox (Windows CI runs compile/import smoke only)')
  process.exit(0)
}

const tmp = mkdtempSync(join(tmpdir(), 'verify-cli-sub-'))
const emptyHome = join(tmp, 'dsh-home')
mkdirSync(emptyHome, { recursive: true })
const fakeUserHome = join(tmp, 'user-home')
mkdirSync(fakeUserHome, { recursive: true })

// PATH 指向一个空目录：dsh/pnpm 一定不可见（node 由 process.execPath 绝对
// 路径调用，不查 PATH——nvm 布局下 node 与全局 dsh 同目录，留 node 目录
// 会把真 dsh 漏进沙箱）。任何触发自举/预检的路径都会因找不到 dsh 失败
// 退出——反证子命令没走到那一步。HOME/USERPROFILE 一并指进沙箱，homedir()
// 不落真实账户目录。
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

// --- help ---------------------------------------------------------------------
for (const alias of ['help', '--help', '-h']) {
  const r = run([alias])
  check(`${alias} 退出 0 且打印用法（无 dsh、空 profile）`, r.status === 0 && r.stdout.includes('用法'), `status=${r.status}`)
}
{
  const r = run(['--help'], { DSH_TUI_LANG: 'en' })
  check('--help 英文输出（DSH_TUI_LANG=en）', r.status === 0 && r.stdout.includes('Usage'))
}

// --- version ------------------------------------------------------------------
for (const alias of ['version', '--version', '-v']) {
  const r = run([alias])
  check(`${alias} 打印本副本版本`, r.status === 0 && r.stdout.includes(ownVersion), `status=${r.status}`)
}
{
  const r = run(['version'])
  check('profile 未安装时打印中文缺失标记', r.stdout.includes('（未安装）'))
}
{
  const r = run(['version'], { DSH_TUI_LANG: 'en' })
  check('profile 未安装时打印英文缺失标记', r.stdout.includes('(not installed)'))
}
{
  // 伪造已安装 profile：version 应打印 profile 版本而不是缺失标记。
  const pkgDir = join(emptyHome, 'profiles', 'dsh-tui', 'node_modules', '@deepseek-harness-tui', 'dsh-tui')
  mkdirSync(pkgDir, { recursive: true })
  writeFileSync(join(pkgDir, 'package.json'), '{"version":"1.2.3-stub"}')
  const r = run(['version'])
  check('profile 已安装时打印 profile 版本', r.status === 0 && r.stdout.includes('1.2.3-stub'))
}

// --- update（顶层分发：不委托、import profile 的 lib）----------------------------
{
  // update 在顶层处理：即使是全局瘦壳，也直接 import **profile 的**编译
  // 产物执行——委托给旧 profile bin 会让不认识 update 的旧副本把它当参数
  // 透传（恰好是最需要升级的用户到不了新入口）。用仓库 bin（瘦壳角色）
  // 驱动，profile 里只放 stub lib，断言：控制权交给 cliUpdate、退出码
  // 透传、且没有发生委托（stub bin 不存在，委托会 delegateFailed）。
  const updateHome = join(tmp, 'update-home')
  const pkgDir = join(updateHome, 'profiles', 'dsh-tui', 'node_modules', '@deepseek-harness-tui', 'dsh-tui')
  mkdirSync(join(pkgDir, 'lib', 'types'), { recursive: true })
  writeFileSync(join(pkgDir, 'package.json'), '{"name":"@deepseek-harness-tui/dsh-tui","version":"9.9.9","type":"module"}')
  writeFileSync(
    join(pkgDir, 'lib', 'types', 'update.js'),
    'export async function cliUpdate(profile) { console.log(`stub-cli-update profile=${profile}`); return 42 }\n',
  )
  const stubDir = join(tmp, 'stub-bin')
  mkdirSync(stubDir, { recursive: true })
  writeFileSync(join(stubDir, 'dsh'), '#!/bin/sh\nexit 0\n')
  ;(await import('node:fs')).chmodSync(join(stubDir, 'dsh'), 0o755)
  const r = run(['update'], { PATH: stubDir, DSH_HOME: updateHome })
  check(
    'update 顶层交给 profile lib 的 cliUpdate 并透传退出码（不经委托）',
    r.status === 42 && r.stdout.includes('stub-cli-update profile=dsh-tui'),
    `status=${r.status}`,
  )
  // 旧版编译产物：update.js 存在但没有 cliUpdate 导出（半更新残留）——
  // 必须走同一条双语指引退出 1，而不是解构 undefined 的裸 TypeError。
  writeFileSync(join(pkgDir, 'lib', 'types', 'update.js'), 'export const somethingElse = 1\n')
  const r2 = run(['update'], { PATH: stubDir, DSH_HOME: updateHome })
  check(
    '旧版 lib 无 cliUpdate 导出时给手工升级指引并退出 1',
    r2.status === 1 && r2.stderr.includes('dsh plugin --profile dsh-tui add'),
    `status=${r2.status}`,
  )
  // lib 整体缺失（未构建源码/损坏安装）：同一条指引。
  rmSync(join(pkgDir, 'lib'), { recursive: true, force: true })
  const r3 = run(['update'], { PATH: stubDir, DSH_HOME: updateHome })
  check(
    'lib 缺失时 update 给手工升级指引并退出 1',
    r3.status === 1 && r3.stderr.includes('dsh plugin --profile dsh-tui add'),
    `status=${r3.status}`,
  )
  // 无 dsh：update 需要 dsh（README 如实声明），止于预检。
  const r4 = run(['update'], { DSH_HOME: updateHome })
  check('无 dsh 时 update 止于预检并给安装指引', r4.status === 1 && r4.stderr.includes('@deepseek-ai/dsh'), `status=${r4.status}`)
  // DSH_TUI_NO_DELEGATE 不改变路径：分发在角色分支之前，import 的仍是
  // profile 的 lib（不是本副本的——两者版本可能不同，读错包会误判）。
  mkdirSync(join(pkgDir, 'lib', 'types'), { recursive: true })
  writeFileSync(
    join(pkgDir, 'lib', 'types', 'update.js'),
    'export async function cliUpdate(profile) { console.log(`stub-cli-update profile=${profile}`); return 42 }\n',
  )
  const r5 = run(['update'], { PATH: stubDir, DSH_HOME: updateHome, DSH_TUI_NO_DELEGATE: '1' })
  check('DSH_TUI_NO_DELEGATE 下 update 仍 import profile lib', r5.status === 42 && r5.stdout.includes('stub-cli-update'), `status=${r5.status}`)
}
{
  // 空 profile → 先走既有自举、再 import 自举出的 profile lib。stub dsh 的
  // plugin 分支模拟真实安装：创建判定文件与带 cliUpdate 的 lib。
  const bootHome = join(tmp, 'boot-home')
  mkdirSync(bootHome, { recursive: true })
  const bootStub = join(tmp, 'boot-stub')
  mkdirSync(bootStub, { recursive: true })
  writeFileSync(
    join(bootStub, 'dsh'),
    '#!/bin/sh\n' +
      // 沙箱 PATH 只含 stub 目录——coreutils（mkdir/printf 的外部实现）要
      // 显式借系统路径，否则 stub 在自己的沙箱里连目录都建不出来。
      'PATH=/usr/bin:/bin\n' +
      'if [ "$1" = "plugin" ]; then\n' +
      '  d="$DSH_HOME/profiles/dsh-tui/node_modules/@deepseek-harness-tui/dsh-tui"\n' +
      '  mkdir -p "$d/lib/types"\n' +
      '  printf \'{"name":"@deepseek-harness-tui/dsh-tui","version":"9.9.9","type":"module"}\' > "$d/package.json"\n' +
      '  printf \'export async function cliUpdate(profile) { console.log(`boot-cli-update profile=${profile}`); return 0 }\' > "$d/lib/types/update.js"\n' +
      'fi\nexit 0\n',
  )
  writeFileSync(join(bootStub, 'pnpm'), '#!/bin/sh\nexit 0\n')
  ;(await import('node:fs')).chmodSync(join(bootStub, 'dsh'), 0o755)
  ;(await import('node:fs')).chmodSync(join(bootStub, 'pnpm'), 0o755)
  const r = run(['update'], { PATH: bootStub, DSH_HOME: bootHome })
  check('空 profile 时 update 先自举再 import profile lib', r.status === 0 && r.stdout.includes('boot-cli-update profile=dsh-tui'), `status=${r.status}`)
}

// --- doctor -------------------------------------------------------------------
{
  // 无 dsh：诊断照常打印全表，但以退出码 1 收束（dsh 缺失是唯一硬失败）。
  const r = run(['doctor'])
  check('doctor 无 dsh 时退出 1 且标注缺失', r.status === 1 && r.stdout.includes('✗ dsh'), `status=${r.status}`)
}
{
  // stub dsh/pnpm：退出 0；profile 已装（前面的用例写入了 1.2.3-stub）；
  // 密钥红线——设置了值时只报告状态，stdout 绝不含密钥本身。
  const stubDir = join(tmp, 'doctor-stub')
  mkdirSync(stubDir, { recursive: true })
  writeFileSync(join(stubDir, 'dsh'), '#!/bin/sh\necho 9.9.9-dsh-stub\nexit 0\n')
  writeFileSync(join(stubDir, 'pnpm'), '#!/bin/sh\necho 9.9.9-pnpm-stub\nexit 0\n')
  ;(await import('node:fs')).chmodSync(join(stubDir, 'dsh'), 0o755)
  ;(await import('node:fs')).chmodSync(join(stubDir, 'pnpm'), 0o755)
  const SECRET = 'sk-hunt-secret-marker'
  const r = run(['doctor'], { PATH: stubDir, DEEPSEEK_API_KEY: SECRET })
  check('doctor 有 dsh/pnpm 时退出 0 并打印版本', r.status === 0 && r.stdout.includes('9.9.9-dsh-stub') && r.stdout.includes('9.9.9-pnpm-stub'), `status=${r.status}`)
  check('doctor 报告 profile 版本', r.stdout.includes('1.2.3-stub'))
  check('doctor 报告密钥已设置', r.stdout.includes('已设置'))
  check('doctor 绝不输出密钥值（红线）', !r.stdout.includes(SECRET) && !r.stderr.includes(SECRET))
  const r2 = run(['doctor'], { PATH: stubDir })
  check('doctor 报告密钥未设置', r2.status === 0 && r2.stdout.includes('未设置'))
  // 版本错位提示：profile(1.2.3-stub) vs 启动器(ownVersion)——不对齐时给指引。
  check('doctor 报告启动器与 profile 版本错位', r2.stdout.includes('launcher ↔ profile') && r2.stdout.includes('✗'))
  // 空字符串密钥：发不了请求，且 TUI 内 /doctor 按 truthiness 报未配置——
  // 两个 doctor 结论必须一致。
  const r3 = run(['doctor'], { PATH: stubDir, DEEPSEEK_API_KEY: '' })
  check('doctor 空字符串密钥按未设置报告', r3.stdout.includes('未设置'))
  // 探针输出白名单：PATH 上的 wrapper 把环境变量 echo 进 --version 时，
  // 非版本形状的首行不得转印（密钥红线的探针侧）。
  const leakDir = join(tmp, 'doctor-leak-stub')
  mkdirSync(leakDir, { recursive: true })
  writeFileSync(join(leakDir, 'dsh'), '#!/bin/sh\necho "$DEEPSEEK_API_KEY"\nexit 0\n')
  ;(await import('node:fs')).chmodSync(join(leakDir, 'dsh'), 0o755)
  const r4 = run(['doctor'], { PATH: leakDir, DEEPSEEK_API_KEY: SECRET })
  check(
    'doctor 探针输出非版本形状时不转印（wrapper 泄密场景）',
    !r4.stdout.includes(SECRET) && !r4.stderr.includes(SECRET) && r4.stdout.includes('(version unreadable)'),
  )
}

// --- 只认第一个参数 ------------------------------------------------------------
{
  // 独立的全新 DSH_HOME：前面的用例已在 emptyHome 写入 profile 残骸，
  // 复用它会让失败原因变成「委托目标缺 bin」而不是「dsh 预检失败」——
  // 断言就空转了。这里必须验证的是：后位子命令词不截获，进程走正常
  // 启动路径，并在无 dsh 沙箱里以自举预检失败（noDsh 指引）告终。
  const freshHome = join(tmp, 'fresh-home')
  mkdirSync(freshHome, { recursive: true })
  for (const [label, args] of [
    ['后位 --help', ['/no/such/path', '--help']],
    ['后位 version', ['/no/such/path', 'version']],
    ['后位 update', ['/no/such/path', 'update']],
    ['后位 help', ['--resume', 'help']],
  ]) {
    const r = run(args, { DSH_HOME: freshHome })
    check(
      `${label} 不截获（走启动路径，止于 dsh 预检）`,
      r.status !== 0 && !r.stdout.includes('用法') && !r.stdout.includes(ownVersion) && r.stderr.includes('dsh'),
      `status=${r.status}`,
    )
  }
}

rmSync(tmp, { recursive: true, force: true })
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
