/**
 * /resume preflight must give back every uncommitted mount reservation.
 * Real resume action, binding transaction and disk ledger; only the Agent
 * factory and external veto/compaction callbacks are controlled test doubles.
 * No model, credentials, network, or user profile is used.
 * Run: node --import tsx/esm scripts/verify-resume-reservation.ts
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'dsh-tui-resume-reservation-'))
process.env.HOME = home
process.env.USERPROFILE = home
process.env.DSH_HOME = join(home, 'dsh')
process.env.DSH_TUI_LANG = 'en'

const [
  { Context },
  { createSessionResumeActions },
  { createChannelBinding, dshChannelBinding },
  { createChannelOwner },
  { createDshSession },
  { clearOwnMounts, occupancyOf, ownMounts, publishMounts, readSessionOwners },
] = await Promise.all([
  import('@deepseek-ai/cordis'),
  import('../src/dsh-adapter/channel/session-resume.js'),
  import('../src/dsh-adapter/channel/binding.js'),
  import('../src/dsh-adapter/channel/owner.js'),
  import('../src/dsh-adapter/backend/session.js'),
  import('../src/sessionMounts.js'),
])

type Deps = Parameters<typeof createSessionResumeActions>[3]
type Hooks = {
  veto?: Deps['sessionSwitchVetoed']
  compact?: Deps['settleCompaction']
  lookup?: () => ReturnType<Deps['binding']['capture']>['agent'] | undefined
  current?: Deps['binding']['isCurrent']
  open?: () => Promise<void>
}
const targetId = 'resume-target'
const fail = () => { throw new Error('injected preflight failure') }

function fixture(hooks: Hooks = {}) {
  const ctx = new Context()
  const owner = createChannelOwner()
  const makeAgent = (id: string) => ({
    id, status: 'idle', options: {},
    session: { id, seq: 0, events: [], header: { cwd: home, createdAt: 0 } },
    followup() {}, steer() {}, cancel() {}, inbox: { remove: () => true },
    ctx: { on: () => () => undefined },
  })
  const source = makeAgent('resume-source')
  const target = makeAgent(targetId)
  let opens = 0
  let adoptedLive = 0
  const binding = dshChannelBinding(createChannelBinding(createDshSession(ctx, { agent: source as never }), owner))
  if (hooks.current !== undefined) binding.isCurrent = hooks.current
  const provide = (ctx as unknown as { provide(name: string, value: unknown): void }).provide.bind(ctx)
  provide('agents', {
    get: () => hooks.lookup?.(),
    resume: async () => {
      opens += 1
      await hooks.open?.()
      return { agent: target, dispose: async () => undefined }
    },
  })
  const state = {
    rows: [], agentId: source.id, sessionId: source.id, cwd: home,
    displayCwd: home, provider: 'test', model: 'test', status: 'idle', emit() {},
  } as Parameters<typeof createSessionResumeActions>[1]
  const actions = createSessionResumeActions(ctx, state, { provider: 'test', model: 'test' }, {
    owner,
    binding,
    adoptLive: async () => { adoptedLive += 1; return { ok: true } },
    backgroundHandles: new Map(), rowIds: { value: 0 },
    resetProjector() {}, resetSubagents() {}, parkSubagents() {}, resetJobs() {},
    replay() {}, settleReplay() {}, describeWorkspace: () => ({}),
    refreshGitBranch() {}, bindAgent() {}, refreshCommands() {},
    refreshLoadedContext: async () => {}, refreshSkillCommands: async () => {},
    clearStagedImages() {}, resetIdeSelection() {},
    settleCompaction: hooks.compact ?? (async () => {}),
    sessionSwitchVetoed: hooks.veto ?? (async () => false),
    notify() {}, notifySessionSwitched() {},
    runtime: { mode: 'legacy', slices: [] },
  })
  return {
    actions, binding, owner, target,
    get opens() { return opens }, get adoptedLive() { return adoptedLive },
    async close() { owner.dispose(); await ctx.fiber.dispose(); clearOwnMounts() },
  }
}

function assertFree(label: string): void {
  assert.equal(ownMounts().includes(targetId), false, `${label}: no local claim remains`)
  assert.equal(occupancyOf(targetId, readSessionOwners()).kind, 'free', `${label}: the ledger immediately frees the target`)
  assert.equal(publishMounts([]), true)
  assert.equal(readSessionOwners().has(targetId), false, `${label}: the next publisher beat cannot resurrect the pin`)
}

const failures: unknown[] = []
async function test(name: string, run: () => Promise<void>) {
  try { await run(); console.log(`PASS ${name}`) }
  catch (error) { failures.push(error); console.error(`FAIL ${name}`, error) }
  finally { clearOwnMounts() }
}

try {
  for (const stage of ['veto', 'compaction', 'binding recheck', 'registry recheck'] as const) {
    await test(`${stage} throw abandons the reservation`, async () => {
      let checks = 0
      const hooks: Hooks = stage === 'veto' ? { veto: async () => fail() }
        : stage === 'compaction' ? { compact: async () => fail() }
        : stage === 'binding recheck' ? { current: () => ++checks === 1 ? true : fail() }
        : { lookup: () => ++checks === 1 ? undefined : fail() }
      const f = fixture(hooks)
      try {
        await assert.rejects(f.actions.resumeTo(targetId), /injected preflight failure/)
        assert.equal(f.opens, 0, 'preflight failure never opens a writer')
        assertFree(stage)
        assert.equal(f.binding.agent.id, 'resume-source', 'the foreground is unchanged')
      } finally { await f.close() }
    })
  }

  for (const stage of ['veto', 'compaction'] as const) {
    await test(`${stage} await holds through publisher beats, then releases on failure`, async () => {
      const entered = Promise.withResolvers<void>()
      const gate = Promise.withResolvers<void>()
      const wait = async () => { entered.resolve(); await gate.promise; return false }
      const f = fixture(stage === 'veto' ? { veto: wait } : { compact: async () => { await wait() } })
      try {
        const pending = f.actions.resumeTo(targetId)
        await entered.promise
        assert.equal(publishMounts([]), true)
        assert.equal(occupancyOf(targetId, readSessionOwners()).kind, 'mine', 'in-flight claim survives an empty registry beat')
        gate.reject(new Error('injected preflight failure'))
        await assert.rejects(pending, /injected preflight failure/)
        assertFree(stage)
      } finally { await f.close() }
    })
  }

  await test('ordinary veto abandons only a newly acquired claim', async () => {
    const f = fixture({ veto: async () => true })
    try {
      assert.deepEqual(await f.actions.resumeTo(targetId), { ok: false, reason: 'cancelled' })
      assertFree('veto')
      assert.equal(publishMounts([targetId]), true)
      assert.deepEqual(await f.actions.resumeTo(targetId), { ok: false, reason: 'cancelled' })
      assert.equal(occupancyOf(targetId, readSessionOwners()).kind, 'mine', 'a claim owned before this attempt is retained')
    } finally { await f.close() }
  })

  await test('foreground revocation after compaction abandons the claim', async () => {
    const f = fixture({ compact: async () => { f.owner.dispose() } })
    try {
      assert.deepEqual(await f.actions.resumeTo(targetId), { ok: false, reason: 'cancelled' })
      assertFree('revoked foreground')
      assert.equal(f.opens, 0)
    } finally { await f.close() }
  })

  await test('target appearing during preflight cancels without opening a second writer', async () => {
    let replaced = false
    const f = fixture({ compact: async () => { replaced = true }, lookup: () => replaced ? f.target as never : undefined })
    try {
      assert.deepEqual(await f.actions.resumeTo(targetId), { ok: false, reason: 'cancelled' })
      assert.equal(f.opens, 0)
      assert.equal(f.adoptedLive, 0)
      assertFree('registry replacement')
    } finally { await f.close() }
  })

  for (const errorName of ['SessionAlreadyOwnedError', 'SessionFormatError', 'Error']) {
    await test(`writer error ${errorName} preserves classification and releases the reservation`, async () => {
      let locked = true
      const failure = new Error('SessionAlreadyOwnedError in an unrelated message')
      failure.name = errorName
      const f = fixture({ open: async () => { if (locked) throw failure } })
      try {
        const result = await f.actions.resumeTo(targetId)
        assert.equal(result.ok, false)
        if (result.ok || result.reason !== 'failed') throw new Error('Expected the compatible failed result')
        if (errorName === 'SessionAlreadyOwnedError') {
          assert.equal(result.code, 'owned-elsewhere')
          assert.match(result.error, /Release it.*retry resume/)
          assert.doesNotMatch(result.error, /PID|unrelated message/)
        } else {
          assert.equal(result.code, undefined)
          assert.equal(result.error, failure.message, 'format and unrelated errors retain their own diagnostics')
        }
        assertFree(errorName)
        assert.equal(f.binding.agent.id, 'resume-source', 'a writer refusal cannot change the foreground')
        locked = false
        assert.equal((await f.actions.resumeTo(targetId)).ok, true, 'retry succeeds after the real holder releases')
        assert.equal(f.binding.agent.session.id, targetId)
      } finally { await f.close() }
    })
  }

  for (const successful of [false, true]) {
    await test(`disk handoff retains its claim until ${successful ? 'commit' : 'open failure'}`, async () => {
      const entered = Promise.withResolvers<void>()
      const gate = Promise.withResolvers<void>()
      const f = fixture({ open: async () => { entered.resolve(); await gate.promise } })
      try {
        const pending = f.actions.resumeTo(targetId)
        await entered.promise
        assert.equal(publishMounts([]), true)
        assert.equal(occupancyOf(targetId, readSessionOwners()).kind, 'mine', 'outer finally must not release a transferred claim')
        if (successful) gate.resolve()
        else gate.reject(new Error('open failed'))
        const result = await pending
        assert.equal(result.ok, successful)
        if (successful) {
          assert.equal(f.binding.agent.session.id, targetId)
          assert.equal(publishMounts([targetId]), true)
          assert.equal(occupancyOf(targetId, readSessionOwners()).kind, 'mine', 'the committed registry owns the mount')
        }
        assert.equal(publishMounts([]), true)
        assertFree('finished disk handoff')
      } finally { await f.close() }
    })
  }
} finally {
  clearOwnMounts()
  rmSync(home, { recursive: true, force: true })
}
assert.equal(failures.length, 0, `${failures.length} reservation checks failed`)
