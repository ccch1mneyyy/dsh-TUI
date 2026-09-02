/**
 * /settings focus-follow window regression: card chrome must survive scrolling.
 *
 * A page longer than the viewport scrolls a focus-follow window, but the card
 * chrome rows — top border + title (`╭─ …`), bottom border (`╰──╯`), and the
 * inter-section gaps — are never focusable. The window used to track only the
 * focused row, so scrolling down to the last field clipped the bottom border
 * and scrolling back up to the first field clipped the card title: at either
 * end of the scroll range the page visibly lost its frame.
 *
 * The window must stay inside the list's physical bounds and pin to them when
 * the focus reaches either end of the focus order (while never hiding the
 * focused row, even on viewports only a couple of lines tall).
 *
 * Run: node --import tsx/esm scripts/verify-settings-scroll.tsx
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
  { settle, settled, sleep, viewportLines },
] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('../src/screens/Settings.js'),
  import('./lib/term-test.mjs'),
])

// Scrolling never writes; a write here means the scenario drifted into
// mutating territory and must fail loudly.
const docs: Record<string, { revision: number; value: Record<string, unknown>; user: Record<string, unknown> }> = {}
const host = {
  listNamespaces: () => Object.entries(docs).map(([ns, doc]) => ({
    ns,
    revision: doc.revision,
    applies: 'live' as const,
    value: { ...doc.value },
    user: { ...doc.user },
  })),
  write: (ns: string) => Promise.reject(new Error(`unexpected write in a scroll-only scenario: ${ns}`)),
  credentialConfigured: () => Promise.resolve(false),
  writeCredential: () => Promise.resolve(),
}

function makeChannel(sections: unknown[]): any {
  return {
    settingsHost: () => host,
    settingsSections: () => sections,
    subscribeSettingsSections: () => () => {},
  }
}

class FakeStderr extends Writable {
  isTTY = true
  _write(_chunk: unknown, _e: BufferEncoding, cb: () => void) { cb() }
}
class FakeStdin extends PassThrough {
  isTTY = true
  setRawMode() { return this }
  ref() { return this }
  unref() { return this }
}

/** One rendered screen fixture: its own xterm buffer, stdout, stdin. */
async function openScreen(cols: number, rows: number, sections: unknown[]) {
  const term = new XTerm({ cols, rows, scrollback: 50, allowProposedApi: true })
  class Stdout extends Writable {
    columns = cols
    rows = rows
    isTTY = true
    _write(chunk: unknown, _e: BufferEncoding, cb: () => void) { term.write(String(chunk), cb) }
  }
  const stdin = new FakeStdin()
  const instance = await render(
    <Settings channel={makeChannel(sections)} onClose={() => {}} />,
    { stdout: new Stdout(), stdin, stderr: new FakeStderr(), exitOnCtrlC: false, patchConsole: false },
  )
  const screen = (): string => viewportLines(term, rows).join('\n')
  return { stdin, screen, close: async () => { await instance.unmount() } }
}

/** The pacing sleeps below are the upstream convention: focus moves only
 *  change colors/highlight, so intermediate steps have no text-observable
 *  condition to settle on. */
async function arrow(stdin: FakeStdin, direction: 'down' | 'up', times: number): Promise<void> {
  const key = direction === 'down' ? '\x1b[B' : '\x1b[A'
  for (let i = 0; i < times; i++) {
    stdin.write(key)
    await sleep(120)
  }
}

function assert(condition: boolean, label: string, screen?: string): void {
  console.log(`${condition ? 'ok' : 'FAIL'} — ${label}`)
  if (!condition) {
    if (screen !== undefined) console.log('--- screen ---\n' + screen)
    process.exit(1)
  }
}

const FIELDS = 16

// ── 1. Root page: one section, 16 fields, rows=12 → viewport 8 lines, entry
// list 18 lines (top border + 16 fields + bottom border). Scrolling to the
// last field must keep the bottom border on screen; scrolling back must show
// the card title again.
{
  docs['long-plugin'] = {
    revision: 1,
    value: Object.fromEntries(Array.from({ length: FIELDS }, (_, i) => [`f${i}`, i])),
    user: {},
  }
  const section = {
    ns: 'long-plugin',
    title: 'Long settings',
    fields: Array.from({ length: FIELDS }, (_, i) => ({ path: [`f${i}`], label: `Field ${i}`, kind: 'number' as const })),
  }
  const { stdin, screen, close } = await openScreen(80, 12, [section])
  assert(await settled(() => screen().includes('╭─ Long settings')), 'opens with the card title row', screen())

  await arrow(stdin, 'down', FIELDS - 1)
  assert(await settled(() => screen().includes('Field 15')), 'focus reaches the last field', screen())
  assert(await settled(() => screen().includes('╰')), 'bottom border stays visible at the end of the list', screen())

  await arrow(stdin, 'up', FIELDS - 1)
  assert(await settled(() => screen().includes('Field 0')), 'first field back in view', screen())
  assert(await settled(() => screen().includes('╭─ Long settings')), 'card title stays visible at the top of the list', screen())
  await close()
}

// ── 2. Group subpage: same geometry behind a group entry — the subpage is
// where a long plugin nests its bulk, and its card chrome must scroll the
// same way.
{
  docs['grouped-plugin'] = {
    revision: 1,
    value: Object.fromEntries(Array.from({ length: FIELDS }, (_, i) => [`g${i}`, i])),
    user: {},
  }
  const section = {
    ns: 'grouped-plugin',
    title: 'Grouped long settings',
    groups: [{ id: 'advanced', title: 'Advanced' }],
    fields: Array.from({ length: FIELDS }, (_, i) => ({ path: [`g${i}`], label: `Grouped field ${i}`, kind: 'number' as const, group: 'advanced' })),
  }
  const { stdin, screen, close } = await openScreen(80, 12, [section])
  assert(await settled(() => screen().includes('Advanced')), 'group entry renders on the root page', screen())

  stdin.write('\r') // the group row is the only focusable entry
  assert(await settled(() => screen().includes('Grouped field 0')), 'group page opens with its fields', screen())

  await arrow(stdin, 'down', FIELDS - 1)
  assert(await settled(() => screen().includes('Grouped field 15')), 'group page reaches its last field', screen())
  assert(await settled(() => screen().includes('╰')), 'group page keeps its bottom border at the end', screen())

  await arrow(stdin, 'up', FIELDS - 1)
  assert(await settled(() => screen().includes('Grouped field 0')), 'group page returns to its first field', screen())
  assert(await settled(() => screen().includes('╭─ Advanced')), 'group page keeps its title at the top', screen())
  await close()
}

// ── 3. Tiny viewport (rows=6 → two list lines, three fields): edge pinning
// must never outrank focus visibility — the focused row stays on screen even
// when the window is pinned to the list's physical ends.
{
  docs['tiny-plugin'] = {
    revision: 1,
    value: { f0: 0, f1: 1, f2: 2 },
    user: {},
  }
  const section = {
    ns: 'tiny-plugin',
    title: 'Tiny settings',
    fields: ['f0', 'f1', 'f2'].map(path => ({ path: [path], label: `Field ${path.slice(1)}`, kind: 'number' as const })),
  }
  const { stdin, screen, close } = await openScreen(80, 6, [section])
  assert(await settled(() => screen().includes('Field 0')), 'tiny viewport opens on the first field', screen())

  await arrow(stdin, 'down', 2)
  assert(await settled(() => screen().includes('Field 2')), 'tiny viewport scrolls the last field into view', screen())
  assert(await settled(() => screen().includes('╰')), 'tiny viewport keeps the bottom border', screen())

  await arrow(stdin, 'up', 2)
  assert(await settled(() => screen().includes('Field 0')), 'tiny viewport returns to the first field', screen())
  assert(await settled(() => screen().includes('╭─ Tiny settings')), 'tiny viewport keeps the card title', screen())
  await close()
}

// ── 4. One-line viewport (rows=5 → a single list line): the edge-pin guards
// are now false (the pinned edge would hide the focus), so pinning must be
// skipped and the follow rules alone must keep the focused row on screen —
// the card chrome loses its slot entirely, and that is the correct trade.
{
  docs['micro-plugin'] = {
    revision: 1,
    value: { f0: 0, f1: 1, f2: 2 },
    user: {},
  }
  const section = {
    ns: 'micro-plugin',
    title: 'Micro settings',
    fields: ['f0', 'f1', 'f2'].map(path => ({ path: [path], label: `Field ${path.slice(1)}`, kind: 'number' as const })),
  }
  const { stdin, screen, close } = await openScreen(80, 5, [section])
  assert(await settled(() => screen().includes('Field 0')), 'one-line viewport opens on the first field', screen())

  await arrow(stdin, 'down', 2)
  assert(await settled(() => screen().includes('Field 2')), 'one-line viewport follows to the last field (bottom pin skipped)', screen())

  await arrow(stdin, 'up', 2)
  assert(await settled(() => screen().includes('Field 0')), 'one-line viewport follows back to the first field (top pin skipped)', screen())
  await close()
}

console.log('verify-settings-scroll: all assertions passed')
