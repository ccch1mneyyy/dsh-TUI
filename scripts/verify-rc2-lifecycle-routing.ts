import './lib/fake-home.mjs'
import { Context } from '@deepseek-ai/cordis'
import { createScope, scopeTarget } from '@deepseek-ai/dsh-scope'
import { createChannel } from '../src/dsh-adapter/channel.js'
const catalog = (childId: string, label: string, at: number) => ({type:'subagent/catalog',time:at,data:{version:0,childId,mode:'continuable',label,childCreatedAt:at}})
function makeSwitchHarness(treeRootEvents = false) {
  const ctx = new Context()
  type TestAgent = ReturnType<typeof makeAgent>
  const registry = new Map<string, TestAgent>()
  const scopes: Array<ReturnType<typeof createScope>> = []
  const roots = new Map<object, object>()
  const emit = (subject: object, event: string, ...args: unknown[]) =>
    (ctx as unknown as { emit(...args: unknown[]): void }).emit(scopeTarget({}, subject), event, ...args)
  function makeAgent(id: string, parent?: { session: { id: string } }, registered = true) {
    const agent = {
      id, status: 'running', options: { provider: 'fake-provider', model: 'model-00' }, ctx,
      session: { id, seq: 0, events: [] as unknown[], header: {
        createdAt: Date.now(), cwd: '/tmp/demo',
        ...(parent ? { origin: 'subagent', parentSession: parent.session.id } : {}),
      } },
      followup() {}, steer() {}, cancel() {}, whenIdle: async () => {}, inbox: { remove: () => true },
    }
    const scope = createScope(ctx, agent, parent ? { parent } : undefined)
    scopes.push(scope)
    roots.set(agent, parent === undefined ? agent : roots.get(parent) ?? parent)
    agent.ctx = scope.ctx
    if (registered) registry.set(id, agent)
    return agent
  }
  const handle = (agent: TestAgent) => ({ agent, async dispose() {
    registry.delete(agent.id)
    agent.status = 'disposed'
    emit(agent, 'agent/disposed', { agent })
  } })
  const a = makeAgent('switch-a')
  const b = makeAgent('switch-b')
  const disk = makeAgent('switch-disk', undefined, false)
  ;(ctx as unknown as { provide(name: string, value: unknown): void }).provide('agents', {
    get: (id: string) => registry.get(id), list: () => [...registry.values()],
    create: async ({ sessionId }: { sessionId: string }) => handle(makeAgent(sessionId)),
    resume: async ({ resumeSessionId }: { resumeSessionId: string }) => {
      if (resumeSessionId !== disk.id) throw new Error('unexpected disk resume')
      registry.set(disk.id, disk)
      return handle(disk)
    },
  })
  if (treeRootEvents) (ctx as unknown as { provide(name: string, value: unknown): void }).provide('subagents', {
    rootOf(agent: object) {
      const root = roots.get(agent)
      if (root === undefined) throw new Error('unknown activation')
      return root
    },
  })
  const channel = createChannel(ctx, a as never, {
    model: 'model-00', provider: 'fake-provider', cwd: '/tmp/demo', activity: false, handle: handle(a) as never,
  })
  const event = (agent: TestAgent, input: { type: string; data: unknown; time?: number }) => {
    const value = { time: Date.now(), ...input, seq: agent.session.seq++ }
    agent.session.events.push(value)
    emit(agent, 'session/event', agent.session, value)
    return value
  }
  const start = (parent: TestAgent, id: string, runId: string, local = true) =>
    emit(treeRootEvents ? roots.get(parent)! : parent, 'subagent/start', { id, runId, provider: 'worker', local, ...(treeRootEvents ? { parentSessionId: parent.session.id } : {}) })
  const end = (parent: TestAgent, id: string, runId: string) =>
    emit(treeRootEvents ? roots.get(parent)! : parent, 'subagent/end', { id, runId, stopReason: 'completed', lastAssistantMessage: [{ type: 'text', text: 'done' }], ...(treeRootEvents ? { parentSessionId: parent.session.id } : {}) })
  const child = (parent: TestAgent, id: string) => {
    const result = makeAgent(id, parent)
    event(parent, catalog(id, id, Date.now() - 65_000))
    return result
  }
  const panel = (id: string) => channel.subagents.find(value => value.agentId === id)
  const tool = (agent: TestAgent, id: string) => event(agent, { type: 'tool/call', data: { callId: id, name: 'Read', arguments: '{}' } })
  const result = (agent: TestAgent, id: string) => event(agent, { type: 'tool/result', data: { message: { source: { callId: id }, content: [{ type: 'text', text: 'done' }] } } })
  const frame = (agent: TestAgent, value: object) => emit(agent, 'agent/assistant-stream', { agent, frame: value })
  return { ctx, a, b, disk, registry, makeAgent, channel, emit, event, start, end, child, panel, tool, result, frame,
    async close() { channel.releaseContributions(); for (const scope of scopes) await scope.dispose() },
  }
}

let failures=0
for(const viewed of [false,true]){
 const h=makeSwitchHarness(true)
 try{
  const child=h.child(h.a,'delegating-child')
  if(viewed) await h.channel.resumeTo(child.id)
  h.start(child,'external-grandchild','grandchild-run',false)
  const got=h.panel('external-grandchild')
  const correct=viewed?got?.status==='running':got===undefined
  console.log(JSON.stringify({foreground:viewed?'direct-parent':'ancestor',expected:viewed?'running child row':'no grandchild row',actual:got??null,pass:correct}))
  if(!correct)failures++
 }finally{await h.close()}
}
if(failures)process.exitCode=1

// The same durable root id from an older activation must never authorize delivery.
{
 const h=makeSwitchHarness(true)
 try {
  const child=h.child(h.a,'nested-current')
  await h.channel.resumeTo(child.id)
  const stale={...h.a,session:{...h.a.session}}
  h.emit(stale,'subagent/start',{id:'stale-child',runId:'stale',provider:'worker',parentSessionId:child.id})
  if(h.panel('stale-child')!==undefined)throw new Error('stale root carrier crossed exact ownership fence')
  h.start(child,'live-child','live',false)
  if(h.panel('live-child')?.status!=='running')throw new Error('current root start missing')
  h.end(child,'live-child','live')
  if(h.panel('live-child')?.status==='running')throw new Error('current root end missing')
 } finally {await h.close()}
}
// Pre-rc.2 direct-parent transport remains valid without rootOf or parentSessionId.
{
 const h=makeSwitchHarness(false)
 try {
  h.start(h.a,'legacy-child','legacy',false)
  if(h.panel('legacy-child')?.status!=='running')throw new Error('legacy start missing')
  h.end(h.a,'legacy-child','legacy')
  if(h.panel('legacy-child')?.status==='running')throw new Error('legacy end missing')
 } finally {await h.close()}
}
