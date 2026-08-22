/**
 * Subagent lifecycle card row for the pi-tui transcript (plan §1.3, WP-03).
 *
 * String-building port of `src/components/Chat/SubagentMessage.tsx`: a
 * borderless card under a 2-cell indent — status glyph + bold
 * `Subagent: <description>` header with dim `·`-separated metadata
 * (model/effort/elapsed/tokens/tool count/status label); while running, a
 * current-tool line plus a constant 3-row activity waterfall, each row
 * hard-clipped so the card height never changes. Settled folds to the
 * header; a failure keeps one `└ error` line.
 *
 * The running glyph follows the user's working-activity preset
 * (`RowContext.activityFrames`) driven by the wall clock at render time —
 * the row owns no timer. The old per-frame `useAnimationFrame(120)` repaint
 * is replaced by the channel's subagent-sync updates invalidating the row.
 */
import chalk from 'chalk'
import { resolvePreset } from 'dsh-working-activity/frames'
import type { SubagentRow } from '../../../dsh-adapter/channel.js'
import { truncateToWidth } from '../../public.js'
import { t } from '../../../i18n.js'
import { isMinimalMode } from '../../../minimalMode.js'
import type { Theme } from '../../../theme.js'
import { clip, fg } from './style.js'
import { CachedRow } from './shared.js'
import { toolNameColor } from './tool.js'

/** The waterfall window is a constant-height region (Kimi Code style). */
const WATERFALL_ROWS = 3

function duration(ms = 0): string {
  const seconds = Math.floor(ms / 1000)
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m${seconds % 60}s`
}

function tokens(sub: SubagentRow): string {
  const total = sub.tokens?.total ?? ((sub.tokens?.input ?? 0) + (sub.tokens?.output ?? 0) || 0)
  return total > 0 ? `${total} tok` : '- tok'
}

function statusInfo(sub: SubagentRow): { glyph: string; label: string; color: keyof Theme | undefined } {
  const minimal = isMinimalMode()
  if (sub.status === 'completed') {
    return { glyph: minimal ? '✓' : '🟢', label: t('subagent-status-completed'), color: minimal ? undefined : 'success' }
  }
  if (sub.status === 'failed') {
    return { glyph: minimal ? '×' : '🔴', label: t('subagent-status-failed'), color: minimal ? undefined : 'error' }
  }
  if (sub.status === 'cancelled') {
    return { glyph: minimal ? '×' : '🔴', label: t('subagent-status-cancelled'), color: minimal ? undefined : 'error' }
  }
  return { glyph: minimal ? '·' : '🟡', label: t('subagent-status-running'), color: minimal ? undefined : 'warning' }
}

function paintMaybe(color: keyof Theme | undefined, text: string): string {
  return color === undefined ? text : fg(color, text)
}

export class SubagentCardRow extends CachedRow {
  protected build(width: number, marginTop: boolean): string[] {
    const sub = this.row.subagent
    if (sub === undefined) return []
    const info = statusInfo(sub)
    const settled =
      sub.status === 'completed' || sub.status === 'failed' || sub.status === 'cancelled'
    const elapsed = sub.completedAt !== undefined ? sub.durationMs : Date.now() - sub.startedAt
    const preset = resolvePreset(this.ctx.activityFrames)
    const runningGlyph =
      preset.frames[Math.floor(Date.now() / preset.intervalMs) % preset.frames.length] ?? '·'
    const contentWidth = Math.max(1, width - 2)

    // Header: glyph (2 cells — the running frame gets a leading pad to match
    // the emoji width) + bold prefix/description + dim metadata segments.
    const glyph = settled ? paintMaybe(info.color, info.glyph) : chalk.dim(` ${runningGlyph}`)
    const parts: string[] = [glyph, chalk.bold(`${t('subagent-card-prefix')}${sub.description}`)]
    parts.push(chalk.dim('·'), sub.model ?? sub.provider ?? 'default')
    if (sub.effort !== undefined && sub.effort !== '') {
      parts.push(chalk.dim('·'), chalk.dim(sub.effort))
    }
    parts.push(chalk.dim('·'), chalk.dim(duration(elapsed)))
    parts.push(chalk.dim('·'), chalk.dim(tokens(sub)))
    parts.push(chalk.dim('·'), chalk.dim(`${sub.toolCalls.length} tools`))
    parts.push(chalk.dim('·'), paintMaybe(info.color, info.label))

    const lines: string[] = [truncateToWidth(parts.join(' '), contentWidth, '…')]

    if (!settled) {
      const lastRunning = [...sub.toolCalls].reverse().find((tool) => tool.status === 'running')
      const previousDone = lastRunning !== undefined
        ? sub.toolCalls[sub.toolCalls.indexOf(lastRunning) - 1]
        : sub.toolCalls[sub.toolCalls.length - 1]
      const current = lastRunning ?? previousDone
      if (current !== undefined) {
        let line = ''
        if (lastRunning !== undefined && previousDone !== undefined) {
          line += `${chalk.dim('  · ')}${fg('success', '✓')}${fg(toolNameColor(previousDone.name), previousDone.name)}${chalk.dim(' · ')}`
        } else if (lastRunning === undefined) {
          line += `${chalk.dim('  · ')}${fg('success', '✓')}${fg(toolNameColor(previousDone!.name), previousDone!.name)}`
        }
        if (lastRunning !== undefined) {
          line += fg(toolNameColor(lastRunning.name), lastRunning.name)
          if (lastRunning.argsPreview !== undefined) {
            const flat = lastRunning.argsPreview.replace(/\s+/g, ' ').trim()
            line += chalk.dim(` (${clip(flat, Math.max(10, contentWidth - lastRunning.name.length - 6))})`)
          }
        } else if (current.argsPreview !== undefined && line !== '') {
          const flat = current.argsPreview.replace(/\s+/g, ' ').trim()
          line += chalk.dim(` (${clip(flat, Math.max(10, contentWidth - current.name.length - 6))})`)
        }
        lines.push(truncateToWidth(line, contentWidth, '…'))
      }
      const activity = sub.outputLines.slice(-WATERFALL_ROWS)
      for (let index = 0; index < WATERFALL_ROWS; index++) {
        lines.push(chalk.dim(`  │ ${clip(activity[index] ?? '', Math.max(1, contentWidth - 4))}`))
      }
    } else if (sub.status === 'failed' && sub.error !== undefined && sub.error !== '') {
      lines.push(fg('error', `  └ ${clip(sub.error, Math.max(1, contentWidth - 4))}`))
    }

    const out: string[] = marginTop ? [''] : []
    for (const line of lines) out.push(`  ${line}`)
    return out
  }
}
