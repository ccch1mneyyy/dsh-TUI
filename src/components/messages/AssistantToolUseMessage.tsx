import React from 'react'
import { extname } from 'node:path'
import { Box, Text, useTerminalSize } from '../../ui.js'
import { stringWidth } from '../../ink/stringWidth.js'
import { useAnimationFrame } from '../../ink/hooks/use-animation-frame.js'
import type { ToolCallView, ToolFileDiff, ToolResultView, ToolRow } from '../../dsh-adapter/channel.js'
import { ToolUseLoader } from '../ToolUseLoader.js'
import { SplitDiffView } from '../SplitDiffView.js'
import { SyntaxText } from '../SyntaxText.js'
import { useTooltip } from '../Tooltip.js'
import { formatDuration } from '../../terminal-utils/format.js'
import { formatClock } from '../../trajectory/format.js'
import { foldLongLines } from '../../utils/fold-long-lines.js'
import { getLang, t, tOr, type I18nKey } from '../../i18n.js'
import type { ToolBackground } from '../../tuiDisplayPrefs.js'
import type { Theme } from '../../theme.js'
import type { ClickEvent } from '../../ink/events/click-event.js'
import { revealLinesOf, snapReveal } from '../smoothReveal.js'
import { useRevealVersion } from '../../hooks/useRevealVersion.js'
import { primaryComboString } from '../../utils/keymap.js'
import { agentMessageStateColor, agentMessageStateText } from './TranscriptLeaves.js'
import type { AgentMessageState } from './agentTeam.js'

type Props = {
  tool: ToolRow
  /** Adds the top margin between messages. */
  marginTopOnTurn: boolean
  /** Ctrl+O verbose: show full args/result instead of previews. */
  verbose: boolean
  /** Message-selection mode highlight. */
  isSelected?: boolean
  /** Row expanded on its own (persistent hover-grey background). */
  isExpanded?: boolean
  /**
   * Mouse click (fullscreen): toggles the row's expansion — same action as
   * clicking other transcript rows. Also makes the localized ctrl+o expand
   * hint (lines-folded-expand) actionable with the mouse.
   */
  onClick?(event: ClickEvent): void
  /**
   * Trajectory pointer, rendered as one more `⎿` line under a failed call.
   *
   * It appears on the NEWEST unseen failure only, so a session with a dozen
   * failed calls still shows exactly one pointer — the moment of failure is
   * where the trajectory is worth mentioning, and mentioning it twelve times
   * is worth less than mentioning it once.
   */
  footnote?: string
  /** Diff presentation preference; `auto` picks by terminal width. */
  diffLayout?: 'auto' | 'split' | 'unified'
  /** Background treatment for the ordinary, unselected tool card surface. */
  toolBackground?: ToolBackground
  /**
   * Click-to-act (fullscreen): opens the file-action menu for the tool's
   * file path. When provided, the path in the card header (and diff path
   * rows) renders underlined and clickable; the click stops propagation so
   * the row's own fold-toggle does not fire.
   */
  onOpenFile?: (path: string) => void
  /**
   * Terminal-card header folding (settings `dsh-tui.foldTerminalCommand`):
   * collapsed cards keep the command title's first source line plus a
   * `+N lines` hint; verbose/expanded cards render the full title.
   */
  foldTerminalCommand?: boolean
  /**
   * Smooth streaming reveal (settings `dsh-tui.smoothStreaming`): the card
   * BODY (diff hunks / write content — model-authored prose, not tool
   * output) paints through an even ~30fps line reveal when it first appears,
   * instead of one jarring block. Only the pending CALL view animates; the
   * settled result view paints complete (real output is progress, not
   * prose), and so do replayed cards.
   */
  smoothReveal?: boolean
  /** Live-arrived row (channel `fresh`): gates reveal participation —
   *  replayed cards must paint complete. */
  fresh?: boolean
  /** Reveal version supplied by MessageList to avoid one store subscriber per card. */
  revealVersion?: number
  /** The transcript window cap folded this row's source: full args/result
   *  payloads were dropped (the session log retains them) and only previews
   *  remain — the expanded card says so instead of passing the preview off
   *  as the full text. */
  sourceFolded?: boolean
}

/** Tool display names localize through the `tool-name-*` dictionary family
 *  (i18n.ts): DSH emits lowercase tool ids (`bash`), display names resolve
 *  per language — proper nouns (Bash, PowerShell) stay identical in zh.
 *  Unmapped ids (plugins, new upstream tools) fall back to the id with its
 *  first letter uppercased: that is a name, not copy — there is nothing to
 *  translate. Keys appear as literals here, so verify-i18n's dead-key scan
 *  sees them without a DYNAMIC_PREFIXES entry. */
const TOOL_NAME_KEYS: Record<string, I18nKey> = {
  bash: 'tool-name-bash',
  powershell: 'tool-name-powershell',
  read: 'tool-name-read',
  glob: 'tool-name-glob',
  grep: 'tool-name-grep',
  write: 'tool-name-write',
  edit: 'tool-name-edit',
  todo_write: 'tool-name-todo_write',
  subagent: 'tool-name-subagent',
  web_search: 'tool-name-web_search',
}

function displayName(name: string, displayKey?: string): string {
  // A backend that names its tools its own way (Claude `Read`, `Bash`)
  // supplies the key with the card view; the raw name is the fallback.
  if (displayKey !== undefined) return tOr(displayKey, name)
  const key = TOOL_NAME_KEYS[name]
  if (key !== undefined) return t(key)
  if (name.length === 0) return name
  return name[0]!.toUpperCase() + name.slice(1)
}

function parseJsonArgs(args: string): unknown {
  try { return JSON.parse(args) } catch { return undefined }
}

function jsonArgsLanguage(args: string): 'json' | undefined {
  return parseJsonArgs(args) === undefined ? undefined : 'json'
}

// --- SendMessage dedicated card (design agent-team-full §5.4 父工具卡) -------

/** The CC relay tool as the card claims it. Task* delegations already have
 *  a first-class surface (the subagent card + waterfall), so the raw-JSON
 *  dump this card replaces is SendMessage's alone — a second message-style
 *  card for Task would duplicate that surface. */
const SEND_MESSAGE_TOOL = 'SendMessage'

/** What the SendMessage card needs from the call's args: the addressed
 *  target (pin.name, else the `to` short id), the body, the summary and
 *  the resume mark. Redundant transport fields (to/type/recipient/content)
 *  never render — they live in the raw layer only. */
interface SendMessageCard {
  readonly target: string
  readonly resuming: boolean
  readonly text: string
  readonly summary?: string
}

const recOf = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
const strOf = (value: unknown): string | undefined =>
  typeof value === 'string' && value !== '' ? value : undefined

/** Parse one SendMessage call; undefined when the args are not the
 *  recognizable relay shape (then the generic card stands). */
function sendMessageCardOf(tool: ToolRow): SendMessageCard | undefined {
  if (tool.name !== SEND_MESSAGE_TOOL) return undefined
  const args = recOf(parseJsonArgs(tool.argsFull ?? tool.argsText))
  if (args === undefined) return undefined
  const to = strOf(args.to) ?? strOf(args.recipient)
  const text = strOf(args.message) ?? strOf(args.text)
  if (to === undefined || text === undefined) return undefined
  const pin = recOf(args.pin)
  const pinName = strOf(pin?.name)
  const target = pinName ?? (to.length > 8 ? `${to.slice(0, 8)}…` : to)
  return {
    target,
    resuming: args.resuming === true || args.resume === true,
    text,
    ...(strOf(args.summary) === undefined ? {} : { summary: strOf(args.summary) }),
  }
}

/** The states a structured result may explicitly name (agent-team §5.2). */
const SEND_MESSAGE_EXPLICIT: Readonly<Record<string, AgentMessageState>> = Object.freeze({
  delivered: 'delivered',
  held: 'held',
  refused: 'refused',
  expired: 'expired',
})

/** The settled state of one SendMessage card — the UI-side mirror of
 *  backends/claude/send-message.ts's rules (UI layers must not import
 *  backends, verify:boundary): a call alone is `issued`; an error result is
 *  a refusal fact; a structured `delivery`/`status` field naming a state
 *  marks exactly that; any other shape — including bare success — is
 *  `unknown`, never a guessed delivery. */
function sendMessageCardState(tool: ToolRow): AgentMessageState {
  if (tool.status === 'running') return 'issued'
  if (tool.status === 'error') return 'refused'
  const structured = recOf(parseJsonArgs(tool.resultFull ?? tool.resultText ?? ''))
  if (structured !== undefined) {
    for (const key of ['delivery', 'status'] as const) {
      const named = SEND_MESSAGE_EXPLICIT[strOf(structured[key]) ?? '']
      if (named !== undefined) return named
    }
  }
  return 'unknown'
}

/** The resumed fact of a structured result: resumedAgentId, or the pin's
 *  agent id — displayed as「已唤醒 <短id>」. */
function sendMessageResumedOf(tool: ToolRow): string | undefined {
  if (tool.status === 'running') return undefined
  const structured = recOf(parseJsonArgs(tool.resultFull ?? tool.resultText ?? ''))
  if (structured === undefined) return undefined
  const resumed = strOf(structured.resumedAgentId) ?? strOf(recOf(structured.pin)?.agentId) ?? strOf(recOf(structured.pin)?.id)
  return resumed === undefined ? undefined : resumed.length > 8 ? `${resumed.slice(0, 8)}…` : resumed
}

function filePathFromTool(tool: ToolRow, view: ToolCallView | ToolResultView | undefined): string | undefined {
  if (view !== undefined && 'path' in view && typeof view.path === 'string') return view.path
  const parsed = parseJsonArgs(tool.argsFull ?? tool.argsText)
  if (parsed !== null && typeof parsed === 'object') {
    const record = parsed as Record<string, unknown>
    for (const key of ['file_path', 'path']) if (typeof record[key] === 'string') return record[key]
  }
  return undefined
}

function languageFromPath(path: string | undefined): string | undefined {
  const language = path === undefined ? undefined : extname(path).slice(1).toLowerCase()
  return language === '' ? undefined : language
}

// --- structured body lines --------------------------------------------------
// The tool's presentation view (dsh-tools presentCall/presentResult, captured
// by the channel) becomes per-line render intents here. The convention is:
// body hangs under a `  ⎿  ` gutter (first line) / blank continuation, so
// tool output is visually nested under its header instead of flush-left.

/** `hint` is the trajectory pointer: recessive, never competing with output. */
type BodyTone = 'add' | 'del' | 'dim' | 'plain' | 'error' | 'hint' | 'path'
type BodyLine = {
  readonly text: string
  readonly tone: BodyTone
  /** The row's collapse hint: dim at rest, steps to text while hovered so the
   *  toggle reads before the click (the compaction row's pattern). */
  readonly revealOnHover?: boolean
}

/** The collapsed text body keeps three lines. */
const TEXT_BODY_MAX_LINES = 3
/** Diff bodies cap at the upstream chat row's 8 (dsh-client-ui-tool's
 *  CHAT_DIFF_MAX_LINES) — denser information than log output. */
const DIFF_BODY_MAX_LINES = 8
/** Minimum terminal width for the two-pane diff: below this the panes
 *  would squeeze under ~50 columns each and the unified view reads better. */
const SPLIT_DIFF_MIN_COLS = 110
/** Verbose (Ctrl+O / expanded) bodies render through a bounded line window:
 *  a full result can be tens of thousands of lines, and laying that out in
 *  one render builds a Yoga tree the frame budget cannot pay. The window
 *  keeps the head readable and says exactly how much of the retained source
 *  it is showing — the source itself keeps every line. */
const VERBOSE_BODY_WINDOW = 400

const GUTTER_FIRST = ' ⎿ '
const GUTTER_REST = '   '

const add = (text: string): BodyLine => ({ text, tone: 'add' })
const del = (text: string): BodyLine => ({ text, tone: 'del' })
const dim = (text: string): BodyLine => ({ text, tone: 'dim' })
const plain = (text: string): BodyLine => ({ text, tone: 'plain' })

/** Tool-name color by category (mist-blue accents): read/search tools keep
 *  the brand blue, file-mutating tools get the warm gold accent, exec /
 *  terminal tools get mist cyan. Exported for the subagent card, which
 *  mirrors the transcript tool-card name styling. */
const TOOL_NAME_MUTATE = new Set(['edit', 'write', 'multiedit', 'notebookedit'])
const TOOL_NAME_EXEC = new Set(['bash', 'bashpersistent', 'sh', 'shell', 'terminal'])
export function toolNameColor(raw: string, category?: 'mutate' | 'exec' | 'other'): keyof Theme {
  // A backend-declared colour family wins over the id heuristics below.
  if (category === 'mutate') return 'toolNameMutate'
  if (category === 'exec') return 'toolNameExec'
  if (category === 'other') return 'accent'
  const n = raw.toLowerCase()
  if (TOOL_NAME_MUTATE.has(n)) return 'toolNameMutate'
  if (TOOL_NAME_EXEC.has(n)) return 'toolNameExec'
  return 'accent'
}

/** One side's text → display lines (upstream contentLines rule: empty text
 *  is zero lines; a single trailing newline is a terminator, not a line;
 *  interior blanks survive). */
function sideLines(text: string): string[] {
  if (text === '') return []
  const lines = text.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  return lines
}

/** Diff hunks → add/del rows. The header already carries the path for the
 *  common single-hunk case; with several hunks a path row separates files
 *  and `⋯` separates scattered hunks of one file (upstream DiffBlock). */
function diffLines(diffs: readonly ToolFileDiff[]): BodyLine[] {
  const out: BodyLine[] = []
  let prevPath: string | undefined
  for (const diff of diffs) {
    if (diffs.length > 1) {
      if (diff.path !== prevPath) out.push({ text: diff.path, tone: 'path' })
      else out.push(dim('⋯'))
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
function contentLines(content: ReadonlyArray<{ readonly type: string; readonly text?: string }> | undefined): BodyLine[] {
  const text = (content ?? []).map(block => (block.type === 'text' ? block.text ?? '' : '')).join('').trimEnd()
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
      // does. `in` narrows the call/result union without extra types. The
      // exit-code / signal lines are NOT body content: the component renders
      // them after the line cap (see terminalExitLines) so a long output can
      // never fold the failure verdict away.
      const out = (('output' in view ? view.output : undefined) ?? '').trimEnd()
      return out === '' ? [] : out.split('\n').map(plain)
    }
    case 'read':
      return contentLines('content' in view ? view.content : undefined)
    case 'generic':
      return contentLines('content' in view ? view.content : undefined)
    case 'search': {
      if (view.shape === 'paths') {
        const lines = view.paths.map(plain)
        if (view.truncated) lines.push(dim(t('search-results-total', { n: view.total })))
        return lines
      }
      const lines: BodyLine[] = []
      for (const file of view.files) {
        lines.push(plain(file.path))
        for (const match of file.matches) {
          lines.push(plain(`${match.lineNumber}: ${match.line}`))
        }
      }
      if (view.truncated) lines.push(dim(`… (${view.total} total)`))
      return lines
    }
    default:
      return []
  }
}

/** Compact char counter for fold hints (1.2k / 3.4M). */
function compactChars(count: number): string {
  if (count < 10_000) return String(count)
  if (count < 10_000_000) return `${(count / 1000).toFixed(1)}k`
  return `${(count / 1_000_000).toFixed(1)}M`
}

/** Fold-hint parts: "3 行", "1.2k 字符" or "3 行 · 1.2k 字符" — one count per
 *  fold kind that actually hid something, composed in the localized unit
 *  words so the sentence grammar stays with i18n. */
function foldHintParts(hiddenLines: number, hiddenChars: number): string {
  const parts: string[] = []
  if (hiddenLines > 0) parts.push(t('tool-card-lines-unit', { n: hiddenLines }))
  if (hiddenChars > 0) parts.push(t('tool-card-chars-unit', { n: compactChars(hiddenChars) }))
  return parts.join(' · ')
}

/** Collapsed bodies fold past the card's line budget; verbose (Ctrl+O) is
 *  always uncapped. Mirrors wrapText's "one extra line is shown directly".
 *  A lines-only fold keeps the historical shared hint (lines-folded-expand)
 *  byte-identical; a fold that also (or only) clipped CHARACTERS inside long
 *  lines uses the combined indicator so the hidden volume stays honest. */
function capLines(lines: BodyLine[], max: number, verbose: boolean, hiddenChars: number): BodyLine[] {
  if (verbose || lines.length <= max) return lines
  if (lines.length - max === 1) return lines
  const hiddenLines = lines.length - max
  // Chars clipped inside the VISIBLE lines carry their own inline marker
  // (fold-long-lines); the hint aggregates what the line fold hid — the
  // clipped characters of the sliced-away rows included — so "how much is
  // hidden" answers in one place. A lines-only fold keeps the historical
  // shared hint byte-identical.
  const hint = hiddenChars > 0
    ? { ...dim(t('tool-card-lines-hidden', { parts: foldHintParts(hiddenLines, hiddenChars), key: primaryComboString('transcript') })), revealOnHover: true }
    : { ...dim(t('lines-folded-expand', { n: hiddenLines, key: primaryComboString('transcript') })), revealOnHover: true }
  return [...lines.slice(0, max), hint]
}

/** Long-line clip for the body rows (utils/fold-long-lines.ts): the line cap
 *  above bounds how MANY rows a card paints, this bounds how many rows ONE
 *  row can paint. A `read` of a minified file, a terminal result whose last
 *  line never broke, or a `write` payload is a single 100k-char line — under
 *  `wrap="wrap"` the body would lay out thousands of visual rows per frame
 *  no matter what the line budget says. Identity-preserving (same array, same
 *  line objects) when every line fits, so the ordinary card allocates
 *  nothing. */
function foldBodyLines(lines: BodyLine[]): { lines: BodyLine[]; hiddenChars: number } {
  let out: BodyLine[] | undefined
  let hiddenChars = 0
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!
    const folded = foldLongLines(line.text)
    if (folded.hiddenChars === 0) {
      out?.push(line)
      continue
    }
    out ??= lines.slice(0, index)
    out.push({ ...line, text: folded.text })
    hiddenChars += folded.hiddenChars
  }
  return out === undefined ? { lines, hiddenChars: 0 } : { lines: out, hiddenChars }
}

/** Header title from the presentation view: terminal cards keep the
 *  `Name(command)` shape; everything else renders the tool's own title
 *  (`Edit /path`, `Read /path (1 - 100)`) with the first word bold. The
 *  result view's title replaces the call view's only when present — a
 *  settled terminal card carries output but no title of its own. */
/** Header args display budget: the parenthesized summary is a pointer, not
 * the payload — full args live in the verbose/expanded body. A streaming
 * tool call's args can grow to hundreds of KB, and wrapping that in the
 * header Text every frame was the dominant long-output stall (string-width
 * via wrap-ansi, 60%+ of CPU in profiles). */
const HEADER_ARGS_BUDGET = 480

function clipHeaderArgs(args: string): string {
  if (args.length <= HEADER_ARGS_BUDGET) return args
  return `${args.slice(0, HEADER_ARGS_BUDGET)}…`
}

/** Terminal-card header folding shape: the line actually rendered, the source
 *  lines the multi-line fold hid, and the characters the long-line clip hid. */
type FoldedTitle = { first: string; hiddenLines: number; hiddenChars: number }

/** Fold a multi-line terminal command title to its first SOURCE line.
 *  Counts '\n' separators in place instead of materializing a line array —
 *  running cards re-render every second and a streamed command can reach
 *  hundreds of KB, and the exact cost the HEADER_ARGS_BUDGET comment above
 *  keeps out of the header must not sneak back in through folding. (Lone-\r
 *  titles are not a thing presentCall produces; CRLF is normalized on the
 *  first line only.)
 *
 *  Two independent folds:
 *   - `foldLines` (the `dsh-tui.foldTerminalCommand` setting): a multi-line
 *     script collapses to its first source line, reported as `+N lines`.
 *   - The long-line clip (always on — utils/fold-long-lines.ts): a command is
 *     frequently ONE enormous line (`python -c …`, a minified blob, a pasted
 *     `curl` body). This header Text WRAPS, so an unclipped 200k-char command
 *     lays out thousands of rows on the card header itself — the same stall
 *     HEADER_ARGS_BUDGET keeps out of the args half of the line.
 *
 *  Single short titles return undefined: nothing to fold, rendering stays
 *  byte-identical to the unfolded card (and the header stays tooltip-silent). */
function foldTerminalTitle(title: string, foldLines: boolean): FoldedTitle | undefined {
  const firstEnd = title.indexOf('\n')
  let hiddenLines = 0
  let body = title
  if (firstEnd !== -1 && foldLines) {
    let separators = 1
    for (let at = title.indexOf('\n', firstEnd + 1); at !== -1; at = title.indexOf('\n', at + 1)) separators++
    // Same trailing-newline rule as sideLines: a terminator is not a line.
    hiddenLines = separators - (title.endsWith('\n') ? 1 : 0)
    body = title.slice(0, title.charCodeAt(firstEnd - 1) === 13 ? firstEnd - 1 : firstEnd)
  }
  const clipped = foldLongLines(body)
  if (hiddenLines <= 0 && clipped.hiddenChars === 0) return undefined
  return { first: clipped.text, hiddenLines: Math.max(0, hiddenLines), hiddenChars: clipped.hiddenChars }
}

/** Addendum line appended to the header hover tooltip when the header hides
 *  content (folded script / clipped args / width-truncated title): start or
 *  finish wall-clock and the terminal result's exit code / signal —
 *  everything the header's relative `· 2m` chip and the body's
 *  `Running… (…)` line do NOT say. Durations stay out on purpose: showing
 *  a value twice, once on the card and once in the float, is exactly the
 *  noise class this tooltip exists to avoid. A fully visible header pops
 *  NOTHING (meta included) — a float that repeats or annotates content
 *  already on screen is noise, not detail. Returns '' when the row carries
 *  no timing data. */
function toolCardMetaTooltip(tool: ToolRow, isRunning: boolean, isError: boolean): string {
  const parts: string[] = []
  const startedAt = tool.startedAt
  if (isRunning) {
    if (startedAt !== undefined) parts.push(t('tool-tip-started', { time: formatClock(startedAt) }))
  } else {
    const durationMs = tool.durationMs
    if (startedAt !== undefined && durationMs !== undefined) {
      parts.push(t(isError ? 'tool-tip-failed' : 'tool-tip-finished', { time: formatClock(startedAt + durationMs) }))
    }
  }
  const resultView = tool.resultView
  if (resultView !== undefined && resultView.card === 'terminal') {
    if ('exitCode' in resultView && resultView.exitCode !== undefined && resultView.exitCode !== 0) {
      parts.push(t('tool-tip-exit', { code: resultView.exitCode }))
    }
    if ('signal' in resultView && resultView.signal !== undefined) {
      parts.push(t('tool-tip-signal', { name: String(resultView.signal) }))
    }
  }
  return parts.join(' · ')
}

function HeaderTitle({ name, title, isTerminal, folded, displayArgs, argsLanguage, nameColor, filePath, onOpenFile, metaTooltip, headerTextBudget }: {
  name: string
  title: string | undefined
  isTerminal: boolean
  /** Terminal-card fold result (multi-line title, folding on, not verbose). */
  folded: FoldedTitle | undefined
  displayArgs: string
  argsLanguage?: 'json'
  nameColor: keyof Theme
  /** Clickable file target: when set and present in the title, the path
   *  segment renders underlined and clickable (opens the file menu). */
  filePath?: string
  onOpenFile?: (path: string) => void
  /** Addendum line for the header hover tooltip when the header HIDES
   *  content (folded script / clipped args / width-truncated title):
   *  start/finish wall-clock, terminal exit code/signal — everything the
   *  relative chip and the body's Running… line do NOT say. Lazy getter,
   *  resolved at show time so a running card's start stays fresh. '' =
   *  nothing. A fully visible header pops no tooltip at all. */
  metaTooltip: () => string
  /**
   * Column budget for the NON-terminal one-line title on the header line —
   * `useTerminalSize().columns` (already margin-adjusted) minus the fixed
   * chrome of the row: loader dot 2 + hover ▾ indicator 2 (present while
   * the pointer dwells) + the settled elapsed chip + slack for the
   * transcript gutter. Only this title renders in a truncate-end Text, so
   * only it can be cut by layout width (terminal titles wrap; args are
   * clipped by the 480-char budget) — this budget gates just that cut.
   */
  headerTextBudget: number
}): React.ReactNode {
  // Hover tooltip rule: pop ONLY when the header genuinely hides content —
  // a folded terminal script, args clipped past the 480-char budget, or a
  // non-terminal one-line title cut by layout width (truncate-end). A header
  // that fully fits its row stays silent: a float that repeats or annotates
  // text already visible next to the pointer is noise, not detail. Empty
  // content is a no-op inside the hook.
  const headerTooltip = useTooltip(() => {
    const meta = metaTooltip()
    const withMeta = (full: string): string => (meta === '' ? full : `${full}\n${meta}`)
    if (folded !== undefined) return withMeta(title ?? '')
    if (title === undefined && clipHeaderArgs(displayArgs) !== displayArgs) return withMeta(displayArgs)
    // Width truncation: only the non-terminal title Text is truncate-end —
    // a long one-line title is really cut by layout when it overflows the
    // row. Terminal titles WRAP instead (default Text wrap, nothing hidden)
    // and args within the 480 budget wrap too; they never reach this gate.
    if (title !== undefined && !isTerminal && stringWidth(title.trim()) > headerTextBudget) {
      return withMeta(title.trim())
    }
    // Header fully visible: nothing hidden, nothing to add — stay silent.
    return ''
  })
  if (title === undefined) {
    return (
      <>
        <Box flexShrink={0}>
          <Text bold color={nameColor} wrap="truncate-end">{name}</Text>
        </Box>
        {displayArgs !== '' && (
          <Box flexWrap="nowrap" {...headerTooltip}>
            <Text>(</Text>
            <SyntaxText text={clipHeaderArgs(displayArgs)} sourceText={displayArgs} language={argsLanguage} />
            <Text>)</Text>
          </Box>
        )}
      </>
    )
  }
  if (isTerminal) {
    return (
      <>
        <Box flexShrink={0}>
          <Text bold color={nameColor} wrap="truncate-end">{name}</Text>
        </Box>
        <Box flexWrap="nowrap" {...headerTooltip}>
          {folded === undefined ? (
            <Text>({title})</Text>
          ) : (
            <>
              <Text>({folded.first})</Text>
              {folded.hiddenLines > 0 && (
                <Text dimColor>{` ${t('lines-folded-expand', { n: folded.hiddenLines, key: primaryComboString('transcript') })}`}</Text>
              )}
            </>
          )}
        </Box>
      </>
    )
  }
  const trimmed = title.trim()
  if (trimmed === '') {
    return (
      <Box flexShrink={0}>
        <Text bold color={nameColor} wrap="truncate-end">{name}</Text>
      </Box>
    )
  }
  // Clickable path: when the caller resolved a file path that appears in
  // the title (`Edit /path (1 - 100)`), render that segment underlined and
  // clickable. The click stops propagation so the row's fold toggle does
  // not fire. indexOf keeps the split exact even for paths with regex
  // metacharacters.
  if (onOpenFile !== undefined && filePath !== undefined && filePath !== '' && trimmed.includes(filePath)) {
    const at = trimmed.indexOf(filePath)
    const before = trimmed.slice(0, at)
    const after = trimmed.slice(at + filePath.length)
    return (
      <Box flexWrap="nowrap" {...headerTooltip}>
        <Text bold color={nameColor} wrap="truncate-end">{before}</Text>
        <Box
          onClick={(event: ClickEvent) => {
            event.stopImmediatePropagation()
            onOpenFile(filePath)
          }}
        >
          <Text underline wrap="truncate-end">{filePath}</Text>
        </Box>
        {after !== '' && (
          <Text bold={false} color="text" wrap="truncate-end">{after}</Text>
        )}
      </Box>
    )
  }
  const space = trimmed.indexOf(' ')
  const head = space === -1 ? trimmed : trimmed.slice(0, space)
  const tail = space === -1 ? '' : trimmed.slice(space)
  return (
    <Box flexWrap="nowrap" {...headerTooltip}>
      <Text bold color={nameColor} wrap="truncate-end">
        {head}
        <Text bold={false} color="text">{tail}</Text>
      </Text>
    </Box>
  )
}

/**
 * Tool-call card: `● Edit /path` header with a blinking status dot, then the
 * structured body under a `  ⎿  ` gutter — diff hunks in red/green, terminal
 * output, read content — instead of the raw result dump. The channel captures
 * the structured views per call.
 */
export function AssistantToolUseMessage({
  tool,
  marginTopOnTurn,
  verbose,
  isSelected = false,
  isExpanded = false,
  onClick,
  footnote,
  diffLayout = 'auto',
  toolBackground = 'none',
  onOpenFile,
  foldTerminalCommand = false,
  smoothReveal = false,
  fresh = false,
  revealVersion,
  sourceFolded = false,
}: Props): React.ReactNode {
  // MessageList owns the single production subscription and passes a version
  // prop only to active reveal rows. Standalone consumers keep the fallback
  // subscription so the component contract remains self-contained.
  // DefaultLane on purpose (useRevealVersion): a useSyncExternalStore wakeup
  // forces a SyncLane render per tick, and repeated sync commits ending with
  // streaming work pending feed React's nested-update counter (error #185).
  useRevealVersion(revealVersion === undefined)
  const isRunning = tool.status === 'running'
  const isError = tool.status === 'error'
  const sendMessage = sendMessageCardOf(tool)
  // The send-message card's raw layer (args/result JSON) shows on verbose OR
  // a row click — the click is the mouse user's only「看全量」path.
  const sendMessageRawOpen = sendMessage !== undefined && (verbose || isExpanded)
  const displayArgs = verbose ? tool.argsFull ?? tool.argsText : tool.argsText
  const result = tool.resultFull ?? tool.resultText
  // The settled view carries the applied diff / actual output; while running,
  // the call view already shows the pending change.
  const view = tool.resultView ?? tool.callView
  const name = displayName(tool.name, view?.displayKey ?? tool.callView?.displayKey)
  const minWidth = stringWidth(name) + 2
  const filePath = filePathFromTool(tool, view)
  const syntaxLanguage = view?.card === 'read' || view?.card === 'generic' || view === undefined
    ? languageFromPath(filePath)
    : undefined
  // presentResult may omit a title (terminal results carry output, not a
  // command) — then the call view's title stands. The SendMessage card owns
  // its header outright: `SendMessage → <target>` (+ the resume mark), the
  // raw args parens stay out of the header.
  const headerTitle = sendMessage !== undefined
    ? `${displayName(tool.name)} → ${sendMessage.target}${sendMessage.resuming ? ` · ${t('send-message-card-resuming')}` : ''}`
    : tool.resultView?.title ?? tool.callView?.title
  const headerIsTerminal = view?.card === 'terminal'
  // Fold the terminal header: multi-line command script (setting-gated) plus
  // the always-on long-line clip, both off once the card is verbose/expanded
  // (Ctrl+O and the row click both land in `verbose`, so expansion reuses the
  // existing state machine). Memoized on the title reference: settled titles
  // never change, so the 1s useAnimationFrame tick of a running card
  // re-renders without rescanning. `lang` joins the deps because the inline
  // marker is localized.
  const lang = getLang()
  const foldedHeader = React.useMemo(
    () => headerIsTerminal && !verbose && headerTitle !== undefined
      ? foldTerminalTitle(headerTitle, foldTerminalCommand)
      : undefined,
    [headerIsTerminal, foldTerminalCommand, verbose, headerTitle, lang],
  )

  // Live elapsed clock while the call runs: the
  // 1s tick re-renders the card; elapsed derives from wall-clock refs.
  const [viewportRef] = useAnimationFrame(isRunning ? 1000 : null)
  const elapsedMs = isRunning
    ? tool.startedAt !== undefined
      ? Date.now() - tool.startedAt
      : undefined
    : tool.durationMs
  const elapsedText = elapsedMs !== undefined ? ` · ${formatDuration(elapsedMs)}` : ''

  // Body lines: the structured view first, raw result text as the fallback
  // (tools without a presenter, or a folded row awaiting loadOlder).
  // Wide terminals render diffs as a two-pane side-by-side instead: one
  // source line per terminal row (truncate) keeps the panes row-aligned,
  // which the flat add/del line model cannot express.
  const { columns } = useTerminalSize()
  // Interactive rows grow a ▾/▴ disclose column while the pointer dwells
  // (fixed, no layout shift elsewhere). The tooltip resolves at show time —
  // i.e. exactly while that column is present — so the budget must reserve
  // it for clickable cards only; non-interactive rows never render it.
  const interactive = onClick !== undefined
  // Header-row budget for the title Text. useTerminalSize() already reports
  // the margin-adjusted content width, so this is the fixed chrome of the
  // line only: loader dot 2 + hover ▾ indicator 2 (interactive rows, present
  // while the pointer dwells) + the settled elapsed chip. Calibrated against
  // the renderer (probe-tooltip-truncation): a truncate-end title whose
  // width exceeds columns − loader − ▾ − chip is really cut on screen at
  // tooltip time; anything at or under the budget fits fully and must NOT
  // pop a tooltip. No extra slack, and the tool name is NOT deducted — a
  // non-terminal title carries its own first word, so double-counting name
  // pushed the gate ~10 cols too tight and floated fully visible titles.
  const headerTextBudget = Math.max(0, columns - 2 - (interactive ? 2 : 0)
    - (!isRunning && elapsedText !== '' ? stringWidth(elapsedText) : 0))
  const useSplitDiff = !isError && view?.card === 'diff' &&
    (diffLayout === 'split' || (diffLayout !== 'unified' && columns >= SPLIT_DIFF_MIN_COLS))
  let body: BodyLine[] = []
  if (sendMessage !== undefined) {
    // 正文 = message 文本预览（长文走既有的三行折叠），summary 作副行；
    // to/type/recipient/content 等原始字段只在 raw 层出现。
    body = sendMessage.text.split('\n').map(plain)
    if (sendMessage.summary !== undefined) {
      body.push(dim(`${t('send-message-card-summary-label')}: ${sendMessage.summary}`))
    }
    // 失败文案不属于 raw 层：折叠态也要看得见拒绝原因。
    if (isError && tool.errorText !== undefined && tool.errorText !== '') {
      body.push(...tool.errorText.split('\n').map(line => ({ text: line, tone: 'error' as const })))
    }
    if (sendMessageRawOpen) {
      const rawArgs = (verbose ? tool.argsFull : undefined) ?? tool.argsText
      body.push(dim('── args ──'))
      body.push(...rawArgs.split('\n').map(dim))
      const rawResult = tool.resultFull ?? tool.resultText
      if (rawResult !== undefined && rawResult !== '') {
        body.push(dim('── result ──'))
        body.push(...rawResult.split('\n').map(dim))
      }
    }
  } else if (isError) {
    // Line-aware like every other body: a multi-line error (a stack trace)
    // goes through the SAME line budget and fold hint as tool output — the
    // verdict visibility problem the exit lines solve does not excuse an
    // unbounded error body in a collapsed card.
    if (tool.errorText) body = tool.errorText.split('\n').map((text): BodyLine => ({ text, tone: 'error' }))
  } else if (!useSplitDiff) {
    if (view !== undefined) body = viewLines(view)
    if (body.length === 0 && result) {
      body = result.trimEnd().split('\n').map(plain)
    }
    if (isRunning && body.length === 0) {
      body = [dim(t('tool-running-elapsed', { duration: formatDuration(Math.max(0, Date.now() - (tool.startedAt ?? Date.now()))) }))]
    }
  }
  const cap = view?.card === 'diff' ? DIFF_BODY_MAX_LINES : TEXT_BODY_MAX_LINES
  // 展开态（点击/verbose）的 SendMessage 卡不截断——raw 层就是「全量」。
  const bodyUncapped = verbose || sendMessageRawOpen
  // Long-line clip before anything downstream reads the body: the syntax
  // highlighter walks `bodySource` by line index, so the folded text must be
  // the single source of truth for both.
  const foldedBody = bodyUncapped ? { lines: body, hiddenChars: 0 } : foldBodyLines(body)
  const bodyLines = foldedBody.lines
  const bodySource = bodyLines.map(line => line.text).join('\n')
  const argsLanguage = jsonArgsLanguage(displayArgs)
  const capped = capLines(bodyLines, cap, bodyUncapped, foldedBody.hiddenChars)
  // Verbose bodies walk a bounded window (see VERBOSE_BODY_WINDOW): the tail
  // stays in the retained source, and the card says what it is showing.
  const lines = verbose && capped.length > VERBOSE_BODY_WINDOW
    ? [
        ...capped.slice(0, VERBOSE_BODY_WINDOW),
        { ...dim(t('tool-card-window-shown', { shown: VERBOSE_BODY_WINDOW, total: capped.length })), revealOnHover: false },
      ]
    : capped
  // The terminal verdict rides OUTSIDE every cap (the footnote's rule): a
  // long output must never fold the non-zero exit code or kill signal away —
  // the settled card keeps the failure readable without the hover tooltip.
  const terminalExitLines: BodyLine[] = []
  if (!isError && tool.resultView !== undefined && tool.resultView.card === 'terminal') {
    const rv = tool.resultView
    if (rv.exitCode !== undefined && rv.exitCode !== 0) {
      terminalExitLines.push({ text: t('tool-exit-code', { code: rv.exitCode }), tone: 'error' })
    }
    if (rv.signal !== undefined) {
      terminalExitLines.push({ text: t('tool-killed-signal', { name: String(rv.signal) }), tone: 'error' })
    }
  }
  // Full-vs-preview disclosure (expanded cards only — the collapsed card is
  // a preview by design and its fold indicator already says so): a folded
  // SOURCE cannot expand past its preview, and a structured-only result has
  // no raw full text to expand into. Both say so instead of passing the
  // visible slice off as everything.
  const disclosure: BodyLine[] = verbose
    ? sourceFolded
      ? [dim(t('tool-card-source-truncated'))]
      : tool.resultFull === undefined && tool.resultView !== undefined && !isRunning
        ? [dim(t('tool-card-full-unavailable'))]
        : []
    : []
  // The footnote rides OUTSIDE the cap: it is a pointer, not content, and a
  // long error body must not be the reason it disappears.
  const rendered: BodyLine[] = [
    ...lines,
    ...disclosure,
    ...terminalExitLines,
    ...(footnote === undefined ? [] : [{ text: footnote, tone: 'hint' as const }]),
  ]
  // Smooth reveal (line-unit, pending CALL body only): model-authored prose
  // (diff hunks, write content) flows in at ~30fps; the settled RESULT view,
  // error bodies, verbose/expanded cards, and replayed (non-fresh) cards all
  // paint complete. `snapReveal` on every non-revealable render retires a
  // cursor the moment its card stops qualifying (result arrived, user
  // expanded) — idempotent, safe during render.
  const revealKey = `tool:${tool.callId}`
  const revealable = smoothReveal && !isError && isRunning && view !== undefined &&
    tool.resultView === undefined && !verbose && !isExpanded && fresh
  if (!revealable) snapReveal(revealKey)
  const revealedLineCount = revealable
    ? revealLinesOf(revealKey, rendered.length, { enabled: true, active: true })
    : rendered.length
  const shownLines: BodyLine[] =
    revealedLineCount >= rendered.length ? rendered : rendered.slice(0, revealedLineCount)
  // Nested split-diff context panes must also yield to interaction highlights.
  // `none` leaves them transparent so the selected/expanded root shows through.
  const ordinaryToolBackground = isSelected || isExpanded ? 'none' : toolBackground
  const ordinaryBackground = ordinaryToolBackground === 'subtle'
    ? 'toolCardBackgroundDim'
    : ordinaryToolBackground === 'strong'
      ? 'toolCardBackground'
      : undefined
  // Hover affordance for the click-to-toggle row: the theme's tool-card blue
  // face marks the call's content area while the pointer dwells (the
  // toolBackground treatment steps up one level to the strong card face), the
  // collapsed fold hint (lines-folded-expand) steps from dim to text, the
  // elapsed clock stops dimming, and a ▾/▴ discloses the row is a toggle.
  // No layout change: the indicator is a fixed column on the header line, the
  // body never moves.
  const [hovered, setHovered] = React.useState(false)
  const hoverTint = interactive && hovered && !isSelected
  // SendMessage 结果行：状态徽标只认结果里的事实（§5.2 镜像规则），
  // resumedAgentId/pin 显示为「已唤醒 <短id>」；unknown 附不推断说明。
  const sendMessageState = sendMessage === undefined ? undefined : sendMessageCardState(tool)
  const sendMessageResumed = sendMessage === undefined ? undefined : sendMessageResumedOf(tool)

  return (
    <Box
      ref={viewportRef}
      flexDirection="row"
      justifyContent="space-between"
      marginTop={marginTopOnTurn ? 1 : 0}
      width="100%"
      onClick={onClick}
      // Only selection paints a highlight; the configured treatment applies
      // to an ordinary card. Diff line tints stay - they are content, not chrome.
      backgroundColor={isSelected ? 'messageActionsBackground' : hoverTint ? 'toolCardBackground' : ordinaryBackground}
      onMouseEnter={interactive ? () => setHovered(true) : undefined}
      onMouseLeave={interactive ? () => setHovered(false) : undefined}
    >
      <Box flexDirection="column" flexGrow={1}>
        <Box flexDirection="row" flexWrap="nowrap" minWidth={minWidth}>
          <ToolUseLoader
            shouldAnimate={isRunning}
            isUnresolved={isRunning}
            isError={isError}
            toolName={tool.name}
          />
          <HeaderTitle name={name} title={headerTitle} isTerminal={headerIsTerminal} folded={foldedHeader} displayArgs={displayArgs} argsLanguage={argsLanguage} nameColor={toolNameColor(tool.name, view?.category ?? tool.callView?.category)} filePath={filePath} onOpenFile={onOpenFile} metaTooltip={() => toolCardMetaTooltip(tool, isRunning, isError)} headerTextBudget={headerTextBudget} />
          {!isRunning && (
            <Box flexWrap="nowrap">
              <Text dimColor={!hovered}>{elapsedText}</Text>
            </Box>
          )}
          {hovered && (
            <Box flexShrink={0}>
              <Text dimColor>{isExpanded ? '▴' : '▾'}</Text>
            </Box>
          )}
        </Box>
        {useSplitDiff && view?.card === 'diff' ? (
          <Box flexDirection="row">
            <Box width={3} flexShrink={0}>
              <Text dimColor>{GUTTER_FIRST}</Text>
            </Box>
            <SplitDiffView
              diffs={view.diffs}
              width={columns - 4}
              maxRows={DIFF_BODY_MAX_LINES}
              verbose={verbose}
              toolBackground={ordinaryToolBackground}
              reveal={revealable ? { key: `${revealKey}:split` } : undefined}
            />
          </Box>
        ) : (
          shownLines.map((line, index) => (
            <Box key={index} flexDirection="row">
              <Box width={3} flexShrink={0}>
                <Text
                  color={
                    line.tone === 'add'
                      ? 'diffAddedWord'
                      : line.tone === 'del'
                        ? 'diffRemovedWord'
                        : line.tone === 'path'
                          ? 'ide'
                          : undefined
                  }
                  dimColor={line.tone !== 'add' && line.tone !== 'del' && line.tone !== 'path'}
                >
                  {index === 0 ? GUTTER_FIRST : GUTTER_REST}
                </Text>
              </Box>
              <Box flexGrow={1}>
                {line.tone === 'path' && onOpenFile !== undefined ? (
                  <Box
                    onClick={(event: ClickEvent) => {
                      // Stop propagation so the row's fold toggle does not
                      // fire when clicking the path.
                      event.stopImmediatePropagation()
                      onOpenFile(line.text)
                    }}
                  >
                    <Text color="ide" underline>{line.text}</Text>
                  </Box>
                ) : (
                  <Text
                    color={
                      line.tone === 'add'
                        ? 'diffAddedWord'
                        : line.tone === 'del'
                          ? 'diffRemovedWord'
                          : line.tone === 'error'
                            ? 'error'
                            : line.tone === 'hint'
                              ? 'subtle'
                              : line.tone === 'path'
                                ? 'ide'
                                : undefined
                    }
                    dimColor={line.tone === 'dim' && !(line.revealOnHover === true && hovered)}
                    wrap="wrap"
                  >
                    {line.tone === 'plain' && syntaxLanguage !== undefined ? (
                      <SyntaxText text={line.text} sourceText={bodySource} lineIndex={index} language={syntaxLanguage} />
                    ) : (
                      line.text === '' ? ' ' : line.text
                    )}
                  </Text>
                )}
              </Box>
            </Box>
          ))
        )}
        {sendMessage !== undefined && sendMessageState !== undefined && (
          <Box flexDirection="row">
            <Box width={3} flexShrink={0}>
              <Text dimColor>{GUTTER_REST}</Text>
            </Box>
            <Text color={agentMessageStateColor(sendMessageState)}>{agentMessageStateText(sendMessageState)}</Text>
            {sendMessageResumed !== undefined && (
              <Text dimColor>{` · ${t('send-message-card-resumed', { id: sendMessageResumed })}`}</Text>
            )}
            {sendMessageState === 'unknown' && (
              <Text dimColor italic>{` · ${t('agent-message-no-delivery-fact')}`}</Text>
            )}
          </Box>
        )}
        {useSplitDiff && disclosure.length > 0 && disclosure.map((line, index) => (
          <Box key={`disclosure-${index}`} flexDirection="row">
            <Box width={3} flexShrink={0}>
              <Text dimColor>{GUTTER_REST}</Text>
            </Box>
            <Text dimColor>{line.text}</Text>
          </Box>
        ))}
        {useSplitDiff && footnote !== undefined && (
          <Box flexDirection="row">
            <Box width={3} flexShrink={0}>
              <Text dimColor>{GUTTER_REST}</Text>
            </Box>
            <Text color="subtle">{footnote}</Text>
          </Box>
        )}
      </Box>
    </Box>
  )
}
