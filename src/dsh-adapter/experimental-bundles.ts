/**
 * DSH installation-supplied experimental bundles this TUI can drive, and the
 * line that says how.
 *
 * A curated list, not a discovery: the plugin service reports every optional
 * bundle the installation ships (voice input and the plugin market included),
 * but only entries with a real TUI entry point belong here. `/plugin list`
 * intersects this list with what the running installation supplies, so an
 * older dsh simply shows nothing.
 *
 * Agent Teams is deliberately absent: `0.2.2-rc.2` moved it into `dsh-base`
 * as a per-session selection (`/team on|off`), so there is no bundle to
 * advertise or install. A bundle host (`0.2.2-rc.1` and earlier) still ships
 * the retired profile package, but the TUI no longer sells it.
 *
 * @module
 */
import type { I18nKey } from '../i18n.js'

/** The bundle that mounts the `auto` permission preset. */
export const AUTO_REVIEW_BUNDLE = '@deepseek-ai/dsh-experimental-auto-review'

/** The bundle that mounts the five read-only session-search tools. */
export const SESSION_SEARCH_BUNDLE = '@deepseek-ai/dsh-experimental-session-search'

/** The bundle that mounts `create_worktree` (a new Git branch and worktree the
 *  session then moves into; the TUI follows the move like any other cd). */
export const WORKTREE_BUNDLE = '@deepseek-ai/dsh-experimental-tool-worktree'

/** One experimental feature the TUI knows how to switch on and use. */
export interface TuiExperimentalBundle {
  readonly name: string
  /** How to use the feature once it is on, in the reader's language. */
  readonly hint: I18nKey
}

/** The features `/plugin list` advertises, in product order. */
export const TUI_EXPERIMENTAL_BUNDLES: readonly TuiExperimentalBundle[] = [
  { name: AUTO_REVIEW_BUNDLE, hint: 'plugins-experimental-auto-review-hint' },
  { name: SESSION_SEARCH_BUNDLE, hint: 'plugins-experimental-session-search-hint' },
  { name: WORKTREE_BUNDLE, hint: 'plugins-experimental-worktree-hint' },
]
