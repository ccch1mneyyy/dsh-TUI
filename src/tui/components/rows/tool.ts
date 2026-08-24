/**
 * Tool-call card row for the pi-tui transcript (plan §1.3, WP-03).
 *
 * String-building port of `src/components/messages/AssistantToolUseMessage.tsx`
 * (+ `ToolUseLoader`'s status dot): `● Name(args)` header with a status glyph
 * (running `●` dim / settled `•` in the tool-category color / error `✗`), then
 * the structured body — the dsh-tools presentation view (diff hunks, terminal
 * output, read content, search results) or the raw result text as fallback —
 * hanging under a ` ⎿ ` gutter with per-tone colors.
 *
 * Deliberate simplifications vs the old yoga layout:
 * - Diffs always render unified (flat `- `/`+ ` red/green lines); the
 *   two-pane `SplitDiffView` (jsdiff re-alignment, word highlights, syntax
 *   tinting) is not ported — the task fixes diff rendering to the prefixed
 *   red/green line format with fixed-width clipping.
 * - No `SyntaxText` highlighting in the header args or read/generic bodies.
 * - No tool-card background fill (`toolBackground` pref) and no trajectory
 *   footnote line (the failure-hint row id is not in TranscriptProjection).
 * - Bodies wrap with the plain-text `wrapWidth` (word boundary, CJK-safe).
 */
import chalk from 'chalk'
import { truncateToWidth } from '../../public.js'
import type {
  ToolCallView,
  ToolFileDiff,
  ToolResultView,
  ToolRow,
} from '../../../dsh-adapter/channel.js'
import { formatDuration } from '../../../cc/format.js'
import { BLACK_CIRCLE, BULLET, MULTIPLICATION_X } from '../../../cc/figures.js'
import { wrapWidth } from '../../../sessions/format.js'
import type { Theme } from '../../../theme.js'
import { fg } from './style.js'
import { CachedRow } from './shared.js'

// --- tool naming / coloring (ported from the old card + status dot) --------

/** DSH emits lowercase tool ids (`bash`); CC shows capitalized (`Bash`). */
function displayName(name: string): string {
  const KNOWN: Record<string, string> = {
    bash: 'Bash',
    powershell: 'PowerShell',
    read: 'Read',
    glob: 'Glob',
    grep: 'Grep',
    write: 'Write',
    edit: 'Edit',
    todo_write: 'TodoWrite',
    subagent: 'Task',
    web_search: 'WebSearch',
  }
  const mapped = KNOWN[name]
  if (mapped !== undefined) return mapped
  if (name.length === 0) return name
  return name[0]!.toUpperCase() + name.slice(1)
}

const TOOL_NAME_MUTATE = new Set(['edit', 'write', 'multiedit', 'notebookedit'])
const TOOL_NAME_EXEC = new Set(['bash', 'bashpersistent', 'sh', 'shell', 'terminal'])

/** Tool-name color by category: read/search brand blue, file-mutating warm
 *  gold, exec/terminal mist cyan. Exported for the subagent card, which
 *  mirrors the transcript tool-card name styling. */
export function toolNameColor(raw: string): keyof Theme {
  const n = raw.toLowerCase()
  if (TOOL_NAME_MUTATE.has(n)) return 'toolNameMutate'
  if (TOOL_NAME_EXEC.has(n)) return 'toolNameExec'
  return 'claude'
}

type ToolCategory = 'exec' | 'read' | 'write' | 'web' | 'task' | 'default'

const CATEGORY_BY_TOOL: Record<string, ToolCategory> = {
  bash: 'exec',
  powershell: 'exec',
  pwsh: 'exec',
  read: 'read',
  grep: 'read',
  glob: 'read',
  search: 'read',
  file_search: 'read',
  edit: 'write',
  write: 'write',
  str_replace_editor: 'write',
  multiedit: 'write',
  web_search: 'web',
  web_fetch: 'web',
  browser: 'web',
  subagent: 'task',
  task: 'task',
  job: 'task',
  workflow: 'task',
}

const CATEGORY_TOKEN: Record<ToolCategory, keyof Theme> = {
  exec: 'toolDotExec',
  read: 'toolDotRead',
  write: 'toolDotWrite',
  web: 'toolDotWeb',
  task: 'toolDotTask',
  default: 'success',
}

// --- structured body lines --------------------------------------------------
// The tool's presentation view becomes per-line render intents. CC
// convention: the body hangs under a ` ⎿ ` gutter (first line) / blank
// continuation, so tool output reads as nested under its header.

type BodyTone = 'add' | 'del' | 'dim' | 'plain' | 'error' | 'path'
interface BodyLine {
  readonly text: string
  readonly tone: BodyTone
}

/** CC's collapsed text body keeps 3 lines (renderTruncatedContent). */
const TEXT_BODY_MAX_LINES = 3
/** Diff bodies cap at the upstream chat row's 8 (CHAT_DIFF_MAX_LINES). */
const DIFF_BODY_MAX_LINES = 8
/** Header args budget: the parenthesized summary is a pointer, not the
 *  payload — full args live in the verbose/expanded body. */
const HEADER_ARGS_BUDGET = 480

const GUTTER_FIRST = ' ⎿ '
const GUTTER_REST = '   '

const add = (text: string): BodyLine => ({ text, tone: 'add' })
const del = (text: string): BodyLine => ({ text, tone: 'del' })
const dimLine = (text: string): BodyLine => ({ text, tone: 'dim' })
const plain = (text: string): BodyLine => ({ text, tone: 'plain' })

/** One side's text → display lines (upstream contentLines rule: empty text
 *  is zero lines; a single trailing newline is a terminator, not a line). */
function sideLines(text: string): string[] {
  if (text === '') return []
  const lines = text.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  return lines
}

/** Diff hunks → add/del rows; with several files a path row separates them
 *  and `⋯` separates scattered hunks of one file (upstream DiffBlock). */
function diffLines(diffs: readonly ToolFileDiff[]): BodyLine[] {
  const out: BodyLine[] = []
  let prevPath: string | undefined
  for (const diff of diffs) {
    if (diffs.length > 1) {
      if (diff.path !== prevPath) out.push({ text: diff.path, tone: 'path' })
      else out.push(dimLine('⋯'))
    }
    prevPath = diff.path
    if (diff.oldText !== null) {
      for (const line of sideLines(diff.oldText)) out.push(del(`- ${line}`))
    }
    for (const line of sideLines(diff.newText)) out.push(add(`+ ${line}`))
  }
  return out
}

/** Join the text blocks of a view's content payload (read/generic cards). */
function contentLines(
  content: ReadonlyArray<{ readonly type: string; readonly text?: string }> | undefined,
): BodyLine[] {
  const text = (content ?? [])
    .map((block) => (block.type === 'text' ? (block.text ?? '') : ''))
    .join('')
    .trimEnd()
  if (text === '') return []
  return text.split('\n').map(plain)
}

/** Per-card body lines; unknown/absent shapes yield [] so the caller falls
 *  back to the raw result text. */
function viewLines(view: ToolCallView | ToolResultView): BodyLine[] {
  switch (view.card) {
    case 'diff':
      return diffLines(view.diffs)
    case 'terminal': {
      // The call-side terminal card has no output yet; only presentResult's
      // does. `in` narrows the call/result union without extra types.
      const out = (('output' in view ? view.output : undefined) ?? '').trimEnd()
      const lines: BodyLine[] = out === '' ? [] : out.split('\n').map(plain)
      if ('exitCode' in view && view.exitCode !== undefined && view.exitCode !== 0) {
        lines.push({ text: `Exit code ${view.exitCode}`, tone: 'error' })
      }
      if ('signal' in view && view.signal !== undefined) {
        lines.push({ text: `Killed by signal ${view.signal}`, tone: 'error' })
      }
      return lines
    }
    case 'read':
      return contentLines('content' in view ? view.content : undefined)
    case 'generic':
      return contentLines('content' in view ? view.content : undefined)
    case 'search': {
      if (view.shape === 'paths') {
        const lines = view.paths.map(plain)
        if (view.truncated) lines.push(dimLine(`… (${view.total} total)`))
        return lines
      }
      const lines: BodyLine[] = []
      for (const file of view.files) {
        lines.push(plain(file.path))
        for (const match of file.matches) {
          lines.push(plain(`${match.lineNumber}: ${match.line}`))
        }
      }
      if (view.truncated) lines.push(dimLine(`… (${view.total} total)`))
      return lines
    }
    default:
      return []
  }
}

/** Collapsed bodies fold past the card's line budget; verbose (Ctrl+O) is
 *  always uncapped. Mirrors the old "one extra line is shown directly". */
function capLines(lines: readonly BodyLine[], max: number, verbose: boolean): BodyLine[] {
  if (verbose || lines.length <= max) return [...lines]
  if (lines.length - max === 1) return [...lines]
  return [...lines.slice(0, max), dimLine(`… +${lines.length - max} lines (ctrl+o to expand)`)]
}

function clipHeaderArgs(args: string): string {
  if (args.length <= HEADER_ARGS_BUDGET) return args
  return `${args.slice(0, HEADER_ARGS_BUDGET)}…`
}

function toneColor(tone: BodyTone, text: string): string {
  switch (tone) {
    case 'add':
      return fg('diffAddedWord', text)
    case 'del':
      return fg('diffRemovedWord', text)
    case 'error':
      return fg('error', text)
    case 'dim':
      return chalk.dim(text)
    case 'path':
      return fg('ide', text)
    default:
      return text
  }
}

/** The gutter carries the add/del/path tint too (old card behavior). */
function gutterColor(tone: BodyTone, text: string): string {
  switch (tone) {
    case 'add':
      return fg('diffAddedWord', text)
    case 'del':
      return fg('diffRemovedWord', text)
    case 'path':
      return fg('ide', text)
    default:
      return chalk.dim(text)
  }
}

export class ToolCardRow extends CachedRow {
  protected build(width: number, marginTop: boolean): string[] {
    const tool = this.row.tool
    if (tool === undefined) return []
    // Verbose = global Ctrl+O OR this card's own click toggle (source parity:
    // `verbose = isExpanded || expanded`).
    const verbose = this.ctx.expanded || this.ctx.expandedRows.has(this.row.id)
    const isRunning = tool.status === 'running'
    const isError = tool.status === 'error'
    const result = tool.resultFull ?? tool.resultText
    // The settled view carries the applied diff / actual output; while
    // running, the call view already shows the pending change.
    const view = tool.resultView ?? tool.callView

    const out: string[] = marginTop ? [''] : []
    out.push(truncateToWidth(this.headerLine(tool, view, verbose), width, '…'))

    // --- body --------------------------------------------------------------
    let body: BodyLine[] = []
    if (isError) {
      if (tool.errorText !== undefined && tool.errorText !== '') {
        body = [{ text: tool.errorText, tone: 'error' }]
      }
    } else {
      if (view !== undefined) body = viewLines(view)
      if (body.length === 0 && result !== undefined && result !== '') {
        body = result.trimEnd().split('\n').map(plain)
      }
      if (isRunning && body.length === 0) {
        const elapsed = formatDuration(Math.max(0, Date.now() - tool.startedAt))
        body = [dimLine(`Running… (${elapsed})`)]
      }
    }
    const cap = view?.card === 'diff' ? DIFF_BODY_MAX_LINES : TEXT_BODY_MAX_LINES

    const bodyWidth = Math.max(1, width - 3)
    for (const line of capLines(body, cap, verbose)) {
      const wrapped = wrapWidth(line.text === '' ? ' ' : line.text, bodyWidth)
      for (let segment = 0; segment < wrapped.length; segment++) {
        const gutter =
          segment === 0 ? gutterColor(line.tone, GUTTER_FIRST) : GUTTER_REST
        out.push(gutter + toneColor(line.tone, wrapped[segment]!))
      }
    }
    return out
  }

  /** `● Edit /path` header: status dot + bold name/title + settled elapsed. */
  private headerLine(
    tool: ToolRow,
    view: ToolCallView | ToolResultView | undefined,
    verbose: boolean,
  ): string {
    const isRunning = tool.status === 'running'
    const isError = tool.status === 'error'
    const name = displayName(tool.name)
    const nameColor = toolNameColor(tool.name)

    let glyph: string
    if (isError) {
      glyph = fg('error', MULTIPLICATION_X)
    } else if (isRunning) {
      glyph = chalk.dim(BLACK_CIRCLE)
    } else {
      const category = CATEGORY_BY_TOOL[tool.name] ?? 'default'
      glyph = fg(CATEGORY_TOKEN[category], BULLET)
    }

    // presentResult may omit a title (terminal results carry output, not a
    // command) — then the call view's title stands.
    const title = tool.resultView?.title ?? tool.callView?.title
    let titleText: string
    if (title === undefined) {
      const displayArgs = verbose ? (tool.argsFull ?? tool.argsText) : tool.argsText
      titleText =
        chalk.bold(fg(nameColor, name)) +
        (displayArgs === '' ? '' : `(${clipHeaderArgs(displayArgs)})`)
    } else if (view?.card === 'terminal') {
      titleText = `${chalk.bold(fg(nameColor, name))}(${title})`
    } else {
      const trimmed = title.trim()
      if (trimmed === '') {
        titleText = chalk.bold(fg(nameColor, name))
      } else {
        const space = trimmed.indexOf(' ')
        const head = space === -1 ? trimmed : trimmed.slice(0, space)
        const tail = space === -1 ? '' : trimmed.slice(space)
        titleText = chalk.bold(fg(nameColor, head)) + tail
      }
    }

    // Live elapsed while running lives in the body's "Running…" fallback;
    // the header shows the settled duration only (old card behavior).
    const elapsed = !isRunning && tool.durationMs !== undefined
      ? chalk.dim(` · ${formatDuration(tool.durationMs)}`)
      : ''
    return `${glyph} ${titleText}${elapsed}`
  }
}
