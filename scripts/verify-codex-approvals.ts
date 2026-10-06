/**
 * Codex approvals and questions (docs/codex-backend-design.md §5.8, §8.4,
 * D10, C0 V5/V7) on the fake app-server: command approvals offering what the
 * server allows (`availableDecisions`, else the official default set), every
 * decision mapping, reject with and without a reason (decline / cancel +
 * the reason as the next turn), fail-closed allow-always, file-change and
 * permission requests, questions (options, free text, cancel = empty
 * answers + interrupt), settlement only on `serverRequest/resolved` (or
 * resolved elsewhere → cancelled), a re-delivered request shown once,
 * dispose withdrawing and answering everything, MCP elicitation and legacy
 * requests answered without a panel, and the recorded s1b approval replayed
 * end to end. zh and en labels follow the official wording.
 *
 * Run: node --import tsx/esm scripts/verify-codex-approvals.ts
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentEvent, PermissionRequestView, QuestionRequestView } from '../src/agent/events.js'
import { prefixLabel } from '../src/backends/codex/session/approvals.js'
import { setLang, t } from '../src/i18n.js'
import { parseWire } from './lib/codex-fake-app-server.js'
import { openHarness, THREAD, tick } from './lib/codex-session-harness.js'

setLang('en')
let passed = 0
const check = (label: string, ok: boolean, detail?: unknown): void => {
  assert.ok(ok, detail === undefined ? label : `${label}: ${JSON.stringify(detail)}`)
  passed += 1
  console.log(`PASS ${label}`)
}
type Rec = Record<string, unknown>
const of = <T extends AgentEvent['type']>(events: readonly AgentEvent[], type: T) =>
  events.filter((event): event is Extract<AgentEvent, { type: T }> => event.type === type)
const lastRequest = (events: readonly AgentEvent[]): PermissionRequestView => of(events, 'permission.request').at(-1)!.request
const lastQuestion = (events: readonly AgentEvent[]): QuestionRequestView => of(events, 'question.request').at(-1)!.request

const COMMAND = {
  threadId: THREAD, turnId: 'turn-1', itemId: 'exec-1', kind: 'command', startedAtMs: 0, environmentId: 'local',
  command: "/bin/bash -lc 'npm test'", cwd: '/TMP/cwd', commandActions: [{ type: 'unknown', command: 'npm test' }],
}

const h = await openHarness()
const respond = h.session.capabilities.permissions!.respond

// ── command approvals ───────────────────────────────────────────────────
{
  const answer = h.fake.request('item/commandExecution/requestApproval', { ...COMMAND, proposedExecpolicyAmendment: ['npm', 'test'], availableDecisions: ['accept', { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['npm', 'test'] } }, 'acceptForSession', 'decline', 'cancel'] })
  await tick()
  const view = lastRequest(h.events())
  check('command: a permission request keyed by generation and id', view.requestId === 'codex:1:0' && view.toolName === 'shell' && view.callId === 'exec-1' && view.command === 'npm test' && view.feedback === true)
  check('command: options follow availableDecisions (one reject for decline + cancel)', view.options.map(option => `${option.kind}:${option.id}`).join(',') === 'allow-once:accept,allow-always:execpolicy,allow-always:session,reject:reject')
  check('command: labels follow the official wording', view.options[1]!.label === 'Yes, and don\'t ask again for commands that start with `npm test`' && view.options[2]!.label === 'Yes, and don\'t ask again for this command in this session')
  check('command: accept / plain reject carry the official wording (decline offered)', view.options[0]!.label === 'Yes, proceed' && view.options[3]!.label === 'No, continue without running it')
  check('command: the panel lists the pending prompt', h.session.capabilities.permissions!.pending().length === 1)
  respond(view.requestId, { kind: 'allow-always', optionId: 'execpolicy' })
  const result = (await answer).result as Rec
  check('allow-always execpolicy → acceptWithExecpolicyAmendment', JSON.stringify(result.decision) === JSON.stringify({ acceptWithExecpolicyAmendment: { execpolicy_amendment: ['npm', 'test'] } }))
  check('no optimistic settle: nothing settles before the server resolves', of(h.events(), 'permission.settled').length === 0 && h.session.capabilities.permissions!.pending().length === 0)
  await h.notify('serverRequest/resolved', { requestId: 0 })
  check('serverRequest/resolved settles it with the user\'s outcome', of(h.events(), 'permission.settled').at(-1)?.outcome === 'allow-always' && of(h.events(), 'permission.settled').at(-1)?.requestId === 'codex:1:0')
}
{
  const answer = h.fake.request('item/commandExecution/requestApproval', { ...COMMAND, availableDecisions: ['accept', 'acceptForSession', 'decline', 'cancel'] })
  await tick()
  respond(lastRequest(h.events()).requestId, { kind: 'allow-once' })
  check('allow-once → accept', ((await answer).result as Rec).decision === 'accept')
}
{
  const answer = h.fake.request('item/commandExecution/requestApproval', { ...COMMAND, availableDecisions: ['accept', 'acceptForSession', 'decline', 'cancel'] })
  await tick()
  respond(lastRequest(h.events()).requestId, { kind: 'allow-always', optionId: 'session' })
  check('allow-always session → acceptForSession', ((await answer).result as Rec).decision === 'acceptForSession')
}
{
  const answer = h.fake.request('item/commandExecution/requestApproval', { ...COMMAND, availableDecisions: ['accept', 'decline', 'cancel'] })
  await tick()
  respond(lastRequest(h.events()).requestId, { kind: 'reject' })
  check('reject without a reason → decline when offered', ((await answer).result as Rec).decision === 'decline')
}
{
  // Absent availableDecisions: the official default set (accept, prefix, cancel).
  const answer = h.fake.request('item/commandExecution/requestApproval', { ...COMMAND, proposedExecpolicyAmendment: ['/bin/bash', '-lc', 'echo probe > a.txt'] })
  await tick()
  const view = lastRequest(h.events())
  check('no availableDecisions: accept, the proposed prefix, cancel', view.options.map(option => option.id).join(',') === 'accept,execpolicy,reject' && view.options[1]!.label!.includes('`echo probe > a.txt`'))
  check('only cancel offered: the reject row says so', view.options[2]!.label === 'No, and tell Codex what to do differently')
  respond(view.requestId, { kind: 'reject' })
  check('reject without a reason, only cancel offered → cancel', ((await answer).result as Rec).decision === 'cancel')
}
{
  const answer = h.fake.request('item/commandExecution/requestApproval', { ...COMMAND, availableDecisions: ['accept', 'cancel'] })
  await tick()
  respond(lastRequest(h.events()).requestId, { kind: 'allow-always' })
  check('fail closed: an allow-always never offered is a rejection', ((await answer).result as Rec).decision === 'cancel')
}
{
  // Reject with a reason: cancel, and the reason runs as the next turn (D10).
  await h.session.submit({ text: 'run tests', clientMessageId: 'c1' }, 'followup')
  await h.startTurn('turn-1', 'c1', 'run tests')
  const answer = h.fake.request('item/commandExecution/requestApproval', { ...COMMAND, availableDecisions: ['accept', 'decline', 'cancel'] })
  await tick()
  respond(lastRequest(h.events()).requestId, { kind: 'reject', message: 'use pnpm instead' })
  check('reject with a reason → cancel', ((await answer).result as Rec).decision === 'cancel')
  await h.completeTurn('turn-1', 'interrupted')
  await tick()
  const followup = h.sent('turn/start').at(-1)!
  check('… and the reason is the next turn\'s message', JSON.stringify(followup.input) === JSON.stringify([{ type: 'text', text: 'use pnpm instead', text_elements: [] }]))
  check('turn end settles prompts still open as cancelled', of(h.events(), 'permission.settled').every(event => typeof event.outcome === 'string'))
}
{
  const answer = h.fake.request('item/commandExecution/requestApproval', { ...COMMAND, itemId: 'net-1', networkApprovalContext: { host: 'example.com' }, availableDecisions: ['accept', 'acceptForSession', { applyNetworkPolicyAmendment: { network_policy_amendment: { host: 'example.com', action: 'allow' } } }, { applyNetworkPolicyAmendment: { network_policy_amendment: { host: 'evil.test', action: 'deny' } } }, 'cancel'] })
  await tick()
  const view = lastRequest(h.events())
  check('network: an allow amendment is an allow-always option naming the host; a deny one is not offered', view.options.map(option => option.id).join(',') === 'accept,session,net:0,reject' && view.options[2]!.label === t('codex-approve-network', { host: 'example.com' }))
  respond(view.requestId, { kind: 'allow-always', optionId: 'net:0' })
  check('network: the amendment decision goes back verbatim', JSON.stringify(((await answer).result as Rec).decision) === JSON.stringify({ applyNetworkPolicyAmendment: { network_policy_amendment: { host: 'example.com', action: 'allow' } } }))
}

// ── file changes and permissions ────────────────────────────────────────
{
  const answer = h.fake.request('item/fileChange/requestApproval', { threadId: THREAD, turnId: 'turn-2', itemId: 'patch-1', startedAtMs: 0, reason: 'needs write access', grantRoot: '/TMP/cwd/sub' })
  await tick()
  const view = lastRequest(h.events())
  check('file change: accept, session, reject; labels; grant root as blocked path', view.toolName === 'apply_patch' && view.options.map(option => option.id).join(',') === 'accept,session,reject' && view.options[1]!.label === 'Yes, and don\'t ask again for these files' && view.blockedPath === 'sub' && view.reason === 'needs write access')
  respond(view.requestId, { kind: 'reject' })
  check('file change: reject without a reason → decline', ((await answer).result as Rec).decision === 'decline')
  await h.notify('item/completed', { turnId: 'turn-2', item: { type: 'fileChange', id: 'patch-1', status: 'declined', changes: [] } })
  check('an answered prompt settles when its item completes', of(h.events(), 'permission.settled').at(-1)?.outcome === 'rejected')
}
{
  const answer = h.fake.request('item/permissions/requestApproval', { threadId: THREAD, turnId: 'turn-2', itemId: 'perm-1', environmentId: null, startedAtMs: 0, cwd: '/TMP/cwd', reason: 'fetch deps', permissions: { network: { enabled: true }, fileSystem: { read: null, write: ['/TMP/cwd/out'] } } })
  await tick()
  const view = lastRequest(h.events())
  check('permissions: a summary of what is asked', view.toolName === 'permissions' && view.description === `${t('codex-perm-network')}; ${t('codex-perm-write', { paths: 'out' })}`, view.description)
  respond(view.requestId, { kind: 'allow-always', optionId: 'session' })
  const result = (await answer).result as Rec
  check('permissions: grant for the session returns what was asked', result.scope === 'session' && (result.permissions as Rec).network !== undefined && (result.permissions as Rec).fileSystem !== undefined)
}
{
  const answer = h.fake.request('item/permissions/requestApproval', { threadId: THREAD, turnId: 'turn-2', itemId: 'perm-2', environmentId: null, startedAtMs: 0, cwd: '/TMP/cwd', reason: null, permissions: { network: { enabled: true }, fileSystem: null } })
  await tick()
  respond(lastRequest(h.events()).requestId, { kind: 'reject' })
  check('permissions: reject grants nothing for the turn', JSON.stringify((await answer).result) === '{"permissions":{},"scope":"turn"}')
}

// ── questions ───────────────────────────────────────────────────────────
{
  const answer = h.fake.request('item/tool/requestUserInput', {
    threadId: THREAD, turnId: 'turn-2', itemId: 'call-q', isBlocking: true, autoResolutionMs: null,
    questions: [
      { id: 'language', header: 'Language', question: 'Which language?', isOther: true, isSecret: false, options: [{ label: 'Python', description: 'portable' }, { label: 'Bash', description: '' }] },
      { id: 'tests', header: 'Tests', question: 'Add tests?', isOther: false, isSecret: false, options: [{ label: 'Yes', description: 'with tests' }, { label: 'No', description: 'none' }] },
    ],
  })
  await tick()
  const question = lastQuestion(h.events())
  check('question: one panel question each, headers and option descriptions kept', question.questions.length === 2 && question.questions[0]!.header === 'Language' && question.questions[0]!.options[0]!.description === 'portable' && question.questions[0]!.options[1]!.description === undefined)
  check('question: free text only where the question allows other', question.questions[0]!.hideCustomInput === undefined && question.questions[1]!.hideCustomInput === true)
  h.session.capabilities.questions!.respond(question.requestId, { answers: [{ selected: ['Python'], custom: 'and Go' }, { selected: ['No'] }] })
  check('question: answers by question id, selected labels then free text', JSON.stringify((await answer).result) === JSON.stringify({ answers: { language: { answers: ['Python', 'and Go'] }, tests: { answers: ['No'] } } }))
  await h.notify('serverRequest/resolved', { requestId: Number(question.requestId.split(':')[2]) })
  check('question: settles on resolution', of(h.events(), 'question.settled').at(-1)?.requestId === question.requestId)
}
{
  await h.session.submit({ text: 'plan it', clientMessageId: 'c5' }, 'followup')
  await tick()
  const turnId = 'turn-x'
  await h.startTurn(turnId, 'c5', 'plan it')
  const interrupts = h.sent('turn/interrupt').length
  const answer = h.fake.request('item/tool/requestUserInput', { threadId: THREAD, turnId, itemId: 'call-q2', isBlocking: true, autoResolutionMs: null, questions: [{ id: 'q', header: '', question: 'Go?', isOther: false, isSecret: false, options: [{ label: 'Yes', description: '' }] }] })
  await tick()
  h.session.capabilities.questions!.cancel(lastQuestion(h.events()).requestId)
  check('question cancel (V7): empty answers', JSON.stringify((await answer).result) === '{"answers":{}}')
  await tick()
  check('question cancel (V7): and the turn is interrupted, as the official Esc does', h.sent('turn/interrupt').length === interrupts + 1)
  await h.completeTurn(turnId, 'interrupted')
}

// ── resolved elsewhere, redelivery, unsupported requests ────────────────
{
  void h.fake.request('item/commandExecution/requestApproval', { ...COMMAND, itemId: 'exec-elsewhere' })
  await tick()
  const view = lastRequest(h.events())
  const pendingId = Number(view.requestId.split(':')[2])
  await h.notify('serverRequest/resolved', { requestId: pendingId })
  check('resolved elsewhere (another client, auto-review): settled as cancelled', of(h.events(), 'permission.settled').at(-1)?.requestId === view.requestId && of(h.events(), 'permission.settled').at(-1)?.outcome === 'cancelled')
}
{
  const before = of(h.events(), 'permission.request').length
  void h.fake.request('item/commandExecution/requestApproval', { ...COMMAND, itemId: 'exec-again' })
  await tick()
  const view = lastRequest(h.events())
  const id = Number(view.requestId.split(':')[2])
  h.fake.raw(JSON.stringify({ method: 'item/commandExecution/requestApproval', id, params: { ...COMMAND, itemId: 'exec-again' } }))
  await tick()
  check('V5: a re-delivered pending request is shown once', of(h.events(), 'permission.request').length === before + 1)
  respond(view.requestId, { kind: 'allow-once' })
  await tick()
  check('… and answered once', [...h.fake.responses.entries()].filter(([key]) => key === id).length === 1)
}
{
  const elicit = await h.fake.request('mcpServer/elicitation/request', { threadId: THREAD, turnId: null, serverName: 'docs', mode: 'form', message: 'login', requestedSchema: {} })
  check('MCP elicitation (C2): cancelled with a notice, never a hang', (elicit.result as Rec).action === 'cancel' && of(h.events(), 'notice').some(event => event.key === 'codex-elicitation'))
  const legacy = await h.fake.request('execCommandApproval', { conversationId: THREAD, callId: 'x', command: ['ls'] })
  check('a legacy v1 approval is refused with -32601', (legacy.error as Rec | undefined)?.code === -32601)
}
{
  const answer = h.fake.request('item/commandExecution/requestApproval', { ...COMMAND, itemId: 'exec-dispose' })
  const question = h.fake.request('item/tool/requestUserInput', { threadId: THREAD, turnId: 'turn-z', itemId: 'q-dispose', isBlocking: true, autoResolutionMs: null, questions: [{ id: 'q', header: '', question: 'Still there?', isOther: true, isSecret: false, options: [] }] })
  await tick()
  await h.session.dispose()
  check('dispose: an open approval is answered cancel and settled cancelled', ((await answer).result as Rec).decision === 'cancel' && of(h.events(), 'permission.settled').at(-1)?.outcome === 'cancelled')
  check('dispose: an open question is answered empty and settled', JSON.stringify((await question).result) === '{"answers":{}}' && of(h.events(), 'question.settled').length >= 2)
}

// ── zh labels ───────────────────────────────────────────────────────────
setLang('zh')
check('zh: session / prefix / files labels', t('codex-approve-session-command') === '是，本会话内此命令不再询问' && t('codex-approve-prefix', { prefix: 'ls' }) === '是，以后以 `ls` 开头的命令不再询问' && t('codex-approve-session-files') === '是，本会话内这些文件不再询问')
setLang('en')
check('prefix labels strip bash -lc and quote odd tokens', prefixLabel(['/bin/bash', '-lc', 'npm test']) === 'npm test' && prefixLabel(['git', 'commit', '-m', 'a b']) === "git commit -m 'a b'" && prefixLabel(['/bin/bash', '-lc', 'a\nb']) === undefined)

// ── the recorded approval, end to end ───────────────────────────────────
{
  const wire = parseWire(readFileSync(join(import.meta.dirname, 'fixtures', 'codex', 'wire', 's1b-command-approval.jsonl'), 'utf8'))
  const recordedThread = ((wire.find(entry => entry.dir === 'out' && entry.msg.method === 'turn/start')!.msg.params as Rec).threadId) as string
  const r = await openHarness()
  r.fake.off('turn/start')
  const replaying = r.fake.replay(wire.filter(entry => !(entry.dir === 'out' && ['initialize', 'thread/start'].includes(String(entry.msg.method))) && !(entry.dir === 'in' && (entry.msg.id === 1 || entry.msg.id === 2) && entry.msg.method === undefined)), {
    threadMap: { [recordedThread]: THREAD },
    until: entry => entry.dir === 'out' && entry.msg.method === 'thread/read',
  })
  await r.session.submit({ text: 'Run exactly this shell command and nothing else: echo probe > a.txt', clientMessageId: 'c1' }, 'followup')
  for (let i = 0; i < 50 && of(r.events(), 'permission.request').length === 0; i++) await tick(5)
  const view = lastRequest(r.events())
  check('recorded s1b: the approval names the unwrapped command with the recorded options', view.command === 'echo probe > a.txt' && view.options.map(option => option.id).join(',') === 'accept,execpolicy,reject')
  check('recorded s1b: the session is waiting on the user', r.session.status === 'requires-action')
  r.session.capabilities.permissions!.respond(view.requestId, { kind: 'allow-once' })
  await replaying
  await tick()
  check('recorded s1b: allow-once sent accept; the card completes; the prompt settled', [...r.fake.responses.values()].some(answer => (answer.result as Rec | undefined)?.decision === 'accept')
    && r.events().some(event => event.type === 'tool.result' && !event.isError) && of(r.events(), 'permission.settled').at(-1)?.outcome === 'allow-once')
  check('recorded s1b: the turn ends completed and the session is idle', of(r.events(), 'turn.end').at(-1)?.reason.kind === 'completed' && r.session.status === 'idle')
  await r.session.dispose()
}

console.log(`\nverify-codex-approvals OK (${passed} checks)`)
