/**
 * The `patch` branch of a {@link ToolFileDiff} (N5): one file's unified diff
 * hunks, as a backend that only has the patch reports them (Codex
 * `fileChange`: `@@ -1,3 +1,3 @@\n one\n-two\n+TWO\n three\n`, no file
 * headers). Both diff renderers — the unified card body and the two-pane
 * SplitDiffView — read the parsed form from here, so they agree on line
 * numbers and on the `(+N -M)` stat.
 *
 * Parsing uses jsdiff's `parsePatch` (file headers are synthesized when the
 * text has none). A hunk whose line counts disagree with its header makes
 * `parsePatch` throw; such a patch, and a headerless one jsdiff cannot
 * place, falls back to a lenient line walk under the same rules. An `add` /
 * `delete` change whose text holds no hunk at all is the file's raw
 * content (Codex reports a new file that way) and becomes one all-added /
 * all-removed hunk. Anything still without hunks keeps its raw lines
 * (`raw`), so nothing the backend sent is silently dropped.
 *
 * Results are cached by patch text (bounded): a running card re-renders
 * every second, and the same patch must not be re-parsed each time.
 */
import * as JsDiff from 'diff'
import type { ToolFileDiff } from '../dsh-adapter/channel.js'
import { t } from '../i18n.js'

/** The `patch` member of the union. */
export type ToolPatchDiff = Extract<ToolFileDiff, { readonly patch: string }>

/** Whether a file diff carries a unified patch (vs old/new texts). */
export const isPatchDiff = (diff: ToolFileDiff): diff is ToolPatchDiff => 'patch' in diff

/** One line of a hunk with its real file line numbers. */
export interface PatchLine {
  readonly kind: 'context' | 'del' | 'add'
  readonly text: string
  /** Line number in the old file (context and removed lines). */
  readonly oldNo?: number
  /** Line number in the new file (context and added lines). */
  readonly newNo?: number
}

/** One parsed hunk. */
export interface PatchHunk {
  readonly oldStart: number
  readonly newStart: number
  readonly lines: readonly PatchLine[]
}

/** One file's parsed patch. */
export interface ParsedPatch {
  readonly hunks: readonly PatchHunk[]
  /** Added / removed line counts over every hunk (the `(+N -M)` stat). */
  readonly added: number
  readonly removed: number
  /** The widest line number any hunk shows (gutter width). */
  readonly maxLineNo: number
  /** No hunk could be read: the patch's own lines, shown as-is. */
  readonly raw?: readonly string[]
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/u

/** Number the lines of one hunk from its starts. */
function numberHunk(oldStart: number, newStart: number, rawLines: readonly string[]): PatchHunk {
  const lines: PatchLine[] = []
  let oldNo = oldStart
  let newNo = newStart
  for (const raw of rawLines) {
    const marker = raw[0]
    const text = raw.slice(1)
    if (marker === ' ') lines.push({ kind: 'context', text, oldNo: oldNo++, newNo: newNo++ })
    else if (marker === '-') lines.push({ kind: 'del', text, oldNo: oldNo++ })
    else if (marker === '+') lines.push({ kind: 'add', text, newNo: newNo++ })
    // `\ No newline at end of file` and stray lines carry no content.
  }
  return { oldStart, newStart, lines }
}

/** A start line as a header states it: `-0,0` (nothing on that side) still
 *  numbers the first line it would hold as 1. */
const startOf = (start: number, count: number | undefined): number => (count === 0 && start === 0 ? 1 : start)

/** The lenient walk: every `@@` header opens a hunk; ` `/`-`/`+` lines
 *  belong to it until the next header, whatever its counts claim. */
function lenientHunks(text: string): PatchHunk[] {
  const hunks: PatchHunk[] = []
  let current: { oldStart: number; newStart: number; lines: string[] } | undefined
  const close = (): void => {
    if (current !== undefined) hunks.push(numberHunk(current.oldStart, current.newStart, current.lines))
  }
  for (const line of text.split('\n')) {
    const header = HUNK_HEADER.exec(line)
    if (header !== null) {
      close()
      current = {
        oldStart: startOf(Number(header[1]), header[2] === undefined ? undefined : Number(header[2])),
        newStart: startOf(Number(header[3]), header[4] === undefined ? undefined : Number(header[4])),
        lines: [],
      }
    } else if (current !== undefined && (line.startsWith(' ') || line.startsWith('-') || line.startsWith('+') || line.startsWith('\\'))) {
      current.lines.push(line)
    }
  }
  close()
  return hunks
}

/** jsdiff's reading of the patch; undefined when it refuses it. */
function jsdiffHunks(text: string, path: string): PatchHunk[] | undefined {
  // Synthesize the file headers jsdiff expects before the first hunk.
  const first = text.search(/^@@ /mu)
  const preamble = first === -1 ? text : text.slice(0, first)
  const withHeaders = /^--- /mu.test(preamble) ? text : `--- a/${path}\n+++ b/${path}\n${text}`
  try {
    const files = JsDiff.parsePatch(withHeaders)
    return files.flatMap(file => file.hunks.map(hunk => numberHunk(hunk.oldStart, hunk.newStart, hunk.lines)))
  } catch {
    return undefined
  }
}

/** A raw-content add/delete as one hunk of added/removed lines. */
function contentHunk(text: string, kind: 'add' | 'delete'): PatchHunk {
  const body = text.endsWith('\n') ? text.slice(0, -1) : text
  const marker = kind === 'add' ? '+' : '-'
  return numberHunk(1, 1, body === '' ? [] : body.split('\n').map(line => `${marker}${line}`))
}

const CACHE_LIMIT = 64
const cache = new Map<string, ParsedPatch>()

/** Parse one file's patch (cached by its text, path and change kind). */
export function parseFilePatch(diff: ToolPatchDiff): ParsedPatch {
  const key = `${diff.change ?? ''}\u0000${diff.path}\u0000${diff.patch}`
  const known = cache.get(key)
  if (known !== undefined) return known
  let hunks = /^@@ -\d/mu.test(diff.patch) ? jsdiffHunks(diff.patch, diff.path) ?? lenientHunks(diff.patch) : []
  if (hunks.length === 0 && (diff.change === 'add' || diff.change === 'delete') && diff.patch !== '') hunks = [contentHunk(diff.patch, diff.change)]
  let added = 0
  let removed = 0
  let maxLineNo = 0
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.kind === 'add') added += 1
      else if (line.kind === 'del') removed += 1
      maxLineNo = Math.max(maxLineNo, line.oldNo ?? 0, line.newNo ?? 0)
    }
  }
  const raw = hunks.length === 0 && diff.patch.trim() !== '' ? diff.patch.replace(/\n$/u, '').split('\n') : undefined
  const parsed: ParsedPatch = { hunks, added, removed, maxLineNo, ...(raw === undefined ? {} : { raw }) }
  if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value!)
  cache.set(key, parsed)
  return parsed
}

/** A moved file's destination (absent when it did not move). */
const movedTo = (diff: ToolPatchDiff): string | undefined =>
  diff.movePath === undefined || diff.movePath === diff.path ? undefined : diff.movePath

/** The change-kind word of an added / deleted file. */
const changeLabel = (diff: ToolPatchDiff): string | undefined =>
  diff.change === 'add' ? t('diff-patch-added') : diff.change === 'delete' ? t('diff-patch-deleted') : undefined

/**
 * The header a patch file renders above its hunks. In a multi-file card
 * every file gets a path row (`path` / `path → moved`, clickable, opening
 * `target`) followed by a dim `suffix` (` · new file (+3 -0)`). A lone file
 * already has its path in the card title, so it gets only the dim stat
 * line (`(+1 -1)`, `new file (+3 -0)`, `→ moved.ts (+1 -1)`).
 */
export type PatchHeader =
  | { readonly kind: 'path'; readonly path: string; readonly target: string; readonly suffix: string }
  | { readonly kind: 'stat'; readonly text: string }

export function patchHeader(diff: ToolPatchDiff, parsed: ParsedPatch, multiFile: boolean): PatchHeader {
  const moved = movedTo(diff)
  const label = changeLabel(diff)
  const stat = `(+${parsed.added} -${parsed.removed})`
  if (multiFile) {
    return {
      kind: 'path',
      path: moved === undefined ? diff.path : `${diff.path} → ${moved}`,
      target: moved ?? diff.path,
      suffix: `${label === undefined ? '' : ` · ${label}`} ${stat}`,
    }
  }
  return { kind: 'stat', text: [moved === undefined ? undefined : `→ ${moved}`, label, stat].filter((part): part is string => part !== undefined).join(' ') }
}

/** The plain text of a header (split view separators, tests). */
export const patchHeaderText = (header: PatchHeader): string => header.kind === 'path' ? `${header.path}${header.suffix}` : header.text
