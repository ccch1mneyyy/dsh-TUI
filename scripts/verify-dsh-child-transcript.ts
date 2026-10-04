/**
 * DSH child transcript regression (design dsh-child-transcript): the second
 * `SubagentControl.history` implementation, read through the PUBLIC
 * sessionPersistence range API and folded by the SAME shared leaf pipeline
 * Claude uses — no backend-specific UI anywhere.
 *
 *  T. lane translation fixtures — user/assistant/tool/reasoning/image
 *     payloads, error results, unknown required/optional events (only the
 *     three leaf kinds survive; todo/job/goal side events are filtered);
 *  O. ownership — parent-owned roster gate, catalog miss = null (no open),
 *     wrong stored parent/id/version/seeded-cut fail closed;
 *  W. windows — newest page and older slices over the child's OWN events
 *     (`[inheritedEventCount, total)`), fork prefix never paged, eventCount
 *     from stat (with the freshness probe) and from bounded tail probes;
 *  B. budget — a 50k+ event log issues only bounded reads (probe reads are
 *     single-event and hard-capped; no unbounded whole-log read + slice);
 *  G. guards — binding-generation fence, cancellation, read/open failures =
 *     honest rejections, close exactly once, live-child flush barrier and its
 *     failure degradation, stale stat growth race;
 *  D. shared dedup/merge — durable ids/seq anchors/callIds, page prepend,
 *     history/live overlap through mergeLiveWindow;
 *  C. capability lighting — the real channel exposes `subagentControl.history`
 *     exactly when the composition serves sessionPersistence (the shared
 *     transcript tab renders on it), and serves a page end to end.
 *
 * Run: node --import tsx/esm scripts/verify-dsh-child-transcript.ts
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))
const home = mkdtempSync(join(tmpdir(), 'dsh-tui-child-transcript-'))
process.env.HOME = home
process.env.USERPROFILE = home
process.env.FORCE_COLOR = '3'

const [
  { setLang },
  { readChildTranscriptPage, CHILD_TRANSCRIPT_PAGE_EVENTS },
  { createDshTranslator },
  shared,
  { createChannel },
] = await Promise.all([
  import('../src/i18n.js'),
  import('../src/dsh-adapter/channel/subagent-transcript.js'),
  import('../src/dsh-adapter/backend/translate.js'),
  import('../src/components/messages/subagentTranscript.js'),
  import('../src/dsh-adapter/channel.js'),
])

setLang('en')
let passed = 0
const check = (label: string, ok: boolean, detail?: unknown): void => {
  assert.ok(ok, detail === undefined ? label : `${label}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`)
  passed += 1
  console.log(`PASS ${label}`)
}
const rejects = async (label: string, run: () => Promise<unknown>, includes?: string): Promise<unknown> => {
  try {
    await run()
  } catch (error) {
    check(label, includes === undefined || String((error as Error).message).includes(includes), (error as Error).message)
    return error
  }
  throw new Error(`expected a rejection: ${label}`)
}

// ── fixture vocabulary (the repo's dsh generator shapes) ───────────────────
type Ev = { type: string; seq: number; time: number; data: Record<string, unknown> }
const text = (value: string) => ({ type: 'text', text: value })
const reasoning = (value: string) => ({ type: 'reasoning', text: value })
class Log {
  readonly events: Ev[] = []
  private clock = 1000
  add(type: string, data: Record<string, unknown>): number {
    const seq = this.events.length
    this.events.push({ type, seq, time: this.clock, data })
    this.clock += 20
    return seq
  }
  user(id: string, body: string): number {
    return this.add('user/message', { id, role: 'user', content: [text(body)], source: { kind: 'user' } })
  }
  assistant(id: string, blocks: readonly unknown[]): number {
    return this.add('assistant/message', { turn: 1, step: 1, message: { id, role: 'assistant', content: blocks, source: { kind: 'model', provider: 'fixture', model: 'm' } }, stream: [] })
  }
  call(callId: string, name: string, args: unknown): number {
    return this.add('tool/call', { turn: 1, step: 1, callId, name, arguments: JSON.stringify(args) })
  }
  result(callId: string, content: readonly unknown[], isError = false): number {
    return this.add('tool/result', {
      turn: 1, step: 1,
      message: { id: `r-${callId}`, role: 'tool', content, source: { kind: 'tool', callId }, toolCallId: callId, ...(isError ? { isError: true } : {}) },
      ...(isError ? { error: { name: 'ToolError', code: 'tool/failed', reason: 'boom' } } : {}),
    })
  }
}

/** In-memory persistence shaped exactly as the public seam reads it; every
 *  read is recorded so the budget assertions observe the real call pattern. */
interface StoredSession {
  header: Record<string, unknown>
  events: readonly Ev[]
  inheritedEventCount: number
  /** Present = stat states an eventCount; absent = probe path (pinned host). */
  statEventCount?: number
  failOpen?: Error
  failRead?: Error
}
const createMemoryPersistence = () => {
  const sessions = new Map<string, StoredSession>()
  const reads: { id: string; offset: number; length: number }[] = []
  let openCount = 0
  let closeCount = 0
  const source = {
    async stat(id: string) {
      const stored = sessions.get(id)
      if (stored === undefined) return undefined
      return { header: stored.header, revision: 'r', ...(stored.statEventCount === undefined ? {} : { eventCount: stored.statEventCount }) }
    },
    async open(id: string) {
      openCount += 1
      const stored = sessions.get(id)
      if (stored === undefined || stored.failOpen !== undefined) throw stored?.failOpen ?? new Error(`session "${id}" not found`)
      let closed = false
      return {
        id,
        header: stored.header,
        inheritedEventCount: stored.inheritedEventCount,
        async read(offset = 0, length = Number.MAX_SAFE_INTEGER) {
          if (closed) throw new Error('handle closed')
          if (stored.failRead !== undefined) throw stored.failRead
          reads.push({ id, offset, length })
          return { eventState: 'shared', events: stored.events.slice(offset, offset + length) as never }
        },
        async close() {
          if (closed) throw new Error('double close')
          closed = true
          closeCount += 1
        },
      }
    },
  }
  return { sessions, reads, source, get openCount() { return openCount }, get closeCount() { return closeCount } }
}

type Capture = import('../src/dsh-adapter/channel/subagent-transcript.js').ChildTranscriptCapture
type Leaf = import('../src/components/messages/subagentTranscript.js').TranscriptLeaf
const PARENT = 'parent-session-1'
const CHILD = 'child-session-1'
const makeDeps = (over: Partial<Parameters<typeof readChildTranscriptPage>[0]> = {}) => {
  let generation = 1
  const session = { id: PARENT }
  const deps = {
    capture: (): Capture => ({ sessionId: PARENT, generation, session }),
    isCurrent: (c: Capture) => c.generation === generation && c.sessionId === PARENT && c.session === session,
    subagents: () => undefined,
    persistence: () => undefined,
    sessionsStore: () => undefined,
    lookupChild: () => undefined,
    createTranslator: () => createDshTranslator({ tools: () => undefined, scope: () => undefined, attachments: () => undefined }),
    ...over,
  }
  return { deps, flipGeneration: () => { generation += 1 } }
}
const rosterService = (ids: readonly string[]) => ({
  listChildren: async () => ids.map((id, i) => ({ id, createdAt: i, mode: i === 0 ? 'continuable' : 'one-shot' })),
})

// ── Section T: lane translation fixtures ───────────────────────────────────
{
  const log = new Log()
  log.user('um-1', 'scan the tree')
  log.assistant('am-1', [reasoning('thinking hard'), text('first part')])
  log.call('call-a', 'read_file', { path: 'a.txt' })
  log.result('call-a', [text('file body')])
  log.call('call-b', 'bash', { command: 'x' })
  log.result('call-b', [text('exit 1')], true)
  log.assistant('am-2', [text('done')])
  log.add('turn/start', { turn: 1 })
  log.add('todo/write', { items: [] })
  log.add('weird/plugin-event', { no: 'idea' })
  log.assistant('am-3', [{ type: 'image', mediaType: 'image/png', data: '' }, text('with an image')])

  const memory = createMemoryPersistence()
  memory.sessions.set(CHILD, { header: { version: 4, id: CHILD, createdAt: 1, isSeeded: false }, events: log.events, inheritedEventCount: 0 })
  const { deps } = makeDeps({ subagents: () => rosterService([CHILD]), persistence: () => memory.source })
  const page = await readChildTranscriptPage(deps, CHILD)
  assert.ok(page !== null)
  const lane = page.events
  check('T1 only leaf kinds survive (turn/todo/plugin events filtered)', lane.every(e => e.type === 'assistant.message' || e.type === 'tool.call' || e.type === 'tool.result') && lane.length === 7)
  check('T2 every lane event is on the child lane (parentCallId)', lane.every(e => (e as { parentCallId?: string }).parentCallId === CHILD))
  check('T3 durable message ids ride verbatim (no fabricated uuids)', JSON.stringify(page.uuids) === JSON.stringify(['um-1', 'am-1', 'am-2', 'am-3']))
  const message = lane[0] as { type: string; anchor: string; blocks: readonly { type: string }[] }
  check('T4 seq becomes the anchor', message.type === 'assistant.message' && message.anchor === '1' && message.blocks.length === 2 && message.blocks[0]!.type === 'reasoning')
  check('T5 parentAgentId is the verified parent fact', page.parentAgentId === PARENT)
  check('T6 tool call ids ride verbatim', (lane[1] as { callId: string }).callId === 'call-a' && (lane[3] as { callId: string }).callId === 'call-b')
  check('T7 an image block degrades safely (no attachments service)', (lane[5] as { blocks?: readonly unknown[] }).blocks !== undefined)

  // The SAME page folds through the shared leaf pipeline.
  const leaves: Leaf[] = []
  shared.foldTranscriptLeaves(page.events, leaves)
  const kinds = leaves.map(leaf => leaf.kind)
  check('T8 shared fold: thinking + text + settled tools',
    kinds.join(',') === 'thinking,text,tool,tool,text,text'
    && leaves[2]!.kind === 'tool' && leaves[2]!.tool.status === 'ok' && leaves[2]!.tool.resultText === 'file body',
    kinds.join(','))
  const errorPage: Leaf[] = []
  shared.foldTranscriptLeaves(page.events.slice(0, 5), errorPage) // through call-b's error result
  check('T9 an error result marks the tool error', errorPage.length === 4 && errorPage[3]!.kind === 'tool' && errorPage[3]!.tool.status === 'error' && errorPage[3]!.tool.errorText !== undefined)
  const uniqued = shared.uniqueRenderKeys(leaves)
  check('T10 unique render keys: collisions get ordinals, first occurrence keeps its key',
    new Set(uniqued.map(l => l.key)).size === uniqued.length && uniqued.length === leaves.length && uniqued[0]!.key === leaves[0]!.key,
    JSON.stringify({ raw: leaves.map(l => l.key), uniqued: uniqued.map(l => l.key) }))
}

// ── Section O: ownership and fail-closed validation ────────────────────────
{
  const log = new Log()
  log.user('um-1', 'hi')
  const memory = createMemoryPersistence()
  const store = (header: Record<string, unknown>, events: readonly Ev[], inheritedEventCount = 0) =>
    memory.sessions.set(CHILD, { header, events, inheritedEventCount })

  // catalog miss → null, and nothing is ever opened
  const miss = makeDeps({ subagents: () => rosterService(['other-child']), persistence: () => memory.source })
  check('O1 catalog miss answers null without opening', await readChildTranscriptPage(miss.deps, CHILD) === null && memory.openCount === 0)

  const wrong = makeDeps({ subagents: () => rosterService([CHILD]), persistence: () => memory.source })
  store({ version: 4, id: CHILD, createdAt: 1, isSeeded: false, parentSession: 'someone-else' }, log.events)
  await rejects('O2 stored parent lineage mismatch fails closed', () => readChildTranscriptPage(wrong.deps, CHILD), 'another parent')

  store({ version: 4, id: 'not-the-child', createdAt: 1, isSeeded: false }, log.events)
  await rejects('O3 stored id mismatch fails closed', () => readChildTranscriptPage(wrong.deps, CHILD), 'does not match')

  store({ version: 3, id: CHILD, createdAt: 1, isSeeded: false }, log.events)
  await rejects('O4 unknown format version fails closed', () => readChildTranscriptPage(wrong.deps, CHILD), 'not supported')

  store({ version: 4, id: CHILD, createdAt: 1, isSeeded: true }, log.events)
  delete (memory.sessions.get(CHILD) as { inheritedEventCount?: number }).inheritedEventCount
  await rejects('O5 seeded without its exact cut fails closed (zero never assumed)', () => readChildTranscriptPage(wrong.deps, CHILD), 'inherited cut')

  const noService = makeDeps({ persistence: () => memory.source })
  await rejects('O6 continuation service absent = unavailable', () => readChildTranscriptPage(noService.deps, CHILD), 'continuation service')

  const oneShot = new Log()
  oneShot.user('um-9', 'one shot')
  oneShot.assistant('am-9', [text('done')])
  store({ version: 4, id: CHILD, createdAt: 1, isSeeded: false }, oneShot.events)
  const shot = makeDeps({ subagents: () => rosterService(['unrelated', CHILD]), persistence: () => memory.source })
  const shotPage = await readChildTranscriptPage(shot.deps, CHILD)
  check('O7 one-shot catalog rows read too (mode is not a history gate)', shotPage !== null && shotPage.uuids.join(',') === 'um-9,am-9')

  const noPersistence = makeDeps({ subagents: () => rosterService([CHILD]) })
  await rejects('O8 persistence absent at call time = unavailable', () => readChildTranscriptPage(noPersistence.deps, CHILD), 'persistence')

  check('O9 every failed path still closed its handle exactly once', memory.closeCount === memory.openCount && memory.openCount === 5, `open=${memory.openCount} close=${memory.closeCount}`)
}

// ── Section W: windows, cursors and the inherited cut ──────────────────────
{
  // A seeded child: 4 fork-inherited parent events, then its own work.
  const child = new Log()
  child.user('p-1', 'parent question')
  child.assistant('p-2', [text('parent answer')])
  child.add('turn/start', { turn: 0 })
  child.user('p-3', 'parent dead end')
  const cut = child.events.length
  child.add('session/end-seed', { inherited: true })
  child.user('c-1', 'child prompt')
  child.assistant('c-2', [text('child answer')])
  for (let i = 0; i < 896; i += 1) child.assistant(`fill-${i}`, [text(`filler ${i}`)])
  child.user('c-last', 'child last')
  const own = child.events.length - cut

  const memory = createMemoryPersistence()
  memory.sessions.set(CHILD, { header: { version: 4, id: CHILD, createdAt: 1, isSeeded: true, parentSession: PARENT }, events: child.events, inheritedEventCount: cut })
  const { deps } = makeDeps({ subagents: () => rosterService([CHILD]), persistence: () => memory.source })
  const newest = await readChildTranscriptPage(deps, CHILD)
  assert.ok(newest !== null)
  check('W1 newest page spans exactly the last 400 own events',
    newest.skippedFromStart === own - CHILD_TRANSCRIPT_PAGE_EVENTS && newest.hasOlder === true,
    `skipped=${newest.skippedFromStart} own=${own}`)
  const firstSeq = Number((newest.events[0] as unknown as { seq: number }).seq)
  check('W2 the fork-inherited parent prefix is never paged', firstSeq === cut + own - CHILD_TRANSCRIPT_PAGE_EVENTS && !newest.uuids.includes('p-1') && !newest.uuids.includes('p-2'))
  const older = await readChildTranscriptPage(deps, CHILD, { count: 400, skipFromStart: newest.skippedFromStart })
  assert.ok(older !== null)
  check('W3 older window addresses [skip-count, skip) exactly',
    older.skippedFromStart === newest.skippedFromStart - 400
    && Number((older.events[0] as unknown as { seq: number }).seq) === cut + older.skippedFromStart
    && older.hasOlder === true)
  const oldest = await readChildTranscriptPage(deps, CHILD, { count: 400, skipFromStart: older.skippedFromStart })
  assert.ok(oldest !== null)
  check('W4 the last older window bottoms out at the cut',
    oldest.skippedFromStart === 0 && oldest.hasOlder === false && oldest.uuids[0] === 'c-1',
    JSON.stringify({ skipped: oldest.skippedFromStart, hasOlder: oldest.hasOlder, firstUuid: oldest.uuids[0] }))
  const oversized = await readChildTranscriptPage(deps, CHILD, { count: 10_000, skipFromStart: 5 })
  assert.ok(oversized !== null)
  check('W5 a count larger than skip clamps to the cut',
    oversized.skippedFromStart === 0 && oversized.uuids.join(',') === 'c-1,c-2,fill-0,fill-1',
    JSON.stringify({ skipped: oversized.skippedFromStart, uuids: oversized.uuids }))

  // stat path: a fresh eventCount skips the tail probes entirely.
  const statMemory = createMemoryPersistence()
  statMemory.sessions.set(CHILD, { header: { version: 4, id: CHILD, createdAt: 1, isSeeded: false, parentSession: PARENT }, events: child.events.slice(cut), inheritedEventCount: 0, statEventCount: own })
  const statDeps = makeDeps({ subagents: () => rosterService([CHILD]), persistence: () => statMemory.source })
  const statPage = await readChildTranscriptPage(statDeps.deps, CHILD)
  assert.ok(statPage !== null)
  const statReads = statMemory.reads
  check('W6 a fresh stat eventCount skips the tail probes entirely', statReads.length === 2 && statReads[0]!.length === 1 && statReads[1]!.length === CHILD_TRANSCRIPT_PAGE_EVENTS, JSON.stringify(statReads))
  check('W7 the stat page agrees with the probe page', statPage.skippedFromStart === newest.skippedFromStart && JSON.stringify(statPage.uuids) === JSON.stringify(newest.uuids))

  // A stale stat (the log grew since): the one-event freshness probe at the
  // stated count finds an event and the bounded tail probe recovers the end.
  const grown = [...child.events.slice(cut)]
  grown.push({ type: 'user/message', seq: grown.length, time: 9999, data: { id: 'grown-1', role: 'user', content: [text('grown after stat')], source: { kind: 'user' } } })
  const grownMemory = createMemoryPersistence()
  grownMemory.sessions.set(CHILD, { header: { version: 4, id: CHILD, createdAt: 1, isSeeded: false, parentSession: PARENT }, events: grown, inheritedEventCount: 0, statEventCount: own })
  const grownDeps = makeDeps({ subagents: () => rosterService([CHILD]), persistence: () => grownMemory.source })
  const grownPage = await readChildTranscriptPage(grownDeps.deps, CHILD)
  assert.ok(grownPage !== null)
  check('W8 a stale stat falls into the bounded probe and still finds the newest page', grownPage.uuids.at(-1) === 'grown-1', JSON.stringify(grownPage.uuids.slice(-2)))

  // An empty child (cut === total): an honest empty page, not an error.
  const emptyMemory = createMemoryPersistence()
  emptyMemory.sessions.set(CHILD, { header: { version: 4, id: CHILD, createdAt: 1, isSeeded: true, parentSession: PARENT }, events: child.events.slice(0, cut), inheritedEventCount: cut })
  const emptyDeps = makeDeps({ subagents: () => rosterService([CHILD]), persistence: () => emptyMemory.source })
  const emptyPage = await readChildTranscriptPage(emptyDeps.deps, CHILD)
  check('W9 a child with no own events pages empty (never fabricated)', emptyPage !== null && emptyPage.events.length === 0 && emptyPage.hasOlder === false && emptyPage.skippedFromStart === 0)
}

// ── Section B: read budget on a 50k+ log ───────────────────────────────────
{
  const big = new Log()
  for (let i = 0; i < 50_123; i += 1) {
    big.user(`u-${i}`, `message ${i}`)
    if (i % 7 === 0) big.assistant(`a-${i}`, [text(`answer ${i}`)])
  }
  const memory = createMemoryPersistence()
  memory.sessions.set(CHILD, { header: { version: 4, id: CHILD, createdAt: 1, isSeeded: false }, events: big.events, inheritedEventCount: 0 })
  const { deps } = makeDeps({ subagents: () => rosterService([CHILD]), persistence: () => memory.source })
  const page = await readChildTranscriptPage(deps, CHILD)
  assert.ok(page !== null)
  const probeReads = memory.reads.filter(read => read.length === 1)
  const pageReads = memory.reads.filter(read => read.length > 1)
  check('B1 the 50k+ log never sees an unbounded read', memory.reads.every(read => Number.isSafeInteger(read.length) && read.length <= CHILD_TRANSCRIPT_PAGE_EVENTS), JSON.stringify(memory.reads.map(r => r.length).filter(l => l > CHILD_TRANSCRIPT_PAGE_EVENTS)))
  check('B2 probe reads are single-event and hard-capped', probeReads.length > 0 && probeReads.length <= 48, `probes=${probeReads.length}`)
  check('B3 exactly one page read', pageReads.length === 1 && pageReads[0]!.length === CHILD_TRANSCRIPT_PAGE_EVENTS)
  const scanned = memory.reads.reduce((sum, read) => sum + Math.min(read.length, CHILD_TRANSCRIPT_PAGE_EVENTS), 0)
  check('B4 total scanned events stay within page + probes', scanned <= CHILD_TRANSCRIPT_PAGE_EVENTS + 48, `scanned=${scanned}`)
  check('B5 the probe path found the true end (last own event in page)',
    page.skippedFromStart === big.events.length - CHILD_TRANSCRIPT_PAGE_EVENTS
    && page.uuids.at(-1) === 'u-50122'
    && page.hasOlder === true,
    `skipped=${page.skippedFromStart} last=${page.uuids.at(-1)}`)
}

// ── Section G: fences, failures, flush ─────────────────────────────────────
{
  const log = new Log()
  log.user('um-1', 'hello')
  log.assistant('am-1', [text('answer')])
  const memory = createMemoryPersistence()
  memory.sessions.set(CHILD, { header: { version: 4, id: CHILD, createdAt: 1, isSeeded: false }, events: log.events, inheritedEventCount: 0, statEventCount: log.events.length })

  // generation fence mid-read: the roster resolving flips the binding away
  const fenced = makeDeps({ persistence: () => memory.source })
  fenced.deps.subagents = () => ({
    listChildren: async () => {
      fenced.flipGeneration()
      return [{ id: CHILD, createdAt: 1, mode: 'continuable' }]
    },
  })
  await rejects('G1 a binding generation switch mid-read discards the page', () => readChildTranscriptPage(fenced.deps, CHILD), 'binding changed')

  // owner signal aborted up front
  const controller = new AbortController()
  controller.abort()
  const aborted = makeDeps({ subagents: () => rosterService([CHILD]), persistence: () => memory.source, ownerSignal: controller.signal })
  await rejects('G2 an aborted owner cancels before opening', () => readChildTranscriptPage(aborted.deps, CHILD))

  // open failure (child never materialized)
  const missing = createMemoryPersistence()
  const missingDeps = makeDeps({ subagents: () => rosterService([CHILD]), persistence: () => missing.source })
  await rejects('G3 an unmaterialized child rejects (unavailable, not empty)', () => readChildTranscriptPage(missingDeps.deps, CHILD))

  // read failure mid-page: still closes exactly once
  const broken = createMemoryPersistence()
  broken.sessions.set(CHILD, { header: { version: 4, id: CHILD, createdAt: 1, isSeeded: false }, events: log.events, inheritedEventCount: 0, statEventCount: log.events.length, failRead: new Error('torn tail') })
  const brokenDeps = makeDeps({ subagents: () => rosterService([CHILD]), persistence: () => broken.source })
  await rejects('G4 a torn read rejects honestly', () => readChildTranscriptPage(brokenDeps.deps, CHILD), 'torn tail')
  check('G5 the failing read still closed its handle once', broken.closeCount === 1 && broken.openCount === 1)

  // stored log shorter than the recorded cut = corruption
  const shortLog = new Log()
  shortLog.user('only-1', 'short')
  const shortMemory = createMemoryPersistence()
  shortMemory.sessions.set(CHILD, { header: { version: 4, id: CHILD, createdAt: 1, isSeeded: true, parentSession: PARENT }, events: shortLog.events, inheritedEventCount: 5 })
  const shortDeps = makeDeps({ subagents: () => rosterService([CHILD]), persistence: () => shortMemory.source })
  await rejects('G6 a log shorter than its inherited cut is corruption', () => readChildTranscriptPage(shortDeps.deps, CHILD), 'shorter than its inherited cut')

  // flush barrier: a live child flushes its exact session before the read
  const flushed: object[] = []
  const liveSession = { id: CHILD }
  const flushedMemory = createMemoryPersistence()
  flushedMemory.sessions.set(CHILD, { header: { version: 4, id: CHILD, createdAt: 1, isSeeded: false }, events: log.events, inheritedEventCount: 0, statEventCount: log.events.length })
  const flushDeps = makeDeps({
    subagents: () => rosterService([CHILD]),
    persistence: () => flushedMemory.source,
    sessionsStore: () => ({ flush: async (session: object) => { flushed.push(session); return true } }),
    lookupChild: (id: string) => id === CHILD ? { session: liveSession } : undefined,
  })
  const flushedPage = await readChildTranscriptPage(flushDeps.deps, CHILD)
  check('G7 a live child flushes its exact session before the read', flushed.length === 1 && flushed[0] === liveSession && flushedPage !== null)
  check('G8 the flush precedes the open', flushedMemory.openCount === 1)

  // flush failure degrades to the persisted prefix (the read still succeeds)
  const flushFailDeps = makeDeps({
    subagents: () => rosterService([CHILD]),
    persistence: () => flushedMemory.source,
    sessionsStore: () => ({ flush: async () => { throw new Error('disk full') } }),
    lookupChild: (id: string) => id === CHILD ? { session: liveSession } : undefined,
  })
  const degraded = await readChildTranscriptPage(flushFailDeps.deps, CHILD)
  check('G9 a failed flush keeps the provable persisted prefix', degraded !== null && degraded.uuids.join(',') === 'um-1,am-1')

  // an ended child (not in the registry) never flushes
  const endedFlushes: object[] = []
  const endedDeps = makeDeps({
    subagents: () => rosterService([CHILD]),
    persistence: () => flushedMemory.source,
    sessionsStore: () => ({ flush: async (session: object) => { endedFlushes.push(session); return true } }),
    lookupChild: () => undefined,
  })
  await readChildTranscriptPage(endedDeps.deps, CHILD)
  check('G10 an ended child skips the flush barrier', endedFlushes.length === 0)

  check('G11 success paths also closed exactly once', flushedMemory.closeCount === flushedMemory.openCount && flushedMemory.openCount === 3, `open=${flushedMemory.openCount} close=${flushedMemory.closeCount}`)
}

// ── Section D: shared dedup / page prepend / live merge ────────────────────
{
  // Two pages of one long child history; the shared helpers must join them
  // without duplicate rows and settle live overlap by callId.
  const child = new Log()
  for (let i = 0; i < 900; i += 1) {
    child.assistant(`m-${i}`, [text(`part ${i}`)])
    if (i === 300) { child.call('call-x', 'bash', { command: 'ls' }); child.result('call-x', [text('file-a')]) }
    if (i === 880) child.call('call-live', 'bash', { command: 'watch' })
  }
  const memory = createMemoryPersistence()
  memory.sessions.set(CHILD, { header: { version: 4, id: CHILD, createdAt: 1, isSeeded: false }, events: child.events, inheritedEventCount: 0, statEventCount: child.events.length })
  const { deps } = makeDeps({ subagents: () => rosterService([CHILD]), persistence: () => memory.source })
  const newest = await readChildTranscriptPage(deps, CHILD)
  assert.ok(newest !== null)
  const older = await readChildTranscriptPage(deps, CHILD, { count: 400, skipFromStart: newest.skippedFromStart })
  assert.ok(older !== null)

  const newestLeavesRaw: Leaf[] = []
  shared.foldTranscriptLeaves(newest.events, newestLeavesRaw)
  const newestLeaves = shared.uniqueRenderKeys(newestLeavesRaw)
  const olderLeaves: Leaf[] = []
  shared.foldTranscriptLeaves(older.events, olderLeaves)
  const joined = shared.prependOlderLeaves(olderLeaves, newestLeaves)
  const keys = joined.map(leaf => leaf.key)
  check('D1 pages join without duplicate render keys', new Set(keys).size === keys.length)
  const xIndex = joined.findIndex(leaf => leaf.kind === 'tool' && leaf.tool.callId === 'call-x')
  const liveIndex = joined.findIndex(leaf => leaf.kind === 'tool' && leaf.tool.callId === 'call-live')
  check('D2 the older page\'s tool stays before the newest page\'s (no hoisting)', xIndex >= 0 && liveIndex >= 0 && xIndex < liveIndex)
  check('D3 the settled tool carries its history result (older page self-contained)', joined[xIndex]!.kind === 'tool' && joined[xIndex]!.tool.status === 'ok' && joined[xIndex]!.tool.resultText === 'file-a')

  // history/live overlap: the live window's settled tool pairs by callId, its
  // text lines the history already paints are suppressed, a live-only call
  // appends — exactly the Claude contract.
  const state = {
    agentId: CHILD, description: 'scan', status: 'running' as const, startedAt: 1,
    output: [], outputEvents: [{ kind: 'text' as const, text: 'part 899', at: 1, settled: true }],
    toolCalls: [
      { id: 'call-x', name: 'bash', status: 'ok' as const, startedAt: 1, endedAt: 2, resultPreview: 'file-a' },
      { id: 'call-z', name: 'bash', status: 'running' as const, startedAt: 3, argsPreview: 'tail' },
    ],
  } as never
  const merged = shared.mergeLiveWindow(joined, state, true)
  const toolRows = merged.filter(row => row.kind === 'tool') as Extract<Leaf, { kind: 'tool' }>[]
  const liveRows = merged.filter(row => row.kind === 'live')
  check('D4 live tool status pairs by callId (no duplicate call-x row)', toolRows.filter(row => row.tool.callId === 'call-x').length === 1)
  check('D5 a live-only tool appends after history', toolRows.at(-1)!.tool.callId === 'call-z')
  check('D6 a text line the history already paints is not doubled', liveRows.length === 0, JSON.stringify(liveRows.map(r => (r as { line?: { text: string } }).line?.text)))

  // Repeat loads of the same window fold byte-identically (idempotent reloads).
  const again = await readChildTranscriptPage(deps, CHILD)
  assert.ok(again !== null)
  check('D7 a repeated load is idempotent', JSON.stringify(again.events) === JSON.stringify(newest.events))
}
{
  // A call that closes one page and its result that opens the next: the
  // newest page still carries the result body (and an error's text) for the
  // card the older page paints.
  const child = new Log()
  for (let i = 0; i < 398; i += 1) child.assistant(`m-${i}`, [text(`part ${i}`)])
  child.call('call-split-error', 'bash', { command: 'false' })
  child.call('call-split', 'bash', { command: 'ls' })
  child.result('call-split', [text('SPLIT RESULT BODY')])
  for (let i = 0; i < 398; i += 1) child.assistant(`n-${i}`, [text(`more ${i}`)])
  child.result('call-split-error', [text('exit 1')], true)
  const memory = createMemoryPersistence()
  memory.sessions.set(CHILD, { header: { version: 4, id: CHILD, createdAt: 1, isSeeded: false }, events: child.events, inheritedEventCount: 0, statEventCount: child.events.length })
  const { deps } = makeDeps({ subagents: () => rosterService([CHILD]), persistence: () => memory.source })
  const newest = await readChildTranscriptPage(deps, CHILD)
  assert.ok(newest !== null)
  const results = newest.events.filter((event): event is Extract<typeof event, { type: 'tool.result' }> => event.type === 'tool.result')
  const split = results.find(event => event.callId === 'call-split')
  const failed = results.find(event => event.callId === 'call-split-error')
  check('D8 a result whose call is on the older page keeps its body',
    newest.events.every(event => event.type !== 'tool.call') && split?.text === 'SPLIT RESULT BODY' && split.parentCallId === CHILD,
    JSON.stringify(split))
  check('D9 an error result whose call is on the older page keeps its error text',
    failed?.isError === true && (failed.errorText ?? '').includes('tool/failed'),
    JSON.stringify(failed))
}

// ── Section C: capability lighting through the real channel ────────────────
{
  const log = new Log()
  log.user('um-1', 'channel prompt')
  log.assistant('am-1', [text('channel answer')])
  const childSession = { id: CHILD }
  const makeChannel = (services: Record<string, unknown>) => {
    const agent = {
      id: 'agent-parent', status: 'idle',
      session: {
        id: PARENT, seq: 3,
        header: { version: 4, id: PARENT, createdAt: 1, isSeeded: false },
        inheritedEventCount: 0,
        snapshotEvents: () => [],
        requestHeader: () => undefined,
        append: () => undefined,
      },
      ctx: { on: () => () => {} },
      followup: () => undefined,
      steer: () => undefined,
      inbox: { remove: () => true },
    }
    return createChannel({ on: () => () => {}, get: (name: string) => services[name], logger: { warn: () => undefined } } as never, agent as never, { model: 'model', cwd: home, provider: 'provider', activity: false })
  }
  const memory = createMemoryPersistence()
  memory.sessions.set(CHILD, { header: { version: 4, id: CHILD, createdAt: 1, isSeeded: false, parentSession: PARENT }, events: log.events, inheritedEventCount: 0, statEventCount: log.events.length })
  const flushed: object[] = []
  const withSource = makeChannel({
    sessionPersistence: memory.source,
    subagents: rosterService([CHILD]),
    sessions: { flush: async (session: object) => { flushed.push(session); return true } },
    agents: { get: (id: string) => id === CHILD ? { status: 'idle', session: childSession } : undefined },
  })
  const history = withSource.subagentControl?.history
  check('C1 the channel exposes subagentControl.history when persistence serves the composition', typeof history === 'function')
  const page = await history?.(CHILD)
  assert.ok(page !== null && page !== undefined)
  check('C2 the channel-served page carries the shared contract', page.parentAgentId === PARENT && page.uuids.join(',') === 'um-1,am-1' && page.hasOlder === false)
  check('C3 the live child flushed through the real wiring', flushed.length === 1 && flushed[0] === childSession)

  const withoutPersistence = makeChannel({ subagents: rosterService([CHILD]) })
  check('C4 without sessionPersistence the capability is absent (no tab)', withoutPersistence.subagentControl?.history === undefined)
}

// ── Section S: source hygiene — the banned paths stay banned ───────────────
{
  const source = readFileSync(join(here, '..', 'src', 'dsh-adapter', 'channel', 'subagent-transcript.ts'), 'utf8')
  check('S1 the reader never touches the deprecated snapshot API', !source.includes('snapshotEvents'))
  check('S2 the reader never imports a raw session-log reader', !source.includes('sessionLog') && !source.includes('readSessionEvents'))
}

console.log(`\nALL PASS (${passed})`)
