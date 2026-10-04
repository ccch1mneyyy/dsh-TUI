import React from 'react'
import { Box, Text, useAnimationFrame, useTerminalSize } from '../../ui.js'
import { formatJobDuration, type BackgroundJobStatus } from '../../dsh-adapter/jobs.js'
import type { JobRow } from '../../dsh-adapter/channel.js'
import type { BackgroundJobOutputChannel, BackgroundJobOutputLine } from '../../adapter/ports/channel-view.js'
import type { Theme } from '../../theme.js'
import { t } from '../../i18n.js'
import wrapText from '../../ink/wrap-text.js'
import { primaryComboString } from '../../utils/keymap.js'
import { isMinimalUiMode } from '../../minimalUiMode.js'
import { ProgressBar } from '../design-system/ProgressBar.js'

/** The waterfall window mirrors the subagent card: a constant-height region. */
const WATERFALL_ROWS = 3
/** Card left padding + the `│ ` gutter prefix. */
const WATERFALL_GUTTER = 4

/** Static status marker — deliberately NOT the animated activity-indicator
 *  preset: a background job is parked work, and reusing the main spinner
 *  language for every card reads as clutter. ● = live background work
 *  (echoing the status-line chip), ✓/✗ for terminal states. NOTE: no ⚙ —
 *  U+2699 is East-Asian Ambiguous: ink measures it 1 cell while CJK
 *  terminal fonts paint it 2, so the following text overlaps the glyph. */
function statusInfo(status: BackgroundJobStatus): { glyph: string; label: string; color: keyof Theme | undefined } {
  const minimalUi = isMinimalUiMode()
  switch (status) {
    case 'completed':
      return { glyph: '✓', label: t('jobs-status-completed'), color: minimalUi ? undefined : 'success' }
    case 'failed':
      return { glyph: '✗', label: t('jobs-status-failed'), color: minimalUi ? undefined : 'error' }
    case 'killed':
      return { glyph: '✗', label: t('jobs-status-killed'), color: minimalUi ? undefined : 'error' }
    case 'stopping':
      return { glyph: '●', label: t('jobs-status-stopping'), color: minimalUi ? undefined : 'warning' }
    default:
      return { glyph: '●', label: t('jobs-status-running'), color: minimalUi ? undefined : 'warning' }
  }
}

/**
 * Producer progress as the design system's bar: `n/m` draws a 5-cell
 * sub-cell-accurate `ProgressBar` (same primitive the rest of the TUI uses)
 * plus the raw counter; any other shape passes through verbatim. Exported for
 * the /jobs panel so both surfaces read the same.
 */
export function JobProgress({ progress }: { progress: string }): React.ReactNode {
  const match = /^(\d+)\s*\/\s*(\d+)$/.exec(progress.trim())
  const current = match === null ? Number.NaN : Number(match[1])
  const total = match === null ? Number.NaN : Number(match[2])
  if (!Number.isFinite(current) || !Number.isFinite(total) || total <= 0) {
    return <Text color="accent" wrap="truncate-end">{progress}</Text>
  }
  return (
    <Box flexDirection="row" gap={1}>
      <ProgressBar ratio={Math.min(current, total) / total} width={5} fillColor="accent" emptyColor="inactive" />
      <Text color="accent">{progress.trim()}</Text>
    </Box>
  )
}

/** One rendered waterfall row: a wrapped piece of an output line, or a gap
 *  banner standing on its own row. */
interface WaterfallRow {
  key: string
  text: string
  channel?: BackgroundJobOutputChannel
  gap?: true
}

/**
 * The waterfall window: every entry is WRAPPED at the card width FIRST, then
 * the last `budget` VISUAL rows are kept. A 400-cell JSON line therefore
 * shows its ending folded over the rows instead of a clipped head — and the
 * window still costs a constant number of rows, which is what the
 * transcript's virtualization measures.
 */
export function jobOutputRows(
  entries: readonly BackgroundJobOutputLine[],
  width: number,
  budget: number,
): WaterfallRow[] {
  const rows: WaterfallRow[] = []
  // One cell of slack: a line that lands exactly on the boundary is re-wrapped
  // by ink's own renderer, which would silently double that row's height.
  const textWidth = Math.max(1, width - 1)
  for (let index = entries.length - 1; index >= 0 && rows.length < budget; index--) {
    const entry = entries[index]!
    const wrapped = wrapText(entry.text, textWidth, 'wrap').split('\n')
    for (let row = wrapped.length - 1; row >= 0 && rows.length < budget; row--) {
      rows.unshift({
        key: `${index}-${row}`,
        text: wrapped[row] ?? '',
        ...(entry.channel === undefined ? {} : { channel: entry.channel }),
      })
    }
    if (entry.gapBefore === true && rows.length < budget) rows.unshift({ key: `gap-${index}`, text: '', gap: true })
  }
  return rows
}

/** Command rows share wrapping and fold counts between the card and panel. */
export function jobCommandRows(text: string, width: number, expanded: boolean, key: string): string[] {
  const lines = wrapText(text, Math.max(1, width - 3), 'wrap').split('\n')
  const shown = (expanded ? lines : lines.slice(0, 1)).map((line, index) => index === 0 ? line : `⎿ ${line}`)
  if (lines.length > 1) shown.push('⎿ ' + (expanded ? t('jobs-details-collapse', { key }) : t('lines-folded-expand', { n: lines.length - 1, key })))
  return shown
}

/**
 * Transcript job card with a folded command and a three-row live output tail.
 * Commands and retained output expand together through the transcript toggle.
 * The group rail counts the rendered rows, including fold controls.
 */
export function JobCard({ job, marginTopOnTurn, onClick, rail, onWatchOutput, expanded = false, onToggle }: {
  job: JobRow
  marginTopOnTurn: boolean
  onClick?(): void
  expanded?: boolean
  onToggle?: () => void
  /** Job GROUP member: shared chain rail, optionally rounded at either end. */
  rail?: { open?: boolean; close?: boolean } | undefined
  /** A backend whose output is read on demand keeps a mounted (on-screen)
   *  live card's tail fresh while it is watched; returns the unwatch. */
  onWatchOutput?: (id: string) => () => void
}): React.ReactNode {
  const settled = job.status === 'completed' || job.status === 'failed' || job.status === 'killed'
  // Only a live card needs a fresh tail (a settled one folds its waterfall).
  React.useEffect(() => (settled || onWatchOutput === undefined ? undefined : onWatchOutput(job.id)), [settled, onWatchOutput, job.id])
  // 动画订阅仅限存活卡片：settled 后退订共享 clock（同 SubagentMessage 的
  // 约定）。1s tick 只驱动运行时长跳动——状态标是静态的（见 statusInfo）。
  const [viewportRef] = useAnimationFrame(settled ? null : 1000)
  const { columns } = useTerminalSize()
  const info = statusInfo(job.status)
  const [hovered, setHovered] = React.useState(false)
  const clickable = onClick !== undefined
  const grouped = rail !== undefined
  const cardColumns = columns ?? 80
  // A grouped card spends two columns on the rail — the glyph column plus its
  // 1-cell gutter. Every width below is measured against that, or the rows
  // would wrap a second time inside ink and the card would grow past the
  // height the rail was painted for.
  const rowWidth = Math.max(20, cardColumns - WATERFALL_GUTTER - (grouped ? 2 : 0))
  // Collapsed live cards keep the newest visual rows; expansion shows the retained tail.
  const outputRows = jobOutputRows(job.outputLines, rowWidth, Number.POSITIVE_INFINITY)
  const activity = expanded ? outputRows : settled ? [] : outputRows.slice(-WATERFALL_ROWS)
  const hiddenOutput = outputRows.length - activity.length
  const toggleKey = primaryComboString('transcript')
  const outputHint = outputRows.length === 0 ? undefined : expanded
    ? t('jobs-details-collapse', { key: toggleKey })
    : hiddenOutput > 0 ? t('lines-folded-expand', { n: hiddenOutput, key: toggleKey }) : undefined
  // A settled job's terminal detail ('exit code: 0') rides the header; a
  // failed/killed one also keeps it as the explanatory tail line.
  const headerDetail = job.detail !== undefined && job.detail !== '' ? job.detail : undefined
  const headerName = `${t('jobs-card-prefix')}${job.id}`
  const duration = formatJobDuration(job)
  // Only a LIVE job carries a progress chip; a settled one has dropped it, so
  // reserving width for it unconditionally would clip the label for nothing.
  const liveProgress = settled || job.progress === undefined || job.progress === '' ? undefined : job.progress

  const railBody = settled && job.status !== 'completed' && headerDetail !== undefined
  const labelWidth = Math.max(8, rowWidth - 2)
  const labelLines = jobCommandRows(job.label, labelWidth, expanded, toggleKey)
  const contentLines = 1 + labelLines.length + activity.length + (outputHint === undefined ? 0 : 1) + (railBody ? 1 : 0)
  const railGlyphs: string[] = []
  if (grouped) {
    for (let index = 0; index < contentLines; index++) {
      const opens = index === 0 && rail?.open === true
      const closes = index === contentLines - 1 && rail?.close === true
      railGlyphs.push(opens ? '╭' : closes ? '╰' : '│')
    }
  }

  // The header opens the panel; body controls fold details without opening it.
  const body = (
    <>
    {/* Keep status and timing beside the id; the command gets its own row below. */}
    <Box flexDirection="row" gap={1} height={1} overflow="hidden">
      {/* The fixed status columns stay on one header row. */}
      <Box flexShrink={0}>
        <Text color={hovered && clickable ? 'accent' : info.color}>{info.glyph}</Text>
      </Box>
      <Box flexShrink={0}>
        <Text bold color={hovered && clickable ? 'accent' : undefined}>
          {headerName}
        </Text>
      </Box>
      <Box flexShrink={0}><Text dimColor>{job.kind}</Text></Box>

      {liveProgress !== undefined && (
        <Box width={12} flexShrink={0}>
          <JobProgress progress={liveProgress} />
        </Box>
      )}
      <Box flexShrink={0}><Text dimColor>{duration}</Text></Box>
      {headerDetail !== undefined && <Box flexShrink={0}><Text dimColor wrap="truncate-end">{headerDetail}</Text></Box>}
      <Box flexShrink={0}><Text color={info.color}>{info.label}</Text></Box>
    </Box>
    <Box width={rowWidth} flexShrink={0} flexDirection="column" paddingLeft={2}
      onClick={onToggle === undefined ? undefined : event => { event.stopImmediatePropagation(); onToggle() }}>
      {labelLines.map((line, index) => <Text key={index} wrap="truncate-end">{line}</Text>)}
    </Box>
    <Box flexDirection="column" onClick={onToggle === undefined ? undefined : event => { event.stopImmediatePropagation(); onToggle() }}>
      {activity.map(entry => (
        // key 不含 time（同 SubagentMessage 的约定）：内容更新走 in-place
        // diff，避免每个 tick 都 unmount+mount。瀑布只在有镜像输出时出现
        // （后台任务静默是常态——无输出时卡片就是头行，不摆空 gutter）。
        // Rows are pre-wrapped to the row width, so truncate is a belt-and-braces
        // guard against a re-wrap (which would break the constant height).
        entry.gap === true ? (
          <Text key={entry.key} dimColor italic wrap="truncate">
            {`  · ${t('jobs-output-gap')}`}
          </Text>
        ) : (
          <Text
            key={entry.key}
            color={entry.channel === 'stderr' ? 'error' : undefined}
            dimColor={entry.channel !== 'stderr'}
            wrap="truncate"
          >
            {`  │ ${entry.text}`}
          </Text>
        )
      ))}
      {outputHint !== undefined && <Text dimColor wrap="truncate-end">{'  ⎿ ' + outputHint}</Text>}
    </Box>
    {railBody && (
      <Text dimColor>{`  └ ${headerDetail}`}</Text>
    )}
    </>
  )

  return <Box
    flexDirection="column"
    marginTop={marginTopOnTurn ? 1 : 0}
    ref={viewportRef}
    onClick={onClick}
    onMouseEnter={clickable ? () => setHovered(true) : undefined}
    onMouseLeave={clickable ? () => setHovered(false) : undefined}
  >
    {grouped ? (
      // The rail is a column of glyphs painted per line — one `│` per card
      // line, `╭`/`╰` on the ends a group asked for — with the body hanging
      // one gutter cell to its right (same 2-cell offset as before).
      <Box flexDirection="row">
        <Box width={1} flexShrink={0}>
          <Text color="inactive">{railGlyphs.join('\n')}</Text>
        </Box>
        <Box flexDirection="column" flexGrow={1} paddingLeft={1}>
          {body}
        </Box>
      </Box>
    ) : body}
  </Box>
}
