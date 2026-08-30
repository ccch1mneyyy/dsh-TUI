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
 *
 * Live Chat check (headless, real useInput path): pressing ESC v (Alt+V)
 * must trigger the clipboard paste branch — the 'v' must NOT be typed into
 * the prompt — and a remapped editor key (alt+g) must open the external
 * editor path rather than inserting 'g'.
 *
 * Run after build: `node scripts/verify-keymap.mjs`
 */
import { Writable, PassThrough } from 'node:stream'
import React from 'react'
import xtermHeadless from '@xterm/headless'
const { Terminal: XTerm } = xtermHeadless
import { render } from '../lib/types/ui.js'
import { Chat } from '../lib/types/screens/Chat.js'
import { setLang } from '../lib/types/i18n.js'
import {
  actionMatches,
  draftComboConflicts,
  effectiveComboString,
  effectiveCombos,
  isFixedReserved,
  parseCombo,
  parseComboDraft,
  reservedActionCombos,
  resetKeymapOverrides,
  setKeymapOverrides,
} from '../lib/types/utils/keymap.js'
import { settle, settled, sleep, viewportLines } from './lib/term-test.mjs'

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

function makeStreams() {
  const stdout = new Writable({ write(chunk, _enc, cb) { term.write(String(chunk), cb) } })
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

const { stdout, stderr, stdin } = makeStreams()
const instance = await render(
  React.createElement(Chat, {
    channel,
    questionStore: { subscribe: () => () => {}, getSnapshot: () => null, answerCurrent: () => {} },
    onExit() {},
  }),
  { stdout, stderr, stdin, exitOnCtrlC: false, patchConsole: false },
)
// 启动等待保留固定 sleep：首帧内容（含随机 tip）没有稳定的轮询锚点。
await sleep(700)
setLang('en')

const screen = () => viewportLines(term).join('\n')

const promptText = () => {
  // Anchored at line start: the input border rows and hint lines can carry
  // a mid-line '>', but only the prompt row begins with the '❯' glyph. The
  // EMPTY prompt renders box-drawing decoration on the same row, and the
  // row now also ends with the ⛶ expand-editor affordance — strip both
  // before comparing content.
  const match = screen().match(/^[❯]\s*(.*)$/m)
  const raw = match === null ? '' : (match[1] ?? '')
  return raw.replace(/[╭╮╰╯─│═║⛶]+/g, '').trim()
}
const clipboardNotice = () => notifications.some(n => /clipboard|剪贴板/i.test(String(n.text)))

// Baseline: a plain 'v' types normally.
stdin.write('v')
check('plain v types', await settled(() => promptText() === 'v'), JSON.stringify(promptText()))

// Ctrl+C clears the non-empty prompt (idle single press).
stdin.write('\x03')
check('ctrl+c clears the prompt', await settled(() => promptText() === ''), JSON.stringify(promptText()))

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
console.log(failed === 0 ? '\nall keymap checks passed' : `\n${failed} keymap check(s) failed`)
process.exit(failed === 0 ? 0 : 1)
