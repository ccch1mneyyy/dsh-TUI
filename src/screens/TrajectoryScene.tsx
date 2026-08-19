import React from 'react'
import { Box, Text, useInput, useTerminalSize } from '../ui.js'
import { useAnimationFrame } from '../ink/hooks/use-animation-frame.js'
import { Divider } from '../components/design-system/Divider.js'
import { HintLine } from '../components/design-system/HintLine.js'
import { WaveBand } from '../components/trajectory/WaveBand.js'
import { Ledger } from '../components/trajectory/Ledger.js'
import { Inspector } from '../components/trajectory/Inspector.js'
import { HotspotView, hotspotRows } from '../components/trajectory/HotspotView.js'
import { applyQuery, parseQuery } from '../trajectory/query.js'
import { MOTION_TICK_MS } from '../trajectory/motion.js'
import { formatDuration, formatTokens, truncateWidth } from '../trajectory/format.js'
import { stringWidth } from '../ink/stringWidth.js'
import { t } from '../i18n.js'
import {
  aggregate,
  burstErrors,
  columnOfIndex,
  inspectNode,
  projectWave,
  type TrajBuild,
} from '../dsh-adapter/trajectory/index.js'
import { HOTSPOT_SORTS, WAVE_PROJECTIONS } from '../dsh-adapter/trajectory/index.js'
import type { Channel } from '../dsh-adapter/channel.js'
import type { HotspotSort, WaveProjection } from '../dsh-adapter/types.js'

/**
 * The trajectory scene — the session's own screen.
 *
 * Rather than carving a panel out of the conversation, the trajectory takes
 * the whole terminal the way `less`, `fzf` and `lazygit` do, and gives it back
 * untouched on exit. That is not only a layout choice: the alternate screen
 * has no scrollback, so none of the frame churn this view generates can reach
 * the transcript — the inline shrink-frame path that once deposited UI copies
 * into scrollback (issues #38/#39/#19/#10) is structurally out of reach here.
 *
 * Four regions, top to bottom: the header, the wake (whole session as one
 * band), the ledger, and the inspector. Every region except the ledger has a
 * fixed height, so moving the cursor never resizes the frame.
 */

/** Inspector height in the default (unexpanded) layout. */
const INSPECTOR_ROWS = 6
/**
 * Rows the ledger does not get: header, tabs, the wake's two rows, one blank
 * line under the wake, the hint line, and one blank line above it.
 *
 * The two blank lines are deliberate. A view that fills every row edge to edge
 * reads as pressure regardless of how good the individual rows are; giving the
 * chrome and the content a line of ground between them costs two rows out of
 * thirty and buys the whole screen room to breathe.
 */
const CHROME_ROWS = 2 + 2 + 1 + 1 + 1

export type TrajectoryView = 'timeline' | 'hotspot'

export function TrajectoryScene({
  channel,
  build,
  onClose,
}: {
  channel: Channel
  /**
   * The session projection, folded by the host. Passing it in rather than
   * folding here means the chat chrome and the scene share one build, so
   * opening the scene costs no work at all.
   */
  build: TrajBuild
  /** Leave the scene and return to the conversation. */
  onClose: () => void
}): React.ReactNode {
  const { columns, rows } = useTerminalSize()
  const [ref, time] = useAnimationFrame(MOTION_TICK_MS)
  const tick = Math.floor(time / MOTION_TICK_MS)

  const [view, setView] = React.useState<TrajectoryView>('timeline')
  const [cursor, setCursor] = React.useState(0)
  const [hotCursor, setHotCursor] = React.useState(0)
  const [queryOpen, setQueryOpen] = React.useState(false)
  const [queryText, setQueryText] = React.useState('')
  // Compressed wall-clock is the default: it reads as a session profile — busy
  // stretches are wide AND tall, idle gaps collapse to a thin flat run — while
  // the pure sequence axis is the specialist view for scanning what happened.
  const [projection, setProjection] = React.useState<WaveProjection>('compressed')
  const [sort, setSort] = React.useState<HotspotSort>('duration')
  const [expanded, setExpanded] = React.useState(false)
  const [inspectScroll, setInspectScroll] = React.useState(0)
  /** Ticks at which one-shot motion verbs were triggered. */
  const [switchTick, setSwitchTick] = React.useState(0)
  const [alertTick, setAlertTick] = React.useState(0)
  const [arrivalTick, setArrivalTick] = React.useState(0)
  const [arrivalFrom, setArrivalFrom] = React.useState(Number.MAX_SAFE_INTEGER)
  /** Cursor pinned to the tail until the user scrolls away from it. */
  const [follow, setFollow] = React.useState(true)

  // ── projection ───────────────────────────────────────────────────────────
  const nodes = build.nodes

  const query = React.useMemo(() => parseQuery(queryText), [queryText])
  const { rows: filtered, indexes } = React.useMemo(
    () => applyQuery(nodes, query),
    // `nodes` is mutated in place by the incremental fold, so its length is
    // the honest dependency — the array identity never changes.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
    [nodes, nodes.length, query],
  )

  const agg = React.useMemo(
    // oxlint-disable-next-line react-hooks/exhaustive-deps
    () => aggregate(build, sort),
    [build, nodes.length, sort],
  )

  // ── arrival + alert detection ────────────────────────────────────────────
  const seenRef = React.useRef(0)
  const errorsRef = React.useRef(0)
  React.useEffect(() => {
    if (nodes.length > seenRef.current) {
      setArrivalFrom(seenRef.current)
      setArrivalTick(tick)
      seenRef.current = nodes.length
      if (follow) setCursor(Math.max(0, filtered.length - 1))
    }
    if (agg.totals.errors > errorsRef.current) {
      errorsRef.current = agg.totals.errors
      setAlertTick(tick)
    }
  }, [nodes.length, agg.totals.errors, tick, follow, filtered.length])

  // ── geometry ─────────────────────────────────────────────────────────────
  const inspectorRows = expanded ? Math.max(4, rows - CHROME_ROWS - 3) : INSPECTOR_ROWS
  const ledgerRows = Math.max(1, rows - CHROME_ROWS - inspectorRows - 1)
  const bandWidth = Math.max(1, columns - 4)

  const clampedCursor = filtered.length === 0 ? 0 : Math.min(cursor, filtered.length - 1)
  const windowStart = Math.max(
    0,
    Math.min(clampedCursor - Math.floor(ledgerRows / 2), filtered.length - ledgerRows),
  )

  const band = React.useMemo(
    // oxlint-disable-next-line react-hooks/exhaustive-deps
    () => projectWave(nodes, bandWidth, projection),
    [nodes, nodes.length, bandWidth, projection],
  )
  const matchColumns = React.useMemo(() => {
    if (query.empty) return undefined
    const set = new Set<number>()
    for (const index of indexes) set.add(columnOfIndex(band, index))
    return set
  }, [band, indexes, query.empty])

  const focused = filtered[clampedCursor]
  const detail = React.useMemo(
    () => (focused === undefined ? undefined : inspectNode(focused, channel.traceEvents())),
    [focused, channel],
  )

  // ── navigation helpers ───────────────────────────────────────────────────
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

  const seek = React.useCallback(
    (predicate: (index: number) => boolean, forward: boolean) => {
      const from = clampedCursor
      const limit = filtered.length
      for (let step = 1; step <= limit; step++) {
        const index = forward ? from + step : from - step
        if (index < 0 || index >= limit) continue
        if (predicate(index)) {
          setExpanded(false)
          setInspectScroll(0)
          setCursor(index)
          setFollow(index >= limit - 1)
          return
        }
      }
    },
    [clampedCursor, filtered.length],
  )

  const isFailure = React.useCallback(
    (index: number): boolean => {
      const node = filtered[index]
      return (
        node !== undefined &&
        (node.status === 'error' || node.kind === 'retry' || (node.burst !== undefined && burstErrors(node.burst) > 0))
      )
    },
    [filtered],
  )

  const switchView = React.useCallback(
    (next: TrajectoryView) => {
      setView(next)
      setSwitchTick(tick)
      setExpanded(false)
      setInspectScroll(0)
    },
    [tick],
  )

  // ── keys ─────────────────────────────────────────────────────────────────
  useInput((input, key) => {
    // The query line owns the keyboard while open, so a `q` typed into a
    // search does not close the scene.
    if (queryOpen) {
      if (key.escape) {
        setQueryOpen(false)
        setQueryText('')
        return
      }
      if (key.return) {
        setQueryOpen(false)
        return
      }
      if (key.backspace || key.delete) {
        setQueryText(previous => previous.slice(0, -1))
        setCursor(0)
        return
      }
      if (input && !key.ctrl && !key.meta) {
        setQueryText(previous => previous + input)
        setCursor(0)
      }
      return
    }

    if (key.escape || input === 'q') {
      if (expanded) {
        setExpanded(false)
        setInspectScroll(0)
        return
      }
      if (!query.empty) {
        setQueryText('')
        return
      }
      onClose()
      return
    }

    if (key.leftArrow) return switchView('timeline')
    if (key.rightArrow) return switchView('hotspot')
    if (input === 'h') return switchView(view === 'hotspot' ? 'timeline' : 'hotspot')
    if (input === '/') {
      setQueryOpen(true)
      return
    }

    if (view === 'hotspot') {
      const total = hotspotRows(agg).length
      if (key.upArrow) return setHotCursor(previous => Math.max(0, previous - 1))
      if (key.downArrow) return setHotCursor(previous => Math.min(total - 1, previous + 1))
      if (input === 't') {
        setSort(previous => HOTSPOT_SORTS[(HOTSPOT_SORTS.indexOf(previous) + 1) % HOTSPOT_SORTS.length]!)
        setSwitchTick(tick)
        return
      }
      if (key.return) {
        // Jump back to the timeline, positioned on the group's first member.
        const row = hotspotRows(agg)[hotCursor]
        switchView('timeline')
        if (row !== undefined) {
          const target = indexes.indexOf(row.firstIndex)
          setCursor(target >= 0 ? target : 0)
          setFollow(false)
        }
        return
      }
      return
    }

    if (key.upArrow) return move(-1)
    if (key.downArrow) return move(1)
    if (key.pageUp) return move(-ledgerRows)
    if (key.pageDown) return move(ledgerRows)
    // Bare-letter jumps must not fire on Ctrl+G (the prompt's external-editor
    // key) or other modified chords that share the letter.
    if (input === 'g' && !key.ctrl && !key.meta && !key.super) {
      setCursor(0)
      setFollow(false)
      return
    }
    if (input === 'G' && !key.ctrl && !key.meta && !key.super) {
      setCursor(Math.max(0, filtered.length - 1))
      setFollow(true)
      return
    }
    if (input === '[') return seek(isFailure, false)
    if (input === ']') return seek(isFailure, true)
    if (input === '{') return seek(index => filtered[index]?.kind === 'turn', false)
    if (input === '}') return seek(index => filtered[index]?.kind === 'turn', true)
    if (input === 'm') {
      setProjection(previous => WAVE_PROJECTIONS[(WAVE_PROJECTIONS.indexOf(previous) + 1) % WAVE_PROJECTIONS.length]!)
      setSwitchTick(tick)
      return
    }
    if (key.return) {
      setExpanded(previous => !previous)
      setInspectScroll(0)
      return
    }
    if (expanded && (input === 'j' || input === 'k')) {
      setInspectScroll(previous => Math.max(0, previous + (input === 'j' ? inspectorRows - 2 : -(inspectorRows - 2))))
    }
  })

  // ── header ───────────────────────────────────────────────────────────────
  //
  // Both chrome rows are composed as ONE pre-measured line each rather than as
  // a flex row of groups. Flex plus `wrap="truncate"` proved unreliable here:
  // a right-hand group laid out at its natural width lost its last character,
  // and under other splits the overflow reflowed onto the row below — which
  // pushes every region beneath it down and breaks the fixed geometry the
  // whole scene depends on. Padding to an exact column count is deterministic,
  // CJK-aware, and cheap (two strings per frame).
  const { totals } = agg

  /** Left text, a computed gap, right text — clipped to `width` columns. */
  const spread = (left: string, right: string, width: number): { left: string; gap: string; right: string } => {
    const rightText = truncateWidth(right, Math.max(0, width - 4))
    const room = width - stringWidth(rightText)
    const leftText = truncateWidth(left, Math.max(0, room - 1))
    return {
      left: leftText,
      gap: ' '.repeat(Math.max(1, room - stringWidth(leftText))),
      right: rightText,
    }
  }

  const totalsText =
    t('traj-totals', { turns: totals.turns, steps: totals.rows }) +
    (totals.errors > 0 ? ` \u00b7 ${t('traj-errors', { n: totals.errors })}` : '') +
    (totals.retries > 0 ? ` \u00b7 ${t('traj-retries', { n: totals.retries })}` : '') +
    ` \u00b7 ${formatDuration(totals.spanMs)}`

  const headerLine = spread(
    `\u2726 ${t('traj-title')}  ${channel.sessionTitle ?? channel.cwd}`,
    totalsText,
    bandWidth,
  )
  const header = (
    <Box width="100%" height={1} flexShrink={0}>
      <Text>
        <Text color="claude" bold>{`\u2726 ${t('traj-title')}`}</Text>
        <Text color="subtle">{headerLine.left.slice((`\u2726 ${t('traj-title')}`).length)}</Text>
        <Text>{headerLine.gap}</Text>
        <Text color={totals.errors > 0 ? 'error' : 'subtle'}>{headerLine.right}</Text>
      </Text>
    </Box>
  )

  const axisLabel = view === 'hotspot' ? t(`traj-sort-${sort}`) : t(`traj-proj-${projection}`)
  const tabsLeft =
    `${view === 'timeline' ? '\u25cf' : '\u25cb'} ${t('traj-tab-timeline')}  ` +
    `${view === 'hotspot' ? '\u25cf' : '\u25cb'} ${t('traj-tab-hotspot')}`
  const queryText_ =
    queryOpen || !query.empty
      ? `   / ${queryText}${queryOpen ? '\u258c' : ''}  ${t('traj-matches', { n: filtered.length, total: nodes.length })}`
      : ''
  const tabsLine = spread(tabsLeft + queryText_, axisLabel, bandWidth)
  const tabs = (
    <Box width="100%" height={1} flexShrink={0}>
      <Text>
        <Text color={view === 'timeline' ? 'permission' : 'subtle'} bold={view === 'timeline'}>
          {tabsLine.left.slice(0, tabsLeft.length)}
        </Text>
        <Text color="suggestion">{tabsLine.left.slice(tabsLeft.length)}</Text>
        <Text>{tabsLine.gap}</Text>
        <Text color="subtle">{tabsLine.right}</Text>
      </Text>
    </Box>
  )

  const hints =
    view === 'hotspot'
      ? t('traj-hint-hotspot')
      : queryOpen
        ? t('traj-hint-query')
        : expanded
          ? t('traj-hint-expanded')
          : t('traj-hint-timeline')

  return (
    // `flexGrow`, not an explicit `height={rows}`: in inline mode the scene is
    // nested inside `<AlternateScreen>`, whose own Box is already pinned to the
    // terminal height. Restating that height here made the two claims add up to
    // one row more than the viewport, which scrolled the header off the top.
    <Box ref={ref} flexDirection="column" width="100%" paddingX={1}>
      {header}
      {tabs}
      <WaveBand
        band={band}
        width={bandWidth}
        cursorColumn={columnOfIndex(band, indexes[clampedCursor] ?? 0)}
        viewportStart={columnOfIndex(band, indexes[windowStart] ?? 0)}
        viewportEnd={columnOfIndex(band, indexes[Math.min(filtered.length - 1, windowStart + ledgerRows - 1)] ?? 0)}
        matches={matchColumns}
        tick={tick}
        alertTick={alertTick}
      />
      <Box height={1} flexShrink={0}><Text> </Text></Box>
      {view === 'timeline' ? (
        <>
          <Ledger
            rows={filtered}
            start={windowStart}
            height={ledgerRows}
            cursor={clampedCursor}
            width={columns - 4}
            tick={tick}
            arrivalTick={arrivalTick}
            arrivalFrom={arrivalFrom}
          />
          {/* `Divider` defaults to the FULL terminal width; inside this
              padded scene that overflows by two cells and wraps onto a
              second row, which pushed the header off the top of the
              viewport. Size it to the scene's own content width. */}
          <Divider color="permission" width={bandWidth} />
          <Inspector
            node={focused}
            detail={detail}
            height={inspectorRows}
            width={columns - 4}
            expanded={expanded}
            scroll={inspectScroll}
          />
        </>
      ) : (
        <HotspotView
          agg={agg}
          sort={sort}
          width={columns - 4}
          height={ledgerRows + inspectorRows + 1}
          cursor={hotCursor}
          tick={tick}
          switchTick={switchTick}
        />
      )}
      <Box height={1} flexShrink={0}><Text> </Text></Box>
      <Box width="100%" height={1} flexShrink={0}>
        <Text dimColor italic wrap="truncate">
          <HintLine text={hints} />
          {totals.tokens.input > 0 ? (
            <Text color="subtle">{`   ${formatTokens(totals.tokens.input)}→${formatTokens(totals.tokens.output)}`}</Text>
          ) : (
            ''
          )}
        </Text>
      </Box>
    </Box>
  )
}
