/**
 * /settings screen scenario (issue #165, real input path via stdin):
 * 1. `/settings` opens the plugin settings screen (section + fields render)
 * 2. Enter on a boolean field toggles AND auto-saves — the write lands as
 *    revision-fenced `mutate` path ops with no save key
 * 3. editing a number field and confirming translates it to a numeric
 *    `set` op and auto-saves on Enter
 * 4. a quiet screen settles — settingsHost() calls stay bounded (P1-1: the
 *    screen keys effects on host identity, so an unstable host loops forever)
 * 5. Esc leaves directly (auto-save leaves nothing to discard — no discard
 *    notice, no extra writes)
 * 6. a terminal shorter than the entry list scrolls to follow the focus
 *    (P2-3: the focused field is always on screen)
 *
 * Exits non-zero on the first failed assertion (CI convention).
 */
process.env.FORCE_COLOR = '3'
// This script asserts English UI copy; pin the language before any
// module import resolves the startup lang (env > persisted > locale).
process.env.DSH_TUI_LANG = 'en'

const [{ PassThrough, Writable }, React, { Terminal: XTerm }, { render }, { Chat }, { QuestionStore }, { ApprovalStore }, commandModule, { settle, settled, sleep, viewportLines }] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('../src/screens/Chat.js'),
  import('../src/dsh-adapter/questions.js'),
  import('../src/dsh-adapter/approvals.js'),
  import('../src/commands.js'),
  import('./lib/term-test.mjs'),
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
function screenText(): string {
  // 刻意读缓冲区开头而非视口：本 inline harness 下 /settings 屏的标题行会被
  // 滚进 scrollback（baseY 上方），断言以完整首帧内容为目标——换成 baseY 视口
  // 读取会丢标题（实测 'Plugin settings' 断言失败）。
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
await settle(() => screenText().includes('Explore the uncharted'))

// 1. /settings opens the screen with the section and its seeded values.
// The 200ms below stays a fixed ordering sleep: the Enter that follows needs
// the slash-completion overlay to be key-ready, which is not observable as
// screen content.
stdin.write('/settings')
await sleep(200)
stdin.write('\r')
assert(await settled(() => screenText().includes('Plugin settings')), 'screen opens with the title')
assert(await settled(() => screenText().includes('Demo settings') && screenText().includes('(demo-plugin)')), 'section header renders')
assert(await settled(() => screenText().includes('Enabled') && screenText().includes('[✓')), 'boolean field renders its checked toggle chip')
assert(await settled(() => screenText().includes('customized')), 'user-layer presence surfaces as customized in the help bar')

// 2. Enter toggles a boolean AND auto-saves it — no save key: one fenced
// set op lands, the toast confirms, the host document reflects the write.
stdin.write('\r')
assert(await settled(() => mutations.length === 1), 'toggle auto-saved exactly one mutation')
const first = mutations[0]
assert(first?.ns === 'demo-plugin' && first.expected === 3, 'write fenced by the seeded revision')
const firstOps = first?.ops as { op: string; path: readonly string[]; value?: unknown }[]
assert(firstOps?.[0]?.op === 'set' && firstOps[0].path.join('.') === 'enabled' && firstOps[0].value === false, 'boolean toggle became a set op')
assert(await settled(() => screenText().includes('Saved demo-plugin')), 'auto-save notice renders')
assert(docs['demo-plugin']?.value.enabled === false, 'host document reflects the write')

// 3. Number field: ↓ focus, Enter edit (the draft seeds from the current
// value), backspace the old digit away, type, Enter confirms AND auto-saves.
// 下面的逐键 200ms 均为编辑器模式切换的 pacing：焦点/编辑态只体现为颜色与
// 光标，无可观测的纯文本条件，保留固定窗口。
stdin.write('\x1b[B') // ↓
await sleep(200)
stdin.write('\r')
await sleep(200)
stdin.write('\x7f') // backspace the seeded '3'
await sleep(200)
stdin.write('10')
await sleep(200)
stdin.write('\r')
assert(await settled(() => mutations.length === 2), 'confirmed number draft auto-saved')
const secondOps = mutations[1]?.ops as { op: string; path: readonly string[]; value?: unknown }[]
assert(secondOps?.[0]?.op === 'set' && secondOps[0].path.join('.') === 'limit' && secondOps[0].value === 10, 'number draft became a numeric set op')

// 4. Quiescence (P1-1): with the screen open and idle, settingsHost() calls
// must stop growing. The screen calls it once per render, so an effect loop
// (unstable host identity re-firing host-keyed effects) shows up as
// unbounded growth; a settled screen makes no calls at all. The bound is
// generous — a real loop runs thousands of renders in this window.
// Stability probe (calls must NOT grow): polling an already-true condition
// would return immediately and test nothing — keep the fixed window.
const quietCalls = settingsHostCalls
await sleep(600)
assert(settingsHostCalls - quietCalls < 50, 'idle screen settles (no render loop through the host)')

// 5. Esc just leaves — auto-save means there is never anything to discard,
// so a single Esc returns to the conversation with no discard notice and no
// extra writes. NOTE: assert the conversation's return, not the title's
// absence — this headless harness keeps a stale first-row residue after
// EVERY screen close (SessionBrowser shows the same artifact; pre-existing
// renderer behavior, not this screen's doing).
stdin.write('\x1b')
assert(await settled(() => screenText().includes('Explore the uncharted')), 'Esc leaves the settings screen directly')
assert(!screenText().includes('Discarded'), 'auto-save leaves nothing to discard')
assert(mutations.length === 2, 'exiting wrote nothing extra')

await instance.unmount()

// 7. Group navigation: the root hides grouped fields, Enter opens the group,
// and a confirmed text draft auto-saves through the nested path. Esc returns
// to the root; re-entering shows the SAVED value.
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
  return viewportLines(groupTerm, GROUP_ROWS).join('\n')
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
assert(await settled(() => groupScreenText().includes('Name') && groupScreenText().includes('Advanced')), 'group root renders ungrouped fields and group entry', groupScreenText())
assert(!groupScreenText().includes('Endpoint'), 'group root hides grouped fields', groupScreenText())
// 焦点移动只体现为颜色高亮，无可观测的纯文本条件，保留固定 pacing。
groupStdin.write('\x1b[B') // ↓ from Name to Advanced
await sleep(200)
groupStdin.write('\r')
// The headless renderer leaves the first row stale across in-place screen
// transitions, so assert navigation through group-only content and its hint.
assert(await settled(() => groupScreenText().includes('Endpoint') && groupScreenText().includes('Esc back')), 'Enter opens the group page', groupScreenText())
assert(!groupScreenText().includes('Name'), 'group page shows only its fields', groupScreenText())
// 编辑器模式切换与逐键退格的 pacing：编辑态无可观测的纯文本条件，保留固定窗口。
groupStdin.write('\r')
await sleep(150)
for (let i = 0; i < 3; i++) {
  groupStdin.write('\x7f')
  await sleep(50)
}
groupStdin.write('new')
await sleep(150)
groupStdin.write('\r')
// 写入落地后 mutations[2] 即终态，后续为同步派生断言。
const groupSaved = await settled(() => mutations.length === 3)
const groupMutation = mutations[2]
const groupOps = groupMutation?.ops as { op: string; path: readonly string[]; value?: unknown }[]
assert(groupSaved && groupMutation?.ns === 'group-plugin' && groupMutation.expected === 5, 'group auto-save is revision-fenced')
assert(groupOps?.[0]?.op === 'set' && groupOps[0].path.join('.') === 'advanced.endpoint' && groupOps[0].value === 'new', 'group auto-save keeps the nested field path')
assert((docs['group-plugin']?.value.advanced as Record<string, unknown> | undefined)?.endpoint === 'new', 'nested group value reaches the host document')
groupStdin.write('\x1b')
assert(await settled(() => groupScreenText().includes('Advanced') && !groupScreenText().includes('Endpoint')), 'Esc returns to the root page', groupScreenText())
// 焦点移动只体现为颜色高亮，无可观测的纯文本条件，保留固定 pacing。
groupStdin.write('\x1b[B')
await sleep(200)
groupStdin.write('\r')
assert(await settled(() => groupScreenText().includes('new')), 're-entering the group shows the saved value', groupScreenText())
// 两次 Esc 之间的处理顺序无可观测中间条件（第一次 Esc 不改变可断言的纯文本），保留固定 pacing。
groupStdin.write('\x1b')
await sleep(200)
groupStdin.write('\x1b')
assert(await settled(() => groupClosed), 'clean group screen exits from the root page')
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
  return viewportLines(smallTerm, SMALL_ROWS).join('\n')
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
assert(await settled(() => smallScreenText().includes('Long settings')), 'small terminal opens the screen', smallScreenText())
assert(await settled(() => smallScreenText().includes('Field 0') && !smallScreenText().includes('Field 15')), 'top of the list renders first', smallScreenText())
// 逐键 ↓ 的 pacing：中间焦点位置只体现为颜色，无可观测的纯文本条件。
for (let i = 0; i < 15; i++) {
  smallStdin.write('\x1b[B')
  await sleep(120)
}
assert(await settled(() => smallScreenText().includes('Field 15')), 'focus on the last field scrolls it into view', smallScreenText())
assert(await settled(() => !smallScreenText().includes('Field 0')), 'scrolled-out fields leave the viewport', smallScreenText())
smallStdin.write('\x1b')
assert(await settled(() => smallClosed), 'Esc on a clean screen closes it')
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
  return viewportLines(groupedSmallTerm, SMALL_ROWS).join('\n')
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
assert(await settled(() => groupedSmallScreenText().includes('Advanced fields') && !groupedSmallScreenText().includes('Grouped field 0')), 'short group root hides grouped fields', groupedSmallScreenText())
groupedSmallStdin.write('\r')
assert(await settled(() => groupedSmallScreenText().includes('Grouped field 0') && !groupedSmallScreenText().includes('Grouped field 15')), 'short group page starts at its first field', groupedSmallScreenText())
// 逐键 ↓ 的 pacing：中间焦点位置只体现为颜色，无可观测的纯文本条件。
for (let i = 0; i < 15; i++) {
  groupedSmallStdin.write('\x1b[B')
  await sleep(120)
}
assert(await settled(() => groupedSmallScreenText().includes('Grouped field 15')), 'short group page follows focus to its last field', groupedSmallScreenText())
assert(await settled(() => !groupedSmallScreenText().includes('Grouped field 0')), 'short group page windows scrolled-out fields', groupedSmallScreenText())
await groupedSmallInstance.unmount()

// 10. Layout stability (the "选中字符跳动 / 按钮对不齐" complaint): every row
// is always exactly one line and the value column stays flush right, so
// moving the focus between hinted and unhinted fields never reflows the list
// or shifts any row's value. The focused field's hint renders in the bottom
// help bar instead of under the row.
const STABLE_ROWS = 14
const stableTerm = new XTerm({ cols: SMALL_COLS, rows: STABLE_ROWS, scrollback: 50, allowProposedApi: true })
class StableStdout extends Writable {
  columns = SMALL_COLS
  rows = STABLE_ROWS
  isTTY = true
  _write(chunk: unknown, _e: BufferEncoding, cb: () => void) { stableTerm.write(String(chunk), cb) }
}
function stableLines(): string[] {
  return viewportLines(stableTerm, STABLE_ROWS)
}
function stableScreenText(): string {
  return stableLines().join('\n')
}
// A fresh host: the shared `docs` object was mutated by the earlier
// scenarios (limit→10, enabled→false), and carries extra namespaces. The
// write applies ops for real — auto-save re-seeds from this document, so a
// no-op write would make every saved toggle appear to revert.
const stableDocs: Record<string, { revision: number; value: Record<string, unknown>; user: Record<string, unknown> }> = {
  'demo-plugin': { revision: 3, value: { enabled: true, limit: 3, mode: 'fast' }, user: { enabled: true } },
  'other-plugin': { revision: 1, value: { mode: 'fast' }, user: {} },
}
let stableWrites = 0
const stableHost = {
  listNamespaces: () => Object.entries(stableDocs).map(([ns, doc]) => ({
    ns,
    revision: doc.revision,
    applies: 'live' as const,
    value: { ...doc.value },
    user: { ...doc.user },
  })),
  write: (ns: string, ops: readonly { op: string; path: readonly string[]; value?: unknown }[]) => {
    stableWrites += 1
    const doc = stableDocs[ns]
    if (doc === undefined) return Promise.reject(new Error(`unknown namespace ${ns}`))
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
const stableChannel: any = { ...channel, settingsHost: () => stableHost, settingsSections: () => [demoSection, otherSection] }
const stableStdin = new FakeStdin()
const stableInstance = await render(
  <Settings channel={stableChannel} onClose={() => {}} />,
  { stdout: new StableStdout(), stdin: stableStdin, stderr: new FakeStderr(), exitOnCtrlC: false, patchConsole: false },
)
const lineOf = (fragment: string): number => stableLines().findIndex(line => line.includes(fragment))
assert(await settled(() => lineOf('Enabled') >= 0), 'stability harness opens', stableScreenText())
// ↓ to the hinted "Retry limit": its row stays one line, its value stays
// flush right (the old inline hint pushed the value ~40 columns left), and
// the hint shows in the bottom help bar.
const modeLineBefore = lineOf('Mode')
const retryLineBefore = lineOf('Retry limit')
stableStdin.write('\x1b[B')
await sleep(200)
assert(lineOf('Mode') === modeLineBefore && lineOf('Retry limit') === retryLineBefore, 'rows never reflow when focus moves', stableScreenText())
assert(stableLines()[retryLineBefore]?.trimEnd().endsWith('3 │') === true, 'hinted row keeps its value flush right while focused', stableScreenText())
// The hint may be truncated on a narrow terminal, but it renders on the left
// of the bottom help bar with the navigation keys pinned to the right.
assert(stableScreenText().includes('Attempts befor') && stableScreenText().includes('Enter open/edit/toggle'), 'field hint renders in the bottom help bar', stableScreenText())
// ↓ to the unhinted "Mode": same guarantees, and the stale hint is gone. The
// select renders the option's label as a ‹ chip › flush against the border.
stableStdin.write('\x1b[B')
await sleep(200)
assert(stableLines()[lineOf('Mode')]?.includes('Fast') === true && stableLines()[lineOf('Mode')]?.trimEnd().endsWith('› │') === true, 'select chip shows the option label flush right while focused', stableScreenText())
assert(!stableScreenText().includes('Attempts before giving up'), 'hint leaves the help bar when its field loses focus', stableScreenText())
assert(stableLines()[retryLineBefore]?.trimEnd().endsWith('3 │') === true, 'a focused row above does not shift the rows below', stableScreenText())
// Toggle a boolean: the chip flips in place (value column never moves) and
// the change auto-saves — the toast confirms and the flipped chip persists.
stableStdin.write('\x1b[A')
await sleep(150)
stableStdin.write('\x1b[A')
await sleep(150)
assert(stableLines()[lineOf('Enabled')]?.includes('[✓') === true, 'boolean true renders as a checked chip', stableScreenText())
stableStdin.write('\r')
assert(await settled(() => stableLines()[lineOf('Enabled')]?.includes('[  ]') === true), 'toggled chip flips without moving the value column', stableScreenText())
assert(await settled(() => stableScreenText().includes('Saved demo-plugin')), 'stability harness toggle auto-saves', stableScreenText())
// Rapid toggles serialize: two quick Enters while the first save is still in
// flight — the pending chain writes both in order instead of racing the
// revision fence, and the last toggle wins the document.
stableStdin.write('\r')
await sleep(50)
stableStdin.write('\r')
assert(await settled(() => stableWrites === 3), `rapid toggles serialize into ordered writes (writes=${stableWrites})`, stableScreenText())
assert(stableDocs['demo-plugin']?.value.enabled === false, 'the last rapid toggle wins the document')
await stableInstance.unmount()

console.log('repro-settings: all assertions passed')
process.exit(0)
