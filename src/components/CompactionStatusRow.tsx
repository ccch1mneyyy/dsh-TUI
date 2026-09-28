import React from 'react'
import { Box, Text } from '../ui.js'
import { useAnimationFrame } from '../ink/hooks/use-animation-frame.js'
import { useTerminalSize } from '../ink/hooks/use-terminal-size.js'
import { stringWidth } from '../ink/stringWidth.js'
import { t } from '../i18n.js'
import { formatDuration, formatTokens } from '../terminal-utils/format.js'
import { SpinnerGlyph } from './Spinner/SpinnerGlyph.js'
import { resolvePreset, type FramePreset } from './activityFrames.js'
import type { CompactionStatus } from '../adapter/ports/channel-view.js'

/** Field separator, matching the working spinner's row. */
const SEP = ' · '
/** Cells kept clear so a long row never wraps into the prompt below. */
const RESERVE = 2
/** Cadence of the classic dot spinner, so that slot agrees with the turn's. */
const FRAME_MS = 140
/** Tick granularity: fine enough for the fastest `/activity` preset (120ms). */
const TICK_MS = 60
/** Columns the classic dot occupies (`SpinnerGlyph`'s fixed two-column slot). */
const DOT_SLOT = 2

/** A `/activity` preset resolved once per name, with its widest frame. */
interface Indicator {
  readonly preset: FramePreset
  readonly width: number
}

/**
 * The in-flight compaction row, in the same slot as the working spinner.
 *
 * A `/compact` runs for tens of seconds (measured on real sessions: median
 * ~25s, p90 ~70s) and the old transient toast covered the first four of them,
 * leaving the screen indistinguishable from idle. This row stays for the whole
 * bracket, counts up, and shows the summarizer's own output as it streams
 * (`compaction.outputChars`) — the one honest progress signal a compaction has,
 * since the host exposes no proportional one.
 *
 * Its leading indicator follows the spinner slot: the `/activity` preset while
 * the working-activity line owns that slot (a running turn shows the preset, so
 * the compaction must not answer with a different glyph), the classic dot
 * otherwise.
 */
export function CompactionStatusRow({
  compaction,
  activityPreset,
}: {
  compaction: CompactionStatus
  /** `/activity` preset name to draw the indicator with; undefined keeps the
   *  classic dot family. */
  activityPreset?: string
}): React.ReactNode {
  const { columns } = useTerminalSize()
  const [viewportRef, time] = useAnimationFrame(TICK_MS)

  // `random` resolves per call, so the pick is memoized per preset name — the
  // rule the activity line and the subagent rows already follow.
  const indicator = React.useMemo((): Indicator | null => {
    if (activityPreset === undefined) return null
    const preset = resolvePreset(activityPreset)
    // The widest frame, not the current one: the row must not reflow mid-pulse.
    return { preset, width: Math.max(...preset.frames.map(frame => stringWidth(frame))) + 1 }
  }, [activityPreset])

  const glyph = indicator === null
    ? null
    : indicator.preset.frames[
      Math.floor(time / indicator.preset.intervalMs) % indicator.preset.frames.length
    ] ?? '·'

  // Derived from wall-clock each frame (the row is only mounted while a
  // compaction runs, so the tick stops with it).
  const elapsed = formatDuration(Date.now() - compaction.startedAt)
  const frame = Math.floor(time / FRAME_MS)
  const label = t('compact-working')
  const detail = compaction.phase === 'summary'
    ? `↓ ${formatTokens(Math.round(compaction.outputChars / 4))} tokens`
    : t('compact-phase-prefill')
  const hint = compaction.cancellable ? t('compact-esc-cancel') : undefined

  // The hint is actionable and the phase is informative, so a narrow terminal
  // drops the phase first and the hint only when even that does not fit.
  const budget = Math.max(0, columns - RESERVE)
  const base = (indicator === null ? DOT_SLOT : indicator.width) + stringWidth(label)
  const elapsedWidth = stringWidth(SEP) + stringWidth(elapsed)
  const hintWidth = hint === undefined ? 0 : stringWidth(SEP) + stringWidth(hint)
  const detailWidth = stringWidth(SEP) + stringWidth(detail)
  const showHint = hint !== undefined && base + elapsedWidth + hintWidth <= budget
  const showDetail = base + elapsedWidth + hintWidth + detailWidth <= budget

  return (
    <Box ref={viewportRef} flexDirection="row" flexWrap="wrap" marginTop={1} width="100%">
      {glyph === null
        ? <SpinnerGlyph frame={frame} messageColor="accent" />
        : <Text color="activity">{`${glyph} `}</Text>}
      <Text color="accent">{label}</Text>
      {showDetail && <Text dimColor>{`${SEP}${detail}`}</Text>}
      <Text dimColor>{`${SEP}${elapsed}`}</Text>
      {showHint && <Text dimColor>{`${SEP}${hint}`}</Text>}
    </Box>
  )
}
