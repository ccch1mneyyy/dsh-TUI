/**
 * LIVE headless Chat on the Claude backend — real `claude` CLI, real (small)
 * usage. NOT part of CI: runs only with DSH_TUI_CLAUDE_LIVE=1, prints SKIP
 * otherwise. HAIKU ONLY (maintainer cost rule, 2026-10-02): the model is
 * pinned and the run refuses to start on any other
 * (scripts/lib/claude-haiku-only.mjs). Mounts the real `Chat` (headless renderer, like scripts/smoke.tsx)
 * over a channel bound to a Claude Agent session (haiku), submits a prompt
 * through the prompt input and waits until the assistant's reply renders;
 * also checks that DSH-only commands are hidden and refused, and (Phase 4a,
 * the channel core serves every backend) that the IDE selection channel
 * (an in-process IDE fixture), the git-branch breadcrumb and `/export` work
 * on the Claude session — within the same single turn.
 *
 * Phase 4b (one more turn): the session is resumed into a SECOND channel the
 * way the plugin does it (history read before construction): the earlier
 * turn renders before the first live row, `/resume` opens the session
 * browser listing it, a new turn follows the history, and the double-Esc
 * rewind's channel action on that turn's prompt hands the text back and
 * lands on the backend's fork (whose transcript ends before it).
 *
 * Phase 5a (four turns, `--only-5a` runs just this part): a subagent turn
 * (the Agent call's card runs, settles with its Read, `/agents` lists it), a
 * background Bash (its job card and status-line chip, the output tail read
 * from the file the CLI reported), a user interrupt of a third turn that must
 * not stop the job, and the CLI's own notification turn when it finishes.
 *
 * Run: DSH_TUI_CLAUDE_LIVE=1 node --import tsx/esm scripts/verify-claude-headless.tsx [--only-5a]
 */
process.env.FORCE_COLOR = '3'

if (process.env.DSH_TUI_CLAUDE_LIVE !== '1') {
  console.log('SKIP verify-claude-headless (set DSH_TUI_CLAUDE_LIVE=1 to run against the real Claude CLI)')
  process.exit(0)
}

const { pinHaikuOrExit } = await import('./lib/claude-haiku-only.mjs')
pinHaikuOrExit('verify-claude-headless', (await import('../src/utils/paths.js')).DATA_DIR)

const [{ execFile, execFileSync }, { startWsFixture }] = await Promise.all([import('node:child_process'), import('./lib/ide-ws-fixture.js')])

const [{ Writable, PassThrough }, { mkdtempSync, readFileSync, rmSync, writeFileSync }, { tmpdir }, { join }, React, { Terminal: XTerm }, ui, { Chat }, { QuestionStore }, { ApprovalStore }, { createChannel }, { claudeBackend }, { setLang, t }, { default: instances }, { settled, sleep, viewportLines }] =
  await Promise.all([
    import('node:stream'),
    import('node:fs'),
    import('node:os'),
    import('node:path'),
    import('react'),
    import('@xterm/headless'),
    import('../src/ui.js'),
    import('../src/screens/Chat.js'),
    import('../src/dsh-adapter/questions.js'),
    import('../src/dsh-adapter/approvals.js'),
    import('../src/dsh-adapter/channel.js'),
    import('../src/backends/claude/index.js'),
    import('../src/i18n.js'),
    import('../src/ink/instances.js'),
    import('./lib/term-test.mjs'),
  ])

type AgentSession = import('../src/agent/session.js').AgentSession

setLang('en')
let passed = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) throw new Error(`${label}${detail ? `\n${detail}` : ''}`)
  passed += 1
  console.log(`PASS ${label}`)
}

const root = mkdtempSync(join(tmpdir(), 'dsh-tui-claude-headless-'))
writeFileSync(join(root, 'README.md'), '# headless fixture\n')
// A real git repository on a known branch (the status-line breadcrumb).
execFileSync('git', ['init', '-q', '-b', 'headless-branch'], { cwd: root })
// A minimal host shell service (the channel core runs `git branch` and
// `!cmd` through `ctx.get('shell')`).
const shell = {
  resolve: (request: unknown) => request,
  run: (spec: { command: string; workdir: string; timeoutMs: number }) => new Promise(resolve => {
    execFile('sh', ['-c', spec.command], { cwd: spec.workdir, timeout: spec.timeoutMs }, (error, stdout, stderr) => {
      resolve({ stdout: { text: String(stdout) }, stderr: { text: String(stderr) }, timedOut: error?.killed === true })
    })
  }),
}
// An in-process IDE that pushes a selection once the channel connects.
const ide = await startWsFixture('tok-headless', [root], { clearSelectionAfterMs: null })
process.env.DSH_TUI_IDE_PORT = String(ide.port)
process.env.DSH_TUI_IDE_TOKEN = 'tok-headless'
const host = { cwd: root, debug: () => undefined, warn: () => undefined, stderr: () => undefined }
/**
 * Every session this run opened (to dispose) and every Claude session id it
 * created (to delete from the real ~/.claude in the final `finally`, success
 * or failure: the catalog lists programmatic sessions, so leftovers would
 * show up in the user's Claude browser; CLAUDE_CONFIG_DIR is NOT isolated —
 * that would lose the login, and credentials are never copied).
 */
const opened: AgentSession[] = []
/** Created session id → its working directory (where the store keeps it). */
const createdIds = new Map<string, string>()
const track = (session: AgentSession): AgentSession => {
  opened.push(session)
  createdIds.set(session.ref.sessionId, session.cwd)
  return session
}
/** Directories this run made (removed last, after the sessions are gone). */
const scratchDirs: string[] = [root]
const only5a = process.argv.includes('--only-5a')
const session = track(await claudeBackend.open({ kind: 'create', cwd: root }, host))
const ctx = {
  on: () => () => undefined,
  get: (name: string) => name === 'shell' ? shell : undefined,
  logger: { warn: () => undefined, info: () => undefined, debug: () => undefined },
} as never
const lifecycle = {
  openSession: async (target: { kind: 'create'; cwd: string } | { kind: 'resume'; sessionId: string; cwd?: string }) => track(await claudeBackend.open(target, host)),
  sessionCatalog: claudeBackend.catalog,
  resumeCommand: (id: string) => `dsh-tui --backend claude --resume ${id}`,
}
const channel = createChannel(ctx, session, {
  model: claudeBackend.descriptor.label,
  provider: claudeBackend.id,
  cwd: root,
  activity: false,
  backendLabel: claudeBackend.descriptor.label,
  ...lifecycle,
})

// The IDE dial has a short connect budget: let it land before the first
// (heavy) Chat render occupies the event loop.
const ideLinked = await settled(() => channel.selection !== undefined, { timeoutMs: 10_000 })

const COLS = 110
const ROWS = 34
const term = new XTerm({ cols: COLS, rows: ROWS, scrollback: 400, allowProposedApi: true })
class FakeStdout extends Writable {
  columns = COLS
  rows = ROWS
  isTTY = true
  _write(chunk: unknown, _encoding: BufferEncoding, callback: () => void): void { term.write(String(chunk), callback) }
}
class FakeStdin extends PassThrough {
  isTTY = true
  setRawMode() { return this }
  ref() { return this }
  unref() { return this }
}
const stdin = new FakeStdin()
const stdout = new FakeStdout()
const screen = (): string => viewportLines(term, ROWS).join('\n')
const instance = await ui.render(
  React.createElement(Chat, {
    channel: channel as never,
    questionStore: new QuestionStore(),
    approvalStore: new ApprovalStore(),
    onExit: () => undefined,
    fullscreen: false,
    trajectorySeen: true,
  }),
  { stdout: stdout as never, stdin: stdin as never, stderr: stdout as never, exitOnCtrlC: false, patchConsole: false },
)
for (const value of instances.values()) instances.set(process.stdout, value)
const type = async (text: string): Promise<void> => {
  for (const char of text) stdin.write(char)
  // 固定窗:pacing the prompt applies typed characters on its own render tick.
  await sleep(80)
}
const clear = async (): Promise<void> => {
  for (let i = 0; i < 32; i += 1) stdin.write('\x7f')
  // 固定窗:pacing backspaces land before the next keystroke batch.
  await sleep(80)
}

try {
  if (only5a) {
    instance.unmount()
    channel.releaseContributions()
    await session.dispose()
  } else try {
    // 固定窗:pacing the key handlers attach after the first frame.
    await sleep(400)
    check('DSH-only commands are not offered', !channel.commandList.some(command => ['preset', 'tree', 'balance', 'workspace', 'migrate'].includes(command.name)))
    // Phase 3: the backend's own controls are served; Phase 4b: the session
    // lifecycle commands (the catalog and `open` are wired).
    check('Claude controls are offered', ['model', 'effort', 'compact', 'context', 'mcp', 'login', 'resume', 'fork', 'rewind'].every(name => channel.commandList.some(command => command.name === name)), channel.commandList.map(command => command.name).join(' '))
    await type('/preset')
    stdin.write('\r')
    const refusal = t('cmd-unavailable-backend', { cmd: 'preset', backend: claudeBackend.descriptor.label })
    check('a typed DSH-only command is refused, not sent', await settled(() => channel.notifications.some(item => item.text === refusal)), channel.notifications.map(item => item.text).join(' | '))
    await clear()

    check('the IDE selection reaches the Claude session\'s channel', ideLinked)
    check('the git branch breadcrumb shows on the Claude session', await settled(() => channel.gitBranch === 'headless-branch', { timeoutMs: 10_000 }), String(channel.gitBranch))
    await type('Reply with exactly: headless-ok')
    stdin.write('\r')
    const rendered = await settled(
      () => channel.rows.some(row => row.kind === 'assistant' && row.streaming !== true && row.text.includes('headless-ok')) && screen().includes('headless-ok') && !channel.working,
      { timeoutMs: 120_000 },
    )
    check('the assistant reply renders in the transcript', rendered, screen())
    check('the confirmed user bubble renders', channel.rows.some(row => row.kind === 'user' && row.text === 'Reply with exactly: headless-ok'))
    check('the status line shows the Claude model', /haiku/iu.test(channel.model), channel.model)
    check('the backend reports its session cost', channel.costReport?.currency === 'USD')
    check('the submitted message carried the IDE selection (indicator on the user row)', channel.rows.some(row => row.kind === 'user' && row.selectionAttached !== undefined))
    const exported = channel.exportSession()
    check('/export writes the Claude transcript', exported !== null && readFileSync(exported, 'utf8').includes('headless-ok'), String(exported))
  } finally {
    instance.unmount()
    channel.releaseContributions()
    await session.dispose()
  }

  // ── Phase 4b: resume into a second channel, browse, a live turn, rewind ──
  if (!only5a) await phase4b()
  async function phase4b(): Promise<void> {
  const sessionId = session.ref.sessionId
  const resumed = track(await claudeBackend.open({ kind: 'resume', sessionId }, host))
  const initialHistory = await resumed.history()
  const second = createChannel(ctx, resumed, {
    model: claudeBackend.descriptor.label,
    provider: claudeBackend.id,
    cwd: resumed.cwd,
    activity: false,
    backendLabel: claudeBackend.descriptor.label,
    initialHistory,
    ...lifecycle,
  })
  term.reset()
  const resumedInstance = await ui.render(
    React.createElement(Chat, {
      channel: second as never,
      questionStore: new QuestionStore(),
      approvalStore: new ApprovalStore(),
      onExit: () => undefined,
      fullscreen: false,
      trajectorySeen: true,
    }),
    { stdout: stdout as never, stdin: stdin as never, stderr: stdout as never, exitOnCtrlC: false, patchConsole: false },
  )
  for (const value of instances.values()) instances.set(process.stdout, value)
  try {
    // 固定窗:pacing the key handlers attach after the first frame.
    await sleep(400)
    check('resume: the earlier turn is the first thing on screen', second.rows[0]?.kind === 'user' && second.rows[0].text === 'Reply with exactly: headless-ok' && second.rows.some(row => row.kind === 'assistant' && row.text.includes('headless-ok')), second.rows.map(row => row.kind).join(' '))
    check('resume: the history renders', await settled(() => screen().includes('headless-ok')), screen())
    await type('/resume')
    stdin.write('\r')
    // The row shows the session's title (the CLI generates one: its wording
    // varies), marked as the one this terminal is in.
    check('resume: /resume opens the browser listing this session', await settled(() => screen().includes('Claude Agent') && /\bcurrent\b/u.test(screen()) && (second.cachedSessions() ?? []).some(row => row.id === sessionId && row.backendId === 'claude'), { timeoutMs: 15_000 }), screen())
    stdin.write('\u001b')
    // 固定窗:pacing the screen closes and the prompt takes keys again.
    await sleep(300)
    await type('Reply with exactly: resumed-ok')
    stdin.write('\r')
    check('resume: a live turn follows the history', await settled(() => second.rows.some(row => row.kind === 'assistant' && row.streaming !== true && row.text.includes('resumed-ok')) && !second.working, { timeoutMs: 120_000 }), screen())
    const rows = second.rows.map(row => `${row.kind}:${row.text}`)
    check('resume: the live rows land after every history row', rows.findIndex(row => row.includes('resumed-ok')) > rows.findIndex(row => row.startsWith('assistant:') && row.includes('headless-ok')), rows)
    const prompt = second.rows.find(row => row.kind === 'user' && row.text === 'Reply with exactly: resumed-ok')!
    check('rewind: the live user row carries the uuid the session pushed', typeof prompt.anchor === 'string' && prompt.anchor.length > 0)
    const text = await second.rewindTo(prompt)
    check('rewind: the conversation rewind hands the message back', text === 'Reply with exactly: resumed-ok', String(text))
    check('rewind: the channel now runs the backend\'s fork', second.sessionRef.sessionId !== sessionId && second.sessionRef.backendId === 'claude')
    check('rewind: the fork\'s transcript ends before the rewound prompt', second.rows.some(row => row.text.includes('headless-ok')) && !second.rows.some(row => row.text.includes('resumed-ok')), second.rows.map(row => `${row.kind}:${row.text}`))
  } finally {
    resumedInstance.unmount()
    second.releaseContributions()
    // The session the rewind adopted is one this run created too.
    createdIds.set(second.sessionRef.sessionId, root)
  }
  }

  // ── Phase 5a: a subagent, a background job, an interrupt that spares it ──
  const root5 = mkdtempSync(join(tmpdir(), 'dsh-tui-claude-headless-5a-'))
  scratchDirs.push(root5)
  writeFileSync(join(root5, 'README.md'), '# subagent fixture line\n')
  const s5 = track(await claudeBackend.open({ kind: 'create', cwd: root5 }, { ...host, cwd: root5 }))
  const c5 = createChannel(ctx, s5, { model: claudeBackend.descriptor.label, provider: claudeBackend.id, cwd: root5, activity: false, backendLabel: claudeBackend.descriptor.label })
  term.reset()
  const i5 = await ui.render(
    React.createElement(Chat, { channel: c5 as never, questionStore: new QuestionStore(), approvalStore: new ApprovalStore(), onExit: () => undefined, fullscreen: false, trajectorySeen: true }),
    { stdout: stdout as never, stdin: stdin as never, stderr: stdout as never, exitOnCtrlC: false, patchConsole: false },
  )
  for (const value of instances.values()) instances.set(process.stdout, value)
  // Approve whatever the CLI asks (the background Bash) once.
  const approver = setInterval(() => {
    const permissions = s5.capabilities.permissions
    for (const request of permissions?.pending() ?? []) permissions?.respond(request.requestId, { kind: 'allow-once' })
  }, 200)
  try {
    // 固定窗:pacing the key handlers attach after the first frame.
    await sleep(400)
    check('5a: /agents and /jobs are offered', c5.commandList.some(command => command.name === 'agents') && c5.commandList.some(command => command.name === 'jobs'))
    await type('Use the Agent tool with subagent_type "general-purpose" and the prompt "Read README.md with the Read tool and report its first line." Wait for it (do not run it in the background), then reply with its report in one sentence.')
    stdin.write('\r')
    check('5a: the Agent call becomes a running subagent card', await settled(() => c5.rows.some(row => row.kind === 'subagent' && row.subagent?.status === 'running'), { timeoutMs: 120_000 }), c5.rows.map(row => row.kind).join(' '))
    check('5a: the subagent settles with its own Read, the reply follows', await settled(() => c5.subagents[0]?.status === 'completed' && !c5.working && c5.rows.some(row => row.kind === 'assistant' && row.text.includes('subagent fixture line')), { timeoutMs: 180_000 }), JSON.stringify(c5.subagents[0]))
    const sub = c5.subagents[0]!
    check('5a: its tools and text stayed on its card (not the main transcript)', sub.toolCalls.some(tool => tool.name === 'Read' && tool.status === 'completed') && !c5.rows.some(row => row.kind === 'tool' && row.tool?.name === 'Read') && /^[0-9a-f]{8,}$/u.test(sub.agentId), JSON.stringify(sub))
    check('5a: the settled card renders', await settled(() => screen().includes(t('subagent-card-prefix')) && screen().includes(t('subagent-status-completed'))), screen())
    await type('/agents')
    stdin.write('\r')
    check('5a: /agents lists it', await settled(() => screen().includes(sub.agentId.slice(0, 8))), screen())

    await type('Use the Bash tool with run_in_background set to true to run `sleep 25; echo bg-live-done`. Then reply with exactly: started')
    stdin.write('\r')
    check('5a: a background Bash is a running job with the file the CLI reported', await settled(() => c5.backgroundJobs[0]?.status === 'running' && (c5.backgroundJobs[0]?.outputFile ?? '').endsWith(`${c5.backgroundJobs[0]?.id}.output`), { timeoutMs: 120_000 }), JSON.stringify(c5.backgroundJobs))
    // (The chip itself is rendered by verify-claude-tasks: here the status
    // line also carries the IDE selection and truncates.)
    check('5a: the running job card renders, the chip counts it, the turn is over', await settled(() => screen().includes(`${t('jobs-card-prefix')}${c5.backgroundJobs[0]!.id}`) && !c5.working, { timeoutMs: 120_000 })
      && c5.backgroundJobs.filter(job => job.status === 'running').length === 1, screen())
    // A user interrupt of another turn while the job runs.
    await type('Count from 1 to 300, one number per line, nothing else.')
    stdin.write('\r')
    check('5a: a third turn starts streaming', await settled(() => c5.working && c5.rows.some(row => row.kind === 'assistant' && /\b3\b/u.test(row.text)), { timeoutMs: 120_000 }))
    c5.cancel()
    check('5a: the interrupt closes the turn', await settled(() => !c5.working && c5.rows.some(row => row.kind === 'interrupt'), { timeoutMs: 60_000 }), screen())
    check('5a: … and the job keeps running (an interrupt never stops a task)', c5.backgroundJobs[0]?.status === 'running', JSON.stringify(c5.backgroundJobs[0]))
    check('5a: the job completes on its own, its tail read from its output file', await settled(() => c5.backgroundJobs[0]?.status === 'completed' && c5.backgroundJobs[0].outputLines.some(line => line.text.includes('bg-live-done')), { timeoutMs: 120_000 }), JSON.stringify(c5.backgroundJobs[0]))
    check('5a: the CLI reports it in its notification turn', await settled(() => !c5.working && c5.rows.some(row => row.kind === 'notice' && row.text === t('claude-notification-turn')), { timeoutMs: 120_000 }), c5.rows.map(row => `${row.kind}:${row.text.slice(0, 40)}`).join(' | '))
  } finally {
    clearInterval(approver)
    i5.unmount()
    c5.releaseContributions()
  }
} finally {
  // Success or failure: every session opened is closed, and every one this
  // run created is deleted from the store.
  ide.close()
  delete process.env.DSH_TUI_IDE_PORT
  delete process.env.DSH_TUI_IDE_TOKEN
  term.dispose()
  await Promise.all(opened.map(item => item.dispose().catch(() => undefined)))
  for (const [id, cwd] of createdIds) await claudeBackend.catalog!.delete!(id, cwd).catch(() => undefined)
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true })
}

console.log(`\nverify-claude-headless OK (${passed} checks)`)
process.exit(0)
