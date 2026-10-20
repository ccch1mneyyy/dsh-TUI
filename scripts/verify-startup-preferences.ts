/**
 * Native interactive launch preferences: argv, catalog refusal, first request,
 * parallel/parked agent isolation and unchanged saved preferences.
 * Run: node --import tsx/esm scripts/verify-startup-preferences.ts
 * The LLM boundary is a deterministic catalog; no model request is sent.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { mock } from 'node:test'

// Catch any accidental invocation of the existing preference writers without
// risking a write to the developer's settings, even when run outside CI's sandbox.
const preferenceWrites: string[] = []
const originalWrite = fs.writeFileSync
mock.method(fs, 'writeFileSync', (...args: Parameters<typeof fs.writeFileSync>) => {
  if (/(?:model|effort|settings)\.(?:json|ya?ml)$/u.test(String(args[0]))) {
    preferenceWrites.push(String(args[0]))
    throw new Error('startup preferences must not persist defaults')
  }
  return originalWrite(...args)
})
syncBuiltinESMExports()

try {
  const { initialPromptFromCmdlineArgs, startupPreferencesFromCmdlineArgs: parse } = await import('../src/dsh-adapter/startup-args.js')
  const { rememberStartupSelection, StartupPreferencesError, validateStartupPreferences } = await import('../src/dsh-adapter/startup-preferences.js')
  const { createModelSelection } = await import('../src/dsh-adapter/channel/model-selection.js')
  const { createModelActions } = await import('../src/dsh-adapter/channel/model-actions.js')
  const { createChannelOwner } = await import('../src/dsh-adapter/channel/owner.js')

  const argv = ['--model', 'ark/kimi3', '--effort=high', 'implement', 'the task']
  assert.deepEqual(parse(argv), { model: { provider: 'ark', model: 'kimi3' }, effort: 'high' })
  assert.equal(initialPromptFromCmdlineArgs(argv), 'implement the task')
  assert.deepEqual(parse(['--model=ark/team/kimi3', '--effort', 'low']), { model: { provider: 'ark', model: 'team/kimi3' }, effort: 'low' })
  assert.deepEqual(parse(['--', '--model', 'literal', '--effort', 'literal']), {})
  assert.equal(initialPromptFromCmdlineArgs(['--', '--model', 'literal']), '--model literal')
  for (const args of [['--model'], ['--effort'], ['--model', '--effort', 'high'], ['--effort='], ['--model', 'kimi3'], ['--model', 'ark/'], ['--model', '/kimi3'], ['--model', 'ark/a b']]) {
    assert.throws(() => parse(args), /dsh-tui:/u)
  }

  type Listener = (...args: unknown[]) => Promise<unknown>
  const makeAgent = (id: string, recorded?: { provider: string; model: string }) => {
    const listeners = new Map<string, Listener>()
    return {
      session: { id, requestHeader: () => recorded === undefined ? undefined : { config: recorded } },
      options: { provider: 'saved', model: 'default' },
      listeners,
      ctx: { on: (name: string, listener: Listener) => { listeners.set(name, listener); return () => listeners.delete(name) } },
    }
  }
  const catalog = {
    listModels: async (provider: string) => provider === 'ark' ? [{ id: 'kimi3' }, { id: 'deepseek-flash' }, { id: 'plain' }, { id: 'custom' }] : [],
    resolveModelInfo: async (_provider: string, model: string) => ({ reasoning: model === 'plain' ? { efforts: [] } : model === 'custom' ? { efforts: [{ id: 'native', name: 'Native' }] } : true }),
  }
  const ctx = { get: (name: string) => name === 'llm' ? catalog : undefined, on: () => () => undefined }
  const fallback = { provider: 'saved', model: 'default' }
  assert.equal(await validateStartupPreferences(ctx as never, {}, fallback), undefined)
  for (const preferences of [parse(['--model', 'unknown/kimi3']), parse(['--model', 'ark/unknown']), parse(['--model', 'ark/plain', '--effort', 'high']), parse(['--model', 'ark/kimi3', '--effort', 'invalid'])]) {
    await assert.rejects(validateStartupPreferences(ctx as never, preferences, fallback), error => error instanceof StartupPreferencesError && /invalid launch preferences/u.test(error.message))
  }
  await assert.rejects(validateStartupPreferences({ get: () => undefined } as never, parse(argv), fallback), /catalog is unavailable/u)
  await assert.rejects(validateStartupPreferences({ get: () => ({ ...catalog, listModels: async () => { throw new Error('disconnected') } }) } as never, parse(argv), fallback), /disconnected/u)
  assert.equal((await validateStartupPreferences(ctx as never, parse(['--effort', 'native']), { provider: 'ark', model: 'custom' }))?.reasoningEffort, 'native')

  const agents = [makeAgent('kimi3'), makeAgent('flash-resume', { provider: 'old', model: 'recorded' })]
  const requests = [parse(argv), parse(['--model', 'ark/deepseek-flash', '--effort', 'low'])]
  const selections = await Promise.all(requests.map(preferences => validateStartupPreferences(ctx as never, preferences, fallback)))
  agents.forEach((agent, index) => rememberStartupSelection(agent as never, selections[index]))
  let foreground = agents[0]!
  const owner = createChannelOwner()
  const router = createModelSelection(ctx as never, { owner, agent: () => foreground as never })
  const actions = agents.map((agent, index) => {
    foreground = agent
    const route = selections[index]!
    router.bind(agent as never, route)
    const state = { ...route, working: false, contextWindow: undefined, reasoningEffort: undefined as string | undefined, effortLevels: undefined, emit() {} }
    const modelActions = createModelActions(ctx as never, state as never, {
      owner, binding: { capture: () => agent, isCurrent: capture => capture === agent } as never,
      selection: router.selection, initialEffort: 'max', agent: () => agent as never,
      notify: () => () => undefined, checkContextWarning: () => undefined,
    })
    assert.equal(state.reasoningEffort, route.reasoningEffort, 'launch effort outranks saved/deployment defaults')
    return modelActions
  })

  // Read the first actual request middleware immediately, before asynchronous
  // metadata warmups. A resumed log's old route must not override explicit pins.
  const firstRequest = async (agent: typeof foreground) => {
    const assembly = await agent.listeners.get('system-prompt/assemble')!({}, {}, async () => ({ variables: {} })) as { variables: Record<string, unknown> }
    return await agent.listeners.get('agent/request')!({}, async () => ({ ...assembly.variables, reasoningEffort: 'medium' }))
  }
  const first = await Promise.all(agents.map(firstRequest))
  assert.deepEqual(first, selections, 'the first requests use their own selected routes and efforts')
  // Settings bootstrap and subsequent foreground movement cannot erase launch
  // overrides or route a parked worker through the foreground worker's ref.
  foreground = agents[0]!
  actions[0]!.setDefaultEffort('medium')
  await actions[0]!.applyPreferredEffort()
  foreground = agents[1]!
  actions[1]!.setDefaultEffort('high')
  await actions[1]!.applyPreferredEffort()
  assert.deepEqual(await Promise.all(agents.map(firstRequest)), selections)
  const plain = makeAgent('next-plain-session')
  foreground = plain
  router.bind(plain as never, fallback)
  assert.equal(router.selection.current, undefined, 'a new unconfigured session does not inherit another session\'s launch override')
  assert.deepEqual(preferenceWrites, [], 'startup and settings bootstrap never call preference writers')
  owner.dispose()
  console.log('verify-startup-preferences OK: argv, strict refusals, first requests, resume override, parallel isolation, saved defaults unchanged')
} finally {
  mock.restoreAll()
  syncBuiltinESMExports()
}
