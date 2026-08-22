/**
 * Working indicator for the chat screen (plan §1.3, WP-03): the imperative
 * merge of the old React `WorkingSpinner` and `ActivityLine`.
 *
 * Rendering contract over `SpinnerProjection`:
 * - `working === false` → zero rows (the component disappears).
 * - activity branch (`activityEnabled && !minimal && workingActivity` live):
 *   the plugin's self-narration line with its frame-preset animation and the
 *   token suffix — replacing the random-verb spinner while real activity
 *   data streams.
 * - fallback branch (`minimal`, `activity: false`, or no activity data
 *   yet): the classic single-line spinner — animation frame, a per-turn
 *   random verb, elapsed time and the token estimate.
 *
 * Both lines end with the `esc to interrupt` hint (ported from the old
 * status line's working hint; the status footer no longer carries it).
 *
 * The component owns one 120 ms unref'd interval that advances the
 * animation clock and requests a render ONLY while working; `dispose()`
 * stops it. State arrives via `update(SpinnerProjection)` — the component
 * never touches the Channel, timers from business code, or stdio.
 */
import chalk from 'chalk'
import {
  truncateToWidth,
  visibleWidth,
  type Component,
  type TUI,
} from '../public.js'
import type { SpinnerProjection } from '../view-model.js'
import { formatDuration, formatTokens } from '../../cc/format.js'
import { t } from '../../i18n.js'
import { getActiveTheme } from '../../theme.js'
import { SPINNER_VERBS } from '../../cc/spinnerVerbs.js'
import { resolvePreset } from '../../components/activityFrames.js'
import { BRAND, FLASH, ICE, sweep } from '../../components/shimmer.js'
import { getDefaultCharacters, parseRGB, type RGBColor } from '../../components/Spinner/spinnerUtils.js'

/** Spinner glyph cycle: the platform frame set forward then back (CC style). */
const SPINNER_FRAMES = [...getDefaultCharacters(), ...[...getDefaultCharacters()].reverse()]

/** Animation tick; the frame preset divides it by its own interval. */
const TICK_MS = 120

type UsageSnapshot = SpinnerProjection['lastUsage']

/**
 * Context-pressure percentage (0–100) from the last usage snapshot, or
 * undefined when unknown — shared with the status line's idle activity row
 * (ported from the React `ActivityLine.tsx`; pi working-activity style:
 * amber ≥ 80%, red ≥ 95%).
 */
export function contextPressurePct(
  usage: UsageSnapshot,
  contextWindow: number | undefined,
): number | undefined {
  if (usage === undefined || contextWindow === undefined || contextWindow <= 0) {
    return undefined
  }
  const occupied = usage.input + usage.cacheRead + usage.cacheWrite
  return Math.round((occupied / contextWindow) * 100)
}

/** The most recent request's real upload (input + cache read/write occupy
 *  the wire exactly like the context window); 0 until the first usage event. */
function uploadTokens(usage: UsageSnapshot): number {
  return usage === undefined ? 0 : usage.input + usage.cacheRead + usage.cacheWrite
}

/** Paint with a theme `rgb(r,g,b)` value; identity when unparsable. */
function themePainter(color: string | undefined): (text: string) => string {
  const rgb = color === undefined ? null : parseRGB(color)
  if (rgb === null) return (text) => text
  return (text) => chalk.rgb(rgb.r, rgb.g, rgb.b)(text)
}

function pickVerb(): string {
  return SPINNER_VERBS[Math.floor(Math.random() * SPINNER_VERBS.length)] ?? 'Working'
}

export class WorkingIndicator implements Component {
  private vm: SpinnerProjection
  private readonly ui: TUI
  private elapsedMs = 0
  private verb = pickVerb()
  private readonly timer: ReturnType<typeof setInterval>

  constructor(ui: TUI, vm: SpinnerProjection) {
    this.ui = ui
    this.vm = vm
    this.timer = setInterval(() => {
      this.elapsedMs += TICK_MS
      // The idle component renders zero rows — repainting then is pure churn.
      if (this.vm.working) {
        this.invalidate()
        this.ui.requestRender()
      }
    }, TICK_MS)
    this.timer.unref?.()
  }

  /** Feed the latest spinner projection; a fresh turn re-rolls the verb. */
  update(vm: SpinnerProjection): void {
    if (vm.working && !this.vm.working) {
      this.verb = pickVerb()
      this.elapsedMs = 0
    }
    this.vm = vm
    this.invalidate()
    this.ui.requestRender()
  }

  invalidate(): void {
    // No cached state — render() derives everything from the projection.
  }

  /** Stop the animation clock. */
  dispose(): void {
    clearInterval(this.timer)
  }

  render(width: number): string[] {
    if (width <= 0 || !this.vm.working) return []
    const line = this.vm.activityEnabled && !this.vm.minimal && this.hasLiveActivity()
      ? this.renderActivityLine()
      : this.renderSpinnerLine(width)
    // The blank row above mirrors the old components' marginTop.
    return ['', truncateToWidth(line, width)]
  }

  private hasLiveActivity(): boolean {
    const activity = this.vm.workingActivity
    return activity !== undefined && activity.line !== '' && activity.phase !== 'idle'
  }

  /**
   * The working-activity line: preset frame + shimmer-swept narration +
   * token suffix. Done summaries render statically in brand blue.
   */
  private renderActivityLine(): string {
    const activity = this.vm.workingActivity
    if (activity === undefined) return ''
    const theme = getActiveTheme()
    const preset = resolvePreset(this.vm.activityFrames)
    const frame = preset.frames[Math.floor(this.elapsedMs / preset.intervalMs) % preset.frames.length] ?? '·'
    const done = activity.phase === 'done'
    const frameColor = themePainter(
      done || activity.phase === 'tool' ? theme.claude : theme.claudeBlue_FOR_SYSTEM_SPINNER,
    )
    const baseRGB: RGBColor = activity.phase === 'tool'
      ? (parseRGB(theme.claude) ?? BRAND)
      : (parseRGB(theme.claudeBlue_FOR_SYSTEM_SPINNER) ?? ICE)
    const text = done
      ? frameColor(activity.line)
      : sweep(activity.line, this.elapsedMs, baseRGB, FLASH, 60)
    return (done ? '' : `${frameColor(frame)} `) + text + chalk.dim(this.suffix())
  }

  /**
   * The classic spinner: frame + verb + a dim status parenthetical. Parts
   * join with ` · ` and are added in priority order (thinking, elapsed,
   * tokens, esc hint) until the width runs out.
   */
  private renderSpinnerLine(width: number): string {
    const theme = getActiveTheme()
    const frame = SPINNER_FRAMES[Math.floor(this.elapsedMs / TICK_MS) % SPINNER_FRAMES.length] ?? '·'
    const verbColor = themePainter(theme.claude)
    const head = `${verbColor(frame)} ${verbColor(`${this.verb}…`)}`

    const parts: string[] = []
    if (this.vm.spinnerMode === 'thinking') parts.push('thinking')
    const elapsed = this.vm.turnStart > 0 ? Date.now() - this.vm.turnStart : 0
    parts.push(formatDuration(elapsed))
    const tokens = this.tokensLabel()
    if (tokens !== '') parts.push(tokens)
    parts.push(t('statusline-hint-working'))

    let line = head
    let status = ''
    for (const part of parts) {
      const next = status === '' ? part : `${status} · ${part}`
      // +4: the ' (' and ')' around the status plus one column of slack.
      if (visibleWidth(head) + visibleWidth(next) + 4 > width) break
      status = next
    }
    if (status !== '') line += chalk.dim(` (${status})`)
    return line
  }

  /** Token readout: real upload tokens beside the chars/4 download estimate. */
  private tokensLabel(): string {
    const upload = uploadTokens(this.vm.lastUsage)
    const download = formatTokens(Math.round(this.vm.responseChars / 4))
    if (upload <= 0 && this.vm.responseChars <= 0) return ''
    const uploadPart = upload > 0 ? `↑ ${formatTokens(upload)} · ` : ''
    return `${uploadPart}↓ ${download} tokens`
  }

  private suffix(): string {
    const tokens = this.tokensLabel()
    const hint = t('statusline-hint-working')
    return tokens === '' ? ` · ${hint}` : ` · ${tokens} · ${hint}`
  }
}
