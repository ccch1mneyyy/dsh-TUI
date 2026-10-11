/**
 * Claude session controls (docs/agent-backend-design.md §4.9–4.10, §5.3–5.4)
 * over a FAKE SDK — the capability delegates, what the channel makes of them,
 * and what the screen shows:
 *
 *  - models: the catalog from the handshake; `set` switches in place
 *    (`setModel`), persists the choice backend-scoped, reports the resolved
 *    model; an unknown id is refused;
 *  - effort: levels from the current model's `supportedEffortLevels`;
 *    `applyFlagSettings({effortLevel})`, `null` = default; persisted;
 *  - modes: default → acceptEdits → plan → bypassPermissions (auto only where
 *    the model supports it, added after bypass); `setPermissionMode`,
 *    confirmed as `mode.changed`; `bypassPermissions` is selectable from any
 *    session (the SDK bypass gate is always sent — options.ts — and the CLI
 *    is the authority, so the TUI refuses nothing); every row carries the
 *    one-line explanation the picker renders;
 *  - compact pushes the CLI's own `/compact`; commands drop terminal-only
 *    ones; MCP, context usage and account (no email) map to neutral views;
 *  - the channel: native mode label + index, effort readout, backend
 *    commands merged after the local ones (local names win), `/mcp` lines,
 *    `/context` LoadedContext, subscription usage, `/model` without a
 *    provider segment, the `/login` host, Shift+Tab cycling;
 *  - headless render: the status line shows the backend-native mode label,
 *    and `/context` renders the backend's context report.
 *
 * Run: node --import tsx/esm scripts/verify-claude-controls.tsx
 */
import assert from 'node:assert/strict'
import instances from '../src/ink/instances.js'

process.env.FORCE_COLOR = '3'

// Hermetic model-truth env (backends/claude/modelEnv.ts reads
// <CLAUDE_CONFIG_DIR>/settings.json to relabel relay catalog rows): pin an
// EMPTY config dir so the real ~/.claude on the developer machine (a relay
// channel mapping every tier to glm-5.3) cannot relabel the fixture catalog.
const { mkdtempSync, rmSync } = await import('node:fs')
const { tmpdir } = await import('node:os')
const { join: joinPath } = await import('node:path')
const hermeticClaudeDir = mkdtempSync(joinPath(tmpdir(), 'dshtui-controls-'))
process.env.CLAUDE_CONFIG_DIR = hermeticClaudeDir
process.on('exit', () => { try { rmSync(hermeticClaudeDir, { recursive: true, force: true }) } catch { /* best effort */ } })

const [
  { PassThrough, Writable },
  React,
  { Terminal },
  { render, AlternateScreen },
  { Chat },
  { QuestionStore },
  { openClaudeSession },
  { memoryClaudePrefs },
  { createChannel },
  { setLang, t },
  { findText, settled, sleep },
  fakes,
  { claudeText },
] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('../src/screens/Chat.js'),
  import('../src/channel/questions.js'),
  import('../src/backends/claude/session.js'),
  import('../src/backends/claude/prefs.js'),
  import('../src/dsh-adapter/channel.js'),
  import('../src/i18n.js'),
  import('./lib/term-test.mjs'),
  import('./lib/claude-fake-sdk.js'),
  import('../src/backends/claude/text.js'),
])
import type { AgentEvent } from '../src/agent/events.js'

setLang('en')
let passed = 0
const check = (label: string, ok: boolean, detail?: unknown): void => {
  assert.ok(ok, detail === undefined ? label : `${label}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`)
  passed += 1
  console.log(`PASS ${label}`)
}
const { fakeClaudeSdk, claudeDeps, tick } = fakes

const MODELS = [
  { value: 'default', resolvedModel: 'claude-sonnet-x', displayName: 'Default (Sonnet)', description: 'recommended', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high'] },
  { value: 'haiku', resolvedModel: 'claude-haiku-x', displayName: 'Haiku', description: 'fast', supportsEffort: false },
  { value: 'opus', resolvedModel: 'claude-opus-x', displayName: 'Opus', description: 'deep', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'max'], supportsAutoMode: true },
]
const COMMANDS = [
  { name: 'compact', description: 'Compact the conversation', argumentHint: '' },
  { name: 'review', description: 'Review a pull request', argumentHint: '<pr>' },
  { name: 'security-review', description: 'Security review', argumentHint: '' },
  { name: 'doctor', description: 'Terminal-only diagnosis', argumentHint: '' },
]
const USAGE = {
  categories: [{ name: 'System prompt', tokens: 3000, color: 'x', kind: 'used' }, { name: 'Free space', tokens: 150000, color: 'y', kind: 'free' }],
  totalTokens: 21000, maxTokens: 200000, rawMaxTokens: 200000, percentage: 10, gridRows: [], model: 'claude-sonnet-x',
  memoryFiles: [{ path: '/fixture/project/CLAUDE.md', type: 'project', tokens: 420 }],
  mcpTools: [{ name: 'search', serverName: 'docs', tokens: 300 }],
  systemTools: [{ name: 'Bash', tokens: 900 }],
  systemPromptSections: [{ name: 'Core instructions', tokens: 2500 }],
  agents: [],
  skills: { totalSkills: 1, includedSkills: 1, tokens: 80, skillFrontmatter: [{ name: 'deploy', source: 'project', tokens: 80 }] },
  isAutoCompactEnabled: true,
}
const permissionModeCalls: string[] = []
const controls = {
  setModel: () => undefined,
  setPermissionMode: (mode: string) => { permissionModeCalls.push(mode) },
  applyFlagSettings: () => undefined,
  supportedModels: () => MODELS,
  supportedCommands: () => COMMANDS,
  mcpServerStatus: () => [{ name: 'docs', status: 'connected', tools: [{ name: 'search' }] }, { name: 'tickets', status: 'needs-auth' }],
  reconnectMcpServer: () => undefined,
  getContextUsage: () => USAGE,
  accountInfo: () => ({ email: 'someone@example.invalid', organization: 'Example Org', subscriptionType: 'Team', apiProvider: 'firstParty', tokenSource: 'claude.ai' }),
  interrupt: () => ({ still_queued: [] }),
}
const init = { type: 'system', subtype: 'init', session_id: 's', cwd: '/fixture/project', model: 'claude-sonnet-x', permissionMode: 'default', slash_commands: ['compact', 'review'], terminal_slash_commands: ['doctor'], apiKeySource: 'none', claude_code_version: '2.1.287', capabilities: [] }

// ── capability delegates ──────────────────────────────────────────────
{
  const fake = fakeClaudeSdk(() => ({ capabilities: ['msg_lifecycle_v1'], models: MODELS, commands: COMMANDS }), controls)
  const prefs = memoryClaudePrefs()
  const session = await openClaudeSession(claudeDeps(fake.sdk, { prefs }))
  const events: AgentEvent[] = []
  session.subscribe(batch => { events.push(...batch) })
  await tick()
  const query = fake.queries[0]!
  query.emit(init)
  await tick()
  const caps = session.capabilities
  check('the start mode is announced', events.some(event => event.type === 'mode.changed' && event.modeId === 'default'))

  const list = await caps.models!.list()
  check('models: the catalog maps to options', list.map(model => model.id).join() === 'default,haiku,opus' && list[1]!.label === 'Haiku')
  check('models: current is the init model', caps.models!.current().model === 'claude-sonnet-x')
  const switched = await caps.models!.set({ model: 'opus' })
  check('models: set switches in place (setModel)', switched.kind === 'switched' && query.calls.some(call => call.method === 'setModel' && call.args[0] === 'opus'))
  check('models: the choice persists backend-scoped', prefs.data.model === 'opus')
  check('models: the resolved model is reported', events.some(event => event.type === 'model.changed' && event.model === 'claude-opus-x' && event.source === 'user'))
  const refused = await caps.models!.set({ model: 'gpt-5' })
  check('models: an unknown id is refused', refused.kind === 'refused')

  check('effort: levels follow the model (opus)', caps.effort!.levels().map(level => level.id).join() === 'low,medium,high,max')
  await caps.effort!.set('max')
  check('effort: applyFlagSettings({effortLevel})', query.calls.some(call => call.method === 'applyFlagSettings' && JSON.stringify(call.args[0]) === JSON.stringify({ effortLevel: 'max' })))
  check('effort: reported and persisted', caps.effort!.current() === 'max' && prefs.data.effort === 'max' && events.some(event => event.type === 'effort.changed' && event.effort === 'max'))
  await caps.effort!.set(null)
  check('effort: null resets to the default', caps.effort!.current() === undefined && prefs.data.effort === undefined && query.calls.some(call => call.method === 'applyFlagSettings' && JSON.stringify(call.args[0]) === JSON.stringify({ effortLevel: null })))
  await caps.models!.set({ model: 'haiku' })
  check('effort: a model without effort offers no levels', caps.effort!.levels().length === 0)
  await caps.models!.set({ model: 'opus' })

  check('modes: bypass is always listed, auto only where the model supports it', caps.modes!.list().map(mode => mode.id).join() === 'default,acceptEdits,plan,bypassPermissions,auto')
  await caps.models!.set({ model: 'default' })
  check('modes: default → acceptEdits → plan → bypassPermissions without auto', caps.modes!.list().map(mode => mode.id).join() === 'default,acceptEdits,plan,bypassPermissions')
  await caps.modes!.set('acceptEdits')
  check('modes: setPermissionMode, confirmed as mode.changed', query.calls.some(call => call.method === 'setPermissionMode' && call.args[0] === 'acceptEdits') && caps.modes!.current() === 'acceptEdits' && events.some(event => event.type === 'mode.changed' && event.modeId === 'acceptEdits'))
  query.emit({ type: 'system', subtype: 'status', status: null, permissionMode: 'acceptEdits' })
  await tick()
  check('modes: the CLI\'s confirming status frame is not reported twice', events.filter(event => event.type === 'mode.changed' && event.modeId === 'acceptEdits').length === 1)
  // The /permission picker can really switch INTO bypass: the TUI no longer
  // vets the id (the SDK gate is always sent; the CLI is the authority). The
  // mode is restored afterwards so the readouts below stay comparable.
  const entered = await caps.modes!.set('bypassPermissions').then(() => true, (error: unknown) => error instanceof Error ? error.message : String(error))
  check('modes: bypassPermissions is selectable at runtime', entered === true && query.calls.some(call => call.method === 'setPermissionMode' && call.args[0] === 'bypassPermissions') && caps.modes!.current() === 'bypassPermissions', entered)
  await caps.modes!.set('acceptEdits')
  const roster = caps.modes!.list()
  check('modes: every roster row explains itself (non-empty, never the bare label)', roster.every(mode => typeof mode.description === 'string' && mode.description.trim() !== '' && mode.description !== mode.label), roster.map(mode => [mode.id, mode.label, mode.description]))

  await caps.compact!.run()
  await tick()
  check('compact: the CLI\'s own /compact is pushed', query.inputs.some(input => (input.message as { content?: unknown }).content === '/compact'))
  const commands = await caps.commands!.list()
  check('commands: terminal-only ones are dropped', commands.map(command => command.name).join() === 'compact,review,security-review' && commands[1]!.argumentHint === '<pr>')
  const mcp = await caps.mcp!.status()
  check('mcp: status and tool counts', mcp[0]!.name === 'docs' && mcp[0]!.toolCount === 1 && mcp[1]!.status === 'needs-auth')
  await caps.mcp!.reconnect!('docs')
  check('mcp: reconnect delegates', query.calls.some(call => call.method === 'reconnectMcpServer' && call.args[0] === 'docs'))
  const usage = await caps.context!.usage('summary')
  check('context: summary usage maps sections, files, skills, tools', usage.used === 21000 && usage.max === 200000 && usage.sections?.[0]?.name === 'Core instructions' && usage.files?.[0]?.path === '/fixture/project/CLAUDE.md' && usage.skills?.[0]?.name === 'deploy' && usage.tools?.length === 2)
  check('context: the summary detail is requested', query.calls.some(call => call.method === 'getContextUsage' && JSON.stringify(call.args[0]) === JSON.stringify({ detail: 'summary' })))
  const account = await caps.account!.info()
  check('account: organization/subscription/provider, never the email', account.organization === 'Example Org' && account.subscription === 'Team' && account.provider === 'firstParty' && !JSON.stringify(account).includes('example.invalid'))
  check('/doctor lines never carry the email', !session.capabilities.diagnostics!.lines().join('\n').includes('example.invalid'))
  await session.dispose()
}

// ── the explicit bypass start: the roster entry is not a duplicate ─────
{
  const fake = fakeClaudeSdk(() => ({ capabilities: ['msg_lifecycle_v1'], models: MODELS, commands: COMMANDS }), controls)
  const session = await openClaudeSession(claudeDeps(fake.sdk, { start: { mode: 'bypassPermissions', source: 'env' } }))
  const events: AgentEvent[] = []
  session.subscribe(batch => { events.push(...batch) })
  await tick()
  const query = fake.queries[0]!
  query.emit({ ...init, permissionMode: 'bypassPermissions' })
  await tick()
  const caps = session.capabilities
  check('bypass session: starts and reports bypassPermissions', caps.modes!.current() === 'bypassPermissions' && events.some(event => event.type === 'mode.changed' && event.modeId === 'bypassPermissions'))
  // Bypass is the roster's own entry, so the live mode is not appended again
  // by the retention rule (the pre-existing trailing rule).
  check('bypass session: bypass is listed once, as the roster entry', caps.modes!.list().map(mode => mode.id).join() === 'default,acceptEdits,plan,bypassPermissions')
  const reentered = await caps.modes!.set('bypassPermissions').then(() => true, (error: unknown) => error instanceof Error ? error.message : String(error))
  check('bypass session: re-entering bypass delegates to setPermissionMode', reentered === true && query.calls.some(call => call.method === 'setPermissionMode' && call.args[0] === 'bypassPermissions'), reentered)
  await caps.modes!.set('default')
  const back = await caps.modes!.set('bypassPermissions').then(() => true, (error: unknown) => error instanceof Error ? error.message : String(error))
  check('bypass session: switching away and back works (the start opt-in holds)', back === true && query.calls.filter(call => call.method === 'setPermissionMode' && call.args[0] === 'bypassPermissions').length === 2 && caps.modes!.current() === 'bypassPermissions', back)
  await session.dispose()
}

// ── a persisted choice starts the next session ────────────────────────
{
  const fake = fakeClaudeSdk(() => ({ capabilities: [], models: MODELS }), controls)
  const session = await openClaudeSession(claudeDeps(fake.sdk, { prefs: memoryClaudePrefs({ model: 'opus', effort: 'high' }) }))
  check('the persisted model and effort are query options', fake.queries[0]!.options.model === 'opus' && fake.queries[0]!.options.effort === 'high')
  await session.dispose()
}

// ── a model switch vs the effort: declared lists rule; missing ones fall back ──
{
  // `MODELS` plus the shapes the real catalog serves: a Haiku row that
  // advertises NEITHER `supportsEffort` NOR a level list (SDK 0.3.287 —
  // the same shape a relay channel's custom model rows serve), and an
  // old-CLI row that claims support but lists no levels. The CLI accepts
  // any effortLevel flag regardless (applyFlagSettings), so those rows get
  // the CLI-standard tiers as a MARKED compatibility fallback and keep the
  // remembered choice; only an explicit `supportsEffort === false` (or a
  // declared list that excludes the tier) still clears.
  const CATALOG = [
    ...MODELS,
    { value: 'haiku-pro', resolvedModel: 'claude-haiku-4-5-20251001', displayName: 'Haiku Pro', description: 'no effort metadata' },
    { value: 'legacy', resolvedModel: 'claude-legacy-x', displayName: 'Legacy', description: 'supports effort, lists no levels', supportsEffort: true },
  ]
  const fake = fakeClaudeSdk(() => ({ capabilities: [], models: CATALOG }), controls)
  const prefs = memoryClaudePrefs({ model: 'opus' })
  const session = await openClaudeSession(claudeDeps(fake.sdk, { prefs }))
  const events: AgentEvent[] = []
  session.subscribe(batch => { events.push(...batch) })
  await tick()
  fake.queries[0]!.emit(init)
  await tick()
  const caps = session.capabilities
  const effortEvents = () => events.filter(event => event.type === 'effort.changed').map(event => event.effort)
  await caps.models!.set({ model: 'opus' })
  await caps.effort!.set('max')
  check('effort: seeded and settable', caps.effort!.current() === 'max' && prefs.data.effort === 'max' && effortEvents().at(-1) === 'max')

  const preview = caps.effort!.forModel!({ model: 'default' })
  check('effort preview uses the candidate model, not the live Opus levels', preview.levels.map(level => level.id).join() === 'low,medium,high')
  check('effort preview respects unsupported and unknown models', caps.effort!.forModel!({ model: 'haiku' }).levels.length === 0 && caps.effort!.forModel!({ model: 'unknown' }).levels.length === 0)
  check('effort preview marks the candidate compatibility ladder', caps.effort!.forModel!({ model: 'haiku-pro' }).levelsFallback === true)
  check('effort preview keeps the live model and preference', caps.models!.current().model === 'claude-opus-x' && caps.effort!.current() === 'max' && prefs.data.effort === 'max')

  // max is not a level of the plain model (low..high): cleared everywhere,
  // the UI never claims a level the picker does not offer.
  await caps.models!.set({ model: 'default' })
  check('models: an effort outside the new levels is cleared everywhere', caps.effort!.current() === undefined && prefs.data.effort === undefined && effortEvents().at(-1) === null && caps.effort!.levels().map(level => level.id).join() === 'low,medium,high')

  // high IS a level of both the plain and the opus model: kept, no clear.
  // A row that declares its own list carries NO fallback marker — the
  // ladder is the model's, not the compatibility offer.
  await caps.effort!.set('high')
  events.length = 0
  await caps.models!.set({ model: 'opus' })
  check('models: an effort the new model still runs is kept', caps.effort!.current() === 'high' && prefs.data.effort === 'high' && effortEvents().length === 0 && caps.effort!.levelsFallback === undefined)

  // haiku EXPLICITLY declares no effort support: still refused and still
  // cleared (without the supportsEffort check the readout kept saying max
  // while levels() was empty and the persisted pref resurrected).
  await caps.effort!.set('max')
  events.length = 0
  const switched = await caps.models!.set({ model: 'haiku' })
  check('models: an effort on a model without effort support is cleared', switched.kind === 'switched' && caps.effort!.current() === undefined && prefs.data.effort === undefined && JSON.stringify(effortEvents()) === '[null]' && caps.effort!.levels().length === 0 && caps.effort!.levelsFallback === undefined)

  // The real 0.3.287 Haiku / relay-custom shape: no `supportsEffort`, no
  // levels list. The picker serves the CLI-standard tiers — marked as a
  // compatibility fallback — and the remembered choice survives the switch
  // (a silent clear would downgrade the user's next start for nothing).
  await caps.models!.set({ model: 'opus' })
  await caps.effort!.set('max')
  events.length = 0
  const toHaikuPro = await caps.models!.set({ model: 'haiku-pro' })
  check('models: a row with no level metadata keeps the effort and serves the CLI-standard tiers', toHaikuPro.kind === 'switched' && caps.effort!.current() === 'max' && prefs.data.effort === 'max' && effortEvents().length === 0 && caps.effort!.levels().map(level => level.id).join() === 'low,medium,high,xhigh,max' && caps.effort!.levels().every(level => level.label !== level.id) && caps.effort!.levelsFallback === true, { current: caps.effort!.current(), prefs: prefs.data.effort, events: effortEvents(), levels: caps.effort!.levels() })
  await caps.effort!.set('xhigh')
  check('effort: a fallback tier applies through applyFlagSettings like any level', fake.queries[0]!.calls.some(call => call.method === 'applyFlagSettings' && JSON.stringify(call.args[0]) === JSON.stringify({ effortLevel: 'xhigh' })) && caps.effort!.current() === 'xhigh' && prefs.data.effort === 'xhigh')

  // supportsEffort:true with no level list (old CLI): a declared-support
  // claim without a list is still a missing list — same fallback.
  events.length = 0
  const toLegacy = await caps.models!.set({ model: 'legacy' })
  check('models: supported-but-unlisted rows take the same marked fallback', toLegacy.kind === 'switched' && caps.effort!.current() === 'xhigh' && prefs.data.effort === 'xhigh' && effortEvents().length === 0 && caps.effort!.levelsFallback === true && caps.effort!.levels().map(level => level.id).join() === 'low,medium,high,xhigh,max', { current: caps.effort!.current(), prefs: prefs.data.effort, events: effortEvents() })

  // A remembered tier outside even the fallback ladder (a relay-specific id
  // the user pinned earlier) is kept verbatim: the CLI is the authority on
  // what it will run, and the TUI neither rewrites the pref nor pretends
  // the picker offers it (the slider marks no tier as current).
  await caps.effort!.set('turbo')
  events.length = 0
  const toHaikuProAgain = await caps.models!.set({ model: 'haiku-pro' })
  check('models: a remembered tier outside the fallback ladder is kept verbatim', toHaikuProAgain.kind === 'switched' && caps.effort!.current() === 'turbo' && prefs.data.effort === 'turbo' && effortEvents().length === 0, { current: caps.effort!.current(), prefs: prefs.data.effort })

  // A declared list that excludes the tier is a real refusal: still cleared.
  await caps.models!.set({ model: 'opus' })
  check('models: a declared list excluding the tier still clears', caps.effort!.current() === undefined && prefs.data.effort === undefined && effortEvents().at(-1) === null && caps.effort!.levels().map(level => level.id).join() === 'low,medium,high,max')

  // The cleared effort does not resurrect, a refused switch never touches
  // it, and setting one again works.
  events.length = 0
  await caps.models!.set({ model: 'haiku-pro' })
  check('models: a cleared effort stays cleared across switches', caps.effort!.current() === undefined && prefs.data.effort === undefined && effortEvents().length === 0 && caps.effort!.levels().map(level => level.id).join() === 'low,medium,high,xhigh,max')
  const refused = await caps.models!.set({ model: 'gpt-5' })
  check('models: a refused switch leaves the effort untouched', refused.kind === 'refused' && caps.effort!.current() === undefined && prefs.data.effort === undefined)
  await caps.effort!.set('max')
  check('effort: settable again after a clear', caps.effort!.current() === 'max' && prefs.data.effort === 'max' && effortEvents().at(-1) === 'max')
  await session.dispose()
}

// ── external model confirmations converge the effort too (R2-4) ──────
{
  // A model change the TUI did not make — a settings edit, /model in
  // another client, a relay rerouting — reaches the session as an init
  // frame or a message_start drift, never through models.set. Every
  // authoritative confirmation (the open/resume seed included) runs the
  // same explicit-refusal convergence as a manual switch; a row with no
  // effort metadata keeps the choice (the standing contract).
  const CATALOG = [
    ...MODELS,
    { value: 'relay', resolvedModel: 'relay-custom-x', displayName: 'Relay', description: 'no effort metadata' },
  ]
  const fake = fakeClaudeSdk(() => ({ capabilities: ['msg_lifecycle_v1'], models: CATALOG }), controls)
  const prefs = memoryClaudePrefs({ effort: 'max' })
  const session = await openClaudeSession(claudeDeps(fake.sdk, { prefs }))
  const events: AgentEvent[] = []
  session.subscribe(batch => { events.push(...batch) })
  await tick()
  const caps = session.capabilities
  const query = fake.queries[0]!
  const effortEvents = () => events.filter(event => event.type === 'effort.changed').map(event => event.effort)

  // Seed source (handshake default): the open seeded the catalog's default
  // row (Sonnet, levels low..high) — the remembered max is excluded and
  // converges at once, before any frame or UI ask.
  check('seed: the open seed converges the effort with the seeded model', caps.models!.current().model === 'claude-sonnet-x' && caps.effort!.current() === undefined && prefs.data.effort === undefined && JSON.stringify(effortEvents()) === '[null]', { model: caps.models!.current().model, current: caps.effort!.current(), prefs: prefs.data.effort, events: effortEvents() })

  // init-frame source: set max again; the CLI's first init frame names the
  // no-effort Haiku — cleared everywhere, exactly one event.
  await caps.effort!.set('max')
  events.length = 0
  query.emit({ ...init, model: 'claude-haiku-x' })
  await tick()
  check('init frame: a no-effort model clears the effort', caps.models!.current().model === 'claude-haiku-x' && caps.effort!.current() === undefined && prefs.data.effort === undefined && JSON.stringify(effortEvents()) === '[null]' && caps.effort!.levels().length === 0, { model: caps.models!.current().model, current: caps.effort!.current(), events: effortEvents() })

  // message_start source: the drift frame carries the relay's custom row
  // — missing metadata keeps the choice; a declared list that excludes
  // the tier still clears.
  await caps.effort!.set('max')
  events.length = 0
  query.emit({ type: 'stream_event', event: { type: 'message_start', message: { id: 'msg_r24a', model: 'relay-custom-x' } }, parent_tool_use_id: null })
  await tick()
  check('message_start: missing metadata keeps the effort', caps.models!.current().model === 'relay-custom-x' && caps.effort!.current() === 'max' && prefs.data.effort === 'max' && effortEvents().length === 0 && caps.effort!.levelsFallback === true, { model: caps.models!.current().model, current: caps.effort!.current() })
  query.emit({ type: 'stream_event', event: { type: 'message_start', message: { id: 'msg_r24b', model: 'claude-sonnet-x' } }, parent_tool_use_id: null })
  await tick()
  check('message_start: a declared list excluding the tier clears', caps.effort!.current() === undefined && prefs.data.effort === undefined && effortEvents().at(-1) === null, { current: caps.effort!.current(), events: effortEvents() })
  await session.dispose()

  // Session-fallback source: the persisted model choice seeds the session
  // (prefs before the handshake default) — a no-effort row clears at open.
  const fallbackFake = fakeClaudeSdk(() => ({ capabilities: [], models: CATALOG }), controls)
  const fallbackPrefs = memoryClaudePrefs({ model: 'haiku', effort: 'max' })
  const fallback = await openClaudeSession(claudeDeps(fallbackFake.sdk, { prefs: fallbackPrefs }))
  const fallbackEvents: AgentEvent[] = []
  fallback.subscribe(batch => { fallbackEvents.push(...batch) })
  await tick()
  check('session fallback: the persisted no-effort model clears the effort at open', fallback.capabilities.models!.current().model === 'haiku' && fallback.capabilities.effort!.current() === undefined && fallbackPrefs.data.effort === undefined && fallbackEvents.filter(event => event.type === 'effort.changed').map(event => event.effort).at(-1) === null, { model: fallback.capabilities.models!.current().model, current: fallback.capabilities.effort!.current(), prefs: fallbackPrefs.data.effort })
  await fallback.dispose()

  // Resume-seed source: the replay names the model no frame will
  // re-announce — the seed converges with it at open.
  const resumeFake = fakeClaudeSdk(() => ({ capabilities: [], models: CATALOG }), controls)
  const resumePrefs = memoryClaudePrefs({ effort: 'max' })
  const resumed = await openClaudeSession(claudeDeps(resumeFake.sdk, { prefs: resumePrefs, resume: { events: [], start: { turn: 2, seq: 3, model: 'claude-haiku-x' } } }))
  const resumeEvents: AgentEvent[] = []
  resumed.subscribe(batch => { resumeEvents.push(...batch) })
  await tick()
  check('resume seed: the replay model converges the effort at open', resumed.capabilities.models!.current().model === 'claude-haiku-x' && resumed.capabilities.effort!.current() === undefined && resumePrefs.data.effort === undefined && resumeEvents.filter(event => event.type === 'effort.changed').map(event => event.effort).at(-1) === null, { model: resumed.capabilities.models!.current().model, current: resumed.capabilities.effort!.current(), prefs: resumePrefs.data.effort })
  await resumed.dispose()
}

// ── the channel and the screen ────────────────────────────────────────
{
  const fake = fakeClaudeSdk(() => ({ capabilities: ['msg_lifecycle_v1'], models: MODELS, commands: COMMANDS }), controls)
  const session = await openClaudeSession(claudeDeps(fake.sdk, { prefs: memoryClaudePrefs() }))
  const ctx = {
    on: () => () => undefined,
    get: (name: string) => name === 'dshAuth' ? { api: { providers: () => Promise.resolve([]), login: () => Promise.reject(new Error('no')), logout: () => Promise.resolve(false) } } : undefined,
    logger: { warn: () => undefined, info: () => undefined, debug: () => undefined },
  } as never
  // The status line's backend-native mode segment is always shown — the
  // `statusBar.mode` field switch does not gate it (only the minimal UI
  // hides it) — so this render uses the DEFAULT status bar config and the
  // mode label must still be on screen.
  const channel = createChannel(ctx, session, { model: 'Claude Agent', provider: 'claude', cwd: '/fixture/project', activity: false, backendLabel: 'Claude Agent' })
  const query = fake.queries[0]!
  query.emit(init)
  await settled(() => channel.model === 'claude-sonnet-x')
  try {
    check('channel: the native modes, models, effort, compact, mcp, context and login commands are served', ['model', 'effort', 'compact', 'mcp', 'context', 'login'].every(name => channel.backendCapabilities.commands.includes(name)), channel.backendCapabilities.commands)
    check('channel: backend commands merge after the local ones, local names win, terminal-only dropped', await settled(() => channel.commandList.some(command => command.name === 'review' && command.origin === 'backend'))
      && channel.commandList.filter(command => command.name === 'compact').length === 1 && channel.commandList.find(command => command.name === 'compact')?.origin === undefined
      && !channel.commandList.some(command => command.name === 'doctor' && command.origin === 'backend'), channel.commandList.map(command => `${command.name}:${command.origin ?? 'local'}`))
    check('channel: the base mode is unmarked', channel.mode.label === claudeText('claude-mode-default') && channel.modeIndex === 0)
    await channel.cycleMode()
    check('channel: Shift+Tab cycles to acceptEdits with its native label', await settled(() => channel.mode.label === claudeText('claude-mode-acceptEdits')) && channel.modeIndex === 1 && channel.mode.sandbox === undefined && channel.mode.approval === undefined)
    await channel.cycleMode()
    check('channel: plan mode is marked as plan', await settled(() => channel.mode.plan === true && channel.mode.label === claudeText('claude-mode-plan')))
    const models = await channel.listModels()
    check('channel: /model lists one provider (the backend)', models.length === 3 && models.every(model => model.provider === 'claude'))
    check('channel: switching by bare id works', await channel.switchModel('claude', 'opus') === true)
    check('channel: the effort readout follows', await channel.setEffort('high') === true && await settled(() => channel.reasoningEffort === 'high') && channel.effortLevels?.join() === 'low,medium,high,max')
    query.emit({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', unifiedWindows: { five_hour: { utilization: 0.42 }, seven_day: { utilization: 0.87 } } } })
    check('channel: subscription usage is kept', await settled(() => channel.rateLimit?.windows.length === 2))
    query.emit({ type: 'system', subtype: 'status', status: 'requesting' })
    query.emit({ type: 'result', subtype: 'success', is_error: false, result: 'done', total_cost_usd: 0.01, modelUsage: { x: { contextWindow: 200000 } } })
    check('channel: /context is the backend\'s report', await settled(() => channel.loadedContext?.sections[0]?.name === 'Core instructions') && channel.loadedContext?.files[0]?.displayPath === './CLAUDE.md' && channel.loadedContext.tools.some(tool => tool.name === 'docs › search'))
    check('channel: /mcp reads the report', await settled(() => channel.mcpStatus()[0] === t('backend-mcp-heading', { n: 2 })) && channel.mcpStatus().some(line => line.includes('needs-auth')))
    const auth = channel.backendAuth()
    await auth!.login(async (oauth, provider) => { check('channel: /login gets the backend sign-in host (dsh-auth surface, anthropic)', provider === 'anthropic' && oauth !== undefined); return 'cancelled' })
    check('channel: its status names the source', channel.rows.some(row => row.text === claudeText('claude-auth-source', { source: claudeText('claude-auth-source-claude-login') })))

    // ── headless render ──────────────────────────────────────────────
    const COLS = 110
    const ROWS = 32
    const terminal = new Terminal({ cols: COLS, rows: ROWS, scrollback: 400, allowProposedApi: true })
    class FakeStdout extends Writable {
      columns = COLS
      rows = ROWS
      isTTY = true
      _write(chunk: unknown, _encoding: BufferEncoding, callback: () => void) { terminal.write(String(chunk), callback) }
    }
    class FakeStdin extends PassThrough {
      isTTY = true
      setRawMode() { return this }
      ref() { return this }
      unref() { return this }
    }
    const screen = (): string => {
      const buffer = terminal.buffer.active
      return Array.from({ length: buffer.length }, (_, y) => buffer.getLine(y)?.translateToString(true) ?? '').join('\n')
    }
    const stdin = new FakeStdin()
    const stdout = new FakeStdout()
    const app = await render(React.createElement(Chat, { channel, questionStore: new QuestionStore(), onExit: () => undefined, fullscreen: false, trajectorySeen: true }), {
      stdout: stdout as never, stdin: stdin as never, stderr: stdout as never, exitOnCtrlC: false, patchConsole: false,
    })
    try {
      check('render: the status line shows the native mode label under the DEFAULT status bar config', await settled(() => screen().includes(claudeText('claude-mode-plan'))), screen())
      // 固定窗:pacing the prompt attaches its key handler after the first frame.
      await sleep(200)
      for (const char of '/context') stdin.write(char)
      // 固定窗:pacing typed characters land before Enter.
      await sleep(100)
      stdin.write('\r')
      check('render: /context shows the backend\'s sections, files and tools', await settled(() => screen().includes('Core instructions') && screen().includes('./CLAUDE.md') && screen().includes('docs › search')), screen())
    } finally {
      app.unmount()
      terminal.dispose()
    }
  } finally {
    channel.releaseContributions()
  }
}


// ── /permission over the native modes + the footer mode chip (click) ──
{
  const fake = fakeClaudeSdk(() => ({ capabilities: ['msg_lifecycle_v1'], models: MODELS, commands: COMMANDS }), controls)
  const session = await openClaudeSession(claudeDeps(fake.sdk, { prefs: memoryClaudePrefs() }))
  const ctx = {
    on: () => () => undefined,
    get: () => undefined,
    logger: { warn: () => undefined, info: () => undefined, debug: () => undefined },
  } as never
  // Default status bar config: the backend-native mode segment shows anyway.
  const channel = createChannel(ctx, session, { model: 'Claude Agent', provider: 'claude', cwd: '/fixture/project', activity: false, backendLabel: 'Claude Agent' })
  const query = fake.queries[0]!
  query.emit(init)
  await settled(() => channel.model === 'claude-sonnet-x')
  const COLS = 110
  const ROWS = 32
  const terminal = new Terminal({ cols: COLS, rows: ROWS, scrollback: 0, allowProposedApi: true })
  class FakeStdout extends Writable {
    columns = COLS
    rows = ROWS
    isTTY = true
    _write(chunk: unknown, _encoding: BufferEncoding, callback: () => void): void { terminal.write(String(chunk), callback) }
  }
  class FakeStdin extends PassThrough {
    isTTY = true
    setRawMode() { return this }
    ref() { return this }
    unref() { return this }
  }
  const stdin = new FakeStdin()
  const stdout = new FakeStdout()
  const screen = (): string => {
    const buffer = terminal.buffer.active
    return Array.from({ length: buffer.length }, (_, y) => buffer.getLine(y)?.translateToString(true) ?? '').join('\n')
  }
  const footer = (): string => {
    const lines = screen().split('\n')
    while (lines.length > 0 && lines[lines.length - 1]!.trim() === '') lines.pop()
    return lines.slice(-4).join('\n')
  }
  // AlternateScreen resolves its renderer through instances.get(process.stdout)
  // with a single-entry fallback: the earlier section's unmounted instance must
  // not answer for this render's alt-screen gate.
  for (const key of [...instances.keys()]) instances.delete(key)
  const app = await render(React.createElement(AlternateScreen, null, React.createElement(Chat, { channel, questionStore: new QuestionStore(), onExit: () => undefined, fullscreen: true, trajectorySeen: true })), {
    stdout: stdout as never, stdin: stdin as never, stderr: stdout as never, exitOnCtrlC: false, patchConsole: false,
  })
  try {
    // The base mode is shown too (backend modes are always visible in the
    // footer — a DSH base mode stays unmarked/hidden by its own rule).
    const callsBefore = permissionModeCalls.length
    check('render: the footer shows the base native mode', await settled(() => footer().includes(claudeText('claude-mode-default'))), footer())
    const hit = findText(terminal, claudeText('claude-mode-default'))
    check('render: the footer mode segment is locatable', hit !== null)
    if (hit !== null) {
      const seq = (final: string): string => '\x1b[<0;' + (hit.col + 1) + ';' + (hit.row + 1) + final
      stdin.write(seq('M'))
      await sleep(30) // 固定窗:pacing 鼠标 press→release 步间
      stdin.write(seq('m'))
      check('render: clicking the mode segment opens the /permission picker', await settled(() => screen().includes(t('permission-mode-picker-title')) && screen().includes(claudeText('claude-mode-acceptEdits'))), screen())
      // 人话解释：每行的第二行必须是「这个模式会做什么」，而不是把名字再打
      // 一遍（旧实现 description = name）。bypass 行同样带着它的解释。
      check('render: picker rows explain themselves instead of repeating the name', await settled(() => screen().includes(claudeText('claude-mode-desc-acceptEdits')) && screen().includes(claudeText('claude-mode-desc-bypassPermissions'))), screen())
      stdin.write('\x1b[B')
      await sleep(80) // 固定窗:pacing the arrow move lands before Enter.
      stdin.write('\r')
      check('render: picker Enter drives setPermissionMode once', await settled(() => permissionModeCalls.length - callsBefore === 1 && permissionModeCalls[permissionModeCalls.length - 1] === 'acceptEdits'), permissionModeCalls.join(','))
      check('render: the footer follows the native mode.changed', await settled(() => footer().includes(claudeText('claude-mode-acceptEdits'))), footer())
    }
    await sleep(200) // 固定窗:pacing the prompt attaches its key handler after the picker closed.
    for (const char of '/permission status') stdin.write(char)
    await sleep(100) // 固定窗:pacing typed characters land before Enter.
    stdin.write('\r')
    check('render: /permission status reports the current native mode', await settled(() => screen().includes(t('permission-mode-current', { name: '' }).trim()) && screen().includes(claudeText('claude-mode-acceptEdits'))), screen())
  } finally {
    app.unmount()
    terminal.dispose()
  }
  channel.releaseContributions()
}
console.log(`\nverify-claude-controls OK (${passed} checks)`)
process.exit(0)
