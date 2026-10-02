/**
 * LIVE Claude backend check — real `claude` CLI, real credentials, real (small)
 * usage. NOT part of CI: it runs only with DSH_TUI_CLAUDE_LIVE=1 and prints
 * SKIP otherwise. HAIKU ONLY (maintainer cost rule, 2026-10-02): the child's
 * model is pinned to haiku and the run refuses to start when the environment
 * or a persisted `/model` choice names another model
 * (scripts/lib/claude-haiku-only.mjs). Throwaway project directory.
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
 *     panel and aborts the turn;
 *  6. controls (Phase 3): a haiku-only `/model` round trip — the `haiku`
 *     alias, then its full id, each switched in place (`setModel`, reported
 *     as `model.changed`) and confirmed by the next reply's model; `/effort`
 *     when haiku offers levels; Shift+Tab's acceptEdits then a Write with no
 *     prompt; `/compact` (compaction start/end). Switching to OTHER models is
 *     covered by the fake-SDK verify-claude-controls only. The persisted
 *     `/model` / `/effort` choice file is restored afterwards;
 *  7. reconnect (Phase 3 review item 1): `/login`'s reconnect on a session
 *     the CLI never persisted creates it again under the same id (no "No
 *     conversation found"); after a turn it resumes the same transcript.
 *  8. sessions (Phase 4b, 2 turns): create → 1 turn → dispose → the catalog
 *     lists it → resume (the replayed history comes first, the live turn
 *     continues the numbering, the model sees the earlier turn) → `/fork`
 *     (a persisted copy with both turns; the live session untouched) →
 *     rewind the conversation to turn 1 (a fork cut before turn 2's
 *     prompt — the anchor is the uuid the session pushed, which the
 *     transcript keeps) → the catalog deletes the copies.
 *  9. phase 5b (`DSH_TUI_CLAUDE_LIVE_SECTIONS=5b`, 2 turns): a tiny PNG
 *     sent as a base64 image block is seen ("what color is this
 *     square?" → red); `/btw` over that conversation answers through the
 *     side query (a throwaway fork) and writes NO transcript file;
 *     `/rename` writes the title the catalog then lists; `/color` is kept
 *     for the session id.
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

const { pinHaikuOrExit, isHaiku } = await import('./lib/claude-haiku-only.mjs')
pinHaikuOrExit('verify-claude-live', (await import('../src/utils/paths.js')).DATA_DIR)
const { claudeBackend } = await import('../src/backends/claude/index.js')
const { setLang } = await import('../src/i18n.js')
const { PermissionStore } = await import('../src/channel/permissions.js')
const { QuestionStore } = await import('../src/channel/questions.js')
const { attachInteraction } = await import('../src/channel/interaction.js')
const sections = new Set((process.env.DSH_TUI_CLAUDE_LIVE_SECTIONS ?? 'basic,permissions,controls,controls-turns,reconnect,sessions,5b').split(',').map(name => name.trim()))
/** `controls` without `controls-turns`: the read-only reports only (no turn). */
class SkipTurns extends Error {}
type AgentEvent = import('../src/agent/events.js').AgentEvent
type AgentSession = import('../src/agent/session.js').AgentSession

setLang('en')
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
/**
 * Every Claude session this run created (opened, forked, rewound): deleted
 * from the real ~/.claude in the final `finally`, success or failure — the
 * catalog lists programmatic sessions, so leftovers would show up in the
 * user's Claude browser. (CLAUDE_CONFIG_DIR is NOT isolated: that would lose
 * the login, and credentials are never copied.)
 */
const created = new Set<string>()
/** Every session this run opened: disposed before any is deleted (a live
 *  CLI still appending would recreate a deleted transcript). */
const opened: AgentSession[] = []
const openSession = async (target: Parameters<typeof claudeBackend.open>[0]): Promise<AgentSession> => {
  const session = await claudeBackend.open(target, host)
  opened.push(session)
  created.add(session.ref.sessionId)
  return session
}
/** Close every opened session, then delete every created one (idempotent:
 *  the final `finally` and Ctrl+C share it). */
let cleaning: Promise<void> | undefined
const cleanup = (): Promise<void> => {
  cleaning ??= (async () => {
    await Promise.all(opened.map(session => session.dispose().catch(() => undefined)))
    // One never persisted has nothing to delete.
    for (const id of created) await claudeBackend.catalog!.delete!(id, project).catch(() => undefined)
    rmSync(root, { recursive: true, force: true })
  })()
  return cleaning
}
process.once('SIGINT', () => {
  console.error('\nverify-claude-live: interrupted — closing and deleting this run\'s sessions')
  void cleanup().finally(() => process.exit(130))
})

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
    const session = await openSession({ kind: 'create', cwd: project })
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
    const session = await openSession({ kind: 'create', cwd: project })
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
    const session = await openSession({ kind: 'create', cwd: project })
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
    const session = await openSession({ kind: 'create', cwd: project })
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
    const session = await openSession({ kind: 'create', cwd: project })
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

  // 6. controls
  if (sections.has('controls')) {
    const { DATA_DIR } = await import('../src/utils/paths.js')
    const prefsFile = join(DATA_DIR, 'backends', 'claude', 'prefs.json')
    const savedPrefs = existsSync(prefsFile) ? readFileSync(prefsFile, 'utf8') : undefined
    process.env.DSH_TUI_CLAUDE_PERMISSION_MODE = 'default'
    const session = await openSession({ kind: 'create', cwd: project })
    delete process.env.DSH_TUI_CLAUDE_PERMISSION_MODE
    try {
      const live = watch(session)
      const caps = session.capabilities
      // Read-only reports first (no turn needed): context usage, account, /login.
      const usage = await caps.context!.usage('summary')
      check('controls: context usage reports a window and its categories', usage.max !== undefined && usage.max > 0 && usage.categories.some(category => category.kind === 'used' && category.tokens > 0), { max: usage.max, categories: usage.categories.length })
      const account = await caps.account!.info()
      check('controls: account info has a provider (never an email)', account.provider !== undefined && !JSON.stringify(account).includes('@'))
      const auth = await caps.auth!.status()
      check('controls: /login status names a source', auth.lines.length > 0 && auth.lines[0]!.length > 0, auth.lines)
      if (!sections.has('controls-turns')) throw new SkipTurns()
      const models = await caps.models!.list()
      check('controls: the model catalog lists haiku', models.some(model => model.id === 'haiku'), models.map(model => model.id))
      const modelChanges = (): string[] => live.events.flatMap(event => event.type === 'model.changed' ? [event.model] : [])
      check('controls: /model haiku (the alias) switches in place', (await caps.models!.set({ model: 'haiku' })).kind === 'switched' && modelChanges().some(isHaiku), modelChanges())
      const levels = caps.effort!.levels().map(level => level.id)
      if (levels.length > 0) {
        await caps.effort!.set(levels[0]!)
        check(`controls: /effort ${levels[0]}`, caps.effort!.current() === levels[0])
      } else {
        console.log('NOTE controls: haiku offers no effort levels (/effort is covered by verify-claude-controls)')
      }
      await session.submit({ text: 'Reply with exactly: haiku-ok', clientMessageId: crypto.randomUUID() }, 'followup')
      await live.until(() => turnEnds(live.events).length >= 1, 120_000, 'haiku turn end')
      const attemptModel = (): string => live.events.filter((event): event is Extract<AgentEvent, { type: 'assistant.attempt.start' }> => event.type === 'assistant.attempt.start').at(-1)?.model ?? ''
      const fullId = attemptModel()
      check('controls: the reply ran on haiku, under its full id (message_start.model)', isHaiku(fullId) && fullId !== 'haiku' && turnEnds(live.events)[0]?.reason.kind === 'completed', fullId)
      // `switched` is answered only after the CLI accepted `setModel`; the
      // next reply's model confirms it.
      check('controls: /model <full haiku id> switches in place (setModel accepted)', (await caps.models!.set({ model: fullId })).kind === 'switched' && isHaiku(caps.models!.current().model), caps.models!.current())

      await caps.modes!.set('acceptEdits')
      check('controls: Shift+Tab mode acceptEdits is current', caps.modes!.current() === 'acceptEdits')
      await session.submit({ text: 'Use the Write tool to create accepted.txt containing exactly: accepted. Reply done.', clientMessageId: crypto.randomUUID() }, 'followup')
      await live.until(() => turnEnds(live.events).length >= 2, 120_000, 'acceptEdits turn end')
      check('controls: the full-id switch is confirmed by the next reply (haiku)', attemptModel() === fullId, attemptModel())
      check('controls: acceptEdits wrote without a prompt', existsSync(join(project, 'accepted.txt')) && !live.events.some(event => event.type === 'permission.request'))

      await caps.compact!.run()
      await live.until(() => live.events.some(event => event.type === 'compaction.end'), 180_000, 'compaction end')
      check('controls: /compact compacts (start + committed end)', live.events.some(event => event.type === 'compaction.start') && live.events.some(event => event.type === 'compaction.end' && event.ok))
    } catch (error) {
      if (!(error instanceof SkipTurns)) throw error
    } finally {
      await session.dispose()
      if (savedPrefs === undefined) rmSync(prefsFile, { force: true })
      else writeFileSync(prefsFile, savedPrefs)
    }
    check('controls: no claude child survives', (await waitForNoChildren()).length === 0, claudeChildren())
  }

  // 7. reconnect before and after the first persisted turn (2 turns)
  if (sections.has('reconnect')) {
    const session = await openSession({ kind: 'create', cwd: project })
    try {
      const live = watch(session)
      await session.capabilities.auth!.reconnect()
      check('reconnect: a never-persisted session reconnects and stays live', session.status !== 'disposed' && !live.events.some(event => event.type === 'session.status' && event.status === 'disposed'))
      await session.submit({ text: 'Remember the word quince. Reply with exactly: noted', clientMessageId: crypto.randomUUID() }, 'followup')
      await live.until(() => turnEnds(live.events).length >= 1, 120_000, 'turn after the first reconnect')
      check('reconnect: the session takes a turn after it', turnEnds(live.events)[0]?.reason.kind === 'completed', turnEnds(live.events)[0])
      await session.capabilities.auth!.reconnect()
      await session.submit({ text: 'Which word did I ask you to remember? Reply with that word only.', clientMessageId: crypto.randomUUID() }, 'followup')
      await live.until(() => turnEnds(live.events).length >= 2, 120_000, 'turn after the resume')
      const replies = live.events.filter((event): event is Extract<AgentEvent, { type: 'assistant.message' }> => event.type === 'assistant.message')
      check('reconnect: a persisted session resumes its own transcript', replies.at(-1)?.blocks.some(block => block.type === 'text' && /quince/iu.test(block.text ?? '')) === true, replies.at(-1)?.blocks)
    } finally {
      await session.dispose()
    }
    check('reconnect: no claude child survives', (await waitForNoChildren()).length === 0, claudeChildren())
  }

  // 8. sessions: resume, /fork, rewind (Phase 4b)
  if (sections.has('sessions')) {
    const { getSessionMessages } = await import('@anthropic-ai/claude-agent-sdk')
    const original = await openSession({ kind: 'create', cwd: project })
    const sessionId = original.ref.sessionId
    const firstId = crypto.randomUUID()
    try {
      const live = watch(original)
      await original.submit({ text: 'Remember the word persimmon. Reply with exactly: first-ok', clientMessageId: firstId }, 'followup')
      await live.until(() => turnEnds(live.events).length >= 1, 120_000, 'the first turn')
      check('sessions: the first turn completes', turnEnds(live.events)[0]?.reason.kind === 'completed', turnEnds(live.events)[0])
    } finally {
      await original.dispose()
    }
    const listed = await claudeBackend.catalog!.list({ cwd: project })
    check('sessions: the catalog lists the session dsh-tui created (programmatic included)', listed.some(row => row.id === sessionId && row.backendId === 'claude' && row.cwd === project), listed.map(row => row.id))
    const resumed = await openSession({ kind: 'resume', sessionId })
    const secondId = crypto.randomUUID()
    try {
      const history = await resumed.history()
      const firstUser = history.find((event): event is Extract<AgentEvent, { type: 'user.message' }> => event.type === 'user.message')
      check('sessions: the resumed history replays the first turn, anchored at the uuid the session pushed', firstUser?.anchor === firstId && history.some(event => event.type === 'assistant.message' && event.blocks.some(block => (block.text ?? '').includes('first-ok'))), history.map(event => event.type))
      const live = watch(resumed)
      await resumed.submit({ text: 'Which word did I ask you to remember? Reply with that word only.', clientMessageId: secondId }, 'followup')
      await live.until(() => turnEnds(live.events).length >= 1, 120_000, 'the resumed turn')
      const replies = live.events.filter((event): event is Extract<AgentEvent, { type: 'assistant.message' }> => event.type === 'assistant.message')
      check('sessions: the resumed session remembers the earlier turn', replies.at(-1)?.blocks.some(block => block.type === 'text' && /persimmon/iu.test(block.text ?? '')) === true, replies.at(-1)?.blocks)
      const replayedTurns = history.filter(event => event.type === 'turn.start').length
      const liveTurn = live.events.find((event): event is Extract<AgentEvent, { type: 'turn.start' }> => event.type === 'turn.start')
      check('sessions: the live turn continues the replayed numbering', liveTurn !== undefined && liveTurn.turn > replayedTurns, liveTurn)
      const forked = await resumed.capabilities.fork!.fork()
      created.add(forked.sessionId)
      const forkChain = await getSessionMessages(forked.sessionId, { dir: project })
      check('sessions: /fork writes a persisted copy with both turns, the live session untouched', forked.sessionId !== sessionId && forkChain.filter(message => message.type === 'user').length >= 2 && resumed.status !== 'disposed', forkChain.length)
      const rewound = await resumed.capabilities.rewind!.rewind(secondId, 'conversation')
      if (rewound.kind === 'rewound') created.add(rewound.session.sessionId)
      check('sessions: the conversation rewind forks before turn 2\'s prompt', rewound.kind === 'rewound' && rewound.session.sessionId !== sessionId, rewound)
      if (rewound.kind === 'rewound') {
        const rewoundChain = await getSessionMessages(rewound.session.sessionId, { dir: project })
        const texts = rewoundChain.flatMap(message => {
          const content = (message.message as { content?: unknown } | undefined)?.content
          return typeof content === 'string' ? [content] : Array.isArray(content) ? content.flatMap(block => typeof (block as { text?: unknown }).text === 'string' ? [(block as { text: string }).text] : []) : []
        })
        check('sessions: the rewound copy keeps turn 1 and drops turn 2', texts.some(text => text.includes('persimmon')) && !texts.some(text => text.includes('Which word did I ask')), texts)
        await claudeBackend.catalog!.delete!(rewound.session.sessionId, project)
      }
      await claudeBackend.catalog!.delete!(forked.sessionId, project)
      const after = await claudeBackend.catalog!.list({ cwd: project })
      check('sessions: the catalog deletes the copies', !after.some(row => row.id === forked.sessionId) && after.some(row => row.id === sessionId), after.map(row => row.id))
    } finally {
      await resumed.dispose()
    }
    check('sessions: no claude child survives', (await waitForNoChildren()).length === 0, claudeChildren())
  }
  // 9. phase 5b: an image turn, /btw (no transcript), /rename, /color
  if (sections.has('5b')) {
    const { readdirSync, existsSync: exists } = await import('node:fs')
    const { homedir } = await import('node:os')
    const { deflateSync } = await import('node:zlib')
    const { createLocalImageStore } = await import('../src/dsh-adapter/channel/core/local-images.js')
    const { CLAUDE_IMAGE_LIMITS } = await import('../src/backends/claude/images.js')
    /** A 16×16 solid red PNG, built by hand. */
    const redPng = (): Uint8Array => {
      const table = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0 })
      const crc = (bytes: Uint8Array): number => { let c = 0xffffffff; for (const byte of bytes) c = table[(c ^ byte) & 0xff]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }
      const chunk = (type: string, data: Uint8Array): Buffer => {
        const head = Buffer.alloc(8); head.writeUInt32BE(data.length, 0); head.write(type, 4, 'ascii')
        const tail = Buffer.alloc(4); tail.writeUInt32BE(crc(Buffer.concat([head.subarray(4), data])), 0)
        return Buffer.concat([head, data, tail])
      }
      const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(16, 0); ihdr.writeUInt32BE(16, 4); ihdr.set([8, 2, 0, 0, 0], 8)
      const rows = Buffer.alloc((16 * 3 + 1) * 16)
      for (let y = 0; y < 16; y += 1) for (let x = 0; x < 16; x += 1) rows.set([255, 0, 0], y * 49 + 1 + x * 3)
      return new Uint8Array(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(rows)), chunk('IEND', new Uint8Array())]))
    }
    /** Transcript files in every project directory naming this run's project. */
    const projectDir = join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'projects')
    const transcripts = (): string[] => {
      const tag = root.split('/').at(-1)!
      return exists(projectDir) ? readdirSync(projectDir).filter(dir => dir.includes(tag)).flatMap(dir => readdirSync(join(projectDir, dir)).filter(file => file.endsWith('.jsonl')).map(file => `${dir}/${file}`)) : []
    }
    const session = await openSession({ kind: 'create', cwd: project })
    try {
      const live = watch(session)
      const store = createLocalImageStore(() => CLAUDE_IMAGE_LIMITS)
      const ref = await store.saveImage({ data: redPng(), mediaType: 'image/png', name: 'square.png' })
      const id = crypto.randomUUID()
      await session.submit({ text: 'What color is this square? Reply with one word.', blocks: [{ type: 'text', text: 'What color is this square? Reply with one word.' }, { type: 'image' }], images: [store.facade(ref)!], clientMessageId: id }, 'turn')
      await live.until(() => turnEnds(live.events).length >= 1, 120_000, 'the image turn')
      const reply = live.events.filter((event): event is Extract<AgentEvent, { type: 'assistant.message' }> => event.type === 'assistant.message').at(-1)
      check('5b: the model sees the image (a red square)', reply?.blocks.some(block => block.type === 'text' && /red/iu.test(block.text ?? '')) === true, reply?.blocks)
      check('5b: the user row carries the image', live.events.some(event => event.type === 'user.message' && event.id === id && (event.images?.length ?? 0) === 1))
      const before = transcripts()
      let streamed = ''
      const btw = await session.capabilities.sideQuery!.ask('In one word: what color was the square?', { onText: delta => { streamed += delta } })
      check('5b: /btw answers over the conversation (side query)', btw.answer !== null && /red/iu.test(btw.answer) && streamed.trim() !== '', btw)
      const after = transcripts()
      check('5b: the side query wrote no transcript file', JSON.stringify(after) === JSON.stringify(before), { before, after })
      check('5b: the session itself is untouched by the side query', session.status !== 'disposed' && turnEnds(live.events).length === 1)
      await session.capabilities.rename!.rename('Live 5b square')
      const listed = await claudeBackend.catalog!.list({ cwd: project })
      check('5b: /rename writes the title the catalog lists', listed.some(row => row.id === session.ref.sessionId && row.title.text === 'Live 5b square'), listed.map(row => row.title))
      session.capabilities.color!.set('purple')
      check('5b: /color is kept for the session id', session.capabilities.color!.current() === 'purple')
      session.capabilities.color!.set('')
    } finally {
      await session.dispose()
    }
    check('5b: no claude child survives', (await waitForNoChildren()).length === 0, claudeChildren())
  }
} finally {
  // Success or failure: every session opened is closed first, then no
  // session of this run stays in the user's store.
  await cleanup()
}

console.log(`\nverify-claude-live OK (${passed} checks)`)
process.exit(0)
