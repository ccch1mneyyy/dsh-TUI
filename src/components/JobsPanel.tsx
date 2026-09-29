import React from 'react'
import { Box, Text, useInput, ScrollBox, type ScrollBoxHandle, useTerminalSize, useAnimationFrame } from '../ui.js'
import { formatJobDuration, type BackgroundJobState, type BackgroundJobStatus } from '../dsh-adapter/jobs.js'
import type { Theme } from '../theme.js'
import { t } from '../i18n.js'
import { Divider } from './design-system/Divider.js'
import { ExitButton } from './SubagentDashboard.js'
import { isPlainReturnInput } from '../utils/modifiers.js'
import { isMinimalUiMode } from '../minimalUiMode.js'
import { stringWidth } from '../ink/stringWidth.js'

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

/** Hard single-line clip by display width (shared rule with the job card). */
function clipLine(text: string, maxWidth: number): string {
  if (maxWidth <= 1) return ''
  let width = 0
  let index = 0
  while (index < text.length) {
    const next = text.codePointAt(index)!
    const char = String.fromCodePoint(next)
    const charWidth = stringWidth(char)
    if (width + charWidth > maxWidth - 1) break
    width += charWidth
    index += char.length
  }
  return index < text.length ? `${text.slice(0, index)}…` : text
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

function JobRowLine({ job, focused, onFocus }: { job: BackgroundJobState; focused: boolean; onFocus?: () => void }): React.ReactNode {
  const { columns } = useTerminalSize()
  const info = statusInfo(job.status)
  const duration = formatJobDuration(job)
  const detail = job.detail !== undefined && job.detail !== '' ? job.detail : undefined
  // Reserve: glyph(2) id(~9) kind(~7) duration(~7) status(~6) separators(5×2)
  // — the label takes the rest and hard-clips instead of wrapping.
  const labelWidth = Math.max(10, (columns ?? 80) - 46)
  return (
    <Box flexDirection="column" onClick={onFocus}>
      <Box flexDirection="row" gap={1}>
        <Text color={focused ? 'accent' : undefined}>{focused ? '❯' : ' '}</Text>
        <Text color={info.color}>{info.glyph}</Text>
        <Text bold={focused} color={focused ? 'accent' : undefined}>{job.id}</Text>
        <Text dimColor>·</Text>
        <Text dimColor>{job.kind}</Text>
        <Text dimColor>·</Text>
        <Text bold={focused}>{clipLine(job.label, labelWidth)}</Text>
        {!isTerminalStatus(job.status) && job.progress !== undefined && job.progress !== '' && (
          <><Text dimColor>·</Text><Text color="accent">{clipLine(job.progress, 20)}</Text></>
        )}
        <Box flexGrow={1} />
        <Text dimColor>{duration}</Text>
        {detail !== undefined && <><Text dimColor>·</Text><Text dimColor>{detail}</Text></>}
        <Text dimColor>·</Text>
        <Text color={info.color}>{info.label}</Text>
      </Box>
      {focused && (
        <Box flexDirection="column">
          {/* 详情块：完整任务名 + 命令 + 起止/输出更新时间 + 镜像输出尾巴。 */}
          <Text dimColor wrap="truncate">
            {`    ${t('jobs-card-prefix')}${clipLine(job.label, Math.max(10, labelWidth + 24))}`}
          </Text>
          {job.command !== undefined && (
            <Text dimColor wrap="truncate">
              {`    ${t('jobs-panel-command')} ${clipLine(job.command, Math.max(10, labelWidth + 24))}`}
            </Text>
          )}
          <Text dimColor wrap="truncate">
            {`    ${t('jobs-panel-started')} ${timeOf(job.startedAt)}`}
            {job.finishedAt !== undefined ? ` · ${t('jobs-panel-finished')} ${timeOf(job.finishedAt)}` : ''}
            {job.lastOutputAt !== undefined ? ` · ${t('jobs-panel-output-at')} ${timeOf(job.lastOutputAt)}` : ''}
          </Text>
          {(job.outputTotalBytes !== undefined || job.outputDropped === true) && (
            <Text dimColor wrap="truncate">
              {job.outputTotalBytes !== undefined
                ? `    ${t('jobs-output-bytes', { bytes: formatBytes(job.outputTotalBytes) })}${job.outputDropped === true ? ` · ${t('jobs-output-dropped')}` : ''}`
                : `    ${t('jobs-output-dropped')}`}
            </Text>
          )}
          {job.spillPaths !== undefined && job.spillPaths.length > 0 && (
            <Text dimColor wrap="truncate">
              {`    ${t('jobs-output-spill', { path: job.spillPaths[job.spillPaths.length - 1] ?? '' })}`}
            </Text>
          )}
          {job.outputLines.length > 0 ? (
            job.outputLines.map((line, index) => (
              <React.Fragment key={`${job.id}-detail-${index}`}>
                {line.gapBefore === true && (
                  <Text dimColor italic wrap="truncate">
                    {`    · ${clipLine(t('jobs-output-gap'), Math.max(10, labelWidth + 24))}`}
                  </Text>
                )}
                <Text
                  color={line.channel === 'stderr' ? 'error' : undefined}
                  dimColor={line.channel !== 'stderr'}
                  wrap="truncate"
                >
                  {`    │ ${clipLine(line.text, Math.max(10, labelWidth + 24))}`}
                </Text>
              </React.Fragment>
            ))
          ) : (
            <Text dimColor wrap="truncate">
              {`    └ ${t('jobs-panel-no-output-yet')}`}
            </Text>
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
  const scrollRef = React.useRef<ScrollBoxHandle | null>(null)
  const { rows } = useTerminalSize()
  // 1s tick keeps live durations counting while the panel is open.
  const [clockRef] = useAnimationFrame(1000)

  const focus = Math.min(focusIndex, Math.max(0, jobs.length - 1))

  useInput((input, key, event) => {
    if (key.escape || (key.ctrl && input === 'c')) {
      event.stopImmediatePropagation()
      onClose()
      return
    }
    if (key.upArrow) {
      event.stopImmediatePropagation()
      setFocusIndex(i => Math.max(0, i - 1))
      scrollRef.current?.scrollBy(-1)
      return
    }
    if (key.downArrow) {
      event.stopImmediatePropagation()
      setFocusIndex(i => Math.min(jobs.length - 1, i + 1))
      scrollRef.current?.scrollBy(1)
      return
    }
    if (input === 'k') {
      const selected = jobs[focus]
      if (selected !== undefined && (selected.status === 'running' || selected.status === 'stopping')) {
        event.stopImmediatePropagation()
        onKill(selected.id)
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
                onFocus={() => setFocusIndex(index)}
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
