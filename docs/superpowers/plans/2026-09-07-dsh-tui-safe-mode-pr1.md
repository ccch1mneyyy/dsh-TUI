# dsh-tui 安全模式 PR① 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 `bin/dsh-tui.js` 加安全模式：`safe` 手动子命令 + dsh 非零退出后的自动 fallback 询问，内含只读诊断、插件清单与修复指引。

**Architecture:** 全部改动单文件内联于 `bin/dsh-tui.js`（迁移契约要求单文件自包含，见 spec §3.1）：doctor 检查提取为 `runDoctorChecks`，最终 spawn 提取为返回结果模型的 `startDshSession`，safe 会话（询问/菜单/降级）为内联函数区段。行为验证走新聚焦脚本 `scripts/verify-safe-mode.mjs`（仓库无 test 框架，惯例为 verify-* 回归）。

**Tech Stack:** Node ESM（顶层 await 可用，`bin/dsh-tui.js:416` 已有先例）、`node:readline/promises`、POSIX sh stub 沙箱测试。

**Spec:** `/mnt/shared/_Projects/DSH-TUI/repo/docs/superpowers/specs/2026-09-07-dsh-tui-safe-mode-pr1-design.md`（v2）。执行每个任务前先读 spec 对应节。

## Global Constraints

- **单文件内联**：不新增 bin/ 模块文件；`bin/dsh-tui.js` 保持零 lib/ 依赖（`bin/dsh-tui.js:23-25` 迁移契约）
- **只追加不替换既有诊断文案**：`profileExited`/`launchFailed` 原样保留，safeHint 追加在其后（`verify-launcher.mjs:174-182` 断言护住旧文案）
- **退出码保真**：最终退出码 = 最近一次 dsh 会话退出码；信号首启维持 self-kill 透传（`bin/dsh-tui.js:338-340`）；不从数值反推信号
- **控制面只读**：safe 会话自身不写文件、不执行安装卸载；重试前 `profileReady()` 检查，不 ready 不自举
- **双语**：所有新用户可见文案进 MSG 表（en/zh 双键，`DSH_TUI_LANG ?? CC_TUI_LANG` 判定，`bin/dsh-tui.js:123`）
- **代码风格**：两空格、单引号、无分号、中文注释（对齐现有文件）；不批量格式化
- **Git 红线**：只 `git add` 显式路径，不用 `git add .`/`-A`；commit 信息用英文 conventional 风格（对齐 `git log` 现状）
- **验证命令**：`node scripts/verify-safe-mode.mjs`、`node scripts/verify-cli-subcommands.mjs`、`node scripts/verify-launcher.mjs`（均不依赖 lib/ 构建产物）；本计划不改 TypeScript，不需要 `pnpm build`
- 行号引用基于 574 行基线（commit 8f66ec93 后），实现中行号会漂移，以代码锚点（函数名/文案键）为准

---

### Task 1: `runDoctorChecks()` 提取（特征测试先行）

**Files:**
- Modify: `bin/dsh-tui.js:278-331`（doctor 截获块）
- Create: `scripts/verify-safe-mode.mjs`

**Interfaces:**
- Consumes: 现有 `msg()`/`probeVersion` 局部函数、`readJson`/`installedPkgPath`/`profileDir`/`runningInsideProfile`/`isVersionNewer` 等模块级标识符
- Produces: `const runDoctorChecks = () => ({ hardFailure: boolean, lines: string[] })`——Task 4 的 safe 会话复用；`scripts/verify-safe-mode.mjs` 的 `run()`/`check()` 骨架——后续所有任务往里加断言

- [ ] **Step 1: 创建 verify-safe-mode.mjs 骨架与 doctor 特征断言（对现状跑绿，固化 golden 输出）**

创建 `scripts/verify-safe-mode.mjs`，内容（手法来源：`verify-cli-subcommands.mjs:23-67` 的沙箱与 `verify-launcher.mjs` 的 stub）：

```js
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

// 递归快照：路径 → (类型, size, mtimeMs)。只读断言的证据来源。
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
    `✗ DEEPSEEK_API_KEY: 未设置——交互启动读取 DEEPSEEK_API_KEY`,
    `✗ config: ${join(fakeUserHome, '.dsh-tui', 'cordis.yml')}  missing`,
    `✗ config: ${join(emptyHome, 'profiles', 'dsh-tui', 'cordis.patch.yml')}  missing`,
  ]
  const actual = r.stdout.split('\n').filter(l => l !== '')
  check(
    'doctor 输出逐行等于期望值（提取前 golden，之后任何任务不得漂移）',
    r.status === 1 && actual.length === expected.length && expected.every((l, i) => l === actual[i]),
    `lines=${actual.length}`,
  )
}

rmSync(tmp, { recursive: true, force: true })
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
```

- [ ] **Step 2: 运行验证特征断言对现状通过**

Run: `node scripts/verify-safe-mode.mjs`
Expected: `ALL PASS`（doctor 输出与手写期望逐行一致——若不一致，以实际输出修正期望值数组后再继续，这是 golden 固化步骤）

- [ ] **Step 3: 提取 runDoctorChecks（行为等价重构）**

把 `bin/dsh-tui.js:284-331` 的 doctor 截获块改为调用提取函数。在 doctor 截获块**上方**（`bin/dsh-tui.js:278` 注释块之前）加入：

```js
// ─── doctor 检查逻辑（doctor 子命令与 safe 会话共用）──────────────────────────
// 输出与退出语义与单命令时代逐字一致：版本探针白名单回显、密钥只报
// truthiness、仅 dsh 缺失为硬失败。safe 复用同一函数——两个入口的
// diagnostics 不许分叉（对齐 doctor 与 TUI 内 /doctor 的既有契约）。
const runDoctorChecks = () => {
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
    report(false, 'dsh', msg('doctorLabels').dshMissing)
  } else {
    report(true, 'dsh', dshVersion)
  }
  const pnpmVersion = probeVersion('pnpm')
  report(pnpmVersion !== undefined, 'pnpm', pnpmVersion ?? msg('doctorLabels').pnpmMissing)
  const profileVersion = readJson(installedPkgPath)?.version
  if (profileVersion === undefined) {
    report(false, 'profile', `${msg('doctorLabels').profileMissing}  (${profileDir})`)
  } else {
    report(true, 'profile', `${profileVersion}  (${profileDir})`)
    if (ownVersion !== undefined && !runningInsideProfile) {
      if (profileVersion === ownVersion) {
        report(true, 'launcher ↔ profile', msg('doctorLabels').aligned)
      } else if (isVersionNewer(profileVersion, ownVersion)) {
        report(false, 'launcher ↔ profile', msg('doctorLabels').profileNewer(profileVersion))
      } else {
        report(false, 'launcher ↔ profile', msg('doctorLabels').profileOlder(ownVersion))
      }
    }
  }
  // truthiness 而非 !== undefined：空字符串的 key 同样发不了请求，且 TUI 内
  // /doctor（channel.doctorInfo）按 truthiness 报告——两个 doctor 不许分叉。
  const keySet = Boolean(process.env.DEEPSEEK_API_KEY)
  report(keySet, 'DEEPSEEK_API_KEY', keySet ? msg('doctorLabels').keySet : msg('doctorLabels').keyMissing)
  for (const candidate of [join(homedir(), '.dsh-tui', 'cordis.yml'), join(profileDir, 'cordis.patch.yml')]) {
    report(existsSync(candidate), 'config', `${candidate}${existsSync(candidate) ? '' : `  ${msg('doctorLabels').missing}`}`)
  }
  return { hardFailure, lines }
}
```

doctor 截获块本体改为：

```js
if (subcommand === 'doctor') {
  const { hardFailure, lines } = runDoctorChecks()
  for (const line of lines) console.log(line)
  process.exit(hardFailure ? 1 : 0)
}
```

注意：原块中的 `const L = msg('doctorLabels')` 与局部 `report`/`probeVersion` 全部移入函数；原 doctor 块顶部的说明注释保留在截获块处。

- [ ] **Step 4: 运行特征断言与既有回归确认等价**

Run: `node scripts/verify-safe-mode.mjs && node scripts/verify-cli-subcommands.mjs`
Expected: 两个脚本均 `ALL PASS`（doctor 行为零漂移）

- [ ] **Step 5: Commit**

```bash
git add bin/dsh-tui.js scripts/verify-safe-mode.mjs
git commit -m "refactor(launcher): extract runDoctorChecks for safe-mode reuse (behavior-identical, golden-pinned)"
```

---

### Task 2: 结果模型 `startDshSession` + 首启路径改造（行为等价）

**Files:**
- Modify: `bin/dsh-tui.js:333-346`（forwardExit 保持不动，瘦壳仍用）、`bin/dsh-tui.js:568-573`（完整逻辑分支最终 spawn）
- Test: `scripts/verify-launcher.mjs`（不改，作为等价回归）

**Interfaces:**
- Produces: `const startDshSession = dshArgs => Promise<DshResult>`，`DshResult = { kind: 'exit', code: number } | { kind: 'signal', signal: string } | { kind: 'error', error: Error }`——Task 3/5 的 fallback 与重试消费
- Produces: `const settleFirstResult = result => void`（首启结算：signal→self-kill；exit0→exit0；error→launchFailed+exit1）——Task 3 在其非零分支插入 fallback

- [ ] **Step 1: 确认既有等价回归基线为绿**

Run: `node scripts/verify-launcher.mjs`
Expected: `ALL PASS`（本任务全程不得变红——这是行为等价的证明）

- [ ] **Step 2: 加入 startDshSession 与 settleFirstResult**

在 `forwardExit` 定义（`bin/dsh-tui.js:333`）之后加入：

```js
// ─── dsh 会话结果模型（fallback 与 safe 重试共用）─────────────────────────────
// 统一表示子进程结局；不在此处做任何退出决定——退出权在调用者（首启结算
// 或 safe 菜单）。Windows 经 cmd()/shell:true 启动（见 cmd 注释），壳层
// 观察到的 signal 不保证等同内部 dsh 的中断语义：判定一律只看数值 code，
// 不从数值反推信号（spec §5.1）。
const startDshSession = dshArgs =>
  new Promise(resolve => {
    const child = spawn(...cmd('dsh', ['--profile', PROFILE, ...dshArgs]), {
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

// 首次启动的结算：本任务维持既有语义（signal self-kill / 非零保留诊断并
// 透传 / error 走 launchFailed）；Task 3 将在非零与 error 分支接入 fallback。
const settleFirstResult = result => {
  if (result.kind === 'signal') {
    process.kill(process.pid, result.signal)
    return
  }
  if (result.kind === 'error') {
    console.error(msg('launchFailed')(result.error))
    process.exit(1)
  }
  if (result.code !== 0) console.error(msg('profileExited')(result.code))
  process.exit(result.code)
}
```

完整逻辑分支末尾（原 568-573）改为：

```js
  const firstArgs = args
  settleFirstResult(await startDshSession(firstArgs))
```

（`firstArgs` 命名是有意的：Task 3 的 fallback 需要重放这份已规范化的 args——spec §5.3 不重新解析 argv。）

- [ ] **Step 3: 运行等价回归**

Run: `node scripts/verify-launcher.mjs && node scripts/verify-cli-subcommands.mjs`
Expected: 均 `ALL PASS`

- [ ] **Step 4: Commit**

```bash
git add bin/dsh-tui.js
git commit -m "refactor(launcher): settle dsh sessions through a result model (behavior-identical)"
```

---

### Task 3: fallback 询问 + safeHint 追加（非 TTY 路径完整，TTY 询问接菜单桩）

**Files:**
- Modify: `bin/dsh-tui.js` MSG 表（新键 `safeAsk`/`safeHint`）、`settleFirstResult`
- Test: `scripts/verify-safe-mode.mjs`（新增 fallback 矩阵断言，需要 stub dsh）

**Interfaces:**
- Consumes: Task 2 的 `DshResult`/`startDshSession`/`firstArgs`
- Produces: `const askSafeEntry = async pendingExitCode => Promise<boolean>`（TTY 询问，true=进入 safe）与 `const runSafeSession = async ({ pendingExitCode, retryDsh }) => Promise<number>`（本任务先给桩：菜单体 Task 5 实现；非 TTY 降级 Task 4 实现）

- [ ] **Step 1: MSG 表新增两个键（插在 `profileExited` 条目之后）**

```js
  safeAsk: {
    en: code => `dsh-tui exited unexpectedly (code ${code}). Enter safe mode? [Y/n] `,
    zh: code => `dsh-tui 异常退出（码 ${code}）。进入安全模式？[Y/n] `,
  },
  safeHint: {
    en: code => `[dsh-tui] Exited with code ${code}. Run dsh-tui safe for diagnostics and repair guidance.`,
    zh: code => `[dsh-tui] 异常退出（码 ${code}）。可运行 dsh-tui safe 进入安全模式`,
  },
```

- [ ] **Step 2: 在 verify-safe-mode.mjs 写失败断言（fallback 非 TTY 矩阵）**

在 doctor 断言块之后、`rmSync` 清理之前插入（stub 手法来源 `verify-launcher.mjs:51`——`--version` 恒 0、`--profile` 受 `DSH_STUB_EXIT` 控制）：

```js
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
  const runFb = (env = {}) => run([], { PATH: stubDir, DSH_HOME: profHome, ...env })
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
```

- [ ] **Step 3: 运行确认新断言失败**

Run: `node scripts/verify-safe-mode.mjs`
Expected: `FAIL: fallback: exit 42 ...`（现状无 safeHint）；exit 0 / 信号两组应已 PASS

- [ ] **Step 4: 改造 settleFirstResult 接入 fallback**

`settleFirstResult` 改为 async 并接收重放参数（替换 Task 2 版本）：

```js
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
```

调用点同步：`settleFirstResult(await startDshSession(firstArgs), firstArgs)`。

加入交互判定与询问（放在 `startDshSession` 之后；`runSafeSession` 本任务给最小桩，Task 4/5 填充）：

```js
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
  let answer = ''
  try { answer = await rl.question(msg('safeAsk')(pendingExitCode)) } catch { cancelled = true }
  try { rl.close() } catch { /* 已关闭 */ }
  if (cancelled || answer === undefined) return false
  const a = answer.trim().toLowerCase()
  return a === '' || a === 'y' || a === 'yes'
}

const runSafeSession = async ({ pendingExitCode = 0, retryDsh }) => {
  // Task 4 填充非 TTY 降级；Task 5 填充 readline 菜单。本任务仅保证
  // fallback 链路可编译可结算：直接返回携带的退出码。
  return pendingExitCode
}
```

注意：`askSafeEntry` 在 stdin 关闭（EOF）时 `question` resolve `undefined`（readline/promises 在接口 close 后的既有行为）——按取消处理，等价拒绝（spec §6.2）。

- [ ] **Step 5: 运行全部回归**

Run: `node scripts/verify-safe-mode.mjs && node scripts/verify-launcher.mjs && node scripts/verify-cli-subcommands.mjs`
Expected: 均 `ALL PASS`（`verify-launcher.mjs:174-182` 的非零退出断言继续绿——profileExited 未动，safeHint 是追加；`silent when aligned` 仍绿——exit 0 无提示）

- [ ] **Step 6: Commit**

```bash
git add bin/dsh-tui.js scripts/verify-safe-mode.mjs
git commit -m "feat(launcher): offer safe mode after unexpected dsh exits (non-TTY hint, TTY prompt stub)"
```

---

### Task 4: `safe` 手动入口 + 非 TTY 降级全量输出 + 插件清单/指引（纯函数）

**Files:**
- Modify: `bin/dsh-tui.js`：新截获块（doctor 块之后、update 块之前 `bin/dsh-tui.js:331-405` 之间）、MSG 表（`safeTitle`/`safeIgnoredArgs`/`safeListUnreadable`/`safeMenuLabels`/`safeGuideIntro` 等键）、`runSafeSession` 填充非 TTY 分支
- Test: `scripts/verify-safe-mode.mjs`

**Interfaces:**
- Consumes: `runDoctorChecks()`（Task 1）
- Produces: `const readProfileInventory = () => { error?: 'missing'|'fields', bundles?: string[], deps?: string[] }`、`const renderSafeReport = () => string[]`（标题+诊断+清单+指引的行数组，交互与非交互共用）——Task 5 菜单复用

- [ ] **Step 1: 写失败断言（零环境降级 + 只读快照 + 清单矩阵 + 忽略参数提示）**

在 verify-safe-mode.mjs 的 fallback 块后插入：

```js
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

// --- 插件清单解析矩阵（伪 profile 根 package.json）------------------------------
{
  const invHome = join(tmp, 'inv-home')
  const mk = pkgJson => {
    rmSync(invHome, { recursive: true, force: true })
    mkdirSync(invHome, { recursive: true })
    if (pkgJson !== null) writeFileSync(join(invHome, 'profiles', 'dsh-tui', 'package.json') .slice(0, 0) ?? '', '')
    return invHome
  }
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
```

注意上面 `mk` 辅助函数未被使用（各用例直接建目录），实现时删除 `mk` 定义，只保留四个用例块。

- [ ] **Step 2: 运行确认失败**

Run: `node scripts/verify-safe-mode.mjs`
Expected: 新增 safe 断言全部 FAIL（safe 尚不存在——现在 `safe` 会走透传路径在无 dsh 沙箱以 noDsh 告终，status !== 0）

- [ ] **Step 3: MSG 表新增 safe 文案键（插在 `safeHint` 之后）**

```js
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
  safeMenuLabels: {
    en: {
      retry: 'Retry normal startup',
      doctor: 'Run environment diagnostics',
      inventory: 'Show profile plugin inventory (read-only)',
      guide: 'Show repair command guidance',
      exit: code => `Exit (exit code ${code})`,
      prompt: 'safe> ',
      invalid: 'Invalid choice — enter 1-5:',
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
      exit: code => `退出（退出码 ${code}）`,
      prompt: 'safe> ',
      invalid: '无效选择——请输入 1-5：',
      bundlesHeader: '组合层（dsh.profile.bundles，有序）：',
      depsHeader: '直接依赖（第三方为可卸载候选）：',
      builtin: '内置',
      third: '第三方',
    },
  },
```

- [ ] **Step 4: 实现清单/指引/报告渲染与 safe 截获块**

在 `runDoctorChecks` 之后加入：

```js
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
  const inv = readProfileInventory()
  if (inv.error) {
    lines.push(msg('safeListUnreadable')(inv.error === 'missing' ? 'package.json 缺失或损坏' : '必需字段缺失或类型错误'))
    return
  }
  lines.push(L.bundlesHeader)
  for (const b of inv.bundles) lines.push(`  · ${b}  (${L.builtin})`)
  lines.push(L.depsHeader)
  for (const d of inv.deps) lines.push(`  · ${d}  (${PROTECTED_PLUGINS.has(d) ? L.builtin : L.third})`)
}
const renderGuide = lines => {
  const L = msg('safeMenuLabels')
  lines.push(msg('safeGuideIntro'))
  const inv = readProfileInventory()
  const third = inv.error ? [] : inv.deps.filter(d => !PROTECTED_PLUGINS.has(d))
  if (third.length > 0) {
    lines.push(`  # 卸载第三方插件（逐个执行）:`)
    for (const d of third) lines.push(`  dsh plugin --profile ${PROFILE} remove ${d}`)
  } else {
    lines.push(`  # 无第三方直接依赖可卸载`)
  }
  lines.push(`  # 重装/对齐 TUI（版本见 dsh-tui doctor）:`)
  lines.push(`  dsh plugin --profile ${PROFILE} add ${PACKAGE}@<版本>`)
  lines.push(`  # 环境诊断:`)
  lines.push(`  dsh-tui doctor`)
  lines.push(`  # 启动器过旧时的全局升级:`)
  lines.push(`  npm install -g --legacy-peer-deps ${PACKAGE}@<版本>`)
}
const renderSafeReport = extraLines => {
  const lines = []
  lines.push(msg('safeTitle')(runningInsideProfile ? 'profile' : 'launcher'))
  for (const l of extraLines ?? []) lines.push(l)
  const { lines: doctorLines } = runDoctorChecks()
  for (const l of doctorLines) lines.push(l)
  lines.push(msg('safeMenuLabels').bundlesHeader.replace('（.*）', '') === '' ? '' : '')
  renderInventory(lines)
  renderGuide(lines)
  return lines.filter(l => l !== '')
}
```

删除上面 `renderSafeReport` 里那行无意义的占位表达式（`lines.push(...replace...)`），最终实现为：标题 → extraLines → doctor 行 → 清单行 → 指引行，直接顺序拼接。

safe 截获块（插在 doctor 截获块之后、update 截获块之前）：

```js
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
```

`runSafeSession` 的非 TTY 分支此刻不会到达（截获块已分流），但为 Task 5 预留 `extraLines` 参数。

- [ ] **Step 5: 运行验证**

Run: `node scripts/verify-safe-mode.mjs`
Expected: `ALL PASS`（全部清单矩阵 + 只读快照 + 双语 + 忽略参数断言绿）

- [ ] **Step 6: 运行既有回归**

Run: `node scripts/verify-cli-subcommands.mjs && node scripts/verify-launcher.mjs`
Expected: 均 `ALL PASS`（`verify-cli-subcommands.mjs:233-245` 的"后位不截获"用例需要补一个 `'后位 safe', ['/no/such/path', 'safe']` 条目——见 Step 7）

- [ ] **Step 7: 在 verify-cli-subcommands.mjs 的后位不截获矩阵补 safe 行**

```js
    ['后位 safe', ['/no/such/path', 'safe']],
```

Run: `node scripts/verify-cli-subcommands.mjs`
Expected: `ALL PASS`

- [ ] **Step 8: Commit**

```bash
git add bin/dsh-tui.js scripts/verify-safe-mode.mjs scripts/verify-cli-subcommands.mjs
git commit -m "feat(launcher): add dsh-tui safe entry with non-TTY degraded report and plugin inventory"
```

---

### Task 5: readline 菜单 + 重试重放 + 终端交接

**Files:**
- Modify: `bin/dsh-tui.js`：`runSafeSession` 填充菜单实现、`bin/dsh-tui.js:36-43` Windows 旧二进制清理加 safe 守卫
- Test: `scripts/verify-safe-mode.mjs`（可无 PTY 验证的部分：safe 在非 TTY 不进菜单；交互逻辑列入手动演练）

**Interfaces:**
- Consumes: Task 3 `askSafeEntry`/`isInteractive`/`restoreTerminalMinimal`/`startDshSession`、Task 4 `renderSafeReport`/`runDoctorChecks`/`renderInventory`/`renderGuide`
- Produces: 完整 `runSafeSession({ pendingExitCode, retryDsh, extraLines }) => Promise<number>`

- [ ] **Step 1: 写失败断言（能自动验证的部分）**

verify-safe-mode.mjs 追加：

```js
// --- 菜单交互边界（非 TTY 不进交互；PTY 子集见文件尾说明）-----------------------
{
  const r = run(['safe'], { DSH_HOME: join(tmp, 'safe-home') })
  check('safe: 非 TTY 不进入交互菜单（无 safe> 提示符）', r.status === 0 && !r.stdout.includes('safe>'))
}
```

Run: `node scripts/verify-safe-mode.mjs` → 此条应已 PASS（Task 4 的分流保证），作为守卫断言保留。

- [ ] **Step 2: 实现 runSafeSession 菜单**

替换 `runSafeSession`（Task 3 桩）：

```js
// safe 会话：交互菜单（fallback 承接与手动入口共用）。返回最终进程退出码。
// 终端所有权三阶段（spec §6.2）：菜单态 readline 持有输入；重试前以
// handingOff 标志主动关闭（区别于用户取消——只有用户取消等价动作 5）；
// 重试结束后重建 readline。防死循环：询问只发生在外层首次非零退出，
// 菜单内重试失败回菜单显示结果，不自动重试。
const runSafeSession = async ({ pendingExitCode = 0, retryDsh, extraLines } = {}) => {
  const L = msg('safeMenuLabels')
  let exitCode = pendingExitCode
  const readline = (await import('node:readline/promises')).default
  const doctorLines = () => runDoctorChecks().lines
  const printMenu = () => {
    console.log(msg('safeTitle')(runningInsideProfile ? 'profile' : 'launcher'))
    for (const l of extraLines ?? []) console.log(l)
    for (const l of doctorLines()) console.log(l)
    console.log(`  1) ${L.retry}`)
    console.log(`  2) ${L.doctor}`)
    console.log(`  3) ${L.inventory}`)
    console.log(`  4) ${L.guide}`)
    console.log(`  5) ${L.exit(exitCode)}`)
  }
  const askChoice = async () => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    const state = { cancelled: false, handingOff: false }
    rl.on('SIGINT', () => { if (!state.handingOff) { state.cancelled = true; rl.close() } })
    let value = ''
    try { value = await rl.question(L.prompt) } catch { state.cancelled = true }
    if (!state.cancelled && !state.handingOff) { try { rl.close() } catch { /* 已关闭 */ } }
    return { cancelled: state.cancelled || value === undefined, value: String(value ?? '').trim() }
  }
  // 无效输入重提示上限 3 次，之后重印完整菜单继续等待；有效选择后计数重置。
  const INVALID_LIMIT = 3
  for (;;) {
    printMenu()
    let invalid = 0
    let choice = ''
    for (;;) {
      const { cancelled, value } = await askChoice()
      if (cancelled) { choice = '5'; break }
      if (['1', '2', '3', '4', '5'].includes(value)) { choice = value; break }
      invalid++
      if (invalid >= INVALID_LIMIT) break
      console.log(L.invalid)
    }
    if (choice === '1') {
      if (typeof retryDsh !== 'function') {
        console.log(msg('safeListUnreadable')('no-retry-from-manual-entry') === '' ? '' : L.retry + ': ' + (msg('safeIgnoredArgs')(0) === '' ? '' : 'cold start'))
        // 手动入口的冷启动重试：无已规范化 args，按空参数冷启动；同样
        // 受 profileReady 前置约束（spec §4：不得隐式自举）。
        if (!profileReady()) { console.error(msg('safeListUnreadable')('profile-not-ready')); continue }
        const result = await startDshSession([])
        if (result.kind === 'exit' && result.code === 0) return 0
        if (result.kind === 'exit') { exitCode = result.code; console.error(msg('profileExited')(result.code)); continue }
        if (result.kind === 'signal') { console.error(`[dsh-tui] retry signaled: ${result.signal}`); continue }
        console.error(msg('launchFailed')(result.error)); continue
      }
      if (!profileReady()) { console.error(msg('safeListUnreadable')('profile-not-ready')); continue }
      const result = await retryDsh()
      if (result.kind === 'exit' && result.code === 0) return 0
      if (result.kind === 'exit') { exitCode = result.code; console.error(msg('profileExited')(result.code)); continue }
      if (result.kind === 'signal') { console.error(`[dsh-tui] retry signaled: ${result.signal}`); continue }
      console.error(msg('launchFailed')(result.error)); continue
    }
    if (choice === '2') { for (const l of doctorLines()) console.log(l); continue }
    if (choice === '3') { const lines = []; renderInventory(lines); for (const l of lines) console.log(l); continue }
    if (choice === '4') { const lines = []; renderGuide(lines); for (const l of lines) console.log(l); continue }
    return exitCode
  }
}
```

实现时把上面 `'1'` 分支里第一行的占位三元表达式删除，并在分支开头直接区分两种来源打印一行提示：`L.retry + ' (replay)'`（fallback 来源）或 `L.retry + ' (cold start)'`（手动来源），其余逻辑照抄。两个 retryDsh 来源的结果结算逻辑完全一致，实现时可提取局部 `settleRetry(result)` 避免复制。

- [ ] **Step 3: Windows 旧二进制清理加 safe 守卫（spec §4：safe 入口跳过旧文件清理）**

`bin/dsh-tui.js:36` 的条件从：

```js
if (process.platform === 'win32' && process.env.DSH_TUI_STANDALONE_BINARY) {
```

改为：

```js
if (process.platform === 'win32' && process.env.DSH_TUI_STANDALONE_BINARY && process.argv[2] !== 'safe') {
```

- [ ] **Step 4: 运行全部回归**

Run: `node scripts/verify-safe-mode.mjs && node scripts/verify-launcher.mjs && node scripts/verify-cli-subcommands.mjs`
Expected: 均 `ALL PASS`

- [ ] **Step 5: 手动演练（spec §8 要求，PTY 自动化依赖外部原生模块时以本清单兜底）**

在真实终端逐项演练并记录到 PR 描述：①`dsh-tui safe` 全菜单动作 1-5；②人为制造非零退出（`DSH_STUB_EXIT` 手法或临时改 profile）观察 fallback 询问 Y/n/回车/Ctrl+C/EOF；③重试失败回菜单、重试成功退出 0；④fullscreen 模式下杀进程后进菜单的可读性（最小终端恢复）；⑤窄终端（60 列）排版。

- [ ] **Step 6: Commit**

```bash
git add bin/dsh-tui.js scripts/verify-safe-mode.mjs
git commit -m "feat(launcher): interactive safe menu with replay retry and terminal handoff"
```

---

### Task 6: helpText、README 双语、CI 登记、全量回归

**Files:**
- Modify: `bin/dsh-tui.js`（MSG `helpText` 两条各加 safe 行）、`README.md`、`README_EN.md`、`scripts/run-ci-group.mjs`
- Test: 全部三个 verify 脚本

**Interfaces:**
- Consumes: 前序全部产出
- Produces: 无代码接口，交付文档与 CI 接线

- [ ] **Step 1: helpText 补 safe 行**

在 MSG `helpText` 的 zh/en 两版子命令列表中，doctor 行之后各加一行（对齐现有缩进与措辞风格，如 zh：`  safe                安全模式：只读诊断、插件清单与修复指引`；en 对应 `safe   safe mode: read-only diagnostics, inventory, repair guidance`）。

- [ ] **Step 2: README 双语小节**

`README.md` 与 `README_EN.md` 在既有命令/故障排查章节附近加入对等小节（双语语义等价，对照 `verify-launcher.mjs` 双语断言的严谨度自查）。内容要点：双入口（`dsh-tui safe` 手动；异常退出后自动询问——仅交互终端，脚本/管道环境只追加一行提示且退出码保真）；控制面只读边界与"重试正常启动"例外（重试不自举，profile 不完整时给出重装指引）；覆盖边界=最终 dsh 子进程的非零退出码，不含启动挂起；旧全局启动器场景（profile 副本不可读/过旧时先升级启动器：`npm install -g --legacy-peer-deps @deepseek-harness-tui/dsh-tui@<版本>`）；修复命令示例（remove 第三方插件 / add 重装 / doctor）。

- [ ] **Step 3: CI 登记**

`scripts/run-ci-group.mjs` 在 `verify-cli-subcommands` 条目（约 185 行附近）之后按既有格式加入：

```js
// 安全模式回归（PR① spec）：safe 子命令零环境可用与非 TTY 降级、
// 控制面只读（文件系统快照）、插件清单解析矩阵、fallback 触发矩阵
// （非 TTY）、doctor 提取行为等价（完整期望值 golden）。
    ["verify-safe-mode", ['node', 'scripts/verify-safe-mode.mjs']],
```

- [ ] **Step 4: 全量回归**

Run: `node scripts/verify-safe-mode.mjs && node scripts/verify-launcher.mjs && node scripts/verify-cli-subcommands.mjs && node scripts/run-ci-group.mjs --list 2>/dev/null || node -e "import('./scripts/run-ci-group.mjs')"`
Expected: 三个 verify 均 `ALL PASS`；run-ci-group 能列出 `verify-safe-mode`（若该脚本无 --list/直跑入口，则以读源码确认登记项格式正确为验收）

- [ ] **Step 5: Commit**

```bash
git add bin/dsh-tui.js README.md README_EN.md scripts/run-ci-group.mjs
git commit -m "docs(launcher): document safe mode and register verify-safe-mode in CI"
```

---

## Self-Review 记录

- **Spec 覆盖**：spec §3.1（截获/单文件/兼容/参数消费）→ Task 4/5；§4（只读边界四条）→ Task 4 快照断言 + Task 5 profileReady 前置 + Task 5 Step 3 清理守卫；§5.1 结果模型表 → Task 2/3/5；§5.2 追加提示 → Task 3；§5.3 重放与 LAUNCHER_VERSION 不重设 → Task 2 `firstArgs` + Task 5 重试不经首启路径；§6.1 菜单五动作与两维度清单 → Task 4/5；§6.2 交互/降级/三阶段 → Task 3（询问）+ Task 4（非 TTY）+ Task 5（菜单/交接/最小恢复）；§7.1-7.4 → Task 1/2/3/4/6；§8 测试七组 → Task 1（doctor golden）/3（fallback 矩阵+信号）/4（零环境+快照+清单矩阵+双语+忽略参数）/5（非 TTY 守卫+手动演练清单+PTY 兜底说明）/6（CI 登记、既有断言更新）；PTTY 依赖探测与"跳过须报告"在 Task 5 Step 5 手动演练清单承接。§8.6 双角色真实 profile 内运行：`verify-launcher.mjs:251` 的 `placeProfileBin` 夹具把真实 bin 放入假 profile 后以 `runBin(..., { delegating: true })` 驱动——本计划未新增该场景断言，**补充**：Task 4 Step 7 已在既有脚本补后位不截获；真实 profile 内 safe 运行依赖手动演练①覆盖（`dsh-tui safe` 在 repo 源码目录运行即 profile/源码角色）。若需自动化，可在 verify-launcher 的 delegating 夹具上补 `runBin(['safe'])` 断言——列为执行时可选增强，不阻塞。
- **占位符扫描**：Task 4 Step 4 与 Task 5 Step 2 中明确标注"实现时删除占位表达式"的两处是给执行者的去噪指令，最终代码不得含它们；其余步骤代码完整。
- **类型一致性**：`DshResult` 三态在 Task 2 定义、Task 3 `settleFirstResult` 与 Task 5 菜单消费一致；`runSafeSession` 签名在 Task 3（桩）→ Task 4（`extraLines` 参数预留）→ Task 5（最终版）保持 `{ pendingExitCode, retryDsh, extraLines }`；`readProfileInventory` 返回 `{ error } | { bundles, deps }` 在 Task 4 定义并被 `renderInventory`/`renderGuide` 消费。
