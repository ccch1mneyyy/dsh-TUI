/**
 * M2.3 built-in slash vocabulary + warm caches (ported from main 41300b04):
 *
 * - completeCommands' token charset includes `. : /` so a provider/model
 *   spec (`deepseek/deepseek-v4-flash`) survives as ONE token;
 * - channel commandCompletions grows the model/preset/effort/lang/theme/
 *   activity children vocabularies (activity frames a third level), with
 *   head-prefix warming (`/m` warms the model catalog before the trailing
 *   space asks for it) and three session caches: modelNodeCache (shared
 *   promise dedupe, arrival emit, dropped on switchModel success),
 *   presetOptionCache (no invalidation; tags resolve at children() time),
 *   effortWarm (state.effortLevels sync vocabulary; one best-effort
 *   resolveEfforts when unknown, `tried` caps error-notification spam);
 * - the prompt provider folds the [current]/[default] tag into the pi
 *   AutocompleteItem description, localized via localizedDescription;
 * - `/model <provider/id>` dispatches a direct switch through the fenced
 *   sink (catalog-validated; an invalid/unknown spec never switches).
 *
 * Harness style follows channel-session-mutation.test.ts (REAL createChannel
 * against a minimal fake ctx/agent) and chat-slash-dispatch.test.ts
 * (ChatScreen over a stub TuiCommands).
 */
import './redirect-home.js'
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { completeCommands, LOCAL_COMMANDS, type CommandCompletion, type CommandCompletionNode } from '../../src/commands.js'
import { createChannel, type ChannelState } from '../../src/dsh-adapter/channel.js'
import { getLang, setLang, t } from '../../src/i18n.js'
import { ChatScreen } from '../../src/tui/screens/chat-screen.js'
import type { TuiCommands } from '../../src/tui/commands.js'
import type { TuiController } from '../../src/tui/controller.js'
import type { ChatViewModel } from '../../src/tui/view-model.js'
import type { TUI } from '../../src/tui/public.js'
import { PromptAutocompleteProvider } from '../../src/tui/components/prompt-editor.js'

// Deterministic [current] tags + localized descriptions below.
setLang('en')

/** One macrotask: flushes every pending microtask hop of the async bodies. */
const tick = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0))
const settle = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 20))

/** Deadlock tripwire: node:test has no per-test timeout. */
function withTimeout<T>(pending: Promise<T>, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    pending,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} did not settle`)), 5000)
    }),
  ]).finally(() => clearTimeout(timer))
}

// --- completeCommands: token charset (pure) ----------------------------------

test('token charset: a provider/model spec survives as ONE token', () => {
  const children = (path: readonly string[]): readonly CommandCompletionNode[] =>
    path.length === 1 && path[0] === 'model'
      ? [
          { name: 'deepseek/deepseek-v4-flash', description: 'DeepSeek V4 Flash' },
          { name: 'openai/gpt-4.1', description: 'GPT 4.1' },
          { name: 'openai/gpt-4.1:latest', description: 'GPT 4.1 latest' },
        ]
      : []
  // `/` in the query: the whole spec is the filter prefix, not a path split.
  const slash = completeCommands('/model deepseek/de', LOCAL_COMMANDS, children)
  assert.deepEqual(slash.map(c => c.name), ['model deepseek/deepseek-v4-flash'])
  assert.equal(slash[0]?.commandLine, '/model deepseek/deepseek-v4-flash')
  // `.` and `:` ride the same charset.
  const dotted = completeCommands('/model openai/gpt-4', LOCAL_COMMANDS, children)
  assert.deepEqual(dotted.map(c => c.name), ['model openai/gpt-4.1', 'model openai/gpt-4.1:latest'])
  const colon = completeCommands('/model openai/gpt-4.1:', LOCAL_COMMANDS, children)
  assert.deepEqual(colon.map(c => c.name), ['model openai/gpt-4.1:latest'])
  // Enter-dispatch text stays intact: the spec round-trips through commandLine.
  assert.equal(colon[0]?.replacement, '/model openai/gpt-4.1:latest ')
})

// --- channel harness (channel-session-mutation style) -------------------------

type Handler = (...args: never[]) => void

interface FakeAgent {
  id: string
  status: string
  options: Record<string, unknown>
  session: {
    id: string
    seq: number
    events: unknown[]
    header: Record<string, unknown>
    append(type: string, data: unknown): void
  }
  ctx: { on(): () => void }
  followup(message: unknown): void
  steer(message: unknown): void
  inbox: { remove(): boolean }
  cancel(): void
  whenIdle(): Promise<void>
}

function makeAgent(id: string, sessionId: string): FakeAgent {
  const session: FakeAgent['session'] = {
    id: sessionId,
    seq: 0,
    events: [],
    header: {},
    append(type, data) {
      session.events.push({ type, seq: session.events.length, time: Date.now(), data })
    },
  }
  return {
    id,
    status: 'idle',
    options: {},
    session,
    ctx: { on: () => () => {} },
    followup() {},
    steer() {},
    inbox: { remove: () => true },
    cancel() {},
    whenIdle: () => Promise.resolve(),
  }
}

function makeHandle(agent: FakeAgent): { agent: FakeAgent; dispose(): Promise<void> } {
  return { agent, dispose: () => Promise.resolve() }
}

function makeChannel(
  services: Record<string, unknown>,
  options: Record<string, unknown> = {},
): ChannelState {
  const handlers = new Map<string, Handler[]>()
  const ctx = {
    on(event: string, handler: Handler) {
      const list = handlers.get(event) ?? []
      list.push(handler)
      handlers.set(event, list)
      return () => {
        const index = list.indexOf(handler)
        if (index >= 0) list.splice(index, 1)
      }
    },
    get: (name: string) => services[name],
    logger: { warn() {} },
  }
  return createChannel(ctx as never, makeAgent('agent-1', 's-1') as never, {
    model: 'test-model',
    cwd: '/tmp',
    provider: 'test',
    activity: false,
    ...options,
  })
}

const MODEL_CATALOG = [
  { provider: 'test', id: 'test-model', name: 'Test Model' },
  { provider: 'deepseek', id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
]

/** llm service fake: catalog fetch + route-metadata resolution, both counted. */
function makeLlm(options: { resolveError?: boolean } = {}) {
  const calls = { listModels: [] as string[], resolveModelInfo: 0 }
  const service = {
    calls,
    listProviders: () => [{ id: 'test' }, { id: 'deepseek' }],
    listModels(provider: string) {
      calls.listModels.push(provider)
      return Promise.resolve(MODEL_CATALOG.filter(model => model.provider === provider))
    },
    resolveModelInfo() {
      calls.resolveModelInfo += 1
      if (options.resolveError === true) return Promise.reject(new Error('no route metadata'))
      return Promise.resolve({
        reasoning: {
          efforts: [
            { id: 'low', name: 'Low' },
            { id: 'high', name: 'High' },
          ],
          defaultEffort: 'low',
        },
      })
    },
  }
  return service
}

// --- channel: six vocabulary children -----------------------------------------

test('channel children: /lang status + zh/en with the active language tagged', () => {
  const channel = makeChannel({})
  const names = channel.commandCompletions('/lang ').map(c => c.name)
  assert.deepEqual(names, ['lang status', 'lang zh', 'lang en'])
  const completions = channel.commandCompletions('/lang ')
  assert.equal(completions.find(c => c.name === 'lang en')?.tag, 'current')
  assert.equal(completions.find(c => c.name === 'lang zh')?.tag, undefined)
  // The child descriptions resolve through the new sugg-* dict keys.
  assert.equal(completions.find(c => c.name === 'lang status')?.descriptionKey, 'sugg-status-desc')
  assert.equal(completions.find(c => c.name === 'lang zh')?.descriptionKey, 'sugg-lang-zh-desc')
})

test('channel children: /theme status + auto + built-ins (+ user themes when present)', () => {
  const channel = makeChannel({})
  // redirect-home sandboxed HOME has no ~/.dsh-tui/themes — built-ins only.
  const names = channel.commandCompletions('/theme ').map(c => c.name)
  assert.deepEqual(names, ['theme status', 'theme auto', 'theme dark', 'theme dark-ansi', 'theme light'])
  const keys = channel.commandCompletions('/theme ').map(c => c.descriptionKey)
  assert.deepEqual(keys, [
    'sugg-status-desc',
    'sugg-theme-auto-desc',
    'sugg-theme-builtin-desc',
    'sugg-theme-builtin-desc',
    'sugg-theme-builtin-desc',
  ])
})

test('channel children: /activity status/frames, frames <preset> at the third level', () => {
  const channel = makeChannel({}, { activityFrames: 'random' })
  assert.deepEqual(
    channel.commandCompletions('/activity ').map(c => c.name),
    ['activity status', 'activity frames'],
  )
  const frames = channel.commandCompletions('/activity frames ')
  assert.ok(frames.length > 1, 'frame presets from dsh-working-activity')
  assert.equal(frames[0]?.name, 'activity frames random')
  assert.equal(frames[0]?.tag, 'current', 'the active frames preset carries [current]')
  assert.ok(frames.every(c => c.descriptionKey === 'sugg-activity-frame-desc'))
  // Prefix filtering runs against the preset name at the third level.
  const filtered = channel.commandCompletions('/activity frames d').map(c => c.name)
  assert.ok(filtered.length > 0 && filtered.every(name => name.startsWith('activity frames d')))
})

test('channel children: /preset warms the roster, [current]/[default] resolve at children() time', async () => {
  const listCalls: number[] = []
  const agentPresets = {
    defaultId: 'liangshen',
    list: () => {
      listCalls.push(1)
      return Promise.resolve([
        { id: 'default', name: 'Default preset' },
        { id: 'liangshen', name: 'Liangshen', description: 'Liangshen mode' },
      ])
    },
  }
  const channel = makeChannel({ agentPresets }, { agentPreset: 'default' })
  // Head-prefix warm: `/p` already starts the roster fetch (deduped).
  channel.commandCompletions('/p')
  channel.commandCompletions('/preset ')
  await settle()
  assert.equal(listCalls.length, 1, 'the shared promise dedupes concurrent warms')
  const completions = channel.commandCompletions('/preset ')
  assert.deepEqual(completions.map(c => c.name), ['preset status', 'preset default', 'preset liangshen'])
  assert.equal(completions.find(c => c.name === 'preset default')?.tag, 'current')
  assert.equal(completions.find(c => c.name === 'preset liangshen')?.tag, 'default')
  // description: preset.description ?? preset.name ?? preset.id
  assert.equal(completions.find(c => c.name === 'preset liangshen')?.description, 'Liangshen mode')
  // Cached afterwards — a later children() call does not refetch.
  channel.commandCompletions('/preset ')
  assert.equal(listCalls.length, 1)
})

test('channel children: /effort unknown warms once via resolveEfforts, then serves the sync vocabulary', async () => {
  const llm = makeLlm()
  const channel = makeChannel({ llm })
  // Still unknown: only the status row is synchronous; the warm fires once.
  assert.deepEqual(channel.commandCompletions('/effort ').map(c => c.name), ['effort status'])
  channel.commandCompletions('/effort h') // in-flight warm must not duplicate
  channel.commandCompletions('/e') // head-prefix warm shares the same guard
  assert.equal(llm.calls.resolveModelInfo, 1)
  await settle()
  assert.equal(llm.calls.resolveModelInfo, 1, 'tried caps keystroke-time retries')
  const completions = channel.commandCompletions('/effort ')
  assert.deepEqual(completions.map(c => c.name), ['effort status', 'effort low', 'effort high'])
  assert.ok(completions.every(c => c.descriptionKey !== undefined))
  // The landed vocabulary is served synchronously with no further resolution.
  channel.commandCompletions('/effort ')
  assert.equal(llm.calls.resolveModelInfo, 1)
})

test('channel children: /effort resolution errors notify once and never retry', async () => {
  const llm = makeLlm({ resolveError: true })
  const channel = makeChannel({ llm })
  channel.commandCompletions('/effort ')
  await settle()
  const errorsAfterFirst = channel.notifications.filter(n => n.color === 'error').length
  channel.commandCompletions('/effort ')
  await settle()
  assert.equal(llm.calls.resolveModelInfo, 1, 'a hard error keeps `tried` set — no retry per keystroke')
  assert.equal(channel.notifications.filter(n => n.color === 'error').length, errorsAfterFirst)
})

test('channel children: /effort tags the live effort when the route vocabulary is known', async () => {
  const llm = makeLlm()
  // options.effort seeds state.reasoningEffort; boot's applyPreferredEffort
  // lands the level table synchronously enough that no warm is needed here.
  const channel = makeChannel({ llm }, { effort: 'high' })
  await settle()
  const completions = channel.commandCompletions('/effort ')
  assert.deepEqual(completions.map(c => c.name), ['effort status', 'effort low', 'effort high'])
  assert.equal(completions.find(c => c.name === 'effort high')?.tag, 'current')
})

// --- channel: modelNodeCache warm/dedupe + switchModel invalidation -----------

test('channel children: /model warms a deduped catalog cache, emits on arrival, switchModel drops it', async () => {
  const llm = makeLlm()
  const services: Record<string, unknown> = { llm }
  const channel = makeChannel(services)
  let emits = 0
  channel.subscribe(() => {
    emits += 1
  })
  await settle()
  emits = 0 // boot noise settled; count only the warm arrival below

  // Before the fetch lands the menu is empty, and concurrent triggers share
  // one in-flight promise: the head-prefix warm and the children() warm.
  assert.deepEqual(channel.commandCompletions('/model '), [])
  channel.commandCompletions('/m')
  channel.commandCompletions('/model')
  channel.commandCompletions('/model deep')
  await settle()
  assert.equal(llm.calls.listModels.length, 2, 'one catalog fetch (two providers) across all warms')
  assert.ok(emits >= 1, 'the arrival emit reopens the menu mid-typing')

  const completions = channel.commandCompletions('/model ')
  assert.deepEqual(completions.map(c => c.name), ['model test/test-model', 'model deepseek/deepseek-v4-flash'])
  assert.equal(completions.find(c => c.name === 'model test/test-model')?.tag, 'current')
  assert.equal(completions.find(c => c.name === 'model deepseek/deepseek-v4-flash')?.tag, undefined)
  // Cached: a later children() call serves the landed nodes without refetching.
  channel.commandCompletions('/model ')
  assert.equal(llm.calls.listModels.length, 2)

  // switchModel's success path drops the cache: the next completion refetches
  // and the [current] tag re-resolves against the new route.
  services.sessions = { fork: () => ({ events: [] }) }
  services.agents = { create: () => Promise.resolve(makeHandle(makeAgent('agent-2', 's-2'))) }
  assert.equal(await withTimeout(channel.switchModel('deepseek', 'deepseek-v4-flash'), 'switchModel'), true)
  assert.equal(channel.provider, 'deepseek')
  assert.deepEqual(channel.commandCompletions('/model '), [], 'cache dropped — refetch in flight')
  await settle()
  assert.equal(llm.calls.listModels.length, 4, 'the [current] tag refetches against the new route')
  const after = channel.commandCompletions('/model ')
  assert.equal(after.find(c => c.name === 'model deepseek/deepseek-v4-flash')?.tag, 'current')
  assert.equal(after.find(c => c.name === 'model test/test-model')?.tag, undefined)
})

// --- provider: tag folded into the localized description ----------------------

test('provider: slash items fold the tag into a localized description', async () => {
  const completions: CommandCompletion[] = [
    {
      name: 'preset status',
      description: 'fallback text loses to the dict',
      descriptionKey: 'sugg-status-desc',
      replacement: '/preset status ',
      commandLine: '/preset status',
    },
    {
      name: 'preset default',
      description: 'Default preset',
      tag: 'current',
      replacement: '/preset default ',
      commandLine: '/preset default',
    },
    {
      name: 'preset quiet',
      description: '',
      tag: 'default',
      replacement: '/preset quiet ',
      commandLine: '/preset quiet',
    },
  ]
  const commands = { query: { commandCompletions: () => completions } }
  const provider = new PromptAutocompleteProvider(commands as never as TuiCommands)
  const suggestions = await provider.getSuggestions(['/preset '], 0, 8, { signal: new AbortController().signal })
  assert.ok(suggestions !== null)
  // descriptionKey resolves through the i18n dict (en pinned above)…
  assert.equal(suggestions.items[0]?.description, 'Show the current choice')
  // …and the [current]/[default] marker appends to the description text.
  assert.equal(suggestions.items[1]?.description, 'Default preset [current]')
  assert.equal(suggestions.items[2]?.description, '[default]')
  assert.equal(suggestions.items[1]?.value, '/preset default')

  setLang('zh')
  const zh = await provider.getSuggestions(['/preset '], 0, 8, { signal: new AbortController().signal })
  assert.equal(zh?.items[0]?.description, '显示当前选择')
  setLang('en')
})

// --- chat screen: /model <spec> direct dispatch --------------------------------

const meta = { revision: 0, sessionEpoch: 0, generation: 0 } as const
const chatMode = { id: 'default', plan: false } as never

function makeChatViewModel(): ChatViewModel {
  return {
    meta,
    transcript: { meta, rows: [] },
    statusLine: {
      meta,
      minimal: false,
      statusBar: {} as never,
      lastUsage: undefined,
      reasoningEffort: undefined,
      mode: chatMode,
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
    prompt: { meta, pending: [], notifications: [], commandList: [], reasoningEffort: undefined, effortLevels: undefined, working: false, mode: chatMode },
    overlays: { meta, question: null, approval: null, dialog: null, statusEntries: [] },
    pluginScene: { meta, active: undefined },
    agentId: 'agent-1',
    cwd: '/repo',
    gitBranch: 'main',
    provider: 'test',
    scrollGutter: 'timeline',
  } as ChatViewModel
}

interface ChatHarnessOptions {
  listModels?: Array<{ provider: string; id: string; name: string }> | undefined
  switchModelResult?: boolean
}

function makeChatHarness(options: ChatHarnessOptions = {}) {
  const calls = {
    listModels: 0,
    switchModel: [] as Array<{ provider: string; model: string }>,
    notify: [] as Array<{ text: string; color?: string }>,
  }
  const commands = {
    input: {
      cancel: () => {},
      interruptAndDeliver: () => 0,
      removePending: () => false,
      runExternalCommand: async () => undefined,
      steer: () => {},
      submit: () => {},
    },
    session: {
      clear: () => {},
      compact: () => {},
      cycleMode: () => {},
      deleteSession: async () => true,
      forkSession: async () => true,
      listModes: () => [],
      newSession: async () => true,
      promptRewind: async () => 'cancel',
      renameSession: () => {},
      renameSessionTo: async () => true,
      resumeTo: async () => ({ ok: false, reason: 'cancelled' }),
      rewindTo: async () => null,
      rewindToNode: async () => null,
      setMode: async () => true,
    },
    model: {
      currentPreset: () => undefined,
      listEfforts: async () => undefined,
      listModels: async () => {
        calls.listModels += 1
        return options.listModels
      },
      listPresets: async () => undefined,
      setActivityFrames: () => true,
      setEffort: async () => true,
      switchModel: async (provider: string, model: string) => {
        calls.switchModel.push({ provider, model })
        return options.switchModelResult ?? true
      },
      switchPreset: async () => true,
    },
    query: {
      commandCompletions: () => [],
      getSessionTree: async () => null,
      listFileCandidates: async () => [],
      listFiles: async () => [],
      listSessions: async () => [],
      listSkills: async () => [],
      listSubagents: async () => [],
      previewSession: async () => [],
      stageImage: async () => undefined,
      subagentInterrupt: () => false,
    },
    settings: {
      settingsHost: () => undefined,
      settingsSections: () => [],
      subscribeSettingsSections: () => () => {},
    },
    workspace: {
      listWorkspaces: async () => [],
      renameWorkspace: async () => true,
      resolveWorkspace: async () => undefined,
      runWorkspaceCommand: async () => undefined,
      switchWorkspace: async () => true,
      workspaceCommands: () => [],
    },
    info: {
      describeCredential: async () => undefined,
      doctorInfo: () => [],
      exportSession: () => null,
      initWorkspace: () => null,
      mcpStatus: () => [],
      notify: (text: string, notifyOptions?: { color?: string }) => {
        calls.notify.push({ text, color: notifyOptions?.color })
        return () => {}
      },
      pluginsInfo: () => [],
      providerSetup: () => undefined,
      pushLocal: () => {},
      sideQuestion: async () => undefined,
      traceEvents: () => [],
    },
    scene: { closePluginScene: () => {}, openPluginScene: () => false },
    overlays: {
      answerQuestion: () => {},
      askQuestion: async () => ({ answers: {} }),
      cancelDialog: () => {},
      cancelQuestion: () => {},
      decideApproval: () => {},
      decideDialog: () => {},
    },
    display: {
      currentTheme: () => 'dark',
      listThemes: () => [],
      setLang: () => true,
      setTheme: () => true,
    },
  } as unknown as TuiCommands
  const vm = makeChatViewModel()
  const controller = {
    subscribe: () => () => {},
    getChat: () => vm,
    getSubagents: () => ({ meta, items: [] }),
    getSessions: () => ({ meta, sessions: [], cwd: '/repo', gitBranch: 'main', currentAgentId: 'agent-1' }),
    getTrajectory: () => ({ meta, events: [] }),
  }
  const ui = { requestRender: () => {}, terminal: { columns: 80, rows: 24 } } as unknown as TUI
  const chat = new ChatScreen({
    commands,
    controller: controller as unknown as TuiController,
    onExit: () => {},
    onUpdate: () => {},
    ui,
  })
  return { calls, chat }
}

async function type(chat: ChatScreen, input: string): Promise<void> {
  chat.handleInput(input)
  chat.handleInput('\r')
  for (let index = 0; index < 4; index += 1) {
    await new Promise(resolve => setImmediate(resolve))
  }
}

test('chat /model <provider/id> validates the catalog then switches directly', async () => {
  const harness = makeChatHarness({ listModels: [...MODEL_CATALOG] })
  await type(harness.chat, '/model deepseek/deepseek-v4-flash')
  assert.equal(harness.calls.listModels, 1)
  assert.deepEqual(harness.calls.switchModel, [{ provider: 'deepseek', model: 'deepseek-v4-flash' }])
  assert.ok(harness.calls.notify.some(entry => entry.text === t('model-switching', { name: 'DeepSeek V4 Flash' })))
  assert.ok(harness.calls.notify.some(entry => entry.text === t('model-switched', { name: 'DeepSeek V4 Flash' })))
  harness.chat.dispose()
})

test('chat /model with an invalid or unknown spec never switches', async () => {
  // No slash in the spec: the usage warning fires before any catalog fetch.
  const usage = makeChatHarness({ listModels: [...MODEL_CATALOG] })
  await type(usage.chat, '/model nope')
  assert.equal(usage.calls.listModels, 0)
  assert.deepEqual(usage.calls.switchModel, [])
  assert.ok(usage.calls.notify.some(entry => entry.color === 'warning' && entry.text === t('model-usage')))
  usage.chat.dispose()

  // Well-formed but absent from the catalog: fetched, reported, not switched.
  const unknown = makeChatHarness({ listModels: [...MODEL_CATALOG] })
  await type(unknown.chat, '/model deepseek/nope')
  assert.equal(unknown.calls.listModels, 1)
  assert.deepEqual(unknown.calls.switchModel, [])
  assert.ok(
    unknown.calls.notify.some(
      entry => entry.color === 'error' && entry.text === t('model-unknown', { spec: 'deepseek/nope' }),
    ),
  )
  unknown.chat.dispose()

  // A stale-dropped (fenced) catalog stays silent and never switches.
  const stale = makeChatHarness({ listModels: undefined })
  await type(stale.chat, '/model deepseek/deepseek-v4-flash')
  assert.equal(stale.calls.listModels, 1)
  assert.deepEqual(stale.calls.switchModel, [])
  assert.equal(stale.calls.notify.length, 0)
  stale.chat.dispose()
})

// getLang sanity: the pinned language above really is what children compare
// against (guards a silent env override making the tag assertions vacuous).
test('the suite pins the UI language for deterministic tags', () => {
  assert.equal(getLang(), 'en')
})
