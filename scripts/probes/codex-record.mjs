// Maintainer probe, not a regression test and not part of CI.
//
// Records the Codex wire fixtures of scripts/fixtures/codex/wire/ against a
// real `codex app-server` (the research scenarios s1–s5 of
// docs/codex-backend-design.md §2, moved here). Every run is pinned by
// scripts/lib/codex-cheap-only.mjs (throwaway CODEX_HOME, relay provider,
// cheap model at effort low). Raw recordings land outside the repo
// (codex-probe-lib.mjs); scrub them before committing:
//
//   node scripts/lib/codex-fixture-sanitize.mjs --write <raw> scripts/fixtures/codex/wire/<name>.jsonl
//
// Usage (in ONE shell, so the credentials never leave it):
//   set -a; . <relay env file>; set +a
//   CODEX_EXECUTABLE=<codex> node scripts/probes/codex-record.mjs <scenario…>
// Scenarios and their live turns: s1 (2), s1b (1), s2 (3), s3 (2 + compact),
// s4 (1), s5 (1).
import { connect, liveCodexHome, pinCheapOrExit, safe, summarize, text } from './codex-probe-lib.mjs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Console output, scrubbed of the relay URL, host and key. */
const say = (...values) => console.log(...values.map(value => safe(value)))

const { model, effort } = pinCheapOrExit('codex-record', join(homedir(), '.dsh-tui'))

const scenarios = {
  // S1: command approval (accept) and file-change approval (decline) on two
  // threads of one connection.
  async s1() {
    const live = liveCodexHome({ model })
    const decisions = []
    const api = await connect({
      ...live, args: live.appServerArgs, scenario: 's1-approvals',
      onServerRequest: msg => {
        if (msg.method === 'item/commandExecution/requestApproval') { decisions.push('command:accept'); return { decision: 'accept' } }
        if (msg.method === 'item/fileChange/requestApproval') { decisions.push('file:decline'); return { decision: 'decline' } }
        decisions.push(`unhandled:${msg.method}`)
        return undefined
      },
    })
    try {
      const t1 = (await api.call('thread/start', { cwd: live.cwd, approvalPolicy: 'untrusted', sandbox: 'danger-full-access' })).result.thread.id
      await api.call('turn/start', { threadId: t1, clientUserMessageId: 'c1', input: text('Run exactly this shell command and nothing else: echo probe > a.txt') })
      await api.until(e => e.method === 'turn/completed' && e.params.threadId === t1)
      const t2 = (await api.call('thread/start', { cwd: live.cwd, approvalPolicy: 'on-request', sandbox: 'read-only' })).result.thread.id
      await api.call('turn/start', { threadId: t2, clientUserMessageId: 'c2', input: text('Create a file named b.txt containing the single word hi, using your file editing tool. Do nothing else.') })
      await api.until(e => e.method === 'turn/completed' && e.params.threadId === t2)
      say(summarize(api.events), '\ndecisions', decisions)
      await api.call('thread/read', { threadId: t2, includeTurns: true })
      await api.call('thread/read', { threadId: t1, includeTurns: true })
    } finally { await api.close(); live.cleanup() }
  },

  async s1b() {
    const live = liveCodexHome({ model })
    const api = await connect({ ...live, args: live.appServerArgs, scenario: 's1b-command-approval', onServerRequest: msg => msg.method === 'item/commandExecution/requestApproval' ? { decision: 'accept' } : undefined })
    try {
      const t1 = (await api.call('thread/start', { cwd: live.cwd, approvalPolicy: 'untrusted', sandbox: 'danger-full-access' })).result.thread.id
      await api.call('turn/start', { threadId: t1, clientUserMessageId: 'c1', input: text('Run exactly this shell command and nothing else: echo probe > a.txt') })
      say((await api.until(e => e.method === 'turn/completed', 150000)) ? 'completed' : 'TIMEOUT')
      say(summarize(api.events))
      await api.call('thread/read', { threadId: t1, includeTurns: true })
    } finally { await api.close(); live.cleanup() }
  },

  // S2: steer during a running command, interrupt a long command, file create + edit.
  async s2() {
    const live = liveCodexHome({ model })
    const api = await connect({ ...live, args: live.appServerArgs, scenario: 's2-steer-interrupt-diff' })
    try {
      const tid = (await api.call('thread/start', { cwd: live.cwd, approvalPolicy: 'never', sandbox: 'danger-full-access' })).result.thread.id
      const a = await api.call('turn/start', { threadId: tid, clientUserMessageId: 'a1', input: text('Run the shell command `sleep 6 && echo done`, then reply with one short sentence.') })
      await api.until(e => e.method === 'item/started' && e.params.item?.type === 'commandExecution')
      await api.call('turn/steer', { threadId: tid, expectedTurnId: a.result.turn.id, clientUserMessageId: 'a2', input: text('Also include the word banana in your reply.') })
      await api.until(e => e.method === 'turn/completed' && e.params.turn.id === a.result.turn.id)
      const b = await api.call('turn/start', { threadId: tid, clientUserMessageId: 'b1', input: text('Run the shell command `sleep 30` and then say finished.') })
      await api.until(e => e.method === 'item/started' && e.params.item?.type === 'commandExecution' && e.params.turnId === b.result.turn.id)
      await api.call('turn/interrupt', { threadId: tid, turnId: b.result.turn.id })
      await api.until(e => e.method === 'turn/completed' && e.params.turn.id === b.result.turn.id, 30000)
      const c = await api.call('turn/start', { threadId: tid, clientUserMessageId: 'c1', input: text('First use your plan tool to record a 2-step plan. Then create c.txt with three lines: one, two, three. Then edit c.txt changing the line two to TWO. Mark plan steps complete as you go. Keep replies minimal.') })
      await api.until(e => e.method === 'turn/completed' && e.params.turn.id === c.result.turn.id, 150000)
      say(summarize(api.events))
      await api.call('thread/read', { threadId: tid, includeTurns: true })
    } finally { await api.close(); live.cleanup() }
  },

  // S3: two turns + a shell command, then on a second connection: list,
  // resume, page, rename, fork, revert, compact, archive.
  async s3() {
    const live = liveCodexHome({ model })
    try {
      let api = await connect({ ...live, args: live.appServerArgs, scenario: 's3-lifecycle-p1' })
      const tid = (await api.call('thread/start', { cwd: live.cwd, approvalPolicy: 'never', sandbox: 'danger-full-access' })).result.thread.id
      for (const [i, prompt] of ['Reply with exactly: alpha', 'Reply with exactly: beta'].entries()) {
        const r = await api.call('turn/start', { threadId: tid, clientUserMessageId: `u${i}`, input: text(prompt) })
        await api.until(e => e.method === 'turn/completed' && e.params.turn.id === r.result.turn.id)
      }
      await api.call('thread/shellCommand', { threadId: tid, command: 'echo shell-ok' })
      await api.until(e => e.method === 'item/completed' && e.params.item?.type === 'commandExecution', 15000)
      await api.close()
      api = await connect({ ...live, args: live.appServerArgs, scenario: 's3-lifecycle-p2' })
      await api.call('thread/list', { limit: 10, cwd: live.cwd })
      await api.call('thread/resume', { threadId: tid, excludeTurns: true })
      const page = await api.call('thread/turns/list', { threadId: tid, limit: 2, sortDirection: 'desc' })
      if (page.result?.nextCursor) await api.call('thread/turns/list', { threadId: tid, limit: 2, sortDirection: 'desc', cursor: page.result.nextCursor })
      const all = (await api.call('thread/read', { threadId: tid, includeTurns: true })).result.thread.turns
      await api.call('thread/name/set', { threadId: tid, name: 'probe title' })
      const fork = await api.call('thread/fork', { threadId: tid, lastTurnId: all[0].id })
      await api.call('thread/revert', { threadId: tid, beforeTurnId: all[1].id })
      await api.call('thread/read', { threadId: tid, includeTurns: true })
      await api.call('thread/compact/start', { threadId: tid })
      await api.until(e => e.method === 'turn/completed' || e.method === 'thread/compacted', 60000)
      await api.call('thread/archive', { threadId: fork.result?.thread?.id })
      await api.call('thread/list', { limit: 10, cwd: live.cwd })
      await api.call('thread/loaded/list', {})
      say(summarize(api.events))
      await api.close()
    } finally { live.cleanup() }
  },

  // S4: Plan mode with one requestUserInput question and a plan item.
  async s4() {
    const live = liveCodexHome({ model })
    const api = await connect({
      ...live, args: live.appServerArgs, scenario: 's4-plan-question',
      onServerRequest: msg => {
        if (msg.method !== 'item/tool/requestUserInput') return undefined
        const answers = {}
        for (const q of msg.params.questions) answers[q.id] = { answers: [q.options?.[0]?.label ?? 'yes'] }
        return { answers }
      },
    })
    try {
      const tid = (await api.call('thread/start', { cwd: live.cwd, approvalPolicy: 'never', sandbox: 'danger-full-access' })).result.thread.id
      const r = await api.call('turn/start', {
        threadId: tid, clientUserMessageId: 'p1',
        collaborationMode: { mode: 'plan', settings: { model, reasoning_effort: effort, developer_instructions: null } },
        input: text('I want a tiny hello-world script in this folder. Before planning, ask me exactly one multiple-choice question (Python or Bash?) using your question tool, then give a very short plan.'),
      })
      await api.until(e => e.method === 'turn/completed' && e.params.turn?.id === r.result?.turn?.id, 150000)
      say(summarize(api.events))
      await api.call('thread/read', { threadId: tid, includeTurns: true })
      await api.call('thread/resume', { threadId: tid, excludeTurns: true })
    } finally { await api.close(); live.cleanup() }
  },

  // S5: one sub-agent.
  async s5() {
    const live = liveCodexHome({ model })
    const api = await connect({ ...live, args: live.appServerArgs, scenario: 's5-subagent' })
    try {
      const tid = (await api.call('thread/start', { cwd: live.cwd, approvalPolicy: 'never', sandbox: 'danger-full-access' })).result.thread.id
      const r = await api.call('turn/start', { threadId: tid, clientUserMessageId: 's1', input: text('Spawn exactly one sub-agent whose only task is to reply with the word child-ok. Wait for it, then reply done. Keep everything minimal.') })
      await api.until(e => e.method === 'turn/completed' && e.params.threadId === tid && e.params.turn.id === r.result.turn.id, 180000)
      say(summarize(api.events))
      await api.call('thread/read', { threadId: tid, includeTurns: true })
      for (const child of new Set(api.events.map(e => e.params?.threadId).filter(id => typeof id === 'string' && id !== tid))) {
        await api.call('thread/read', { threadId: child, includeTurns: true })
      }
      await api.call('thread/list', { limit: 10 })
    } finally { await api.close(); live.cleanup() }
  },
}

const requested = process.argv.slice(2)
if (requested.length === 0 || requested.some(name => !(name in scenarios))) {
  console.error(`usage: node scripts/probes/codex-record.mjs <${Object.keys(scenarios).join('|')}>…`)
  process.exit(2)
}
for (const name of requested) {
  console.log(`=== ${name}`)
  try {
    await scenarios[name]()
  } catch (error) {
    // A failed call can quote the provider URL: scrub before printing.
    console.error(safe(String(error instanceof Error ? error.stack ?? error.message : error)))
    process.exitCode = 1
  }
}
