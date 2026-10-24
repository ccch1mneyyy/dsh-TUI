/**
 * PanelCompactRows — the compact slot of side panels (§18.1).
 *
 * A panel may declare a 1–3 row `compact` form "for when the side column is
 * collapsed or the screen is narrow" (types.ts). This is that slot: while the
 * split is NOT rendering — inline mode, a terminal narrower than the split
 * threshold, the column collapsed, the full-page editor open — Chat mounts it
 * above the prompt, in the same band as the rich plugin status views. While
 * the split renders it is empty: the panels speak for themselves there (the
 * same rule the bottom Goal/Todo chrome follows for the todo panel).
 *
 * Membership follows the ONE enabled set (`sidePanel.panels`, `*` = every
 * registered panel), in its order: deselecting a panel in /settings removes
 * its compact row too. The rows share one budget of {@link PANEL_COMPACT_ROWS}
 * lines; a panel whose `maxRows` no longer fits is skipped (never squeezed).
 * Each row is clipped to its `maxRows`, rendered under its own error boundary
 * (a crash shows a one-line error and counts toward the session disable), and
 * a disabled panel shows nothing.
 *
 * Chat renders this on every channel emit, streamed deltas included. The rows'
 * props therefore stay identical unless something a row reads changed — its
 * width, its badge, or (once it has called `snapshot()`) the snapshot's
 * inputs — and the compact components are memoized, so a token does not
 * re-render plugin code. A row that never asks for a snapshot costs no
 * snapshot work at all.
 */
import React from 'react'
import { Box, useTerminalSize } from '../../ui.js'
import type { ChannelUi } from '../../adapter/channel/ui-policy.js'
import type { ActivityView } from '../../dsh-adapter/activity-store.js'
import type { TuiPanelCompactSnapshot } from '../../dsh-adapter/panels.js'
import { panelStore } from './PanelStore.js'
import { PanelErrorBoundary } from './PanelErrorBoundary.js'
import { buildPanelSnapshot, panelSnapshotInputs, PANEL_SNAPSHOT_INPUT_COUNT } from './panelSnapshot.js'
import type { PanelEntry } from './types.js'

/** Total rows the compact slot may take above the prompt. */
export const PANEL_COMPACT_ROWS = 3

/** Where the rows' snapshots come from: what PanelHost gives full panels. */
export interface PanelCompactSnapshotSources {
  readonly channel?: Partial<ChannelUi>
  readonly activity?: ActivityView
  readonly approvals?: number
  readonly questions?: number
}

export interface PanelCompactRowsProps extends PanelCompactSnapshotSources {
  /** The side-panel controller's view: whether the split renders, and the enabled set. */
  readonly controller: { readonly split: boolean; readonly enabledPanelIds: readonly string[] }
}

const NO_ROWS: readonly PanelEntry[] = Object.freeze([])
/** The memo key of a row that has not called `snapshot()` yet: never changes. */
const UNUSED_SNAPSHOT_INPUTS: readonly unknown[] = Object.freeze(new Array<unknown>(PANEL_SNAPSHOT_INPUT_COUNT).fill(undefined))

/** Which entries get a compact row, in order, within the row budget. */
export function selectCompactEntries(
  entries: readonly PanelEntry[],
  enabledPanelIds: readonly string[],
  budget: number = PANEL_COMPACT_ROWS,
): readonly PanelEntry[] {
  const picked: PanelEntry[] = []
  let remaining = budget
  for (const id of enabledPanelIds) {
    const entry = entries.find(candidate => candidate.definition.id === id)
    const compact = entry?.definition.compact
    if (entry === undefined || compact === undefined || entry.disabled === true) continue
    if (compact.maxRows > remaining) continue
    picked.push(entry)
    remaining -= compact.maxRows
    if (remaining <= 0) break
  }
  return picked
}

export function PanelCompactRows({ controller, channel, activity, approvals = 0, questions = 0 }: PanelCompactRowsProps): React.ReactNode {
  const entries = React.useSyncExternalStore(panelStore.subscribe, () => panelStore.list())
  const { columns } = useTerminalSize()
  const { split, enabledPanelIds } = controller
  const rows = React.useMemo(
    () => (split ? NO_ROWS : selectCompactEntries(entries, enabledPanelIds)),
    [split, entries, enabledPanelIds],
  )
  if (rows.length === 0) return null
  return (
    <Box flexDirection="column" flexShrink={0}>
      {rows.map(entry => (
        <CompactRow
          key={entry.definition.id + ':' + String(entry.registrationId)}
          entry={entry}
          width={columns}
          channel={channel}
          activity={activity}
          approvals={approvals}
          questions={questions}
        />
      ))}
    </Box>
  )
}

interface CompactRowProps extends PanelCompactSnapshotSources {
  readonly entry: PanelEntry
  readonly width: number
}

function CompactRow({ entry, width, channel, activity, approvals = 0, questions = 0 }: CompactRowProps): React.ReactNode {
  const compact = entry.definition.compact!
  // `snapshot()` always builds from the latest sources; its identity is what
  // tells a memoized row to re-render. Until the row first calls it, that key
  // is a constant (no per-render reads); afterwards it is the snapshot's
  // inputs, so the row re-renders when — and only when — they move.
  const sources = React.useRef({ channel, activity, approvals, questions })
  sources.current = { channel, activity, approvals, questions }
  const used = React.useRef(false)
  const inputs = used.current ? panelSnapshotInputs(channel, activity, approvals, questions) : UNUSED_SNAPSHOT_INPUTS
  const snapshot = React.useMemo(
    () => (): TuiPanelCompactSnapshot => {
      used.current = true
      const latest = sources.current
      const { version: _version, ...snapshot } = buildPanelSnapshot(latest.channel, latest.activity, { approvals: latest.approvals, questions: latest.questions })
      return Object.freeze(snapshot)
    },
    inputs,
  )
  return (
    <Box flexDirection="column" flexShrink={0} maxHeight={compact.maxRows} overflow="hidden">
      {/* Non-shrinking inner column (the status-view recipe): the clip
          keeps the TOP rows instead of squeezing every row into one. */}
      <Box flexDirection="column" flexShrink={0}>
        <PanelErrorBoundary panelId={entry.definition.id} variant="row">
          {React.createElement(compact.component, { width, badge: entry.badge, snapshot })}
        </PanelErrorBoundary>
      </Box>
    </Box>
  )
}
