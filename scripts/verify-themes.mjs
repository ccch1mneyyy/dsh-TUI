/**
 * Theme subsystem smoke test (no assertions framework, plain node:assert).
 *
 * Creates a throwaway HOME with a fake ~/.dsh-tui/themes directory containing
 * one valid theme, one format-exercise theme, and one of each failure mode
 * (unknown key, invalid color, bad base, broken JSON), then asserts that
 * loading, validation, fallback and persistence behave as designed.
 *
 * Run after (or before) tsc — the script imports the TypeScript sources
 * directly through tsx:
 *   node --import tsx/esm scripts/verify-themes.mjs
 */

import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'

// Point HOME/USERPROFILE at a throwaway dir BEFORE importing the modules, so
// their module-level dirs (~/.dsh-tui, ~/.dsh-tui/themes) resolve there.
const tmpHome = mkdtempSync(join(tmpdir(), 'dshtui-theme-test-'))
process.env.USERPROFILE = tmpHome
process.env.HOME = tmpHome
// The render half of this script (colorize) is chalk-backed and chalk fixes its
// level on first import; force truecolor so the SGR assertions are deterministic
// outside a TTY.
process.env.FORCE_COLOR = '3'

const {
  CUSTOM_THEME_DIR,
  parseCustomTheme,
  loadCustomTheme,
  listCustomThemes,
  buildTheme,
  isValidThemeColor,
  isThemeAvailable,
  resolveCustomTheme,
  clearCustomThemeCache,
} = await import('../src/customTheme.js')
const { parseThemePref, readThemePref, writeThemePref } = await import('../src/themePrefs.js')
const {
  getTheme,
  registerCustomThemeResolver,
  registerRuntimeThemeResolver,
  setAutoThemeBase,
  getAutoThemeBase,
  isLightThemeActive,
  cursorGlyphColor,
  THEME_NAMES,
} = await import('../src/theme.js')
// The chrome keys (context-bar fills, ignition pair, caret) are consumed by two
// modules; assert the consumption here, where the palettes are already at hand.
const { contextBarSegmentColors } = await import('../src/screens/StatusMetrics.js')
const { ignitionColors } = await import('../src/trajectory/effortIgnition.js')
const { colorize } = await import('../src/ink/colorize.js')

/** Keys added for the hardcoded chrome (context bar / effort ignition / caret). */
const CHROME_KEYS = [
  'contextBarSystem',
  'contextBarPrompt',
  'contextBarAssistant',
  'contextBarThinking',
  'contextBarTools',
  'ignition',
  'ignitionDim',
  'cursor',
]
/** The pre-theme segment ramp a palette without the keys falls back to. */
const FALLBACK_SEGMENTS = ['#22305F', '#2B3D78', '#344A92', '#4D6BFE', '#5A7CFF']

const themesDir = join(tmpHome, '.dsh-tui', 'themes')
mkdirSync(themesDir, { recursive: true })

// --- fixture files: one valid, one exercising every accepted color form,
// one of each failure mode ------------------------------------------------
const FIXTURES = {
  'good.json': JSON.stringify({
    name: 'sakura',
    displayName: '樱花粉',
    base: 'dark',
    colors: { accent: '#FF9EC7', text: '#E8E6E0' },
  }),
  // name/displayName omitted -> file name / name
  'unnamed.json': JSON.stringify({
    base: 'light',
    colors: { accent: '#3F6CC4' },
  }),
  // every accepted color form
  'format.json': JSON.stringify({
    name: 'format',
    base: 'dark-ansi',
    colors: {
      accent: '#abc',
      text: '#aabbcc',
      subtle: '#aabbccdd',
      success: 'rgb(130,184,157)',
      error: 'ansi256(196)',
      warning: 'ansi:yellowBright',
    },
  }),
  // unknown key skipped, known key kept
  'unknown-key.json': JSON.stringify({
    base: 'dark',
    colors: { accent: '#123456', noSuchKey: '#000000' },
  }),
  // the chrome keys: hex forms must reach the bar fills, the ignition pair and
  // the caret (they are consumed as raw color values, not as theme tokens)
  'chrome.json': JSON.stringify({
    name: 'chrome',
    base: 'dark',
    colors: {
      contextBarSystem: '#101010',
      contextBarPrompt: '#202020',
      contextBarAssistant: '#303030',
      contextBarThinking: '#404040',
      contextBarTools: '#505050',
      ignition: '#00FF00',
      ignitionDim: '#000000',
      cursor: '#ABCDEF',
    },
  }),
  // invalid value skipped, valid sibling kept
  'bad-color.json': JSON.stringify({
    base: 'dark',
    colors: { accent: 'hotpink', text: '#E8E6E0' },
  }),
  // invalid base -> whole file skipped
  'bad-base.json': JSON.stringify({
    base: 'neon',
    colors: { accent: '#FF0000' },
  }),
  // broken JSON -> whole file skipped, no crash
  'broken.json': '{ "base": "dark", "colors": { "accent": ',
}
for (const [file, contents] of Object.entries(FIXTURES)) {
  writeFileSync(join(themesDir, file), contents)
}

// --- capture warnings issued during parsing --------------------------------
const warnings = []
const originalWarn = console.warn
console.warn = (...args) => {
  warnings.push(args.join(' '))
}

let failures = 0
const check = (name, fn) => {
  try {
    fn()
    console.log(`  ok   ${name}`)
  } catch (error) {
    failures += 1
    console.error(`  FAIL ${name}`)
    console.error(`       ${error.message}`)
  }
}

check('palette: light panels are white without changing accent or dark surfaces', () => {
  const light = getTheme('light')
  assert.equal(light.toolCardBackground, 'rgb(255,255,255)')
  assert.equal(light.toolCardBackgroundDim, 'rgb(255,255,255)')
  assert.notEqual(light.text, light.toolCardBackground, 'body text stays readable on white')
  assert.notEqual(light.background, light.toolCardBackground, 'badge accent remains distinct from panel fill')
  assert.equal(getTheme('dark').toolCardBackground, 'rgb(36,43,58)')
  assert.equal(getTheme('dark-ansi').toolCardBackground, 'ansi:blackBright')
})

// The Theme contract is the union of every built-in palette: a new palette that
// forgets a key would otherwise render a component with `undefined`. Assert the
// full shape for all of them at once instead of spot-checking values, so the
// next family cannot land half-covered.
check('palette: every built-in covers the full Theme contract', () => {
  const reference = Object.keys(getTheme('dark')).sort()
  // 键数本身就是契约：只比「期望集 vs 被测集」的话，从 `Theme` 与六套色板
  // 同时删一键会让两边一起缩水，消费方拿到的 `undefined` 无人咬。
  assert.equal(reference.length, 81, 'Theme contract key count')
  for (const name of THEME_NAMES) {
    const palette = getTheme(name)
    assert.deepEqual(Object.keys(palette).sort(), reference, `${name} key set`)
    for (const [key, value] of Object.entries(palette)) {
      // The two slots upstream deliberately keeps empty: the user turn gets no
      // fill, only its label color, and an empty caret means the inverse-video
      // block (a theme only declares `cursor` to split the caret off it).
      if (key === 'userMessageBackground' || key === 'cursor') continue
      assert.ok(typeof value === 'string' && value !== '', `${name}.${key} is empty`)
    }
  }
  assert.deepEqual(
    THEME_NAMES.filter(name => name.startsWith('pink-')).sort(),
    ['pink-ansi', 'pink-day', 'pink-night'],
    'the sakura family ships all three roles',
  )
})

check('palette: the sakura family keeps the mist family role split', () => {
  assert.equal(getTheme('pink-night').text, 'rgb(240,228,233)', 'dark ink stays light')
  assert.equal(getTheme('pink-day').toolCardBackground, 'rgb(249,236,241)', 'light palette uses a panel surface')
  assert.equal(getTheme('pink-ansi').toolCardBackground, 'ansi:blackBright', 'ansi palette stays 16-color')
  assert.equal(getTheme('pink-night').accent, getTheme('pink-night').activity, 'brand and activity share the accent')
  assert.equal(getTheme('pink-night').userMessageBackground, '', 'user turn keeps no fill')
})

// The sakura family is the reason the chrome keys exist: these palettes ship a
// pink ramp, so a dropped key would silently fall back to the pre-theme navy
// ramp (the wave pair falls back silently too, and only fixed-channel forms
// reach it — an `ansi:*` `ignition` renders the built-in blue wave instead of
// failing). The caret is the one chrome key the family leaves empty, like the
// mist family: empty keeps the inverse-video block. Every value is pinned.
const SAKURA_CHROME = {
  'pink-night': {
    contextBarSystem: 'rgb(110,27,60)', contextBarPrompt: 'rgb(155,44,85)',
    contextBarAssistant: 'rgb(194,77,120)', contextBarThinking: 'rgb(232,121,160)',
    contextBarTools: 'rgb(247,183,204)', ignition: 'rgb(242,123,166)',
    ignitionDim: 'rgb(36,26,32)', cursor: '',
  },
  // The light crest is its own deeper pink: neither the old neon #FF2D6F nor
  // the night's softened #F27BA6 reads on this palette's `#FFE3EC` blush (2.98:1
  // and 2.14:1), and #E879A0 stops the ramp above it.
  'pink-day': {
    contextBarSystem: 'rgb(110,27,60)', contextBarPrompt: 'rgb(155,44,85)',
    contextBarAssistant: 'rgb(194,77,120)', contextBarThinking: 'rgb(232,121,160)',
    contextBarTools: 'rgb(238,143,176)', ignition: 'rgb(176,58,99)',
    ignitionDim: 'rgb(255,227,236)', cursor: '',
  },
  'pink-ansi': {
    contextBarSystem: 'ansi:blackBright', contextBarPrompt: 'ansi:magenta',
    contextBarAssistant: 'ansi:magentaBright', contextBarThinking: 'ansi:white',
    contextBarTools: 'ansi:whiteBright', ignition: 'rgb(242,123,166)',
    ignitionDim: 'rgb(36,26,32)', cursor: '',
  },
}
check('palette: the sakura family carries the chrome keys', () => {
  for (const [name, expected] of Object.entries(SAKURA_CHROME)) {
    assert.deepEqual(Object.keys(expected), CHROME_KEYS, `${name} pins every chrome key`)
    const palette = getTheme(name)
    for (const key of CHROME_KEYS) assert.equal(palette[key], expected[key], `${name}.${key}`)
  }
})

// The caret glyph is not unconditionally `inverseText` any more: whichever ink
// contrasts with the declared fill wins. No built-in declares one, so the
// synthetic palettes below stand in for the user/plugin themes that do.
check('palette: the caret glyph follows the fill, not the inverse assumption', () => {
  // Six empty carets: the pre-key inverse-video block, unchanged.
  for (const name of THEME_NAMES) {
    assert.equal(cursorGlyphColor(getTheme(name)), 'inverseText', `${name} keeps the inverse glyph`)
  }
  // 同一填充、两种答案：pink-night 的近黑 `inverseText`（#2B1E25）在粉底上
  // 对比度更高；pink-day 的近白 `inverseText`（#FBF3F0）输给深墨 `text`（#3D2B33）。
  assert.equal(cursorGlyphColor({ ...getTheme('pink-night'), cursor: '#E879A0' }), 'inverseText')
  assert.equal(cursorGlyphColor({ ...getTheme('pink-day'), cursor: '#E879A0' }), 'text')
  // A 16-color or empty fill carries no channels to measure: pre-key behavior.
  const dark = getTheme('dark')
  assert.equal(cursorGlyphColor({ ...dark, cursor: 'ansi:magentaBright' }), 'inverseText')
  assert.equal(cursorGlyphColor({ ...dark, cursor: '' }), 'inverseText')
  assert.equal(cursorGlyphColor({ ...dark, cursor: '#00FF00' }), 'inverseText')
  assert.equal(cursorGlyphColor({ ...dark, cursor: '#101010' }), 'text')
  // 八位 hex 与六位写法同底色（渲染丢 alpha），字色必须同判。
  assert.equal(cursorGlyphColor({ ...dark, cursor: '#000000ff' }), 'text')
  assert.equal(
    cursorGlyphColor({ ...dark, cursor: '#000000ff' }),
    cursorGlyphColor({ ...dark, cursor: '#000000' }),
  )
  assert.equal(cursorGlyphColor({ ...dark, cursor: '#10101080' }), 'text')
})

// 驱动组件（点火坡道、提示输入的 onLight、默认前景）消费的是这个**答案**。
// 注意断言只钉答案：六套内置的身份分支与亮度分支今天恰好同答，所以删掉
// `isLightThemeActive` 里的身份分支这些断言仍全绿——机制本身没有可观测接缝，
// 这里守的是答案不回退。
check('light detection: every built-in lands on the right side', () => {
  assert.ok(isLightThemeActive('light'))
  assert.ok(isLightThemeActive('pink-day'))
  assert.ok(!isLightThemeActive('dark'))
  assert.ok(!isLightThemeActive('dark-ansi'))
  assert.ok(!isLightThemeActive('pink-night'))
  assert.ok(!isLightThemeActive('pink-ansi'))
})

// 校验器放行的墨色写法都必须判得出来：只认紧凑 `rgb()` 时，hex 墨（最常见的写法）
// 与带空白的 `rgb()` 会被按深色算——浅色用户主题的点火回落对、底栏空余段与图片衬底
// 一起取错。`ansi:*` 没有绝对通道值（由终端调色板决定），按深色算是有意口径。
check('light detection: every validator-accepted ink form is read', () => {
  let palette = { ...getTheme('light') }
  const dispose = registerRuntimeThemeResolver(name =>
    name === 'ink-form-probe' ? palette : undefined)
  try {
    for (const [text, want] of [
      ['#123', true], ['#112233', true], ['#11223380', true],
      ['rgb(17,34,51)', true], ['rgb(17, 34, 51)', true], ['rgb( 17 , 34 , 51 )', true],
      ['#EEF2F7', false], ['rgb(238, 242, 247)', false], ['ansi:black', false],
    ]) {
      assert.ok(isValidThemeColor(text), `${text}: no longer validator-accepted`)
      palette = { ...palette, text }
      assert.equal(isLightThemeActive('ink-form-probe'), want, `ink ${text}`)
    }
  } finally {
    dispose()
  }
})

// --- parsing / validation --------------------------------------------------
const goodText = FIXTURES['good.json']
check('parse: valid theme fields', () => {
  const spec = parseCustomTheme(goodText, 'good.json')
  assert.ok(spec)
  assert.equal(spec.name, 'sakura')
  assert.equal(spec.displayName, '樱花粉')
  assert.equal(spec.base, 'dark')
  assert.deepEqual(spec.colors, { accent: '#FF9EC7', text: '#E8E6E0' })
})

check('parse: name/displayName default to file name', () => {
  const spec = parseCustomTheme(FIXTURES['unnamed.json'], 'unnamed.json')
  assert.ok(spec)
  assert.equal(spec.name, 'unnamed')
  assert.equal(spec.displayName, 'unnamed')
})

check('parse: displayName internal CR/LF flattened at the entry', () => {
  // displayName 会进入按固定行高切片的列表行（ThemePicker/Select）与状态栏
  // 等单行 UI——内部换行必须在入口压平（四次审查 P3；ListItem 的递归压平
  // 是第二道防线，不能替代入口断言）。\n、\r、\r\n、连续换行各自折叠为一个
  // 空格。
  for (const [raw, want] of [
    ['A\nB', 'A B'],
    ['A\rB', 'A B'],
    ['A\r\nB', 'A B'],
    ['A\n\nB', 'A B'],
  ]) {
    const spec = parseCustomTheme(
      JSON.stringify({ name: 'nl', displayName: raw, base: 'dark' }),
      'nl.json',
    )
    assert.ok(spec)
    assert.equal(spec.displayName, want, `displayName ${JSON.stringify(raw)}`)
  }
})

check('parse: bad JSON rejected, no throw', () => {
  assert.equal(parseCustomTheme(FIXTURES['broken.json'], 'broken.json'), undefined)
})

check('parse: bad base rejects the whole file', () => {
  assert.equal(parseCustomTheme(FIXTURES['bad-base.json'], 'bad-base.json'), undefined)
})

check('parse: unknown key skipped, valid sibling kept', () => {
  const spec = parseCustomTheme(FIXTURES['unknown-key.json'], 'unknown-key.json')
  assert.ok(spec)
  assert.deepEqual(Object.keys(spec.colors), ['accent'])
  assert.equal(spec.colors.accent, '#123456')
})

check('parse: invalid color skipped, valid sibling kept', () => {
  const spec = parseCustomTheme(FIXTURES['bad-color.json'], 'bad-color.json')
  assert.ok(spec)
  assert.deepEqual(Object.keys(spec.colors), ['text'])
  assert.equal(spec.colors.text, '#E8E6E0')
})

check('parse: every accepted color form passes', () => {
  assert.ok(isValidThemeColor('#abc'))
  assert.ok(isValidThemeColor('#aabbcc'))
  assert.ok(isValidThemeColor('#aabbccdd'))
  assert.ok(isValidThemeColor('rgb(130,184,157)'))
  assert.ok(isValidThemeColor('rgb(255,255,255)'))
  assert.ok(isValidThemeColor('ansi256(196)'))
  assert.ok(isValidThemeColor('ansi:yellowBright'))
  assert.ok(!isValidThemeColor('hotpink'))
  assert.ok(!isValidThemeColor('red'))
  assert.ok(!isValidThemeColor('#12345'))
  assert.ok(!isValidThemeColor('#gggggg'))
  assert.ok(!isValidThemeColor('rgb(300,0,0)'))
  assert.ok(!isValidThemeColor('ansi256(300)'))
  assert.ok(!isValidThemeColor('ansi:chartreuse'))
  assert.ok(!isValidThemeColor(42))
  assert.ok(!isValidThemeColor(undefined))
})

// 校验器接受的形式**必须**能画上屏：`rgb(0 ,0,0)` 曾通过校验却在
// colorize 里解析失败——不是可见报错，而是静默不上色（光标块没有背景、底栏
// 分段没有填充）。断言表从校验器派生：先要求形式仍被接受，再要求真的出 SGR，
// 两边语法漂移时这里先红。
check('render: every accepted color form paints, whitespace included', () => {
  const exact = [
    // [值, 前景 SGR, 背景 SGR] —— 只钉真彩/256 色的起始序列。
    ['rgb(0 ,0,0)', '\u001b[38;2;0;0;0m', '\u001b[48;2;0;0;0m'],
    ['rgb(0,  0,0)', '\u001b[38;2;0;0;0m', '\u001b[48;2;0;0;0m'],
    ['rgb( 0,0,0)', '\u001b[38;2;0;0;0m', '\u001b[48;2;0;0;0m'],
    ['ansi256(  33)', '\u001b[38;5;33m', '\u001b[48;5;33m'],
    // 八位 hex：渲染丢 alpha，背景与六位写法逐字节相同。
    ['#000000ff', '\u001b[38;2;0;0;0m', '\u001b[48;2;0;0;0m'],
    ['#abc', '\u001b[38;2;170;187;204m', '\u001b[48;2;170;187;204m'],
    ['ansi:red', '\u001b[31m', '\u001b[41m'],
  ]
  for (const [value, fg, bg] of exact) {
    assert.ok(isValidThemeColor(value), `${value}: no longer validator-accepted, update the table`)
    assert.ok(colorize('x', value, 'foreground').startsWith(fg), `fg ${value}`)
    assert.ok(colorize('x', value, 'background').startsWith(bg), `bg ${value}`)
  }
  // 校验器拒绝的值保持原样：上色层是超集，不是第二套校验器。
  assert.equal(colorize('x', 'hotpink', 'foreground'), 'x')
  assert.equal(colorize('x', undefined, 'background'), 'x')
})

check('load: missing file is silent (undefined, no warning added)', () => {
  const before = warnings.length
  assert.equal(loadCustomTheme('does-not-exist'), undefined)
  assert.equal(warnings.length, before)
})

check('load: unsafe name never touches the fs', () => {
  assert.equal(loadCustomTheme('../evil'), undefined)
  assert.equal(loadCustomTheme('..'), undefined)
})

// --- discovery -------------------------------------------------------------
check('list: valid + salvageable files only, sorted by theme name', () => {
  const specs = listCustomThemes()
  assert.deepEqual(
    specs.map(s => s.name),
    ['bad-color', 'chrome', 'format', 'sakura', 'unknown-key', 'unnamed'],
  )
  assert.ok(specs.every(s => !['bad-base', 'broken'].includes(s.name)))
  // the underlying file name stays reachable for loading
  assert.equal(specs.find(s => s.name === 'sakura')?.file, 'good')
})

// --- composition -----------------------------------------------------------
check('build: overrides land on the base palette', () => {
  const theme = buildTheme(parseCustomTheme(goodText, 'good.json'))
  assert.equal(theme.accent, '#FF9EC7')
  assert.equal(theme.text, '#E8E6E0')
  // untouched keys come from the dark base
  assert.equal(theme.success, getTheme('dark').success)
  assert.equal(theme.background, getTheme('dark').background)
})

check('resolve: cached full palette via the name', () => {
  clearCustomThemeCache()
  const theme = resolveCustomTheme('good')
  assert.ok(theme)
  assert.equal(theme.accent, '#FF9EC7')
  assert.equal(theme.success, getTheme('dark').success)
  assert.equal(resolveCustomTheme('good'), theme) // cached identity
  assert.equal(resolveCustomTheme('nope'), undefined)
})

check('resolve: a name field differing from the file name still resolves', () => {
  clearCustomThemeCache()
  // sakura.json does not exist on disk — good.json declares name: sakura.
  const theme = resolveCustomTheme('sakura')
  assert.ok(theme)
  assert.equal(theme.accent, '#FF9EC7')
  assert.equal(resolveCustomTheme('sakura'), theme)
})

check('isThemeAvailable: built-ins and valid user themes, not the rest', () => {
  assert.ok(isThemeAvailable('dark'))
  assert.ok(isThemeAvailable('light'))
  assert.ok(isThemeAvailable('dark-ansi'))
  assert.ok(isThemeAvailable('pink-night'))
  assert.ok(isThemeAvailable('pink-day'))
  assert.ok(isThemeAvailable('pink-ansi'))
  assert.ok(isThemeAvailable('good'))
  assert.ok(isThemeAvailable('format'))
  assert.ok(!isThemeAvailable('bad-base'))
  assert.ok(!isThemeAvailable('broken'))
  assert.ok(!isThemeAvailable('nope'))
  assert.ok(!isThemeAvailable('../evil'))
})

check('getTheme: registry resolves user themes, built-ins untouched', () => {
  registerCustomThemeResolver(resolveCustomTheme)
  assert.equal(getTheme('sakura').accent, '#FF9EC7') // display name via index
  assert.equal(getTheme('good').accent, '#FF9EC7') // file name alias
  assert.equal(getTheme('dark'), getTheme('dark')) // built-in identity preserved
  assert.equal(getTheme('nope').accent, getTheme('dark').accent) // unknown -> dark
})

// --- chrome keys: context bar, effort ignition, caret ----------------------
// The other seven chrome keys need no separate check: the contract check above
// asserts every built-in's key set and non-empty values, and SAKURA_CHROME
// pins the sakura values one by one.
check('chrome: every built-in keeps the inverse-video caret', () => {
  for (const name of THEME_NAMES) {
    // `cursor` is the one slot the contract check skips on purpose: empty means
    // the inverse-video caret every palette had before the key existed.
    assert.equal(getTheme(name).cursor, '', `${name}.cursor`)
  }
})

check('chrome: the bar fills come from the palette, in bar order', () => {
  assert.deepEqual(contextBarSegmentColors(getTheme('chrome')), [
    '#101010', '#202020', '#303030', '#404040', '#505050',
  ])
  // Built-ins keep the ramp they rendered before the keys existed.
  assert.deepEqual(contextBarSegmentColors(getTheme('dark')), [
    'rgb(34,48,95)', 'rgb(43,61,120)', 'rgb(52,74,146)', 'rgb(77,107,254)', 'rgb(90,124,255)',
  ])
})

check('chrome: ignition follows the palette (hex accepted) and light/dark fallback', () => {
  assert.deepEqual(ignitionColors('chrome').ignition, { r: 0, g: 255, b: 0 })
  assert.deepEqual(ignitionColors('chrome').ignitionDim, { r: 0, g: 0, b: 0 })
  // Built-ins keep the pre-theme pair for their own background lightness.
  assert.deepEqual(ignitionColors('dark').ignition, { r: 130, g: 185, b: 255 })
  assert.deepEqual(ignitionColors('light').ignition, { r: 30, g: 95, b: 235 })
})

check('chrome: an 8-digit hex ignition drops the alpha, it does not fall back', () => {
  // The theme-file validator accepts `#rrggbbaa` (customTheme's HEX_RE), so the
  // wave has to consume it: the RGB half reaches the gradient, the alpha byte
  // is dropped (no alpha channel in per-column blending). Falling back to the
  // built-in pair here would silently ignore a value the file accepted.
  const alphaPalette = {
    ...getTheme('dark'),
    ignition: '#12345678',
    ignitionDim: '#ABCDEF80',
  }
  const dispose = registerRuntimeThemeResolver(name =>
    name === 'alpha-chrome' ? alphaPalette : undefined)
  try {
    assert.deepEqual(ignitionColors('alpha-chrome').ignition, { r: 0x12, g: 0x34, b: 0x56 })
    assert.deepEqual(ignitionColors('alpha-chrome').ignitionDim, { r: 0xab, g: 0xcd, b: 0xef })
  } finally {
    dispose()
  }
})

check('chrome: palettes predating the keys keep the pre-theme chrome', () => {
  // A runtime palette (an older plugin returning a full palette) without the
  // keys: light ink still selects the light ignition fallback.
  const legacyLight = { ...getTheme('light') }
  for (const key of CHROME_KEYS) delete legacyLight[key]
  const dispose = registerRuntimeThemeResolver(name =>
    name === 'legacy-light-chrome' ? legacyLight : undefined)
  try {
    assert.deepEqual(ignitionColors('legacy-light-chrome').ignition, { r: 30, g: 95, b: 235 })
    assert.deepEqual(contextBarSegmentColors(getTheme('legacy-light-chrome')), FALLBACK_SEGMENTS)
  } finally {
    dispose()
  }
})

check('parse: legacy keys normalize to semantic keys', () => {
  const spec = parseCustomTheme(JSON.stringify({
    base: 'dark',
    colors: {
      claude: '#112233',
      claudeShimmer: '#223344',
      claudeBlue_FOR_SYSTEM_SPINNER: '#334455',
      claudeBlueShimmer_FOR_SYSTEM_SPINNER: '#445566',
      clawd_body: '#556677',
      clawd_background: '#667788',
    },
  }), 'legacy.json')
  assert.ok(spec)
  assert.deepEqual(spec.colors, {
    accent: '#112233',
    accentShimmer: '#223344',
    activity: '#334455',
    activityShimmer: '#445566',
    mascotBody: '#556677',
    inputBackground: '#667788',
  })
  assert.equal(Object.hasOwn(spec.colors, 'claude'), false)
})

// --- the auto pseudo-theme -------------------------------------------------
check('auto: available, resolves to the detected base, shadows user themes', () => {
  assert.ok(isThemeAvailable('auto'))
  // pre-detection default is dark (the readable fallback)
  assert.equal(getAutoThemeBase(), 'dark')
  assert.equal(getTheme('auto'), getTheme('dark'))
  setAutoThemeBase('light')
  assert.equal(getAutoThemeBase(), 'light')
  assert.equal(getTheme('auto'), getTheme('light'))
  setAutoThemeBase('dark')
  // a user theme named auto can never shadow the built-in pseudo-theme
  writeFileSync(join(themesDir, 'auto.json'), JSON.stringify({ base: 'light', colors: { accent: '#123456' } }))
  clearCustomThemeCache()
  assert.equal(getTheme('auto'), getTheme('dark'))
})

check('themePrefs: the auto choice round-trips like any theme name', () => {
  assert.ok(writeThemePref('auto'))
  assert.equal(readThemePref(), 'auto')
  assert.equal(parseThemePref('{"theme": "auto"}'), 'auto')
})

// --- persistence (themePrefs) ----------------------------------------------
check('themePrefs: write/read round-trip under the temp HOME', () => {
  assert.ok(writeThemePref('good'))
  assert.equal(readThemePref(), 'good')
})

check('themePrefs: corrupt file yields undefined, no throw', () => {
  writeFileSync(join(tmpHome, '.dsh-tui', 'theme.json'), '{ nope ')
  assert.equal(readThemePref(), undefined)
})

check('themePrefs: invalid shapes and unsafe names rejected', () => {
  assert.equal(parseThemePref('{}'), undefined)
  assert.equal(parseThemePref('{"theme": 42}'), undefined)
  assert.equal(parseThemePref('{"theme": ""}'), undefined)
  assert.equal(parseThemePref('{"theme": "../evil"}'), undefined)
  assert.equal(parseThemePref('{"theme": "sakura"}'), 'sakura')
})

// --- warning coverage ------------------------------------------------------
check('warnings: each failure mode warns once with a distinct message', () => {
  const joined = warnings.join('\n')
  assert.match(joined, /not valid JSON/)
  assert.match(joined, /invalid or missing "base"/)
  assert.match(joined, /unknown color key "noSuchKey"/)
  assert.match(joined, /invalid color value for "accent"/)
})

console.warn = originalWarn

// --- summary ---------------------------------------------------------------
console.log()
if (failures === 0) {
  console.log(`verify-themes: PASS (${warnings.length} expected warnings captured, themes dir: ${themesDir})`)
  process.exit(0)
} else {
  console.error(`verify-themes: FAIL (${failures} assertion(s) failed)`)
  process.exit(1)
}
