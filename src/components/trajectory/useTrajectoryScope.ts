/**
 * The scope state + scoped data plane shared by the trajectory scene and
 * the side panel.
 *
 * The hook owns three things the two surfaces would otherwise drift on:
 *
 * - the lane roster, read tolerantly (trajectoryLanes is an optional
 *   capability — a source without lane attribution offers no filter);
 * - the scoped node list + event snapshot every downstream region
 *   (query, wave, ledger, inspector, hotspot) renders from — ONE
 *   substitution point, so a scoped view can never show the session's
 *   wave over the lane's ledger;
 * - the lane fold itself, kept incremental per scope exactly the way Chat
 *   keeps the main one: extended during render against the lane snapshot's
 *   prefix identity, refolded from scratch when the scope switches.
 */

import React from 'react'
import { emptyTrajectory, extendTrajectory, type RawTrajEvent, type TrajBuild, type TrajectoryLane } from '../../dsh-adapter/trajectory/index.js'
import type { TrajNode } from '../../dsh-adapter/types.js'
import type { ChannelUi } from '../../adapter/channel/ui-policy.js'
import { drillScopeFrom, nextScope, type TrajScope } from './scope.js'

const NO_EVENTS: readonly RawTrajEvent[] = []
const NO_LANES: readonly TrajectoryLane[] = []

/** One scoped data plane: the rows to render and the log to inspect from. */
export interface ScopedTrajectory {
  readonly nodes: readonly TrajNode[]
  readonly events: readonly RawTrajEvent[]
  /**
   * The scoped build the aggregators read. For lane scopes this is the
   * lane's own incremental build; for parent-turn a derived view over the
   * main build (its nodes filtered, its timing slots shared); for session
   * the main build itself, untouched.
   */
  readonly build: TrajBuild
}

export function useTrajectoryScope(channel: ChannelUi | undefined, build: TrajBuild): {
  readonly scope: TrajScope
  readonly lanes: readonly TrajectoryLane[]
  readonly scoped: ScopedTrajectory
  /** The drill key / chip click: drill from a focused row, or cycle. */
  drill(node: TrajNode | undefined): void
  /** Esc's first layer: true when a non-session scope consumed the press. */
  popScope(): boolean
} {
  const [scope, setScope] = React.useState<TrajScope>({ kind: 'session' })
  // The roster rebuilds when the main build grows (lanes register on
  // subagent.start, which appends to the main log) — the same staleness
  // contract every other per-render read follows.
  const lanes = React.useMemo(
    // oxlint-disable-next-line react-hooks/exhaustive-deps
    () => (channel !== undefined && typeof channel.trajectoryLanes === 'function' ? channel.trajectoryLanes() : NO_LANES),
    [channel, build],
  )
  /** The lane fold, keyed by scope so a switch refolds from scratch. */
  const laneBuildRef = React.useRef<{ readonly key: string; build: TrajBuild | null }>({ key: '', build: null })

  // The parent-turn view is derived from the main build; memoized so the
  // animation tick does not refilter the ledger and invalidate every
  // aggregate keyed on the scoped build.
  const parentTurn = scope.kind === 'parent-turn' ? scope.turn : undefined
  const parentTurnBuild = React.useMemo((): TrajBuild | undefined => {
    if (parentTurn === undefined) return undefined
    const filtered = build.nodes.filter(node => node.turn === parentTurn)
    return { source: build.source, nodes: filtered, timing: build.timing, counts: build.counts, state: build.state }
  }, [build, parentTurn])

  let nodes: readonly TrajNode[] = build.nodes
  let events: readonly RawTrajEvent[] = NO_EVENTS
  let scopedBuild: TrajBuild = build
  if (scope.kind === 'agent' || scope.kind === 'descendants') {
    const descendants = scope.kind === 'descendants'
    const key = scope.agentId + ':' + (descendants ? 'd' : 'a')
    if (laneBuildRef.current.key !== key) laneBuildRef.current = { key, build: null }
    // Per-render incremental extend (the lane's events grow without the
    // main build changing — a memo keyed on the main build would never see
    // the tail; Chat's own main fold follows the same render-time pattern).
    const snapshot =
      channel !== undefined && typeof channel.trajectoryLaneEvents === 'function'
        ? (channel.trajectoryLaneEvents(scope.agentId, descendants) as readonly RawTrajEvent[])
        : NO_EVENTS
    laneBuildRef.current.build = extendTrajectory(laneBuildRef.current.build, snapshot)
    scopedBuild = laneBuildRef.current.build ?? emptyTrajectory()
    nodes = scopedBuild.nodes
    events = snapshot
  } else if (parentTurnBuild !== undefined) {
    // The main lane's rows of the delegating turn: a derived view (the
    // timing slots stay the main build's — keyed turn:step, they answer
    // this turn's TTFT/decode questions exactly).
    nodes = parentTurnBuild.nodes
    events = (channel?.traceEvents?.() ?? NO_EVENTS) as readonly RawTrajEvent[]
    scopedBuild = parentTurnBuild
  } else {
    events = (channel?.traceEvents?.() ?? NO_EVENTS) as readonly RawTrajEvent[]
  }

  const drill = React.useCallback(
    (node: TrajNode | undefined): void => {
      setScope(previous => {
        if (previous.kind === 'session') return drillScopeFrom(node, lanes) ?? previous
        return nextScope(previous, lanes, build.nodes)
      })
    },
    [lanes, build],
  )

  const popScope = React.useCallback((): boolean => {
    if (scope.kind === 'session') return false
    setScope({ kind: 'session' })
    return true
  }, [scope])

  return { scope, lanes, scoped: { nodes, events, build: scopedBuild }, drill, popScope }
}
