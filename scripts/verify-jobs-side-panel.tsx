/**
 * Jobs side-panel migration regression: mounts SidePanelColumn + PanelHost in
 * a headless XTerm (AlternateScreen) with a fake channel behind the REAL
 * useSidePanel controller, and locks the migrated behavior:
 *  - badge: running>0 lights 'info' while the jobs panel is inactive; a NEW
 *    failed job flips it to 'error' with unread>=1; opening (visible) marks
 *    the failed set as seen and drops the error;
 *  - opening the jobs tab renders the roster (ids, summary, focus marker) in
 *    the split panel;
 *  - keyboard goes through the v2.1 dispatcher (usePanelInput): downArrow
 *    moves the focused row, double-k kills the focused running job, Esc
 *    YIELDS to the host (focus returns to chat, panel stays open);
 *  - a real SGR mouse click on a roster row still focuses that job;
 *  - the jobsFocusStore lane refocuses the requested job (same id twice
 *    still re-applies — the nonce, not the id, drives it).
 * Run: node --import tsx/esm scripts/verify-jobs-side-panel.tsx
 */
process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_LANG = 'en'

const [{ PassThrough, Writable }, React, { Terminal: XTerm }, ui, { SidePanelColumn }, { useSidePanel }, prefs, { panelStore }, { jobsFocusStore }, termTest] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('../src/components/sidePanel/SidePanelColumn.js'),
  import('../src/components/sidePanel/useSidePanel.js'),
  import('../src/tuiDisplayPrefs.js'),
  import('../src/components/sidePanel/PanelStore.js'),
  import('../src/components/sidePanel/jobsFocusStore.js'),
  import('./lib/term-test.mjs'),
])
const { render, ThemeProvider, AlternateScreen, Box, Text, useInput } = ui
const { applySidePanelOpen, applySidePanelRatio } = prefs
const { settled, sleep } = termTest

const COLS = 120
const ROWS = 22

let failed = 0
function check(name: string, ok: boolean, extra = ''): void {
  console.log((ok ? 'PASS' : 'FAIL') + ': ' + name + (extra ? '  (' + extra + ')' : ''))
  if (!ok) failed += 1
}

// --- fake channel -----------------------------------------------------------
interface FakeJob {
  id: string
  kind: string
  label: string
  status: string
  startedAt: number
  command?: string
  outputLines: Array<{ text: string }>
}
let jobs: FakeJob[] = []
let channelVersion = 0
const channelListeners = new Set<() => void>()
const kills: string[] = []
const attachedContexts: Array<{ title: string; content: string }> = []
const channel = {
  get version() { return channelVersion },
  get backgroundJobs() { return jobs },
  // agents 面板默认启用，适配器读名册（subagents.filter）
  subagents: [] as unknown[],
  jobControl: {
    kill(id: string) { kills.push(id); return true },
  },
  notifications: [] as Array<{ text: string }>,
  notify(text: string) { channel.notifications.push({ text }) },
  attachContext(context: { title: string; content: string }) { attachedContexts.push(context) },
  subscribe(listener: () => void) {
    channelListeners.add(listener)
    return () => { channelListeners.delete(listener) }
  },
}
function setJobs(next: FakeJob[]): void {
  jobs = next
  channelVersion += 1
  for (const listener of [...channelListeners]) listener()
}

const NOW = Date.now()
const J1: FakeJob = { id: 'job-run-1', kind: 'pwsh', label: 'LLL1', status: 'running', startedAt: NOW - 60_000, command: 'gh run watch 1', outputLines: [{ text: 'step one ok' }] }
const J2: FakeJob = { id: 'job-done-2', kind: 'bash', label: 'LLL2', status: 'completed', startedAt: NOW - 90_000, outputLines: [] }
const J3: FakeJob = { id: 'job-run-3', kind: 'pwsh', label: 'LLL3', status: 'running', startedAt: NOW - 5_000, outputLines: [] }

// --- harness ----------------------------------------------------------------
let exposedFocus = ''
let exposedActive = ''
let exposedSplit = false
let openJobs: (() => void) | undefined

function Harness(): React.ReactNode {
  const sp = useSidePanel({ columns: COLS, fullscreen: true, editorOpen: false })
  const [, bump] = React.useState(0)
  exposedFocus = sp.focus
  exposedActive = sp.activePanelId ?? 'none'
  exposedSplit = sp.split
  openJobs = () => sp.openPanel('jobs', { focus: true })
  React.useEffect(() => channel.subscribe(() => bump(previous => previous + 1)), [])
  useInput((input: string, key: Record<string, boolean | undefined>) => {
    sp.handleKey(input, key as never)
    bump(previous => previous + 1)
  })
  return (
    <Box flexDirection="row" width={COLS}>
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
const term = new XTerm({ cols: COLS, rows: ROWS, scrollback: 0, allowProposedApi: true })
const stdout = new FakeStdout(term)
const stdin = new FakeStdin()
const app = await render(
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
const focusedLine = (): string => lines().find(l => l.includes('❯')) ?? ''
const focusedLabelLine = (): string => {
  const index = lines().findIndex(line => line.includes('❯'))
  return index < 0 ? '' : lines()[index + 1] ?? ''
}

try {
  await settled(() => state().includes('split=1'))
  check('mount: split renders with jobs tab enabled', state().includes('split=1 focus=chat active=todo'), state())

  // --- 1. badge: running → info while the jobs panel is inactive -----------
  setJobs([J1, J2, J3])
  await settled(() => panelStore.get('jobs')?.badge?.level === 'info', { timeout: 4000 })
  check('badge: running job lights info on the jobs tab', panelStore.get('jobs')?.badge?.level === 'info',
    JSON.stringify(panelStore.get('jobs')?.badge ?? null))

  // --- 2. badge: NEW failed job (unseen) → error with unread ---------------
  setJobs([J1, J2, J3, { id: 'job-fail-4', kind: 'pwsh', label: 'LLL4', status: 'failed', startedAt: NOW - 1000, outputLines: [] }])
  await settled(() => panelStore.get('jobs')?.badge?.level === 'error', { timeout: 4000 })
  const errorBadge = panelStore.get('jobs')?.badge ?? null
  check('badge: unseen failed job flips to error unread=1', errorBadge !== null && errorBadge.level === 'error' && errorBadge.unread === 1,
    JSON.stringify(errorBadge))

  // --- 3. open the jobs tab: roster renders, failed set marked seen --------
  openJobs?.()
  await settled(() => state().includes('active=jobs') && lines().some(l => l.includes('LLL1')), { timeout: 4000 })
  const roster = lines()
  check('open: jobs roster renders in the split panel',
    roster.some(l => l.includes('LLL1')) && roster.some(l => l.includes('LLL2')) && roster.filter(line => line.includes('job-')).length === 3,
    roster.filter(line => /LLL|job-|runni|comple|step/.test(line)).join('|'))
  check('open: focus starts at the roster head', focusedLabelLine().includes('LLL1'), focusedLine().trim() + ' | ' + focusedLabelLine().trim())
  check('open: summary line counts running', roster.some(l => l.includes('2 running')), roster.find(l => l.includes('running')) ?? '')
  stdin.write('s')
  await settled(() => attachedContexts.length === 1, { timeout: 4000 })
  check('send-to-chat: title and summary use localized labels', attachedContexts[0]?.title === 'Background job job-run-1' && attachedContexts[0]?.content.includes('Background job job-run-1 (running)') && attachedContexts[0]?.content.includes('Command: gh run watch 1') && attachedContexts[0]?.content.includes('Output (last 1 lines):'), JSON.stringify(attachedContexts[0]))
  await settled(() => panelStore.get('jobs')?.badge?.level !== 'error', { timeout: 4000 })
  // PanelHost clears the badge on activation (children effects run first, so
  // the host's clear wins that frame); the adapter re-lights running>0 as
  // info on the next channel version bump while visible.
  setJobs([J1, J2, J3, { id: 'job-fail-4', kind: 'pwsh', label: 'LLL4', status: 'failed', startedAt: NOW - 1000, outputLines: [] }])
  await settled(() => panelStore.get('jobs')?.badge?.level === 'info', { timeout: 4000 })
  check('open: error badge cleared once visible (running re-lights info)', panelStore.get('jobs')?.badge?.level === 'info',
    JSON.stringify(panelStore.get('jobs')?.badge ?? null))

  // --- 4. dispatcher keys: downArrow moves the focused row -----------------
  stdin.write('\x1b[B')
  await settled(() => focusedLabelLine().includes('LLL2'), { timeout: 4000 })
  check('keys: downArrow moves focus to the second row (usePanelInput dispatch)', focusedLabelLine().includes('LLL2'), focusedLine().trim() + ' | ' + focusedLabelLine().trim())

  // --- 5. SGR click on another row focuses it ------------------------------
  const cell = findCell('LLL3')
  check('click: target row on screen', cell !== null)
  if (cell !== null) {
    stdin.write('\x1b[<0;' + (cell.col + 1) + ';' + (cell.row + 1) + 'M')
    stdin.write('\x1b[<0;' + (cell.col + 1) + ';' + (cell.row + 1) + 'm')
    await settled(() => focusedLabelLine().includes('LLL3'), { timeout: 4000 })
    check('click: SGR press on a roster row focuses that job', focusedLabelLine().includes('LLL3'), focusedLine().trim() + ' | ' + focusedLabelLine().trim())
  }

  // --- 6. Esc yields to the host: focus back to chat, panel stays ----------
  check('esc: focus is panel before Esc', exposedFocus === 'panel', exposedFocus)
  stdin.write('\x1b')
  await settled(() => exposedFocus === 'chat', { timeout: 4000 })
  check('esc: focus returns to chat (panel yields)', exposedFocus === 'chat' && exposedSplit && exposedActive === 'jobs',
    'focus=' + exposedFocus + ' split=' + String(exposedSplit) + ' active=' + exposedActive)
  check('esc: roster still rendered (sidebar not closed)', lines().some(l => l.includes('LLL1')))

  // --- 7. double-k kills the focused running job (two presses, two ticks:
  //        a same-tick double write merges into one paste event) ------------
  openJobs?.()
  await settled(() => exposedFocus === 'panel', { timeout: 4000 })
  stdin.write('k')
  await settled(() => focusedLine().includes('press k'), { timeout: 2000 }).catch(() => undefined)
  await sleep(50) // 固定窗:pacing 双击间隔——同 tick 两次写入会被合并成一条粘贴事件（见上行注释）
  stdin.write('k')
  await settled(() => kills.length === 1, { timeout: 4000 })
  check('kill: double-k kills the focused running job via jobControl', kills.join(',') === 'job-run-3', kills.join(','))

  // --- 8. focus lane: jobsFocusStore re-focuses (nonce-driven) -------------
  stdin.write('\x1b') // back to chat, then request focus on job-done-2
  await settled(() => exposedFocus === 'chat', { timeout: 4000 })
  jobsFocusStore.request('job-done-2')
  openJobs?.()
  await settled(() => focusedLabelLine().includes('LLL2'), { timeout: 4000 })
  check('focus lane: requested job focused on open', focusedLabelLine().includes('LLL2'), focusedLine().trim() + ' | ' + focusedLabelLine().trim())
  // Move away, then re-request the SAME id — the nonce must re-apply.
  stdin.write('\x1b[B')
  await settled(() => focusedLabelLine().includes('LLL1'), { timeout: 4000 })
  jobsFocusStore.request('job-done-2')
  await settled(() => focusedLabelLine().includes('LLL2'), { timeout: 4000 })
  check('focus lane: same id re-requested refocuses (nonce, not id)', focusedLabelLine().includes('LLL2'), focusedLine().trim() + ' | ' + focusedLabelLine().trim())

  setJobs([{ ...J1, command: 'cd D:/project\nWrite-Output CMD-TAIL', outputLines: Array.from({ length: 5 }, (_, index) => ({ text: 'RAW-OUT-' + index })) }])
  openJobs?.()
  check('details: command folds and output keeps a three-line preview', await settled(() => lines().some(line => line.includes('RAW-OUT-4')) && lines().some(line => line.includes('e to expand'))) && !lines().some(line => line.includes('CMD-TAIL') || line.includes('RAW-OUT-0')))
  stdin.write('e')
  check('details: e expands the focused command and output', await settled(() => lines().some(line => line.includes('CMD-TAIL')) && lines().some(line => line.includes('RAW-OUT-0'))))
  stdin.write('e')
  check('details: e folds the command and output again', await settled(() => !lines().some(line => line.includes('CMD-TAIL') || line.includes('RAW-OUT-0'))))
  const commandCell = findCell('cd D:/project')
  check('details: command click target is visible', commandCell !== null)
  if (commandCell !== null) {
    stdin.write('\x1b[<0;' + (commandCell.col + 1) + ';' + (commandCell.row + 1) + 'M')
    await sleep(30) // 固定窗:pacing 鼠标 press 和 release 分两次事件
    stdin.write('\x1b[<0;' + (commandCell.col + 1) + ';' + (commandCell.row + 1) + 'm')
    check('details: clicking command expands full output too', await settled(() => lines().some(line => line.includes('CMD-TAIL')) && lines().some(line => line.includes('RAW-OUT-0'))))
  }
} finally {
  await app.unmount()
  term.dispose()
}

if (failed > 0) {
  console.error('FAILED: ' + failed + ' check(s).')
  process.exit(1)
}
console.log('OK: jobs side panel all checks passed.')
process.exit(0)
