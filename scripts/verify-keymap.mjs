#!/usr/bin/env node
/**
 * Keymap regression (compiled lib): the shared combo grammar, the built-in
 * action registry behind /settings remapping, and the Alt+V paste alias.
 *
 * Pure checks (all platforms):
 * - parse: grammar accepts ctrl/alt combos + named keys, refuses bare
 *   letters, modifier-less shifts, unknown names, duplicate modifiers and
 *   escape combos
 * - match: defaults still bind (ctrl+v paste, ctrl+g editor…), the alt+v
 *   paste alias matches meta+v, ctrl+shift+v does NOT (native terminal
 *   paste must keep falling through), mac super alias for ctrl combos
 * - overrides: setKeymapOverrides remaps live and drops invalid entries
 *   (a cordis.yml typo must never disable a built-in)
 * - reserved: fixed editor combos stay reserved and the effective action
 *   combos (including remaps) join the set the plugin registry refuses
 * - drafts: parseComboDraft accepts multi-combo lists, rejects junk, and
 *   draftComboConflicts catches cross-action + fixed-reserved collisions
 * - hints: help menu and fold markers show the effective (remapped) combo
 *
 * Live Chat check (headless, real useInput path): pressing ESC v (Alt+V)
 * must trigger the clipboard paste branch — the 'v' must NOT be typed into
 * the prompt — and a remapped editor key (alt+g) must open the external
 * editor path rather than inserting 'g'.
 *
 * Listener order (#1155): on the FIRST mount — before any screen has
 * unmounted and remounted the composer — Ctrl+E (showAll) and Ctrl+A
 * (dashboard) must be consumed by Chat alone; the editor's readline
 * line-end / line-start bindings must not also move the caret. A fresh
 * fullscreen mount then proves Ctrl+E really toggled show-all (the row
 * hidden behind MessageList's render cap appears), which the caret probe
 * alone cannot tell apart from a press nobody handled.
 * While a turn is working, Esc still belongs to the draft editor / input
 * selection before Chat's interrupt branch, including in one stdin batch.
 *
 * Run after build: `node scripts/verify-keymap.mjs`
 */
import { Writable, PassThrough } from 'node:stream'
import React from 'react'
import xtermHeadless from '@xterm/headless'
const { Terminal: XTerm } = xtermHeadless
import { render, AlternateScreen } from '../lib/types/ui.js'
import { Chat } from '../lib/types/screens/Chat.js'
import { setLang } from '../lib/types/i18n.js'
import { HelpMenu } from '../lib/types/components/HelpMenu.js'
import { foldLongLines } from '../lib/types/utils/fold-long-lines.js'
import {
  actionMatches,
  draftComboConflicts,
  effectiveComboString,
  effectiveCombos,
  isFixedReserved,
  parseCombo,
  parseComboDraft,
  primaryComboString,
  reservedActionCombos,
  resetKeymapOverrides,
  setKeymapOverrides,
} from '../lib/types/utils/keymap.js'
import { findText, settle, settled, sleep, viewportLines } from './lib/term-test.mjs'

let failed = 0
function check(name, ok, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed += 1
}

// ---- grammar --------------------------------------------------------------
check('parse: ctrl+shift+p', parseCombo('ctrl+shift+p')?.char === 'p')
check('parse: alt+v', parseCombo('alt+v')?.char === 'v')
check('parse: named key ctrl+return', parseCombo('ctrl+return')?.named === 'return')
check('parse: ctrl+space → char " "', parseCombo('ctrl+space')?.char === ' ')
check('parse: bare letter refused', parseCombo('p') === undefined)
check('parse: shift-only refused', parseCombo('shift+p') === undefined)
check('parse: unknown key name refused', parseCombo('ctrl+wat') === undefined)
check('parse: duplicated modifier refused', parseCombo('ctrl+ctrl+p') === undefined)
check('parse: escape combos refused', parseCombo('alt+escape') === undefined)

// ---- default matching -----------------------------------------------------
resetKeymapOverrides()
check('default paste matches ctrl+v', actionMatches('paste', 'v', { ctrl: true }))
check('default paste matches alt+v (meta)', actionMatches('paste', 'v', { meta: true }))
check('ctrl+shift+v does NOT match paste (native terminal paste)', !actionMatches('paste', 'v', { ctrl: true, shift: true }))
check('default editor matches ctrl+g', actionMatches('editor', 'g', { ctrl: true }))
check('default trajectory matches ctrl+t', actionMatches('trajectory', 't', { ctrl: true }))
check('default history matches ctrl+r', actionMatches('history', 'r', { ctrl: true }))
check('default undo matches ctrl+z', actionMatches('undo', 'z', { ctrl: true }))
check('undo display string', effectiveComboString('undo') === 'ctrl+z', effectiveComboString('undo'))
// macOS primary-modifier polarity, asserted on Linux via the platformAlias
// seam: ordinary ctrl combos still alias to Cmd, `undo` (exactPrimary) must
// not — Cmd+Z belongs to whatever the rest of macOS gives it.
check('mac alias: ctrl+v paste also matches super+v', actionMatches('paste', 'v', { super: true }, true))
check('mac alias: a remapped editor combo matches super+g', actionMatches('editor', 'g', { super: true }, true))
check('mac alias: super+z does NOT match undo (exactPrimary)', !actionMatches('undo', 'z', { super: true }, true))
check('mac alias: ctrl+z still matches undo', actionMatches('undo', 'z', { ctrl: true }, true))
check('no alias on linux: super+v does NOT match paste', !actionMatches('paste', 'v', { super: true }, false))
check('default paste display string', effectiveComboString('paste') === 'ctrl+v, alt+v', effectiveComboString('paste'))

// ---- overrides ------------------------------------------------------------
// (ctrl+shift+insert is deliberately NOT valid grammar — "insert" is not a
// named key — and must be dropped so paste keeps its defaults.)
setKeymapOverrides({ paste: 'ctrl+shift+insert', editor: 'wat??', history: 'alt+r, ctrl+shift+r' })
check('invalid override entry falls back to default', actionMatches('editor', 'g', { ctrl: true }))
check('other invalid entry keeps paste default', actionMatches('paste', 'v', { ctrl: true }))
setKeymapOverrides({ paste: 'ctrl+shift+v', editor: 'wat??', history: 'alt+r, ctrl+shift+r' })
check('override moves the paste binding', actionMatches('paste', 'v', { ctrl: true, shift: true }))
check('override drops ctrl+v from paste', !actionMatches('paste', 'v', { ctrl: true }))
check('multi-combo override: alt+r', actionMatches('history', 'r', { meta: true }))
check('multi-combo override: ctrl+shift+r', actionMatches('history', 'r', { ctrl: true, shift: true }))
check('override reflected in display string', effectiveComboString('history') === 'alt+r, ctrl+shift+r', effectiveComboString('history'))

// ---- reserved sets --------------------------------------------------------
const reserved = reservedActionCombos()
check('remapped paste combo joins reserved set', reserved.has('ctrl+shift+v'))
check('remapped combo frees nothing stale', !reserved.has('ctrl+v'))
check('other actions keep their defaults reserved', reserved.has('ctrl+o') && reserved.has('ctrl+q'))
check('fixed: ctrl+u kill-line reserved', isFixedReserved('ctrl+u'))
check('fixed: ctrl+return reserved', isFixedReserved('ctrl+return'))
check('fixed: ctrl+w reserved', isFixedReserved('ctrl+w'))
check('fixed: ctrl+j newline fallback reserved', isFixedReserved('ctrl+j'))
check('free combo not reserved', !isFixedReserved('ctrl+n'))

// ---- settings drafts ------------------------------------------------------
// (Reset first: the override block above moved paste off ctrl+v, and the
// conflict checks below assume the DEFAULT bindings.)
resetKeymapOverrides()
check('draft: single combo', parseComboDraft('alt+b')?.combos.join(',') === 'alt+b')
check('draft: comma list', parseComboDraft('alt+b, ctrl+shift+b')?.combos.length === 2)
check('draft: blank restores default', parseComboDraft('  ')?.combos.length === 0)
check('draft: junk refused', parseComboDraft('press the b key') === undefined)
check('draft: escape combo refused', parseComboDraft('alt+escape') === undefined)
check('conflict: history → ctrl+v refused (owned by paste)', draftComboConflicts('history', ['ctrl+v']))
check('conflict: paste → ctrl+u refused (fixed kill-line)', draftComboConflicts('paste', ['ctrl+u']))
check('no conflict: history restating ctrl+r', !draftComboConflicts('history', ['ctrl+r']))
check('no conflict: fresh combo ctrl+n', !draftComboConflicts('history', ['ctrl+n']))
// Restating an action's OWN default (even one that is also fixed-reserved
// for the editor, like dashboard's ctrl+a / showAll's ctrl+e) changes
// nothing about what shadows what — it must not read as a conflict.
check('no conflict: dashboard restating its fixed-reserved default ctrl+a', !draftComboConflicts('dashboard', ['ctrl+a']))
check('no conflict: showAll restating its fixed-reserved default ctrl+e', !draftComboConflicts('showAll', ['ctrl+e']))
check('conflict: showAll claiming ctrl+a (dashboard owns it)', draftComboConflicts('showAll', ['ctrl+a']))
check('conflict: dashboard claiming ctrl+e (showAll owns it)', draftComboConflicts('dashboard', ['ctrl+e']))
check('conflict: another action cannot borrow the fixed ctrl+u', draftComboConflicts('dashboard', ['ctrl+u']))
resetKeymapOverrides()

// ---- hints follow remaps ----------------------------------------------------
setLang('en')
check('hint: default transcript key is ctrl+o', primaryComboString('transcript') === 'ctrl+o', primaryComboString('transcript'))
check('hint: default fold marker names ctrl+o', foldLongLines('x'.repeat(1100)).text.includes('ctrl+o'))
setKeymapOverrides({ transcript: 'alt+o, ctrl+o', history: 'alt+r' })
check('hint: primary combo is the first remapped entry', primaryComboString('transcript') === 'alt+o', primaryComboString('transcript'))
{
  const folded = foldLongLines('x'.repeat(1100)).text
  check('hint: fold marker follows the transcript remap', folded.includes('alt+o to expand'), folded.slice(-60))
}
{
  const helpTerm = new XTerm({ cols: 110, rows: 20, scrollback: 0, allowProposedApi: true })
  const helpOut = new Writable({ write(chunk, _enc, cb) { helpTerm.write(String(chunk), cb) } })
  helpOut.columns = 110
  helpOut.rows = 20
  helpOut.isTTY = true
  const helpApp = await render(React.createElement(HelpMenu, { commands: [] }), { stdout: helpOut, exitOnCtrlC: false, patchConsole: false })
  const helpScreen = () => viewportLines(helpTerm, 20).join('\n')
  check('hint: help menu shows remapped verbose-output key', await settled(() => helpScreen().includes('alt+o for verbose output')), helpScreen())
  check('hint: help menu shows remapped history key', helpScreen().includes('alt+r to search history'))
  check('hint: help menu keeps unmapped defaults', helpScreen().includes('ctrl+t to open trajectory'))
  helpApp.unmount()
}
resetKeymapOverrides()

// ---- live Chat: Alt+V triggers the paste branch ---------------------------
// The host clipboard is whatever it happens to be, so the deterministic
// proof is indirect but airtight: with meta held, the typing branch can
// never insert a character (PromptInput excludes modified keys), so ANY
// prompt change or clipboard notification after the keypress can only come
// from the paste branch consuming it. $VISUAL/$EDITOR are cleared so the
// editor check resolves via the unavailable-notify path instead of
// spawning a real editor that would hold the output pipes open.
delete process.env.VISUAL
delete process.env.EDITOR
const term = new XTerm({ cols: 110, rows: 34, scrollback: 100, allowProposedApi: true })

function makeStreams(target = term) {
  const stdout = new Writable({ write(chunk, _enc, cb) { target.write(String(chunk), cb) } })
  stdout.columns = 110
  stdout.rows = 34
  stdout.isTTY = true
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

const listeners = new Set()
const notifications = []
const rows = []
const channel = {
  version: 0,
  rows,
  status: 'idle',
  sessionTitle: 'keymap',
  agentId: 'keymap',
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
  notifications,
  contextWindow: undefined,
  reasoningEffort: 'high',
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
  notify(text, options) { notifications.push({ text: String(text), options }) },
  pushLocal() {},
  subscribe(l) { listeners.add(l); return () => listeners.delete(l) },
  emit() { channel.version += 1; for (const l of listeners) l() },
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
  activityFrames: 'moon8',
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
  subagents: [],
}

const { stdout, stderr, stdin } = makeStreams()
const instance = await render(
  React.createElement(Chat, {
    channel,
    questionStore: { subscribe: () => () => {}, getSnapshot: () => null, answerCurrent: () => {} },
    onExit() {},
  }),
  { stdout, stderr, stdin, exitOnCtrlC: false, patchConsole: false },
)
// 固定窗:pacing 启动首帧内容（含随机 tip）没有稳定的轮询锚点。
await sleep(700)
setLang('en')

const screen = () => viewportLines(term).join('\n')

const promptText = (view = screen()) => {
  // Anchored at line start: the input border rows and hint lines can carry
  // a mid-line '>', but only the prompt row carries the '❯' glyph.
  //
  // The row now begins with the ⌸ session-entry control, which sits BEFORE the
  // ❯ caret, so the anchor has to allow that leading cell or `^[❯]` never
  // matches and every draft reads as empty. The EMPTY prompt renders box-drawing
  // decoration on the same row and the row ends with the ⛶ expand-editor
  // affordance — strip those before comparing content, along with the ⌸ itself.
  const match = view.match(/^\s*⌸?\s*[❯]\s*(.*)$/m)
  const raw = match === null ? '' : (match[1] ?? '')
  return raw.replace(/[╭╮╰╯─│═║⛶⌸]+/g, '').trim()
}
const clipboardNotice = () => notifications.some(n => /clipboard|剪贴板/i.test(String(n.text)))

// Baseline: a plain 'v' types normally.
stdin.write('v')
check('plain v types', await settled(() => promptText() === 'v'), JSON.stringify(promptText()))

// Ctrl+C clears the non-empty prompt (idle single press).
stdin.write('\x03')
check('ctrl+c clears the prompt', await settled(() => promptText() === ''), JSON.stringify(promptText()))

// Listener order (#1155). Nothing has remounted the composer yet, so this
// is the first-mount order: Chat must still own Ctrl+E / Ctrl+A. The caret
// probe is a typed marker — if the readline binding also fired, the marker
// lands at the line end / line start instead of where the caret was.
stdin.write('abc')
await settle(() => promptText() === 'abc')
stdin.write('\x1b[H')
stdin.write('\x05')
stdin.write('Y')
check('first-mount ctrl+e does not move the caret', await settled(() => promptText() === 'Yabc'), JSON.stringify(promptText()))
stdin.write('\x03')
await settle(() => promptText() === '')
stdin.write('abc')
await settle(() => promptText() === 'abc')
stdin.write('\x1b[D')
stdin.write('\x01')
check('first-mount ctrl+a opens the subagent dashboard', await settled(() => /Subagent Dashboard|子代理面板/.test(screen())))
stdin.write('\x1b')
await settle(() => promptText() === 'abc')
stdin.write('X')
check('first-mount ctrl+a leaves the caret where it was', await settled(() => promptText() === 'abXc'), JSON.stringify(promptText()))
stdin.write('\x03')
await settle(() => promptText() === '')

// Alt+V arrives as ESC v. Whatever the clipboard holds, the paste branch
// must consume the key: a prompt change or a clipboard notification are
// the only possible outcomes (typing 'v' with meta held is impossible).
const beforeAltV = promptText()
notifications.length = 0
stdin.write('\x1bv')
check(
  'alt+v reaches the clipboard paste branch',
  await settled(() => promptText() !== beforeAltV || clipboardNotice()),
  JSON.stringify({ before: beforeAltV, after: promptText(), notices: notifications.map(n => n.text) }),
)
check('alt+v does not type a bare v on an empty clipboard', clipboardNotice() || promptText() !== 'v')

// Ctrl+V (0x16) goes through the same branch.
stdin.write('\x03')
await settle(() => promptText() === '')
const beforeCtrlV = promptText()
notifications.length = 0
stdin.write('\x16')
check(
  'ctrl+v reaches the clipboard paste branch',
  await settled(() => promptText() !== beforeCtrlV || clipboardNotice()),
  JSON.stringify({ before: beforeCtrlV, after: promptText(), notices: notifications.map(n => n.text) }),
)

// Remap the editor action to alt+g and verify the external-editor branch
// takes the key: with $VISUAL/$EDITOR unset the outcome is the
// unavailable notification, and no 'g' is typed either way.
stdin.write('\x03')
await settle(() => promptText() === '')
setKeymapOverrides({ editor: 'alt+g' })
notifications.length = 0
stdin.write('\x1bg')
const editorNotice = await settled(() => notifications.some(n => /editor|编辑器/i.test(String(n.text))))
check('remapped alt+g editor key does not type g', promptText() !== 'g', JSON.stringify(promptText()))
check('remapped editor key reached the editor path (notify seen)', editorNotice, JSON.stringify(notifications.map(n => n.text)))
check('default ctrl+g no longer matches after remap', !actionMatches('editor', 'g', { ctrl: true }))
resetKeymapOverrides()

instance.unmount()

// ---- fresh fullscreen mount: first-mount Ctrl+E really toggles show-all ---
// The caret probe above cannot tell "Chat consumed Ctrl+E" from "nobody
// handled it". Show-all is observable only with a transcript longer than
// MessageList's render cap (120 rows) — its oldest row stays hidden until
// the toggle — and only where the transcript is live: inline history never
// repaints rows above it, so this half runs fullscreen. A fresh mount is
// itself first-mount listener order.
const HIDDEN_ROW = 'keymap-showall-hidden-row'
rows.push({ id: 9000, kind: 'notice', text: HIDDEN_ROW })
for (let i = 1; i <= 120; i++) rows.push({ id: 9000 + i, kind: 'notice', text: `keymap filler ${i}` })
const fsTerm = new XTerm({ cols: 110, rows: 34, scrollback: 0, allowProposedApi: true })
const fs = makeStreams(fsTerm)
const fsController = { current: null }
const fsInstance = await render(
  React.createElement(AlternateScreen, null, React.createElement(Chat, {
    channel,
    questionStore: { subscribe: () => () => {}, getSnapshot: () => null, answerCurrent: () => {} },
    // The star prompt reads the real usage stats; it must not steal keys here.
    starPrompt: null,
    fullscreen: true,
    promptControllerRef: fsController,
    onExit() {},
  })),
  { stdout: fs.stdout, stderr: fs.stderr, stdin: fs.stdin, exitOnCtrlC: false, patchConsole: false },
)
const fsScreen = () => viewportLines(fsTerm).join('\n')
/** PageUp until the transcript's top is on screen (the page size is the layout's). */
const scrollToTop = async () => {
  for (let i = 0; i < 12; i++) fs.stdin.write('\x1b[5~')
  await sleep(300) // 固定窗:pacing 翻页没有逐页锚点，最终画面由下方 settled 断言
}
await settle(() => fsScreen().includes('keymap filler 120'))
await scrollToTop()
const capped = await settled(() => /previous messages|显示前/.test(fsScreen()) && !fsScreen().includes(HIDDEN_ROW))
check('fullscreen: the capped transcript shows the divider, not its oldest row', capped, capped ? '' : fsScreen())
fs.stdin.write('abc')
await settle(() => promptText(fsScreen()) === 'abc')
fs.stdin.write('\x1b[H')
fs.stdin.write('\x05')
fs.stdin.write('Y')
check('fullscreen first-mount ctrl+e does not move the caret', await settled(() => promptText(fsScreen()) === 'Yabc'), JSON.stringify(promptText(fsScreen())))
await scrollToTop()
const shownAll = await settled(() => fsScreen().includes(HIDDEN_ROW))
check('fullscreen first-mount ctrl+e toggles show-all', shownAll, shownAll ? '' : fsScreen())

// The global layer is first, but editing-layer Esc must not interrupt a
// running turn. Drive the real Chat, not the editor-only fixture.
let cancelCalls = 0
channel.cancel = () => { cancelCalls += 1 }
channel.working = true
rows.length = 0
channel.emit()
const DRAFT = 'escape draft'
const EXPAND_EDITOR = '\x1b[69;6u'
const editorOpen = () => fsScreen().includes('Draft editor')
const resetDraft = async () => {
  fsController.current.clear()
  fs.stdin.write(DRAFT)
  await settle(() => promptText(fsScreen()) === DRAFT)
  cancelCalls = 0
}
await resetDraft()
fs.stdin.write(EXPAND_EDITOR)
await settle(editorOpen)
fs.stdin.write('\x1b')
check('working Esc collapses the editor and keeps the draft', await settled(() => !editorOpen() && promptText(fsScreen()) === DRAFT))
check('editor Esc does not interrupt the turn', cancelCalls === 0, String(cancelCalls))

await resetDraft()
// ASCII-only draft/prefix: string indices match terminal columns here.
const { col, row } = findText(fsTerm, DRAFT)
fs.stdin.write(`\x1b[<0;${col + 1};${row + 1}M`)
fs.stdin.write(`\x1b[<32;${col + 4};${row + 1}M`)
fs.stdin.write(`\x1b[<0;${col + 4};${row + 1}m`)
const inputSelected = () => {
  const buffer = fsTerm.buffer.active
  return buffer.getLine(buffer.baseY + row)?.getCell(col)?.isInverse() === true
}
await settle(inputSelected)
fs.stdin.write('\x1b[27uX')
check('working Esc clears only the input selection', await settled(() => !inputSelected() && fsController.current.text() === 'escXape draft'))
check('input-selection Esc does not interrupt the turn', cancelCalls === 0, String(cancelCalls))

await resetDraft()
// CSI-u Esc is complete, so expansion, Escape, and typing share one batch.
fs.stdin.write(`${EXPAND_EDITOR}\x1b[27u!`)
check('batched editor open/Esc keeps the turn and draft', await settled(() => !editorOpen() && promptText(fsScreen()) === `${DRAFT}!` && cancelCalls === 0))

await resetDraft()
fs.stdin.write('\x1b')
check('working Esc without an editing layer still interrupts', await settled(() => cancelCalls === 1))
check('interrupting Esc keeps the unsent draft', fsController.current.text() === DRAFT)
fsInstance.unmount()
console.log(failed === 0 ? '\nall keymap checks passed' : `\n${failed} keymap check(s) failed`)
process.exit(failed === 0 ? 0 : 1)
