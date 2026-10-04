import React from 'react'
import { Box, Text } from '../../ui.js'
import type { WheelEvent } from '../../ink/events/wheel-event.js'
import type { ClickEvent } from '../../ink/events/click-event.js'
import { useAnimationFrame } from '../../ink/hooks/use-animation-frame.js'
import { WaveBand } from '../trajectory/WaveBand.js'
import { Ledger } from '../trajectory/Ledger.js'
import { Inspector } from '../trajectory/Inspector.js'
import { HotspotView, hotspotRows } from '../trajectory/HotspotView.js'
import { Divider } from '../design-system/Divider.js'
import { MOTION_TICK_MS } from '../../trajectory/motion.js'
import { truncateWidth } from '../../trajectory/format.js'
import { stringWidth } from '../../ink/stringWidth.js'
import { t } from '../../i18n.js'
import {
  aggregate,
  columnOfIndex,
  emptyTrajectory,
  inspectNode,
  projectWave,
  HOTSPOT_SORTS,
  WAVE_PROJECTIONS,
} from '../../dsh-adapter/trajectory/index.js'
import type { HotspotRow, HotspotSort, WaveProjection } from '../../dsh-adapter/types.js'
import { SidePanelRuntimeContext, useSidePanelTrajectory } from './SidePanelRuntimeContext.js'
import { usePanelInput } from './usePanelInput.js'
import type { PanelKeyHandler, PanelProps } from './types.js'

/**
 * The trajectory as a side-panel form of the fullscreen TrajectoryScene.
 *
 * This is deliberately a THIN ADAPTER, not a variant of the scene: the scene
 * is tuned end-to-end for owning the whole alternate screen (its own query
 * editor, exit chrome, page-sized chrome math against the terminal size), and
 * re-parameterizing every one of those decisions would risk drifting the
 * fullscreen behavior. Instead the panel composes the very same leaf regions
 * — WaveBand / Ledger / Inspector / HotspotView — over the same projection
 * utilities (aggregate / projectWave / inspectNode / columnOfIndex), so the
 * two forms can never disagree about what a session looks like.
 *
 * What changes for the narrow column: no query line, no exit chrome (the host
 * PanelBar owns ⤢ / Esc), Enter expands the inspector in place, and every
 * line is clipped to the panel width via truncateWidth — never bare slice.
 */

/** Inspector rows in the collapsed layout (header + 3 body lines). */
const INSPECTOR_ROWS = 4
/** Tabs row, the wake's two rows, the ledger/inspector divider, the hint. */
const CHROME_ROWS = 5

type TrajectoryView = 'timeline' | 'hotspot'

export function TrajectoryPanel({ width, height, focused, visible }: PanelProps): React.ReactNode {
  // The channel comes from the same runtime context the trajectory build
  // does. Reading it tolerantly (rather than via useSidePanelChannel, which
  // throws) keeps the component mountable in headless fallback probes.
  const channel = React.useContext(SidePanelRuntimeContext)?.channel
  const build = useSidePanelTrajectory()
  const nodes = build?.nodes
  const empty = nodes === undefined || nodes.length === 0

  // visible=false (inactive tab / collapsed sidebar) stops the motion clock:
  // zero animation-frame subscriptions, the store keeps folding underneath.
  const [ref, time] = useAnimationFrame(visible && !empty ? MOTION_TICK_MS : null)
  const tick = Math.floor(time / MOTION_TICK_MS)

  const [view, setView] = React.useState<TrajectoryView>('timeline')
  const [cursor, setCursor] = React.useState(0)
  const [hotCursor, setHotCursor] = React.useState(0)
  const [projection, setProjection] = React.useState<WaveProjection>('compressed')
  const [sort, setSort] = React.useState<HotspotSort>('duration')
  const [expanded, setExpanded] = React.useState(false)
  const [inspectScroll, setInspectScroll] = React.useState(0)
  const [switchTick, setSwitchTick] = React.useState(0)
  const [alertTick, setAlertTick] = React.useState(0)
  const [arrivalTick, setArrivalTick] = React.useState(0)
  const [arrivalFrom, setArrivalFrom] = React.useState(Number.MAX_SAFE_INTEGER)
  /** Cursor pinned to the tail until the user scrolls away from it. */
  const [follow, setFollow] = React.useState(true)
  const [hoverTab, setHoverTab] = React.useState<'timeline' | 'hotspot' | null>(null)
  const [hoverAxis, setHoverAxis] = React.useState(false)

  // ── projection (no query in the panel form: the filtered list is the
  //    ledger itself, and the column index map is the identity) ─────────────
  const filtered = nodes ?? []
  const indexes = React.useMemo(() => filtered.map((_, index) => index), [filtered.length])

  // `emptyTrajectory()` keeps the memo body total: hooks run before the
  // empty-state early return, so the aggregators must tolerate a missing
  // build rather than throwing on first paint.
  const agg = React.useMemo(
    // oxlint-disable-next-line react-hooks/exhaustive-deps
    () => aggregate(build ?? emptyTrajectory(), sort),
    [build, filtered.length, sort],
  )

  // ── arrival + alert detection (same contract as the scene) ───────────────
  const seenRef = React.useRef(0)
  const errorsRef = React.useRef(0)
  React.useEffect(() => {
    if (empty) return
    if (filtered.length > seenRef.current) {
      setArrivalFrom(seenRef.current)
      setArrivalTick(tick)
      seenRef.current = filtered.length
      if (follow) setCursor(Math.max(0, filtered.length - 1))
    }
    if (agg.totals.errors > errorsRef.current) {
      errorsRef.current = agg.totals.errors
      setAlertTick(tick)
    }
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [filtered.length, agg.totals.errors, tick, follow])

  // ── geometry (all against the panel's own width/height, never the screen)
  const contentWidth = Math.max(1, width - 2)
  const bandWidth = contentWidth
  const inspectorRows = expanded
    ? Math.max(4, height - CHROME_ROWS - 1)
    : Math.max(3, Math.min(INSPECTOR_ROWS, height - CHROME_ROWS - 2))
  const ledgerRows = Math.max(1, height - CHROME_ROWS - inspectorRows)

  const clampedCursor = filtered.length === 0 ? 0 : Math.min(cursor, filtered.length - 1)
  const windowStart = Math.max(
    0,
    Math.min(clampedCursor - Math.floor(ledgerRows / 2), filtered.length - ledgerRows),
  )

  const band = React.useMemo(
    // oxlint-disable-next-line react-hooks/exhaustive-deps
    () => projectWave(nodes ?? emptyTrajectory().nodes, bandWidth, projection),
    [nodes, filtered.length, bandWidth, projection],
  )

  const focusedNode = filtered[clampedCursor]
  const detail = React.useMemo(
    () =>
      focusedNode === undefined || channel === undefined
        ? undefined
        : inspectNode(focusedNode, channel.traceEvents()),
    [focusedNode, channel],
  )

  // ── navigation helpers (mirroring the scene's semantics) ─────────────────
  const move = React.useCallback(
    (delta: number) => {
      setExpanded(false)
      setInspectScroll(0)
      setCursor(previous => {
        const next = Math.max(0, Math.min(filtered.length - 1, previous + delta))
        setFollow(next >= filtered.length - 1)
        return next
      })
    },
    [filtered.length],
  )

  const switchView = React.useCallback((next: TrajectoryView) => {
    setView(next)
    setSwitchTick(tick)
    setExpanded(false)
    setInspectScroll(0)
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [tick])

  /** Jump back to the timeline positioned on a hotspot group's first member. */
  const jumpFromHotspot = React.useCallback(
    (row: HotspotRow | undefined) => {
      switchView('timeline')
      if (row !== undefined) {
        const target = indexes.indexOf(row.firstIndex)
        setCursor(target >= 0 ? target : 0)
        setFollow(false)
      }
    },
    [indexes, switchView],
  )

  const jumpTo = React.useCallback(
    (index: number) => {
      setInspectScroll(0)
      setCursor(index)
      setFollow(index >= filtered.length - 1)
    },
    [filtered.length],
  )

  const handleWheel = React.useCallback(
    (event: WheelEvent): void => {
      if (view === 'hotspot') {
        const total = hotspotRows(agg).length
        const direction = event.deltaY >= 0 ? 1 : -1
        setHotCursor(previous => Math.max(0, Math.min(total - 1, previous + direction)))
        return
      }
      if (expanded) {
        const direction = event.deltaY >= 0 ? 1 : -1
        setInspectScroll(previous => Math.max(0, previous + direction * Math.max(1, inspectorRows - 2)))
        return
      }
      move(event.deltaY)
    },
    [view, agg, expanded, inspectorRows, move],
  )

  // ── keys (v2.1 panel contract: true = consumed; Esc is NEVER consumed —
  //    the host owns the return-to-chat key) ────────────────────────────────
  const onKey = React.useCallback<PanelKeyHandler>(
    (input, key) => {
      if (key.escape) return false
      // Tab toggles the two views. ←/→ are deliberately NOT consumed: the
      // host owns them for cycling the ACTIVE PANEL (v2.1 contract — the
      // user expects ←/→ to switch panels everywhere in the column, and the
      // tabs above are already the mouse path). ink delivers Tab as
      // input='' + key.tab (no '\t' character) and the host's
      // SidePanelKeyFlags does not carry a tab field, so both shapes count.
      const tabKey = (key as { readonly tab?: boolean }).tab === true || input === '\t'
      if (tabKey) {
        switchView(view === 'timeline' ? 'hotspot' : 'timeline')
        return true
      }
      if (view === 'hotspot') {
        const total = hotspotRows(agg).length
        if (key.upArrow) {
          setHotCursor(previous => Math.max(0, previous - 1))
          return true
        }
        if (key.downArrow) {
          setHotCursor(previous => Math.min(total - 1, previous + 1))
          return true
        }
        if (input === 't' && !key.ctrl && !key.meta) {
          setSort(previous => HOTSPOT_SORTS[(HOTSPOT_SORTS.indexOf(previous) + 1) % HOTSPOT_SORTS.length]!)
          setSwitchTick(tick)
          return true
        }
        if (key.return_) {
          jumpFromHotspot(hotspotRows(agg)[hotCursor])
          return true
        }
        return false
      }
      if (key.upArrow) {
        move(-1)
        return true
      }
      if (key.downArrow) {
        move(1)
        return true
      }
      if (key.pageUp) {
        move(-ledgerRows)
        return true
      }
      if (key.pageDown) {
        move(ledgerRows)
        return true
      }
      if (input === 'm' && !key.ctrl && !key.meta) {
        setProjection(
          previous => WAVE_PROJECTIONS[(WAVE_PROJECTIONS.indexOf(previous) + 1) % WAVE_PROJECTIONS.length]!,
        )
        setSwitchTick(tick)
        return true
      }
      if (key.return_) {
        setExpanded(previous => !previous)
        setInspectScroll(0)
        return true
      }
      if (expanded && (input === 'j' || input === 'k')) {
        setInspectScroll(previous =>
          Math.max(0, previous + (input === 'j' ? inspectorRows - 2 : -(inspectorRows - 2))),
        )
        return true
      }
      return false
      // oxlint-disable-next-line react-hooks/exhaustive-deps
    },
    [view, agg, hotCursor, expanded, inspectorRows, ledgerRows, move, switchView, jumpFromHotspot, tick],
  )
  usePanelInput(onKey, { active: focused && visible })

  // ── unsupported state (design §④ 轨迹裁决) ─────────────────────────────────
  // The channel's trajectorySource() report decides, never the node count:
  // a backend that mounted no source (Claude today) must not masquerade as
  // "no turns yet". The copy names the backend's gap, promises no future
  // data, and the ⤢ outlet is gone (SidePanelColumn hides it) — the
  // fullscreen line below explains why instead of leaving a dead button.
  // Tolerant read: headless fallback probes mount this panel with a partial
  // channel, and absence of the report means "legacy channel" = old behavior.
  const source = channel?.trajectorySource?.()
  if (source === 'unsupported') {
    // Copy selection only (the STATE above is structural): the Claude
    // backend gets its specifically-worded line, any other source-less
    // backend the generic one.
    const unsupportedLine =
      channel?.backendCapabilities?.backendId === 'claude'
        ? t('trajectory-unsupported-claude')
        : t('trajectory-unsupported')
    return (
      <Box ref={ref} flexDirection="column" width="100%" paddingX={1}>
        <Box marginTop={1}>
          <Text color="subtle" wrap="truncate">
            {truncateWidth(unsupportedLine, contentWidth)}
          </Text>
        </Box>
        <Box marginTop={1}>
          <Text dimColor italic wrap="truncate">
            {truncateWidth(t('trajectory-unsupported-fullscreen'), contentWidth)}
          </Text>
        </Box>
      </Box>
    )
  }

  // ── empty state (supported + no events yet — the ONLY state allowed to
  //    promise data once turns happen) ────────────────────────────────────────
  if (empty) {
    return (
      <Box ref={ref} flexDirection="column" width="100%" paddingX={1}>
        <Box marginTop={1}>
          <Text color="subtle" wrap="truncate">
            {t('panel-trajectory-empty')}
          </Text>
        </Box>
        <Box marginTop={1}>
          <Text dimColor italic wrap="truncate">
            {truncateWidth(t('panel-trajectory-hint'), contentWidth)}
          </Text>
        </Box>
      </Box>
    )
  }

  // ── tabs row: two clickable segments + the axis label (cycle on click) ───
  const tabTimelineText = `${view === 'timeline' ? '●' : '○'} ${t('traj-tab-timeline')}`
  const tabHotspotText = `${view === 'hotspot' ? '●' : '○'} ${t('traj-tab-hotspot')}`
  const axisText = view === 'hotspot' ? t(`traj-sort-${sort}`) : t(`traj-proj-${projection}`)
  const axisRoom = contentWidth - stringWidth(tabTimelineText) - stringWidth(tabHotspotText) - 3
  const axisShown = axisRoom >= stringWidth(axisText) ? axisText : ''
  const tabs = (
    <Box width="100%" height={1} flexShrink={0}>
      <Box
        flexShrink={0}
        width={stringWidth(tabTimelineText)}
        onClick={(event: ClickEvent) => {
          event.stopImmediatePropagation()
          switchView('timeline')
        }}
        onMouseEnter={(): void => setHoverTab('timeline')}
        onMouseLeave={(): void => setHoverTab(previous => (previous === 'timeline' ? null : previous))}
      >
        <Text
          color={view === 'timeline' ? 'permission' : hoverTab === 'timeline' ? 'text' : 'subtle'}
          bold={view === 'timeline'}
        >
          {tabTimelineText}
        </Text>
      </Box>
      <Box
        flexShrink={0}
        width={stringWidth(tabHotspotText)}
        onClick={(event: ClickEvent) => {
          event.stopImmediatePropagation()
          switchView('hotspot')
        }}
        onMouseEnter={(): void => setHoverTab('hotspot')}
        onMouseLeave={(): void => setHoverTab(previous => (previous === 'hotspot' ? null : previous))}
      >
        <Text
          color={view === 'hotspot' ? 'permission' : hoverTab === 'hotspot' ? 'text' : 'subtle'}
          bold={view === 'hotspot'}
        >
          {tabHotspotText}
        </Text>
      </Box>
      <Box flexGrow={1} flexShrink={1}>
        <Text> </Text>
      </Box>
      {axisShown !== '' && (
        <Box
          flexShrink={0}
          width={stringWidth(axisShown) + 1}
          onClick={(event: ClickEvent) => {
            event.stopImmediatePropagation()
            if (view === 'hotspot') {
              setSort(previous => HOTSPOT_SORTS[(HOTSPOT_SORTS.indexOf(previous) + 1) % HOTSPOT_SORTS.length]!)
            } else {
              setProjection(
                previous =>
                  WAVE_PROJECTIONS[(WAVE_PROJECTIONS.indexOf(previous) + 1) % WAVE_PROJECTIONS.length]!,
              )
            }
            setSwitchTick(tick)
          }}
          onMouseEnter={(): void => setHoverAxis(true)}
          onMouseLeave={(): void => setHoverAxis(false)}
        >
          <Text color={hoverAxis ? 'text' : 'subtle'}>{axisShown}</Text>
        </Box>
      )}
    </Box>
  )

  return (
    <Box ref={ref} flexDirection="column" width="100%" height={height} paddingX={1} overflow="hidden">
      {tabs}
      <WaveBand
        band={band}
        width={bandWidth}
        cursorColumn={columnOfIndex(band, clampedCursor)}
        viewportStart={columnOfIndex(band, windowStart)}
        viewportEnd={columnOfIndex(band, Math.min(filtered.length - 1, windowStart + ledgerRows - 1))}
        tick={tick}
        alertTick={alertTick}
        onColumnClick={(column, event) => {
          event.stopImmediatePropagation()
          const nodeIndex = band.buckets[column]?.firstIndex ?? -1
          if (nodeIndex < 0) return
          const target = indexes.indexOf(nodeIndex)
          if (target >= 0) jumpTo(target)
        }}
      />
      {/* The wheel host: every Box flavor drops onWheel into the style rest,
          so the literal ink-box element is written directly (same wall the
          scene hit). */}
      <ink-box
        style={{ flexDirection: 'column', flexGrow: 1, flexShrink: 1, overflow: 'hidden', width: '100%' }}
        onWheel={handleWheel}
      >
        {view === 'timeline' ? (
          <>
            <Ledger
              rows={filtered}
              start={windowStart}
              height={ledgerRows}
              cursor={clampedCursor}
              width={contentWidth}
              tick={tick}
              arrivalTick={arrivalTick}
              arrivalFrom={arrivalFrom}
              onRowClick={(index, event) => {
                event.stopImmediatePropagation()
                jumpTo(index)
              }}
            />
            <Divider color="permission" width={bandWidth} />
            <Inspector
              node={focusedNode}
              detail={detail}
              height={inspectorRows}
              width={contentWidth}
              expanded={expanded}
              scroll={inspectScroll}
            />
          </>
        ) : (
          <HotspotView
            agg={agg}
            sort={sort}
            width={contentWidth}
            height={ledgerRows + inspectorRows + 1}
            cursor={hotCursor}
            tick={tick}
            switchTick={switchTick}
            onRowClick={index => jumpFromHotspot(hotspotRows(agg)[index])}
          />
        )}
      </ink-box>
      <Box width="100%" height={1} flexShrink={0}>
        <Text dimColor italic wrap="truncate">
          {truncateWidth(t('panel-trajectory-hint'), contentWidth)}
        </Text>
      </Box>
    </Box>
  )
}

/** Re-exported for the host/verify fixtures (same union the scene exports). */
export type { TrajectoryView }
