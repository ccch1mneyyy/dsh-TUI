/**
 * 女仆娘立绘 + "求 star" 开屏弹窗回归：
 *   A. channel 语义：`dsh-tui.whaleGirl` 默认关、显式开、setWhaleGirl
 *      只在变化时通知；
 *   B. 头部渲染（真实 LogoHeader）：立绘**最优先**走终端图像协议
 *      （Kitty/Sixel）；夹具终端没有图形能力 → maid 档必须回落到
 *      **字符画女仆娘**（专属色在、文字列在、阶梯契约不动）；
 *      whale:false 时艺术整列不画；发行资产能解出方形 RGBA（sharp
 *      缺席时显式跳过）；
 *   C. 弹窗（挂真实 Chat + fake channel）：99h 档开屏弹一次（标题/正文/
 *      两颗按钮/▸ 光标/**会动的**回落鲸鱼），标语行让位（「已陪你」不出
 *      现），账本记到下一档；连按两次 Enter 只触发一次 star 动作（去重）；
 *   D. Esc 关闭后不抢键（后续 ↓/Enter 落回输入框，不再触发按钮）；
 *      ↓ 可把 ▸ 移到「在浏览器中打开」，Enter 走 open 动作；
 *   E. 非历史档（24h）不弹窗、不记账；
 *   F. 回合进行中（working）不弹窗、**不记账**——留给下一次启动。
 *   K. 登录赠金复用弹窗：宽屏女仆娘、窄屏文案、展示后回执与 Esc 关闭。
 * 运行：node --import tsx/esm scripts/verify-whale-girl.tsx
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { StarAttempt } from '../src/components/StarPrompt.js'
import type { WhaleCouponStore } from '../src/dsh-adapter/oauth/bonus.js'

process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_LANG = 'zh'
// HOME/USERPROFILE 指到空夹具目录：DATA_DIR（~/.dsh-tui）不碰真实数据，
// LogoV2 的 recordLaunch 也落在夹具里；弹窗判定的账本目录另用
// starPrompt.dir 逐 case 注入（一进程多 case，互不串档）。
const fixtureHome = mkdtempSync(join(tmpdir(), 'verify-whale-girl-'))
process.env.HOME = fixtureHome
process.env.USERPROFILE = fixtureHome

const [
  { PassThrough, Writable },
  React,
  { render, ThemeProvider, Box },
  { Chat },
  { LogoHeader },
  { createChannel },
  { QuestionStore },
  { POINTER },
  { LOCAL_COMMANDS },
  { WhaleCouponStore: CouponStore },
  { settle, settled, sleep },
] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('../src/ui.js'),
  import('../src/screens/Chat.js'),
  import('../src/components/MessageList.js'),
  import('../src/dsh-adapter/channel.js'),
  import('../src/dsh-adapter/questions.js'),
  import('../src/terminal-utils/figures.js'),
  import('../src/commands.js'),
  import('../src/dsh-adapter/oauth/bonus.js'),
  import('./lib/term-test.mjs'),
])

let failures = 0
let checks = 0
function check(name: string, ok: boolean, extra = ''): void {
  checks += 1
  if (ok) console.log(`  ✓ ${name}`)
  else {
    failures++
    console.error(`  ✗ ${name}${extra ? `  (${extra})` : ''}`)
  }
}

class FakeStdout extends Writable {
  columns: number
  rows = 30
  isTTY = true
  frames: string[] = []
  constructor(columns: number) {
    super()
    this.columns = columns
  }
  _write(chunk: unknown, _encoding: BufferEncoding, callback: () => void) {
    this.frames.push(String(chunk))
    callback()
  }
}

class FakeStderr extends Writable {
  isTTY = true
  _write(_chunk: unknown, _encoding: BufferEncoding, callback: () => void) {
    callback()
  }
}

class FakeStdin extends PassThrough {
  isTTY = true
  setRawMode() { return this }
  ref() { return this }
  unref() { return this }
}

const plainText = (frames: readonly string[]) => frames
  .join('')
  .replace(/\x1b\[(\d+)C/g, (_, n) => ' '.repeat(Number(n)))
  .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
  .replace(/\x1b\]9;[^\x07]*\x07/g, '')

// 夹具终端没有图形协议（TerminalImagesContext 默认关）：maid 档在夹具里
// 必然回落到字符画女仆娘（半块精灵的专属色互证），弹窗回落到会动的像素
// 鲸鱼（描边色）——这正是要钉住的回落契约。真图优先级由 B6 的资产面覆盖。
const MAID_HAIR = '\x1b[38;2;43;56;120m'
const MAID_WHITE = '\x1b[38;2;253;253;253m'
const WHALE_OUTLINE = '\x1b[38;2;20;38;96m'

// ── A. channel 语义 ─────────────────────────────────────────────────────────
function makeChannel(options = {}) {
  const handlers = new Map()
  const ctx = {
    on(event: string, handler: () => void) {
      handlers.set(event, handler)
      return () => handlers.delete(event)
    },
    get() { return undefined },
    logger: { warn() {} },
  }
  const agent = {
    id: 'a1',
    status: 'idle',
    session: { id: 's1', seq: 0, events: [] },
    ctx: { on: () => () => {} },
    followup() {},
    steer() {},
  }
  return createChannel(ctx, agent, {
    model: 'deepseek-chat',
    cwd: '/tmp',
    provider: 'deepseek',
    activity: false,
    ...options,
  })
}

{
  const channel = makeChannel() as { whaleGirl: boolean; setWhaleGirl(v: boolean): void; subscribe(fn: () => void): () => void }
  check('A1 channel defaults whaleGirl to off', channel.whaleGirl === false)
  check('A2 channel preserves an explicit whaleGirl=true', (makeChannel({ whaleGirl: true }) as { whaleGirl: boolean }).whaleGirl === true)
  let notified = 0
  channel.subscribe(() => { notified += 1 })
  channel.setWhaleGirl(true)
  check('A3 setWhaleGirl(true) updates and notifies once', channel.whaleGirl === true && notified === 1)
  channel.setWhaleGirl(true)
  check('A4 repeated setWhaleGirl(true) is a no-op', notified === 1)
  channel.setWhaleGirl(false)
  check('A5 setWhaleGirl(false) toggles back', channel.whaleGirl === false && notified === 2)
}

// ── B. 头部渲染（真实 LogoHeader） ──────────────────────────────────────────
// 2026-10 启动页吉祥物起，艺术槽跟随 companion.skin：deepy/whaleGirl 皮肤的
// 吉祥物按设计取代女仆娘立绘——maid 回退契约只存在于 whale 皮肤分支。
// LogoHeader 不透传 companionSkin，用 store 钉住 'whale' 来测 maid 契约本身
//（吉祥物形态归 verify-splash-mascot）。
const { applyCompanionSkin } = await import('../src/tuiDisplayPrefs.js')
applyCompanionSkin('whale')
async function renderHeader(props: Record<string, unknown>, expect?: (plain: string) => boolean) {
  const stdout = new FakeStdout(typeof props.columns === 'number' ? props.columns as number : 120)
  const { columns, ...logoProps } = props
  const instance = await render(
    React.createElement(ThemeProvider, { theme: 'dark' }, React.createElement(LogoHeader, logoProps)),
    { stdout, stderr: new FakeStderr(), stdin: new FakeStdin(), exitOnCtrlC: false, patchConsole: false },
  )
  const ready = expect ?? ((plain: string) => plain.includes('dsh-TUI') && plain.includes('whale-model-probe'))
  await settle(() => ready(plainText(stdout.frames)))
  const raw = stdout.frames.join('')
  await instance.unmount()
  return { raw, plain: plainText(stdout.frames) }
}

{
  const bothFit = await renderHeader({
    columns: 120, model: 'whale-model-probe', cwd: '/whale/cwd', whaleGirl: true,
  }, plain => plain.includes('dsh-TUI'))
  check('B1 maid mode without terminal graphics falls back to the character-art maid',
    bothFit.raw.includes(MAID_HAIR) && bothFit.raw.includes(MAID_WHITE) && !bothFit.raw.includes(WHALE_OUTLINE), 'maid colors / whale outline')
  check('B2 maid fallback keeps the text column', bothFit.plain.includes('dsh-TUI') && bothFit.plain.includes('whale-model-probe'))

  const defaultArt = await renderHeader({ columns: 120, model: 'whale-model-probe', cwd: '/whale/cwd' })
  check('B3 default stays the pixel whale', defaultArt.raw.includes(WHALE_OUTLINE) && !defaultArt.raw.includes(MAID_HAIR))

  const artOff = await renderHeader({ columns: 120, model: 'whale-model-probe', cwd: '/whale/cwd', whaleGirl: true, whale: false })
  check('B4 whale:false drops the art entirely (text-only header)', !artOff.raw.includes(MAID_HAIR) && !artOff.raw.includes(WHALE_OUTLINE) && artOff.plain.includes('dsh-TUI'))

  const whaleOnly = await renderHeader({
    columns: 48, model: 'whale-model-probe', cwd: '/whale/cwd', whaleGirl: true,
  }, plain => !plain.includes('dsh-TUI'))
  check('B5 whale-only tier keeps the ladder contract in maid mode',
    whaleOnly.raw.includes(MAID_HAIR) && !whaleOnly.plain.includes('dsh-TUI') && !whaleOnly.plain.includes('whale-model-probe'))

  // 真图数据面：两张立绘都解出 RGBA、裁掉透明边，并且**共用同一张画布**
  //（点她换「高兴鲸娘」、庆祝态换图都靠这个几何一致做干净擦除+重画）。
  const { loadMaidPortraits } = await import('../src/components/maidPortrait.js')
  const portraits = await loadMaidPortraits()
  if (portraits === undefined) console.log('  - B6 skipped: maid asset or sharp unavailable')
  else check('B6 both portraits decode to the SAME canvas geometry (clean swap)',
    portraits.normal.width === portraits.happy.width
    && portraits.normal.height === portraits.happy.height
    && portraits.normal.width > 0 && portraits.normal.height > 0
    && (portraits.normal.width < 472 || portraits.normal.height < 496)
    && portraits.normal.data.byteLength === portraits.normal.width * portraits.normal.height * 4
    && portraits.happy.data.byteLength === portraits.happy.width * portraits.happy.height * 4)
}

// ── C–F. 弹窗（挂真实 Chat） ────────────────────────────────────────────────
const HOUR_MS = 3_600_000
function seedUsage(dir: string, stats: { launches: number; totalMs: number; celebrated: number }): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'usage.json'), JSON.stringify(stats))
}
const readCelebrated = (dir: string): number =>
  (JSON.parse(readFileSync(join(dir, 'usage.json'), 'utf8')) as { celebrated: number }).celebrated

function makeChatChannel(working = false) {
  // smoke.tsx 形状的 fake channel：Chat 只读它渲染要用的面。
  return {
    version: 0,
    whaleIdle: false,
    rows: [],
    status: 'idle' as const,
    sessionTitle: 'probe',
    agentId: 'probe',
    model: 'deepseek-v4-flash',
    provider: 'deepseek',
    tokens: { input: 0, output: 0 },
    cwd: 'C:/code/demo-project',
    displayCwd: 'C:/code/demo-project',
    gitBranch: 'main',
    working,
    spinnerMode: 'requesting' as const,
    mode: { plan: false },
    responseChars: 0,
    activeToolCount: 0,
    turnStart: 0,
    lastUserText: '',
    pending: [],
    notifications: [],
    commandList: LOCAL_COMMANDS,
    contextSegments: { system: 0, prompt: 0, assistant: 0, thinking: 0, tools: 0 },
    subscribe: () => () => {},
    submit() {},
    steer() {},
    cancel() {},
    clear() {},
    notify() {},
    listModels: () => Promise.resolve([]),
    listSessions: () => [],
    setResumeTarget: () => {},
  }
}

interface ChatHandle {
  stdout: FakeStdout
  stdin: FakeStdin
  plain: () => string
  since: (mark: number) => string
  mark: () => number
  unmount: () => Promise<void>
}

async function mountChat(
  starPrompt: { dir: string; onStar?: () => StarAttempt | Promise<StarAttempt>; onOpen?: () => void } | null,
  working = false,
  bonusNotices?: WhaleCouponStore,
  columns = 100,
): Promise<ChatHandle> {
  const stdout = new FakeStdout(columns)
  stdout.rows = 28
  const stdin = new FakeStdin()
  const instance = await render(
    // Chat 包在**视口大小**的盒子里：真实运行时是 alt-screen（根=整屏），
    // 而内联夹具的根只有内容高——弹窗卡片是 absolute 且贴根底，根太矮时
    // 卡片顶端会被裁掉（实测标题整行消失）。包一层即等价于真机的根。
    <Box width={columns} height={28} flexDirection="column">
      <Chat channel={makeChatChannel(working) as never} questionStore={new QuestionStore()}
        starPrompt={starPrompt} bonusNotices={bonusNotices} />
    </Box>,
    { stdout, stdin, stderr: new FakeStderr(), exitOnCtrlC: false, patchConsole: false },
  )
  return {
    stdout,
    stdin,
    plain: () => plainText(stdout.frames),
    mark: () => stdout.frames.length,
    since: (m: number) => plainText(stdout.frames.slice(m)),
    unmount: async () => { await instance.unmount() },
  }
}

const modalShown = (text: string) => text.includes('不知不觉') && text.includes('投喂一颗 Star')

// C：99h 弹一次；Enter 走 star → 庆祝 → 自己收场；双击 Enter 只算一次；记账落档。
{
  const dir = join(fixtureHome, 'case-c')
  seedUsage(dir, { launches: 1, totalMs: 99 * HOUR_MS + 60_000, celebrated: 2 })
  const starCalls: string[] = []
  const chat = await mountChat({
    dir,
    onStar: () => { starCalls.push('star'); return { kind: 'starred' } },
    onOpen: () => { starCalls.push('open') },
  })
  check('C1 the 99h milestone opens the modal once', await settled(() => modalShown(chat.plain()), { timeoutMs: 5000 }))
  const plain = chat.plain()
  check('C2 title rides the card border', plain.includes('已经陪你 99 小时了') && plain.includes('╭'))
  check('C3 both actions and the Esc hint render',
    plain.includes('在浏览器中打开 GitHub') && plain.includes('Esc 下次一定'))
  check('C4 selection pointer starts on the star row', plain.includes(`${POINTER} 投喂一颗 Star`))
  check('C5 the modal carries the pixel whale while graphics are off', chat.stdout.frames.join('').includes(WHALE_OUTLINE))
  check('C6 the passive star line yields to the modal', !plain.includes('已陪你'))
  check('C7 the milestone is marked as asked exactly one tier up', readCelebrated(dir) === 3)
  await sleep(300) // 固定窗:pacing 弹窗画出来≠useInput 已订阅（passive effect 晚于绘制一拍），发键前等订阅就绪

  const mark = chat.mark()
  // 跨 tick 的两次 Enter：第一次触发 star（卡进 working，第二次 Enter
  // 在 working/庆祝态不再触发），两种时序下动作都恰好一次。（同 tick 写入
  // "\r\r" 会被合并成一条多字符粘贴事件，key.return 为假，不拿来当用例。）
  // 注意这里**只断言"恰好一次"**：第二次 Enter 若正好落在 phase=done 之后，
  // 会当场关窗，庆祝那一帧有没有画出来是竞态——庆祝本身由 C9 在"只按一次"
  // 的独立挂载上断言（下面的 case-c-celebrate）。
  chat.stdin.write('\r')
  await new Promise<void>(resolve => setImmediate(resolve))
  chat.stdin.write('\r')
  check('C8 a double Enter fires the star action once', await settled(() => starCalls.length === 1, { timeoutMs: 5000 })
    && starCalls[0] === 'star', `calls=${starCalls.join(',')}`)
  // 弹窗已经收场（第二次 Enter 关的），此后按键落回输入框、不再触发任何动作。
  const mark2 = chat.mark()
  chat.stdin.write('\u001b[B')
  await sleep(250) // 固定窗:pacing 按键步间节奏：↓ 与 Enter 必须是两条独立事件，不能合成粘贴
  chat.stdin.write('\r')
  await sleep(400) // 固定窗:探针 关闭后的按键不得再触发动作——"无新调用"没有可轮询锚点，只能等观察窗再断言不变
  check('C9 keys after close reach the composer, not the dead modal', starCalls.length === 1 && !chat.since(mark2).includes('在浏览器中打开 GitHub'))
  await chat.unmount()
}

// C9：只按**一次** Enter —— 庆祝要真的画出来，并自己收场。
// （独立挂载：双 Enter 的那个用例里，第二次 Enter 可能正好落在庆祝开始之后、
//  把弹窗当场关掉，庆祝那一帧画没画出来是竞态，不适合下断言。）
{
  const dir = join(fixtureHome, 'case-c-celebrate')
  seedUsage(dir, { launches: 1, totalMs: 99 * HOUR_MS + 60_000, celebrated: 2 })
  const calls: string[] = []
  const chat = await mountChat({
    dir,
    onStar: () => { calls.push('star'); return { kind: 'starred' } },
  })
  await settled(() => modalShown(chat.plain()), { timeoutMs: 5000 })
  await sleep(300) // 固定窗:pacing 等 useInput 订阅就绪再发键
  const mark = chat.mark()
  chat.stdin.write('\r')
  check('C10 a successful star celebrates instead of closing silently',
    await settled(() => chat.since(mark).includes('收到 Star') && chat.since(mark).includes('接住了一颗小星星'), { timeoutMs: 5000 })
    && calls.length === 1,
    `calls=${calls.join(',')}`)
  const mark2 = chat.mark()
  await settle(() => !chat.since(mark2).includes('收到 Star'), { timeoutMs: 9000 })
  check('C11 the celebration closes itself', !chat.since(mark2).includes('收到 Star'))
  await chat.unmount()
}

// D：Esc 关闭；↓ 把指针移到第二个动作，Enter 走 open 动作。
{
  const dir = join(fixtureHome, 'case-d')
  seedUsage(dir, { launches: 1, totalMs: 99 * HOUR_MS + 60_000, celebrated: 2 })
  const calls: string[] = []
  const chat = await mountChat({ dir, onStar: () => { calls.push('star'); return { kind: 'starred' } }, onOpen: () => { calls.push('open') } })
  check('D1 the modal opens again on a fresh ledger', await settled(() => modalShown(chat.plain()), { timeoutMs: 5000 }))
  await sleep(300) // 固定窗:pacing 同 C：画出来≠已订阅，发键前等订阅就绪
  const mark = chat.mark()
  chat.stdin.write('\u001b')
  await settle(() => chat.stdout.frames.length > mark && !chat.since(mark).includes('在浏览器中打开 GitHub'))
  check('D2 Esc closes the modal', !chat.since(mark).includes('在浏览器中打开 GitHub'))
  chat.stdin.write('\u001b[B')
  await sleep(250) // 固定窗:pacing 按键步间节奏：↓ 与 Enter 保持两条独立事件
  chat.stdin.write('\r')
  await sleep(400) // 固定窗:探针 Esc 关闭后的按键不得触发任何动作——无锚点的不变式只能等观察窗
  check('D3 keys after Esc-close do not fire any action', calls.length === 0, `calls=${calls.join(',')}`)
  await chat.unmount()

  const dir2 = join(fixtureHome, 'case-d2')
  seedUsage(dir2, { launches: 1, totalMs: 99 * HOUR_MS + 60_000, celebrated: 2 })
  const chat2 = await mountChat({ dir: dir2, onStar: () => { calls.push('star'); return { kind: 'starred' } }, onOpen: () => { calls.push('open') } })
  check('D4 the modal opens on the second fresh ledger', await settled(() => modalShown(chat2.plain()), { timeoutMs: 5000 }))
  await sleep(300) // 固定窗:pacing 同上，发键前等 useInput 订阅就绪
  const mark2 = chat2.mark()
  chat2.stdin.write('\u001b[B')
  await settle(() => chat2.since(mark2).includes(`${POINTER} 在浏览器中打开 GitHub`))
  check('D5 ↓ moves the pointer onto the browser action', chat2.since(mark2).includes(`${POINTER} 在浏览器中打开 GitHub`))
  // Enter 前另起 mark：↓ 的重绘帧里本来就带着弹窗正文，累计窗口从它
  // 之后起算，"关闭"才成立（与 C9/D2 同一模式）。
  chat2.stdin.write('\r')
  const mark3 = chat2.mark()
  await settle(() => chat2.stdout.frames.length > mark3)
  check('D6 Enter on the browser action fires open and closes', calls.length === 1 && calls[0] === 'open' && !chat2.since(mark3).includes('在浏览器中打开 GitHub'))
  await chat2.unmount()
}

// G：star 失败时卡片留在屏幕上说明原因，浏览器那条路仍可用。
{
  const dir = join(fixtureHome, 'case-g')
  seedUsage(dir, { launches: 1, totalMs: 99 * HOUR_MS + 60_000, celebrated: 2 })
  const chat = await mountChat({
    dir,
    onStar: () => ({ kind: 'failed', detail: 'boom-403', url: 'https://example.test/repo' }),
    onOpen: () => {},
  })
  check('G1 the modal opens', await settled(() => modalShown(chat.plain()), { timeoutMs: 5000 }))
  await sleep(300) // 固定窗:pacing 同 C：画出来≠已订阅，发键前等订阅就绪
  chat.stdin.write('\r')
  // 错误文案在 48 列里会折行，断言只用不会被折开的短片段。
  check('G2 a failed star keeps the card open with the reason',
    await settled(() => chat.plain().includes('没成功') && chat.plain().includes('boom-403'), { timeoutMs: 5000 }))
  check('G3 the failure view keeps the browser escape hatch', chat.plain().includes('在浏览器中打开 GitHub'))
  chat.stdin.write('\u001b')
  await sleep(300) // 固定窗:pacing Esc 关闭后确认重绘
  await chat.unmount()
}

// E：非弹窗档（50h）不弹窗；24h 这一档**会**弹（用户要求把门槛从 99h 提前）。
{
  const dir = join(fixtureHome, 'case-e')
  seedUsage(dir, { launches: 1, totalMs: 50 * HOUR_MS + 60_000, celebrated: 1 })
  const chat = await mountChat({ dir })
  await sleep(1500) // 固定窗:探针 非弹窗档不得弹窗——"不出现"没有可轮询锚点，观察窗须盖过 700ms 的弹窗延迟
  check('E1 a passive milestone never opens the modal', !chat.plain().includes('不知不觉'))
  check('E2 a passive milestone leaves the ledger untouched', readCelebrated(dir) === 1)
  await chat.unmount()
}

// E3：24h 档现在也弹窗（第一次陪你一整天）。
{
  const dir = join(fixtureHome, 'case-e3')
  seedUsage(dir, { launches: 1, totalMs: 24 * HOUR_MS + 60_000, celebrated: 0 })
  const chat = await mountChat({ dir })
  check('E3 the 24h milestone opens the modal now',
    await settled(() => modalShown(chat.plain()), { timeoutMs: 5000 }) && readCelebrated(dir) === 1)
  await chat.unmount()
}

// F：回合进行中不弹、不记账（留给下一次启动）。
{
  const dir = join(fixtureHome, 'case-f')
  seedUsage(dir, { launches: 1, totalMs: 99 * HOUR_MS + 60_000, celebrated: 2 })
  const chat = await mountChat({ dir }, true)
  await sleep(1500) // 固定窗:探针 忙时启动不得弹窗——同上，观察窗盖过 700ms 弹窗延迟
  check('F1 a busy startup never opens the modal', !chat.plain().includes('不知不觉'))
  check('F2 a busy startup does not mark the milestone', readCelebrated(dir) === 2)
  await chat.unmount()
}

// H：`Alt+S` 一键 star（与 `/star`、开屏标语点击同一个动作；默认键位不抢
// 普通字母键）。
{
  const { actionMatches } = await import('../src/utils/keymap.js')
  check('H1 Alt+S is bound to the star action', actionMatches('star', 's', { meta: true }) === true)
  check('H2 a bare s is NOT the star action (the composer keeps it)',
    actionMatches('star', 's', {}) === false && actionMatches('star', 's', { ctrl: true }) === false)

  const dir = join(fixtureHome, 'case-h')
  seedUsage(dir, { launches: 1, totalMs: 24 * HOUR_MS + 60_000, celebrated: 0 })
  const calls: string[] = []
  const chat = await mountChat({ dir, onStar: () => { calls.push('star'); return { kind: 'starred' } } })
  await sleep(300) // 固定窗:pacing 挂载后等 useInput 订阅就绪再发键
  chat.stdin.write('\u001bs')
  check('H3 Alt+S fires the one-key star action', await settled(() => calls.length === 1 && calls[0] === 'star', { timeoutMs: 4000 }),
    `calls=${calls.join(',')}`)
  await chat.unmount()
}

// I：一次性动作成功后也演庆祝（`/star`、`Alt+S`、标语点击共用 runStarAction
// ——这里用已验证端到端的 Alt+S 触发，断言的是新增的"成功→庆祝"分支）。
{
  const dir = join(fixtureHome, 'case-i')
  seedUsage(dir, { launches: 1, totalMs: 24 * HOUR_MS + 60_000, celebrated: 1 })
  const calls: string[] = []
  const chat = await mountChat({ dir, onStar: () => { calls.push('star'); return { kind: 'starred' } } })
  await sleep(400) // 固定窗:pacing 等挂载与键盘订阅就绪
  chat.stdin.write('\u001bs')
  check('I1 a successful one-key star (/star shares this path) opens the celebration',
    await settled(() => calls.length === 1 && chat.plain().includes('收到 Star'), { timeoutMs: 5000 }))
  await chat.unmount()
}

// J：本机没法一键（没装 gh / 没登录）→ **自动**打开仓库页兜底。
{
  for (const kind of ['no-gh', 'not-authed'] as const) {
    const dir = join(fixtureHome, `case-j-${kind}`)
    seedUsage(dir, { launches: 1, totalMs: 24 * HOUR_MS + 60_000, celebrated: 1 })
    const opened: string[] = []
    const chat = await mountChat({
      dir,
      onStar: () => ({ kind, url: 'https://x.test/repo' }),
      onOpen: () => { opened.push('open') },
    })
    await sleep(400) // 固定窗:pacing 等挂载与键盘订阅就绪
    chat.stdin.write('\u001bs')
    check(`J ${kind}: the browser opens by itself (no extra keystroke)`,
      await settled(() => opened.length === 1 && opened[0] === 'open', { timeoutMs: 4000 }),
      `opened=${opened.join(',')}`)
    await chat.unmount()
  }
}

// K：服务器确认的登录赠金复用庆祝弹窗，画出后才确认订单。
for (const columns of [100, 40]) {
  const coupons = new CouponStore()
  const acknowledgements: string[] = []
  const chat = await mountChat(null, false, coupons, columns)
  await coupons.refresh({
    getUnnotifiedBonuses: async () => ({ accountId: 'account-1' as never, bonuses: [{
      orderId: 'coupon-1' as never, campaign: 'dsh_login_bonus', amount: '6.00', currency: 'CNY',
      grantedAt: '2099-09-30T00:00:00Z', expiresAt: '2099-10-06T12:15:00Z', message: 'server copy',
    }] }),
    ackBonusNotified: async (_accountId, orderId) => { acknowledgements.push(orderId); return true },
  })
  check(`K${columns}: coupon modal uses the confirmed amount and Beijing expiry`,
    await settled(() => chat.plain().includes('DeepSeek 送你的') && chat.plain().includes('6 元')
      && chat.plain().includes('Deepy提醒') && chat.plain().includes('10 月 6 日 20:15'), { timeoutMs: 5000 }))
  check(`K${columns}: coupon modal has no /model instruction`, !chat.plain().includes('想让鲸鱼券开工'))
  check(`K${columns}: coupon notice is acknowledged once after display`,
    await settled(() => acknowledgements.length === 1))
  const art = chat.stdout.frames.join('')
  check(`K${columns}: the heart-pose maid fits only the wide modal`,
    (art.includes('253;162;169') || art.includes('244;119;167')) === (columns === 100))
  await sleep(150) // 固定窗:pacing 弹窗输入订阅晚于首次绘制
  chat.stdin.write('\u001b')
  check(`K${columns}: Esc dismisses the coupon modal`,
    await settled(() => coupons.getSnapshot() === null))
  await chat.unmount()
}

rmSync(fixtureHome, { recursive: true, force: true })
if (failures > 0) {
  console.error(`\n${failures} of ${checks} whale-girl checks FAILED.`)
  process.exit(1)
}
console.log(`\nAll ${checks} whale-girl checks passed.`)
