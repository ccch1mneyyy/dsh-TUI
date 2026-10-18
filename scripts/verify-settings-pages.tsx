/**
 * /settings top-level page (tab) navigation regression.
 *
 * Sections that declare the same `page` share one tab; sections that declare
 * none share the default "general" page, which stays first. The contract
 * pinned here:
 * - the strip lists General first, then declared pages in registration order;
 * - Tab / Shift+Tab cycle pages (wrapping) and a click switches to the
 *   clicked tab;
 * - the header count, the cards and the focus order belong to the active
 *   page only, and that page's focus is restored when you come back;
 * - Tab from a group subpage returns to a page root, not the subpage, and the
 *   page keeps the group row it was entered from as its root focus;
 * - a single-page composition keeps the pre-tabs layout (no extra chrome row,
 *   no Tab hint) — the strip only exists once a page is declared;
 * - a terminal too narrow for every label collapses the strip to the active
 *   tab plus its position, so the page you are on never disappears.
 *
 * Run: node --import tsx/esm scripts/verify-settings-pages.tsx
 */
process.env.FORCE_COLOR = '3'
// English UI copy is asserted below; pin the language before any module
// import resolves the startup lang (env > persisted > locale).
process.env.DSH_TUI_LANG = 'en'

const [
  { PassThrough, Writable },
  React,
  { Terminal: XTerm },
  { render, AlternateScreen },
  { Settings },
  { settled, viewportLines },
] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('../src/screens/Settings.js'),
  import('./lib/term-test.mjs'),
])

const COLS = 100
const ROWS = 24

type Doc = { revision: number; value: Record<string, unknown>; user: Record<string, unknown> }
const searchPage = { id: 'search', title: 'Search', descriptions: { zh: '搜索' } }
const otherPage = { id: 'other', title: 'Other', descriptions: { zh: '其他' } }

const docs: Record<string, Doc> = {
  'dsh-tui': { revision: 1, value: { a0: false, a1: false }, user: {} },
  'legacy-plugin': { revision: 1, value: { l0: false }, user: {} },
  web: { revision: 1, value: { w0: false }, user: {} },
  'web-api': { revision: 1, value: { x0: false }, user: {} },
  'other-plugin': { revision: 1, value: { o0: false, d0: false }, user: {} },
}
const host = {
  listNamespaces: () => Object.entries(docs).map(([ns, doc]) => ({
    ns, revision: doc.revision, applies: 'live' as const, value: { ...doc.value }, user: { ...doc.user },
  })),
  // Navigation-only scenario: a write here means the scenario drifted into
  // mutating territory and must fail loudly.
  write: (ns: string) => Promise.reject(new Error(`unexpected write in a navigation-only scenario: ${ns}`)),
  credentialConfigured: () => Promise.resolve(false),
  writeCredential: () => Promise.resolve(),
}

const generalSection = {
  ns: 'dsh-tui',
  title: 'TUI settings',
  fields: [
    { path: ['a0'], label: 'Top one', kind: 'boolean' as const },
    { path: ['a1'], label: 'Top two', kind: 'boolean' as const },
  ],
}
/** No page: joins the default general page next to the TUI's own section. */
const legacySection = {
  ns: 'legacy-plugin',
  title: 'Legacy plugin',
  fields: [{ path: ['l0'], label: 'Legacy one', kind: 'boolean' as const }],
}
const webSection = {
  ns: 'web',
  title: 'Web search',
  page: searchPage,
  fields: [{ path: ['w0'], label: 'Web one', kind: 'boolean' as const }],
}
const searchApiSection = {
  ns: 'web-api',
  title: 'Search API',
  page: searchPage,
  fields: [{ path: ['x0'], label: 'API one', kind: 'boolean' as const }],
}
const otherSection = {
  ns: 'other-plugin',
  title: 'Other plugin',
  page: otherPage,
  groups: [{ id: 'deep', title: 'Deep group', mode: 'page' as const }],
  fields: [
    { path: ['o0'], label: 'Other one', kind: 'boolean' as const },
    { path: ['d0'], label: 'Deep field', kind: 'boolean' as const, group: 'deep' },
  ],
}

class FakeStderr extends Writable { isTTY = true; _write(_c: unknown, _e: BufferEncoding, cb: () => void) { cb() } }
class FakeStdin extends PassThrough { isTTY = true; setRawMode() { return this } ref() { return this } unref() { return this } }

function makeTerm(cols: number): InstanceType<typeof XTerm> {
  return new XTerm({ cols, rows: ROWS, scrollback: 50, allowProposedApi: true })
}
class FakeStdout extends Writable {
  columns: number
  rows = ROWS
  isTTY = true
  term: InstanceType<typeof XTerm>
  constructor(term: InstanceType<typeof XTerm>, cols: number) { super(); this.term = term; this.columns = cols }
  _write(chunk: unknown, _e: BufferEncoding, cb: () => void) { this.term.write(String(chunk), cb) }
}

let failures = 0
function assert(condition: boolean, label: string, dump?: string): void {
  console.log((condition ? 'ok' : 'FAIL') + ' — ' + label)
  if (!condition) {
    failures += 1
    console.log('--- screen ---\n' + (dump ?? ''))
    process.exitCode = 1
  }
}

async function mount(sections: readonly unknown[], cols = COLS) {
  const term = makeTerm(cols)
  const stdin = new FakeStdin()
  const instance = await render(
    <AlternateScreen>
      <Settings
        channel={{ settingsHost: () => host, settingsSections: () => sections, subscribeSettingsSections: () => () => {} } as Parameters<typeof Settings>[0]['channel']}
        onClose={() => {}}
      />
    </AlternateScreen>,
    { stdout: new FakeStdout(term, cols), stdin, stderr: new FakeStderr(), exitOnCtrlC: false, patchConsole: false },
  )
  const lines = (): string[] => viewportLines(term, ROWS)
  /** The whole buffer, scrollback included — inline mode can scroll the
   *  title row out of the viewport while the layout assertions still hold. */
  const bufferLines = (): string[] => {
    const buffer = term.buffer.active
    const out: string[] = []
    for (let y = 0; y < buffer.length; y++) out.push(buffer.getLine(y)?.translateToString(true) ?? '')
    return out
  }
  const screen = (): string => lines().join('\n')
  const lineOf = (text: string): string => lines().find(line => line.includes(text)) ?? ''
  /** The tab strip is the only row carrying both page labels. */
  const stripRow = (): number => lines().findIndex(line => line.includes('General') && line.includes('Search'))
  /** SGR click on a tab label (press + release on the same cell). */
  const clickTab = (label: string): void => {
    const row = stripRow()
    const column = lines()[row]?.indexOf(label) ?? -1
    if (row < 0 || column < 0) throw new Error(`tab "${label}" is not on screen: ${screen()}`)
    stdin.write(`\x1b[<0;${column + 1};${row + 1}M`)
    stdin.write(`\x1b[<0;${column + 1};${row + 1}m`)
  }
  return {
    stdin,
    screen,
    lineOf,
    stripRow,
    clickTab,
    bufferLines,
    term,
    unmount: async (): Promise<void> => { await instance.unmount(); term.dispose() },
  }
}

// ── Three pages: default (general) / declared search / declared other ────────
{
  const ui = await mount([generalSection, legacySection, webSection, searchApiSection, otherSection])
  try {
    assert(await settled(() => ui.screen().includes('General') && ui.screen().includes('Search')), 'the tab strip lists the declared pages', ui.screen())
    const strip = ui.lineOf('General')
    assert(strip.indexOf('General') < strip.indexOf('Search') && strip.indexOf('Search') < strip.indexOf('Other'),
      'tabs follow General first, then declared pages in registration order', ui.screen())
    assert(ui.screen().includes('TUI settings') && ui.screen().includes('Top one')
      && ui.screen().includes('Legacy plugin') && ui.screen().includes('Legacy one'),
      'sections without a page share the default general page', ui.screen())
    assert(!ui.screen().includes('Web search') && !ui.screen().includes('Other plugin'),
      'other pages are not rendered until selected', ui.screen())
    assert(ui.lineOf('Top one').includes('❯'), 'focus starts on the general page', ui.screen())
    assert((ui.screen().match(/1\/(\d+)/u)?.[1] ?? '') === '3', 'the header count covers the active page only', ui.screen())
    {
      const all = ui.bufferLines()
      const card = all.findIndex(line => line.includes('TUI settings'))
      assert(all[card - 2]?.includes('Plugin settings') === true && all[card - 1]?.includes('General') === true,
        'the tab strip sits between the title row and the cards', ui.screen())
    }
    // The active tab is a reverse block; the inactive ones are not.
    const stripLine = ui.term.buffer.active.getLine(ui.stripRow())
    const at = (label: string): number => (ui.lineOf('General').indexOf(label))
    // xterm's CellData flags come back as bit values, so only truthiness is
    // portable across its versions.
    assert(Boolean(stripLine?.getCell(at('General'))?.isInverse()), 'the active tab renders as a reverse block', ui.screen())
    assert(!Boolean(stripLine?.getCell(at('Search'))?.isInverse()), 'inactive tabs are not highlighted', ui.screen())

    // Tab walks forward to the search page.
    ui.stdin.write('\t')
    assert(await settled(() => ui.screen().includes('Web search') && ui.screen().includes('Search API')),
      'Tab switches to the next page and renders every section sharing it', ui.screen())
    assert(!ui.screen().includes('TUI settings'), 'the previous page is gone, not scrolled away', ui.screen())
    assert((ui.screen().match(/1\/(\d+)/u)?.[1] ?? '') === '2', 'the header count follows the page switch', ui.screen())
    assert(Boolean(ui.term.buffer.active.getLine(ui.stripRow())?.getCell(ui.lineOf('General').indexOf('Search'))?.isInverse()),
      'the newly active tab is the reverse block', ui.screen())

    // Tab wraps to the last page; Shift+Tab walks back.
    ui.stdin.write('\t')
    assert(await settled(() => ui.lineOf('Other one').includes('❯')), 'Tab reaches a declared page', ui.screen())
    ui.stdin.write('\t')
    assert(await settled(() => ui.screen().includes('TUI settings')), 'Tab wraps from the last page to the first', ui.screen())
    ui.stdin.write('\x1b[Z')
    assert(await settled(() => ui.lineOf('Other one').includes('❯')), 'Shift+Tab walks back, wrapping to the last page', ui.screen())

    // A click on a tab switches to it.
    ui.clickTab('Search')
    assert(await settled(() => ui.screen().includes('Web search')), 'a click on a tab selects that page', ui.screen())

    // Per-page focus memory: leave the general page from its second field.
    ui.clickTab('General')
    assert(await settled(() => ui.lineOf('Top one').includes('❯')), 'clicking General returns to its root page', ui.screen())
    ui.stdin.write('\x1b[B')
    assert(await settled(() => ui.lineOf('Top two').includes('❯')), '↓ moves the focus on the general page', ui.screen())
    ui.stdin.write('\t')
    assert(await settled(() => ui.screen().includes('Web search')), 'Tab leaves with the focus where it was', ui.screen())
    ui.stdin.write('\x1b[Z')
    assert(await settled(() => ui.lineOf('Top two').includes('❯')), 'returning to a page restores its focused row', ui.screen())

    // Tab from a group subpage returns to a page root (never to the subpage).
    ui.clickTab('Other')
    assert(await settled(() => ui.lineOf('Other one').includes('❯')), 'the other page opens on its first row', ui.screen())
    ui.stdin.write('\x1b[B')
    assert(await settled(() => ui.lineOf('Deep group').includes('❯')), '↓ reaches the group row', ui.screen())
    ui.stdin.write('\r')
    assert(await settled(() => ui.screen().includes('Deep field')), 'Enter opens the group subpage', ui.screen())
    ui.stdin.write('\t')
    assert(await settled(() => ui.screen().includes('TUI settings') && !ui.screen().includes('Deep field')),
      'Tab from a group subpage lands on a page root with the group closed', ui.screen())
    ui.stdin.write('\x1b[Z')
    assert(await settled(() => ui.lineOf('Deep group').includes('❯')),
      'returning to the page restores the group row, not a subpage index', ui.screen())
  } finally {
    await ui.unmount()
  }
}

// ── One page: the strip disappears and the layout matches the pre-tabs screen ─
{
  const ui = await mount([generalSection])
  try {
    assert(await settled(() => ui.screen().includes('TUI settings')), 'a single-page composition renders its section', ui.screen())
    assert(!ui.screen().includes('General'), 'a single page has no tab strip', ui.screen())
    {
      const all = ui.bufferLines()
      const card = all.findIndex(line => line.includes('TUI settings'))
      assert(all[card - 1]?.includes('Plugin settings') === true,
        'the card follows the title row directly — no extra chrome row', ui.screen())
    }
    assert(!ui.screen().includes('Tab'), 'the help bar offers no page key without pages', ui.screen())
  } finally {
    await ui.unmount()
  }
}

// ── One declared page only: still no strip (nothing to switch to) ────────────
{
  const ui = await mount([webSection, searchApiSection])
  try {
    assert(await settled(() => ui.screen().includes('Web search') && ui.screen().includes('Search API')),
      'a single declared page renders all of its sections', ui.screen())
    assert(!ui.screen().includes('Tab'), 'a single declared page keeps the one-page help bar', ui.screen())
  } finally {
    await ui.unmount()
  }
}

// ── A strip narrower than three cells per page keeps the active tab ─────────
{
  const pages = ['A', 'B', 'C', 'D', 'E'].map((title, index) => ({
    ns: `page-${index}`,
    title: `Page ${title}`,
    page: { id: `p${index}`, title },
    fields: [{ path: ['v'], label: `V ${index}`, kind: 'boolean' as const }],
  }))
  const ui = await mount(pages, 14)
  try {
    assert(await settled(() => ui.screen().includes('1/5')),
      'a strip too narrow for every label collapses to the active tab plus its position', ui.screen())
    ui.stdin.write('\t')
    assert(await settled(() => ui.screen().includes('2/5')),
      'the compact strip follows Tab to the next page', ui.screen())
  } finally {
    await ui.unmount()
  }
}

if (failures > 0) process.exit(1)
console.log('verify-settings-pages: all assertions passed')
