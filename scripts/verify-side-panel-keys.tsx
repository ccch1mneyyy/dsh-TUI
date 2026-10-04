/**
 * Side-panel controller regression (Phase 1, keyboard): drives useSidePanel
 * through REAL stdin key injection (FakeStdin PassThrough + ink raw mode,
 * the repro-ctrlc pattern). A harness component forwards every parsed key
 * to sidePanel.handleKey — exactly Chat's call point — and renders the
 * controller state as a text line; when handleKey returns false the key is
 * counted as "received by chat" (the fall-through contract).
 *
 * Locked behavior:
 *  a. ctrl+b toggles visibility from either focus and returns to chat;
 *     opening leaves plain text available to the composer.
 *  b. panel-focused keys: arrows and [ ] cycle activePanelId, '2' jumps,
 *     z toggles zoom (chatColumns 81<->64), +/- resize by 4 columns each
 *     way, plain 'x' swallowed (no chat key), ctrl combos (ctrl+l) fall
 *     through to chat; global alt+z zooms from any focus.
 *  e. Esc: a real lone ESC arrives from this ink fork as
 *     {escape:true, meta:true}; the ctrl/meta fall-through guard exempts
 *     escape (meta && escape!==true), so Esc returns focus to chat, and
 *     ctrl+b afterwards closes the panel; /panel focus opens and focuses it.
 *  c. 90 cols (splitAvailable=false): ctrl+b returns false, no state move.
 *  d. editorOpen=true at 120 cols: ctrl+b likewise inert.
 * Run: node --import tsx/esm scripts/verify-side-panel-keys.tsx
 */
process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_LANG = 'en'

const [{ PassThrough, Writable }, React, { Terminal: XTerm }, ui, { useSidePanel }, prefs, termTest] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('../src/components/sidePanel/useSidePanel.js'),
  import('../src/tuiDisplayPrefs.js'),
  import('./lib/term-test.mjs'),
])
const { render, AlternateScreen, Box, Text, useInput } = ui
const { applySidePanelOpen, applySidePanelRatio } = prefs
const { settled, viewportLines } = termTest

const COLS = 84
const ROWS = 6

let failed = 0
function check(name: string, ok: boolean, extra = '') {
  console.log((ok ? 'PASS' : 'FAIL') + ': ' + name + (extra ? '  (' + extra + ')' : ''))
  if (!ok) failed += 1
}

// Mutable probes the harness reports on its state line.
let chatKeyCount = 0
let lastHandled = -1 // -1 none yet, 1 handled by panel, 0 fell through
let exposedHandleKey: ((input: string, key: Record<string, boolean | undefined>) => boolean) | undefined
let exposedFocus = ''
let exposedCommand: ((raw: string) => boolean) | undefined

function Harness({ columns, fullscreen, editorOpen }: { columns: number; fullscreen: boolean; editorOpen: boolean }): React.ReactNode {
  const sp = useSidePanel({ columns, fullscreen, editorOpen })
  const [, bump] = React.useState(0)
  exposedHandleKey = sp.handleKey
  exposedFocus = sp.focus
  exposedCommand = sp.command
  useInput((input: string, key: { escape?: boolean; leftArrow?: boolean; rightArrow?: boolean; ctrl?: boolean; meta?: boolean }) => {
    // Chat's call point (v2.1 contract): sidePanel.handleKey first; only a
    // false return lets the key reach the chat surface.
    const handled = sp.handleKey(input, key)
    lastHandled = handled ? 1 : 0
    if (!handled) chatKeyCount += 1
    bump(t => t + 1)
  })
  return (
    <Box flexDirection="column" paddingX={1}>
      <Text>{'SP split=' + (sp.split ? 1 : 0) + ' focus=' + sp.focus + ' zoom=' + (sp.zoom ? 1 : 0) + ' active=' + (sp.activePanelId ?? 'none') + ' chat=' + sp.chatColumns + ' avail=' + (sp.splitAvailable ? 1 : 0) + ' handled=' + lastHandled + ' chatKeys=' + chatKeyCount}</Text>
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

interface Session {
  stdin: FakeStdin
  state(): string
  close(): Promise<void>
}

async function openSession(columns: number, fullscreen = true, editorOpen = false, preOpen = false): Promise<Session> {
  // Live stores are module-level: reset them so every scenario starts at
  // the default ratio (focus/zoom are component state, fresh per mount;
  // open/ratio persist across mounts within this process).
  applySidePanelOpen(preOpen)
  applySidePanelRatio(0.68)
  chatKeyCount = 0
  lastHandled = -1
  const term = new XTerm({ cols: COLS, rows: ROWS, scrollback: 0, allowProposedApi: true })
  const stdout = new FakeStdout(term)
  const stdin = new FakeStdin()
  const app = await render(
    <AlternateScreen mouseTracking={false}>
      <Harness columns={columns} fullscreen={fullscreen} editorOpen={editorOpen} />
    </AlternateScreen>,
    {
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      stderr: new FakeStderr() as unknown as NodeJS.WriteStream,
      exitOnCtrlC: false,
      patchConsole: false,
    },
  )
  const session: Session = {
    stdin,
    state() { return viewportLines(term, ROWS).find(l => l.includes('SP ')) ?? '' },
    async close() { await app.unmount() },
  }
  await settled(() => session.state().includes('split='))
  return session
}

async function press(session: Session, bytes: string, expectState: string): Promise<string> {
  session.stdin.write(bytes)
  const ok = await settled(() => session.state().includes(expectState), { timeout: 4000 })
  const state = session.state()
  if (!ok) throw new Error('state never reached ' + JSON.stringify(expectState) + '; last: ' + JSON.stringify(state))
  return state
}

async function focusPanel(): Promise<void> {
  if (exposedCommand?.('focus') !== true) throw new Error('/panel focus was not handled')
  if (!await settled(() => exposedFocus === 'panel')) throw new Error('/panel focus did not take focus')
}

// --- ctrl+b toggles visibility independently of keyboard focus ------------
{
  const s = await openSession(120)
  check('initial state is closed with chat focus', s.state().includes('split=0 focus=chat zoom=0 active=todo chat=120 avail=1'), s.state())
  await press(s, '\x02', 'split=1 focus=chat zoom=0 active=todo chat=81')
  check('ctrl+b opens without taking focus from the composer', s.state().includes('handled=1') && chatKeyCount === 0, s.state())
  await press(s, 'x', 'chatKeys=1')
  check('plain typing after opening reaches chat', s.state().includes('handled=0') && chatKeyCount === 1, s.state())
  await press(s, '\x02', 'split=0 focus=chat zoom=0 active=todo chat=120')
  check('ctrl+b closes from chat focus', s.state().includes('handled=1'), s.state())
  await press(s, '\x02', 'split=1 focus=chat zoom=0 active=todo chat=81')
  await focusPanel()
  check('/panel focus takes keyboard focus without closing', s.state().includes('split=1 focus=panel'), s.state())
  await press(s, '\x02', 'split=0 focus=chat zoom=0 active=todo chat=120')
  check('ctrl+b closes from panel focus and returns to chat', s.state().includes('handled=1'), s.state())
  await s.close()
  const s2 = await openSession(120, true, false, true)
  await press(s2, '\x02', 'split=0 focus=chat zoom=0 active=todo chat=120')
  check('ctrl+b closes a pre-opened sidebar immediately', s2.state().includes('handled=1'), s2.state())
  await s2.close()
}

// --- b. panel-focused host keys -------------------------------------------
{
  const s = await openSession(120)
  await focusPanel()
  await press(s, '\x1b[D', 'active=agents')
  check('b: leftArrow cycles todo -> agents (wrap)', s.state().includes('active=agents'), s.state())
  await press(s, '\x1b[C', 'active=todo')
  check('b: rightArrow cycles back to todo', s.state().includes('active=todo'), s.state())
  await press(s, '[', 'active=agents')
  check('b: [ cycles backwards', s.state().includes('active=agents'), s.state())
  await press(s, ']', 'active=todo')
  check('b: ] cycles forwards', s.state().includes('active=todo'), s.state())
  await press(s, '2', 'active=jobs')
  check('b: 2 jumps to the second panel', s.state().includes('active=jobs'), s.state())
  // Resize (ratio store, split stays): the panel-focused '+' WIDENS THE
  // PANEL (nudge -4 → chat 81->77); '-' gives the width back to chat.
  await press(s, '+', 'chat=77')
  check('b: + widens the panel (chat shrinks by 4)', s.state().includes('chat=77'), s.state())
  await press(s, '-', 'chat=81')
  check('b: - returns the width to the chat column', s.state().includes('chat=81'), s.state())
  // Zoom: chat pinned to CHAT_MIN (64) and back.
  await press(s, 'z', 'zoom=1')
  check('b: z zooms (chat=64)', s.state().includes('zoom=1 active=jobs chat=64'), s.state())
  await press(s, 'z', 'zoom=0')
  check('b: z again restores the split (chat=81)', s.state().includes('zoom=0 active=jobs chat=81'), s.state())
  // Plain letter swallowed: handled=1 and the chat counter does not move.
  const before = chatKeyCount
  await press(s, 'x', 'handled=1 chatKeys=' + before)
  check('b: plain x swallowed by the panel (no chat key)', s.state().includes('handled=1') && chatKeyCount === before, s.state() + ' chatKeys=' + chatKeyCount)
  // Ctrl combo falls through to Chat.
  await press(s, '\x0c', 'chatKeys=' + (before + 1))
  check('b: ctrl+l falls through to chat (handled=0, counted)', s.state().includes('handled=0') && chatKeyCount === before + 1, s.state())
  // Global alt+z zoom works from panel focus too (input 'z' + meta).
  await press(s, '\x1bz', 'zoom=1')
  check('b: alt+z (global) toggles zoom from panel focus', s.state().includes('zoom=1 active=jobs chat=64'), s.state())
  await press(s, '\x1bz', 'zoom=0')
  check('b: alt+z toggles zoom back', s.state().includes('zoom=0 active=jobs chat=81'), s.state())
  await s.close()
}

// --- e. Esc returns focus to chat (real key path) --------------------------
{
  const s = await openSession(120)
  await focusPanel()
  // e.1 Programmatic: the escape branch itself handles {escape:true}.
  const handledEsc = exposedHandleKey?.('', { escape: true }) ?? null
  await settled(() => exposedFocus === 'chat')
  check('e: handleKey({escape:true}) returns to chat focus (branch works)', handledEsc === true && exposedFocus === 'chat', 'handled=' + String(handledEsc) + ' focus=' + exposedFocus)
  await focusPanel()
  // e.2 Real lone ESC arrives as {escape:true, meta:true} from this ink
  //     fork; the ctrl/meta fall-through guard exempts escape, so the key
  //     is consumed here and focus returns to chat (split stays open).
  await press(s, '\x1b', 'split=1 focus=chat zoom=0 active=todo chat=81')
  check('e: real Esc key returns focus to chat (stays open, handled)', s.state().includes('split=1 focus=chat zoom=0 active=todo chat=81 avail=1 handled=1'), s.state())
  await press(s, '\x02', 'split=0 focus=chat zoom=0 active=todo chat=120')
  check('ctrl+b after Esc closes rather than unexpectedly changing focus', s.state().includes('handled=1'), s.state())
  await focusPanel()
  check('/panel focus reopens and focuses the panel', s.state().includes('split=1 focus=panel zoom=0 active=todo chat=81'), s.state())
  await press(s, '\x02', 'split=0 focus=chat zoom=0 active=todo chat=120')
  check('ctrl+b from panel focus closes and returns to chat', s.state().includes('handled=1'), s.state())
  await s.close()
}

// --- c. 90 columns: split unavailable, ctrl+b inert -----------------------
{
  const s = await openSession(90)
  check('c: 90 cols -> splitAvailable=false', s.state().includes('split=0 focus=chat zoom=0 active=todo chat=90 avail=0'), s.state())
  await press(s, '\x02', 'handled=0')
  check('c: ctrl+b returns false (chat would process it)', s.state().includes('handled=0') && chatKeyCount === 1, s.state())
  check('c: state unchanged (still closed, chat focus, chat=90)', s.state().includes('split=0 focus=chat zoom=0 active=todo chat=90'), s.state())
  await s.close()
}

// --- d. editorOpen=true: ctrl+b inert -------------------------------------
{
  const s = await openSession(120, true, true)
  check('d: editorOpen -> splitAvailable=false at 120 cols', s.state().includes('avail=0'), s.state())
  await press(s, '\x02', 'handled=0')
  check('d: ctrl+b returns false with the editor open', s.state().includes('handled=0') && chatKeyCount === 1, s.state())
  check('d: state unchanged', s.state().includes('split=0 focus=chat zoom=0 active=todo chat=120 avail=0'), s.state())
  await s.close()
}

if (failed > 0) {
  console.error('FAILED: ' + failed + ' check(s).')
  process.exit(1)
}
console.log('OK: side-panel keys all checks passed.')
process.exit(0)
