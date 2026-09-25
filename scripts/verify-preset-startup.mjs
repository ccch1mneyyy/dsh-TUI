/**
 * Real Loader + preset registry through the public TUI entry. Replace only the
 * terminal runtime with a preset consumer; no model, credentials or user state.
 * Run after build: node scripts/verify-preset-startup.mjs
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AgentPresetRegistry from '@deepseek-ai/dsh-agent-preset-registry'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { composePreset } from '../lib/types/dsh-adapter/presets.js'
import { settled } from './lib/term-test.mjs'

const fixtureKey = Symbol.for('dsh-tui.verify-preset-startup')
const runtimeUrl = new URL('../lib/types/dsh-adapter/plugin.js', import.meta.url).href
const hooks = registerHooks({
  load(url, context, nextLoad) {
    if (url !== runtimeUrl) return nextLoad(url, context)
    return { format: 'module', shortCircuit: true, source: `
      const fixture = globalThis[Symbol.for('dsh-tui.verify-preset-startup')]
      export const apply = (...args) => fixture.start(...args)
      export const handleStartupError = (...args) => fixture.fail(...args)
    ` }
  },
})
const fixture = { start() {}, fail() {} }
globalThis[fixtureKey] = fixture
const entry = await import('../lib/types/dsh-adapter/index.js')

async function runtime() {
  const ctx = new Context()
  ctx.baseUrl = new URL('../cordis.patch.yml', import.meta.url).href
  ctx.provide('agents', {}) // The stubbed terminal never creates a model Agent.
  await ctx.plugin(Loader)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentPresetRegistry, { default: 'fixture' })
  ctx.loader.builtins.frontend = entry
  ctx.loader.builtins.pending = { inject: ['fixtureDependency'], apply() {} }
  await ctx.agentPresets.register({ id: 'fixture', plugins: [{ id: 'pending', name: 'cordis:pending' }] })
  return ctx
}

try {
  for (const dependency of ['missing', 'ready', 'late']) {
    const ctx = await runtime()
    const available = dependency !== 'missing'
    const errors = []
    let completed = false
    let released = false
    let owner
    if (dependency === 'ready') ctx.provide('fixtureDependency', {})
    const providerGate = Promise.withResolvers()
    let providerStarted = false
    ctx.loader.builtins.provider = async child => {
      providerStarted = true
      await providerGate.promise
      child.provide('fixtureDependency', {})
    }
    fixture.start = async (child, config, configOwner) => {
      owner = configOwner
      child.effect(() => () => { released = true })
      const composition = await composePreset(child, 'fixture')
      assert.equal(child.agents, ctx.agents, 'runtime inherits the Host row dependencies')
      const resolved = await child.get('agentPresets').resolve(composition.agentPreset)
      if (resolved.broken !== undefined) throw new Error(resolved.broken)
      completed = true
    }
    fixture.fail = (_ctx, error) => errors.push(error)
    await ctx.loader.root.update([
      { id: 'frontend', name: 'cordis:frontend' },
      ...(dependency === 'late' ? [{ id: 'provider', name: 'cordis:provider' }] : []),
    ])
    if (dependency === 'late') {
      assert.ok(await settled(() => providerStarted))
      assert.equal(owner, undefined, 'runtime waits for Host providers before resolving presets')
      providerGate.resolve()
    }
    // The timeout is an assertion bound, not a sleep-based readiness guess.
    assert.ok(await settled(() => completed || errors.length > 0),
      `startup must settle with dependency ${dependency}`)
    await ctx.loader.await()
    assert.equal(owner, [...ctx.loader.entries()][0].fiber.ctx, 'retain the Loader Config owner')
    assert.equal(completed, available)
    assert.equal(errors.length, available ? 0 : 1)
    if (!available) assert.match(errors[0].message, /waiting for fixtureDependency/u)
    await ctx.fiber.dispose()
    assert.equal(released, true, 'runtime effects belong to Cordis teardown')
  }

  // Disposing the Loader entry before its activation settles must cancel the
  // deferred runtime, rather than mount an orphan after a recompose.
  const ctx = await runtime()
  let started = false
  const errors = []
  fixture.start = async () => { started = true }
  fixture.fail = (_ctx, error) => errors.push(error)
  ctx.loader.builtins.cancelled = {
    async apply(owner) {
      await entry.apply(owner, {})
      void owner.fiber.dispose()
    },
  }
  await ctx.loader.root.update([{ id: 'cancelled', name: 'cordis:cancelled' }])
  await ctx.loader.await()
  assert.equal(started, false)
  assert.deepEqual(errors, [])
  await ctx.fiber.dispose()

  // Exercise the real error funnel in a subprocess: it must restore terminal
  // modes, report the failure, dispose Cordis effects, and exit nonzero.
  const home = mkdtempSync(join(tmpdir(), 'dsh-tui-startup-'))
  try {
    const failed = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { Context } from '@deepseek-ai/cordis'
      import { handleStartupError } from ${JSON.stringify(runtimeUrl)}
      const ctx = new Context()
      ctx.effect(() => () => { process.stderr.write('fixture disposed\\n') })
      handleStartupError(ctx, new Error('fixture startup failure'))
    `], { encoding: 'utf8', timeout: 10000, env: { ...process.env, HOME: home, USERPROFILE: home, DSH_HOME: home } })
    assert.equal(failed.error, undefined)
    assert.equal(failed.status, 1, failed.stderr)
    assert.match(failed.stderr, /dsh-tui startup failed: fixture startup failure/u)
    assert.match(failed.stderr, /fixture disposed/u)
    assert.ok(failed.stdout.includes('\u001b[?1049l'), 'failure leaves the alternate screen')
    assert.ok(failed.stdout.includes('\u001b[?25h'), 'failure restores the cursor')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
} finally {
  hooks.deregister()
  delete globalThis[fixtureKey]
}
console.log('preset startup OK (missing/ready/late dependency, Config owner, failure exit, teardown, cancelled activation)')
