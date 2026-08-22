/**
 * Chat header for the chat screen (plan §1.3, WP-03): the imperative port
 * of the React `LogoHeader`/`LogoV2` startup splash plus the collapsed
 * loaded-context summary line.
 *
 * Layout (ported from LogoV2): the 13-row pixel whale beside the text
 * column — `✦ dsh-TUI` wordmark with version, the DEEPSEEK/HARNESS block
 * font in the brand-blue → ice gradient, the model/effort and cwd lines,
 * the startup tip — and below the whale the welcome tagline, centered under
 * the art. Narrow terminals (< 64 columns) drop the whale and keep the
 * text column. Minimal mode is a chat-screen mounting decision, not this
 * component's.
 *
 * The whale easter egg: construction plays the ~3.4s OPENING_SEQUENCE once
 * (blink → water-spout bloom → tail wag), then the header settles static
 * with every sweep parked off-screen and the clock stopped. `setLogoNonce`
 * replays it (`/deepseek`). The pixel art is data from the React-free
 * `whaleFrames.ts`; the half-block renderer is copied here because the old
 * one lives in `Whale.tsx` behind the React import boundary.
 *
 * `loadedContext` renders as the collapsed summary line only (no Ctrl+P
 * expansion — the chat screen owns mounting and interaction). The header
 * stays mounted once transcript rows arrive: it is the transcript's top
 * block and scrolls away with the conversation, like the React LogoHeader.
 *
 * While the opening plays, one 60 ms unref'd interval drives the frame
 * chain and the shimmer sweeps; `dispose()` stops it. State arrives via
 * `update(HeaderProjection)` — no Channel, no store subscriptions.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import chalk from 'chalk'
import {
  truncateToWidth,
  visibleWidth,
  type Component,
  type TUI,
} from '../public.js'
import type { HeaderProjection } from '../view-model.js'
import { getLang, t } from '../../i18n.js'
import { pickRandomTip, type Tip } from '../../tips.js'
import { summarizeLoadedContext } from '../../utils/loaded-context.js'
import { getActiveTheme } from '../../theme.js'
import { renderBigText } from '../../components/bigfont.js'
import { BRAND, FLASH, ICE, PALE, sweep } from '../../components/shimmer.js'
import { parseRGB } from '../../components/Spinner/spinnerUtils.js'
import {
  OPENING_SEQUENCE,
  WHALE_FRAMES,
  type WhaleFrame,
} from '../../components/whaleFrames.js'

/**
 * Header badge version, read from the installed package.json so the display
 * never drifts from the published version. Falls back to a literal when the
 * package metadata is unreadable (unusual layouts).
 */
const VERSION = (() => {
  try {
    const pkgPath = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'package.json')
    return (JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: string }).version ?? '0.1.0'
  } catch {
    return '0.1.0'
  }
})()

/** Below this width the whale hides and the header goes text-only. */
const WHALE_MIN_COLUMNS = 64
/** Fixed whale box width: the tail-wag frames reach 4 columns further right
 *  than the standard pose; a pinned width keeps the text column from
 *  shifting sideways during the opening animation. */
const FULL_WHALE_WIDTH = 40
/** Center of the whale art's bounding box (sprite columns 3..34 of the
 *  40-wide box): the welcome tagline is centered on this column. */
const WHALE_CENTER = 18.5
/** Opening/sweep clock cadence. */
const FRAME_MS = 60

// --- Pixel-whale half-block renderer (copied from Whale.tsx; see header) ---

type Rgb = readonly [number, number, number]

/** Sprite palette: D outline · B body · L belly · W mouth · `.` transparent. */
const PALETTE: Record<string, Rgb | undefined> = {
  D: [20, 38, 96],
  B: [78, 111, 255],
  L: [190, 225, 255],
  W: [255, 255, 255],
}

const fg = (rgb: Rgb): string => `\x1b[38;2;${rgb[0]};${rgb[1]};${rgb[2]}m`
const bg = (rgb: Rgb): string => `\x1b[48;2;${rgb[0]};${rgb[1]};${rgb[2]}m`
const RESET = '\x1b[0m'

/**
 * Render a frame to 13 ANSI rows (one per sprite row pair): each terminal
 * cell packs two vertical pixels into one `▀`/`▄` glyph (foreground = upper
 * pixel, background = lower), so the whale shows at 40 columns × 13 rows
 * with visually square pixels. Trailing transparent cells are dropped and
 * every row closes its SGR so no style leaks into line padding.
 */
function renderWhaleRows(frame: WhaleFrame): string[] {
  const sprite = frame.rows
  const rows: string[] = []
  for (let r = 0; r < sprite.length; r += 2) {
    const upper = sprite[r]
    const lower = sprite[r + 1] ?? ''
    let out = ''
    let current = ''
    for (let x = 0; x < upper.length; x++) {
      const up = PALETTE[upper[x]]
      const lo = PALETTE[lower[x]]
      let seq: string
      let ch: string
      if (up !== undefined && lo !== undefined) {
        seq = fg(up) + bg(lo)
        ch = '▀'
      } else if (up !== undefined) {
        seq = fg(up)
        ch = '▀'
      } else if (lo !== undefined) {
        seq = fg(lo)
        ch = '▄'
      } else {
        seq = ''
        ch = ' '
      }
      if (seq !== current) {
        out += seq === '' ? RESET : seq
        current = seq
      }
      out += ch
    }
    let row = out.replace(/[ ]+$/, '')
    if (!row.endsWith(RESET)) row += RESET
    rows.push(row)
  }
  return rows
}

/** Pre-rendered ANSI rows for every frame, computed once at module load. */
const RENDERED: readonly string[][] = WHALE_FRAMES.map(renderWhaleRows)

/** Index of the `standard` frame — the settled header's static pose. */
const STANDARD_FRAME_INDEX = 0

/** Cumulative start times of the opening steps, plus the total duration. */
const OPENING_ENDS: readonly number[] = (() => {
  const ends: number[] = []
  let at = 0
  for (const step of OPENING_SEQUENCE) {
    at += step.ms
    ends.push(at)
  }
  return ends
})()
const OPENING_TOTAL_MS = OPENING_ENDS[OPENING_ENDS.length - 1] ?? 0

/** Opening frame index at `elapsed` ms into the sequence. */
function openingFrameAt(elapsed: number): number {
  for (let i = 0; i < OPENING_ENDS.length; i++) {
    if (elapsed < OPENING_ENDS[i]!) return OPENING_SEQUENCE[i]!.frame
  }
  return STANDARD_FRAME_INDEX
}

/** `max` → `Max` (effort levels arrive lower-case from the adapter). */
function capitalize(text: string): string {
  return text.length === 0 ? text : text[0].toUpperCase() + text.slice(1)
}

export class HeaderView implements Component {
  private vm: HeaderProjection
  private readonly ui: TUI
  private logoNonce = 0
  /** Elapsed ms into the opening; null once settled (clock stopped). */
  private openingElapsed: number | null = 0
  private animTimer: ReturnType<typeof setInterval> | null = null
  /** One random tip per mount — the settled header must not re-roll on
   *  every repaint (language switch, terminal resize), or the line flickers. */
  private readonly tip: Tip = pickRandomTip()

  constructor(ui: TUI, vm: HeaderProjection) {
    this.ui = ui
    this.vm = vm
    this.startClock()
  }

  /** Feed the latest header projection. */
  update(vm: HeaderProjection): void {
    this.vm = vm
    this.invalidate()
    this.ui.requestRender()
  }

  invalidate(): void {
    // No cached state — render() derives everything from the projection.
  }

  /** `/deepseek` easter egg: a new nonce replays the opening animation. */
  setLogoNonce(nonce: number): void {
    if (nonce === this.logoNonce) return
    this.logoNonce = nonce
    this.openingElapsed = 0
    this.startClock()
    this.ui.requestRender()
  }

  /** Stop the opening clock (idempotent; safe on the settled header). */
  dispose(): void {
    if (this.animTimer !== null) {
      clearInterval(this.animTimer)
      this.animTimer = null
    }
  }

  private startClock(): void {
    if (this.animTimer !== null || this.openingElapsed === null) return
    this.animTimer = setInterval(() => {
      if (this.openingElapsed === null) return
      this.openingElapsed += FRAME_MS
      if (this.openingElapsed >= OPENING_TOTAL_MS) {
        // Settle: standard pose, sweeps parked off-screen, zero timers.
        this.openingElapsed = null
        this.dispose()
      }
      this.ui.requestRender()
    }, FRAME_MS)
    this.animTimer.unref?.()
  }

  render(width: number): string[] {
    if (width <= 0) return []
    const vm = this.vm
    const theme = getActiveTheme()
    const dim = (text: string): string => chalk.dim(text)

    const wordmarkRGB = parseRGB(theme.claude) ?? BRAND
    const wordmarkShimmerRGB = parseRGB(theme.claudeShimmer) ?? ICE
    const taglineRGB = parseRGB(theme.claudeBlue_FOR_SYSTEM_SPINNER) ?? ICE

    // Frozen clock for the settled header: t=0 parks every sweep highlight
    // off-screen, leaving the static gradient behind.
    const time = this.openingElapsed ?? 0
    const frameIndex = this.openingElapsed === null
      ? STANDARD_FRAME_INDEX
      : openingFrameAt(this.openingElapsed)

    const showWhale = vm.whale && width >= WHALE_MIN_COLUMNS
    const contentWidth = width - (showWhale ? FULL_WHALE_WIDTH + 2 : 0)

    const textColumn: string[] = [
      `${sweep('✦ dsh-TUI', time, wordmarkRGB, wordmarkShimmerRGB, FRAME_MS)}${dim(`  v${VERSION}`)}`,
      ...renderBigText('DEEPSEEK', time, wordmarkRGB, taglineRGB, FLASH, FRAME_MS),
      ...renderBigText('HARNESS', time, taglineRGB, PALE, FLASH, FRAME_MS),
      `${vm.model}${vm.reasoningEffort === undefined ? '' : dim(` · ${capitalize(vm.reasoningEffort)} effort`)}`,
      dim(vm.displayCwd),
      `${dim(t('logo-tip-prefix'))}${getLang() === 'zh' ? this.tip.zh : this.tip.en}${dim(` · /tips ${t('logo-tip-more')}`)}`,
    ].map((line) => truncateToWidth(line, Math.max(1, contentWidth)))

    const rows: string[] = ['']
    if (showWhale) {
      const whaleRows = RENDERED[frameIndex] ?? RENDERED[STANDARD_FRAME_INDEX]!
      const blankWhale = ' '.repeat(FULL_WHALE_WIDTH)
      const rowCount = Math.max(whaleRows.length, textColumn.length)
      for (let i = 0; i < rowCount; i++) {
        const whaleRow = whaleRows[i] ?? blankWhale
        const whalePad = ' '.repeat(Math.max(0, FULL_WHALE_WIDTH - visibleWidth(whaleRow)))
        rows.push(`${whaleRow}${whalePad}  ${textColumn[i] ?? ''}`)
      }
    } else {
      rows.push(...textColumn)
    }

    // Welcome tagline below the whale, centered under the art.
    const tagline = t('logo-tagline')
    const welcomePad = showWhale
      ? Math.max(0, Math.round(WHALE_CENTER - visibleWidth(tagline) / 2))
      : 2
    rows.push('')
    rows.push(truncateToWidth(
      `${' '.repeat(welcomePad)}${sweep(tagline, time, taglineRGB, FLASH, FRAME_MS)}`,
      width,
    ))

    const contextRow = this.renderContextSummary(width, dim)
    if (contextRow !== undefined) {
      rows.push('')
      rows.push(contextRow)
    }

    rows.push('')
    return rows
  }

  /** The collapsed startup loaded-context summary (no expansion here — the
   *  chat screen owns mounting and the Ctrl+P interaction). */
  private renderContextSummary(
    width: number,
    dim: (text: string) => string,
  ): string | undefined {
    const context = this.vm.loadedContext
    if (context === undefined) return undefined
    const summary = summarizeLoadedContext(context)
    if (summary === '') return undefined
    return truncateToWidth(
      ` ▶ ${dim(`（Ctrl+P${t('context-panel-expand')}）`)} ${t('context-loaded')} · ${summary}`,
      width - 1,
    )
  }
}
