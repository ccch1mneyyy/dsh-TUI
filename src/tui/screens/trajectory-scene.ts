/**
 * The trajectory scene (`/trace`, Ctrl+T) — the session's own screen, ported
 * from the Ink `TrajectoryScene.tsx` to a pi-tui `Component`.
 *
 * Rather than carving a panel out of the conversation, the trajectory takes
 * the whole terminal the way `less`, `fzf` and `lazygit` do, and gives it
 * back untouched on exit. Four regions, top to bottom: the header, the wake
 * (whole session as one band), the ledger, and the inspector. Every region
 * except the ledger has a fixed height, so moving the cursor never resizes
 * the frame.
 *
 * ## What changed in the port
 *
 * - React state becomes plain fields; `useMemo` becomes explicit caches
 *   keyed the way the old dependency lists were (`nodes` identity + length,
 *   because the incremental fold mutates the array in place).
 * - The session projection is folded HERE, not by the host: `update(vm)`
 *   runs the same `extendTrajectory(prev, vm.events)` incremental fold
 *   `Chat.tsx` used to run, and a `meta.sessionEpoch` change resets the fold
 *   so a swapped session rebuilds from scratch.
 * - The animation clock is a `setInterval(MOTION_TICK_MS)` (unref'd) owned
 *   by the scene; each tick advances the motion clock and asks the shell to
 *   repaint. `dispose()` clears it.
 * - Keyboard input arrives as raw `data` matched with `matchesKey(data,
 *   Key.x)`; the query line accepts printable text the way pi-tui's own
 *   `Input` does (Kitty CSI-u decode, then a control-character reject).
 * - Pointer input (research §4.3) resolves against geometry recorded during
 *   `render` — the scene is a full-screen transient leaf, so `localY` is the
 *   output row index and `localX − 1` the content column. Clicks reuse the
 *   keyboard verbs (tab ←/→, axis m/t, query `/`, hotspot Enter, ✕ = q/Esc);
 *   the wheel moves the selection. press/release/move stay unconsumed so
 *   drag-selection copy keeps working.
 * - The header's session title is no longer read off the Channel (components
 *   may not hold one); the shell passes it as `title` at construction.
 *
 * Width arrives per frame via `render(width)`; height arrives via
 * `setViewportHeight(rows)` from the shell.
 */

import {
  decodeKittyPrintable,
  Key,
  matchesKey,
  visibleWidth,
  type Component,
  type PointerEvent,
} from '../public.js'
import type { TuiCommands } from '../commands.js'
import type { TrajectoryProjection } from '../view-model.js'
import { t } from '../../i18n.js'
import {
  aggregate,
  burstErrors,
  columnOfIndex,
  emptyTrajectory,
  extendTrajectory,
  HOTSPOT_SORTS,
  inspectNode,
  projectWave,
  WAVE_PROJECTIONS,
  type HotspotSort,
  type InspectDetail,
  type TrajAggregate,
  type TrajBuild,
  type TrajNode,
  type WaveBand,
  type WaveProjection,
} from '../../dsh-adapter/trajectory/index.js'
import { applyQuery, parseQuery, type TrajQuery } from '../../trajectory/query.js'
import { MOTION_TICK_MS } from '../../trajectory/motion.js'
import { formatDuration, formatTokens, truncateWidth } from '../../trajectory/format.js'
import { renderWaveBand } from '../components/trajectory/wave-band.js'
import { renderLedger } from '../components/trajectory/ledger.js'
import { renderInspector } from '../components/trajectory/inspector.js'
import { hotspotPointerRows, hotspotRows, renderHotspotView } from '../components/trajectory/hotspot-view.js'
import { fg } from '../components/trajectory/paint.js'
import type { HotspotRow } from '../../dsh-adapter/types.js'

/** Inspector height in the default (unexpanded) layout. */
const INSPECTOR_ROWS = 6
/**
 * Rows the ledger does not get: header, tabs, the wake's two rows, one blank
 * line under the wake, the hint line, and one blank line above it.
 *
 * The two blank lines are deliberate. A view that fills every row edge to
 * edge reads as pressure regardless of how good the individual rows are;
 * giving the chrome and the content a line of ground between them costs two
 * rows out of thirty and buys the whole screen room to breathe.
 */
const CHROME_ROWS = 2 + 2 + 1 + 1 + 1

/** Viewport height assumed until the shell first calls `setViewportHeight`. */
const DEFAULT_VIEWPORT_ROWS = 24

/**
 * Fixed scene rows above the content region (research §4.3 pointer mapping):
 * header (with the ✕ close cell), tabs, the two wave-band rows, one blank.
 * The band renders exactly two lines (wave + ruler), so the content region —
 * ledger or hotspot — always starts at row 5 of the scene's output.
 */
const HEADER_ROW = 0
const TABS_ROW = 1
const BAND_ROWS = 2
const CONTENT_START_ROW = 2 + BAND_ROWS + 1

/** Width of the header's clickable ` ✕` close affordance (source main). */
const CLOSE_WIDTH = 2

/** Content-column ranges of the tabs line's clickable segments, recorded by
 *  {@link TrajectoryScene.tabsLine} on every render. All are 0-based columns
 *  within the unpadded line (the scene prefixes one space at paint time). */
interface TabsPointerGeometry {
  /** [0, timelineEnd) switches to the timeline view. */
  timelineEnd: number
  /** [timelineEnd, hotspotEnd) switches to the hotspot view. */
  hotspotEnd: number
  /** [hotspotEnd, queryEnd) reopens the query editor (absent when no query
   *  segment is shown — then this equals hotspotEnd). */
  queryEnd: number
  /** End of the clipped left side: [queryEnd, axisStart) is the gap, which
   *  also opens the query editor (the gap IS where the query line sits). */
  leftEnd: number
  /** [axisStart, bandWidth) cycles the projection/sort label. */
  axisStart: number
}

export type TrajectoryView = 'timeline' | 'hotspot'

export interface TrajectorySceneOptions {
  commands: TuiCommands
  /** Leave the scene and return to the conversation. */
  onClose: () => void
  /**
   * Shell repaint hook for the motion clock (`ui.requestRender`). Optional so
   * tests can drive `render` by hand; defaults to a no-op.
   */
  requestRender?: () => void
  /**
   * Header context — the old scene showed `channel.sessionTitle ??
   * channel.cwd`; components may not hold the Channel, so the shell passes
   * the resolved string in.
   */
  title?: string
  /** Initial viewport height; the shell re-feeds it via `setViewportHeight`. */
  viewportHeight?: number
}

export class TrajectoryScene implements Component {
  private readonly commands: TuiCommands
  private readonly onClose: () => void
  private readonly requestRender: () => void
  private readonly title: string | undefined
  private viewportHeight: number

  /** Scene clock; every motion verb reads differences against this counter. */
  private tick = 0
  private readonly timer: ReturnType<typeof setInterval>
  private disposed = false

  // ── interaction state (the old component's useState fields) ─────────────
  private view: TrajectoryView = 'timeline'
  private cursor = 0
  private hotCursor = 0
  private queryOpen = false
  private queryText = ''
  // Compressed wall-clock is the default: it reads as a session profile —
  // busy stretches are wide AND tall, idle gaps collapse to a thin flat run —
  // while the pure sequence axis is the specialist view for scanning what
  // happened.
  private projection: WaveProjection = 'compressed'
  private sort: HotspotSort = 'duration'
  private expanded = false
  private inspectScroll = 0
  /** Ticks at which one-shot motion verbs were triggered. */
  private switchTick = 0
  private alertTick = 0
  private arrivalTick = 0
  private arrivalFrom = Number.MAX_SAFE_INTEGER
  /** Cursor pinned to the tail until the user scrolls away from it. */
  private follow = true

  // ── fold state ───────────────────────────────────────────────────────────
  private build: TrajBuild = emptyTrajectory()
  private foldEpoch: number | undefined
  /** Ledger length already announced via the `arrive` verb. */
  private seenLength = 0
  /** Error count already announced via the `alert` verb. */
  private errorsSeen = 0

  // ── derived-value caches (the old useMemo fields) ───────────────────────
  private filterCache:
    | { nodes: readonly TrajNode[]; length: number; queryText: string; rows: TrajNode[]; indexes: number[] }
    | undefined
  private aggregateCache:
    | { build: TrajBuild; sort: HotspotSort; agg: TrajAggregate }
    | undefined
  private bandCache:
    | { nodes: readonly TrajNode[]; length: number; width: number; projection: WaveProjection; band: WaveBand }
    | undefined
  private matchCache:
    | { band: WaveBand; indexes: readonly number[]; empty: boolean; columns: Set<number> | undefined }
    | undefined
  private detailCache: { node: TrajNode; detail: InspectDetail } | undefined

  // ── pointer geometry (recorded per render; see handlePointer) ───────────
  /** bandWidth of the last render; the ✕ close cell sits at its right end. */
  private pointerBandWidth = 0
  /** Tabs line segment ranges of the last render. */
  private pointerTabs: TabsPointerGeometry | undefined
  /** The band rendered last frame (bucket lookup for column clicks). */
  private pointerBand: WaveBand | undefined
  /** Filtered index behind the first visible ledger row of the last render. */
  private pointerLedgerStart = 0
  /** Ledger line count of the last render. */
  private pointerLedgerRows = 0
  /** Clickable hotspot row per visible content offset (undefined = title or
   *  padding), aligned with the last hotspot render; undefined in timeline. */
  private pointerHotspot: (HotspotRow | undefined)[] | undefined

  constructor(options: TrajectorySceneOptions) {
    this.commands = options.commands
    this.onClose = options.onClose
    this.requestRender = options.requestRender ?? (() => {})
    this.title = options.title
    this.viewportHeight = options.viewportHeight ?? DEFAULT_VIEWPORT_ROWS
    // The Ink original subscribed to a shared animation clock; here the scene
    // owns its timer outright. Unref'd so an open scene never holds the
    // process alive; cleared by dispose().
    this.timer = setInterval(() => {
      if (this.disposed) return
      this.tick += 1
      this.requestRender()
    }, MOTION_TICK_MS)
    this.timer.unref?.()
  }

  /** Clear the interval; the shell calls this when the scene closes. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    clearInterval(this.timer)
  }

  /** The shell feeds the current viewport height in rows. */
  setViewportHeight(rows: number): void {
    this.viewportHeight = Math.max(1, Math.floor(rows))
  }

  /** Drop every derived cache (theme switch, terminal relayout). */
  invalidate(): void {
    this.filterCache = undefined
    this.aggregateCache = undefined
    this.bandCache = undefined
    this.matchCache = undefined
    this.detailCache = undefined
  }

  /**
   * Fold the session's event snapshot into the projection.
   *
   * The fold is incremental — `extendTrajectory` consumes only events
   * appended since the previous build, proven by object identity at the
   * previous last index — so an idle conversation pays nothing for it. A
   * `sessionEpoch` change (a /new, /resume, /model or rewind swap) resets
   * the fold so the new session rebuilds from scratch.
   */
  update(vm: TrajectoryProjection): void {
    if (this.foldEpoch !== vm.meta.sessionEpoch) {
      this.foldEpoch = vm.meta.sessionEpoch
      // An empty build prefix-extends any snapshot, so the extend below
      // folds the new session's whole log from scratch.
      this.build = emptyTrajectory()
      this.seenLength = 0
      this.errorsSeen = 0
      this.arrivalFrom = Number.MAX_SAFE_INTEGER
      this.invalidate()
    }
    this.build = extendTrajectory(this.build, vm.events)
    const nodes = this.build.nodes

    // ── arrival + alert detection (the old post-render effect) ─────────────
    if (nodes.length > this.seenLength) {
      this.arrivalFrom = this.seenLength
      this.arrivalTick = this.tick
      this.seenLength = nodes.length
      if (this.follow) {
        const filtered = this.ensureFilter(nodes, parseQuery(this.queryText))
        this.cursor = Math.max(0, filtered.rows.length - 1)
      }
    }
    const agg = this.ensureAggregate()
    if (agg.totals.errors > this.errorsSeen) {
      this.errorsSeen = agg.totals.errors
      this.alertTick = this.tick
    }
  }

  // ── derived values ────────────────────────────────────────────────────────

  /**
   * The filtered ledger plus original indexes (the wave band highlights
   * matches in place, so it needs pre-filter positions). Keyed like the old
   * `useMemo`: `nodes` identity + length + query — the fold mutates the
   * array in place, so its length is the honest dependency.
   */
  private ensureFilter(
    nodes: readonly TrajNode[],
    query: TrajQuery,
  ): { rows: TrajNode[]; indexes: number[] } {
    const cached = this.filterCache
    if (cached !== undefined && cached.nodes === nodes && cached.length === nodes.length && cached.queryText === this.queryText) {
      return cached
    }
    const { rows, indexes } = applyQuery(nodes, query)
    this.filterCache = { nodes, length: nodes.length, queryText: this.queryText, rows, indexes }
    return this.filterCache
  }

  /**
   * Session aggregate, keyed on `build` identity + sort — the old memo's
   * `[build, nodes.length, sort]` deps. Build identity (not just the row
   * count) matters because a bracket-closing append adds no rows yet moves
   * the totals (`spanMs`, errors), and the incremental fold returns a fresh
   * build object for every appended batch.
   */
  private ensureAggregate(): TrajAggregate {
    const cached = this.aggregateCache
    if (cached !== undefined && cached.build === this.build && cached.sort === this.sort) {
      return cached.agg
    }
    const agg = aggregate(this.build, this.sort)
    this.aggregateCache = { build: this.build, sort: this.sort, agg }
    return agg
  }

  private ensureBand(nodes: readonly TrajNode[], width: number): WaveBand {
    const cached = this.bandCache
    if (
      cached !== undefined &&
      cached.nodes === nodes &&
      cached.length === nodes.length &&
      cached.width === width &&
      cached.projection === this.projection
    ) {
      return cached.band
    }
    const band = projectWave(nodes, width, this.projection)
    this.bandCache = { nodes, length: nodes.length, width, projection: this.projection, band }
    return band
  }

  /** Columns holding a query match, or `undefined` with no active query. */
  private ensureMatchColumns(band: WaveBand, indexes: readonly number[], empty: boolean): Set<number> | undefined {
    const cached = this.matchCache
    if (cached !== undefined && cached.band === band && cached.indexes === indexes && cached.empty === empty) {
      return cached.columns
    }
    let columns: Set<number> | undefined
    if (!empty) {
      columns = new Set<number>()
      for (const index of indexes) columns.add(columnOfIndex(band, index))
    }
    this.matchCache = { band, indexes, empty, columns }
    return columns
  }

  /** Inspector detail, re-read from the log on demand (cached per node). */
  private ensureDetail(focused: TrajNode | undefined): InspectDetail | undefined {
    if (focused === undefined) return undefined
    if (this.detailCache !== undefined && this.detailCache.node === focused) return this.detailCache.detail
    const detail = inspectNode(focused, this.commands.info.traceEvents())
    this.detailCache = { node: focused, detail }
    return detail
  }

  // ── keys ─────────────────────────────────────────────────────────────────

  handleInput(data: string): void {
    const nodes = this.build.nodes
    const query = parseQuery(this.queryText)
    const { rows: filtered, indexes } = this.ensureFilter(nodes, query)

    // The query line owns the keyboard while open, so a `q` typed into a
    // search does not close the scene.
    if (this.queryOpen) {
      if (matchesKey(data, Key.escape)) {
        this.queryOpen = false
        this.queryText = ''
        return
      }
      if (matchesKey(data, Key.enter)) {
        this.queryOpen = false
        return
      }
      if (matchesKey(data, Key.backspace) || matchesKey(data, Key.delete)) {
        this.queryText = this.queryText.slice(0, -1)
        this.cursor = 0
        return
      }
      // Printable text — Kitty CSI-u first (those sequences contain \x1b and
      // would fail the control-character check), then any input free of C0 /
      // DEL / C1 controls, exactly like pi-tui's own Input component.
      const printable = decodeKittyPrintable(data) ?? (hasNoControlChars(data) ? data : undefined)
      if (printable !== undefined) {
        this.queryText += printable
        this.cursor = 0
      }
      return
    }

    if (matchesKey(data, Key.escape) || matchesKey(data, 'q')) {
      if (this.expanded) {
        this.expanded = false
        this.inspectScroll = 0
        return
      }
      if (!query.empty) {
        this.queryText = ''
        return
      }
      this.onClose()
      return
    }

    if (matchesKey(data, Key.left)) return this.switchView('timeline')
    if (matchesKey(data, Key.right)) return this.switchView('hotspot')
    if (matchesKey(data, 'h')) return this.switchView(this.view === 'hotspot' ? 'timeline' : 'hotspot')
    if (matchesKey(data, Key.slash)) {
      this.queryOpen = true
      return
    }

    if (this.view === 'hotspot') {
      const total = hotspotRows(this.ensureAggregate()).length
      if (matchesKey(data, Key.up)) {
        this.hotCursor = Math.max(0, this.hotCursor - 1)
        return
      }
      if (matchesKey(data, Key.down)) {
        this.hotCursor = Math.min(Math.max(0, total - 1), this.hotCursor + 1)
        return
      }
      if (matchesKey(data, 't')) {
        this.cycleAxis()
        return
      }
      if (matchesKey(data, Key.enter)) {
        // Jump back to the timeline, positioned on the group's first member.
        this.jumpFromHotspot(hotspotRows(this.ensureAggregate())[this.hotCursor], indexes)
        return
      }
      return
    }

    const inspectorRows = this.inspectorRows()
    const ledgerRows = this.ledgerRows(inspectorRows)

    if (matchesKey(data, Key.up)) return this.move(-1, filtered.length)
    if (matchesKey(data, Key.down)) return this.move(1, filtered.length)
    if (matchesKey(data, Key.pageUp)) return this.move(-ledgerRows, filtered.length)
    if (matchesKey(data, Key.pageDown)) return this.move(ledgerRows, filtered.length)
    // `matchesKey` for a bare letter already rejects Ctrl/Alt/Super chords,
    // so Ctrl+G (the prompt's external-editor key) cannot fire the jump.
    if (matchesKey(data, 'g')) {
      this.cursor = 0
      this.follow = false
      return
    }
    if (matchesKey(data, Key.shift('g'))) {
      this.cursor = Math.max(0, filtered.length - 1)
      this.follow = true
      return
    }
    if (matchesKey(data, Key.leftbracket)) return this.seek(filtered, this.isFailure(filtered), false)
    if (matchesKey(data, Key.rightbracket)) return this.seek(filtered, this.isFailure(filtered), true)
    if (matchesKey(data, Key.leftbrace)) {
      return this.seek(filtered, (index) => filtered[index]?.kind === 'turn', false)
    }
    if (matchesKey(data, Key.rightbrace)) {
      return this.seek(filtered, (index) => filtered[index]?.kind === 'turn', true)
    }
    if (matchesKey(data, 'm')) {
      this.cycleAxis()
      return
    }
    if (matchesKey(data, Key.enter)) {
      this.expanded = !this.expanded
      this.inspectScroll = 0
      return
    }
    if (this.expanded && matchesKey(data, 'j')) {
      this.inspectScroll += Math.max(1, inspectorRows - 2)
      return
    }
    if (this.expanded && matchesKey(data, 'k')) {
      this.inspectScroll = Math.max(0, this.inspectScroll - Math.max(1, inspectorRows - 2))
    }
  }

  /** Vertical cursor move; collapses the expanded inspector. */
  private move(delta: number, length: number): void {
    this.expanded = false
    this.inspectScroll = 0
    const next = Math.max(0, Math.min(length - 1, this.cursor + delta))
    this.follow = next >= length - 1
    this.cursor = next
  }

  /** Jump to the next/previous row satisfying `predicate`. */
  private seek(filtered: readonly TrajNode[], predicate: (index: number) => boolean, forward: boolean): void {
    const from = this.clampedCursor(filtered.length)
    const limit = filtered.length
    for (let step = 1; step <= limit; step++) {
      const index = forward ? from + step : from - step
      if (index < 0 || index >= limit) continue
      if (predicate(index)) {
        this.expanded = false
        this.inspectScroll = 0
        this.cursor = index
        this.follow = index >= limit - 1
        return
      }
    }
  }

  /** Failure predicate for the `[`/`]` jumps. */
  private isFailure(filtered: readonly TrajNode[]): (index: number) => boolean {
    return (index) => {
      const node = filtered[index]
      return (
        node !== undefined &&
        (node.status === 'error' || node.kind === 'retry' || (node.burst !== undefined && burstErrors(node.burst) > 0))
      )
    }
  }

  private switchView(next: TrajectoryView): void {
    this.view = next
    this.switchTick = this.tick
    this.expanded = false
    this.inspectScroll = 0
  }

  /** Axis label cycle — the `m` (timeline) / `t` (hotspot) key path, shared
   *  with the tabs-line axis click. */
  private cycleAxis(): void {
    if (this.view === 'hotspot') {
      this.sort = HOTSPOT_SORTS[(HOTSPOT_SORTS.indexOf(this.sort) + 1) % HOTSPOT_SORTS.length]!
    } else {
      this.projection = WAVE_PROJECTIONS[(WAVE_PROJECTIONS.indexOf(this.projection) + 1) % WAVE_PROJECTIONS.length]!
    }
    this.switchTick = this.tick
  }

  /** Jump the timeline cursor to a filtered index (keyboard jump semantics:
   *  reset the inspector scroll, re-pin the tail follow at the last row). */
  private jumpTo(index: number, filteredLength: number): void {
    this.inspectScroll = 0
    this.cursor = index
    this.follow = index >= filteredLength - 1
  }

  /** Jump back to the timeline, positioned on a hotspot group's first
   *  member — the hotspot-view Enter path, shared with the row click. */
  private jumpFromHotspot(row: HotspotRow | undefined, indexes: readonly number[]): void {
    this.switchView('timeline')
    if (row !== undefined) {
      const target = indexes.indexOf(row.firstIndex)
      this.cursor = target >= 0 ? target : 0
      this.follow = false
    }
  }

  // ── pointer (research §4.3) ──────────────────────────────────────────────

  /**
   * Pointer parity with the source scene: clicks resolve against the
   * geometry recorded by the last {@link render} — header ✕ closes (q/Esc
   * equivalent), tab segments switch views (←/→), the query segment and the
   * gap open the search editor (`/`), the right axis label cycles the
   * projection/sort (m/t), a wave-band column seeks the nearest event
   * (bucket.firstIndex, ruler row included), a ledger row moves the cursor
   * to it, and a hotspot row takes the Enter path back to the timeline.
   * The wheel moves the selection rather than a viewport: ±1 hotspot row,
   * ±3 ledger rows, or the inspector page step while expanded.
   *
   * Every click/wheel inside the scene is consumed (it is a full-screen
   * transient replacement — nothing behind it may see the event);
   * press/release/move stay unconsumed so terminal drag-selection copy
   * keeps working, and a drag release never dispatches a click.
   */
  handlePointer(event: PointerEvent): boolean | void {
    if (event.type === 'click') {
      if (event.button === 0) this.handleClick(event.localX - 1, event.localY)
      return true
    }
    if (event.type === 'wheel') {
      if (event.deltaY !== 0) this.handleWheel(event.deltaY)
      return true
    }
    return undefined
  }

  /** Click dispatch in CONTENT columns (the scene pads every line by one
   *  cell, so the caller passes localX − 1) and output row indexes. */
  private handleClick(column: number, row: number): void {
    const nodes = this.build.nodes
    const query = parseQuery(this.queryText)
    const { rows: filtered, indexes } = this.ensureFilter(nodes, query)

    if (row === HEADER_ROW) {
      if (column >= this.pointerBandWidth - CLOSE_WIDTH) this.onClose()
      return
    }
    if (row === TABS_ROW) {
      const tabs = this.pointerTabs
      if (tabs === undefined) return
      if (column < tabs.timelineEnd) return this.switchView('timeline')
      if (column < tabs.hotspotEnd) return this.switchView('hotspot')
      if (column >= tabs.axisStart) return this.cycleAxis()
      // Query segment and gap share one action: (re)open the search editor.
      this.queryOpen = true
      return
    }
    if (row >= TABS_ROW + 1 && row < CONTENT_START_ROW - 1) {
      // Wave band (wave + ruler rows): seek the column's nearest event.
      // Empty columns inherit their predecessor's firstIndex for exactly
      // this; rows the query filtered out never jump (indexOf misses).
      const band = this.pointerBand
      if (band === undefined || band.buckets.length === 0) return
      const bucket = Math.max(0, Math.min(band.buckets.length - 1, column))
      const nodeIndex = band.buckets[bucket]?.firstIndex ?? -1
      if (nodeIndex < 0) return
      const target = indexes.indexOf(nodeIndex)
      if (target >= 0) this.jumpTo(target, filtered.length)
      return
    }
    const contentRow = row - CONTENT_START_ROW
    if (contentRow < 0) return
    if (this.view === 'timeline') {
      // Ledger rows jump the cursor; the divider and the inspector below
      // have no click action (consumed by the caller regardless).
      if (contentRow < this.pointerLedgerRows) {
        const index = this.pointerLedgerStart + contentRow
        if (index < filtered.length) this.jumpTo(index, filtered.length)
      }
      return
    }
    const hotspotRow = this.pointerHotspot?.[contentRow]
    if (hotspotRow !== undefined) this.jumpFromHotspot(hotspotRow, indexes)
  }

  /** Wheel over the content area moves the selection (source semantics). */
  private handleWheel(deltaY: number): void {
    const direction = deltaY > 0 ? 1 : -1
    if (this.view === 'hotspot') {
      const total = hotspotRows(this.ensureAggregate()).length
      this.hotCursor = Math.max(0, Math.min(total - 1, this.hotCursor + direction))
      return
    }
    if (this.expanded) {
      // The expanded inspector owns the wheel: same page step as j/k.
      this.inspectScroll = Math.max(
        0,
        this.inspectScroll + direction * Math.max(1, this.inspectorRows() - 2),
      )
      return
    }
    const filtered = this.ensureFilter(this.build.nodes, parseQuery(this.queryText)).rows
    this.move(direction * 3, filtered.length)
  }

  private clampedCursor(length: number): number {
    return length === 0 ? 0 : Math.min(this.cursor, length - 1)
  }

  // ── geometry ─────────────────────────────────────────────────────────────

  private inspectorRows(): number {
    return this.expanded ? Math.max(4, this.viewportHeight - CHROME_ROWS - 3) : INSPECTOR_ROWS
  }

  private ledgerRows(inspectorRows: number): number {
    return Math.max(1, this.viewportHeight - CHROME_ROWS - inspectorRows - 1)
  }

  // ── render ────────────────────────────────────────────────────────────────

  render(width: number): string[] {
    const nodes = this.build.nodes
    const query = parseQuery(this.queryText)
    const { rows: filtered, indexes } = this.ensureFilter(nodes, query)
    const agg = this.ensureAggregate()

    const inspectorRows = this.inspectorRows()
    const ledgerRows = this.ledgerRows(inspectorRows)
    const bandWidth = Math.max(1, width - 4)

    const clampedCursor = this.clampedCursor(filtered.length)
    const windowStart = Math.max(
      0,
      Math.min(clampedCursor - Math.floor(ledgerRows / 2), filtered.length - ledgerRows),
    )

    const band = this.ensureBand(nodes, bandWidth)
    const matchColumns = this.ensureMatchColumns(band, indexes, query.empty)
    const focused = filtered[clampedCursor]
    const detail = this.ensureDetail(focused)

    // Pointer geometry rides along with the paint so handlePointer resolves
    // against exactly what is on screen (research §4.3).
    this.pointerBandWidth = bandWidth
    this.pointerBand = band
    this.pointerLedgerStart = windowStart
    this.pointerLedgerRows = ledgerRows

    const lines: string[] = [
      // The ✕ close affordance pins to the band's right end (source main):
      // the spread line gives up its last two cells for it.
      this.headerLine(agg, bandWidth - CLOSE_WIDTH) + fg('subtle', ' ✕'),
      this.tabsLine(agg, query, filtered.length, nodes.length, bandWidth),
      ...renderWaveBand({
        band,
        width: bandWidth,
        cursorColumn: columnOfIndex(band, indexes[clampedCursor] ?? 0),
        viewportStart: columnOfIndex(band, indexes[windowStart] ?? 0),
        viewportEnd: columnOfIndex(band, indexes[Math.min(filtered.length - 1, windowStart + ledgerRows - 1)] ?? 0),
        matches: matchColumns,
        tick: this.tick,
        alertTick: this.alertTick,
      }),
      // A line of ground between the wake and the content, on purpose.
      ' ',
    ]

    if (this.view === 'timeline') {
      this.pointerHotspot = undefined
      lines.push(
        ...renderLedger({
          rows: filtered,
          start: windowStart,
          height: ledgerRows,
          cursor: clampedCursor,
          width: width - 4,
          tick: this.tick,
          arrivalTick: this.arrivalTick,
          arrivalFrom: this.arrivalFrom,
        }),
        fg('permission', '─'.repeat(bandWidth)),
        ...renderInspector({
          node: focused,
          detail,
          height: inspectorRows,
          width: width - 4,
          expanded: this.expanded,
          scroll: this.inspectScroll,
        }),
      )
    } else {
      const hotspotHeight = ledgerRows + inspectorRows + 1
      this.pointerHotspot = hotspotPointerRows(agg, this.sort, hotspotHeight, this.hotCursor)
      lines.push(
        ...renderHotspotView({
          agg,
          sort: this.sort,
          width: width - 4,
          height: hotspotHeight,
          cursor: this.hotCursor,
          tick: this.tick,
          switchTick: this.switchTick,
        }),
      )
    }

    lines.push(' ', this.hintLine(agg))

    // The Ink original padded the whole scene by one column (`paddingX={1}`);
    // keep the same left margin so the ported geometry matches byte for byte.
    return lines.map((line) => ` ${line}`)
  }

  // ── chrome ────────────────────────────────────────────────────────────────

  /** Left text, a computed gap, right text — clipped to `width` columns. */
  private spread(left: string, right: string, width: number): { left: string; gap: string; right: string } {
    const rightText = truncateWidth(right, Math.max(0, width - 4))
    const room = width - visibleWidth(rightText)
    const leftText = truncateWidth(left, Math.max(0, room - 1))
    return {
      left: leftText,
      gap: ' '.repeat(Math.max(1, room - visibleWidth(leftText))),
      right: rightText,
    }
  }

  private headerLine(agg: TrajAggregate, width: number): string {
    const { totals } = agg
    const totalsText =
      t('traj-totals', { turns: totals.turns, steps: totals.rows }) +
      (totals.errors > 0 ? ` · ${t('traj-errors', { n: totals.errors })}` : '') +
      (totals.retries > 0 ? ` · ${t('traj-retries', { n: totals.retries })}` : '') +
      ` · ${formatDuration(totals.spanMs)}`

    const prefix = `✦ ${t('traj-title')}`
    const line = this.spread(`${prefix}  ${this.title ?? ''}`.trimEnd(), totalsText, width)
    const rest = line.left.startsWith(prefix) ? line.left.slice(prefix.length) : line.left
    return (
      fg('claude', line.left.startsWith(prefix) ? prefix : '', { bold: true }) +
      fg('subtle', rest) +
      line.gap +
      fg(totals.errors > 0 ? 'error' : 'subtle', line.right)
    )
  }

  private tabsLine(
    agg: TrajAggregate,
    query: TrajQuery,
    filteredLength: number,
    totalLength: number,
    width: number,
  ): string {
    const axisLabel =
      this.view === 'hotspot' ? t(`traj-sort-${this.sort}`) : t(`traj-proj-${this.projection}`)
    const tabTimeline =
      `${this.view === 'timeline' ? '●' : '○'} ${t('traj-tab-timeline')}  `
    const tabHotspot = `${this.view === 'hotspot' ? '●' : '○'} ${t('traj-tab-hotspot')}`
    const tabsLeft = tabTimeline + tabHotspot
    const querySegment =
      this.queryOpen || !query.empty
        ? `   / ${this.queryText}${this.queryOpen ? '▌' : ''}  ${t('traj-matches', { n: filteredLength, total: totalLength })}`
        : ''
    const line = this.spread(tabsLeft + querySegment, axisLabel, width)
    const tabs = line.left.length >= tabsLeft.length ? line.left.slice(0, tabsLeft.length) : line.left
    const queryPart = line.left.length >= tabsLeft.length ? line.left.slice(tabsLeft.length) : ''

    // Clickable segment ranges in CELL columns (pointer coordinates are
    // cells; the string-position split above only steers the coloring).
    // The spread clips the left side at its room budget, so every segment
    // end clamps to the actually-painted left width.
    const leftWidth = visibleWidth(line.left)
    const timelineEnd = Math.min(visibleWidth(tabTimeline), leftWidth)
    const hotspotEnd = Math.min(timelineEnd + visibleWidth(tabHotspot), leftWidth)
    const queryEnd =
      querySegment === ''
        ? hotspotEnd
        : Math.min(hotspotEnd + visibleWidth(querySegment), leftWidth)
    this.pointerTabs = {
      timelineEnd,
      hotspotEnd,
      queryEnd,
      leftEnd: leftWidth,
      axisStart: width - visibleWidth(line.right),
    }

    return (
      fg(this.view === 'timeline' ? 'permission' : 'subtle', tabs, { bold: this.view === 'timeline' }) +
      fg('suggestion', queryPart) +
      line.gap +
      fg('subtle', line.right)
    )
  }

  private hintLine(agg: TrajAggregate): string {
    const hints =
      this.view === 'hotspot'
        ? t('traj-hint-hotspot')
        : this.queryOpen
          ? t('traj-hint-query')
          : this.expanded
            ? t('traj-hint-expanded')
            : t('traj-hint-timeline')
    const { tokens } = agg.totals
    const suffix = tokens.input > 0 ? `   ${formatTokens(tokens.input)}→${formatTokens(tokens.output)}` : ''
    return hintWithBold(hints) + fg('subtle', suffix, { dim: true, italic: true })
  }
}

/** True when `data` carries no C0/DEL/C1 control characters. */
function hasNoControlChars(data: string): boolean {
  if (data.length === 0) return false
  for (const char of data) {
    const code = char.charCodeAt(0)
    if (code < 32 || code === 0x7f || (code >= 0x80 && code <= 0x9f)) return false
  }
  return true
}

/**
 * The old `<HintLine>`: a `t('hint-*')` string whose `**primary**` segment
 * is bold, inside the surrounding dim-italic line.
 */
function hintWithBold(text: string): string {
  const parts = text.split('**')
  let out = ''
  for (let index = 0; index < parts.length; index++) {
    out += fg(undefined, parts[index]!, { dim: true, italic: true, bold: index % 2 === 1 })
  }
  return out
}
