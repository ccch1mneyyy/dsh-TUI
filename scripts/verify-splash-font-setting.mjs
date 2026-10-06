/**
 * 开屏大字字体设置（`dsh-tui.splashFont`）回归。取值只有两种语义：`daily`
 * （默认，按本地日期轮换）或注册表里的某款 id（pin 住那一款）；非法值必须回到
 * `daily`——悄悄变成某一款会让用户以为设置生效了。覆盖：
 *
 * ① 取值解析：每个合法 id 解析到自己那款，`daily` 的实义就是 `pickSplashFont`，
 *    非法值（拼错/大小写/空白/非字符串/未设置）统一回落 `daily`；
 * ② 设置经 channel 状态的往返：启动选项归一化、setter 通知与幂等、逐款都能设；
 * ③ `/settings` 选项覆盖每一个合法取值（都选得到，且中英标签齐全）；
 * ④ Config schema 的默认值与归一化（cordis.yml 那一层）；
 * ⑤ 组件缝：`fontId` 真的换脸（经典款笔画上屏、方板款笔画不在场），而 `daily`
 *    经 `splashFontIdOf` 回到按天轮换。
 *
 * 源码经 tsx 直读，不依赖已编译的 lib/。
 * Run: node --import tsx/esm scripts/verify-splash-font-setting.mjs
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
  fonts,
  { renderBigText },
  { Config },
  { configValues },
] = await Promise.all([
  import('node:assert'),
  import('node:stream'),
  import('react'),
  import('../src/ui.js'),
  import('../src/components/MessageList.js'),
  import('../src/dsh-adapter/channel.js'),
  import('./lib/term-test.mjs'),
  import('../src/components/splashFonts.js'),
  import('../src/components/bigfont.js'),
  import('../src/dsh-adapter/index.js'),
  import('../src/dsh-adapter/compat/settings.js'),
])

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
  rows = 40
  isTTY = true
  writes = []
  _write(chunk, _encoding, callback) {
    this.writes.push(String(chunk))
    callback()
  }
}

/**
 * 去 ANSI **并保留列位置**：Ink 会把成串空格压成 `CSI n C`（光标右移），直接丢掉
 * 就会把点阵字的字腔/字距吃掉，于是"哪款字体上屏"再也比不出来——这里把它还原成
 * 等量空格。
 */
const stripAnsi = text => text
  .replace(/\x1b\[(\d*)C/g, (_match, count) => ' '.repeat(count === '' ? 1 : Number(count)))
  .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
  .replace(/\x1b\]9;[^\x07]*\x07/g, '')
  .replace(/\r/g, '')

/** 轮换池的期望顺序（"按天轮换"的取模顺序；顺序变了就是用户可见的变化）。 */
const IDS = ['bold', 'square', 'bevel', 'wide', 'dot', 'stencil', 'classic', 'slab', 'shadow']
const ACCENT = { r: 63, g: 108, b: 196 }
const PALE = { r: 211, g: 225, b: 254 }

/** 某款字体上排标题的五行动画字符（去 SGR；行尾字距留白与 Ink 对齐后裁掉）。 */
const faceRows = font => renderBigText(font, font.tagline.top, 0, ACCENT, ACCENT, PALE, 60, font.tagline.topKerning)
  .map(row => stripAnsi(row).trimEnd())

/** `ready`（可选）：比默认文字条件更强的正向条件并入等待谓词，否则会断言到旧帧。 */
async function renderHeader({ columns = 120, fontId, ready }) {
  const stdout = new FakeOutput(columns)
  const stderr = new FakeOutput(columns)
  // 关掉鲸鱼：本脚本测的是大字字面，鲸鱼的半块字符会掩盖"哪款字体上屏"的断言。
  const props = { model: 'splash-font-probe', cwd: '/splash/cwd', whale: false, whaleIdle: false, skipIntro: true }
  if (fontId !== undefined) props.fontId = fontId
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
  await settle(() => {
    const raw = stdout.writes.join('')
    const plain = stripAnsi(raw)
    return plain.includes('dsh-TUI') && plain.includes('splash-font-probe')
      && (ready === undefined || ready(raw))
  })
  const raw = stdout.writes.join('')
  await instance.unmount()
  return { raw, plain: stripAnsi(raw) }
}

// ── ① 取值解析 ────────────────────────────────────────────────────────────
check('轮换池就是端口声明的 9 款，顺序稳定', () => {
  assert.deepEqual(fonts.SPLASH_FONTS.map(font => font.id), IDS)
  assert.equal(new Set(IDS).size, IDS.length)
})
check('每款都带中英标签', () => {
  for (const font of fonts.SPLASH_FONTS) {
    assert.ok(font.label.trim() !== '', `${font.id} 缺 zh 标签`)
    assert.ok(font.labelEn.trim() !== '', `${font.id} 缺 en 标签`)
  }
})

for (const id of IDS) {
  check(`[${id}] 是合法设置，归一化后仍是自己`, () => {
    assert.equal(fonts.isSplashFontSetting(id), true)
    assert.equal(fonts.normalizeSplashFont(id), id)
  })
  check(`[${id}] 按 id 取到的就是本款`, () => assert.equal(fonts.splashFontById(id).id, id))
  check(`[${id}] pin 时原样交给 LogoV2`, () => assert.equal(fonts.splashFontIdOf(id), id))
}

check('daily 是合法设置且是默认值', () => {
  assert.equal(fonts.isSplashFontSetting(fonts.SPLASH_FONT_DAILY), true)
  assert.equal(fonts.normalizeSplashFont('daily'), 'daily')
  assert.equal(fonts.normalizeSplashFont(undefined), 'daily')
})
check('daily 交回按天轮换（fontId = undefined）', () => {
  assert.equal(fonts.splashFontIdOf('daily'), undefined)
})
check('daily 的实义就是 pickSplashFont（同一天恒定、隔天换一款）', () => {
  const first = fonts.pickSplashFont(new Date(2026, 3, 1, 0, 1))
  assert.equal(first.id, fonts.pickSplashFont(new Date(2026, 3, 1, 23, 59)).id)
  assert.notEqual(first.id, fonts.pickSplashFont(new Date(2026, 3, 2)).id)
  assert.equal(fonts.splashFontIdOf(fonts.normalizeSplashFont(first.id)), first.id, '每天那款也能被 pin')
})

for (const junk of ['nope', 'NOPE', 'BOLD', '', ' ', 'daily ', 'daily\n', 'bold\t', 42, null, undefined, true, {}, ['bold']]) {
  check(`非法值 ${typeof junk === 'string' ? JSON.stringify(junk) : String(junk)} 回落 daily`, () => {
    assert.equal(fonts.isSplashFontSetting(junk), false)
    assert.equal(fonts.normalizeSplashFont(junk), 'daily')
    assert.equal(fonts.splashFontIdOf(fonts.normalizeSplashFont(junk)), undefined)
  })
}

// ── ② channel 状态往返 ────────────────────────────────────────────────────
check('channel 默认按天轮换', () => assert.equal(makeChannel().splashFont, 'daily'))
check('启动选项 pin 住一款', () => assert.equal(makeChannel({ splashFont: 'classic' }).splashFont, 'classic'))
check('启动选项里的非法值归一化为 daily', () => assert.equal(makeChannel({ splashFont: 'nope' }).splashFont, 'daily'))

const channel = makeChannel()
let notified = 0
channel.subscribe(() => { notified += 1 })
channel.setSplashFont('slab')
check('setSplashFont 更新并通知一次', () => {
  assert.equal(channel.splashFont, 'slab')
  assert.equal(notified, 1)
})
channel.setSplashFont('slab')
check('重复设置同款是无操作', () => assert.equal(notified, 1))
channel.setSplashFont('nope')
check('setSplashFont 的非法值回落 daily 并通知', () => {
  assert.equal(channel.splashFont, 'daily')
  assert.equal(notified, 2)
})
channel.setSplashFont('daily')
check('非法值归一化后与现值相同 → 不再通知', () => assert.equal(notified, 2))
for (const id of IDS) {
  check(`[${id}] 能经 channel 设置并读回`, () => {
    channel.setSplashFont(id)
    assert.equal(channel.splashFont, id)
  })
}
channel.setSplashFont(fonts.SPLASH_FONT_DAILY)
check('回到 daily 后 fontId 缝又交回轮换', () => {
  assert.equal(channel.splashFont, 'daily')
  assert.equal(fonts.splashFontIdOf(channel.splashFont), undefined)
})

// ── ③ /settings 选项 ──────────────────────────────────────────────────────
check('面板选项 = daily + 每一款，无遗漏无重复', () => {
  assert.deepEqual(fonts.SPLASH_FONT_OPTIONS.map(option => option.value), ['daily', ...IDS])
})
check('面板选项 default 在前且标签中英齐全', () => {
  assert.equal(fonts.SPLASH_FONT_OPTIONS[0].value, fonts.SPLASH_FONT_DAILY)
  for (const option of fonts.SPLASH_FONT_OPTIONS) {
    assert.ok(option.label.trim() !== '', `${option.value} 缺 en 标签`)
    assert.ok(option.descriptions.zh.trim() !== '', `${option.value} 缺 zh 标签`)
  }
})

// ── ④ Config（cordis.yml）层 ──────────────────────────────────────────────
// 未设置时解析结果是 `undefined`（volatile 包装会吞掉 transform 里的 default，与
// pageMargin 同形），默认值由 `normalizeSplashFont` 在每个读取点补上——这里连
// 「未设置 → daily」的等效性一起钉住。
check('Config 未设置时经归一化读回 daily', () => {
  assert.equal(configValues(Config({})).splashFont, undefined)
  assert.equal(fonts.normalizeSplashFont(configValues(Config({})).splashFont), 'daily')
})
check('Config 接受每一款 id', () => {
  for (const id of IDS) assert.equal(configValues(Config({ splashFont: id })).splashFont, id)
})
check('Config 的字符串非法值在解析期回落 daily', () => {
  assert.equal(configValues(Config({ splashFont: 'nope' })).splashFont, 'daily')
  assert.equal(configValues(Config({ splashFont: 'BOLD' })).splashFont, 'daily')
})
check('Config 对非字符串直接拒（与其它字符串字段同规矩）', () => {
  assert.throws(() => Config({ splashFont: 42 }), /expected string/)
  assert.throws(() => Config({ splashFont: ['bold'] }), /expected string/)
})

// ── ⑤ 组件缝：fontId 真的换脸 ─────────────────────────────────────────────
const classic = fonts.splashFontById('classic')
const slab = fonts.splashFontById('slab')
const classicRows = faceRows(classic)
const slabRows = faceRows(slab)
const showsFace = (plain, rows) => rows.every(row => row !== '' && plain.includes(row))

const classicMount = await renderHeader({ fontId: 'classic', ready: raw => stripAnsi(raw).includes(faceRows(classic)[0]) })
check('fontId=classic 时上屏的就是经典款的笔画', () => {
  assert.ok(showsFace(classicMount.plain, classicRows), '经典款笔画缺失')
})
check('pin 一款时另一款的笔画不在场', () => {
  assert.ok(!slabRows.some(row => classicMount.plain.includes(row)), '方板款笔画也上屏了')
})

const slabMount = await renderHeader({ fontId: 'slab', ready: raw => stripAnsi(raw).includes(faceRows(slab)[0]) })
check('fontId=slab 时上屏的是方板款', () => {
  assert.ok(showsFace(slabMount.plain, slabRows), '方板款笔画缺失')
  assert.ok(!classicRows.some(row => slabMount.plain.includes(row)), '经典款笔画也上屏了')
})

// 生产路径：设置值经 `splashFontIdOf` 进组件（Chat 就是这么接的）。
const dailyMount = await renderHeader({
  fontId: fonts.splashFontIdOf(fonts.normalizeSplashFont(makeChannel().splashFont)),
  ready: raw => stripAnsi(raw).includes(faceRows(fonts.pickSplashFont())[0]),
})
check('daily 走的是当天轮换那一款', () => {
  const before = fonts.pickSplashFont()
  const after = fonts.pickSplashFont()
  const shown = shown => showsFace(shown, faceRows(before)) || (after.id !== before.id && showsFace(shown, faceRows(after)))
  assert.ok(shown(dailyMount.plain), `当天应画 ${before.id}`)
})

console.log(`\nAll ${checks} splash-font-setting checks passed (${IDS.length} faces).`)
