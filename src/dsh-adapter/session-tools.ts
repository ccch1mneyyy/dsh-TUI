/**
 * Card headers for the experimental session-search tools.
 *
 * `@deepseek-ai/dsh-tool-session-query@0.2.1-rc.2` gives both search calls a
 * static sentence — "Search prior sessions" / "Search session events" — while
 * a titled generic card renders that sentence and nothing else (the tool name
 * and the arguments stay off the header). Two different calls therefore read
 * alike, and the word "search" repeats the result body's own first line
 * ("Session search results (3):").
 *
 * This adapter is the layer allowed to decide presentation (`agent/
 * presentation.ts`: "a backend translator decides which shape a call gets"),
 * so it gives those two calls a bash-style header instead: the object first,
 * the concrete query in parentheses.
 *
 * The rewrite is self-expiring: it fires only while the upstream title is
 * still the pinned 0.2.1-rc.2 string. A wording change upstream (or a future
 * result presenter) wins silently instead of fighting a second source of
 * truth; delete the entry once upstream ships the new wording.
 *
 * @module
 */
import type { ToolCallView } from './channel/types.js'

/** Pinned upstream title → the header stem this app shows instead. */
const REFINED: ReadonlyMap<string, { readonly pinned: string; readonly stem: string }> = new Map([
  ['session_search', { pinned: 'Search prior sessions', stem: 'Sessions' }],
  ['session_event_search', { pinned: 'Search session events', stem: 'Events' }],
])

/**
 * Refine a session-search call card's title with the query it was given.
 *
 * @param name - Tool name.
 * @param view - The upstream presentation view for this call, if any.
 * @param rawArgs - The call's JSON arguments, as persisted.
 * @returns The upstream view untouched unless the tool, the pinned title and
 *          a non-empty string `query` all line up; else a retitled copy.
 */
export function refineSessionSearchTitle(
  name: string,
  view: ToolCallView | undefined,
  rawArgs: string,
): ToolCallView | undefined {
  if (view === undefined || view.card !== 'generic') return view
  const refined = REFINED.get(name)
  if (refined === undefined || view.title !== refined.pinned) return view
  let args: unknown
  try {
    args = JSON.parse(rawArgs)
  } catch {
    return view
  }
  const query = (args as { query?: unknown } | null)?.query
  if (typeof query !== 'string') return view
  const trimmed = query.trim()
  if (trimmed === '') return view
  // The generic card header is one line (`HeaderTitle`'s non-terminal branch),
  // and the query is free model text: JSON-encoding keeps newlines, quotes and
  // control bytes printable inside the `Name("query")` shape instead of
  // splitting the row or writing raw escape sequences to the terminal.
  return { ...view, title: `${refined.stem}(${JSON.stringify(trimmed)})` }
}
