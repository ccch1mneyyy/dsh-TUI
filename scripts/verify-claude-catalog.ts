/**
 * Claude session lifecycle off the live turn, over a fake SDK and a temp
 * data directory (no CLI, no network):
 *
 *  - the catalog: listing (one project / every project, programmatic sessions
 *    included), the title sources, MRU-aware `updatedAt`, info / preview /
 *    rename / delete with the session's own directory;
 *  - resume: the transcript is read and replayed before the CLI starts with
 *    `resume`; an unknown id fails loudly; live numbering continues;
 *  - `/fork` and the rewind capability: the fork is a persisted copy, the
 *    conversation rewind cuts before the picked message, files restore by
 *    checkpoint (dry run first), `both` restores files then forks;
 *  - the channel flows (core): the browser listing (directory first, then
 *    every project), `/resume` painting history before live events, the
 *    cross-process mount ledger under `claude:<id>` (a real peer process
 *    holds one: refused, nothing opened), a failing resume reported loudly
 *    with the bound session untouched, rename / delete (never the bound or
 *    a held session), the `/fork` notice, the rewind prompt and its three
 *    modes, the startup history painted ahead of the first live event;
 *  - the backend prefs: MRU, the launcher's last-session marker, forget.
 *
 * Uses a temp HOME so the real ~/.dsh-tui is never touched (the ledger reads
 * `homedir()` at import time: HOME is set before the dynamic imports).
 *
 * Run: node --import tsx/esm scripts/verify-claude-catalog.ts
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'dsh-tui-claude-catalog-'))
process.env.HOME = home
process.env.USERPROFILE = home

const [
  { createClaudeCatalog, claudeSessionSummary },
  { loadClaudeTranscript },
  { openClaudeSession },
  { fileClaudePrefs, memoryClaudePrefs },
  { createChannel },
  { readSessionOwners, ownMounts },
  { setLang, t },
  { claudeDeps, fakeClaudeSdk, tick },
  { settled },
] = await Promise.all([
  import('../src/backends/claude/catalog.js'),
  import('../src/backends/claude/backend.js'),
  import('../src/backends/claude/session.js'),
  import('../src/backends/claude/prefs.js'),
  import('../src/dsh-adapter/channel.js'),
  import('../src/sessionMounts.js'),
  import('../src/i18n.js'),
  import('./lib/claude-fake-sdk.js'),
  import('./lib/term-test.mjs'),
])
type AgentEvent = import('../src/agent/events.js').AgentEvent
type AgentEventMeta = import('../src/agent/events.js').AgentEventMeta
type AgentSession = import('../src/agent/session.js').AgentSession
type SessionCapabilities = import('../src/agent/capabilities.js').SessionCapabilities
type SessionSummary = import('../src/adapter/ports/channel-session.js').SessionSummary

setLang('en')
let passed = 0
const check = (label: string, ok: boolean, detail?: unknown): void => {
  assert.ok(ok, detail === undefined ? label : `${label}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`)
  passed += 1
  console.log(`PASS ${label}`)
}

const workdir = join(home, 'work', 'project')
mkdirSync(workdir, { recursive: true })
const NOW = Date.UTC(2026, 9, 2, 12)
const info = (over: Record<string, unknown>) => ({ sessionId: 's', summary: 'a summary', lastModified: NOW - 60_000, fileSize: 1234, cwd: workdir, createdAt: NOW - 120_000, gitBranch: 'main', ...over })

// ── the catalog ────────────────────────────────────────────────────────
{
  const calls: { method: string; args: unknown[] }[] = []
  const store = {
    listSessions: (options?: Record<string, unknown>) => {
      calls.push({ method: 'listSessions', args: [options] })
      return Promise.resolve(options?.dir === undefined
        ? [info({ sessionId: 'a', customTitle: 'Custom or AI title' }), info({ sessionId: 'b', firstPrompt: 'first prompt', lastModified: NOW - 10 }), info({ sessionId: 'elsewhere', cwd: '/other/dir', summary: 'other' })]
        : [info({ sessionId: 'a', customTitle: 'Custom or AI title' }), info({ sessionId: 'b', firstPrompt: 'first prompt', lastModified: NOW - 10 })])
    },
    getSessionInfo: (id: string, options?: Record<string, unknown>) => {
      calls.push({ method: 'getSessionInfo', args: [id, options] })
      return Promise.resolve(options?.dir === undefined && id === 'moved' ? info({ sessionId: 'moved', cwd: '/moved/dir' }) : undefined)
    },
    getSessionMessages: (id: string, options?: Record<string, unknown>) => {
      calls.push({ method: 'getSessionMessages', args: [id, options] })
      return Promise.resolve([
        { type: 'user', uuid: 'u1', session_id: id, message: { role: 'user', content: 'first question' }, parent_tool_use_id: null, parent_agent_id: null },
        { type: 'assistant', uuid: 'a1', session_id: id, message: { id: 'm1', content: [{ type: 'text', text: 'first answer' }] }, parent_tool_use_id: null, parent_agent_id: null },
        { type: 'user', uuid: 'u2', session_id: id, message: { role: 'user', content: 'second question' }, parent_tool_use_id: null, parent_agent_id: null },
        { type: 'assistant', uuid: 'a2', session_id: id, message: { id: 'm2', content: [{ type: 'text', text: 'second answer' }] }, parent_tool_use_id: null, parent_agent_id: null },
      ])
    },
    renameSession: (...args: unknown[]) => { calls.push({ method: 'renameSession', args }); return Promise.resolve() },
    deleteSession: (...args: unknown[]) => { calls.push({ method: 'deleteSession', args }); return Promise.resolve() },
  }
  const catalog = createClaudeCatalog({ loadSdk: () => Promise.resolve(store as never), cwd: () => workdir, lastUsed: () => ({ a: NOW }) })
  const local = await catalog.list({ cwd: workdir })
  const listCall = calls.find(call => call.method === 'listSessions')!.args[0] as Record<string, unknown>
  check('the project listing asks the SDK for that directory, programmatic sessions included (P4-1)', listCall.dir === workdir && listCall.includeProgrammatic === true)
  check('rows are the browser\'s shape, tagged with the backend', local.every(row => row.backendId === 'claude' && row.kind.kind === 'root' && row.hasPrompt && row.childCount === 0))
  const a = local.find(row => row.id === 'a')!
  const b = local.find(row => row.id === 'b')!
  check('a titled session (custom or generated) is `auto`', a.title.text === 'Custom or AI title' && a.title.source === 'auto')
  check('an untitled session shows its first prompt', b.title.text === 'first prompt' && b.title.source === 'prompt')
  check('updatedAt is the later of the mtime and this install\'s last use', a.updatedAt === NOW && b.updatedAt === NOW - 10)
  check('… and rows sort by it', local[0]!.id === 'a')
  check('bytes and branch come from the record', a.bytes === 1234 && a.branch === 'main' && a.cwd === workdir)
  const all = await catalog.list({ allProjects: true })
  const allCall = calls.filter(call => call.method === 'listSessions').at(-1)!.args[0] as Record<string, unknown>
  check('the all-projects listing passes no directory', allCall.dir === undefined && allCall.includeProgrammatic === true && all.some(row => row.id === 'elsewhere' && row.cwd === '/other/dir'))
  check('no title and no prompt falls back to the directory name', claudeSessionSummary(info({ sessionId: 'x', summary: '' }) as never).title.source === 'fallback')
  const moved = await catalog.info!('moved', workdir)
  check('info looks in the directory first, then every project', moved?.cwd === '/moved/dir' && calls.filter(call => call.method === 'getSessionInfo').length === 2)
  const preview = await catalog.preview!('a', { cwd: workdir, limit: 2 })
  check('preview: the tail exchanges of the session\'s own directory', preview.length === 2 && preview[0]!.text === 'second question' && preview[1]!.text === 'second answer' && (calls.find(call => call.method === 'getSessionMessages')!.args[1] as Record<string, unknown>).dir === workdir)
  await catalog.rename!('a', 'New title', workdir)
  await catalog.delete!('b', workdir)
  check('rename and delete pass the session\'s directory', JSON.stringify(calls.find(call => call.method === 'renameSession')!.args) === JSON.stringify(['a', 'New title', { dir: workdir }]) && JSON.stringify(calls.find(call => call.method === 'deleteSession')!.args) === JSON.stringify(['b', { dir: workdir }]))
}

// ── resume: transcript → replay → `resume` ────────────────────────────
const transcriptStore = (sessions: Record<string, { cwd: string; messages: unknown[]; subagents?: Record<string, unknown[]> }>) => ({
  getSessionInfo: (id: string) => Promise.resolve(sessions[id] === undefined ? undefined : info({ sessionId: id, cwd: sessions[id]!.cwd, customTitle: `title of ${id}` })),
  getSessionMessages: (id: string) => Promise.resolve(sessions[id]?.messages ?? []),
  listSubagents: (id: string) => Promise.resolve(Object.keys(sessions[id]?.subagents ?? {})),
  getSubagentMessages: (id: string, agent: string) => Promise.resolve(sessions[id]?.subagents?.[agent] ?? []),
})
const chain = (id: string) => [
  { type: 'user', uuid: `${id}-u1`, session_id: id, message: { role: 'user', content: 'read the file' }, parent_tool_use_id: null, parent_agent_id: null, timestamp: '2026-10-02T10:00:00.000Z' },
  { type: 'assistant', uuid: `${id}-a1`, session_id: id, message: { id: `${id}-m1`, model: 'claude-haiku-4-5', content: [{ type: 'tool_use', id: `${id}-call`, name: 'Agent', input: { description: 'look', subagent_type: 'general-purpose', prompt: 'look' } }], usage: { input_tokens: 5, output_tokens: 7 } }, parent_tool_use_id: null, parent_agent_id: null, timestamp: '2026-10-02T10:00:01.000Z' },
  { type: 'user', uuid: `${id}-r1`, session_id: id, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `${id}-call`, content: 'done' }] }, parent_tool_use_id: null, parent_agent_id: null, timestamp: '2026-10-02T10:00:02.000Z' },
  { type: 'assistant', uuid: `${id}-a2`, session_id: id, message: { id: `${id}-m2`, model: 'claude-haiku-4-5', content: [{ type: 'text', text: 'it says hi' }], usage: { input_tokens: 9, output_tokens: 3 } }, parent_tool_use_id: null, parent_agent_id: null, timestamp: '2026-10-02T10:00:03.000Z' },
  { type: 'user', uuid: `${id}-u2`, session_id: id, message: { role: 'user', content: 'and then?' }, parent_tool_use_id: null, parent_agent_id: null, timestamp: '2026-10-02T10:00:04.000Z' },
  { type: 'assistant', uuid: `${id}-a3`, session_id: id, message: { id: `${id}-m3`, model: 'claude-haiku-4-5', content: [{ type: 'text', text: 'nothing more' }] }, parent_tool_use_id: null, parent_agent_id: null, timestamp: '2026-10-02T10:00:05.000Z' },
]
{
  const store = transcriptStore({
    'sess-1': { cwd: workdir, messages: chain('sess-1'), subagents: { agentx: [{ type: 'assistant', uuid: 'x1', session_id: 'sess-1', message: { id: 'mx', content: [{ type: 'text', text: 'subagent report' }] }, parent_tool_use_id: 'sess-1-call', parent_agent_id: null }] } },
  })
  const loaded = await loadClaudeTranscript(store as never, { sessionId: 'sess-1' }, '/launch/dir')
  check('resume reads where the session was recorded', loaded.cwd === workdir)
  check('… replays its subagents after their Agent call', loaded.replay.events.some(event => event.type === 'subagent.start' && event.agentId === 'agentx' && event.parentCallId === 'sess-1-call'))
  check('… and its title', loaded.replay.events.some(event => event.type === 'session.title' && event.title === 'title of sess-1'))
  check('an unknown id fails loudly (never a fresh session)', await loadClaudeTranscript(store as never, { sessionId: 'nope' }, workdir).then(() => false, (error: Error) => error.message === t('claude-resume-not-found', { id: 'nope' })))

  const fake = fakeClaudeSdk(undefined, {
    rewindFiles: (anchor: unknown, options: unknown) => ((options as { dryRun?: boolean } | undefined)?.dryRun === true
      ? { canRewind: true, filesChanged: ['src/a.ts', 'src/b.ts'], insertions: 4, deletions: 1 }
      : anchor === 'no-checkpoint' ? { canRewind: false, error: 'No file checkpoint for this message' } : { canRewind: true, filesChanged: ['src/a.ts'], insertions: 4, deletions: 1 }),
  })
  const forks: { id: string; options: Record<string, unknown> }[] = []
  let failFork = false
  const sessionStore = {
    getSessionMessages: () => Promise.resolve(chain('sess-1')),
    forkSession: (id: string, options: Record<string, unknown>) => {
      if (failFork) return Promise.reject(new Error('disk full'))
      forks.push({ id, options })
      return Promise.resolve({ sessionId: `fork-${forks.length}` })
    },
  }
  const session = await openClaudeSession(claudeDeps(fake.sdk, { sessionId: 'sess-1', cwd: workdir, resume: loaded.replay, store: sessionStore as never }))
  const query = fake.queries[0]!
  check('the CLI starts with `resume` (never `sessionId`)', query.options.resume === 'sess-1' && query.options.sessionId === undefined)
  check('history() is the replay read before the start', await session.history() === loaded.replay.events)
  const live: AgentEvent[] = []
  session.subscribe(batch => { live.push(...batch) })
  await tick()
  await session.submit({ text: 'third question', clientMessageId: 'u-3' }, 'turn')
  query.emit({ type: 'command_lifecycle', command_uuid: 'u-3', state: 'started' })
  query.emit({ type: 'assistant', message: { id: 'live-m', model: 'claude-haiku-4-5', content: [{ type: 'text', text: 'live answer' }], usage: {} } })
  query.emit({ type: 'result', subtype: 'success', is_error: false, result: 'ok' })
  for (let i = 0; i < 6; i += 1) await tick()
  const turnStart = live.find((event): event is Extract<AgentEvent, { type: 'turn.start' }> => event.type === 'turn.start')
  const message = live.find((event): event is Extract<AgentEvent, { type: 'assistant.message' }> => event.type === 'assistant.message')
  check('live numbering continues after the replay (turn and seq)', turnStart?.turn === loaded.replay.start.turn + 1 && message !== undefined && message.seq > loaded.replay.start.seq)

  // /fork and the rewind
  const forked = await session.capabilities.fork!.fork()
  check('/fork: a persisted copy in the session\'s directory, the live session untouched', forked.backendId === 'claude' && forked.sessionId === 'fork-1' && forks[0]!.id === 'sess-1' && forks[0]!.options.dir === workdir && forks[0]!.options.upToMessageId === undefined && !query.closed)
  const rewind = session.capabilities.rewind!
  const preview = await rewind.preview!('sess-1-u2')
  check('rewind preview: a dry-run file restore', preview.filesChanged.length === 2 && preview.insertions === 4 && query.calls.some(call => call.method === 'rewindFiles' && (call.args[1] as { dryRun?: boolean } | undefined)?.dryRun === true))
  const conversation = await rewind.rewind('sess-1-u2', 'conversation')
  check('conversation rewind forks up to the entry right before the picked message', conversation.kind === 'rewound' && conversation.session.sessionId === 'fork-2' && forks[1]!.options.upToMessageId === 'sess-1-a2' && conversation.files === undefined)
  const filesOnly = await rewind.rewind('sess-1-u2', 'files')
  check('files rewind restores by checkpoint and stays in the session', filesOnly.kind === 'rewound' && filesOnly.session.sessionId === 'sess-1' && filesOnly.files?.filesChanged.length === 1 && forks.length === 2)
  const both = await rewind.rewind('sess-1-u2', 'both')
  check('both: files first, then the fork', both.kind === 'rewound' && both.files !== undefined && both.session.sessionId === 'fork-3')
  // The files moved, then the fork failed: a partial outcome, never one
  // reported as nothing done.
  failFork = true
  const partial = await rewind.rewind('sess-1-u2', 'both')
  check('both, fork failing after the files: files reported, the conversation error kept, the session stays', partial.kind === 'rewound' && partial.files?.filesChanged.length === 1 && partial.conversationError === 'disk full' && partial.session.sessionId === 'sess-1', partial)
  check('a conversation-only rewind whose fork fails still rejects (nothing was done)', await rewind.rewind('sess-1-u2', 'conversation').then(() => false, (error: Error) => error.message === 'disk full'))
  failFork = false
  const first = await rewind.rewind('sess-1-u1', 'conversation')
  check('the very first message cannot be rewound to', first.kind === 'refused' && first.reason === t('rewind-first-message'))
  const unknown = await rewind.rewind('not-there', 'both')
  check('an anchor outside the saved chain is refused before any file moves', unknown.kind === 'refused' && query.calls.filter(call => call.method === 'rewindFiles' && (call.args[1] as { dryRun?: boolean } | undefined)?.dryRun !== true && call.args[0] === 'not-there').length === 0)
  const noCheckpoint = await rewind.rewind('no-checkpoint', 'files')
  check('a missing checkpoint is refused with the CLI\'s reason', noCheckpoint.kind === 'refused' && noCheckpoint.reason.includes('No file checkpoint'))
  await session.dispose()

  // A session the CLI never wrote has nothing to fork.
  const fresh = await openClaudeSession(claudeDeps(fakeClaudeSdk().sdk, { store: sessionStore as never }))
  check('/fork before the first saved prompt is refused', await fresh.capabilities.fork!.fork().then(() => false, (error: Error) => error.message === t('claude-fork-empty')))
  await fresh.dispose()
}

// ── the backend prefs ──────────────────────────────────────────────────
{
  const prefs = memoryClaudePrefs({ model: 'haiku' })
  prefs.touch('s1')
  prefs.write({ lastSession: 's1' })
  prefs.touch('s2')
  check('prefs: MRU notes and the last-session marker, other fields kept', prefs.data.model === 'haiku' && prefs.data.lastSession === 's1' && Object.keys(prefs.data.lastUsed ?? {}).sort().join() === 's1,s2')
  prefs.forget('s1')
  check('forget drops the note and the marker it named', prefs.data.lastSession === undefined && Object.keys(prefs.data.lastUsed ?? {}).join() === 's2')
  const dir = join(home, '.dsh-tui', 'backends', 'claude')
  const file = fileClaudePrefs(dir)
  file.write({ model: 'haiku', lastSession: 'disk-1' })
  file.touch('disk-1')
  const raw = JSON.parse(readFileSync(join(dir, 'prefs.json'), 'utf8')) as Record<string, unknown>
  check('the launcher reads `lastSession` straight from prefs.json', raw.lastSession === 'disk-1' && raw.model === 'haiku' && typeof (raw.lastUsed as Record<string, unknown>)['disk-1'] === 'number')
  writeFileSync(join(dir, 'prefs.json'), '{ broken')
  check('a corrupt prefs file reads as no choice', JSON.stringify(file.read()) === '{}')
  rmSync(join(dir, 'prefs.json'))
}

// ── prefs writes never expose a torn document ──────────────────────────
{
  const dir = join(home, 'atomic', 'claude')
  mkdirSync(dir, { recursive: true })
  const debugged: string[] = []
  const prefs = fileClaudePrefs(dir, message => debugged.push(message))
  prefs.write({ model: 'opus' })
  // A near-limit document (200 colours + 200 MRU notes) widens the window
  // a plain O_TRUNC write leaves the file truncated for.
  for (let i = 0; i < 200; i++) prefs.setColor(`s-${i}`, '#0a0b0c')
  for (let i = 0; i < 200; i++) prefs.touch(`t-${i}`)
  // A real second process hammers the same file through the same API (two
  // terminals, no synthetic fs) while this one keeps reading (and
  // writing); whatever a reader sees must be a complete JSON document,
  // and the shared fields (the model pick) must survive the storm.
  const PREFS_URL = new URL('../src/backends/claude/prefs.ts', import.meta.url).href
  const ready = join(dir, 'writer-ready')
  const writer = spawn(process.execPath, ['--import', 'tsx/esm', '-e',
    `const m = await import(${JSON.stringify(PREFS_URL)}); const fs = await import('node:fs'); const p = m.fileClaudePrefs(${JSON.stringify(dir)}); fs.writeFileSync(${JSON.stringify(ready)}, ''); const end = Date.now() + 2500; let i = 0; while (Date.now() < end) { p.setColor('peer-' + (i % 60), '#abcdef'); p.touch('peer-' + (i % 60)); i++ }`],
    { stdio: 'ignore', env: { ...process.env } })
  // The exit promise is armed at once (a child that dies before the ready
  // marker settles the await instead of hanging the test).
  const exited = new Promise<void>(resolve => {
    writer.once('exit', () => resolve())
    writer.once('error', () => resolve())
  })
  // A ready marker written by the child itself: the storm below only counts
  // once the writer is really hammering (a dead child would fail here).
  check('prefs: the concurrent writer came up', await settled(() => existsSync(ready), { timeoutMs: 15_000 }))
  // 固定窗:墙钟 a fixed observation window: the child hammers for 2.5 s,
  // this loop reads (and writes) for 3 s — long enough to overlap the whole
  // storm deterministically without extending the run on failure.
  const deadline = Date.now() + 3000
  let torn = 0
  let reads = 0
  while (Date.now() < deadline) {
    reads += 1
    try {
      JSON.parse(readFileSync(join(dir, 'prefs.json'), 'utf8'))
    } catch {
      torn += 1
    }
    prefs.touch(`main-${reads % 20}`)
  }
  await exited
  rmSync(ready, { force: true })
  check('prefs: the concurrent writer ran to completion', writer.exitCode === 0, writer.exitCode)
  check('prefs: a concurrent reader never sees a torn document', torn === 0, `${torn} torn of ${reads} reads`)
  const final = JSON.parse(readFileSync(join(dir, 'prefs.json'), 'utf8')) as Record<string, unknown>
  check('prefs: the storm never wipes the model choice', final.model === 'opus', Object.keys(final))
  check('prefs: no temporary litter is left behind', readdirSync(dir).filter(name => name.endsWith('.tmp')).length === 0, readdirSync(dir))

  // A failed commit reports, keeps the previous document and cleans its
  // temporary (the target being a directory makes the rename fail).
  const debuggedSoFar = debugged.length
  rmSync(join(dir, 'prefs.json'))
  mkdirSync(join(dir, 'prefs.json'))
  prefs.write({ model: 'haiku' })
  check('prefs: a failed commit keeps the target and leaves no temp', debugged.length === debuggedSoFar + 1 && readdirSync(dir).join() === 'prefs.json' && JSON.stringify(prefs.read()) === '{}', debugged)
  rmSync(dir, { recursive: true, force: true })
}

// A rename that fails mid-commit leaves the previous document (a valid
// prefs file, byte for byte) and its temporary is cleaned; the next write
// still succeeds. The failure is injected through the default fs export
// for this process only (`syncBuiltinESMExports` from node:module makes
// the named bindings follow; the storm child above keeps the real one).
{
  const dir = join(home, 'atomic-fail', 'claude')
  mkdirSync(dir, { recursive: true })
  const debugged: string[] = []
  const prefs = fileClaudePrefs(dir, message => debugged.push(message))
  prefs.write({ model: 'opus' })
  prefs.touch('keep-1')
  const before = readFileSync(join(dir, 'prefs.json'), 'utf8')
  const fsDefault = (await import('node:fs')).default
  const { syncBuiltinESMExports } = await import('node:module')
  const realRename = fsDefault.renameSync
  let injections = 0
  try {
    fsDefault.renameSync = () => { injections += 1; throw new Error('injected rename failure') }
    syncBuiltinESMExports()
    prefs.write({ model: 'haiku' })
  } finally {
    fsDefault.renameSync = realRename
    syncBuiltinESMExports()
  }
  check('prefs: a failed rename keeps the previous document byte-for-byte', readFileSync(join(dir, 'prefs.json'), 'utf8') === before && (JSON.parse(before) as Record<string, unknown>).model === 'opus' && injections === 1, { injections, head: before.slice(0, 40) })
  check('prefs: the failed commit is reported and leaves no temp', debugged.length === 1 && readdirSync(dir).join() === 'prefs.json', debugged)
  prefs.write({ model: 'sonnet' })
  check('prefs: the next write after a failed one succeeds', (JSON.parse(readFileSync(join(dir, 'prefs.json'), 'utf8')) as Record<string, unknown>).model === 'sonnet')
  rmSync(join(home, 'atomic-fail'), { recursive: true, force: true })
}

// ── the channel: browser, /resume, ledger, rename/delete, /fork, rewind ──
interface FakeSession extends AgentSession {
  disposed: boolean
  emit(events: readonly AgentEvent[], meta?: Partial<AgentEventMeta>): void
}
const fakeSession = (sessionId: string, options: { cwd?: string; history?: readonly AgentEvent[]; emitOnSubscribe?: readonly AgentEvent[]; capabilities?: Omit<SessionCapabilities, 'native'> } = {}): FakeSession => {
  const listeners = new Set<(batch: readonly AgentEvent[], meta: AgentEventMeta) => void>()
  const session: FakeSession = {
    ref: { backendId: 'claude', sessionId },
    cwd: options.cwd ?? workdir,
    status: 'idle',
    capabilities: { ...options.capabilities, native: {} },
    disposed: false,
    history: () => Promise.resolve(options.history ?? []),
    subscribe(listener) {
      listeners.add(listener)
      // A backend may deliver right away (Claude's start-up backlog): the
      // channel must already have painted the history.
      if (options.emitOnSubscribe !== undefined) listener(options.emitOnSubscribe, { replay: false, wake: 'sync' })
      return () => { listeners.delete(listener) }
    },
    submit: () => Promise.resolve({ accepted: true }),

    cancel: () => Promise.resolve({ stillQueued: [] }),
    dispose() { session.disposed = true; return Promise.resolve() },
    emit(events, meta = {}) { for (const listener of [...listeners]) listener(events, { replay: false, wake: 'sync', ...meta }) },
  }
  return session
}
const userTurn = (turn: number, seq: number, id: string, text: string, reply: string): AgentEvent[] => [
  { type: 'turn.start', turn, origin: 'user', userMessageId: id, time: seq },
  { type: 'user.message', id, anchor: id, seq, turn, time: seq, source: 'user', text, blocks: [{ type: 'text', text }] },
  { type: 'step.start', turn, step: 1 },
  { type: 'assistant.attempt.start', attemptId: `m-${id}`, turn, step: 1 },
  { type: 'assistant.message', seq: seq + 1, anchor: `m-${id}`, turn, step: 1, attemptId: `m-${id}`, time: seq + 1, canonical: true, blocks: [{ type: 'text', text: reply }] },
  { type: 'step.end', turn, step: 1 },
  { type: 'turn.end', turn, reason: { kind: 'completed' }, time: seq + 2 },
]
const ctx = { on: () => () => undefined, get: () => undefined, logger: { warn: () => undefined, info: () => undefined, debug: () => undefined } } as never

const catalogRows: SessionSummary[] = [
  claudeSessionSummary(info({ sessionId: 'here-1', customTitle: 'Here one' }) as never),
  claudeSessionSummary(info({ sessionId: 'held-1', customTitle: 'Held one' }) as never),
]
const catalogCalls: string[] = []
const sessionCatalog = {
  list: (scope?: { cwd?: string; allProjects?: boolean }) => {
    catalogCalls.push(scope?.allProjects === true ? 'list:all' : `list:${scope?.cwd ?? ''}`)
    return Promise.resolve(scope?.allProjects === true ? [...catalogRows, claudeSessionSummary(info({ sessionId: 'far-1', cwd: '/far/away', customTitle: 'Far' }) as never)] : catalogRows)
  },
  preview: (id: string, options?: { cwd?: string }) => { catalogCalls.push(`preview:${id}:${options?.cwd ?? ''}`); return Promise.resolve([{ role: 'user' as const, text: 'hi', at: undefined }]) },
  rename: (id: string, title: string, cwd?: string) => { catalogCalls.push(`rename:${id}:${title}:${cwd ?? ''}`); return Promise.resolve() },
  delete: (id: string, cwd?: string) => { catalogCalls.push(`delete:${id}:${cwd ?? ''}`); return Promise.resolve() },
}
const prefCalls: string[] = []
const sessionPrefs = {
  touch: (id: string) => { prefCalls.push(`touch:${id}`) },
  setLastSession: (id: string) => { prefCalls.push(`last:${id}`) },
  forget: (id: string) => { prefCalls.push(`forget:${id}`) },
}

// A real second process holds `claude:held-1` in the ledger.
const MODULE_URL = new URL('../src/sessionMounts.ts', import.meta.url).href
const peer = spawn(process.execPath, ['--import', 'tsx/esm', '-e', `const m = await import(${JSON.stringify(MODULE_URL)}); m.publishMounts(['claude:held-1']); setInterval(() => {}, 60_000)`], { stdio: 'ignore', env: { ...process.env } })
try {
  check('a peer process holds claude:held-1', await settled(() => readSessionOwners().get('claude:held-1')?.pid === peer.pid, { timeoutMs: 15_000 }))

  // The startup session: its history read ahead paints before its first
  // live event (which it delivers synchronously on subscribe).
  const startupHistory = userTurn(1, 1, 'start-u1', 'earlier question', 'earlier answer')
  const startup = fakeSession('start-1', { history: startupHistory, emitOnSubscribe: [{ type: 'notice', level: 'info', text: 'live backlog notice' }] })
  const opened: string[] = []
  let failNext = false
  const sessions = new Map<string, FakeSession>()
  const channel = createChannel(ctx, startup, {
    model: 'Claude Agent', provider: 'claude', cwd: workdir, activity: false, backendLabel: 'Claude Agent',
    initialHistory: startupHistory,
    sessionCatalog,
    sessionPrefs,
    resumeCommand: id => `dsh-tui --backend claude --resume ${id}`,
    openSession: target => {
      opened.push(target.kind === 'resume' ? `resume:${target.sessionId}` : `create:${target.cwd}`)
      if (failNext) { failNext = false; return Promise.reject(new Error('No conversation found with session ID: x')) }
      const id = target.kind === 'resume' ? target.sessionId : `new-${opened.length}`
      const history = target.kind === 'resume' ? userTurn(1, 1, `${id}-u1`, `question of ${id}`, `answer of ${id}`) : []
      const next = fakeSession(id, { history, emitOnSubscribe: [{ type: 'notice', level: 'info', text: `backlog of ${id}` }] })
      sessions.set(id, next)
      return Promise.resolve(next)
    },
  })
  const toasts = (): string[] => channel.notifications.map(item => item.text)
  const kinds = (): string[] => channel.rows.map(row => `${row.kind}:${row.text}`)
  try {
    check('the startup history paints before the first live event', kinds()[0] === 'user:earlier question' && kinds().indexOf('notice:live backlog notice') > kinds().indexOf('assistant:earlier answer'), kinds())
    check('user rows carry the backend\'s rewind anchor', channel.rows.find(row => row.kind === 'user')?.anchor === 'start-u1')
    check('/resume is offered for a backend with a catalog and open', channel.backendCapabilities.resume && channel.backendCapabilities.commands.includes('resume'))

    // The browser: the directory first (partial), then every project.
    const partials: number[] = []
    const listed = await channel.listSessions(undefined, rows => { partials.push(rows.length) })
    check('the browser lists the directory first, then every project', JSON.stringify(catalogCalls.slice(0, 2)) === JSON.stringify([`list:${workdir}`, 'list:all']) && partials[0] === 2 && listed.length === 3 && listed.some(row => row.id === 'far-1'))
    check('… and caches the listing for the next first paint', channel.cachedSessions()?.length === 3)
    await channel.previewSession('far-1')
    check('preview reads in the row\'s own directory', catalogCalls.includes('preview:far-1:/far/away'))

    // Resume: history first, then live; the ledger follows the bound key.
    const resumed = await channel.resumeTo('here-1')
    const target = sessions.get('here-1')!
    check('/resume opens the target with `resume`', resumed.ok && opened.at(-1) === 'resume:here-1' && channel.sessionRef.sessionId === 'here-1' && channel.agentId === 'here-1')
    check('… its history paints before its live events', kinds()[0] === 'user:question of here-1' && kinds().indexOf('notice:backlog of here-1') > kinds().indexOf('assistant:answer of here-1'), kinds())
    check('… the replaced session is disposed', await settled(() => startup.disposed))
    check('… MRU and the launcher marker follow', prefCalls.includes('touch:here-1') && prefCalls.includes('last:here-1'))
    check('… the ledger holds claude:here-1 and no longer claude:start-1', await settled(() => ownMounts().includes('claude:here-1') && !ownMounts().includes('claude:start-1')), ownMounts())
    target.emit(userTurn(2, 10, 'here-1-u2', 'live question', 'live answer'))
    check('live rows land after the history', kinds().indexOf('user:live question') > kinds().indexOf('assistant:answer of here-1'))

    // A session another TUI process drives: refused, nothing opened.
    const before = opened.length
    const held = await channel.resumeTo('held-1')
    check('a session held by another process is refused (occupied, its pid)', !held.ok && held.reason === 'occupied' && held.pid === peer.pid && opened.length === before && channel.sessionRef.sessionId === 'here-1')
    check('… and the user is told who holds it', toasts().includes(t('resume-session-occupied', { pid: peer.pid! })))

    // A failing resume is loud and leaves the bound session alone.
    failNext = true
    const broken = await channel.resumeTo('broken-1')
    check('a failing resume reports the failure (never a silent fresh session)', !broken.ok && broken.reason === 'failed' && toasts().some(text => text.startsWith(t('resume-failed', { err: '' }).trim().slice(0, 12))) && channel.sessionRef.sessionId === 'here-1' && !target.disposed)
    check('… and gives its ledger reservation back', !ownMounts().includes('claude:broken-1'))

    // Rename / delete through the catalog.
    check('rename the bound session: catalog + status line', await channel.renameSessionTo('here-1', '  Renamed  ') && catalogCalls.includes(`rename:here-1:Renamed:${workdir}`) && channel.sessionTitle === 'Renamed')
    check('the bound session cannot be deleted', await channel.deleteSession('here-1') === false && !catalogCalls.some(call => call.startsWith('delete:here-1')))
    check('a session another process holds cannot be deleted', await channel.deleteSession('held-1') === false && !catalogCalls.some(call => call.startsWith('delete:held-1')))
    check('delete: catalog, prefs and the cached listing', await channel.deleteSession('far-1') && catalogCalls.includes('delete:far-1:/far/away') && prefCalls.includes('forget:far-1') && !(channel.cachedSessions() ?? []).some(row => row.id === 'far-1'))
    channel.setResumeTarget('here-1')
    check('setResumeTarget sets the backend\'s own marker', prefCalls.filter(call => call === 'last:here-1').length === 2)
  } finally {
    channel.releaseContributions()
  }

  // /fork and the rewind on a session with those capabilities.
  const rewinds: { anchor: string; mode: string }[] = []
  let refuse: string | undefined
  let conversationError: string | undefined
  let previewFails = false
  const capable = fakeSession('cap-1', {
    history: userTurn(1, 1, 'cap-u1', 'first prompt', 'first answer').concat(userTurn(2, 4, 'cap-u2', 'second prompt', 'second answer')),
    capabilities: {
      fork: { fork: () => Promise.resolve({ backendId: 'claude', sessionId: 'forked-9' }) },
      rewind: {
        preview: () => previewFails ? Promise.reject(new Error('no checkpoint')) : Promise.resolve({ filesChanged: ['a.ts', 'b.ts'], insertions: 3, deletions: 2 }),
        rewind: (anchor, mode) => {
          rewinds.push({ anchor, mode })
          if (refuse !== undefined) return Promise.resolve({ kind: 'refused' as const, reason: refuse })
          if (conversationError !== undefined) return Promise.resolve({ kind: 'rewound' as const, session: { backendId: 'claude', sessionId: 'cap-1' }, files: { filesChanged: ['a.ts'], insertions: 3, deletions: 2 }, conversationError })
          return Promise.resolve(mode === 'files'
            ? { kind: 'rewound' as const, session: { backendId: 'claude', sessionId: 'cap-1' }, files: { filesChanged: ['a.ts'], insertions: 3, deletions: 2 } }
            : { kind: 'rewound' as const, session: { backendId: 'claude', sessionId: anchor === 'cap-u1' ? 'rewound-unopenable' : `rewound-${rewinds.length}` }, ...(mode === 'both' ? { files: { filesChanged: ['a.ts'] } } : {}) })
        },
      },
    },
  })
  const capOpened: string[] = []
  let raceId: string | undefined
  const rewindChannel: ReturnType<typeof createChannel> = createChannel(ctx, capable, {
    model: 'Claude Agent', provider: 'claude', cwd: workdir, activity: false, backendLabel: 'Claude Agent',
    initialHistory: await capable.history(),
    sessionCatalog,
    sessionPrefs,
    resumeCommand: id => `dsh-tui --backend claude --resume ${id}`,
    openSession: target => {
      capOpened.push(target.kind === 'resume' ? target.sessionId : 'create')
      if (target.kind === 'resume' && target.sessionId === 'rewound-unopenable') return Promise.reject(new Error('cannot open'))
      // The user types while the fork opens: the open is abandoned as a race.
      if (target.kind === 'resume' && target.sessionId === raceId) rewindChannel.submit('typed while the fork opened')
      return Promise.resolve(fakeSession(target.kind === 'resume' ? target.sessionId : 'n', { history: target.kind === 'resume' ? userTurn(1, 1, 'r-u1', 'first prompt', 'first answer') : [] }))
    },
  })
  const rewindToasts = (): string[] => rewindChannel.notifications.map(item => item.text)
  try {
    check('/fork: a persisted copy, the notice names how to enter it', await rewindChannel.forkSession() && rewindToasts().includes(t('fork-done', { id: 'forked-9', command: 'dsh-tui --backend claude --resume forked-9' })) && rewindChannel.sessionRef.sessionId === 'cap-1')
    const second = rewindChannel.rows.find(row => row.kind === 'user' && row.text === 'second prompt')!
    const prompt = await rewindChannel.promptRewind(second)
    check('the rewind prompt offers files and both, described by the dry run', prompt !== 'cancel' && prompt !== null && JSON.stringify(prompt.modes.map(mode => mode.id)) === JSON.stringify(['both', 'files']) && prompt.modes.every(mode => mode.description === `${t('rewind-files-count', { n: 2 })} · +3 −2`))
    previewFails = true
    check('no file restore available: the plain conversation confirm', await rewindChannel.promptRewind(second) === null)
    check('a row without an anchor is not rewindable', await rewindChannel.promptRewind({ id: 99, kind: 'user', text: 'no anchor' }) === 'cancel')
    const filesText = await rewindChannel.rewindTo(second, 'files')
    check('files only: restored, the conversation stays (no text back, no switch)', filesText === null && rewinds.at(-1)?.mode === 'files' && rewinds.at(-1)?.anchor === 'cap-u2' && rewindChannel.sessionRef.sessionId === 'cap-1' && rewindToasts().includes(t('rewind-files-restored', { summary: `${t('rewind-files-count', { n: 1 })} · +3 −2` })))
    refuse = 'not allowed here'
    check('a refused rewind is reported, nothing switches', await rewindChannel.rewindTo(second, 'both') === null && rewindToasts().includes(t('rewind-fork-failed', { err: 'not allowed here' })) && rewindChannel.sessionRef.sessionId === 'cap-1')
    refuse = undefined
    const firstRow = rewindChannel.rows.find(row => row.kind === 'user' && row.text === 'first prompt')!
    check('a fork the channel cannot open stays persisted, and the notice says how to enter it', await rewindChannel.rewindTo(firstRow) === null
      && rewindToasts().includes(t('rewind-fork-kept', { command: 'dsh-tui --backend claude --resume rewound-unopenable' })) && rewindChannel.sessionRef.sessionId === 'cap-1')
    conversationError = 'disk full'
    check('files restored but the conversation rewind failed: both said, nothing switches', await rewindChannel.rewindTo(second, 'both') === null
      && rewindToasts().includes(t('rewind-conversation-failed', { err: 'disk full' })) && rewindToasts().filter(text => text === t('rewind-files-restored', { summary: `${t('rewind-files-count', { n: 1 })} · +3 −2` })).length >= 2 && rewindChannel.sessionRef.sessionId === 'cap-1', rewindToasts())
    conversationError = undefined
    raceId = 'rewound-5'
    check('a fork open abandoned as a race keeps the fork and says how to enter it', await rewindChannel.rewindTo(second) === null && capOpened.at(-1) === 'rewound-5'
      && rewindToasts().includes(t('rewind-fork-kept', { command: 'dsh-tui --backend claude --resume rewound-5' })) && rewindChannel.sessionRef.sessionId === 'cap-1', rewindToasts())
    raceId = undefined
    await settled(() => !rewindChannel.working && rewindChannel.pending.length === 0)
    const text = await rewindChannel.rewindTo(second)
    check('the conversation rewind adopts the backend\'s fork and hands the message back', text === 'second prompt' && rewinds.at(-1)?.mode === 'conversation' && capOpened.at(-1) === 'rewound-6' && rewindChannel.sessionRef.sessionId === 'rewound-6')
    check('… the fork\'s history replaces the transcript', rewindChannel.rows.some(row => row.kind === 'user' && row.text === 'first prompt') && !rewindChannel.rows.some(row => row.text === 'second prompt'))
  } finally {
    rewindChannel.releaseContributions()
  }
} finally {
  peer.kill()
  rmSync(home, { recursive: true, force: true })
}

console.log(`\nverify-claude-catalog OK (${passed} checks)`)
process.exit(0)
