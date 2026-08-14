import React from 'react'
import { Box, Text } from '../../ui.js'
import { stringWidth } from '../../ink/stringWidth.js'
import { useAnimationFrame } from '../../ink/hooks/use-animation-frame.js'
import type { ToolCallView, ToolFileDiff, ToolResultView, ToolRow } from '../../channel.js'
import { ToolUseLoader } from '../ToolUseLoader.js'
import { formatDuration, formatTokens } from '../../cc/format.js'
import { createHyperlink } from '../../cc/hyperlink.js'
import { getCliHighlightPromise, type CliHighlight } from '../../cc/cliHighlight.js'
import { Markdown } from '../Markdown.js'

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
}

/** Tool display names: DSH emits lowercase tool ids (`bash`); Claude Code
 *  shows capitalized names (`Bash`). Map the common ones — aligned with dsh's
 *  actual tool vocabulary (subagent is SubAgent, never CC's "Task") — and
 *  fall back to the id with its first letter uppercased. */
function displayName(name: string): string {
  const KNOWN: Record<string, string> = {
    bash: 'Bash',
    pwsh: 'Pwsh',
    powershell: 'PowerShell',
    read: 'Read',
    read_image: 'Read',
    glob: 'Glob',
    grep: 'Grep',
    write: 'Write',
    edit: 'Edit',
    todo_write: 'TodoWrite',
    subagent: 'SubAgent',
    subagent_fork: 'SubAgent Fork',
    web_search: 'WebSearch',
    web_fetch: 'WebFetch',
    job_output: 'Job Output',
    job_list: 'Job List',
    job_kill: 'Job Kill',
    list_agents: 'List Agents',
    send_message: 'Send Message',
    interrupt_agent: 'Interrupt',
    report: 'Report',
  }
  const mapped = KNOWN[name]
  if (mapped) return mapped
  if (name.length === 0) return name
  return name[0]!.toUpperCase() + name.slice(1)
}

/** Settled tools whose collapsed body is suppressed (CC renders TodoWrite
 *  without a card at all; dsh keeps the header as the audit trail — the blue
 *  dot + duration already say "ok"). These are instant control operations
 *  with no observational value in the body. */
const QUIET_RESULTS: Record<string, true> = {
  todo_write: true,
  get_goal: true,
  create_goal: true,
  update_goal: true,
  skill: true,
  job_kill: true,
  terminal_open: true,
  terminal_signal: true,
  terminal_close: true,
  cordis_stop: true,
  cordis_undefine: true,
  send_message: true,
  interrupt_agent: true,
  report: true,
}

/** Presenterless tools: parse argsFull JSON into a human header argument.
 *  Returns undefined to keep the raw args display (unparseable input). */
function headerArgs(name: string, rawArgs: string | undefined): string | undefined {
  if (rawArgs === undefined) return undefined
  let args: unknown
  try {
    args = JSON.parse(rawArgs)
  } catch {
    return undefined
  }
  if (typeof args !== 'object' || args === null) return undefined
  const record = args as Record<string, unknown>
  const stringField = (key: string): string | undefined => {
    const value = record[key]
    return typeof value === 'string' && value !== '' ? value : undefined
  }
  switch (name) {
    case 'subagent':
    case 'subagent_fork': {
      const description = stringField('description')
      return description !== undefined ? previewText(description, 60) : undefined
    }
    case 'send_message': {
      const message = stringField('message')
      return message !== undefined ? previewText(message, 60) : undefined
    }
    case 'web_search': {
      const query = stringField('query')
      return query !== undefined ? previewText(query, 60) : undefined
    }
    case 'web_fetch': {
      const url = stringField('url')
      return url !== undefined ? previewText(url, 80) : undefined
    }
    case 'interrupt_agent':
      return stringField('agent_id') ?? stringField('agent')
    case 'report':
      return ''
    default:
      return undefined
  }
}

/** Clip a single-line display string to `max` chars with an ellipsis. */
function previewText(text: string, max: number): string {
  const oneLine = text.replace(/\s*\n\s*/g, ' ⏎ ').trim()
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine
}

// --- structured body lines --------------------------------------------------
// The tool's presentation view (dsh-tools presentCall/presentResult, captured
// by the channel) becomes per-line render intents here. CC convention: the
// body hangs under a `  ⎿  ` gutter (first line) / blank continuation, so
// tool output is visually nested under its header instead of flush-left.

type BodyTone = 'add' | 'del' | 'dim' | 'plain' | 'error'
/** One colored/hyperlinked span inside a run-rendered body line. */
type Run = {
  readonly text: string
  readonly bold?: boolean
  readonly dim?: boolean
  readonly color?: 'success' | 'error' | 'warning' | 'diffAddedWord' | 'diffRemovedWord' | 'suggestion'
  /** OSC 8 hyperlink target wrapping this run's text. */
  readonly link?: string
}
type BodyLine = { readonly text?: string; readonly tone?: BodyTone; readonly runs?: readonly Run[] }

/** CC's collapsed text body keeps 3 lines (renderTruncatedContent). */
const TEXT_BODY_MAX_LINES = 3
/** Diff bodies cap at the upstream chat row's 8 (dsh-client-ui-tool's
 *  CHAT_DIFF_MAX_LINES) — denser information than log output. */
const DIFF_BODY_MAX_LINES = 8

const GUTTER_FIRST = '  ⎿  '
const GUTTER_REST = '     '

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

/** +A / -R count line for a diff body (CC's diff header counts). */
function diffCountLine(diffs: readonly ToolFileDiff[]): BodyLine | undefined {
  let added = 0
  let removed = 0
  for (const diff of diffs) {
    if (diff.oldText !== null) removed += sideLines(diff.oldText).length
    added += sideLines(diff.newText).length
  }
  if (added === 0 && removed === 0) return undefined
  const runs: Run[] = []
  if (added > 0) runs.push({ text: `+${added}`, color: 'diffAddedWord' })
  if (removed > 0) {
    if (runs.length > 0) runs.push({ text: ' ' })
    runs.push({ text: `-${removed}`, color: 'diffRemovedWord' })
  }
  return { runs }
}

/** Join the text blocks of a view's content payload (read/generic cards). */
function contentLines(content: ReadonlyArray<{ readonly type: string; readonly text?: string }> | undefined): BodyLine[] {
  const text = (content ?? []).map(block => (block.type === 'text' ? block.text ?? '' : '')).join('').trimEnd()
  if (text === '') return []
  return text.split('\n').map(dim)
}

/** Language display names for the read-card summary (extensions → label). */
const LANGUAGE_NAMES: Record<string, string> = {
  ts: 'TypeScript',
  tsx: 'TypeScript React',
  js: 'JavaScript',
  jsx: 'JavaScript React',
  mjs: 'JavaScript',
  cjs: 'JavaScript',
  py: 'Python',
  go: 'Go',
  rs: 'Rust',
  md: 'Markdown',
  json: 'JSON',
  yml: 'YAML',
  yaml: 'YAML',
  sh: 'Shell',
  bash: 'Shell',
  zsh: 'Shell',
  css: 'CSS',
  html: 'HTML',
  java: 'Java',
  c: 'C',
  h: 'C',
  cpp: 'C++',
  cc: 'C++',
  hpp: 'C++',
  cs: 'C#',
  rb: 'Ruby',
  php: 'PHP',
  sql: 'SQL',
  toml: 'TOML',
  xml: 'XML',
  swift: 'Swift',
  kt: 'Kotlin',
}

/** `Read N lines (lines A–B of T) · TypeScript` — CC's read summary. */
function readSummary(view: Extract<ToolResultView, { card: 'read' }>): BodyLine {
  const lines = view.lines ?? []
  const count = lines.length
  const runs: Run[] = [
    { text: 'Read ', dim: true },
    { text: String(count), bold: true },
    { text: count === 1 ? ' line' : ' lines', dim: true },
  ]
  const offset = view.offset ?? lines[0]?.number
  if (view.totalLines !== undefined && offset !== undefined && count < view.totalLines) {
    runs.push({ text: ` (lines ${offset}–${offset + count - 1} of ${view.totalLines})`, dim: true })
  }
  if (view.lang !== undefined) {
    const label = LANGUAGE_NAMES[view.lang] ?? view.lang
    runs.push({ text: ` · ${label}`, dim: true })
  }
  return { runs }
}

/** `Found K matches across F files` — CC's grep summary. */
function grepSummary(view: Extract<ToolResultView, { card: 'search'; shape: 'matches' }>): BodyLine {
  const kept = view.files.reduce((sum, file) => sum + file.matches.length, 0)
  const shown = view.truncated ? kept : view.total
  const runs: Run[] = [
    { text: 'Found ', dim: true },
    { text: String(shown), bold: true },
  ]
  if (view.truncated) {
    runs.push({ text: ` of ${view.total}`, dim: true })
  }
  runs.push({ text: shown === 1 ? ' match across ' : ' matches across ', dim: true })
  const files = view.files.length
  runs.push({ text: String(files), bold: true })
  runs.push({ text: files === 1 ? ' file' : ' files', dim: true })
  return { runs }
}

/** `Found N files` — CC's glob summary. */
function globSummary(view: Extract<ToolResultView, { card: 'search'; shape: 'paths' }>): BodyLine {
  const shown = view.truncated ? view.paths.length : view.total
  const runs: Run[] = [
    { text: 'Found ', dim: true },
    { text: String(shown), bold: true },
  ]
  if (view.truncated) {
    runs.push({ text: ` of ${view.total}`, dim: true })
  }
  runs.push({ text: shown === 1 ? ' file' : ' files', dim: true })
  return { runs }
}

/** URL → host, best-effort (invalid URLs fall back to the raw string). */
function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

type ReadResultView = Extract<ToolResultView, { card: 'read' }>
type SearchMatchesView = Extract<ToolResultView, { card: 'search'; shape: 'matches' }>
type SearchPathsView = Extract<ToolResultView, { card: 'search'; shape: 'paths' }>
type WebSearchView = Extract<ToolResultView, { card: 'web'; kind: 'search' }>
type WebFetchView = Extract<ToolResultView, { card: 'web'; kind: 'fetch' }>

/** Per-card body lines; unknown/absent shapes yield [] so the caller falls
 *  back to the raw result text. */
function viewLines(view: ToolCallView | ToolResultView, verbose: boolean, highlight: CliHighlight | null): BodyLine[] {
  switch (view.card) {
    case 'diff': {
      const count = diffCountLine(view.diffs)
      const lines = diffLines(view.diffs)
      return count !== undefined ? [count, ...lines] : lines
    }
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
    case 'read': {
      // Structural lines (with numbers) — CC's read card. Fall back to the
      // content envelope when the presenter gave no structured lines.
      if (view.lines === undefined) return contentLines(view.content)
      if (view.lines.length === 0) return [dim('(empty)')]
      const summary = readSummary(view)
      if (!verbose) return [summary]
      const width = String(Math.max(...view.lines.map(line => line.number))).length
      const numbered = view.lines.map(line => {
        let text: string
        if (highlight !== null && view.lang !== undefined && highlight.supportsLanguage(view.lang)) {
          try {
            text = highlight.highlight(line.text, { language: view.lang })
          } catch {
            text = line.text
          }
        } else {
          text = line.text
        }
        return { runs: [{ text: `${String(line.number).padStart(width)} `, dim: true }, { text: `${'→'} ` , dim: true }, { text }] } as BodyLine
      })
      return [summary, ...numbered]
    }
    case 'generic':
      return contentLines('content' in view ? view.content : undefined)
    case 'search': {
      if (view.shape === 'paths') {
        const summary = globSummary(view)
        if (!verbose) return [summary]
        const lines: BodyLine[] = view.paths.map(plain)
        if (view.truncated) lines.push(dim(`… (${view.total} total)`))
        return [summary, ...lines]
      }
      const summary = grepSummary(view)
      if (!verbose) return [summary]
      const lines: BodyLine[] = []
      for (const file of view.files) {
        lines.push(plain(file.path))
        for (const match of file.matches) {
          lines.push(dim(`${match.lineNumber}: ${match.line}`))
        }
      }
      if (view.truncated) lines.push(dim(`… (${view.total} total)`))
      return [summary, ...lines]
    }
    case 'web': {
      if (view.kind === 'search') return webSearchLines(view, verbose)
      return webFetchLines(view, verbose)
    }
    default:
      return []
  }
}

function webSearchLines(view: WebSearchView, verbose: boolean): BodyLine[] {
  const lines: BodyLine[] = []
  if (view.answer !== undefined) {
    const answerLines = view.answer.trimEnd().split('\n')
    for (const line of verbose ? answerLines : answerLines.slice(0, 2)) {
      if (line !== '') lines.push(dim(line))
    }
  }
  if (view.sources.length === 0 && (view.answer === undefined || view.answer === '')) {
    lines.push(dim('No results'))
  }
  view.sources.forEach((source, index) => {
    const title = source.title?.trim() !== '' && source.title !== undefined ? source.title : source.url
    const runs: Run[] = [{ text: `${index + 1}. ` , dim: true }, { text: title, link: source.url, color: 'suggestion' }]
    lines.push({ runs })
    if (verbose && source.snippet !== undefined && source.snippet !== '') {
      lines.push(dim(`   ${source.snippet}`))
    }
  })
  if (view.truncated) lines.push(dim(`… first ${view.sources.length} sources`))
  return lines
}

function webFetchLines(view: WebFetchView, verbose: boolean): BodyLine[] {
  const statusColor: Run['color'] = view.statusCode >= 200 && view.statusCode < 300
    ? 'success'
    : view.statusCode >= 300 && view.statusCode < 400
      ? 'warning'
      : 'error'
  const runs: Run[] = [
    { text: `HTTP ${view.statusCode}`, color: statusColor },
    { text: ` · ${hostOf(view.url)}`, dim: true },
  ]
  if (view.truncated) runs.push({ text: ' · truncated', color: 'warning' })
  return [{ runs }]
}

/** Parse a job_output render text into body/content lines + status badge. */
function jobOutputLines(resultText: string, verbose: boolean, durationText: string | undefined): BodyLine[] {
  const lines = resultText.split('\n')
  const statusLine = lines[lines.length - 1] ?? ''
  const match = /^\[status: (\w+)(?:, (.*))?\]$/.exec(statusLine)
  if (match === null) return lines.map(dim)
  const body = lines.slice(0, -1)
  const status = match[1] ?? ''
  const detail = match[2] ?? ''
  const out: BodyLine[] = body.map(dim)
  if (status === 'completed') {
    const runs: Run[] = [
      { text: '[✓ ', color: 'success' },
      { text: detail, color: 'success' },
    ]
    if (durationText !== undefined) runs.push({ text: ` · ${durationText}`, dim: true })
    runs.push({ text: ']', dim: true })
    out.push({ runs })
  } else if (status === 'running' || status === 'stopping') {
    out.push(dim(status === 'running' ? '[○ running]' : '[○ stopping]'))
  } else {
    const text = detail === '' ? status : detail
    out.push({ runs: [{ text: `[✕ ${text}]`, color: 'error' }] })
  }
  if (verbose) out.push(dim(statusLine))
  return out.length > 0 ? out : lines.map(dim)
}

/** Parse a job_list render text into per-job rows. */
const JOB_LIST_ROW = /^(\S+) \[(\w+)\] (\w+) — (.*)$/

function jobListLines(resultText: string): BodyLine[] {
  if (resultText === '(no background jobs)') return [dim('(no background jobs)')]
  const out: BodyLine[] = []
  for (const line of resultText.split('\n')) {
    const match = JOB_LIST_ROW.exec(line)
    if (match === null) {
      out.push(dim(line))
      continue
    }
    const [, id, kind, status, label] = match
    let glyph: Run
    switch (status) {
      case 'running':
        glyph = { text: '● ', color: 'suggestion' }
        break
      case 'stopping':
        glyph = { text: '● ', dim: true }
        break
      case 'completed':
        glyph = { text: '◆ ', dim: true }
        break
      default:
        glyph = { text: '✕ ', color: 'error' }
        break
    }
    out.push({
      runs: [glyph, { text: `${id} ` }, { text: `${status}`, ...(status === 'running' ? { color: 'suggestion' as const } : { dim: true }) }, { text: ` — ${label}`, dim: true }, { text: ` · ${kind}`, dim: true }],
    })
  }
  return out
}

/** SubAgent/Job status line runs (CC's AgentTool summary shapes). */
function childStatsLines(tool: ToolRow, verbose: boolean): BodyLine[] {
  const stats = tool.childStats
  if (stats === undefined) return []
  const tokens = formatTokens(stats.totalTokens)
  const toolUses = String(stats.toolUses)
  const lines: BodyLine[] = []
  if (tool.status === 'running') {
    lines.push({
      runs: [
        { text: 'In progress', color: 'suggestion', bold: true },
        { text: ' · ', dim: true },
        { text: toolUses, dim: true, bold: true },
        { text: stats.toolUses === 1 ? ' tool use · ' : ' tool uses · ', dim: true },
        { text: tokens, dim: true, bold: true },
        { text: ' tokens', dim: true },
      ],
    })
    return lines
  }
  // Settled: Done (N tool uses · X tokens · dur) — duration from the child's
  // own event span when present, else the card duration.
  const span = stats.endedAt !== undefined && stats.firstEventAt !== undefined
    ? stats.endedAt - stats.firstEventAt
    : tool.durationMs
  const durationText = span !== undefined ? formatDuration(span) : ''
  const stopLabel = stats.stopReason !== undefined && stats.stopReason !== 'completed'
    ? (stats.stopReason === 'aborted' ? 'Cancelled' : stats.stopReason === 'error' ? 'Error' : stats.stopReason === 'max-tokens' ? 'Max tokens' : stats.stopReason === 'refusal' ? 'Refusal' : stats.stopReason)
    : 'Done'
  const verbColor: Run['color'] = stopLabel === 'Done' ? 'suggestion' : stopLabel === 'Refusal' ? 'warning' : 'error'
  const runs: Run[] = [
    { text: stopLabel, color: verbColor, bold: true },
    { text: ' (', dim: true },
    { text: toolUses, color: 'suggestion', bold: true },
    { text: stats.toolUses === 1 ? ' tool use · ' : ' tool uses · ', dim: true },
    { text: tokens, color: 'suggestion', bold: true },
    { text: ' tokens', dim: true },
  ]
  if (durationText !== '') {
    runs.push({ text: ' · ', dim: true }, { text: durationText, dim: true })
  }
  runs.push({ text: ')', dim: true })
  lines.push({ runs })
  const text = tool.resultFull ?? tool.resultText ?? ''
  if (text !== '') {
    if (verbose) {
      for (const line of text.split('\n')) lines.push(dim(line))
    } else {
      for (const line of text.split('\n').slice(0, 2)) {
        if (line.trim() !== '') lines.push(dim(line))
      }
    }
  }
  return lines
}

/** bash run_in_background settled card: live status line from ctx.jobs sync. */
function jobStatusLines(tool: ToolRow, verbose: boolean): BodyLine[] {
  const ackText = tool.resultFull ?? tool.resultText ?? ''
  if (ackText !== '') {
    // Before the first jobs sync lands, keep the ack line visible.
    const ack = tool.jobStatus === undefined ? [dim(ackText)] : []
    const status = tool.jobStatus
    const detail = tool.jobDetail
    if (status === undefined) return ack
    if (status === 'running' || status === 'stopping') {
      return [...ack, { runs: [{ text: status === 'running' ? 'Running' : 'Stopping', color: 'suggestion', bold: true }, { text: ' · ', dim: true }, { text: formatDuration(Date.now() - (tool.childStats?.firstEventAt ?? tool.startedAt)), dim: true }] }]
    }
    const ok = status === 'completed'
    const runs: Run[] = [
      { text: detail ?? status, color: ok ? 'success' : 'error' },
    ]
    if (tool.childStats?.endedAt !== undefined && tool.childStats.firstEventAt !== undefined) {
      runs.push({ text: ` · ${formatDuration(tool.childStats.endedAt - tool.childStats.firstEventAt)}`, dim: true })
    }
    return [...ack, { runs }]
  }
  return []
}

/** job_output card body: content preview + [✓ exit code: 0 · 3m 4s] badge. */
function jobOutputCardLines(tool: ToolRow, verbose: boolean): BodyLine[] {
  const text = tool.resultFull ?? tool.resultText ?? ''
  if (text === '') return []
  let durationText: string | undefined
  if (tool.childStats?.endedAt !== undefined && tool.childStats.firstEventAt !== undefined) {
    durationText = formatDuration(tool.childStats.endedAt - tool.childStats.firstEventAt)
  }
  const lines = jobOutputLines(text, verbose, durationText)
  if (verbose) return lines
  // collapsed: at most 2 content rows + badge fit inside the 3-line budget
  const badge = lines[lines.length - 1]
  const content = lines.slice(0, -1)
  const budget = TEXT_BODY_MAX_LINES - 1
  if (content.length > budget) {
    return [...content.slice(0, budget), dim(`… +${content.length - budget} lines (ctrl+o to expand)`), badge]
  }
  return lines
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
            <Text>({displayArgs})</Text>
          </Box>
        )}
      </>
    )
  }
  if (isTerminal) {
    const folded = title.replace(/\s*\n\s*/g, ' ⏎ ')
    const clipped = folded.length > 160 ? `${folded.slice(0, 159)}…` : folded
    return (
      <>
        <Box flexShrink={0}>
          <Text bold wrap="truncate-end">{name}</Text>
        </Box>
        <Box flexWrap="nowrap">
          <Text>({clipped})</Text>
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

/** Render one run span: OSC 8 hyperlink when linked, else a styled Text. */
function RunText({ run }: { run: Run }): React.ReactNode {
  if (run.link !== undefined) {
    return (
      <Text color={run.color} bold={run.bold}>
        {createHyperlink(run.link, run.text)}
      </Text>
    )
  }
  return (
    <Text color={run.color} bold={run.bold} dimColor={run.dim}>
      {run.text === '' ? ' ' : run.text}
    </Text>
  )
}

/**
 * Tool-call card: `● Edit /path` header with a blinking status dot, then the
 * structured body under a `  ⎿  ` gutter — diff hunks in red/green, terminal
 * output, read content — instead of the raw result dump (ported from the
 * leak's `AssistantToolUseMessage.tsx` + the dsh-tools presentation views the
 * channel captures per call).
 */
export function AssistantToolUseMessage({
  tool,
  addMargin,
  verbose,
  isSelected = false,
  isExpanded = false,
}: Props): React.ReactNode {
  const isRunning = tool.status === 'running'
  const isError = tool.status === 'error'
  const name = displayName(tool.name)
  // Presenterless delegation tools get a parsed header argument instead of
  // raw JSON (verbose keeps the full args for audit).
  const parsedArgs = verbose ? undefined : headerArgs(tool.name, tool.argsFull)
  const displayArgs = parsedArgs !== undefined ? parsedArgs : (verbose ? tool.argsFull ?? tool.argsText : tool.argsText)
  const result = tool.resultFull ?? tool.resultText
  const minWidth = stringWidth(name) + 2
  // The settled view carries the applied diff / actual output; while running,
  // the call view already shows the pending change (CC's pending Edit diff).
  const view = tool.resultView ?? tool.callView
  // presentResult may omit a title (terminal results carry output, not a
  // command) — then the call view's title stands.
  const headerTitle = tool.resultView?.title ?? tool.callView?.title
  const headerIsTerminal = view?.card === 'terminal'

  // Shared lazy cli-highlight load (Markdown.tsx pattern) for verbose read
  // bodies; null until loaded → plain dim text.
  const [highlight, setHighlight] = React.useState<CliHighlight | null>(null)
  React.useEffect(() => {
    let alive = true
    void getCliHighlightPromise().then(loaded => {
      if (alive) setHighlight(loaded)
    })
    return () => {
      alive = false
    }
  }, [])

  // Live elapsed clock while the call runs (CC's bash elapsed timer): the
  // 1s tick re-renders the card; elapsed derives from wall-clock refs.
  // Background job cards keep ticking after settle (live Running… line).
  const liveAfterSettle = !isRunning && !isError && tool.jobId !== undefined
    && (tool.jobStatus === 'running' || tool.jobStatus === 'stopping')
  const [viewportRef] = useAnimationFrame(isRunning || liveAfterSettle ? 1000 : null)
  const elapsedMs = isRunning
    ? tool.startedAt !== undefined
      ? Date.now() - tool.startedAt
      : undefined
    : tool.durationMs
  const elapsedText = elapsedMs !== undefined ? ` · ${formatDuration(elapsedMs)}` : ''

  // Body lines: the structured view first, raw result text as the fallback
  // (tools without a presenter, or a folded row awaiting loadOlder).
  let body: BodyLine[] = []
  if (isError) {
    if (tool.errorText) body = [{ text: tool.errorText, tone: 'error' }]
  } else if (tool.childStats !== undefined && (tool.name === 'subagent' || tool.name === 'subagent_fork')) {
    body = childStatsLines(tool, verbose)
  } else if (tool.name === 'job_output') {
    body = jobOutputCardLines(tool, verbose)
    if (body.length === 0 && result) body = result.trimEnd().split('\n').map(dim)
  } else if (tool.name === 'job_list') {
    body = result !== undefined ? jobListLines(result.trimEnd()) : []
    if (body.length === 0 && result) body = result.trimEnd().split('\n').map(dim)
  } else if (view !== undefined) {
    body = viewLines(view, verbose, highlight)
    if (view.card === 'terminal' && tool.callView?.card === 'terminal' && tool.callView.description !== undefined && tool.callView.description !== '') {
      body = [dim(tool.callView.description), ...body]
    }
  }
  if (body.length === 0 && result && !isRunning) {
    // Settled quiet tools suppress the body entirely (collapsed only).
    if (!(verbose === false && QUIET_RESULTS[tool.name] === true)) {
      body = result.trimEnd().split('\n').map(dim)
    }
  }
  if (body.length === 0 && isRunning) {
    body = [dim(`Running… (${formatDuration(Math.max(0, Date.now() - (tool.startedAt ?? Date.now())))})`)]
  }
  // Background bash/pwsh job cards replace the ack line with a live status
  // line once ctx.jobs syncs a snapshot (channel-side correlation).
  if (!isRunning && !isError && tool.jobId !== undefined && (tool.name === 'bash' || tool.name === 'pwsh')) {
    const status = jobStatusLines(tool, verbose)
    if (status.length > 0) body = status
  }
  const cap = view?.card === 'diff' ? DIFF_BODY_MAX_LINES : TEXT_BODY_MAX_LINES
  const lines = capLines(body, cap, verbose)

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
            : undefined
      }
    >
      <Box flexDirection="column" flexGrow={1}>
        <Box flexDirection="row" flexWrap="nowrap" minWidth={minWidth}>
          <ToolUseLoader
            shouldAnimate={isRunning}
            isUnresolved={isRunning}
            isError={isError}
          />
          <HeaderTitle name={name} title={headerTitle} isTerminal={headerIsTerminal} displayArgs={displayArgs} />
          {!isRunning && (
            <Box flexWrap="nowrap">
              <Text dimColor>{elapsedText}</Text>
            </Box>
          )}
        </Box>
        {lines.map((line, index) => (
          <Box key={index} flexDirection="row">
            <Box width={5} flexShrink={0}>
              <Text dimColor>{index === 0 ? GUTTER_FIRST : GUTTER_REST}</Text>
            </Box>
            <Box flexGrow={1}>
              {line.runs !== undefined ? (
                <Text wrap="wrap">
                  {line.runs.map((run, runIndex) => (
                    <RunText key={runIndex} run={run} />
                  ))}
                </Text>
              ) : (
                <Text
                  color={
                    line.tone === 'add'
                      ? 'diffAddedWord'
                      : line.tone === 'del'
                        ? 'diffRemovedWord'
                        : line.tone === 'error'
                          ? 'error'
                          : undefined
                  }
                  dimColor={line.tone === 'dim'}
                  wrap="wrap"
                >
                  {(line.text ?? '') === '' ? ' ' : line.text}
                </Text>
              )}
            </Box>
          </Box>
        ))}
      </Box>
    </Box>
  )
}
