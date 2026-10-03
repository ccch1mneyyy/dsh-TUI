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
}

async function openWizard(events: Ev[], options: OpenOptions = {}) {
  const columns = options.columns ?? COLS
  const rows = options.rows ?? ROWS
  const channel = options.channel ?? makeChannel()
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
        initialStep={options.step ?? 0}
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
check('A1 步骤表就是四步（apikey/look/model/keys）',
  ONBOARDING_STEPS.length === 4 && ONBOARDING_STEPS[0] === 'apikey' && ONBOARDING_STEPS[3] === 'keys')
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
    await settled(() => wide.screen().includes('API Key 与连通性') && wide.screen().includes('快捷键与招式')))
  wide.close()
  const ev2: Ev[] = []
  const narrow = await openWizard(ev2, { step: 0, columns: STEP_BAR_MIN_COLUMNS - 8 })
  await narrow.idle()
  check('A4 窄终端：步骤条整条撤，但头部进度还在（信息不丢）',
    !narrow.screen().includes('API Key 与连通性') && narrow.screen().includes('第 1 / 4 步'),
    narrow.screen().slice(0, 200))
  narrow.close()
  const ev3: Ev[] = []
  const short = await openWizard(ev3, { step: 0, rows: STEP_BAR_MIN_ROWS - 2 })
  await short.idle()
  check('A5 矮终端：步骤条同样整条撤（高度轴与宽度轴同一条规则）',
    !short.screen().includes('API Key 与连通性') && short.screen().includes('第 1 / 4 步'),
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

if (failures === 0) console.log(`\nverify-onboarding-wizard: ${checks} checks, all passed`)
else console.error(`\nverify-onboarding-wizard: ${failures} of ${checks} checks FAILED`)
process.exit(failures === 0 ? 0 : 1)