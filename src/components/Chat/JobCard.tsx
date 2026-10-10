import React from 'react'
import { Box, Text, useAnimationFrame, useTerminalSize } from '../../ui.js'
import { formatJobDuration, type BackgroundJobStatus } from '../../dsh-adapter/jobs.js'
import type { JobRow } from '../../dsh-adapter/channel.js'
import type { BackgroundJobOutputLine } from '../../adapter/ports/channel-view.js'
import type { Theme } from '../../theme.js'
import { t } from '../../i18n.js'
import { wrapTextLines } from '../../ink/wrap-text.js'
import { isMinimalUiMode } from '../../minimalUiMode.js'
import { ProgressBar } from '../design-system/ProgressBar.js'

/** The waterfall window mirrors the subagent card: a constant-height region. */
const WATERFALL_ROWS = 2
const COMMAND_MARK = process.platform === 'win32' ? '>' : '❯'

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
    const wrapped = wrapTextLines(entry.text, textWidth).map(line => line.text)
    for (let row = wrapped.length - 1; row >= 0 && rows.length < budget; row--) {
      rows.unshift({
        key: `${index}-${row}`,
        text: wrapped[row] ?? '',
      })
    }
    if (entry.gapBefore === true && rows.length < budget) rows.unshift({ key: `gap-${index}`, text: '', gap: true })
  }
  return rows
}
/** Command content shares normalization and wrapping with the full jobs panel. */
export function jobCommandRows(text: string, width: number, expanded: boolean): string[] {
  const command = text.trim()
  const script = command.replace(/^(?:pwsh|powershell)(?:\.exe)?\s+(?:(?:-(?:NoProfile|NoLogo|NonInteractive)|-ExecutionPolicy\s+\S+)\s+)*-Command\s+/i, '')
  const body = (script === command ? script : script.replace(/^(['"])([\s\S]*)\1$/, '$2')).replace(/\r\n?/g, '\n').trim()
  const source = body.split('\n').filter((line, index, lines) => line.trim() !== '' || index === 0 || lines[index - 1]?.trim() !== '').join('\n')
  const shown = expanded ? source : source.split('\n')[0]!
  const rows = wrapTextLines(COMMAND_MARK + ' ' + shown, Math.max(1, width)).map(line => line.text)
  return expanded ? rows : rows.slice(0, 1)
}

/** The renderer draws the continuous section edge across all content rows. */
export function JobSection({ rows, color, onToggle, children }: {
  rows: readonly string[]
  color: 'accent' | 'success'
  onToggle?: () => void
  children?: React.ReactNode
}): React.ReactNode {
  if (rows.length === 0 && children === undefined) return null
  return <Box flexDirection="column" borderStyle="single" borderTop={false} borderBottom={false} borderRight={false} borderLeft
    borderColor={color} paddingLeft={1}
    onClick={onToggle === undefined ? undefined : event => { event.stopImmediatePropagation(); onToggle() }}>
    {children === undefined ? rows.map((line, index) => <Text key={index} dimColor wrap="truncate-end">{line === '' ? ' ' : line}</Text>) : children}
  </Box>
}
/** Transcript job card: command folding is independent of the fixed output tail. */
export function JobCard({ job, marginTopOnTurn, onClick, onWatchOutput, expanded = false, onToggle }: {
  job: JobRow
  marginTopOnTurn: boolean
  onClick?(): void
  expanded?: boolean
  onToggle?: () => void
  onWatchOutput?: (id: string) => () => void
}): React.ReactNode {
  const settled = job.status === 'completed' || job.status === 'failed' || job.status === 'killed'
  React.useEffect(() => (settled || onWatchOutput === undefined ? undefined : onWatchOutput(job.id)), [settled, onWatchOutput, job.id])
  const [viewportRef] = useAnimationFrame(settled ? null : 1000)
  const { columns } = useTerminalSize()
  const info = statusInfo(job.status)
  const [hovered, setHovered] = React.useState(false)
  const contentWidth = Math.max(1, columns - 2)
  const commandRows = jobCommandRows(job.label, contentWidth, expanded)
  const output = jobOutputRows(job.outputLines, Math.max(1, contentWidth - 1), WATERFALL_ROWS)
  const outputRows = output.map((entry, index) => (index === 0 ? '≡ ' : '') + (entry.gap === true ? t('jobs-output-gap') : entry.text))
  const headerDetail = job.detail !== undefined && job.detail !== '' ? job.detail : undefined
  const headerName = `${t('jobs-card-prefix')}${job.id}`
  const duration = formatJobDuration(job)
  const liveProgress = settled || job.progress === undefined || job.progress === '' ? undefined : job.progress
  return <Box flexDirection="column" marginTop={marginTopOnTurn ? 1 : 0} ref={viewportRef}
    onClick={onToggle === undefined ? undefined : event => { event.stopImmediatePropagation(); onToggle() }}
    onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}>
    <Box flexDirection="row" gap={1} height={1} overflow="hidden"
      onClick={onClick === undefined ? undefined : event => { event.stopImmediatePropagation(); onClick() }}>
      <Box flexShrink={0}>
        <Text color={hovered ? 'accent' : info.color}>{info.glyph}</Text>
      </Box>
      <Box flexShrink={0}>
        <Text bold color={hovered ? 'accent' : undefined}>{headerName}</Text>
      </Box>
      <Box flexShrink={0}><Text dimColor>{job.kind}</Text></Box>
      {liveProgress !== undefined && <Box width={12} flexShrink={0}><JobProgress progress={liveProgress} /></Box>}
      <Box flexShrink={0}><Text dimColor>{duration}</Text></Box>
      {headerDetail !== undefined && <Box flexShrink={0}><Text dimColor wrap="truncate-end">{headerDetail}</Text></Box>}
      <Box flexShrink={0}><Text color={info.color}>{info.label}</Text></Box>
    </Box>
    <JobSection rows={commandRows} color="accent" />
    <JobSection rows={outputRows} color="success" />
  </Box>
}
