import React from 'react'
import { Box, Text, useInput, ScrollBox, type ScrollBoxHandle, useTerminalSize, useAnimationFrame } from '../ui.js'
import { formatJobDuration, JOBS_MAX_OUTPUT_LINES, type BackgroundJobState, type BackgroundJobStatus, type JobTimelineEvent } from '../dsh-adapter/jobs.js'
import { JobProgress } from './Chat/JobCard.js'
import { Markdown } from './Markdown.js'
import type { Theme } from '../theme.js'
import { t } from '../i18n.js'
import { Divider } from './design-system/Divider.js'
import { ExitButton } from './SubagentDashboard.js'
import { isPlainReturnInput } from '../utils/modifiers.js'
import { isMinimalUiMode } from '../minimalUiMode.js'
import { usePanelInput } from './sidePanel/usePanelInput.js'
import type { PanelKeyHandler } from './sidePanel/types.js'

/**
 * Pure width→column allocation for the roster row (kept side-effect free so
 * regressions can assert the table directly). There is no pid column in this
 * roster. Side-panel tiers: the label always truncates and every column
 * leaves it ≥8 cells — progress drops first, then duration, then the
 * id/status columns narrow — so a 38-col panel never folds a command into
 * per-word lines. The full-screen form keeps its wrap-the-label contract.
 */
export interface JobsRowColumns {
  readonly showProgress: boolean
  readonly showDuration: boolean
  readonly showStatus: boolean
  readonly idWidth: number
  readonly statusWidth: number
  /** 整屏形态 label 折行（长命令可读全文）；panel 形态 truncate-end
   *  （行高恒定，全文由焦点行的 detail 块承担）。 */
  readonly labelWrap: boolean
}

export function resolveJobsRowColumns(width: number): JobsRowColumns {
  if (width >= 52) return { showProgress: true, showDuration: true, showStatus: true, idWidth: 9, statusWidth: 9, labelWrap: false }
  if (width >= 44) return { showProgress: false, showDuration: true, showStatus: true, idWidth: 9, statusWidth: 9, labelWrap: false }
  if (width >= 34) return { showProgress: false, showDuration: true, showStatus: true, idWidth: 8, statusWidth: 6, labelWrap: false }
  return { showProgress: false, showDuration: false, showStatus: true, idWidth: 7, statusWidth: 6, labelWrap: false }
}

export interface JobsPanelProps {
  jobs: readonly BackgroundJobState[]
  /** Focus this job on open (a transcript card click opens the panel AT its
   *  job); absent or unknown ids fall back to the roster head. */
  initialFocusId?: string
  /** Panel-variant focus lane: same intent as initialFocusId but re-fireable
   *  (nonce bumps on every request, so clicking the same card twice refocuses).
   *  Ignored by the default (full-screen) variant. */
  focusRequest?: { readonly id: string | null; readonly nonce: number } | null
  onClose?: () => void
  /** Kill the focused live job (`job_kill` with the session's authority). */
  onKill: (id: string) => void
  /** Keep the focused job's output tail fresh while the panel shows it
   *  (a backend whose output is read on demand); returns the unwatch. */
  onWatchOutput?: (id: string) => () => void
  /** Send to Chat（§6.7）：把焦点任务作为附加上下文送进草稿（chip 出现在
   *  输入框上方，随下一次提交附给模型）。仅 panel 形态；未接时不提供 's'。 */
  onSendToChat?: (job: BackgroundJobState) => void
  /** 'panel' mounts inside the side-panel host (no outer padding, host-owned
   *  chrome, keyboard via usePanelInput). Default keeps the full-screen
   *  behavior byte-for-byte. */
  variant?: 'default' | 'panel'
  /** Panel variant: the host reports focus/visibility; inactive panels keep
   *  their state but receive no keys and pause the clock. */
  focused?: boolean
  visible?: boolean
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
  for (const line of job.outputLines ?? []) {
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

function JobRowLine({ job, focused, armed, columns, onFocus }: {
  job: BackgroundJobState
  focused: boolean
  armed?: boolean
  /** Column allocation (see resolveJobsRowColumns); the progress flag
   * reserves the column on EVERY row so the grid stays aligned once one
   * live job reports progress. */
  columns: JobsRowColumns
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
        <Box width={columns.idWidth} flexShrink={0}>
          <Text bold={focused} color={focused ? 'accent' : undefined} wrap="truncate-end">{job.id}</Text>
        </Box>
        {/* The label is the row's flexible column and WRAPS: a long command
          * folds onto the following lines (hanging under its own column)
          * instead of collapsing to an ellipsis when the terminal is narrow.
          * The id, progress, duration and status columns keep their grid. */}
        <Box flexGrow={1} flexShrink={1}>
          <Text bold={focused} wrap={columns.labelWrap ? undefined : 'truncate-end'}>{job.label}</Text>
        </Box>
        {columns.showProgress && (
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
            {columns.showDuration && (
              <Box width={6} flexShrink={0} justifyContent="flex-end"><Text dimColor>{duration}</Text></Box>
            )}
            {/* Right-aligned too: a 4-cell status ("失败") next to a 6-cell one
              * ("已完成") left the row's right edge ragged. */}
            {columns.showStatus && (
              <Box width={columns.statusWidth} flexShrink={0} justifyContent="flex-end"><Text color={info.color} wrap="truncate-end">{info.label}</Text></Box>
            )}
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
              {/* Detail values WRAP: a long command, a long path or a wide
                * output line must be readable in full here — the panel is the
                * deep view, and a clipped one-liner was the "a long line shows
                * nothing" report. */}
              <Text dimColor>{job.command}</Text>
            </Box>
          )}
          <Box flexDirection="row" gap={1}>
            <Box width={7} flexShrink={0}><Text dimColor>{t('jobs-panel-started')}</Text></Box>
            <Text dimColor>
              {timeOf(job.startedAt)
                + (job.finishedAt !== undefined ? ` · ${t('jobs-panel-finished')} ${timeOf(job.finishedAt)}` : '')
                + (job.lastOutputAt !== undefined ? ` · ${t('jobs-panel-output-at')} ${timeOf(job.lastOutputAt)}` : '')}
            </Text>
          </Box>
          {(job.outputTotalBytes !== undefined || job.outputDropped === true || (job.outputLines?.length ?? 0) >= JOBS_MAX_OUTPUT_LINES) && (
            <Box flexDirection="row" gap={1}>
              <Box width={7} flexShrink={0}><Text dimColor>{t('jobs-panel-output')}</Text></Box>
              <Text dimColor>
                {(job.outputTotalBytes !== undefined ? formatBytes(job.outputTotalBytes) : '')
                  + (job.outputDropped === true
                    ? `${job.outputTotalBytes !== undefined ? ' · ' : ''}${t('jobs-output-dropped')}`
                    : '')
                  // At the retention cap the visible tail is provably partial:
                  // say so instead of letting it read as the whole stream.
                  + ((job.outputLines?.length ?? 0) >= JOBS_MAX_OUTPUT_LINES
                    ? `${job.outputTotalBytes !== undefined || job.outputDropped === true ? ' · ' : ''}${t('jobs-output-retained-tail', { n: job.outputLines?.length ?? 0 })}`
                    : '')}
              </Text>
            </Box>
          )}
          {job.lastProgress !== undefined && (
            // The producer's last progress line outlives the live chip: the
            // registry clears `progress` at settle, the detail keeps the last
            // line with its observation time and the producer kind.
            <Box flexDirection="row" gap={1}>
              <Box width={7} flexShrink={0}><Text dimColor>{t('jobs-progress-latest')}</Text></Box>
              <Text dimColor>
                {job.lastProgress}
                {job.lastProgressAt !== undefined ? ` · ${t('jobs-progress-updated-at', { time: timeOf(job.lastProgressAt) })}` : ''}
                {` · ${t('jobs-progress-source', { source: job.kind })}`}
              </Text>
            </Box>
          )}
          {job.spillPaths !== undefined && job.spillPaths.length > 0 && (
            <Box paddingLeft={8}>
              <Text dimColor>
                {t('jobs-output-spill', { path: job.spillPaths[job.spillPaths.length - 1] ?? '' })}
              </Text>
            </Box>
          )}
          {(job.outputLines?.length ?? 0) > 0 ? (
            <Box flexDirection="column" marginTop={1}>
              {renderOutputRuns(job).map((run, runIndex) => (
                <Box
                  key={`${job.id}-run-${runIndex}`}
                  flexDirection="column"
                  marginTop={runIndex === 0 ? 0 : 1}
                >
                  {run.kind === 'gap' && (
                    <Text dimColor italic>{t('jobs-output-gap')}</Text>
                  )}
                  {run.kind === 'markdown' && (
                    // stdout prose (a subagent job's report, an agent's
                    // narrated plan) renders through the shared markdown
                    // pipeline; plain shell logs take its fast text path.
                    <Markdown cacheTokens>{run.text}</Markdown>
                  )}
                  {run.kind === 'stderr' && (
                    <Text color="error">{`│ ${run.text}`}</Text>
                  )}
                  {run.kind === 'log' && (
                    <Text dimColor italic>{`│ ${run.text}`}</Text>
                  )}
                </Box>
              ))}
            </Box>
          ) : (
            <Text dimColor>{t('jobs-panel-no-output-yet')}</Text>
          )}
          {/* Bounded observation timeline: started, progress changes, output
              drains, gaps and the settle, in arrival order. A job whose
              history predates this process (resumed roster) says the
              timeline is unavailable instead of showing it empty. */}
          <Box flexDirection="column" marginTop={1}>
            <Text dimColor bold>{t('jobs-timeline')}</Text>
            {(job.timeline?.length ?? 0) === 0 ? (
              <Text dimColor italic>{t('jobs-timeline-events-unavailable')}</Text>
            ) : (
              <>
                {(job.gapCount ?? 0) > 0 && (
                  <Text dimColor italic>{t('jobs-timeline-gap-count', { n: job.gapCount ?? 0 })}</Text>
                )}
                {(job.timeline?.length ?? 0) > JOBS_TIMELINE_DISPLAY && (
                  <Text dimColor>{`… +${(job.timeline?.length ?? 0) - JOBS_TIMELINE_DISPLAY}`}</Text>
                )}
                {(job.timeline ?? []).slice(-JOBS_TIMELINE_DISPLAY).map((event, index) => (
                  <Text key={index} dimColor>{timelineLine(event)}</Text>
                ))}
              </>
            )}
          </Box>
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

/** The rendered form of one timeline observation: `HH:MM:SS <what>`.
 * Progress keeps the producer's own line verbatim (never re-parsed into a
 * percentage); an output drain names its byte advance and channel when the
 * kernel labelled one. */
function timelineLine(event: JobTimelineEvent): string {
  const time = timeOf(event.at)
  switch (event.kind) {
    case 'started':
      return `${time} ${t('jobs-timeline-started')}`
    case 'progress':
      return `${time} ${t('jobs-timeline-progress')} ${event.text ?? ''}`
    case 'output':
      return `${time} ${event.channel === 'stderr' ? 'stderr' : event.channel === 'log' ? 'log' : t('jobs-timeline-output')}${event.bytes === undefined ? '' : ` +${formatBytes(event.bytes)}`}`
    case 'gap':
      return `${time} ${t('jobs-timeline-gap')}`
    case 'stopping':
      return `${time} ${t('jobs-status-stopping')}`
    case 'settled':
      return `${time} ${t('jobs-timeline-settled')}${event.text === undefined || event.text === '' ? '' : ` · ${event.text}`}`
  }
}

/** Latest timeline slice shown in the focused detail: enough to read the
 * recent shape of the job without the block swallowing the panel. */
const JOBS_TIMELINE_DISPLAY = 8

/**
 * `/jobs` overlay panel — every background job of the current session with
 * live status, elapsed/total duration and terminal detail (exit code).
 * Keyboard: ↑/↓ move, k kills the focused live job, Esc closes; the focused
 * row expands a detail block (full label, start/finish times, mirrored
 * output tail). The panel is the deep view behind the transcript job cards.
 */
export function JobsPanel({ jobs, onClose, onKill, onSendToChat, initialFocusId, focusRequest, variant = 'default', focused = true, visible = true, onWatchOutput }: JobsPanelProps): React.ReactNode {
  const panelMode = variant === 'panel'
  const [focusIndex, setFocusIndex] = React.useState(() => {
    if (initialFocusId === undefined) return 0
    const found = jobs.findIndex(job => job.id === initialFocusId)
    return found >= 0 ? found : 0
  })
  // A card click may race the roster: the id can land after the panel opened
  // (late kernel push), so re-apply once when it first becomes findable.
  const initialFocusApplied = React.useRef(initialFocusId === undefined)
  React.useEffect(() => {
    if (initialFocusApplied.current || initialFocusId === undefined) return
    const found = jobs.findIndex(job => job.id === initialFocusId)
    if (found < 0) return
    initialFocusApplied.current = true
    setFocusIndex(found)
    scrollRef.current?.scrollTo(Math.max(0, found - 2))
  }, [jobs, initialFocusId])
  // Panel-variant focus lane: the same "open AT this job" intent, but each
  // request carries a nonce so re-clicking the same card refocuses. The
  // nonce is only consumed once the id resolves against the roster (the
  // late-kernel-push race from initialFocusId applies here too).
  const focusRequestNonceRef = React.useRef(-1)
  React.useEffect(() => {
    if (panelMode === false || focusRequest === undefined || focusRequest === null) return
    if (focusRequestNonceRef.current === focusRequest.nonce) return
    if (focusRequest.id === null) {
      focusRequestNonceRef.current = focusRequest.nonce
      return
    }
    const found = jobs.findIndex(job => job.id === focusRequest.id)
    if (found < 0) return
    focusRequestNonceRef.current = focusRequest.nonce
    initialFocusApplied.current = true
    setFocusIndex(found)
    scrollRef.current?.scrollTo(Math.max(0, found - 2))
  }, [jobs, focusRequest, panelMode])
  /** Armed kill: first `k` primes, second within the window confirms; any
   *  navigation or other key disarms. Mirrors the web two-press stop. */
  const [killArmed, setKillArmed] = React.useState<string | undefined>(undefined)
  const scrollRef = React.useRef<ScrollBoxHandle | null>(null)
  // PanelHost overrides the terminal-size context to the panel's own
  // columns/rows, so the same hook reports the panel geometry in panel mode.
  const { columns: terminalColumns, rows } = useTerminalSize()
  // 1s tick keeps live durations counting while the panel is open (a hidden
  // panel variant suspends the clock — zero subscriptions when invisible).
  const [clockRef] = useAnimationFrame(panelMode ? (visible ? 1000 : null) : 1000)

  // Bring an initial deep focus into view on mount (rows are ~1 line each;
  // two rows of headroom above reads better than pinning to the top edge).
  React.useEffect(() => {
    if (initialFocusId === undefined || initialFocusApplied.current === false) return
    if (initialFocusId !== undefined && jobs.findIndex(job => job.id === initialFocusId) > 2) {
      scrollRef.current?.scrollTo(Math.max(0, jobs.findIndex(job => job.id === initialFocusId) - 2))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only scroll placement
  }, [])

  const focus = Math.min(focusIndex, Math.max(0, jobs.length - 1))
  // The focused job's detail shows its output: keep that tail fresh while
  // the panel is open and visible (a hidden side-panel instance keeps its
  // state but reads nothing; a settled job is read once more, then left
  // alone).
  const focusedId = jobs[focus]?.id
  React.useEffect(() => (focusedId === undefined || onWatchOutput === undefined || !visible ? undefined : onWatchOutput(focusedId)), [focusedId, onWatchOutput, visible])

  // The armed confirmation decays after 4s so a stray later `k` never kills.
  React.useEffect(() => {
    if (killArmed === undefined) return
    const timer = setTimeout(() => setKillArmed(undefined), 4000)
    return () => clearTimeout(timer)
  }, [killArmed])

  // Full-screen form: byte-identical to the pre-panel behavior (the only
  // delta is isActive, which is always true in default mode). In panel mode
  // this stays registered-but-inactive so the hook order never changes; the
  // host dispatcher (usePanelInput) owns the keys instead.
  useInput((input, key, event) => {
    if (panelMode) return
    if (key.escape || (key.ctrl && input === 'c')) {
      event.stopImmediatePropagation()
      onClose?.()
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
  }, { isActive: !panelMode })

  // Panel form: same business keys through the host dispatcher. Esc/Ctrl+C
  // RETURN FALSE — the host fallback then walks the focus back to chat (the
  // panel never closes the sidebar itself); everything unconsumed also
  // returns false so [/]/z/+/-/digits keep working.
  const panelKeyHandler: PanelKeyHandler = (input, key) => {
    if (key.escape === true || (key.ctrl === true && input === 'c')) return false
    if (key.upArrow === true) {
      setKillArmed(undefined)
      setFocusIndex(i => Math.max(0, i - 1))
      scrollRef.current?.scrollBy(-1)
      return true
    }
    if (key.downArrow === true) {
      setKillArmed(undefined)
      setFocusIndex(i => Math.min(jobs.length - 1, i + 1))
      scrollRef.current?.scrollBy(1)
      return true
    }
    if (input === 'k') {
      const selected = jobs[focus]
      if (selected !== undefined && (selected.status === 'running' || selected.status === 'stopping')) {
        if (killArmed === selected.id) {
          setKillArmed(undefined)
          onKill(selected.id)
        } else {
          setKillArmed(selected.id)
        }
      }
      return true
    }
    // 's' = Send to Chat：焦点任务附为下一次提交的上下文（chip 在输入框
    // 上方，Esc 可撤）。未接通道时让出。
    if (input === 's') {
      if (onSendToChat === undefined) return false
      const selected = jobs[focus]
      if (selected === undefined) return true
      onSendToChat(selected)
      return true
    }
    // Enter keeps the same "panel owns the keyboard" semantics (no extra
    // action on a live job — the row IS the view).
    if (key.return_ === true) return true
    return false
  }
  usePanelInput(panelKeyHandler, { active: panelMode && focused && visible })

  const running = jobs.filter(job => job.status === 'running' || job.status === 'stopping').length
  // One live job with a progress line reserves the column on every row, so the
  // right-hand grid does not shift as jobs start and finish.
  const progressEligible = jobs.some(job => (job.status === 'running' || job.status === 'stopping') && job.progress !== undefined && job.progress !== '')
  // Column allocation: the full-screen form keeps the historical layout
  // (progress eligible as computed, duration and status always shown); the
  // panel form derives everything from the panel width.
  const rowColumns: JobsRowColumns = panelMode
    ? resolveJobsRowColumns(terminalColumns)
    : { showProgress: progressEligible, showDuration: true, showStatus: true, idWidth: 9, statusWidth: 9, labelWrap: true }
  const completed = jobs.filter(job => job.status === 'completed').length
  const failed = jobs.filter(job => job.status === 'failed' || job.status === 'killed').length

  if (panelMode) {
    // Panel layout aligned with TodoPanelAdapter: no outer padding beyond
    // one left/right cell, no title divider / exit button / hint footer
    // (PanelBar + the host hint row already carry that chrome), the summary
    // line kept but tightened for narrow widths.
    return (
      <Box flexDirection="column" paddingLeft={1} paddingRight={1} paddingTop={0} flexGrow={1} ref={clockRef}>
        <Box flexDirection="row" gap={1} marginTop={0} marginBottom={1}>
          <Text>
            <Text color="accent">{running}</Text>
            <Text dimColor> {t('jobs-panel-count-running')}</Text>
          </Text>
          {(terminalColumns >= 34 || failed > 0) && (
            <Text>
              <Text color={failed > 0 ? 'error' : 'success'}>{failed > 0 ? failed : completed}</Text>
              <Text dimColor> {failed > 0 ? t('jobs-panel-count-failed') : t('jobs-panel-count-completed')}</Text>
            </Text>
          )}
        </Box>
        <Box flexDirection="column" maxHeight={Math.max(6, rows - 4)} marginTop={0}>
          <ScrollBox ref={scrollRef} flexDirection="column" flexGrow={1}>
            {jobs.length === 0 ? (
              <Box flexDirection="column" alignItems="center" marginTop={2}>
                <Text dimColor>{'○'}</Text>
                <Text dimColor>{t('jobs-panel-empty')}</Text>
              </Box>
            ) : (
              jobs.map((job, index) => (
                <JobRowLine
                  key={job.id}
                  job={job}
                  focused={index === focus}
                  armed={killArmed === job.id}
                  columns={rowColumns}
                  onFocus={() => { setKillArmed(undefined); setFocusIndex(index) }}
                />
              ))
            )}
          </ScrollBox>
        </Box>
      </Box>
    )
  }

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
        <ExitButton onClick={() => onClose?.()} />
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
                columns={rowColumns}
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
