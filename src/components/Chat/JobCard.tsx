import React from 'react'
import { Box, Text, useAnimationFrame, useTerminalSize } from '../../ui.js'
import { formatJobDuration, type BackgroundJobStatus } from '../../dsh-adapter/jobs.js'
import type { JobRow } from '../../dsh-adapter/channel.js'
import type { Theme } from '../../theme.js'
import { t } from '../../i18n.js'
import { stringWidth } from '../../ink/stringWidth.js'
import { isMinimalMode } from '../../minimalMode.js'

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
  const minimal = isMinimalMode()
  switch (status) {
    case 'completed':
      return { glyph: '✓', label: t('jobs-status-completed'), color: minimal ? undefined : 'success' }
    case 'failed':
      return { glyph: '✗', label: t('jobs-status-failed'), color: minimal ? undefined : 'error' }
    case 'killed':
      return { glyph: '✗', label: t('jobs-status-killed'), color: minimal ? undefined : 'error' }
    case 'stopping':
      return { glyph: '●', label: t('jobs-status-stopping'), color: minimal ? undefined : 'warning' }
    default:
      return { glyph: '●', label: t('jobs-status-running'), color: minimal ? undefined : 'warning' }
  }
}

/** Hard single-line clip by display width — a wrapped waterfall row would
 *  break the constant-height window. */
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

/**
 * Live background-job card embedded in the transcript (`kind: 'job'`),
 * sibling of the subagent card: header (id · kind · label · elapsed ·
 * status) plus a bounded output waterfall (up to three rows) while the job
 * is live — and only when mirrored output exists: background jobs are
 * usually silent, so an outputless card is just its header line, never a
 * row of empty gutters. Settled jobs fold to the header line alone (a
 * failed/killed job keeps one detail line); the `/jobs` panel holds the
 * fuller view the card clicks to.
 *
 * The waterfall is MIRRORED, never polled: the harness job registry's read
 * is consuming and reserved for the owning agent, so the card shows the
 * tail of the agent's own job_output results as they stream through the
 * transcript.
 */
export function JobCard({ job, addMargin, onClick }: {
  job: JobRow
  addMargin: boolean
  onClick?(): void
}): React.ReactNode {
  const settled = job.status === 'completed' || job.status === 'failed' || job.status === 'killed'
  // 动画订阅仅限存活卡片：settled 后退订共享 clock（同 SubagentMessage 的
  // 约定）。1s tick 只驱动运行时长跳动——状态标是静态的（见 statusInfo）。
  const [viewportRef] = useAnimationFrame(settled ? null : 1000)
  const { columns } = useTerminalSize()
  const info = statusInfo(job.status)
  const [hovered, setHovered] = React.useState(false)
  const clickable = onClick !== undefined
  const rowWidth = Math.max(20, (columns ?? 80) - WATERFALL_GUTTER)
  const activity = settled ? [] : job.outputLines.slice(-WATERFALL_ROWS)
  // A settled job's terminal detail ('exit code: 0') rides the header; a
  // failed/killed one also keeps it as the explanatory tail line.
  const headerDetail = job.detail !== undefined && job.detail !== '' ? job.detail : undefined

  // 点击打开 /jobs 面板；hover 不刷整行背景（转录视觉保持安静），只把
  // 状态 glyph 提亮为品牌色作为可点指示。无外层缩进：任务卡是上方工具
  // 调用（run_in_background 卡）的延续，与工具卡通栏左对齐；子代理卡才
  // 是嵌套子实体、保留缩进。瀑布的 `  │ ` 槽自带两格，正好与工具卡正文
  // 的 `  ⎿ ` 槽位一致。
  return <Box
    flexDirection="column"
    marginTop={addMargin ? 1 : 0}
    ref={viewportRef}
    onClick={onClick}
    onMouseEnter={clickable ? () => setHovered(true) : undefined}
    onMouseLeave={clickable ? () => setHovered(false) : undefined}
  >
    <Box flexDirection="row" gap={1}>
      <Text color={hovered && clickable ? 'claude' : info.color}>{info.glyph}</Text>
      <Text bold color={hovered && clickable ? 'claude' : undefined}>
        {`${t('jobs-card-prefix')}${job.id}`}
      </Text>
      <Text dimColor>·</Text>
      <Text dimColor>{job.kind}</Text>
      <Text dimColor>·</Text>
      <Text>{clipLine(job.label, Math.max(10, rowWidth - 30))}</Text>
      <Text dimColor>·</Text>
      <Text dimColor>{formatJobDuration(job)}</Text>
      {headerDetail !== undefined && <><Text dimColor>·</Text><Text dimColor>{headerDetail}</Text></>}
      <Text dimColor>·</Text>
      <Text color={info.color}>{info.label}</Text>
    </Box>
    {!settled && activity.length > 0 && activity.map((line, index) => (
      // key 不含 time（同 SubagentMessage 的约定）：内容更新走 in-place
      // diff，避免每个 tick 都 unmount+mount。瀑布只在有镜像输出时出现
      // （后台任务静默是常态——无输出时卡片就是头行，不摆空 gutter）。
      <Text key={`${job.id}-wf-${index}`} dimColor wrap="truncate">
        {`  │ ${clipLine(line, rowWidth)}`}
      </Text>
    ))}
    {settled && job.status !== 'completed' && headerDetail !== undefined && (
      <Text dimColor wrap="truncate">{`  └ ${clipLine(headerDetail, rowWidth)}`}</Text>
    )}
  </Box>
}
