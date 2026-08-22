/**
 * Regression test for the in-place transcript rows bug (plan §1.3, WP-02):
 * the channel appends streaming/user/assistant rows by pushing into the SAME
 * `rows` array and bumps only `version` (channel.ts `emit`/`emitStream`).
 * Reference equality therefore proves nothing for the transcript slice, so
 * the projection must treat a version move as a content change:
 * `meta.revision` advances and `TranscriptView` registers and renders the
 * new/grown rows.
 *
 * Runs with the bare Node test runner (`node --import tsx/esm --test`), no
 * framework. The channel is faked down to the controller's structural
 * consumption surface (`ChannelProjectionSource`), mirroring
 * channel-view-model-race.test.ts.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ChatRow } from '../../src/dsh-adapter/channel.js'
import { TranscriptView } from '../../src/tui/components/transcript.js'
import {
  TuiController,
  type ChannelProjectionSource,
} from '../../src/tui/controller.js'
import type { TuiFences } from '../../src/tui/commands.js'
import { DEFAULT_STATUS_BAR } from '../../src/tuiDisplayPrefs.js'

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

  private readonly channelListeners = new Set<() => void>()

  subscribe(listener: () => void): () => void {
    this.channelListeners.add(listener)
    return () => {
      this.channelListeners.delete(listener)
    }
  }

  /** Mirrors channel.emit()/emitStream(): the version bumps synchronously,
   *  then listeners run; `rows` keeps its reference across both. */
  emit(): void {
    this.version += 1
    for (const listener of [...this.channelListeners]) listener()
  }

  listSessions(): ReturnType<ChannelProjectionSource['listSessions']> {
    return Promise.resolve([])
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

function makeHarness(): { channel: FakeChannel; controller: TuiController } {
  const channel = new FakeChannel()
  const fences: TuiFences = {
    sessionEpoch: () => channel.sessionEpoch,
    generation: () => 0,
  }
  const noopStore = {
    subscribe: () => () => {},
    getSnapshot: () => null,
  }
  const controller = new TuiController({
    channel,
    questions: noopStore,
    approvals: undefined,
    dialogs: undefined,
    status: undefined,
    fences,
  })
  return { channel, controller }
}

test('in-place rows push + version bump advances the transcript projection and renders the new row', () => {
  const { channel, controller } = makeHarness()
  const view = new TranscriptView()

  // Production shape: one array instance for the whole session, mutated in place.
  const rows: ChatRow[] = [{ id: 1, kind: 'user', text: 'first-row' }]
  channel.rows = rows
  channel.emit() // v1
  const first = controller.getChat()
  assert.equal(first.transcript.meta.revision, 1)
  view.update(first.transcript)
  assert.ok(view.render(80).some((line) => line.includes('first-row')))

  // Append through the SAME reference; only the version moves (emit/emitStream).
  rows.push({ id: 2, kind: 'user', text: 'second-in-place-row' })
  channel.emit() // v2
  const next = controller.getChat()
  assert.equal(next.transcript.meta.revision, 2)
  assert.notEqual(next.transcript, first.transcript)
  // Still structural sharing: the rows array itself is never copied.
  assert.equal(next.transcript.rows, first.transcript.rows)

  view.update(next.transcript)
  const lines = view.render(80)
  assert.ok(lines.some((line) => line.includes('first-row')))
  assert.ok(lines.some((line) => line.includes('second-in-place-row')))

  // Within one version, repeated pulls reuse the cached projection.
  assert.equal(controller.getChat().transcript, next.transcript)
  controller.dispose()
})

test('in-place streaming text growth advances the revision and re-renders the row', () => {
  const { channel, controller } = makeHarness()
  const view = new TranscriptView()

  const row: ChatRow = { id: 1, kind: 'assistant', text: 'chunk-one', streaming: true }
  const rows: ChatRow[] = [row]
  channel.rows = rows
  channel.emit() // v1
  const first = controller.getChat()
  view.update(first.transcript)
  assert.ok(view.render(80).some((line) => line.includes('chunk-one')))

  // emitStream shape: the row object grows in place; only the version moves.
  row.text = 'chunk-one chunk-two'
  channel.emit() // v2
  const next = controller.getChat()
  assert.equal(next.transcript.meta.revision, 2)
  assert.equal(next.transcript.rows, first.transcript.rows)

  view.update(next.transcript)
  const lines = view.render(80)
  assert.ok(lines.some((line) => line.includes('chunk-two')))
  controller.dispose()
})

test('renderFullTranscript lifts the MAX_RENDERED_ROWS fold for the fullscreen exit replay', () => {
  const view = new TranscriptView()
  const rows: ChatRow[] = [{ id: 1, kind: 'user', text: 'oldest-folded-row' }]
  for (let id = 2; id <= 304; id += 1) rows.push({ id, kind: 'user', text: `filler ${id}` })
  rows.push({ id: 305, kind: 'user', text: 'newest-row' })
  view.update({ meta: { revision: 1, sessionEpoch: 0, generation: 0 }, rows })

  // The live view folds the oldest rows behind the 300-row cap.
  const capped = view.render(80)
  assert.ok(!capped.some((line) => line.includes('oldest-folded-row')))
  assert.ok(capped.some((line) => line.includes('newest-row')))

  // The exit replay carries the complete transcript, uncapped.
  const full = view.renderFullTranscript(80)
  assert.ok(full.some((line) => line.includes('oldest-folded-row')))
  assert.ok(full.some((line) => line.includes('newest-row')))

  // The one-shot path is uncached: the live view keeps its fold afterwards.
  assert.ok(!view.render(80).some((line) => line.includes('oldest-folded-row')))
})
