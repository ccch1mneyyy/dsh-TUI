import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Component, TUI } from '../../src/tui/public.js'
import { ChatScreen, type ChatSceneHost } from '../../src/tui/screens/chat-screen.js'
import type { TuiCommands } from '../../src/tui/commands.js'
import type { TuiSceneDescriptor, TuiSceneContext } from '../../src/dsh-adapter/scenes.js'
import type { ChatViewModel } from '../../src/tui/view-model.js'
import type { TuiController } from '../../src/tui/controller.js'

const meta = { revision: 0, sessionEpoch: 0, generation: 0 } as const

function makeViewModel(active: { id: string; title?: string } | undefined): ChatViewModel {
  const mode = { id: 'default', plan: false } as never
  return {
    meta,
    transcript: { meta, rows: [] },
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
      agentId: 'test-agent-id',
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
    header: {
      meta,
      whale: false,
      model: 'test-model',
      reasoningEffort: undefined,
      displayCwd: '/repo',
      loadedContext: undefined,
    },
    prompt: {
      meta,
      pending: [],
      notifications: [],
      commandList: [],
      reasoningEffort: undefined,
      effortLevels: undefined,
      working: false,
      mode,
    },
    overlays: {
      meta,
      question: null,
      approval: null,
      dialog: null,
      statusEntries: [],
    },
    pluginScene: {
      meta,
      active,
    },
    agentId: 'agent-1',
    cwd: '/repo',
    gitBranch: 'main',
    provider: 'test-provider',
    scrollGutter: 'timeline',
  }
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

class SceneComponent implements Component {
  readonly updates: TuiSceneContext[] = []
  disposed = false

  constructor(private readonly label: string, private readonly signal: AbortSignal) {}

  update(context: TuiSceneContext): void {
    this.updates.push(context)
  }

  render(_width: number): string[] {
    return [this.label]
  }

  invalidate(): void {}

  dispose(): void {
    this.disposed = true
    assert.equal(this.signal.aborted, true)
  }
}

function makeCommands(): TuiCommands {
  return {} as TuiCommands
}

function makeUi(): TUI {
  return {
    terminal: { columns: 80, rows: 24 },
    requestRender() {},
  } as unknown as TUI
}

function makeDescriptor(id: string): TuiSceneDescriptor {
  return {
    version: 'dsh-tui/pi-tui-scene@1',
    id,
    create: () => ({ render: () => [], invalidate() {} }),
  }
}

function makeChat(
  controller: FakeController,
  host: ChatSceneHost,
): ChatScreen {
  return new ChatScreen({
    ui: makeUi(),
    commands: makeCommands(),
    controller: controller as unknown as TuiController,
    onExit() {},
    sceneHost: host,
  })
}

test('ChatScreen mounts, updates, and closes one imperative plugin scene', () => {
  let active: TuiSceneDescriptor | undefined
  let closeCalls = 0
  let created: SceneComponent | undefined
  let seenContext: TuiSceneContext | undefined
  const host: ChatSceneHost = {
    get active() {
      return active
    },
    close() {
      closeCalls += 1
      active = undefined
    },
    create(context) {
      seenContext = context
      created = new SceneComponent('plugin-scene', context.signal)
      return created
    },
  }
  const controller = new FakeController(makeViewModel(undefined))
  const chat = makeChat(controller, host)
  const descriptor = makeDescriptor('demo')
  active = descriptor
  controller.setViewModel(makeViewModel({ id: 'demo' }))

  assert.equal(created !== undefined, true)
  assert.equal(chat.render(80)[0], 'plugin-scene')
  assert.equal(seenContext?.root.kind, 'root')
  assert.equal(seenContext?.root.id, 'chat')
  assert.equal(seenContext?.overlay.visible, false)
  assert.equal(seenContext?.viewModel.pluginScene.active?.id, 'demo')
  assert.equal(seenContext?.signal.aborted, false)

  controller.setViewModel(makeViewModel({ id: 'demo', title: 'updated' }))
  assert.equal(created?.updates.length, 1)
  assert.equal(created?.updates[0]?.viewModel.pluginScene.active?.title, 'updated')

  const firstComponent = created
  active = makeDescriptor('replacement')
  controller.setViewModel(makeViewModel({ id: 'replacement' }))
  assert.equal(firstComponent?.disposed, true)
  assert.notEqual(created, firstComponent)

  controller.setViewModel(makeViewModel(undefined))
  assert.equal(closeCalls, 1)
  assert.equal(created?.disposed, true)
  assert.equal(seenContext?.signal.aborted, true)
  assert.notEqual(chat.render(80)[0], 'plugin-scene')
  chat.dispose()
})

test('ChatScreen fail-closes a scene when the host factory returns no component', () => {
  let active: TuiSceneDescriptor | undefined
  let closeCalls = 0
  let createCalls = 0
  const host: ChatSceneHost = {
    get active() {
      return active
    },
    close() {
      closeCalls += 1
      active = undefined
    },
    create() {
      createCalls += 1
      return undefined
    },
  }
  const controller = new FakeController(makeViewModel(undefined))
  const chat = makeChat(controller, host)
  active = makeDescriptor('broken')
  controller.setViewModel(makeViewModel({ id: 'broken' }))

  assert.equal(createCalls, 1)
  assert.equal(closeCalls, 1)
  assert.notEqual(chat.render(80)[0], 'plugin-scene')

  // Once the host has closed the failed scene, a stale projection must not
  // remount it while the host/runtime mirrors converge.
  controller.setViewModel(makeViewModel({ id: 'broken' }))
  assert.equal(createCalls, 1)
  chat.dispose()
})
