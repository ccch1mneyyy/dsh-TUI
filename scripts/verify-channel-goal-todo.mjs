/**
 * Channel-level verification of the goal/todo live state: creates a real
 * Channel via createChannel against a minimal fake ctx/agent, seeds a
 * session log containing `todo/write` and goal-sourced `user/message`
 * events, and asserts the folded `channel.goal`/`channel.todos`. Then fires
 * live events through the captured `session/event` handler and asserts the
 * panel state updates in real time (subscribers notified, version bumped).
 *
 * Run with plain node against the compiled lib: `node scripts/verify-channel-goal-todo.mjs`
 */
import { createChannel } from '../lib/types/channel.js'

let failed = 0
function check(name, ok, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed += 1
}

const now = Date.now()
const handlers = new Map()
const ctx = {
  on(event, handler) {
    handlers.set(event, handler)
    return () => handlers.delete(event)
  },
  get(name) {
    return undefined
  },
  logger: { warn() {} },
}

// ---- seed log: create goal -> todo snapshot -> goal paused -> todo update
const seed = [
  {
    type: 'user/message',
    seq: 1,
    time: now - 4000,
    data: {
      source: {
        kind: 'goal',
        goalId: 'g1',
        revision: 1,
        round: 0,
        change: {
          kind: 'goal/change',
          version: 1,
          operation: 'create',
          goal: {
            id: 'g1',
            revision: 1,
            objective: 'Ship the release',
            phase: 'active',
            maxGoalRounds: 5,
          },
          roundsStarted: 0,
          createdAt: now - 4000,
          updatedAt: now - 4000,
        },
      },
      content: [],
    },
  },
  {
    type: 'todo/write',
    seq: 2,
    time: now - 3000,
    data: { todos: [
      { content: 'Prepare the release notes', status: 'completed' },
      { content: 'Cut the tag', status: 'in_progress' },
    ] },
  },
  {
    type: 'user/message',
    seq: 3,
    time: now - 2000,
    data: {
      source: {
        kind: 'goal',
        goalId: 'g1',
        revision: 2,
        round: 0,
        change: {
          kind: 'goal/change',
          version: 1,
          operation: 'pause',
          goal: {
            id: 'g1',
            revision: 2,
            objective: 'Ship the release',
            phase: 'paused',
            maxGoalRounds: 5,
          },
          roundsStarted: 1,
          createdAt: now - 4000,
          updatedAt: now - 2000,
        },
      },
      content: [],
    },
  },
  {
    type: 'todo/write',
    seq: 4,
    time: now - 1000,
    data: { todos: [
      { content: 'Prepare the release notes', status: 'completed' },
      { content: 'Cut the tag', status: 'completed' },
      { content: 'Announce on Slack', status: 'pending' },
    ] },
  },
]

const agent = {
  id: 'a1',
  status: 'idle',
  session: { id: 's1', seq: 4, events: seed },
  // bindAgent 挂 installModelSelection 需要 agent.ctx 提供"可订阅、返回
  // 解除函数"的最小面（0.3.6 Shift+Tab 推理等级）。
  ctx: { on: () => () => {} },
}

const channel = createChannel(ctx, agent, {
  model: 'deepseek-chat',
  cwd: '/tmp',
  provider: 'deepseek',
  activity: false,
})

// ---- replay fold assertions
check('goal folded from seed', channel.goal?.objective === 'Ship the release' && channel.goal?.phase === 'paused', JSON.stringify(channel.goal))
check('goal revision from last change', channel.goal?.revision === 2)
check('goal roundsStarted from last change', channel.goal?.roundsStarted === 1)
check('goal maxGoalRounds kept', channel.goal?.maxGoalRounds === 5)
check(
  'todos = last whole-list snapshot',
  channel.todos?.length === 3 && channel.todos[2]?.content === 'Announce on Slack' && channel.todos[2]?.status === 'pending',
  JSON.stringify(channel.todos),
)

// ---- live events through the captured session/event handler
const sessionHandler = handlers.get('session/event')
if (sessionHandler === undefined) {
  check('session/event handler captured', false)
} else {
  const session = agent.session
  let notified = 0
  let lastVersion = channel.version
  channel.subscribe(() => { notified += 1 })

  // 1. Goal resumed (revision 3).
  sessionHandler(session, {
    type: 'user/message',
    seq: 5,
    time: now,
    data: {
      source: {
        kind: 'goal',
        goalId: 'g1',
        revision: 3,
        round: 0,
        change: {
          kind: 'goal/change',
          version: 1,
          operation: 'resume',
          goal: {
            id: 'g1',
            revision: 3,
            objective: 'Ship the release',
            phase: 'active',
            maxGoalRounds: 5,
          },
          roundsStarted: 1,
          createdAt: now - 4000,
          updatedAt: now,
        },
      },
      content: [],
    },
  })
  check('live resume updates phase', channel.goal?.phase === 'active' && channel.goal?.revision === 3)
  check('subscriber notified after goal change', notified === 1)
  check('version bumped after goal change', channel.version > lastVersion)
  lastVersion = channel.version

  // 2. Todo snapshot updated live.
  sessionHandler(session, {
    type: 'todo/write',
    seq: 6,
    time: now + 1,
    data: { todos: [
      { content: 'Cut the tag', status: 'completed' },
      { content: 'Announce on Slack', status: 'in_progress' },
    ] },
  })
  check('live todo/write replaces the list', channel.todos?.length === 2 && channel.todos[1]?.status === 'in_progress')
  check('subscriber notified after todo write', notified === 2)

  // 3. Positive-round continuation prompt advances roundsStarted only.
  sessionHandler(session, {
    type: 'user/message',
    seq: 7,
    time: now + 2,
    data: {
      source: { kind: 'goal', goalId: 'g1', revision: 3, round: 2 },
      content: [],
    },
  })
  check('continuation round advances roundsStarted', channel.goal?.roundsStarted === 2 && channel.goal?.revision === 3)

  // 4. Clear tombstone removes the goal.
  sessionHandler(session, {
    type: 'user/message',
    seq: 8,
    time: now + 3,
    data: {
      source: {
        kind: 'goal',
        goalId: 'g1',
        revision: 4,
        round: 0,
        change: {
          kind: 'goal/change',
          version: 1,
          operation: 'clear',
          cleared: { id: 'g1', revision: 4 },
          clearedAt: now + 3,
        },
      },
      content: [],
    },
  })
  check('clear removes the goal', channel.goal === undefined)

  // 5. Non-goal injected context must not disturb the projection.
  sessionHandler(session, {
    type: 'user/message',
    seq: 9,
    time: now + 4,
    data: { source: { kind: 'plugin', plugin: 'skills' }, content: [] },
  })
  check('non-goal injected message ignored', channel.goal === undefined && channel.todos?.length === 2)
}

process.exit(failed)
