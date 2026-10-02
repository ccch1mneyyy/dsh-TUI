/**
 * Projection golden pipeline shared by scripts/capture-projection-golden.ts
 * (writes) and scripts/verify-projection-golden.ts (compares) — the
 * equivalence anchor of docs/agent-backend-design.md §6.4.
 *
 * Each fixture under scripts/fixtures/dsh/ runs through the DSH translator
 * (`createDshTranslator`, src/dsh-adapter/backend/translate.ts) feeding the
 * shared projector (`createChannelProjection`, src/channel/projection.ts) —
 * the pipeline the channel uses — twice:
 *   - replay: `apply(translateReplay(log), { replay: true })`, then every
 *     frame through `translateFrame`, then `settleStreaming()` — what
 *     /resume, rewind and a reattaching client produce;
 *   - live: `translateEvent` per durable event in order, then the same frames
 *     and settle — what an attached client accumulates.
 * The goldens were captured in Phase 0 from the single pre-split DSH reducer;
 * Phase 1 must reproduce them byte-for-byte.
 * The golden stores the replay snapshot in full and documents every place the
 * live snapshot differs (`liveRows` / `liveState` / `liveDiff`), each with the
 * reason it is legitimate; an unexplained difference fails both scripts. It
 * also keeps `liveTimeline`, the live view after every input, so transient
 * behaviour (spinner phases, when a thinking row folds) is pinned too.
 *
 * Determinism: the language is pinned to zh, debug logging is off, and
 * `Date.now` is replaced BEFORE the projection modules load by a clock that
 * starts at a fixed instant for every run and advances 1ms per call, so
 * `startedAt`/`durationMs`/`turnStart` are stable. Event and frame times come
 * from the fixtures, so TPS and peak/idle cost buckets are stable too.
 * Dependencies are stubs without Cordis: no tools registry (cards keep raw
 * text), no attachments, no IDE selections; notify, jobs, context-warning
 * hooks, the presenter scope (`calls.agent`) and the plugin renderer only
 * record their calls. The DSH pricing window is the production one.
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

process.env.DSH_TUI_LANG = 'zh'
delete process.env.DSH_TUI_DEBUG

const CLOCK_BASE = Date.UTC(2026, 0, 5, 0, 0, 0)
let clock = CLOCK_BASE
Date.now = () => clock++

const { createChannelProjection } = await import('../../src/channel/projection.js')
const { createDshTranslator, dshPricingWindow } = await import('../../src/dsh-adapter/backend/translate.js')
const { createInitialChannelView } = await import('../../src/dsh-adapter/channel/state.js')
const { FIXTURE_DIR, buildFixtures, staleFixtureFiles } = await import('../fixtures/dsh/generate.js')

type Translator = ReturnType<typeof createDshTranslator>
type ProjectionArgs = Parameters<typeof createChannelProjection>
type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

export interface GoldenVariant {
  /** Fixture base name under scripts/fixtures/dsh/. */
  readonly fixture: string
  /** Golden suffix; `default` writes `<fixture>.golden.json`. */
  readonly variant: string
  readonly thinkingFold: 'preview' | 'full'
}

/** Every golden: each fixture once with production defaults, plus the
 *  `full` thinking-fold setting where reasoning rows exist to fold. */
export function goldenVariants(): GoldenVariant[] {
  const variants: GoldenVariant[] = buildFixtures().map(fixture => ({ fixture: fixture.name, variant: 'default', thinkingFold: 'preview' }))
  variants.push({ fixture: 'v3-turns', variant: 'thinking-full', thinkingFold: 'full' })
  return variants
}

export const goldenPath = (variant: GoldenVariant): string =>
  join(FIXTURE_DIR, variant.variant === 'default' ? `${variant.fixture}.golden.json` : `${variant.fixture}.${variant.variant}.golden.json`)

/**
 * Where live may legitimately differ from replay. Anything else is a
 * projection inconsistency and must not be blessed into a golden.
 */
const LIVE_DIFFERENCE_REASONS: readonly { readonly pattern: RegExp; readonly fixtures?: readonly string[]; readonly reason: string }[] = [
  {
    pattern: /^rows\[\d+\]\.fresh$/u,
    reason: 'smooth-reveal flag: live tool cards and live-settled assistant text are fresh, replay paints settled history',
  },
  {
    pattern: /^calls\.notify(\[|$)/u,
    reason: 'a failed turn raises a toast only live; replay keeps just the notice row',
  },
  {
    pattern: /^calls\.checkContextWarning$/u,
    reason: 'the context-low warning is checked only after live completed turns',
  },
  {
    pattern: /^compaction(\.|$)/u,
    reason: 'an unmatched compaction/start opens the progress row only live; replay treats it as settled history',
  },
  {
    pattern: /^(rows|responseChars|tps|tpsSamples|nextRowId|turnStart)(\[|\.|$)/u,
    fixtures: ['compaction-legacy'],
    reason: 'prepareReplayEvents drops legacy assistant/chunk deltas already settled by a later assistant/message; live renders them first (rows keep the chunk seq, TPS is sampled from them, and the extra Date.now reads shift later stub-clock stamps)',
  },
]

const readJsonl = (path: string): unknown[] => {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return []
  }
  return raw.split('\n').filter(line => line.trim() !== '').map(line => JSON.parse(line) as unknown)
}

const toJson = (value: unknown): JsonValue => JSON.parse(JSON.stringify(value ?? null)) as JsonValue

interface Recorder {
  readonly calls: {
    notify: JsonValue[]
    jobsOnStarted: JsonValue[]
    jobsOnOutputSeen: JsonValue[]
    rendererRender: string[]
    checkContextWarning: number
    resetContextWarning: number
    agent: number
  }
}

interface Projected {
  readonly snapshot: JsonValue
  /** Live path only: one line per input; a replay batch is atomic, so replay has none. */
  readonly timeline: readonly string[]
}

function project(variant: GoldenVariant, mode: 'replay' | 'live'): Projected {
  clock = CLOCK_BASE
  const events = readJsonl(join(FIXTURE_DIR, `${variant.fixture}.jsonl`)) as Parameters<Translator['translateReplay']>[0]
  const frames = readJsonl(join(FIXTURE_DIR, `${variant.fixture}.frames.jsonl`)) as Parameters<Translator['translateFrame']>[0][]
  const recorder: Recorder = {
    calls: { notify: [], jobsOnStarted: [], jobsOnOutputSeen: [], rendererRender: [], checkContextWarning: 0, resetContextWarning: 0, agent: 0 },
  }
  const view = createInitialChannelView(
    { model: 'fixture-model-a', provider: 'fixture', cwd: '/fixture', agentPreset: 'ptc', thinkingFold: variant.thinkingFold },
    { agentId: 'fixture-agent', sessionId: 'fixture-session', mode: { id: 'normal', name: 'Normal' } as never, cwdDescription: '/fixture' },
  )
  const state: ProjectionArgs[0] = { ...view, emit: () => undefined }
  const rowIds = { value: 0 }
  const inputConvergence = { cancelInFlight: true }
  const translator = createDshTranslator({
    tools: () => undefined,
    scope: () => {
      recorder.calls.agent += 1
      return {}
    },
    attachments: () => undefined,
  })
  const deps: ProjectionArgs[1] = {
    rowIds,
    resetContextWarning: () => { recorder.calls.resetContextWarning += 1 },
    jobs: {
      onStarted: (id, command) => { recorder.calls.jobsOnStarted.push(toJson({ id, command })) },
      onOutputSeen: (id, text, at) => { recorder.calls.jobsOnOutputSeen.push(toJson({ id, text, at })) },
    },
    inputConvergence,
    checkContextWarning: () => { recorder.calls.checkContextWarning += 1 },
    notify: (text, options) => {
      recorder.calls.notify.push(toJson({ text, options }))
      return () => undefined
    },
    renderer: {
      render: (type, payload) => {
        recorder.calls.rendererRender.push(type)
        if (type !== 'fixture-plugin/note' || typeof payload !== 'object' || payload === null) return undefined
        const note = payload as { title?: unknown; lines?: unknown }
        return {
          title: typeof note.title === 'string' ? note.title : undefined,
          lines: Array.isArray(note.lines) ? note.lines.map(String) : [],
        }
      },
    },
    selectionAttached: () => undefined,
    pricingWindow: dshPricingWindow,
  }
  const projector = createChannelProjection(state, deps)
  // The transient view after each live input: spinner phase, open streaming
  // rows and live counters are behaviour the end snapshot cannot show (when a
  // thinking row folds, when the spinner leaves tool-use, …).
  const timeline: string[] = []
  const mark = (input: string): void => {
    if (mode === 'replay') return
    const streamingIds = state.rows.filter(row => row.streaming === true).map(row => row.id).join(',')
    const goal = state.goal === undefined ? '-' : `${state.goal.id}:${state.goal.phase}:${state.goal.roundsStarted}`
    timeline.push(`${input} | rows=${state.rows.length} streaming=[${streamingIds}] spin=${state.spinnerMode} working=${state.working ? 1 : 0} tools=${state.activeToolCount} chars=${state.responseChars} goal=${goal} todos=${state.todos.length} compaction=${state.compaction?.phase ?? '-'}`)
  }
  if (mode === 'replay') projector.apply(translator.translateReplay(events), { replay: true })
  else {
    for (const event of events) {
      projector.apply(translator.translateEvent(event), { replay: false })
      mark(`#${event.seq} ${event.type}`)
    }
  }
  for (const frame of frames) {
    projector.apply(translator.translateFrame(frame), { replay: false })
    mark(`frame r${frame.revision} ${frame.type} ${frame.attemptId}`)
  }
  projector.settleStreaming()
  mark('settleStreaming')
  const snapshot = toJson({
    rows: state.rows,
    tokens: state.tokens,
    lastUsage: state.lastUsage ?? null,
    contextSegments: state.contextSegments,
    contextWindow: state.contextWindow ?? null,
    reasoningEffort: state.reasoningEffort ?? null,
    model: state.model,
    sessionTitle: state.sessionTitle,
    sessionColor: state.sessionColor,
    goal: state.goal ?? null,
    todos: state.todos,
    compaction: state.compaction ?? null,
    working: state.working,
    cancelPending: state.cancelPending,
    turnStart: state.turnStart,
    activeToolCount: state.activeToolCount,
    spinnerMode: state.spinnerMode,
    responseChars: state.responseChars,
    lastUserText: state.lastUserText,
    tps: state.tps ?? null,
    tpsSamples: state.tpsSamples,
    mainCost: state.mainCost,
    nextRowId: rowIds.value,
    inputConvergence,
    calls: recorder.calls,
  })
  return { snapshot, timeline }
}

const isRecord = (value: unknown): value is Record<string, JsonValue> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** Leaf paths where two JSON values differ (`rows[3].tool.status`). */
export function diffPaths(a: unknown, b: unknown, path = ''): string[] {
  if (a === b) return []
  if (Array.isArray(a) && Array.isArray(b)) {
    const out: string[] = []
    for (let i = 0; i < Math.max(a.length, b.length); i++) out.push(...diffPaths(a[i], b[i], `${path}[${i}]`))
    return out
  }
  if (isRecord(a) && isRecord(b)) {
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()
    return keys.flatMap(key => diffPaths(a[key], b[key], path === '' ? key : `${path}.${key}`))
  }
  return [path === '' ? '(root)' : path]
}

/** Read the value at a `diffPaths` path, for readable mismatch reports. */
export function valueAt(root: unknown, path: string): unknown {
  if (path === '(root)') return root
  let value = root
  for (const part of path.match(/[^.[\]]+/gu) ?? []) {
    if (Array.isArray(value)) value = value[Number(part)]
    else if (isRecord(value)) value = value[part]
    else return undefined
  }
  return value
}

export interface GoldenBuild {
  readonly golden: JsonValue
  /** Live differences with no legitimate reason — a capture must not bless them. */
  readonly unexplained: readonly string[]
}

export function buildGolden(variant: GoldenVariant): GoldenBuild {
  const replay = project(variant, 'replay').snapshot
  const { snapshot: live, timeline } = project(variant, 'live')
  const unexplained: string[] = []
  const liveDiff = diffPaths(replay, live).map(path => {
    const rule = LIVE_DIFFERENCE_REASONS.find(candidate => candidate.pattern.test(path) && (candidate.fixtures === undefined || candidate.fixtures.includes(variant.fixture)))
    if (rule === undefined) unexplained.push(path)
    return { path, reason: rule?.reason ?? 'UNEXPLAINED' }
  })
  if (!isRecord(replay) || !isRecord(live)) throw new Error('projection snapshot is not an object')
  const liveState: Record<string, JsonValue> = {}
  for (const key of Object.keys(live)) {
    if (key !== 'rows' && diffPaths(replay[key], live[key]).length > 0) liveState[key] = live[key]
  }
  const rowsDiffer = diffPaths(replay.rows, live.rows).length > 0
  const golden = toJson({
    $comment: 'Generated by scripts/capture-projection-golden.ts from the fixture log (+ frames) beside this file; do not edit by hand. Top level = replay snapshot; liveRows/liveState = where the live path ends differently, each difference explained in liveDiff; liveTimeline = the live view after every input.',
    fixture: variant.fixture,
    variant: variant.variant,
    options: { thinkingFold: variant.thinkingFold, agentPreset: 'ptc', lang: 'zh', clockBase: CLOCK_BASE },
    ...replay,
    ...(rowsDiffer ? { liveRows: live.rows } : {}),
    ...(Object.keys(liveState).length > 0 ? { liveState } : {}),
    liveDiff,
    liveTimeline: timeline,
  })
  return { golden, unexplained }
}

export function readGolden(variant: GoldenVariant): unknown {
  try {
    return JSON.parse(readFileSync(goldenPath(variant), 'utf8')) as unknown
  } catch {
    return undefined
  }
}

export function writeGolden(variant: GoldenVariant, golden: JsonValue): void {
  writeFileSync(goldenPath(variant), `${JSON.stringify(golden, null, 2)}\n`)
}

/** Golden files on disk that no variant produces any more. */
export function orphanGoldens(): string[] {
  const expected = new Set(goldenVariants().map(goldenPath))
  return readdirSync(FIXTURE_DIR)
    .filter(name => name.endsWith('.golden.json'))
    .map(name => join(FIXTURE_DIR, name))
    .filter(path => !expected.has(path))
}

export { staleFixtureFiles }
