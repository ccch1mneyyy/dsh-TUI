/**
 * Codex translator gate (docs/codex-backend-design.md §7, §10.3): every
 * thread of every scrubbed wire fixture in scripts/fixtures/codex/wire/
 * runs through the live translator and the one shared projector, and the
 * result (event sequence, transcript rows, status-relevant state) must equal
 * the committed golden in scripts/fixtures/codex/goldens/. Synthetic
 * notification sequences then pin each rule of the attempt/step algorithm
 * (§7.3), the item table (§7.4), the notification table (§7.5) and the
 * card presentations (§8.1–§8.4).
 *
 * No process, no network.
 *
 * Run:    node --import tsx/esm scripts/verify-codex-translate.ts
 * Update: node --import tsx/esm scripts/verify-codex-translate.ts --update
 *         (review the golden diff: it is the behaviour change)
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentEvent } from '../src/agent/events.js'
import { codexEmits } from '../src/backends/codex/translate/events.js'
import { hunkTexts } from '../src/backends/codex/translate/presentation.js'
import { unwrapCommand } from '../src/backends/codex/translate/commands.js'
import { setLang, t } from '../src/i18n.js'
import { golden, liveRun, loadWire, notificationsOf, turnThreads, WIRE_DIR } from './lib/codex-translate-harness.js'

setLang('en')
const GOLDENS = join(import.meta.dirname, 'fixtures', 'codex', 'goldens')
const UPDATE = process.argv.includes('--update')
let passed = 0
const check = (label: string, ok: boolean, detail?: unknown): void => {
  assert.ok(ok, detail === undefined ? label : `${label}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`)
  passed += 1
  console.log(`PASS ${label}`)
}
const of = <T extends AgentEvent['type']>(events: readonly AgentEvent[], type: T) =>
  events.filter((event): event is Extract<AgentEvent, { type: T }> => event.type === type)

// ── goldens ─────────────────────────────────────────────────────────────
mkdirSync(GOLDENS, { recursive: true })
const fixtures = readdirSync(WIRE_DIR).filter(file => file.endsWith('.jsonl')).map(file => file.slice(0, -'.jsonl'.length)).sort()
check('wire fixtures cover the recorded scenarios', ['s1-approvals', 's1b-command-approval', 's2-steer-interrupt-diff', 's3-lifecycle-p1', 's3-lifecycle-p2', 's4-plan-question', 's5-subagent', 'c0-files-delete-fork', 'c0-approval-redeliver-interrupt'].every(name => fixtures.includes(name)), fixtures)
const runs = new Map<string, ReturnType<typeof liveRun>>()
for (const name of fixtures) {
  const wire = loadWire(name)
  turnThreads(wire).forEach((thread, index) => {
    const key = index === 0 ? name : `${name}.${index + 1}`
    const run = liveRun(notificationsOf(wire, thread))
    runs.set(key, run)
    const path = join(GOLDENS, `${key}.golden.json`)
    const actual = JSON.stringify(golden(run), null, 2) + '\n'
    if (UPDATE) {
      writeFileSync(path, actual)
      console.log(`updated ${key}.golden.json`)
      return
    }
    check(`${key}: golden exists`, existsSync(path))
    check(`${key}: matches golden`, readFileSync(path, 'utf8') === actual, `run with --update and review the diff for ${key}`)
  })
}
if (UPDATE) process.exit(0)

// ── vocabulary ──────────────────────────────────────────────────────────
for (const [key, run] of runs) {
  const undeclared = [...new Set(run.events.map(event => event.type))].filter(type => !codexEmits(type))
  check(`${key}: only declared event types`, undeclared.length === 0, undeclared)
  const started = new Set<string>()
  const orphan = run.events.find(event => {
    if (event.type === 'assistant.attempt.start') started.add(event.attemptId)
    return event.type === 'assistant.delta' && !started.has(event.attemptId)
  })
  check(`${key}: attempt.start precedes its deltas`, orphan === undefined, orphan)
  const seqs = run.events.flatMap(event => 'seq' in event && typeof event.seq === 'number' ? [event.seq] : [])
  check(`${key}: seq strictly increases`, seqs.every((seq, index) => index === 0 || seq > seqs[index - 1]!))
}
check('s1-approvals: the stuck turn (F29) stays open', runs.get('s1-approvals')!.harness.state.working && of(runs.get('s1-approvals')!.events, 'turn.end').length === 0)
for (const key of ['s1-approvals.2', 's1b-command-approval', 's2-steer-interrupt-diff', 's3-lifecycle-p1', 's4-plan-question', 'c0-files-delete-fork']) {
  const run = runs.get(key)!
  check(`${key}: every turn closes`, of(run.events, 'turn.start').length === of(run.events, 'turn.end').length && !run.harness.state.working)
}

// ── recorded behaviour ──────────────────────────────────────────────────
{
  const declined = runs.get('s1-approvals.2')!.harness.state.rows.find(row => row.kind === 'tool')
  check('declined file change: an error card that says declined (F14)', declined?.tool?.status === 'error' && declined.tool.errorText === t('codex-declined') && declined.tool.callView?.card === 'diff', declined?.tool)
  const command = runs.get('s1b-command-approval')!.harness.state.rows.find(row => row.kind === 'tool')
  check('approved command: a terminal card titled with the unwrapped command (F13)', command?.tool?.callView?.card === 'terminal' && 'title' in command.tool.callView && command.tool.callView.title === 'echo probe > a.txt' && command.tool.callView.displayKey === 'tool-name-bash', command?.tool)
  const steer = runs.get('s2-steer-interrupt-diff')!
  const users = steer.harness.state.rows.filter(row => row.kind === 'user').map(row => row.text)
  check('steer: the steered message is a user row inside the turn (F10)', users[1] === 'Also include the word banana in your reply.' && of(steer.events, 'turn.start').length === 3)
  check('steer: user rows carry the client id and the item anchor', of(steer.events, 'user.message').map(event => event.id).join(',') === 'a1,a2,b1,c1' && of(steer.events, 'user.message').every(event => event.anchor !== event.id))
  const ends = of(steer.events, 'turn.end').map(event => event.reason.kind)
  check('interrupt: the second turn ends interrupted, the others complete', ends.join(',') === 'completed,interrupted,completed', ends)
  const interruptedCard = steer.harness.state.rows.find(row => row.kind === 'tool' && row.tool?.status === 'error')
  check('interrupt: the never-completed command is closed as interrupted (F11)', interruptedCard?.tool?.errorText === t('codex-interrupted'))
  check('interrupt: an interrupt row marks the abort', steer.harness.state.rows.some(row => row.kind === 'interrupt'))
  const patches = steer.harness.state.rows.filter(row => row.tool?.name === 'apply_patch')
  check('file changes: write (add) then edit (update) diff cards', patches.length === 2 && patches[0]!.tool!.callView?.displayKey === 'tool-name-write' && patches[1]!.tool!.callView?.displayKey === 'tool-name-edit', patches.map(row => row.tool?.callView))
  check('usage: token usage reaches the context sample and the window', (steer.harness.state.lastUsage?.input ?? 0) + (steer.harness.state.lastUsage?.cacheWrite ?? 0) + (steer.harness.state.lastUsage?.cacheRead ?? 0) > 0 && steer.harness.state.contextWindow === 258400, { lastUsage: steer.harness.state.lastUsage, window: steer.harness.state.contextWindow })
  const shell = runs.get('s3-lifecycle-p1')!
  const shellRow = shell.harness.state.rows.find(row => row.tool?.name === 'user_shell')
  check('user shell turn: a `!` terminal card in a user turn (F17)', shellRow?.tool?.callView !== undefined && 'title' in shellRow.tool.callView && shellRow.tool.callView.title === '!echo shell-ok' && of(shell.events, 'turn.start').at(-1)?.origin === 'user', shellRow?.tool?.callView)
  const deleted = runs.get('c0-files-delete-fork')!.events.filter((event): event is Extract<AgentEvent, { type: 'tool.call' }> => event.type === 'tool.call' && event.name === 'apply_patch')
  const deleteDiff = deleted[1]?.presentation
  check('deleted file: the diff card shows the old content (C0 V13)', deleteDiff !== undefined && 'diffs' in deleteDiff && deleteDiff.diffs[0]?.oldText === 'x\n' && deleteDiff.diffs[0]?.newText === '', deleteDiff)
  const child = runs.get('s5-subagent.2')!
  check('a subagent thread translates on its own (lane routing is C4)', child.harness.state.rows.some(row => row.kind === 'assistant' && row.text === 'child-ok'))
  check('subAgentActivity reaches the plugin renderer seam, not a card', of(runs.get('s5-subagent')!.events, 'custom').some(event => event.nativeType === 'codex/subAgentActivity'))
}

// ── synthetic sequences ─────────────────────────────────────────────────
type N = { method: string; params: Record<string, unknown> }
const T = 'thread-x'
const turnStarted = (id: string): N => ({ method: 'turn/started', params: { threadId: T, turn: { id, items: [], status: 'inProgress' } } })
const turnCompleted = (id: string, status = 'completed', error: unknown = null): N => ({ method: 'turn/completed', params: { threadId: T, turn: { id, items: [], status, error } } })
const started = (item: Record<string, unknown>): N => ({ method: 'item/started', params: { threadId: T, turnId: 't1', item } })
const completed = (item: Record<string, unknown>): N => ({ method: 'item/completed', params: { threadId: T, turnId: 't1', item } })
const user = (id: string, text: string, clientId: string | null = null): Record<string, unknown> => ({ type: 'userMessage', id, clientId, content: [{ type: 'text', text, text_elements: [] }] })
const delta = (method: string, itemId: string, value: string, extra: Record<string, unknown> = {}): N => ({ method, params: { threadId: T, turnId: 't1', itemId, delta: value, ...extra } })

{
  // Reasoning-only attempt, then a tool, then a commentary + tool, then the answer.
  const run = liveRun([
    turnStarted('t1'),
    started(user('u1', 'hello', 'c1')), completed(user('u1', 'hello', 'c1')),
    started({ type: 'reasoning', id: 'r1', summary: [], content: [] }),
    delta('item/reasoning/summaryTextDelta', 'r1', 'Plan **A**', { summaryIndex: 0 }),
    { method: 'item/reasoning/summaryPartAdded', params: { threadId: T, turnId: 't1', itemId: 'r1', summaryIndex: 1 } },
    delta('item/reasoning/summaryTextDelta', 'r1', 'then B', { summaryIndex: 1 }),
    delta('item/reasoning/textDelta', 'r1', 'RAW HIDDEN', { contentIndex: 0 }),
    completed({ type: 'reasoning', id: 'r1', summary: ['Plan **A**', 'then B'], content: [] }),
    started({ type: 'commandExecution', id: 'x1', command: "/bin/bash -lc 'ls -la'", cwd: '/TMP/cwd', processId: null, source: 'agent', status: 'inProgress', commandActions: [{ type: 'listFiles', command: 'ls -la', path: null }], aggregatedOutput: null, exitCode: null, durationMs: null }),
    completed({ type: 'commandExecution', id: 'x1', command: "/bin/bash -lc 'ls -la'", cwd: '/TMP/cwd', processId: null, source: 'agent', status: 'completed', commandActions: [{ type: 'listFiles', command: 'ls -la', path: null }], aggregatedOutput: 'a\nb\n', exitCode: 0, durationMs: 3 }),
    { method: 'thread/tokenUsage/updated', params: { threadId: T, turnId: 't1', tokenUsage: { total: {}, last: { totalTokens: 120, inputTokens: 100, cachedInputTokens: 60, cacheWriteInputTokens: 0, outputTokens: 20, reasoningOutputTokens: 5 }, modelContextWindow: 1000 } } },
    started({ type: 'agentMessage', id: 'm1', text: '', phase: 'commentary' }),
    delta('item/agentMessage/delta', 'm1', 'Reading '),
    delta('item/agentMessage/delta', 'm1', 'files.'),
    completed({ type: 'agentMessage', id: 'm1', text: 'Reading files.', phase: 'commentary' }),
    started({ type: 'commandExecution', id: 'x2', command: "/bin/bash -lc 'sed -n 1,5p a.ts'", cwd: '/TMP/cwd', processId: null, source: 'agent', status: 'inProgress', commandActions: [{ type: 'read', command: 'sed -n 1,5p a.ts', name: 'a.ts', path: '/TMP/cwd/a.ts' }], aggregatedOutput: null, exitCode: null, durationMs: null }),
    completed({ type: 'commandExecution', id: 'x2', command: "/bin/bash -lc 'sed -n 1,5p a.ts'", cwd: '/TMP/cwd', processId: null, source: 'agent', status: 'completed', commandActions: [{ type: 'read', command: 'sed -n 1,5p a.ts', name: 'a.ts', path: '/TMP/cwd/a.ts' }], aggregatedOutput: 'const a = 1\n', exitCode: 0, durationMs: 2 }),
    started({ type: 'agentMessage', id: 'm2', text: '', phase: 'final_answer' }),
    delta('item/agentMessage/delta', 'm2', 'Done.'),
    completed({ type: 'agentMessage', id: 'm2', text: 'Done.', phase: 'final_answer' }),
    { method: 'turn/plan/updated', params: { threadId: T, turnId: 't1', explanation: null, plan: [{ step: 'one', status: 'completed' }, { step: 'two', status: 'inProgress' }] } },
    turnCompleted('t1'),
  ])
  const steps = of(run.events, 'step.start').map(event => event.step)
  check('§7.3: reasoning opens step 1; commentary step 2; the final answer step 3', steps.join(',') === '1,2,3', steps)
  const messages = of(run.events, 'assistant.message').filter(event => event.canonical)
  check('§7.3 rule 5: a tool settles a reasoning-only attempt', messages[0]?.blocks.length === 1 && messages[0].blocks[0]!.type === 'reasoning' && messages[0].blocks[0]!.text === 'Plan **A**\n\nthen B', messages[0])
  check('§7.3: commentary and final answer settle as their own messages', messages[1]?.blocks.some(block => block.type === 'text' && block.text === 'Reading files.') === true && messages[2]?.blocks.some(block => block.type === 'text' && block.text === 'Done.') === true)
  const reasoningDeltas = of(run.events, 'assistant.delta').filter(event => event.delta.kind === 'reasoning').map(event => event.delta.kind === 'reasoning' ? event.delta.text : '')
  check('§7.3: a new summary part starts a paragraph; raw text stays hidden beside a summary', reasoningDeltas.join('') === 'Plan **A**\n\nthen B', reasoningDeltas)
  const tools = of(run.events, 'tool.call')
  check('§7.3: tools join the step of the reply before them', tools[0]!.step === 1 && tools[1]!.step === 2)
  check('§8.1 D12: a list-only command is a terminal card named Glob', tools[0]!.presentation !== undefined && 'displayKey' in tools[0]!.presentation && tools[0]!.presentation.displayKey === 'tool-name-glob')
  const read = run.harness.state.rows.find(row => row.tool?.name === 'shell' && row.tool.resultView?.card === 'read')
  check('§8.1 D12: a read-only command settles as a read card of the file', read !== undefined && read.tool!.resultView?.card === 'read' && 'path' in read.tool!.resultView! && read.tool!.resultView.path === '/TMP/cwd/a.ts', read?.tool)
  check('§7.5: token usage is booked (uncached / cached split) and the window announced', run.harness.state.tokens.input === 40 && run.harness.state.tokens.cacheRead === 60 && run.harness.state.tokens.output === 20 && run.harness.state.contextWindow === 1000, run.harness.state.tokens)
  check('§7.5: usage-only messages add no rows', run.harness.state.rows.filter(row => row.kind === 'assistant').length === 2)
  check('§7.5: turn/plan/updated → the todo panel', JSON.stringify(run.harness.state.todos) === JSON.stringify([{ content: 'one', status: 'completed' }, { content: 'two', status: 'in_progress' }]))
  check('§7.2: the user row is the client id, anchored on the item', of(run.events, 'user.message')[0]?.id === 'c1' && of(run.events, 'user.message')[0]?.anchor === 'u1' && run.ctx.anchorTurns.get('u1') === 't1')
  check('§7.4: the turn end carries the turn usage', of(run.events, 'turn.end')[0]?.usage?.output === 20)
}

{
  // An interrupt while a reply streams; a failed turn with no item.
  const run = liveRun([
    turnStarted('t1'),
    started(user('u1', 'go')),
    started({ type: 'agentMessage', id: 'm1', text: '', phase: 'final_answer' }),
    delta('item/agentMessage/delta', 'm1', 'partial'),
    turnCompleted('t1', 'interrupted'),
    turnCompleted('t1', 'interrupted'),
    turnStarted('t2'),
    turnCompleted('t2', 'failed', { message: 'Unauthorized', codexErrorInfo: 'unauthorized', additionalDetails: null }),
  ])
  const message = of(run.events, 'assistant.message')[0]
  check('§7.3 rule 6: the streaming reply settles interrupted with its text', message?.interrupted === true && message.blocks.some(block => block.text === 'partial'), message)
  check('a repeated turn/completed changes nothing', of(run.events, 'turn.end').length === 2)
  const failed = of(run.events, 'turn.end')[1]
  check('§9.1: a failed turn ends as an error with the kebab category', failed?.reason.kind === 'error' && failed.reason.category === 'unauthorized' && failed.reason.message === 'Unauthorized', failed?.reason)
  check('§9.1: an auth failure adds the sign-in hint', of(run.events, 'notice').some(event => event.key === 'codex-hint:auth'))
  check('a turn without items still opens and closes', of(run.events, 'turn.start').length === 2)
}

{
  // Notifications: status, settings, reroute, retry, warnings, unknown items.
  const run = liveRun([
    { method: 'thread/status/changed', params: { threadId: T, status: { type: 'active', activeFlags: ['waitingOnApproval'] } } },
    { method: 'thread/status/changed', params: { threadId: T, status: { type: 'idle' } } },
    { method: 'thread/settings/updated', params: { threadId: T, threadSettings: { model: 'gpt-x', modelProvider: 'relay', effort: 'high', approvalPolicy: 'never', sandboxPolicy: { type: 'dangerFullAccess' } } } },
    { method: 'model/rerouted', params: { threadId: T, turnId: 't1', fromModel: 'gpt-x', toModel: 'gpt-y', reason: 'highRiskCyberActivity' } },
    { method: 'error', params: { threadId: T, turnId: 't1', willRetry: true, error: { message: 'stream disconnected', codexErrorInfo: null } } },
    { method: 'error', params: { threadId: T, turnId: 't1', willRetry: true, error: { message: 'again', codexErrorInfo: null } } },
    { method: 'warning', params: { threadId: T, message: 'Heads up' } },
    { method: 'thread/name/updated', params: { threadId: T, threadName: 'Named' } },
    turnStarted('t1'),
    started({ type: 'futureThing', id: 'f1' }),
    completed({ type: 'futureThing', id: 'f1' }),
    turnCompleted('t1'),
  ])
  check('§7.5: thread status → session status (waiting = requires-action)', of(run.events, 'session.status').map(event => event.status).join(',') === 'requires-action,idle')
  check('§7.5: settings changes → model / effort / mode events', of(run.events, 'model.changed')[0]?.model === 'gpt-x' && of(run.events, 'effort.changed')[0]?.effort === 'high' && of(run.events, 'mode.changed')[0]?.modeId === 'full-access')
  check('§7.5: a reroute is a fallback model change with a notice', of(run.events, 'model.changed')[1]?.source === 'fallback' && of(run.events, 'notice').some(event => event.key === 'reroute'))
  const retries = of(run.events, 'notice').filter(event => event.key === 'retry:t1')
  check('§7.5: retry notices share one key per turn', retries.length === 2)
  check('§7.5: a warning is a keyed notice', of(run.events, 'notice').some(event => event.text === 'Heads up' && event.key !== undefined))
  check('§7.5: a name update → session.title', of(run.events, 'session.title')[0]?.title === 'Named')
  check('§7.4: an unknown item type → custom (renderer seam), once', of(run.events, 'custom').length === 1 && of(run.events, 'custom')[0]!.nativeType === 'codex/futureThing')
}

{
  // Cards: MCP, web search, file update fallback, user-shell, bash output.
  const run = liveRun([
    turnStarted('t1'),
    started(user('u1', '<bash-stdout>\nhi\n</bash-stdout>')),
    started({ type: 'mcpToolCall', id: 'mcp1', server: 'docs', tool: 'search', status: 'inProgress', arguments: { q: 'x' }, result: null, error: null }),
    { method: 'item/mcpToolCall/progress', params: { threadId: T, turnId: 't1', itemId: 'mcp1', message: 'working' } },
    completed({ type: 'mcpToolCall', id: 'mcp1', server: 'docs', tool: 'search', status: 'completed', arguments: { q: 'x' }, result: { content: [{ type: 'text', text: 'found' }], structuredContent: { n: 1 } }, error: null }),
    started({ type: 'webSearch', id: 'w1', query: 'codex app-server', action: null, results: null }),
    completed({ type: 'webSearch', id: 'w1', query: 'codex app-server', action: { type: 'search', query: 'codex app-server', queries: ['codex app-server'] }, results: null }),
    started({ type: 'fileChange', id: 'p1', status: 'inProgress', changes: [{ path: '/TMP/cwd/c.txt', kind: { type: 'update', move_path: null }, diff: '@@ -1,3 +1,3 @@\n one\n-two\n+TWO\n three\n' }] }),
    completed({ type: 'fileChange', id: 'p1', status: 'completed', changes: [{ path: '/TMP/cwd/c.txt', kind: { type: 'update', move_path: null }, diff: '@@ -1,3 +1,3 @@\n one\n-two\n+TWO\n three\n' }] }),
    started({ type: 'commandExecution', id: 'x9', command: "/bin/bash -lc 'false'", cwd: '/TMP/cwd', processId: null, source: 'agent', status: 'inProgress', commandActions: [{ type: 'unknown', command: 'false' }], aggregatedOutput: null, exitCode: null, durationMs: null }),
    completed({ type: 'commandExecution', id: 'x9', command: "/bin/bash -lc 'false'", cwd: '/TMP/cwd', processId: null, source: 'agent', status: 'failed', commandActions: [{ type: 'unknown', command: 'false' }], aggregatedOutput: 'boom\n', exitCode: 1, durationMs: 1 }),
    turnCompleted('t1'),
  ])
  check('`!!` output reaches the transcript as command output', of(run.events, 'user.message')[0]?.source === 'command-output' && of(run.events, 'user.message')[0]?.text === 'hi')
  const mcp = of(run.events, 'tool.call').find(event => event.callId === 'mcp1')
  check('§7.4: an MCP call is mcp__server__tool on a `server › tool` card', mcp?.name === 'mcp__docs__search' && mcp.presentation !== undefined && 'title' in mcp.presentation && mcp.presentation.title === 'docs › search')
  check('§7.5: MCP progress → tool.progress', of(run.events, 'tool.progress').some(event => event.callId === 'mcp1'))
  const mcpResult = of(run.events, 'tool.result').find(event => event.callId === 'mcp1')
  check('§7.4: an MCP result keeps its text and structured content', mcpResult?.text === 'found' && JSON.stringify(mcpResult.structured) === '{"n":1}')
  const web = run.harness.state.rows.find(row => row.tool?.name === 'web_search')
  check('§7.4: web search is a generic card named WebSearch titled by the query', web?.tool?.callView?.displayKey === 'tool-name-web_search' && web.tool.callView !== undefined && 'title' in web.tool.callView && web.tool.callView.title === 'codex app-server')
  const patch = of(run.events, 'tool.call').find(event => event.callId === 'p1')?.presentation
  check('§8.2 (C1 fallback): an update hunk renders as old/new text', patch !== undefined && 'diffs' in patch && patch.diffs[0]?.oldText === 'one\ntwo\nthree\n' && patch.diffs[0]?.newText === 'one\nTWO\nthree\n', patch)
  const failed = run.harness.state.rows.find(row => row.tool?.name === 'shell')
  check('§8.1: a failing command is an error card with its output and exit code', failed?.tool?.status === 'error' && failed.tool.errorText === 'boom\nexit 1', failed?.tool)
}

// ── helpers ─────────────────────────────────────────────────────────────
check('commands: bash -lc single quotes unwrap with escaped quotes', unwrapCommand(`/bin/bash -lc 'echo '"'"'hi'"'"''`) === "echo 'hi'")
check('commands: zsh -lc and /usr/bin unwrap', unwrapCommand("/usr/bin/zsh -lc 'pwd'") === 'pwd')
check('commands: one parsed action stands in for an unknown wrapper', unwrapCommand('cmd.exe /c dir', [{ type: 'unknown', command: 'dir' }]) === 'dir')
check('commands: an unwrapped command passes through', unwrapCommand('ls') === 'ls')
check('hunks: two hunks join their context', hunkTexts('@@ -1 +1 @@\n-a\n+b\n@@ -9 +9 @@\n c\n').newText === 'b\nc\n')

// ── a usage report is invisible (review fix) ────────────────────────────
{
  const { createProjectorHarness } = await import('./lib/projector-harness.js')
  const { createAgentTrajectorySource } = await import('../src/dsh-adapter/trajectory/agent-source.js')
  const harness = createProjectorHarness({ model: '', activity: true, now: () => 1000 })
  const trace = createAgentTrajectorySource({ clock: () => 1000 })
  const feed = (events: readonly AgentEvent[]): void => { harness.apply(events); for (const event of events) trace.observe(event, false) }
  feed([
    { type: 'turn.start', turn: 1, origin: 'user', time: 1 },
    { type: 'assistant.message', seq: 1, anchor: 'a1', turn: 1, step: 1, attemptId: 'turn-1#1', time: 2, blocks: [{ type: 'text', text: 'hello' }], canonical: true },
  ])
  const rows = JSON.stringify(harness.state.rows)
  const traced = trace.events().length
  const input = harness.state.tokens.input
  feed([{ type: 'assistant.message', seq: 2, anchor: '', turn: 1, step: 1, attemptId: 'turn-1#1#usage', time: 99, blocks: [], usage: { input: 10, output: 5 }, canonical: false, usageOnly: true }])
  check('usage-only: no row changes (no new row, no rewritten time or images, so no /export or copy line)', JSON.stringify(harness.state.rows) === rows, harness.state.rows)
  check('usage-only: no trace entry', trace.events().length === traced, trace.events().slice(traced))
  check('usage-only: the usage is booked once', harness.state.tokens.input === input + 10)
  feed([{ type: 'assistant.message', seq: 2, anchor: '', turn: 1, step: 1, attemptId: 'turn-1#1#usage', time: 99, blocks: [], usage: { input: 10, output: 5 }, canonical: false, usageOnly: true }])
  check('usage-only: a redelivered report (same seq) is not booked twice', harness.state.tokens.input === input + 10)
  feed([{ type: 'turn.end', turn: 1, reason: { kind: 'completed' }, time: 100 }])
  check('usage-only: the turn ends with one assistant row', harness.state.rows.filter(row => row.kind === 'assistant').length === 1)
}

console.log(`\nverify-codex-translate OK (${passed} checks)`)
