/**
 * Headless verification of turn notifications (hooks/useTurnNotification.ts):
 * the terminal is asked for attention on the *edges* the user cares about —
 * a turn ending, an approval parking, a questionnaire opening — and the
 * working flag drives the terminal's progress indicator.
 *
 * Covers the three ways this feature can go wrong in a way no type check
 * sees: firing on mount (alerting about work the user did not start),
 * firing while the user is already watching (`unfocused` must respect DECSET
 * 1004 focus), and firing at all when the mode is `off`.
 *
 * Run against the compiled lib: `node scripts/verify-notifications.mjs`
 */
import { PassThrough, Writable } from 'node:stream'
import React from 'react'
import { render, Text } from '../lib/types/ui.js'
import { useTurnNotification } from '../lib/types/hooks/useTurnNotification.js'
import { pickNotifyChannel } from '../lib/types/notifications.js'
import { setTerminalFocused } from '../lib/types/ink/terminal-focus-state.js'

// The progress helper gates on a real TTY and rejects Windows Terminal
// (which reads OSC 9;4 as a notification). Force the ConEmu branch so the
// assertions below do not depend on how the suite was launched.
process.stdout.isTTY = true
delete process.env.WT_SESSION
delete process.env.TMUX
delete process.env.STY
process.env.ConEmuANSI = 'ON'

let failed = 0
function check(name, ok, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed += 1
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

// ── 1. Protocol selection (pure) ──────────────────────────────────────────

check('ghostty by TERM_PROGRAM', pickNotifyChannel({ TERM_PROGRAM: 'ghostty' }) === 'ghostty')
check('ghostty by resources dir', pickNotifyChannel({ GHOSTTY_RESOURCES_DIR: '/x' }) === 'ghostty')
check('kitty by TERM', pickNotifyChannel({ TERM: 'xterm-kitty' }) === 'kitty')
check('kitty by window id', pickNotifyChannel({ KITTY_WINDOW_ID: '1' }) === 'kitty')
check('iTerm2 by TERM_PROGRAM', pickNotifyChannel({ TERM_PROGRAM: 'iTerm.app' }) === 'iterm2')
check('WezTerm rides the iTerm2 payload', pickNotifyChannel({ TERM_PROGRAM: 'WezTerm' }) === 'iterm2')
check('unknown terminal falls back to BEL', pickNotifyChannel({ TERM: 'xterm-256color' }) === 'bell')
check('empty environment falls back to BEL', pickNotifyChannel({}) === 'bell')

// ── 2. Emission edges (mounted) ───────────────────────────────────────────

function makeStreams() {
  const stdout = new Writable({
    write(chunk, _enc, cb) {
      stdout.frames.push(String(chunk))
      cb()
    },
  })
  stdout.columns = 80
  stdout.rows = 24
  stdout.isTTY = true
  stdout.frames = []
  const stderr = new Writable({ write(_c, _e, cb) { cb() } })
  stderr.isTTY = true
  const stdin = new PassThrough()
  stdin.isTTY = true
  stdin.setRawMode = () => stdin
  stdin.setEncoding = () => stdin
  stdin.ref = () => stdin
  stdin.unref = () => stdin
  return { stdout, stderr, stdin }
}

function Harness({ mode, working, awaitingApproval, awaitingQuestion }) {
  useTurnNotification(mode, {
    working,
    awaitingApproval,
    awaitingQuestion,
    title: 'demo session',
  })
  return React.createElement(Text, null, 'harness')
}

/** Mount the harness and return a driver that re-renders it with new state. */
async function mount(initial) {
  const { stdout, stderr, stdin } = makeStreams()
  let state = { mode: 'always', working: false, awaitingApproval: false, awaitingQuestion: false, ...initial }
  const instance = await render(React.createElement(Harness, state), {
    stdout,
    stderr,
    stdin,
    exitOnCtrlC: false,
    patchConsole: false,
  })
  await sleep(80)
  return {
    /** stdout since the last `clear()`. */
    out: () => stdout.frames.join(''),
    clear: () => { stdout.frames.length = 0 },
    async set(next) {
      state = { ...state, ...next }
      instance.rerender(React.createElement(Harness, state))
      await sleep(120)
    },
    unmount: () => { instance.unmount() },
  }
}

/** OSC 9 notification payload (iTerm2/WezTerm), independent of terminator. */
const ITERM2_NOTIFY = '\x1b]9;\n\n'
/** OSC 9;4 progress: `3` indeterminate, `0` clear. */
const PROGRESS_BUSY = '\x1b]9;4;3;'
const PROGRESS_CLEAR = '\x1b]9;4;0;'

process.env.TERM_PROGRAM = 'iTerm.app'
setTerminalFocused(false)

// Mounting mid-turn must stay silent: the refs seed from the first render,
// so `--resume` onto a live agent does not alert about a turn the user did
// not start here.
{
  const ui = await mount({ working: true })
  check('no alert on mount into a running turn', !ui.out().includes(ITERM2_NOTIFY))
  ui.clear()
  await ui.set({ working: false })
  check('turn end alerts (iTerm2 OSC 9)', ui.out().includes(ITERM2_NOTIFY))
  ui.unmount()
}

{
  const ui = await mount({ working: false })
  ui.clear()
  await ui.set({ working: true })
  check('turn start does not alert', !ui.out().includes(ITERM2_NOTIFY))
  check('turn start raises progress', ui.out().includes(PROGRESS_BUSY))
  ui.clear()
  await ui.set({ working: false })
  check('turn end clears progress', ui.out().includes(PROGRESS_CLEAR))
  ui.unmount()
}

{
  const ui = await mount({ mode: 'off', working: true })
  ui.clear()
  await ui.set({ working: false })
  check('mode off stays silent', !ui.out().includes(ITERM2_NOTIFY))
  check('mode off reports no progress', !ui.out().includes(PROGRESS_BUSY))
  ui.unmount()
}

{
  const ui = await mount({ mode: 'unfocused', working: true })
  setTerminalFocused(true)
  await sleep(50)
  ui.clear()
  await ui.set({ working: false })
  check('unfocused mode stays silent while focused', !ui.out().includes(ITERM2_NOTIFY))
  ui.unmount()
}

{
  setTerminalFocused(false)
  const ui = await mount({ mode: 'unfocused', working: true })
  ui.clear()
  await ui.set({ working: false })
  check('unfocused mode alerts while blurred', ui.out().includes(ITERM2_NOTIFY))
  ui.unmount()
}

{
  const ui = await mount({})
  ui.clear()
  await ui.set({ awaitingApproval: true })
  check('parked approval alerts', ui.out().includes(ITERM2_NOTIFY))
  ui.clear()
  await ui.set({ awaitingApproval: false })
  check('settled approval does not alert', !ui.out().includes(ITERM2_NOTIFY))
  ui.clear()
  await ui.set({ awaitingQuestion: true })
  check('parked questionnaire alerts', ui.out().includes(ITERM2_NOTIFY))
  ui.unmount()
}

// BEL fallback: an unrecognized terminal rings instead of writing OSC 9.
{
  delete process.env.TERM_PROGRAM
  const ui = await mount({ working: true })
  ui.clear()
  await ui.set({ working: false })
  const out = ui.out()
  check('unknown terminal rings the bell', out.includes('\x07'))
  check('unknown terminal writes no OSC 9 notification', !out.includes(ITERM2_NOTIFY))
  ui.unmount()
}

console.log(failed === 0 ? '\nverify-notifications: OK' : `\nverify-notifications: ${failed} failure(s)`)
process.exit(failed === 0 ? 0 : 1)
