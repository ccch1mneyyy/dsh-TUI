import React from 'react'
import wrapText from '../ink/wrap-text.js'
import { stringWidth } from '../ink/stringWidth.js'
import { t } from '../i18n.js'
import { Box, Text, useTerminalSize } from '../ui.js'
import { cleanRenderText } from '../channel/sanitize.js'
import { useOverlayListRows } from './OverlayAbove.js'
import type { GrantPlan, GrantPlanEntry } from '../dsh-adapter/grant-file.js'

/** Rows a confirmation pane shows before folding the rest into one line. */
const GRANT_LIST_MAX_ROWS = 12
/** Per-cell cap: a permission name and a scope are foreign text like any other. */
const GRANT_CELLS = 48
/** Both panes render this list inside `Pane`, which pads two cells on each side. */
const PANE_PADDING_CELLS = 4
/** What one row spends besides its two cells: `  `, ` @ ` and `  `. */
const ROW_SEPARATOR_CELLS = 7
/** Narrower cells than this stop being useful; the row may then lose its tail. */
const MIN_CELLS = 4
/** Unknown names named on the folded line before it becomes a list of its own. */
const UNKNOWN_NAMES_SHOWN = 3
/** The list's own chrome above the heading; the heading itself is measured. */
const LIST_TOP_MARGIN_ROWS = 1
/** Chat wraps every picker pane in one row's margin inside the overlay. */
const OVERLAY_PANE_MARGIN_ROWS = 1

/**
 * Rows one localized line occupies inside a `Pane` at the current width.
 *
 * A pane that hands the permission list its frame has to know how tall that
 * frame really is: the trust and notice copy wraps differently at 50 and 80
 * columns, so a fixed row count either folds rows that would have fit or lets
 * the list push the pane title off the overlay. This measures with the
 * renderer's own wrap function (the one `Text` uses) at the pane's content
 * width, so the count matches what is drawn.
 */
export function usePaneTextRows(): (text: string) => number {
  const { columns } = useTerminalSize()
  return React.useCallback(
    (text: string): number =>
      wrapText(text, Math.max(1, columns - PANE_PADDING_CELLS), 'wrap').split('\n').length,
    [columns],
  )
}

/**
 * The permissions one lifecycle action is about, as the confirmation pane shows
 * them (grant lifecycle plan §8).
 *
 * Both the install confirmation and the lifecycle confirmation read the same
 * list, so they cannot describe the same declaration differently. Ordering is
 * deliberate: default-deny (the interception-class) permissions lead — the risk
 * a person is least likely to expect is what they see first — and inside that
 * block the ones not granted yet come first. Granted entries sink within their
 * own group, never across it, so a hand-edited grant on a default-deny row
 * keeps its place in the leading block instead of disappearing under the
 * default-allow rows.
 *
 * Height is the overlay's, not the terminal's: the pane sits in `OverlayAbove`,
 * which reserves a strip above the prompt and clips whole rows from the top.
 * The list therefore folds to whatever its pane's frame leaves — fewer rows plus
 * `and N more…` — instead of pushing the package identity, the trust notice or
 * the key hint off a short terminal.
 *
 * Presentational only; the state lives in the flows.
 */
export function PluginGrantList({ plan, mode, frameRows }: {
  plan: GrantPlan
  mode: 'grant' | 'revoke'
  /**
   * Rows the pane spends outside the permission rows: the pane frame, the
   * heading, the facts, the hint. The margin the caller wraps the pane in is
   * reserved here, since it is part of the overlay this list has to fit.
   */
  readonly frameRows: number
}): React.ReactNode {
  // Hooks run before the "nothing to show" return: the pane may re-render this
  // list with another plan, and the hook order must not depend on it.
  const { columns } = useTerminalSize()
  const textRows = usePaneTextRows()
  const overlayRows = useOverlayListRows(0)
  // Nothing to show (a package that declares no permissions): the pane keeps its
  // own layout rather than printing an empty heading.
  if (plan.entries.length === 0 && plan.unknown.length === 0) return null
  // One row per permission. Besides the two foreign cells a row spends `  `,
  // ` @ `, the gap before the status and the localized status itself; `Pane`
  // adds two cells of padding on each side that `useTerminalSize()` does not
  // subtract. Measure the status instead of assuming it: the English labels are
  // wider than the Chinese ones. `wrap="truncate"` is the backstop for terminals
  // narrower than `MIN_CELLS`: an over-long row loses its tail instead of
  // growing a second line and pushing the key hint off the screen.
  // A reduce, not `Math.max(...map)`: the declaration is untrusted input and a
  // manifest can carry more permissions than the argument limit allows.
  const statusCells = plan.entries.reduce((widest, entry) => Math.max(widest, stringWidth(statusOf(entry))), 0)
  const cells = Math.max(MIN_CELLS, Math.min(GRANT_CELLS, Math.floor(
    (columns - PANE_PADDING_CELLS - ROW_SEPARATOR_CELLS - statusCells) / 2,
  )))
  const clean = (value: string): string => cleanRenderText(value, cells)
  const entries = [...plan.entries].sort(compareEntries)
  const title = t(mode === 'grant' ? 'plugins-grant-list-title' : 'plugins-grant-list-title-revoke')
  const unknown = plan.unknown.length === 0
    ? undefined
    : `  ${t('plugins-grant-unknown-line', {
      count: String(plan.unknown.length),
      names: `${plan.unknown.slice(0, UNKNOWN_NAMES_SHOWN).map(clean).join(', ')}${plan.unknown.length > UNKNOWN_NAMES_SHOWN ? '…' : ''}`,
    })}`
  // Rows left for entry rows and the folded-count line. `overlayRows` is the
  // overlay's own budget (`rows - 8` outside one, the same reserve the pickers
  // assume); the frame is what the pane already spends, and the chrome is this
  // list's gap, heading and unknown line.
  const available = overlayRows - frameRows - OVERLAY_PANE_MARGIN_ROWS - LIST_TOP_MARGIN_ROWS
    - textRows(title) - (unknown === undefined ? 0 : textRows(unknown))
  // A frame that already fills the overlay leaves nothing to fold into: drawing
  // a heading and no rows would only cost the rows above it.
  if (entries.length === 0 && available < 0) return null
  if (entries.length > 0 && available < 1) return null
  const cap = Math.min(GRANT_LIST_MAX_ROWS, Math.max(0, available))
  const needsFold = entries.length > cap
  const shownCount = needsFold ? Math.min(cap, Math.max(0, available - 1)) : entries.length
  const shown = entries.slice(0, shownCount)
  const hidden = entries.length - shown.length
  return (
    <Box marginTop={LIST_TOP_MARGIN_ROWS} flexDirection="column">
      <Text>{title}</Text>
      {shown.length === 0
        // Not one row fits. Keep a count under the heading (the key hint repeats
        // it) instead of drawing a heading with nothing beneath it.
        ? hidden > 0 && <Text dimColor wrap="truncate">{`  ${t('plugins-grant-hidden', { count: String(hidden) })}`}</Text>
        : shown.map(entry => (
          <Text key={`${entry.name}\u0000${entry.scope}`} dimColor={entry.granted} wrap="truncate">
            {`  ${clean(entry.name)} @ ${clean(entry.scope)}  ${statusOf(entry)}`}
          </Text>
        ))}
      {shown.length > 0 && hidden > 0 && <Text dimColor>{`  ${t('plugins-grant-more', { count: String(hidden) })}`}</Text>}
      {unknown !== undefined && <Text dimColor>{unknown}</Text>}
    </Box>
  )
}

/** What one row says about itself: its registry default and whether it is granted. */
function statusOf(entry: GrantPlanEntry): string {
  const granted = t(entry.granted ? 'plugins-grant-granted' : 'plugins-grant-not-granted')
  const fallback = t(entry.default === 'allow' ? 'plugins-grant-default-allow' : 'plugins-grant-default-deny')
  return `${fallback}  ${granted}`
}

/** Default-deny before default-allow, then not-yet-granted before granted. */
function compareEntries(left: GrantPlanEntry, right: GrantPlanEntry): number {
  if (left.default !== right.default) return left.default === 'deny' ? -1 : 1
  if (left.granted !== right.granted) return left.granted ? 1 : -1
  return 0
}
