/**
 * Codex C2 controls/commands regressions on the real hub + production session.
 * Only the external app-server is scripted. No personal config or network.
 * Run: node --import tsx/esm scripts/verify-codex-controls.ts
 */
import assert from 'node:assert/strict'
import type { AgentEvent } from '../src/agent/events.js'
import { setLang } from '../src/i18n.js'
import { memoryCodexPrefs } from '../src/backends/codex/prefs.js'
import { CLIENT, NOTIFY } from '../src/backends/codex/protocol/index.js'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createItemContext } from '../src/backends/codex/translate/items.js'
import type { SettingsSnapshot } from '../src/backends/codex/translate/live.js'
import { createFakeAppServer, FakeRpcError, NO_REPLY } from './lib/codex-fake-app-server.js'
import { CWD, THREAD, manualClock, threadAnswer } from './lib/codex-session-harness.js'

setLang('en')
// Optional read-only integration target; defaults to this script's own tree.
const runtimeRoot = process.env.CODEX_TEST_SOURCE_ROOT ?? fileURLToPath(new URL('../', import.meta.url))
const sourceUrl = (path: string): string => pathToFileURL(resolve(runtimeRoot, path)).href
const { createCodexHub } = await import(sourceUrl('src/backends/codex/rpc/hub.js')) as typeof import('../src/backends/codex/rpc/hub.js')
const { createCodexControls } = await import(sourceUrl('src/backends/codex/session/controls.js')) as typeof import('../src/backends/codex/session/controls.js')
const { openCodexSession } = await import(sourceUrl('src/backends/codex/session/session.js')) as typeof import('../src/backends/codex/session/session.js')
const runtimeI18n = await import(sourceUrl('src/i18n.js')) as typeof import('../src/i18n.js')
runtimeI18n.setLang('en')
let passed = 0
const failures: string[] = []
function check(name: string, actual: unknown, expected: unknown = true): void {
  try { assert.deepEqual(actual, expected); passed += 1; console.log('PASS', name) }
  catch (error) { failures.push(name); console.error('FAIL', name, error instanceof Error ? error.message : String(error)) }
}
type Rec = Record<string, unknown>
const object = (value: unknown): Rec => typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Rec : {}
const model = (slug: string, effort: string[] = ['low', 'high'], defaultEffort = 'low'): Rec => ({ id: 'catalog-' + slug, model: slug, displayName: 'Model ' + slug, defaultReasoningEffort: defaultEffort, supportedReasoningEfforts: effort.map(reasoningEffort => ({ reasoningEffort })), hidden: false })
// 固定窗:探针 fake pipe notification delivery; no wall-clock performance assertions.
const settle = (): Promise<void> => new Promise(resolve => { setTimeout(resolve, 0) })

async function fixture(options: { answer?: Rec; configure?(fake: ReturnType<typeof createFakeAppServer>): void } = {}) {
  const fake = createFakeAppServer()
  const clock = manualClock()
  const prefs = memoryCodexPrefs({})
  const events: AgentEvent[] = []
  const debug: string[] = []
  const hub = createCodexHub({ executable: '/fake/codex', args: ['app-server'], env: {}, cwd: CWD }, { transportFactory: fake.transportFactory, clock, debug: line => debug.push(line) })
  await hub.ready
  fake.on(CLIENT.threadStart, () => options.answer ?? threadAnswer())
  fake.on(CLIENT.threadUnsubscribe, () => ({}))
  fake.on(CLIENT.collaborationModeList, () => ({ data: [{ mode: 'default' }, { mode: 'plan' }] }))
  fake.on(CLIENT.modelList, () => ({ data: [model('gpt-5.6-terra'), model('limited', ['medium'], 'medium')], nextCursor: null }))
  fake.on(CLIENT.threadSettingsUpdate, () => ({}))
  fake.on(CLIENT.turnInterrupt, () => ({}))
  let turn = 0
  fake.on(CLIENT.turnStart, () => ({ turn: { id: 'turn-' + ++turn, status: 'inProgress', items: [] } }))
  options.configure?.(fake)
  let session: Awaited<ReturnType<typeof openCodexSession>>
  try {
    session = await openCodexSession({ hub, release: hub.retain(), target: { kind: 'create', cwd: CWD }, cwd: CWD, prefs, executable: { path: '/fake/codex', source: 'env', version: '0.160.1' }, host: { debug: line => debug.push(line) }, clock })
  } catch (error) { await hub.close(); throw error }
  session.subscribe(batch => events.push(...batch))
  await settle()
  const sent = (method: string): Rec[] => fake.requests.filter(request => request.method === method).map(request => request.params)
  const last = (method: string): Rec => sent(method).at(-1) ?? {}
  const notify = async (method: string, params: Rec = {}): Promise<void> => { fake.notify(method, { threadId: THREAD, ...params }); await settle() }
  const submit = (text: string, id = text) => session.submit({ text, clientMessageId: id }, 'followup')
  const complete = (id: string) => notify(NOTIFY.turnCompleted, { turn: { id, status: 'completed', items: [], error: null } })
  return { fake, hub, prefs, events, debug, session, sent, last, notify, submit, complete, close: async () => { await session.dispose(); await hub.close() } }
}
async function scenario(name: string, run: () => Promise<void>): Promise<void> {
  console.log('\n' + name)
  try { await run() } catch (error) { failures.push(name); console.error('FAIL', name, error) }
}

await scenario('models pagination/cache/mapping + effort defaults', async () => {
  const f = await fixture({ configure: fake => fake.on(CLIENT.modelList, params => params.cursor === undefined
    ? { data: [model('gpt-5.6-terra'), { ...model('hidden'), hidden: true }], nextCursor: 'page-2' }
    : { data: [model('limited', ['medium'], 'medium')], nextCursor: null }) })
  try {
    const c = f.session.capabilities
    check('all visible model pages, model slug not opaque id', (await c.models!.list()).map(row => row.id), ['gpt-5.6-terra', 'limited'])
    await c.models!.list()
    check('hub catalog cached', f.sent(CLIENT.modelList).length, 2)
    const settings: SettingsSnapshot = { model: 'gpt-5.6-terra', effort: 'high', modeId: 'auto', permissionMode: 'auto' }
    const controls = createCodexControls({ hub: f.hub, prefs: f.prefs, ctx: createItemContext({ cwd: CWD, model: settings.model, debug: () => {} }), settings, cwd: CWD, threadId: () => THREAD, busy: () => false, emit: () => {}, submitText: async () => {}, debug: () => {}, mappedModels: () => [{ id: 'alias', label: 'mapped limited' }], actualModel: id => id === 'alias' ? 'limited' : id })
    check('mapped alias added without extra request', (await controls.capabilities.models!.list()).some(row => row.id === 'alias'))
    f.prefs.write({ effort: 'high' })
    await controls.capabilities.models!.set({ model: 'alias' })
    check('mapping wire actual slug', f.last(CLIENT.threadSettingsUpdate).model, 'limited')
    check('model switch normalizes unsupported effort', settings.effort, 'medium')
    check('mapping persists user-facing id', f.prefs.read().model, 'alias')
    check('incompatible effort preference normalized', f.prefs.read().effort, 'medium')
    await c.effort!.set(null)
    check('effort default resolves catalog default', c.effort!.current(), 'low')
    check('effort default preference cleared by null patch', Object.hasOwn(f.prefs.read(), 'effort'), false)
    let rejected = false
    try { await c.effort!.set('unknown') } catch { rejected = true }
    check('effort rejects unsupported level', rejected)
    f.fake.notify(NOTIFY.accountUpdated, {})
    await settle()
    await c.models!.list()
    check('account notification invalidates hub cache', f.sent(CLIENT.modelList).length, 4)
  } finally { await f.close() }
})

await scenario('pending overrides preserve instructions and are acknowledged', async () => {
  const f = await fixture({ answer: threadAnswer({ collaborationMode: { mode: 'default', settings: { model: 'gpt-5.6-terra', reasoning_effort: 'low', developer_instructions: 'Keep my developer rules.' } } }) })
  try {
    const c = f.session.capabilities
    await c.models!.set({ model: 'limited' })
    check('ordinary model change does not replace collaboration instructions', Object.hasOwn(f.last(CLIENT.threadSettingsUpdate), 'collaborationMode'), false)
    await f.submit('first')
    check('idle settings already applied do not leak into next turn', Object.hasOwn(f.last(CLIENT.turnStart), 'model'), false)
    await c.effort!.set('medium')
    check('busy setting does not issue settings RPC', f.sent(CLIENT.threadSettingsUpdate).length, 1)
    await f.complete('turn-1')
    await f.submit('second')
    check('busy effort change deferred to next turn', f.last(CLIENT.turnStart).effort, 'medium')
    await f.notify(NOTIFY.turnStarted, { turn: { id: 'turn-2', status: 'inProgress', items: [] } })
    await f.notify(NOTIFY.threadSettingsUpdated, { threadSettings: { model: 'limited', effort: 'medium' } })
    await f.complete('turn-2')
    await f.notify(NOTIFY.threadSettingsUpdated, { threadSettings: { model: 'gpt-5.6-terra', effort: 'high' } })
    await f.submit('third')
    check('acknowledged pending effort cannot clobber later native update', Object.hasOwn(f.last(CLIENT.turnStart), 'effort'), false)
  } finally { await f.close() }
})

await scenario('permission orthogonal Plan cycle and deferred mode/model', async () => {
  const f = await fixture()
  try {
    const c = f.session.capabilities
    await c.modes!.set('full-access')
    check('permissions wire policy', f.last(CLIENT.threadSettingsUpdate).approvalPolicy, 'never')
    check('permissions wire sandbox', object(f.last(CLIENT.threadSettingsUpdate).sandboxPolicy).type, 'dangerFullAccess')
    check('permission selector does not gratuitously rewrite Default', Object.hasOwn(f.last(CLIENT.threadSettingsUpdate), 'collaborationMode'), false)
    await c.modes!.set('plan')
    check('Plan preserves permission in cycle', c.modes!.cycle!().map(row => row.id), ['full-access', 'plan'])
    check('Plan does not overwrite permission preference', f.prefs.read().mode, 'full-access')
    await c.modes!.set('full-access')
    check('Plan exit returns saved permission', c.modes!.current(), 'full-access')
    check('Plan toggle preference saved false', f.prefs.read().plan, false)
    await f.submit('busy')
    await c.modes!.set('plan')
    await c.models!.set({ model: 'limited' })
    await f.complete('turn-1')
    await f.submit('plan next')
    const override = object(f.last(CLIENT.turnStart).collaborationMode)
    check('busy mode/model merge keeps Plan', override.mode, 'plan')
    check('pending collaboration embeds latest model not stale model', object(override.settings).model, 'limited')
  } finally { await f.close() }
})

for (const code of [-32601, -32602]) await scenario('settings unsupported ' + code + ' stable next-turn fallback', async () => {
  const f = await fixture({ configure: fake => {
    fake.on(CLIENT.threadSettingsUpdate, () => { throw new FakeRpcError(code, 'settings unsupported') })
    fake.on(CLIENT.turnStart, params => { if (params.collaborationMode !== undefined) throw new FakeRpcError(-32602, 'collaborationMode unsupported'); return { turn: { id: 'fallback', status: 'inProgress', items: [] } } })
  } })
  try {
    await f.session.capabilities.models!.set({ model: 'limited' })
    await f.session.capabilities.effort!.set('medium')
    check('unsupported settings warns only once', f.events.filter(event => event.type === 'notice' && event.key === 'codex-settings-deferred').length, 1)
    check('unsupported settings not retried', f.sent(CLIENT.threadSettingsUpdate).length, 1)
    check('stable fallback turn accepted without gratuitous experimental field', (await f.submit('fallback')).accepted)
    check('fallback transmits model', f.last(CLIENT.turnStart).model, 'limited')
    check('fallback transmits effort', f.last(CLIENT.turnStart).effort, 'medium')
  } finally { await f.close() }
})

await scenario('context raw last.totalTokens/account/MCP/rename/init', async () => {
  const f = await fixture({ configure: fake => {
    fake.on(CLIENT.accountRead, () => ({ account: { type: 'chatgpt', planType: 'plus', email: 'must-not-project@example.invalid' } }))
    fake.on(CLIENT.mcpServerStatusList, params => params.cursor === undefined ? { data: [{ name: 'alpha', authStatus: 'oauth', runtimeStatus: 'ready', tools: { one: {}, two: {} } }], nextCursor: 'mcp-next' } : { data: [{ name: 'beta', authStatus: 'notLoggedIn', tools: {} }], nextCursor: null })
    fake.on(CLIENT.mcpServerReload, () => ({}))
    fake.on(CLIENT.threadNameSet, params => { fake.notify(NOTIFY.threadNameUpdated, { threadId: THREAD, threadName: params.name }); return {} })
  } })
  try {
    await f.notify(NOTIFY.threadTokenUsageUpdated, { tokenUsage: { total: { totalTokens: 999999 }, last: { totalTokens: 24000, inputTokens: 22000, outputTokens: 2000 }, modelContextWindow: 200000 } })
    check('context raw uses last not cumulative total', (await f.session.capabilities.context!.usage('summary')).used, 24000)
    check('context raw includes original capacity', (await f.session.capabilities.context!.usage('summary')).max, 200000)
    check('shared occupancy baseline remains distinct', f.events.some(event => event.type === 'context.usage' && event.used === 12000 && event.max === 188000))
    const account = await f.session.capabilities.account!.info()
    check('account view omits email', Object.hasOwn(account, 'email'), false)
    check('account subscription projected', account.subscription, 'plus')
    const mcp = await f.session.capabilities.mcp!.status()
    check('MCP pagination and runtime/auth mapping', mcp.map(row => [row.name, row.status, row.toolCount]), [['alpha', 'ready', 2], ['beta', 'notLoggedIn', 0]])
    check('MCP status carries active thread', f.last(CLIENT.mcpServerStatusList).threadId, THREAD)
    await f.session.capabilities.mcp!.reconnect!('alpha')
    check('MCP reconnect reloads then refetches', f.sent(CLIENT.mcpServerReload).length === 1 && f.sent(CLIENT.mcpServerStatusList).length === 4)
    await f.session.capabilities.rename!.rename('New title')
    await settle()
    check('rename notification source is user', f.events.some(event => event.type === 'session.title' && event.title === 'New title' && event.source === 'user'))
    await f.session.capabilities.init!.run()
    check('init actual turn prompt', JSON.stringify(f.last(CLIENT.turnStart).input).includes('AGENTS.md'))
  } finally { await f.close() }
})

await scenario('review wire targets and lifecycle', async () => {
  let reviewTurn = 0
  const f = await fixture({ configure: fake => fake.on(CLIENT.reviewStart, () => ({ turn: { id: 'review-' + ++reviewTurn, status: 'inProgress', items: [] } })) })
  try {
    for (const [command, target] of [['/review', { type: 'uncommittedChanges' }], ['/review base main', { type: 'baseBranch', branch: 'main' }], ['/review commit abc123', { type: 'commit', sha: 'abc123', title: null }], ['/review check the API', { type: 'custom', instructions: 'check the API' }]] as const) {
      check(command + ' accepted', (await f.submit(command)).accepted)
      check(command + ' exact target', f.last(CLIENT.reviewStart).target, target)
      check(command + ' delivery inline', f.last(CLIENT.reviewStart).delivery, 'inline')
      check(command + ' second review refuses active turn', (await f.submit('/review')).accepted, false)
      const id = 'review-' + reviewTurn
      await f.notify(NOTIFY.itemStarted, { turnId: id, item: { type: 'enteredReviewMode', id: 'enter-' + id, review: 'API' } })
      await f.notify(NOTIFY.itemCompleted, { turnId: id, item: { type: 'exitedReviewMode', id: 'exit-' + id, review: 'No issues.' } })
      await f.complete(id)
    }
    check('review completion creates matched neutral turn boundaries', f.events.filter(event => event.type === 'turn.start').length === 4 && f.events.filter(event => event.type === 'turn.end').length === 4)
  } finally { await f.close() }
})

await scenario('diff fallback and usage windows/credits', async () => {
  const f = await fixture({ configure: fake => {
    fake.on(CLIENT.gitDiffToRemote, () => ({ sha: 'abc', diff: '+fallback diff' }))
    fake.on(CLIENT.accountRateLimitsRead, () => ({ rateLimits: { primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 1800000000 }, secondary: { usedPercent: 50, windowDurationMins: 10080, resetsAt: 1800001000 }, credits: { balance: '42.5', unlimited: false, hasCredits: true } } }))
  } })
  try {
    await f.submit('/diff')
    check('diff falls back to git remote RPC', f.sent(CLIENT.gitDiffToRemote).length, 1)
    await f.notify(NOTIFY.turnDiffUpdated, { turnId: 'diff-turn', diff: '+live diff' })
    await f.submit('/diff')
    check('last aggregate diff avoids fallback', f.sent(CLIENT.gitDiffToRemote).length, 1)
    check('diff writes command-output not assistant', f.events.some(event => event.type === 'user.message' && event.source === 'command-output' && event.text === '+live diff'))
    f.fake.off(CLIENT.gitDiffToRemote)
    await f.notify(NOTIFY.turnDiffUpdated, { turnId: 'diff-turn', diff: '' })
    let accepted = false
    try { accepted = (await f.submit('/diff')).accepted } catch { /* asserted below */ }
    check('unsupported diff fallback returns empty notice without rejecting command', accepted)
    await f.submit('/usage')
    const output = f.events.filter(event => event.type === 'user.message' && event.source === 'command-output').at(-1)
    check('usage includes both percentage windows and credits', output?.type === 'user.message' && output.text.includes('25%') && output.text.includes('50%') && output.text.includes('42.5'))
    const rate = f.events.find(event => event.type === 'rate-limit')
    check('usage reset unix seconds becomes epoch ms', rate?.type === 'rate-limit' ? rate.info.windows?.[0]?.resetsAt : undefined, 1800000000000)
  } finally { await f.close() }
})

await scenario('skills collision filtering, cache, dynamic refresh and actual skill input', async () => {
  let skills = [{ name: 'Init', path: '/TMP/init/SKILL.md' }, { name: 'review', path: '/TMP/review/SKILL.md' }, { name: 'permission', path: '/TMP/permission/SKILL.md' }, { name: 'disabled', enabled: false, path: '/TMP/disabled/SKILL.md' }, { name: 'deploy', path: '/TMP/deploy/SKILL.md' }]
  const f = await fixture({ configure: fake => fake.on(CLIENT.skillsList, () => ({ data: [{ cwd: CWD, skills }] })) })
  try {
    const commands = await f.session.capabilities.commands!.list()
    check('skills local names filtered case-insensitively', commands.some(row => row.name.toLowerCase() === 'init'), false)
    check('skills backend reserved names not duplicated', commands.filter(row => row.name === 'review').length, 1)
    check('skills capability-owned names not advertised', commands.some(row => row.name === 'permission'), false)
    check('disabled skill omitted', commands.some(row => row.name === 'disabled'), false)
    await f.session.capabilities.commands!.list()
    check('skill catalog cached', f.sent(CLIENT.skillsList).length, 1)
    await f.submit('/deploy stage', 'skill-message')
    check('actual skill input name/path preserved', object((f.last(CLIENT.turnStart).input as unknown[])[0]), { type: 'skill', name: 'deploy', path: '/TMP/deploy/SKILL.md' })
    check('actual skill text args retained', object((f.last(CLIENT.turnStart).input as unknown[])[1]).text, 'stage')
    await f.complete('turn-1')
    skills = [{ name: 'newskill', path: '/TMP/newskill/SKILL.md' }]
    f.fake.notify(NOTIFY.skillsChanged, {})
    await settle()
    await settle()
    check('skills changed refreshes menu event', f.events.some(event => event.type === 'commands.changed' && event.commands.some(row => row.name === 'newskill') && !event.commands.some(row => row.name === 'deploy')))
    const list = await f.session.capabilities.commands!.list()
    check('skills changed invalidates current list cache', list.some(row => row.name === 'newskill'))
    // An older in-flight list must not overwrite a catalog invalidated mid-request.
    let held: number | string | undefined
    f.fake.on(CLIENT.skillsList, (_params, request) => { held = request.id; return NO_REPLY })
    const after = f.fake.requests.length
    f.fake.notify(NOTIFY.skillsChanged, {})
    held = (await f.fake.waitForRequest(CLIENT.skillsList, { after })).id
    f.fake.on(CLIENT.skillsList, () => ({ data: [{ cwd: CWD, skills: [{ name: 'latest', path: '/TMP/latest/SKILL.md' }] }] }))
    f.fake.notify(NOTIFY.skillsChanged, {})
    await settle()
    await settle()
    if (held !== undefined) f.fake.reply(held, { data: [{ cwd: CWD, skills: [{ name: 'stale', path: '/TMP/stale/SKILL.md' }] }] })
    await settle()
    check('stale skills reply cannot replace latest generation', (await f.session.capabilities.commands!.list()).some(row => row.name === 'latest'))
  } finally { await f.close() }
})


await scenario('multi-bucket usage includes every native quota and credits', async () => {
  const f = await fixture({ configure: fake => fake.on(CLIENT.accountRateLimitsRead, () => ({
    rateLimits: { primary: { usedPercent: 5, windowDurationMins: 300 }, credits: { balance: '1', unlimited: false } },
    rateLimitsByLimitId: {
      codex: { limitName: 'Codex', primary: { usedPercent: 5, windowDurationMins: 300 }, credits: { balance: '1', unlimited: false } },
      review: { limitName: 'Code review', primary: { usedPercent: 87, windowDurationMins: 10080 }, credits: { balance: '9', unlimited: true } },
    },
  })) })
  try {
    await f.submit('/usage')
    const output = f.events.filter(event => event.type === 'user.message' && event.source === 'command-output').at(-1)
    check('usage renders non-legacy native buckets', output?.type === 'user.message' && output.text.includes('Code review') && output.text.includes('87%'))
    check('usage bucket window labels localized not wire identifiers', output?.type === 'user.message' && output.text.includes('5h') && !output.text.includes('five_hour'))
  } finally { await f.close() }
})


await scenario('unsupported Plan field cannot poison later ordinary turns', async () => {
  const f = await fixture({ configure: fake => {
    fake.on(CLIENT.threadSettingsUpdate, params => { if (params.collaborationMode !== undefined) throw new FakeRpcError(-32602, 'collaborationMode unsupported'); return {} })
    fake.on(CLIENT.turnStart, params => { if (params.collaborationMode !== undefined) throw new FakeRpcError(-32602, 'collaborationMode unsupported'); return { turn: { id: 'stable-after-plan', status: 'inProgress', items: [] } } })
  } })
  try {
    let refused = false
    try { await f.session.capabilities.modes!.set('plan') } catch { refused = true }
    check('unsupported Plan field refuses explicit mode instead of claiming success', refused)
    check('unsupported Plan removed from mode options', f.session.capabilities.modes!.list().some(row => row.id === 'plan'), false)
    await f.session.capabilities.models!.set({ model: 'limited' })
    check('ordinary turn survives previously rejected collaboration field', (await f.submit('stable after Plan')).accepted)
  } finally { await f.close() }
})

await scenario('failed idle update does not persist or leak rejected knobs', async () => {
  const f = await fixture({ configure: fake => fake.on(CLIENT.threadSettingsUpdate, () => { throw new FakeRpcError(-32000, 'model unavailable') }) })
  try {
    let refused = false
    try { await f.session.capabilities.models!.set({ model: 'limited' }) } catch { refused = true }
    check('non-capability model error propagates', refused)
    check('failed model update does not mutate current model', f.session.capabilities.models!.current().model, 'gpt-5.6-terra')
    await f.submit('after failed update')
    check('failed idle update not leaked into next turn', Object.hasOwn(f.last(CLIENT.turnStart), 'model'), false)
  } finally { await f.close() }
})


await scenario('busy Plan rejected on next turn rolls back only experimental knobs', async () => {
  let stableTurns = 0
  const f = await fixture({ answer: threadAnswer({ collaborationMode: { mode: 'default', settings: { model: 'gpt-5.6-terra', reasoning_effort: 'low', developer_instructions: 'Preserve native developer instructions.' } } }), configure: fake => {
    fake.on(CLIENT.turnStart, params => {
      if (params.collaborationMode !== undefined) throw new FakeRpcError(-32602, 'collaborationMode unsupported')
      return { turn: { id: 'stable-' + ++stableTurns, status: 'inProgress', items: [] } }
    })
  } })
  try {
    await f.submit('running')
    await f.session.capabilities.modes!.set('read-only')
    await f.session.capabilities.modes!.set('plan')
    await f.session.capabilities.models!.set({ model: 'limited' })
    await f.session.capabilities.effort!.set('medium')
    check('busy control changes do not probe idle settings', f.sent(CLIENT.threadSettingsUpdate).length, 0)
    await f.complete('stable-1')
    check('unsupported Plan turn remains observably refused', (await f.submit('Plan rejected')).accepted, false)
    check('failed next-turn Plan restores permission snapshot', f.session.capabilities.modes!.current(), 'read-only')
    check('failed next-turn Plan closes only Plan selection', f.session.capabilities.modes!.list().some(row => row.id === 'plan'), false)
    check('failed next-turn Plan rolls back saved toggle', f.prefs.read().plan, false)
    check('failed next-turn Plan emits one localized notice', f.events.filter(event => event.type === 'notice' && event.key === 'codex-plan-unavailable').length, 1)
    check('next ordinary turn succeeds after failed experimental field', (await f.submit('ordinary recovery')).accepted)
    const recovered = f.last(CLIENT.turnStart)
    check('turn failure preserves stable model selection', recovered.model, 'limited')
    check('turn failure preserves stable effort selection', recovered.effort, 'medium')
    check('turn failure preserves stable permission selection', recovered.approvalPolicy === 'on-request' && object(recovered.sandboxPolicy).type === 'readOnly')
    check('turn failure removes experimental mode without clearing stable pending', Object.hasOwn(recovered, 'collaborationMode'), false)
  } finally { await f.close() }
})

console.log('\nCodex controls/commands: ' + passed + ' passed, ' + failures.length + ' failed')
if (failures.length > 0) process.exitCode = 1
