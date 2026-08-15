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
const { getTheme, registerCustomThemeResolver, setAutoThemeBase, getAutoThemeBase } = await import('../src/theme.js')

const themesDir = join(tmpHome, '.dsh-tui', 'themes')
mkdirSync(themesDir, { recursive: true })

// --- fixture files: one valid, one exercising every accepted color form,
// one of each failure mode ------------------------------------------------
const FIXTURES = {
  'good.json': JSON.stringify({
    name: 'sakura',
    displayName: '樱花粉',
    base: 'dark',
    colors: { claude: '#FF9EC7', text: '#E8E6E0' },
  }),
  // name/displayName omitted -> file name / name
  'unnamed.json': JSON.stringify({
    base: 'light',
    colors: { claude: '#3F6CC4' },
  }),
  // every accepted color form
  'format.json': JSON.stringify({
    name: 'format',
    base: 'dark-ansi',
    colors: {
      claude: '#abc',
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
    colors: { claude: '#123456', noSuchKey: '#000000' },
  }),
  // invalid value skipped, valid sibling kept
  'bad-color.json': JSON.stringify({
    base: 'dark',
    colors: { claude: 'hotpink', text: '#E8E6E0' },
  }),
  // invalid base -> whole file skipped
  'bad-base.json': JSON.stringify({
    base: 'neon',
    colors: { claude: '#FF0000' },
  }),
  // broken JSON -> whole file skipped, no crash
  'broken.json': '{ "base": "dark", "colors": { "claude": ',
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

// --- parsing / validation --------------------------------------------------
const goodText = FIXTURES['good.json']
check('parse: valid theme fields', () => {
  const spec = parseCustomTheme(goodText, 'good.json')
  assert.ok(spec)
  assert.equal(spec.name, 'sakura')
  assert.equal(spec.displayName, '樱花粉')
  assert.equal(spec.base, 'dark')
  assert.deepEqual(spec.colors, { claude: '#FF9EC7', text: '#E8E6E0' })
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
  assert.deepEqual(Object.keys(spec.colors), ['claude'])
  assert.equal(spec.colors.claude, '#123456')
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
    ['bad-color', 'format', 'sakura', 'unknown-key', 'unnamed'],
  )
  assert.ok(specs.every(s => !['bad-base', 'broken'].includes(s.name)))
  // the underlying file name stays reachable for loading
  assert.equal(specs.find(s => s.name === 'sakura')?.file, 'good')
})

// --- composition -----------------------------------------------------------
check('build: overrides land on the base palette', () => {
  const theme = buildTheme(parseCustomTheme(goodText, 'good.json'))
  assert.equal(theme.claude, '#FF9EC7')
  assert.equal(theme.text, '#E8E6E0')
  // untouched keys come from the dark base
  assert.equal(theme.success, getTheme('dark').success)
  assert.equal(theme.background, getTheme('dark').background)
})

check('resolve: cached full palette via the name', () => {
  clearCustomThemeCache()
  const theme = resolveCustomTheme('good')
  assert.ok(theme)
  assert.equal(theme.claude, '#FF9EC7')
  assert.equal(theme.success, getTheme('dark').success)
  assert.equal(resolveCustomTheme('good'), theme) // cached identity
  assert.equal(resolveCustomTheme('nope'), undefined)
})

check('resolve: a name field differing from the file name still resolves', () => {
  clearCustomThemeCache()
  // sakura.json does not exist on disk — good.json declares name: sakura.
  const theme = resolveCustomTheme('sakura')
  assert.ok(theme)
  assert.equal(theme.claude, '#FF9EC7')
  assert.equal(resolveCustomTheme('sakura'), theme)
})

check('isThemeAvailable: built-ins and valid user themes, not the rest', () => {
  assert.ok(isThemeAvailable('dark'))
  assert.ok(isThemeAvailable('light'))
  assert.ok(isThemeAvailable('dark-ansi'))
  assert.ok(isThemeAvailable('good'))
  assert.ok(isThemeAvailable('format'))
  assert.ok(!isThemeAvailable('bad-base'))
  assert.ok(!isThemeAvailable('broken'))
  assert.ok(!isThemeAvailable('nope'))
  assert.ok(!isThemeAvailable('../evil'))
})

check('getTheme: registry resolves user themes, built-ins untouched', () => {
  registerCustomThemeResolver(resolveCustomTheme)
  assert.equal(getTheme('sakura').claude, '#FF9EC7') // display name via index
  assert.equal(getTheme('good').claude, '#FF9EC7') // file name alias
  assert.equal(getTheme('dark'), getTheme('dark')) // built-in identity preserved
  assert.equal(getTheme('nope').claude, getTheme('dark').claude) // unknown -> dark
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
  writeFileSync(join(themesDir, 'auto.json'), JSON.stringify({ base: 'light', colors: { claude: '#123456' } }))
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
  assert.match(joined, /invalid color value for "claude"/)
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
