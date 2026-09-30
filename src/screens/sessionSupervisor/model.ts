/**
 * Pure model for the unified session screen: constants, view types and the
 * derivations that are testable without a terminal.
 *
 * Kept apart from the screen so the hook and the screen can share them without
 * importing each other, and so a regression can drive them directly. Anything
 * that needs a channel, the filesystem or a render belongs to the hook instead.
 */

import type { SessionSummary } from '../../dsh-adapter/sessions/index.js'
import type { TuiWorkspaceEntry } from '../../workspaces.js'
import wrapAnsi from 'wrap-ansi'
import { normalizeWorkspaceCwd } from '../../sessions/view.js'
import { truncateWidth } from '../../sessions/format.js'
import { stringWidth } from '../../ink/stringWidth.js'

/**
 * Rows the left rail always keeps: the section header, the hint line, and the
 * blank rows around them.
 *
 * There is no `+` row any more. A workspace enters the ledger by being the
 * directory a terminal started in (see the startup attach in `plugin.ts`), so
 * the rail has no creation control to reserve a row for.
 */
export const RAIL_CHROME_ROWS = 4
/** Terminal rows one rail entry occupies; see {@link HomeWorkspaceRow}. */
export const WORKSPACE_ROW_LINES = 2
/** Width the rail gets when the terminal is wide enough to show both panes. */
export const RAIL_MIN_TOTAL_COLUMNS = 84
export const RAIL_WIDTH_MIN = 24
export const RAIL_WIDTH_MAX = 38
/** Two lines per session row (title + facts), plus the filter and notice rows. */
export const SESSION_ROW_LINES = 2
/** Chrome the right pane spends on banner, filter, new-session card, notice and hints. */
export const SESSION_PANE_CHROME_ROWS = 8
/**
 * Most rows the notice may grow to. A mount refusal carries the adapter's own
 * error text, which is routinely longer than one row; three rows show it in
 * full on ordinary widths without letting it push the list off the screen.
 */
export const NOTICE_MAX_LINES = 3

/**
 * The notice wrapped to `width` display columns, at most
 * {@link NOTICE_MAX_LINES} rows, the last one ellipsised when text remains.
 * Always at least one row, so an empty notice still holds its place.
 */
export function noticeLines(text: string | undefined, width: number): string[] {
  if (text === undefined || width <= 0) return ['']
  const rows = wrapAnsi(text, width, { hard: true, trim: true }).split('\n')
  if (rows.length <= NOTICE_MAX_LINES) return rows
  const kept = rows.slice(0, NOTICE_MAX_LINES)
  const last = kept[NOTICE_MAX_LINES - 1] ?? ''
  // The ellipsis marks the cut even when the kept row is short of `width`.
  kept[NOTICE_MAX_LINES - 1] = stringWidth(last) < width ? `${last}…` : truncateWidth(`${last}…`, width)
  return kept
}

export type MenuAction = 'edit' | 'new' | 'rename' | 'remove'
export const MENU_ACTIONS: readonly MenuAction[] = ['edit', 'new', 'rename', 'remove']
export const MENU_WIDTH = 30
/** One confirm line + its explanation. */
export const MENU_HEIGHT = MENU_ACTIONS.length + 2

export const MENU_LABEL_KEYS = {
  edit: 'home-menu-edit',
  new: 'home-menu-new',
  rename: 'home-menu-rename',
  remove: 'home-menu-remove',
} as const

/**
 * What this terminal knows about one session's live state, from the channel's
 * agent-view projection. Absent for a session this process never mounted.
 */
export interface SupervisorLiveState {
  /** The row status vocabulary the overview column already uses. */
  readonly status: 'working' | 'needs-input' | 'idle' | 'completed' | 'failed' | 'stopped'
  /** True when an agent for this session is alive in THIS process. */
  readonly live: boolean
  /** True when this is the session the terminal is attached to. */
  readonly current: boolean
  /** One-line activity summary. */
  readonly summary: string
}

/**
 * One row of the workspace rail: a durable registration, or the fallback group
 * for sessions whose directory is NOT registered.
 *
 * The registry is not the whole session store — a host can run without the
 * workspace service at all (bare compositions return an empty registry), and a
 * session keeps existing after its registration is removed. Those sessions are
 * still resumable, so "no registration" must not read as "no history".
 */
export type RailEntry = TuiWorkspaceEntry & { readonly from: 'registry' | 'unregistered' }

/** Synthetic id/path for the fallback group; never persisted. */
export const UNREGISTERED_RAIL_ID = 'rail:unregistered'

export function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Case-insensitive path equality, matching the workspace ledger's own rule. */
export function samePath(left: string, right: string): boolean {
  return normalizeWorkspaceCwd(left) === normalizeWorkspaceCwd(right)
}

/**
 * Case-insensitive substring match over the fields a person searches by.
 *
 * Title and label are the obvious ones; the working directory and branch are
 * included because "which of these three look-alike sessions" is usually
 * answered by where it ran and what it was on, not by its truncated title.
 * @param session - The session to test.
 * @param needle - Lower-cased query; empty matches everything.
 * @returns True when the session should stay visible.
 */
export function sessionMatchesQuery(session: SessionSummary, needle: string): boolean {
  if (needle.length === 0) return true
  const haystack = [
    session.title.text,
    session.label ?? '',
    session.cwd,
    session.branch ?? '',
    session.model ?? '',
  ].join('\n').toLowerCase()
  return haystack.includes(needle)
}
