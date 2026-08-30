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
import { formatDuration } from '../../cc/format.js'
import type { ToolBackground } from '../../tuiDisplayPrefs.js'
import type { Theme } from '../../theme.js'
import type { ClickEvent } from '../../ink/events/click-event.js'

type Props = {
  tool: ToolRow
  /** Adds the top margin between messages (CC: addMargin). */
  addMargin: boolean
  /** Ctrl+O verbose: show full args/result instead of previews. */
  verbose: boolean
  /** Message-selection mode highlight. */
  isSelected?: boolean
  /** Row expanded on its own (persistent hover-grey background, CC). */
  isExpanded?: boolean
  /**
   * Mouse click (fullscreen): toggles the row's expansion — same action as
   * clicking other transcript rows. Also makes the `(ctrl+o to expand)`
   * hint actionable with the mouse.
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
}

/** Tool display names: DSH emits lowercase tool ids (`bash`); Claude Code
 *  shows capitalized names (`Bash`). Map the common ones, fall back to the
 *  id with its first letter uppercased. */
function displayName(name: string): string {
  const KNOWN: Record<string, string> = {
    bash: 'Bash',
    powershell: 'PowerShell',
    read: 'Read',
    glob: 'Glob',
    grep: 'Grep',
    write: 'Write',
    edit: 'Edit',
    todo_write: 'Tasks',
    subagent: 'Task',
    subagent_fork: 'Task',
    web_search: 'Search',
    web_fetch: 'Fetch',
    read_image: 'Image',
  }
  const mapped = KNOWN[name]
  if (mapped) return mapped
  if (name.length === 0) return name
  return name[0]!.toUpperCase() + name.slice(1)
}

function parseJsonArgs(args: string): unknown {
  try { return JSON.parse(args) } catch { return undefined }
}

function jsonArgsLanguage(args: string): 'json' | undefined {
  return parseJsonArgs(args) === undefined ? undefined : 'json'
}

const QUIET_COLLAPSED_TOOLS = new Set([
  'read',
  'glob',
  'grep',
  'skill',
  'read_image',
  'list_agents',
  'job_list',
  'todo_write',
  'get_goal',
  'create_goal',
  'update_goal',
  'blender_status',
  'blender_scene_info',
  'blender_object_info',
  'blender_validate_scene',
  'blender_validate_export',
])

function deriveSmartToolHeader(tool: ToolRow, viewTitle?: string): { name: string; title?: string; filePath?: string; isTerminal?: boolean } {
  const toolName = tool.name.toLowerCase()
  const rawArgs = tool.argsFull ?? tool.argsText
  const parsed = parseJsonArgs(rawArgs) as Record<string, unknown> | undefined

  if (toolName === 'bash' || toolName === 'shell' || toolName === 'terminal' || toolName === 'powershell') {
    if (parsed && typeof parsed.description === 'string' && parsed.description.trim()) {
      return { name: displayName(tool.name), title: parsed.description.trim(), isTerminal: false }
    }
    if (parsed && typeof parsed.command === 'string') {
      const cmd = parsed.command.trim()
      const firstLine = cmd.split('\n')[0] ?? ''
      const cleaned = firstLine.length > 80 ? `${firstLine.slice(0, 78)}…` : firstLine
      return { name: displayName(tool.name), title: cleaned, isTerminal: true }
    }
  }

  if (toolName === 'skill') {
    if (parsed && typeof parsed.name === 'string') {
      return { name: 'Skill', title: `Load ${parsed.name}` }
    }
  }

  if (toolName === 'todo_write') {
    if (parsed && Array.isArray(parsed.todos)) {
      const done = parsed.todos.filter((t: any) => t && t.status === 'completed').length
      return { name: 'Tasks', title: `Update task list (${done}/${parsed.todos.length} done)` }
    }
    return { name: 'Tasks', title: 'Update task list' }
  }

  if (toolName === 'read') {
    const filePath = (parsed?.file_path ?? parsed?.path) as string | undefined
    if (filePath) {
      return { name: 'Read', title: filePath, filePath }
    }
  }

  if (toolName === 'edit') {
    const filePath = (parsed?.file_path ?? parsed?.path) as string | undefined
    if (filePath) {
      return { name: 'Edit', title: filePath, filePath }
    }
  }

  if (toolName === 'write') {
    const filePath = (parsed?.file_path ?? parsed?.path) as string | undefined
    if (filePath) {
      return { name: 'Write', title: filePath, filePath }
    }
  }

  if (toolName === 'glob') {
    const pattern = parsed?.pattern as string | undefined
    const dir = parsed?.path as string | undefined
    if (pattern) {
      return { name: 'Glob', title: `${pattern}${dir ? ` in ${dir}` : ''}` }
    }
  }

  if (toolName === 'grep') {
    const pattern = parsed?.pattern as string | undefined
    const dir = (parsed?.path ?? parsed?.include) as string | undefined
    if (pattern) {
      return { name: 'Grep', title: `"${pattern}"${dir ? ` in ${dir}` : ''}` }
    }
  }

  if (toolName === 'read_image') {
    const filePath = (parsed?.file_path ?? parsed?.path) as string | undefined
    if (filePath) {
      return { name: 'Image', title: filePath, filePath }
    }
  }

  if (toolName === 'subagent' || toolName === 'subagent_fork') {
    const desc = parsed?.description as string | undefined
    if (desc) {
      return { name: 'Task', title: desc }
    }
  }

  if (toolName === 'web_search') {
    const queries = parsed?.queries as string[] | undefined
    if (Array.isArray(queries) && queries[0]) {
      return { name: 'Search', title: `"${queries[0]}"` }
    }
  }

  if (toolName === 'web_fetch') {
    const url = parsed?.url as string | undefined
    if (url) {
      return { name: 'Fetch', title: url }
    }
  }

  if (toolName.startsWith('mcp__roblox_studio__')) {
    const action = toolName.replace('mcp__roblox_studio__', '')
    const desc = (parsed?.instance_path ?? parsed?.script ?? parsed?.query ?? '') as string
    return { name: 'Roblox', title: `${action}${desc ? ` ${desc.slice(0, 40)}` : ''}` }
  }

  if (toolName.startsWith('blender_')) {
    const action = toolName.replace('blender_', '')
    return { name: 'Blender', title: action }
  }

  if (toolName === 'artifact') {
    const cmd = (parsed?.command ?? '') as string
    const p = (parsed?.path ?? '') as string
    return { name: 'Artifact', title: `${cmd} ${p}`.trim() }
  }

  if (viewTitle) {
    return { name: displayName(tool.name), title: viewTitle }
  }

  return { name: displayName(tool.name), title: viewTitle }
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
// by the channel) becomes per-line render intents here. CC convention: the
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

/** Collapsed text body keeps 2 lines for a linear, concise transcript stream. */
const TEXT_BODY_MAX_LINES = 2
/** Collapsed diff bodies cap at 3 lines — clean linear presentation without consuming screen height. */
const DIFF_BODY_MAX_LINES = 3
/** Minimum terminal width for the two-pane diff: below this the panes
 *  would squeeze under ~50 columns each and the unified view reads better. */
const SPLIT_DIFF_MIN_COLS = 110

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
export function toolNameColor(raw: string): keyof Theme {
  const n = raw.toLowerCase()
  if (TOOL_NAME_MUTATE.has(n)) return 'toolNameMutate'
  if (TOOL_NAME_EXEC.has(n)) return 'toolNameExec'
  return 'claude'
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
        if (view.truncated) lines.push(dim(`… (${view.total} total)`))
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

/** Collapsed bodies fold past the card's line budget; verbose (Ctrl+O) is
 *  always uncapped. Mirrors wrapText's "one extra line is shown directly". */
function capLines(lines: BodyLine[], max: number, verbose: boolean): BodyLine[] {
  if (verbose || lines.length <= max) return lines
  if (lines.length - max === 1) return lines
  return [
    ...lines.slice(0, max),
    { ...dim(`… +${lines.length - max} lines (ctrl+o to expand)`), revealOnHover: true },
  ]
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

/** Terminal-card header folding shape: the first source line plus how many
 *  lines are hidden. */
type FoldedTitle = { first: string; hidden: number }

/** Fold a multi-line terminal command title to its first SOURCE line.
 *  Counts '\n' separators in place instead of materializing a line array —
 *  running cards re-render every second and a streamed command can reach
 *  hundreds of KB, and the exact cost the HEADER_ARGS_BUDGET comment above
 *  keeps out of the header must not sneak back in through folding. (Lone-\r
 *  titles are not a thing presentCall produces; CRLF is normalized on the
 *  first line only.) Single-line titles return undefined: nothing to fold,
 *  rendering stays byte-identical to the unfolded card. */
function foldTerminalTitle(title: string): FoldedTitle | undefined {
  const firstEnd = title.indexOf('\n')
  if (firstEnd === -1) return undefined
  let separators = 1
  for (let at = title.indexOf('\n', firstEnd + 1); at !== -1; at = title.indexOf('\n', at + 1)) separators++
  // Same trailing-newline rule as sideLines: a terminator is not a line.
  const hidden = separators - (title.endsWith('\n') ? 1 : 0)
  if (hidden <= 0) return undefined
  const first = title.slice(0, title.charCodeAt(firstEnd - 1) === 13 ? firstEnd - 1 : firstEnd)
  return { first, hidden }
}

function HeaderTitle({ name, title, isTerminal, folded, displayArgs, argsLanguage, nameColor, filePath, onOpenFile }: {
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
}): React.ReactNode {
  // Hover tooltip: the header line truncates long paths/commands, so the
  // full string (or the unfolded terminal script) pops up after a dwell.
  // Empty content is a no-op inside the hook.
  const headerTooltip = useTooltip(() => {
    if (title === undefined) return displayArgs
    if (isTerminal) return title
    return title.trim()
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
          <Text bold color={nameColor} wrap="truncate-end">{name} </Text>
        </Box>
        <Box flexWrap="nowrap" {...headerTooltip}>
          {folded === undefined ? (
            <Text wrap="truncate-end">{title}</Text>
          ) : (
            <>
              <Text wrap="truncate-end">{folded.first}</Text>
              <Text dimColor>{` … +${folded.hidden} lines (ctrl+o to expand)`}</Text>
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
  if (onOpenFile !== undefined && filePath !== undefined && filePath !== '' && trimmed.includes(filePath)) {
    const at = trimmed.indexOf(filePath)
    const before = trimmed.slice(0, at).trim()
    const after = trimmed.slice(at + filePath.length).trim()
    return (
      <Box flexWrap="nowrap" {...headerTooltip}>
        <Text bold color={nameColor} wrap="truncate-end">{name} </Text>
        {before !== '' && <Text color="text">{before} </Text>}
        <Box
          onClick={(event: ClickEvent) => {
            event.stopImmediatePropagation()
            onOpenFile(filePath)
          }}
        >
          <Text underline wrap="truncate-end">{filePath}</Text>
        </Box>
        {after !== '' && (
          <Text bold={false} color="text" wrap="truncate-end"> {after}</Text>
        )}
      </Box>
    )
  }
  const startsWithName = trimmed.toLowerCase().startsWith(name.toLowerCase())
  const displayTitle = startsWithName ? trimmed.slice(name.length).trimStart() : trimmed
  return (
    <Box flexWrap="nowrap" {...headerTooltip}>
      <Text bold color={nameColor} wrap="truncate-end">{name} </Text>
      <Text bold={false} color="text" wrap="truncate-end">{displayTitle}</Text>
    </Box>
  )
}

/**
 * Tool-call card: `● Edit /path` header with a blinking status dot, then the
 * structured body under a `  ⎿  ` gutter — diff hunks in red/green, terminal
 * output, read content — instead of the raw result dump (mirroring Claude Code's `AssistantToolUseMessage.tsx` + the dsh-tools presentation views the
 * channel captures per call).
 */
export function AssistantToolUseMessage({
  tool,
  addMargin,
  verbose,
  isSelected = false,
  isExpanded = false,
  onClick,
  footnote,
  diffLayout = 'auto',
  toolBackground = 'none',
  onOpenFile,
  foldTerminalCommand = false,
}: Props): React.ReactNode {
  const isRunning = tool.status === 'running'
  const isError = tool.status === 'error'
  const displayArgs = verbose ? tool.argsFull ?? tool.argsText : tool.argsText
  const result = tool.resultFull ?? tool.resultText
  const view = tool.resultView ?? tool.callView
  const smart = deriveSmartToolHeader(tool, tool.resultView?.title ?? tool.callView?.title)
  const name = smart.name
  const headerTitle = smart.title
  const filePath = smart.filePath ?? filePathFromTool(tool, view)
  const minWidth = stringWidth(name) + 2
  const syntaxLanguage = view?.card === 'read' || view?.card === 'generic' || view === undefined
    ? languageFromPath(filePath)
    : undefined
  const headerIsTerminal = smart.isTerminal ?? (view?.card === 'terminal')
  const foldedHeader = React.useMemo(
    () => headerIsTerminal && foldTerminalCommand && !verbose && headerTitle !== undefined
      ? foldTerminalTitle(headerTitle)
      : undefined,
    [headerIsTerminal, foldTerminalCommand, verbose, headerTitle],
  )

  // Live elapsed clock while the call runs (CC's bash elapsed timer): the
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
  const useSplitDiff = !isError && view?.card === 'diff' && diffLayout === 'split'
  const isQuietTool = QUIET_COLLAPSED_TOOLS.has(tool.name.toLowerCase())
  const isCollapsed = !verbose && !isExpanded

  let body: BodyLine[] = []
  if (isError) {
    if (tool.errorText) body = [{ text: tool.errorText, tone: 'error' }]
  } else if (!useSplitDiff) {
    if (isRunning) {
      body = [dim(`Running… (${formatDuration(Math.max(0, Date.now() - (tool.startedAt ?? Date.now())))})`)]
    } else if (isCollapsed && isQuietTool) {
      // Clean 1-line tool card: suppress noisy result previews when collapsed
      body = []
    } else {
      if (view !== undefined) body = viewLines(view)
      if (body.length === 0 && result) {
        body = result.trimEnd().split('\n').map(plain)
      }
    }
  }
  const cap = view?.card === 'diff' ? DIFF_BODY_MAX_LINES : TEXT_BODY_MAX_LINES
  const bodySource = body.map(line => line.text).join('\n')
  const argsLanguage = jsonArgsLanguage(displayArgs)
  // The footnote rides OUTSIDE the cap: it is a pointer, not content, and a
  // long error body must not be the reason it disappears.
  const lines = capLines(body, cap, verbose)
  const rendered: BodyLine[] =
    footnote === undefined ? lines : [...lines, { text: footnote, tone: 'hint' }]
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
  // collapsed `(ctrl+o to expand)` hint steps from dim to text, the elapsed
  // clock stops dimming, and a ▾/▴ discloses the row is a toggle.
  // No layout change: the indicator is a fixed column on the header line, the
  // body never moves.
  const [hovered, setHovered] = React.useState(false)
  const interactive = onClick !== undefined
  const hoverTint = interactive && hovered && !isSelected

  return (
    <Box
      ref={viewportRef}
      flexDirection="row"
      justifyContent="space-between"
      marginTop={addMargin ? 1 : 0}
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
          <HeaderTitle name={name} title={headerTitle} isTerminal={headerIsTerminal} folded={foldedHeader} displayArgs={displayArgs} argsLanguage={argsLanguage} nameColor={toolNameColor(tool.name)} filePath={filePath} onOpenFile={onOpenFile} />
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
            />
          </Box>
        ) : (
          rendered.map((line, index) => (
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
