/**
 * "Load earlier" for Claude sessions (docs/agent-backend-design.md §4.11
 * 压缩前历史, Phase 5a), over a synthetic transcript file with TWO
 * compactions and a fake SDK — no CLI, no network:
 *
 *  - locating `<config>/projects/<any>/<sessionId>.jsonl` by scanning (never
 *    by computing the munged directory name); unsafe ids never resolve;
 *  - the reader: bad lines tolerated (skipped, counted), a file over the
 *    bound refused rather than truncated;
 *  - older slices: walked back one compaction segment at a time along the
 *    `parentUuid` chain from each boundary's `logicalParentUuid`, the older
 *    boundary's preserved entries spliced after its summary, the newer one's
 *    excluded (already shown) — in order, bounded (a long segment comes in
 *    slices that never overlap), idempotent once exhausted;
 *  - the channel: `olderHistory` shows "load earlier" with nothing folded,
 *    `loadOlder()` prepends restored rows (ids below every row, never
 *    folded again) segment by segment, then returns 0;
 *  - folding is back on for Claude: a long live session folds rows past the
 *    window (only rows with a stable anchor), its retained text stays
 *    bounded as it grows, and `loadOlder()` restores folded rows from the
 *    transcript file first.
 *
 * Run: node --import tsx/esm scripts/verify-claude-load-older.ts
 */
import assert from 'node:assert/strict'
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'dsh-tui-claude-older-'))
process.env.HOME = home
process.env.USERPROFILE = home

const [
  { locateClaudeTranscript, readTranscriptEntries, preservedUuids, MAX_SLICE_ENTRIES },
  { createClaudeTranscriptHistory },
  { replayClaudeTranscript },
  { openClaudeSession },
  { memoryClaudePrefs },
  { createChannel },
  { MAX_ROWS },
  { setLang, t },
  { settled },
  fakes,
] = await Promise.all([
  import('../src/backends/claude/transcript-file.js'),
  import('../src/backends/claude/older-history.js'),
  import('../src/backends/claude/replay.js'),
  import('../src/backends/claude/session.js'),
  import('../src/backends/claude/prefs.js'),
  import('../src/dsh-adapter/channel.js'),
  import('../src/channel/transcript.js'),
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
type Rec = Record<string, unknown>

// ── a transcript with two compactions ───────────────────────────────────
const SESSION = '0d0d0d0d-0000-4000-8000-00000000c0de'
const configDir = join(home, 'claude-config')
const projectDir = join(configDir, 'projects', '-somewhere-else-entirely')
mkdirSync(projectDir, { recursive: true })
mkdirSync(join(configDir, 'projects', '-another-project'), { recursive: true })
writeFileSync(join(configDir, 'projects', '-another-project', 'unrelated.jsonl'), '{}\n')
let clock = Date.UTC(2026, 9, 2, 9)
const stamp = (): string => new Date((clock += 1000)).toISOString()
const user = (uuid: string, parent: string | null, text: string, extra: Rec = {}): Rec => ({ type: 'user', uuid, parentUuid: parent, isSidechain: false, message: { role: 'user', content: text }, timestamp: stamp(), sessionId: SESSION, ...extra })
const reply = (uuid: string, parent: string, id: string, text: string): Rec => ({ type: 'assistant', uuid, parentUuid: parent, isSidechain: false, message: { id, role: 'assistant', model: 'claude-haiku-4-5', content: [{ type: 'text', text }] }, timestamp: stamp(), sessionId: SESSION })
const call = (uuid: string, parent: string, id: string, callId: string): Rec => ({ type: 'assistant', uuid, parentUuid: parent, isSidechain: false, message: { id, role: 'assistant', model: 'claude-haiku-4-5', content: [{ type: 'tool_use', id: callId, name: 'Read', input: { file_path: '/fixture/project/README.md' } }] }, timestamp: stamp(), sessionId: SESSION })
const result = (uuid: string, parent: string, callId: string, text: string): Rec => ({ type: 'user', uuid, parentUuid: parent, isSidechain: false, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: callId, content: text }] }, toolUseResult: { type: 'text', file: { filePath: '/fixture/project/README.md', content: text } }, timestamp: stamp(), sessionId: SESSION })
const attachment = (uuid: string, parent: string): Rec => ({ type: 'attachment', uuid, parentUuid: parent, isSidechain: false, attachment: { type: 'noise' }, timestamp: stamp() })
const boundary = (uuid: string, logicalParent: string, anchor: string, preserved: string[]): Rec => ({ type: 'system', subtype: 'compact_boundary', uuid, parentUuid: null, logicalParentUuid: logicalParent, isSidechain: false, content: 'Conversation compacted', compactMetadata: { trigger: 'manual', preTokens: 1000, preservedMessages: { anchorUuid: anchor, uuids: preserved } }, timestamp: stamp() })
const summary = (uuid: string, parent: string, text: string): Rec => ({ ...user(uuid, parent, text), isCompactSummary: true })

// Segment A (the oldest): two turns, one with a Read call.
const segmentA = [
  user('a-u1', null, 'first question'),
  attachment('a-x1', 'a-u1'),
  reply('a-a1', 'a-x1', 'msg-a1', 'first answer'),
  user('a-u2', 'a-a1', 'second question'),
  call('a-c2', 'a-u2', 'msg-a2', 'toolu-a2'),
  result('a-r2', 'a-c2', 'toolu-a2', '1\t# Fixture project'),
  reply('a-a3', 'a-r2', 'msg-a3', 'second answer (preserved by the first compaction)'),
]
// Compaction 1 keeps a-a3 after its summary.
const segmentB = [
  boundary('b1', 'a-a3', 's1', ['a-a3']),
  summary('s1', 'b1', 'SUMMARY ONE: the first two questions'),
  user('b-u3', 's1', 'third question'),
  reply('b-a4', 'b-u3', 'msg-b4', 'third answer'),
  user('b-u4', 'b-a4', 'fourth question'),
  reply('b-a5', 'b-u4', 'msg-b5', 'fourth answer (preserved by the second compaction)'),
]
// Compaction 2 keeps b-a5 after its summary; the current chain follows.
const segmentC = [
  boundary('b2', 'b-a5', 's2', ['b-a5']),
  summary('s2', 'b2', 'SUMMARY TWO: four questions so far'),
  user('c-u5', 's2', 'fifth question'),
  reply('c-a6', 'c-u5', 'msg-c6', 'fifth answer'),
]
const transcriptPath = join(projectDir, `${SESSION}.jsonl`)
writeFileSync(transcriptPath, [
  ...segmentA.map(entry => JSON.stringify(entry)),
  '{"type": "user", "uuid": "trunc',            // a truncated line
  'not json at all',                              // garbage
  JSON.stringify({ type: 'queue-operation', operation: 'enqueue' }),
  ...segmentB.map(entry => JSON.stringify(entry)),
  ...segmentC.map(entry => JSON.stringify(entry)),
].join('\n') + '\n')
// What the SDK's read API returns on resume: the post-compaction chain
// (the boundary, the summary, the preserved tail, what followed).
const resumedChain = [
  { type: 'system', uuid: 'b2', session_id: SESSION, parent_tool_use_id: null, timestamp: segmentC[0]!.timestamp },
  { type: 'user', uuid: 's2', isCompactSummary: true, message: segmentC[1]!.message, parent_tool_use_id: null, timestamp: segmentC[1]!.timestamp },
  { type: 'assistant', uuid: 'b-a5', message: segmentB[5]!.message, parent_tool_use_id: null, timestamp: segmentB[5]!.timestamp },
  { type: 'user', uuid: 'c-u5', message: segmentC[2]!.message, parent_tool_use_id: null, timestamp: segmentC[2]!.timestamp },
  { type: 'assistant', uuid: 'c-a6', message: segmentC[3]!.message, parent_tool_use_id: null, timestamp: segmentC[3]!.timestamp },
]

const texts = (events: readonly AgentEvent[]): string[] => events.flatMap(event => {
  if (event.type === 'user.message') return [`${event.source === 'compaction' ? 'summary' : 'user'}:${event.text.slice(0, 14)}`]
  if (event.type === 'assistant.message') return event.blocks.flatMap(block => block.type === 'text' && block.text ? [`assistant:${block.text.slice(0, 14)}`] : [])
  if (event.type === 'tool.call') return [`tool:${event.name}`]
  return []
})

// ── the reader ─────────────────────────────────────────────────────────
{
  check('the transcript is found by scanning the project directories', locateClaudeTranscript(SESSION, configDir) === transcriptPath)
  check('an unknown id is not found; an unsafe id never resolves', locateClaudeTranscript('no-such-session', configDir) === undefined && locateClaudeTranscript('../projects', configDir) === undefined && locateClaudeTranscript('', configDir) === undefined)
  const read = readTranscriptEntries(transcriptPath)
  check('bad lines are skipped and counted, every good entry kept', read.badLines === 2 && read.entries.length === segmentA.length + segmentB.length + segmentC.length + 1, read.badLines)
  let refused = false
  try { readTranscriptEntries(transcriptPath, 100) } catch (error) { refused = error instanceof Error && error.message === t('claude-transcript-too-large', { mb: '0' }) }
  check('a file over the bound is refused, not truncated', refused)
}

// ── older slices ───────────────────────────────────────────────────────
{
  const replayed = replayClaudeTranscript(resumedChain, { cwd: '/fixture/project' })
  check('the resumed chain says it began at a compaction', replayed.compactedFrom === 'b2')
  const history = createClaudeTranscriptHistory({ sessionId: SESSION, cwd: '/fixture/project', configDir: () => configDir, compactedFrom: replayed.compactedFrom })
  check('older history may exist', history.hasOlder())
  const first = history.older()
  check('slice 1 = the segment between the compactions: its summary, the entry it preserved, its turns; not what compaction 2 preserved', JSON.stringify(texts(first)) === JSON.stringify(['summary:SUMMARY ONE: t', 'assistant:second answer ', 'user:third question', 'assistant:third answer', 'user:fourth questio']), texts(first))
  check('… the summary replays as the compaction rows', first.some(event => event.type === 'compaction.end') && first.some(event => event.type === 'user.message' && event.source === 'compaction'))
  check('… more remains', history.hasOlder())
  const second = history.older()
  check('slice 2 = the oldest segment, in order, minus what compaction 1 preserved (bad lines and attachments skipped)', JSON.stringify(texts(second)) === JSON.stringify(['user:first question', 'assistant:first answer', 'user:second questio', 'tool:Read']), texts(second))
  const results = second.filter((event): event is Extract<AgentEvent, { type: 'tool.result' }> => event.type === 'tool.result')
  check('… its tool result pairs with its call, with the structured result the file keeps (a Read card)', results.length === 1 && results[0]!.callId === 'toolu-a2' && results[0]!.presentation?.card === 'read', results[0]?.presentation)
  check('nothing older: an empty slice, and it stays empty (idempotent)', !history.hasOlder() && history.older().length === 0 && history.older().length === 0)
  const fresh = createClaudeTranscriptHistory({ sessionId: SESSION, cwd: '/fixture/project', configDir: () => configDir })
  check('a session that did not resume at a compaction has nothing older', !fresh.hasOlder() && fresh.older().length === 0)
  const record = fresh.record()
  check('the record replays every main entry of the file (the fold-restore source)', record !== undefined && ['msg-a1', 'msg-b4', 'msg-c6'].every(id => record.some(event => event.type === 'assistant.message' && event.anchor === id)) && record.some(event => event.type === 'tool.call' && event.callId === 'toolu-a2'))
  // Bounded: a long segment arrives in non-overlapping slices.
  const bounded = createClaudeTranscriptHistory({ sessionId: SESSION, cwd: '/fixture/project', configDir: () => configDir, compactedFrom: 'b2', sliceEntries: 2 })
  const pieces: string[][] = []
  for (let guard = 0; guard < 10 && bounded.hasOlder(); guard += 1) pieces.push(texts(bounded.older()))
  check('a bounded slice is cut at a prompt; slices never overlap and add up to the same history', pieces.every(piece => piece.length > 0 && piece.length <= 4) && JSON.stringify(pieces.flatMap(piece => piece).sort()) === JSON.stringify([...texts(first), ...texts(second)].sort()), pieces)
  check('the default slice bound is generous but finite', MAX_SLICE_ENTRIES === 1000)
  // Parsed once per file change (5a review 9): repeated presses reuse it.
  const cached = createClaudeTranscriptHistory({ sessionId: SESSION, cwd: '/fixture/project', configDir: () => configDir })
  const once = cached.record()
  check('the record is parsed and replayed once while the file is unchanged', cached.record() === once)
  appendFileSync(transcriptPath, `${JSON.stringify(reply('c-a7', 'c-a6', 'msg-c7', 'appended later'))}\n`)
  const changed = cached.record()
  check('… a change to the file is read again', changed !== once && changed.some(event => event.type === 'assistant.message' && event.anchor === 'msg-c7'))
  // A cyclic preserved segment cannot run the walk away (5a review 10).
  const byUuid = new Map<string, Rec>([['t1', { uuid: 't1', parentUuid: 't2' }], ['t2', { uuid: 't2', parentUuid: 't1' }]])
  const started = Date.now()
  const preserved = preservedUuids({ compactMetadata: { preservedSegment: { headUuid: 'never', tailUuid: 't1' } } }, byUuid as never)
  check('a cyclic preserved segment walk stops at once with nothing', preserved.length === 0 && Date.now() - started < 200, Date.now() - started)
}

// ── the channel ────────────────────────────────────────────────────────
async function openChannel(resume?: ReturnType<typeof replayClaudeTranscript>, sessionId = SESSION) {
  const fake = fakeClaudeSdk(() => ({ capabilities: ['msg_lifecycle_v1'] }), {
    getContextUsage: () => ({ totalTokens: 10, maxTokens: 200_000, categories: [], memoryFiles: [], mcpTools: [] }),
  })
  const session = await openClaudeSession(claudeDeps(fake.sdk, {
    sessionId,
    env: { PATH: '/usr/bin', CLAUDE_CONFIG_DIR: configDir },
    prefs: memoryClaudePrefs(),
    ...(resume === undefined ? {} : { resume }),
  }))
  const channel = createChannel(ctx, session, {
    model: 'Claude Agent', provider: 'claude', cwd: '/fixture/project', activity: false, backendLabel: 'Claude Agent',
    ...(resume === undefined ? {} : { initialHistory: resume.events }),
  })
  return { channel, query: fake.queries[0]!, session }
}
{
  const { channel, session } = await openChannel(replayClaudeTranscript(resumedChain, { cwd: '/fixture/project' }))
  try {
    const shown = (): string[] => channel.rows.filter(row => row.kind === 'user' || row.kind === 'assistant' || row.kind === 'compact' || row.kind === 'tool').map(row => `${row.kind}:${row.kind === 'tool' ? row.tool?.name : row.text.slice(0, 14)}`)
    const current = shown()
    check('resume paints the post-compaction chain', JSON.stringify(current) === JSON.stringify(['compact:SUMMARY TWO: f', 'assistant:fourth answer ', 'user:fifth question', 'assistant:fifth answer']), current)
    check('"load earlier" is offered with nothing folded (older history exists)', channel.olderHistory && !channel.rows.some(row => row.folded))
    const firstIds = channel.rows.map(row => row.id)
    const added = channel.loadOlder()
    const afterOne = shown()
    check('loadOlder prepends the segment between the compactions, ahead of what was shown', added > 0 && JSON.stringify(afterOne) === JSON.stringify(['compact:SUMMARY ONE: t', 'assistant:second answer ', 'user:third question', 'assistant:third answer', 'user:fourth questio', ...current]), afterOne)
    const prepended = channel.rows.slice(0, added)
    check('… as restored rows, ids below every row (never "new"), not animated', prepended.every(row => row.restored === true && row.id < Math.min(...firstIds) && row.fresh !== true) && new Set(channel.rows.map(row => row.id)).size === channel.rows.length)
    check('… the transcript rows already shown are untouched', JSON.stringify(channel.rows.slice(added).map(row => row.id)) === JSON.stringify(firstIds))
    const addedTwo = channel.loadOlder()
    check('the next loadOlder prepends the oldest segment (its tool card settled)', addedTwo > 0 && JSON.stringify(shown().slice(0, 4)) === JSON.stringify(['user:first question', 'assistant:first answer', 'user:second questio', 'tool:Read']) && channel.rows.find(row => row.kind === 'tool')?.tool?.status === 'ok', shown())
    check('then nothing older: 0, the divider\'s reason is gone, nothing duplicated', channel.loadOlder() === 0 && !channel.olderHistory && shown().filter(text => text === 'user:first question').length === 1)
  } finally {
    channel.releaseContributions()
    await session.dispose()
  }
}
// The view-only `/clear` (5a review 13): older history never comes back above
// a cleared view, and the divider is gone, as with DSH.
{
  const { channel, session } = await openChannel(replayClaudeTranscript(resumedChain, { cwd: '/fixture/project' }))
  try {
    check('before /clear: older history is offered', channel.olderHistory)
    channel.clear()
    check('after /clear: no "load earlier" divider', !channel.olderHistory)
    check('… and loadOlder prepends nothing above the cleared view', channel.loadOlder() === 0 && !channel.rows.some(row => row.restored === true), channel.rows.map(row => row.kind))
    const handed = await session.history()
    check('the replayed history is handed over once and then let go (5a review 11)', handed.length > 0 && (await session.history()).length === 0)
  } finally {
    channel.releaseContributions()
    await session.dispose()
  }
}

// ── folding is back on for Claude, bounded, restored from the file ──────
{
  const LIVE = '1e1e1e1e-0000-4000-8000-0000000011fe'
  const livePath = join(projectDir, `${LIVE}.jsonl`)
  writeFileSync(livePath, '')
  const { channel, query, session } = await openChannel(undefined, LIVE)
  const BIG = 'x'.repeat(4000)
  /** Retained transcript text (what folding bounds). */
  const retained = (): number => channel.rows.reduce((sum, row) => sum + row.text.length + (row.tool?.argsFull?.length ?? 0) + (row.tool?.resultFull?.length ?? 0), 0)
  let turn = 0
  const runTurns = async (count: number): Promise<void> => {
    for (let index = 0; index < count; index += 1) {
      turn += 1
      const uuid = `00000000-0000-4000-8000-${String(turn).padStart(12, '0')}`
      const text = `question ${turn}`
      await session.submit({ text, clientMessageId: uuid }, 'turn')
      const parent = turn === 1 ? null : `reply-${turn - 1}`
      appendFileSync(livePath, [
        JSON.stringify({ type: 'user', uuid, parentUuid: parent, message: { role: 'user', content: text }, timestamp: stamp() }),
        JSON.stringify({ type: 'assistant', uuid: `answer-${turn}`, parentUuid: uuid, message: { id: `msg-live-${turn}`, content: [{ type: 'text', text: `answer ${turn} ${BIG}` }] }, timestamp: stamp() }),
        JSON.stringify({ type: 'assistant', uuid: `call-${turn}`, parentUuid: `answer-${turn}`, message: { id: `msg-live-${turn}`, content: [{ type: 'tool_use', id: `toolu-live-${turn}`, name: 'Read', input: { file_path: `/fixture/project/f${turn}.txt` } }] }, timestamp: stamp() }),
        JSON.stringify({ type: 'user', uuid: `result-${turn}`, parentUuid: `call-${turn}`, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `toolu-live-${turn}`, content: `result ${turn} ${BIG}` }] }, timestamp: stamp() }),
        JSON.stringify({ type: 'assistant', uuid: `reply-${turn}`, parentUuid: `result-${turn}`, message: { id: `msg-live-${turn}b`, content: [{ type: 'text', text: 'ok' }] }, timestamp: stamp() }),
      ].join('\n') + '\n')
      query.emit({ type: 'command_lifecycle', command_uuid: uuid, state: 'started' })
      query.emit({ type: 'stream_event', event: { type: 'message_start', message: { id: `msg-live-${turn}`, model: 'claude-haiku-4-5', usage: { input_tokens: 10 } } } })
      query.emit({ type: 'assistant', message: { id: `msg-live-${turn}`, content: [{ type: 'text', text: `answer ${turn} ${BIG}` }] } })
      query.emit({ type: 'assistant', message: { id: `msg-live-${turn}`, content: [{ type: 'tool_use', id: `toolu-live-${turn}`, name: 'Read', input: { file_path: `/fixture/project/f${turn}.txt` } }] } })
      query.emit({ type: 'stream_event', event: { type: 'message_stop' } })
      query.emit({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `toolu-live-${turn}`, content: `result ${turn} ${BIG}` }] } })
      query.emit({ type: 'assistant', message: { id: `msg-live-${turn}b`, content: [{ type: 'text', text: 'ok' }] } })
      query.emit({ type: 'stream_event', event: { type: 'message_stop' } })
      query.emit({ type: 'result', subtype: 'success', is_error: false, result: 'ok', total_cost_usd: 0, modelUsage: {} })
      if (index % 50 === 49) await settled(() => channel.rows.filter(row => row.kind === 'user').length === turn, { timeoutMs: 20_000 })
    }
    await settled(() => channel.rows.filter(row => row.kind === 'user').length === turn && !channel.working, { timeoutMs: 20_000 })
    // A wake folds (the emitter folds on every publish).
    channel.emit()
  }
  try {
    check('a fresh session has no older history', !channel.olderHistory)
    await runTurns(250)
    const rowsAt250 = channel.rows.length
    const at250 = retained()
    check('past the window, rows fold (only anchored ones: user, assistant, tool)', rowsAt250 > MAX_ROWS && channel.rows.some(row => row.folded) && channel.rows.filter(row => row.folded).every(row => (row.kind === 'user' || row.kind === 'assistant' || row.kind === 'tool' || row.kind === 'reasoning') && (row.kind === 'tool' || row.anchor !== undefined)), rowsAt250)
    check('… a folded row keeps only its preview', channel.rows.filter(row => row.folded).every(row => row.text.length <= 201 && row.tool?.argsFull === undefined && row.tool?.resultFull === undefined))
    await runTurns(250)
    const at500 = retained()
    const grew = at500 - at250
    const fullGrowth = 250 * 2 * BIG.length
    check(`retained text stays bounded as the session grows (+${grew} chars for 250 turns; whole text would be +${fullGrowth})`, grew < fullGrowth / 10 && channel.rows.length > rowsAt250, { at250, at500 })
    const foldedBefore = channel.rows.filter(row => row.folded).length
    const restored = channel.loadOlder()
    const folded = channel.rows.filter(row => row.folded).length
    check('loadOlder restores folded rows from the transcript file first', restored > 0 && folded === foldedBefore - restored, { restored, foldedBefore, folded })
    const back = channel.rows.find(row => row.kind === 'assistant' && row.restored === true && row.text.startsWith('answer 1 '))
    const tool = channel.rows.find(row => row.kind === 'tool' && row.restored === true && row.tool?.callId === 'toolu-live-1')
    check('… with their full text, arguments and result again', back !== undefined && back.text.length > 4000 && tool?.tool?.argsFull?.includes('f1.txt') === true && (tool.tool.resultFull ?? '').length > 4000 && tool.tool.status === 'ok', { back: back?.text.length, tool: tool?.tool?.resultFull?.length })
    channel.emit()
    check('… restored rows are not folded again', channel.rows.filter(row => row.restored === true).every(row => row.folded !== true))
  } finally {
    channel.releaseContributions()
    await session.dispose()
  }
}

console.log(`\nverify-claude-load-older OK (${passed} checks)`)
process.exit(0)
