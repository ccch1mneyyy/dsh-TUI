/**
 * /settings root-page presentation regression (inline groups).
 *
 * Groups come in two presentations: 'inline' lays the group's fields right
 * on the root page under a small non-focusable header (shallow topics — a
 * subpage round-trip costs more clicks than the ordering buys), 'page' (and
 * the modeless legacy default) keeps one navigation row into a subpage.
 * The contract pinned here:
 * - inline fields render directly on the root page, header included;
 * - the header is NOT focusable: arrows walk fields and page rows only;
 * - page groups still open their subpage on Enter, Esc returns;
 * - an inline group with no fields renders nothing (no orphan header);
 * - ungrouped fields still render first, like before.
 *
 * Run: node --import tsx/esm scripts/verify-settings-root-inline.tsx
 */
process.env.FORCE_COLOR = '3'
// English UI copy is asserted below; pin the language before any module
// import resolves the startup lang (env > persisted > locale).
process.env.DSH_TUI_LANG = 'en'

const [
  { PassThrough, Writable },
  React,
  { Terminal: XTerm },
  { render },
  { Settings },
  { settled, sleep, viewportLines },
] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('../src/screens/Settings.js'),
  import('./lib/term-test.mjs'),
])

// Navigation-only scenario: a write here means the scenario drifted into
// mutating territory and must fail loudly.
const docs: Record<string, { revision: number; value: Record<string, unknown>; user: Record<string, unknown> }> = {
  'demo-plugin': { revision: 1, value: { u0: false, a0: false, a1: false, d0: false, d1: false, b0: false, l0: false }, user: {} },
}
const host = {
  listNamespaces: () => Object.entries(docs).map(([ns, doc]) => ({
    ns, revision: doc.revision, applies: 'live' as const, value: { ...doc.value }, user: { ...doc.user },
  })),
  write: (ns: string) => Promise.reject(new Error('unexpected write in a navigation-only scenario: ' + ns)),
  credentialConfigured: () => Promise.resolve(false),
  writeCredential: () => Promise.resolve(),
}
const sections = [{
  ns: 'demo-plugin',
  title: 'Demo settings',
  groups: [
    { id: 'shallow-a', mode: 'inline' as const, title: 'Shallow A' },
    { id: 'deep', mode: 'page' as const, title: 'Deep domain' },
    { id: 'shallow-b', mode: 'inline' as const, title: 'Shallow B' },
    { id: 'empty-inline', mode: 'inline' as const, title: 'Empty inline' },
    { id: 'legacy', title: 'Legacy group' },
  ],
  fields: [
    { path: ['u0'], label: 'Ungrouped plain', kind: 'boolean' as const },
    { path: ['a0'], label: 'A one', kind: 'boolean' as const, group: 'shallow-a' },
    { path: ['a1'], label: 'A two', kind: 'boolean' as const, group: 'shallow-a' },
    { path: ['d0'], label: 'D one', kind: 'boolean' as const, group: 'deep' },
    { path: ['d1'], label: 'D two', kind: 'boolean' as const, group: 'deep' },
    { path: ['b0'], label: 'B one', kind: 'boolean' as const, group: 'shallow-b' },
    { path: ['l0'], label: 'L one', kind: 'boolean' as const, group: 'legacy' },
  ],
}]

class FakeStderr extends Writable { isTTY = true; _write(_c: unknown, _e: BufferEncoding, cb: () => void) { cb() } }
class FakeStdin extends PassThrough { isTTY = true; setRawMode() { return this } ref() { return this } unref() { return this } }

const cols = 80, rows = 24
const term = new XTerm({ cols, rows, scrollback: 50, allowProposedApi: true })
class Stdout extends Writable {
  columns = cols
  rows = rows
  isTTY = true
  _write(chunk: unknown, _e: BufferEncoding, cb: () => void) { term.write(String(chunk), cb) }
}
const stdin = new FakeStdin()
const instance = await render(
  <Settings channel={{ settingsHost: () => host, settingsSections: () => sections, subscribeSettingsSections: () => () => {} } as any} onClose={() => {}} />,
  { stdout: new Stdout(), stdin, stderr: new FakeStderr(), exitOnCtrlC: false, patchConsole: false },
)
const screen = (): string => viewportLines(term, rows).join('\n')
/** The rendered line carrying text, if any. */
const lineOf = (text: string): string => screen().split('\n').find(line => line.includes(text)) ?? ''
/** The help bar's two segments, read off the rendered line: the focused
 *  field's hint on the left, the pinned navigation keys on the right. */
function barSegments(line: string): { hint: string; keys: string } {
  const cut = line.indexOf('Enter')
  if (cut < 0) return { hint: line.trim(), keys: '' }
  return { hint: line.slice(0, cut).trim(), keys: line.slice(cut).trim() }
}

/** Focus moves only change colors/the pointer glyph; the pacing sleeps are
 *  the upstream convention (no text-observable condition mid-walk). */
async function arrow(direction: 'down' | 'up', times: number): Promise<void> {
  const key = direction === 'down' ? '\x1b[B' : '\x1b[A'
  for (let i = 0; i < times; i++) { stdin.write(key); await sleep(120) } // 固定窗:pacing 焦点步进无 settle 锚点
}
/** `dump` overrides the failure screen dump for scenarios rendered into their
 *  own terminal (the module-level `screen()` belongs to the first harness). */
function assert(condition: boolean, label: string, dump?: string): void {
  console.log((condition ? 'ok' : 'FAIL') + ' — ' + label)
  if (!condition) { console.log('--- screen ---\n' + (dump ?? screen())); process.exit(1) }
}

// 1. Inline groups lay their fields — and header — right on the root page.
assert(await settled(() => screen().includes('Ungrouped plain')), 'ungrouped field renders first on the root page')
assert(screen().includes('Shallow A') && screen().includes('A one') && screen().includes('A two'), 'inline group fields sit on the root page under their header')
assert(screen().includes('Shallow B') && screen().includes('B one'), 'a second inline group renders after the page rows in group order')
// 2. Page groups — and the modeless legacy default — keep fields off the root.
assert(screen().includes('Deep domain') && !screen().includes('D one') && !screen().includes('D two'), 'page group shows one navigation row, fields stay on the subpage')
assert(screen().includes('Legacy group') && !screen().includes('L one'), 'a group without a mode defaults to a subpage row')
// 3. An inline group with no fields renders nothing at all.
assert(!screen().includes('Empty inline'), 'empty inline group renders no orphan header')
// 4. Headers are not focusable: arrows walk fields and page rows only.
assert(lineOf('Ungrouped plain').includes('❯'), 'focus starts on the first field')
await arrow('down', 1)
assert(lineOf('A one').includes('❯') && !lineOf('Shallow A').includes('❯'), 'arrow skips the header straight to the first inline field')
await arrow('down', 1)
assert(lineOf('A two').includes('❯'), 'the second inline field is next in the focus order')
await arrow('down', 1)
assert(lineOf('Deep domain').includes('❯'), 'focus flows from inline fields to the next page row')
// 5. The page group still opens its subpage on Enter; Esc returns.
stdin.write('\r')
assert(await settled(() => screen().includes('D one') && screen().includes('D two')), 'Enter on the page row opens the subpage')
stdin.write('\x1b')
assert(await settled(() => !screen().includes('D one') && screen().includes('A one')), 'Esc returns to the root page with the inline fields in place')
await instance.unmount()

// ── 6. Precedence-hint visibility across widths, in both languages (T08) ──
// The frozen contract (TASK.md «冻结表述 B v3», visibility tiers) is about
// what the bottom help bar really shows: at 100 columns both hints still
// spell out the tokens naming who owns the splash slot; at 80 columns the
// short core still names whale / the splash art; at 60 columns only the head
// fits — and that head must match the frozen short core verbatim, not the old
// technical-detail sentence. The two fields come from the real definitions
// (the contract's single source of truth), rendered under their real topic
// group. Measured widths are printed as a readout only, never asserted as
// thresholds (L-025).
const [{ settingField, SETTING_GROUPS }, { setLang }, { stringWidth }] = await Promise.all([
  import('../src/settings/definitions.js'),
  import('../src/i18n.js'),
  import('../src/ink/stringWidth.js'),
])

const HINT_ROWS = 16
const hintDocs = { 'dsh-tui': { revision: 1, value: { whaleGirl: false, companion: { skin: 'deepy' } }, user: {} } }
const hintHost = {
  listNamespaces: () => Object.entries(hintDocs).map(([ns, doc]) => ({
    ns, revision: doc.revision, applies: 'live' as const, value: { ...doc.value }, user: { ...doc.user },
  })),
  // Read-only scenario: a write here means the visibility probe drifted into
  // mutating territory and must fail loudly.
  write: (ns: string) => Promise.reject(new Error('unexpected write in the hint-visibility scenario: ' + ns)),
  credentialConfigured: () => Promise.resolve(false),
  writeCredential: () => Promise.resolve(),
}
const hintSection = {
  ns: 'dsh-tui',
  title: 'dsh-tui',
  groups: SETTING_GROUPS.filter(group => group.id === 'splash'),
  fields: [settingField('whaleGirl'), settingField('companion.skin')],
}

async function openHintScreen(width: number) {
  const term = new XTerm({ cols: width, rows: HINT_ROWS, scrollback: 50, allowProposedApi: true })
  class HintStdout extends Writable {
    columns = width
    rows = HINT_ROWS
    isTTY = true
    _write(chunk: unknown, _e: BufferEncoding, cb: () => void) { term.write(String(chunk), cb) }
  }
  const stdin = new FakeStdin()
  const instance = await render(
    <Settings channel={{ settingsHost: () => hintHost, settingsSections: () => [hintSection], subscribeSettingsSections: () => () => {} } as any} onClose={() => {}} />,
    { stdout: new HintStdout(), stdin, stderr: new FakeStderr(), exitOnCtrlC: false, patchConsole: false },
  )
  const screen = (): string => viewportLines(term, HINT_ROWS).join('\n')
  const lineOf = (text: string): string => screen().split('\n').find(line => line.includes(text)) ?? ''
  const bar = (): { hint: string; keys: string } => barSegments(lineOf('Esc '))
  return { stdin, lineOf, bar, screen, unmount: () => instance.unmount() }
}

const HINT_LABELS: Record<'en' | 'zh', Record<'whaleGirl' | 'companion.skin', string>> = {
  en: { whaleGirl: 'Maid portrait', 'companion.skin': 'Companion skin' },
  zh: { whaleGirl: '女仆娘立绘', 'companion.skin': '宠物皮肤' },
}
/** Tokens the 100/80-column tiers require in the visible segment. */
const TIER_TOKENS: Record<'en' | 'zh', Record<100 | 80, Record<'whaleGirl' | 'companion.skin', readonly string[]>>> = {
  en: {
    100: { whaleGirl: ['deepy', 'whale'], 'companion.skin': ['splash', 'whale'] },
    80: { whaleGirl: ['whale'], 'companion.skin': ['splash'] },
  },
  zh: {
    100: { whaleGirl: ['deepy', 'whale'], 'companion.skin': ['开屏', 'whale'] },
    80: { whaleGirl: ['whale'], 'companion.skin': ['开屏'] },
  },
}
/** A required token must be a whole word: a bare `whale` must not be satisfied
 *  by the `whaleGirl` token next to it (same tokenizer as the definitions
 *  check — independent review B-F3). CJK topics have no word boundaries in
 *  that split, so they stay a plain substring match. */
const showsToken = (visible: string, token: string): boolean =>
  /^[A-Za-z0-9_]+$/.test(token) ? visible.split(/[^A-Za-z0-9_]+/).includes(token) : visible.includes(token)
/** The frozen short cores each hint opens with (TASK.md «冻结表述 B v3»), the
 *  same literals `verify-settings-definitions.ts` anchors on. Truncation only
 *  drops the tail, so whatever the bar shows must match the core verbatim —
 *  a semantic inversion keeps every token and is caught only here. */
const SHORT_CORES: Record<'en' | 'zh', Record<'whaleGirl' | 'companion.skin', string>> = {
  en: {
    whaleGirl: 'Set Companion skin to whale, not deepy/whaleGirl.',
    'companion.skin': 'Also picks the splash art. Set it to whale to keep the maid portrait.',
  },
  zh: {
    whaleGirl: '宠物皮肤要设为 whale，不要 deepy/whaleGirl',
    'companion.skin': '同时决定开屏艺术槽。设为 whale 才保留女仆娘立绘。',
  },
}

for (const lang of ['en', 'zh'] as const) {
  setLang(lang)
  for (const columns of [100, 80, 60] as const) {
    const ui = await openHintScreen(columns)
    try {
      const labels = HINT_LABELS[lang]
      const check = (key: 'whaleGirl' | 'companion.skin', seen: { hint: string; keys: string }): void => {
        const budget = columns - stringWidth(seen.keys) - 2
        console.log(`readout — ${lang} ${columns}col ${key}: budget ${budget}, visible ${stringWidth(seen.hint)} cols | ${seen.hint}`)
        // The 60-column tier has no token budget left: the head below is all it
        // can show, and the tokens are not required at that width (a known UI
        // limit the docs' precedence table covers).
        if (columns !== 60) {
          const tokens = TIER_TOKENS[lang][columns][key]
          assert(tokens.every(token => showsToken(seen.hint, token)), `${lang} ${columns}col: ${key} visible text shows ${tokens.join(' + ')}`, ui.screen())
        }
        // Whatever is visible is a truncated head of the hint, so it must still
        // match the frozen short core: tokens survive a semantic inversion
        // (`Never choose whale …`), this does not. The bar may run past the
        // core into the detail sentence, so compare the overlap only.
        const visible = seen.hint.replace(/…$/, '')
        const core = SHORT_CORES[lang][key]
        const overlap = Math.min(visible.length, core.length)
        // An empty bar (the help row dropped the hint, or the `Esc ` anchor the
        // bar is read from went missing) would make the overlap 0 and compare
        // `` === `` — green with nothing checked, which at 60 columns is the only
        // assertion covering this hint. Every tier below shows a non-empty head
        // (12–13 columns at 60), so require one.
        assert(overlap > 0, `${lang} ${columns}col: ${key} help bar shows a non-empty hint head`, ui.screen())
        assert(visible.slice(0, overlap) === core.slice(0, overlap),
          `${lang} ${columns}col: ${key} visible text matches the frozen short core`, ui.screen())
      }
      // The screen opens focused on the first field; one ↓ moves to the
      // second. The pointer glyph is text-observable, so the focus step has
      // a real settle anchor (no fixed pacing window).
      assert(await settled(() => ui.lineOf(labels.whaleGirl).includes('❯')), `${lang} ${columns}col: focus starts on ${labels.whaleGirl}`, ui.screen())
      check('whaleGirl', ui.bar())
      ui.stdin.write('\x1b[B')
      assert(await settled(() => ui.lineOf(labels['companion.skin']).includes('❯')), `${lang} ${columns}col: ↓ moves the focus to ${labels['companion.skin']}`, ui.screen())
      check('companion.skin', ui.bar())
    } finally {
      await ui.unmount()
    }
  }
}

console.log('verify-settings-root-inline: all assertions passed')
