/**
 * The ledger — one line per event, columns aligned across every row — ported
 * from the Ink `Ledger.tsx` to a pure string renderer for pi-tui.
 *
 * Four decisions carry most of the readability:
 *
 * **Flat rows, spined turns.** Indenting by turn would break the column
 * alignment that makes forty rows scannable at a glance, so rows stay flush
 * and a two-cell spine on the left (`╭ │ ╰`, the git-graph idiom) carries the
 * grouping instead. The spine is itself information: it turns red for a turn
 * that failed and green for the turn still running.
 *
 * **Turn boundaries are rules, not rows.** A turn is a chapter heading, and a
 * heading that looks like a body row makes the ledger read as one
 * undifferentiated list. Rendering it as a full-width rule chunks a
 * five-hundred-row session into things the eye can count.
 *
 * **Cost before number.** Every row carries a one-cell bar on an absolute
 * scale, so "which of these was slow" is answered by silhouette rather than
 * by reading a column of durations.
 *
 * **Call and result on one line.** `name {args} → result` — the same shape
 * the official web ledger uses, and the reason a screenful answers "what did
 * it do and what came back" without a single expansion.
 *
 * Where Ink used flex rows with `gap={1}` and `wrap="truncate"`, this port
 * composes each row as one string: fixed columns are padded by hand, the
 * elastic label column is clipped ANSI-aware ({@link clip}), and the gap is
 * a literal space. Rows are windowed by the caller; this paints only what it
 * is given and calls `previewText` exactly once per visible cell.
 */

import { burstDurationMs, burstErrors, previewText } from '../../../dsh-adapter/trajectory/index.js'
import {
  costGlyph,
  formatClock,
  formatDuration,
  heatColor,
  KIND_BADGE,
  KIND_BADGE_BG,
  KIND_FG,
  KIND_GLYPH,
  ledgerLayout,
} from '../../../trajectory/format.js'
import { arrive, mix } from '../../../trajectory/motion.js'
import { visibleWidth } from '../../public.js'
import type { TrajNode } from '../../../dsh-adapter/types.js'
import { activeTheme, badge, clip, fg, padStart } from './paint.js'

/** Idle shorter than this is noise, not a pause worth naming. */
const IDLE_FLOOR_MS = 20_000

/** Spine glyphs by position within a turn. */
const SPINE = { open: '╭', mid: '│', close: '╰', none: ' ' } as const

/** Which spine glyph a row gets, given its neighbours' turns. */
function spineGlyph(rows: readonly TrajNode[], index: number): string {
  const node = rows[index]!
  if (node.kind === 'turn') return SPINE.open
  const next = rows[index + 1]
  if (next === undefined || next.turn !== node.turn || next.kind === 'turn') return SPINE.close
  return SPINE.mid
}

export interface LedgerProps {
  /** The (possibly filtered) ledger. */
  rows: readonly TrajNode[]
  /** Index of the first visible row. */
  start: number
  /** Visible row count; the output is always exactly this many lines. */
  height: number
  /** Focused row index into `rows`. */
  cursor: number
  /** Content width in cells. */
  width: number
  tick: number
  /** Tick at which the most recent rows arrived. */
  arrivalTick: number
  /** Rows at or after this index are the ones that just arrived. */
  arrivalFrom: number
}

export function renderLedger({
  rows,
  start,
  height,
  cursor,
  width,
  tick,
  arrivalTick,
  arrivalFrom,
}: LedgerProps): string[] {
  const theme = activeTheme()
  const layout = ledgerLayout(width)
  const visible = rows.slice(start, start + height)
  const arriving = arrive(tick, arrivalTick)

  if (visible.length === 0) {
    return padToHeight([fg('subtle', '—')], height)
  }

  const lines: string[] = []
  for (let offset = 0; offset < visible.length; offset++) {
    const node = visible[offset]!
    const index = start + offset
    const focused = index === cursor
    const failed = node.status === 'error' || (node.burst !== undefined && burstErrors(node.burst) > 0)
    const running = node.status === 'running'
    const isNew = index >= arrivalFrom && arriving > 0
    const duration = node.burst === undefined ? node.durationMs : burstDurationMs(node.burst)

    // ── structural rows are RULES, not rows ────────────────────────────────
    //
    // A ledger with five hundred entries needs chapters. Turn and step are
    // the session's own headings, and a heading that looks like a body row
    // makes the whole list read as one undifferentiated stream.
    if (node.kind === 'turn' || node.kind === 'step') {
      const isTurn = node.kind === 'turn'
      const right = `${duration === undefined ? '' : formatDuration(duration)}${failed ? ' ✗' : ''}`

      // A step is a quiet row, not a rule. Steps are frequent — three or
      // four per screen — and a full-width dashed line each drew more
      // attention than the work between them.
      if (!isTurn) {
        const elastic = Math.max(0, width - (2 + 1 + 7) - 3)
        lines.push(
          fg('subtle', `${focused ? '▸' : ' '}╵`) +
            ' ' +
            clip(fg(focused ? 'suggestion' : 'subtle', node.label), elastic) +
            ' ' +
            fg(heatColor(duration), costGlyph(duration)) +
            ' ' +
            fg(heatColor(duration), padStart(right, 7)),
        )
        continue
      }

      const tone = failed ? 'error' : running ? 'success' : 'inactiveShimmer'
      // Idle before a turn is wall-clock the session spent waiting on the
      // human, and it is invisible everywhere else — every duration only ever
      // accounts for work. Surfacing it here is what makes the clock column
      // add up.
      const previous = rows[index - 1]
      const idle = previous === undefined ? 0 : node.time - (previous.time + (previous.durationMs ?? 0))
      const idleText = idle >= IDLE_FLOOR_MS ? `  ⋯ ${formatDuration(idle)}` : ''
      const headWidth = cellWidth(`${focused ? '▸' : ' '}━━ ${node.label}${idleText} `)
      const fill = Math.max(2, width - headWidth - cellWidth(right) - 2)
      lines.push(
        clip(
          fg(tone, `${focused ? '▸' : ' '}━━ ${node.label}`, { bold: true }) +
            fg('subtle', idleText, { bold: true }) +
            fg('inactive', ` ${'━'.repeat(fill)} `, { bold: true }) +
            fg(failed ? 'error' : heatColor(duration), right, { bold: true }),
          width,
        ),
      )
      continue
    }

    const spineColor = failed ? 'error' : running ? 'success' : node.seed === true ? 'subtle' : 'inactive'
    const badgeBg = KIND_BADGE_BG[node.kind]
    const badgeText = layout.badge === 6 ? KIND_BADGE[node.kind] : KIND_GLYPH[node.kind]

    // Label and detail share one budget so a long tool name never pushes the
    // duration column off the row.
    const label = node.burst !== undefined ? `${node.label} ×${node.burst.members.length}` : node.label
    const detailBudget = Math.max(0, layout.detail - label.length - 1)
    const detail = node.detail === undefined ? '' : previewText(node.detail, detailBudget)
    const outcome =
      layout.outcome && node.outcome !== undefined && node.outcome !== ''
        ? previewText(node.outcome, Math.max(8, Math.floor(layout.detail * 0.3)))
        : ''

    const badgeFg = isNew
      ? (mix(theme[KIND_FG[node.kind]] as string, theme.text, arriving) as string)
      : (theme[KIND_FG[node.kind]] as string)

    const labelSegment =
      fg(focused ? 'suggestion' : node.seed === true ? 'subtle' : undefined, label) +
      (detail === '' ? '' : ' ' + fg(focused ? 'suggestion' : 'inactive', detail)) +
      (outcome === '' ? '' : fg('subtle', `  → ${outcome}`))

    const fixed = 2 + (layout.index ? 8 : 0) + cellWidth(badgeText) + 1 + 7
    const gaps = (layout.index ? 6 : 5) - 1
    const elastic = Math.max(0, width - fixed - gaps)

    const segments = [
      fg(spineColor, `${focused ? '▸' : ' '}${spineGlyph(rows, index)}`),
      // Wall-clock, not a record index or an offset: an offset collapses to
      // the same value for every row late in a long session, and "it hung
      // around 10:02" is how a person remembers the thing they came here to
      // find.
      ...(layout.index ? [fg('subtle', formatClock(node.time))] : []),
      badge(badgeFg, badgeBg, badgeText),
      clip(labelSegment, elastic),
      fg(running ? 'success' : heatColor(duration), costGlyph(duration)),
      fg(running ? 'success' : heatColor(duration), padStart(running ? '…' : duration === undefined ? '' : formatDuration(duration), 7)),
    ]
    lines.push(clip(segments.join(' '), width))
  }
  return padToHeight(lines, height)
}

/** Visible cell width of a plain (unstyled) string; CJK-aware. */
function cellWidth(text: string): number {
  return visibleWidth(text)
}

/** Fill the window with blank lines so the region's row count never moves. */
function padToHeight(lines: string[], height: number): string[] {
  while (lines.length < height) lines.push(' ')
  return lines
}
