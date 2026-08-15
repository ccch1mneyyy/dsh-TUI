import React from 'react'
import { t as tr } from '../i18n.js'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Box, Text, useAnimationFrame, useTerminalSize } from '../ui.js'
import { getTheme } from '../theme.js'
import { useTheme } from './design-system/ThemeProvider.js'
import { parseRGB } from './Spinner/spinnerUtils.js'
import { renderBigText } from './bigfont.js'
import { BRAND, FLASH, ICE, PALE, sweep } from './shimmer.js'
import { STANDARD_FRAME_INDEX, WhaleArt } from './Whale.js'
import { OPENING_SEQUENCE } from './whaleFrames.js'

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

/**
 * Fixed whale box width: the tail-wag frames reach 4 columns further right
 * than the standard pose, and a pinned width keeps the text column from
 * shifting sideways during the opening animation.
 */
const FULL_WHALE_WIDTH = 40

/**
 * Leading spaces that center the welcome line under the drawn whale: the
 * art's bounding box spans sprite columns 3..34 (center 18.5) of the
 * 40-wide box, and the tagline measure 14
 * columns — 18.5 − 7 = 11.5 → 12. Centered on the full 40-column box
 * instead would need 13, which reads one column right of the whale body.
 */
const WELCOME_PAD = 12

/** `max` → `Max` (effort levels arrive lower-case from the adapter). */
function capitalize(text: string): string {
  return text.length === 0 ? text : text[0].toUpperCase() + text.slice(1)
}

/**
 * The header splash: one layout, two phases. The **opening** (~3.4s, once)
 * plays the hand-drawn whale animation (blink → water-spout bloom → tail
 * wag) and runs the shimmer sweeps; the **settled** header is the same
 * tree frozen at t=0 — whale on the standard pose, sweep highlights parked
 * off-screen, clock unsubscribed, zero timers.
 *
 * Layout: the 13-row pixel whale beside a text column of matching height —
 * the `✦ dsh-TUI` wordmark with version, the `DEEPSEEK`/`HARNESS` tagline in
 * the 5-row block font (brand-blue → ice gradient), the model/effort and
 * cwd in plain text (no brand-color highlight), the startup tip, and below
 * the whale the welcome tagline, centered under the art, in ice
 * blue. Narrow terminals drop the whale and keep the text column.
 */
export function LogoV2({
  model,
  effort,
  cwd,
  skipIntro = false,
}: {
  model: string
  effort?: string | undefined
  cwd: string
  /** Test seam: mount straight into the settled header (probes skip the intro). */
  skipIntro?: boolean
}): React.ReactNode {
  const [step, setStep] = React.useState(skipIntro ? OPENING_SEQUENCE.length : 0)
  const settled = step >= OPENING_SEQUENCE.length

  // Opening clock: drives the shimmer sweep and big-text highlight only
  // while the intro plays; `null` afterwards unsubscribes so the settled
  // header never repaints. 60ms frames keep the sweep lively.
  const [ref, time] = useAnimationFrame(settled ? null : 60)

  // Frame chain: dwell per OPENING_SEQUENCE entry, then settle for good.
  React.useEffect(() => {
    if (settled) return
    const timer = setTimeout(() => {
      setStep(s => s + 1)
    }, OPENING_SEQUENCE[step].ms)
    return () => {
      clearTimeout(timer)
    }
  }, [step, settled])

  const [themeName] = useTheme()
  const theme = getTheme(themeName)
  const { columns } = useTerminalSize()

  const wordmarkRGB = parseRGB(theme.claude) ?? BRAND
  const wordmarkShimmerRGB = parseRGB(theme.claudeShimmer) ?? ICE
  const taglineRGB = parseRGB(theme.claudeBlue_FOR_SYSTEM_SPINNER) ?? ICE

  const showWhale = columns >= WHALE_MIN_COLUMNS
  const frameIndex = settled ? STANDARD_FRAME_INDEX : OPENING_SEQUENCE[step].frame
  // Frozen clock for the settled header: t=0 parks every sweep highlight
  // off-screen, leaving the static gradient behind.
  const t = settled ? 0 : time

  const bigDeepSeek = renderBigText('DEEPSEEK', t, wordmarkRGB, taglineRGB, FLASH, 60)
  const bigHarness = renderBigText('HARNESS', t, taglineRGB, PALE, FLASH, 60)

  return (
    <Box ref={ref} flexDirection="column" marginTop={1}>
      <Box flexDirection="row" gap={2} width="100%" alignItems="center">
        {showWhale && <WhaleArt frameIndex={frameIndex} width={FULL_WHALE_WIDTH} />}
        <Box flexDirection="column" flexShrink={1}>
          <Text wrap="truncate-end">
            {sweep('✦ dsh-TUI', t, wordmarkRGB, wordmarkShimmerRGB, 60)}
            <Text dimColor>{'  v' + VERSION}</Text>
          </Text>
          {bigDeepSeek.map((row, index) => (
            <Text key={`ds-${index}`} wrap="truncate-end">
              {row}
            </Text>
          ))}
          {bigHarness.map((row, index) => (
            <Text key={`h-${index}`} wrap="truncate-end">
              {row}
            </Text>
          ))}
          <Text wrap="truncate-end">
            {model}
            {effort !== undefined && <Text dimColor>{' · ' + capitalize(effort) + ' effort'}</Text>}
          </Text>
          <Text dimColor wrap="truncate-end">
            {cwd}
          </Text>
          <Text wrap="truncate-end">
            <Text dimColor>Tip: </Text>
            /model
            <Text dimColor> {tr('logo-tip-model')} · </Text>
            /help
            <Text dimColor> {tr('logo-tip-help')} · </Text>
            Tab
            <Text dimColor> {tr('logo-tip-tab')}</Text>
          </Text>
        </Box>
      </Box>
      <Box marginTop={1} paddingLeft={showWhale ? WELCOME_PAD : 2}>
        <Text>{sweep(tr('logo-tagline'), t, taglineRGB, FLASH, 60)}</Text>
      </Box>
    </Box>
  )
}
