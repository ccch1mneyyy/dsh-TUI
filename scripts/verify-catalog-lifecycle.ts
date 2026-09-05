/** Focused lifecycle regression: deferred command authorization and skill ownership. */
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { createExternalCommandInvoker } from '../src/dsh-adapter/channel/external-commands.js'
import { createSkillCatalog } from '../src/dsh-adapter/channel/skill-catalog.js'
import { createChannelOwner } from '../src/dsh-adapter/channel/owner.js'
import { stampCommandOwner } from '../src/dsh-adapter/command-attribution.js'

const deferred = <T>() => {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail })
  return { promise, resolve, reject }
}

const agentA = { id: 'a', ctx: {} } as never
const agentB = { id: 'b', ctx: {} } as never
const runtime = { mode: 'legacy', slices: [] }

// Image awaits must re-read grants and reject a same-name replacement before execute.
{
  const ctx = new Context()
  const image = deferred<{ data: Uint8Array }>()
  let current: object
  let allowed = true
  let executions = 0
  const definition = { name: 'photo', input: { images: true }, handler() {} }
  current = definition
  stampCommandOwner(ctx, definition, { componentId: 'owner-a', activationId: 'activation-a' }, 'owner-a.photo')
  const service = {
    find: () => current,
    execute(_agent: unknown, _line: string, _images: unknown, _signal: AbortSignal) { executions += 1; return Promise.resolve({ result: { text: 'executed' } }) },
  }
  const invoke = createExternalCommandInvoker(ctx, {
    commandService: service as never, runtime, agent: () => agentA, capture: () => 'binding', bindingCurrent: () => true,
    allows: () => allowed, stagedImages: () => new Map([['[image]', { mediaType: 'image/png', name: 'image' }]]),
    attachments: () => ({ readImage: () => image.promise }), notify: () => {},
  }).invoke
  const pending = invoke('photo', ' [image]')
  allowed = false
  image.resolve({ data: new Uint8Array([1]) })
  assert.notEqual(await pending, undefined, 'revocation should report authorization denial')
  assert.equal(executions, 0, 'revoked grant must prevent execute after image await')

  allowed = true
  const replacementImage = deferred<{ data: Uint8Array }>()
  const replacementInvoke = createExternalCommandInvoker(ctx, {
    commandService: service as never, runtime, agent: () => agentA, capture: () => 'binding', bindingCurrent: () => true,
    allows: () => allowed, stagedImages: () => new Map([['[image]', { mediaType: 'image/png', name: 'image' }]]),
    attachments: () => ({ readImage: () => replacementImage.promise }), notify: () => {},
  }).invoke
  const replacementPending = replacementInvoke('photo', ' [image]')
  current = { name: 'photo', input: { images: true }, handler() {} }
  replacementImage.resolve({ data: new Uint8Array([1]) })
  assert.equal(await replacementPending, undefined)
  assert.equal(executions, 0, 'replacement handler must not inherit prior authorization')
}

// Both success and failure completion paths must be fenced before exposing output.
for (const failure of [false, true]) {
  const ctx = new Context()
  const completion = deferred<{ result: { text: string } }>()
  const started = deferred<void>()
  let bound = true
  const definition = { name: 'plain', handler() {} }
  const service = {
    find: () => definition,
    execute() { started.resolve(); return completion.promise },
  }
  const invoke = createExternalCommandInvoker(ctx, {
    commandService: service as never, runtime, agent: () => agentA, capture: () => 'binding', bindingCurrent: () => bound,
    allows: () => true, stagedImages: () => new Map(), attachments: () => undefined, notify: () => { throw new Error('stale completion notified') },
  }).invoke
  const pending = invoke('plain', '')
  await started.promise
  bound = false
  if (failure) completion.reject(new Error('OLD ERROR'))
  else completion.resolve({ result: { text: 'OLD RESULT' } })
  assert.equal(await pending, undefined, `${failure ? 'failed' : 'successful'} stale execution must be silent`)
}

const skill = { name: 'skill-x', description: 'skill', invocation: { userInvocable: true }, content: 'BODY' }
const makeCatalog = (options: { throwSecondListener?: boolean } = {}) => {
  const owner = createChannelOwner()
  let currentAgent = agentA
  const handlers = new Map<string, (() => void)[]>()
  let registrations = 0
  let releases = 0
  let lists = 0
  let published = 0
  let delivered = 0
  let hasSkillTool = true
  let skillGets = 0
  const commandService = {
    list: () => { lists += 1; return [] },
    find: () => undefined,
    register(descriptor: { name: string; handler: unknown }) { registrations += 1; return () => { releases += 1 } },
  }
  let onCount = 0
  const ctx = {
    on(event: string, handler: () => void) {
      onCount += 1
      if (options.throwSecondListener && onCount === 2) throw new Error('second listener failed')
      const values = handlers.get(event) ?? []
      values.push(handler)
      handlers.set(event, values)
      return () => {
        releases += 1
        handlers.set(event, (handlers.get(event) ?? []).filter(value => value !== handler))
      }
    },
    get(name: string) {
      if (name === 'tools') return { get: () => hasSkillTool ? {} : undefined }
      if (name === 'skills') return { snapshot: async () => ({ skills: [skill], complete: true }), get: async () => { skillGets += 1; return skill } }
      return undefined
    },
    logger: { warn() {} },
  }
  const catalog = createSkillCatalog(ctx as never, {
    owner, commandService: commandService as never, agent: () => currentAgent, cwd: () => '/tmp',
    setCommands: () => { published += 1 }, commandDescriptions: () => undefined,
    deliverUserText: () => { delivered += 1 },
  })
  return {
    owner, handlers, commandService, catalog, setAgent(agent: typeof agentA) { currentAgent = agent }, setSkillTool(value: boolean) { hasSkillTool = value },
    counts: () => ({ registrations, releases, lists, published, delivered, skillGets }),
  }
}

// Handler ownership is checked before the tool fast path, and retained handlers
// cannot deliver to a later agent or a disposed Channel.
{
  const direct = makeCatalog()
  const captures: { handler?: (input: { agent: unknown; rawInput: string; signal?: AbortSignal }) => Promise<{ kind: string }> }[] = []
  const directRegister = direct.commandService.register
  ;(direct.commandService as never as { register: typeof directRegister }).register = (entry: never) => {
    captures.push(entry as never)
    return directRegister(entry)
  }
  direct.catalog.start()
  await new Promise(resolve => setTimeout(resolve, 0))
  const handler = captures[0]?.handler
  assert.ok(handler, 'skill registration must provide a handler')
  assert.equal((await handler!({ agent: agentB, rawInput: '', signal: undefined })).kind, 'error')
  assert.equal(direct.counts().delivered, 0, 'wrong invoker must not use fast-path delivery')
  direct.setSkillTool(false)
  assert.equal((await handler!({ agent: agentB, rawInput: '', signal: undefined })).kind, 'error')
  assert.equal(direct.counts().skillGets, 0, 'wrong invoker must not read fallback skill content')
  direct.setAgent(agentB)
  assert.equal((await handler!({ agent: agentA, rawInput: '', signal: undefined })).kind, 'error')
  assert.equal(direct.counts().delivered, 0, 'retained handler must not target replacement agent')
  direct.owner.dispose()
  assert.equal((await handler!({ agent: agentB, rawInput: '', signal: undefined })).kind, 'error')
  assert.equal(direct.counts().delivered, 0, 'disposed owner must reject retained handler')
}

// Partial startup rolls back the first listener; retained callbacks after owner
// disposal cannot touch registry services or publish a command list.
{
  const partial = makeCatalog({ throwSecondListener: true })
  assert.throws(() => partial.catalog.start(), /second listener failed/u)
  assert.equal(partial.counts().releases, 1, 'first listener must be rolled back when second registration throws')
  partial.owner.dispose()
  assert.equal(partial.counts().releases, 1, 'rollback cleanup remains idempotent')

  const retained = makeCatalog()
  retained.catalog.start()
  const listener = retained.handlers.get('commands/change')?.[0]
  assert.ok(listener, 'commands/change listener captured')
  retained.owner.dispose()
  const before = retained.counts()
  listener!()
  assert.deepEqual(retained.counts(), before, 'retained refresh callback must not access/publish after disposal')
}

console.log('verify:catalog-lifecycle OK')
