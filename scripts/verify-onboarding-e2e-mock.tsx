/**
 * verify-onboarding-e2e-mock — 引导（Onboarding）R1/R2 的**端到端**回归，
 * provider API 全程打本地回环 mock（`scripts/lib/mock-provider-api.mjs`）。
 *
 * 钉住两件事（PR #1647 维护者 review 的 R1/R2）：
 *
 *   R1 动作归属：`runProviderAction` 在 `await channel.listModels()` **之前**
 *      建立动作归属；关闭/卸载/新动作作废旧请求；目录返回后先验归属再写基线
 *      与启动。断言按维护者复现时序：延迟目录读取 → Esc 卸载 → draft 已清空 →
 *      释放 Promise → **不得**调用登录、**不得**写回旧 draft。
 *   R2 窗口化：80×24 + 30 个模型时，焦点行必须在视口内；且不能只是"行在屏幕
 *      外但 Space/Enter 仍然落了 `switchModel`"。
 *
 * 渲染是真的：真 Ink（`src/ui.ts` 的 render）+ headless xterm 解析真输出，
 * 挂的是真的 `Onboarding`。网络是真的 HTTP，但只打到 127.0.0.1 的 mock——
 * `globalThis.fetch` 被包了守卫，任何非回环请求直接抛错并记账。
 *
 * 运行：node --import tsx/esm scripts/verify-onboarding-e2e-mock.tsx
 * 退出码：0 = 全过；1 = 有失败（RED 阶段预期为 1）。
 */
process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_THEME = 'dark'
process.env.DSH_TUI_LANG = 'zh'

import { PassThrough, Writable } from 'node:stream'
import React from 'react'
import xterm from '@xterm/headless'
import fakeHome from './lib/fake-home.mjs' // 必须最先：DATA_DIR 在 import 时定死
import { settle, settled, viewportLines } from './lib/term-test.mjs'
import { startMockProviderApi } from './lib/mock-provider-api.mjs'

const { Terminal: XTerm } = xterm
const [
  { render, ThemeProvider, AlternateScreen },
  { Onboarding },
  draftModule,
] = await Promise.all([
  import('../src/ui.js'),
  import('../src/screens/Onboarding.js'),
  import('../src/onboardingDraft.js'),
])
const { readOnboardingDraft, clearOnboardingDraft } = draftModule

// ── 真实网络守卫：只有 127.0.0.1 的 mock 可以走 ──────────────────────────
const realFetch = globalThis.fetch
const offLoopback: string[] = []
globalThis.fetch = (async (input, init) => {
  const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : String(input.url)
  if (!/^http:\/\/127\.0\.0\.1:\d+(?:\/|$)/u.test(raw)) {
    offLoopback.push(raw)
    throw new Error(`real network is forbidden in this regression: ${raw}`)
  }
  return realFetch(input, init)
}) as typeof fetch

let failures = 0
let checks = 0
function check(name: string, ok: boolean, detail = ''): void {
  checks += 1
  if (ok) console.log(`ok   ${name}`)
  else {
    failures += 1
    console.error(`FAIL ${name}${detail === '' ? '' : `\n      ${detail}`}`)
  }
}

const CWD = '/tmp/verify-onboarding-e2e'
const INITIAL = [{ provider: 'deepseek', id: 'deepseek-chat', name: 'deepseek-chat' }]
const XAI_MODELS = Array.from({ length: 30 }, (_, index) => ({
  provider: 'xai',
  id: `model-${index}`,
  name: `xai-model-${String(index).padStart(2, '0')}`,
}))
const oauthRow = (provider: string) => ({
  provider, label: provider, oauthLabel: provider,
  loginLabel: undefined, signedIn: false, expiresAt: undefined, expired: false,
})

/** 桩 channel：真形状（踩过：balances 是数组、listEfforts 回对象、字段叫 name）。 */
function makeChannel(over: Record<string, unknown> = {}) {
  const calls: string[] = []
  const channel = {
    calls,
    cwd: CWD,
    displayCwd: '~/verify-onboarding-e2e',
    model: 'deepseek-chat',
    provider: 'deepseek',
    reasoningEffort: 'high',
    describeCredential: async (name: string) => {
      calls.push('describeCredential:' + name)
      return { configured: false, source: 'none', writable: true }
    },
    balanceInfo: async () => {
      calls.push('balanceInfo')
      return { ok: true, isAvailable: true, balances: [{ currency: 'CNY', total: 110 }] }
    },
    listModels: async () => INITIAL,
    listProviders: async () => [{ id: 'deepseek', name: 'DeepSeek' }],
    listEfforts: async () => ({ efforts: [{ id: 'high', name: 'High' }], defaultEffort: 'high' }),
    listWorkspaces: async () => [{ cwd: CWD, label: 'verify-onboarding-e2e' }],
    setEffort: async (id: string) => { calls.push('setEffort:' + id); return true },
    switchModel: async (provider: string, id: string) => {
      calls.push('switchModel:' + provider + '/' + id)
      return true
    },
    switchWorkspace: async (target: { cwd: string }) => {
      calls.push('switchWorkspace:' + target.cwd)
      return true
    },
    oauthProviderStatuses: async () => [oauthRow('xai')],
    providerSetup: () => ({ oauth: {} }),
    ...over,
  }
  return channel
}

interface Ev { type: string; value?: unknown }

class FakeStdout extends Writable {
  isTTY = true
  readonly painted: string[] = []
  constructor(private readonly terminal: InstanceType<typeof XTerm>) { super() }
  get columns(): number { return this.terminal.cols }
  get rows(): number { return this.terminal.rows }
  _write(chunk: unknown, _encoding: BufferEncoding, callback: () => void): void {
    this.painted.push(String(chunk))
    this.terminal.write(String(chunk), callback)
  }
}
class FakeStderr extends Writable {
  isTTY = true
  _write(_c: unknown, _e: BufferEncoding, callback: () => void): void { callback() }
}
class FakeStdin extends PassThrough {
  isTTY = true
  setRawMode(): this { return this }
  override ref(): this { return this }
  override unref(): this { return this }
}

interface OpenOptions {
  columns?: number
  rows?: number
  channel?: ReturnType<typeof makeChannel>
  signIn?: (provider: string) => Promise<'added' | 'updated' | 'deleted' | 'signed-out' | 'cancelled' | 'failed'>
}

async function openWizard(events: Ev[], options: OpenOptions = {}) {
  const columns = options.columns ?? 120
  const rows = options.rows ?? 40
  const channel = options.channel ?? makeChannel()
  clearOnboardingDraft()
  const term = new XTerm({ cols: columns, rows, scrollback: 0, allowProposedApi: true })
  const out = new FakeStdout(term)
  const input = new FakeStdin()
  const app = await render(
    <ThemeProvider theme="dark">
      <AlternateScreen>
        <Onboarding
          channel={channel as never}
          initialStep={0}
          onProviderSignIn={options.signIn}
          onProviderAddProvider={undefined}
          onClose={(outcome) => { events.push({ type: 'close', value: outcome }) }}
          onRunCommand={(name) => { events.push({ type: 'runCommand', value: name }) }}
          onApplyLang={(lang) => { events.push({ type: 'applyLang', value: lang }) }}
        />
      </AlternateScreen>
    </ThemeProvider>,
    {
      stdin: input as never,
      stdout: out as never,
      stderr: new FakeStderr() as never,
      exitOnCtrlC: false,
      patchConsole: false,
    },
  )
  const screen = () => viewportLines(term).join('\n')
  /** 写一个按键，等这一帧真的重画（上限 250ms）。 */
  const send = async (data: string): Promise<void> => {
    const before = out.painted.length
    input.write(data)
    await settle(() => out.painted.length > before, { timeoutMs: 250 })
  }
  return {
    term, channel, screen, send,
    close: () => { app.unmount() },
  }
}

/** 走到"接入动作行"：第一步（access）+ 有 oauth 缝。 */
async function toActionRows(wizard: Awaited<ReturnType<typeof openWizard>>): Promise<boolean> {
  return settled(() => wizard.screen().includes('登录订阅账号'), { timeoutMs: 8000 })
}

/** 动作行 → 账号选择 → 发起登录（第二下 Enter 才真正调 start()）。 */
async function startSignInAction(wizard: Awaited<ReturnType<typeof openWizard>>): Promise<boolean> {
  await wizard.send('\r')
  const signin = await settled(() => wizard.screen().includes('选择要登录的账号'), { timeoutMs: 8000 })
  await wizard.send('\r')
  return signin
}

// ── 进程级 pty 模式（父进程用 util-linux `script` 起真 pty 调用本模式） ─────
async function runPtyMode(): Promise<void> {
  const [ui, onboarding] = await Promise.all([
    import('../src/ui.js'),
    import('../src/screens/Onboarding.js'),
  ])
  const channel = makeChannel({
    oauthProviderStatuses: async () => [oauthRow('xai')],
    providerSetup: () => ({ oauth: {} }),
  })
  const app = await ui.render(
    <ui.ThemeProvider theme="dark">
      <onboarding.Onboarding
        channel={channel as never}
        initialStep={0}
        onProviderSignIn={async () => 'added'}
        onClose={(outcome) => {
          app.unmount()
          process.stdout.write(`\nPTY-CLOSE:${outcome}\n`)
          setTimeout(() => process.exit(0), 120)
        }}
        onRunCommand={() => {}}
        onApplyLang={() => {}}
      />
    </ui.ThemeProvider>,
    { exitOnCtrlC: false, patchConsole: false },
  )
  // 真 pty 下由父进程写 Esc；这里保持进程存活。
  await new Promise(() => {})
}
if (process.argv.includes('--pty')) {
  await runPtyMode()
}

// ── R1：关闭/卸载后迟到的目录读取不得启动动作、不得写回 draft ──────────────
{
  const mock = await startMockProviderApi({ models: XAI_MODELS })
  // 目录读取按"期"控制，不按调用次数：挂载期的连通性读取可能跑多次（
  // checkNonce/catalogNonce 的重跑），用次数当判据会把挂载读错认成动作读。
  let catalog: readonly { provider: string; id: string; name: string }[] = INITIAL
  let deferNext = false
  let releaseDeferred: (() => void) | undefined
  const signInCalls: string[] = []
  const channel = makeChannel({
    listModels: async () => {
      if (!deferNext) return catalog
      deferNext = false
      return new Promise(resolve => { releaseDeferred = () => resolve(catalog) })
    },
  })
  const ev: Ev[] = []
  const wizard = await openWizard(ev, {
    channel,
    signIn: async (provider: string) => {
      signInCalls.push(provider)
      await mock.signIn(provider)
      return 'added'
    },
  })
  const ready = await toActionRows(wizard)
  check('R1 前置：动作行出现（登录订阅账号）', ready, wizard.screen().slice(0, 300))
  // 先把"下一次目录读取"标记为动作里的那一次，再按两下 Enter 发起登录。
  await wizard.send('\r')
  const signinPhase = await settled(() => wizard.screen().includes('选择要登录的账号'), { timeoutMs: 8000 })
  check('R1 前置：已进入账号选择子层', signinPhase, wizard.screen().slice(0, 300))
  deferNext = true
  await wizard.send('\r')
  const blocked = await settled(() => releaseDeferred !== undefined, { timeoutMs: 8000 })
  check('R1 前置：动作里的目录读取已被卡住（复现维护者时序，动作已发起）', blocked,
    `releaseDeferred=${releaseDeferred !== undefined}`)

  // 维护者时序：目录读取还没回来时 Esc 退出（finish 清 draft），屏幕卸载；
  // 随后那个迟到的 Promise 才被放行。
  await wizard.send('\u001b')
  const closed = await settled(() => ev.some(e => e.type === 'close' && e.value === 'skipped'), { timeoutMs: 8000 })
  check('R1 前置：Esc 已退出引导（skipped）', closed, JSON.stringify(ev))
  wizard.close()
  const draftCleared = readOnboardingDraft() === undefined
  check('R1 前置：退出后 draft 已清空', draftCleared, JSON.stringify(readOnboardingDraft()))

  releaseDeferred?.()
  // 固定窗:探针 断言"关闭之后不得再发起动作/写回 draft"：没有可轮询的完成条件，
  // 迟到的 Promise 是否触发副作用本身就是被测不变量，只能等一个观察窗再断言。
  await new Promise(resolve => setTimeout(resolve, 500))

  check('R1a 关闭后迟到的目录读取不得调用登录（signIn 零次）', signInCalls.length === 0,
    `signInCalls=${JSON.stringify(signInCalls)}`)
  check('R1b 关闭后不得写回旧 draft（draft 仍为空）', readOnboardingDraft() === undefined,
    JSON.stringify(readOnboardingDraft()))
  check('R1c mock 上没有发生登录（没有 authorize/token 请求）', !mock.signedIn,
    JSON.stringify(mock.requests.map(request => request.url)))
  check('R1d 全程没有发往非回环地址的请求', offLoopback.length === 0, JSON.stringify(offLoopback))
  await mock.close()
}

// ── R1-b：两单并发时，先返回的旧单不得 start、不得写 draft ─────────────────
{
  const mock = await startMockProviderApi({ models: XAI_MODELS })
  let deferNext = false
  let releaseA: (() => void) | undefined
  let releaseB: (() => void) | undefined
  const signInCalls: string[] = []
  const catalog = INITIAL
  const channel = makeChannel({
    listModels: async () => {
      if (!deferNext) return catalog
      deferNext = false
      return new Promise<void>(resolve => {
        if (releaseA === undefined) releaseA = resolve
        else releaseB = resolve
      }).then(() => catalog)
    },
  })
  const ev: Ev[] = []
  const wizard = await openWizard(ev, {
    channel,
    signIn: async (provider: string) => {
      signInCalls.push(provider)
      await mock.signIn(provider)
      return 'added'
    },
  })
  check('R1b 前置：动作行出现', await toActionRows(wizard))

  // 第一单：目录读取卡住。
  await wizard.send('\r')
  await settled(() => wizard.screen().includes('选择要登录的账号'), { timeoutMs: 8000 })
  deferNext = true
  await wizard.send('\r')
  await settled(() => releaseA !== undefined, { timeoutMs: 8000 })
  check('R1b 前置：第一单已发起且目录读取被卡住', releaseA !== undefined)

  // 第二单：回到动作行再发起一单，也卡住它的目录读取。
  await wizard.send('\r')
  await settled(() => wizard.screen().includes('选择要登录的账号'), { timeoutMs: 8000 })
  deferNext = true
  await wizard.send('\r')
  await settled(() => releaseB !== undefined, { timeoutMs: 8000 })
  check('R1b 前置：第二单已发起且目录读取被卡住', releaseB !== undefined)

  // 先放第一单（旧单）：它的归属已经被第二单覆盖。
  releaseA?.()
  // 固定窗:探针 断言"旧单迟到的回调不得产生副作用"：没有可轮询的完成条件。
  await new Promise(resolve => setTimeout(resolve, 500))
  check('R1b-1 旧单迟到的目录读取不得启动登录', signInCalls.length === 0,
    `signInCalls=${JSON.stringify(signInCalls)}`)
  // 归属在内存 ref 里（批准方案：不要求 draft 在 await 前落盘），所以这里断言的是
  // 可观察后果：旧单迟到时 **不许往 draft 里写任何归属**（pending 与 completed 都不许出现）。
  const draftAfterOld = readOnboardingDraft()
  check('R1b-2 旧单迟到不得写 draft 归属（pending / completed 都不许出现）',
    draftAfterOld?.pending === undefined && draftAfterOld?.completed === undefined,
    JSON.stringify(draftAfterOld))

  // 再放第二单：它才是该结算的那一单。
  releaseB?.()
  const secondSettled = await settled(() => signInCalls.length === 1, { timeoutMs: 8000 })
  check('R1b-3 新单正常结算（signIn 恰好 1 次，属第二单）', secondSettled,
    JSON.stringify(signInCalls))
  wizard.close()
  await mock.close()
}

// ── R2：80×24 + 30 个模型，焦点行必须在视口内 ─────────────────────────────
{
  const mock = await startMockProviderApi({ models: XAI_MODELS })
  const signInCalls: string[] = []
  // 目录按"期"变：动作基线读到的仍是登录前的 1 个；登录成功后（结算读）变 31 个。
  let catalog: readonly { provider: string; id: string; name: string }[] = INITIAL
  const channel = makeChannel({ listModels: async () => catalog })
  const ev: Ev[] = []
  const wizard = await openWizard(ev, {
    columns: 80,
    rows: 24,
    channel,
    signIn: async (provider: string) => {
      signInCalls.push(provider)
      await mock.signIn(provider)
      catalog = [...INITIAL, ...XAI_MODELS]
      return 'added'
    },
  })
  const ready = await toActionRows(wizard)
  check('R2 前置：动作行出现（登录订阅账号）', ready, wizard.screen().slice(0, 300))
  await wizard.send('\r')
  await settled(() => wizard.screen().includes('选择要登录的账号'), { timeoutMs: 8000 })
  await wizard.send('\r')
  const adopt = await settled(() => wizard.screen().includes('xai-model-00'), { timeoutMs: 12000 })
  check('R2 前置：登录后进入采纳层，30 个新模型参与（首个可见）', adopt,
    wizard.screen().slice(0, 400))
  check('R2 前置：登录真的打了 mock（authorize→token）', mock.signedIn && signInCalls.length === 1,
    JSON.stringify(mock.requests.map(request => `${request.method} ${request.url}`)))

  // 焦点一路 ↓ 到最后一个模型（第 30 行）。每步等一帧重画当屏障。
  for (let index = 0; index < 29; index += 1) await wizard.send('\u001b[B')
  const focusVisible = await settled(() => wizard.screen().includes('xai-model-29'), { timeoutMs: 2000 })
  check('R2a 80×24 下焦点行（第 30 个模型）必须落在视口内', focusVisible,
    wizard.screen().split('\n').filter(line => line.trim() !== '').slice(0, 24).join(' / '))

  // 影响面：焦点行不可见时 Space/Enter 依然会落 switchModel —— 维护者实测的
  // "盲操作"路径。Tab 进默认区 → ↓ 到同一行 → Space 标记 → Enter 落盘。
  await wizard.send('\t')
  for (let index = 0; index < 29; index += 1) await wizard.send('\u001b[B')
  const defaultFocusVisible = await settled(() => wizard.screen().includes('xai-model-29'), { timeoutMs: 2000 })
  check('R2d 默认区（Tab 后）焦点行同样必须在视口内', defaultFocusVisible,
    wizard.screen().split('\n').filter(line => line.trim() !== '').slice(0, 24).join(' / '))
  await wizard.send(' ')
  await wizard.send('\r')
  const switched = await settled(
    () => wizard.channel.calls.some(call => call === 'switchModel:xai/model-29'),
    { timeoutMs: 6000 },
  )
  check('R2b 同一行 Space/Enter 真的落了 switchModel:xai/model-29（影响面证据）', switched,
    JSON.stringify(wizard.channel.calls))
  check('R2c 全程没有发往非回环地址的请求', offLoopback.length === 0, JSON.stringify(offLoopback))
  wizard.close()
  await mock.close()
}

// ── P：进程级 pty 全链路（真 pty，非等宽假终端） ─────────────────────────
{
  const { spawn } = await import('node:child_process')
  const entry = `${process.execPath} --import tsx/esm ${import.meta.dirname}/verify-onboarding-e2e-mock.tsx --pty`
  const child = spawn('script', ['-qec', entry, '/dev/null'], {
    env: { ...process.env, DSH_TUI_LANG: 'zh', FORCE_COLOR: '3' },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout.on('data', (chunk: Buffer) => { output += String(chunk) })
  child.stderr.on('data', (chunk: Buffer) => { output += String(chunk) })
  const rendered = await settled(() => output.includes('登录订阅账号'), { timeoutMs: 20000 })
  check('P1 真 pty 下真 Ink 渲染到接入动作行', rendered, output.slice(0, 300))
  const exitCodePromise = new Promise<number | null>(resolve => child.on('exit', code => resolve(code)))
  child.stdin.write('\u001b')
  const closed = await settled(() => output.includes('PTY-CLOSE:skipped'), { timeoutMs: 15000 })
  const exitCode = child.exitCode ?? (await exitCodePromise)
  check('P2 真 pty 下 Esc 交 skipped 并干净退出（exit 0）', closed && exitCode === 0,
    `exit=${String(exitCode)} closed=${closed}`)
  check('P3 pty 输出里没有崩溃栈', !/AssertionError|ERR_[A-Z]+|UnhandledPromiseRejection/u.test(output),
    output.slice(-500))
}

clearOnboardingDraft()
if (failures === 0) console.log(`\nverify-onboarding-e2e-mock: ${checks} checks, all passed`)
else console.error(`\nverify-onboarding-e2e-mock: ${failures} of ${checks} checks FAILED`)
process.exit(failures === 0 ? 0 : 1)
