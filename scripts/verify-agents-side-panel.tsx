/**
 * Agents side-panel migration regression: mounts SidePanelColumn + PanelHost in
 * a headless XTerm (AlternateScreen) with a fake channel behind the REAL
 * useSidePanel controller, and locks the migrated behavior:
 *  - badge: running/starting>0 lights 'info' while the agents panel is
 *    inactive; a NEW failed subagent flips it to 'error' with unread>=1;
 *    opening (visible) marks the failed set as seen and drops the error;
 *  - the dashboard renders INSIDE the panel: one cell of outer padding and the
 *    card separator following the panel's own columns (not the screen's);
 *  - Enter opens the detail of the focused card, ←/→ page it, and Esc from the
 *    detail returns to the dashboard WITHOUT handing the focus back to chat —
 *    Detail→Dashboard is consumed by the panel itself (the core v2.1 point);
 *  - Esc on the dashboard YIELDS to the host: focus returns to chat, the panel
 *    stays open and active (the dashboard is the root of this column);
 *  - the dashboard↔detail route survives switching to another panel and back
 *    (mountPolicy:'enabled' state retention);
 *  - 'x' interrupts the running subagent from the detail; a real SGR click on
 *    a dashboard card opens that card's detail;
 *  - a roster gap (the routed subagent is gone) falls back to the dashboard
 *    instead of rendering a stale detail.
 * Run: node --import tsx/esm scripts/verify-agents-side-panel.tsx
 */
process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_LANG = 'en'

const [{ PassThrough, Writable }, React, { Terminal: XTerm }, ui, { SidePanelColumn }, { useSidePanel }, prefs, { panelStore }, termTest] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('../src/components/sidePanel/SidePanelColumn.js'),
  import('../src/components/sidePanel/useSidePanel.js'),
  import('../src/tuiDisplayPrefs.js'),
  import('../src/components/sidePanel/PanelStore.js'),
  import('./lib/term-test.mjs'),
])
const { render, ThemeProvider, AlternateScreen, Box, Text, useInput } = ui
const { applySidePanelOpen, applySidePanelRatio } = prefs
const { settled } = termTest

const COLS = 120
const ROWS = 22

let failed = 0
function check(name: string, ok: boolean, extra = ''): void {
  console.log((ok ? 'PASS' : 'FAIL') + ': ' + name + (extra ? '  (' + extra + ')' : ''))
  if (!ok) failed += 1
}

// --- fake channel -----------------------------------------------------------
interface FakeSubagent {
  agentId: string
  description: string
  status: string
  startedAt: number
  completedAt?: number
  error?: string
  model?: string
  effort?: string
  output: string[]
  outputEvents: Array<{ kind: string; text: string; at: number; settled?: boolean }>
  toolCalls: Array<{ name: string; status: string; startedAt: number }>
}
let subagents: FakeSubagent[] = []
let channelVersion = 0
const channelListeners = new Set<() => void>()
const interrupted: string[] = []
const channel = {
  get version() { return channelVersion },
  get subagents() { return subagents },
  // jobs 面板默认启用，适配器读名册（jobs.length 摘要）
  backgroundJobs: [] as unknown[],
  subagentControl: {
    interrupt(id: string) { interrupted.push(id); return true },
  },
  notifications: [] as Array<{ text: string }>,
  notify(text: string) { channel.notifications.push({ text }) },
  subscribe(listener: () => void) {
    channelListeners.add(listener)
    return () => { channelListeners.delete(listener) }
  },
}
function setSubagents(next: FakeSubagent[]): void {
  subagents = next
  channelVersion += 1
  for (const listener of [...channelListeners]) listener()
}

const NOW = Date.now()
function agent(id: string, description: string, status: string, extra: Partial<FakeSubagent> = {}): FakeSubagent {
  return {
    agentId: id,
    description,
    status,
    startedAt: NOW - 60_000,
    model: 'glm-5.3',
    effort: 'max',
    output: [],
    outputEvents: [],
    toolCalls: [],
    ...extra,
  }
}
const A1 = agent('agent-run-1', 'AAA1', 'running', { output: ['older output', 'LIVE-PREVIEW-LINE'] })
const A2 = agent('agent-done-2', 'AAA2', 'completed', { completedAt: NOW - 10_000 })
const A3 = agent('agent-fail-3', 'AAA3', 'failed', { completedAt: NOW - 5_000, error: 'boom' })
const A4 = agent('agent-done-4', 'AAA4', 'completed', { completedAt: NOW - 9_000 })
const A5 = agent('agent-done-5', 'AAA5', 'completed', { completedAt: NOW - 8_000 })
const A6 = agent('agent-done-6', 'AAA6', 'completed', { completedAt: NOW - 7_000 })

// --- harness ----------------------------------------------------------------
let exposedFocus = ''
let exposedActive = ''
let exposedSplit = false
let exposedChatColumns = 0
let openAgents: (() => void) | undefined
let openTodo: (() => void) | undefined

function Harness(): React.ReactNode {
  const sp = useSidePanel({ columns: COLS, fullscreen: true, editorOpen: false })
  const [, bump] = React.useState(0)
  exposedFocus = sp.focus
  exposedActive = sp.activePanelId ?? 'none'
  exposedSplit = sp.split
  exposedChatColumns = sp.chatColumns
  openAgents = () => sp.openPanel('agents', { focus: true })
  openTodo = () => sp.openPanel('todo', { focus: true })
  React.useEffect(() => channel.subscribe(() => bump(previous => previous + 1)), [])
  useInput((input: string, key: Record<string, boolean | undefined>) => {
    sp.handleKey(input, key as never)
    bump(previous => previous + 1)
  })
  return (
    // 高度钉死为屏幕行数（生产形态是 SidePanelLayout 的定高行）：不钉时
    // 列高随内容涨出屏幕、帧底锚定，滚动类断言读到的是帧底而不是视口。
    <Box flexDirection="row" width={COLS} height={ROWS}>
      <Box width={sp.split ? sp.chatColumns : COLS}><Text>{'chat-anchor SP split=' + (sp.split ? 1 : 0) + ' focus=' + sp.focus + ' active=' + (sp.activePanelId ?? 'none')}</Text></Box>
      {sp.split ? <SidePanelColumn width={sp.panelColumns} controller={sp} channel={channel as never} /> : null}
    </Box>
  )
}

class FakeStdout extends Writable {
  columns = COLS
  rows = ROWS
  isTTY = true
  term: import('@xterm/headless').Terminal
  constructor(term: import('@xterm/headless').Terminal) { super(); this.term = term }
  _write(chunk: unknown, _e: BufferEncoding, cb: () => void) { this.term.write(String(chunk), cb) }
}
class FakeStderr extends Writable { isTTY = true; _write(_c: unknown, _e: BufferEncoding, cb: () => void) { cb() } }
class FakeStdin extends PassThrough { isTTY = true; setRawMode() { return this }; ref() { return this }; unref() { return this } }

// Live stores are module-level: pin open + the default ratio so the harness
// starts split (mirrors Chat at 120 columns with the sidebar enabled).
applySidePanelOpen(true)
applySidePanelRatio(0.68)
// 可重挂载的夹具：滚动/焦点是面板内状态（mountPolicy:'enabled' 的卖点），
// 跨用例段共享会互相污染——需要「全新面板」的段落 unmount 后重挂。
let term: InstanceType<typeof XTerm>
let stdin: FakeStdin
let app: Awaited<ReturnType<typeof render>>
async function mountApp(): Promise<void> {
  term = new XTerm({ cols: COLS, rows: ROWS, scrollback: 0, allowProposedApi: true })
  const stdout = new FakeStdout(term)
  stdin = new FakeStdin()
  app = await render(
    <AlternateScreen mouseTracking={true}>
      <ThemeProvider theme="dark">
        <Harness />
      </ThemeProvider>
    </AlternateScreen>,
    {
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      stderr: new FakeStderr() as unknown as NodeJS.WriteStream,
      exitOnCtrlC: false,
      patchConsole: false,
    },
  )
}
await mountApp()
function lines(): string[] {
  const buf = term.buffer.active
  const out: string[] = []
  for (let y = 0; y < ROWS; y += 1) out.push((buf.getLine(y)?.translateToString(false) ?? '').padEnd(COLS, ' '))
  return out
}
const state = (): string => lines().find(l => l.includes('SP split=')) ?? ''
const findCell = (needle: string): { col: number; row: number } | null => {
  const ls = lines()
  for (let y = 0; y < ls.length; y += 1) {
    const col = ls[y].indexOf(needle)
    if (col >= 0) return { col, row: y }
  }
  return null
}
const findRow = (needle: string): number => lines().findIndex(l => l.includes(needle))
const has = (needle: string): boolean => lines().some(l => l.includes(needle))
/** 同一 tick 里的两次 stdin.write 会被 ink 解析成一条多字符（粘贴）事件，
 *  按键语义随之丢失——写一个键后让出一轮事件循环再写下一位。 */
const writeKey = async (data: string): Promise<void> => {
  stdin.write(data)
  await new Promise(resolve => setImmediate(resolve))
}
function dumpScreen(): void {
  console.error(lines().map((l, i) => i + '|' + l.replace(/ +$/, '')).join('\n'))
}

try {
  await settled(() => state().includes('split=1'))
  check('mount: split renders with the agents tab enabled', state().includes('split=1 focus=chat active=todo'), state())
  check('mount: the active Todo title is on the PanelBar', has('Todo'))
  check('badge: empty roster and no failure leaves the badge null', panelStore.get('agents')?.badge === null,
    JSON.stringify(panelStore.get('agents')?.badge ?? null))

  // --- 1. badge: running → info while the agents panel is inactive ---------
  setSubagents([A1, A2])
  await settled(() => panelStore.get('agents')?.badge?.level === 'info')
  check('badge: a running subagent lights info on the agents tab', panelStore.get('agents')?.badge?.level === 'info',
    JSON.stringify(panelStore.get('agents')?.badge ?? null))

  // --- 2. badge: NEW failed subagent (unseen) → error with unread ----------
  setSubagents([A1, A2, A3])
  await settled(() => panelStore.get('agents')?.badge?.level === 'error')
  const errorBadge = panelStore.get('agents')?.badge ?? null
  check('badge: unseen failed subagent flips to error unread=1',
    errorBadge !== null && errorBadge.level === 'error' && errorBadge.unread === 1, JSON.stringify(errorBadge))

  // --- 3. open the agents tab: dashboard renders inside the panel ----------
  openAgents?.()
  await settled(() => state().includes('active=agents') && has('AAA1'))
  check('open: the dashboard renders in the split panel', has('AAA1') && has('AAA2') && has('AAA3'))
  check('open: summary line counts running', has('1 running'), (lines().find(l => l.includes('running')) ?? '').trim())
  check('open: the PanelBar carries the panel title', has('Agents'))
  check('layout: no duplicate dashboard title or fixed footer', !has('Subagent Dashboard') && !has('Enter view detail'))
  let agentRows = lines().filter(line => /AAA[123]/.test(line))
  check('layout: three agents occupy three compact rows', agentRows.length === 3, JSON.stringify(agentRows))
  const firstAgentRow = findRow('AAA1')
  const secondAgentRow = findRow('AAA2')
  const betweenAgentRows = firstAgentRow >= 0 && secondAgentRow > firstAgentRow ? lines().slice(firstAgentRow + 1, secondAgentRow) : []
  check('layout: compact metadata and only one view action separate adjacent agents', secondAgentRow === firstAgentRow + 4 && betweenAgentRows.some(line => line.includes('open in main view')) && !betweenAgentRows.some(line => /─{20,}/.test(line)), JSON.stringify(betweenAgentRows))
  check('layout: only the focused agent gets an open-view action', lines().filter(line => line.includes('open in main view')).length === 1)
  check('layout: running agents retain their newest output preview', has('LIVE-PREVIEW-LINE') && !has('older output'))
  setSubagents([A1, A2, A3, A4, A5])
  check('layout: five agents fit in the panel host', await settled(() => has('AAA1') && has('AAA5')), lines().filter(line => /AAA[1-5]/.test(line)).join('|'))
  agentRows = lines().filter(line => /AAA[1-5]/.test(line))
  check('layout: five agents keep compact title rows', agentRows.length === 5, JSON.stringify(agentRows))
  check('layout: every agent includes model, effort and elapsed on one metadata row', lines().filter(line => line.includes('glm-5.3 · max ·')).length === 5, lines().filter(line => line.includes('glm-5.3')).join('|'))
  check('layout: descriptions are not prefixed', !lines().some(line => line.includes('Subagent:')))
  check('layout: empty tool count is omitted', !lines().some(line => line.includes('0 tools')))
  setSubagents([A1, A2, A3])
  // The host clears the badge on activation (children effects run first, so
  // the host's clear wins that frame); the adapter re-lights running>0 as info
  // on the next channel version bump while visible.
  await settled(() => panelStore.get('agents')?.badge?.level !== 'error')
  setSubagents([A1, A2, A3])
  await settled(() => panelStore.get('agents')?.badge?.level === 'info')
  check('open: error badge cleared once visible (running re-lights info)',
    panelStore.get('agents')?.badge?.level === 'info', JSON.stringify(panelStore.get('agents')?.badge ?? null))

  // --- 4. Enter opens the focused card's detail ---------------------------
  await writeKey('\r')
  await settled(() => has('1/3') && has('Subagent: AAA1'))
  check('keys: Enter opens the focused card detail (usePanelInput dispatch)', has('1/3') && has('Subagent: AAA1'),
    (lines().find(l => l.includes('/3')) ?? '').trim())
  check('detail: the dashboard list is replaced by the paged scene', !has('AAA2'))

  // --- 5. ←/→ page the detail --------------------------------------------
  await writeKey('\x1b[C')
  await settled(() => has('2/3'))
  check('keys: rightArrow pages the detail forward', has('2/3'))
  await writeKey('\x1b[C')
  await settled(() => has('3/3'))
  await writeKey('\x1b[C')
  await settled(() => has('1/3'))
  check('keys: rightArrow wraps 3/3 → 1/3', has('1/3'))
  await writeKey('\x1b[D')
  await settled(() => has('3/3'))
  check('keys: leftArrow pages the detail backward (wraps to 3/3)', has('3/3'))

  // --- 6. Esc in the detail: back to the dashboard, focus STAYS in the panel
  await writeKey('\x1b')
  await settled(() => has('AAA1') && !has('/3'))
  check('esc: detail → dashboard (the panel consumed the key)', has('AAA1') && !has('/3'))
  check('esc: focus is still in the panel (chat did NOT take it back)',
    exposedFocus === 'panel' && exposedSplit && exposedActive === 'agents',
    'focus=' + exposedFocus + ' split=' + String(exposedSplit) + ' active=' + exposedActive)

  // --- 7. the route survives switching panels away and back ---------------
  await writeKey('\r')
  await settled(() => has('1/3'))
  await writeKey('\x1b[C')
  await settled(() => has('2/3'))
  openTodo?.()
  await settled(() => state().includes('active=todo'))
  check('route: switching to another panel hides the agents panel', !has('2/3'))
  openAgents?.()
  await settled(() => state().includes('active=agents') && has('2/3'))
  check('route: dashboard → detail page survives a panel switch (enabled mount policy)', has('2/3'),
    (lines().find(l => l.includes('/3')) ?? '').trim())

  // --- 8. Esc on the dashboard YIELDS to the host -------------------------
  await writeKey('\x1b')
  await settled(() => has('AAA1') && !has('/3'))
  check('esc: detail → dashboard again', has('AAA1') && !has('/3'))
  await writeKey('\x1b')
  await settled(() => exposedFocus === 'chat')
  check('esc: dashboard yields — focus returns to chat (panel stays open)',
    exposedFocus === 'chat' && exposedSplit && exposedActive === 'agents',
    'focus=' + exposedFocus + ' split=' + String(exposedSplit) + ' active=' + exposedActive)
  check('esc: the dashboard is still rendered (sidebar not closed)', has('AAA1'))

  // --- 9. ↑/↓ move the focus lane; x interrupts the running row -----------
  // 名册先长过视口：焦点高亮是样式、读不出文本，但 ↓/↑ 同时 scrollBy(±3)，
  // 位移才是可以从屏幕判定的「面板确实吃到了这个键」。
  setSubagents([A1, A2, A3, A4, A5, A6, ...Array.from({ length: 14 }, (_, index) => agent('agent-extra-' + index, 'AAA' + (index + 7), 'completed', { completedAt: NOW - 1000 }))])
  // 全新挂载（scroll=0 / focusIndex=0）：上面段落已经在面板里滚过、进出过
  // detail，滚动与焦点车道是会保留的内状态，不能带进滚动契约的断言里。
  await app.unmount()
  await mountApp()
  await settled(() => state().includes('split=1') && has('AAA1'))
  openAgents?.()
  await settled(() => exposedFocus === 'panel' && has('AAA1') && !has('AAA20'))
  check('keys: a long roster overflows the panel viewport', has('AAA1') && !has('AAA20'))
  await writeKey('\x1b[B')
  await settled(() => !lines().some(line => /\bAAA1\b/.test(line)))
  check('keys: downArrow is consumed by the panel (roster scrolls)', !lines().some(line => /\bAAA1\b/.test(line)), lines().filter(line => /AAA[1-9]/.test(line)).join('|'))
  await writeKey('\r')
  await settled(() => has('1/3'))
  check('keys: Enter after downArrow opens the SECOND card detail', has('AAA2') && has('1/3'),
    (lines().find(l => l.includes('/3')) ?? '').trim())
  await writeKey('\x1b') // back to the dashboard, focus lane stays on AAA2
  await settled(() => has('AAA3') && !has('/3'))
  await writeKey('\x1b[A')
  await settled(() => lines().some(line => /\bAAA1\b/.test(line)))
  check('keys: upArrow is consumed by the panel (roster scrolls back)', lines().some(line => /\bAAA1\b/.test(line)))
  await writeKey('\r')
  await settled(() => has('AAA1') && has('1/3'))
  check('keys: Enter after upArrow returns to the first card', has('AAA1') && has('1/3'))
  await writeKey('x')
  await settled(() => interrupted.length > 0)
  check('keys: x interrupts the running subagent from the detail', interrupted.join(',') === 'agent-run-1', interrupted.join(','))

  // --- 10. a real SGR click on a card opens its detail --------------------
  await writeKey('\x1b')
  await settled(() => has('AAA3') && !has('/3'))
  const cell = findCell('AAA3')
  check('click: target card on screen', cell !== null)
  if (cell !== null) {
    await writeKey('\x1b[<0;' + (cell.col + 1) + ';' + (cell.row + 1) + 'M')
    await writeKey('\x1b[<0;' + (cell.col + 1) + ';' + (cell.row + 1) + 'm')
    await settled(() => has('AAA3') && has('/3'))
    check('click: SGR press on a dashboard card opens that detail', has('/3'), (lines().find(l => l.includes('/3')) ?? '').trim())
  }

  // --- 11. a roster gap falls back to the dashboard -----------------------
  setSubagents([])
  await settled(() => has('No subagents in the current session'))
  check('route: a missing subagent falls back to the dashboard (empty state)',
    has('No subagents in the current session') && !has('/3'))
} finally {
  // 失败时把最后一帧打给 stderr：CI 日志里能直接看到断言看到的那一屏。
  if (failed > 0) dumpScreen()
  await app.unmount()
  term.dispose()
}

if (failed > 0) {
  console.error('FAILED: ' + failed + ' check(s).')
  process.exit(1)
}
console.log('OK: agents side panel all checks passed.')
process.exit(0)
