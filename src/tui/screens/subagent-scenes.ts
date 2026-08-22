/**
 * Subagent dashboard and detail scenes (WP-03 imperative port of the React
 * `src/components/SubagentDashboard.tsx` and `SubagentDetailScene.tsx`).
 *
 * - {@link SubagentDashboardScreen}: a counts header (running / completed /
 *   failed) over a scrollable list of SubagentCardView rows. ↑/↓ moves the
 *   focus row and the scroll window follows it; an unmodified Enter opens
 *   the detail through `onSelect(agentId)`; Esc / Ctrl+C closes via
 *   `onClose()`. Data arrives exclusively through `update(vm)` — the command
 *   sink is part of the uniform scene constructor contract but the dashboard
 *   issues no commands today.
 * - {@link SubagentDetailScreen}: paged full-screen view of one subagent
 *   (summary | output | tools). ←/→ turns pages (scroll resets), ↑/↓
 *   scrolls the body, X interrupts a running subagent through
 *   `commands.query.subagentInterrupt`, Esc / Ctrl+C / an unmodified Enter
 *   returns via `onBack()`. The output page tail-follows the newest
 *   streamed line while the subagent runs; page turns and settlement stop
 *   the follow so manual ↑ scrolling wins.
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
      pad(counts.join('   ')),
      '',
      ...body.map(pad),
      pad(dividerLine(contentWidth, '', 'subtle')),
      pad(chalk.dim(hint)),
      '',
    ].slice(0, this.viewportRows)
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
      pad(`${themeKeyFg(info.color, chalk.bold(info.glyph))} ${chalk.bold(`${t('subagent-card-prefix')}${subagent.description}`)}${chalk.dim(' · ')}${themeKeyFg(info.color, info.label)}`),
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

    // Tab bar with page indicator.
    const tabs = PAGES.map((name, index) => {
      const label = name === 'summary' ? t('subagent-tab-summary') : name === 'output' ? t('subagent-output-label') : t('subagent-tools')
      const active = index === pageIndex
      const cell = active ? themeKeyFg('claude', chalk.bold.inverse(` ${label} `)) : ` ${label} `
      return index === PAGES.length - 1 ? cell : `${cell}${chalk.dim('│')}`
    }).join('')
    head.push('', pad(`${tabs}${chalk.dim(`  ${pageIndex + 1}/${PAGES.length}`)}`), pad(rowSeparator(contentWidth - 2)))

    const foot = [pad(dividerLine(contentWidth, '', 'subtle')), pad(chalk.dim(
      `←/→ ${t('subagent-hint-page')} · ↑/↓ ${t('subagent-hint-scroll')}` +
      (running ? ' · X interrupt' : '') +
      ` · Esc ${t('subagent-hint-back')}`,
    )), '']

    const bodyRows = Math.max(1, this.viewportRows - head.length - foot.length)
    const body = this.renderBody(subagent, running, totalTokens, elapsed, contentWidth)
    const maxOffset = Math.max(0, body.length - bodyRows)
    // tail -f: while the subagent runs and the output page shows, follow the
    // newest streamed line. Page turns and settlement stop the follow.
    if (this.page === 'output' && running && this.followOutput) this.scrollOffset = maxOffset
    this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, maxOffset))
    const windowed = body.slice(this.scrollOffset, this.scrollOffset + bodyRows)

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
    this.page = PAGES[next]!
    this.scrollOffset = 0
    // Re-entering the output page of a running subagent resumes tail-follow.
    this.followOutput = this.page === 'output'
  }
}
