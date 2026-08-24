/**
 * Reasoning (thinking) row for the pi-tui transcript (plan §1.3, WP-03).
 *
 * Port of `src/components/messages/AssistantThinkingMessage.tsx`:
 * - streaming: a braille spinner + `Thinking…` header; the body is either a
 *   constant-height 3-row live ticker of the latest reasoning lines
 *   (`thinkingFold: 'preview'`, the channel default) or the full dimmed
 *   markdown block (`'full'` / Ctrl+O). A click folds the live view to the
 *   bare header via `RowContext.streamFoldedRows`.
 * - settled: folded one-liner `⚓ Thinking · 12s (ctrl+o to expand)`; the
 *   global Ctrl+O verbose (`RowContext.expanded`) or the row's own click
 *   toggle (`RowContext.expandedRows`) reveals the full text.
 *
 * Simplifications vs the old React path: the streaming glyph pulses in a
 * fixed `claude` tint instead of the sine brand→ice color sweep, and the
 * spinner frame derives from the wall clock at render time (the ~16ms
 * stream-merge updates drive the animation) — the row owns no timer.
 * `thinkingVisible` filtering happens in `TranscriptView`, not here.
 */
import chalk from 'chalk'
import { Markdown, sliceByColumn, visibleWidth } from '../../public.js'
import {
  THINKING_SETTLED_MARKER,
  THINKING_SPINNER_FRAMES,
  THINKING_SPINNER_INTERVAL_MS,
} from '../../../cc/figures.js'
import { formatDuration } from '../../../cc/format.js'
import { stripPromptXMLTags } from '../../../cc/markdown.js'
import { t } from '../../../i18n.js'
import { isMinimalMode } from '../../../minimalMode.js'
import { createTranscriptMarkdownTheme } from './markdown-theme.js'
import { clip, fg, trimPad } from './style.js'
import { CachedRow } from './shared.js'

/** Fixed ticker height — a wrapped/variable block would bounce mid-stream. */
const PREVIEW_ROWS = 3

/** Dim default text style for the expanded thinking body (old `dimColor`). */
const DIM_TEXT = { color: (text: string): string => chalk.dim(text) }

export class ReasoningRow extends CachedRow {
  private markdown: Markdown | undefined

  override invalidate(): void {
    super.invalidate()
    this.markdown?.invalidate()
  }

  protected build(width: number, marginTop: boolean): string[] {
    const thinking = this.row.text
    if (thinking === '') return []
    const streaming = this.row.streaming === true
    const durationMs = this.row.durationMs
    const duration =
      durationMs !== undefined && durationMs >= 1000 ? ` · ${formatDuration(durationMs)}` : ''
    const label = `${t('thinking-label')}${duration}${streaming ? '…' : ` ${t('hint-expand-ctrl-o')}`}`
    const header = streaming
      ? `${fg('claude', spinnerFrame())} ${chalk.dim(chalk.italic(label))}`
      : chalk.dim(
          chalk.italic(`${isMinimalMode() ? '*' : THINKING_SETTLED_MARKER} ${label}`),
        )

    const out: string[] = marginTop ? [''] : []
    out.push(clip(header, width))

    // Click fold state (research §4.3): a SETTLED row toggles via the shared
    // per-row set (default folded — click expands); a STREAMING row defaults
    // to the live view, so its click fold is the separate streamFolded set
    // and the two defaults never flip each other (source main e972821).
    const rowExpanded = this.ctx.expandedRows.has(this.row.id)
    const streamFolded = streaming && this.ctx.streamFoldedRows.has(this.row.id)
    if (
      streaming &&
      !streamFolded &&
      !rowExpanded &&
      !this.ctx.expanded &&
      this.ctx.thinkingFold === 'preview'
    ) {
      // Live ticker: the model's last reasoning lines, one row each, padded
      // to a constant PREVIEW_ROWS-tall block. The LAST row truncates from
      // the start so the newest tokens (growing at the line's end) stay
      // visible. Gutter matches the old `paddingLeft=2` + `│ ` layout.
      const lines = thinking.split('\n')
      const visible = lines.slice(-PREVIEW_ROWS)
      const clipped = lines.length > visible.length
      const budget = Math.max(1, width - 4)
      for (let index = 0; index < PREVIEW_ROWS; index++) {
        const line = visible[index] ?? ' '
        let content: string
        if (index === PREVIEW_ROWS - 1 && visibleWidth(line) > budget) {
          content = `…${sliceByColumn(line, visibleWidth(line) - budget + 1, budget - 1)}`
        } else {
          content = clip(index === 0 && clipped ? `…${line}` : line, budget)
        }
        out.push(`${chalk.dim('  │ ')}${chalk.dim(chalk.italic(content))}`)
      }
      return out
    }

    if ((streaming && !streamFolded) || this.ctx.expanded || rowExpanded) {
      out.push('')
      for (const line of this.renderMarkdown(thinking.trim(), Math.max(1, width - 2))) {
        out.push(`  ${trimPad(line)}`)
      }
    }
    return out
  }

  private renderMarkdown(text: string, width: number): string[] {
    if (this.markdown === undefined) {
      this.markdown = new Markdown(text, 0, 0, createTranscriptMarkdownTheme(), DIM_TEXT, {
        transform: (source) => stripPromptXMLTags(source),
      })
    } else {
      this.markdown.setText(text)
    }
    return this.markdown.render(width)
  }
}

/** Wall-clock braille frame (see module header for the no-timer rationale). */
function spinnerFrame(): string {
  const frame = Math.floor(Date.now() / THINKING_SPINNER_INTERVAL_MS)
  return THINKING_SPINNER_FRAMES[frame % THINKING_SPINNER_FRAMES.length] ?? '⠋'
}
