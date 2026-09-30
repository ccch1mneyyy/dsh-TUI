/**
 * Component and channel regression for settings `dsh-tui.whale`.
 * Imports source through tsx, so it never relies on a pre-existing lib/ tree.
 *
 * Run: node --import tsx/esm scripts/verify-whale-toggle.mjs
 */
process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_LANG = 'en'

const [
  { strict: assert },
  { PassThrough, Writable },
  React,
  { render, ThemeProvider },
  { LogoHeader },
  { createChannel },
  { settle },
  { TIPS },
] = await Promise.all([
  import('node:assert'),
  import('node:stream'),
  import('react'),
  import('../src/ui.js'),
  import('../src/components/MessageList.js'),
  import('../src/dsh-adapter/channel.js'),
  import('./lib/term-test.mjs'),
  import('../src/tips.js'),
])

/** 固定的一条 tip：两条 renderHeader 序列要比字节，随机 tip 会让它们无端不同。 */
const PINNED_TIP = TIPS[0]

let checks = 0
function check(name, test) {
  try {
    test()
    checks += 1
    console.log(`PASS: ${name}`)
  } catch (error) {
    console.error(`FAIL: ${name}`)
    throw error
  }
}

function makeChannel(options = {}) {
  const handlers = new Map()
  const ctx = {
    on(event, handler) {
      handlers.set(event, handler)
      return () => handlers.delete(event)
    },
    get() {
      return undefined
    },
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

class FakeStdin extends PassThrough {
  isTTY = true
  setRawMode() { return this }
  ref() { return this }
  unref() { return this }
}

class FakeOutput extends Writable {
  constructor(columns) {
    super()
    this.columns = columns
  }
  rows = 30
  isTTY = true
  writes = []
  _write(chunk, _encoding, callback) {
    this.writes.push(String(chunk))
    callback()
  }
}

const stripAnsi = text => text
  .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
  .replace(/\x1b\]9;[^\x07]*\x07/g, '')
const WHALE_OUTLINE = '\x1b[38;2;20;38;96m'

// `ready`（可选）：call site 断言里比默认文字条件更强的正向条件必须并入
// 等待谓词（#561 弱条件分叉），否则 settle 等到文字就返回、断言到旧帧。
// `intro` 钉住开场序列（不钉就是随机 roll）；`probeAfterMs` 在 unmount **之前**
// 再采一次已写字节——开场是 unmount 后不再产生的定时器帧，只有挂载期间能取到。
async function renderHeader({ columns, whale, intro, skipIntro, ready, expect, probeAfterMs }) {
  const stdout = new FakeOutput(columns)
  const stderr = new FakeOutput(columns)
  const props = { model: 'whale-model-probe', cwd: '/whale/cwd', tip: PINNED_TIP }
  if (whale !== undefined) props.whale = whale
  if (intro !== undefined) props.intro = intro
  if (skipIntro !== undefined) props.skipIntro = skipIntro
  const instance = await render(
    React.createElement(
      ThemeProvider,
      { theme: 'dark' },
      React.createElement(LogoHeader, props),
    ),
    {
      stdout,
      stderr,
      stdin: new FakeStdin(),
      exitOnCtrlC: false,
      patchConsole: false,
    },
  )
  // 探针从**挂载**起算：settle 落地时间本身随开场长短变化，以它为基准会把
  // unmount 也推后不同时长，两次采样的字节量就没法比。固定基准后，3.5s 时
  // 开场（约 2.75s）早已跑完、静止帧不再变化，采样结果只反映开场有没有跑。
  if (probeAfterMs !== undefined) {
    await new Promise(resolve => setTimeout(resolve, probeAfterMs))
    const afterProbe = stdout.writes.join('')
    await instance.unmount()
    return { raw: afterProbe, plain: stripAnsi(afterProbe), afterProbe }
  }
  // 默认等「文字列画出来了」；纯鲸鱼档没有文字列，用 expect 换掉这个前提。
  const settled = expect ?? (plain => plain.includes('dsh-TUI') && plain.includes('whale-model-probe'))
  await settle(() => {
    const raw = stdout.writes.join('')
    const plain = stripAnsi(raw)
    return settled(plain) && (ready === undefined || ready(raw))
  })
  const raw = stdout.writes.join('')
  await instance.unmount()
  return { raw, plain: stripAnsi(raw), afterProbe: null }
}

// Channel defaults and live setter semantics.
check('channel defaults whale to on', () => assert.equal(makeChannel().whale, true))
check('channel preserves an explicit whale=false', () => assert.equal(makeChannel({ whale: false }).whale, false))
const channel = makeChannel()
let notified = 0
channel.subscribe(() => { notified += 1 })
channel.setWhale(false)
check('setWhale(false) updates and notifies once', () => {
  assert.equal(channel.whale, false)
  assert.equal(notified, 1)
})
channel.setWhale(false)
check('repeated setWhale(false) is a no-op', () => assert.equal(notified, 1))
channel.setWhale(true)
check('setWhale(true) restores the default view', () => {
  assert.equal(channel.whale, true)
  assert.equal(notified, 2)
})

// Real LogoHeader -> LogoV2 rendering: default, explicit opt-out, and narrow fallback.
// 宽度按**阶梯**取，不按字体取：120 列放得下任何一款轮换字体与鲸鱼并排
// （最宽的 wide 需要 40 + 2 + 71 = 113 列），35 列连大字都放不下——这样断言
// 与「今天轮到哪款字体」无关。
const BOTH_FIT_COLUMNS = 120
const NOTHING_FITS_COLUMNS = 35
const wideDefault = await renderHeader({ columns: BOTH_FIT_COLUMNS, ready: raw => raw.includes(WHALE_OUTLINE) })
check('wide LogoHeader shows whale by default', () => {
  assert.ok(wideDefault.raw.includes(WHALE_OUTLINE), 'whale palette marker missing')
  assert.ok(wideDefault.plain.includes('dsh-TUI'), 'text logo missing')
})

const wideDisabled = await renderHeader({ columns: BOTH_FIT_COLUMNS, whale: false })
check('LogoHeader forwards whale=false while preserving the text logo', () => {
  assert.ok(!wideDisabled.raw.includes(WHALE_OUTLINE), 'whale palette marker still rendered')
  assert.ok(wideDisabled.plain.includes('dsh-TUI'), 'text logo missing')
  assert.ok(wideDisabled.plain.includes('whale-model-probe'), 'header details missing')
})

// #971：whale=false 只是不画像素鲸鱼，开场计时仍会走完——用户看到的仍是那段开屏
// （文字列的逐帧入场照放）。鲸鱼关闭时开场帧里没有任何独有颜色，所以这里比的是
// **和显式 skipIntro 同不同**：两者都是无鲸鱼、直落静止标题的组合，唯一差别就是
// 有没有在挂载时跑完那串文字帧。钉住 intro 免得撞上随机 roll。
const introWhaleOff = await renderHeader({
  columns: BOTH_FIT_COLUMNS,
  whale: false,
  intro: 'heart',
  probeAfterMs: 3500,
})
const introSkipped = await renderHeader({
  columns: BOTH_FIT_COLUMNS,
  whale: false,
  intro: 'heart',
  skipIntro: true,
  probeAfterMs: 3500,
})
check('whale=false mounts the settled header, not a whale-less replay of the intro', () => {
  assert.equal(
    introWhaleOff.afterProbe,
    introSkipped.afterProbe,
    'whale=false emitted a different frame sequence than an explicitly skipped intro',
  )
  assert.ok(introWhaleOff.plain.includes('dsh-TUI'), 'text logo missing')
})

const narrowDefault = await renderHeader({ columns: NOTHING_FITS_COLUMNS })
check('narrow terminal drops the whale and falls back to the plain title', () => {
  assert.ok(!narrowDefault.raw.includes(WHALE_OUTLINE), 'whale should hide when the art no longer fits')
  assert.ok(narrowDefault.plain.includes('dsh-TUI'), 'text logo missing')
  assert.ok(narrowDefault.plain.includes('whale-model-probe'), 'header details missing')
})

// 阶梯独有的一档：48 列时大字放不下（最窄的 classic/slab 也要 54 列）、鲸鱼还放得下
// ——只渲染鲸鱼，文字列整列不画（画出来只会是 `✦ dsh…` 这种残句）。对任何一款轮换
// 字体都是这一档，所以这与"今天轮到哪款字体"无关。
const WHALE_ONLY_COLUMNS = 48
const whaleOnly = await renderHeader({
  columns: WHALE_ONLY_COLUMNS,
  expect: plain => !plain.includes('dsh-TUI'),
  ready: raw => raw.includes(WHALE_OUTLINE),
})
check('whale-only tier renders the art and drops the whole text column', () => {
  assert.ok(whaleOnly.raw.includes(WHALE_OUTLINE), 'whale missing in the whale-only tier')
  assert.ok(!whaleOnly.plain.includes('dsh-TUI'), 'text column should not render in the whale-only tier')
  assert.ok(!whaleOnly.plain.includes('whale-model-probe'), 'header details should not render either')
})

console.log(`\nAll ${checks} whale-toggle checks passed.`)
