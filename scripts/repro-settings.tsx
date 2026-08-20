/**
 * /settings screen scenario (issue #165, real input path via stdin):
 * 1. `/settings` opens the plugin settings screen (section + fields render)
 * 2. Enter on a boolean field stages a toggle (draft marker), `s` saves it —
 *    the write lands as revision-fenced `mutate` path ops on the host
 * 3. editing a number field stages draft text; saving translates it to a
 *    numeric `set` op
 * 4. Esc with a staged edit in ANOTHER section discards every section's
 *    drafts instead of closing (P2-4: leaving must never silently drop an
 *    edit made two sections ago); a second Esc closes
 * 5. a quiet screen settles — settingsHost() calls stay bounded (P1-1: the
 *    screen keys effects on host identity, so an unstable host loops forever)
 * 6. a terminal shorter than the entry list scrolls to follow the focus
 *    (P2-3: the focused field is always on screen)
 *
 * Exits non-zero on the first failed assertion (CI convention).
 */
process.env.FORCE_COLOR = '3'
// This script asserts English UI copy; pin the language before any
// module import resolves the startup lang (env > persisted > locale).
process.env.DSH_TUI_LANG = 'en'

const [{ PassThrough, Writable }, React, { Terminal: XTerm }, { render }, { Chat }, { QuestionStore }, { ApprovalStore }, commandModule] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('../src/screens/Chat.js'),
  import('../src/dsh-adapter/questions.js'),
  import('../src/dsh-adapter/approvals.js'),
  import('../src/commands.js'),
])

const COLS = 100
const ROWS = 40
const term = new XTerm({ cols: COLS, rows: ROWS, scrollback: 50, allowProposedApi: true })

class FakeStdout extends Writable {
  columns = COLS
  rows = ROWS
  isTTY = true
  _write(chunk: unknown, _e: BufferEncoding, cb: () => void) { term.write(String(chunk), cb) }
}
class FakeStderr extends Writable {
  isTTY = true
  _write(_c: unknown, _e: BufferEncoding, cb: () => void) { cb() }
}
class FakeStdin extends PassThrough {
  isTTY = true
  setRawMode() { return this }
  ref() { return this }
  unref() { return this }
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
function screenText(): string {
  const buf = term.buffer.active
  const lines: string[] = []
  for (let y = 0; y < ROWS; y++) lines.push(buf.getLine(y)?.translateToString(true) ?? '')
  return lines.join('\n')
}
function assert(condition: boolean, label: string, screen?: string): void {
  console.log(`${condition ? 'ok' : 'FAIL'} — ${label}`)
  if (!condition) {
    console.log('--- screen ---\n' + (screen ?? screenText()))
    process.exit(1)
  }
}

// ── In-memory settings host: two namespaces, one plugin section each ──
const mutations: { ns: string; ops: readonly unknown[]; expected: number | undefined }[] = []
const docs: Record<string, { revision: number; value: Record<string, unknown>; user: Record<string, unknown> }> = {
  'demo-plugin': { revision: 3, value: { enabled: true, limit: 3 }, user: { enabled: true } },
  'other-plugin': { revision: 1, value: { mode: 'fast' }, user: {} },
}
const host = {
  listNamespaces: () => Object.entries(docs).map(([ns, doc]) => ({
    ns,
    revision: doc.revision,
    applies: 'live' as const,
    value: { ...doc.value },
    user: { ...doc.user },
  })),
  write: (ns: string, ops: readonly { op: string; path: readonly string[]; value?: unknown }[], expected?: number) => {
    const doc = docs[ns]
    if (doc === undefined) return Promise.reject(new Error(`unknown namespace ${ns}`))
    mutations.push({ ns, ops, expected })
    if (expected !== undefined && expected !== doc.revision) {
      const conflict = new Error('stale') as Error & { code: string }
      conflict.code = 'SETTINGS_CONFLICT'
      return Promise.reject(conflict)
    }
    for (const op of ops) {
      let parent = doc.value
      for (const segment of op.path.slice(0, -1)) {
        const child = parent[segment]
        if (typeof child === 'object' && child !== null && !Array.isArray(child)) {
          parent = child as Record<string, unknown>
        } else {
          const created: Record<string, unknown> = {}
          parent[segment] = created
          parent = created
        }
      }
      const leaf = op.path.at(-1)
      if (leaf === undefined) continue
      if (op.op === 'set') parent[leaf] = op.value
      else delete parent[leaf]
    }
    doc.revision += 1
    return Promise.resolve()
  },
  credentialConfigured: () => Promise.resolve(false),
  writeCredential: () => Promise.resolve(),
}
const demoSection = {
  ns: 'demo-plugin',
  title: 'Demo settings',
  fields: [
    { path: ['enabled'], label: 'Enabled', kind: 'boolean' as const },
    { path: ['limit'], label: 'Retry limit', kind: 'number' as const, hint: 'Attempts before giving up' },
  ],
}
const otherSection = {
  ns: 'other-plugin',
  title: 'Other settings',
  fields: [
    { path: ['mode'], label: 'Mode', kind: 'select' as const, options: [
      { value: 'fast', label: 'Fast' },
      { value: 'safe', label: 'Safe' },
    ] },
  ],
}

const listeners = new Set<() => void>()
let settingsHostCalls = 0
const channel: any = {
  version: 0,
  rows: [],
  status: 'idle',
  sessionTitle: 'probe',
  agentId: 'probe',
  model: 'deepseek-v4-flash',
  mode: { plan: false },
  reasoningEffort: 'max',
  tokens: { input: 1, output: 1 },
  cwd: '/tmp/demo',
  displayCwd: '/tmp/demo',
  gitBranch: 'main',
  working: false,
  spinnerMode: 'requesting',
  responseChars: 0,
  activeToolCount: 0,
  turnStart: Date.now(),
  lastUserText: '',
  pending: [],
  commandList: commandModule.LOCAL_COMMANDS,
  notifications: [],
  subscribe(cb: () => void) { listeners.add(cb); return () => listeners.delete(cb) },
  submit: () => {}, cancel: () => {}, clear: () => {},
  notify: () => {},
  listModels: () => Promise.resolve([]), listSessions: () => [], setResumeTarget: () => {},
  loadOlder: () => {}, mcpStatus: () => [],
  commandCompletions: () => [],
  // The channel MUST hand the screen the same host object every call — the
  // screen reads it on every render and keys effects on its identity, so a
  // fresh object per call re-fires them forever (P1-1). Count calls so a
  // render loop shows up as unbounded growth in scenario 5.
  settingsHost: () => { settingsHostCalls += 1; return host },
  settingsSections: () => [demoSection, otherSection],
  subscribeSettingsSections: () => () => {},
}

const stdin = new FakeStdin()
// fullscreen matches the shipped default (cordis.yml `fullscreen: true`):
// screens then render bare — Chat is already inside the app's alternate
// screen, and nesting a second one is both wrong (DEC 1049) and, in this
// headless harness, drops the first painted row.
const instance = await render(
  <Chat fullscreen channel={channel} questionStore={new QuestionStore()} approvalStore={new ApprovalStore()} />,
  { stdout: new FakeStdout(), stdin, stderr: new FakeStderr(), exitOnCtrlC: false, patchConsole: false },
)
await sleep(600)

// 1. /settings opens the screen with the section and its seeded values.
stdin.write('/settings')
await sleep(200)
stdin.write('\r')
await sleep(500)
assert(screenText().includes('Plugin settings'), 'screen opens with the title')
assert(screenText().includes('Demo settings') && screenText().includes('(demo-plugin)'), 'section header renders')
assert(screenText().includes('Enabled') && screenText().includes('true'), 'boolean field shows its value')
assert(screenText().includes('overridden'), 'user-layer presence marks the override')

// 2. Enter stages a boolean toggle; `s` saves it as a fenced set op.
stdin.write('\r')
await sleep(300)
assert(screenText().includes('unsaved'), 'staged toggle marks the section dirty')
stdin.write('s')
await sleep(400)
assert(mutations.length === 1, 'save wrote exactly one mutation')
const first = mutations[0]
assert(first?.ns === 'demo-plugin' && first.expected === 3, 'write fenced by the seeded revision')
const firstOps = first?.ops as { op: string; path: readonly string[]; value?: unknown }[]
assert(firstOps?.[0]?.op === 'set' && firstOps[0].path.join('.') === 'enabled' && firstOps[0].value === false, 'boolean toggle became a set op')
assert(screenText().includes('Saved demo-plugin'), 'save notice renders')
assert(docs['demo-plugin']?.value.enabled === false, 'host document reflects the write')

// 3. Number field: ↓ focus, Enter edit (the draft seeds from the current
// value), backspace the old digit away, type, Enter stage, s save.
stdin.write('\x1b[B') // ↓
await sleep(200)
stdin.write('\r')
await sleep(200)
stdin.write('\x7f') // backspace the seeded '3'
await sleep(200)
stdin.write('10')
await sleep(200)
stdin.write('\r')
await sleep(200)
assert(screenText().includes('10'), 'staged number draft renders')
stdin.write('s')
await sleep(400)
assert(mutations.length === 2, 'second save wrote')
const secondOps = mutations[1]?.ops as { op: string; path: readonly string[]; value?: unknown }[]
assert(secondOps?.[0]?.op === 'set' && secondOps[0].path.join('.') === 'limit' && secondOps[0].value === 10, 'number draft became a numeric set op')

// 4. Cross-section Esc (P2-4): stage a toggle in demo-plugin, move focus
// into other-plugin, then Esc. The OLD code only checked the FOCUSED
// section's form — clean here — and closed, silently dropping the staged
// toggle. The fixed behavior: Esc discards EVERY section's staged drafts
// first (notice), and only a second Esc leaves.
stdin.write('\x1b[A') // ↑ back to Enabled
await sleep(200)
stdin.write('\r') // stage a toggle in demo-plugin (dirty)
await sleep(200)
stdin.write('\x1b[B') // ↓
await sleep(150)
stdin.write('\x1b[B') // ↓ into other-plugin's Mode field
await sleep(300)
stdin.write('\x1b') // Esc: focused section is clean, demo-plugin is dirty
await sleep(400)
assert(screenText().includes('Discarded all unsaved edits'), 'Esc discards staged edits across ALL sections')
assert(screenText().includes('Other settings'), 'screen stays open after the discard')
assert(mutations.length === 2, 'discard wrote nothing')

// 5. Quiescence (P1-1): with the screen open and idle, settingsHost() calls
// must stop growing. The screen calls it once per render, so an effect loop
// (unstable host identity re-firing host-keyed effects) shows up as
// unbounded growth; a settled screen makes no calls at all. The bound is
// generous — a real loop runs thousands of renders in this window.
const quietCalls = settingsHostCalls
await sleep(600)
assert(settingsHostCalls - quietCalls < 50, 'idle screen settles (no render loop through the host)')

// 6. Esc again — nothing dirty now — closes back to the conversation. NOTE:
// assert the conversation's return, not the title's absence — this headless
// harness keeps a stale first-row residue after EVERY screen close
// (SessionBrowser shows the same artifact; pre-existing renderer behavior,
// not this screen's doing).
stdin.write('\x1b')
await sleep(900)
assert(screenText().includes('Explore the uncharted'), 'second Esc returns to the conversation')

await instance.unmount()

// 7. Group navigation: the root hides grouped fields, Enter opens the group,
// and Esc returns without settling its staged drafts. Re-entering must show the
// draft, and saving must preserve a nested settings path.
const { Settings } = await import('../src/screens/Settings.js')
const GROUP_ROWS = 20
const groupTerm = new XTerm({ cols: COLS, rows: GROUP_ROWS, scrollback: 50, allowProposedApi: true })
class GroupStdout extends Writable {
  columns = COLS
  rows = GROUP_ROWS
  isTTY = true
  _write(chunk: unknown, _e: BufferEncoding, cb: () => void) { groupTerm.write(String(chunk), cb) }
}
function groupScreenText(): string {
  const buf = groupTerm.buffer.active
  const lines: string[] = []
  for (let y = 0; y < GROUP_ROWS; y++) lines.push(buf.getLine(y)?.translateToString(true) ?? '')
  return lines.join('\n')
}
docs['group-plugin'] = {
  revision: 5,
  value: { name: 'basic', advanced: { endpoint: 'old' } },
  user: {},
}
const groupSection = {
  ns: 'group-plugin',
  title: 'Grouped settings',
  groups: [{ id: 'advanced', title: 'Advanced' }],
  fields: [
    { path: ['name'], label: 'Name', kind: 'text' as const },
    { path: ['advanced', 'endpoint'], label: 'Endpoint', kind: 'text' as const, group: 'advanced' },
  ],
}
const groupChannel: any = { ...channel, settingsSections: () => [groupSection] }
const groupStdin = new FakeStdin()
let groupClosed = false
const groupInstance = await render(
  <Settings channel={groupChannel} onClose={() => { groupClosed = true }} />,
  { stdout: new GroupStdout(), stdin: groupStdin, stderr: new FakeStderr(), exitOnCtrlC: false, patchConsole: false },
)
await sleep(600)
assert(groupScreenText().includes('Name') && groupScreenText().includes('Advanced'), 'group root renders ungrouped fields and group entry', groupScreenText())
assert(!groupScreenText().includes('Endpoint'), 'group root hides grouped fields', groupScreenText())
groupStdin.write('\x1b[B') // ↓ from Name to Advanced
await sleep(200)
groupStdin.write('\r')
await sleep(400)
// The headless renderer leaves the first row stale across in-place screen
// transitions, so assert navigation through group-only content and its hint.
assert(groupScreenText().includes('Endpoint') && groupScreenText().includes('Esc back'), 'Enter opens the group page', groupScreenText())
assert(!groupScreenText().includes('Name'), 'group page shows only its fields', groupScreenText())
groupStdin.write('\r')
await sleep(150)
for (let i = 0; i < 3; i++) {
  groupStdin.write('\x7f')
  await sleep(50)
}
groupStdin.write('new')
await sleep(150)
groupStdin.write('\r')
await sleep(300)
assert(groupScreenText().includes('new'), 'group field draft is staged', groupScreenText())
groupStdin.write('\x1b')
await sleep(300)
assert(groupScreenText().includes('unsaved') && !groupScreenText().includes('Endpoint'), 'Esc returns to root without dropping the staged edit', groupScreenText())
groupStdin.write('\x1b[B')
await sleep(200)
groupStdin.write('\r')
await sleep(300)
assert(groupScreenText().includes('new'), 're-entering the group restores the staged draft', groupScreenText())
groupStdin.write('s')
await sleep(400)
const groupMutation = mutations[2]
const groupOps = groupMutation?.ops as { op: string; path: readonly string[]; value?: unknown }[]
assert(groupMutation?.ns === 'group-plugin' && groupMutation.expected === 5, 'group save is revision-fenced')
assert(groupOps?.[0]?.op === 'set' && groupOps[0].path.join('.') === 'advanced.endpoint' && groupOps[0].value === 'new', 'group save keeps the nested field path')
assert((docs['group-plugin']?.value.advanced as Record<string, unknown> | undefined)?.endpoint === 'new', 'nested group value reaches the host document')
groupStdin.write('\x1b')
await sleep(200)
groupStdin.write('\x1b')
await sleep(300)
assert(groupClosed, 'clean group screen exits from the root page')
await groupInstance.unmount()

// 8. Focus-follow scrolling (P2-3): a terminal shorter than the entry list
// must keep the focused field on screen. Render the Settings screen DIRECTLY
// (not through Chat — Chat's static splash shrinks Ink's live region and
// clips the frame, which is container behavior, not this screen's). Sixteen
// fields at rows=12 overflow the 8-line viewport (rows minus
// title/rules/hint); driving the focus to the last field must scroll the
// first fields out of view.
const SMALL_COLS = 80
const SMALL_ROWS = 12
const smallTerm = new XTerm({ cols: SMALL_COLS, rows: SMALL_ROWS, scrollback: 50, allowProposedApi: true })
class SmallStdout extends Writable {
  columns = SMALL_COLS
  rows = SMALL_ROWS
  isTTY = true
  _write(chunk: unknown, _e: BufferEncoding, cb: () => void) { smallTerm.write(String(chunk), cb) }
}
function smallScreenText(): string {
  const buf = smallTerm.buffer.active
  const lines: string[] = []
  for (let y = 0; y < SMALL_ROWS; y++) lines.push(buf.getLine(y)?.translateToString(true) ?? '')
  return lines.join('\n')
}
docs['long-plugin'] = {
  revision: 1,
  value: Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`f${i}`, i])),
  user: {},
}
const longSection = {
  ns: 'long-plugin',
  title: 'Long settings',
  fields: Array.from({ length: 16 }, (_, i) => ({ path: [`f${i}`], label: `Field ${i}`, kind: 'number' as const })),
}
const smallChannel: any = { ...channel, settingsSections: () => [longSection] }
const smallStdin = new FakeStdin()
let smallClosed = false
const smallInstance = await render(
  <Settings channel={smallChannel} onClose={() => { smallClosed = true }} />,
  { stdout: new SmallStdout(), stdin: smallStdin, stderr: new FakeStderr(), exitOnCtrlC: false, patchConsole: false },
)
await sleep(600)
assert(smallScreenText().includes('Long settings'), 'small terminal opens the screen', smallScreenText())
assert(smallScreenText().includes('Field 0') && !smallScreenText().includes('Field 15'), 'top of the list renders first', smallScreenText())
for (let i = 0; i < 15; i++) {
  smallStdin.write('\x1b[B')
  await sleep(120)
}
assert(smallScreenText().includes('Field 15'), 'focus on the last field scrolls it into view', smallScreenText())
assert(!smallScreenText().includes('Field 0'), 'scrolled-out fields leave the viewport', smallScreenText())
smallStdin.write('\x1b')
await sleep(400)
assert(smallClosed, 'Esc on a clean screen closes it')
await smallInstance.unmount()

// 9. The same focus-follow guarantee applies inside a group subpage.
const groupedSmallTerm = new XTerm({ cols: SMALL_COLS, rows: SMALL_ROWS, scrollback: 50, allowProposedApi: true })
class GroupedSmallStdout extends Writable {
  columns = SMALL_COLS
  rows = SMALL_ROWS
  isTTY = true
  _write(chunk: unknown, _e: BufferEncoding, cb: () => void) { groupedSmallTerm.write(String(chunk), cb) }
}
function groupedSmallScreenText(): string {
  const buf = groupedSmallTerm.buffer.active
  const lines: string[] = []
  for (let y = 0; y < SMALL_ROWS; y++) lines.push(buf.getLine(y)?.translateToString(true) ?? '')
  return lines.join('\n')
}
docs['long-group-plugin'] = {
  revision: 1,
  value: Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`f${i}`, i])),
  user: {},
}
const longGroupSection = {
  ns: 'long-group-plugin',
  title: 'Long grouped settings',
  groups: [{ id: 'advanced', title: 'Advanced fields' }],
  fields: Array.from({ length: 16 }, (_, i) => ({ path: [`f${i}`], label: `Grouped field ${i}`, kind: 'number' as const, group: 'advanced' })),
}
const groupedSmallChannel: any = { ...channel, settingsSections: () => [longGroupSection] }
const groupedSmallStdin = new FakeStdin()
const groupedSmallInstance = await render(
  <Settings channel={groupedSmallChannel} onClose={() => {}} />,
  { stdout: new GroupedSmallStdout(), stdin: groupedSmallStdin, stderr: new FakeStderr(), exitOnCtrlC: false, patchConsole: false },
)
await sleep(500)
assert(groupedSmallScreenText().includes('Advanced fields') && !groupedSmallScreenText().includes('Grouped field 0'), 'short group root hides grouped fields', groupedSmallScreenText())
groupedSmallStdin.write('\r')
await sleep(300)
assert(groupedSmallScreenText().includes('Grouped field 0') && !groupedSmallScreenText().includes('Grouped field 15'), 'short group page starts at its first field', groupedSmallScreenText())
for (let i = 0; i < 15; i++) {
  groupedSmallStdin.write('\x1b[B')
  await sleep(120)
}
assert(groupedSmallScreenText().includes('Grouped field 15'), 'short group page follows focus to its last field', groupedSmallScreenText())
assert(!groupedSmallScreenText().includes('Grouped field 0'), 'short group page windows scrolled-out fields', groupedSmallScreenText())
await groupedSmallInstance.unmount()

console.log('repro-settings: all assertions passed')
process.exit(0)
