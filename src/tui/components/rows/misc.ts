/**
 * Small transcript rows for the pi-tui transcript (plan §1.3, WP-03) —
 * string-building ports of the simple branches of the old
 * `MessageList.tsx` row switch:
 *
 * - `notice` — a dim divider with the notice text as its centered title.
 * - `interrupt` — the dim two-line "Interrupted / what next" marker.
 * - `local` — the `!command` echo in `bashBorder` (CC's UserBashInputMessage).
 * - `local-output` — the command's output, dimmed under a 2-cell indent;
 *   never takes a top margin (it hangs directly under its `local` echo).
 * - `compact` — the post-compaction summary: folded one-liner with a
 *   60-cell whitespace-flattened preview, full dimmed text under Ctrl+O or
 *   the row's own click toggle (`RowContext.expandedRows`).
 *   The folded line wraps like the old Text when it overflows.
 */
import chalk from 'chalk'
import { t } from '../../../i18n.js'
import { visibleWidth } from '../../public.js'
import { wrapWidth } from '../../../sessions/format.js'
import { clip, dividerLine, fg } from './style.js'
import { CachedRow } from './shared.js'

/** Folded compact-summary preview: whitespace flattened, capped in terminal
 *  CELLS so CJK wide chars count double and never split mid-glyph. */
function compactPreview(text: string, limit = 60): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return visibleWidth(flat) <= limit ? flat : clip(flat, limit)
}

export class NoticeRow extends CachedRow {
  protected build(width: number, _marginTop: boolean): string[] {
    // The old row always took a 1-row top margin regardless of position.
    return ['', dividerLine(` ${this.row.text} `, width)]
  }
}

export class InterruptRow extends CachedRow {
  protected build(width: number, _marginTop: boolean): string[] {
    const out = ['']
    for (const text of [t('interrupted-by-user'), t('interrupted-ask-next')]) {
      for (const line of wrapWidth(text, Math.max(1, width))) {
        out.push(chalk.dim(line))
      }
    }
    return out
  }
}

export class LocalRow extends CachedRow {
  protected build(width: number, _marginTop: boolean): string[] {
    const target = this.row.executionTarget
    const text = `!${target !== undefined && target !== '' ? ` [${target}]` : ''} ${this.row.text}`
    const out = ['']
    for (const line of wrapWidth(text, Math.max(1, width))) {
      out.push(fg('bashBorder', line))
    }
    return out
  }
}

export class LocalOutputRow extends CachedRow {
  protected build(width: number, _marginTop: boolean): string[] {
    const out: string[] = []
    for (const line of wrapWidth(this.row.text, Math.max(1, width - 2))) {
      out.push(`  ${chalk.dim(line)}`)
    }
    return out
  }
}

export class CompactRow extends CachedRow {
  protected build(width: number, marginTop: boolean): string[] {
    const out: string[] = marginTop ? [''] : []
    // Global Ctrl+O or the row's own click toggle reveals the full summary
    // (source parity: `expanded || isExpanded`).
    if (this.ctx.expanded || this.ctx.expandedRows.has(this.row.id)) {
      for (const line of wrapWidth(this.row.text, Math.max(1, width - 2))) {
        out.push(`  ${chalk.dim(line)}`)
      }
      return out
    }
    const folded =
      `∴ ${t('compact-summary-folded')} · ${compactPreview(this.row.text)} ${t('hint-expand-ctrl-o')}`
    // Wrap (not clip): the hint must survive narrow widths on its own line,
    // matching the old Text's wrap behavior.
    for (const line of wrapWidth(folded, Math.max(1, width - 2))) {
      out.push(`  ${chalk.dim(chalk.italic(line))}`)
    }
    return out
  }
}
