/**
 * Live Session facade: exclusive seq, inclusive source slice, lineage, and
 * the alpha.4 fork/end-seed trap (child snapshot length cannot determine the cut).
 *
 * Run: node --import tsx/esm scripts/verify-live-session.ts
 * Real newest-upstream seam (requires the checked-out upstream source aliases):
 *   TSX_TSCONFIG_PATH="$DSH_HARNESS_SOURCE_ROOT/tsconfig.base.json" \
 *     node --import tsx/esm scripts/verify-live-session.ts --real-upstream
 */
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  appendInterruptedTurnEnd,
  liveSessionCreateOptions,
  liveSessionOffset,
  liveSessionPhysicalSeedLength,
  liveSessionSeedMetadata,
  sliceLiveSessionSeed,
  snapshotLiveSessionEvents,
} from '../src/dsh-adapter/compat/liveSession.js'

let failed = 0
function check(name: string, ok: boolean, extra = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed += 1
}

const ev = (seq: number, type: string) => ({ seq, time: seq, type, data: { turn: 0 } })
type OptionsView = {
  readonly meta: Record<string, unknown>
  readonly inheritedEventCount?: unknown
}

interface UpstreamSessionView {
  readonly header: Record<string, unknown>
  readonly inheritedEventCount: number
  readonly seq: number
  append(type: string, data: Record<string, unknown>): unknown
  snapshotEvents(fromSeq?: number, toSeqExclusive?: number): readonly {
    readonly type: string
    readonly seq: number
  }[]
  ownEvents(): readonly { readonly type: string; readonly seq: number }[]
}

interface UpstreamSessionModule {
  readonly SESSION_FORMAT_VERSION: number
  SessionId(value: string): unknown
  SessionLogOffset(value: number): number
  readonly Session: {
    create(
      id: unknown,
      seed?: readonly unknown[],
      header?: Record<string, unknown>,
      inheritedEventCount?: number,
    ): UpstreamSessionView
  }
}

const rc2 = {
  seq: 3,
  events: [ev(0, 'turn/start'), ev(1, 'user/message'), ev(2, 'turn/end')],
  header: { seedLength: 3, parentSession: 'parent' },
}

const alpha4 = {
  seq: 3,
  header: { isSeeded: true, parentSession: 'parent' },
  inheritedEventCount: 3,
  snapshotEvents() {
    return this._log
  },
  _log: [ev(0, 'turn/start'), ev(1, 'user/message'), ev(2, 'turn/end')],
}

function throwsMatching(run: () => unknown, pattern: RegExp): boolean {
  try {
    run()
    return false
  } catch (error) {
    return error instanceof Error && pattern.test(error.message)
  }
}

check('rc2 snapshot uses events', snapshotLiveSessionEvents(rc2).length === 3)
check('alpha4 snapshot uses snapshotEvents', snapshotLiveSessionEvents(alpha4).length === 3)
check('empty seq is exclusive 0', liveSessionOffset({ seq: 0, events: [] }) === 0)
check('seq is exclusive offset not last event seq', liveSessionOffset(rc2) === 3 && rc2.events.at(-1)!.seq === 2)
check(
  'invalid snapshot result fails loudly',
  throwsMatching(() => snapshotLiveSessionEvents({ snapshotEvents: () => ({}) }), /did not return an array/),
)
check(
  'missing live log API fails loudly',
  throwsMatching(() => snapshotLiveSessionEvents({ header: {} }), /neither snapshotEvents\(\) nor events/),
)

const whole = sliceLiveSessionSeed(alpha4)
check('omitted boundary copies whole source log', whole.length === 3 && whole[2]!.seq === 2)
const cut = sliceLiveSessionSeed(alpha4, 2)
check('inclusive boundary keeps seq <= boundary', cut.length === 3 && cut[2]!.seq === 2)
let pastEnd = false
try {
  sliceLiveSessionSeed(alpha4, 3)
} catch (error) {
  pastEnd = error instanceof Error && error.message.includes('does not exist')
}
check('boundary at exclusive seq is rejected', pastEnd)
check(
  'snapshot length must match exclusive seq',
  throwsMatching(
    () => sliceLiveSessionSeed({ seq: 4, events: rc2.events }),
    /snapshot length 3 does not match exclusive seq 4/,
  ),
)
check(
  'boundary must name the contiguous event at that index',
  throwsMatching(
    () => sliceLiveSessionSeed({ seq: 3, events: [ev(0, 'turn/start'), ev(7, 'user/message'), ev(2, 'turn/end')] }, 1),
    /does not match a contiguous event seq/,
  ),
)

const childSnapshot = [...alpha4._log, ev(3, 'session/end-seed')]
check(
  'child snapshot with end-seed is longer than inherited cut',
  childSnapshot.length !== alpha4.inheritedEventCount
    && childSnapshot.length === 4
    && whole.length === alpha4.inheritedEventCount,
)

let openTurn = false
try {
  sliceLiveSessionSeed({ seq: 2, events: [ev(0, 'turn/start'), ev(1, 'user/message')] }, 1)
} catch (error) {
  openTurn = error instanceof Error && error.message.includes('open turn')
}
check('open-turn slice is rejected', openTurn)
check(
  'omitted-boundary whole open turn is rejected',
  throwsMatching(
    () => sliceLiveSessionSeed({ seq: 2, events: [ev(0, 'turn/start'), ev(1, 'user/message')] }),
    /open turn/,
  ),
)

const inheritedRc2 = liveSessionSeedMetadata(rc2, 3)
check('rc2 inherited uses seedLength', inheritedRc2.meta.seedLength === 3 && inheritedRc2.inheritedEventCount === undefined)

const inheritedA4 = liveSessionSeedMetadata(alpha4, 3)
check(
  'alpha4 inherited uses isSeeded + inheritedEventCount',
  inheritedA4.meta.isSeeded === true && inheritedA4.inheritedEventCount === 3,
)

check('physical seedLength from live alpha4 seeded session', liveSessionPhysicalSeedLength(alpha4) === 3)
check('physical seedLength omitted for unseeded live session', liveSessionPhysicalSeedLength({ header: { isSeeded: false } }) === undefined)
check(
  'seeded live session never invents a missing cut',
  liveSessionPhysicalSeedLength({ header: { isSeeded: true } }) === undefined,
)

const rc2Options = liveSessionCreateOptions({
  sessionId: 'child-rc2' as never,
  seed: rc2.events as never,
  runtimeSession: rc2,
  inheritedCount: 3,
  cwd: '/tmp',
  parentSession: 'parent' as never,
  agentOptions: {},
}) as unknown as OptionsView
check(
  'rc2 create options keep lineage in meta.seedLength',
  rc2Options.meta.seedLength === 3
    && rc2Options.meta.isSeeded === undefined
    && rc2Options.inheritedEventCount === undefined,
)

const alpha4Options = liveSessionCreateOptions({
  sessionId: 'child-alpha4' as never,
  seed: alpha4._log as never,
  runtimeSession: alpha4,
  inheritedCount: 3,
  cwd: '/tmp',
  parentSession: 'parent' as never,
  agentOptions: {},
}) as unknown as OptionsView
check(
  'alpha4 create options keep exact top-level inherited cut',
  alpha4Options.meta.isSeeded === true
    && alpha4Options.meta.seedLength === undefined
    && alpha4Options.inheritedEventCount === 3,
)

const independentRc2Options = liveSessionCreateOptions({
  sessionId: 'independent-rc2' as never,
  seed: rc2.events as never,
  runtimeSession: rc2,
  inheritedCount: 3,
  cwd: '/tmp',
  agentOptions: {},
}) as unknown as OptionsView
check(
  'rc2 independent root keeps seed ownership without parent lineage',
  independentRc2Options.meta.seedLength === 3
    && independentRc2Options.meta.parentSession === undefined,
)

const independentA4Options = liveSessionCreateOptions({
  sessionId: 'independent-alpha4' as never,
  seed: alpha4._log as never,
  runtimeSession: alpha4,
  inheritedCount: 3,
  cwd: '/tmp',
  agentOptions: {},
}) as unknown as OptionsView
check(
  'alpha4 independent root keeps seed ownership without parent lineage',
  independentA4Options.meta.isSeeded === true
    && independentA4Options.inheritedEventCount === 3
    && independentA4Options.meta.parentSession === undefined,
)

const kept = [ev(0, 'turn/start'), ev(1, 'user/message')]
const inheritedBeforeCloser = kept.length
appendInterruptedTurnEnd(kept as never, 0)
const keptOptions = liveSessionCreateOptions({
  sessionId: 'child-closed' as never,
  seed: kept as never,
  runtimeSession: alpha4,
  inheritedCount: inheritedBeforeCloser,
  cwd: '/tmp',
  parentSession: 'parent' as never,
  agentOptions: {},
}) as unknown as OptionsView
check(
  'synthetic closer is child-owned, not part of inherited cut',
  kept.length === inheritedBeforeCloser + 1
    && kept.at(-1)?.type === 'turn/end'
    && keptOptions.inheritedEventCount === inheritedBeforeCloser,
)

async function verifyRealUpstreamSession(): Promise<void> {
  const sourceRoot = process.env.DSH_HARNESS_SOURCE_ROOT
  if (sourceRoot === undefined || sourceRoot.length === 0) {
    throw new Error('--real-upstream requires DSH_HARNESS_SOURCE_ROOT')
  }
  if (process.env.TSX_TSCONFIG_PATH === undefined) {
    throw new Error('--real-upstream requires TSX_TSCONFIG_PATH for upstream workspace source aliases')
  }

  const sessionEntry = pathToFileURL(resolve(sourceRoot, 'packages/core/session/src/index.ts')).href
  const upstream = await import(sessionEntry) as unknown as UpstreamSessionModule

  const parentId = upstream.SessionId('dsh-tui-real-upstream-parent')
  const source = upstream.Session.create(parentId)
  source.append('turn/start', { turn: 1 })
  source.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

  const seed = sliceLiveSessionSeed(source)
  check(
    'real upstream source slice keeps one closed turn',
    seed.length === 2 && seed[0]?.type === 'turn/start' && seed[1]?.type === 'turn/end',
  )

  const childId = upstream.SessionId('dsh-tui-real-upstream-child')
  const request = liveSessionCreateOptions({
    sessionId: childId as never,
    seed,
    runtimeSession: source,
    inheritedCount: seed.length,
    cwd: process.cwd(),
    parentSession: parentId as never,
    agentOptions: {},
  }) as unknown as {
    readonly sessionId: unknown
    readonly seed: readonly unknown[]
    readonly meta: Record<string, unknown>
    readonly inheritedEventCount?: unknown
  }

  check(
    'real upstream create options use isSeeded and exact inherited count',
    request.meta['isSeeded'] === true
      && request.meta['seedLength'] === undefined
      && request.inheritedEventCount === 2,
  )

  const header = {
    version: upstream.SESSION_FORMAT_VERSION,
    id: request.sessionId,
    createdAt: Date.now(),
    cwd: request.meta['cwd'],
    parentSession: request.meta['parentSession'],
    isSeeded: request.meta['isSeeded'],
  }
  const child = upstream.Session.create(
    request.sessionId,
    request.seed,
    header,
    upstream.SessionLogOffset(Number(request.inheritedEventCount)),
  )
  const childSnapshot = snapshotLiveSessionEvents(child)
  const childOwnEvents = child.ownEvents()

  check(
    'real upstream Session accepts adapter create options',
    child.header['isSeeded'] === true
      && child.inheritedEventCount === 2
      && child.seq === 3,
  )
  check(
    'real upstream Session keeps end-seed child-owned',
    childSnapshot.at(-1)?.type === 'session/end-seed'
      && childOwnEvents.length === 1
      && childOwnEvents[0]?.type === 'session/end-seed',
  )
  check(
    'real upstream physical seed cut remains inherited prefix length',
    liveSessionPhysicalSeedLength(child) === 2,
  )
}

if (process.argv.includes('--real-upstream')) await verifyRealUpstreamSession()

process.exit(failed === 0 ? 0 : 1)
