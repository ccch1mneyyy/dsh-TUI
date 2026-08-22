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
 * The view owns no keyboard handling and no timers; animation frames
 * (streaming spinner, running-tool elapsed) derive from the wall clock at
 * render time and advance with the controller's update stream.
 */
import type { Component, TUI } from '../public.js'
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

/** Render cap for very long sessions (CC's virtualization equivalent):
 *  older rows fold behind a divider until Ctrl+E expands them. */
const MAX_RENDERED_ROWS = 300

interface RowEntry {
  component: RowComponent
  row: ChatRow
  fingerprint: string
}

export class TranscriptView implements Component {
  private readonly entries = new Map<number, RowEntry>()
  private readonly ctx: RowContext = {
    expanded: false,
    thinkingFold: 'preview',
    activityFrames: undefined,
  }
  private rows: readonly ChatRow[] = []
  private lastRevision = -1
  private lastSessionEpoch = -1
  private showAllRows = false
  private thinkingVisible = true
  private cache: { width: number; lines: string[] } | undefined

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
      // components keyed by id must not leak across the boundary.
      this.lastSessionEpoch = vm.meta.sessionEpoch
      this.lastRevision = -1
      this.entries.clear()
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
      if (!seen.has(id)) this.entries.delete(id)
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
    if (this.cache !== undefined && this.cache.width === safeWidth) {
      return this.cache.lines
    }

    const lines = this.renderRows(safeWidth, false)
    this.cache = { width: safeWidth, lines }
    return lines
  }

  /**
   * Fullscreen exit replay (plan §1.2): the normal {@link render} folds long
   * sessions behind MAX_RENDERED_ROWS, but the scrollback replay must carry
   * the COMPLETE transcript. Uncapped and uncached — a one-shot path.
   */
  renderFullTranscript(width: number): string[] {
    return this.renderRows(Math.max(0, Math.floor(width)), true)
  }

  private renderRows(safeWidth: number, uncapped: boolean): string[] {
    const lines: string[] = []
    // CC-style "load earlier" affordance: the session log still holds folded
    // rows (informational only — the old click→loadOlder command is not
    // wired into this projection yet).
    if (this.rows.some((row) => row.folded)) {
      lines.push('', dividerLine(t('load-earlier'), safeWidth))
    }
    const hiddenCount = this.rows.length - MAX_RENDERED_ROWS
    if (!uncapped && !this.showAllRows && hiddenCount > 0) {
      lines.push('', dividerLine(t('show-previous-messages', { n: hiddenCount }), safeWidth))
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
      lines.push(...entry.component.render(safeWidth, marginTop))
      marginTop = true
    }

    return lines
  }
}
