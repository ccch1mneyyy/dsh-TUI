import React from 'react'
import { Box, Text, useTerminalSize } from '../../ui.js'
import { stringWidth } from '../../ink/stringWidth.js'
import { useAnimationFrame } from '../../ink/hooks/use-animation-frame.js'
import type { ToolCallView, ToolFileDiff, ToolResultView, ToolRow } from '../../dsh-adapter/channel.js'
import { ToolUseLoader } from '../ToolUseLoader.js'
import { SplitDiffView } from '../SplitDiffView.js'
import { formatDuration } from '../../cc/format.js'

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
    todo_write: 'TodoWrite',
    subagent: 'Task',
    web_search: 'WebSearch',
  }
  const mapped = KNOWN[name]
  if (mapped) return mapped
  if (name.length === 0) return name
  return name[0]!.toUpperCase() + name.slice(1)
}

// --- structured body lines --------------------------------------------------
// The tool's presentation view (dsh-tools presentCall/presentResult, captured
// by the channel) becomes per-line render intents here. CC convention: the
// body hangs under a `  ⎿  ` gutter (first line) / blank continuation, so
// tool output is visually nested under its header instead of flush-left.

/** `hint` is the trajectory pointer: recessive, never competing with output. */
type BodyTone = 'add' | 'del' | 'dim' | 'plain' | 'error' | 'hint'
type BodyLine = { readonly text: string; readonly tone: BodyTone }

/** CC's collapsed text body keeps 3 lines (renderTruncatedContent). */
const TEXT_BODY_MAX_LINES = 3
/** Diff bodies cap at the upstream chat row's 8 (dsh-client-ui-tool's
 *  CHAT_DIFF_MAX_LINES) — denser information than log output. */
const DIFF_BODY_MAX_LINES = 8
/** Minimum terminal width for the two-pane diff: below this the panes
 *  would squeeze under ~50 columns each and the unified view reads better. */
const SPLIT_DIFF_MIN_COLS = 110

const GUTTER_FIRST = ' ⎿ '
const GUTTER_REST = '   '

const add = (text: string): BodyLine => ({ text, tone: 'add' })
const del = (text: string): BodyLine => ({ text, tone: 'del' })
const dim = (text: string): BodyLine => ({ text, tone: 'dim' })
const plain = (text: string): BodyLine => ({ text, tone: 'plain' })

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
      if (diff.path !== prevPath) out.push(plain(diff.path))
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
  return text.split('\n').map(dim)
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
      const lines: BodyLine[] = out === '' ? [] : out.split('\n').map(dim)
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
          lines.push(dim(`${match.lineNumber}: ${match.line}`))
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
    dim(`… +${lines.length - max} lines (ctrl+o to expand)`),
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

function HeaderTitle({ name, title, isTerminal, displayArgs }: {
  name: string
  title: string | undefined
  isTerminal: boolean
  displayArgs: string
}): React.ReactNode {
  if (title === undefined) {
    return (
      <>
        <Box flexShrink={0}>
          <Text bold wrap="truncate-end">{name}</Text>
        </Box>
        {displayArgs !== '' && (
          <Box flexWrap="nowrap">
            <Text>({clipHeaderArgs(displayArgs)})</Text>
          </Box>
        )}
      </>
    )
  }
  if (isTerminal) {
    return (
      <>
        <Box flexShrink={0}>
          <Text bold wrap="truncate-end">{name}</Text>
        </Box>
        <Box flexWrap="nowrap">
          <Text>({title})</Text>
        </Box>
      </>
    )
  }
  const trimmed = title.trim()
  if (trimmed === '') {
    return (
      <Box flexShrink={0}>
        <Text bold wrap="truncate-end">{name}</Text>
      </Box>
    )
  }
  const space = trimmed.indexOf(' ')
  const head = space === -1 ? trimmed : trimmed.slice(0, space)
  const tail = space === -1 ? '' : trimmed.slice(space)
  return (
    <Box flexWrap="nowrap">
      <Text bold wrap="truncate-end">
        {head}
        <Text bold={false}>{tail}</Text>
      </Text>
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
  footnote,
  diffLayout = 'auto',
}: Props): React.ReactNode {
  const isRunning = tool.status === 'running'
  const isError = tool.status === 'error'
  const displayArgs = verbose ? tool.argsFull ?? tool.argsText : tool.argsText
  const result = tool.resultFull ?? tool.resultText
  const name = displayName(tool.name)
  const minWidth = stringWidth(name) + 2
  // The settled view carries the applied diff / actual output; while running,
  // the call view already shows the pending change (CC's pending Edit diff).
  const view = tool.resultView ?? tool.callView
  // presentResult may omit a title (terminal results carry output, not a
  // command) — then the call view's title stands.
  const headerTitle = tool.resultView?.title ?? tool.callView?.title
  const headerIsTerminal = view?.card === 'terminal'

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
  const useSplitDiff = !isError && view?.card === 'diff' &&
    (diffLayout === 'split' || (diffLayout !== 'unified' && columns >= SPLIT_DIFF_MIN_COLS))
  let body: BodyLine[] = []
  if (isError) {
    if (tool.errorText) body = [{ text: tool.errorText, tone: 'error' }]
  } else if (!useSplitDiff) {
    if (view !== undefined) body = viewLines(view)
    if (body.length === 0 && result) {
      body = result.trimEnd().split('\n').map(dim)
    }
    if (isRunning && body.length === 0) {
      body = [dim(`Running… (${formatDuration(Math.max(0, Date.now() - (tool.startedAt ?? Date.now())))})`)]
    }
  }
  const cap = view?.card === 'diff' ? DIFF_BODY_MAX_LINES : TEXT_BODY_MAX_LINES
  // The footnote rides OUTSIDE the cap: it is a pointer, not content, and a
  // long error body must not be the reason it disappears.
  const lines = capLines(body, cap, verbose)
  const rendered: BodyLine[] =
    footnote === undefined ? lines : [...lines, { text: footnote, tone: 'hint' }]

  return (
    <Box
      ref={viewportRef}
      flexDirection="row"
      justifyContent="space-between"
      marginTop={addMargin ? 1 : 0}
      width="100%"
      backgroundColor={
        isSelected
          ? 'messageActionsBackground'
          : isExpanded
            ? 'userMessageBackgroundHover'
            : 'toolCardBackgroundDim'
      }
    >
      <Box flexDirection="column" flexGrow={1}>
        <Box flexDirection="row" flexWrap="nowrap" minWidth={minWidth}>
          <ToolUseLoader
            shouldAnimate={isRunning}
            isUnresolved={isRunning}
            isError={isError}
            toolName={tool.name}
          />
          <HeaderTitle name={name} title={headerTitle} isTerminal={headerIsTerminal} displayArgs={displayArgs} />
          {!isRunning && (
            <Box flexWrap="nowrap">
              <Text dimColor>{elapsedText}</Text>
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
            />
          </Box>
        ) : (
          rendered.map((line, index) => (
            <Box key={index} flexDirection="row">
              <Box width={3} flexShrink={0}>
                <Text dimColor>{index === 0 ? GUTTER_FIRST : GUTTER_REST}</Text>
              </Box>
              <Box flexGrow={1}>
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
                            : undefined
                  }
                  dimColor={line.tone === 'dim'}
                  wrap="wrap"
                >
                  {line.text === '' ? ' ' : line.text}
                </Text>
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
