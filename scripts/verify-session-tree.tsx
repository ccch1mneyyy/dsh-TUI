#!/usr/bin/env node
import { buildSessionTree } from '../src/sessions/tree.js'
import type { SessionSummary } from '../src/dsh-adapter/sessions/index.js'
import { createChannel } from '../src/dsh-adapter/channel.js'

let failed = 0
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${detail ? ` (${detail})` : ''}`)
  if (!ok) failed += 1
}

function summary(overrides: Partial<SessionSummary> & Pick<SessionSummary, 'id'>): SessionSummary {
  return {
    id: overrides.id,
    kind: { kind: 'root' },
    title: { text: overrides.id, source: 'auto' },
    cwd: '/repo',
    createdAt: 1,
    updatedAt: 1,
    bytes: 1024,
    hasPrompt: true,
    agentPreset: 'standard',
    model: 'deepseek-chat',
    label: undefined,
    branch: 'main',
    childCount: 0,
    ...overrides,
  }
}

const sessions: SessionSummary[] = [
  summary({ id: 'root', createdAt: 1 }),
  summary({ id: 'branch-a', kind: { kind: 'fork', parent: 'root' }, createdAt: 2 }),
  summary({ id: 'branch-b', kind: { kind: 'fork', parent: 'root' }, createdAt: 4 }),
  summary({ id: 'branch-a-1', kind: { kind: 'fork', parent: 'branch-a' }, createdAt: 3 }),
  summary({ id: 'agent-run', kind: { kind: 'subagent', parent: 'branch-a', depth: 1 }, createdAt: 5 }),
  summary({ id: 'unrelated', createdAt: 6 }),
]

const rows = buildSessionTree(sessions, 'branch-a')
check(
  '只展示当前会话所属的分支树',
  rows.map(row => row.session.id).join(',') === 'root,branch-a,branch-a-1,branch-b',
  rows.map(row => row.session.id).join(','),
)
check(
  '按 lineage 深度缩进',
  rows.map(row => row.depth).join(',') === '0,1,2,1',
  rows.map(row => row.depth).join(','),
)
check('当前节点有明确标记', rows.filter(row => row.current).map(row => row.session.id).join(',') === 'branch-a')
check('子代理不混入会话分支树', rows.every(row => row.session.kind.kind !== 'subagent'))

const orphan = buildSessionTree([
  summary({ id: 'orphan', kind: { kind: 'fork', parent: 'missing' } }),
  summary({ id: 'child', kind: { kind: 'fork', parent: 'orphan' }, createdAt: 2 }),
], 'orphan')
check('父日志缺失时仍能展示可见子树', orphan.map(row => row.session.id).join(',') === 'orphan,child')

const sourceEvents = [
  { seq: 0, time: 1, type: 'turn/start', data: { turn: 0 } },
  { seq: 1, time: 2, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '保留这段历史' }] } },
  { seq: 2, time: 3, type: 'assistant/message', data: { turn: 0, step: 0, message: { role: 'assistant', content: [{ type: 'text', text: '历史回复' }] } } },
  { seq: 3, time: 4, type: 'turn/end', data: { turn: 0, reason: { kind: 'completed' } } },
]
const created: Array<Record<string, unknown>> = []
const makeAgent = (id: string, events: readonly unknown[]) => ({
  id,
  status: 'idle',
  session: { id, seq: events.length, events, header: { cwd: '/repo', agentPreset: 'standard' } },
  ctx: { on: () => () => {} },
  followup() {},
  steer() {},
  inbox: { remove: () => true },
})
const services: Record<string, unknown> = {
  sessions: { fork: (source: { events: readonly unknown[] }) => ({ events: source.events }) },
  agentPresets: {
    defaultId: 'standard',
    list: async () => [{ id: 'standard', trust: 'system' }],
    resolve: async (id = 'standard') => ({ id, trust: 'system' }),
    mount: async () => ({ id: 'standard', trust: 'system' }),
    recompose: async () => ({ id: 'standard', trust: 'system' }),
  },
  agents: {
    async create(options: Record<string, unknown>) {
      created.push(options)
      return { agent: makeAgent(String(options.sessionId), options.seed as readonly unknown[]), dispose: async () => {} }
    },
  },
}
const channel = createChannel({
  get: (name: string) => services[name],
  on: () => () => {},
  logger: { warn() {} },
} as never, makeAgent('source-session', sourceEvents) as never, {
  cwd: '/repo',
  provider: 'deepseek',
  model: 'deepseek-chat',
  agentPreset: 'standard',
  activity: false,
})
const forked = await channel.forkSession()
const createOptions = created[0] as {
  seed?: readonly unknown[]
  meta?: { parentSession?: string; seedLength?: number; agentPreset?: string }
  agentOptions?: { provider?: string; model?: string }
} | undefined
check('fork 会创建并进入新会话', forked && channel.agentId !== 'source-session')
check('fork 保留完整历史', createOptions?.seed === sourceEvents)
check('fork 记录父会话和 seed 长度', createOptions?.meta?.parentSession === 'source-session' && createOptions.meta.seedLength === 4)
check('fork 保留模型与 preset', createOptions?.agentOptions?.model === 'deepseek-chat' && createOptions.meta?.agentPreset === 'standard')

const runningAgent = { ...makeAgent('running-session', sourceEvents), status: 'running' }
const runningHandlers = new Map<string, Array<(...args: unknown[]) => void>>()
const runningChannel = createChannel({
  get: (name: string) => services[name],
  on(event: string, handler: (...args: unknown[]) => void) {
    const handlers = runningHandlers.get(event) ?? []
    handlers.push(handler)
    runningHandlers.set(event, handlers)
    return () => true
  },
  logger: { warn() {} },
} as never, runningAgent as never, {
  cwd: '/repo',
  provider: 'deepseek',
  model: 'deepseek-chat',
  agentPreset: 'standard',
  activity: false,
})
for (const handler of runningHandlers.get('session/event') ?? []) {
  handler(runningAgent.session, { seq: 4, time: 5, type: 'turn/start', data: { turn: 1 } })
}
const createdBeforeRunningFork = created.length
check(
  '运行中的 turn 拒绝 fork',
  !(await runningChannel.forkSession()) && created.length === createdBeforeRunningFork,
)

if (failed > 0) process.exitCode = 1
