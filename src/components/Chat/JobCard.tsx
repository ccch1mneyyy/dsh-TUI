import React from 'react'
import { Box, Text, useAnimationFrame, useTerminalSize } from '../../ui.js'
import { formatJobDuration, type BackgroundJobStatus } from '../../dsh-adapter/jobs.js'
import type { JobRow } from '../../dsh-adapter/channel.js'
import type { BackgroundJobOutputChannel, BackgroundJobOutputLine } from '../../adapter/ports/channel-view.js'
import type { Theme } from '../../theme.js'
import { t } from '../../i18n.js'
import wrapText from '../../ink/wrap-text.js'
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
function waterfallWindow(
  entries: ReadonlyArray<{ kind: 'line'; line: BackgroundJobOutputLine } | { kind: 'gap' }>,
  width: number,
  budget: number,
): WaterfallRow[] {
  const rows: WaterfallRow[] = []
  // One cell of slack: a line that lands exactly on the boundary is re-wrapped
  // by ink's own renderer, which would silently double that row's height.
  const textWidth = Math.max(1, width - 1)
  for (let index = entries.length - 1; index >= 0 && rows.length < budget; index--) {
    const entry = entries[index]!
    if (entry.kind === 'gap') {
      rows.unshift({ key: `gap-${index}`, text: '', gap: true })
      continue
    }
    const wrapped = wrapText(entry.line.text, textWidth, 'wrap').split('\n')
    for (let row = wrapped.length - 1; row >= 0 && rows.length < budget; row--) {
      rows.unshift({
        key: `${index}-${row}`,
        text: wrapped[row] ?? '',
        ...(entry.line.channel === undefined ? {} : { channel: entry.line.channel }),
      })
    }
  }
  return rows
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
 *
 * `rail` marks the card as a member of a job GROUP (see JobGroupRow): the
 * card gets a 2-cell chain column on its left — a `mid` member draws it as a
 * left BORDER (so it spans every line, wrapped label rows included), while
 * the `tail` member closes with a `└` joint glyph. A lone card passes no
 * rail and renders exactly as before.
 */
export function JobCard({ job, marginTopOnTurn, onClick, rail, onWatchOutput }: {
  job: JobRow
  marginTopOnTurn: boolean
  onClick?(): void
  /** Group member: chain joint on the left (`mid` continues, `tail` closes). */
  rail?: 'mid' | 'tail' | undefined
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
  // Chain column of a grouped card: the header line carries the joint, and
  // every continuation line indents by the same two cells so the body hangs
  // under its own header (the tree convention).
  const railGlyph = rail === undefined ? undefined : rail === 'tail' ? '└' : '│'
  // A CONTINUING member (│) draws its rail as the body box's LEFT BORDER: the
  // border spans every line of the card, so a label that wraps onto three rows
  // keeps one unbroken rail (a per-line string prefix cannot do that — the
  // wrapped rows are produced inside the label column, where no prefix runs).
  // The closing member (└) has nothing below it, so it keeps the joint glyph
  // and a blank 2-cell gutter; both land the card body on column 2.
  const bordered = railGlyph === '│'
  // Continuation rows (waterfall / detail tail) hang under the card's own
  // 4-cell body gutter; only the closing member needs the blank column, the
  // bordered one is offset by its border + padding.
  const gutter = railGlyph === '└' ? '  ' : ''
  // A grouped card spends two more columns on the rail: the waterfall must be
  // wrapped against the width that is actually left, or every row would wrap
  // a second time in ink and the window would grow past its budget.
  const rowWidth = Math.max(20, (columns ?? 80) - WATERFALL_GUTTER - (railGlyph === undefined ? 0 : 2))
  // Waterfall entries: gap banners interleave as their own rows, then the
  // window keeps the LAST WATERFALL_ROWS entries so a banner never pushes a
  // fresher line out — the card stays constant-height.
  const waterfall: Array<{ kind: 'line'; line: BackgroundJobOutputLine } | { kind: 'gap' }> = []
  for (const line of settled ? [] : job.outputLines) {
    if (line.gapBefore === true) waterfall.push({ kind: 'gap' })
    waterfall.push({ kind: 'line', line })
  }
  const activity = waterfallWindow(waterfall, rowWidth, WATERFALL_ROWS)
  // A settled job's terminal detail ('exit code: 0') rides the header; a
  // failed/killed one also keeps it as the explanatory tail line.
  const headerDetail = job.detail !== undefined && job.detail !== '' ? job.detail : undefined
  const headerName = `${t('jobs-card-prefix')}${job.id}`
  const duration = formatJobDuration(job)
  // Only a LIVE job carries a progress chip; a settled one has dropped it, so
  // reserving width for it unconditionally would clip the label for nothing.
  const liveProgress = settled || job.progress === undefined || job.progress === '' ? undefined : job.progress

  // 点击打开 /jobs 面板；hover 不刷整行背景（转录视觉保持安静），只把
  // 状态 glyph 提亮为品牌色作为可点指示。无外层缩进：任务卡是上方工具
  // 调用（run_in_background 卡）的延续，与工具卡通栏左对齐；子代理卡才
  // 是嵌套子实体、保留缩进。瀑布的 `  │ ` 槽自带两格，正好与工具卡正文
  // 的 `  ⎿ ` 槽位一致。
  //
  // 成组时的竖线不在 body 里：继续中的成员把 body 包进一个只有左边框的
  // Box（见下方 bordered），边框覆盖整张卡的每一行——标签折行出的续行也
  // 有线，链条不断。收口的尾成员用 `└ ` 字形 + 2 格空槽，两者都把正文
  // 落在第 2 列。
  const body = (
    <>
    {/* Fixed columns around ONE flexible label: the other columns hold their
      * width while the label wraps, so the grid survives any label length and
      * the progress chip (the old header reserved a hand-counted width and
      * overflowed by exactly the chip's width). */}
    <Box flexDirection="row" gap={1}>
      {/* The rail joint rides the status glyph's own text node: a sibling Box
        * would collect the row's `gap` on top of the joint's space. It still
        * needs flexShrink={0} like every other fixed column — a wrapped label
        * over-constrains the row, and an unguarded text node shrinks with it,
        * pushing the joint+glyph pair onto a line of its own (stray ✓). */}
      <Box flexShrink={0}>
        <Text color={hovered && clickable ? 'accent' : info.color}>
          {/* Only the closing joint is a glyph; the continuing rail is the
            * border of the box this body is wrapped in (see `bordered`). */}
          {railGlyph === '└' ? <Text color="inactive">{'└ '}</Text> : null}
          {info.glyph}
        </Text>
      </Box>
      <Box flexShrink={0}>
        <Text bold color={hovered && clickable ? 'accent' : undefined}>
          {headerName}
        </Text>
      </Box>
      <Box flexShrink={0}><Text dimColor>{job.kind}</Text></Box>
      {/* The label is the one flexible column: it WRAPS here (a long
        * command stays readable instead of vanishing into an ellipsis in a
        * narrow terminal) while every other column keeps its fixed width. */}
      <Box flexGrow={1} flexShrink={1}>
        <Text>{job.label}</Text>
      </Box>
      {liveProgress !== undefined && (
        <Box width={12} flexShrink={0}>
          <JobProgress progress={liveProgress} />
        </Box>
      )}
      <Box flexShrink={0}><Text dimColor>{duration}</Text></Box>
      {headerDetail !== undefined && <Box flexShrink={0}><Text dimColor wrap="truncate-end">{headerDetail}</Text></Box>}
      <Box flexShrink={0}><Text color={info.color}>{info.label}</Text></Box>
    </Box>
    {!settled && activity.length > 0 && activity.map(entry => (
      // key 不含 time（同 SubagentMessage 的约定）：内容更新走 in-place
      // diff，避免每个 tick 都 unmount+mount。瀑布只在有镜像输出时出现
      // （后台任务静默是常态——无输出时卡片就是头行，不摆空 gutter）。
      // Rows are pre-wrapped to the row width, so truncate is a belt-and-braces
      // guard against a re-wrap (which would break the constant height).
      entry.gap === true ? (
        <Text key={entry.key} dimColor italic wrap="truncate">
          {`${gutter}  · ${t('jobs-output-gap')}`}
        </Text>
      ) : (
        <Text
          key={entry.key}
          color={entry.channel === 'stderr' ? 'error' : undefined}
          dimColor={entry.channel !== 'stderr'}
          wrap="truncate"
        >
          {`${gutter}  │ ${entry.text}`}
        </Text>
      )
    ))}
    {settled && job.status !== 'completed' && headerDetail !== undefined && (
      <Text dimColor>{`${gutter}  └ ${headerDetail}`}</Text>
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
    {bordered ? (
      <Box
        flexDirection="column"
        borderStyle="single"
        // 这个实现里边框默认四边全画，要靠 `false` 逐边关掉：只要左边。
        borderTop={false}
        borderBottom={false}
        borderRight={false}
        borderColor="inactive"
        paddingLeft={1}
      >
        {body}
      </Box>
    ) : body}
  </Box>
}
