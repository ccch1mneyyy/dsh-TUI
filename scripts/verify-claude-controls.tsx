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
 *  - modes: default → acceptEdits → plan (auto only where the model supports
 *    it, bypass never); `setPermissionMode`, confirmed as `mode.changed`;
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

process.env.FORCE_COLOR = '3'

const [
  { PassThrough, Writable },
  React,
  { Terminal },
  { render },
  { Chat },
  { QuestionStore },
  { openClaudeSession },
  { memoryClaudePrefs },
  { createChannel },
  { setLang, t },
  { settled, sleep },
  fakes,
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
const controls = {
  setModel: () => undefined,
  setPermissionMode: () => undefined,
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

  check('modes: auto only where the model supports it, bypass never', caps.modes!.list().map(mode => mode.id).join() === 'default,acceptEdits,plan,auto')
  await caps.models!.set({ model: 'default' })
  check('modes: default → acceptEdits → plan without auto', caps.modes!.list().map(mode => mode.id).join() === 'default,acceptEdits,plan')
  await caps.modes!.set('acceptEdits')
  check('modes: setPermissionMode, confirmed as mode.changed', query.calls.some(call => call.method === 'setPermissionMode' && call.args[0] === 'acceptEdits') && caps.modes!.current() === 'acceptEdits' && events.some(event => event.type === 'mode.changed' && event.modeId === 'acceptEdits'))
  check('modes: bypassPermissions is refused', await caps.modes!.set('bypassPermissions').then(() => false, () => true))
  query.emit({ type: 'system', subtype: 'status', status: null, permissionMode: 'acceptEdits' })
  await tick()
  check('modes: the CLI\'s confirming status frame is not reported twice', events.filter(event => event.type === 'mode.changed' && event.modeId === 'acceptEdits').length === 1)

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

// ── a persisted choice starts the next session ────────────────────────
{
  const fake = fakeClaudeSdk(() => ({ capabilities: [], models: MODELS }), controls)
  const session = await openClaudeSession(claudeDeps(fake.sdk, { prefs: memoryClaudePrefs({ model: 'opus', effort: 'high' }) }))
  check('the persisted model and effort are query options', fake.queries[0]!.options.model === 'opus' && fake.queries[0]!.options.effort === 'high')
  await session.dispose()
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
  // The status line's mode field is opt-in (`statusBar.mode`, as on DSH).
  const channel = createChannel(ctx, session, { model: 'Claude Agent', provider: 'claude', cwd: '/fixture/project', activity: false, backendLabel: 'Claude Agent', statusBar: { mode: true } })
  const query = fake.queries[0]!
  query.emit(init)
  await settled(() => channel.model === 'claude-sonnet-x')
  try {
    check('channel: the native modes, models, effort, compact, mcp, context and login commands are served', ['model', 'effort', 'compact', 'mcp', 'context', 'login'].every(name => channel.capabilities.commands.includes(name)), channel.capabilities.commands)
    check('channel: backend commands merge after the local ones, local names win, terminal-only dropped', await settled(() => channel.commandList.some(command => command.name === 'review' && command.origin === 'backend'))
      && channel.commandList.filter(command => command.name === 'compact').length === 1 && channel.commandList.find(command => command.name === 'compact')?.origin === undefined
      && !channel.commandList.some(command => command.name === 'doctor' && command.origin === 'backend'), channel.commandList.map(command => `${command.name}:${command.origin ?? 'local'}`))
    check('channel: the base mode is unmarked', channel.mode.label === t('claude-mode-default') && channel.modeIndex === 0)
    await channel.cycleMode()
    check('channel: Shift+Tab cycles to acceptEdits with its native label', await settled(() => channel.mode.label === t('claude-mode-acceptEdits')) && channel.modeIndex === 1 && channel.mode.sandbox === undefined && channel.mode.approval === undefined)
    await channel.cycleMode()
    check('channel: plan mode is marked as plan', await settled(() => channel.mode.plan === true && channel.mode.label === t('claude-mode-plan')))
    const models = await channel.listModels()
    check('channel: /model lists one provider (the backend)', models.length === 3 && models.every(model => model.provider === 'claude'))
    check('channel: switching by bare id works', await channel.switchModel('claude', 'opus') === true)
    check('channel: the effort readout follows', await channel.setEffort('high') === true && await settled(() => channel.reasoningEffort === 'high') && channel.effortLevels?.join() === 'low,medium,high,max')
    query.emit({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', unifiedWindows: { five_hour: { utilization: 0.42 }, seven_day: { utilization: 0.87 } } } })
    check('channel: subscription usage is kept', await settled(() => channel.rateLimit?.windows.length === 2))
    query.emit({ type: 'system', subtype: 'status', status: 'requesting' })
    query.emit({ type: 'result', subtype: 'success', is_error: false, result: 'done', total_cost_usd: 0.01, modelUsage: { x: { contextWindow: 200000 } } })
    check('channel: /context is the backend\'s report', await settled(() => channel.loadedContext?.sections[0]?.name === 'Core instructions') && channel.loadedContext?.files[0]?.displayPath === './CLAUDE.md' && channel.loadedContext.tools.some(tool => tool.name === 'docs › search'))
    check('channel: /mcp reads the report', await settled(() => channel.mcpStatus()[0] === t('claude-mcp-heading', { n: 2 })) && channel.mcpStatus().some(line => line.includes('needs-auth')))
    const auth = channel.backendAuth()
    check('channel: /login gets the backend sign-in host (dsh-auth surface, anthropic)', auth?.provider === 'anthropic' && auth.oauth !== undefined)
    check('channel: its status names the source', (await auth!.status()).some(line => line === t('claude-auth-source', { source: t('claude-auth-source-claude-login') })))

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
      check('render: the status line shows the native mode label', await settled(() => screen().includes(t('claude-mode-plan'))), screen())
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

console.log(`\nverify-claude-controls OK (${passed} checks)`)
process.exit(0)
