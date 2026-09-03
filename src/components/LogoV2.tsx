import React from 'react'
import { getLang, t as tr, tOr } from '../i18n.js'
import { pickRandomTip, type Tip } from '../tips.js'
import { upstreamDriftSummary, UPSTREAM_VALIDATED_VERSION, type UpstreamDriftSummary } from '../dsh-adapter/contract.js'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Box, Text, useAnimationFrame, useTerminalSize } from '../ui.js'
import { getTheme } from '../theme.js'
import { useTheme } from './design-system/ThemeProvider.js'
import { parseRGB } from './Spinner/spinnerUtils.js'
import { renderBigText } from './bigfont.js'
import { stringWidth } from '../ink/stringWidth.js'
import { BRAND, FLASH, ICE, PALE, sweep } from './shimmer.js'
import { STANDARD_FRAME_INDEX, WhaleArt } from './Whale.js'
import { OPENING_SEQUENCES, pickOpeningSequence, type OpeningStep, type WhaleIntroId } from './whaleFrames.js'
import {
  HEART_HOLD_MS,
  HEART_PASS,
  initialWhaleIdleState,
  nextWhaleIdleStep,
  type WhaleIdleState,
} from './whaleIdle.js'

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
 * Center of the whale art's bounding box: sprite columns 3..34 (center
 * 18.5) of the 40-wide box. The welcome tagline is indented so its own
 * center lands on this column — for the 14-column Chinese tagline that is
 * 18.5 − 7 = 11.5 → 12 leading spaces. (Centering on the full 40-column
 * box would need 13, which reads one column right of the whale body.)
 * The pad is recomputed from the rendered tagline's display width so
 * longer locales — e.g. the 21-column English tagline → 8 — stay
 * centered under the art too.
 */
const WHALE_CENTER = 18.5

/** `max` → `Max` (effort levels arrive lower-case from the adapter). */
function capitalize(text: string): string {
  return text.length === 0 ? text : text[0].toUpperCase() + text.slice(1)
}

/**
 * The header splash: one layout, two phases. The **opening** (~1.7–3.5s,
 * once) plays one of three whale intros — the classic blink + spout +
 * tail-wag combo, the heart pass, or the sleep-Z float — rolled on every
 * mount (see `pickOpeningSequence`): randomly at startup, and again
 * randomly on each `/deepseek` easter-egg replay — and runs the shimmer
 * sweeps; the **settled** header is the same tree frozen at t=0 — whale
 * on the standard pose, sweep highlights parked off-screen, clock
 * unsubscribed, zero timers.
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
  intro,
  tip,
  whale = true,
  whaleIdle = false,
  working = false,
  drift,
}: {
  model: string
  effort?: string | undefined
  cwd: string
  /** Test seam: mount straight into the settled header (probes skip the intro). */
  skipIntro?: boolean
  /** Test seam: pin the intro animation instead of rolling one at startup. */
  intro?: WhaleIntroId
  /** Test seam: pin the startup tip line (probes need a deterministic tip). */
  tip?: Tip
  /** Show the pixel whale art (settings `dsh-tui.whale`); off → text-only header. */
  whale?: boolean
  /** Idle whale behaviors — fin flutters, tail thumps, sleep after
   * inactivity (settings `dsh-tui.whaleIdle`; off by default: the settled
   * header otherwise holds zero timers). Click-hearts work regardless. */
  whaleIdle?: boolean
  /** Whether an agent turn is active: working wakes the whale and keeps
   * it moving; sustained !working lets it fall asleep. */
  working?: boolean
  /** Test seam: pin/suppress the upstream-drift notice (`null` forces it off;
   * `undefined` — the production default — auto-detects the install). */
  drift?: UpstreamDriftSummary | null
}): React.ReactNode {
  // One intro per logo mount: the production path rolls (startup splash
  // and each /deepseek replay roll independently), the `intro` seam pins
  // a specific animation for probes.
  const [sequence] = React.useState<readonly OpeningStep[]>(() => OPENING_SEQUENCES[intro ?? pickOpeningSequence().id])
  const [step, setStep] = React.useState(skipIntro ? sequence.length : 0)
  const settled = step >= sequence.length

  // Opening clock: drives the shimmer sweep and big-text highlight only
  // while the intro plays; `null` afterwards unsubscribes so the settled
  // header never repaints. 60ms frames keep the sweep lively.
  const [ref, time] = useAnimationFrame(settled ? null : 60)

  // Frame chain: dwell per sequence entry, then settle for good.
  React.useEffect(() => {
    if (settled) return
    const timer = setTimeout(() => {
      setStep(s => s + 1)
    }, sequence[step].ms)
    return () => {
      clearTimeout(timer)
    }
  }, [step, settled, sequence])

  // ── Settled whale behaviors (ported from the dsh-ui-whale pet) ─────────
  // Click → heart pass: purely event-driven (zero idle cost), available
  // whenever the whale shows, independent of `whaleIdle`. The pass is
  // one-way heart1→heart2→heart3 (350ms each), then the whale resumes
  // whatever it was showing; a fresh click restarts it from the small heart.
  const [heartSeq, setHeartSeq] = React.useState(-1)
  // heartKey restarts the pass on every click, even when heartSeq is already 0
  // (setHeartSeq(0) alone bails in React when the value is unchanged, so a
  // repeat click mid-pass would otherwise do nothing).
  const [heartKey, setHeartKey] = React.useState(0)
  React.useEffect(() => {
    if (heartSeq < 0) return
    const timer = setTimeout(() => {
      setHeartSeq(s => (s >= HEART_PASS.length - 1 ? -1 : s + 1))
    }, HEART_HOLD_MS)
    return () => {
      clearTimeout(timer)
    }
  }, [heartSeq, heartKey])

  const [themeName] = useTheme()
  const theme = getTheme(themeName)
  const { columns } = useTerminalSize()

  const wordmarkRGB = parseRGB(theme.claude) ?? BRAND
  const wordmarkShimmerRGB = parseRGB(theme.claudeShimmer) ?? ICE
  const taglineRGB = parseRGB(theme.claudeBlue_FOR_SYSTEM_SPINNER) ?? ICE

  const showWhale = whale && columns >= WHALE_MIN_COLUMNS

  // Idle behaviors (settings `dsh-tui.whaleIdle`): fin flutters, tail
  // thumps and blips while idle, continuous motion while the agent works,
  // and a sleep-Z loop after sustained inactivity. The planner is
  // event-driven — while the whale rests, the ONLY pending timer is the
  // one waiting for the next due event, and with the setting off there is
  // no timer at all (the idle-wakeup contract keeps holding).
  const [idleFrame, setIdleFrame] = React.useState<number | null>(null)
  const idleStateRef = React.useRef<WhaleIdleState>(initialWhaleIdleState(0))
  React.useEffect(() => {
    if (!settled || !whaleIdle || !showWhale) {
      setIdleFrame(null)
      return
    }
    // A working flip restarts the loop: work wakes a sleeping whale and
    // slides every idle deadline forward (see nextWhaleIdleStep).
    idleStateRef.current = initialWhaleIdleState(Date.now())
    let timer: ReturnType<typeof setTimeout> | undefined
    const tick = (): void => {
      const step = nextWhaleIdleStep(idleStateRef.current, { working, heart: false }, Date.now())
      idleStateRef.current = step.state
      setIdleFrame(step.frameIndex)
      timer = setTimeout(tick, step.delayMs)
    }
    tick()
    return () => {
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [settled, whaleIdle, showWhale, working])
  // Frame priority: heart overlay → intro → idle behavior → standard pose.
  // The heart beats the intro so a click during the opening animation is
  // actually visible instead of staying hidden behind the opening frames.
  const frameIndex = heartSeq >= 0
    ? (HEART_PASS[heartSeq] ?? STANDARD_FRAME_INDEX)
    : !settled
      ? sequence[step].frame
      : (idleFrame ?? STANDARD_FRAME_INDEX)
  // Frozen clock for the settled header: t=0 parks every sweep highlight
  // off-screen, leaving the static gradient behind.
  const t = settled ? 0 : time

  const tagline = tr('logo-tagline')
  // One random tip per mount: the settled header must not re-roll on every
  // repaint (language switch, terminal resize), or the line would flicker.
  // `tip` is a test seam; production always passes undefined and rolls.
  const [randomTip] = React.useState<Tip>(() => tip ?? pickRandomTip())
  // Upstream-drift notice, merged to one line: computed once per mount from
  // the same memoized contract data the adapter checks (undefined when the
  // install matches). `drift` is a test seam to pin or suppress it.
  const [driftLine] = React.useState<UpstreamDriftSummary | null | undefined>(() =>
    drift === undefined ? upstreamDriftSummary() : drift,
  )
  // Indent that centers the tagline under the whale art's bounding box.
  const welcomePad = showWhale
    ? Math.max(0, Math.round(WHALE_CENTER - stringWidth(tagline) / 2))
    : 2

  const bigDeepSeek = renderBigText('DEEPSEEK', t, wordmarkRGB, taglineRGB, FLASH, 60)
  const bigHarness = renderBigText('HARNESS', t, taglineRGB, PALE, FLASH, 60)

  return (
    <Box ref={ref} flexDirection="column" marginTop={1}>
      <Box flexDirection="row" gap={2} width="100%" alignItems="center">
        {showWhale && (
          <Box flexShrink={0} onClick={(): void => { setHeartSeq(0); setHeartKey(k => k + 1) }}>
            <WhaleArt frameIndex={frameIndex} width={FULL_WHALE_WIDTH} />
          </Box>
        )}
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
            <Text dimColor>{tr('logo-tip-prefix')}</Text>
            {getLang() === 'zh' ? randomTip.zh : randomTip.en}
            <Text dimColor>{' · /tips ' + tr('logo-tip-more')}</Text>
          </Text>
          {driftLine != null && (
            <Text color="warning" wrap="wrap">
              ⚠{' '}
              {tOr(
                `logo-drift-${driftLine.kind}`,
                `The dsh engine (${driftLine.versions.join(' / ')}) does not match the validated ${UPSTREAM_VALIDATED_VERSION}; reinstall via npm i -g @deepseek-ai/dsh@${UPSTREAM_VALIDATED_VERSION}.`,
                {
                  installed: driftLine.versions.join(' / '),
                  validated: UPSTREAM_VALIDATED_VERSION,
                  primary: UPSTREAM_VALIDATED_VERSION,
                },
              )}
            </Text>
          )}
        </Box>
      </Box>
      <Box marginTop={1} paddingLeft={welcomePad}>
        <Text>{sweep(tagline, t, taglineRGB, FLASH, 60)}</Text>
      </Box>
    </Box>
  )
}
