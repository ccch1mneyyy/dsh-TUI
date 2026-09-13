/**
 * Deterministic binding transaction regression.
 *
 * Run: node --import tsx/esm scripts/verify-binding-transaction.ts
 */
import assert from 'node:assert/strict'
import { createChannelBinding } from '../src/dsh-adapter/channel/binding.js'
import { createChannelOwner } from '../src/dsh-adapter/channel/owner.js'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

function agent(id: string) {
  return { id, session: { id: `session-${id}` } } as never
}

function handle(id: string) {
  let disposeCount = 0
  return {
    agent: agent(id),
    async dispose() { disposeCount += 1 },
    get disposeCount() { return disposeCount },
  } as never as { agent: ReturnType<typeof agent>; dispose(): Promise<void>; readonly disposeCount: number }
}

// Deferred preparation never acquires live authority; a rival identity change
// rejects the candidate and releases it exactly once.
{
  const owner = createChannelOwner()
  const binding = createChannelBinding(agent('initial'), undefined, owner)
  const candidate = handle('late')
  const gate = deferred<typeof candidate>()
  const pending = binding.prepare(binding.capture(), () => gate.promise as never)
  binding.switchTo(agent('rival'), undefined, () => undefined)
  gate.resolve(candidate)
  await assert.rejects(pending, /changed during preparation/u)
  assert.equal(candidate.disposeCount, 1)
}

// A returned prepared handle stays owner-owned across an attachment await.
{
  const owner = createChannelOwner()
  const binding = createChannelBinding(agent('initial'), undefined, owner)
  const candidate = handle('attachment-blocked')
  await binding.prepare(binding.capture(), async () => candidate as never)
  owner.dispose()
  assert.equal(candidate.disposeCount, 1)
}

// The adoption tail is an explicit synchronous transaction even with no old
// handle. A tail throw revokes and disposes the new candidate synchronously.
{
  const owner = createChannelOwner()
  const binding = createChannelBinding(agent('initial'), undefined, owner)
  const candidate = handle('tail-throw')
  const capture = binding.capture()
  await binding.prepare(capture, async () => candidate as never)
  assert.throws(() => binding.adopt(candidate as never, capture, () => {
    throw new Error('tail failed')
  }), /tail failed/u)
  assert.equal(candidate.disposeCount, 1, 'no-old-handle tail failure is fail-closed')
  assert.equal(owner.current(), false)
}

// A cleanup callback can revoke the owner. The post-cleanup identity check
// rejects the handoff before candidate authority is written.
{
  const owner = createChannelOwner()
  const binding = createChannelBinding(agent('initial'), undefined, owner)
  const candidate = handle('cleanup-revocation')
  const capture = binding.capture()
  binding.subscribe(() => owner.dispose())
  await binding.prepare(capture, async () => candidate as never)
  assert.throws(() => binding.adopt(candidate as never, capture, () => undefined), /changed before adoption/u)
  assert.equal(binding.agent.id, 'initial')
  assert.equal(candidate.disposeCount, 1)
}

// All cleanup functions run even if one throws; the prepared candidate is
// reclaimed and ordinary owner teardown still does not dispose the baseline
// live handle merely because UI ownership ended.
{
  const owner = createChannelOwner()
  const old = handle('old')
  const binding = createChannelBinding(old.agent as never, old as never, owner)
  let secondCleanup = 0
  binding.subscribe(() => { throw new Error('unsubscribe failed') })
  binding.subscribe(() => { secondCleanup += 1 })
  const candidate = handle('cleanup-throw')
  const capture = binding.capture()
  await binding.prepare(capture, async () => candidate as never)
  assert.throws(() => binding.adopt(candidate as never, capture, () => undefined), /unsubscribe failed/u)
  assert.equal(secondCleanup, 1)
  assert.equal(candidate.disposeCount, 1)
  assert.equal(old.disposeCount, 0, 'pre-handoff cleanup failure preserves baseline live-handle ownership')
}

// Reentrant adoption from cleanup has no successful result and cannot write a
// second identity over the transaction currently being revoked.
{
  const owner = createChannelOwner()
  const binding = createChannelBinding(agent('initial'), undefined, owner)
  const first = handle('first')
  const second = handle('second')
  const capture = binding.capture()
  await binding.prepare(capture, async () => first as never)
  binding.subscribe(() => {
    assert.throws(() => binding.switchTo(second.agent as never, undefined, () => undefined), /handoff is already in progress/u)
  })
  assert.throws(() => binding.adopt(first as never, capture, () => undefined), /changed before adoption/u)
  assert.equal(binding.agent.id, 'initial')
  assert.equal(first.disposeCount, 1)
}

// Explicit disposition is singular: parking retains the previous handle,
// whereas a transaction success without a park instruction disposes it.
{
  const owner = createChannelOwner()
  const old = handle('old')
  const next = handle('next')
  const binding = createChannelBinding(old.agent as never, old as never, owner)
  const capture = binding.capture()
  await binding.prepare(capture, async () => next as never)
  binding.adopt(next as never, capture, (previous, disposition) => {
    assert.equal(previous.handle, old)
    disposition('park')
  })
  assert.equal(old.disposeCount, 0)
  owner.dispose()
  assert.equal(next.disposeCount, 0, 'ordinary owner teardown preserves live-handle ownership')
}

console.log('verify:binding-transaction OK (synchronous adoption/revocation/disposition)')
