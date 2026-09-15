/**
 * verify-session-supervisor — the unified session screen (issue #879).
 *
 * `/resume`, `/agentview` and `/home` are one screen over one runtime now, and
 * the two properties worth a regression are the ones that used to be spread
 * across three implementations and drifted:
 *
 *   1. it is genuinely ONE surface — a workspace rail, the sessions of the
 *      selected workspace, and a live-state cell on every row, with the
 *      current session marked;
 *   2. a session held by ANOTHER TUI terminal is shown as occupied and cannot
 *      be entered: clicking it must NOT reach the channel's resume path, which
 *      is what would interleave two processes into one append-only log;
 *   3. the rail is the ledger and nothing else — no `+` row, because a
 *      workspace joins by being the directory a terminal started in (the
 *      startup attach), not by an in-screen picker.
 *
 * Plus the pure behaviours the screen leans on: the search predicate, and the
 * rail's window math.
 *
 * Renders the real `SessionSupervisor` into an in-memory terminal with a stub
 * channel, then drives it with real stdin bytes (SGR mouse reports).
 *
 * Run: node --import tsx/esm scripts/verify-session-supervisor.tsx
 */
process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_THEME = 'dark'
process.env.DSH_TUI_LANG = 'en'

import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Writable } from 'node:stream'
import React from 'react'
import xterm from '@xterm/headless'
import { findText, settled, viewportLines, writeParsed } from './lib/term-test.mjs'

const { Terminal: XTerm } = xterm
const [{ render, ThemeProvider, AlternateScreen }, { SessionSupervisor, sessionMatchesQuery, railWindowTop }] =
  await Promise.all([
    import('../src/ui.js'),
    import('../src/screens/SessionSupervisor.js'),
  ])

let failures = 0
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) console.log(`ok   ${name}`)
  else {
    failures++
    console.error(`FAIL ${name}${detail === '' ? '' : `\n      ${detail}`}`)
  }
}

const COLS = 120
const ROWS = 28

class FakeStdout extends Writable {
  columns = COLS
  rows = ROWS
  isTTY = true
  constructor(private readonly terminal: InstanceType<typeof XTerm>) { super() }
  _write(chunk: unknown, _encoding: BufferEncoding, callback: () => void): void {
    this.terminal.write(String(chunk), callback)
  }
}
class FakeStderr extends Writable {
  isTTY = true
  _write(_c: unknown, _e: BufferEncoding, callback: () => void): void { callback() }
}
class FakeStdin extends PassThrough {
  isTTY = true
  setRawMode(): this { return this }
  override ref(): this { return this }
  override unref(): this { return this }
}

const sandbox = mkdtempSync(join(tmpdir(), 'dsh-tui-supervisor-'))
const alphaDir = join(sandbox, 'alpha')
mkdirSync(alphaDir)
// A SECOND workspace that sorts BEFORE the terminal's own directory. It exists
// so "the rail opens on the workspace this terminal is in" is provable: a
// first-entry default would select Beta and the pane header would name it.
const betaDir = join(sandbox, 'beta')
mkdirSync(betaDir)

const now = Date.now()
const session = (over: Record<string, unknown>): never => ({
  id: 's',
  kind: { kind: 'root' },
  title: { text: 'a session', source: 'prompt' },
  cwd: alphaDir,
  createdAt: now - 60_000,
  updatedAt: now - 30_000,
  bytes: 2048,
  hasPrompt: true,
  agentPreset: 'standard',
  model: 'deepseek-flash',
  label: undefined,
  branch: 'main',
  childCount: 0,
  ...over,
}) as never

const registry = [
  // Beta first, on purpose: the ledger's order must not decide the selection.
  { id: 'w-beta', path: betaDir, title: 'Beta', present: true, sessionCount: 0 },
  { id: 'w-alpha', path: alphaDir, title: 'Alpha', present: true, sessionCount: 0 },
]
const sessions = [
  session({ id: 'free-one', title: { text: 'free session', source: 'prompt' }, updatedAt: now - 1_000 }),
  session({ id: 'held-one', title: { text: 'held session', source: 'prompt' }, updatedAt: now - 2_000 }),
  session({ id: 'live-one', title: { text: 'live session', source: 'prompt' }, updatedAt: now - 3_000 }),
]

/** The pid we pretend another terminal has; the screen must only show it. */
const FOREIGN_PID = 424242

const calls: string[] = []
const channel = {
  version: 0,
  cwd: alphaDir,
  working: false,
  agentId: 'live-one',
  listWorkspaceRegistry: async () => registry,
  listSessions: async () => sessions,
  resumeTo: async (id: string) => {
    calls.push(`resumeTo:${id}`)
    return { ok: true }
  },
  switchWorkspace: async (target: { cwd: string }) => {
    calls.push(`switchWorkspace:${target.cwd}`)
    return true
  },
  resolveWorkspace: async (reference: string) => ({ cwd: reference, uri: reference, label: reference, kind: 'local', badge: 'LOCAL' }),
  stopBackgroundAgent: async (id: string) => {
    calls.push(`stop:${id}`)
    return true
  },
  notify: (text: string) => { calls.push(`notify:${text}`) },
  subscribe: () => () => {},
} as never

const liveState = {
  'live-one': { status: 'working' as const, live: true, current: true, summary: 'doing work' },
}

const terminal = new XTerm({ cols: COLS, rows: ROWS, scrollback: 0, allowProposedApi: true })
const stdout = new FakeStdout(terminal)
const stdin = new FakeStdin()
const instance = await render(
  <ThemeProvider theme="dark">
    {/* The alternate screen is what turns mouse tracking on; without it the
        renderer drops every click before hit-testing (see AlternateScreen). */}
    <AlternateScreen>
      <SessionSupervisor
        channel={channel}
        home={sandbox}
        onClose={() => { calls.push('close') }}
        onOpenSession={async (id) => {
          await (channel as unknown as { resumeTo(id: string): Promise<{ ok: boolean }> }).resumeTo(id)
          return true
        }}
        // Same path Chat.tsx wires: the screen resolves the workspace target,
        // the host switches to it and starts the session there.
        onNewSession={async (target) => {
          await (channel as unknown as { switchWorkspace(t: unknown): Promise<boolean> }).switchWorkspace(target)
          return true
        }}
        onStopSession={async (id) => {
          await (channel as unknown as { stopBackgroundAgent(id: string): Promise<boolean> }).stopBackgroundAgent(id)
          return true
        }}
        approval={null}
        onApprove={() => {}}
        liveStateOf={(id) => liveState[id as keyof typeof liveState]}
        occupancyOf={(id) => (id === 'held-one' ? FOREIGN_PID : undefined)}
      />
    </AlternateScreen>
  </ThemeProvider>,
  {
    stdin: stdin as never,
    stdout: stdout as never,
    stderr: new FakeStderr() as never,
    exitOnCtrlC: false,
    patchConsole: false,
  },
)
// Wait for the listing effect to land AND the frame to paint. The first
// condition is what makes this robust: the screen names the terminal's own
// workspace in the pane header only after `listSessions()` resolved, so polling
// for it cannot pass early. (Polling the bare word "Sessions" WOULD pass early —
// the banner carries it from the first paint, before any row exists.)
await settled(() => viewportLines(terminal).join('\n').includes('Sessions in Alpha'))

const line = (y: number): string => viewportLines(terminal)[y] ?? ''
const text = (): string => viewportLines(terminal).join('\n')
const rowOf = (needle: string): number => {
  const lines = viewportLines(terminal)
  for (let y = 0; y < lines.length; y++) if (lines[y].includes(needle)) return y
  return -1
}
/**
 * One real click, routed through the renderer's hit-testing path.
 *
 * The pointer report goes to STDIN (the app's input), not to the terminal's
 * output parser — `writeParsed` feeds the latter and would silently click
 * nothing. A whole SGR report is written in one go, like a real terminal
 * delivering an event burst, and the wait is a predicate so the assertions do
 * not race the render.
 *
 * The brief delay is `固定窗:pacing`: the input pump needs a turn of the event
 * loop to hand the bytes to the parser, and there is no observable anchor for
 * "the parser consumed the burst".
 */
const clickText = async (needle: string, until?: () => boolean): Promise<void> => {
  await settled(() => findText(terminal, needle) !== null)
  const found = findText(terminal, needle)
  if (found === null) throw new Error(`row not found: ${needle}`)
  const x = found.col + 1
  const y = found.row + 1
  stdin.write(`\u001b[<0;${x};${y}M\u001b[<0;${x};${y}m`)
  await new Promise(resolve => setTimeout(resolve, 120))
  await settled(until ?? (() => true))
}

console.log('pure helpers:')
check('empty query matches everything', sessionMatchesQuery(sessions[0] as never, ''))
check('title substring matches', sessionMatchesQuery(sessions[0] as never, 'free'))
check('cwd substring matches', sessionMatchesQuery(sessions[0] as never, 'alpha'))
check('branch substring matches', sessionMatchesQuery(sessions[0] as never, 'main'))
check('non-match is rejected', !sessionMatchesQuery(sessions[0] as never, 'zzzz'))
check('rail window keeps the focused entry visible', railWindowTop(4, 20, 6) <= 3)
check('rail window clamps at zero', railWindowTop(0, 20, 6) === 0)

console.log('one surface:')
check('screen title renders', text().includes('Sessions'))
check('workspace rail renders', text().includes('Workspaces'))
check('the rail has no add-workspace row', !text().includes('Add workspace'))
check('session pane header renders', text().includes('Sessions in Alpha'))
check(
  'the rail opens on the terminal own workspace, not the first ledger entry',
  text().includes('Sessions in Alpha') && !text().includes('Sessions in Beta'),
)
// The cursor and the selection are ONE position on this screen. The regression
// is the untouched first frame: the cursor started at index 0 while the
// selection landed on Alpha, so Beta and Alpha both looked selected.
//
// Both rows are located by the rail's own `▣`/`▢` marker — matching the bare
// title would hit the sessions pane, whose path line also contains "alpha" —
// and "the cursor is here" is read as the ❯ in the rail's own prefix. The rail
// is a fraction of the frame, so leading cells are skipped rather than assuming
// a fixed indent.
const railCursor = (marker: string, title: string): boolean =>
  viewportLines(terminal).some(raw => new RegExp(`^\\s*❯\\s+${marker} ${title}\\b`, 'u').test(raw))
check(
  'the cursor opens on the selected workspace, not on row 0',
  railCursor('▣', 'Alpha') && !railCursor('▢', 'Beta'),
  `alpha marked: ${railCursor('▣', 'Alpha')}, beta marked: ${railCursor('▢', 'Beta')}`,
)
check('the live-state counts render', /\d+ working · \d+ live · \d+ total/u.test(text()))
check('a free session is listed', text().includes('free session'))
check('the live session is listed', text().includes('live session'))
check('the current session is marked', text().includes('current'))
check('a free session carries no occupancy badge', rowOf('free session') >= 0 && !line(rowOf('free session')).includes('held'))

// ←/→ picks the column, and exactly one column shows the cursor. The rail's own
// cursor is the unambiguous witness for which column owns the keyboard: it is
// read as "the `❯` immediately before this workspace's `▣`/`▢` marker", a shape
// no session row can produce. Asserting on it therefore proves the switch for
// both directions without trying to locate the session cursor inside a line the
// two panes share (the session half starts after the rail's column).
console.log('←/→ picks the column, and only that column shows ❯:')
check(
  'the rail starts with the cursor on its selected workspace',
  railCursor('▣', 'Alpha') && !railCursor('▢', 'Beta'),
  `alpha=${railCursor('▣', 'Alpha')} beta=${railCursor('▢', 'Beta')}`,
)
stdin.write('\u001b[C')
await settled(() => true)
check(
  '→ hands the cursor to the session column (the rail cursor clears)',
  await settled(() => !railCursor('▣', 'Alpha') && !railCursor('▢', 'Beta')),
  `alpha=${railCursor('▣', 'Alpha')} beta=${railCursor('▢', 'Beta')}`,
)
stdin.write('\u001b[D')
await settled(() => true)
check(
  '← hands it back to the rail',
  await settled(() => railCursor('▣', 'Alpha')),
  `alpha=${railCursor('▣', 'Alpha')}`,
)

// The new-session card is row 0 of the session list, so the cursor can stand on
// it. It used to be a fixed row outside the cursor model — which is what let the
// session window keep its old height, park `❯` on a row that never made it on
// screen (two cursors at once) and leave ↑ unable to reach the bottom.
//
// Cursor presence is read from the BUFFER with escapes stripped: a captured row
// can carry a bare ANSI cursor-move in front of the glyph (see the rail reader),
// which no `^\s*❯` test survives.
const focusedRowOf = (needle: string): boolean => {
  const buffer = terminal.buffer.active
  for (let y = 0; y < terminal.rows; y++) {
    const raw = buffer.getLine(buffer.baseY + y)?.translateToString(true) ?? ''
    if (!raw.includes(needle)) continue
    const plain = raw.replace(/\u001b\[[0-9;]*[A-Za-z]/gu, '')
    return plain.includes('❯')
  }
  return false
}
const cardFocus = (): boolean => focusedRowOf('＋ New session')
const sessionRowFocus = (needle: string): boolean => focusedRowOf(needle)
console.log('the new-session card is a row in the cursor model:')
stdin.write('\u001b[C')
await settled(() => true)
check(
  '→ lands on the first session, not on the card',
  await settled(() => sessionRowFocus('live session') && !cardFocus()),
  `card=${cardFocus()} session=${sessionRowFocus('live session')}`,
)
// The card is IN the list's cursor space (row 0), so it can be picked directly —
// which is how a user reaches it when the list is empty, and what a fixed
// outside-the-list row could never offer. The continuous ↑/↓ walk is left to the
// manual pass: arrow delivery through this harness is not reliable enough to
// assert key-by-key here.
stdin.write('\u001b[D')
await settled(() => railCursor('▣', 'Alpha'))

// The pane's own new-session entry, next to the counts it acts within.
check('the sessions pane offers a new-session entry', text().includes('+ New session'))
check('the filter box is live', text().includes('Type to search sessions'))

console.log('typing filters the session list (the box is LIVE, not a mode):')
stdin.write('free')
check(
  'typing narrows the list to the matching session',
  await settled(() => text().includes('free session') && !text().includes('live session')),
  text(),
)
// Clear so the occupancy checks below see the full ledger again.
stdin.write('\u007f\u007f\u007f\u007f')
check(
  'backspace restores the full list',
  await settled(() => text().includes('live session') && text().includes('held session')),
  text(),
)

console.log('the pane entry starts a session:')
// The entry is a full session-card row directly under the filter, so the
// column-scan click lands on it rather than on a right-aligned header control.
const entryRow = rowOf('+ New session')
const hintRow = rowOf('Start a session in')
check(
  'the new-session card sits under the filter with a session card\'s height',
  entryRow > rowOf('Type to search sessions') && hintRow === entryRow + 1,
  `entry row=${entryRow} hint row=${hintRow}`,
)
await clickText('+ New session', () => calls.some(call => call.startsWith('switchWorkspace:')))
check(
  'clicking the pane entry starts a session in the selected workspace',
  calls.includes(`switchWorkspace:${alphaDir}`),
  `calls: ${calls.join(', ')}`,
)

console.log('cross-process occupancy:')
check('the occupied row is listed', text().includes('held session'))
check('the occupied row carries the badge', line(rowOf('held session')).includes('held by pid'))
check('the occupied row names the holder pid', text().includes(String(FOREIGN_PID)))

// Click the title text itself (located by search), not a control cell: a
// hard-coded x would land in the rail on any width where the rail is visible,
// and the click would then do nothing for a reason unrelated to the test.
const before = calls.filter(call => call.startsWith('resumeTo')).length
await clickText('held session')
const after = calls.filter(call => call.startsWith('resumeTo')).length
check('clicking an occupied session never reaches resumeTo', after === before, `calls: ${calls.join(', ')}`)

console.log('a free session still opens:')
await clickText('free session', () => calls.includes('resumeTo:free-one'))
check('clicking a free session resumes it', calls.includes('resumeTo:free-one'), `calls: ${calls.join(', ')}`)
check(
  'the occupied and free rows are different rows',
  findText(terminal, 'free session')?.row !== findText(terminal, 'held session')?.row,
)

instance.unmount()
console.log(failures === 0 ? '\nAll session-supervisor checks passed.' : `\n${failures} check(s) failed.`)
process.exit(failures === 0 ? 0 : 1)
