import React from 'react'
import { Box, Text, useTerminalSize, useTheme } from '../ui.js'
import type { Color } from '../ink/styles.js'
import { formatTokens } from '../cc/format.js'
import { t } from '../i18n.js'
import { formatContextUsage, DEFAULT_STATUS_BAR, normalizeStatusBar, type StatusBarConfig } from '../tuiDisplayPrefs.js'
import { estimateSessionCostCny, estimateSessionCostSplitCny, isDeepSeekOfficialProvider, isPeakHour } from '../deepseekPricing.js'
import { ActivityLine, contextPressurePct } from '../components/ActivityLine.js'
import { GoalStatusChip } from '../components/GoalTodoPanel.js'
import { formatJobDuration, type BackgroundJobState } from '../dsh-adapter/jobs.js'

/** Stable fallback for stubbed channels: verify/repro harnesses render the
 *  real Chat with partial channel literals that predate the jobs field. */
const NO_BACKGROUND_JOBS: readonly BackgroundJobState[] = []
import type { Channel } from '../dsh-adapter/channel.js'
import type { SelectionSnapshot } from '../dsh-adapter/ide-channel.js'
import { modeDisplayName } from '../sessionModes.js'
import { MiniWake } from '../components/trajectory/MiniWake.js'
import { ContextBarView } from '../components/ContextBarView.js'
import { TooltipTarget } from '../components/Tooltip.js'
import { formatProject } from '../sessions/format.js'
import { homeDir } from '../utils/paths.js'
import {
  USED_SEGMENTS,
  renderMiniContextBar,
  renderTpsGauge,
  renderTpsSparkline,
  speedColor,
  tpsStats,
} from './StatusMetrics.js'
import type { WaveBand } from '../dsh-adapter/types.js'

/**
 * The footer under the prompt input, in Claude Code's PromptInputFooter
 * layout: the segmented context progress bar on its own first line, the
 * status line below (left group: model · tokens · think level · cache · tps
 * gauge/sparkline; right group: git · cwd · title · short session id,
 * right-aligned), and the
 * mode/hint line last. The right side of the footer shows the latest
 * transient notification (errors in red, warnings in amber — CC style).
 *
 * Every metric field is hover-aware (fullscreen mouse): dwelling on a field
 * swaps the ctx readout for a mini pressure gauge and parks that field's
 * detailed breakdown on the supplemental row where the idle hint lives —
 * the footer stays one line tall, the detail is a peek, not a layout
 * change. Hovering a context-bar segment does the same for that segment.
 */

/** Footer fields that answer a hover with a supplemental-row detail.
 *  Context-bar segments arrive as `segment:<key>` (see ContextBarView). */
type HoverTarget =
  | 'ctx'
  | 'cache'
  | 'tps'
  | 'tokens'
  | 'cost'
  | 'goal'
  | 'jobs'
  | 'model'
  | 'git'
  | 'sessionId'
  | 'cwd'
  | 'title'
  | `segment:${string}`

/** One inline footer field: `node` renders inside a shrinkable, optionally
 *  hoverable Box; `key` doubles as the React key in its row. */
type FieldPart = {
  key: string
  node: React.ReactNode
  /** Present when the field shows a detail readout on hover. */
  id?: HoverTarget
  /** Present when the field's own text may be truncated: hovering pops a
   *  tooltip with the full string (e.g. the session title, cut mid-word
   *  when the right-aligned group runs out of columns). */
  tooltip?: string
}

/**
 * Render field parts as sibling shrinkable Boxes joined by the Byline
 * separator (` · `). The Box-per-field layout is what makes individual
 * fields hoverable — a Byline inside one Text cannot carry per-field mouse
 * rects — at the cost of truncating each field on its own under pressure
 * instead of truncating the joined string's tail.
 */
function FieldLine({
  parts,
  hoverProps,
}: {
  parts: readonly FieldPart[]
  hoverProps: (id: HoverTarget) => {
    onMouseEnter: () => void
    onMouseLeave: () => void
  }
}): React.ReactNode {
  const visible = parts.filter(
    part => part.node !== null && part.node !== undefined && part.node !== false,
  )
  return (
    <>
      {visible.map((part, index) => (
        <React.Fragment key={part.key}>
          {index > 0 ? <Text dimColor> · </Text> : null}
          <Box
            flexShrink={1}
            {...(part.id === undefined ? {} : hoverProps(part.id))}
          >
            {part.tooltip === undefined || part.tooltip === '' ? (
              <Text wrap="truncate">{part.node}</Text>
            ) : (
              <TooltipTarget content={part.tooltip}>
                <Text wrap="truncate">{part.node}</Text>
              </TooltipTarget>
            )}
          </Box>
        </React.Fragment>
      ))}
    </>
  )
}

export function StatusLine({
  channel,
  selectionActive = false,
  helpOpen = false,
  wake,
}: {
  channel: Channel
  selectionActive?: boolean
  helpOpen?: boolean
  /**
   * The session projected onto the status line's few columns, plus the
   * animation tick and the self-retiring key hint.
   *
   * A strip that shows the session's shape keeps earning its space in a way a
   * static label cannot, and it carries the failure signal in position rather
   * than as a count in the corner. Absent in headless embeds, where nothing
   * folds the event log.
   */
  wake?: { band: WaveBand; hint?: string; tick: number }
}) {
  const { columns } = useTerminalSize()
  const [themeName] = useTheme()
  const [hover, setHover] = React.useState<HoverTarget | null>(null)
  const hoverProps = React.useCallback((id: HoverTarget) => ({
    onMouseEnter: () => setHover(id),
    // Guarded leave: a late leave from a field the pointer already left must
    // not clobber the field it entered.
    onMouseLeave: () => setHover(current => (current === id ? null : current)),
  }), [])

  const statusBar: StatusBarConfig = channel.minimal
    // Minimal mode overrides every field switch: model + cwd only, so the
    // footer can never grow decorations regardless of saved preferences.
    ? { ...DEFAULT_STATUS_BAR, compact: true, model: true, cwd: true }
    : normalizeStatusBar(channel.statusBar)
  // Provider workspaces expose a remote display path alongside a host alias;
  // only the local target has identical cwd/displayCwd values to fold.
  const displayCwd = channel.displayCwd === channel.cwd
    ? formatProject(channel.displayCwd, homeDir())
    : channel.displayCwd
  const usage = channel.lastUsage
  const contextUsed = usage === undefined
    ? undefined
    : usage.input + usage.cacheRead + usage.cacheWrite
  const contextParts: FieldPart[] = []

  if (statusBar.thinking && channel.reasoningEffort !== undefined) {
    contextParts.push({
      key: 'effort',
      node: <Text color="inactiveShimmer">{channel.reasoningEffort}</Text>,
    })
  }
  const modeNeedsExplicitMarker = channel.mode.plan === true
    || channel.mode.sandbox === 'danger-full-access'
    || channel.mode.approval === 'never'
  if (statusBar.mode && (channel.modeIndex > 0 || modeNeedsExplicitMarker)) {
    contextParts.push({
      key: 'mode',
      node: (
        <Text
          color={channel.mode.plan === true ? 'planMode' : 'warning'}
        >
          {modeDisplayName(channel.mode)}
        </Text>
      ),
    })
  }

  const formattedContext = statusBar.contextUsage
    ? formatContextUsage(contextUsed, channel.contextWindow, statusBar.compact)
    : undefined
  // The ctx field's two faces: the idle readout, and the hover state — an
  // in-place pressure bar (the user-liked "text becomes a bar" morph).
  //
  // WIDTH-STABLE BY CONSTRUCTION: the idle variable part is
  // `P + " (" + C + ")"` (either order; P = percent text, C = counts) —
  // len(P)+len(C)+3 cells. The hover variant is `▕+bar+▏ + " " + P` —
  // 3+barLen+len(P) cells. Sizing barLen = len(C) makes them equal, so the
  // morph swaps glyphs in place and NO sibling field, separator, or the
  // right-aligned group moves a single cell (the first attempt used a fixed
  // 10-cell gauge and made the whole row jump).
  const ctxParts = (() => {
    if (formattedContext === undefined) return undefined
    const open = formattedContext.indexOf(' (')
    if (open < 0) return undefined
    const first = formattedContext.slice(0, open)
    const second = formattedContext.slice(open + 2, -1)
    if (first.endsWith('%')) return { percent: first, counts: second }
    if (second.endsWith('%')) return { percent: second, counts: first }
    return undefined
  })()
  const ctxHoverBarWidth = ctxParts?.counts.length ?? 0
  const ctxNode = formattedContext === undefined
    ? undefined
    : hover === 'ctx' &&
        ctxParts !== undefined &&
        ctxHoverBarWidth > 0 &&
        contextUsed !== undefined &&
        channel.contextWindow !== undefined
      ? (
        <Text color="inactiveShimmer">
          <Text dimColor>ctx </Text>
          {renderMiniContextBar(contextUsed, channel.contextWindow, ctxHoverBarWidth)}
          {' '}{ctxParts.percent}
        </Text>
      )
      : (
        <Text color="inactiveShimmer">
          <Text dimColor>ctx </Text>{formattedContext}
        </Text>
      )
  if (statusBar.cache) {
    const cacheRate = formatCacheHitRate(usage)
    if (cacheRate !== undefined) {
      contextParts.push({
        key: 'cache',
        id: 'cache',
        node: (
          <Text color="inactiveShimmer">
            <Text dimColor>{t('status-cache-label')}</Text>{cacheRate}
          </Text>
        ),
      })
    }
  }

  let tpsPart: FieldPart | undefined
  if (statusBar.tps && channel.tps !== undefined) {
    if (channel.working && channel.tpsSamples.length === 0) {
      tpsPart = {
        key: 'tps',
        id: 'tps',
        node: (
          <Text>
            {renderTpsGauge(channel.tps, channel.tps)}{' '}
            <Text dimColor>{Math.round(channel.tps)} tps</Text>
          </Text>
        ),
      }
    } else if (channel.tpsSamples.length > 0) {
      const peak = Math.max(...channel.tpsSamples.map(sample => sample.tps), channel.tps)
      tpsPart = {
        key: 'tps',
        id: 'tps',
        node: (
          <Text>
            {channel.working
              ? renderTpsGauge(channel.tps, peak)
              : renderTpsSparkline(channel.tpsSamples)}{' '}
            {speedColor(channel.tps, `${Math.round(channel.tps)}`)} tps
          </Text>
        ),
      }
    } else {
      tpsPart = {
        key: 'tps',
        id: 'tps',
        node: <Text dimColor>{Math.round(channel.tps)} t/s</Text>,
      }
    }
  }

const selectionBadge = formatSelectionBadge(channel.selection)
  // Background-job chip (ctx.jobs; /jobs): live count of running/stopping
  // jobs, shown only while non-zero — a silent zero is not information.
  // Not preference-gated: it is transient situational state like the goal
  // chip, not chrome. Hover lists the live jobs with elapsed times.
  // Marker is ●, NOT ⚙ (U+2699 is EA-ambiguous: ink measures 1 cell, CJK
  // terminal fonts paint 2 → the count overlaps the glyph).
  const liveJobs = (channel.backgroundJobs ?? NO_BACKGROUND_JOBS).filter(
    job => job.status === 'running' || job.status === 'stopping',
  )
  const jobsPart: FieldPart | undefined = liveJobs.length === 0
    ? undefined
    : {
        key: 'jobs',
        id: 'jobs',
        node: (
          <Text color="toolDotTask">
            {'● '}{liveJobs.length}
          </Text>
        ),
      }
  const leftFields: FieldPart[] = [
    ...(statusBar.model
      ? [{ key: 'model', id: 'model' as const, node: <Text color="inactiveShimmer">{channel.model}</Text> }]
      : []),
    ...(tpsPart !== undefined ? [tpsPart] : []),
    ...(jobsPart !== undefined ? [jobsPart] : []),
    ...contextParts,
    ...(statusBar.tokens
      ? [{
          key: 'tokens',
          id: 'tokens' as const,
          node: (
            <Text color="inactiveShimmer">
              {formatTokens(channel.tokens.input)}→{formatTokens(channel.tokens.output)}
            </Text>
          ),
        }]
      : []),
    // Estimated session spend (≈¥): only for official DeepSeek providers
    // whose model has a known price, and only once the estimate is non-zero
    // (a fresh session showing ¥0.00 is noise). The trailing 峰/谷 marker
    // shows the current billing window. Hover shows the breakdown.
    ...(statusBar.cost && isDeepSeekOfficialProvider(channel.provider)
      ? (() => {
        const estimate = estimateSessionCostCny(channel.tokens, channel.model)
        return estimate === undefined || estimate <= 0
          ? []
          : [{
              key: 'cost',
              id: 'cost' as const,
              node: (
                <Text color="inactiveShimmer">
                  {t('status-cost-label')}¥{estimate.toFixed(2)} {t(isPeakHour() ? 'cost-now-peak' : 'cost-now-idle')}
                </Text>
              ),
            }]
      })()
      : []),
  ]

  const rightFields: FieldPart[] = [
    // Live IDE-selection badge first: it tracks the user's in-editor gesture,
    // the freshest signal in the footer (T-FIX-02). Absent without an IDE —
    // no placeholder, matching the official Claude Code footer.
    ...(selectionBadge !== undefined
      ? [{
          key: 'ideSelection',
          node: (
            <Text color="ide" wrap="truncate">{selectionBadge}</Text>
          ),
        }]
      : []),
    // Goal chip first: session-level state outranks repo/location details.
    ...(statusBar.goal && channel.goal !== undefined
      ? [{
          key: 'goal',
          id: 'goal' as const,
          node: <GoalStatusChip goal={channel.goal} minimal={channel.minimal} />,
        }]
      : []),
    ...(statusBar.gitBranch && channel.gitBranch
      ? [
          {
            key: 'git',
            id: 'git' as const,
            node: <Text color="professionalBlue">{channel.gitBranch}</Text>,
          },
        ]
      : []),
    ...(statusBar.cwd
      ? [{
          key: 'cwd',
          id: 'cwd' as const,
          node: (
            <Text color="inactiveShimmer">
              {statusBar.compact ? basename(displayCwd) : displayCwd}
            </Text>
          ),
        }]
      : []),
    ...(statusBar.sessionTitle && channel.sessionTitle
      ? [{
          key: 'title',
          id: 'title' as const,
          // The title truncates mid-word when the right-aligned group
          // overflows; the tooltip carries the full string.
          tooltip: channel.sessionTitle,
          node: <Text dimColor>{channel.sessionTitle}</Text>,
        }]
      : []),
    // Short id last: a provenance tag trails the content it identifies, and
    // the 8-char form is what the session log filename starts with, so a
    // truncated rendering still names the right log for --resume.
    ...(statusBar.sessionId && channel.agentId
      ? [{
          key: 'sessionId',
          id: 'sessionId' as const,
          node: <Text dimColor>{`#${channel.agentId.slice(0, 8)}`}</Text>,
        }]
      : []),
  ]

  const hint = selectionActive
    ? t('statusline-hint-select')
    : channel.working
      ? t('statusline-hint-working')
      : statusBar.shortcutHint && !helpOpen
        ? t('statusline-hint-shortcuts')
        : ''
  const activity = channel.workingActivity
  const showActivity =
    statusBar.activity &&
    !channel.working &&
    activity !== undefined &&
    activity.line !== '' &&
    activity.phase !== 'idle'
  const showTrajectory = statusBar.trajectory && wake !== undefined

  const barWidth = columns - 4
  const barColors: { freeFill: Color; freeText: Color } | undefined =
    themeName === 'light'
      ? undefined
      : { freeFill: '#2E3440', freeText: '#8D95A6' }
  const barVisible =
    statusBar.contextBar &&
    channel.contextBarEnabled &&
    barWidth >= 14 &&
    usage !== undefined &&
    channel.contextWindow !== undefined

  // The supplemental-row readout for the hovered field: replaces the idle
  // hint (never the activity line) while the pointer dwells on a field.
  const detail = buildHoverDetail(hover, channel, usage, contextUsed)
  const trailer: React.ReactNode = detail !== null
    ? detail
    : hint !== ''
      ? <Text color="inactiveShimmer">{hint}</Text>
      : null

  const compactFields = [...leftFields, ...rightFields]
  const fullLeftFields = [
    ...leftFields,
    ...(ctxNode !== undefined ? [{ key: 'context', id: 'ctx' as const, node: ctxNode }] : []),
  ]
  const hasStatusFields = compactFields.length > 0 || ctxNode !== undefined
  // The supplemental row is PERMANENTLY mounted (height pinned to 1)
  // whenever the footer carries hoverable chrome — mounting it from nothing
  // on hover is what made the footer grow mid-gesture and shoved the
  // transcript up (user feedback). Idle it may sit blank: a stable footer
  // outranks a reclaimable row, and hovering only ever swaps this line's
  // content. Minimal mode keeps the old contract — no hover details, the
  // row appears only for real content (which its defaults never produce).
  const showSupplementalRow =
    (!channel.minimal && (hasStatusFields || barVisible)) ||
    showActivity ||
    showTrajectory ||
    hint !== ''

  return (
    // Width is pinned to the terminal rather than inherited: `width="100%"`
    // resolves against the *parent's* width, and the bottom chrome this sits
    // in is sized by cross-axis stretch, not by a definite value. Where that
    // resolution comes back indefinite the column falls to content width — the
    // context bar (a string sized from `columns`) still spans the terminal
    // while the two flex rows under it stop short, truncating the session
    // title mid-word and leaving the right-aligned wake stranded mid-line.
    // Taking the width from the same source the bar already uses makes the
    // three rows agree by construction. verify-trace-scene part D walks a
    // ladder of widths and asserts the wake reaches the right margin at each.
    <Box paddingX={1} width={columns} flexShrink={0}>
      <Box flexDirection="column" width="100%">
        {/* Row 1: segmented context bar, its own line, first (pi-nano-context
            placement — the bar sits directly under the transcript). Rendered
            as per-segment Boxes so each segment is hoverable; hovering one
            parks its token breakdown on the supplemental row. */}
        {barVisible ? (
          <ContextBarView
            segments={channel.contextSegments}
            usedTokens={contextUsed ?? 0}
            contextWindow={channel.contextWindow ?? 0}
            width={barWidth}
            colors={barColors}
            onHover={segment =>
              setHover(current =>
                segment === null
                  ? (current !== null && current.startsWith('segment:') ? null : current)
                  : `segment:${segment}`)}
          />
        ) : null}
        {/* Row 2: optional status fields — every field is independently gated. */}
        {hasStatusFields ? statusBar.compact ? (
          <Box flexDirection="row" justifyContent="space-between" gap={2}>
            <Box flexGrow={1} flexShrink={1} flexDirection="row" overflow="hidden">
              <FieldLine parts={compactFields} hoverProps={hoverProps} />
            </Box>
            {ctxNode !== undefined ? (
              <Box flexShrink={0} {...hoverProps('ctx')}>
                <Text wrap="truncate">{ctxNode}</Text>
              </Box>
            ) : null}
          </Box>
        ) : (
          <Box flexDirection="row" justifyContent="space-between" gap={2}>
            <Box flexGrow={1} flexShrink={1} flexDirection="row" overflow="hidden">
              <FieldLine parts={fullLeftFields} hoverProps={hoverProps} />
            </Box>
            <Box
              justifyContent="flex-end"
              flexShrink={2}
              flexDirection="row"
              overflow="hidden"
            >
              <FieldLine parts={rightFields} hoverProps={hoverProps} />
            </Box>
          </Box>
        ) : null}
        {/* Row 3: one stable hint/activity/detail area plus an optional
            wake. Permanently one line tall — hover swaps what it says,
            never whether it exists. */}
        {showSupplementalRow ? <Box
          height={1}
          overflow="hidden"
          flexDirection="row"
          justifyContent="space-between"
          gap={2}
        >
          <Box
            flexDirection="row"
            flexGrow={1}
            justifyContent={showActivity && trailer !== null ? 'space-between' : 'flex-start'}
            gap={2}
          >
            {showActivity && activity !== undefined ? (
              <ActivityLine
                activity={activity}
                activityFrames={channel.activityFrames}
                warnPct={contextPressurePct(usage, channel.contextWindow)}
                warnDanger={
                  (contextPressurePct(usage, channel.contextWindow) ?? 0) >= 95
                }
              />
            ) : trailer}
            {showActivity ? trailer : null}
          </Box>
          {showTrajectory && wake !== undefined ? (
            <MiniWake band={wake.band} hint={wake.hint} tick={wake.tick} />
          ) : null}
        </Box> : null}
      </Box>
    </Box>
  )
}

type UsageSnapshot = {
  input: number
  cacheRead: number
  cacheWrite: number
}

/**
 * The supplemental-row readout for a hovered footer field. Technical label
 * tokens (ctx, free, read, sys…) stay unlocalized like the footer fields
 * themselves; sentences go through t(). Returns null when nothing is
 * hovered (or the hover outlived its data, which the field gating makes
 * near-impossible).
 */
function buildHoverDetail(
  hover: HoverTarget | null,
  channel: Channel,
  usage: UsageSnapshot | undefined,
  contextUsed: number | undefined,
): React.ReactNode | null {
  if (hover === null) return null
  const window = channel.contextWindow
  const dim = (label: string): React.ReactNode => <Text dimColor>{label}</Text>

  if (hover.startsWith('segment:')) {
    if (window === undefined || window <= 0 || contextUsed === undefined) return null
    const key = hover.slice('segment:'.length)
    const free = Math.max(0, window - contextUsed)
    if (key === 'free') {
      return (
        <Text wrap="truncate">
          {dim('free ')}{formatTokens(free)} · {((free / window) * 100).toFixed(1)}% {t('status-detail-of-window')}
        </Text>
      )
    }
    const segment = USED_SEGMENTS.find(s => s.key === key)
    if (segment === undefined) return null
    const tokens = channel.contextSegments[segment.key]
    return (
      <Text wrap="truncate">
        {dim(`${segment.labels[1] ?? segment.key} `)}{formatTokens(tokens)} ·{' '}
        {((tokens / window) * 100).toFixed(1)}% {t('status-detail-of-window')}
      </Text>
    )
  }

  switch (hover) {
    case 'ctx': {
      if (contextUsed === undefined || window === undefined || window <= 0) return null
      const free = Math.max(0, window - contextUsed)
      // The hover payoff for the ctx ask: percent + counts + free, then the
      // segment breakdown as the truncate-able tail (no bar — the row's
      // in-place morph and the segment bar above already carry the gauge).
      const segments = USED_SEGMENTS.map(
        segment => `${segment.labels[1] ?? segment.key} ${formatTokens(channel.contextSegments[segment.key])}`,
      ).join(' · ')
      return (
        <Text wrap="truncate">
          {((contextUsed / window) * 100).toFixed(1)}% ·{' '}
          {formatTokens(contextUsed)}/{formatTokens(window)} · {dim('free ')}{formatTokens(free)}
          {' · '}{segments}
        </Text>
      )
    }
    case 'cache': {
      const rate = formatCacheHitRate(usage)
      if (usage === undefined || rate === undefined) return null
      return (
        <Text wrap="truncate">
          {dim('cache ')}{rate} · {dim('read ')}{formatTokens(usage.cacheRead)} ·{' '}
          {dim('write ')}{formatTokens(usage.cacheWrite)} · {dim('input ')}{formatTokens(usage.input)}
        </Text>
      )
    }
    case 'tps': {
      if (channel.tps === undefined) return null
      const stats = tpsStats(channel.tpsSamples, Date.now())
      return (
        <Text wrap="truncate">
          {dim('tps ')}{Math.round(channel.tps)} · {dim('avg60 ')}{stats.avg.toFixed(1)} ·{' '}
          {dim('mean ')}{stats.mean.toFixed(1)} · {dim('p95 ')}{stats.p95.toFixed(1)}
        </Text>
      )
    }
    case 'tokens': {
      const { input, output } = channel.tokens
      return (
        <Text wrap="truncate">
          {dim('in ')}{input.toLocaleString()} · {dim('out ')}{output.toLocaleString()} ·{' '}
          {dim('total ')}{(input + output).toLocaleString()}
        </Text>
      )
    }
    case 'cost': {
      const split = estimateSessionCostSplitCny(channel.tokens, channel.model)
      if (split === undefined) return null
      const { input, output, cacheRead } = channel.tokens
      return (
        <Text wrap="truncate">
          {dim('≈¥')}{split.total.toFixed(2)} · {dim('peak ')}¥{split.peak.toFixed(2)}
          {' · '}{dim('idle ')}¥{split.idle.toFixed(2)} · {dim('in ')}{formatTokens(input)}
          {' · '}{dim('out ')}{formatTokens(output)} · {dim('cache ')}{formatTokens(cacheRead)}
          {' · '}{t('status-cost-note')}
        </Text>
      )
    }
    case 'goal': {
      const goal = channel.goal
      if (goal === undefined) return null
      return (
        <Text wrap="truncate">
          {dim('goal ')}{goal.phase} · {dim('r')}{goal.roundsStarted}/{goal.maxGoalRounds} ·{' '}
          {goal.objective}
        </Text>
      )
    }
    case 'jobs': {
      const live = (channel.backgroundJobs ?? NO_BACKGROUND_JOBS).filter(
        job => job.status === 'running' || job.status === 'stopping',
      )
      if (live.length === 0) return null
      const shown = live.slice(0, 3)
      const rest = live.length - shown.length
      return (
        <Text wrap="truncate">
          {dim('jobs ')}
          {shown.map(job => `${job.id} ${job.label} (${formatJobDuration(job)})`).join(' · ')}
          {rest > 0 ? ` · +${rest}` : ''}
        </Text>
      )
    }
    case 'model': {
      return (
        <Text wrap="truncate">
          {dim('model ')}{channel.model} · {dim('provider ')}{channel.provider}
          {channel.contextWindow !== undefined
            ? <> · {dim('ctx ')}{formatTokens(channel.contextWindow)}</>
            : null}
        </Text>
      )
    }
    case 'git': {
      if (channel.gitBranch === undefined) return null
      return (
        <Text wrap="truncate">
          {dim('git ')}{channel.gitBranch}
        </Text>
      )
    }
    case 'sessionId':
      return (
        <Text wrap="truncate">
          {dim('# ')}{channel.agentId} · {t('status-detail-session-id')}
        </Text>
      )
    case 'cwd':
      return (
        <Text wrap="truncate">
          {dim('cwd ')}{channel.displayCwd}
        </Text>
      )
    case 'title':
      return (
        <Text wrap="truncate">
          {dim('title ')}{channel.sessionTitle}
        </Text>
      )
    default:
      return null
  }
}

/** Return the prompt-cache hit rate, or nothing when usage is unavailable. */
export function formatCacheHitRate(usage: UsageSnapshot | undefined): string | undefined {
  if (usage === undefined) return undefined
  const total = usage.input + usage.cacheRead + usage.cacheWrite
  if (!Number.isFinite(total) || total <= 0) return undefined
  return `${((usage.cacheRead / total) * 100).toFixed(1)}%`
}

/**
 * The prompt footer's live IDE-selection badge (T-FIX-02), mirroring Claude
 * Code's `⧉ N lines selected`: English only (like every other footer field),
 * singular/plural aware, line count from the snapshot's 0-based inclusive
 * range. `undefined` (no IDE yet / cleared by an isEmpty notification)
 * renders no field at all — a manually launched session never shows a
 * placeholder. Exported for scripts/verify-ide-channel.tsx.
 */
export function formatSelectionBadge(
  selection:
    | { startLine: number; endLine: number; isEmpty?: boolean }
    | undefined,
): string | undefined {
  if (selection === undefined || selection.isEmpty === true) return undefined
  const lines = selection.endLine - selection.startLine + 1
  return `⧉ ${lines} ${lines === 1 ? 'line' : 'lines'} selected`
}

function basename(path: string): string {
  const parts = path.split(/[\\/]/)
  return parts[parts.length - 1] ?? path
}
