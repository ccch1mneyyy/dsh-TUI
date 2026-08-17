/**
 * Regression checks for channel.buildSessionTree's event-budget accounting
 * (needs a real channel over a fake backend, so it lives apart from the pure
 * model checks in tree-check.ts): an over-budget LIVE session must charge
 * the budget for its KEPT tail (sessionTree.liveTailWindow), not the full
 * in-memory log — charging the whole log used to consume the entire
 * MAX_TREE_EVENTS budget behind a discarded prefix, blacking out every
 * other family member (their branches silently vanished from the tree).
 * Run: node --import tsx/esm scripts/channel-tree-check.ts
 */
import { Context } from '@deepseek-ai/cordis'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { createChannel } from '../src/dsh-adapter/channel.js'
import { flattenTree } from '../src/dsh-adapter/sessionTree.js'

let failed = 0
const check = (name: string, ok: boolean, extra?: unknown) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}`, ok ? '' : (extra ?? ''))
  if (!ok) failed += 1
}

// ── Fixtures: an oversized live session forked from a tiny ancestor ──────
const ev = (type: string, seq: number, data: unknown) =>
  ({ type, seq, time: seq + 1, data }) as unknown as SessionEvent
const turnStart = (seq: number, turn: number) => ev('turn/start', seq, { turn })
const userMsg = (seq: number, text: string) =>
  ev('user/message', seq, { source: { kind: 'user' }, content: [{ type: 'text', text }] })
const assistantMsg = (seq: number, turn: number, step: number, text: string) =>
  ev('assistant/message', seq, { turn, step, message: { role: 'assistant', content: [{ type: 'text', text }] } })
const chunk = (seq: number, turn: number, step: number, text: string) =>
  ev('assistant/chunk', seq, { turn, step, chunk: { type: 'text-delta', text } })
const toolCall = (seq: number, turn: number, step: number, callId: string, name: string, args: string) =>
  ev('tool/call', seq, { turn, step, callId, name, arguments: args })
const toolOk = (seq: number, turn: number, step: number, callId: string) =>
  ev('tool/result', seq, { turn, step, message: { role: 'tool', source: { callId }, content: [{ type: 'text', text: 'ok' }] } })
const turnEnd = (seq: number, turn: number, reason: object) => ev('turn/end', seq, { turn, reason })
const stepStart = (seq: number, turn: number, step: number) => ev('step/start', seq, { turn, step })
const stepEnd = (seq: number, turn: number, step: number) => ev('step/end', seq, { turn, step })

// The ancestor's whole log: one small turn (seqs 0..3), inherited by the
// live session as its seed prefix.
const ancestorEvents: SessionEvent[] = [
  turnStart(0, 0),
  userMsg(1, 'ancestor question'),
  assistantMsg(2, 0, 0, 'ancestor answer'),
  turnEnd(3, 0, { kind: 'completed' }),
]
// Live log: the 4-event seed prefix, then one HUGE turn (its chunk storm
// alone fills the event budget), then a small recent turn. Total 200_010 —
// ten over the 200_000 budget, so the tail window keeps only the last turn.
const liveEvents: SessionEvent[] = [...ancestorEvents]
{
  let seq = 4
  liveEvents.push(turnStart(seq, 1), userMsg(seq + 1, 'huge turn prompt'))
  seq += 2
  for (let i = 0; i < 199_999; i++) liveEvents.push(chunk(seq + i, 1, 0, 'x'))
  seq += 199_999
  liveEvents.push(turnEnd(seq, 1, { kind: 'completed' }))
  seq += 1
  liveEvents.push(
    turnStart(seq, 2),
    userMsg(seq + 1, 'latest question'),
    assistantMsg(seq + 2, 2, 0, 'latest answer'),
    turnEnd(seq + 3, 2, { kind: 'completed' }),
  )
}
check('live log exceeds the budget', liveEvents.length === 200_010, liveEvents.length)

// Backend with NO locate(): the stock-root scan misses (empty temp root is
// the default for this process), so the ancestor's events arrive through
// inspect — what matters is that it is ASKED at all (it was not, when the
// live session's full length consumed the budget ahead of it).
let inspected: string[] = []
const backend = {
  async list() {
    return [{ id: 's-anc', cwd: '/tmp', createdAt: 1 }]
  },
  async inspect(id: string) {
    inspected.push(String(id))
    return { events: ancestorEvents }
  },
}

const root = new Context()
root.provide('sessionPersistence' as never, backend as never)
const agent = {
  id: 's-live',
  status: 'idle',
  ctx: root.extend(),
  session: {
    id: 's-live',
    seq: liveEvents.length,
    events: liveEvents,
    header: { id: 's-live', cwd: '/tmp', createdAt: 2, parentSession: 's-anc', seedLength: 4 },
  },
  followup() {},
  steer() {},
  inbox: { remove() {} },
} as never

const channel = createChannel(root as never, agent, {
  model: 'm',
  cwd: '/tmp',
  provider: 'p',
  activity: false,
})
const data = await channel.buildSessionTree()
check('tree builds', data !== null)
check('family holds both sessions', data?.sessionCount === 2, data?.sessionCount)
const flat = data === null ? [] : flattenTree(data.roots, data.activeLeafId)
const ids = new Set(flat.map(f => f.node.id))
check('ancestor branch survived the budget', ids.has('s-anc:1'),
  [...ids].filter(id => id.startsWith('s-anc')))
check('ancestor was read (inspect reached)', inspected.includes('s-anc'), inspected)
check('live tail kept (latest turn visible)', ids.has(`s-live:${200_010 - 3}`),
  [...ids].filter(id => id.startsWith('s-live')))
check('live tip is the active leaf', data?.activeLeafId === `s-live:${200_010 - 2}`, data?.activeLeafId)
check('sliced live log marks truncation', data?.truncated === true)

// ── A session swap mid-build discards the result ──────────────────────────
// buildSessionTree awaits list()/inspect with the live agent readable
// throughout; /new, /resume and /model are fire-and-forget, so the agent can
// be swapped mid-build. The build pins the entry-time session and must DROP
// the result when the live session moved on — returning it would stitch the
// new session's events under the old session's id, and a confirm would then
// rewind from the wrong persisted log.
{
  let releaseList: ((headers: unknown[]) => void) | null = null
  const deferredBackend = {
    list: () => new Promise<unknown[]>(resolve => { releaseList = resolve }),
    async inspect() { return { events: ancestorEvents } },
  }
  const root2 = new Context()
  root2.provide('sessionPersistence' as never, deferredBackend as never)
  const smallTurn = [
    turnStart(0, 0), userMsg(1, 'old session question'), assistantMsg(2, 0, 0, 'old answer'), turnEnd(3, 0, { kind: 'completed' }),
  ]
  const swappableAgent = {
    id: 's-old',
    status: 'idle',
    ctx: root2.extend(),
    session: {
      id: 's-old',
      seq: smallTurn.length,
      events: smallTurn,
      header: { id: 's-old', cwd: '/tmp', createdAt: 1 },
    },
    followup() {},
    steer() {},
    inbox: { remove() {} },
  }
  const channel2 = createChannel(root2 as never, swappableAgent as never, {
    model: 'm',
    cwd: '/tmp',
    provider: 'p',
    activity: false,
  })
  const building = channel2.buildSessionTree()
  // The switch lands while list() is still in flight.
  swappableAgent.session = {
    id: 's-new',
    seq: 0,
    events: [],
    header: { id: 's-new', cwd: '/tmp', createdAt: 2 },
  } as never
  releaseList!([{ id: 's-old', cwd: '/tmp', createdAt: 1 }])
  const staleResult = await building
  check('stale build is discarded', staleResult === null, staleResult?.sessionCount)
}

// ── The tree-level scan budget caps the TOTAL cost across logs ────────────
// A per-log scan allowance alone left the panel-open cost unbounded: every
// log gets its own 4×-of-remaining allowance, and ignorable envelopes
// (repair-marked activity frames) are paid for — I/O, decompress, parse —
// without ever being collected, so N flood logs each returned ~0 events
// while each burning its full allowance (~23 × 800k ≈ 18.5M envelope scans).
// The build now draws every read down from ONE global scan budget; two
// floods below exhaust it, and the sibling read after them degrades to an
// UNLOADED placeholder (the branch structure survives a spent budget —
// sessions never vanish), while the sibling read before them keeps its
// entries.
{
  // sessionsRoots() resolves DSH_TUI_SESSION_ROOT at call time, so pointing it
  // at a scratch root here still isolates every lookup of this section.
  const floodRoot = mkdtempSync(join(tmpdir(), 'dsh-channel-tree-'))
  process.env.DSH_TUI_SESSION_ROOT = floodRoot
  const HEADER = { session: { id: 'x', cwd: '/tmp' } }
  const writePlainLog = (sessionId: string, lines: readonly unknown[]): void => {
    const dir = join(floodRoot, 'ws-a', sessionId)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'session.jsonl'), lines.map(line => JSON.stringify(line)).join('\n') + '\n')
  }
  const mkTurns = (startSeq: number, count: number, tag: string): SessionEvent[] => {
    const out: SessionEvent[] = []
    for (let t = 0; t < count; t++) {
      const seq = startSeq + t * 4
      out.push(
        turnStart(seq, t),
        userMsg(seq + 1, `${tag} q${t}`),
        assistantMsg(seq + 2, t, 0, `${tag} a${t}`),
        turnEnd(seq + 3, t, { kind: 'completed' }),
      )
    }
    return out
  }
  // Ignorable envelopes with a numeric seq: the repair-marked activity-frame
  // shape — skipped after their scan cost is paid.
  const flood = (count: number): unknown[] =>
    Array.from({ length: count }, (_, i) => ({ type: 'activity/status', seq: i, ignorable: true }))

  // One family: s-root → {s-live (live), s-before, s-noisy1, s-noisy2,
  // s-after}. Processing is topological (parents first), chain-priority then
  // createdAt-desc among siblings, so the reads run: s-root, s-live
  // (memory), s-before, s-noisy1, s-noisy2, s-after.
  const rootEvents = mkTurns(0, 12, 'root') // 48 events
  writePlainLog('s-root', [HEADER, ...rootEvents])
  writePlainLog('s-before', [HEADER, ...mkTurns(0, 75, 'before')]) // 300 events
  // The global budget left when s-noisy1 is reached is 804096-49-301 = 803746;
  // its per-log allowance is min(4×remaining+4096, 803746) — the exact split
  // moves with the live session's charged events, so the flood must outlast
  // ANY allowance: header + 804_200 flood envelopes exceeds even the full
  // global budget, keeping the real events behind it unreached either way.
  writePlainLog('s-noisy1', [HEADER, ...flood(804_200), ...mkTurns(0, 50, 'noisy1')])
  // s-noisy1 stops at its allowance mid-flood; a second, small flood (larger
  // than whatever sliver of the global budget remains) drains the rest.
  writePlainLog('s-noisy2', [HEADER, ...flood(1_400), ...mkTurns(0, 50, 'noisy2')])
  writePlainLog('s-after', [HEADER, ...mkTurns(0, 25, 'after')]) // 100 events

  const floodBackend = {
    async list() {
      return [
        { id: 's-root', cwd: '/tmp', createdAt: 1 },
        { id: 's-after', cwd: '/tmp', createdAt: 2, parentSession: 's-root' },
        { id: 's-noisy2', cwd: '/tmp', createdAt: 3, parentSession: 's-root' },
        { id: 's-noisy1', cwd: '/tmp', createdAt: 4, parentSession: 's-root' },
        { id: 's-before', cwd: '/tmp', createdAt: 6, parentSession: 's-root' },
      ]
    },
    async inspect(): Promise<never> {
      throw new Error('inspect must not be reached — every read resolves on disk')
    },
  }
  const root3 = new Context()
  root3.provide('sessionPersistence' as never, floodBackend as never)
  const floodLiveEvents = [...rootEvents, ...mkTurns(48, 1, 'live')]
  const floodAgent = {
    id: 's-live',
    status: 'idle',
    ctx: root3.extend(),
    session: {
      id: 's-live',
      seq: floodLiveEvents.length,
      events: floodLiveEvents,
      header: { id: 's-live', cwd: '/tmp', createdAt: 5, parentSession: 's-root', seedLength: 48 },
    },
    followup() {},
    steer() {},
    inbox: { remove() {} },
  }
  const channel3 = createChannel(root3 as never, floodAgent as never, {
    model: 'm',
    cwd: '/tmp',
    provider: 'p',
    activity: false,
  })
  const floodData = await channel3.buildSessionTree()
  check('flood tree builds', floodData !== null)
  const floodIds = new Set(
    (floodData === null ? [] : flattenTree(floodData.roots, floodData.activeLeafId)).map(f => f.node.id),
  )
  check('sibling before the floods keeps its entries', floodIds.has('s-before:1'),
    [...floodIds].filter(id => id.startsWith('s-before')))
  check('flood logs contribute no real entries',
    ![...floodIds].some(id => /^s-noisy\d:\d/.test(id)),
    [...floodIds].filter(id => id.includes('noisy')))
  // The budget spent by the floods no longer makes later siblings VANISH:
  // s-after degrades to an unloaded placeholder — the branch structure
  // survives, the entries stay hidden (nothing read, nothing to rewind).
  check('sibling after the floods keeps no entries (global budget spent)',
    ![...floodIds].some(id => /^s-after:\d/.test(id)),
    [...floodIds].filter(id => id.startsWith('s-after')))
  check('sibling after the floods degrades to an unloaded placeholder',
    floodIds.has('s-after:head') && floodData?.sessions.get('s-after')?.unloaded === true,
    { ids: [...floodIds].filter(id => id.startsWith('s-after')), meta: floodData?.sessions.get('s-after') })
  check('flooded family marks truncation', floodData?.truncated === true)
}

// ── Inherited-prefix skip: a fork's event budget pays only for OWN events ──
// 70k-event parent, two forks with 4 own events each (one of them live).
// The seed-prefix read used to consume the remaining event budget: fork 2
// got only ~60k of its 70k prefix, trimmed to a head-only placeholder and
// vanished from the panel. The reader now SKIPS the seq range the parent
// already covers (charged to the scan budget, never the event budget), so
// both forks keep their own turns visible.
{
  const skipRoot = mkdtempSync(join(tmpdir(), 'dsh-channel-skip-'))
  process.env.DSH_TUI_SESSION_ROOT = skipRoot
  const HEADER = { session: { id: 'x', cwd: '/tmp' } }
  const writeLog = (sessionId: string, lines: readonly unknown[]): void => {
    const dir = join(skipRoot, 'ws-a', sessionId)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'session.jsonl'), lines.map(line => JSON.stringify(line)).join('\n') + '\n')
  }
  const big: SessionEvent[] = []
  for (let t = 0; t < 17_500; t++) {
    big.push(
      turnStart(t * 4, t),
      userMsg(t * 4 + 1, `big q${t}`),
      assistantMsg(t * 4 + 2, t, 0, `big a${t}`),
      turnEnd(t * 4 + 3, t, { kind: 'completed' }),
    )
  }
  const ownTurn = (tag: string): SessionEvent[] => [
    turnStart(70_000, 0),
    userMsg(70_001, `${tag} own q`),
    assistantMsg(70_002, 0, 0, `${tag} own a`),
    turnEnd(70_003, 0, { kind: 'completed' }),
  ]
  writeLog('s-big', [HEADER, ...big])
  writeLog('s-f1', [HEADER, ...big, ...ownTurn('f1')])
  const skipBackend = {
    async list() {
      return [
        { id: 's-big', cwd: '/tmp', createdAt: 1 },
        { id: 's-f1', cwd: '/tmp', createdAt: 2, parentSession: 's-big', seedLength: 70_000 },
        { id: 's-f2', cwd: '/tmp', createdAt: 3, parentSession: 's-big', seedLength: 70_000 },
      ]
    },
    async inspect(): Promise<never> {
      throw new Error('inspect must not be reached — every read resolves on disk')
    },
  }
  const skipCtx = new Context()
  skipCtx.provide('sessionPersistence' as never, skipBackend as never)
  const skipAgent = {
    id: 's-f2',
    status: 'idle',
    ctx: skipCtx.extend(),
    session: {
      id: 's-f2',
      seq: 70_004,
      events: [...big, ...ownTurn('f2')],
      header: { id: 's-f2', cwd: '/tmp', createdAt: 3, parentSession: 's-big', seedLength: 70_000 },
    },
    followup() {},
    steer() {},
    inbox: { remove() {} },
  }
  const skipChannel = createChannel(skipCtx as never, skipAgent as never, {
    model: 'm', cwd: '/tmp', provider: 'p', activity: false,
  })
  const skipData = await skipChannel.buildSessionTree()
  const skipFlat = skipData === null ? [] : flattenTree(skipData.roots, skipData.activeLeafId)
  const skipById = new Map(skipFlat.map(f => [f.node.id, f]))
  check('huge parent: family holds all three sessions', skipData?.sessionCount === 3, skipData?.sessionCount)
  check('huge parent: fork 1 keeps its own turn',
    skipById.get('s-f1:70001')?.node.entry?.text === 'f1 own q',
    [...skipById.keys()].filter(id => id.startsWith('s-f1')))
  check('huge parent: fork 1 anchors at the parent tip',
    skipById.get('s-f1:70001')?.parentId === 's-big:69998', skipById.get('s-f1:70001')?.parentId)
  check('huge parent: live fork 2 keeps its own turn',
    skipById.get('s-f2:70001')?.node.entry?.text === 'f2 own q')
  check('huge parent: nothing truncated', skipData?.truncated === false)
}

// ── The live fork's seed does not double-pay the event budget ────────────
// 120k-event parent, a LIVE fork with 4 own events, plus a small sibling.
// The live session's in-memory log is self-contained (the inherited seed is
// in it): windowing the tail of the WHOLE log and charging its length used
// to spend ~80k of the family budget on history the parent already paid
// for — the sibling then degraded to an unloaded placeholder although the
// unique history is ~120k, well under the 200k cap. The live read now skips
// the inherited prefix exactly like the non-live reads.
{
  const dupRoot = mkdtempSync(join(tmpdir(), 'dsh-channel-dup-'))
  process.env.DSH_TUI_SESSION_ROOT = dupRoot
  const HEADER = { session: { id: 'x', cwd: '/tmp' } }
  const writeLog = (sessionId: string, lines: readonly unknown[]): void => {
    const dir = join(dupRoot, 'ws-a', sessionId)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'session.jsonl'), lines.map(line => JSON.stringify(line)).join('\n') + '\n')
  }
  const big: SessionEvent[] = []
  for (let t = 0; t < 30_000; t++) {
    big.push(
      turnStart(t * 4, t),
      userMsg(t * 4 + 1, `big q${t}`),
      assistantMsg(t * 4 + 2, t, 0, `big a${t}`),
      turnEnd(t * 4 + 3, t, { kind: 'completed' }),
    )
  }
  const ownTurn = (tag: string): SessionEvent[] => [
    turnStart(120_000, 0),
    userMsg(120_001, `${tag} own q`),
    assistantMsg(120_002, 0, 0, `${tag} own a`),
    turnEnd(120_003, 0, { kind: 'completed' }),
  ]
  writeLog('s-big', [HEADER, ...big])
  writeLog('s-f1', [HEADER, ...big, ...ownTurn('f1')])
  const dupBackend = {
    async list() {
      return [
        { id: 's-big', cwd: '/tmp', createdAt: 1 },
        { id: 's-f1', cwd: '/tmp', createdAt: 2, parentSession: 's-big', seedLength: 120_000 },
        { id: 's-f2', cwd: '/tmp', createdAt: 3, parentSession: 's-big', seedLength: 120_000 },
      ]
    },
    async inspect(): Promise<never> {
      throw new Error('inspect must not be reached — every read resolves on disk')
    },
  }
  const dupCtx = new Context()
  dupCtx.provide('sessionPersistence' as never, dupBackend as never)
  const dupAgent = {
    id: 's-f2',
    status: 'idle',
    ctx: dupCtx.extend(),
    session: {
      id: 's-f2',
      seq: 120_004,
      events: [...big, ...ownTurn('f2')],
      header: { id: 's-f2', cwd: '/tmp', createdAt: 3, parentSession: 's-big', seedLength: 120_000 },
    },
    followup() {},
    steer() {},
    inbox: { remove() {} },
  }
  const dupChannel = createChannel(dupCtx as never, dupAgent as never, {
    model: 'm', cwd: '/tmp', provider: 'p', activity: false,
  })
  const dupData = await dupChannel.buildSessionTree()
  const dupFlat = dupData === null ? [] : flattenTree(dupData.roots, dupData.activeLeafId)
  const dupById = new Map(dupFlat.map(f => [f.node.id, f]))
  check('live seed: family holds all three sessions', dupData?.sessionCount === 3, dupData?.sessionCount)
  check('live seed: live fork keeps its own turn',
    dupById.get('s-f2:120001')?.node.entry?.text === 'f2 own q',
    [...dupById.keys()].filter(id => id.startsWith('s-f2')))
  check('live seed: the small sibling is NOT squeezed out',
    dupById.get('s-f1:120001')?.node.entry?.text === 'f1 own q',
    [...dupById.keys()].filter(id => id.startsWith('s-f1')))
  check('live seed: nothing truncated', dupData?.truncated === false)
  // Branch-adopt targets: the live fork's memory log always reaches the tip;
  // both disk reads fit the budget, so their tails are complete too.
  check('live seed: live fork adoptable at its tip', dupData?.rewindFacts.get('s-f2')?.tipBoundary === 120_003,
    dupData?.rewindFacts.get('s-f2'))
  check('live seed: disk sibling adoptable at its tip', dupData?.rewindFacts.get('s-f1')?.tipBoundary === 120_003)
  check('live seed: huge parent adoptable at its tip', dupData?.rewindFacts.get('s-big')?.tipBoundary === 119_999)
}

// ── A budget-sliced tail withholds the adopt target ──────────────────────
// "Switch to this branch keeping everything" is only honest when the loaded
// events reach the log tip: a read sliced by the event budget lost the
// tail, and a tip computed from it would fork mid-branch while claiming to
// keep everything. 210k turn markers > the 200k event budget, so the dead
// parent's read slices; the live twin (4 own events in memory) keeps its
// adopt target.
{
  const cutRoot = mkdtempSync(join(tmpdir(), 'dsh-channel-cut-'))
  process.env.DSH_TUI_SESSION_ROOT = cutRoot
  const HEADER = { session: { id: 'x', cwd: '/tmp' } }
  const writeLog = (sessionId: string, lines: readonly unknown[]): void => {
    const dir = join(cutRoot, 'ws-a', sessionId)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'session.jsonl'), lines.map(line => JSON.stringify(line)).join('\n') + '\n')
  }
  const huge: SessionEvent[] = []
  for (let t = 0; t < 105_000; t++) {
    huge.push(turnStart(t * 2, t), turnEnd(t * 2 + 1, t, { kind: 'completed' }))
  }
  const twinOwn: SessionEvent[] = [
    turnStart(210_000, 0),
    userMsg(210_001, 'twin own q'),
    assistantMsg(210_002, 0, 0, 'twin own a'),
    turnEnd(210_003, 0, { kind: 'completed' }),
  ]
  writeLog('s-huge', [HEADER, ...huge])
  const cutBackend = {
    async list() {
      return [
        { id: 's-huge', cwd: '/tmp', createdAt: 1 },
        { id: 's-twin', cwd: '/tmp', createdAt: 2, parentSession: 's-huge', seedLength: 210_000 },
      ]
    },
    async inspect(): Promise<never> {
      throw new Error('inspect must not be reached — every read resolves on disk')
    },
  }
  const cutCtx = new Context()
  cutCtx.provide('sessionPersistence' as never, cutBackend as never)
  const cutAgent = {
    id: 's-twin',
    status: 'idle',
    ctx: cutCtx.extend(),
    session: {
      id: 's-twin',
      seq: 210_004,
      events: [...huge, ...twinOwn],
      header: { id: 's-twin', cwd: '/tmp', createdAt: 2, parentSession: 's-huge', seedLength: 210_000 },
    },
    followup() {},
    steer() {},
    inbox: { remove() {} },
  }
  const cutChannel = createChannel(cutCtx as never, cutAgent as never, {
    model: 'm', cwd: '/tmp', provider: 'p', activity: false,
  })
  const cutData = await cutChannel.buildSessionTree()
  check('tail cut: tree builds', cutData !== null)
  check('tail cut: truncated flag set', cutData?.truncated === true)
  check('tail cut: sliced parent keeps tailComplete=false', cutData?.rewindFacts.get('s-huge')?.tailComplete === false,
    cutData?.rewindFacts.get('s-huge'))
  check('tail cut: sliced parent withholds the adopt target',
    cutData?.rewindFacts.get('s-huge')?.tipBoundary === undefined)
  // The parent's slice exhausts the event budget, so the live twin's tail
  // window keeps nothing — its memory log is still tip-complete (live =>
  // tailComplete) but an empty window holds no turn/end to aim at. Adopt on
  // the live session is refused up front anyway ('已在该分支上').
  check('tail cut: live twin tip-complete but window empty',
    cutData?.rewindFacts.get('s-twin')?.tailComplete === true &&
    cutData?.rewindFacts.get('s-twin')?.tipBoundary === undefined,
    cutData?.rewindFacts.get('s-twin'))
}

// ── The inherited-prefix skip also applies to inspect-only backends ───────
// A backend with no JSONL artifact (SQLite & friends) serves the WHOLE
// self-contained log from inspect: the prefix skip the file readers apply
// used to be skipped there, so a fork's 120k inherited events filled the
// remaining budget from index 0 and the branch's OWN events — the only ones
// nobody else displays — were sliced off.
{
  const inspectRoot = mkdtempSync(join(tmpdir(), 'dsh-channel-inspect-'))
  process.env.DSH_TUI_SESSION_ROOT = inspectRoot
  const big: SessionEvent[] = []
  for (let t = 0; t < 30_000; t++) {
    big.push(
      turnStart(t * 4, t),
      userMsg(t * 4 + 1, `big q${t}`),
      assistantMsg(t * 4 + 2, t, 0, `big a${t}`),
      turnEnd(t * 4 + 3, t, { kind: 'completed' }),
    )
  }
  const ownTurn = (tag: string): SessionEvent[] => [
    turnStart(120_000, 0),
    userMsg(120_001, `${tag} own q`),
    assistantMsg(120_002, 0, 0, `${tag} own a`),
    turnEnd(120_003, 0, { kind: 'completed' }),
  ]
  const inspectBackend = {
    async list() {
      return [
        { id: 's-big', cwd: '/tmp', createdAt: 1 },
        { id: 's-f1', cwd: '/tmp', createdAt: 2, parentSession: 's-big', seedLength: 120_000 },
        { id: 's-f2', cwd: '/tmp', createdAt: 3, parentSession: 's-big', seedLength: 120_000 },
      ]
    },
    async inspect(id: unknown) {
      const sid = String(id)
      if (sid === 's-big') return { events: big }
      if (sid === 's-f1') return { events: [...big, ...ownTurn('f1')] }
      throw new Error(`unexpected inspect for ${sid}`)
    },
  }
  const inspCtx = new Context()
  inspCtx.provide('sessionPersistence' as never, inspectBackend as never)
  const inspAgent = {
    id: 's-f2',
    status: 'idle',
    ctx: inspCtx.extend(),
    session: {
      id: 's-f2',
      seq: 120_004,
      events: [...big, ...ownTurn('f2')],
      header: { id: 's-f2', cwd: '/tmp', createdAt: 3, parentSession: 's-big', seedLength: 120_000 },
    },
    followup() {},
    steer() {},
    inbox: { remove() {} },
  }
  const inspChannel = createChannel(inspCtx as never, inspAgent as never, {
    model: 'm', cwd: '/tmp', provider: 'p', activity: false,
  })
  const inspData = await inspChannel.buildSessionTree()
  const inspFlat = inspData === null ? [] : flattenTree(inspData.roots, inspData.activeLeafId)
  const inspById = new Map(inspFlat.map(f => [f.node.id, f]))
  check('inspect backend: parent read through inspect', inspById.get('s-big:1')?.node.entry?.text === 'big q0')
  check('inspect backend: fork keeps its own turn past the skipped prefix',
    inspById.get('s-f1:120001')?.node.entry?.text === 'f1 own q',
    [...inspById.keys()].filter(id => id.startsWith('s-f1')))
  check('inspect backend: nothing truncated', inspData?.truncated === false)
}

// ── Family cwd matching is project-aware (the same rule /resume uses) ────
// A pre-upgrade subdirectory path on ONE header used to fail the exact
// string comparison and amputate every ancestor it records: the tree
// degraded to the live session alone while /resume still listed the family.
{
  const cwdRoot = mkdtempSync(join(tmpdir(), 'dsh-channel-cwd-'))
  process.env.DSH_TUI_SESSION_ROOT = cwdRoot
  const HEADER = { session: { id: 'x', cwd: '/tmp/proj/sub' } }
  const writeLog = (sessionId: string, lines: readonly unknown[]): void => {
    const dir = join(cwdRoot, 'ws-a', sessionId)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'session.jsonl'), lines.map(line => JSON.stringify(line)).join('\n') + '\n')
  }
  const parentEvents: SessionEvent[] = [
    turnStart(0, 0),
    userMsg(1, 'parent q'),
    assistantMsg(2, 0, 0, 'parent a'),
    turnEnd(3, 0, { kind: 'completed' }),
  ]
  const childEvents: SessionEvent[] = [
    ...parentEvents,
    turnStart(4, 1),
    userMsg(5, 'child q'),
    assistantMsg(6, 1, 0, 'child a'),
    turnEnd(7, 1, { kind: 'completed' }),
  ]
  writeLog('s-parent', [HEADER, ...parentEvents])
  const cwdBackend = {
    async list() {
      return [
        { id: 's-parent', cwd: '/tmp/proj/sub', createdAt: 1 },
        { id: 's-child', cwd: '/tmp/proj', createdAt: 2, parentSession: 's-parent', seedLength: 4 },
      ]
    },
    async inspect(): Promise<never> {
      throw new Error('inspect must not be reached — every read resolves on disk')
    },
  }
  const cwdCtx = new Context()
  cwdCtx.provide('sessionPersistence' as never, cwdBackend as never)
  const cwdAgent = {
    id: 's-child',
    status: 'idle',
    ctx: cwdCtx.extend(),
    session: {
      id: 's-child',
      seq: 8,
      events: childEvents,
      header: { id: 's-child', cwd: '/tmp/proj', createdAt: 2, parentSession: 's-parent', seedLength: 4 },
    },
    followup() {},
    steer() {},
    inbox: { remove() {} },
  }
  const cwdChannel = createChannel(cwdCtx as never, cwdAgent as never, {
    model: 'm', cwd: '/tmp/proj', provider: 'p', activity: false,
  })
  const cwdData = await cwdChannel.buildSessionTree()
  const cwdFlat = cwdData === null ? [] : flattenTree(cwdData.roots, cwdData.activeLeafId)
  check('cwd variant: the subdirectory parent joins the family', cwdData?.sessionCount === 2, cwdData?.sessionCount)
  check('cwd variant: parent entries are on the tree',
    cwdFlat.some(f => f.node.entry?.text === 'parent q'),
    cwdFlat.map(f => f.node.id))
}

// ── The session cap never evicts the ancestor chain ───────────────────────
// A 26-deep chain (cap 24) used to drop the two OLDEST ancestors to the
// slice — the live branch lost its root and the tree fell apart into
// sessionCount=1 + roots=[live]. The chain now bypasses the cap; only
// non-ancestor branches compete for the remaining slots.
{
  const chainRoot = mkdtempSync(join(tmpdir(), 'dsh-channel-chain-'))
  process.env.DSH_TUI_SESSION_ROOT = chainRoot
  const HEADER = { session: { id: 'x', cwd: '/tmp' } }
  const DEPTH = 26
  const sid = (i: number) => `s${String(i).padStart(2, '0')}`
  const headers: { id: string; cwd: string; createdAt: number; parentSession?: string; seedLength?: number }[] = []
  let chainLiveEvents: SessionEvent[] = []
  for (let i = 0; i < DEPTH; i++) {
    // Session i's log: turns 0..i (4 events each) — its parent's log is its
    // seed prefix (seedLength 4i), so each read collects only its own turn.
    const events: SessionEvent[] = []
    for (let t = 0; t <= i; t++) {
      events.push(
        turnStart(t * 4, t),
        userMsg(t * 4 + 1, `${sid(i)} q${t}`),
        assistantMsg(t * 4 + 2, t, 0, `${sid(i)} a${t}`),
        turnEnd(t * 4 + 3, t, { kind: 'completed' }),
      )
    }
    const dir = join(chainRoot, 'ws-a', sid(i))
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'session.jsonl'), [HEADER, ...events].map(line => JSON.stringify(line)).join('\n') + '\n')
    headers.push({
      id: sid(i),
      cwd: '/tmp',
      createdAt: i + 1,
      ...(i > 0 ? { parentSession: sid(i - 1), seedLength: i * 4 } : {}),
    })
    if (i === DEPTH - 1) chainLiveEvents = events
  }
  const chainBackend = {
    async list() { return headers },
    async inspect(): Promise<never> {
      throw new Error('inspect must not be reached — every read resolves on disk')
    },
  }
  const chainCtx = new Context()
  chainCtx.provide('sessionPersistence' as never, chainBackend as never)
  const lastHeader = headers[DEPTH - 1]!
  const chainAgent = {
    id: lastHeader.id,
    status: 'idle',
    ctx: chainCtx.extend(),
    session: {
      id: lastHeader.id,
      seq: chainLiveEvents.length,
      events: chainLiveEvents,
      header: lastHeader,
    },
    followup() {},
    steer() {},
    inbox: { remove() {} },
  }
  const chainChannel = createChannel(chainCtx as never, chainAgent as never, {
    model: 'm', cwd: '/tmp', provider: 'p', activity: false,
  })
  const chainData = await chainChannel.buildSessionTree()
  check('deep chain: every ancestor survives the cap', chainData?.sessionCount === DEPTH, chainData?.sessionCount)
  check('deep chain: single root at the oldest ancestor',
    chainData?.roots.length === 1 && chainData.roots[0]!.id === 's00:1', chainData?.roots[0]?.id)
  const chainFlat = chainData === null ? [] : flattenTree(chainData.roots, chainData.activeLeafId)
  const chainIds = new Set(chainFlat.map(f => f.node.id))
  check('deep chain: oldest ancestor entries present', chainIds.has('s00:1'))
  check('deep chain: live tip is the active leaf', chainData?.activeLeafId === `${sid(DEPTH - 1)}:${(DEPTH - 1) * 4 + 2}`,
    chainData?.activeLeafId)
}

// ── A failed bounded read never escalates to the unbounded strict read ────
// The compat reader distinguishes ABSENT (undefined → the inspect fallback
// stays, it is the only source for non-file backends) from FAILED (safety
// cap / corruption → placeholder only). Falling back on FAILED would re-read
// exactly the oversized/bomb logs the caps exist to bound, whole.
{
  const failRoot = mkdtempSync(join(tmpdir(), 'dsh-channel-fail-'))
  process.env.DSH_TUI_SESSION_ROOT = failRoot
  const HEADER = { session: { id: 'x', cwd: '/tmp' } }
  const rootTurn: SessionEvent[] = [
    turnStart(0, 0), userMsg(1, 'root q'), assistantMsg(2, 0, 0, 'root a'), turnEnd(3, 0, { kind: 'completed' }),
  ]
  const writePlain2 = (sessionId: string, lines: readonly unknown[]): void => {
    const dir = join(failRoot, 'ws-a', sessionId)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'session.jsonl'), lines.map(line => JSON.stringify(line)).join('\n') + '\n')
  }
  writePlain2('s-root', [HEADER, ...rootTurn])
  // s-bad: a corrupt zstd frame on disk (byte flipped near the end — the
  // bounded reader fails it closed).
  const badDir = join(failRoot, 'ws-a', 's-bad')
  mkdirSync(badDir, { recursive: true })
  const badBytes = zstdCompressSync(Buffer.from(
    [HEADER, turnStart(0, 0), userMsg(1, 'bad q'), turnEnd(2, 0, { kind: 'completed' })].map(line => JSON.stringify(line)).join('\n') + '\n',
    'utf8'))
  badBytes[badBytes.length - 3] = badBytes[badBytes.length - 3]! ^ 0xff
  writeFileSync(join(badDir, 'session.jsonl.zstd'), badBytes)
  // s-gone: listed by the backend but owns NO file — the inspect fallback.
  const goneEvents: SessionEvent[] = [
    ...rootTurn,
    turnStart(4, 1), userMsg(5, 'gone own q'), assistantMsg(6, 1, 0, 'gone own a'), turnEnd(7, 1, { kind: 'completed' }),
  ]
  const inspected: string[] = []
  const failBackend = {
    async list() {
      return [
        { id: 's-root', cwd: '/tmp', createdAt: 1 },
        { id: 's-bad', cwd: '/tmp', createdAt: 2, parentSession: 's-root' },
        { id: 's-gone', cwd: '/tmp', createdAt: 3, parentSession: 's-root', seedLength: 4 },
      ]
    },
    async inspect(id: unknown) {
      inspected.push(String(id))
      if (String(id) === 's-bad') {
        throw new Error('inspect must not be retried for a FAILED bounded read')
      }
      return { events: goneEvents }
    },
  }
  const failCtx = new Context()
  failCtx.provide('sessionPersistence' as never, failBackend as never)
  const failAgent = {
    id: 's-live',
    status: 'idle',
    ctx: failCtx.extend(),
    session: {
      id: 's-live',
      seq: 4,
      events: rootTurn,
      header: { id: 's-live', cwd: '/tmp', createdAt: 4, parentSession: 's-root', seedLength: 4 },
    },
    followup() {},
    steer() {},
    inbox: { remove() {} },
  }
  const failChannel = createChannel(failCtx as never, failAgent as never, {
    model: 'm', cwd: '/tmp', provider: 'p', activity: false,
  })
  const failData = await failChannel.buildSessionTree()
  const failFlat = failData === null ? [] : flattenTree(failData.roots, failData.activeLeafId)
  const failIds = new Set(failFlat.map(f => f.node.id))
  check('failed read: degraded to an unreadable placeholder',
    failIds.has('s-bad:head') && failData?.sessions.get('s-bad')?.unreadable === true,
    { ids: [...failIds].filter(id => id.startsWith('s-bad')), meta: failData?.sessions.get('s-bad') })
  check('failed read: inspect never retried it', !inspected.includes('s-bad'), inspected)
  check('absent log: inspect fallback still serves it', inspected.includes('s-gone'), inspected)
  check('absent log: fallback entries visible', failIds.has('s-gone:5'), [...failIds].filter(id => id.startsWith('s-gone')))
}

// ── An unreadable parent cannot hide the child's self-contained history ────
// The child inherits its prefix from the dead parent's log, but with the
// parent unreadable nothing displays that prefix — the child must keep and
// show it (coverage-based trim), not trim by the bare seedLength.
{
  const orphanRoot = mkdtempSync(join(tmpdir(), 'dsh-channel-orphan-'))
  process.env.DSH_TUI_SESSION_ROOT = orphanRoot
  const HEADER = { session: { id: 'x', cwd: '/tmp' } }
  const kidTurn: SessionEvent[] = [
    turnStart(0, 0), userMsg(1, 'inherited q0'), assistantMsg(2, 0, 0, 'inherited a0'), turnEnd(3, 0, { kind: 'completed' }),
    turnStart(4, 1), userMsg(5, 'kid own q'), assistantMsg(6, 1, 0, 'kid own a'), turnEnd(7, 1, { kind: 'completed' }),
  ]
  const kidDir = join(orphanRoot, 'ws-a', 's-kid')
  mkdirSync(kidDir, { recursive: true })
  writeFileSync(join(kidDir, 'session.jsonl'),
    [HEADER, ...kidTurn].map(line => JSON.stringify(line)).join('\n') + '\n')
  const deadDir = join(orphanRoot, 'ws-a', 's-dead')
  mkdirSync(deadDir, { recursive: true })
  const deadBytes = zstdCompressSync(Buffer.from(
    [HEADER, turnStart(0, 0), userMsg(1, 'dead q'), turnEnd(2, 0, { kind: 'completed' })].map(line => JSON.stringify(line)).join('\n') + '\n',
    'utf8'))
  deadBytes[deadBytes.length - 3] = deadBytes[deadBytes.length - 3]! ^ 0xff
  writeFileSync(join(deadDir, 'session.jsonl.zstd'), deadBytes)
  const orphanBackend = {
    async list() {
      return [
        { id: 's-dead', cwd: '/tmp', createdAt: 1 },
        { id: 's-kid', cwd: '/tmp', createdAt: 2, parentSession: 's-dead', seedLength: 4 },
      ]
    },
    async inspect(): Promise<never> {
      throw new Error('inspect must not be reached — s-dead FAILED, it is not ABSENT')
    },
  }
  const orphanCtx = new Context()
  orphanCtx.provide('sessionPersistence' as never, orphanBackend as never)
  const liveEvents: SessionEvent[] = [
    ...kidTurn,
    turnStart(8, 2), userMsg(9, 'live own q'), assistantMsg(10, 2, 0, 'live own a'), turnEnd(11, 2, { kind: 'completed' }),
  ]
  const orphanAgent = {
    id: 's-live',
    status: 'idle',
    ctx: orphanCtx.extend(),
    session: {
      id: 's-live',
      seq: liveEvents.length,
      events: liveEvents,
      header: { id: 's-live', cwd: '/tmp', createdAt: 3, parentSession: 's-kid', seedLength: 8 },
    },
    followup() {},
    steer() {},
    inbox: { remove() {} },
  }
  const orphanChannel = createChannel(orphanCtx as never, orphanAgent as never, {
    model: 'm', cwd: '/tmp', provider: 'p', activity: false,
  })
  const orphanData = await orphanChannel.buildSessionTree()
  const orphanFlat = orphanData === null ? [] : flattenTree(orphanData.roots, orphanData.activeLeafId)
  const orphanById = new Map(orphanFlat.map(f => [f.node.id, f]))
  check('dead parent: structure-only placeholder', orphanById.has('s-dead:head'))
  check('dead parent: child keeps the inherited prefix',
    orphanById.get('s-kid:1')?.node.entry?.text === 'inherited q0',
    [...orphanById.keys()].filter(id => id.startsWith('s-kid')))
  check('dead parent: child own turn kept too',
    orphanById.get('s-kid:5')?.node.entry?.text === 'kid own q')
  check('dead parent: live grandchild reaches the child chain',
    orphanById.get('s-live:9')?.node.entry?.text === 'live own q')
}

// ── Agent swaps serialize; a mid-create swap disposes the orphan ──────────
// ── rewindToNode boundary semantics (pi navigateTree on DSH's turn-closed
// fork constraint) ────────────────────────────────────────────────────────
// A tool/assistant entry KEEPS its whole turn (boundary = the closing
// turn/end) and restores no prompt; only a user entry drops its turn and
// restores the prompt. A live-tip entry is a no-op: keeping it keeps the
// whole log, so the fork would seed an identical session — refuse with a
// notice instead of swapping to nothing-changed. Chained on one channel:
// each fork becomes the next case's live session.
{
  const semRoot = new Context()
  semRoot.provide('sessions' as never, {
    fork() { throw new Error('sessions.fork must not be called — ghost branch') },
  } as never)
  const seeds: number[] = []
  semRoot.provide('agents' as never, {
    create: (options: { seed: readonly SessionEvent[] }) => {
      seeds.push(options.seed.length)
      const id = `s-sem-fork-${seeds.length}`
      return Promise.resolve({
        agent: {
          id,
          status: 'idle',
          ctx: semRoot.extend(),
          session: { id, seq: options.seed.length, events: options.seed, header: { id, cwd: '/tmp', createdAt: 20 } },
          followup() {},
          steer() {},
          inbox: { remove() {} },
        },
        dispose: () => Promise.resolve(),
      })
    },
  } as never)
  const semEvents: SessionEvent[] = [
    turnStart(0, 0), userMsg(1, 'first question'), assistantMsg(2, 0, 0, 'first answer'), turnEnd(3, 0, { kind: 'completed' }),
    turnStart(4, 1), userMsg(5, 'second question'), toolCall(6, 1, 0, 'c1', 'Bash', '{"command":"ls"}'), toolOk(7, 1, 0, 'c1'), assistantMsg(8, 1, 1, 'second answer'), turnEnd(9, 1, { kind: 'completed' }),
    turnStart(10, 2), userMsg(11, 'third question'), assistantMsg(12, 2, 0, 'third answer'), turnEnd(13, 2, { kind: 'completed' }),
  ]
  const semAgent = {
    id: 's-sem',
    status: 'idle',
    ctx: semRoot.extend(),
    session: { id: 's-sem', seq: semEvents.length, events: semEvents, header: { id: 's-sem', cwd: '/tmp', createdAt: 19 } },
    followup() {},
    steer() {},
    inbox: { remove() {} },
  }
  const semChannel = createChannel(semRoot as never, semAgent as never, {
    model: 'm',
    cwd: '/tmp',
    provider: 'p',
    activity: false,
  })
  // A BASH tool call mid-log: keeps turn 1 — the seed runs through the
  // closing turn/end@9, the picked call stays in history, nothing is
  // restored into the input.
  check('tool entry keeps its turn (no prompt restore)', (await semChannel.rewindToNode('s-sem', 6)) === '')
  check('tool entry seed ends at the closing turn/end',
    seeds[0] === 10 && semEvents[9]?.type === 'turn/end', seeds)
  // The fork (events 0..9) is live now. Its LAST turn's assistant entry sits
  // at the tip: keeping it keeps the whole log — refuse as a no-op instead
  // of swapping to an identical session.
  check('live-tip entry refuses as a no-op', (await semChannel.rewindToNode('s-sem-fork-1', 8)) === null)
  check('no-op rewind creates nothing', seeds.length === 1, seeds)
  // A turn-0 assistant entry is NOT first-message-refused: turn 0 has a
  // closing turn/end@3, so keeping the turn gives a valid boundary.
  check('turn-0 assistant keeps turn 0', (await semChannel.rewindToNode('s-sem-fork-1', 2)) === '')
  check('turn-0 assistant seed is turn 0 whole', seeds[1] === 4, seeds)
  // …while a turn-0 USER entry can never rewind (boundary -1).
  check('turn-0 user refuses at the channel', (await semChannel.rewindToNode('s-sem-fork-2', 1)) === null)
  check('refused rewind creates nothing', seeds.length === 2, seeds)
}

// ── rewindToNode STEP granularity: a mid-turn pick cuts at its step's
// step/end and the channel closes the orphaned turn with the exact event a
// real user interrupt writes (turn/end aborted/user). DSH agentic turns are
// marathons — one prompt, N steps — so turn-granular keeping maps any
// mid-turn pick to the turn's end and the visible history barely moves (the
// "rewind stays in place" report). Chained on one channel like above.
{
  const stepRoot = new Context()
  stepRoot.provide('sessions' as never, {
    fork() { throw new Error('sessions.fork must not be called — ghost branch') },
  } as never)
  const stepSeeds: SessionEvent[][] = []
  stepRoot.provide('agents' as never, {
    create: (options: { seed: readonly SessionEvent[] }) => {
      stepSeeds.push([...options.seed])
      const id = `s-step-fork-${stepSeeds.length}`
      return Promise.resolve({
        agent: {
          id,
          status: 'idle',
          ctx: stepRoot.extend(),
          session: { id, seq: options.seed.length, events: options.seed, header: { id, cwd: '/tmp', createdAt: 21 } },
          followup() {},
          steer() {},
          inbox: { remove() {} },
        },
        dispose: () => Promise.resolve(),
      })
    },
  } as never)
  // One turn, three steps: bash in step 0, an answer in step 1, a read in
  // step 2 — the shape of the reporter's single-giant-turn session.
  const stepEvents: SessionEvent[] = [
    turnStart(0, 0), userMsg(1, 'explore this project'),
    stepStart(2, 0, 0), toolCall(3, 0, 0, 'c1', 'Bash', '{"command":"ls"}'), toolOk(4, 0, 0, 'c1'), stepEnd(5, 0, 0),
    stepStart(6, 0, 1), assistantMsg(7, 0, 1, 'first findings'), stepEnd(8, 0, 1),
    stepStart(9, 0, 2), toolCall(10, 0, 2, 'c2', 'Read', '{"path":"a.ts"}'), toolOk(11, 0, 2, 'c2'), stepEnd(12, 0, 2),
    turnEnd(13, 0, { kind: 'completed' }),
  ]
  const stepAgent = {
    id: 's-step',
    status: 'idle',
    ctx: stepRoot.extend(),
    session: { id: 's-step', seq: stepEvents.length, events: stepEvents, header: { id: 's-step', cwd: '/tmp', createdAt: 20 } },
    followup() {},
    steer() {},
    inbox: { remove() {} },
  }
  const stepChannel = createChannel(stepRoot as never, stepAgent as never, {
    model: 'm',
    cwd: '/tmp',
    provider: 'p',
    activity: false,
  })
  // Pick the bash call of step 0: the seed runs through step 0's step/end@5
  // and the channel appends a synthetic turn/end@6 — steps 1-2 are dropped,
  // the picked call stays in history, nothing is restored into the input.
  check('stepped tool pick restores no prompt', (await stepChannel.rewindToNode('s-step', 3)) === '')
  check('stepped seed length is step/end + synthetic close', stepSeeds[0]?.length === 7, stepSeeds[0]?.length)
  check('stepped seed ends with a synthetic interrupt', (() => {
    const last = stepSeeds[0]?.[6]
    if (last?.type !== 'turn/end') return false
    const data = last.data as { turn?: number, reason?: { kind?: string, reason?: { kind?: string } } }
    return last.seq === 6 && data.turn === 0 &&
      data.reason?.kind === 'aborted' && data.reason.reason?.kind === 'user'
  })(), stepSeeds[0]?.[6])
  check('stepped seed keeps the picked call', stepSeeds[0]?.[3]?.type === 'tool/call')
  check('stepped seed seq is contiguous', (() => {
    const seed = stepSeeds[0]
    return seed !== undefined && seed.every((event, index) => event.seq === index)
  })())
  // The fork (events 0..6) is live now. Picking the SAME call again would
  // cut at step/end@5 + synthetic close — nothing message-bearing follows
  // the boundary, so it must refuse as a no-op instead of forking an
  // identical transcript.
  check('stepped re-pick of the tip step refuses as a no-op',
    (await stepChannel.rewindToNode('s-step-fork-1', 3)) === null)
  check('stepped no-op creates nothing', stepSeeds.length === 1, stepSeeds.length)
  // …and the fork's own turn-0 USER message still can never rewind
  // (boundary -1) — drop-the-turn is unaffected by the step markers.
  check('stepped turn-0 user refuses at the channel',
    (await stepChannel.rewindToNode('s-step-fork-1', 1)) === null)
  check('stepped refused rewind creates nothing', stepSeeds.length === 1, stepSeeds.length)
}

// rewindToNode/resumeTo/newSession/switchModel each await (preset compose,
// agent create) before adopting the new agent. Without serialization two
// fire-and-forget swaps interleave — both create a session and the loser's
// adopt disposes the winner's agent, orphaning a branch. The swap lock
// refuses concurrent swaps up front; and when the live session still moved
// (a path outside the four), the created handle must be DISPOSED, not
// adopted over the new session.
{
  const flush = () => new Promise(resolve => setImmediate(resolve))
  const lockRoot = new Context()
  // Tripwire: the swap paths must not consult the sessions service at all —
  // upstream SessionStore.fork() registers + announces a REAL child session,
  // which is where every live rewind used to leak a ghost branch.
  lockRoot.provide('sessions' as never, {
    fork() { throw new Error('sessions.fork must not be called — ghost branch') },
  } as never)
  let releaseCreate: ((handle: unknown) => void) | null = null
  let creates = 0
  lockRoot.provide('agents' as never, {
    create: () => {
      creates += 1
      return new Promise(resolve => { releaseCreate = resolve })
    },
  } as never)
  const lockEvents: SessionEvent[] = [
    turnStart(0, 0), userMsg(1, 'first question'), assistantMsg(2, 0, 0, 'first answer'), turnEnd(3, 0, { kind: 'completed' }),
    turnStart(4, 1), userMsg(5, 'second question'), assistantMsg(6, 1, 0, 'second answer'), turnEnd(7, 1, { kind: 'completed' }),
  ]
  const disposed: string[] = []
  const mkHandle = (id: string, events: SessionEvent[]) => ({
    agent: {
      id,
      status: 'idle',
      ctx: lockRoot.extend(),
      session: { id, seq: events.length, events, header: { id, cwd: '/tmp', createdAt: 9 } },
      followup() {},
      steer() {},
      inbox: { remove() {} },
    },
    dispose: async () => { disposed.push(id) },
  })
  const lockAgent = {
    id: 's-lock',
    status: 'idle',
    ctx: lockRoot.extend(),
    session: {
      id: 's-lock',
      seq: lockEvents.length,
      events: lockEvents,
      header: { id: 's-lock', cwd: '/tmp', createdAt: 8 },
    },
    followup() {},
    steer() {},
    inbox: { remove() {} },
  }
  const channel4 = createChannel(lockRoot as never, lockAgent as never, {
    model: 'm',
    cwd: '/tmp',
    provider: 'p',
    activity: false,
  })
  const first = channel4.rewindToNode('s-lock', 5)
  await flush()
  check('first swap reached agent create', creates === 1, creates)
  check('concurrent rewind refused', (await channel4.rewindToNode('s-lock', 5)) === null)
  check('concurrent /new refused', (await channel4.newSession()) === false)
  check('concurrent /model refused', (await channel4.switchModel('p', 'm2')) === false)
  check('concurrent /resume refused', (await channel4.resumeTo('s-lock')) === false)
  check('refused swaps create nothing', creates === 1, creates)
  releaseCreate!(mkHandle('s-lock-fork', lockEvents))
  check('first swap restores the rewound prompt', (await first) === 'second question')
  // The lock releases when the swap completes: a follow-up rewind of the
  // forked session proceeds to its own create.
  const followUp = channel4.rewindToNode('s-lock-fork', 5)
  await flush()
  check('lock released after the swap', creates === 2, creates)
  releaseCreate!(mkHandle('s-lock-fork-2', lockEvents.slice(0, 4)))
  check('follow-up swap completes', (await followUp) === 'second question')

  // A swap landing mid-create (outside the four locked paths — the guard is
  // defense in depth) must not adopt over the new session: bail + dispose.
  const staleRoot = new Context()
  staleRoot.provide('sessions' as never, {
    fork() { throw new Error('sessions.fork must not be called — ghost branch') },
  } as never)
  let releaseCreate2: ((handle: unknown) => void) | null = null
  staleRoot.provide('agents' as never, {
    create: () => new Promise(resolve => { releaseCreate2 = resolve }),
  } as never)
  const staleAgent = {
    id: 's-stale',
    status: 'idle',
    ctx: staleRoot.extend(),
    session: {
      id: 's-stale',
      seq: lockEvents.length,
      events: lockEvents,
      header: { id: 's-stale', cwd: '/tmp', createdAt: 10 },
    },
    followup() {},
    steer() {},
    inbox: { remove() {} },
  }
  const channel5 = createChannel(staleRoot as never, staleAgent as never, {
    model: 'm',
    cwd: '/tmp',
    provider: 'p',
    activity: false,
  })
  const parked = channel5.rewindToNode('s-stale', 5)
  await flush()
  check('second harness reached create', releaseCreate2 !== null)
  staleAgent.session = {
    id: 's-elsewhere',
    seq: 0,
    events: [],
    header: { id: 's-elsewhere', cwd: '/tmp', createdAt: 11 },
  } as never
  releaseCreate2!(mkHandle('s-stale-fork', lockEvents.slice(0, 4)))
  check('post-create swap bails instead of adopting', (await parked) === null)
  await flush()
  check('orphaned fork disposed', disposed.includes('s-stale-fork'), disposed)
}

console.log(failed === 0 ? 'ALL PASS' : `${failed} FAILURES`)
process.exit(failed === 0 ? 0 : 1)
