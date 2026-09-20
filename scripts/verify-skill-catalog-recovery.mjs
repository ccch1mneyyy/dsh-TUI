/**
 * Skill catalog recovery with real commands/change notifications and a fake
 * clock: last-good caching, non-authoritative observations, bounded retries,
 * recovery, superseded reads, agent swaps and teardown.
 * Run after pnpm build: node scripts/verify-skill-catalog-recovery.mjs
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setImmediate as drain } from 'node:timers/promises'
import { Context } from '@deepseek-ai/cordis'
import { CommandRuntime } from '@deepseek-ai/dsh-commands'
import { createSkillCatalog } from '../lib/types/dsh-adapter/channel/skill-catalog.js'
import { createChannelOwner } from '../lib/types/dsh-adapter/channel/owner.js'

const skill = (name, description = name) => ({ name, description, invocation: { userInvocable: true, modelInvocable: true } })
const good = { skills: [skill('skill-x'), skill('skill-y')], complete: true }
const incomplete = { skills: [], complete: false }

function fixture(t, initial = good) {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const events = new Context()
  const commands = new CommandRuntime(events)
  const owner = createChannelOwner()
  const agentA = { id: 'a', ctx: events }
  const agentB = { id: 'b', ctx: events }
  let agent = agentA
  let read = async () => initial
  let menu = []
  let calls = 0
  let warnings = 0
  let hideSkillDescriptors = false
  const disposePlan = commands.register({ name: 'plan', description: 'Host plan', handler: async () => ({ kind: 'success' }) })
  const catalog = createSkillCatalog({
    on: (event, listener) => events.on(event, listener),
    get: name => name === 'skills' ? { snapshot: options => { calls += 1; return read(options) } } : undefined,
    logger: { warn() { warnings += 1 } },
  }, {
    owner, agent: () => agent, cwd: () => '/tmp', commandDescriptions: () => undefined,
    setCommands(value) { menu = value }, deliverUserText() {},
    commandService: {
      list: target => commands.list(target).filter(entry => !hideSkillDescriptors || entry.name === 'plan'),
      find: (target, name) => commands.find(target, name),
      register: descriptor => commands.register(descriptor),
    },
  })
  t.after(() => { owner.dispose(); catalog.release(); disposePlan() })
  return {
    catalog, owner, agentA, agentB,
    get menu() { return menu }, get calls() { return calls }, get warnings() { return warnings },
    find: name => commands.find(agent, name),
    setAgent(value) { agent = value },
    observe(value) { read = async () => value },
    readWith(value) { read = value },
    hideDescriptors() { hideSkillDescriptors = true },
    async start() { catalog.start(); await drain() },
    async change() { events.emit('skills/change'); await drain() },
    // Drain snapshot promises after each fake-clock step; no wall-clock sleeps.
    async tick(ms) { t.mock.timers.tick(ms); await drain() },
  }
}

const assertSkills = (f, names = ['skill-x', 'skill-y']) => {
  for (const name of names) {
    assert.ok(f.menu.some(entry => entry.name === name), `${name} remains in the menu`)
    assert.equal(typeof f.find(name)?.handler, 'function', `${name} remains callable`)
  }
}

await test('repeated complete reads cache all skills, independently of registered descriptors', async t => {
  const f = fixture(t, { skills: [...good.skills, skill('plan'), skill('help')], complete: true })
  await f.start()
  await f.change()
  assertSkills(f)
  // Exercise the cache, not just a still-populated commands.list(): a missing
  // descriptor must not reveal that last-good was overwritten with a delta.
  f.hideDescriptors()
  f.observe(incomplete)
  f.catalog.refreshCommands()
  await drain()
  assertSkills(f)
  assert.equal(f.menu.filter(entry => entry.name === 'plan').length, 1)
  assert.equal(f.menu.find(entry => entry.name === 'plan').description, 'Host plan')
  assert.equal(f.menu.filter(entry => entry.name === 'help').length, 1)
  assert.notEqual(f.menu.find(entry => entry.name === 'help').skill, true)
  f.readWith(async () => { throw new Error('provider read failed') })
  f.catalog.refreshCommands()
  await drain()
  assertSkills(f)
})

await test('incomplete observations preserve handler identities and retry only at 800/1600/3200ms', async t => {
  const f = fixture(t)
  await f.start()
  await f.change()
  const original = f.find('skill-x')
  // A partial catalog is non-authoritative even for description changes.
  f.observe({ skills: [skill('skill-x', 'partial replacement'), skill('new-skill')], complete: false })
  await f.change()
  assertSkills(f)
  assert.equal(f.find('skill-x'), original)
  assert.equal(f.find('new-skill'), undefined)
  for (const delay of [800, 1600, 3200]) {
    const before = f.calls
    await f.tick(delay - 1)
    assert.equal(f.calls, before, 'no early retry')
    await f.tick(1)
    assert.equal(f.calls, before + 1, 'one registration snapshot per retry')
    assertSkills(f)
    assert.equal(f.find('skill-x'), original)
  }
  const exhausted = f.calls
  await f.tick(60_000)
  assert.equal(f.calls, exhausted, 'no polling after the three-retry budget')
  assertSkills(f)
  f.observe(incomplete)
  await f.change()
  const restarted = f.calls
  await f.tick(800)
  assert.equal(f.calls, restarted + 1, 'skills/change starts a fresh budget')
})

await test('a permanently incomplete cold-start provider stops after three retries', async t => {
  const f = fixture(t, incomplete)
  await f.start()
  const initial = f.calls
  for (const delay of [800, 1600, 3200]) await f.tick(delay)
  assert.equal(f.calls, initial + 3)
  await f.tick(60_000)
  assert.equal(f.calls, initial + 3, 'exhaustion does not require a last-good catalog')
})

await test('cold-start retry recovers without an event, and a later failure has a fresh budget', async t => {
  const f = fixture(t, incomplete)
  await f.start()
  f.observe(good)
  await f.tick(800)
  assertSkills(f)
  const recovered = f.calls
  await f.tick(60_000)
  assert.equal(f.calls, recovered, 'successful recovery leaves no timer')
  f.observe(incomplete)
  await f.change()
  const failedAgain = f.calls
  await f.tick(800)
  assert.equal(f.calls, failedAgain + 1)
  assertSkills(f)
  // Explicit refresh supersedes the queued retry and resets its delay.
  await f.tick(400)
  await f.catalog.refreshSkillCommands()
  const explicit = f.calls
  await f.tick(799)
  assert.equal(f.calls, explicit)
  await f.tick(1)
  assert.equal(f.calls, explicit + 1)
})

await test('complete empty catalogs remove skills and cancel pending retries without stale restoration', async t => {
  const f = fixture(t)
  await f.start()
  await f.change()
  f.observe(incomplete)
  await f.change()
  f.observe({ skills: [], complete: true })
  await f.change()
  for (const name of ['skill-x', 'skill-y']) {
    assert.equal(f.find(name), undefined)
    assert.ok(!f.menu.some(entry => entry.name === name))
  }
  assert.ok(f.find('plan'), 'other command owners survive')
  const complete = f.calls
  await f.tick(60_000)
  assert.equal(f.calls, complete, 'complete observation cancels the pending retry')
  f.observe(incomplete)
  f.catalog.refreshCommands()
  await drain()
  assert.ok(!f.menu.some(entry => entry.name === 'skill-x'), 'complete empty replaced the cache')
})

await test('superseded registration reads cannot remove handlers or rearm retries', async t => {
  const f = fixture(t)
  await f.start()
  for (const stale of [{ skills: [], complete: true }, incomplete, new Error('stale rejection')]) {
    let resolve
    let reject
    f.readWith(() => new Promise((ok, fail) => { resolve = ok; reject = fail }))
    const pending = f.catalog.refreshSkillCommands()
    f.observe(good)
    await f.catalog.refreshSkillCommands()
    const before = f.calls
    const warned = f.warnings
    if (stale instanceof Error) reject(stale)
    else resolve(stale)
    await pending
    await f.tick(60_000)
    assert.equal(f.calls, before)
    assert.equal(f.warnings, warned)
    assertSkills(f)
  }
})

await test('agent switches cancel the old ladder and fence A -> B -> A pending reads', async t => {
  const f = fixture(t)
  await f.start()
  f.observe(incomplete)
  await f.change()
  await f.tick(800)
  f.setAgent(f.agentB)
  await f.catalog.refreshSkillCommands()
  const newAgent = f.calls
  await f.tick(799)
  assert.equal(f.calls, newAgent)
  await f.tick(1)
  assert.equal(f.calls, newAgent + 1, 'new agent starts at the base delay')
  f.setAgent(f.agentA)
  let resolve
  f.readWith(() => new Promise(ok => { resolve = ok }))
  const pending = f.catalog.refreshSkillCommands()
  f.setAgent(f.agentB)
  f.observe(good)
  await f.catalog.refreshSkillCommands()
  f.setAgent(f.agentA)
  await f.catalog.refreshSkillCommands()
  const before = f.calls
  resolve(incomplete)
  await pending
  await f.tick(60_000)
  assert.equal(f.calls, before, 'same agent identity does not revive an old generation')
  assertSkills(f)
})

await test('release cancels the pending retry timer', async t => {
  const f = fixture(t)
  await f.start()
  f.observe(incomplete)
  await f.change()
  f.owner.dispose()
  const disposed = f.calls
  await f.tick(60_000)
  assert.equal(f.calls, disposed)
  assert.equal(f.find('skill-x'), undefined)
})

await test('release prevents pending reads from registering or retrying', async t => {
  const pendingFixture = fixture(t)
  let resolve
  pendingFixture.readWith(() => new Promise(ok => { resolve = ok }))
  const pending = pendingFixture.catalog.refreshSkillCommands()
  pendingFixture.catalog.release()
  const before = pendingFixture.calls
  resolve(good)
  await pending
  await pendingFixture.catalog.refreshSkillCommands()
  await pendingFixture.tick(60_000)
  assert.equal(pendingFixture.calls, before)
  assert.equal(pendingFixture.find('skill-x'), undefined)
})
