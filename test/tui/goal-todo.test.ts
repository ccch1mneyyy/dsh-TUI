/**
 * M2.2 goal/todo panel tests (research §6.2, plan §1.3):
 * - controller: the bounded GoalTodoProjection slice (content revisions,
 *   structural sharing, session-replacement clearing, fence refresh),
 * - component: render rules (phase badge, blocked reason, working/idle
 *   completed filtering, 8-row truncation, collapsed preview, hidden-when-
 *   nothing-to-narrate) and the component-local elapsed clock (start on
 *   first goal-id appearance, freeze on complete, no timer leaks on clear /
 *   goal-id change / dispose),
 * - screen: ChatScreen dock wiring and the Ctrl/Cmd+Q fold routing.
 *
 * Runs with the bare Node test runner (`node --import tsx/esm --test`).
 */
import './redirect-home.js'
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { GoalTodoView } from '../../src/tui/components/goal-todo.js'
import { ChatScreen } from '../../src/tui/screens/chat-screen.js'
import {
  TuiController,
  type ChannelProjectionSource,
} from '../../src/tui/controller.js'
import type { TuiCommands } from '../../src/tui/commands.js'
import type { GoalTodoProjection } from '../../src/tui/view-model.js'
import type { ChannelGoal, TodoPanelItem } from '../../src/dsh-adapter/channel.js'
import {
  getLayoutNode,
  stripTerminalSequences,
  visibleWidth,
  type StackLayoutNode,
  type TUI,
} from '../../src/tui/public.js'
import { t } from '../../src/i18n.js'
import { modLabel } from '../../src/utils/modifiers.js'

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const meta = { revision: 0, sessionEpoch: 0, generation: 0 } as const

function makeGoal(overrides: Partial<ChannelGoal> = {}): ChannelGoal {
  return {
    id: 'g1',
    revision: 1,
    objective: 'Ship the release',
    phase: 'active',
    maxGoalRounds: 5,
    roundsStarted: 1,
    ...overrides,
  }
}

function todo(content: string, status: TodoPanelItem['status'] = 'pending'): TodoPanelItem {
  return { content, status }
}

function makeProjection(overrides: Partial<GoalTodoProjection> = {}): GoalTodoProjection {
  return { meta, goal: undefined, todos: [], working: false, ...overrides }
}

function makeUi(): { ui: TUI; renders: () => number } {
  let renders = 0
  const ui = {
    terminal: { columns: 80, rows: 24 },
    requestRender() {
      renders += 1
    },
  } as unknown as TUI
  return { ui, renders: () => renders }
}

function renderLines(view: GoalTodoView, width = 80): string[] {
  return view.render(width).map((line) => stripTerminalSequences(line))
}

/** Minimal channel carrying only the goal/todo surface the slice reads. */
class FakeChannel {
  version = 0
  sessionEpoch = 0
  working = false
  goal: ChannelGoal | undefined = undefined
  todos: readonly TodoPanelItem[] = []
  private readonly listeners = new Set<() => void>()

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  subscribeSettingsSections(): () => void {
    return () => {}
  }

  /** Mirrors channel.emit(): the version bumps synchronously, then listeners run. */
  emit(): void {
    this.version += 1
    for (const listener of [...this.listeners]) listener()
  }
}

function makeController(channel: FakeChannel, fenceState: { generation: number }): TuiController {
  const fences = {
    sessionEpoch: () => channel.sessionEpoch,
    generation: () => fenceState.generation,
  }
  const questions = { subscribe: () => () => {}, getSnapshot: () => null }
  return new TuiController({
    channel: channel as unknown as ChannelProjectionSource,
    questions,
    approvals: undefined,
    dialogs: undefined,
    status: undefined,
    fences,
  })
}

// ---------------------------------------------------------------------------
// Controller: bounded projection slice
// ---------------------------------------------------------------------------

test('projection follows goal appear / advance / complete / clear with content revisions', () => {
  const channel = new FakeChannel()
  const fenceState = { generation: 0 }
  const controller = makeController(channel, fenceState)

  const empty = controller.getGoalTodo()
  assert.equal(empty.goal, undefined)
  assert.deepEqual(empty.todos, [])
  assert.deepEqual(empty.meta, { revision: 0, sessionEpoch: 0, generation: 0 })

  // Goal appears (goal/change fold) together with a todo/write snapshot.
  channel.goal = makeGoal()
  channel.todos = [todo('Prepare the release notes', 'completed'), todo('Cut the tag', 'in_progress')]
  channel.working = true
  channel.emit() // v1
  const appeared = controller.getGoalTodo()
  assert.equal(appeared.goal?.id, 'g1')
  assert.equal(appeared.todos, channel.todos) // shared by reference, never copied
  assert.equal(appeared.working, true)
  assert.equal(appeared.meta.revision, 1)

  // An unrelated version bump reuses the slice (structural sharing).
  channel.emit() // v2
  assert.equal(controller.getGoalTodo(), appeared)

  // The goal advances: the channel folds a fresh object under the same id.
  channel.goal = makeGoal({ revision: 2, roundsStarted: 2 })
  channel.emit() // v3
  const advanced = controller.getGoalTodo()
  assert.notEqual(advanced, appeared)
  assert.equal(advanced.goal?.roundsStarted, 2)
  assert.equal(advanced.meta.revision, 3)

  // Complete, then the session replacement shape: goal cleared, todos emptied.
  channel.goal = makeGoal({ revision: 3, phase: 'complete' })
  channel.emit() // v4
  assert.equal(controller.getGoalTodo().goal?.phase, 'complete')
  channel.goal = undefined
  channel.todos = []
  channel.sessionEpoch += 1
  channel.emit() // v5
  const cleared = controller.getGoalTodo()
  assert.equal(cleared.goal, undefined)
  assert.equal(cleared.todos.length, 0)
  assert.equal(cleared.meta.sessionEpoch, 1)

  controller.dispose()
})

test('a fence-only move refreshes sessionEpoch/generation without moving the revision', () => {
  const channel = new FakeChannel()
  const fenceState = { generation: 0 }
  const controller = makeController(channel, fenceState)

  channel.goal = makeGoal()
  channel.emit() // v1
  const before = controller.getGoalTodo()
  assert.equal(before.meta.revision, 1)

  channel.sessionEpoch = 7
  fenceState.generation = 3
  const fenced = controller.getGoalTodo()
  assert.notEqual(fenced, before)
  assert.equal(fenced.meta.revision, 1)
  assert.equal(fenced.meta.sessionEpoch, 7)
  assert.equal(fenced.meta.generation, 3)
  // Same content: the goal reference rides through unchanged.
  assert.equal(fenced.goal, before.goal)

  controller.dispose()
})

// ---------------------------------------------------------------------------
// Component: render rules
// ---------------------------------------------------------------------------

test('empty projection renders nothing and the dock entry stays hidden', () => {
  const { ui } = makeUi()
  const view = new GoalTodoView(ui, makeProjection())
  assert.equal(view.visible, false)
  assert.deepEqual(view.render(80), [])
  view.dispose()
})

test('goal block renders objective, phase badge, rounds and elapsed', () => {
  const { ui } = makeUi()
  const view = new GoalTodoView(ui, makeProjection({ goal: makeGoal(), working: true }))
  assert.equal(view.visible, true)
  const out = renderLines(view).join('\n')
  assert.ok(out.includes('🎯'), out)
  assert.ok(out.includes('Ship the release'), out)
  assert.ok(out.includes('● active · 1/5'), out)
  assert.ok(out.includes('0s'), out)
  view.dispose()
})

test('blocked goal adds the reason line', () => {
  const { ui } = makeUi()
  const view = new GoalTodoView(ui, makeProjection({
    goal: makeGoal({
      phase: 'blocked',
      blockedReason: { code: 'stuck', message: 'Waiting on the deploy window' },
    }),
    working: true,
  }))
  const out = renderLines(view).join('\n')
  assert.ok(out.includes('⛔ blocked'), out)
  assert.ok(out.includes('│ Waiting on the deploy window'), out)
  view.dispose()
})

test('complete goal renders the dimmed complete badge', () => {
  const { ui } = makeUi()
  const view = new GoalTodoView(ui, makeProjection({
    goal: makeGoal({ phase: 'complete', roundsStarted: 5 }),
    working: false,
  }))
  const out = renderLines(view).join('\n')
  assert.ok(out.includes('✓ complete · 5/5'), out)
  view.dispose()
})

test('working shows completed rows; idle filters them but keeps the done count', () => {
  const { ui } = makeUi()
  const todos = [
    todo('Prepare the release notes', 'completed'),
    todo('Cut the tag', 'in_progress'),
    todo('Announce on Slack', 'pending'),
  ]
  const view = new GoalTodoView(ui, makeProjection({ todos, working: true }))
  let out = renderLines(view).join('\n')
  assert.ok(out.includes('✓ 1/3'), out)
  assert.ok(out.includes('Prepare the release notes'), out)
  assert.ok(out.includes('Cut the tag'), out)

  view.update(makeProjection({ todos, working: false }))
  out = renderLines(view).join('\n')
  assert.ok(out.includes('✓ 1/3'), out)
  assert.ok(!out.includes('Prepare the release notes'), out)
  assert.ok(out.includes('Cut the tag'), out)
  assert.ok(out.includes('Announce on Slack'), out)
  view.dispose()
})

test('no goal and an all-completed list hides the panel once idle, shows it while working', () => {
  const { ui } = makeUi()
  const todos = [todo('Done A', 'completed'), todo('Done B', 'completed')]
  const view = new GoalTodoView(ui, makeProjection({ todos, working: true }))
  assert.equal(view.visible, true)
  assert.ok(renderLines(view).join('\n').includes('✓ 2/2'))

  view.update(makeProjection({ todos, working: false }))
  assert.equal(view.visible, false)
  assert.deepEqual(view.render(80), [])
  view.dispose()
})

test('more than eight todos truncate to 8 rows plus the overflow line', () => {
  const { ui } = makeUi()
  const todos = Array.from({ length: 10 }, (_, index) => todo(`Task ${index + 1}`))
  const view = new GoalTodoView(ui, makeProjection({ todos, working: false }))
  const lines = renderLines(view)
  const out = lines.join('\n')
  assert.ok(out.includes('Task 8'), out)
  assert.ok(!out.includes('Task 9'), out)
  assert.ok(out.includes('… 2 more'), out)
  // Blank pad + fold header + 8 rows + overflow + fold hint.
  assert.equal(lines.length, 1 + 1 + 8 + 1 + 1)
  view.dispose()
})

test('collapsed folds to the summary header plus the in-progress preview', () => {
  const { ui } = makeUi()
  const todos = [
    todo('Prepare the release notes', 'completed'),
    todo('Cut the tag', 'in_progress'),
    todo('Announce on Slack', 'pending'),
  ]
  const view = new GoalTodoView(ui, makeProjection({ todos, working: true }))
  view.setCollapsed(true)
  const lines = renderLines(view)
  const out = lines.join('\n')
  assert.ok(out.includes('▸ ✓ 1/3'), out)
  assert.ok(out.includes('● Cut the tag'), out)
  assert.ok(!out.includes('Announce on Slack'), out)
  assert.ok(!out.includes('▾'), out)

  view.setCollapsed(false)
  const expanded = renderLines(view).join('\n')
  assert.ok(expanded.includes('▾ ✓ 1/3'), expanded)
  assert.ok(expanded.includes(t('goal-todo-fold-hint', { mod: modLabel })), expanded)
  view.dispose()
})

test('every rendered row fits the requested width', () => {
  const { ui } = makeUi()
  const view = new GoalTodoView(ui, makeProjection({
    goal: makeGoal({ objective: 'A very long objective that cannot possibly fit into a narrow dock row' }),
    todos: [todo('A very long task line that also has to be truncated to the dock width', 'in_progress')],
    working: true,
  }))
  for (const line of view.render(30)) {
    assert.ok(visibleWidth(line) <= 30, `row too wide (${visibleWidth(line)}): ${stripTerminalSequences(line)}`)
  }
  view.dispose()
})

// ---------------------------------------------------------------------------
// Component: elapsed clock lifecycle (fake timers)
// ---------------------------------------------------------------------------

test('elapsed clock ticks while live, freezes on complete, stops on clear, leaks nothing', (context) => {
  context.mock.timers.enable({ apis: ['setInterval', 'Date'], now: 1_000_000 })
  const { ui, renders } = makeUi()
  const view = new GoalTodoView(ui, makeProjection())
  // No goal: no clock at all — a tick must not repaint.
  context.mock.timers.tick(2000)
  assert.equal(renders(), 0)

  view.update(makeProjection({ goal: makeGoal(), working: true })) // renders=1
  context.mock.timers.tick(1000) // interval fires once
  assert.equal(renders(), 2)
  assert.ok(renderLines(view).join('\n').includes('1s'))
  context.mock.timers.tick(2000)
  assert.equal(renders(), 4)
  assert.ok(renderLines(view).join('\n').includes('3s'))

  // Complete freezes the last reading and stops the timer.
  view.update(makeProjection({ goal: makeGoal({ revision: 2, phase: 'complete' }), working: false }))
  const frozen = renderLines(view).join('\n')
  assert.ok(frozen.includes('✓ complete'), frozen)
  assert.ok(frozen.includes('3s'), frozen)
  const afterFreeze = renders()
  context.mock.timers.tick(5000)
  assert.equal(renders(), afterFreeze) // no repaint without a live goal
  assert.ok(renderLines(view).join('\n').includes('3s'))

  // Session replacement (goal cleared) leaves no timer and no elapsed.
  view.update(makeProjection())
  const afterClear = renders()
  context.mock.timers.tick(3000)
  assert.equal(renders(), afterClear)

  view.dispose()
  context.mock.timers.tick(1000)
  assert.equal(renders(), afterClear)
})

test('a goal-id change restarts the elapsed base; dispose kills a live clock', (context) => {
  context.mock.timers.enable({ apis: ['setInterval', 'Date'], now: 1_000_000 })
  const { ui, renders } = makeUi()
  const view = new GoalTodoView(ui, makeProjection({ goal: makeGoal(), working: true }))
  context.mock.timers.tick(4000)
  assert.ok(renderLines(view).join('\n').includes('4s'))

  // New goal id: the base restarts and only one interval keeps running —
  // tick 1s advances the reading by exactly one second.
  view.update(makeProjection({ goal: makeGoal({ id: 'g2' }), working: true }))
  assert.ok(renderLines(view).join('\n').includes('0s'))
  const beforeTick = renders()
  context.mock.timers.tick(1000)
  assert.equal(renders(), beforeTick + 1)
  assert.ok(renderLines(view).join('\n').includes('1s'))

  const beforeDispose = renders()
  view.dispose()
  context.mock.timers.tick(5000)
  assert.equal(renders(), beforeDispose)
})

// ---------------------------------------------------------------------------
// Screen: dock wiring and the Ctrl/Cmd+Q fold
// ---------------------------------------------------------------------------

const screenMeta = meta

function makeScreenViewModel(): Parameters<ChatScreen['update']>[0] {
  const mode = { id: 'default', plan: false } as never
  return {
    meta: screenMeta,
    transcript: { meta: screenMeta, rows: [] },
    statusLine: {
      meta: screenMeta,
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
      meta: screenMeta,
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
      meta: screenMeta,
      whale: false,
      model: 'test-model',
      reasoningEffort: undefined,
      displayCwd: '/repo',
      loadedContext: undefined,
    },
    prompt: {
      meta: screenMeta,
      pending: [],
      notifications: [],
      commandList: [],
      reasoningEffort: undefined,
      effortLevels: undefined,
      working: false,
      mode,
    },
    overlays: {
      meta: screenMeta,
      question: null,
      approval: null,
      dialog: null,
      statusEntries: [],
    },
    pluginScene: { meta: screenMeta, active: undefined },
    agentId: 'agent-1',
    cwd: '/repo',
    gitBranch: 'main',
    provider: 'test-provider',
    scrollGutter: 'timeline',
  }
}

class FakeScreenController {
  goalTodo: GoalTodoProjection = makeProjection()
  private readonly vm = makeScreenViewModel()

  subscribe(): () => void {
    return () => {}
  }

  getChat(): ReturnType<typeof makeScreenViewModel> {
    return this.vm
  }

  getSubagents(): never {
    return { meta: screenMeta, items: [] } as never
  }

  getGoalTodo(): GoalTodoProjection {
    return this.goalTodo
  }
}

function makeChat(fullscreen: boolean): { chat: ChatScreen; controller: FakeScreenController } {
  const { ui } = makeUi()
  const controller = new FakeScreenController()
  const chat = new ChatScreen({
    ui,
    commands: {} as TuiCommands,
    controller: controller as never,
    onExit() {},
    fullscreen,
  })
  return { chat, controller }
}

test('chat screen docks the panel under the working row and routes Ctrl+Q to the fold', () => {
  const { chat, controller } = makeChat(false)
  controller.goalTodo = makeProjection({
    goal: makeGoal(),
    todos: [todo('Cut the tag', 'in_progress'), todo('Announce on Slack', 'pending')],
    working: true,
  })
  chat.update(controller.getChat())
  let out = chat.render(80).map((line) => stripTerminalSequences(line)).join('\n')
  assert.ok(out.includes('🎯'), out)
  assert.ok(out.includes('▾ ✓ 0/2'), out)

  // Ctrl+Q folds the todo section; the collapsed line keeps the preview.
  chat.handleInput('\x11')
  out = chat.render(80).map((line) => stripTerminalSequences(line)).join('\n')
  assert.ok(out.includes('▸ ✓ 0/2'), out)
  assert.ok(out.includes('● Cut the tag'), out)
  assert.ok(!out.includes('Announce on Slack'), out)

  chat.handleInput('\x11')
  out = chat.render(80).map((line) => stripTerminalSequences(line)).join('\n')
  assert.ok(out.includes('▾ ✓ 0/2'), out)
  assert.ok(out.includes('Announce on Slack'), out)

  chat.dispose()
})

test('fullscreen dock layout contains the goal/todo entry', () => {
  const { chat, controller } = makeChat(true)
  controller.goalTodo = makeProjection({ goal: makeGoal(), working: true })
  chat.update(controller.getChat())

  const root = getLayoutNode(chat)
  assert.equal(root?.type, 'vstack')
  // M4b root: VStack(stickyHeader, conversationRow, dock) — the dock is the
  // third entry now.
  const dock = (root as StackLayoutNode).entries[2]?.component
  const dockNode = dock === undefined ? undefined : getLayoutNode(dock)
  assert.equal(dockNode?.type, 'vstack')
  const entries = (dockNode as StackLayoutNode).entries
  assert.ok(entries.some((entry) => entry.component instanceof GoalTodoView))
  // The dock predicate tracks the panel's own visibility rule.
  const entry = entries.find((item) => item.component instanceof GoalTodoView)
  assert.equal(entry?.visible?.({ width: 80, height: 24 }), true)

  chat.dispose()
})
