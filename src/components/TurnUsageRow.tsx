import React from 'react'
import { Text } from '../ui.js'
import { t } from '../i18n.js'
import { formatTokens } from '../terminal-utils/format.js'
import { formatDuration } from '../terminal-utils/format.js'
import type { TurnUsageSummary } from '../adapter/ports/channel-view.js'

/**
 * The quiet right-aligned emblem that closes a turn (design §C, restyled):
 * tokens in/out, cache split, span, retries — metadata, so it hugs the right
 * margin instead of competing with the reading flow, drops the "this turn"
 * prefix (position says it) and sits one notch BELOW the thinking timer's
 * dim (theme `subtle`). The model name appears only when it differs from
 * the previous turn (`noteModel`, decided at projection time) — repeating
 * an unchanged model every turn is noise, and the first turn shows it once
 * to establish which model the session runs.
 *
 * Formatting happens at render time (not projection time) so a language
 * switch relabels history; the payload itself is immutable, which is what
 * the per-row memo compares. Cache segments render only when the wire
 * carried cache tokens: an unreported cache is absent, not zero. An
 * interrupted or failed turn keeps its ledger marked as partial truth.
 */
export function TurnUsageRow({ usage }: { usage: TurnUsageSummary }): React.ReactNode {
  const parts: string[] = [
    `↑${formatTokens(usage.input)}`,
    `↓${formatTokens(usage.output)}`,
  ]
  if (usage.cacheKnown && usage.cacheRead + usage.cacheWrite > 0) {
    const cacheParts: string[] = []
    if (usage.cacheRead > 0) cacheParts.push(t('usage-cache-read', { n: formatTokens(usage.cacheRead) }))
    if (usage.cacheWrite > 0) cacheParts.push(t('usage-cache-write', { n: formatTokens(usage.cacheWrite) }))
    parts.push(t('usage-cache-segment', { parts: cacheParts.join('/') }))
  }
  parts.push(formatDuration(usage.durationMs))
  if (usage.noteModel === true && usage.model !== undefined) parts.push(usage.model)
  if (usage.retries > 0) parts.push(t('usage-retry-segment', { n: usage.retries }))
  if (usage.outcome === 'interrupted') parts.push(t('usage-turn-outcome-interrupted'))
  else if (usage.outcome === 'error') parts.push(t('usage-turn-outcome-error'))
  return (
    <Text color="subtle" wrap="truncate">{parts.join(' · ')}</Text>
  )
}
