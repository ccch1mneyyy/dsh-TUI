/**
 * M3 stage 4 pointer tests: picker / settings / session browser / session
 * tree / completion-menu click + wheel parity (research §4.3), plus the
 * ChatScreen pointer gate extension to the settings/picker slots (§1.3
 * ownership, the M3.3 modal reading extended). Stage 5 adds the prompt
 * editor click-to-caret check below (the dsh subclass inherits the pi
 * Editor handler unchanged — this file guards that wiring).
 *
 * Component-level tests drive `handlePointer` directly with synthesized
 * events (localY = the row's line index in the component's last render
 * output, localX = cell column); the gate tests reuse the ChatScreen fake
 * shape from pointer-blocking.test.ts, and one fullscreen integration test
 * pushes SGR sequences through a REAL TuiAltScreen so the settings slot's
 * forwarding travels the genuine dispatch path.
 */
import './redirect-home.js'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { VirtualTerminal } from '../../packages/pi-tui/test/virtual-terminal.ts'
import {
  getLayoutNode,
  LAYOUT_NODE,
  ScrollView,
  TuiAltScreen,
  TuiMainScreen,
  stripTerminalSequences,
  type PointerEvent,
  type PointerEventType,
  type StackLayoutNode,
  type TUI,
} from '../../src/tui/public.js'
import type { TuiCommands } from '../../src/tui/commands.js'
import {
  PickerView,
  createEffortSlider,
  createModelPicker,
} from '../../src/tui/components/pickers.js'
import { SettingsPanel } from '../../src/tui/components/settings-panel.js'
import { PromptEditor } from '../../src/tui/components/prompt-editor.js'
import { SessionBrowserScreen } from '../../src/tui/screens/session-browser.js'
import { SessionTreeScreen } from '../../src/tui/screens/session-tree.js'
import { ChatScreen } from '../../src/tui/screens/chat-screen.js'
import type { TuiController } from '../../src/tui/controller.js'
import type { ChatViewModel, SessionsProjection } from '../../src/tui/view-model.js'
import type { SettingsHost, SettingsNamespaceView } from '../../src/dsh-adapter/settingsEditor.js'
import type { TuiSettingsSection } from '../../src/dsh-adapter/settings-sections.js'
import type { SessionSummary } from '../../src/dsh-adapter/sessions/types.js'
import { buildSessionTree, type FamilySession } from '../../src/dsh-adapter/sessionTree.js'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { t } from '../../src/i18n.js'

// ── shared helpers ──────────────────────────────────────────────────────

function pointerEvent(type: PointerEventType, localY: number, overrides: Partial<PointerEvent> = {}): PointerEvent {
  return {
    type,
    x: 4,
    y: localY,
    localX: 4,
    localY,
    button: type === 'click' || type === 'press' ? 0 : -1,
    shift: false,
    alt: false,
    ctrl: false,
    deltaX: 0,
    deltaY: 0,
    cellIsBlank: false,
    ...overrides,
  }
}

/** Line index of the first rendered line containing `needle` (ANSI-stripped). */
function rowOf(lines: readonly string[], needle: string): number {
  const row = lines.findIndex(line => stripTerminalSequences(line).includes(needle))
  assert.notEqual(row, -1, `rendered lines must contain ${JSON.stringify(needle)}: ${JSON.stringify(lines)}`)
  return row
}

const DOWN = '\x1b[B'
const ENTER = '\r'
const ESC = '\x1b'
const CTRL_D = '\x04'
const CTRL_R = '\x12'

const tick = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0))

async function flush(): Promise<void> {
  for (let index = 0; index < 4; index += 1) await new Promise(resolve => setImmediate(resolve))
}

// ── picker family ───────────────────────────────────────────────────────

interface PickItem {
  id: string
}

function makePicker(onSelect: (item: PickItem) => void): PickerView<PickItem> {
  return new PickerView<PickItem>({
    title: 'Pick one',
    items: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
    toItem: item => ({ label: `row-${item.id}`, description: `desc-${item.id}` }),
    footerHint: 'enter to confirm',
    onSelect,
    onClose() {},
  })
}

test('picker: clicking a row focuses and confirms it — identical to ↑/↓ + Enter', () => {
  const clicked: string[] = []
  const keyed: string[] = []
  const byClick = makePicker(item => clicked.push(item.id))
  const byKeys = makePicker(item => keyed.push(item.id))

  const lines = byClick.render(80)
  assert.equal(byClick.handlePointer(pointerEvent('click', rowOf(lines, 'row-c'))), true)
  assert.deepEqual(clicked, ['c'])

  byKeys.handleInput(DOWN)
  byKeys.handleInput(DOWN)
  byKeys.handleInput(ENTER)
  assert.deepEqual(keyed, ['c'], 'click and keyboard resolve the same business action')
})

test('picker: chrome and blank clicks act on nothing but are consumed; wheel steps the selection', () => {
  const selected: string[] = []
  const picker = makePicker(item => selected.push(item.id))
  const lines = picker.render(80)

  // Title, divider, footer and the blank lead line never select.
  for (const y of [0, 1, rowOf(lines, 'Pick one'), rowOf(lines, 'enter to confirm')]) {
    assert.equal(picker.handlePointer(pointerEvent('click', y)), true)
  }
  assert.deepEqual(selected, [])

  // Wheel over the list moves the focus (clamped); a click then confirms the new focus.
  assert.equal(picker.handlePointer(pointerEvent('wheel', rowOf(lines, 'row-a'), { deltaY: 1 })), true)
  const after = picker.render(80)
  assert.ok(stripTerminalSequences(after[rowOf(after, 'row-b')]!).includes('→'), 'wheel moved the focus to row-b')
  picker.handlePointer(pointerEvent('click', rowOf(after, 'row-b')))
  assert.deepEqual(selected, ['b'])

  // The open picker swallows press/release too (no selection through it).
  assert.equal(picker.handlePointer(pointerEvent('press', 0)), true)
  assert.equal(picker.handlePointer(pointerEvent('release', 0)), true)
})

test('model picker: clicking a row commits provider+id like Enter', () => {
  const selected: Array<readonly [string, string]> = []
  const picker = createModelPicker({
    models: [
      { provider: 'p1', id: 'm1' },
      { provider: 'p2', id: 'm2', description: 'second model' },
    ],
    current: { provider: 'p1', model: 'm1' },
    onSelect: (provider, id) => selected.push([provider, id]),
    onClose() {},
  })
  const lines = picker.render(80)
  assert.equal(picker.handlePointer?.(pointerEvent('click', rowOf(lines, 'm2'))), true)
  assert.deepEqual(selected, [['p2', 'm2']])
})

test('effort slider: clicking a segment focuses and commits it like ←/→ + Enter', () => {
  const selected: string[] = []
  const slider = createEffortSlider({
    levels: [
      { id: 'low', name: 'low' },
      { id: 'high', name: 'high' },
    ],
    current: 'low',
    onSelect: id => selected.push(id),
    onClose() {},
  })
  const lines = slider.render(80)
  const row = rowOf(lines, 'high')
  const cell = stripTerminalSequences(lines[row]!).indexOf('high') + 1
  assert.equal(slider.handlePointer?.(pointerEvent('click', row, { localX: cell })), true)
  assert.deepEqual(selected, ['high'])
})

// ── settings panel ──────────────────────────────────────────────────────

const SETTINGS_SECTION: TuiSettingsSection = {
  ns: 'dsh-tui',
  title: 'dsh-tui',
  fields: [
    { path: ['whale'], label: 'Whale art', kind: 'boolean' },
    { path: ['lang'], label: 'Language', kind: 'select', options: [{ value: 'zh', label: '中文' }, { value: 'en', label: 'English' }] },
    { path: ['statusBar', 'compact'], label: 'Compact status bar', kind: 'boolean', group: 'status-bar' },
  ],
  groups: [{ id: 'status-bar', title: 'Status bar' }],
}

function makeSettingsPanel() {
  const writes: Array<{ ns: string; ops: readonly unknown[] }> = []
  let closed = 0
  const namespace: SettingsNamespaceView = {
    ns: 'dsh-tui',
    revision: 7,
    applies: 'live',
    value: { lang: 'zh', whale: true, statusBar: { compact: false } },
    user: {},
  }
  const host: SettingsHost = {
    listNamespaces: () => [namespace],
    write: async (ns, ops) => {
      writes.push({ ns, ops })
    },
    credentialConfigured: async () => false,
    writeCredential: async () => {},
  }
  const commands = {
    settings: {
      settingsHost: () => host,
      settingsSections: () => [SETTINGS_SECTION],
      subscribeSettingsSections: () => () => {},
    },
    info: { notify: () => () => {} },
  } as unknown as TuiCommands
  const panel = new SettingsPanel({ commands, onClose: () => { closed += 1 } })
  return { panel, writes, closed: () => closed }
}

test('settings panel: clicking a cycle row writes like Enter; wheel moves the selection', async () => {
  const { panel, writes } = makeSettingsPanel()
  const lines = panel.render(80)

  // Chrome rows (blank/divider/title) and the search row act on nothing.
  for (const y of [0, 1, 2, 3]) {
    assert.equal(panel.handlePointer(pointerEvent('click', y)), true)
  }
  await flush()
  assert.deepEqual(writes, [])

  // Click the boolean row: Enter parity — whale flips off and writes now.
  assert.equal(panel.handlePointer(pointerEvent('click', rowOf(lines, 'Whale art'))), true)
  await flush()
  assert.deepEqual(writes, [{ ns: 'dsh-tui', ops: [{ op: 'set', path: ['whale'], value: false }] }])

  // Wheel steps the selection (search keeps focus row 0 initially).
  const before = panel.render(80)
  const cursorBefore = rowOf(before, '❯')
  panel.handlePointer(pointerEvent('wheel', cursorBefore, { deltaY: 1 }))
  const after = panel.render(80)
  assert.equal(rowOf(after, '❯'), cursorBefore + 1, 'wheel moved the focus one row down')
})

test('settings panel: clicking a group row opens its submenu (Enter parity)', () => {
  const { panel } = makeSettingsPanel()
  const lines = panel.render(80)
  assert.equal(panel.handlePointer(pointerEvent('click', rowOf(lines, 'Status bar'))), true)
  const submenu = panel.render(80).map(line => stripTerminalSequences(line)).join('\n')
  assert.ok(submenu.includes('Compact status bar'), 'the nested list renders after the click')
})

// ── session browser ─────────────────────────────────────────────────────

const summary = (over: Partial<SessionSummary> & { id: string }): SessionSummary => ({
  kind: { kind: 'root' },
  title: { text: 'title', source: 'auto' },
  cwd: '/proj',
  createdAt: 1,
  updatedAt: 1,
  bytes: 10,
  hasPrompt: true,
  agentPreset: undefined,
  model: undefined,
  label: undefined,
  branch: undefined,
  childCount: 0,
  ...over,
})

function makeBrowser(sessions: readonly SessionSummary[]) {
  const resumed: string[] = []
  const deleted: string[] = []
  let closed = false
  const commands = {
    query: {
      listSessions: async () => sessions,
      previewSession: async () => [],
    },
    session: {
      resumeTo: async (id: string) => {
        resumed.push(id)
        return { ok: true as const }
      },
      deleteSession: async (id: string) => {
        deleted.push(id)
        return true
      },
      renameSessionTo: async () => true,
    },
    info: { notify: () => () => {} },
  } as unknown as TuiCommands
  const screen = new SessionBrowserScreen({
    commands,
    home: '/home/u',
    sameProject: (a, b) => a === b,
    onClose: () => { closed = true },
  })
  const vm: SessionsProjection = {
    meta: { revision: 1, sessionEpoch: 1, generation: 1 },
    sessions,
    cwd: '/proj',
    gitBranch: undefined,
    currentAgentId: 'live',
  }
  screen.update(vm)
  return {
    screen,
    resumed,
    deleted,
    closed: () => closed,
    rendered: () => screen.render(100),
    focusedLine: () =>
      stripTerminalSequences(screen.render(100).join('\n')).split('\n').find(line => line.trimStart().startsWith('❯')) ?? '',
  }
}

test('session browser: clicking a row resumes THAT session by stable id (Enter parity)', async () => {
  const browser = makeBrowser([
    summary({ id: 'live', updatedAt: 100 }),
    summary({ id: 'conv', updatedAt: 90, title: { text: 'render fix', source: 'auto' } }),
    summary({ id: 'solo', updatedAt: 70, title: { text: 'solo chat', source: 'auto' } }),
  ])
  const lines = browser.rendered()
  // Click the metadata line of the 'solo chat' row (rows are two lines tall).
  assert.equal(browser.screen.handlePointer(pointerEvent('click', rowOf(lines, 'solo chat') + 1)), true)
  await tick()
  assert.deepEqual(browser.resumed, ['solo'], 'the clicked row resumes by its own id, not by cursor position')
  assert.equal(browser.closed(), true, 'a successful resume closes the browser, like Enter')
})

test('session browser: delete stays behind its confirm seat — clicks never execute it', async () => {
  const browser = makeBrowser([
    summary({ id: 'live', updatedAt: 100 }),
    summary({ id: 'conv', updatedAt: 90, title: { text: 'render fix', source: 'auto' } }),
    summary({ id: 'solo', updatedAt: 70, title: { text: 'solo chat', source: 'auto' } }),
  ])
  browser.screen.handleInput(CTRL_D)
  const confirming = browser.rendered()
  assert.ok(stripTerminalSequences(confirming.join('\n')).includes(t('resume-delete-confirm', { name: 'render fix' })))

  // Clicks while the confirm seat is up act on nothing: no delete, no resume.
  browser.screen.handlePointer(pointerEvent('click', rowOf(confirming, 'solo chat')))
  await tick()
  assert.deepEqual(browser.deleted, [])
  assert.deepEqual(browser.resumed, [])

  // The keyboard seat still works: Enter executes the delete.
  browser.screen.handleInput(ENTER)
  await tick()
  assert.deepEqual(browser.deleted, ['conv'])
})

test('session browser: wheel steps the cursor; project headers and blanks never act', async () => {
  const browser = makeBrowser([
    summary({ id: 'live', updatedAt: 100 }),
    summary({ id: 'conv', updatedAt: 90, title: { text: 'render fix', source: 'auto' } }),
    summary({ id: 'solo', updatedAt: 70, title: { text: 'solo chat', source: 'auto' } }),
  ])
  assert.ok(browser.focusedLine().includes('render fix'))
  assert.equal(browser.screen.handlePointer(pointerEvent('wheel', 6, { deltaY: 1 })), true)
  assert.ok(browser.focusedLine().includes('solo chat'), 'wheel down moved the cursor a row')
  assert.equal(browser.screen.handlePointer(pointerEvent('wheel', 6, { deltaY: -1 })), true)
  assert.ok(browser.focusedLine().includes('render fix'))

  // Header/search/blank clicks are consumed without resuming.
  const lines = browser.rendered()
  browser.screen.handlePointer(pointerEvent('click', 0))
  browser.screen.handlePointer(pointerEvent('click', rowOf(lines, '⌕')))
  await tick()
  assert.deepEqual(browser.resumed, [])
})

// ── session tree ────────────────────────────────────────────────────────

let treeClock = 0
function treeEvent(type: string, data: unknown): SessionEvent {
  return { type, seq: -1, time: ++treeClock, data } as unknown as SessionEvent
}

function treeFixture() {
  const log: SessionEvent[] = [
    treeEvent('turn/start', { turn: 0 }),
    treeEvent('user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: 'first prompt' }] }),
    treeEvent('assistant/message', { turn: 0, step: 0, message: { role: 'assistant', content: [{ type: 'text', text: 'first reply' }] } }),
    treeEvent('step/end', { turn: 0, step: 0 }),
    treeEvent('turn/end', { turn: 0, reason: { kind: 'completed' } }),
  ]
  log.forEach((event, index) => { (event as { seq: number }).seq = index })
  const live: FamilySession = { id: 'live', createdAt: 1, events: log, live: true, tailComplete: true }
  return buildSessionTree([live], 'live')
}

test('session tree: clicking a row only OPENS the confirm seat; Enter executes', async () => {
  const rewind: Array<{ sessionId: string; seq: number }> = []
  const commands = {
    query: { getSessionTree: async () => treeFixture() },
    session: {
      rewindToNode: async (sessionId: string, seq: number) => {
        rewind.push({ sessionId, seq })
        return ''
      },
    },
    info: { notify: () => () => {} },
  } as unknown as TuiCommands
  const screen = new SessionTreeScreen({
    commands,
    mode: 'rewind',
    currentSessionId: 'live',
    onClose() {},
    onRestoreText() {},
  })
  screen.load()
  await tick()

  const lines = screen.render(100)
  assert.equal(screen.handlePointer(pointerEvent('click', rowOf(lines, 'first reply'))), true)
  const seat = stripTerminalSequences(screen.render(100).join('\n'))
  assert.ok(seat.includes(t('tree-confirm-title')), 'the click lands on the confirm seat, not on the action')
  assert.deepEqual(rewind, [], 'no rewind without the seat’s Enter')

  screen.handleInput(ENTER)
  await tick()
  assert.equal(rewind.length, 1, 'Enter on the seat executes the rewind')
  assert.equal(rewind[0]!.sessionId, 'live')
})

// ── completion menu (pi Editor autocomplete through PromptEditor) ────────

function makePromptEditor() {
  const submitted: string[] = []
  // A real TuiMainScreen over a virtual terminal: Editor.render reads
  // tui.terminal.rows for its visible-lines budget.
  const tui = new TuiMainScreen(new VirtualTerminal(80, 24))
  const commands = {
    query: {
      commandCompletions: () => [
        { name: 'model', commandLine: '/model', description: 'Model picker' },
        { name: 'theme', commandLine: '/theme', description: 'Theme picker' },
      ],
      listFileCandidates: async () => [{ path: 'src/a.ts', kind: 'file' as const }],
    },
    info: { notify: () => () => {} },
  } as unknown as TuiCommands
  const vm = { working: false, mode: { id: 'default', plan: false } } as never
  const editor = new PromptEditor(tui, commands, vm)
  editor.onSubmitPrompt = text => submitted.push(text)
  return { editor, submitted }
}

async function flushAutocomplete(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 30))
  await flush()
}

test('completion menu: clicking a slash row accepts AND submits through the dsh Enter routing', async () => {
  const { editor, submitted } = makePromptEditor()
  editor.handleInput('/')
  await flushAutocomplete()
  assert.equal(editor.isShowingAutocomplete(), true)

  const lines = editor.render(80)
  const menuRow = rowOf(lines, '/theme')
  assert.equal(editor.handlePointer(pointerEvent('click', menuRow)), true)
  assert.deepEqual(submitted, ['/theme'], 'click = accept the row + submit, exactly like Enter')
  assert.equal(editor.isShowingAutocomplete(), false)
})

test('completion menu: clicking a file row accepts without submitting; wheel moves the selection', async () => {
  const { editor, submitted } = makePromptEditor()
  editor.handleInput('@')
  await flushAutocomplete()
  assert.equal(editor.isShowingAutocomplete(), true)

  const lines = editor.render(80)
  const menuRow = rowOf(lines, 'src/a.ts')
  assert.equal(editor.handlePointer(pointerEvent('click', menuRow)), true)
  assert.deepEqual(submitted, [], 'file accepts never submit (Enter parity)')
  assert.ok(editor.getText().includes('@src/a.ts'), 'the mention was inserted')
  editor.dispose()

  // Wheel over a slash menu steps the selection.
  const second = makePromptEditor()
  second.editor.handleInput('/')
  await flushAutocomplete()
  const menuLines = second.editor.render(80)
  const menuStart = rowOf(menuLines, '/model')
  assert.ok(stripTerminalSequences(menuLines[menuStart]!).includes('→'), '/model selected first')
  assert.equal(second.editor.handlePointer(pointerEvent('wheel', menuStart, { deltaY: 1 })), true)
  const after = second.editor.render(80)
  assert.ok(stripTerminalSequences(after[rowOf(after, '/theme')]!).includes('→'), 'wheel moved the selection to /theme')
  // Wheel above the menu is not the menu's business.
  assert.equal(second.editor.handlePointer(pointerEvent('wheel', 1, { deltaY: 1 })), undefined)
  second.editor.dispose()
})

test('prompt editor: click positions the caret (grapheme-safe, multi-line), press/release stay selection-only', async () => {
  const { editor } = makePromptEditor()
  editor.setText('你好\nworld')
  editor.render(80)

  // Second logical line, cell 2 → caret on that line at col 2. The click is
  // handled but NOT consumed, so the selection fallback stays alive.
  assert.equal(editor.handlePointer(pointerEvent('click', 2, { localX: 2 })), undefined)
  assert.deepEqual(editor.getCursor(), { line: 1, col: 2 })

  // CJK: the second cell of 你 snaps after the wide char, never mid-grapheme.
  assert.equal(editor.handlePointer(pointerEvent('click', 1, { localX: 1 })), undefined)
  assert.deepEqual(editor.getCursor(), { line: 0, col: 1 })

  // press/release/move never move the caret and are never consumed, so the
  // terminal drag selection keeps working over the prompt.
  assert.equal(editor.handlePointer(pointerEvent('press', 1, { localX: 3 })), undefined)
  assert.equal(editor.handlePointer(pointerEvent('release', 1, { localX: 3 })), undefined)
  assert.deepEqual(editor.getCursor(), { line: 0, col: 1 })
  editor.dispose()
})

// ── ChatScreen gate: settings/picker slots + transient forwarding ────────

const meta = { revision: 0, sessionEpoch: 0, generation: 0 } as const

function makeViewModel(rowCount = 0): ChatViewModel {
  const mode = { id: 'default', plan: false } as never
  return {
    meta,
    transcript: {
      meta,
      rows: Array.from({ length: rowCount }, (_, index) => ({ id: index + 1, kind: 'user' as const, text: `rowmsg-${index}` })),
    },
    statusLine: {
      meta,
      minimal: false,
      statusBar: {} as never,
      lastUsage: undefined,
      reasoningEffort: undefined,
      mode,
      modeIndex: 0,
      contextWindow: undefined,
      tps: undefined,
      tpsSamples: [],
      model: 'test-model',
      tokens: { input: 0, output: 0 },
      gitBranch: 'main',
      displayCwd: '/repo',
      sessionTitle: '',
      agentId: '',
      working: false,
      workingActivity: undefined,
      activityFrames: undefined,
      contextBarEnabled: false,
      contextSegments: { system: 0, prompt: 0, assistant: 0, thinking: 0, tools: 0 },
    },
    spinner: {
      meta,
      working: false,
      spinnerMode: 'requesting',
      responseChars: 0,
      turnStart: 0,
      activeToolCount: 0,
      workingActivity: undefined,
      activityFrames: undefined,
      activityEnabled: false,
      minimal: false,
      lastUsage: undefined,
    },
    header: { meta, whale: false, model: 'test-model', reasoningEffort: undefined, displayCwd: '/repo', loadedContext: undefined },
    prompt: { meta, pending: [], notifications: [], commandList: [], reasoningEffort: undefined, effortLevels: undefined, working: false, mode },
    overlays: { meta, question: null, approval: null, dialog: null, statusEntries: [] },
    pluginScene: { meta, active: undefined },
    agentId: 'agent-1',
    cwd: '/repo',
    gitBranch: 'main',
    provider: 'test-provider',
  } as unknown as ChatViewModel
}

class FakeController {
  private listener: (() => void) | undefined
  constructor(private vm: ChatViewModel) {}

  subscribe(_slice: 'chat', listener: () => void): () => void {
    this.listener = listener
    return () => {
      if (this.listener === listener) this.listener = undefined
    }
  }

  getChat(): ChatViewModel {
    return this.vm
  }

  getSubagents(): never {
    return { meta, items: [] } as never
  }

  setViewModel(vm: ChatViewModel): void {
    this.vm = vm
    this.listener?.()
  }
}

function makeGateChat(ui: TUI, commands: TuiCommands, vm: ChatViewModel): ChatScreen {
  const controller = new FakeController(vm)
  return new ChatScreen({
    ui,
    commands,
    controller: controller as unknown as TuiController,
    onExit() {},
    fullscreen: true,
  })
}

function gateCommands(): TuiCommands {
  return {
    overlays: {
      decideApproval() {},
      answerQuestion() {},
      decideDialog() {},
      cancelQuestion() {},
      cancelDialog() {},
    },
    settings: {
      settingsHost: () => undefined,
      settingsSections: () => [],
      subscribeSettingsSections: () => () => {},
    },
    query: {
      commandCompletions: () => [],
      listFileCandidates: async () => [],
      listSessions: async () => [],
      previewSession: async () => [],
    },
    session: {
      resumeTo: async () => ({ ok: true }),
      cycleMode() {},
    },
    input: {
      submit() {},
      steer() {},
      cancel() {},
    },
    info: { notify: () => () => {} },
  } as unknown as TuiCommands
}

function fakeUi(): TUI {
  return { terminal: { columns: 80, rows: 24 }, requestRender() {} } as unknown as TUI
}

test('ChatScreen gate: settings panel and slot picker own the pointer while open', () => {
  const chat = makeGateChat(fakeUi(), gateCommands(), makeViewModel())
  try {
    assert.equal(chat.handlePointer(pointerEvent('click', 3)), undefined)
    assert.equal(chat.handlePointer(pointerEvent('wheel', 3, { deltaY: -1 })), undefined)

    chat.openSettings()
    assert.equal(chat.handlePointer(pointerEvent('click', 3)), true, 'settings panel gates clicks')
    assert.equal(chat.handlePointer(pointerEvent('press', 3)), true, 'settings panel gates selection starts')
    assert.equal(chat.handlePointer(pointerEvent('wheel', 3, { deltaY: -1 })), true, 'settings panel gates wheel')
    chat.handleInput(ESC)
    assert.equal(chat.handlePointer(pointerEvent('click', 3)), undefined, 'closing settings restores default routing')

    // Ctrl+R mounts the history picker in the editor slot (empty history still mounts).
    chat.handleInput(CTRL_R)
    assert.equal(chat.handlePointer(pointerEvent('click', 3)), true, 'slot picker gates clicks')
    assert.equal(chat.handlePointer(pointerEvent('wheel', 3, { deltaY: 1 })), true, 'slot picker gates transcript wheel')
    chat.handleInput(ESC)
    assert.equal(chat.handlePointer(pointerEvent('click', 3)), undefined, 'closing the picker restores default routing')
  } finally {
    chat.dispose()
  }
})

test('ChatScreen gate: a transient screen with a pointer handler receives events through the root', async () => {
  const commands = gateCommands()
  const resumed: string[] = []
  ;(commands.session as { resumeTo: unknown }).resumeTo = async (id: string) => {
    resumed.push(id)
    return { ok: true as const }
  }
  const chat = makeGateChat(fakeUi(), commands, makeViewModel())
  try {
    chat.openSessionBrowser({
      meta,
      sessions: [summary({ id: 'solo', updatedAt: 70, title: { text: 'solo chat', source: 'auto' } })],
      cwd: '/proj',
      gitBranch: undefined,
      currentAgentId: 'live',
    })
    const lines = chat.render(80)
    assert.equal(chat.handlePointer(pointerEvent('click', rowOf(lines, 'solo chat'))), true)
    await tick()
    assert.deepEqual(resumed, ['solo'], 'the transient browser handled the click (resume by stable id)')
  } finally {
    chat.dispose()
  }
})

// ── fullscreen integration over the real dispatch path ──────────────────

/** SGR mouse sequence for a 0-based cell. */
function sgr(button: number, x: number, y: number, release = false): string {
  return `\x1b[<${button};${x + 1};${y + 1}${release ? 'm' : 'M'}`
}

function conversationScrollOf(chat: ChatScreen): ScrollView {
  const node = chat[LAYOUT_NODE]()
  assert.ok(node !== undefined && node.type === 'vstack')
  // M4b: root = VStack(stickyHeader, conversationRow, dock); the ScrollView
  // is the conversation row HStack's first child.
  const row = (node as StackLayoutNode).entries[1]?.component
  const rowNode = row === undefined ? undefined : getLayoutNode(row)
  assert.ok(rowNode !== undefined && rowNode.type === 'hstack')
  const scroll = (rowNode as StackLayoutNode).entries[0]?.component
  assert.ok(scroll instanceof ScrollView)
  return scroll
}

test('fullscreen dispatch: settings slot row click writes, transcript wheel gated while open', async () => {
  const terminal = new VirtualTerminal(80, 24)
  const tui = new TuiAltScreen(terminal, undefined, undefined, {})
  const writes: Array<readonly unknown[]> = []
  const commands = gateCommands()
  ;(commands.settings as unknown as { settingsHost: () => SettingsHost }).settingsHost = () => ({
    listNamespaces: () => [{
      ns: 'dsh-tui',
      revision: 7,
      applies: 'live' as const,
      value: { whale: true },
      user: {},
    }],
    write: async (_ns: string, ops: readonly unknown[]) => {
      writes.push(ops)
    },
    credentialConfigured: async () => false,
    writeCredential: async () => {},
  })
  ;(commands.settings as unknown as { settingsSections: () => TuiSettingsSection[] }).settingsSections = () => [
    {
      ns: 'dsh-tui',
      title: 'dsh-tui',
      fields: [
        { path: ['whale'], label: 'Whale art', kind: 'boolean' },
        { path: ['compact'], label: 'Compact mode', kind: 'boolean' },
      ],
    },
  ]
  const chat = makeGateChat(tui, commands, makeViewModel(40))
  try {
    tui.setLayoutRoot(chat)
    tui.start()
    await terminal.waitForRender()
    const scroll = conversationScrollOf(chat)
    const maxTop = scroll.scrollTop
    assert.ok(maxTop > 0, 'the 40-row conversation must overflow the viewport')

    chat.openSettings()
    await terminal.waitForRender()

    // Opening the panel re-lays the dock out (the editor slot swaps for the
    // taller panel), which itself moves the scroll anchor — the gating
    // baseline is the position AFTER that settles.
    const gatedTop = scroll.scrollTop

    // Wheel over the transcript is gated while the settings panel is open.
    terminal.sendInput(sgr(64, 5, 2))
    await terminal.waitForRender()
    assert.equal(scroll.scrollTop, gatedTop, 'wheel must not reach the transcript while settings is open')

    // Click the 'Whale art' row in the settings slot: Enter parity (writes now).
    const viewport = terminal.getViewport()
    const whaleRow = viewport.findIndex(line => line.includes('Whale art'))
    assert.notEqual(whaleRow, -1, `settings row must be visible: ${JSON.stringify(viewport)}`)
    terminal.sendInput(sgr(0, 6, whaleRow))
    terminal.sendInput(sgr(0, 6, whaleRow, true))
    await terminal.waitForRender()
    await flush()
    assert.deepEqual(writes, [[{ op: 'set', path: ['whale'], value: false }]], 'slot row click travels the real dispatch path')

    // Wheel over the settings rows moves the panel selection instead of scrolling.
    terminal.sendInput(sgr(65, 6, whaleRow))
    await terminal.waitForRender()
    const afterWheel = terminal.getViewport()
    const compactRow = afterWheel.findIndex(line => line.includes('Compact mode'))
    assert.notEqual(compactRow, -1, `second settings row must be visible: ${JSON.stringify(afterWheel)}`)
    assert.ok(afterWheel[compactRow]!.includes('❯'), 'wheel stepped the settings selection down a row')
    assert.ok(!afterWheel[whaleRow]!.includes('❯'), 'the first row lost the focus cursor')
    assert.equal(scroll.scrollTop, gatedTop)

    // Esc closes the panel; the transcript owns the wheel again.
    chat.handleInput(ESC)
    await terminal.waitForRender()
    terminal.sendInput(sgr(64, 5, 2))
    await terminal.waitForRender()
    assert.ok(scroll.scrollTop < gatedTop, 'wheel scrolls the transcript again once the panel closes')
  } finally {
    chat.dispose()
    tui.stop()
  }
})
