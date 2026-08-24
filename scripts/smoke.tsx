import assert from 'node:assert/strict'

import type {
  ChatRow,
  NotificationItem,
} from '../src/dsh-adapter/channel.js'
import { ApprovalStore } from '../src/dsh-adapter/approvals.js'
import { QuestionStore } from '../src/dsh-adapter/questions.js'
import { createTuiCommands, type TuiFences } from '../src/tui/commands.js'
import { TuiController } from '../src/tui/controller.js'
import { TuiLifecycle } from '../src/tui/lifecycle.js'
import { ChatScreen } from '../src/tui/screens/chat-screen.js'
import {
  stripTerminalSequences,
  TuiMainScreen,
  type Component,
  type Terminal,
} from '../src/tui/public.js'
import type { StatusBarConfig } from '../src/tuiDisplayPrefs.js'

/** A public Terminal fake: no process stdio, but every lifecycle edge is visible. */
class RecordingTerminal implements Terminal {
  readonly columns = 72
  readonly rows = 20
  readonly writes: string[] = []
  readonly events: string[]
  startCount = 0
  stopCount = 0
  private inputHandler: ((data: string) => void) | undefined
  private resizeHandler: (() => void) | undefined

  constructor(events: string[]) {
    this.events = events
  }

  start(onInput: (data: string) => void, onResize: () => void): void {
    this.startCount += 1
    this.events.push('terminal.start')
    this.inputHandler = onInput
    this.resizeHandler = onResize
  }

  stop(): void {
    this.stopCount += 1
    this.events.push('terminal.stop')
    this.inputHandler = undefined
    this.resizeHandler = undefined
  }

  drainInput(): Promise<void> {
    this.events.push('terminal.drainInput')
    return Promise.resolve()
  }

  write(data: string): void {
    this.events.push('terminal.write')
    this.writes.push(data)
  }

  get kittyProtocolActive(): boolean {
    return false
  }

  moveBy(_lines: number): void {}
  hideCursor(): void {}
  showCursor(): void {}
  clearLine(): void {}
  clearFromCursor(): void {}
  clearScreen(): void {}
  setTitle(_title: string): void {}
  setProgress(_active: boolean): void {}

  sendInput(data: string): void {
    this.inputHandler?.(data)
  }
}

/** Records the actual component output while preserving ChatScreen behavior. */
class RecordingRoot implements Component {
  readonly frames: string[][] = []

  constructor(
    private readonly screen: ChatScreen,
    private readonly events: string[],
  ) {}

  render(width: number): string[] {
    this.events.push('root.render')
    const lines = this.screen.render(width)
    this.frames.push([...lines])
    return lines
  }

  handleInput(data: string): void {
    this.screen.handleInput(data)
  }

  invalidate(): void {
    this.screen.invalidate()
  }
}

/**
 * Only the projection fields consumed by TuiController are real. The command
 * methods below are harmless sink endpoints for ChatScreen's typed facade.
 */
class SmokeChannel {
  version = 0
  sessionEpoch = 0
  rows: readonly ChatRow[] = [{ id: 1, kind: 'user', text: 'initial smoke text' }]
  agentId = 'smoke-agent'
  cwd = '/smoke/project'
  gitBranch = 'main'
  provider = 'smoke-provider'
  model = 'smoke-model'
  tokens = { input: 3, output: 2 }
  displayCwd = '/smoke/project'
  sessionTitle = 'smoke'
  working = false
  spinnerMode = 'requesting' as const
  responseChars = 0
  activeToolCount = 0
  turnStart = 0
  notifications: readonly NotificationItem[] = []
  contextWindow = undefined
  reasoningEffort = undefined
  effortLevels = undefined
  lastUsage = undefined
  tps = undefined
  tpsSamples: readonly { tps: number; at: number }[] = []
  workingActivity = undefined
  activityFrames = undefined
  statusBar: Readonly<StatusBarConfig> = {
    compact: true,
    model: true,
    thinking: true,
    cwd: true,
    contextUsage: true,
    cache: true,
    tokens: false,
    tps: false,
    gitBranch: false,
    sessionTitle: false,
    sessionId: false,
    mode: false,
    contextBar: false,
    activity: false,
    trajectory: false,
    shortcutHint: false,
  }
  whale = false
  minimal = true
  activityEnabled = false
  contextBarEnabled = false
  loadedContext = undefined
  pending = []
  commandList = []
  mode = { id: 'default', plan: false } as const
  modeIndex = 0
  pluginScene = undefined
  contextSegments = { system: 0, prompt: 0, assistant: 0, thinking: 0, tools: 0 }
  subagents = []
  subagentControl = { interrupt: (_id: string) => false }
  goal = undefined
  todos = []
  readonly submissions: string[] = []
  private readonly listeners = new Set<() => void>()
  private readonly settingsListeners = new Set<() => void>()
  private notificationId = 0

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  subscribeSettingsSections(listener: () => void): () => void {
    this.settingsListeners.add(listener)
    return () => this.settingsListeners.delete(listener)
  }

  settingsSections(): readonly never[] {
    return []
  }

  listSessions(): Promise<readonly never[]> {
    return Promise.resolve([])
  }

  traceEvents(): readonly never[] {
    return []
  }

  replaceRows(rows: readonly ChatRow[]): void {
    this.rows = rows
    this.version += 1
    for (const listener of this.listeners) listener()
  }

  submit(text: string): void {
    this.submissions.push(text)
  }

  steer(_text: string): void {}
  cancel(): void {}
  interruptAndDeliver(_texts: readonly string[]): number { return 0 }
  removePending(_id: string): boolean { return false }
  runExternalCommand(_name: string, _rawInput: string): Promise<string | undefined> {
    return Promise.resolve(undefined)
  }

  newSession(): Promise<boolean> { return Promise.resolve(false) }
  resumeTo(_id: string): Promise<{ ok: false; reason: 'unavailable' }> {
    return Promise.resolve({ ok: false, reason: 'unavailable' })
  }
  deleteSession(_id: string): Promise<boolean> { return Promise.resolve(false) }
  renameSession(_title: string): void {}
  renameSessionTo(_id: string, _title: string): Promise<boolean> { return Promise.resolve(false) }
  compact(): void {}
  clear(): void {}
  promptRewind(_row: ChatRow): Promise<null> { return Promise.resolve(null) }
  rewindTo(_row: ChatRow, _mode?: string | null): Promise<null> { return Promise.resolve(null) }

  switchModel(_provider: string, _model: string): Promise<boolean> { return Promise.resolve(false) }
  listModels(): Promise<readonly never[]> { return Promise.resolve([]) }
  switchPreset(_id: string): Promise<boolean> { return Promise.resolve(false) }
  listPresets(): Promise<readonly never[]> { return Promise.resolve([]) }
  setEffort(_id: string): Promise<boolean> { return Promise.resolve(false) }
  listEfforts(): Promise<{ efforts: readonly never[]; defaultEffort: undefined }> {
    return Promise.resolve({ efforts: [], defaultEffort: undefined })
  }
  setActivityFrames(_name: string | undefined): boolean { return false }

  previewSession(_id: string): Promise<readonly never[]> { return Promise.resolve([]) }
  listSkills(): Promise<readonly never[]> { return Promise.resolve([]) }
  listFiles(): Promise<readonly string[]> { return Promise.resolve([]) }
  commandCompletions(_value: string): readonly never[] { return [] }
  stageImage(_input: unknown): Promise<string> { return Promise.resolve('') }
  listSubagents(): Promise<readonly string[]> { return Promise.resolve([]) }

  settingsHost(): undefined { return undefined }
  notify(text: string, _options?: unknown): () => void {
    const item: NotificationItem = { id: ++this.notificationId, text, timeoutMs: 0 }
    this.notifications = [...this.notifications, item]
    return () => {}
  }
  pushLocal(_title: string, _lines: readonly string[]): void {}
  exportSession(): null { return null }
  initWorkspace(): null { return null }
  doctorInfo(): string[] { return [] }
  mcpStatus(): string[] { return [] }
  pluginsInfo(_rawInput: string): string[] { return [] }
  describeCredential(_name: string): Promise<undefined> { return Promise.resolve(undefined) }
  providerSetup(): undefined { return undefined }
  sideQuestion(_question: string): Promise<{ answer: null }> {
    return Promise.resolve({ answer: null })
  }

  openPluginScene(_id: string): boolean { return false }
  closePluginScene(): void {}
  listWorkspaces(): Promise<readonly never[]> { return Promise.resolve([]) }
  resolveWorkspace(_uri: string): Promise<undefined> { return Promise.resolve(undefined) }
  switchWorkspace(_target: unknown): Promise<boolean> { return Promise.resolve(false) }
  renameWorkspace(_title: string): Promise<boolean> { return Promise.resolve(false) }
  workspaceCommands(): readonly never[] { return [] }
  runWorkspaceCommand(_name: string, _input: string): Promise<undefined> { return Promise.resolve(undefined) }
}

function plainText(lines: readonly string[]): string {
  return stripTerminalSequences(lines.join('\n')).replaceAll('\x1b_pi:c\x07', '')
}

function lastFrame(root: RecordingRoot): string {
  const frame = root.frames[root.frames.length - 1]
  assert.ok(frame !== undefined, 'smoke: expected at least one root render')
  return plainText(frame)
}

const events: string[] = []
const terminal = new RecordingTerminal(events)
const ui = new TuiMainScreen(terminal)
const lifecycle = new TuiLifecycle({ ui })
const channel = new SmokeChannel()
const questions = new QuestionStore()
const approvals = new ApprovalStore()
const fences: TuiFences = {
  sessionEpoch: () => channel.sessionEpoch,
  generation: () => lifecycle.generation,
}
const controller = new TuiController({
  channel: channel as never,
  questions,
  approvals,
  dialogs: undefined,
  status: undefined,
  fences,
})
const commands = createTuiCommands({
  channel: channel as never,
  fences,
  stores: { questions, approvals },
})
const chat = new ChatScreen({
  ui,
  commands,
  controller,
  onExit: () => {},
})
const root = new RecordingRoot(chat, events)
ui.addChild(root)
ui.setFocus(root)

let approvalPromise: Promise<unknown> | undefined
try {
  ui.start()
  ui.renderNow(true)

  const startIndex = events.indexOf('terminal.start')
  const firstRenderIndex = events.indexOf('root.render')
  const firstWriteAfterRender = events.findIndex(
    (event, index) => index > firstRenderIndex && event === 'terminal.write',
  )
  assert.equal(terminal.startCount, 1, 'smoke: root started more than once')
  assert.ok(startIndex >= 0, 'smoke: fake terminal did not start')
  assert.ok(firstRenderIndex > startIndex, 'smoke: render happened before terminal start')
  assert.ok(firstWriteAfterRender > firstRenderIndex, 'smoke: root render did not reach terminal')
  assert.ok(lastFrame(root).includes('initial smoke text'), 'smoke: first render missed initial text')

  terminal.sendInput('typed smoke command')
  terminal.sendInput('\r')
  assert.deepEqual(channel.submissions, ['typed smoke command'], 'smoke: typed Enter did not submit once')

  channel.replaceRows([{ id: 2, kind: 'assistant', text: 'updated bounded projection' }])
  ui.renderNow(true)
  assert.ok(lastFrame(root).includes('updated bounded projection'), 'smoke: projection update missed render')

  approvalPromise = approvals.park({
    agent: {
      session: {
        events: [{
          type: 'tool/call',
          seq: 1,
          time: 0,
          data: {
            turn: 0,
            step: 0,
            callId: 'smoke-call',
            name: 'Bash',
            arguments: JSON.stringify({ command: 'echo smoke approval' }),
          },
        }],
      },
    },
    toolName: 'Bash',
    callId: 'smoke-call',
    reason: 'smoke overlay approval',
  } as never)
  ui.renderNow(true)
  const approvalFrame = lastFrame(root)
  assert.ok(approvalFrame.includes('Bash'), 'smoke: approval overlay did not open')
  assert.ok(approvalFrame.includes('echo smoke approval'), 'smoke: approval command did not render')
  terminal.sendInput('1')
  assert.equal(await approvalPromise, 'allowed-once', 'smoke: approval input did not confirm')
  ui.renderNow(true)
  assert.equal(approvals.getSnapshot(), null, 'smoke: approval overlay did not close')
  assert.ok(!lastFrame(root).includes('echo smoke approval'), 'smoke: closed overlay remained rendered')

  const stopResult = await lifecycle.finalStop('shutdown')
  assert.equal(stopResult.reason, 'shutdown')
  assert.strictEqual(await lifecycle.awaitStop(), stopResult)
  assert.equal(lifecycle.state, 'stopped', 'smoke: lifecycle did not reach stopped')
} finally {
  approvals.settleAll('cancelled')
  questions.rejectAll()
  if (!lifecycle.finalStopEstablished) {
    await lifecycle.finalStop('shutdown')
  } else {
    await lifecycle.awaitStop()
  }
  chat.dispose()
  controller.dispose()
}

const stopIndex = events.lastIndexOf('terminal.stop')
const drainIndex = events.lastIndexOf('terminal.drainInput')
assert.ok(drainIndex >= 0 && drainIndex < stopIndex, 'smoke: final stop did not drain before stopping')
assert.equal(terminal.stopCount, 1, 'smoke: a second terminal stop was created')
assert.equal(terminal.startCount, 1, 'smoke: a second terminal start was created')
assert.equal(ui.terminal, terminal, 'smoke: root did not retain the injected terminal')
assert.equal(events[events.length - 1], 'terminal.stop', 'smoke: cleanup continued after terminal stop')
