/**
 * `/btw`, `/recap`, `/rename`, `/color` and `/mcp reconnect|toggle` on a
 * Claude session, over a fake SDK (no CLI, no network):
 *
 *  - the side query is a throwaway fork: `resume` = the current session id,
 *    `forkSession`, `persistSession:false`, no tools, one turn, the
 *    session's model, environment and route pin; its text streams to the
 *    caller, the query is closed after the answer, on abort and on failure;
 *    an unpersisted session has nothing to fork; an error result is an error;
 *  - through the channel: `/btw` sends the shared side-question contract,
 *    `/recap` the conversation recap contract and parses title + summary;
 *    the open-time recap stays off for Claude (it would spend on every
 *    open);
 *  - `/rename`: `renameSession(id, title, {dir})` and a `session.title`
 *    (status line); before the CLI wrote the transcript the title is kept
 *    and written with the first persisted frame;
 *  - `/color`: kept per session id in the Claude prefs (bounded: the oldest
 *    past 200 are pruned), reported as `session.color`, restored when the
 *    session opens again;
 *  - `/mcp reconnect <name>` / `/mcp toggle <name> on|off`: the capability
 *    calls, the notice, completion of subcommands, server names (from the
 *    last status report) and on/off; a DSH session's `/mcp` is unchanged;
 *  - the commands appear for Claude (capability snapshot) and stay as they
 *    were for DSH.
 *
 * Run: node --import tsx/esm scripts/verify-claude-session-commands.ts
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'dsh-tui-claude-commands-'))
process.env.HOME = home
process.env.USERPROFILE = home

const [
  { openClaudeSession },
  { memoryClaudePrefs, fileClaudePrefs, COLOR_LIMIT },
  { createChannel },
  { channelCapabilities },
  { sideQuestionPrompt, conversationRecapPrompt },
  { OPTION_POLICY, buildSideQueryOptions },
  { setLang, t },
  { settled },
  fakes,
] = await Promise.all([
  import('../src/backends/claude/session.js'),
  import('../src/backends/claude/prefs.js'),
  import('../src/dsh-adapter/channel.js'),
  import('../src/channel/capabilities.js'),
  import('../src/channel/side-prompts.js'),
  import('../src/backends/claude/options.js'),
  import('../src/i18n.js'),
  import('./lib/term-test.mjs'),
  import('./lib/claude-fake-sdk.js'),
])
type AgentEvent = import('../src/agent/events.js').AgentEvent

setLang('en')
let passed = 0
const check = (label: string, ok: boolean, detail?: unknown): void => {
  assert.ok(ok, detail === undefined ? label : `${label}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`)
  passed += 1
  console.log(`PASS ${label}`)
}
const { fakeClaudeSdk, claudeDeps, tick } = fakes
const ctx = { on: () => () => undefined, get: () => undefined, logger: { warn: () => undefined, info: () => undefined, debug: () => undefined } } as never
const SESSION = '00000000-0000-4000-8000-0000000000ab'

/** A session whose CLI has written its transcript (one turn ran). */
async function persistedSession(extra: Record<string, unknown> = {}, listen = true) {
  const renames: { id: string; title: string; dir?: string }[] = []
  const fake = fakeClaudeSdk(() => ({ capabilities: ['msg_lifecycle_v1'] }), {
    mcpServerStatus: () => [{ name: 'github', status: 'connected', tools: [{}, {}] }, { name: 'claude.ai Gmail', status: 'needs-auth' }, { name: 'linear', status: 'failed' }],
    reconnectMcpServer: () => undefined,
    toggleMcpServer: () => undefined,
  })
  const store = {
    getSessionMessages: () => Promise.resolve([]),
    forkSession: () => Promise.resolve({ sessionId: 'f' }),
    renameSession: (id: string, title: string, options?: { dir?: string }) => { renames.push({ id, title, ...(options?.dir === undefined ? {} : { dir: options.dir }) }); return Promise.resolve() },
  }
  const plan = { source: 'dsh-auth' as const, expiresAt: 1, env: { PATH: '/usr/bin', CLAUDE_CODE_OAUTH_TOKEN: 'tok' }, settings: { env: { ANTHROPIC_BASE_URL: 'https://api.anthropic.com' } } }
  const session = await openClaudeSession(claudeDeps(fake.sdk, { prefs: memoryClaudePrefs(), store: store as never, auth: { plan, renew: () => Promise.resolve(plan) }, ...extra }))
  const events: AgentEvent[] = []
  // The start backlog goes to the first subscriber: a channel that must see
  // it (the restored colour) subscribes first (`listen` false).
  if (listen) session.subscribe(batch => { events.push(...batch) })
  await tick()
  const main = fake.queries[0]!
  return { fake, session, events, main, renames, persist: async () => {
    await session.submit({ text: 'hello', clientMessageId: 'u1' }, 'turn')
    main.emit({ type: 'command_lifecycle', command_uuid: 'u1', state: 'started' })
    main.emit({ type: 'system', subtype: 'init', model: 'claude-haiku-4-5', permissionMode: 'default', slash_commands: [], tools: [], claude_code_version: '2.1.287' })
    main.emit({ type: 'stream_event', event: { type: 'message_start', message: { id: 'm1', model: 'claude-haiku-4-5', usage: {} } } })
    main.emit({ type: 'assistant', message: { id: 'm1', model: 'claude-haiku-4-5', content: [{ type: 'text', text: 'hi' }] } })
    main.emit({ type: 'result', subtype: 'success', is_error: false, result: 'hi', total_cost_usd: 0.001, modelUsage: {} })
    await settled(() => session.status === 'idle')
  } }
}

/** Answer the side query the fake started (index `n`) with streamed text. */
function answer(query: { emit(message: unknown): void }, text: string): void {
  query.emit({ type: 'system', subtype: 'init', model: 'claude-haiku-4-5' })
  query.emit({ type: 'stream_event', event: { type: 'message_start', message: { id: 'side-1', model: 'claude-haiku-4-5', usage: {} } } })
  for (const part of [text.slice(0, 5), text.slice(5)]) query.emit({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: part } } })
  query.emit({ type: 'assistant', message: { id: 'side-1', content: [{ type: 'text', text }] } })
  query.emit({ type: 'result', subtype: 'success', is_error: false, result: text, total_cost_usd: 0.04 })
}

// ── the side query ─────────────────────────────────────────────────────
{
  const { fake, session, persist } = await persistedSession()
  try {
    const early = await session.capabilities.sideQuery!.ask('anything?')
    check('a session the CLI has not persisted has nothing to fork', early.answer === null && early.error === t('claude-side-query-empty') && fake.queries.length === 1)
    await persist()
    const deltas: string[] = []
    const pending = session.capabilities.sideQuery!.ask('What did we say?', { onText: delta => { deltas.push(delta) } })
    await settled(() => fake.queries.length === 2)
    const side = fake.queries[1]!
    const options = side.options as Record<string, unknown>
    check('the side query forks the CURRENT session, writes no transcript, has no tools, one turn', options.resume === SESSION && options.forkSession === true && options.persistSession === false && Array.isArray(options.tools) && (options.tools as unknown[]).length === 0 && options.maxTurns === 1, options)
    check('… with the session\'s model, environment and route pin', options.model === 'claude-haiku-4-5' && (options.env as Record<string, string>).CLAUDE_CODE_OAUTH_TOKEN === 'tok' && side.flagSettings?.env?.ANTHROPIC_BASE_URL === 'https://api.anthropic.com' && typeof options.settings === 'string')
    check('… and the session\'s system prompt and settings sources', JSON.stringify(options.systemPrompt) === JSON.stringify({ type: 'preset', preset: 'claude_code' }) && JSON.stringify(options.settingSources) === JSON.stringify(['user', 'project', 'local']))
    await settled(() => side.inputs.length === 1)
    check('the prompt is the one message', JSON.stringify((side.inputs[0]?.message as { content?: unknown })?.content) === JSON.stringify('What did we say?'))
    answer(side, 'You said hello.')
    const outcome = await pending
    check('its text streams to the caller and is the answer', outcome.answer === 'You said hello.' && deltas.join('') === 'You said hello.', { outcome, deltas })
    check('the side query is closed after the answer', side.closed)
    check('… and its flag settings file is removed', !existsSync(options.settings as string))
    check('… and the session\'s own query is untouched', !fake.queries[0]!.closed && session.status === 'idle')
    // Abort mid-answer.
    const controller = new AbortController()
    const aborted = session.capabilities.sideQuery!.ask('Long?', { signal: controller.signal })
    await settled(() => fake.queries.length === 3)
    fake.queries[2]!.emit({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'par' } } })
    await tick()
    controller.abort()
    fake.queries[2]!.emit({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'tial' } } })
    const abortedOutcome = await aborted
    check('an abort answers null without an error and closes the query', abortedOutcome.answer === null && abortedOutcome.error === undefined && fake.queries[2]!.closed)
    // An error result.
    const failing = session.capabilities.sideQuery!.ask('Fail?')
    await settled(() => fake.queries.length === 4)
    fake.queries[3]!.emit({ type: 'result', subtype: 'success', is_error: true, result: 'API Error: 529 overloaded' })
    const failed = await failing
    check('an error result is an error (and closes the query)', failed.answer === null && failed.error === 'API Error: 529 overloaded' && fake.queries[3]!.closed)
  } finally {
    await session.dispose()
  }
}

// ── the side query's options are classified ────────────────────────────
{
  const built = Object.keys(buildSideQueryOptions({ cwd: '/p', resume: 's', env: {}, executable: '/bin/claude', abortController: new AbortController(), stderr: () => undefined, model: 'haiku', settings: { env: {} } }))
  const policy = OPTION_POLICY as Record<string, string>
  const side = Object.keys(policy).filter(key => policy[key] === 'side')
  check('the side query sets every `side` option and otherwise only `set` ones', side.every(key => built.includes(key)) && built.every(key => policy[key] === 'side' || policy[key] === 'set'), { built, side })
}

// ── /btw and /recap through the channel ────────────────────────────────
{
  const { fake, session, persist } = await persistedSession()
  const channel = createChannel(ctx, session, { model: 'Claude Agent', provider: 'claude', cwd: '/fixture/project', activity: false, backendLabel: 'Claude Agent' })
  try {
    await persist()
    check('the commands are offered for Claude', ['btw', 'recap', 'rename', 'color', 'mcp'].every(name => channel.backendCapabilities.commands.includes(name)) && channel.backendCapabilities.sideQuery && channel.backendMcp() !== undefined)
    check('the open-time recap stays off for Claude (it would spend on every open)', channel.autoRecapOnOpen === false)
    const streamed: string[] = []
    const btw = channel.sideQuestion('what changed?', { onText: delta => { streamed.push(delta) } })
    await settled(() => fake.queries.length === 2)
    await settled(() => fake.queries[1]!.inputs.length === 1)
    check('/btw sends the shared side-question contract', (fake.queries[1]!.inputs[0]?.message as { content?: unknown })?.content === sideQuestionPrompt('what changed?'))
    answer(fake.queries[1]!, 'Nothing yet.')
    const btwOutcome = await btw
    check('/btw streams and answers', btwOutcome.answer === 'Nothing yet.' && streamed.join('') === 'Nothing yet.')
    const recap = channel.recapRecent()
    await settled(() => fake.queries.length === 3 && fake.queries[2]!.inputs.length === 1)
    check('/recap sends the conversation recap contract', (fake.queries[2]!.inputs[0]?.message as { content?: unknown })?.content === conversationRecapPrompt())
    answer(fake.queries[2]!, '{"title":"Greeting test","summary":"The user said hello and got a reply."}')
    const recapOutcome = await recap
    check('/recap parses the summary and the proposed title', recapOutcome.summary === 'The user said hello and got a reply.' && recapOutcome.title === 'Greeting test', recapOutcome)
  } finally {
    channel.releaseContributions()
    await session.dispose()
  }
}

// ── /rename ────────────────────────────────────────────────────────────
{
  const { session, events, renames, persist, main } = await persistedSession()
  const channel = createChannel(ctx, session, { model: 'Claude Agent', provider: 'claude', cwd: '/fixture/project', activity: false, backendLabel: 'Claude Agent' })
  try {
    channel.renameSession('Early title')
    check('a rename before the transcript exists shows at once (status line)', await settled(() => channel.sessionTitle === 'Early title') && renames.length === 0)
    check('… as a user-sourced title event', events.some(event => event.type === 'session.title' && event.title === 'Early title' && event.source === 'user'))
    await persist()
    check('… and is written with the first persisted frame', await settled(() => renames.length === 1) && renames[0]!.id === SESSION && renames[0]!.title === 'Early title' && renames[0]!.dir === '/fixture/project', renames)
    channel.renameSession('Final title')
    check('a rename of a persisted session writes it through renameSession', await settled(() => renames.length === 2) && renames[1]!.title === 'Final title' && channel.sessionTitle === 'Final title')
    // A later CLI-generated title does not undo it in the session; the
    // status line shows the newest title event.
    main.emit({ type: 'system', subtype: 'session_title_changed', title: 'CLI title' })
    await settled(() => channel.sessionTitle === 'CLI title')
    check('the CLI\'s own title events still flow', channel.sessionTitle === 'CLI title')
  } finally {
    channel.releaseContributions()
    await session.dispose()
  }
}

// ── /color ─────────────────────────────────────────────────────────────
{
  const prefs = memoryClaudePrefs()
  const { session } = await persistedSession({ prefs })
  const channel = createChannel(ctx, session, { model: 'Claude Agent', provider: 'claude', cwd: '/fixture/project', activity: false, backendLabel: 'Claude Agent' })
  try {
    channel.setSessionColor('purple')
    check('/color sets the accent (state) and keeps it per session id', await settled(() => channel.sessionColor === 'purple') && prefs.color(SESSION) === 'purple')
    channel.setSessionColor('')
    check('/color reset clears it', await settled(() => channel.sessionColor === '') && prefs.color(SESSION) === '')
    channel.setSessionColor('green')
  } finally {
    channel.releaseContributions()
    await session.dispose()
  }
  const again = await persistedSession({ prefs }, false)
  const reopened = createChannel(ctx, again.session, { model: 'Claude Agent', provider: 'claude', cwd: '/fixture/project', activity: false, backendLabel: 'Claude Agent' })
  try {
    check('the accent comes back when the session opens again', await settled(() => reopened.sessionColor === 'green'))
  } finally {
    reopened.releaseContributions()
    await again.session.dispose()
  }
  // Bounded on disk: the oldest past the limit are pruned.
  const dir = mkdtempSync(join(home, 'prefs-'))
  const file = fileClaudePrefs(dir)
  const realNow = Date.now
  let clock = 1_000
  Date.now = () => (clock += 1)
  try {
    for (let index = 0; index < COLOR_LIMIT + 5; index += 1) file.setColor(`s-${index}`, 'blue')
  } finally {
    Date.now = realNow
  }
  const kept = Object.keys(file.read().colors ?? {})
  check(`colours are bounded: the newest ${COLOR_LIMIT} kept, the oldest pruned`, kept.length === COLOR_LIMIT && !kept.includes('s-0') && kept.includes(`s-${COLOR_LIMIT + 4}`) && file.color('s-4') === '' && file.color('s-5') === 'blue')
  file.forget(`s-${COLOR_LIMIT + 4}`)
  check('forgetting a session drops its colour', file.color(`s-${COLOR_LIMIT + 4}`) === '')
}

// ── /mcp reconnect | toggle ────────────────────────────────────────────
{
  const { fake, session } = await persistedSession()
  const channel = createChannel(ctx, session, { model: 'Claude Agent', provider: 'claude', cwd: '/fixture/project', activity: false, backendLabel: 'Claude Agent' })
  try {
    channel.mcpStatus()
    await settled(() => channel.mcpStatus().some(line => line.includes('github')))
    const names = (input: string): string[] => channel.commandCompletions(input).map(item => item.name.split(' ').at(-1)!)
    check('/mcp completes its subcommands', JSON.stringify(names('/mcp ')) === JSON.stringify(['reconnect', 'toggle']), names('/mcp '))
    check('… server names from the last status report (names a command line can carry)', JSON.stringify(names('/mcp reconnect ')) === JSON.stringify(['github', 'linear']) && JSON.stringify(names('/mcp toggle li')) === JSON.stringify(['linear']), names('/mcp reconnect '))
    check('… and on / off after a server', JSON.stringify(names('/mcp toggle github ')) === JSON.stringify(['on', 'off']), names('/mcp toggle github '))
    check('/mcp reconnect calls the capability and says so', await channel.backendMcp()!.reconnect('linear') && fake.queries[0]!.calls.some(call => call.method === 'reconnectMcpServer' && call.args[0] === 'linear') && channel.notifications.some(item => item.text === t('mcp-reconnected', { name: 'linear' })))
    check('/mcp toggle off calls the capability with false', await channel.backendMcp()!.toggle('github', false) && fake.queries[0]!.calls.some(call => call.method === 'toggleMcpServer' && call.args[0] === 'github' && call.args[1] === false) && channel.notifications.some(item => item.text === t('mcp-disabled', { name: 'github' })))
  } finally {
    channel.releaseContributions()
    await session.dispose()
  }
}

// ── DSH keeps its command set and its plain /mcp ───────────────────────
{
  const dsh = channelCapabilities({ backendId: 'dsh', backendLabel: 'DSH', capabilities: { native: {} }, dsh: true })
  check('DSH: the snapshot offers recap/btw/rename/color as before, no MCP control', ['btw', 'recap', 'rename', 'color', 'mcp'].every(name => dsh.commands.includes(name)) && !('mcpControl' in dsh))
}

console.log(`\nverify-claude-session-commands OK (${passed} checks)`)
process.exit(0)
