#!/usr/bin/env node
/**
 * Transcript paging regression (compiled lib): PgUp/PgDn page the FULLSCREEN
 * transcript a viewport at a time, and stay out of the way everywhere the
 * keyboard already belongs to someone else.
 *
 * Why this exists: the fullscreen transcript had exactly one scroll input —
 * the mouse wheel. The alt screen holds no native scrollback (MessageList's
 * historyPaint gate is main-screen only), so a keyboard-only user could never
 * reach an earlier turn, while every other fullscreen surface (session
 * browser, session tree, trajectory) already paged with these very keys.
 *
 * Scenario: 60 single-line assistant rows in a 34-row viewport, pinned to the
 * bottom (sticky).
 *  - PgUp once      → the tail row leaves the viewport and a deeper row shows:
 *                     the view actually paged, it did not just clamp.
 *  - PgUp until top → the FIRST row becomes reachable (paging repeats, so the
 *                     page size is not one giant jump to 0 / a no-op).
 *  - PgDn to bottom → the tail row returns.
 *  - inline mode    → PgUp must NOT move the TUI viewport: committed history
 *                     lives in the terminal's own scrollback there, and its
 *                     paging must not be stolen (mirrors the wheel no-op).
 *  - help open      → Chat yields these keys to PromptInput's help viewport,
 *                     so the transcript behind must not move.
 *  - question panel → does NOT yield: the panel mounts below the transcript
 *                     (replacing the prompt, never covering it) and binds no
 *                     paging keys, so the wheel-parity contract holds — the
 *                     transcript pages while a decision is pending.
 *  - narrow 70x24   → margins and the gutter shrink the transcript width,
 *                     paging behavior is unchanged.
 *
 * Run after build: `node scripts/verify-transcript-paging.mjs`
 */
import { Writable, PassThrough } from 'node:stream'
import React from 'react'
import xtermHeadless from '@xterm/headless'
const { Terminal: XTerm } = xtermHeadless
import { render, ThemeProvider, AlternateScreen } from '../lib/types/ui.js'
import { PageMargin } from '../lib/types/components/PageMargin.js'
import { Chat } from '../lib/types/screens/Chat.js'
import { setLang } from '../lib/types/i18n.js'
import { screenHas, settled, settle, sleep } from './lib/term-test.mjs'

let failed = 0
function check(name, ok, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed += 1
}

const TERM_ROWS = 34
const TERM_COLS = 110
/** Zero-padded so the marker never aliases another row's digits. */
const marker = i => `row${String(i).padStart(3, '0')}`
const FIRST = 0
const LAST = 59

function makeChannel() {
  const rows = []
  let localSeq = 0
  for (let i = FIRST; i <= LAST; i += 1) {
    rows.push({ id: i, kind: 'assistant', text: marker(i), seq: i, fresh: false })
  }
  const listeners = new Set()
  const channel = {
    version: 0,
    rows,
    status: 'idle',
    sessionTitle: 'paging',
    agentId: 'paging',
    model: 'deepseek-v4-flash',
    provider: 'deepseek',
    tokens: { input: 0, output: 0 },
    cwd: '/tmp',
    displayCwd: '/tmp',
    gitBranch: 'main',
    working: false,
    spinnerMode: 'requesting',
    responseChars: 0,
    activeToolCount: 0,
    turnStart: 0,
    lastUserText: '',
    pending: [],
    notifications: [],
    contextWindow: undefined,
    reasoningEffort: 'high',
    workingActivity: undefined,
    activityEnabled: false,
    contextBarEnabled: true,
    statusBar: {},
    agentPreset: 'standard',
    goal: undefined,
    todos: [],
    mode: { id: 'default', plan: false, sandbox: 'workspace-write', approval: 'ask' },
    modeIndex: 0,
    cycleMode() {},
    commandList: [],
    commandCompletions: () => [],
    contextSegments: { system: 0, prompt: 0, assistant: 0, thinking: 0, tools: 0 },
    notify() {},
    // Real pushLocal folds a local row into the transcript; mirroring that
    // (row + emit) lets the question-close effect's drained summary be
    // asserted end-to-end instead of mocked into a void.
    pushLocal(title, lines) {
      localSeq += 1
      rows.push({ id: 1000 + localSeq, kind: 'local', text: `${title} ${lines.join(' ')}`, seq: 1000 + localSeq, fresh: false })
      channel.emit()
    },
    subscribe(l) {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    emit() {
      channel.version += 1
      for (const l of listeners) l()
    },
    submit() {},
    steer() {},
    removePending: () => true,
    cancel() {},
    interruptAndDeliver: () => 0,
    clear() {},
    loadOlder: () => 0,
    listModels: async () => [],
    listFiles: async () => [],
    listSessions: async () => [],
    setResumeTarget() {},
    setActivityFrames: () => true,
    activityFrames: 'claude',
    runExternalCommand: async () => '',
    mcpStatus: () => [],
    exportSession: () => null,
    initWorkspace: () => null,
    doctorInfo: () => [],
    listSubagents: async () => [],
    listPresets: async () => [],
    switchPreset: async () => false,
    switchModel: async () => false,
    rewindTo: async () => null,
    resumeTo: async () => ({ ok: false, reason: 'unavailable' }),
    newSession: async () => false,
    compact() {},
  }
  return channel
}

/** A questionStore that can arm/disarm a real snapshot, so a scenario can
 *  open the AskUserQuestionPanel through Chat's actual useSyncExternalStore. */
function makeQuestionStore() {
  let snapshot = null
  let summaries = [{ title: 'QA-DRAIN-ANCHOR', lines: ['drained-ok'] }]
  const listeners = new Set()
  return {
    subscribe: l => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    getSnapshot: () => snapshot,
    answerCurrent() {},
    // Chat's panel-close effect calls this unconditionally (drains completed
    // batch summaries into the transcript). Handing back one summary turns
    // the drain into an observable: the drained row must surface in the
    // transcript after disarm. Omitting the method entirely throws a
    // TypeError mid-effect — a race the assertions can sometimes outrun,
    // which is exactly the flakiness this script must not contain.
    takeSummaries: () => {
      const drained = summaries
      summaries = []
      return drained
    },
    arm() {
      snapshot = {
        key: 'q1',
        question: { id: 'q1', question: 'PICK-ONE-ANCHOR', options: [{ label: 'A' }, { label: 'B' }] },
        position: 1,
        total: 1,
        answered: 0,
        canGoBack: false,
      }
      for (const l of listeners) l()
    },
    disarm() {
      snapshot = null
      for (const l of listeners) l()
    },
  }
}

async function mount(fullscreen, cols = TERM_COLS, rows = TERM_ROWS) {
  const term = new XTerm({ cols, rows, allowProposedApi: true })
  const stdout = new Writable({ write(chunk, _enc, cb) { term.write(String(chunk), cb) } })
  stdout.columns = cols
  stdout.rows = rows
  stdout.isTTY = true
  const stderr = new Writable({ write(_c, _e, cb) { cb() } })
  stderr.isTTY = true
  const stdin = new PassThrough()
  stdin.isTTY = true
  stdin.setRawMode = () => stdin
  stdin.setEncoding = () => stdin
  stdin.ref = () => stdin
  stdin.unref = () => stdin

  const channel = makeChannel()
  const questionStore = makeQuestionStore()
  // Mirror the real fullscreen mount (dsh-adapter/plugin.ts): ThemeProvider >
  // AlternateScreen > PageMargin > Chat. The AlternateScreen wrap is not
  // cosmetic — it constrains the transcript ScrollBox to the terminal rows;
  // an unwrapped Chat grows to its content height and getViewportHeight()
  // reports the whole buffer instead of the window. Inline mounts PageMargin
  // only, matching the host's inline path.
  const chat = React.createElement(Chat, {
    channel,
    questionStore,
    fullscreen,
    onExit() {},
  })
  const tree = React.createElement(ThemeProvider, {
    children: fullscreen
      ? React.createElement(AlternateScreen, null, React.createElement(PageMargin, null, chat))
      : React.createElement(PageMargin, null, chat),
  })
  const instance = await render(tree, { stdout, stderr, stdin, exitOnCtrlC: false, patchConsole: false })
  // Fixed wait: the first frame carries a random tip, so there is no stable
  // content anchor to poll for (same compromise as verify-keymap.mjs).
  await sleep(700)
  return { term, stdin, instance, channel, questionStore }
}

const PGUP = '\x1b[5~'
const PGDN = '\x1b[6~'

/** Press `key` up to `max` times, stopping when `pred` holds. */
async function pageUntil(term, stdin, key, pred, max = 12) {
  let presses = 0
  while (!pred() && presses < max) {
    stdin.write(key)
    presses += 1
    await settle(pred, { timeoutMs: 1500 })
  }
  return presses
}


setLang('en')

// ---- fullscreen: the transcript pages ----
const full = await mount(true)
const tailBefore = screenHas(full.term, marker(LAST))
check('fullscreen: pinned to the bottom before any key', tailBefore)
check('fullscreen: the first row is off-screen before paging', !screenHas(full.term, marker(FIRST)))

full.stdin.write(PGUP)
await sleep(400)
const pagedUp = !screenHas(full.term, marker(LAST))
check('fullscreen: PgUp moves the tail row out of the viewport', pagedUp)
// Paging must land somewhere in the middle, not teleport to the top: the row
// just above the first page boundary is expected while the topmost is not.
check('fullscreen: one PgUp is one page, not the whole buffer', !screenHas(full.term, marker(FIRST)))

const upPresses = await pageUntil(full.term, full.stdin, PGUP, () => screenHas(full.term, marker(FIRST)))
check('fullscreen: repeated PgUp reaches the first row', upPresses > 0 && screenHas(full.term, marker(FIRST)), `${upPresses} presses`)

const downPresses = await pageUntil(full.term, full.stdin, PGDN, () => screenHas(full.term, marker(LAST)))
check('fullscreen: PgDn pages back down to the tail', downPresses > 0 && screenHas(full.term, marker(LAST)), `${downPresses} presses`)

// Back home re-pins the follow (the scrollBy overshoot clamps exactly onto
// maxScroll, whose positional at-bottom restore re-pins sticky): arriving
// content must land IN the viewport, never behind a "↓ 1 new message" pill.
full.channel.rows.push({ id: 60, kind: 'assistant', text: marker(60), seq: 60, fresh: false })
full.channel.emit()
const followed = await settled(() => screenHas(full.term, marker(60)))
check('fullscreen: new content after paging home follows, no pill', followed && !screenHas(full.term, '↓ 1 new message'))

// Help is modal over the transcript and pages its own viewport, so the tail
// has to stay exactly where it is. `?` opens help on empty input; its footer
// hint ("↑/↓ scroll · PgUp/PgDn page · Home/End jump · Esc close") is the
// stable anchor that help is actually up.
full.stdin.write('?')
const helpShown = await settled(() => screenHas(full.term, 'PgUp/PgDn page'), { timeoutMs: 3000 })
check('fullscreen: ? opens the help overlay', helpShown)
if (helpShown) {
  const tail = screenHas(full.term, marker(LAST))
  full.stdin.write(PGUP)
  await sleep(400)
  check('fullscreen: help open yields PgUp to the help viewport', screenHas(full.term, marker(LAST)) === tail)
  full.stdin.write('\x1b')
  await sleep(300)
}

// The question panel must NOT take these keys away: it mounts BELOW the
// transcript (replacing the prompt, never covering it), and the wheel branch
// scrolls the still-visible transcript in exactly this state. Lock that
// wheel parity in: with a question pending, PgUp pages the transcript and
// the panel stays exactly where it is.
full.questionStore.arm()
const panelShown = await settled(() => screenHas(full.term, 'PICK-ONE-ANCHOR'), { timeoutMs: 3000 })
check('fullscreen: question panel opens through the store', panelShown)
if (panelShown) {
  const panelVisible = screenHas(full.term, 'PICK-ONE-ANCHOR')
  full.stdin.write(PGUP)
  await sleep(400)
  check('fullscreen: question panel open — PgUp still pages the transcript', !screenHas(full.term, marker(LAST)))
  check('fullscreen: question panel open — the panel is undisturbed', screenHas(full.term, 'PICK-ONE-ANCHOR') === panelVisible)
}
// Return to the tail before closing: the panel scenario left the view one
// page up, and the drained summary lands at the very bottom — only visible
// with the follow re-pinned.
const backDown = await pageUntil(full.term, full.stdin, PGDN, () => screenHas(full.term, marker(LAST)), 3)
check('fullscreen: paged home before closing the panel', backDown > 0 || screenHas(full.term, marker(LAST)))
full.questionStore.disarm()
const panelClosed = await settled(() => !screenHas(full.term, 'PICK-ONE-ANCHOR'), { timeoutMs: 3000 })
check('fullscreen: question panel closes cleanly', panelClosed)
// The close effect drains takeSummaries() through pushLocal — the summary
// must surface as a transcript row (this is the check that turns a broken
// store contract into a red line instead of a silent mid-effect TypeError).
const drained = await settled(() => screenHas(full.term, 'QA-DRAIN-ANCHOR'), { timeoutMs: 3000 })
check('fullscreen: closed panel drains its summary into the transcript', drained)
await full.instance.unmount()

// ---- inline: the terminal owns these keys ----
const inline = await mount(false)
check('inline: pinned to the bottom', screenHas(inline.term, marker(LAST)))
inline.stdin.write(PGUP)
inline.stdin.write(PGUP)
await sleep(500)
check('inline: PgUp leaves the TUI viewport alone (terminal scrollback owns it)', screenHas(inline.term, marker(LAST)))
await inline.instance.unmount()

// ---- narrow terminal: margins + gutter shrink the transcript, not paging ----
// The return leg polls instead of assuming one press: at 24 rows the
// virtualization window is re-mounting rows mid-scroll and a single PgDn can
// race the layout — the contract under test is "paging works at narrow
// width", not single-press symmetry.
const narrow = await mount(true, 70, 24)
check('narrow 70x24: pinned to the bottom', screenHas(narrow.term, marker(LAST)))
narrow.stdin.write(PGUP)
await sleep(400)
check('narrow 70x24: PgUp pages away from the tail', !screenHas(narrow.term, marker(LAST)))
const narrowDown = await pageUntil(narrow.term, narrow.stdin, PGDN, () => screenHas(narrow.term, marker(LAST)), 3)
check('narrow 70x24: PgDn returns to the tail', narrowDown > 0 && screenHas(narrow.term, marker(LAST)), `${narrowDown} presses`)
await narrow.instance.unmount()

console.log(failed === 0 ? '\nAll transcript paging checks passed.' : `\n${failed} check(s) failed.`)
process.exit(failed === 0 ? 0 : 1)
