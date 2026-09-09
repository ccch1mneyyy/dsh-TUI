/** L4 setup transaction and owner cleanup regressions. */
import assert from 'node:assert/strict'
import { createChannelOwner } from '../src/dsh-adapter/channel/owner.js'
import { createChannelActionReadiness } from '../src/dsh-adapter/channel/action-readiness.js'
import { registerTuiChannel, getRegisteredTuiChannel } from '../src/adapter/channel/host-registry.js'
import { createAgentViewProjection } from '../src/dsh-adapter/channel/agent-view-projection.js'
import { createContextBookkeeping } from '../src/dsh-adapter/channel/context-bookkeeping.js'

// Cleanup is exhaustive: later resources are released even if an earlier
// external unsubscriber throws, and the primary cleanup failure is surfaced.
{
  const owner = createChannelOwner()
  const cleaned: string[] = []
  owner.own(() => { cleaned.push('first'); throw new Error('first cleanup failed') })
  owner.own(() => { cleaned.push('second') })
  assert.throws(() => owner.dispose(), /first cleanup failed/)
  assert.deepEqual(cleaned, ['first', 'second'])
  assert.equal(owner.current(), false)
}

// Registering a cleanup after release invokes it synchronously; setup code can
// therefore use the same ownership primitive at every acquisition step.
{
  const owner = createChannelOwner()
  owner.dispose()
  let calls = 0
  owner.own(() => { calls += 1 })
  assert.equal(calls, 1)
}

// The action cell has no success-shaped placeholder. Before installation and
// after owner release, public delegates must fail instead of returning a fake
// "unavailable" result.
{
  const owner = createChannelOwner()
  const readiness = createChannelActionReadiness()
  const getReadyActions = () => { owner.assertActive(); return readiness.getReadyActions() }
  assert.throws(getReadyActions, /not installed/)
  owner.dispose()
  assert.throws(getReadyActions, /lifetime has ended/)
}

// Registry identity is its registration token, not its Channel object. An old
// same-object registration cannot unregister the current A after A → B → A,
// and an old A cannot revive a retained Port's authority by removing B.
{
  const ctx = {}
  const channelA = {}
  const channelB = {}
  const removeA1 = registerTuiChannel(ctx, channelA)
  const removeB = registerTuiChannel(ctx, channelB)
  const removeA2 = registerTuiChannel(ctx, channelA)
  assert.equal(removeA1(), false)
  assert.equal(getRegisteredTuiChannel(ctx), channelA)
  assert.equal(removeB(), false)
  assert.equal(getRegisteredTuiChannel(ctx), channelA)
  assert.equal(removeA2(), true)
  assert.equal(getRegisteredTuiChannel(ctx), undefined)
}

// The warning latch is one cell shared with projection compact reset: after a
// compaction checkpoint, crossing the high-water mark must warn again.
{
  const warnings: string[] = []
  const state = { contextWindow: 100, tokens: { input: 90 }, pending: [], emit() {} }
  const bookkeeping = createContextBookkeeping(
    () => state,
    text => { warnings.push(text) },
    percent => `remaining ${percent}%`,
    20,
  )
  bookkeeping.checkContextWarning()
  bookkeeping.resetContextWarning()
  bookkeeping.checkContextWarning()
  assert.deepEqual(warnings, ['remaining 10%', 'remaining 10%'])
}

// Agent-view cleanup has independent external subscriptions and background
// handles. A status unsubscriber failure cannot strand the other resources.
{
  const owner = createChannelOwner()
  const attempted: string[] = []
  let backgroundDisposed = 0
  const foreground = { id: 'foreground', session: { id: 'foreground', events: [], header: { createdAt: 0 } } }
  const projection = createAgentViewProjection({
    get(name: string) {
      if (name === 'agents') return { list: () => [], get: () => undefined, create: async () => { throw new Error('unused') } }
      return undefined
    },
    on(name: string) {
      return () => {
        attempted.push(name)
        if (name === 'agent/status') throw new Error('status cleanup failed')
      }
    },
  } as never, {
    owner,
    binding: { agent: foreground, capture: () => undefined, isCurrent: () => true, prepare: async () => { throw new Error('unused') }, abandon() {} } as never,
    cwd: () => '/tmp', provider: 'provider', model: 'model', notify() {}, listPersisted: async () => [],
    createDetached: async () => { throw new Error('unused') }, sessionSwitchVetoed: async () => false,
    adoptLive: async () => ({ ok: false } as never), resumeInto: async () => ({ ok: false } as never),
    backgroundHandles: new Map([['background', { dispose: async () => { backgroundDisposed += 1 } } as never]]),
  })
  projection.start()
  assert.throws(() => owner.dispose(), /status cleanup failed/)
  assert.deepEqual(attempted, ['agent/status', 'agent/created', 'agent/disposed'])
  await Promise.resolve()
  assert.equal(backgroundDisposed, 1)
}

console.log('verify-channel-owner-lifecycle: OK')
