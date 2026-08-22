/**
 * WP-02 race tests for the controller/command-sink fences (plan §1.3):
 * async results captured under an old sessionEpoch/generation must be
 * dropped, never written into a projection built after the swap — while the
 * channel's emit coalescing and the projections' structural sharing stay
 * intact.
 *
 * Runs with the bare Node test runner (`node --import tsx/esm --test`), no
 * framework. The channel is faked down to the controller's structural
 * consumption surface (`ChannelProjectionSource`); the command sink is
 * exercised through the same fake (only the methods the test calls exist,
 * hence the cast at the sink boundary).
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Channel, ChatRow } from '../../src/dsh-adapter/channel.js'
import type { ApprovalSnapshot } from '../../src/dsh-adapter/approvals.js'
import type { TuiDialogSnapshot } from '../../src/dsh-adapter/dialogs.js'
import type { QuestionSnapshot } from '../../src/dsh-adapter/questions.js'
import type { SessionSummary } from '../../src/dsh-adapter/sessions/types.js'
import type { TuiStatusEntry } from '../../src/dsh-adapter/status.js'
import { createTuiCommands, type TuiFences } from '../../src/tui/commands.js'
import {
  TuiController,
  type ChannelProjectionSource,
  type SnapshotSource,
} from '../../src/tui/controller.js'
import { DEFAULT_STATUS_BAR } from '../../src/tuiDisplayPrefs.js'

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function makeSession(id: string): SessionSummary {
  return {
    id,
    kind: { kind: 'root' },
    title: { text: id, source: 'prompt' },
    cwd: '/repo',
    createdAt: 1,
    updatedAt: 1,
    bytes: undefined,
    hasPrompt: true,
    agentPreset: undefined,
    model: undefined,
    label: undefined,
    branch: undefined,
    childCount: 0,
  }
}

/** Minimal channel satisfying the controller's consumption surface. */
class FakeChannel implements ChannelProjectionSource {
  version = 0
  sessionEpoch = 0
  rows: readonly ChatRow[] = []
  agentId = 'session-a'
  cwd = '/repo'
  gitBranch: string | undefined = 'main'
  provider = 'deepseek'
  model = 'deepseek-chat'
  tokens = { input: 0, output: 0 }
  displayCwd = '/repo'
  sessionTitle = ''
  working = false
  spinnerMode: ChannelProjectionSource['spinnerMode'] = 'requesting'
  responseChars = 0
  activeToolCount = 0
  turnStart = 0
  notifications: ChannelProjectionSource['notifications'] = []
  contextWindow: number | undefined = undefined
  reasoningEffort: string | undefined = undefined
  effortLevels: readonly string[] | undefined = undefined
  lastUsage: ChannelProjectionSource['lastUsage'] = undefined
  tps: number | undefined = undefined
  tpsSamples: readonly { tps: number; at: number }[] = []
  workingActivity: ChannelProjectionSource['workingActivity'] = undefined
  activityFrames: string | undefined = undefined
  statusBar = DEFAULT_STATUS_BAR
  whale = true
  minimal = false
  activityEnabled = true
  contextBarEnabled = true
  contextSegments = { system: 0, prompt: 0, assistant: 0, thinking: 0, tools: 0 }
  loadedContext: ChannelProjectionSource['loadedContext'] = undefined
  pending: ChannelProjectionSource['pending'] = []
  commandList: ChannelProjectionSource['commandList'] = []
  mode = { id: 'default' }
  modeIndex = 0
  pluginScene: ChannelProjectionSource['pluginScene'] = undefined
  subagents: ChannelProjectionSource['subagents'] = []

  sessionsResult: Promise<readonly SessionSummary[]> = Promise.resolve([])
  filesResult: Promise<readonly string[]> = Promise.resolve([])
  private readonly channelListeners = new Set<() => void>()

  subscribe(listener: () => void): () => void {
    this.channelListeners.add(listener)
    return () => {
      this.channelListeners.delete(listener)
    }
  }

  /** Mirrors channel.emit(): the version bumps synchronously, then listeners run. */
  emit(): void {
    this.version += 1
    for (const listener of [...this.channelListeners]) listener()
  }

  listSessions(): Promise<readonly SessionSummary[]> {
    return this.sessionsResult
  }

  listFiles(): Promise<readonly string[]> {
    return this.filesResult
  }

  settingsSections(): ReturnType<ChannelProjectionSource['settingsSections']> {
    return []
  }

  subscribeSettingsSections(_listener: () => void): () => void {
    return () => {}
  }

  traceEvents(): ReturnType<ChannelProjectionSource['traceEvents']> {
    return []
  }
}

class FakeStore<T> implements SnapshotSource<T> {
  private snapshot: T
  private readonly storeListeners = new Set<() => void>()

  constructor(initial: T) {
    this.snapshot = initial
  }

  getSnapshot(): T {
    return this.snapshot
  }

  set(next: T): void {
    this.snapshot = next
    for (const listener of [...this.storeListeners]) listener()
  }

  subscribe(listener: () => void): () => void {
    this.storeListeners.add(listener)
    return () => {
      this.storeListeners.delete(listener)
    }
  }
}

interface Harness {
  channel: FakeChannel
  fences: TuiFences
  fenceState: { generation: number }
  controller: TuiController
  commands: ReturnType<typeof createTuiCommands>
  questions: FakeStore<QuestionSnapshot | null>
  approvals: FakeStore<ApprovalSnapshot | null>
  dialogs: FakeStore<TuiDialogSnapshot | null>
  status: FakeStore<readonly TuiStatusEntry[]>
}

function makeHarness(): Harness {
  const channel = new FakeChannel()
  const fenceState = { generation: 0 }
  const fences: TuiFences = {
    sessionEpoch: () => channel.sessionEpoch,
    generation: () => fenceState.generation,
  }
  const questions = new FakeStore<QuestionSnapshot | null>(null)
  const approvals = new FakeStore<ApprovalSnapshot | null>(null)
  const dialogs = new FakeStore<TuiDialogSnapshot | null>(null)
  const status = new FakeStore<readonly TuiStatusEntry[]>([])
  const controller = new TuiController({ channel, questions, approvals, dialogs, status, fences })
  // The fake only implements the methods the tests call; the sink is typed
  // against the full Channel by design.
  const commands = createTuiCommands({ channel: channel as unknown as Channel, fences })
  return { channel, fences, fenceState, controller, commands, questions, approvals, dialogs, status }
}

test('session switch drops stale async command results instead of writing them into the new projection', async () => {
  const { channel, controller, commands } = makeHarness()

  // Two slow reads captured under epoch 0: one through the command sink, one
  // through the controller-owned refresh that feeds the sessions projection.
  const slowList = deferred<readonly SessionSummary[]>()
  channel.sessionsResult = slowList.promise
  const commandResult = commands.query.listSessions()
  const refreshResult = controller.refreshSessions()

  // The session/agent swap lands while both reads are in flight.
  channel.sessionEpoch += 1
  channel.emit()

  slowList.resolve([makeSession('s1')])
  assert.equal(await commandResult, undefined)
  assert.equal(await refreshResult, undefined)
  // The stale result never reached the projection.
  assert.equal(controller.getSessions().sessions.length, 0)

  // A read issued under the new epoch lands and notifies the slice.
  let sessionsWake = 0
  const unsubscribe = controller.subscribe('sessions', () => {
    sessionsWake += 1
  })
  channel.sessionsResult = Promise.resolve([makeSession('s2')])
  const accepted = await controller.refreshSessions()
  assert.equal(accepted?.length, 1)
  assert.equal(controller.getSessions().sessions[0]?.id, 's2')
  assert.equal(controller.getSessions().meta.sessionEpoch, 1)
  assert.equal(sessionsWake, 1)
  unsubscribe()
  controller.dispose()
})

test('lifecycle generation bump drops completions of commands captured before it', async () => {
  const { channel, fenceState, commands, controller } = makeHarness()

  const slowFiles = deferred<readonly string[]>()
  channel.filesResult = slowFiles.promise
  const staleResult = commands.query.listFiles()
  // quiesce/resume (external editor) bumps the generation mid-flight.
  fenceState.generation += 1
  slowFiles.resolve(['a.ts'])
  assert.equal(await staleResult, undefined)

  // The same call under the current generation resolves normally.
  channel.filesResult = Promise.resolve(['b.ts'])
  assert.deepEqual(await commands.query.listFiles(), ['b.ts'])
  controller.dispose()
})

test('synchronous emits dispatch unbatched and unchanged slices keep their identity', () => {
  const { channel, controller } = makeHarness()

  const seen: number[] = []
  const unsubscribe = controller.subscribe('chat', () => {
    seen.push(controller.getChat().meta.revision)
  })
  const first = controller.getChat()
  assert.equal(first.meta.revision, 0)

  channel.working = true
  channel.emit() // v1
  channel.responseChars = 128
  channel.emit() // v2
  // No React-style batching: each notify dispatched synchronously and the
  // listener pulled the freshest projection at that moment.
  assert.deepEqual(seen, [1, 2])

  const after = controller.getChat()
  assert.equal(after.meta.revision, 2)
  // Structural sharing: field-compared slices that read nothing new keep
  // their references, and the transcript always shares the rows array.
  assert.equal(after.header, first.header)
  assert.equal(after.transcript.rows, first.transcript.rows)
  // The transcript slice tracks the channel version instead: rows is
  // mutated in place, so any version bump may carry an invisible append.
  assert.notEqual(after.transcript, first.transcript)
  assert.equal(after.transcript.meta.revision, 2)
  // The spinner slice did change (working/responseChars are its fields).
  assert.notEqual(after.spinner, first.spinner)
  assert.notEqual(after, first)

  // A version-only bump still rebuilds the transcript (in-place rows make
  // "no relevant change" undetectable) and with it the chat view model, but
  // repeated pulls within the same version reuse the rebuilt objects.
  channel.emit() // v3 — version-only bump
  const again = controller.getChat()
  assert.notEqual(again, after)
  assert.equal(again.meta.revision, 3)
  assert.equal(again.transcript.meta.revision, 3)
  assert.equal(controller.getChat(), again)
  unsubscribe()
  controller.dispose()
})

test('every projection carries revision/sessionEpoch/generation and revisions mark content changes', () => {
  const { channel, fenceState, controller, questions } = makeHarness()
  channel.sessionEpoch = 2
  fenceState.generation = 3

  const row: ChatRow = { id: 1, kind: 'user', text: 'hello' }
  channel.rows = [row]
  channel.emit() // v1 — transcript content changed here
  const vm = controller.getChat()
  assert.deepEqual(vm.transcript.meta, { revision: 1, sessionEpoch: 2, generation: 3 })
  assert.deepEqual(vm.meta, { revision: 1, sessionEpoch: 2, generation: 3 })

  // An unrelated change moves the slices that read the changed fields — and
  // the transcript, whose in-place rows make content moves indistinguishable
  // from version bumps. Field-compared slices like the header stay put.
  channel.working = true
  channel.emit() // v2
  const next = controller.getChat()
  assert.equal(next.header.meta.revision, 1)
  assert.equal(next.transcript.meta.revision, 2)
  assert.equal(next.statusLine.meta.revision, 2)
  assert.equal(next.meta.revision, 2)

  // A fence move alone refreshes the fence stamps without touching revisions.
  fenceState.generation = 4
  const fenced = controller.getChat()
  assert.equal(fenced.transcript.meta.generation, 4)
  assert.equal(fenced.transcript.meta.revision, 2)
  assert.notEqual(fenced.transcript, next.transcript)

  // Store-sourced overlays carry the same fences; a store notify wakes both
  // the overlays slice and the chat slice that embeds it.
  const woken: string[] = []
  const offOverlays = controller.subscribe('overlays', () => woken.push('overlays'))
  const offChat = controller.subscribe('chat', () => woken.push('chat'))
  questions.set({ key: 'q1', question: {} as QuestionSnapshot['question'], position: 1, total: 1, answered: 0 })
  assert.deepEqual(woken.sort(), ['chat', 'overlays'])
  const overlays = controller.getOverlays()
  assert.equal(overlays.question?.key, 'q1')
  assert.equal(overlays.meta.sessionEpoch, 2)
  assert.equal(overlays.meta.generation, 4)
  assert.equal(overlays.meta.revision, 1) // first store content change
  offOverlays()
  offChat()
  controller.dispose()
})
