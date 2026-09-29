import React from 'react'
import { Box, Text, useInput, ScrollBox, type ScrollBoxHandle, useTerminalSize, useAnimationFrame } from '../ui.js'
import { formatJobDuration, type BackgroundJobState, type BackgroundJobStatus } from '../dsh-adapter/jobs.js'
import { JobProgress } from './Chat/JobCard.js'
import { Markdown } from './Markdown.js'
import type { Theme } from '../theme.js'
import { t } from '../i18n.js'
import { Divider } from './design-system/Divider.js'
import { ExitButton } from './SubagentDashboard.js'
import { isPlainReturnInput } from '../utils/modifiers.js'
import { isMinimalUiMode } from '../minimalUiMode.js'

export interface JobsPanelProps {
  jobs: readonly BackgroundJobState[]
  onClose: () => void
  /** Kill the focused live job (`job_kill` with the session's authority). */
  onKill: (id: string) => void
}

function statusInfo(status: BackgroundJobStatus): { glyph: string; label: string; color: keyof Theme | undefined } {
  const minimalUi = isMinimalUiMode()
  switch (status) {
    case 'completed':
      return { glyph: minimalUi ? '✓' : '●', label: t('jobs-status-completed'), color: minimalUi ? undefined : 'success' }
    case 'failed':
      return { glyph: minimalUi ? '×' : '●', label: t('jobs-status-failed'), color: minimalUi ? undefined : 'error' }
    case 'killed':
      return { glyph: minimalUi ? '×' : '●', label: t('jobs-status-killed'), color: minimalUi ? undefined : 'error' }
    case 'stopping':
      return { glyph: minimalUi ? '·' : '●', label: t('jobs-status-stopping'), color: minimalUi ? undefined : 'warning' }
    default:
      return { glyph: minimalUi ? '·' : '●', label: t('jobs-status-running'), color: minimalUi ? undefined : 'warning' }
  }
}

function isTerminalStatus(status: BackgroundJobStatus): boolean {
  return status === 'completed' || status === 'killed' || status === 'failed'
}

/** 12.3 KB / 1.4 MB — byte counter for the detail block. */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * Group one job's mirrored output tail into render runs: consecutive stdout
 * lines become ONE markdown document (a subagent job's report renders as
 * prose; plain shell logs take the markdown fast text path), while stderr
 * rows stay red single lines, log rows stay dim italic narration, and a
 * `gapBefore` marker becomes its own banner between runs.
 */
type OutputRun =
  | { kind: 'gap' }
  | { kind: 'markdown'; text: string }
  | { kind: 'stderr'; text: string }
  | { kind: 'log'; text: string }

function renderOutputRuns(job: BackgroundJobState): OutputRun[] {
  const runs: OutputRun[] = []
  let markdown: string[] = []
  const flush = (): void => {
    if (markdown.length === 0) return
    runs.push({ kind: 'markdown', text: markdown.join('\n') })
    markdown = []
  }
  for (const line of job.outputLines) {
    if (line.gapBefore === true) {
      flush()
      runs.push({ kind: 'gap' })
    }
    if (line.channel === 'stderr') {
      flush()
      runs.push({ kind: 'stderr', text: line.text })
    } else if (line.channel === 'log') {
      flush()
      runs.push({ kind: 'log', text: line.text })
    } else {
      markdown.push(line.text)
    }
  }
  flush()
  return runs
}

function JobRowLine({ job, focused, armed, showProgress, onFocus }: {
  job: BackgroundJobState
  focused: boolean
  armed?: boolean
  /** Reserve the progress column on EVERY row (see the panel below) so the
   *  grid stays aligned once one live job reports progress. */
  showProgress?: boolean
  onFocus?: () => void
}): React.ReactNode {
  const info = statusInfo(job.status)
  const duration = formatJobDuration(job)
  const live = !isTerminalStatus(job.status)
  const progress = live && job.progress !== undefined && job.progress !== '' ? job.progress : undefined
  return (
    <Box flexDirection="column" onClick={onFocus}>
      {/* Fixed columns around ONE flexible label. The old row reserved a
        * hand-counted `columns - 46` for the label, which ignored the progress
        * chip (+22) and the exit detail (+15) — any long command then overflowed
        * and ink wrapped it, splitting the id across two lines. The label now
        * truncates into whatever is left, so the grid holds at every width. */}
      <Box flexDirection="row" gap={1}>
        {/* Marker and status glyph share one 2-cell cell: as two siblings the
          * row gap collapsed between them and the marker touched the glyph. */}
        <Box width={2} flexShrink={0}>
          <Text color={focused ? 'accent' : undefined}>{focused ? '❯' : ' '}</Text>
          <Text color={info.color}>{info.glyph}</Text>
        </Box>
        <Box width={9} flexShrink={0}>
          <Text bold={focused} color={focused ? 'accent' : undefined} wrap="truncate-end">{job.id}</Text>
        </Box>
        <Box flexGrow={1} flexShrink={1}>
          <Text bold={focused} wrap="truncate-end">{job.label}</Text>
        </Box>
        {showProgress === true && (
          <Box width={11} flexShrink={0} justifyContent="flex-end">
            {progress !== undefined ? <JobProgress progress={progress} /> : <Text> </Text>}
          </Box>
        )}
        {armed === true ? (
          // The confirmation replaces duration+status in place: appending it
          // would widen the row past the grid the moment the key is pressed.
          <Text bold color="error" wrap="truncate-end">{t('jobs-kill-armed')}</Text>
        ) : (
          <>
            <Box width={6} flexShrink={0} justifyContent="flex-end"><Text dimColor>{duration}</Text></Box>
            {/* Right-aligned too: a 4-cell status ("失败") next to a 6-cell one
              * ("已完成") left the row's right edge ragged. */}
            <Box width={9} flexShrink={0} justifyContent="flex-end"><Text color={info.color} wrap="truncate-end">{info.label}</Text></Box>
          </>
        )}
      </Box>
      {focused && (
        // Detail block on one label gutter (width 6 in both languages): the
        // row above already names the job, so the old `任务：…` line was pure
        // repetition, and the command only earns a line when it differs.
        <Box flexDirection="column" paddingLeft={4}>
          {job.command !== undefined && job.command !== '' && job.command !== job.label && (
            <Box flexDirection="row" gap={1}>
              <Box width={7} flexShrink={0}><Text dimColor>{t('jobs-panel-command')}</Text></Box>
              <Text dimColor wrap="truncate-end">{job.command}</Text>
            </Box>
          )}
          <Box flexDirection="row" gap={1}>
            <Box width={7} flexShrink={0}><Text dimColor>{t('jobs-panel-started')}</Text></Box>
            <Text dimColor wrap="truncate-end">
              {timeOf(job.startedAt)
                + (job.finishedAt !== undefined ? ` · ${t('jobs-panel-finished')} ${timeOf(job.finishedAt)}` : '')
                + (job.lastOutputAt !== undefined ? ` · ${t('jobs-panel-output-at')} ${timeOf(job.lastOutputAt)}` : '')}
            </Text>
          </Box>
          {(job.outputTotalBytes !== undefined || job.outputDropped === true) && (
            <Box flexDirection="row" gap={1}>
              <Box width={7} flexShrink={0}><Text dimColor>{t('jobs-panel-output')}</Text></Box>
              <Text dimColor wrap="truncate-end">
                {(job.outputTotalBytes !== undefined ? formatBytes(job.outputTotalBytes) : '')
                  + (job.outputDropped === true
                    ? `${job.outputTotalBytes !== undefined ? ' · ' : ''}${t('jobs-output-dropped')}`
                    : '')}
              </Text>
            </Box>
          )}
          {job.spillPaths !== undefined && job.spillPaths.length > 0 && (
            <Box paddingLeft={8}>
              <Text dimColor wrap="truncate-end">
                {t('jobs-output-spill', { path: job.spillPaths[job.spillPaths.length - 1] ?? '' })}
              </Text>
            </Box>
          )}
          {job.outputLines.length > 0 ? (
            <Box flexDirection="column" marginTop={1}>
              {renderOutputRuns(job).map((run, runIndex) => (
                <Box
                  key={`${job.id}-run-${runIndex}`}
                  flexDirection="column"
                  marginTop={runIndex === 0 ? 0 : 1}
                >
                  {run.kind === 'gap' && (
                    <Text dimColor italic wrap="truncate-end">{t('jobs-output-gap')}</Text>
                  )}
                  {run.kind === 'markdown' && (
                    // stdout prose (a subagent job's report, an agent's
                    // narrated plan) renders through the shared markdown
                    // pipeline; plain shell logs take its fast text path.
                    <Markdown cacheTokens>{run.text}</Markdown>
                  )}
                  {run.kind === 'stderr' && (
                    <Text color="error" wrap="truncate-end">{`│ ${run.text}`}</Text>
                  )}
                  {run.kind === 'log' && (
                    <Text dimColor italic wrap="truncate-end">{`│ ${run.text}`}</Text>
                  )}
                </Box>
              ))}
            </Box>
          ) : (
            <Text dimColor wrap="truncate-end">{t('jobs-panel-no-output-yet')}</Text>
          )}
        </Box>
      )}
    </Box>
  )
}

/** HH:MM:SS wall-clock of an epoch ms value (locale-independent). */
function timeOf(ms: number): string {
  const date = new Date(ms)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/**
 * `/jobs` overlay panel — every background job of the current session with
 * live status, elapsed/total duration and terminal detail (exit code).
 * Keyboard: ↑/↓ move, k kills the focused live job, Esc closes; the focused
 * row expands a detail block (full label, start/finish times, mirrored
 * output tail). The panel is the deep view behind the transcript job cards.
 */
export function JobsPanel({ jobs, onClose, onKill }: JobsPanelProps): React.ReactNode {
  const [focusIndex, setFocusIndex] = React.useState(0)
  /** Armed kill: first `k` primes, second within the window confirms; any
   *  navigation or other key disarms. Mirrors the web two-press stop. */
  const [killArmed, setKillArmed] = React.useState<string | undefined>(undefined)
  const scrollRef = React.useRef<ScrollBoxHandle | null>(null)
  const { rows } = useTerminalSize()
  // 1s tick keeps live durations counting while the panel is open.
  const [clockRef] = useAnimationFrame(1000)

  const focus = Math.min(focusIndex, Math.max(0, jobs.length - 1))

  // The armed confirmation decays after 4s so a stray later `k` never kills.
  React.useEffect(() => {
    if (killArmed === undefined) return
    const timer = setTimeout(() => setKillArmed(undefined), 4000)
    return () => clearTimeout(timer)
  }, [killArmed])

  useInput((input, key, event) => {
    if (key.escape || (key.ctrl && input === 'c')) {
      event.stopImmediatePropagation()
      onClose()
      return
    }
    if (key.upArrow) {
      event.stopImmediatePropagation()
      setKillArmed(undefined)
      setFocusIndex(i => Math.max(0, i - 1))
      scrollRef.current?.scrollBy(-1)
      return
    }
    if (key.downArrow) {
      event.stopImmediatePropagation()
      setKillArmed(undefined)
      setFocusIndex(i => Math.min(jobs.length - 1, i + 1))
      scrollRef.current?.scrollBy(1)
      return
    }
    if (input === 'k') {
      const selected = jobs[focus]
      if (selected !== undefined && (selected.status === 'running' || selected.status === 'stopping')) {
        event.stopImmediatePropagation()
        if (killArmed === selected.id) {
          setKillArmed(undefined)
          onKill(selected.id)
        } else {
          setKillArmed(selected.id)
        }
      }
      return
    }
    // Enter on a live job does nothing extra (the card/panel IS the view);
    // keep the key consumed while the panel owns the keyboard.
    if (isPlainReturnInput(input, key)) {
      event.stopImmediatePropagation()
      return
    }
    event.stopImmediatePropagation()
  })

  const running = jobs.filter(job => job.status === 'running' || job.status === 'stopping').length
  // One live job with a progress line reserves the column on every row, so the
  // right-hand grid does not shift as jobs start and finish.
  const showProgress = jobs.some(job => (job.status === 'running' || job.status === 'stopping') && job.progress !== undefined && job.progress !== '')
  const completed = jobs.filter(job => job.status === 'completed').length
  const failed = jobs.filter(job => job.status === 'failed' || job.status === 'killed').length

  return (
    <Box flexDirection="column" paddingX={2} paddingY={1} ref={clockRef}>
      <Divider color="accent" title={t('jobs-panel-title')} />

      <Box flexDirection="row" gap={3} marginTop={1} marginBottom={1}>
        <Text>
          <Text color="accent">{running}</Text>
          <Text dimColor> {t('jobs-panel-count-running')}</Text>
        </Text>
        <Text>
          <Text color="success">{completed}</Text>
          <Text dimColor> {t('jobs-panel-count-completed')}</Text>
        </Text>
        {failed > 0 && (
          <Text>
            <Text color="error">{failed}</Text>
            <Text dimColor> {t('jobs-panel-count-failed')}</Text>
          </Text>
        )}
        <Box flexGrow={1} />
        <ExitButton onClick={onClose} />
      </Box>

      <Box flexDirection="column" maxHeight={Math.max(10, rows - 10)} marginTop={1}>
        <ScrollBox ref={scrollRef} flexDirection="column" flexGrow={1}>
          {jobs.length === 0 ? (
            <Box flexDirection="column" alignItems="center" marginTop={Math.max(2, Math.floor((rows - 16) / 3))}>
              <Text dimColor>{'○'}</Text>
              <Text dimColor>{t('jobs-panel-empty')}</Text>
              <Box marginTop={1}><Text dimColor>{t('jobs-panel-empty-hint')}</Text></Box>
            </Box>
          ) : (
            jobs.map((job, index) => (
              <JobRowLine
                key={job.id}
                job={job}
                focused={index === focus}
                armed={killArmed === job.id}
                showProgress={showProgress}
                onFocus={() => { setKillArmed(undefined); setFocusIndex(index) }}
              />
            ))
          )}
        </ScrollBox>
      </Box>

      <Divider color="subtle" title="" />
      <Box marginTop={0}>
        <Text dimColor>{t('jobs-panel-hint')}</Text>
      </Box>
    </Box>
  )
}
