/**
 * verify-workspace-home — the workspace home screen (left rail + session pane).
 *
 * Renders the real `WorkspaceHome` into an in-memory terminal with a stub
 * channel, then drives it with real stdin bytes (SGR mouse reports and raw
 * keys). What is asserted, in order:
 *
 *   1. the rail lists EVERY durable workspace (including one with no sessions
 *      and one whose directory is gone), the `+` row is present, and each
 *      badge counts exactly the sessions the pane shows for that workspace;
 *   2. the pane is scoped to the selected workspace — a session recorded in
 *      another workspace must not appear, which is the whole difference
 *      between this screen and `/resume` — and subagent runs and
 *      never-prompted sessions stay out of it;
 *   3. clicking a session row resumes that session through the channel, and
 *      clicking `+` opens the directory picker;
 *   4. clicking a rail row selects that workspace and re-scopes the pane;
 *   5. keyboard: down-arrow walks the rail and re-scopes the pane, and a
 *      no-session workspace renders its empty-state line;
 *   6. the picker browses the REAL filesystem and registers the picked
 *      directory through the channel;
 *   7. the rail's window math keeps the focused entry inside the budget.
 *
 * Run: node --import tsx/esm scripts/verify-workspace-home.tsx
 */
process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_THEME = 'dark'
process.env.DSH_TUI_LANG = 'en'

import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Writable } from 'node:stream'
import React from 'react'
import xterm from '@xterm/headless'
import { settled } from './lib/term-test.mjs'

const { Terminal: XTerm } = xterm
const [{ render, ThemeProvider, AlternateScreen }, { WorkspaceHome, railWindowTop }] = await Promise.all([
  import('../src/ui.js'),
  import('../src/screens/WorkspaceHome.js'),
])

let failures = 0
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) console.log(`ok   ${name}`)
  else {
    failures++
    console.error(`FAIL ${name}${detail === '' ? '' : `\n      ${detail}`}`)
  }
}

const COLS = 116
const ROWS = 26

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

// Real directories on disk: the picker lists the filesystem for real.
const sandbox = mkdtempSync(join(tmpdir(), 'dsh-tui-home-'))
const alphaDir = join(sandbox, 'alpha')
const betaDir = join(sandbox, 'beta')
const pickedDir = join(sandbox, 'picked-project')
mkdirSync(alphaDir)
mkdirSync(betaDir)
mkdirSync(pickedDir)
mkdirSync(join(pickedDir, 'src'))
const missingDir = join(sandbox, 'gone-away')

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
  { id: 'w-alpha', path: alphaDir, title: 'Alpha', present: true, sessionCount: 0 },
  { id: 'w-beta', path: betaDir, title: 'Beta', present: true, sessionCount: 0 },
  { id: 'w-gone', path: missingDir, title: 'Gone', present: false, sessionCount: 0 },
]
const sessions = [
  session({ id: 'alpha-new', title: { text: 'alpha newest', source: 'prompt' }, updatedAt: now - 1_000 }),
  session({ id: 'alpha-old', title: { text: 'alpha oldest', source: 'auto' }, updatedAt: now - 900_000 }),
  session({ id: 'beta-one', title: { text: 'beta only', source: 'prompt' }, cwd: betaDir, updatedAt: now - 2_000 }),
  session({ id: 'subagent-run', kind: { kind: 'subagent', parent: 'alpha-new', depth: 1 }, title: { text: 'delegated', source: 'prompt' }, updatedAt: now - 500 }),
  session({ id: 'blank', title: { text: 'never used', source: 'fallback' }, hasPrompt: false, updatedAt: now - 100 }),
]

const calls: string[] = []
const target = (path: string) => ({ uri: `file:///${path.replace(/\\/gu, '/')}`, cwd: path, label: path, kind: 'local', badge: 'LOCAL' })
const channel = {
  version: 0,
  cwd: alphaDir,
  working: false,
  listWorkspaceRegistry: async () => registry,
  listSessions: async () => sessions,
  registerWorkspace: async (path: string) => {
    calls.push(`register:${path}`)
    return { id: `w-${path}`, path, title: path.split(/[\\/]/u).at(-1) ?? path, present: true, sessionCount: 0 }
  },
  renameWorkspaceAt: async (path: string, title: string) => {
    calls.push(`rename:${path}:${title}`)
    return true
  },
  removeWorkspace: async (path: string) => {
    calls.push(`remove:${path}`)
    return true
  },
  resolveWorkspace: async (path: string) => target(path),
  resumeTo: async (id: string) => {
    calls.push(`resume:${id}`)
    return { ok: true }
  },
  switchWorkspace: async (workspace: { cwd: string }) => {
    calls.push(`switch:${workspace.cwd}`)
    return true
  },
  notify: (text: string) => { calls.push(`notify:${text}`) },
  subscribe: () => () => {},
} as never

const terminal = new XTerm({ cols: COLS, rows: ROWS, scrollback: 0, allowProposedApi: true })
const stdout = new FakeStdout(terminal)
const stdin = new FakeStdin()
const instance = await render(
  <ThemeProvider theme="dark">
    {/* The alternate screen is what turns mouse tracking on; without it the
        renderer drops every click before hit-testing (see AlternateScreen). */}
    <AlternateScreen>
      <WorkspaceHome
        channel={channel}
        home={sandbox}
        onClose={() => { calls.push('close') }}
        onOpenSession={async (id) => {
          await (channel as unknown as { resumeTo(id: string): Promise<{ ok: boolean }> }).resumeTo(id)
          return true
        }}
        onNewSession={async (workspace) =>
          (channel as unknown as { switchWorkspace(t: unknown): Promise<boolean> }).switchWorkspace(workspace)}
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

const line = (y: number): string => terminal.buffer.active.getLine(y)?.translateToString(true) ?? ''
const text = (): string => Array.from({ length: ROWS }, (_, y) => line(y)).join('\n')
/**
 * Send raw key bytes and wait for the screen to settle.
 *
 * A whole key sequence goes in one write (like a real terminal delivering a
 * burst) followed by a real delay: `settled` only waits for the renderer's own
 * flush, and the input pump needs a turn of the event loop to hand the bytes to
 * the parser.
 */
const press = async (keys: string, until?: () => boolean): Promise<void> => {
  stdin.write(keys)
  await new Promise(resolve => setTimeout(resolve, 120))
  await settled(until ?? (() => true))
}
/** One real click, routed through the renderer's hit-testing path. */
const click = async (x: number, y: number, until?: () => boolean): Promise<void> => {
  stdin.write(`\u001b[<0;${x + 1};${y + 1}M\u001b[<0;${x + 1};${y + 1}m`)
  await new Promise(resolve => setTimeout(resolve, 120))
  await settled(until ?? (() => true))
}
/** Row index whose rendered text contains `needle`, or -1. */
const rowOf = (needle: string): number => {
  for (let y = 0; y < ROWS; y++) if (line(y).includes(needle)) return y
  return -1
}

await settled(() => text().includes('Alpha'))
const first = text()

check('rail lists every durable workspace, empty ones included',
  first.includes('Alpha') && first.includes('Beta') && first.includes('Gone'), first)
check('rail marks a workspace whose directory is gone',
  first.includes('directory missing'), first)
check('rail shows the add-workspace row',
  first.includes('Add workspace'), first)
check('rail counts match the pane (alpha 2, beta 1)',
  /Alpha\s+✓ 2 sessions/u.test(first) && /Beta\s+1 session/u.test(first), first)
check('pane is scoped to the selected workspace only',
  first.includes('alpha newest') && first.includes('alpha oldest') && !first.includes('beta only'), first)
check('pane hides subagent runs and never-prompted sessions',
  !first.includes('delegated') && !first.includes('never used'), first)

// ── Pane clicks: a session row and the + row ────────────────────────────────
// Mouse coordinates have to be inside the target's own rect: the rail sits in
// the left column and the pane in the right one, so a click is aimed at the
// column where the row's text actually rendered.
const colIn = (y: number, needle: string): number => Math.max(0, line(y).indexOf(needle)) + 1
calls.length = 0
await click(colIn(rowOf('alpha newest'), 'alpha newest'), rowOf('alpha newest'),
  () => calls.some(call => call.startsWith('resume:')))
check('clicking a session row resumes that session through the channel',
  calls.includes('resume:alpha-new'), calls.join(' | '))

calls.length = 0
const plusRow = rowOf('Add workspace')
await click(colIn(plusRow, 'Add workspace'), plusRow,
  () => text().includes('Add this directory'))
check('clicking + opens the directory picker on the selected workspace',
  text().includes('Add this directory') && text().includes('(no subdirectories)'))

// The picker starts in the selected workspace (an empty directory here), so
// walk UP to the sandbox first — that proves the parent row works — then into
// `picked-project`, which the REAL filesystem listing produced.
const parentRow = rowOf('Parent directory')
await click(colIn(parentRow, 'Parent directory'), parentRow, () => rowOf('picked-project') >= 0)
check('the parent row walks up to the real parent directory',
  rowOf('picked-project') >= 0 && rowOf('beta') >= 0, text())

const pickedRow = rowOf('picked-project')
await click(colIn(pickedRow, 'picked-project'), pickedRow, () => text().includes('src'))
check('picker walks into the clicked directory (its subdirectory is listed)',
  text().includes('src'), text())

calls.length = 0
await press('\t', () => calls.some(call => call.startsWith('register:')))
check('Tab registers the browsed directory through the channel',
  calls.includes(`register:${pickedDir}`), calls.join(' | '))
check('a successful registration closes the picker',
  !text().includes('Add this directory'), text())

// ── Rail clicks and keyboard ────────────────────────────────────────────────
// The rail starts focused on the `+` row; click "Beta" directly.
const betaRow = rowOf('Beta ')
await click(colIn(betaRow, 'Beta '), betaRow, () => text().includes('beta only'))
check('clicking a rail row selects that workspace and re-scopes the pane',
  text().includes('beta only') && !text().includes('alpha newest'), text())

// Keyboard: down-arrow walks the rail cursor onto "Gone" (no sessions).
await press('\u001b[B', () => rowOf('No sessions in this workspace yet') >= 0)
check('a workspace with no sessions renders its empty-state line',
  rowOf('No sessions in this workspace yet') >= 0, text())
check('down-arrow re-scopes the pane with the rail cursor',
  !text().includes('beta only'), text())

// Keyboard: two ups return to the `+` row (Gone → Beta → Alpha), a third
// reaches the `+` row itself.
await press('\u001b[A', () => text().includes('beta only'))
await press('\u001b[A', () => text().includes('alpha newest'))
check('up-arrow walks the rail cursor back over the entries',
  text().includes('alpha newest'), text())
await press('\u001b[A')
await press('\r', () => text().includes('Add this directory'))
check('Enter on the + row opens the picker from the keyboard',
  text().includes('Add this directory'), text())
await press('\u001b', () => !text().includes('Add this directory'))
check('Esc closes the picker without registering anything',
  !text().includes('Add this directory'), text())

check('rail window keeps the focused entry inside the budget',
  railWindowTop(0, 40, 10) === 0
    && railWindowTop(5, 40, 10) === 0
    && railWindowTop(20, 40, 10) === 11
    && railWindowTop(39, 40, 10) === 30,
  `${railWindowTop(0, 40, 10)} ${railWindowTop(5, 40, 10)} ${railWindowTop(20, 40, 10)} ${railWindowTop(39, 40, 10)}`)

await instance.unmount()
rmSync(sandbox, { recursive: true, force: true })

if (failures > 0) {
  console.error(`verify-workspace-home: ${failures} failing check(s)`)
  process.exit(1)
}
console.log('verify-workspace-home: all checks passed')
process.exit(0)
