import React from 'react'
import { Box, Text, useTerminalSize, useTheme } from '../ui.js'
import type { Color } from '../ink/styles.js'
import { formatTokens } from '../terminal-utils/format.js'
import { t } from '../i18n.js'
import { formatContextUsage, DEFAULT_STATUS_BAR, normalizeStatusBar, type StatusBarConfig } from '../tuiDisplayPrefs.js'
import { estimateSessionCostSnapshotCny, isDeepSeekOfficialProvider, isPeakHour } from '../deepseekPricing.js'
import { getActiveBrand } from '../branding.js'
import { ActivityLine, contextPressurePct, type ActivityLineValue } from '../components/ActivityLine.js'
import { formatClock } from '../trajectory/format.js'
import { GoalStatusChip } from '../components/GoalTodoPanel.js'
import { formatGoalBudget } from '../channel/goal-command.js'
import { formatJobDuration, type BackgroundJobState } from '../dsh-adapter/jobs.js'

/** Stable fallback for stubbed channels: verify/repro harnesses render the
 *  real Chat with partial channel literals that predate the jobs field. */
const NO_BACKGROUND_JOBS: readonly BackgroundJobState[] = []
import type { ChannelUi as Channel } from '../adapter/channel/ui-policy.js'
/** 同上：partial channel 字面量可能早于 mainCost/subagentCost 字段（R4 兼容）。 */
/** A reported session cost: `$0.0123` for USD (sub-dollar keeps 4 places,
 *  a session often costs cents), `12.34 EUR` for any other currency. */
export function formatCostReport(report: { readonly currency: string; readonly amount: number }): string {
  const digits = report.amount < 1 ? 4 : 2
  return report.currency === 'USD'
    ? `$${report.amount.toFixed(digits)}`
    : `${report.amount.toFixed(digits)} ${report.currency}`
}

const NO_MAIN_COST: Channel['mainCost'] = {}
const NO_SUBAGENT_COST: Channel['subagentCost'] = []
import type { SelectionSnapshot } from '../dsh-adapter/ide-channel.js'
import { modeDisplayName } from '../sessionModes.js'
import { MiniWake } from '../components/trajectory/MiniWake.js'
import { getTheme, isLightThemeActive } from '../theme.js'
import { ContextBarView } from '../components/ContextBarView.js'
import { TooltipTarget } from '../components/Tooltip.js'
import { formatProject } from '../sessions/format.js'
import { homeDir } from '../utils/paths.js'
import {
  USED_SEGMENTS,
  channelContextOccupancy,
  contextBarBreakdown,
  contextBarSegmentColors,
  renderMiniContextBar,
  renderTpsGauge,
  renderTpsSparkline,
  speedColor,
  tpsStats,
} from './StatusMetrics.js'
import type { WaveBand } from '../dsh-adapter/types.js'
import type { ContextOccupancy } from '../adapter/ports/channel-view.js'

/**
 * The footer under the prompt input: the segmented context progress bar on
 * its own first line, the
 * status line below (left group: model · tokens · think level · cache · tps
 * gauge/sparkline; right group: git · cwd · title · short session id,
 * right-aligned), and the
 * mode/hint line last. The right side of the footer shows the latest
 * transient notification (errors in red, warnings in amber).
 *
 * Every metric field is hover-aware (fullscreen mouse): dwelling on a field
 * swaps the ctx readout for a mini pressure gauge and parks that field's
 * detailed breakdown on the supplemental row where the idle hint lives —
 * the footer stays one line tall, the detail is a peek, not a layout
 * change. The context bar answers the same way: it carries no labels of its
 * own, so hovering it is how its colors get their names and numbers.
 */

/**
 * The minimal UI's footer config. It ignores every SAVED preference (built from
 * scratch rather than `normalizeStatusBar(channel.statusBar)`) and pins the
 * DECORATION switches OFF — the shared defaults are free to change
 * (`contextBar` became default-on in 2026-09) and the minimal UI must not follow
 * them into the footer.
 *
 * The metric fields keep their `DEFAULT_STATUS_BAR` values on purpose: the
 * minimal UI has ALWAYS shown the default-on metrics (thinking / contextUsage /
 * cache / cost / goal) next to model + cwd — that predates the long-line fold
 * and the context-bar flip, and trimming them further is a product decision,
 * not a regression fix. Module scope: one frozen object, no per-render
 * allocation.
 */
const MINIMAL_UI_STATUS_BAR: StatusBarConfig = Object.freeze({
  ...DEFAULT_STATUS_BAR,
  compact: true,
  model: true,
  cwd: true,
  contextBar: false,
  activity: false,
  trajectory: false,
  shortcutHint: false,
})

/** Footer fields that answer a hover with a supplemental-row detail.
 *  The context bar reports the single `bar` target (see ContextBarView). */
type HoverTarget =
  | 'ctx'
  | 'mode'
  | 'effort'
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
  | 'bar'

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
  /** Click target (fullscreen mouse): the backend mode segment opens the
   *  /permission picker — the same route the launchpad param row takes. */
  onClick?: () => void
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
            {...(part.onClick === undefined ? {} : { onClick: part.onClick })}
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
  backendMode,
  modelPicker,
  effortPicker,
  wake,
  activity: projectedActivity,
}: {
  channel: Channel
  selectionActive?: boolean
  helpOpen?: boolean
  /** The backend's OWN permission mode (the typed `modes` capability):
   *  `id` is the backend mode id (default / acceptEdits / plan /
   *  bypassPermissions / dontAsk / auto …), `name` the label the backend
   *  gives it, `onOpen` opens the same /permission picker the command does.
   *  Present: the mode segment always shows — the base mode included, the
   *  user asked to SEE the current permission level — and both its colour
   *  and its text come from the backend, never from the DSH mode atoms.
   *  It also ignores the `statusBar.mode` field switch (see the gate
   *  below: a safety readout outranks a decoration preference); the minimal
   *  UI is the only thing it yields to. Absent (DSH, or a backend without
   *  modes): rendering stays byte-identical to the modeMarked rule below. */
  backendMode?: {
    readonly id: string
    readonly name: string
    readonly onOpen: () => void
  }
  /** The model segment's click target: the same /model picker the command
   *  opens. Present only when the backend serves a model catalog
   *  (backendCapabilities.models — DSH and the Claude backend both do);
   *  absent = the segment renders exactly as before, and its hover detail
   *  keeps the pure route readout without the click affordance line. */
  modelPicker?: {
    readonly onOpen: () => void
  }
  /** Same contract for the think-level segment and /effort: present only
   *  when the backend serves the effort capability. The hover id rides
   *  with it — the segment's whole detail line IS the affordance. */
  effortPicker?: {
    readonly onOpen: () => void
  }
  /** Activity value published by the working-activity plugin for this session.
   *  Preferred over the channel's own copy when the composition provides it. */
  activity?: ActivityLineValue
  /**
   * The session projected onto the status line's few columns, plus the
   * animation tick and the self-retiring key hint.
   *
   * A strip that shows the session's shape keeps earning its space in a way a
   * static label cannot, and it carries the failure signal in position rather
   * than as a count in the corner. Absent in headless embeds, where nothing
   * folds the event log.
   */
  wake?: {
    band: WaveBand
    hint?: string
    tick: number
    /** Click target for the strip: opens the trajectory scene. */
    onOpen?: () => void
    /** Chord revealed while the pointer rests on the strip. */
    hoverHint?: string
  }
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

  const statusBar: StatusBarConfig = channel.minimalUi
    // The minimal UI overrides every field switch: model + cwd only, so the
    // footer can never grow decorations regardless of saved preferences.
    ? MINIMAL_UI_STATUS_BAR
    : normalizeStatusBar(channel.statusBar)
  // Provider workspaces expose a remote display path alongside a host alias;
  // only the local target has identical cwd/displayCwd values to fold.
  const displayCwd = channel.displayCwd === channel.cwd
    ? formatProject(channel.displayCwd, homeDir())
    : channel.displayCwd
  const usage = channel.lastUsage
  // ONE occupancy reading behind every ctx surface in this footer (the field,
  // its hover gauge, the segmented bar, the working line's pressure prefix):
  // DSH's own `contextPressure` projection when the composition mounts the
  // token meter, else the last request's billed sample. `usage` above stays the
  // source for the cache/cost fields — "what the last request cost" and "how
  // full the window is now" are different questions.
  const occupancy = channelContextOccupancy(channel)
  const contextUsed = occupancy?.usedTokens
  const contextWindow = occupancy?.contextWindow
  const contextParts: FieldPart[] = []

  if (statusBar.thinking && channel.reasoningEffort !== undefined) {
    contextParts.push({
      key: 'effort',
      // The hover id rides only with the click target: the segment's whole
      // detail line IS the affordance (level + /effort), so promising it
      // without the picker behind it would be a lie.
      ...(effortPicker === undefined ? {} : { id: 'effort' as const, onClick: effortPicker.onOpen }),
      node: <Text color="inactiveShimmer">{channel.reasoningEffort}</Text>,
    })
  }
  const modeNeedsExplicitMarker = channel.mode.plan === true
    || channel.mode.sandbox === 'danger-full-access'
    || channel.mode.approval === 'never'
  const modeMarked = channel.modeIndex > 0 || modeNeedsExplicitMarker
  // Backend-native permission modes are a SAFETY readout (bypassPermissions
  // = every confirmation switched off), so the segment outranks the
  // `statusBar.mode` field switch: it shows whenever the backend reports a
  // mode, even at the default `mode: false`. The one thing it cannot outrank
  // is the minimal UI (`minimalUi === true` pins the footer to model + cwd —
  // the user's explicit choice must not be displaced). With no backend mode
  // (DSH) the rule stays byte-identical to before: `statusBar.mode` AND
  // modeMarked.
  if (backendMode === undefined
    ? statusBar.mode && modeMarked
    : channel.minimalUi !== true) {
    // Backend modes carry their own colour rule — the two destructive ids
    // warn, plan keeps its own colour, everything else (the unmarked base
    // mode included) renders muted; the DSH atoms never leak in. Without a
    // backend mode the DSH rule stands: warning colour for anything that
    // needs an explicit marker, plan keeps its own.
    const modeColour = backendMode === undefined
      ? channel.mode.plan === true
        ? 'planMode'
        : modeMarked ? 'warning' : 'inactiveShimmer'
      : backendMode.id === 'bypassPermissions' || backendMode.id === 'dontAsk'
        ? 'warning'
        : backendMode.id === 'plan' ? 'planMode' : 'inactiveShimmer'
    contextParts.push({
      key: 'mode',
      ...(backendMode === undefined ? {} : { id: 'mode' as const, onClick: backendMode.onOpen }),
      node: (
        <Text
          color={modeColour}
        >
          {backendMode === undefined ? modeDisplayName(channel.mode) : backendMode.name}
        </Text>
      ),
    })
  }

  const formattedContext = statusBar.contextUsage
    ? formatContextUsage(contextUsed, contextWindow, statusBar.compact)
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
        contextWindow !== undefined
      ? (
        <Text color="inactiveShimmer">
          <Text dimColor>ctx </Text>
          {renderMiniContextBar(contextUsed, contextWindow, ctxHoverBarWidth)}
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
  // The short id names the backend's own session, the id `--resume`
  // takes. A DSH session's id is its agent id; stub channels
  // without a session ref fall back to the agent id.
  const sessionShortId = channel.sessionRef?.sessionId ?? channel.agentId
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
      ? [{ key: 'model', id: 'model' as const, ...(modelPicker === undefined ? {} : { onClick: modelPicker.onOpen }), node: <Text color="inactiveShimmer">{channel.modelDisplay ?? channel.model}</Text> }]
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
    // Estimated session spend (≈¥): only for official DeepSeek providers.
    // Visible once there is a priced amount or at least one unpriced token (a
    // fresh, fully priced zero session keeps hiding ¥0.00 as noise; unpriced
    // usage still needs the 未计价 marker). The estimate merges the main
    // session (by model) with the subagents' own durable usage, so delegating
    // work no longer silently undercounts. The trailing 峰/谷 marker shows
    // the current billing window; the total>0 shape is unchanged. Hover shows
    // the breakdown.
    // A backend that reports its own session cost (Claude `total_cost_usd`)
    // wins over the local DeepSeek estimate: the reported figure is the bill.
    ...(statusBar.cost && channel.costReport !== undefined
      ? [{
          key: 'cost',
          id: 'cost' as const,
          node: (
            <Text color="inactiveShimmer">
              {channel.costReport.source === 'estimate' ? t('status-cost-label') : ''}{formatCostReport(channel.costReport)}
            </Text>
          ),
        }]
      : []),
    ...(statusBar.cost && channel.costReport === undefined && isDeepSeekOfficialProvider(channel.provider)
      ? (() => {
        const estimate = estimateSessionCostSnapshotCny({
          provider: channel.provider,
          main: channel.mainCost ?? NO_MAIN_COST,
          subagents: channel.subagentCost ?? NO_SUBAGENT_COST,
          fallbackTokens: channel.tokens,
          fallbackModel: channel.model,
        })
        return estimate !== undefined && (estimate.total > 0 || estimate.unpricedTokens > 0)
          ? [{
              key: 'cost',
              id: 'cost' as const,
              node: (
                <Text color="inactiveShimmer">
                  {t('status-cost-label')}
                  {estimate.total > 0
                    ? <>¥{estimate.total.toFixed(2)} {t(isPeakHour() ? 'cost-now-peak' : 'cost-now-idle')}</>
                    : <> {t('cost-unpriced', { tokens: formatTokens(estimate.unpricedTokens) })}</>}
                </Text>
              ),
            }]
          : []
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
          node: <GoalStatusChip goal={channel.goal} minimal={channel.minimalUi} />,
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
    ...(statusBar.sessionId && sessionShortId
      ? [{
          key: 'sessionId',
          id: 'sessionId' as const,
          node: <Text dimColor>{`#${sessionShortId.slice(0, 8)}`}</Text>,
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
  const activity = projectedActivity
  const showActivity =
    statusBar.activity &&
    !channel.working &&
    activity !== undefined &&
    activity.line !== '' &&
    activity.phase !== 'idle'
  const showTrajectory = statusBar.trajectory && wake !== undefined

  // The root Box below paints paddingX={1} inside width={columns}, so the
  // content area is `columns - 2` cells wide — size the bar from the same
  // arithmetic or its right edge falls 2 columns short of the status row's
  // (the v0.8.0 paddingX 2→1 tightening left the old `columns - 4` stale).
  const barWidth = columns - 2
  // 空段的深色兜底：deepseek 档冷灰、claude 档暖墨（品牌档见 branding.ts）。
  // 明暗问色板而不是比主题名：浅色主题不一定叫 `light`（用户/插件色板也可以是
  // 浅色），只有真彩/ANSI 的深色默认档才需要显式的 free 段色。
  const barColors: { freeFill: Color; freeText: Color } | undefined =
    isLightThemeActive(themeName)
      ? undefined
      : getActiveBrand() === 'claude'
        ? { freeFill: '#24221F', freeText: '#B8B2A8' }
        : { freeFill: '#2E3440', freeText: '#8D95A6' }
  const barVisible =
    statusBar.contextBar &&
    channel.contextBarEnabled &&
    barWidth >= 14 &&
    contextUsed !== undefined &&
    contextWindow !== undefined

  // The supplemental-row readout for the hovered field: replaces the idle
  // hint (never the activity line) while the pointer dwells on a field.
  const detail = buildHoverDetail(
    hover,
    channel,
    occupancy,
    usage,
    columns,
    barColors,
    backendMode,
    modelPicker,
    contextBarSegmentColors(getTheme(themeName)),
  )
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
  // content. The minimal UI keeps the old contract — no hover details, the
  // row appears only for real content (which its defaults never produce).
  const showSupplementalRow =
    (!channel.minimalUi && (hasStatusFields || barVisible)) ||
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
            as per-segment Boxes so the fill can react to the pointer; the bar
            carries no labels — hovering it parks the breakdown of every
            content type on the supplemental row. */}
        {barVisible ? (
          <ContextBarView
            segments={channel.contextSegments}
            usedTokens={contextUsed ?? 0}
            contextWindow={contextWindow ?? 0}
            width={barWidth}
            colors={barColors}
            onHover={hovered =>
              setHover(current =>
                hovered ? 'bar' : current === 'bar' ? null : current)}
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
                warnPct={contextPressurePct(occupancy)}
                warnDanger={
                  (contextPressurePct(occupancy) ?? 0) >= 95
                }
              />
            ) : trailer}
            {showActivity ? trailer : null}
          </Box>
          {showTrajectory && wake !== undefined ? (
            <MiniWake band={wake.band} hint={wake.hint} tick={wake.tick} onOpen={wake.onOpen} hoverHint={wake.hoverHint} />
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
  /** Sampling wall-clock (the producing message's event time). */
  at: number
}

/**
 * The supplemental-row readout for a hovered footer field. Technical label
 * tokens (ctx, free, read, sys…) stay unlocalized like the footer fields
 * themselves; sentences go through t(). Returns null when nothing is
 * hovered (or the hover outlived its data, which the field gating makes
 * near-impossible).
 */
/** `5h 68% · 7d 87%` for the subscription windows a backend reported. */
function formatRateLimit(rateLimit: Channel['rateLimit']): string | undefined {
  const windows = rateLimit?.windows ?? []
  if (windows.length === 0) return undefined
  const label = (name: string): string => name === 'five_hour'
    ? t('status-rate-limit-five-hour')
    : name === 'seven_day' ? t('status-rate-limit-seven-day') : name
  return windows.map(window => `${label(window.name)} ${Math.round(window.utilization * 100)}%`).join(' · ')
}

function buildHoverDetail(
  hover: HoverTarget | null,
  channel: Channel,
  occupancy: ContextOccupancy | undefined,
  usage: UsageSnapshot | undefined,
  columns: number,
  barColors: { freeFill: Color; freeText: Color } | undefined,
  backendMode: { readonly name: string } | undefined,
  modelPicker: { readonly onOpen: () => void } | undefined,
  usedColors: readonly Color[],
): React.ReactNode | null {
  if (hover === null) return null
  const contextUsed = occupancy?.usedTokens
  // The hover surfaces report the SAME occupancy the field/bar above show; the
  // 'model' chip below stays a pure route-capacity readout.
  const window = occupancy?.contextWindow
  const dim = (label: string): React.ReactNode => <Text dimColor>{label}</Text>

  if (hover === 'bar') {
    if (window === undefined || window <= 0 || contextUsed === undefined) return null
    // The bar's text-free design pays off here: this line is its legend, so
    // every entry leads with a chip of the very color it names.
    const { entries, separator } = contextBarBreakdown(
      channel.contextSegments,
      contextUsed,
      window,
      columns,
      { used: usedColors, freeFill: barColors?.freeFill },
    )
    if (entries.length === 0) return null
    return (
      <Text wrap="truncate">
        {entries.map((entry, index) => (
          <React.Fragment key={entry.key}>
            {index > 0 ? dim(separator) : null}
            <Text backgroundColor={entry.color}> </Text>
            {entry.label}
          </React.Fragment>
        ))}
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
    case 'mode': {
      // Only the mode segment carries the hover id (its click target); the
      // detail names the field and the affordance at the moment of asking.
      // A backend-owned mode names itself (the DSH spec would only ever show
      // the DSH cycle's own label here).
      return (
        <Text wrap="truncate">
          {dim('mode ')}{backendMode?.name ?? modeDisplayName(channel.mode)} · {t('status-detail-mode')}
        </Text>
      )
    }
    case 'effort': {
      // The think-level segment's whole detail line IS the affordance (the
      // hover id rides with the click target — see the field above), so the
      // case is unreachable without the picker behind it.
      return (
        <Text wrap="truncate">
          {dim('effort ')}{channel.reasoningEffort} · {t('status-detail-effort')}
        </Text>
      )
    }
    case 'cache': {
      const rate = formatCacheHitRate(usage)
      if (usage === undefined || rate === undefined) return null
      // The cache split is optional on the wire (`cacheReadTokens?` /
      // `cacheWriteTokens?`), and a route that never writes the prompt cache
      // reports a zero or omits the field — every DeepSeek route does one or
      // the other. A zero component says nothing the rate does not, and
      // rendering the absence as `0` asserts a number no provider sent.
      return (
        <Text wrap="truncate">
          {dim('cache ')}{rate}
          {usage.cacheRead > 0
            ? <>{' · '}{dim('read ')}{formatTokens(usage.cacheRead)}</>
            : null}
          {usage.cacheWrite > 0
            ? <>{' · '}{dim('write ')}{formatTokens(usage.cacheWrite)}</>
            : null}
          {' · '}{dim('input ')}{formatTokens(usage.input)}
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
      const { input, output, cacheRead, cacheWrite } = channel.tokens
      // The hover answers "what moved" in one place — session
      // totals with the cache split (uncached in/out stay separate from
      // cache movement; zeros render nothing rather than a fabricated 0),
      // the window the totals sit in, WHEN the last request was sampled,
      // and the last COMPLETED turn's mini summary (kept after the turn
      // ends — per-turn and cumulative never blend into one number).
      const last = channel.turnUsage
      return (
        <Text wrap="truncate">
          {dim('in ')}{formatTokens(input)} · {dim('out ')}{formatTokens(output)}
          {cacheRead > 0 ? <>{' · '}{dim('cache read ')}{formatTokens(cacheRead)}</> : null}
          {cacheWrite > 0 ? <>{' · '}{dim('cache write ')}{formatTokens(cacheWrite)}</> : null}
          {' · '}{dim('total ')}{formatTokens(input + output + cacheRead + cacheWrite)}
          {window !== undefined && window > 0 ? <>{' · '}{dim('ctx ')}{formatTokens(window)}</> : null}
          {usage !== undefined
            ? <>{' · '}{t('usage-sampled-at', { time: formatClock(usage.at) })}</>
            : null}
          {last !== undefined
            ? <>{' · '}{t('usage-last-turn')} ↑{formatTokens(last.input)} ↓{formatTokens(last.output)}
              {last.cacheKnown && last.cacheRead + last.cacheWrite > 0
                ? <> {t('usage-cache-segment', { parts: `${formatTokens(last.cacheRead)}/${formatTokens(last.cacheWrite)}` })}</>
                : null}
              {last.retries > 0 ? <> · {t('usage-retry-segment', { n: last.retries })}</> : null}
            </>
            : null}
        </Text>
      )
    }
    case 'cost': {
      const report = channel.costReport
      if (report !== undefined) {
        const { input, output, cacheRead } = channel.tokens
        // Subscription windows the backend reported ride along: the bill and
        // the plan's remaining room answer the same "what did this cost" glance.
        const usage = formatRateLimit(channel.rateLimit)
        return (
          <Text wrap="truncate">
            {formatCostReport(report)} · {dim('in ')}{formatTokens(input)}
            {' · '}{dim('out ')}{formatTokens(output)} · {dim('cache ')}{formatTokens(cacheRead)}
            {' · '}{t(report.source === 'backend' ? 'cost-source-backend' : 'status-cost-note')}
            {usage === undefined ? null : <>{' · '}{t('status-rate-limit', { usage })}</>}
          </Text>
        )
      }
      const estimate = estimateSessionCostSnapshotCny({
        provider: channel.provider,
        main: channel.mainCost ?? NO_MAIN_COST,
        subagents: channel.subagentCost ?? NO_SUBAGENT_COST,
        fallbackTokens: channel.tokens,
        fallbackModel: channel.model,
      })
      // Same visibility contract as the field: a priced amount or unpriced
      // tokens (with the 未计价 row) both warrant the breakdown; the old
      // total>0 gate hid the only explanation for an all-unpriced session.
      if (estimate === undefined || (estimate.total <= 0 && estimate.unpricedTokens <= 0)) return null
      const { input, output, cacheRead } = channel.tokens
      return (
        <Text wrap="truncate">
          {dim('≈¥')}{estimate.total.toFixed(2)} · {dim('peak ')}¥{estimate.peak.toFixed(2)}
          {' · '}{dim('idle ')}¥{estimate.idle.toFixed(2)} · {dim('in ')}{formatTokens(input)}
          {' · '}{dim('out ')}{formatTokens(output)} · {dim('cache ')}{formatTokens(cacheRead)}
          {' · '}{t('cost-split-main', { cost: estimate.main.toFixed(2) })}
          {' · '}{t('cost-split-subagent', { cost: estimate.subagent.toFixed(2) })}
          {estimate.unpricedTokens > 0
            ? <>{' · '}{t('cost-unpriced', { tokens: formatTokens(estimate.unpricedTokens) })}</>
            : null}
          {' · '}{t('status-cost-note')}
        </Text>
      )
    }
    case 'goal': {
      const goal = channel.goal
      if (goal === undefined) return null
      // A budgeted goal (a backend that measures tokens/time) reads its
      // spend instead of the rounds.
      return goal.budget === undefined ? (
        <Text wrap="truncate">
          {dim('goal ')}{goal.phase} · {dim('r')}{goal.roundsStarted}/{goal.maxGoalRounds} ·{' '}
          {goal.objective}
        </Text>
      ) : (
        <Text wrap="truncate">
          {dim('goal ')}{goal.phase} · {formatGoalBudget(goal.budget)} ·{' '}
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
      // When a display name masks the raw id (modelDisplay maps a
      // friendly/alias name), the hover shows BOTH — the requested alias the
      // user picked and the raw id the route runs. Identical strings render
      // once; nothing is invented when no mapping is known.
      return (
        <Text wrap="truncate">
          {dim('model ')}{channel.modelDisplay ?? channel.model}
          {channel.modelDisplay !== undefined && channel.modelDisplay !== channel.model
            ? <>{' ('}{channel.model}{')'}</>
            : null}
          {' · '}{dim('provider ')}{channel.provider}
          {channel.contextWindow !== undefined
            ? <> · {dim('ctx ')}{formatTokens(channel.contextWindow)}</>
            : null}
          {modelPicker !== undefined
            ? <> · {t('status-detail-model')}</>
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
          {dim('# ')}{channel.sessionRef?.sessionId ?? channel.agentId} · {t('status-detail-session-id')}
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
