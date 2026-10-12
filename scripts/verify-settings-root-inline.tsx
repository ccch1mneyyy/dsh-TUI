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

// The help bar must display the focused field's hint at wide and narrow widths.
// Read the expected text from the definition so copy edits do not need a second
// version of each sentence in this regression.
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
    <Settings channel={{ settingsHost: () => hintHost, settingsSections: () => [hintSection], subscribeSettingsSections: () => () => {} } as Parameters<typeof Settings>[0]['channel']} onClose={() => {}} />,
    { stdout: new HintStdout(), stdin, stderr: new FakeStderr(), exitOnCtrlC: false, patchConsole: false },
  )
  const screen = (): string => viewportLines(term, HINT_ROWS).join('\n')
  const lineOf = (text: string): string => screen().split('\n').find(line => line.includes(text)) ?? ''
  const bar = (): { hint: string; keys: string } => barSegments(lineOf('Esc '))
  return { stdin, lineOf, bar, screen, unmount: async () => { await instance.unmount(); term.dispose() } }
}

for (const lang of ['en', 'zh'] as const) {
  setLang(lang)
  for (const columns of [100, 80, 60] as const) {
    const ui = await openHintScreen(columns)
    try {
      const labels = Object.fromEntries(hintSection.fields.map(field => [
        field.path.join('.'), lang === 'zh' ? field.descriptions?.zh ?? field.label : field.label,
      ]))
      const check = (key: 'whaleGirl' | 'companion.skin', seen: { hint: string; keys: string }): void => {
        const budget = columns - stringWidth(seen.keys) - 2
        console.log(`readout — ${lang} ${columns}col ${key}: budget ${budget}, visible ${stringWidth(seen.hint)} cols | ${seen.hint}`)
        const field = hintSection.fields.find(field => field.path.join('.') === key)!
        const expected = lang === 'zh' ? field.hintDescriptions?.zh ?? field.hint : field.hint
        const visible = seen.hint.replace(/…$/, '')
        const expectedWidth = Math.min(budget, stringWidth(expected ?? ''))
        const actualWidth = stringWidth(seen.hint)
        // A wide character can leave one unused column before the ellipsis.
        assert(actualWidth >= expectedWidth - 1 && actualWidth <= expectedWidth,
          `${lang} ${columns}col: ${key} hint fills its available display width`, ui.screen())
        assert(visible.length > 0, `${lang} ${columns}col: ${key} help bar shows a non-empty hint head`, ui.screen())
        assert(expected?.startsWith(visible) === true,
          `${lang} ${columns}col: ${key} visible text starts with the focused field's hint`, ui.screen())
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
