/**
 * verify-onboarding-wizard — 首次运行引导（Onboarding）回归。
 *
 * 钉住的契约：
 *
 *   A. 骨架：四步各自渲染得出内容，头部进度是 `第 N / 4 步`；步骤条只在
 *      够宽够高时画（窄了整条撤，进度改由头部承担，信息不丢）。
 *   B. 第一步（access）：凭证只报"有没有"、余额串走 `formatBalance`、失败
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
 *      （0 不问、1 直接设默认、多个进内联选默认层：单选 + 保持当前模型，不做多选）；
 *      加 key 由 /provider 向导自己问启用与切换，引导只报结果（J13）；draft 让步骤
 *      在卸载-重挂后保持；流程的失败原因与登出/删除结果在整屏引导里看得见（J14/J15）；
 *      迟到的目录读取不复活已作废的动作、选默认层在 80×24 下窗口化（J16–J18）；
 *      有别的接入时 DeepSeek 专用检查不报失败（J19/J20）；登录行与执行同一接缝、
 *      晚到的 dsh-auth 不需要重新检查（J21）；失败/取消提示不用成功色（J22）；一单在跑时
 *      登录 / 加 key 不能再发起第二单，重挂后也一样（J23）。
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
    /** 通知条（最新在末尾）：流程的失败原因与结果只从这里出。 */
    notifications: [] as { id: number; text: string }[],
    ...over,
  }
  return channel
}

/** 模拟流程发一条通知（id 单调，与真 channel 一致）。 */
function notifyOn(channel: { notifications: { id: number; text: string }[] }, text: string): void {
  channel.notifications.push({ id: (channel.notifications.at(-1)?.id ?? 0) + 1, text })
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
  check('J3c 一个模型不进选默认层，只报结果',
    await settled(() => s.screen().includes('默认模型设为 Grok 4'))
    && !s.screen().includes('保持当前模型'), s.screen())
  s.close()
}
{
  // J4（review R1）：三个新增模型 → 内联选默认层。只有单选：登录后这些模型已经
  // 全部可用，没有可保存的"接入子集"，所以不出现勾选，提示也不报"已接入 N 个"。
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
  check('J4a 多个新增 → 画出选默认层，末尾有"保持当前模型"',
    await settled(() => s.screen().includes('接入 3 个可用模型') && s.screen().includes('保持当前模型')), s.screen())
  check('J4b 没有多选：不出现勾选计数，也没有"接入哪些"',
    !s.screen().includes('已选') && !s.screen().includes('接入哪些') && !s.screen().includes('Space'), s.screen())
  check('J4c 焦点落在预选（当前路由 Grok 4，不在列表头也是它）',
    s.screen().includes('❯ Grok 4  xai') && !s.screen().includes('❯ Grok 4 Mini'), s.screen())
  await s.send(' ') // Space 在单选层里没有含义：什么都不改
  await s.send('\u001b[B') // ↓ 到 Grok 4 Mini
  check('J4d ↓ 移动焦点', await settled(() => s.screen().includes('❯ Grok 4 Mini  xai')), s.screen())
  s.send('\r')
  check('J4e Enter 把焦点那一行落成默认（只落一次）',
    await settled(() => s.channel.calls.includes('switchModel:xai/grok-4-mini'))
    && s.channel.calls.filter(call => call.startsWith('switchModel:')).length === 1, JSON.stringify(s.channel.calls))
  check('J4f 提示只说默认模型，不报"已接入 N 个模型"',
    await settled(() => s.screen().includes('默认模型设为 Grok 4 Mini')) && !s.screen().includes('个模型，默认'),
    s.screen())
  s.close()
}
{
  // J8：末尾那行"保持当前模型"与 Esc 同义——不调 switchModel，模型照样可用。
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
  check('J8a "保持当前模型"带上当前模型名', s.screen().includes('当前：deepseek-chat'), s.screen())
  await s.send('\u001b[B')
  await s.send('\u001b[B') // 两个模型之后就是"保持当前模型"
  await s.send('\u001b[B') // 再按不越界
  check('J8b ↓ 走到"保持当前模型"且不越界', await settled(() => s.screen().includes('❯ 保持当前模型')), s.screen())
  s.send('\r')
  check('J8c 保持当前模型 = 不调 switchModel，退回动作列表',
    await settled(() => s.screen().includes('已保持当前模型') && s.screen().includes('重新检查'))
    && !s.channel.calls.some(call => call.startsWith('switchModel:')), JSON.stringify(s.channel.calls))
  s.close()
}
{
  // J10：鼠标与键盘同一个落点——点模型行就把它设为默认，点"保持当前模型"不动默认。
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
  check('J10a 当前路由不在新增里 → 焦点在第一个新增模型', s.screen().includes('❯ Grok 3  xai'), s.screen())
  await s.click('Grok 4  xai')
  check('J10b 点模型行 = 设为默认（与 Enter 同一条路）',
    await settled(() => s.channel.calls.includes('switchModel:xai/grok-4')), JSON.stringify(s.channel.calls))
  s.close()
  catalog.list = []
  const kept = await openWizard([], {
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
  await settled(() => kept.screen().includes('登录订阅账号'))
  kept.send('\r')
  await settled(() => kept.screen().includes('选择要登录的账号'))
  kept.send('\r')
  await settled(() => kept.screen().includes('接入 2 个可用模型'))
  await kept.click('保持当前模型') // 自上而下第一处是那一行（底部提示行在它下面）
  check('J10c 点"保持当前模型" = 不调 switchModel',
    await settled(() => kept.screen().includes('已保持当前模型'))
    && !kept.channel.calls.some(call => call.startsWith('switchModel:')), JSON.stringify(kept.channel.calls))
  kept.close()
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
    notice: { text: 'n', tone: 'error' },
  })
  check('J6a 空 → undefined；写后可读回全部字段（提示连同语气）',
    empty && written.step === 2 && written.focus === 1
    && written.baseline.length === 1 && written.pending?.provider === 'a'
    && typeof written.pending?.id === 'number' && written.notice?.text === 'n' && written.notice.tone === 'error')
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
  // 固定窗:探针 断言"动作未完成时什么都不结算"：没有可轮询的完成条件。
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
  // 固定窗:探针 断言"不会再结算第二次"：没有可轮询的完成条件。
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
    completed: { id: 1, kind: 'sign-in', provider: 'xai', status: 'added' },
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
  // 固定窗:探针 断言"迟到的 A 什么都不做"：没有可轮询的完成条件。
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

{
  // J13：「添加模型提供方」跑的是 /provider 向导——启用哪些模型（模型多选）、切到
  // 其中哪一个还是保持当前（provider-q-switch），向导自己已经问过。回到引导只报结果：
  // 再跑 auto / 接入层，会推翻用户在向导里的选择，并把同一批模型再问一遍。
  const trio = [
    { provider: 'mock', id: 'a', name: 'Alpha' },
    { provider: 'mock', id: 'b', name: 'Beta' },
    { provider: 'mock', id: 'c', name: 'Gamma' },
  ]
  const cases = [
    { name: '一个新模型 + 保持当前模型', added: [{ provider: 'mock', id: 'solo', name: 'Solo' }], switched: false },
    { name: '三个新模型 + 保持当前模型', added: trio, switched: false },
    { name: '三个新模型 + 向导里切到 Beta', added: trio, switched: true },
  ]
  for (const item of cases) {
    const ev: Ev[] = []
    const catalog: { list: readonly { provider: string; id: string; name: string }[] } = {
      list: [{ provider: 'deepseek', id: 'deepseek-chat', name: 'deepseek-chat' }],
    }
    // 只给加 key 的接缝（没有登录行），动作行 0 就是「添加模型提供方」。
    const channel = makeChannel({
      listModels: async () => catalog.list,
      providerSetup: () => ({}),
    })
    const s = await openWizard(ev, {
      step: 0,
      channel,
      // 向导写好 profile：目录多出这批模型；「切过去」时由向导自己调 switchModel，
      // live 路由随之变（桩 channel 的 switchModel 只记账，这里手动跟上）。
      addProvider: async () => {
        catalog.list = [...catalog.list, ...item.added]
        if (item.switched) {
          const picked = item.added[1]!
          await channel.switchModel(picked.provider, picked.id)
          channel.provider = picked.provider
          channel.model = picked.id
        }
        return 'added'
      },
    })
    await settled(() => s.screen().includes('❯ 添加模型提供方'))
    s.send('\r')
    const wizardSwitches = item.switched ? 1 : 0
    const expectedDefault = item.switched ? item.added[1]!.name : 'deepseek-chat'
    check(`J13a ${item.name}：引导只报结果，默认是向导定下的那个（${expectedDefault}）`,
      await settled(() => s.screen().includes(`已接入 mock 的 ${item.added.length} 个模型；默认模型：${expectedDefault}`)),
      s.screen())
    check(`J13b ${item.name}：引导自己不调 switchModel（只有向导的 ${wizardSwitches} 次）`,
      channel.calls.filter(call => call.startsWith('switchModel:')).length === wizardSwitches,
      JSON.stringify(channel.calls))
    check(`J13c ${item.name}：不进选默认层（启用与切换已在向导里问过）`,
      !s.screen().includes('保持当前模型'), s.screen())
    s.close()
  }
}

{
  // J14：引导整屏盖住了通知条，而流程的失败原因只走 notify——结算时把开跑之后
  // 最新的那一条并进引导自己的提示行；开跑前就在的旧通知不算这一单的原因。
  const channel = makeChannel({ providerSetup: () => ({}) })
  const s = await openWizard([], {
    step: 0,
    channel,
    addProvider: async () => {
      notifyOn(channel, '写入 provider 配置失败：settings-rejected')
      return 'failed'
    },
  })
  await settled(() => s.screen().includes('❯ 添加模型提供方'))
  s.send('\r')
  check('J14a 失败时引导显示流程自己的原因',
    await settled(() => s.screen().includes('这次配置没有完成：写入 provider 配置失败：settings-rejected')),
    s.screen())
  s.close()
  const stale = makeChannel({ providerSetup: () => ({}) })
  notifyOn(stale, '开跑前的旧通知')
  const t2 = await openWizard([], { step: 0, channel: stale, addProvider: async () => 'failed' })
  await settled(() => t2.screen().includes('❯ 添加模型提供方'))
  t2.send('\r')
  check('J14b 流程没发新通知 → 通用失败文案，不拿旧通知冒充原因',
    await settled(() => t2.screen().includes('这次配置没有完成，可以重试或换一种方式'))
    && !t2.screen().includes('开跑前的旧通知'), t2.screen())
  t2.close()
}
{
  // J15：登出、删路由不是"新增"——报流程自己的那一句，不说"没有新增可用模型"。
  const channel = makeChannel({
    describeCredential: async () => ({ configured: false, source: 'none', writable: true }),
    oauthProviderStatuses: async () => [oauthRow('xai')],
    providerSetup: () => ({ oauth: {} }),
  })
  const s = await openWizard([], {
    step: 0,
    channel,
    signIn: async () => {
      notifyOn(channel, '已退出 xai 的登录')
      return 'signed-out'
    },
  })
  await settled(() => s.screen().includes('登录订阅账号'))
  s.send('\r')
  await settled(() => s.screen().includes('选择要登录的账号'))
  s.send('\r')
  check('J15a 登出 → 报"已退出"，不报"没有新增"',
    await settled(() => s.screen().includes('已退出 xai 的登录'))
    && !s.screen().includes('没有新增可用模型'), s.screen())
  s.close()
  const removed = makeChannel({ providerSetup: () => ({}) })
  const t2 = await openWizard([], { step: 0, channel: removed, addProvider: async () => 'deleted' })
  await settled(() => t2.screen().includes('❯ 添加模型提供方'))
  t2.send('\r')
  check('J15b 删路由且流程没发通知 → 通用"设置已更新"，不报"没有新增"',
    await settled(() => t2.screen().includes('设置已更新，没有新增模型'))
    && !t2.screen().includes('没有新增可用模型'), t2.screen())
  t2.close()
}
{
  // J16（PR #1647 review R1）：动作里的目录读取还没回来就 Esc 关掉引导。迟到的
  // 读取不得再 start()（替已经离开的用户跑登录），也不得把已清空的 draft 写回来。
  const draft = await import('../src/onboardingDraft.js')
  // 只卡"动作里的那一次"：挂载期的读取会随 checkNonce/catalogNonce 重跑，按调用
  // 次数判会把挂载读错认成动作读。
  let deferNext = false
  let release: (() => void) | undefined
  const signInCalls: string[] = []
  const channel = makeChannel({
    describeCredential: async () => ({ configured: false, source: 'none', writable: true }),
    oauthProviderStatuses: async () => [oauthRow('xai')],
    providerSetup: () => ({ oauth: {} }),
    listModels: async () => {
      if (!deferNext) return MODELS
      deferNext = false
      return new Promise(resolve => { release = () => resolve(MODELS) })
    },
  })
  const ev: Ev[] = []
  const s = await openWizard(ev, {
    step: 0,
    channel,
    signIn: async (provider) => { signInCalls.push(provider); return 'added' },
  })
  await settled(() => s.screen().includes('登录订阅账号'))
  await s.send('\r')
  await settled(() => s.screen().includes('选择要登录的账号'))
  deferNext = true
  await s.send('\r')
  check('J16 前置：动作里的目录读取被卡住', await settled(() => release !== undefined))
  await s.send('\u001b')
  check('J16 前置：Esc 退出引导且 draft 已清空',
    await settled(() => ev.some(e => e.type === 'close' && e.value === 'skipped'))
    && draft.readOnboardingDraft() === undefined, JSON.stringify(ev))
  s.close()
  release?.()
  // 固定窗:探针 断言"迟到的读取什么都不做"：没有可轮询的完成条件。
  await new Promise(resolve => setTimeout(resolve, 120))
  check('J16a 关屏后迟到的目录读取不调登录', signInCalls.length === 0, JSON.stringify(signInCalls))
  check('J16b 也不把 draft 写回来', draft.readOnboardingDraft() === undefined,
    JSON.stringify(draft.readOnboardingDraft()))
}
{
  // J17（review R1）：两单的目录读取都卡住，先放旧单——它的归属已被新单作废，
  // 不得 start()、不得写 draft 归属；新单照常启动。
  const draft = await import('../src/onboardingDraft.js')
  let deferNext = false
  const releases: (() => void)[] = []
  const signInCalls: string[] = []
  const channel = makeChannel({
    describeCredential: async () => ({ configured: false, source: 'none', writable: true }),
    oauthProviderStatuses: async () => [oauthRow('xai')],
    providerSetup: () => ({ oauth: {} }),
    listModels: async () => {
      if (!deferNext) return MODELS
      deferNext = false
      return new Promise(resolve => { releases.push(() => resolve(MODELS)) })
    },
  })
  const s = await openWizard([], {
    step: 0,
    channel,
    signIn: async (provider) => { signInCalls.push(provider); return 'added' },
  })
  await settled(() => s.screen().includes('登录订阅账号'))
  for (let round = 1; round <= 2; round++) {
    await s.send('\r')
    await settled(() => s.screen().includes('选择要登录的账号'))
    deferNext = true
    await s.send('\r')
    await settled(() => releases.length === round)
  }
  check('J17 前置：两单都已发起且目录读取被卡住', releases.length === 2, String(releases.length))
  releases[0]?.()
  // 固定窗:探针 断言"旧单迟到什么都不做"：没有可轮询的完成条件。
  await new Promise(resolve => setTimeout(resolve, 120))
  check('J17a 旧单迟到不启动登录', signInCalls.length === 0, JSON.stringify(signInCalls))
  check('J17b 旧单迟到不写 draft 归属（pending / completed 都没有）',
    draft.readOnboardingDraft()?.pending === undefined && draft.readOnboardingDraft()?.completed === undefined,
    JSON.stringify(draft.readOnboardingDraft()))
  releases[1]?.()
  check('J17c 新单照常启动登录（恰好一次）',
    await settled(() => signInCalls.length === 1), JSON.stringify(signInCalls))
  s.close()
  draft.clearOnboardingDraft()
}
{
  // J18（review R2）：80×24 下 30 个新模型，选默认层要窗口化——焦点行落在
  // 视口外时 Enter 仍作用在它上面，等于盲操作。
  const many = Array.from({ length: 30 }, (_, index) => ({
    provider: 'xai',
    id: `model-${index}`,
    name: `xai-model-${String(index).padStart(2, '0')}`,
  }))
  let catalog: readonly { provider: string; id: string; name: string }[] = MODELS
  const channel = makeChannel({
    describeCredential: async () => ({ configured: false, source: 'none', writable: true }),
    oauthProviderStatuses: async () => [oauthRow('xai')],
    providerSetup: () => ({ oauth: {} }),
    listModels: async () => catalog,
  })
  const s = await openWizard([], {
    step: 0,
    columns: 80,
    rows: 24,
    channel,
    signIn: async () => { catalog = [...MODELS, ...many]; return 'added' },
  })
  await settled(() => s.screen().includes('登录订阅账号'))
  await s.send('\r')
  await settled(() => s.screen().includes('选择要登录的账号'))
  await s.send('\r')
  check('J18 前置：30 个新模型进了选默认层', await settled(() => s.screen().includes('xai-model-00')), s.screen())
  // 只看焦点行不够：整帧溢出时 xterm 滚到底，末行焦点照样"可见"，但页头已经被
  // 顶出屏幕。窗口化的不变量是两者同屏——整帧装得下，焦点行也在里面。
  const fits = (needle: string) => (): boolean => s.screen().includes(needle) && s.screen().includes('第 1 / 4 步')
  for (let index = 0; index < 29; index++) await s.send('\u001b[B')
  check('J18a 焦点行（第 30 个）在 80×24 视口内，页头也还在',
    await settled(fits('❯ xai-model-29')), s.screen())
  await s.send('\u001b[B')
  check('J18b 再往下是"保持当前模型"：同样在视口内，页头也还在',
    await settled(fits('❯ 保持当前模型')), s.screen())
  await s.send('\u001b[A')
  await s.send('\r')
  check('J18c 落点就是屏幕上那一行',
    await settled(() => s.channel.calls.includes('switchModel:xai/model-29')), JSON.stringify(s.channel.calls))
  s.close()
}
{
  // J19（review R2）：没有 DeepSeek key、余额检查 no-key，但订阅账号已登录——第一步
  // 不再说"没有可用的凭证"，而是说明 DeepSeek 检查已跳过、已接入了谁；登录结算后的
  // 成功提示仍在。
  let signedIn = false
  let catalog: readonly { provider: string; id: string; name: string }[] = MODELS
  const channel = makeChannel({
    describeCredential: async () => ({ configured: false, source: 'none', writable: true }),
    balanceInfo: async () => ({ ok: false, reason: 'no-key' }),
    listModels: async () => catalog,
    oauthProviderStatuses: async () => [{ ...oauthRow('xai'), signedIn }],
    providerSetup: () => ({ oauth: {} }),
  })
  const s = await openWizard([], {
    step: 0,
    channel,
    signIn: async () => {
      signedIn = true
      catalog = [...MODELS, { provider: 'xai', id: 'grok-4', name: 'Grok 4' }]
      return 'added'
    },
  })
  check('J19 前置：登录前（什么都没有）照常报缺凭证',
    await settled(() => s.screen().includes(connFailText('no-key'))), s.screen())
  await settled(() => s.screen().includes('❯ 登录订阅账号'))
  s.send('\r')
  await settled(() => s.screen().includes('选择要登录的账号'))
  s.send('\r')
  check('J19a 登录后成功提示在，且不再出现"没有可用的凭证"',
    await settled(() => s.screen().includes('默认模型设为 Grok 4')
      && s.screen().includes('已跳过 DeepSeek 余额检查') && s.screen().includes('已接入：xai'))
    && !s.screen().includes(connFailText('no-key')), s.screen())
  check('J19b 凭证行改为中性说明（不再是 ✗ 还没检测到）',
    s.screen().includes('只有 DeepSeek 官方 API 需要') && !s.screen().includes('✗ 还没检测到'), s.screen())
  check('J19c 有可用接入时不再堆手工设置的兜底文案',
    !s.screen().includes('credentials.yaml') && !s.screen().includes('setx'), s.screen())
  s.close()
}
{
  // J20（review R2；本地演示里撞到的那一组）：用 /provider 配好的 key 路由同样算
  // "能用"——只有 key 真的在的路由才算，DEEPSEEK_API_KEY 那一条不算。
  const channel = makeChannel({
    describeCredential: async (name: string) => ({ configured: name === 'DEMO_GW_API_KEY', source: 'config', writable: true }),
    balanceInfo: async () => ({ ok: false, reason: 'no-key' }),
    providerSetup: () => ({
      listConfiguredProviders: () => [
        { route: 'demo-gw', ref: 'DEMO_GW_API_KEY', shadowed: false, isCatalog: false },
        { route: 'stale-gw', ref: 'STALE_GW_API_KEY', shadowed: false, isCatalog: false },
        { route: 'deepseek-official', ref: 'DEEPSEEK_API_KEY', shadowed: false, isCatalog: true },
      ],
    }),
  })
  const s = await openWizard([], { step: 0, channel, addProvider: async () => 'cancelled' })
  check('J20a 配好 key 的路由让 DeepSeek 检查变成中性说明',
    await settled(() => s.screen().includes('已接入：demo-gw')) && !s.screen().includes(connFailText('no-key')), s.screen())
  check('J20b key 不在的路由与 DEEPSEEK_API_KEY 路由都不算接入',
    !s.screen().includes('stale-gw') && !s.screen().includes('deepseek-official'), s.screen())
  s.close()
}
{
  // J21（review R3）：登录行的可见性与执行走同一个接缝（`providerSetup()?.oauth`）。
  // 只有 dsh-auth、没有 /provider 宿主服务时不画登录行（点了只会报未挂载）；
  // dsh-auth 晚于首帧组合进来时，登录行不必等"重新检查"。
  const bare = makeChannel({
    describeCredential: async () => ({ configured: false, source: 'none', writable: true }),
    oauthProviderStatuses: async () => [oauthRow('xai')],
  })
  const s = await openWizard([], { step: 0, channel: bare, signIn: async () => 'failed' })
  await settled(() => s.screen().includes('重新检查') && s.screen().includes('订阅登录不可用'))
  check('J21a 有 dsh-auth 但没有 providerSetup → 不画登录行，兜底不断言"未挂载 dsh-auth"',
    !s.screen().includes('登录订阅账号（OAuth）') && s.screen().includes('当前组合里订阅登录不可用')
    && !s.screen().includes('未挂载 dsh-auth'), s.screen())
  s.close()
  let composed = false
  const late = makeChannel({
    describeCredential: async () => ({ configured: false, source: 'none', writable: true }),
    oauthProviderStatuses: async () => composed ? [oauthRow('xai')] : undefined,
    providerSetup: () => composed ? { oauth: {} } : undefined,
  })
  const l = await openWizard([], { step: 0, channel: late, signIn: async () => 'cancelled', addProvider: async () => 'cancelled' })
  await settled(() => l.screen().includes('重新检查') && called(late, 'describeCredential'))
  const checksBefore = late.calls.filter(call => call.startsWith('describeCredential')).length
  composed = true
  await l.send('\u001b[B') // 任意一次重画（真机里是 channel 版本变化）
  check('J21b 晚到的 dsh-auth：不点"重新检查"登录行也会出现',
    await settled(() => l.screen().includes('登录订阅账号（OAuth）'))
    && late.calls.filter(call => call.startsWith('describeCredential')).length === checksBefore, l.screen())
  l.close()
}
{
  // J22（review R5）：提示行带语气——失败用 error、取消用 warning、成功用 success，
  // 重挂后从 draft 读回也是同一个语气。
  const draft = await import('../src/onboardingDraft.js')
  const outcomes: ('failed' | 'cancelled' | 'added')[] = ['failed', 'cancelled', 'added']
  let catalog: readonly { provider: string; id: string; name: string }[] = MODELS
  const channel = makeChannel({
    describeCredential: async () => ({ configured: false, source: 'none', writable: true }),
    listModels: async () => catalog,
    oauthProviderStatuses: async () => [oauthRow('xai')],
    providerSetup: () => ({ oauth: {} }),
  })
  const s = await openWizard([], {
    step: 0,
    channel,
    signIn: async () => {
      const outcome = outcomes.shift() ?? 'added'
      if (outcome === 'added') catalog = [...MODELS, { provider: 'xai', id: 'grok-4', name: 'Grok 4' }]
      return outcome
    },
  })
  const signIn = async (): Promise<void> => {
    await settled(() => s.screen().includes('❯ 登录订阅账号'))
    s.send('\r')
    await settled(() => s.screen().includes('选择要登录的账号'))
    s.send('\r')
  }
  /** 目标文本首格的前景色（xterm 的调色板/RGB 编码值）。 */
  const fg = (needle: string): number | undefined => {
    const at = findCell(s.term, needle)
    if (at === null) return undefined
    const buffer = s.term.buffer.active
    return buffer.getLine(buffer.viewportY + at.row - 1)?.getCell(at.col - 1)?.getFgColor()
  }
  await signIn()
  await settled(() => s.screen().includes('这次配置没有完成'))
  const failedTone = draft.readOnboardingDraft()?.notice?.tone
  const failedFg = fg('这次配置没有完成')
  await signIn()
  await settled(() => s.screen().includes('已取消，没有写入任何东西'))
  const cancelledTone = draft.readOnboardingDraft()?.notice?.tone
  const cancelledFg = fg('已取消，没有写入任何东西')
  await signIn()
  await settled(() => s.screen().includes('默认模型设为 Grok 4'))
  const addedTone = draft.readOnboardingDraft()?.notice?.tone
  const addedFg = fg('默认模型设为 Grok 4')
  check('J22a draft 里的语气：失败 error、取消 warning、成功 success',
    failedTone === 'error' && cancelledTone === 'warning' && addedTone === 'success',
    JSON.stringify({ failedTone, cancelledTone, addedTone }))
  check('J22b 屏幕上三种提示是三种颜色（失败/取消不再是成功色）',
    failedFg !== undefined && cancelledFg !== undefined && addedFg !== undefined
    && new Set([failedFg, cancelledFg, addedFg]).size === 3,
    JSON.stringify({ failedFg, cancelledFg, addedFg }))
  s.close()
  draft.clearOnboardingDraft()
}

{
  // J23（第二轮 review R1）：一单在跑时（draft 有 pending），登录 / 加 key 两行不能再
  // 发起第二单——否则两套流程并发提问、并发写盘，第二单顶掉 pending，第一单的结果
  // 无处结算。真实触发：问答面板在两次提问之间关掉，本屏重挂回动作列表。
  const draft = await import('../src/onboardingDraft.js')
  let release: ((outcome: 'added') => void) | undefined
  let addCalls = 0
  let catalog: readonly { provider: string; id: string; name: string }[] = MODELS
  const channel = makeChannel({ providerSetup: () => ({}), listModels: async () => catalog })
  const addProvider = (): Promise<'added'> => {
    addCalls += 1
    return new Promise((resolve) => { release = resolve })
  }
  const s = await openWizard([], { step: 0, channel, addProvider })
  await settled(() => s.screen().includes('❯ 添加模型提供方'))
  await s.send('\r')
  check('J23 前置：第一单在跑（draft 有 pending，回调调了一次）',
    await settled(() => draft.readOnboardingDraft()?.pending !== undefined && addCalls === 1),
    JSON.stringify({ addCalls, pending: draft.readOnboardingDraft()?.pending }))
  check('J23a 在跑时动作区说"配置进行中"，加 key 行写明暂不可用',
    await settled(() => s.screen().includes('上一项配置还在进行') && s.screen().includes('上一项配置结束前不能再发起')),
    s.screen())
  await s.send('\r')
  await s.click('添加模型提供方')
  check('J23b 在跑时再按 Enter / 再点一次都不发起第二单', addCalls === 1, String(addCalls))
  // 问答面板关掉后的重挂：新实例从 draft 读出"在跑"，同样不接。
  s.close()
  const again = await openWizard([], { step: 0, channel, addProvider, keepDraft: true })
  await settled(() => again.screen().includes('上一项配置还在进行'))
  await again.send('\r')
  check('J23c 重挂之后仍然不接（回调还是只调过一次）', addCalls === 1, String(addCalls))
  catalog = [...MODELS, { provider: 'demo', id: 'demo-1', name: 'demo-1' }]
  release?.('added')
  check('J23d 第一单的结果被重挂的实例接住（没有被吞掉）',
    await settled(() => again.screen().includes('已接入') && !again.screen().includes('上一项配置还在进行')),
    again.screen())
  await again.send('\r')
  check('J23e 结束后动作行恢复可用：再按 Enter 发起新的一单',
    await settled(() => addCalls === 2), String(addCalls))
  again.close()
  draft.clearOnboardingDraft()
}

if (failures === 0) console.log(`\nverify-onboarding-wizard: ${checks} checks, all passed`)
else console.error(`\nverify-onboarding-wizard: ${failures} of ${checks} checks FAILED`)
process.exit(failures === 0 ? 0 : 1)