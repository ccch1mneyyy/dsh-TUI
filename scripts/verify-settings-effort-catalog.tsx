/** Current-route effort choices through the real Settings screen and form.
 * Run: node --import tsx/esm scripts/verify-settings-effort-catalog.tsx
 */
export {}
await import('./lib/fake-home.mjs')
process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_LANG = 'en'
const [{ default: assert }, { PassThrough, Writable }, React, { Terminal }, { render, AlternateScreen }, { Settings }, { SETTING_DEFINITIONS }, { settled, settle, sleep, viewportLines }] = await Promise.all([
  import('node:assert/strict'), import('node:stream'), import('react'), import('@xterm/headless'),
  import('../src/ui.js'), import('../src/screens/Settings.js'), import('../src/settings/definitions.js'), import('./lib/term-test.mjs'),
])
const { SettingsForm } = await import('../src/dsh-adapter/settingsEditor.js')
let observedField: Parameters<InstanceType<typeof SettingsForm>['field']>[0] | undefined
const originalField = SettingsForm.prototype.field
SettingsForm.prototype.field = function (field) {
  if (field.optionsSource === 'effort') observedField = field
  return originalField.call(this, field)
}
const offered = () => observedField?.options?.map(option => option.value) ?? []
type Catalog = { efforts: { id: string; name: string }[]; defaultEffort: string | undefined }
const pending: { route: string; resolve(value: Catalog): void; reject(error: Error): void }[] = []
const writes: string[] = []
let stored = 'remembered-custom'
let revision = 1
// Real action and request middleware: form writes must reach the next request.
const { createModelActions } = await import('../src/dsh-adapter/channel/model-actions.js')
const { createModelSelection } = await import('../src/dsh-adapter/channel/model-selection.js')
const { createChannelOwner } = await import('../src/dsh-adapter/channel/owner.js')
type Hook = (...args: unknown[]) => Promise<unknown>
const hooks = new Map<string, Hook>()
const owner = createChannelOwner()
const agent = {
  options: { provider: 'p', model: 'declared' },
  session: { requestHeader: () => ({ config: { provider: 'p', model: 'declared', reasoningEffort: 'xhigh' } }) },
  ctx: { on: (name: string, hook: Hook) => { hooks.set(name, hook); return () => hooks.delete(name) } },
}
const ctx = { on: () => () => {}, get: (name: string) => name === 'llm'
  ? { resolveModelInfo: async () => ({ reasoning: { efforts: ['medium', 'xhigh', 'ultra-custom'].map(id => ({ id, name: id })) } }) }
  : undefined }
const routing = createModelSelection(ctx as never, { owner, agent: () => agent as never })
routing.bind(agent as never, agent.options)
const state = { provider: 'p', model: 'declared', working: false, reasoningEffort: undefined as string | undefined, effortLevels: undefined as string[] | undefined, agentPreset: undefined, contextWindow: undefined, emit: () => {} }
const actions = createModelActions(ctx as never, state as never, {
  owner, binding: { capture: () => agent, isCurrent: (value: unknown) => value === agent } as never,
  selection: routing.selection, agent: () => agent as never, notify: () => {}, checkContextWarning: () => {},
})
await actions.applyPreferredEffort(true)
assert.equal(routing.selection.current?.reasoningEffort, 'xhigh', 'passive catalog refresh preserves restored effort')
const nextRequest = async () => {
  await hooks.get('system-prompt/assemble')!({}, {}, async () => ({ variables: agent.options }))
  return await hooks.get('agent/request')!({}, async () => ({ provider: 'p', model: 'declared' })) as { reasoningEffort?: string }
}
// A capability-only channel must use the same setting through the real
// action installation and Claude control request, not the DSH extension.
const { createChannel } = await import('../src/dsh-adapter/channel.js')
const { createClaudeControls } = await import('../src/backends/claude/controls.js')
let claudeFlag: string | null = 'xhigh'
const claudeFlags: (string | null)[] = []
let claudeSaved: string | undefined = 'xhigh'
const claudeControls = createClaudeControls({
  query: () => ({ applyFlagSettings: async (flags: { effortLevel: string | null }) => { claudeFlag = flags.effortLevel; claudeFlags.push(claudeFlag) } }),
  currentModel: () => 'declared', currentMode: () => 'default',
  prefs: { read: () => ({ effort: claudeSaved }), write: (patch: { effort?: string | null }) => { claudeSaved = patch.effort ?? undefined } },
  emit: () => {}, debug: () => {},
} as never)
claudeControls.seed({ models: [{ value: 'declared', displayName: 'Declared', supportedEffortLevels: ['medium', 'xhigh', 'ultra-custom'] }] })
const capabilityChannel = createChannel({ on: () => () => {}, get: () => undefined, logger: { warn: () => {}, debug: () => {} } } as never, {
  ref: { backendId: 'claude', sessionId: 'effort-fixture' }, cwd: process.cwd(), status: 'idle',
  capabilities: { effort: claudeControls.capabilities.effort, native: {} },
  history: async () => [], subscribe: () => () => {}, dispose: async () => {},
} as never, { model: 'declared', provider: 'claude', cwd: process.cwd(), activity: false })
// Run the production settings watcher, including its boot/live distinction.
const [{ readFileSync }, { default: ts }] = await Promise.all([import('node:fs'), import('typescript')])
const pluginSource = ts.createSourceFile('plugin.ts', readFileSync(new URL('../src/dsh-adapter/plugin.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true)
const watcherDeclarations = new Map<string, string>()
let readinessStatement = ''
const findWatcher = (node: import('typescript').Node): void => {
  if (ts.isIfStatement(node) && node.expression.getText(pluginSource).startsWith('backendStart !== undefined') && node.getText(pluginSource).includes('applyEffortDefault(scope.get())')) readinessStatement = node.getText(pluginSource)
  if (ts.isVariableStatement(node)) for (const declaration of node.declarationList.declarations) {
    const name = declaration.name.getText(pluginSource)
    if (name === 'lastEffortDefault' || name === 'applyEffortDefault') watcherDeclarations.set(name, node.getText(pluginSource))
  }
  ts.forEachChild(node, findWatcher)
}
findWatcher(pluginSource)
assert.equal(watcherDeclarations.size, 2)
assert.notEqual(readinessStatement, '', 'production readiness/catalog subscription is exercised')
const watcherJs = ts.transpileModule(`let settingsEditsLive = false;
${watcherDeclarations.get('lastEffortDefault')}
${watcherDeclarations.get('applyEffortDefault')}
const apply = (value, live) => { settingsEditsLive = live; applyEffortDefault(value) };
apply.start = () => { ${readinessStatement} };
return apply`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText
const applyCapabilityDefault = new Function('channel', 'backendStart', watcherJs)(capabilityChannel, { resumedSessionId: 'effort-fixture' }) as (value: { effortDefault: string }, live: boolean) => void
applyCapabilityDefault({ effortDefault: 'auto' }, false)
assert.deepEqual(claudeFlags, [], 'initial Auto preserves the restored capability effort')
applyCapabilityDefault({ effortDefault: 'medium' }, false)
assert.deepEqual(claudeFlags, [], 'boot settings cannot overwrite a resumed capability session')

const host = {
  listNamespaces: () => [{ ns: 'fixture', revision, applies: 'live' as const, value: { effortDefault: stored }, user: {} }],
  write: async (_ns: string, ops: readonly { op: string; value?: unknown }[]) => {
    for (const op of ops) if (op.op === 'set') { stored = String(op.value); writes.push(stored); actions.setDefaultEffort(stored === 'auto' ? undefined : stored); applyCapabilityDefault({ effortDefault: stored }, true) }
    revision += 1
  },
  credentialConfigured: async () => false,
  writeCredential: async () => undefined,
}
const listeners = new Set<() => void>()
const channel = {
  version: 0, backendCapabilities: { backendId: 'fixture', effort: true },
  sessionRef: { backendId: 'fixture', sessionId: 'session-a' }, agentBindingGeneration: 1, agentId: 'a', provider: 'p', model: 'first', effortLevels: undefined as string[] | undefined,
  settingsHost: () => host,
  settingsSections: () => [{ ns: 'fixture', title: 'Fixture', fields: [{ ...SETTING_DEFINITIONS.effortDefault, path: ['effortDefault'], kind: 'select' as const, optionsSource: 'effort' as const, group: undefined, format: (value: unknown) => value === undefined || value === null ? 'persisted-fallback' : String(value) }] }],
  subscribeSettingsSections: () => () => {},
  subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
  listEfforts: (route: { provider: string; model: string }) => new Promise<Catalog>((resolve, reject) => pending.push({ route: route.model, resolve, reject })),
}
const emit = () => { channel.version++; for (const listener of listeners) listener() }
// Use the production read projection: it reallocates detached arrays and
// capability objects on every unrelated version, while the settings host
// remains the stable fixture handle.
const { createChannelUi, createChannelUiLease } = await import('../src/adapter/channel/ui.js')
const { createChannelPlugins } = await import('../src/adapter/channel/plugins.js')
const { CHANNEL_SPLIT_TOKEN } = await import('../src/adapter/channel/internal-token.js')
const lease = createChannelUiLease(() => true)
const projected = createChannelUi(channel as never, 'legacy', lease)
const plugins = createChannelPlugins(channel as never, CHANNEL_SPLIT_TOKEN)
const screenChannel = Object.create(channel) as typeof channel
Object.defineProperties(screenChannel, {
  settingsSections: { value: () => plugins.settingsSections() },
  effortLevels: { get: () => projected.effortLevels },
  backendCapabilities: { get: () => projected.backendCapabilities },
})
class Stdin extends PassThrough { isTTY = true; setRawMode() { return this }; ref() { return this }; unref() { return this } }
class Stderr extends Writable { _write(_chunk: unknown, _encoding: BufferEncoding, callback: () => void) { callback() } }
const terminal = new Terminal({ cols: 110, rows: 28, allowProposedApi: true })
class Stdout extends Writable {
  isTTY = true; columns = 110; rows = 28
  _write(chunk: unknown, _encoding: BufferEncoding, callback: () => void) { terminal.write(String(chunk), callback) }
}
const stdin = new Stdin()
const app = await render(<AlternateScreen><Settings channel={screenChannel as never} onClose={() => {}} /></AlternateScreen>, {
  stdout: new Stdout() as never, stdin: stdin as never, stderr: new Stderr() as never, patchConsole: false, exitOnCtrlC: false,
})
const has = (text: string) => viewportLines(terminal, 28).join('\n').includes(text)
const wait = async (condition: () => boolean, message: string) => { assert.equal(await settled(condition, { timeoutMs: 4000 }), true, message) }
const cycle = async (value: string) => { const before = writes.length; stdin.write('\x1b[C'); await wait(() => writes.length > before && stored === value, `save ${value}`) }
try {
  await wait(() => pending.length === 1 && has('remembered-custom'), 'saved unsupported value remains readable while loading')
  assert.deepEqual(writes, [], 'opening never overwrites an unsupported global preference')
  const previousCapabilities = projected.backendCapabilities
  for (let index = 0; index < 5; index++) { emit(); await sleep(20) } // 固定窗:探针 Unrelated streaming emissions retain the in-flight lookup.
  assert.notEqual(projected.backendCapabilities, previousCapabilities, 'fixture exercises production projection churn')
  assert.equal(pending.length, 1, 'unrelated updates cannot restart or starve a pending catalog')
  pending[0]!.resolve({ efforts: [{ id: 'medium', name: 'Medium declared' }, { id: 'xhigh', name: 'Extra high declared' }, { id: 'ultra-custom', name: 'Custom declared' }], defaultEffort: 'medium' })
  // The catalog updates the retained SettingsForm as well as the visible row.
  await settle(() => offered().includes('ultra-custom'))
  await cycle('auto')
  await cycle('medium')
  await wait(() => has('Medium declared'), 'declared medium label rendered')
  await cycle('xhigh')
  await cycle('ultra-custom')
  await wait(() => routing.selection.current?.reasoningEffort === 'ultra-custom', 'form write reaches live model selection')
  assert.equal((await nextRequest()).reasoningEffort, 'ultra-custom', 'custom tier ships through real agent/request middleware')
  await wait(() => claudeFlag === 'ultra-custom', 'form write reaches capability-only SDK effort flag')
  assert.equal(claudeSaved, 'ultra-custom', 'capability backend retains its own preference')
  await wait(() => has('Custom declared'), 'declared custom label rendered')
  console.log('SCREEN effort custom tier\n' + viewportLines(terminal, 28).filter(line => line.trim()).join('\n'))
  channel.model = 'second'; emit()
  await wait(() => pending.length === 2 && has('ultra-custom'), 'saved unsupported value remains readable on route refresh')
  assert.deepEqual(offered(), ['auto'], 'saved value is readable, not advertised as supported')
  channel.model = 'third'; emit()
  await wait(() => pending.length === 3, 'third route replaces pending preview')
  pending[1]!.resolve({ efforts: [{ id: 'stale-only', name: 'Stale only' }], defaultEffort: 'stale-only' })
  pending[2]!.reject(new Error('metadata unavailable'))
  await sleep(100) // 固定窗:探针 A rejected or superseded lookup must not mutate the saved preference.
  assert.equal(stored, 'ultra-custom', 'failed refresh retains the saved preference')
  await cycle('auto')
  stdin.write('\x1b[C')
  await sleep(100) // 固定窗:探针 Cycling the only option must not introduce a different preference.
  assert.equal(stored, 'auto', 'only Auto remains selectable')
  assert.equal(claudeFlag, null, 'explicit Auto resets the capability backend to its model default')
  assert.equal(writes.includes('stale-only'), false, 'late route cannot publish selectable tiers')
  channel.effortLevels = ['only-tier']; emit()
  await wait(() => pending.length === 4, 'capability refresh reloads the same route')
  pending[3]!.resolve({ efforts: [{ id: 'only-tier', name: 'Only declared' }], defaultEffort: 'only-tier' })
  await settle(() => offered().includes('only-tier'))
  await cycle('only-tier')
  channel.model = 'no-reasoning'; emit()
  await wait(() => pending.length === 5, 'nonreasoning route lookup')
  pending[4]!.resolve({ efforts: [], defaultEffort: undefined })
  await settle(() => offered().length === 1 && offered()[0] === 'auto')
  await cycle('auto')
  stdin.write('\x1b[C')
  await sleep(100) // 固定窗:探针 Cycling the only option must not introduce a different preference.
  assert.equal(stored, 'auto', 'only Auto remains selectable')
  channel.sessionRef = { backendId: 'other-backend', sessionId: 'session-a' }; emit()
  await wait(() => pending.length === 6, 'sessionRef backend change refreshes the catalog')
  channel.agentBindingGeneration++; emit()
  await wait(() => pending.length === 7, 'same session rebind invalidates pending catalog')
  pending[5]!.resolve({ efforts: [{ id: 'wrong-backend', name: 'Wrong backend' }], defaultEffort: undefined })
  pending[6]!.resolve({ efforts: [{ id: 'current', name: 'Current binding' }], defaultEffort: undefined })
  await settle(() => offered().includes('current'))
  assert.equal(offered().includes('wrong-backend'), false)
  channel.effortLevels = ['only-tier']; emit()
  await sleep(100) // 固定窗:探针 Semantically identical metadata must retain loaded choices.
  assert.equal(pending.length, 7, 'equal tiers with new projected identity do not refetch')
  assert.ok(offered().includes('current'))
  channel.effortLevels = ['current']; emit()
  await wait(() => pending.length === 8, 'changed capability tiers reload the same route')
  assert.deepEqual(offered(), ['auto'], 'loading cannot advertise the previous capability')
  pending[7]!.resolve({ efforts: [{ id: 'current', name: 'Refreshed label' }], defaultEffort: undefined })
  await settle(() => observedField?.options?.some(option => option.label === 'Refreshed label'))
  await cycle('current')
  await wait(() => has('Refreshed label'), 'same-route labels refresh through retained form')
  assert.equal(writes.some(value => ['off', 'low', 'high', 'max'].includes(value)), false, 'no fabricated static tiers')
} finally {
  await app.unmount()
  terminal.dispose()
  SettingsForm.prototype.field = originalField
  owner.dispose()
  capabilityChannel.releaseContributions()
  lease.dispose()
}
// Codex uses its own thread settings request and resolves null to the
// model's declared default. Exercise that real adapter rather than a second
// fake implementation of the effort capability.
const { createCodexControls } = await import('../src/backends/codex/session/controls.js')
const codexUpdates: Record<string, unknown>[] = []
const codexPrefs: (string | null)[] = []
const codexControls = createCodexControls({
  hub: { call: async (method: string, params: Record<string, unknown>) => {
    if (method === 'model/list') return { data: [{ id: 'declared', model: 'declared', defaultReasoningEffort: 'medium', supportedReasoningEfforts: ['medium', 'xhigh', 'ultra-custom'].map(reasoningEffort => ({ reasoningEffort })) }] }
    assert.equal(method, 'thread/settings/update')
    codexUpdates.push(params)
    return {}
  } },
  prefs: { write: (patch: { effort: string | null }) => { codexPrefs.push(patch.effort) } },
  settings: { model: 'declared', effort: 'xhigh' }, ctx: {}, cwd: process.cwd(),
  threadId: () => 'thread-effort', busy: () => false, emit: () => {}, debug: () => {},
} as never)
await codexControls.capabilities.models!.list()
const codexChannel = createChannel({ on: () => () => {}, get: () => undefined, logger: { warn: () => {}, debug: () => {} } } as never, {
  ref: { backendId: 'codex', sessionId: 'effort-fixture' }, cwd: process.cwd(), status: 'idle',
  capabilities: { effort: codexControls.capabilities.effort, native: {} },
  history: async () => [], subscribe: () => () => {}, dispose: async () => {},
} as never, { model: 'declared', provider: 'codex', cwd: process.cwd(), activity: false })
try {
  const applyCodexDefault = new Function('channel', 'backendStart', watcherJs)(codexChannel, {}) as (value: { effortDefault: string }, live: boolean) => void
  applyCodexDefault({ effortDefault: 'auto' }, false)
  assert.deepEqual(codexUpdates, [], 'initial Auto also preserves Codex restored effort')
  codexChannel.setDefaultEffort('ultra-custom')
  await wait(() => codexPrefs.at(-1) === 'ultra-custom', 'Codex custom default reaches acknowledged thread settings')
  assert.equal(codexUpdates.at(-1)?.effort, 'ultra-custom')
  codexChannel.setDefaultEffort('max')
  await wait(() => codexPrefs.at(-1) === 'xhigh', 'unsupported standard preference only falls to a lower tier')
  assert.equal(codexUpdates.at(-1)?.effort, 'xhigh')
  assert.ok(codexChannel.notifications.some(item => item.text.includes('max') && item.text.includes('xhigh')), 'fallback is explained')
  codexChannel.setDefaultEffort('low')
  await wait(() => codexPrefs.at(-1) === null, 'no lower tier leaves the backend default unpinned')
  assert.equal(codexUpdates.at(-1)?.effort, 'medium', 'Codex resolves a reset to the declared model default')
  codexChannel.setDefaultEffort('ultra-custom')
  await wait(() => codexPrefs.at(-1) === 'ultra-custom', 'custom default remains selectable after fallback')
  codexChannel.setDefaultEffort(undefined)
  await wait(() => codexPrefs.at(-1) === null, 'explicit Auto clears the backend-scoped default')
  assert.equal(codexUpdates.at(-1)?.effort, 'medium')
} finally { codexChannel.releaseContributions() }
// A failed catalog is not a reliable empty ladder: preserve the saved
// preference until the existing model catalog has actually loaded.
const catalogFailures: string[] = []
for (const scenario of ['initial failure', 'repeated failure', 'empty ladder', 'empty catalog', 'explicit Auto']) {
  let modelCalls = 0
  const failCount = scenario === 'repeated failure' ? 2 : ['initial failure', 'explicit Auto'].includes(scenario) ? 1 : 0
  const saved: (string | null)[] = []
  const updates: Record<string, unknown>[] = []
  const settings = { model: 'declared', effort: 'ultra-custom' as string | null }
  const controls = createCodexControls({
    hub: { call: async (method: string, params: Record<string, unknown>) => {
      if (method === 'model/list') {
        if (++modelCalls <= failCount) throw new Error('fixture catalog unavailable')
        return { data: scenario === 'empty catalog' ? [] : [{ id: 'declared', model: 'declared', defaultReasoningEffort: 'medium',
          supportedReasoningEfforts: (scenario === 'empty ladder' ? [] : ['medium', 'ultra-custom']).map(reasoningEffort => ({ reasoningEffort })) }] }
      }
      if (method === 'collaborationMode/list') return { data: [] }
      assert.equal(method, 'thread/settings/update')
      updates.push(params)
      return {}
    } },
    prefs: { write: (patch: { effort: string | null }) => { saved.push(patch.effort) } },
    settings, ctx: {}, cwd: process.cwd(), threadId: () => 'catalog-fixture', busy: () => false, emit: () => {}, debug: () => {},
  } as never)
  await controls.initialize()
  const tested = createChannel({ on: () => () => {}, get: () => undefined, logger: { warn: () => {}, debug: () => {} } } as never, {
    ref: { backendId: 'codex', sessionId: 'catalog-fixture' }, cwd: process.cwd(), status: 'idle',
    capabilities: { effort: controls.capabilities.effort, native: {} },
    history: async () => [], subscribe: () => () => {}, dispose: async () => {},
  } as never, { model: 'declared', provider: 'codex', cwd: process.cwd(), activity: false })
  try {
    if (scenario === 'initial failure' || scenario === 'repeated failure') {
      tested.setDefaultEffort('ultra-custom')
      await sleep(30) // 固定窗:探针 Negative-observation window: an unavailable catalog must not mutate preferences.
      assert.deepEqual(saved, [], 'failed catalog leaves the existing saved preference untouched')
      assert.equal(modelCalls, 1, 'unavailable catalog must not turn a concrete preference into a reset retry')
      assert.deepEqual(updates, [], 'failed catalog does not send a backend reset')
      assert.equal(settings.effort, 'ultra-custom')
      if (scenario === 'repeated failure') {
        await assert.rejects(controls.capabilities.models!.list(), /fixture catalog unavailable/u)
        tested.setDefaultEffort('ultra-custom')
        await sleep(30) // 固定窗:探针 Negative-observation window after a second catalog failure.
        assert.deepEqual(saved, [], 'continued unavailability cannot clear the preference')
      }
      await controls.capabilities.models!.list()
      tested.setDefaultEffort('ultra-custom')
      await wait(() => saved.length === 1, 'recovered catalog applies the original supported preference')
      assert.equal(saved[0], 'ultra-custom')
      assert.equal(updates[0]?.effort, 'ultra-custom')
    } else {
      tested.setDefaultEffort(scenario === 'explicit Auto' ? undefined : 'ultra-custom')
      await wait(() => saved.length === 1, 'reliable empty ladder and explicit Auto retain backend reset semantics')
      assert.equal(saved[0], null)
      assert.equal(updates[0]?.effort, scenario === 'empty catalog' ? null : 'medium')
      assert.equal(modelCalls, scenario === 'explicit Auto' ? 2 : 1, 'Auto may recover through the existing catalog; reliable empty reuses it')
    }
    console.log(`PASS: Codex default effort ${scenario}`)
  } catch (error) {
    catalogFailures.push(`${scenario}: ${error instanceof Error ? error.message : String(error)}`)
    console.log(`FAIL: Codex default effort ${catalogFailures.at(-1)}`)
  } finally { tested.releaseContributions() }
}
assert.deepEqual(catalogFailures, [], 'Codex unavailable and reliable-empty catalogs have distinct semantics')
// The default host entry opens backends after mounting a starting session.
// A pending default must wait for adoption and read the latest settings once.
const { createStartingSession } = await import('../src/agent/starting-session.js')
for (const scenario of [
  { boot: 'medium', edits: ['ultra-custom'], wire: 'ultra-custom', preference: 'ultra-custom' },
  { boot: 'auto', edits: ['medium', 'auto'], wire: 'medium', preference: null },
]) {
  let resolveStartup!: (value: { session: import('../src/agent/session.js').AgentSession; history: [] }) => void
  const startup = new Promise<{ session: import('../src/agent/session.js').AgentSession; history: [] }>(resolve => { resolveStartup = resolve })
  const startingChannel = createChannel({ on: () => () => {}, get: () => undefined, logger: { warn: () => {}, debug: () => {} } } as never,
    createStartingSession('codex', process.cwd()), { model: 'declared', provider: 'codex', cwd: process.cwd(), activity: false, startup })
  let latestDefault = { effortDefault: scenario.boot }
  const startupDisposers: (() => void)[] = []
  const pendingWatcher = new Function('channel', 'backendStart', 'settingsCtx', 'scope', watcherJs)(startingChannel, {},
    { effect: (effect: () => () => void) => { startupDisposers.push(effect()) } }, { get: () => latestDefault }) as
    ((value: { effortDefault: string }, live: boolean) => void) & { start(): void }
  try {
    const before = codexPrefs.length
    pendingWatcher(latestDefault, false)
    pendingWatcher.start()
    for (const effortDefault of scenario.edits) { latestDefault = { effortDefault }; pendingWatcher(latestDefault, true) }
    assert.equal(codexPrefs.length, before, 'placeholder cannot apply backend effort')
    resolveStartup({ session: {
      ref: { backendId: 'codex', sessionId: 'opened-effort' }, cwd: process.cwd(), status: 'idle',
      capabilities: { effort: codexControls.capabilities.effort, native: {} },
      history: async () => [], subscribe: () => () => {}, dispose: async () => {},
    } as never, history: [] })
    await wait(() => startingChannel.ready && codexPrefs.length > before, 'deferred startup applies the saved default after adopting capabilities')
    assert.equal(codexUpdates.at(-1)?.effort, scenario.wire, 'startup uses the latest settings, including an explicit return to Auto')
    assert.equal(codexPrefs.at(-1), scenario.preference, 'pending Auto clears the backend preference')
    assert.equal(codexPrefs.length, before + 1, 'initial settings replay applies once')
  } finally {
    for (const dispose of startupDisposers) dispose()
    startingChannel.releaseContributions()
  }
}
console.log('PASS: dynamic effort catalog, persisted unknown value, stale/error/empty capability refresh')


// Startup recovery through the real session/RPC/channel and production watcher.
// Only the app-server transport is scripted; no second setDefaultEffort call.
const { openHarness, threadAnswer } = await import('./lib/codex-session-harness.js')
const { mountChannelUi } = await import('../src/dsh-adapter/channel-ui.js')
for (const scenario of ['recover', 'empty', 'Auto-before', 'Auto-after', 'Auto-then-concrete', 'resume', 'switch'] as const) {
  let available = scenario === 'empty'
  let latestDefault = { effortDefault: scenario === 'Auto-then-concrete' ? 'auto' : 'ultra-custom' }
  let resolveStartup!: (value: { session: import('../src/agent/session.js').AgentSession; history: [] }) => void
  const startup = new Promise<{ session: import('../src/agent/session.js').AgentSession; history: [] }>(resolve => { resolveStartup = resolve })
  let replacement: Awaited<ReturnType<typeof openHarness>> | undefined
  const starting = createChannel({ on: () => () => {}, get: () => undefined, logger: { warn: () => {}, debug: () => {} } } as never,
    createStartingSession('codex', process.cwd()), { model: 'gpt-5.6-terra', provider: 'codex', cwd: process.cwd(), activity: false, startup,
      openSession: async () => {
        replacement = await openHarness({ prefs: { effort: 'low' }, configureFake: fake => {
          fake.on('model/list', () => ({ data: [{ model: 'gpt-5.6-terra', supportedReasoningEfforts: [{ reasoningEffort: 'low' }] }] }))
        } })
        return replacement.session
      },
    })
  const mounted = mountChannelUi({}, starting, undefined, 'legacy')
  const disposers: (() => void)[] = []
  const watcher = new Function('channel', 'backendStart', 'settingsCtx', 'scope', watcherJs)(mounted.channel,
    scenario === 'resume' ? { resumedSessionId: 'resumed' } : {},
    { effect: (effect: () => () => void) => { disposers.push(effect()) } }, { get: () => latestDefault }) as
    ((value: { effortDefault: string }, live: boolean) => void) & { start(): void }
  watcher(latestDefault, false)
  watcher.start()
  const h = await openHarness({ prefs: { effort: 'low' }, ...(scenario === 'resume' ? { resume: threadAnswer() } : {}), configureFake: fake => {
    fake.on('model/list', () => {
      if (!available) throw new Error('startup catalog unavailable')
      return { data: scenario === 'empty' ? [] : [{ model: 'gpt-5.6-terra', defaultReasoningEffort: 'medium',
        supportedReasoningEfforts: ['medium', 'ultra-custom'].map(reasoningEffort => ({ reasoningEffort })) }] }
    })
    fake.on('thread/settings/update', () => ({}))
  } })
  try {
    resolveStartup({ session: h.session, history: [] })
    await wait(() => starting.ready, 'real Codex startup reaches ready despite unavailable optional catalog')
    if (scenario === 'empty') {
      await wait(() => h.sent('thread/settings/update').length === 1, 'reliable empty catalog is handled using null fallback')
      assert.equal(h.sent('thread/settings/update')[0]?.effort, null)
      await wait(() => h.session.capabilities.effort!.current() === undefined, 'empty catalog reset reaches the acknowledged session state')
    } else {
      assert.equal(h.sent('thread/settings/update').length, 0, 'unavailable boot catalog does not clear or prematurely apply preference')
      assert.equal(h.session.capabilities.effort!.current(), 'low', 'restored effort survives unavailable catalog')
      if (scenario === 'switch') {
        const before = starting.agentBindingGeneration
        await starting.newSession()
        assert.notEqual(starting.agentBindingGeneration, before, 'real session replacement changes binding even for the same id')
        await mounted.channel.listModels()
        assert.equal(replacement!.sent('thread/settings/update').length, 0, 'old startup pending does not affect a replacement session')
      } else {
        if (scenario === 'Auto-then-concrete') {
          latestDefault = { effortDefault: 'ultra-custom' }
          watcher(latestDefault, true)
        }
        available = true
        if (scenario === 'Auto-before') {
          latestDefault = { effortDefault: 'auto' }
          watcher(latestDefault, true)
        }
        await mounted.channel.listModels()
        if (scenario === 'resume') {
          assert.equal(h.sent('thread/settings/update').length, 0, 'catalog recovery preserves resumed effort')
        } else {
          await wait(() => h.sent('thread/settings/update').length === 1, 'successful catalog notification applies pending preference exactly once')
          assert.equal(h.sent('thread/settings/update')[0]?.effort, scenario === 'Auto-before' ? 'medium' : 'ultra-custom')
          await wait(() => h.session.capabilities.effort!.current() === (scenario === 'Auto-before' ? 'medium' : 'ultra-custom'), 'pending preference reaches acknowledged session state')
          if (scenario === 'Auto-after') {
            latestDefault = { effortDefault: 'auto' }
            watcher(latestDefault, true)
            await wait(() => h.sent('thread/settings/update').length === 2, 'active Auto after default application resets effort')
            assert.equal(h.sent('thread/settings/update')[1]?.effort, 'medium')
            await wait(() => h.session.capabilities.effort!.current() === 'medium', 'active Auto reset reaches acknowledged session state')
          }
        }
        const count = h.sent('thread/settings/update').length
        await mounted.channel.listModels()
        assert.equal(h.sent('thread/settings/update').length, count, 'later catalog reads do not replay handled defaults')
      }
    }
    console.log(`PASS: production effort startup pending ${scenario}`)
  } finally {
    for (const dispose of disposers) dispose()
    mounted.dispose()
    starting.releaseContributions()
    await h.session.dispose()
    await replacement?.session.dispose()
  }
}
