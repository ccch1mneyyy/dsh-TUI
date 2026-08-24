/**
 * M2.4 transcript keyboard paths (research §1.2/§1.3/§3.5):
 * - Ctrl/Cmd+E toggles the transcript's MAX_RENDERED_ROWS fold (showAll /
 *   collapse),
 * - Ctrl/Cmd+O toggles verbose expansion (RowContext.expanded),
 * - Ctrl/Cmd+R mounts the persisted-history search picker in the editor slot
 *   and Enter backfills the prompt editor,
 * - plain Enter while the fullscreen conversation is scrolled away from the
 *   end returns to the bottom and is consumed (never reaches the editor, even
 *   with a non-empty prompt — the manual's semantics, a deliberate deviation
 *   from source main); pinned at the end it submits normally,
 * - parking the fullscreen ScrollView at the very top with log-folded rows
 *   left auto-fires loadOlder once through the commands sink (in-flight never
 *   doubles up, re-armed only after the user leaves the top), anchoring the
 *   viewport against the rows restored above,
 * - inline mode has no scroll container: no Enter interception, no loadOlder.
 *
 * Runs with the bare Node test runner (`node --import tsx/esm --test`).
 */
import './redirect-home.js'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { ChatScreen } from '../../src/tui/screens/chat-screen.js'
import type { TuiCommands } from '../../src/tui/commands.js'
import type { ChatViewModel } from '../../src/tui/view-model.js'
import type { TuiController } from '../../src/tui/controller.js'
import type { ChatRow } from '../../src/dsh-adapter/channel.js'
import { stripTerminalSequences, type TUI } from '../../src/tui/public.js'
import { DATA_DIR } from '../../src/utils/paths.js'
import { t } from '../../src/i18n.js'

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function makeViewModel(options: { revision?: number; rows?: readonly ChatRow[] } = {}): ChatViewModel {
  const meta = { revision: options.revision ?? 0, sessionEpoch: 0, generation: 0 } as const
  const mode = { id: 'default', plan: false } as never
  return {
    meta,
    transcript: { meta, rows: options.rows ?? [] },
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
    pluginScene: { meta, active: undefined },
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
    return { meta: { revision: 0, sessionEpoch: 0, generation: 0 }, items: [] } as never
  }

  setViewModel(vm: ChatViewModel): void {
    this.vm = vm
    this.listener?.()
  }
}

interface CommandsHarness {
  commands: TuiCommands
  submitted: string[]
  loadOlderCalls: () => number
}

function makeCommands(loadOlder?: () => Promise<number>): CommandsHarness {
  const submitted: string[] = []
  let loadOlderCalls = 0
  const commands = {
    input: {
      submit: (text: string) => {
        submitted.push(text)
      },
      steer: () => {},
      cancel: () => {},
      interruptAndDeliver: () => 0,
      removePending: () => false,
      runExternalCommand: async () => undefined,
    },
    transcript: {
      loadOlder: () => {
        loadOlderCalls += 1
        return loadOlder !== undefined ? loadOlder() : Promise.resolve(0)
      },
    },
  } as unknown as TuiCommands
  return { commands, submitted, loadOlderCalls: () => loadOlderCalls }
}

function makeChat(
  fullscreen: boolean,
  harness: CommandsHarness = makeCommands(),
): { chat: ChatScreen; controller: FakeController } & CommandsHarness {
  const controller = new FakeController(makeViewModel())
  const chat = new ChatScreen({
    ui: {
      terminal: { columns: 80, rows: 24 },
      requestRender() {},
    } as unknown as TUI,
    commands: harness.commands,
    controller: controller as unknown as TuiController,
    onExit() {},
    fullscreen,
  })
  return { chat, controller, ...harness }
}

function rendered(chat: ChatScreen, width = 80): string {
  return chat.render(width).map(line => stripTerminalSequences(line)).join('\n')
}

function type(chat: ChatScreen, text: string): void {
  for (const char of text) chat.handleInput(char)
}

async function flushMicrotasks(): Promise<void> {
  await new Promise(resolve => setImmediate(resolve))
}

// ---------------------------------------------------------------------------
// Ctrl/Cmd+E — MAX_RENDERED_ROWS fold toggle
// ---------------------------------------------------------------------------

test('Ctrl+E lifts and re-applies the MAX_RENDERED_ROWS fold', () => {
  const { chat } = makeChat(false)
  const rows: ChatRow[] = Array.from({ length: 310 }, (_, index) => ({
    id: index + 1,
    kind: 'notice',
    text: `marker-row-${String(index).padStart(4, '0')}`,
  }))
  chat.update(makeViewModel({ rows }))

  const foldDivider = t('show-previous-messages', { n: 10 }).trim()
  let out = rendered(chat)
  assert.ok(out.includes(foldDivider), 'fold divider advertises ctrl+e')
  assert.ok(!out.includes('marker-row-0000'), 'oldest rows stay folded away')
  assert.ok(out.includes('marker-row-0309'), 'newest rows render')

  chat.handleInput('\x05') // ctrl+e
  out = rendered(chat)
  assert.ok(!out.includes(foldDivider), 'divider lifted')
  assert.ok(out.includes('marker-row-0000'), 'showAll reveals the oldest rows')

  chat.handleInput('\x05') // ctrl+e again
  out = rendered(chat)
  assert.ok(out.includes(foldDivider), 'collapse restores the divider')
  assert.ok(!out.includes('marker-row-0000'), 'oldest rows folded again')

  chat.dispose()
})

// ---------------------------------------------------------------------------
// Ctrl/Cmd+O — verbose expansion toggle
// ---------------------------------------------------------------------------

test('Ctrl+O toggles verbose expansion of settled reasoning rows', () => {
  const { chat } = makeChat(false)
  const rows: ChatRow[] = [
    { id: 1, kind: 'reasoning', text: 'secret-marker-thought', durationMs: 2000 },
  ]
  chat.update(makeViewModel({ rows }))

  let out = rendered(chat)
  assert.ok(!out.includes('secret-marker-thought'), 'settled reasoning stays folded')

  chat.handleInput('\x0f') // ctrl+o
  out = rendered(chat)
  assert.ok(out.includes('secret-marker-thought'), 'verbose reveals the full reasoning')

  chat.handleInput('\x0f') // ctrl+o again
  out = rendered(chat)
  assert.ok(!out.includes('secret-marker-thought'), 'toggle off folds it again')

  chat.dispose()
})

// ---------------------------------------------------------------------------
// Ctrl/Cmd+R — persisted history search in the editor slot
// ---------------------------------------------------------------------------

test('Ctrl+R mounts the history search picker and Enter backfills the editor', () => {
  const { chat } = makeChat(false)
  // loadHistory() reads newest-first from the redirected-home history file.
  mkdirSync(DATA_DIR, { recursive: true })
  writeFileSync(
    join(DATA_DIR, 'history.jsonl'),
    `${JSON.stringify({ text: 'first command', ts: 1 })}\n${JSON.stringify({ text: 'second command', ts: 2 })}\n`,
    'utf8',
  )

  chat.handleInput('\x12') // ctrl+r
  let out = rendered(chat)
  const title = t('history-search-title')
  assert.ok(out.includes(title), 'picker mounts in the editor slot')
  assert.ok(out.includes('second command'), 'newest history entry listed')
  assert.ok(out.indexOf('second command') < out.indexOf('first command'), 'newest first')

  chat.handleInput('\r') // Enter selects the focused (newest) entry
  out = rendered(chat)
  assert.ok(!out.includes(title), 'picker closed after the selection')
  assert.ok(out.includes('second command'), 'the picked text landed in the prompt editor')

  chat.dispose()
})

// ---------------------------------------------------------------------------
// Plain Enter back-to-bottom (fullscreen only)
// ---------------------------------------------------------------------------

test('fullscreen plain Enter off the end returns to the bottom without submitting', () => {
  const { chat, submitted } = makeChat(true)
  const scroll = chat.conversationScrollView
  assert.ok(scroll !== undefined)
  // Content taller than the viewport, pinned at the end (the follow default).
  scroll.updateLayout(1000, 10, () => {})
  assert.equal(scroll.isFollowingEnd, true)

  type(chat, 'draft message')
  scroll.scrollTo(0) // user scrolls up
  assert.equal(scroll.isFollowingEnd, false)

  chat.handleInput('\r') // plain Enter while off the end
  assert.equal(scroll.isFollowingEnd, true, 'Enter scrolled back to the bottom')
  assert.deepEqual(submitted, [], 'the send was blocked (manual §3.5, deliberate deviation)')

  chat.handleInput('\r') // pinned at the end now: the editor owns Enter again
  assert.deepEqual(submitted, ['draft message'], 'Enter submits normally at the bottom')

  chat.dispose()
})

// ---------------------------------------------------------------------------
// Scroll-top auto loadOlder (fullscreen only)
// ---------------------------------------------------------------------------

const FOLDED_ROWS: readonly ChatRow[] = [
  { id: 1, kind: 'assistant', text: 'old folded answer', folded: true },
  { id: 2, kind: 'assistant', text: 'latest answer' },
]

test('scroll-top auto loadOlder fires once, then re-arms only after leaving the top', async () => {
  const { chat, controller, loadOlderCalls } = makeChat(true)
  const scroll = chat.conversationScrollView
  assert.ok(scroll !== undefined)
  const vm = makeViewModel({ rows: FOLDED_ROWS })

  scroll.updateLayout(1000, 10, () => {}) // pinned at the end
  controller.setViewModel(vm) // poll: scrollTop > 0 arms the trigger
  assert.equal(loadOlderCalls(), 0)

  scroll.scrollTo(0) // user parks at the very top
  controller.setViewModel(vm)
  assert.equal(loadOlderCalls(), 1, 'top + folded rows fires loadOlder once')
  await flushMicrotasks()

  controller.setViewModel(vm) // parked at the top: consumed, no auto-drain loop
  controller.setViewModel(vm)
  assert.equal(loadOlderCalls(), 1)

  scroll.scrollTo(5) // leaving the top re-arms
  controller.setViewModel(vm)
  assert.equal(loadOlderCalls(), 1)

  scroll.scrollTo(0) // back at the top: fires again
  controller.setViewModel(vm)
  assert.equal(loadOlderCalls(), 2)
  await flushMicrotasks()

  chat.dispose()
})

test('a second loadOlder never fires while one is in flight', async () => {
  let resolveLoad: ((restored: number) => void) | undefined
  const harness = makeCommands(() => new Promise<number>((resolve) => {
    resolveLoad = resolve
  }))
  const { chat, controller, loadOlderCalls } = makeChat(true, harness)
  const scroll = chat.conversationScrollView
  assert.ok(scroll !== undefined)
  const vm = makeViewModel({ rows: FOLDED_ROWS })

  scroll.updateLayout(1000, 10, () => {})
  controller.setViewModel(vm) // arm
  scroll.scrollTo(0)
  controller.setViewModel(vm) // fire (promise pending now)
  assert.equal(loadOlderCalls(), 1)

  // Leave and return to the top while the first load is still in flight:
  // the re-arm must not double up.
  scroll.scrollTo(5)
  controller.setViewModel(vm)
  scroll.scrollTo(0)
  controller.setViewModel(vm)
  assert.equal(loadOlderCalls(), 1)

  resolveLoad?.(2)
  await flushMicrotasks()

  scroll.scrollTo(5)
  controller.setViewModel(vm)
  scroll.scrollTo(0)
  controller.setViewModel(vm)
  assert.equal(loadOlderCalls(), 2, 'after settle the re-armed trigger fires')

  chat.dispose()
})

test('loadOlder anchors the viewport against the rows restored above', async () => {
  const restoredRow: ChatRow = { id: 1, kind: 'assistant', text: 'short', folded: true }
  const fillerRows: readonly ChatRow[] = [{ id: 2, kind: 'assistant', text: 'filler answer' }]
  const restoredText = Array.from({ length: 20 }, (_, index) => `restored line ${index + 1}`).join('\n')

  const controller = new FakeController(makeViewModel())
  const harness = makeCommands(() => {
    // Mimic the channel: restore the folded row with its much taller full
    // text and emit the new projection synchronously.
    restoredRow.text = restoredText
    restoredRow.folded = false
    restoredRow.restored = true
    controller.setViewModel(makeViewModel({ revision: 1, rows: [restoredRow, ...fillerRows] }))
    return Promise.resolve(1)
  })
  const chat = new ChatScreen({
    ui: {
      terminal: { columns: 80, rows: 24 },
      requestRender() {},
    } as unknown as TUI,
    commands: harness.commands,
    controller: controller as unknown as TuiController,
    onExit() {},
    fullscreen: true,
  })
  const scroll = chat.conversationScrollView
  assert.ok(scroll !== undefined)

  const initialRows: readonly ChatRow[] = [restoredRow, ...fillerRows]
  controller.setViewModel(makeViewModel({ rows: initialRows })) // rows land
  // The fullscreen root render gives the basis-0 conversation no lines, so
  // measure the scroll content directly (this also warms the transcript's
  // render cache, which the anchor re-measures against).
  const heightBefore = scroll.render(80).length
  scroll.updateLayout(1000, 10, () => {}) // pinned at the end
  controller.setViewModel(makeViewModel({ rows: initialRows })) // arm (scrollTop > 0)
  scroll.scrollTo(0)
  controller.setViewModel(makeViewModel({ rows: initialRows })) // fire
  await flushMicrotasks()

  const grown = scroll.render(80).length - heightBefore
  assert.ok(grown > 0, 'the restored row grew the transcript')
  assert.equal(scroll.scrollTop, grown, 'scrollBy compensated exactly the grown height')

  chat.dispose()
})

// ---------------------------------------------------------------------------
// Inline mode: no scroll container, no scroll behavior
// ---------------------------------------------------------------------------

test('inline mode never intercepts Enter and never fires loadOlder', () => {
  const { chat, controller, submitted, loadOlderCalls } = makeChat(false)
  assert.equal(chat.conversationScrollView, undefined)

  controller.setViewModel(makeViewModel({ rows: FOLDED_ROWS }))
  controller.setViewModel(makeViewModel({ rows: FOLDED_ROWS }))
  assert.equal(loadOlderCalls(), 0, 'no scroll container → no loadOlder trigger')

  type(chat, 'inline draft')
  chat.handleInput('\r')
  assert.deepEqual(submitted, ['inline draft'], 'plain Enter reaches the editor inline')

  chat.dispose()
})
