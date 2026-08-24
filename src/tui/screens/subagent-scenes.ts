/**
 * Subagent dashboard and detail scenes (WP-03 imperative port of the React
 * `src/components/SubagentDashboard.tsx` and `SubagentDetailScene.tsx`).
 *
 * - {@link SubagentDashboardScreen}: a counts header (running / completed /
 *   failed) over a scrollable list of SubagentCardView rows. ↑/↓ moves the
 *   focus row and the scroll window follows it; an unmodified Enter opens
 *   the detail through `onSelect(agentId)`; Esc / Ctrl+C closes via
 *   `onClose()`. Pointer (research §4.3): the counts row's right-end ✕ is
 *   the Esc-equivalent close click and the wheel steps the focus row; card
 *   rows stay keyboard-Enter only (source main parity — the transcript's
 *   subagent card is the click-to-detail path).
 * - {@link SubagentDetailScreen}: paged full-screen view of one subagent
 *   (summary | output | tools). ←/→ turns pages (scroll resets), ↑/↓
 *   scrolls the body, X interrupts a running subagent through
 *   `commands.query.subagentInterrupt`, Esc / Ctrl+C / an unmodified Enter
 *   returns via `onBack()`. Pointer: tab cells switch pages with the turn
 *   semantics, the hint row's `X interrupt` segment runs the x key's command
 *   path, the identity row's ✕ takes the onBack seat, and the wheel scrolls
 *   the body. The output page tail-follows the newest streamed line while
 *   the subagent runs; page turns and settlement stop the follow so manual
 *   ↑ scrolling wins.
 *
 * Both are imperative pi-tui Components fed by `update(...)` projections
 * (plan §1.3) — no React/Ink/Yoga, no Channel/Cordis/Agent, no stdio.
 */
import chalk from 'chalk'
import {
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
  type PointerEvent,
} from '../public.js'
import type { TuiCommands } from '../commands.js'
import type { SubagentsProjection } from '../view-model.js'
import type { SubagentState } from '../../dsh-adapter/subagents.js'
import { t } from '../../i18n.js'
import {
  SubagentCardView,
  formatDetailDuration,
  formatTimestamp,
  isSubagentRunning,
  subagentElapsed,
  subagentStatusVisual,
  subagentTokensTotal,
  themeKeyFg,
  toolNameThemeKey,
} from '../components/subagent-card.js'

/** Lines scrolled per ↑/↓ press (the old scenes' `scrollBy(3)`). */
const SCROLL_STEP = 3
/** Horizontal inset the old scenes applied (`paddingX={2}` on both sides). */
const SIDE_PADDING = 2
const DEFAULT_VIEWPORT_ROWS = 24
/** Width of the clickable ` ✕` close/back affordance (source main's
 *  ExitButton) pinned to a chrome row's right end. */
const CLOSE_WIDTH = 2
/** Dashboard screen row of the counts line (after pad/divider/pad). */
const DASHBOARD_COUNTS_ROW = 3
/** Detail screen row of the identity line (after the top pad). */
const DETAIL_IDENTITY_ROW = 1

/** A chrome row with a ` ✕` cell pinned to the right end of the content
 *  width — the mouse equivalent of the scene's Esc seat (source main). */
function withCloseCell(text: string, contentWidth: number): string {
  const left = truncateToWidth(text, Math.max(0, contentWidth - CLOSE_WIDTH), '…')
  const gap = ' '.repeat(Math.max(0, contentWidth - CLOSE_WIDTH - visibleWidth(left)))
  return `${left}${gap}${chalk.dim(' ✕')}`
}

/** Divider in the Claude Code visual language: `────── title ──────`, the
 *  dashes and title in one palette slot (dim when no slot is given). */
function dividerLine(width: number, title: string, colorKey: 'claude' | 'subtle'): string {
  const paint = (line: string): string => themeKeyFg(colorKey, line)
  const titleWidth = visibleWidth(title)
  if (title !== '' && titleWidth < width) {
    const lineWidth = width - titleWidth
    return paint(`${'─'.repeat(Math.floor(lineWidth / 2))}${title}${'─'.repeat(Math.ceil(lineWidth / 2))}`)
  }
  return paint('─'.repeat(width))
}

/** Item separator between dashboard rows (old: 20–72 dashes, width-6). */
function rowSeparator(width: number): string {
  return chalk.dim('─'.repeat(Math.max(20, Math.min(72, width))))
}

// ── dashboard ─────────────────────────────────────────────────────────────

export interface SubagentDashboardHandlers {
  onClose(): void
  onSelect?(agentId: string): void
}

/**
 * Subagent dashboard scene. Chrome rows: top pad, title divider, blank,
 * counts, blank, then the list window, then footer divider, hint, bottom
 * pad — 8 rows total around the list.
 */
export class SubagentDashboardScreen implements Component {
  private items: readonly SubagentState[] = []
  private focusIndex = 0
  private scrollOffset = 0
  private viewportRows = DEFAULT_VIEWPORT_ROWS
  private readonly cards = new Map<string, SubagentCardView>()
  /** Content width of the last render; locates the counts row's ✕ cell. */
  private pointerContentWidth = 0

  constructor(
    private readonly commands: TuiCommands,
    private readonly handlers: SubagentDashboardHandlers,
  ) {}

  /** Push the newest subagents projection (arrays shared by reference). */
  update(vm: SubagentsProjection): void {
    this.items = vm.items
    if (this.focusIndex > this.items.length - 1) this.focusIndex = Math.max(0, this.items.length - 1)
    const live = new Set(this.items.map(item => item.agentId))
    for (const id of this.cards.keys()) {
      if (!live.has(id)) this.cards.delete(id)
    }
  }

  /** Rows the scene may occupy; the list window gets what chrome leaves. */
  setViewportHeight(rows: number): void {
    this.viewportRows = Math.max(1, Math.floor(rows))
  }

  invalidate(): void {
    for (const card of this.cards.values()) card.invalidate()
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl('c'))) {
      this.handlers.onClose()
      return
    }
    if (matchesKey(data, Key.up)) {
      this.focusIndex = Math.max(0, this.focusIndex - 1)
      return
    }
    if (matchesKey(data, Key.down)) {
      this.focusIndex = Math.min(this.items.length - 1, this.focusIndex + 1)
      return
    }
    // Only an unmodified Enter confirms (matchesKey(enter) rejects modifiers).
    if (matchesKey(data, Key.enter) && this.handlers.onSelect !== undefined) {
      const selected = this.items[this.focusIndex]
      if (selected !== undefined) this.handlers.onSelect(selected.agentId)
    }
  }

  render(width: number): string[] {
    if (width <= 0) return []
    const contentWidth = Math.max(1, width - SIDE_PADDING * 2)
    const pad = (line: string): string => ' '.repeat(SIDE_PADDING) + line
    const listRows = Math.max(1, this.viewportRows - 8)

    const running = this.items.filter(s => s.status === 'running').length
    const completed = this.items.filter(s => s.status === 'completed').length
    const failed = this.items.filter(s => s.status === 'failed').length
    const counts = [
      `${themeKeyFg('claude', String(running))}${chalk.dim(` ${t('subagent-count-running')}`)}`,
      `${themeKeyFg('success', String(completed))}${chalk.dim(` ${t('subagent-count-completed')}`)}`,
    ]
    if (failed > 0) counts.push(`${themeKeyFg('error', String(failed))}${chalk.dim(` ${t('subagent-count-failed')}`)}`)

    // Pointer geometry rides along with the paint (research §4.3).
    this.pointerContentWidth = contentWidth

    const body = this.items.length === 0
      ? this.renderEmpty(listRows, contentWidth)
      : this.renderList(listRows, contentWidth)

    const hint = this.handlers.onSelect !== undefined
      ? t('subagent-dashboard-hint-detail')
      : t('subagent-dashboard-hint-basic')
    return [
      '',
      pad(dividerLine(contentWidth, t('subagent-dashboard-title'), 'claude')),
      '',
      pad(withCloseCell(counts.join('   '), contentWidth)),
      '',
      ...body.map(pad),
      pad(dividerLine(contentWidth, '', 'subtle')),
      pad(chalk.dim(hint)),
      '',
    ].slice(0, this.viewportRows)
  }

  /**
   * Pointer parity (research §4.3): the counts row's right-end ✕ closes the
   * dashboard (the Esc seat); a wheel steps the focus row like ↑/↓. Card
   * rows deliberately stay keyboard-Enter only, as on source main — the
   * transcript's own subagent card is the click-to-detail path. All clicks
   * and wheels inside the scene are consumed (full-screen transient modal);
   * press/release/move stay unconsumed so drag-selection copy keeps working.
   */
  handlePointer(event: PointerEvent): boolean | void {
    if (event.type === 'click') {
      if (
        event.button === 0 &&
        event.localY === DASHBOARD_COUNTS_ROW &&
        event.localX - SIDE_PADDING >= this.pointerContentWidth - CLOSE_WIDTH
      ) {
        this.handlers.onClose()
      }
      return true
    }
    if (event.type === 'wheel') {
      if (event.deltaY !== 0 && this.items.length > 0) {
        const direction = event.deltaY > 0 ? 1 : -1
        this.focusIndex = Math.max(0, Math.min(this.items.length - 1, this.focusIndex + direction))
      }
      return true
    }
    return undefined
  }

  /** Empty state: dim, horizontally centered block under a top margin. */
  private renderEmpty(listRows: number, contentWidth: number): string[] {
    const center = (line: string): string =>
      ' '.repeat(Math.max(0, Math.floor((contentWidth - visibleWidth(line)) / 2))) + line
    const lines: string[] = []
    for (let i = 0; i < Math.max(2, Math.floor((this.viewportRows - 16) / 3)); i++) lines.push('')
    lines.push(center(chalk.dim('○')), center(chalk.dim(t('subagent-none'))), '', center(chalk.dim(t('subagent-empty-hint'))))
    return lines.slice(0, listRows)
  }

  /** Card rows with separators; the window keeps the focused row visible. */
  private renderList(listRows: number, contentWidth: number): string[] {
    const lines: string[] = []
    const starts: number[] = []
    const ends: number[] = []
    this.items.forEach((subagent, index) => {
      let card = this.cards.get(subagent.agentId)
      if (card === undefined) {
        card = new SubagentCardView(subagent)
        this.cards.set(subagent.agentId, card)
      }
      card.update(subagent)
      card.setFocused(index === this.focusIndex)
      starts.push(lines.length)
      lines.push(...card.render(contentWidth))
      ends.push(lines.length)
      if (index < this.items.length - 1) lines.push(rowSeparator(contentWidth - 2))
    })
    // Follow the focus: scroll just enough to keep the focused row visible.
    const focusStart = starts[this.focusIndex] ?? 0
    const focusEnd = ends[this.focusIndex] ?? 0
    if (focusStart < this.scrollOffset) this.scrollOffset = focusStart
    if (focusEnd > this.scrollOffset + listRows) this.scrollOffset = focusEnd - listRows
    this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, Math.max(0, lines.length - listRows)))
    return lines.slice(this.scrollOffset, this.scrollOffset + listRows)
  }
}

// ── detail ────────────────────────────────────────────────────────────────

const PAGES = ['summary', 'output', 'tools'] as const
type DetailPage = (typeof PAGES)[number]

export interface SubagentDetailHandlers {
  onBack(): void
}

/**
 * Subagent detail scene: fixed header (identity + stats + timing + error),
 * a tab bar with page indicator, then the paged scrollable body. Follow-up
 * delivery is intentionally absent (as in the old scene): the official seam
 * only accepts continuable children and one-shot spawn children are disposed
 * at settlement, so the affordance would be a dead control.
 */
export class SubagentDetailScreen implements Component {
  private subagent: SubagentState | undefined
  private page: DetailPage = 'summary'
  private scrollOffset = 0
  private followOutput = false
  private viewportRows = DEFAULT_VIEWPORT_ROWS
  // ── pointer geometry (recorded per render; research §4.3) ──────────────
  /** Content width of the last render; locates the identity row's ✕ cell. */
  private pointerContentWidth = 0
  /** Tab bar: screen row plus each tab's content-column range. */
  private pointerTabs: { row: number; ranges: { start: number; end: number; page: DetailPage }[] } | undefined
  /** The hint row's `X interrupt` segment (present only while running). */
  private pointerInterrupt: { row: number; start: number; end: number } | undefined

  constructor(
    private readonly commands: TuiCommands,
    private readonly handlers: SubagentDetailHandlers,
    subagent?: SubagentState,
  ) {
    this.subagent = subagent
  }

  /** Push the newest snapshot of the viewed subagent. */
  update(subagent: SubagentState): void {
    this.subagent = subagent
  }

  /** Rows the scene may occupy; the body window gets what chrome leaves. */
  setViewportHeight(rows: number): void {
    this.viewportRows = Math.max(1, Math.floor(rows))
  }

  invalidate(): void {}

  handleInput(data: string): void {
    const subagent = this.subagent
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl('c'))) {
      this.handlers.onBack()
      return
    }
    if (matchesKey(data, Key.left)) {
      this.turnPage(-1)
      return
    }
    if (matchesKey(data, Key.right)) {
      this.turnPage(1)
      return
    }
    if (matchesKey(data, Key.up)) {
      this.scrollOffset = Math.max(0, this.scrollOffset - SCROLL_STEP)
      return
    }
    if (matchesKey(data, Key.down)) {
      this.scrollOffset += SCROLL_STEP // clamped against the body at render
      return
    }
    // Old scene: input.toLowerCase() === 'x' — both x and X interrupt.
    if ((matchesKey(data, 'x') || matchesKey(data, Key.shift('x'))) && subagent !== undefined && isSubagentRunning(subagent)) {
      this.commands.query.subagentInterrupt(subagent.agentId)
      return
    }
    // Only an unmodified Enter confirms (matchesKey(enter) rejects modifiers).
    if (matchesKey(data, Key.enter)) {
      this.handlers.onBack()
    }
  }

  render(width: number): string[] {
    const subagent = this.subagent
    if (subagent === undefined || width <= 0) return []
    const contentWidth = Math.max(1, width - SIDE_PADDING * 2)
    const pad = (line: string): string => ' '.repeat(SIDE_PADDING) + line

    const running = isSubagentRunning(subagent)
    const elapsed = subagentElapsed(subagent)
    const info = subagentStatusVisual(subagent.status)
    const totalTokens = subagentTokensTotal(subagent)
    const pageIndex = PAGES.indexOf(this.page)

    // Header: identity line, stats line, timing line, optional error.
    const head: string[] = [
      '',
      pad(withCloseCell(
        `${themeKeyFg(info.color, chalk.bold(info.glyph))} ${chalk.bold(`${t('subagent-card-prefix')}${subagent.description}`)}${chalk.dim(' · ')}${themeKeyFg(info.color, info.label)}`,
        contentWidth,
      )),
      pad(`${subagent.model ?? subagent.provider ?? 'default'}${chalk.dim(` · ${formatDetailDuration(elapsed)} · ${totalTokens || '—'} tok · ${subagent.toolCalls.length} tools`)}`),
      pad(chalk.dim(
        `${t('subagent-started')} ${formatTimestamp(subagent.startedAt)}` +
        (subagent.completedAt !== undefined ? ` · ${t('subagent-completed')} ${formatTimestamp(subagent.completedAt)}` : '') +
        ` · id ${subagent.agentId}`,
      )),
    ]
    if (subagent.error !== undefined && subagent.error !== '') {
      for (const line of wrapTextWithAnsi(`${t('subagent-error-label')}: ${subagent.error}`, contentWidth)) {
        head.push(pad(themeKeyFg('error', line)))
      }
    }

    // Tab bar with page indicator. Each tab cell is clickable (the ←/→ page
    // turn's mouse equivalent); ranges land in pointerTabs in CONTENT
    // columns, one `│` separator cell wide between cells.
    const tabRanges: { start: number; end: number; page: DetailPage }[] = []
    let tabColumn = 0
    const tabs = PAGES.map((name, index) => {
      const label = name === 'summary' ? t('subagent-tab-summary') : name === 'output' ? t('subagent-output-label') : t('subagent-tools')
      const active = index === pageIndex
      const cellWidth = visibleWidth(label) + 2
      tabRanges.push({ start: tabColumn, end: tabColumn + cellWidth, page: name })
      tabColumn += cellWidth + (index === PAGES.length - 1 ? 0 : 1)
      const cell = active ? themeKeyFg('claude', chalk.bold.inverse(` ${label} `)) : ` ${label} `
      return index === PAGES.length - 1 ? cell : `${cell}${chalk.dim('│')}`
    }).join('')
    const tabsRow = head.length + 1
    head.push('', pad(`${tabs}${chalk.dim(`  ${pageIndex + 1}/${PAGES.length}`)}`), pad(rowSeparator(contentWidth - 2)))

    const hintPrefix = `←/→ ${t('subagent-hint-page')} · ↑/↓ ${t('subagent-hint-scroll')}`
    // The `X interrupt` hint segment is clickable while running (the x key's
    // command path); its cell range is recorded for the pointer handler.
    const interruptSegment = running ? ' · X interrupt' : ''
    const foot = [pad(dividerLine(contentWidth, '', 'subtle')), pad(chalk.dim(
      hintPrefix + interruptSegment + ` · Esc ${t('subagent-hint-back')}`,
    )), '']

    const bodyRows = Math.max(1, this.viewportRows - head.length - foot.length)
    const body = this.renderBody(subagent, running, totalTokens, elapsed, contentWidth)
    const maxOffset = Math.max(0, body.length - bodyRows)
    // tail -f: while the subagent runs and the output page shows, follow the
    // newest streamed line. Page turns and settlement stop the follow.
    if (this.page === 'output' && running && this.followOutput) this.scrollOffset = maxOffset
    this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, maxOffset))
    const windowed = body.slice(this.scrollOffset, this.scrollOffset + bodyRows)

    // Pointer geometry rides along with the paint (research §4.3).
    this.pointerContentWidth = contentWidth
    this.pointerTabs = { row: tabsRow, ranges: tabRanges }
    const interruptStart = visibleWidth(hintPrefix) + 2
    this.pointerInterrupt = running
      ? { row: head.length + windowed.length + 1, start: interruptStart, end: interruptStart + 'X interrupt'.length }
      : undefined

    return [...head, ...windowed.map(pad), ...foot].slice(0, this.viewportRows)
  }

  /** Body lines of the active page (unwindowed, unpadded). */
  private renderBody(subagent: SubagentState, running: boolean, totalTokens: number, elapsed: number, contentWidth: number): string[] {
    const bodyWidth = Math.max(1, contentWidth - SIDE_PADDING) // old body paddingX={1}
    if (this.page === 'summary') return this.renderSummary(subagent, running, totalTokens, elapsed, bodyWidth)
    if (this.page === 'output') return this.renderOutput(subagent, running, bodyWidth)
    return this.renderTools(subagent, bodyWidth)
  }

  /** Summary page: the two-column key/value stats grid above the final answer. */
  private renderSummary(subagent: SubagentState, running: boolean, totalTokens: number, elapsed: number, bodyWidth: number): string[] {
    const info = subagentStatusVisual(subagent.status)
    const stat = (label: string, value: string): string =>
      `${chalk.dim(label)}${' '.repeat(Math.max(1, 14 - visibleWidth(label)))}${value}`
    const tokensValue = `${totalTokens || '—'}${subagent.tokens?.input !== undefined ? ` (in ${subagent.tokens.input} · out ${subagent.tokens.output ?? 0})` : ''}`
    const lines = [
      stat(t('subagent-status-label'), themeKeyFg(info.color, info.label)),
      stat(t('subagent-model'), subagent.model ?? subagent.provider ?? 'default'),
      stat(t('subagent-duration'), formatDetailDuration(elapsed)),
      stat('tokens', tokensValue),
      stat(t('subagent-tools'), String(subagent.toolCalls.length)),
      stat(t('subagent-started'), formatTimestamp(subagent.startedAt)),
    ]
    if (subagent.completedAt !== undefined) lines.push(stat(t('subagent-completed'), formatTimestamp(subagent.completedAt)))
    if (subagent.summary !== undefined && subagent.summary !== '') {
      lines.push('', chalk.dim.bold('─ summary '), ...wrapTextWithAnsi(subagent.summary, bodyWidth))
    } else {
      lines.push(chalk.dim(running ? t('subagent-no-output') : t('subagent-no-summary')))
    }
    return lines
  }

  /** Output page: streamed lines, thinking/system dimmed, errors colored. */
  private renderOutput(subagent: SubagentState, running: boolean, bodyWidth: number): string[] {
    if (subagent.outputEvents.length === 0 && subagent.output.length === 0) {
      return [chalk.dim(t('subagent-no-output'))]
    }
    const lines: string[] = []
    for (const event of subagent.outputEvents) {
      const prefix = event.kind === 'thinking' ? '  ⌁ ' : '  '
      const suffix = event.settled === false && running ? ' ▍' : ''
      const paint = (line: string): string =>
        event.kind === 'error'
          ? themeKeyFg('error', line)
          : event.kind === 'thinking' || event.kind === 'system'
            ? chalk.dim(line)
            : line
      for (const wrapped of wrapTextWithAnsi(`${prefix}${event.text}${suffix}`, bodyWidth)) {
        lines.push(paint(wrapped))
      }
    }
    return lines
  }

  /** Tools page: one block per call — status glyph, name, duration, then
   *  flattened args / result preview / error indented under it. */
  private renderTools(subagent: SubagentState, bodyWidth: number): string[] {
    if (subagent.toolCalls.length === 0) return [chalk.dim(t('subagent-no-tools'))]
    const lines: string[] = []
    subagent.toolCalls.forEach((tool, index) => {
      if (index > 0) lines.push('')
      const glyph = tool.status === 'running' ? '·' : tool.status === 'failed' ? '×' : '✓'
      const glyphColor = tool.status === 'failed' ? 'error' : tool.status === 'running' ? 'warning' : 'success'
      const head = `${themeKeyFg(glyphColor, glyph)} ${themeKeyFg(toolNameThemeKey(tool.name), tool.name)}` +
        (tool.endedAt !== undefined ? ` ${chalk.dim(formatDetailDuration(tool.endedAt - tool.startedAt))}` : '')
      lines.push(head)
      if (tool.argsPreview !== undefined && tool.argsPreview !== '') {
        // Old scene cli-highlighted JSON-looking args asynchronously; the
        // imperative port keeps the dim flat fallback (synchronous render).
        const flat = tool.argsPreview.replace(/\s+/g, ' ').trim()
        lines.push(...wrapTextWithAnsi(`  ${flat}`, bodyWidth).map(line => chalk.dim(line)))
      }
      if (tool.resultPreview !== undefined && tool.resultPreview !== '') {
        lines.push(...wrapTextWithAnsi(`  ⎿ ${tool.resultPreview}`, bodyWidth).map(line => chalk.dim(line)))
      }
      if (tool.error !== undefined && tool.error !== '') {
        lines.push(...wrapTextWithAnsi(`  ${tool.error}`, bodyWidth).map(line => themeKeyFg('error', line)))
      }
    })
    return lines
  }

  private turnPage(delta: number): void {
    const next = (PAGES.indexOf(this.page) + delta + PAGES.length) % PAGES.length
    this.goToPage(PAGES[next]!)
  }

  /** Absolute page switch — the tab click shares the ←/→ turn semantics
   *  (scroll resets; re-entering a running output page resumes tail-follow). */
  private goToPage(page: DetailPage): void {
    this.page = page
    this.scrollOffset = 0
    this.followOutput = page === 'output'
  }

  /**
   * Pointer parity (research §4.3): the identity row's right-end ✕ takes the
   * Esc/Enter seat (onBack); a tab cell switches pages with the ←/→ turn
   * semantics; the hint row's `X interrupt` segment runs the x key's exact
   * command path (commands.query.subagentInterrupt — no separate business
   * action); the wheel scrolls the body like ↑/↓. Every click/wheel is
   * consumed (full-screen transient modal); press/release/move stay
   * unconsumed so drag-selection copy keeps working.
   */
  handlePointer(event: PointerEvent): boolean | void {
    if (event.type === 'click') {
      if (event.button === 0) this.handleClick(event.localX - SIDE_PADDING, event.localY)
      return true
    }
    if (event.type === 'wheel') {
      if (event.deltaY !== 0) {
        this.scrollOffset = Math.max(0, this.scrollOffset + (event.deltaY > 0 ? SCROLL_STEP : -SCROLL_STEP))
      }
      return true
    }
    return undefined
  }

  /** Click dispatch in content columns (after the side padding) / rows. */
  private handleClick(column: number, row: number): void {
    if (row === DETAIL_IDENTITY_ROW) {
      if (column >= this.pointerContentWidth - CLOSE_WIDTH) this.handlers.onBack()
      return
    }
    const tabs = this.pointerTabs
    if (tabs !== undefined && row === tabs.row) {
      const hit = tabs.ranges.find((range) => column >= range.start && column < range.end)
      if (hit !== undefined && hit.page !== this.page) this.goToPage(hit.page)
      return
    }
    const interrupt = this.pointerInterrupt
    if (
      interrupt !== undefined &&
      row === interrupt.row &&
      column >= interrupt.start &&
      column < interrupt.end &&
      this.subagent !== undefined &&
      isSubagentRunning(this.subagent)
    ) {
      this.commands.query.subagentInterrupt(this.subagent.agentId)
    }
  }
}
