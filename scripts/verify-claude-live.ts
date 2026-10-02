/**
 * LIVE Claude backend check — real `claude` CLI, real credentials, real (small)
 * usage. NOT part of CI: it runs only with DSH_TUI_CLAUDE_LIVE=1 and prints
 * SKIP otherwise. Uses haiku (ANTHROPIC_MODEL=haiku for the child) and a
 * throwaway project directory.
 *
 *  1. a text turn streams and settles (user row confirmed, reply, cost);
 *  2. Read + Write with DSH_TUI_CLAUDE_PERMISSION_MODE=acceptEdits (the
 *     developer start-mode override) actually writes the file;
 *  3. a mid-stream cancel closes the turn as aborted;
 *  4. open → dispose ×5, then no `claude` child process of this process
 *     remains (`ps --ppid`);
 *  5. approvals (Phase 3), answered through the real PermissionStore and the
 *     channel's interaction bridge, in `default` mode: a Write approved once
 *     writes the file; a Bash rejected with a reason errors its card and the
 *     model carries on; an interrupt while a prompt is pending closes the
 *     panel and aborts the turn.
 *
 * `DSH_TUI_CLAUDE_LIVE_SECTIONS=basic,permissions` limits the run (default:
 * all) — each section costs real turns.
 * Prerequisites: `claude` on PATH or CLAUDE_CODE_EXECUTABLE; a logged-in CLI.
 * Run: DSH_TUI_CLAUDE_LIVE=1 node --import tsx/esm scripts/verify-claude-live.ts
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

if (process.env.DSH_TUI_CLAUDE_LIVE !== '1') {
  console.log('SKIP verify-claude-live (set DSH_TUI_CLAUDE_LIVE=1 to run against the real Claude CLI)')
  process.exit(0)
}

const { claudeBackend } = await import('../src/backends/claude/index.js')
const { setLang } = await import('../src/i18n.js')
const { PermissionStore } = await import('../src/channel/permissions.js')
const { QuestionStore } = await import('../src/channel/questions.js')
const { attachInteraction } = await import('../src/channel/interaction.js')
const sections = new Set((process.env.DSH_TUI_CLAUDE_LIVE_SECTIONS ?? 'basic,permissions').split(',').map(name => name.trim()))
type AgentEvent = import('../src/agent/events.js').AgentEvent
type AgentSession = import('../src/agent/session.js').AgentSession

setLang('en')
process.env.ANTHROPIC_MODEL ??= 'haiku'
let passed = 0
const check = (label: string, ok: boolean, detail?: unknown): void => {
  assert.ok(ok, detail === undefined ? label : `${label}: ${typeof detail === 'string' ? detail : JSON.stringify(detail).slice(0, 600)}`)
  passed += 1
  console.log(`PASS ${label}`)
}
const root = mkdtempSync(join(tmpdir(), 'dsh-tui-claude-live-'))
const project = join(root, 'project')
mkdirSync(project)
writeFileSync(join(project, 'README.md'), '# Live fixture\n\nThe secret word is marmalade.\n')
const host = { cwd: project, debug: () => undefined, warn: () => undefined, stderr: () => undefined }

/** Subscribe and wait for predicates over the accumulated events. */
function watch(session: AgentSession) {
  const events: AgentEvent[] = []
  const waiters: { pred: () => boolean; resolve: () => void }[] = []
  session.subscribe(batch => {
    events.push(...batch)
    for (const waiter of [...waiters]) if (waiter.pred()) { waiters.splice(waiters.indexOf(waiter), 1); waiter.resolve() }
  })
  return {
    events,
    until(pred: () => boolean, timeoutMs = 120_000, label = 'condition'): Promise<void> {
      if (pred()) return Promise.resolve()
      return new Promise((resolve, reject) => {
        const waiter = { pred, resolve }
        waiters.push(waiter)
        setTimeout(() => { if (waiters.includes(waiter)) reject(new Error(`timed out waiting for ${label}`)) }, timeoutMs).unref()
      })
    },
  }
}
const turnEnds = (events: AgentEvent[]) => events.filter((event): event is Extract<AgentEvent, { type: 'turn.end' }> => event.type === 'turn.end')
const claudeChildren = (): string[] => {
  try {
    return execFileSync('ps', ['--ppid', String(process.pid), '-o', 'pid=,args='], { encoding: 'utf8' })
      .split('\n').map(line => line.trim()).filter(line => line !== '' && /claude/u.test(line) && !/\bps\b/u.test(line))
  } catch {
    return []
  }
}
const waitForNoChildren = async (): Promise<string[]> => {
  for (let i = 0; i < 50; i += 1) {
    const left = claudeChildren()
    if (left.length === 0) return left
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  return claudeChildren()
}

try {
  const detection = await claudeBackend.detect(host)
  check('detect: SDK installed and CLI found', detection.installed && detection.version !== undefined, detection)

  if (sections.has('basic')) {
  // 1. text turn
  {
    const session = await claudeBackend.open({ kind: 'create', cwd: project }, host)
    const live = watch(session)
    await session.submit({ text: 'Reply with exactly: live-ok', clientMessageId: crypto.randomUUID() }, 'followup')
    await live.until(() => turnEnds(live.events).length >= 1, 120_000, 'first turn end')
    const ready = live.events.find(event => event.type === 'session.ready')
    check('text: session.ready names the model (haiku)', ready?.type === 'session.ready' && /haiku/iu.test(ready.model), ready)
    check('text: the user row is confirmed', live.events.some(event => event.type === 'user.message' && event.text === 'Reply with exactly: live-ok'))
    check('text: streamed text deltas', live.events.some(event => event.type === 'assistant.delta' && event.delta.kind === 'text'))
    check('text: the reply settles', live.events.some(event => event.type === 'assistant.message' && event.blocks.some(block => block.type === 'text' && (block.text ?? '').includes('live-ok'))))
    const end = turnEnds(live.events)[0]
    check('text: completed with a backend cost', end?.reason.kind === 'completed' && end.cost?.currency === 'USD' && end.cost.amount > 0, end)
    await session.dispose()
  }

  // 2. Read + Write (acceptEdits start mode via the developer override)
  {
    process.env.DSH_TUI_CLAUDE_PERMISSION_MODE = 'acceptEdits'
    const session = await claudeBackend.open({ kind: 'create', cwd: project }, host)
    delete process.env.DSH_TUI_CLAUDE_PERMISSION_MODE
    const live = watch(session)
    await session.submit({ text: 'Use the Read tool to read README.md. Then use the Write tool to create out.txt containing exactly the secret word from README.md. Reply done.', clientMessageId: crypto.randomUUID() }, 'followup')
    await live.until(() => turnEnds(live.events).length >= 1, 180_000, 'tool turn end')
    const calls = live.events.filter((event): event is Extract<AgentEvent, { type: 'tool.call' }> => event.type === 'tool.call')
    const results = live.events.filter((event): event is Extract<AgentEvent, { type: 'tool.result' }> => event.type === 'tool.result')
    check('tools: Read and Write were called', calls.some(call => call.name === 'Read') && calls.some(call => call.name === 'Write'), calls.map(call => call.name))
    check('tools: Read renders as a read card', results.some(result => result.presentation?.card === 'read'))
    check('tools: Write renders as a diff card', results.some(result => result.presentation?.card === 'diff'))
    check('tools: the file was written', existsSync(join(project, 'out.txt')) && readFileSync(join(project, 'out.txt'), 'utf8').includes('marmalade'))
    await session.dispose()
  }

  // 3. cancel mid-stream
  {
    const session = await claudeBackend.open({ kind: 'create', cwd: project }, host)
    const live = watch(session)
    await session.submit({ text: 'Count from 1 to 300, one number per line, no other text.', clientMessageId: crypto.randomUUID() }, 'followup')
    await live.until(() => live.events.some(event => event.type === 'assistant.delta' && event.delta.kind === 'text'), 120_000, 'first text delta')
    await session.cancel('user')
    await live.until(() => turnEnds(live.events).length >= 1, 40_000, 'aborted turn end')
    check('cancel: the turn closes as aborted', turnEnds(live.events)[0]?.reason.kind === 'aborted', turnEnds(live.events)[0])
    await session.dispose()
  }

  check('no claude child survives the three sessions', (await waitForNoChildren()).length === 0, claudeChildren())

  // 4. open → dispose ×5
  for (let i = 0; i < 5; i += 1) {
    const session = await claudeBackend.open({ kind: 'create', cwd: project }, host)
    check(`dispose ×5: session ${i + 1} opened`, session.status === 'idle')
    // The probe must see a live child, or "none left" below proves nothing.
    if (i === 0) check('dispose ×5: ps --ppid sees the live claude child', claudeChildren().length >= 1, claudeChildren())
    await session.dispose()
  }
  const left = await waitForNoChildren()
  check('dispose ×5: no claude child process remains (ps --ppid)', left.length === 0, left)
  }

  // 5. approvals through the shared store (default mode)
  if (sections.has('permissions')) {
    process.env.DSH_TUI_CLAUDE_PERMISSION_MODE = 'default'
    const session = await claudeBackend.open({ kind: 'create', cwd: project }, host)
    delete process.env.DSH_TUI_CLAUDE_PERMISSION_MODE
    const permissions = new PermissionStore()
    const link = attachInteraction({ permissions, questions: new QuestionStore(), debug: () => undefined }, { sessionId: session.ref.sessionId, capabilities: session.capabilities })
    session.subscribe(batch => link.apply(batch))
    const live = watch(session)
    const panel = (): boolean => permissions.getSnapshot() !== null
    const status = (value: string): boolean => live.events.some(event => event.type === 'session.status' && event.status === value)

    await session.submit({ text: 'Use the Write tool to create approved.txt containing exactly: approved. Reply done.', clientMessageId: crypto.randomUUID() }, 'followup')
    await live.until(panel, 120_000, 'the Write approval')
    const write = permissions.getSnapshot()!
    check('approve: the Write prompt parks on the panel', write.toolName.includes('Write') && write.command === 'approved.txt', write)
    check('approve: the CLI suggests auto-accepting edits (allow always offered)', write.options?.some(option => option.kind === 'allow-always') === true, write.options)
    check('approve: the session requires action', session.status === 'requires-action' && status('requires-action'))
    permissions.decide('allowed-once', { optionId: 'allow-once', kind: 'allow-once' })
    await live.until(() => turnEnds(live.events).length >= 1, 120_000, 'approved turn end')
    check('approve: allow once wrote the file', existsSync(join(project, 'approved.txt')) && readFileSync(join(project, 'approved.txt'), 'utf8').includes('approved'))
    check('approve: settled allow-once', live.events.some(event => event.type === 'permission.settled' && event.outcome === 'allow-once'))

    await session.submit({ text: 'Use the Bash tool to run `touch dsh-tui-live-reject.txt`. If the tool is refused, reply with exactly: refused-ok', clientMessageId: crypto.randomUUID() }, 'followup')
    await live.until(panel, 120_000, 'the Bash approval')
    check('reject: the Bash prompt shows its command', permissions.getSnapshot()?.command?.includes('dsh-tui-live-reject') === true, permissions.getSnapshot())
    permissions.decide('rejected', { optionId: 'reject', kind: 'reject', feedback: 'not now' })
    await live.until(() => turnEnds(live.events).length >= 2, 120_000, 'rejected turn end')
    const bashResult = live.events.filter((event): event is Extract<AgentEvent, { type: 'tool.result' }> => event.type === 'tool.result').at(-1)
    check('reject: the Bash card errors', bashResult?.isError === true && (bashResult.errorText ?? '').length > 0, bashResult)
    check('reject: the model carries on', live.events.some(event => event.type === 'assistant.message' && event.blocks.some(block => (block.text ?? '').includes('refused-ok'))) && turnEnds(live.events)[1]?.reason.kind === 'completed', turnEnds(live.events)[1])

    await session.submit({ text: 'Use the Write tool to create never.txt containing exactly: never. Reply done.', clientMessageId: crypto.randomUUID() }, 'followup')
    await live.until(panel, 120_000, 'the pending approval')
    await session.cancel('user')
    await live.until(() => !panel() && turnEnds(live.events).length >= 3, 40_000, 'panel closed and turn aborted')
    check('interrupt: the pending prompt is withdrawn (panel closes)', !panel() && live.events.some(event => event.type === 'permission.settled' && event.outcome === 'cancelled'))
    check('interrupt: the turn aborts', turnEnds(live.events)[2]?.reason.kind === 'aborted', turnEnds(live.events)[2])
    check('interrupt: nothing was written', !existsSync(join(project, 'never.txt')))
    link.release()
    await session.dispose()
    check('approvals: no claude child survives', (await waitForNoChildren()).length === 0, claudeChildren())
  }
} finally {
  rmSync(root, { recursive: true, force: true })
}

console.log(`\nverify-claude-live OK (${passed} checks)`)
process.exit(0)
