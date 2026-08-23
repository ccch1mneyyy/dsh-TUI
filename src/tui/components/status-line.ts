/**
 * Status footer for the chat screen (plan §1.3, WP-03): the imperative port
 * of the React `src/screens/StatusLine.tsx` footer.
 *
 * Rows (each independently gated by the `statusBar` config, minimal mode
 * first collapsing the config to its essential fields):
 * 1. the segmented context bar on its own line (`contextBar`),
 * 2. the fields row — left group: model · tps gauge/sparkline · effort ·
 *    mode · cache · tokens (+ contextUsage); right group: git · cwd ·
 *    session title · short session id — space-between, truncating to the row
 *    width,
 * 3. the idle working-activity summary (`activity`, only when no turn runs).
 *
 * The old footer's hint texts (`esc to interrupt`, `? for shortcuts`) moved:
 * the interrupt hint now rides the WorkingIndicator row and the shortcuts
 * hint is dropped (the keys keep working). The MiniWake trajectory strip is
 * out of scope here — it belongs to the trajectory migration.
 *
 * Pure render over `StatusLineProjection`: no store subscriptions and no
 * timers — the chat screen's tick calls `update()` + `requestRender()`.
 * Metric painters come from the React-free `src/screens/StatusMetrics.ts`.
 */
import chalk from 'chalk'
import {
  truncateToWidth,
  visibleWidth,
  type Component,
  type TUI,
} from '../public.js'
import type { StatusLineProjection } from '../view-model.js'
import { formatTokens } from '../../cc/format.js'
import { t } from '../../i18n.js'
import {
  DEFAULT_STATUS_BAR,
  formatContextUsage,
  normalizeStatusBar,
  type StatusBarConfig,
} from '../../tuiDisplayPrefs.js'
import { modeDisplayName } from '../../sessionModes.js'
import {
  renderContextBar,
  renderTpsGauge,
  renderTpsSparkline,
  speedColor,
} from '../../screens/StatusMetrics.js'
import { getActiveTheme, getTheme, type Theme } from '../../theme.js'
import { parseRGB } from '../../components/Spinner/spinnerUtils.js'
import { BRAND, FLASH, ICE, sweep } from '../../components/shimmer.js'
import { resolvePreset } from '../../components/activityFrames.js'
import { contextPressurePct } from './working-indicator.js'

type UsageSnapshot = StatusLineProjection['lastUsage']

/** Paint with a theme `rgb(r,g,b)` value; identity when unparsable. */
function themePainter(color: string | undefined): (text: string) => string {
  const rgb = color === undefined ? null : parseRGB(color)
  if (rgb === null) return (text) => text
  return (text) => chalk.rgb(rgb.r, rgb.g, rgb.b)(text)
}

/** True when the resolved palette renders on a light background (palette
 *  identity for the built-ins, ink luminance for custom themes — mirrors
 *  `isLightThemeActive`, which is keyed by name this layer never sees). */
function isLightPalette(theme: Theme): boolean {
  if (theme === getTheme('light')) return true
  if (theme === getTheme('dark') || theme === getTheme('dark-ansi')) return false
  const rgb = /^rgb\((\d+),(\d+),(\d+)\)$/.exec(theme.text)
  if (rgb === null) return false
  const [r, g, b] = [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])]
  return 0.299 * r + 0.587 * g + 0.114 * b < 140
}

/** Prompt-cache hit rate, or nothing when usage is unavailable
 *  (ported from StatusLine.tsx, which the React boundary makes unimportable). */
function formatCacheHitRate(usage: UsageSnapshot): string | undefined {
  if (usage === undefined) return undefined
  const total = usage.input + usage.cacheRead + usage.cacheWrite
  if (!Number.isFinite(total) || total <= 0) return undefined
  return `${((usage.cacheRead / total) * 100).toFixed(1)}%`
}

function basename(path: string): string {
  const parts = path.split(/[\\/]/)
  return parts[parts.length - 1] ?? path
}

/** Join parts with the dim middot separator (the Byline contract). */
function byline(parts: readonly string[], dim: (text: string) => string): string {
  return parts.filter((part) => part !== '').join(dim(' · '))
}

/**
 * Left/right space-between composition: when the pair overflows, the left
 * group truncates first; a right group that alone exceeds the width is
 * truncated on its own.
 */
function spaceBetween(left: string, right: string, width: number): string {
  if (width <= 0) return ''
  const leftWidth = visibleWidth(left)
  const rightWidth = visibleWidth(right)
  if (leftWidth + rightWidth + 2 <= width) {
    return left + ' '.repeat(width - leftWidth - rightWidth) + right
  }
  if (leftWidth === 0) return truncateToWidth(right, width)
  if (rightWidth === 0) return truncateToWidth(left, width)
  if (rightWidth + 2 <= width) {
    return truncateToWidth(left, width - rightWidth - 2) + '  ' + right
  }
  return truncateToWidth(right, width)
}

export class StatusLineView implements Component {
  private vm: StatusLineProjection
  private readonly ui: TUI

  constructor(ui: TUI, vm: StatusLineProjection) {
    this.ui = ui
    this.vm = vm
  }

  /** Feed the latest status-line projection (the chat tick drives refresh). */
  update(vm: StatusLineProjection): void {
    this.vm = vm
    this.invalidate()
    this.ui.requestRender()
  }

  invalidate(): void {
    // No cached state — render() derives everything from the projection.
  }

  render(width: number): string[] {
    if (width <= 0) return []
    const vm = this.vm
    const theme = getActiveTheme()
    const inactive = themePainter(theme.inactiveShimmer)
    const dim = (text: string): string => chalk.dim(text)

    // Minimal mode overrides every field switch (model + the DEFAULT set
    // only), so the footer can never grow decorations back.
    const statusBar: StatusBarConfig = vm.minimal
      ? { ...DEFAULT_STATUS_BAR, compact: true, model: true, cwd: true }
      : normalizeStatusBar(vm.statusBar)

    const usage = vm.lastUsage
    const contextUsed = usage === undefined
      ? undefined
      : usage.input + usage.cacheRead + usage.cacheWrite

    const rows: string[] = []
    const barRow = this.renderContextBarRow(statusBar, contextUsed, width, theme)
    if (barRow !== undefined) rows.push(barRow)

    const fieldsRow = this.renderFieldsRow(statusBar, contextUsed, width, { inactive, dim, theme })
    if (fieldsRow !== undefined) rows.push(fieldsRow)

    const activityRow = this.renderActivityRow(statusBar, width, { inactive, dim, theme })
    if (activityRow !== undefined) rows.push(activityRow)

    // One column of breathing room on the left (the old Box paddingX={1}).
    return rows.map((row) => ` ${row}`)
  }

  /** Row 1: the segmented context bar (pi-nano-context placement). */
  private renderContextBarRow(
    statusBar: StatusBarConfig,
    contextUsed: number | undefined,
    width: number,
    theme: Theme,
  ): string | undefined {
    const barWidth = width - 4
    if (
      !statusBar.contextBar
      || !this.vm.contextBarEnabled
      || barWidth < 14
      || this.vm.lastUsage === undefined
      || this.vm.contextWindow === undefined
    ) {
      return undefined
    }
    return renderContextBar(
      this.vm.contextSegments,
      contextUsed ?? 0,
      this.vm.contextWindow,
      barWidth,
      isLightPalette(theme) ? undefined : { freeFill: '#2E3440', freeText: '#8D95A6' },
    )
  }

  /** Row 2: the status fields, left vs right group space-between. */
  private renderFieldsRow(
    statusBar: StatusBarConfig,
    contextUsed: number | undefined,
    width: number,
    paint: { inactive: (text: string) => string; dim: (text: string) => string; theme: Theme },
  ): string | undefined {
    const vm = this.vm
    const { inactive, dim, theme } = paint
    const contentWidth = width - 2

    const tpsParts: string[] = []
    if (statusBar.tps && vm.tps !== undefined) {
      if (vm.working && vm.tpsSamples.length === 0) {
        tpsParts.push(`${renderTpsGauge(vm.tps, vm.tps)} ${dim(`${Math.round(vm.tps)} tps`)}`)
      } else if (vm.tpsSamples.length > 0) {
        const peak = Math.max(...vm.tpsSamples.map((sample) => sample.tps), vm.tps)
        tpsParts.push(
          `${vm.working ? renderTpsGauge(vm.tps, peak) : renderTpsSparkline(vm.tpsSamples)} ${speedColor(vm.tps, `${Math.round(vm.tps)}`)} tps`,
        )
      } else {
        tpsParts.push(dim(`${Math.round(vm.tps)} t/s`))
      }
    }

    const contextParts: string[] = []
    if (statusBar.thinking && vm.reasoningEffort !== undefined) {
      contextParts.push(inactive(vm.reasoningEffort))
    }
    if (statusBar.mode && vm.modeIndex > 0) {
      contextParts.push(themePainter(vm.mode.plan === true ? theme.planMode : theme.warning)(modeDisplayName(vm.mode)))
    }
    if (statusBar.cache) {
      const cacheRate = formatCacheHitRate(vm.lastUsage)
      if (cacheRate !== undefined) {
        contextParts.push(`${dim(t('status-cache-label'))}${inactive(cacheRate)}`)
      }
    }

    const leftParts = [
      ...(statusBar.model ? [inactive(vm.model)] : []),
      ...tpsParts,
      ...contextParts,
      ...(statusBar.tokens
        ? [inactive(`${formatTokens(vm.tokens.input)}→${formatTokens(vm.tokens.output)}`)]
        : []),
    ]

    const rightParts = [
      ...(statusBar.gitBranch && vm.gitBranch ? [themePainter(theme.professionalBlue)(vm.gitBranch)] : []),
      ...(statusBar.cwd ? [inactive(statusBar.compact ? basename(vm.displayCwd) : vm.displayCwd)] : []),
      ...(statusBar.sessionTitle && vm.sessionTitle ? [dim(vm.sessionTitle)] : []),
      // Short id last: a provenance tag trails the content it identifies, and
      // the 8-char form is what the session log filename starts with, so a
      // truncated rendering still names the right log for --resume.
      ...(statusBar.sessionId && vm.agentId ? [dim(`#${vm.agentId.slice(0, 8)}`)] : []),
    ]

    const formattedContext = statusBar.contextUsage
      ? formatContextUsage(contextUsed, vm.contextWindow, statusBar.compact)
      : undefined
    const contextUsagePart = formattedContext === undefined
      ? ''
      : `${dim('ctx ')}${inactive(formattedContext)}`

    // Compact: every field joins the left group, context usage sits right.
    // Full: context usage joins the left group, git/cwd/title sit right.
    const left = statusBar.compact
      ? byline([...leftParts, ...rightParts], dim)
      : byline([...leftParts, ...(contextUsagePart === '' ? [] : [contextUsagePart])], dim)
    const right = statusBar.compact ? contextUsagePart : byline(rightParts, dim)

    if (left === '' && right === '') return undefined
    return spaceBetween(left, right, contentWidth)
  }

  /** Row 3: the idle working-activity summary (the turn is over — static
   *  done line in brand mist blue, no animation). */
  private renderActivityRow(
    statusBar: StatusBarConfig,
    width: number,
    paint: { inactive: (text: string) => string; dim: (text: string) => string; theme: Theme },
  ): string | undefined {
    const activity = this.vm.workingActivity
    if (
      !statusBar.activity
      || this.vm.working
      || activity === undefined
      || activity.line === ''
      || activity.phase === 'idle'
    ) {
      return undefined
    }
    const { dim, theme } = paint
    const warnPct = contextPressurePct(this.vm.lastUsage, this.vm.contextWindow)
    const preset = resolvePreset(this.vm.activityFrames)
    const frame = preset.frames[Math.floor(Date.now() / preset.intervalMs) % preset.frames.length] ?? '·'
    const done = activity.phase === 'done'
    const color = themePainter(
      done || activity.phase === 'tool' ? theme.claude : theme.claudeBlue_FOR_SYSTEM_SPINNER,
    )
    const warn = warnPct !== undefined && warnPct >= 80
      ? themePainter(warnPct >= 95 ? theme.error : theme.warning)(`${t('activity-ctx-warn')}${warnPct}% · `)
      : ''
    const baseRGB = activity.phase === 'tool'
      ? (parseRGB(theme.claude) ?? BRAND)
      : (parseRGB(theme.claudeBlue_FOR_SYSTEM_SPINNER) ?? ICE)
    const line = done
      ? color(activity.line)
      : sweep(activity.line, Date.now(), baseRGB, FLASH, 60)
    return truncateToWidth(
      `${done ? '' : `${color(frame)} `}${warn}${line}`,
      width - 2,
    )
  }
}
