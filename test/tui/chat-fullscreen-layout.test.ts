import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  getLayoutNode,
  LAYOUT_NODE,
  ScrollView,
  type Component,
  type StackLayoutNode,
  type TUI,
} from '../../src/tui/public.js'
import { ChatScreen, type ChatSceneHost } from '../../src/tui/screens/chat-screen.js'
import type { TuiCommands } from '../../src/tui/commands.js'
import type { TuiSceneDescriptor } from '../../src/dsh-adapter/scenes.js'
import type { ChatViewModel } from '../../src/tui/view-model.js'
import type { TuiController } from '../../src/tui/controller.js'

const meta = { revision: 0, sessionEpoch: 0, generation: 0 } as const

function makeViewModel(active: { id: string } | undefined): ChatViewModel {
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

function makeChat(fullscreen: boolean, host?: ChatSceneHost): { chat: ChatScreen; controller: FakeController } {
  const controller = new FakeController(makeViewModel(undefined))
  const chat = new ChatScreen({
    ui: {
      terminal: { columns: 80, rows: 24 },
      requestRender() {},
    } as unknown as TUI,
    commands: {} as TuiCommands,
    controller: controller as unknown as TuiController,
    onExit() {},
    fullscreen,
    ...(host === undefined ? {} : { sceneHost: host }),
  })
  return { chat, controller }
}

function asStack(node: ReturnType<typeof getLayoutNode>): StackLayoutNode {
  assert.ok(node !== undefined && (node.type === 'vstack' || node.type === 'hstack'))
  return node
}

test('fullscreen ChatScreen exposes a ScrollView+dock layout root', () => {
  const { chat } = makeChat(true)
  try {
    const node = asStack(chat[LAYOUT_NODE]())
    assert.equal(node.type, 'vstack')
    assert.equal(node.entries.length, 2)

    // The conversation scrolls: first entry is the primary follow-end
    // ScrollView that TuiAltScreen routes wheel/PageUp/PageDown to.
    const [scrollEntry, dockEntry] = node.entries
    assert.equal(scrollEntry?.basis, 0)
    assert.equal(scrollEntry?.grow, 1)
    assert.equal(scrollEntry?.shrink, 1)
    assert.equal(scrollEntry?.minSize, 1)
    const scrollView = scrollEntry?.component
    assert.ok(scrollView instanceof ScrollView)
    assert.equal(scrollView.primary, true)
    assert.equal(scrollView.overscroll, 'chain')
    assert.equal(scrollView.scrollbar, 'auto')
    assert.equal(scrollView.isFollowingEnd, true)

    // The scroll content is header + transcript, so the banner scrolls away
    // with the conversation history.
    const scrollNode = getLayoutNode(scrollView)
    assert.equal(scrollNode?.type, 'scroll')
    const conversation = asStack(getLayoutNode((scrollNode as { component: Component }).component))
    assert.equal(conversation.type, 'vstack')
    assert.equal(conversation.entries.length, 2)

    // The dock keeps every chrome row below the transcript at its natural
    // height: working/approval/dialog/question/statusEntries/editor/
    // settingsSlot/pickerSlot/notifications/status.
    assert.equal(dockEntry?.basis, 'auto')
    assert.equal(dockEntry?.grow, 0)
    const dock = asStack(getLayoutNode(dockEntry!.component))
    assert.equal(dock.type, 'vstack')
    assert.equal(dock.entries.length, 10)
    // The status line is the last, always-visible dock row; notifications sit
    // right above it.
    assert.equal(dock.entries.at(-1)?.visible, undefined)
    assert.equal(typeof dock.entries.at(-2)?.visible, 'function')

    // render() still produces the natural document (fullscreen exit replay).
    assert.ok(chat.render(80).length > 0)
  } finally {
    chat.dispose()
  }
})

test('inline ChatScreen keeps the flat root without a scroll node', () => {
  const { chat } = makeChat(false)
  try {
    const node = asStack(chat[LAYOUT_NODE]())
    assert.equal(node.type, 'vstack')
    assert.equal(node.entries.length, 12)
    assert.ok(node.entries.every((entry) => getLayoutNode(entry.component)?.type !== 'scroll'))
  } finally {
    chat.dispose()
  }
})

test('fullscreen ChatScreen falls back to leaf rendering while a transient screen is mounted', () => {
  let active: TuiSceneDescriptor | undefined
  const host: ChatSceneHost = {
    get active() {
      return active
    },
    close() {
      active = undefined
    },
    create: () => ({ render: () => ['plugin-scene'], invalidate() {} }),
  }
  const { chat, controller } = makeChat(true, host)
  try {
    active = { version: 'dsh-tui/pi-tui-scene@1', id: 'demo', create: () => ({ render: () => [], invalidate() {} }) }
    controller.setViewModel(makeViewModel({ id: 'demo' }))
    assert.equal(chat.render(80)[0], 'plugin-scene')
    assert.equal(chat[LAYOUT_NODE](), undefined)

    controller.setViewModel(makeViewModel(undefined))
    assert.equal(chat[LAYOUT_NODE]()?.type, 'vstack')
  } finally {
    chat.dispose()
  }
})
