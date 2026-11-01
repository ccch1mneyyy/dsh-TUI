/**
 * Card shape for the experimental `create_worktree` tool.
 *
 * `@deepseek-ai/dsh-experimental-tool-worktree@0.2.1-rc.3` titles every call
 * with the bare tool name and ships no result presenter, so the card reads
 * `create_worktree` over one line of JSON (`path`, `branch`, `baseCommit`,
 * `repositoryRoot`) that a narrow terminal breaks mid-field. This adapter is
 * the layer allowed to decide presentation (`agent/presentation.ts`), so the
 * call header names the branch the way the session-search cards name their
 * query (`session-tools.ts`), and a settled result becomes two lines: where
 * the checkout is and what it started from.
 *
 * Self-expiring like those cards: the header is rewritten only while the
 * upstream title is still the pinned tool name, and the result only while the
 * tool has no presenter of its own (the caller checks), so an upstream
 * presentation wins without editing this app.
 *
 * @module
 */
import { displayPath } from '../backends/shared/display-path.js'
import { t } from '../i18n.js'
import type { ToolCallView, ToolResultView } from './channel/types.js'

/** The tool name, which is also its pinned upstream call title. */
export const WORKTREE_TOOL = 'create_worktree'

/** `Worktree("name")`: JSON-encoding keeps the one-line header printable
 *  whatever the model put in the name (`session-tools.ts`). */
const header = (branch: string): string => `Worktree(${JSON.stringify(branch)})`

/** The model's `{ name?, from? }` arguments, or undefined when unparseable. */
function argsOf(rawArgs: string): { name?: unknown; from?: unknown } | undefined {
  try {
    const args: unknown = JSON.parse(rawArgs)
    return typeof args === 'object' && args !== null ? args : undefined
  } catch {
    return undefined
  }
}

/**
 * Put the requested branch name in a `create_worktree` call card's header.
 *
 * @param name - Tool name.
 * @param view - The upstream presentation view for this call, if any.
 * @param rawArgs - The call's JSON arguments, as persisted.
 * @returns The upstream view untouched unless the tool, the pinned title and a
 *          non-empty string `name` all line up; else a retitled copy. A call
 *          without a name keeps the plain title until its result names the
 *          generated branch.
 */
export function refineWorktreeCallTitle(
  name: string,
  view: ToolCallView | undefined,
  rawArgs: string,
): ToolCallView | undefined {
  if (name !== WORKTREE_TOOL || view === undefined || view.card !== 'generic' || view.title !== WORKTREE_TOOL) return view
  const branch = argsOf(rawArgs)?.name
  if (typeof branch !== 'string' || branch.trim() === '') return view
  return { ...view, title: header(branch.trim()) }
}

/**
 * Summarize a settled `create_worktree` result.
 *
 * @param name - Tool name.
 * @param rawArgs - The call's JSON arguments, as persisted.
 * @param text - The result's text payload (the tool's JSON output).
 * @returns A generic card titled with the created branch, whose body is the
 *          checkout path (relative to the repository when inside it) and the
 *          revision it started from; undefined for any other tool or shape.
 */
export function worktreeResultView(name: string, rawArgs: string, text: string): ToolResultView | undefined {
  if (name !== WORKTREE_TOOL) return undefined
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return undefined
  }
  const { path, branch, baseCommit, repositoryRoot } = (value ?? {}) as Record<string, unknown>
  if (typeof path !== 'string' || typeof branch !== 'string' || typeof baseCommit !== 'string' || typeof repositoryRoot !== 'string') {
    return undefined
  }
  const from = argsOf(rawArgs)?.from
  const lines = [
    displayPath(path, repositoryRoot),
    t('worktree-result-base', { from: typeof from === 'string' && from !== '' ? from : 'HEAD', commit: baseCommit.slice(0, 7) }),
  ]
  // One block: a generic card joins its text blocks without a separator.
  return { card: 'generic', title: header(branch), content: [{ type: 'text', text: lines.join('\n') }] }
}
