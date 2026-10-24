/**
 * verify-onboarding-wizard — 首次运行引导（Onboarding）回归。
 *
 * 钉住的契约：
 *
 *   A. 骨架：四步各自渲染得出内容，头部进度是 `第 N / 4 步`；步骤条只在
 *      够宽够高时画（窄了整条撤，进度改由头部承担，信息不丢）。
 *   B. 第一步（apikey）：凭证只报"有没有"、余额串走 `formatBalance`、失败
 *      分类走 `connFailText`；Enter 是"重新检查"（再打一次 describeCredential）。
 *   C. 第二步（look）：两个面板（语言/主题）都在，Tab 在两个面板间切。
 *   D. 第三步（model）：Tab 依次走 模型 → 强度 → 工作区；模型区 Enter 先钻
 *      进 provider 分组、再 Enter 真的换模型（switchModel 带 provider+id）；
 *      强度区 ←/→ 落 `setEffort`、Enter 前进到工作区；工作区 Enter 开选择器、再 Enter 落
 *      `switchWorkspace`。
 *   E. 第四步（keys）：六张招式卡；没有命令的键位卡 Enter 不做事，命令卡
 *      Enter 走 `onRunCommand`（与手敲 `/help` 同一条路）。
 *   F. 出口：Esc 交 `skipped`，最后一步的 Enter 交 `done`——两条路分别对应
 *      `Chat` 的"不记账"与"记账"分支。
 *   J. 第一步的接入（v2）：动作行按接缝出现、缺接缝时给平台正确的兜底文案
 *      （不再有 `~/.deepseek/config.json`）；登录后按 0/1/N 三分支处理新模型
 *      （0 不问、1 直接设默认、多个进内联接入层选默认）；draft 让步骤在
 *      卸载-重挂后保持。
 *
 * 运行：node --import tsx/esm scripts/verify-onboarding-wizard.tsx
 */
process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_THEME = 'dark'
process.env.DSH_TUI_LANG = 'zh'

import { join } from 'node:path'
import { PassThrough, Writable } from 'node:stream'
import React from 'react'
import xterm from '@xterm/headless'
import fakeHome from './lib/fake-home.mjs' // 必须最先：DATA_DIR 在 import 时定死
import { settle, settled, viewportLines } from './lib/term-test.mjs'
import { stringWidth } from '../src/ink/stringWidth.js'
import { clearOnboardingDraft } from '../src/onboardingDraft.js'

const { Terminal: XTerm } = xterm
const [
  { render, ThemeProvider, AlternateScreen },
  { Onboarding },
  { ONBOARDING_STEPS, TUTORIAL_CARDS, STEP_BAR_MIN_COLUMNS, STEP_BAR_MIN_ROWS, formatBalance, connFailText },
] = await Promise.all([
  import('../src/ui.js'),
  import('../src/screens/Onboarding.js'),
  import('../src/components/onboardingModel.js'),
])

let failures = 0
let checks = 0
function check(name: string, ok: boolean, detail = ''): void {
  checks += 1
  if (ok) console.log(`ok   ${name}`)
  else {
    failures++
    console.error(`FAIL ${name}${detail === '' ? '' : `\n      ${detail}`}`)
  }
}

const COLS = 120
const ROWS = 40
const CWD = '/tmp/verify-onboarding'

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

const MODELS = [
  { provider: 'deepseek', id: 'deepseek-chat', name: 'deepseek-chat' },
  { provider: 'deepseek', id: 'deepseek-reasoner', name: 'deepseek-reasoner' },
]
const PROVIDERS = [{ id: 'deepseek', name: 'DeepSeek' }]
const EFFORTS = [{ id: 'high', name: 'High' }, { id: 'low', name: 'Low' }]
const WORKSPACES = [
  { cwd: CWD, label: 'verify-onboarding' },
  { cwd: '/tmp/other-workspace', label: 'other' },
]

/** 桩 channel：真形状（踩过：balances 是数组、listEfforts 回对象、字段叫 name）。 */
function makeChannel(over: Record<string, unknown> = {}) {
  const calls: string[] = []
  const channel = {
    calls,
    cwd: CWD,
    displayCwd: '~/verify-onboarding',
    model: 'deepseek-chat',
    provider: 'deepseek',
    reasoningEffort: 'high',
    describeCredential: async (name: string) => {
      calls.push('describeCredential:' + name)
      return { configured: true, source: 'env', writable: false }
    },
    balanceInfo: async () => {
      calls.push('balanceInfo')
      return { ok: true, isAvailable: true, balances: [{ currency: 'CNY', total: 110 }] }
    },
    listModels: async () => MODELS,
    listProviders: async () => PROVIDERS,
    listEfforts: async () => ({ efforts: EFFORTS, defaultEffort: 'high' }),
    listWorkspaces: async () => { calls.push('listWorkspaces'); return WORKSPACES },
    setEffort: async (id: string) => { calls.push('setEffort:' + id); return true },
    switchModel: async (provider: string, id: string) => {
      calls.push('switchModel:' + provider + '/' + id)
      return true
    },
    switchWorkspace: async (target: { cwd: string }) => {
      calls.push('switchWorkspace:' + target.cwd)
      return true
    },
    ...over,
  }
  return channel
}

interface Ev { type: string; value?: unknown }

interface OpenOptions {
  columns?: number
  rows?: number
  step?: number
  channel?: ReturnType<typeof makeChannel>
  /** 第一步的动作回调（不传 = 对应动作行不出现）。 */
  signIn?: (provider: string) => Promise<'added' | 'updated' | 'deleted' | 'signed-out' | 'cancelled' | 'failed'>
  addProvider?: () => Promise<'added' | 'updated' | 'deleted' | 'signed-out' | 'cancelled' | 'failed'>
  /** 保留上一个用例留下的 draft（默认每个用例都从干净状态开始）。 */
  keepDraft?: boolean
}

async function openWizard(events: Ev[], options: OpenOptions = {}) {
  const columns = options.columns ?? COLS
  const rows = options.rows ?? ROWS
  const channel = options.channel ?? makeChannel()
  // draft 是模块级单例：用例之间必须隔离，否则上一个用例的步骤会被下一个
  // 用例"恢复"（真实运行里它只服务于同一个引导会话的重挂）。
  if (options.keepDraft !== true) clearOnboardingDraft()
  const term = new XTerm({ cols: columns, rows, scrollback: 0, allowProposedApi: true })
  const out = new FakeStdout(term)
  const input = new FakeStdin()
  const app = await render(
    <ThemeProvider theme="dark">
      {/* 与 Chat 的非全屏分支同构：inline 模式下 ink 的第一帧会整体上移
          一行（表头被自己的重绘覆盖），套上 AlternateScreen 视口才是准的。 */}
      <AlternateScreen>
      <Onboarding
        channel={channel as never}
        initialStep={options.step}
        onProviderSignIn={options.signIn}
        onProviderAddProvider={options.addProvider}
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
  /**
   * 写一个按键，然后等**这一帧真的重画**（上限 250ms）。
   *
   * 两个都试过、都不行的写法：
   *   - 等「events / channel.calls 增量」：Tab、↑/↓、钻进分组这些键**合法地**什么都不
   *     产生 → 每次白等一个超时（本地 4s / CI 8s），整脚本 54s。
   *   - 只写不等待：同一 tick 写入的多个按键会被 ink 当成**一次数据事件**解析，两个键
   *     一起交给 handler，后一个读到的是**旧 state**（「先移焦点再回车」的用例假红）。
   * 等一次重画既是屏障（state 已提交、帧已画出），又不像前者那样白等满超时。
   */
  const send = async (data: string): Promise<void> => {
    const before = out.painted.length
    input.write(data)
    await settle(() => out.painted.length > before, { timeoutMs: 250 })
  }
  /** 真鼠标点击（SGR），等这一帧重画当屏障。 */
  const click = async (needle: string): Promise<void> => {
    await settled(() => findCell(term, needle) !== null)
    const found = findCell(term, needle)
    if (found === null) throw new Error('click target not on screen: ' + needle)
    const before = out.painted.length
    input.write(`\u001b[<0;${found.col};${found.row}M\u001b[<0;${found.col};${found.row}m`)
    await settle(() => out.painted.length > before, { timeoutMs: 400 })
  }
  const idle = async (): Promise<void> => { await settle(() => viewportLines(term).some(l => l.trim() !== '')) }
  return { term, channel, screen, send, click, idle, close: () => { app.unmount() } }
}

/** 目标文本的终端列号（双宽字符按显示宽度算；`findText` 给的是字符串下标）。 */
function findCell(term: InstanceType<typeof XTerm>, needle: string): { col: number; row: number } | null {
  const lines = viewportLines(term)
  for (let row = 0; row < lines.length; row++) {
    const at = lines[row]!.indexOf(needle)
    if (at >= 0) return { col: stringWidth(lines[row]!.slice(0, at)) + 1, row: row + 1 }
  }
  return null
}

const last = (events: readonly Ev[], type: string): Ev | undefined =>
  [...events].reverse().find(e => e.type === type)
const called = (channel: { calls: readonly string[] }, prefix: string): boolean =>
  channel.calls.some(c => c.startsWith(prefix))

// ── A. 骨架 ─────────────────────────────────────────────────────────────────
check('A1 步骤表就是四步（access/look/model/keys）',
  ONBOARDING_STEPS.length === 4 && ONBOARDING_STEPS[0] === 'access' && ONBOARDING_STEPS[3] === 'keys')
for (let step = 0; step < 4; step++) {
  const ev: Ev[] = []
  const w = await openWizard(ev, { step })
  const want = `第 ${step + 1} / 4 步`
  check(`A2.${step + 1} 第 ${step + 1} 步渲染出进度与正文`,
    await settled(() => w.screen().includes(want) && w.screen().trim().split('\n').length >= 5),
    w.screen().slice(0, 200))
  w.close()
}
{
  const ev: Ev[] = []
  const wide = await openWizard(ev, { step: 0 })
  check('A3 够宽时步骤条画出来（四步标题横排）',
    await settled(() => wide.screen().includes('账号与模型接入') && wide.screen().includes('快捷键与招式')))
  wide.close()
  const ev2: Ev[] = []
  const narrow = await openWizard(ev2, { step: 0, columns: STEP_BAR_MIN_COLUMNS - 8 })
  await narrow.idle()
  check('A4 窄终端：步骤条整条撤，但头部进度还在（信息不丢）',
    !narrow.screen().includes('账号与模型接入') && narrow.screen().includes('第 1 / 4 步'),
    narrow.screen().slice(0, 200))
  narrow.close()
  const ev3: Ev[] = []
  const short = await openWizard(ev3, { step: 0, rows: STEP_BAR_MIN_ROWS - 2 })
  await short.idle()
  check('A5 矮终端：步骤条同样整条撤（高度轴与宽度轴同一条规则）',
    !short.screen().includes('账号与模型接入') && short.screen().includes('第 1 / 4 步'),
    short.screen().slice(0, 160))
  short.close()
}

// ── B. 第一步：凭证与连通性 ──────────────────────────────────────────────────
{
  const ev: Ev[] = []
  const w = await openWizard(ev, { step: 0 })
  const want = formatBalance({ ok: true, isAvailable: true, balances: [{ currency: 'CNY', total: 110 }] } as never)
  check('B1 检测到的凭证环境变量名上屏（真名上屏、值绝不上屏）',
    await settled(() => w.screen().includes('DEEPSEEK_API_KEY')) && !w.screen().includes('sk-'),
    w.screen().slice(0, 160))
  check('B2 连通成功后余额按 formatBalance 的原样上屏',
    await settled(() => want !== null && w.screen().includes(want)), 'want=' + String(want))
  w.close()
}
{
  const ev: Ev[] = []
  const w = await openWizard(ev, {
    step: 0,
    channel: makeChannel({
      describeCredential: async () => ({ configured: false, writable: false }),
      balanceInfo: async () => ({ ok: false, reason: 'no-key' }),
    }),
  })
  const want = connFailText('no-key')
  check('B3 没配 key 时给出可执行的排查方向（connFailText 的口径）',
    await settled(() => w.screen().includes(want)), 'want=' + want)
  w.close()
}
{
  const ev: Ev[] = []
  const channel = makeChannel()
  const w = await openWizard(ev, { step: 0, channel })
  await settled(() => called(channel, 'describeCredential'))
  const first = channel.calls.filter(c => c.startsWith('describeCredential')).length
  await w.send('\r')
  check('B4 第一步的 Enter 是"重新检查"（再打一次 describeCredential）',
    await settled(() => channel.calls.filter(c => c.startsWith('describeCredential')).length > first),
    JSON.stringify(channel.calls))
  w.close()
}

// ── C. 第二步：语言 + 主题 ──────────────────────────────────────────────────
{
  const ev: Ev[] = []
  const w = await openWizard(ev, { step: 1 })
  check('C1 两个面板都在（语言 + 主题）',
    await settled(() => w.screen().includes('界面语言') && w.screen().includes('颜色主题')))
  check('C2 默认落在语言面板（语言清单可见）',
    await settled(() => w.screen().includes('中文') || w.screen().includes('English')))
  await w.send('\t')
  check('C3 Tab 切到主题面板', await settled(() => !w.screen().includes('English')))
  await w.send('\t')
  check('C4 再 Tab 切回语言面板', await settled(() => w.screen().includes('English')))
  await w.send('\u001b[B')
  await w.send('\r')
  check('C5 语言面板上 ↓ + Enter 真的应用语言（键盘路径，不是只有鼠标）',
    last(ev, 'applyLang')?.value === 'en', JSON.stringify(ev.slice(-3)))
  w.close()
}

// ── C-M. 第二步：鼠标路径（面板标签可点、列表行真的应用） ──────────────────
{
  const ev: Ev[] = []
  const w = await openWizard(ev, { step: 1 })
  await settled(() => w.screen().includes('界面语言') && w.screen().includes('English'))
  await w.click('颜色主题')
  check('CM1 点「颜色主题」标签切到主题面板（标签可点，不是只有 Tab）',
    await settled(() => w.screen().includes('dark-ansi') && !w.screen().includes('English')),
    w.screen().slice(0, 200))
  await w.click('light  █')
  check('CM2 点主题行真的应用主题（✓ 落到 light 行，dark 行失去 ✓）',
    (await settled(() => w.screen().split('\n').some(l => l.includes('light') && l.includes('✓'))
      && !w.screen().split('\n').some(l => l.includes('dark-ansi') && l.includes('✓')))),
    w.screen())
  await w.click('界面语言')
  check('CM3 点「界面语言」标签切回语言面板',
    await settled(() => w.screen().includes('English')), w.screen().slice(0, 200))
  await w.click('English')
  check('CM4 点语言行真的应用语言（onApplyLang 走鼠标路径）',
    await settled(() => last(ev, 'applyLang')?.value === 'en'), JSON.stringify(ev.slice(-3)))
  w.close()
}

// ── D. 第三步：模型 / 强度 / 工作区 ────────────────────────────────────────
{
  const ev: Ev[] = []
  const channel = makeChannel()
  const w = await openWizard(ev, { step: 2, channel })
  check('D1 provider 分组按注册表的 name 显示', await settled(() => w.screen().includes('DeepSeek')))
  await w.send('\r')
  check('D2 Enter 钻进分组，模型列表出来',
    await settled(() => w.screen().includes('deepseek-chat') || w.screen().includes('deepseek-reasoner')))
  await w.send('\u001b[B')
  await w.send('\r')
  check('D3 在模型上 Enter 真的换模型（provider + id 一起交给通道）',
    await settled(() => called(channel, 'switchModel:deepseek/')),
    JSON.stringify(channel.calls))
  w.close()
}
{
  const ev: Ev[] = []
  const channel = makeChannel()
  const w = await openWizard(ev, { step: 2, channel })
  await settled(() => w.screen().includes('DeepSeek'))
  await w.send('\t')
  await settled(() => w.screen().includes('High'))
  await w.send('\u001b[C')
  check('D4 Tab 到强度区，→ 落 setEffort（滑块移动即生效）',
    await settled(() => called(channel, 'setEffort:')), JSON.stringify(channel.calls))
  w.close()
}
{
  const ev: Ev[] = []
  const channel = makeChannel()
  const w = await openWizard(ev, { step: 2, channel })
  await settled(() => w.screen().includes('DeepSeek'))
  await w.send('\t')
  await w.send('\t')
  await w.send('\r')
  check('D5 再 Tab 到工作区，Enter 开门（按需拉一次 listWorkspaces）',
    await settled(() => called(channel, 'listWorkspaces')), JSON.stringify(channel.calls))
  await w.send('\u001b[B')
  await w.send('\r')
  check('D6 选择器里 Enter 落 switchWorkspace(那一行)',
    await settled(() => called(channel, 'switchWorkspace:')), JSON.stringify(channel.calls))
  w.close()
}

{
  const ev: Ev[] = []
  const channel = makeChannel()
  const w = await openWizard(ev, { step: 2, channel })
  await settled(() => w.screen().includes('DeepSeek'))
  await w.send('\t')
  await settled(() => w.screen().includes('High'))
  await w.send('\r')
  check('D7 强度滑块上的 Enter 不再是死键：前进到工作区（还没开门拉清单）',
    await settled(() => !called(channel, 'listWorkspaces')), JSON.stringify(channel.calls))
  await w.send('\r')
  check('D8 再一次 Enter 落在工作区上才开门（listWorkspaces 按需拉）',
    await settled(() => called(channel, 'listWorkspaces')), JSON.stringify(channel.calls))
  w.close()
}

{
  // 回归：模型分组曾硬截前 6 行，第 7 个及以后的 provider（用户实测漏掉的
  // deepseek-official）完全不可见。钉住的契约：列表按焦点窗口化（/model 同
  // 一条 listWindow 路），↓ 能把最后一个分组带进视口并被选中；窗口上下沿
  // 有 ▲/▼ 折叠提示。桩造 7 个 provider，不依赖真实配置。
  const MANY_PROVIDERS = Array.from({ length: 6 }, (_, i) => ({ id: 'stub-' + i, name: '桩分组 ' + i }))
    .concat([{ id: 'deepseek-official', name: 'DeepSeek 官方' }])
  const MANY_MODELS = MANY_PROVIDERS.map(pr => ({ provider: pr.id, id: pr.id + '-chat', name: pr.id + '-chat' }))
  const ev: Ev[] = []
  const channel = makeChannel({
    listModels: async () => MANY_MODELS,
    listProviders: async () => MANY_PROVIDERS,
  })
  const w = await openWizard(ev, { step: 2, channel })
  await settled(() => w.screen().includes('桩分组 0'))
  check('D11 分组超过 6 行时不再硬截：窗口下沿有 ↓ 折叠提示',
    w.screen().includes('\u2193') && !w.screen().includes('DeepSeek 官方'),
    w.screen().split('\n').filter(l => l.includes('桩分组') || l.includes('\u2193')).join(' / '))
  for (let i = 0; i < 6; i++) await w.send('\u001b[B')
  check('D12 ↓ 走到底：第 7 个分组（deepseek-official）被带进视口',
    await settled(() => w.screen().includes('DeepSeek 官方') && w.screen().includes('\u2191')),
    w.screen().split('\n').filter(l => l.trim() !== '').slice(0, 12).join(' / '))
  await w.send('\r')
  check('D9 在最后一个分组上 Enter 真的钻进去（catalog 型 provider 也可达）',
    await settled(() => w.screen().includes('deepseek-official-chat')), w.screen().slice(0, 200))
  await w.send('\r')
  check('D10 组内模型 Enter 照常落 switchModel(provider + id)',
    await settled(() => called(channel, 'switchModel:deepseek-official/')), JSON.stringify(channel.calls))
  w.close()
}

// ── E. 第四步：招式卡 ──────────────────────────────────────────────────────
{
  const ev: Ev[] = []
  const w = await openWizard(ev, { step: 3 })
  check('E1 六张卡都登记在表里，其中四张带命令',
    TUTORIAL_CARDS.length === 6 && TUTORIAL_CARDS.filter(c => c.command !== undefined).length === 4)
  await w.send('\u001b[B')
  await w.send('\r')
  check('E2 光标在第一张命令卡上 Enter → onRunCommand(help)',
    await settled(() => last(ev, 'runCommand')?.value === 'help'), JSON.stringify(ev))
  w.close()
}
{
  const ev: Ev[] = []
  const w = await openWizard(ev, { step: 3 })
  await w.send('\r')
  check('E3 第一张是键位卡（没有命令）：Enter 不假装能试，而是走"完成"',
    (await settled(() => last(ev, 'close')?.value === 'done')) && last(ev, 'runCommand') === undefined,
    JSON.stringify(ev))
  w.close()
}

// ── F. 出口 ─────────────────────────────────────────────────────────────────
{
  const ev: Ev[] = []
  const w = await openWizard(ev, { step: 1 })
  await w.send('\u001b')
  check('F1 Esc 交 skipped（Chat 走不记账那条路）',
    await settled(() => last(ev, 'close')?.value === 'skipped'), JSON.stringify(ev))
  w.close()
}
{
  const ev: Ev[] = []
  const w = await openWizard(ev, { step: 3 })
  await w.send('\r')
  check('F2 最后一步的 Enter 交 done（唯一会写 onboarding.json 的出口）',
    await settled(() => last(ev, 'close')?.value === 'done'), JSON.stringify(ev))
  w.close()
}
{
  const ev: Ev[] = []
  const w = await openWizard(ev, { step: 0 })
  await w.send('\u001b[C')
  check('F3 → 走到下一步（第 2 / 4 步）',
    await settled(() => w.screen().includes('第 2 / 4 步')), w.screen().slice(0, 120))
  await w.send('\u001b[D')
  check('F4 ← 退回上一步（第 1 / 4 步）',
    await settled(() => w.screen().includes('第 1 / 4 步')), w.screen().slice(0, 120))
  w.close()
}
{
  const ev: Ev[] = []
  const w = await openWizard(ev, { step: 3 })
  await settled(() => w.screen().includes('第 4 / 4 步') && w.screen().includes('命令菜单'))
  await w.send('\u001b[C')
  // 夹到最后一格：`step` 不能变成 undefined（那会渲染出一个空白步）
  check('F5 最后一步再按 → 不越界：还停在第 4 步且正文还在',
    await settled(() => w.screen().includes('第 4 / 4 步') && w.screen().includes('命令菜单')),
    w.screen().slice(0, 160))
  w.close()
}

// ── G. 模型分组钻出（回归：这条曾经是单向门） ──────────────────────────────
{
  const ev: Ev[] = []
  const s = await openWizard(ev, { step: 2 })
  await settled(() => s.screen().includes('DeepSeek'))
  s.send('\r')
  check('G1 钻进 provider 分组', await settled(() => s.screen().includes('deepseek-chat')))
  s.send('\u001b')
  check('G2 Esc 先退一层回到分组（不是直接跳过整个向导）',
    (await settled(() => s.screen().includes('DeepSeek') && !s.screen().includes('deepseek-chat')))
    && last(ev, 'close') === undefined, JSON.stringify(ev))
  s.send('\u001b')
  check('G3 再按一次 Esc 才跳过引导',
    await settled(() => last(ev, 'close')?.value === 'skipped'), JSON.stringify(ev))
  s.close()
}
{
  // 钻进去之后的**鼠标**出路（键盘有 Esc，鼠标只有这一行）
  const ev: Ev[] = []
  const s = await openWizard(ev, { step: 2 })
  await settled(() => s.screen().includes('DeepSeek'))
  s.send('\r')
  await settled(() => s.screen().includes('deepseek-chat'))
  check('G4 钻进去后画出了鼠标返回行', await settled(() => s.screen().includes('返回分组')))
  await s.click('返回分组')
  check('G5 点返回行回到分组（不关向导）',
    (await settled(() => s.screen().includes('DeepSeek') && !s.screen().includes('deepseek-chat')))
    && last(ev, 'close') === undefined, JSON.stringify(ev))
  s.close()
}

// ── H. Ctrl+C 与键位卡的 CANCEL_COMBO 同义 ─────────────────────────────────
{
  const ev: Ev[] = []
  const s = await openWizard(ev, { step: 1 })
  await settled(() => s.screen().includes('界面语言'))
  s.send('\u0003')
  check('H1 向导里 Ctrl+C 不是静默无效：与 Esc 同义（跳过引导）',
    await settled(() => last(ev, 'close')?.value === 'skipped'), JSON.stringify(ev))
  s.close()
}

// ── I. 记账契约（onboardingPrefs：解析 / 往返 / 三种触发口径） ──────────────
{
  const prefs = await import('../src/onboardingPrefs.js')
  check('I1 空/坏 JSON/非对象/completed 非字面 true 一律读作"没跑过"',
    prefs.parseOnboardingPrefs('').completed === false
    && prefs.parseOnboardingPrefs('{ not json').completed === false
    && prefs.parseOnboardingPrefs('[]').completed === false
    && prefs.parseOnboardingPrefs('{"completed":"yes"}').completed === false)
  check('I2 只有 completed:true 算跑过；非法 version 归 0',
    prefs.parseOnboardingPrefs('{"completed":true,"version":1}').completed === true
    && prefs.parseOnboardingPrefs('{"completed":true,"version":-3}').version === 0)
  const dir = join(fakeHome, 'onboarding-probe')
  check('I3 markOnboardingDone 真落盘、readOnboardingPrefs 读得回',
    prefs.markOnboardingDone(prefs.ONBOARDING_VERSION, dir) === true
    && prefs.readOnboardingPrefs(dir).completed === true)
  check('I4 不可写目录返回 false 而不是抛（best effort）',
    prefs.markOnboardingDone(1, join(fakeHome, 'nope', '\u0000bad')) === false)
  const fresh = prefs.shouldOfferOnboarding()
  prefs.markOnboardingDone(prefs.ONBOARDING_VERSION)
  const done = prefs.shouldOfferOnboarding()
  prefs.markOnboardingDone(0)
  const stale = prefs.shouldOfferOnboarding()
  check('I5 没跑过→问；跑过→不问；旧版本盖的章→再问一次',
    fresh === true && done === false && stale === true,
    [fresh, done, stale].join(','))
}

// ── J. 第一步的接入（账号与模型）───────────────────────────────────────────
/** 一行 dsh-auth 登录状态（未登录）。 */
const oauthRow = (provider: string) => ({
  provider, label: provider, oauthLabel: provider,
  loginLabel: undefined, signedIn: false, expiresAt: undefined, expired: false,
})
{
  // J1：接了缝就画动作行；v1 那条 `~/.deepseek/config.json` 指引必须消失。
  const ev: Ev[] = []
  const s = await openWizard(ev, {
    step: 0,
    channel: makeChannel({
      describeCredential: async () => ({ configured: false, source: 'none', writable: true }),
      oauthProviderStatuses: async () => [oauthRow('openai-codex'), oauthRow('deepseek-account')],
      providerSetup: () => ({ oauth: {} }),
    }),
    signIn: async () => 'cancelled',
    addProvider: async () => 'cancelled',
  })
  await settled(() => s.screen().includes('登录订阅账号'))
  check('J1a 有接缝时第一步画出四个动作行',
    s.screen().includes('登录订阅账号') && s.screen().includes('添加模型提供方')
    && s.screen().includes('重新检查') && s.screen().includes('跳过这一步'),
    s.screen())
  check('J1b 登录行带掩码状态（未登录账号数）',
    s.screen().includes('已登录 0 / 2'), s.screen())
  check('J1c 缺 key 时不再出现 ~/.deepseek/config.json',
    !s.screen().includes('.deepseek/config.json') && !s.screen().includes('deepseek/config.json'))
  s.close()
}
{
  // J2：没有接缝（老宿主 / 裸 cordis）→ 只留"重新检查 + 跳过"和真实兜底文案。
  const ev: Ev[] = []
  const s = await openWizard(ev, {
    step: 0,
    channel: makeChannel({
      describeCredential: async () => ({ configured: false, source: 'none', writable: true }),
      oauthProviderStatuses: async () => undefined,
    }),
  })
  await settled(() => s.screen().includes('重新检查'))
  check('J2a 没有接缝时不画登录/加 key 行（不假装能点）',
    !s.screen().includes('登录订阅账号（OAuth）') && !s.screen().includes('添加模型提供方（API key）'),
    s.screen())
  check('J2b 兜底文案给出真实位置与平台写法（credentials.yaml + setx）',
    s.screen().includes('credentials.yaml') && s.screen().includes('setx')
    && !s.screen().includes('deepseek/config.json'), s.screen())
  s.close()
}
{
  // J3：登录后只新增一个模型 → 直接设为默认，不进接入层。
  const ev: Ev[] = []
  const catalog: { list: readonly { provider: string; id: string; name: string }[] } = {
    list: [{ provider: 'deepseek', id: 'deepseek-chat', name: 'deepseek-chat' }],
  }
  let asked = ''
  const s = await openWizard(ev, {
    step: 0,
    channel: makeChannel({
      describeCredential: async () => ({ configured: false, source: 'none', writable: true }),
      listModels: async () => catalog.list,
      oauthProviderStatuses: async () => [oauthRow('xai')],
      providerSetup: () => ({ oauth: {} }),
    }),
    signIn: async (provider) => {
      asked = provider
      catalog.list = [{ provider: 'xai', id: 'grok-4', name: 'Grok 4' }]
      return 'added'
    },
  })
  await settled(() => s.screen().includes('登录订阅账号'))
  s.send('\r') // 动作行 0 = 登录订阅账号
  await settled(() => s.screen().includes('选择要登录的账号'))
  s.send('\r') // 第一个账号
  check('J3a 登录回调拿到被选中的 provider',
    await settled(() => asked === 'xai'), asked)
  check('J3b 只有一个新增模型 → 自动设为默认',
    await settled(() => s.channel.calls.includes('switchModel:xai/grok-4')), JSON.stringify(s.channel.calls))
  check('J3c 一个模型不问接入层，只报结果',
    await settled(() => s.screen().includes('默认模型设为 Grok 4'))
    && !s.screen().includes('哪个设为默认模型'), s.screen())
  s.close()
}
{
  // J4：三个新增模型 → 内联接入层；勾选可改，默认预选当前路由。
  const ev: Ev[] = []
  const catalog: { list: readonly { provider: string; id: string; name: string }[] } = { list: [] }
  const s = await openWizard(ev, {
    step: 0,
    channel: makeChannel({
      // 当前会话已经指向 xai/grok-4（例如恢复了旧会话），但该 provider 还没登录
      provider: 'xai',
      model: 'grok-4',
      describeCredential: async () => ({ configured: false, source: 'none', writable: true }),
      listModels: async () => catalog.list,
      oauthProviderStatuses: async () => [oauthRow('xai')],
      providerSetup: () => ({ oauth: {} }),
    }),
    signIn: async () => {
      catalog.list = [
        { provider: 'xai', id: 'grok-3', name: 'Grok 3' },
        { provider: 'xai', id: 'grok-4', name: 'Grok 4' },
        { provider: 'xai', id: 'grok-4-mini', name: 'Grok 4 Mini' },
      ]
      return 'added'
    },
  })
  await settled(() => s.screen().includes('登录订阅账号'))
  s.send('\r')
  await settled(() => s.screen().includes('选择要登录的账号'))
  s.send('\r')
  check('J4a 多个新增 → 画出接入层（默认全选）',
    await settled(() => s.screen().includes('接入 3 个可用模型') && s.screen().includes('已选 3 个')), s.screen())
  await s.send(' ') // 在第一行上取消勾选
  check('J4b Space 取消勾选后计数跟着变',
    await settled(() => s.screen().includes('已选 2 个')), s.screen())
  await s.send(' ') // 再勾回来
  await settled(() => s.screen().includes('已选 3 个'))
  s.send('\t') // 换到"哪个设为默认"
  check('J4c Tab 进入默认区，焦点与标记都落在预选的那一行（不在列表头也是它）',
    await settled(() => s.screen().includes('哪个设为默认模型') && s.screen().includes('❯ Grok 4  xai ✓')), s.screen())
  s.send('\u001b[B') // ↓ 只移动焦点（Grok 4 Mini）
  check('J4d ↓ 只移动焦点，标记（✓）不跟着走',
    await settled(() => s.screen().includes('❯ Grok 4 Mini  xai')
      && !s.screen().includes('❯ Grok 4 Mini  xai ✓')
      && s.screen().includes('  Grok 4  xai ✓')), s.screen())
  await s.send(' ') // Space = 选中当前行（Grok 4 Mini）
  check('J4e Space 把标记移到当前行',
    await settled(() => s.screen().includes('❯ Grok 4 Mini  xai ✓')
      && !s.screen().includes('  Grok 4  xai ✓')), s.screen())
  s.send('\u001b[A') // ↑ 焦点回 Grok 4，但不按 Space → 标记仍是 Grok 4 Mini
  await settled(() => s.screen().includes('❯ Grok 4  xai '))
  s.send('\r')
  check('J4f Enter 确定的是「选中的那一个」（标记优先于焦点）',
    await settled(() => s.channel.calls.includes('switchModel:xai/grok-4-mini')), JSON.stringify(s.channel.calls))
  s.close()
}
{
  // J8：模型区的 Space 与 Enter 分工——Space 只勾选，Enter 才确定（进默认区）；
  // 一个都没勾时 Enter = 这次不选默认（模型仍然可用），直接收层。
  const ev: Ev[] = []
  const catalog: { list: readonly { provider: string; id: string; name: string }[] } = { list: [] }
  const s = await openWizard(ev, {
    step: 0,
    channel: makeChannel({
      describeCredential: async () => ({ configured: false, source: 'none', writable: true }),
      listModels: async () => catalog.list,
      oauthProviderStatuses: async () => [oauthRow('xai')],
      providerSetup: () => ({ oauth: {} }),
    }),
    signIn: async () => {
      catalog.list = [
        { provider: 'xai', id: 'grok-3', name: 'Grok 3' },
        { provider: 'xai', id: 'grok-4', name: 'Grok 4' },
      ]
      return 'added'
    },
  })
  await settled(() => s.screen().includes('登录订阅账号'))
  s.send('\r')
  await settled(() => s.screen().includes('选择要登录的账号'))
  s.send('\r')
  await settled(() => s.screen().includes('接入 2 个可用模型'))
  s.send('\r') // Enter（焦点在第 0 行模型上）= 确定这批勾选，而不是勾掉这一行
  check('J8a 模型区 Enter = 确定（进默认区），不会把当前行勾掉',
    await settled(() => s.screen().includes('哪个设为默认模型')), s.screen())
  s.send('\t') // 回模型区
  await settled(() => s.screen().includes('接入哪些'))
  await s.send(' ') // Space 勾掉第 0 行（Space 不移动焦点）
  await s.send('\u001b[B') // ↓ 到第 1 行
  await s.send(' ') // Space 勾掉第 1 行 → 一个都不剩
  check('J8b Space 逐个取消后计数归零',
    await settled(() => s.screen().includes('确认接入（已选 0 个）')), s.screen())
  s.send('\r')
  check('J8c 一个都没勾时 Enter = 跳过选默认（不调 switchModel，也不问）',
    await settled(() => s.screen().includes('没有勾选任何模型'))
    && !s.channel.calls.some(call => call.startsWith('switchModel:')), JSON.stringify(s.channel.calls))
  s.close()
}
{
  // J10：勾掉"被标记为默认"的那一行时，标记要让给还选着的模型——否则默认区
  // 会出现"一个 ✓ 都没有、Enter 却落在 picked[0]"的错位。
  const ev: Ev[] = []
  const catalog: { list: readonly { provider: string; id: string; name: string }[] } = { list: [] }
  const s = await openWizard(ev, {
    step: 0,
    channel: makeChannel({
      // 当前路由不在新增里 → 预选就是第一个新增模型（Grok 3）
      provider: 'deepseek',
      model: 'deepseek-chat',
      describeCredential: async () => ({ configured: false, source: 'none', writable: true }),
      listModels: async () => catalog.list,
      oauthProviderStatuses: async () => [oauthRow('xai')],
      providerSetup: () => ({ oauth: {} }),
    }),
    signIn: async () => {
      catalog.list = [
        { provider: 'xai', id: 'grok-3', name: 'Grok 3' },
        { provider: 'xai', id: 'grok-4', name: 'Grok 4' },
      ]
      return 'added'
    },
  })
  await settled(() => s.screen().includes('登录订阅账号'))
  s.send('\r')
  await settled(() => s.screen().includes('选择要登录的账号'))
  s.send('\r')
  await settled(() => s.screen().includes('接入 2 个可用模型'))
  await s.send(' ') // 勾掉被标记的那一行（Grok 3）
  await settled(() => s.screen().includes('已选 1 个'))
  s.send('\r') // 确认 → 默认区
  check('J10 勾掉预选行后，标记让给还选着的模型（默认区仍有 ✓）',
    await settled(() => s.screen().includes('哪个设为默认模型') && s.screen().includes('Grok 4  xai ✓')), s.screen())
  s.send('\r')
  check('J10b 落点就是那个仍有标记的模型',
    await settled(() => s.channel.calls.includes('switchModel:xai/grok-4')), JSON.stringify(s.channel.calls))
  s.close()
}
{
  // J5：登录成功但没有新模型 → 只报结果，不动默认。
  const ev: Ev[] = []
  const before: string[] = []
  const s = await openWizard(ev, {
    step: 0,
    channel: makeChannel({
      describeCredential: async () => ({ configured: false, source: 'none', writable: true }),
      listModels: async () => [{ provider: 'deepseek', id: 'deepseek-chat', name: 'deepseek-chat' }],
      oauthProviderStatuses: async () => [oauthRow('xai')],
      providerSetup: () => ({ oauth: {} }),
    }),
    signIn: async () => {
      before.push(...s.channel.calls)
      return 'added'
    },
  })
  await settled(() => s.screen().includes('登录订阅账号'))
  s.send('\r')
  await settled(() => s.screen().includes('选择要登录的账号'))
  s.send('\r')
  check('J5 没有新增模型 → 只出提示，不调 switchModel',
    await settled(() => s.screen().includes('没有新增可用模型'))
    && !s.channel.calls.some(call => call.startsWith('switchModel:')), JSON.stringify(s.channel.calls))
  s.close()
}
{
  // J6：draft 生命周期（面板接管期间的进度记忆）：写入/读回/清空，不测形状解析。
  const draft = await import('../src/onboardingDraft.js')
  draft.clearOnboardingDraft()
  const empty = draft.readOnboardingDraft() === undefined
  const written = draft.writeOnboardingDraft({
    step: 2,
    focus: 1,
    baseline: [{ provider: 'a', id: 'b', name: 'c' }],
    pending: { id: 1, kind: 'sign-in', provider: 'a' },
    notice: 'n',
  })
  check('J6a 空 → undefined；写后可读回全部字段',
    empty && written.step === 2 && written.focus === 1
    && written.baseline.length === 1 && written.pending?.provider === 'a'
    && typeof written.pending?.id === 'number' && written.notice === 'n')
  draft.clearOnboardingDraft()
  check('J6c clear 真的清空', draft.readOnboardingDraft() === undefined)
}
{
  // J7：卸载-重挂后步骤保持（真实触发是问答面板接管整屏）。
  const ev: Ev[] = []
  const first = await openWizard(ev, { step: 2 })
  await settled(() => first.screen().includes('第 3 / 4 步'))
  first.close()
  const second = await openWizard(ev, { keepDraft: true })
  check('J7 draft 让重挂回到第 3 步（不是从第一步重问）',
    await settled(() => second.screen().includes('第 3 / 4 步')), second.screen())
  second.close()
  clearOnboardingDraft()
}

{
  // J9：面板可以在**两次提问之间**关闭（模型探测 / profile 写入都发生在提问
  // 之间），那时本屏被重挂、目录还没变。必须等到动作真的结束（draft.completed）
  // 才结算，否则会读到旧目录并把结果丢掉；而且迟到的完成要能送到在挂的实例。
  const ev: Ev[] = []
  const catalog: { list: readonly { provider: string; id: string; name: string }[] } = { list: [] }
  let release: (() => void) | undefined
  const remountChannel = makeChannel({
    describeCredential: async () => ({ configured: false, source: 'none', writable: true }),
    listModels: async () => catalog.list,
    oauthProviderStatuses: async () => [oauthRow('xai')],
    providerSetup: () => ({ oauth: {} }),
  })
  const s = await openWizard(ev, {
    step: 0,
    channel: remountChannel,
    // 永不自动解析的登录：模拟"动作还在跑"。
    signIn: () => new Promise((resolve) => { release = () => resolve('added') }),
  })
  await settled(() => s.screen().includes('登录订阅账号'))
  s.send('\r')
  await settled(() => s.screen().includes('选择要登录的账号'))
  s.send('\r')
  const draft = await import('../src/onboardingDraft.js')
  check('J9a 动作发起时落 draft：基线 + 意图 + 焦点 id + 动作 id，且还没有完成态',
    await settled(() => draft.readOnboardingDraft()?.pending?.provider === 'xai'
      && draft.readOnboardingDraft()?.pending?.id !== undefined
      && draft.readOnboardingDraft()?.completed === undefined
      && draft.readOnboardingDraft()?.focusId === 'signin'),
    JSON.stringify(draft.readOnboardingDraft()))
  s.close() // ← 面板关闭、本屏卸载（动作仍在跑）
  catalog.list = [{ provider: 'xai', id: 'grok-4', name: 'Grok 4' }]
  const second = await openWizard(ev, { keepDraft: true, channel: remountChannel })
  await settled(() => second.screen().includes('登录订阅账号'))
  await new Promise(resolve => setTimeout(resolve, 120))
  check('J9b 动作未完成时重挂不结算（不拿旧目录做决定）',
    !second.channel.calls.some(call => call.startsWith('switchModel:')),
    JSON.stringify(second.channel.calls))
  release?.() // ← 动作此刻才结束
  check('J9c 迟到的完成由在挂实例结算：自动设为默认',
    await settled(() => second.channel.calls.includes('switchModel:xai/grok-4')),
    JSON.stringify(second.channel.calls))
  check('J9d 结算后 draft 清干净（pending/completed 都不留）',
    await settled(() => draft.readOnboardingDraft()?.pending === undefined
      && draft.readOnboardingDraft()?.completed === undefined),
    JSON.stringify(draft.readOnboardingDraft()))
  await new Promise(resolve => setTimeout(resolve, 60))
  check('J9e 只结算一次',
    second.channel.calls.filter(call => call === 'switchModel:xai/grok-4').length === 1,
    JSON.stringify(second.channel.calls))
  second.close()
  draft.clearOnboardingDraft()
}
{
  // J11：另一种时序——动作在重挂之前就已经结束（完成态已写进 draft），
  // 挂载时直接结算，不用等任何回调。
  const ev: Ev[] = []
  const draft = await import('../src/onboardingDraft.js')
  clearOnboardingDraft()
  draft.writeOnboardingDraft({
    step: 0,
    focus: 0,
    focusId: 'signin',
    baseline: [],
    pending: undefined,
    completed: { kind: 'sign-in', provider: 'xai', status: 'completed' },
  })
  const catalog = {
    list: [{ provider: 'xai', id: 'grok-4', name: 'Grok 4' }],
  }
  const s = await openWizard(ev, {
    keepDraft: true,
    // 有登录动作行，才能验证"焦点按 id 回到发起它的那一行"。
    signIn: async () => 'cancelled',
    channel: makeChannel({
      describeCredential: async () => ({ configured: false, source: 'none', writable: true }),
      listModels: async () => catalog.list,
      oauthProviderStatuses: async () => [oauthRow('xai')],
      providerSetup: () => ({ oauth: {} }),
    }),
  })
  check('J11 挂载时动作已完成 → 立即结算（自动设为默认）',
    await settled(() => s.channel.calls.includes('switchModel:xai/grok-4')), JSON.stringify(s.channel.calls))
  check('J11b 焦点按 id 恢复到"登录订阅账号"那一行',
    await settled(() => s.screen().includes('❯ 登录订阅账号（OAuth）')), s.screen())
  s.close()
  draft.clearOnboardingDraft()
}

{
  // J12：旧动作的迟到回调不能顶掉新动作。时序：发起 A（慢）→ 关引导 →
  // 重新打开并发起 B → A 先结束（此时 draft 里是 B 的 pending）→ A 必须被丢弃，
  // B 仍然持有自己的 pending，B 结束时正常结算。
  const draft = await import('../src/onboardingDraft.js')
  clearOnboardingDraft()
  const catalog: { list: readonly { provider: string; id: string; name: string }[] } = { list: [] }
  let releaseA: (() => void) | undefined
  let releaseB: (() => void) | undefined
  const channel = makeChannel({
    describeCredential: async () => ({ configured: false, source: 'none', writable: true }),
    listModels: async () => catalog.list,
    oauthProviderStatuses: async () => [oauthRow('xai'), oauthRow('openai-codex')],
    providerSetup: () => ({ oauth: {} }),
  })
  const a = await openWizard([], {
    step: 0,
    channel,
    signIn: () => new Promise((resolve) => { releaseA = () => resolve('added') }),
  })
  await settled(() => a.screen().includes('登录订阅账号'))
  a.send('\r')
  await settled(() => a.screen().includes('选择要登录的账号'))
  a.send('\r')
  const draftA = await settled(() => draft.readOnboardingDraft()?.pending?.id !== undefined)
    ? draft.readOnboardingDraft()
    : undefined
  a.close() // 关掉引导：draft 清空，但 A 的 promise 还在跑
  clearOnboardingDraft()
  const b = await openWizard([], {
    step: 0,
    channel,
    signIn: () => new Promise((resolve) => { releaseB = () => resolve('added') }),
  })
  await settled(() => b.screen().includes('登录订阅账号'))
  b.send('\r')
  await settled(() => b.screen().includes('选择要登录的账号'))
  b.send('\u001b[B') // 选第二个账号，避免与 A 的 provider 相同
  await settled(() => b.screen().includes('❯ openai-codex'))
  b.send('\r')
  const draftB = await settled(() => draft.readOnboardingDraft()?.pending?.provider === 'openai-codex')
    ? draft.readOnboardingDraft()
    : undefined
  check('J12a 两单的动作 id 不同（A/B 各自持有）',
    draftA?.pending?.id !== undefined && draftB?.pending?.id !== undefined
    && draftA?.pending?.id !== draftB?.pending?.id,
    JSON.stringify({ a: draftA?.pending, b: draftB?.pending }))
  // B 登录的是 openai-codex，所以新出现的模型也必须是它的——否则 diff 会被
  // provider 过滤掉，测的就不是"两单交错"而是"登录了别的号"。
  catalog.list = [{ provider: 'openai-codex', id: 'gpt-5.6', name: 'GPT-5.6' }]
  releaseA?.() // A 迟到：不能把 B 的 pending 顶掉，也不能替 B 结算
  await new Promise(resolve => setTimeout(resolve, 120))
  check('J12b A 的迟到完成被丢弃：B 的 pending 原样还在，也没有完成态',
    draft.readOnboardingDraft()?.pending?.id === draftB?.pending?.id
    && draft.readOnboardingDraft()?.completed === undefined,
    JSON.stringify(draft.readOnboardingDraft()))
  check('J12c A 的模型没有被接入（没有替 B 结算）',
    !channel.calls.some(call => call.startsWith('switchModel:')), JSON.stringify(channel.calls))
  releaseB?.()
  check('J12d B 正常结算（自己的结果仍然被接住）',
    await settled(() => channel.calls.filter(call => call === 'switchModel:openai-codex/gpt-5.6').length === 1),
    JSON.stringify(channel.calls))
  b.close()
  draft.clearOnboardingDraft()
}

if (failures === 0) console.log(`\nverify-onboarding-wizard: ${checks} checks, all passed`)
else console.error(`\nverify-onboarding-wizard: ${failures} of ${checks} checks FAILED`)
process.exit(failures === 0 ? 0 : 1)