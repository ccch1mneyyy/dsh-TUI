/**
 * Transcript message list for the pi-tui chat screen (plan §1.3, WP-03).
 *
 * `TranscriptView` is the imperative pi-tui `Component` that replaces the old
 * React `MessageList`: the controller pushes bounded `TranscriptProjection`
 * snapshots via {@link update} (rows shared by reference; `meta.revision`
 * marks content change), and the view reconciles one cached
 * {@link RowComponent} per `ChatRow.id`:
 *
 * - new rows build a component, vanished rows drop theirs;
 * - the channel mutates row fields IN PLACE, so identity proves nothing — a
 *   cheap per-row fingerprint (`rows/shared.ts`) decides invalidation, and
 *   streaming rows are invalidated on EVERY revision (their text grows per
 *   chunk); subagent rows re-render whenever the channel's sync replaces
 *   `row.subagent` (a fresh object per sync);
 * - untouched rows return their cached lines with zero allocation.
 *
 * Long sessions fold behind the old `MAX_RENDERED_ROWS = 300` cap: older rows
 * collapse into a divider hint until {@link showAll} (chat screen's Ctrl+E).
 * `thinkingVisible` filters reasoning rows (the old Chat toggle); the
 * `expanded` (Ctrl+O verbose), `thinkingFold` and `activityFrames` toggles
 * live in the shared `RowContext` and invalidate the affected rows on change.
 * {@link invalidate} drops every cache — the theme-switch path (all colors
 * resolve lazily via `getActiveTheme()` at build time).
 *
 * Pointer (research §4.3): `handlePointer` resolves a click to a row through
 * the line spans recorded by the last {@link render} (the ScrollView delivers
 * `localY` in exactly this content-space indexing). Foldable cards toggle
 * per-row expansion (`RowContext.expandedRows` / `streamFoldedRows`), the
 * subagent card and the fold dividers act through the wired callbacks, plain
 * text rows never consume, and `cellIsBlank` vetoes clicks on a row's
 * unpainted tail. See {@link handlePointer} for the full contract.
 *
 * The same render pass also records the per-row timeline geometry
 * ({@link TranscriptRowGeometry}, research §3.4.2): precise startRow/height
 * for every row plus the turn preview/folded bits for user rows, exposed via
 * {@link rowGeometry} for the chat screen's timeline snapshot tick.
 * Recording rides the existing render cache, so scroll ticks never pay for
 * it (research §5.2).
 *
 * The view owns no keyboard handling and no timers; animation frames
 * (streaming spinner, running-tool elapsed) derive from the wall clock at
 * render time and advance with the controller's update stream.
 */
import type { Component, PointerEvent, TUI } from '../public.js'
import type { TranscriptProjection } from '../view-model.js'
import type { ChatRow } from '../../dsh-adapter/channel.js'
import { t } from '../../i18n.js'
import {
  createRowComponent,
  rowFingerprint,
  type RowComponent,
  type RowContext,
} from './rows/index.js'
import { warmCodeHighlight } from './rows/markdown-theme.js'
import { dividerLine } from './rows/style.js'
import { clipPreview } from '../timeline-model.js'

/** Render cap for very long sessions (CC's virtualization equivalent):
 *  older rows fold behind a divider until Ctrl+E expands them. */
const MAX_RENDERED_ROWS = 300

interface RowEntry {
  component: RowComponent
  row: ChatRow
  fingerprint: string
}

/**
 * One clickable line span of the last {@link TranscriptView.render} (research
 * §4.3). `start`/`end` are line indexes into the rendered output (content
 * space — the ScrollView translates pointer `localY` into exactly this
 * indexing). Recorded during render so the pointer handler never re-derives
 * row geometry.
 */
type TranscriptSpan =
  | { readonly kind: 'load-earlier'; readonly start: number; readonly end: number }
  | { readonly kind: 'show-all'; readonly start: number; readonly end: number }
  | { readonly kind: 'row'; readonly start: number; readonly end: number; readonly row: ChatRow }

/** The row variant of {@link TranscriptSpan}. */
type RowSpan = Extract<TranscriptSpan, { kind: 'row' }>

/**
 * One row's precise render geometry, recorded synchronously by
 * {@link TranscriptView.renderRows} (research §3.4.2) — the data layer
 * behind the timeline rail / sticky header / back-to-bottom pill (their
 * views are M4b). One record per `ChatRow`, in rows order:
 *
 * - `startRow`/`height` index into the last render's line output — the same
 *   transcript-local line space the pointer spans use; the consumer adds
 *   the transcript's offset inside the ScrollView content (the header
 *   height, research §3.4.3). −1/0 while the row is not rendered (the
 *   MAX_RENDERED_ROWS window sliced it away).
 * - For USER rows `startRow` is the prompt TEXT top, not the row wrapper
 *   top: the 1-line top margin counts (source: `margins.get(row.id) ===
 *   true ? 1 : 0`), so `scrollTo(startRow + headerHeight)` pins the prompt
 *   text to the viewport top exactly.
 * - `folded` (user rows only) marks the timeline's folded turns: the
 *   channel folded the row's full text away (`row.folded`) or the render
 *   window excludes it. A folded turn's `startRow` is not a navigation
 *   target — the reveal path (loadOlder/showAll) must run first.
 * - `preview` (user rows only) is the model's `clipPreview` of the prompt.
 */
export interface TranscriptRowGeometry {
  readonly rowId: number
  readonly kind: ChatRow['kind']
  readonly startRow: number
  readonly height: number
  readonly preview: string
  readonly folded: boolean
}

/** Shared empty geometry (pre-first-render reads must not allocate). */
const EMPTY_GEOMETRY: readonly TranscriptRowGeometry[] = Object.freeze([])

/** Row kinds whose click toggles the shared per-row expansion set. */
const CLICK_FOLD_KINDS = new Set(['tool', 'compact'])

export class TranscriptView implements Component {
  private readonly entries = new Map<number, RowEntry>()
  private readonly ctx: RowContext = {
    expanded: false,
    expandedRows: new Set<number>(),
    streamFoldedRows: new Set<number>(),
    thinkingFold: 'preview',
    activityFrames: undefined,
  }
  private rows: readonly ChatRow[] = []
  private lastRevision = -1
  private lastSessionEpoch = -1
  private showAllRows = false
  private thinkingVisible = true
  /** Width of the most recent {@link render} call — kept independently of
   *  the lines cache so a dropped cache (new projection) does not erase the
   *  knowledge of which width the geometry belongs to. */
  private lastWidth = 0
  /** clipPreview memo (the source MessageList's previewCacheRef): geometry
   *  re-records on every content change, but a row's preview changes only
   *  with its text, so the clip scan stays O(1) amortized per row. */
  private readonly previewCache = new Map<number, { len: number; preview: string }>()
  private cache: { width: number; lines: string[]; spans: TranscriptSpan[]; geometry: TranscriptRowGeometry[] } | undefined

  /**
   * Pointer seams (research §4.3), wired by the chat screen:
   * - `onOpenSubagent` — subagent card click opens the detail scene (the
   *   dashboard Enter path's target, by agent id);
   * - `onLoadOlder` — the load-earlier divider's click, the scroll-top
   *   trigger's command-sink path;
   * - `isPointerBlocked` — the §1.3 ownership gate mirrored one level down:
   *   while a modal/panel owns the keyboard the transcript consumes every
   *   pointer event without acting, exactly what the ChatScreen root
   *   backstop did before the transcript grew its own handler.
   */
  onOpenSubagent: ((agentId: string) => void) | undefined
  onLoadOlder: (() => void) | undefined
  isPointerBlocked: (() => boolean) | undefined

  constructor(private readonly ui?: TUI) {
    // Lazy cli-highlight load (old Markdown.tsx behavior): code blocks render
    // plain until the highlighter arrives, then one invalidate + repaint.
    warmCodeHighlight(() => {
      this.invalidate()
      this.ui?.requestRender()
    })
  }

  /** Push the newest transcript projection (controller → component flow). */
  update(vm: TranscriptProjection): void {
    if (vm.meta.sessionEpoch !== this.lastSessionEpoch) {
      // /new, /resume, model swap: row ids restart per session, so cached
      // components keyed by id must not leak across the boundary — and
      // neither may the per-row click state keyed by the same ids.
      this.lastSessionEpoch = vm.meta.sessionEpoch
      this.lastRevision = -1
      this.entries.clear()
      this.ctx.expandedRows = new Set<number>()
      this.ctx.streamFoldedRows = new Set<number>()
      this.previewCache.clear()
    }
    const revisionChanged = vm.meta.revision !== this.lastRevision
    if (!revisionChanged && vm.rows === this.rows) return
    this.lastRevision = vm.meta.revision
    this.rows = vm.rows

    const nowMs = Date.now()
    const seen = new Set<number>()
    for (const row of vm.rows) {
      seen.add(row.id)
      const entry = this.entries.get(row.id)
      if (entry === undefined) {
        this.entries.set(row.id, {
          component: createRowComponent(row, this.ctx),
          row,
          fingerprint: rowFingerprint(row, nowMs),
        })
        continue
      }
      const subagentChanged = row.subagent !== entry.row.subagent
      const fingerprint = rowFingerprint(row, nowMs)
      if (
        revisionChanged &&
        (fingerprint !== entry.fingerprint || row.streaming === true || subagentChanged)
      ) {
        entry.component.invalidate()
      }
      entry.row = row
      entry.component.setRow(row)
      entry.fingerprint = fingerprint
    }
    for (const [id] of this.entries) {
      if (seen.has(id)) continue
      this.entries.delete(id)
      // A vanished row never comes back under the same id (session restore
      // re-keys), so its click state is pruned with its cache entry.
      if (this.ctx.expandedRows.has(id) || this.ctx.streamFoldedRows.has(id)) {
        const expanded = new Set(this.ctx.expandedRows)
        const folded = new Set(this.ctx.streamFoldedRows)
        expanded.delete(id)
        folded.delete(id)
        this.ctx.expandedRows = expanded
        this.ctx.streamFoldedRows = folded
      }
    }
    this.cache = undefined
  }

  /** Ctrl+E: lift the MAX_RENDERED_ROWS fold (chat screen wires the key). */
  showAll(): void {
    if (this.showAllRows) return
    this.showAllRows = true
    this.cache = undefined
  }

  /** Re-apply the MAX_RENDERED_ROWS fold after {@link showAll}. */
  collapse(): void {
    if (!this.showAllRows) return
    this.showAllRows = false
    this.cache = undefined
  }

  /** True while the MAX_RENDERED_ROWS fold is lifted. */
  get isShowingAll(): boolean {
    return this.showAllRows
  }

  /** True while Ctrl+O verbose expansion is on (the chat screen owns the
   *  UI-local toggle; this mirrors it for tests and future chrome). */
  get expanded(): boolean {
    return this.ctx.expanded
  }

  /** Width of the last {@link render} (0 before the first frame). The chat
   *  screen's loadOlder viewport anchor re-measures at exactly this width so
   *  the before/after heights are comparable, and the timeline tick
   *  re-renders at it to refresh the row geometry within the same tick. */
  get renderWidth(): number {
    return this.lastWidth
  }

  /** Height in lines of the last {@link render} (0 before the first frame). */
  get renderedHeight(): number {
    return this.cache?.lines.length ?? 0
  }

  /** Show/hide reasoning rows entirely (the old Chat thinking toggle). */
  setThinkingVisible(visible: boolean): void {
    if (this.thinkingVisible === visible) return
    this.thinkingVisible = visible
    this.cache = undefined
  }

  get thinkingShown(): boolean {
    return this.thinkingVisible
  }

  /** Ctrl+O verbose: full reasoning, full tool args/results, uncapped bodies. */
  setExpanded(expanded: boolean): void {
    if (this.ctx.expanded === expanded) return
    this.ctx.expanded = expanded
    this.invalidate()
  }

  /** Channel thinking-block display mode (streaming preview vs full). */
  setThinkingFold(fold: 'preview' | 'full'): void {
    if (this.ctx.thinkingFold === fold) return
    this.ctx.thinkingFold = fold
    this.invalidate()
  }

  /** Working-activity preset name for the subagent card's running glyph. */
  setActivityFrames(name: string | undefined): void {
    if (this.ctx.activityFrames === name) return
    this.ctx.activityFrames = name
    this.invalidate()
  }

  /** Drop every row cache (theme switch, external style change). */
  invalidate(): void {
    for (const [, entry] of this.entries) entry.component.invalidate()
    this.cache = undefined
  }

  render(width: number): string[] {
    const safeWidth = Math.max(0, Math.floor(width))
    if (safeWidth > 0) this.lastWidth = safeWidth
    if (this.cache !== undefined && this.cache.width === safeWidth) {
      return this.cache.lines
    }

    const { lines, spans, geometry } = this.renderRows(safeWidth, false)
    this.cache = { width: safeWidth, lines, spans, geometry }
    return lines
  }

  /**
   * Row geometry of the last {@link render} (research §3.4.2), in rows
   * order; empty before the first frame. The array is replaced (never
   * mutated) with the render cache, so a retained reference stays coherent
   * until the next re-render. The chat screen's timeline tick re-renders at
   * the last width before reading this, so the geometry reflects the newest
   * projection within the same update tick.
   */
  get rowGeometry(): readonly TranscriptRowGeometry[] {
    return this.cache?.geometry ?? EMPTY_GEOMETRY
  }

  /**
   * Transcript click semantics (research §4.3 final state):
   *
   * - tool / compact / settled-reasoning rows toggle their per-row expansion
   *   (`expandedRows`); a STREAMING reasoning row toggles `streamFoldedRows`
   *   instead (its default is the live view, the opposite default);
   * - a subagent card opens the detail scene through `onOpenSubagent`;
   * - the load-earlier / show-previous dividers act like their keyboard
   *   seats (the scroll-top loadOlder sink path, Ctrl+E);
   * - plain user/assistant/notice/local rows never consume: the transcript
   *   stays a reading area and terminal drag selection keeps working;
   * - `cellIsBlank` guards every action — a click on the unpainted right
   *   tail of a full-width row is a selection attempt, not a toggle;
   * - only `click` is handled (and consumed) when it acts. press/release/
   *   move stay unconsumed (selection), wheel falls through to the
   *   ScrollView route. A drag release never dispatches a click, so a
   *   selection can never toggle a card (dispatch contract §4.2.4).
   */
  handlePointer(event: PointerEvent): boolean | void {
    if (this.isPointerBlocked?.() === true) return true
    if (event.type !== 'click' || event.button !== 0) return undefined
    if (event.cellIsBlank) return undefined
    const span = this.cache?.spans.find(
      (candidate) => event.localY >= candidate.start && event.localY < candidate.end,
    )
    if (span === undefined) return undefined
    if (span.kind === 'load-earlier') {
      if (this.onLoadOlder === undefined) return undefined
      this.onLoadOlder()
      return true
    }
    if (span.kind === 'show-all') {
      this.showAll()
      return true
    }
    const row = span.row
    if (CLICK_FOLD_KINDS.has(row.kind)) {
      this.toggleRowExpanded(row.id)
      return true
    }
    if (row.kind === 'reasoning') {
      if (row.streaming === true) this.toggleStreamFolded(row.id)
      else this.toggleRowExpanded(row.id)
      return true
    }
    if (row.kind === 'subagent') {
      const agentId = row.subagent?.agentId
      if (agentId === undefined || this.onOpenSubagent === undefined) return undefined
      this.onOpenSubagent(agentId)
      return true
    }
    return undefined
  }

  /** One row's click-fold toggle (source `toggleRowExpanded`): the set is
   *  REPLACED so a retained reference can never mutate under a reader. */
  private toggleRowExpanded(rowId: number): void {
    const next = new Set(this.ctx.expandedRows)
    if (next.has(rowId)) next.delete(rowId)
    else next.add(rowId)
    this.ctx.expandedRows = next
    this.invalidateRow(rowId)
  }

  /** Streaming reasoning fold toggle (source `toggleStreamFolded`). */
  private toggleStreamFolded(rowId: number): void {
    const next = new Set(this.ctx.streamFoldedRows)
    if (next.has(rowId)) next.delete(rowId)
    else next.add(rowId)
    this.ctx.streamFoldedRows = next
    this.invalidateRow(rowId)
  }

  /** Drop one row's cache plus the list-level lines/spans cache. */
  private invalidateRow(rowId: number): void {
    this.entries.get(rowId)?.component.invalidate()
    this.cache = undefined
  }

  /**
   * Fullscreen exit replay (plan §1.2): the normal {@link render} folds long
   * sessions behind MAX_RENDERED_ROWS, but the scrollback replay must carry
   * the COMPLETE transcript. Uncapped and uncached — a one-shot path. The
   * click spans are dropped with the lines: pointer events only ever resolve
   * against the live (capped, cached) render.
   */
  renderFullTranscript(width: number): string[] {
    return this.renderRows(Math.max(0, Math.floor(width)), true).lines
  }

  private renderRows(safeWidth: number, uncapped: boolean): { lines: string[]; spans: TranscriptSpan[]; geometry: TranscriptRowGeometry[] } {
    const lines: string[] = []
    const spans: TranscriptSpan[] = []
    // CC-style "load earlier" affordance: the session log still holds folded
    // rows. The chat screen restores them through the command sink when the
    // user scrolls to the very top (M2.4) — or clicks this divider, which the
    // pointer handler routes to the same sink path (research §4.3).
    if (this.rows.some((row) => row.folded)) {
      const start = lines.length
      lines.push('', dividerLine(t('load-earlier'), safeWidth))
      spans.push({ kind: 'load-earlier', start, end: lines.length })
    }
    const hiddenCount = this.rows.length - MAX_RENDERED_ROWS
    if (!uncapped && !this.showAllRows && hiddenCount > 0) {
      const start = lines.length
      lines.push('', dividerLine(t('show-previous-messages', { n: hiddenCount }), safeWidth))
      spans.push({ kind: 'show-all', start, end: lines.length })
    }

    // The thinking filter runs after the cap slice, mirroring the old list
    // (window indices line up with the unfiltered array).
    const visibleRows = (
      uncapped || this.showAllRows || hiddenCount <= 0 ? this.rows : this.rows.slice(hiddenCount)
    ).filter((row) => this.thinkingVisible || row.kind !== 'reasoning')

    let marginTop = false
    for (const row of visibleRows) {
      const entry = this.entries.get(row.id)
      // Rows render only after an update() registered them; a render called
      // before the first update yields an empty transcript, not a crash.
      if (entry === undefined) continue
      const start = lines.length
      lines.push(...entry.component.render(safeWidth, marginTop))
      spans.push({ kind: 'row', start, end: lines.length, row })
      marginTop = true
    }

    return { lines, spans, geometry: this.recordGeometry(spans) }
  }

  /**
   * Timeline geometry derivation (research §3.4.2), folded into the render
   * pass so consumers never re-measure. One record per `ChatRow` in rows
   * order. The row spans are order-aligned with `rows` (visibleRows is a
   * slice+filter of it and spans follow render order), so the walk is a
   * two-pointer merge with no per-row map; the top-margin flag is the row
   * span's ordinal (every rendered row after the first takes the margin).
   * Runs only on a real re-render (the cache gates render()), never on
   * scroll ticks — the transcript hot path is untouched (research §5.2).
   */
  private recordGeometry(spans: readonly TranscriptSpan[]): TranscriptRowGeometry[] {
    if (this.rows.length === 0) return []
    const geometry: TranscriptRowGeometry[] = new Array(this.rows.length)
    let spanIndex = 0
    // The dividers lead; row spans never interleave with them.
    while (spanIndex < spans.length && spans[spanIndex]!.kind !== 'row') spanIndex++
    let ordinal = 0
    for (let i = 0; i < this.rows.length; i++) {
      const row = this.rows[i]!
      let measured: RowSpan | undefined
      const span = spanIndex < spans.length ? spans[spanIndex]! : undefined
      if (span !== undefined && span.kind === 'row' && span.row.id === row.id) {
        measured = span
        spanIndex++
        while (spanIndex < spans.length && spans[spanIndex]!.kind !== 'row') spanIndex++
      }
      if (measured === undefined) {
        // Not rendered (the MAX_RENDERED_ROWS window sliced it away, or its
        // component is not registered yet). A window-excluded USER row is a
        // folded turn by construction — the thinking filter never removes
        // user rows, so absence from the spans is exactly the fold signal.
        geometry[i] = row.kind === 'user'
          ? { rowId: row.id, kind: row.kind, startRow: -1, height: 0, preview: this.rowPreview(row), folded: true }
          : { rowId: row.id, kind: row.kind, startRow: -1, height: 0, preview: '', folded: false }
        continue
      }
      // Every rendered row after the first takes the 1-line top margin.
      const margin = ordinal > 0
      ordinal++
      if (row.kind !== 'user') {
        geometry[i] = {
          rowId: row.id,
          kind: row.kind,
          startRow: measured.start,
          height: measured.end - measured.start,
          preview: '',
          folded: false,
        }
        continue
      }
      // User turn: startRow is the prompt TEXT top — wrapper top plus the
      // margin (source: `margins.get(row.id) === true ? 1 : 0`). A
      // channel-folded row keeps its measured span (it still renders its
      // preview text) but is a folded TURN: its rendered content is not the
      // real prompt, so navigation must reveal it first.
      geometry[i] = {
        rowId: row.id,
        kind: row.kind,
        startRow: measured.start + (margin ? 1 : 0),
        height: measured.end - measured.start,
        preview: this.rowPreview(row),
        folded: row.folded === true,
      }
    }
    return geometry
  }

  /** clipPreview behind the id-keyed memo (see {@link previewCache}). */
  private rowPreview(row: ChatRow): string {
    let cached = this.previewCache.get(row.id)
    if (cached === undefined || cached.len !== row.text.length) {
      if (this.previewCache.size > 2000) this.previewCache.clear()
      cached = { len: row.text.length, preview: clipPreview(row.text) }
      this.previewCache.set(row.id, cached)
    }
    return cached.preview
  }
}
