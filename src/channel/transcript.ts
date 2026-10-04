/** Backend-neutral transcript limits and text helpers shared by the projector,
 *  the fold pass and the local-output paths. */

export const ARGS_PREVIEW_LIMIT = 160

export const RESULT_PREVIEW_LIMIT = 240

/** Local `!`-command output cap (mirrors the result preview limit). */
export const LOCAL_OUTPUT_LIMIT = 240

/**
 * In-memory transcript window cap. Older rows beyond this count are folded:
 * their full-text fields (assistant/reasoning text, tool args/results) are
 * dropped and only the preview/status metadata kept, so a long merge/deploy
 * turn cannot grow the TUI's RAM without bound. The session log still holds
 * everything (`/export` reads it, `/resume` replays it); the
 * folded row keeps its kind/id so scrolling and selection stay stable.
 */
export const MAX_ROWS = 600

export function preview(text: string, limit: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= limit ? flat : `${flat.slice(0, limit)}…`
}
