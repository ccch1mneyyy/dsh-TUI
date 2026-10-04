/**
 * Claude tool presentations (docs/agent-backend-design.md §4.6, §5.2): which
 * card shape each Claude Code tool call and result renders as, in the
 * backend-neutral `ToolPresentation` vocabulary the shared projector and the
 * tool card already understand. The UI never picks a card by tool name; this
 * table does, from the tool input and the structured `tool_use_result`.
 *
 * Every reader narrows `unknown`: inputs come from the model and structured
 * results are undeclared in the SDK types (design appendix B). A shape this
 * module does not recognise degrades to the plain text card.
 */
import { isAbsolute, relative } from 'node:path'
import type { ToolFileDiff } from '../../adapter/ports/channel-view.js'
import type { ToolCallPresentation, ToolPresentationMeta, ToolResultPresentation } from '../../agent/presentation.js'
import { num, rec, str, type Rec } from './narrow.js'

/** How a tool call is projected besides (or instead of) a card. */
export type ClaudeToolRole =
  /** An ordinary tool card. */
  | 'card'
  /** `Agent`/`Task`: a subagent delegation (subagent row, never a card). */
  | 'subagent'
  /** `AskUserQuestion`: the questionnaire surface. */
  | 'question'
  /** `TodoWrite` and the task family that replaced it (CLI 2.1.284:
   *  `TaskCreate`/`TaskUpdate`/`TaskList`/`TaskGet`): the todo panel, never
   *  a card — the translator emits `todo.write` snapshots for them. Not the
   *  `Task` subagent delegation nor `TaskStop` (a background task). */
  | 'todo'
  /** `EnterPlanMode` / `ExitPlanMode`: the mode and the plan-review panel,
   *  never a card (the translator emits no call for them). */
  | 'plan'

const META: Readonly<Record<string, ToolPresentationMeta>> = {
  Read: { displayKey: 'tool-name-read', category: 'other' },
  Write: { displayKey: 'tool-name-write', category: 'mutate' },
  Edit: { displayKey: 'tool-name-edit', category: 'mutate' },
  MultiEdit: { displayKey: 'tool-name-multiedit', category: 'mutate' },
  NotebookEdit: { displayKey: 'tool-name-notebookedit', category: 'mutate' },
  Bash: { displayKey: 'tool-name-bash', category: 'exec' },
  PowerShell: { displayKey: 'tool-name-powershell', category: 'exec' },
  Glob: { displayKey: 'tool-name-glob', category: 'other' },
  Grep: { displayKey: 'tool-name-grep', category: 'other' },
  WebFetch: { displayKey: 'tool-name-webfetch', category: 'other' },
  WebSearch: { displayKey: 'tool-name-web_search', category: 'other' },
  Skill: { displayKey: 'tool-name-skill', category: 'other' },
}
const metaOf = (name: string): ToolPresentationMeta => (Object.hasOwn(META, name) ? META[name] : undefined) ?? { category: 'other' }

/** The role of a tool call (cards are the default). */
export function claudeToolRole(name: string): ClaudeToolRole {
  switch (name) {
    case 'Agent':
    case 'Task':
      return 'subagent'
    case 'AskUserQuestion':
      return 'question'
    case 'TodoWrite':
    // The task tools that replaced TodoWrite (CLI 2.1.284); both families
    // are shouldDefer tools, so the preset alone never surfaces them.
    case 'TaskCreate':
    case 'TaskUpdate':
    case 'TaskList':
    case 'TaskGet':
      return 'todo'
    case 'EnterPlanMode':
    case 'ExitPlanMode':
      return 'plan'
    default:
      return 'card'
  }
}

/** A path for a title: relative to the session cwd when inside it. */
export function displayPath(path: string, cwd: string): string {
  if (!isAbsolute(path) || cwd === '') return path
  const rel = relative(cwd, path)
  return rel === '' || rel.startsWith('..') || isAbsolute(rel) ? path : rel
}

/** `mcp__<server>__<tool>` → `server › tool`. */
function mcpTitle(name: string): string | undefined {
  const match = /^mcp__(.+?)__(.+)$/u.exec(name)
  return match === null ? undefined : `${match[1]} › ${match[2]}`
}

/** Replace the first (or every) occurrence literally — no `$` patterns. */
function replaceLiteral(text: string, from: string, to: string, all: boolean): string {
  if (from === '') return text
  if (all) return text.split(from).join(to)
  const index = text.indexOf(from)
  return index === -1 ? text : text.slice(0, index) + to + text.slice(index + from.length)
}

/** The diffs an Edit/MultiEdit input describes, applied to `original` when
 *  the full before-image is known (else snippet diffs). */
function editDiffs(path: string, edits: readonly { old: string; new: string; all: boolean }[], original: string | undefined): ToolFileDiff[] {
  if (original !== undefined) {
    let next = original
    for (const edit of edits) next = replaceLiteral(next, edit.old, edit.new, edit.all)
    return [{ path, oldText: original, newText: next }]
  }
  return edits.map(edit => ({ path, oldText: edit.old, newText: edit.new }))
}

function editsOf(name: string, input: Rec): { old: string; new: string; all: boolean }[] {
  if (name === 'MultiEdit') {
    const list = Array.isArray(input.edits) ? input.edits : []
    return list.flatMap(item => {
      const edit = rec(item)
      const from = str(edit?.old_string)
      const to = str(edit?.new_string)
      return from === undefined || to === undefined ? [] : [{ old: from, new: to, all: edit?.replace_all === true }]
    })
  }
  const from = str(input.old_string)
  const to = str(input.new_string)
  return from === undefined || to === undefined ? [] : [{ old: from, new: to, all: input.replace_all === true }]
}

/** How a call renders while it runs. */
export function presentClaudeToolCall(name: string, rawInput: unknown, cwd: string): ToolCallPresentation | undefined {
  const role = claudeToolRole(name)
  if (role === 'subagent') return { card: 'subagent' }
  if (role === 'question') return { card: 'question' }
  if (role === 'todo') return { card: 'todo' }
  // Plan-mode tools never reach here as calls; a stray one stays a plain card.
  const input = rec(rawInput) ?? {}
  const meta = metaOf(name)
  const filePath = str(input.file_path) ?? str(input.notebook_path)
  switch (name) {
    case 'Read': {
      if (filePath === undefined) return undefined
      const offset = num(input.offset)
      return { card: 'generic', title: `${displayPath(filePath, cwd)}${offset === undefined ? '' : `:${offset}`}`, ...meta }
    }
    case 'Write': {
      const content = str(input.content)
      if (filePath === undefined || content === undefined) return undefined
      return { card: 'diff', title: displayPath(filePath, cwd), diffs: [{ path: filePath, oldText: null, newText: content }], ...meta }
    }
    case 'Edit':
    case 'MultiEdit': {
      if (filePath === undefined) return undefined
      const edits = editsOf(name, input)
      if (edits.length === 0) return { card: 'generic', title: displayPath(filePath, cwd), ...meta }
      return { card: 'diff', title: displayPath(filePath, cwd), diffs: editDiffs(filePath, edits, undefined), ...meta }
    }
    case 'NotebookEdit':
      return filePath === undefined ? undefined : { card: 'generic', title: displayPath(filePath, cwd), ...meta }
    case 'Bash':
    case 'PowerShell': {
      const command = str(input.command)
      if (command === undefined) return undefined
      const description = str(input.description)
      return { card: 'terminal', title: command, ...(description === undefined ? {} : { description }), cwd, ...meta }
    }
    case 'Glob':
    case 'Grep': {
      const pattern = str(input.pattern)
      if (pattern === undefined) return undefined
      const where = str(input.path)
      return { card: 'generic', title: where === undefined ? pattern : `${pattern} · ${displayPath(where, cwd)}`, ...meta }
    }
    case 'WebFetch':
      return { card: 'generic', title: str(input.url) ?? name, ...meta }
    case 'WebSearch':
      return { card: 'generic', title: str(input.query) ?? name, ...meta }
    case 'Skill': {
      const skill = str(input.skill) ?? str(input.name)
      return { card: 'generic', title: skill ?? name, ...meta }
    }
    default: {
      const title = mcpTitle(name)
      return title === undefined ? undefined : { card: 'generic', title, ...meta }
    }
  }
}

/** The settled facts of one tool result. */
export interface ClaudeToolOutcome {
  readonly isError: boolean
  /** The result's text blocks joined. */
  readonly text: string
  /** `tool_use_result` (undeclared, per-tool). */
  readonly structured: unknown
}

/** Parse `path:line:text` grep output into per-file matches. */
function grepMatches(content: string): { path: string; matches: { lineNumber: number; line: string }[] }[] {
  const files = new Map<string, { lineNumber: number; line: string }[]>()
  for (const raw of content.split('\n')) {
    const match = /^(.+?):(\d+):(.*)$/u.exec(raw)
    if (match === null) continue
    const list = files.get(match[1]!) ?? []
    list.push({ lineNumber: Number(match[2]), line: match[3]! })
    files.set(match[1]!, list)
  }
  return [...files].map(([path, matches]) => ({ path, matches }))
}

/** How a settled result renders (undefined = the plain text card). */
export function presentClaudeToolResult(name: string, rawInput: unknown, outcome: ClaudeToolOutcome, cwd: string): ToolResultPresentation | undefined {
  if (outcome.isError || claudeToolRole(name) !== 'card') return undefined
  const input = rec(rawInput) ?? {}
  const result = rec(outcome.structured)
  const meta = metaOf(name)
  switch (name) {
    case 'Read': {
      const file = rec(result?.file)
      const path = str(file?.filePath) ?? str(input.file_path)
      const content = str(file?.content)
      if (path === undefined || content === undefined) return undefined
      return { card: 'read', title: displayPath(path, cwd), path, content: [{ type: 'text', text: content }], ...meta }
    }
    case 'Write': {
      const path = str(result?.filePath) ?? str(input.file_path)
      const content = str(result?.content) ?? str(input.content)
      if (path === undefined || content === undefined) return undefined
      const original = str(result?.originalFile)
      return { card: 'diff', title: displayPath(path, cwd), diffs: [{ path, oldText: original ?? null, newText: content }], ...meta }
    }
    case 'Edit':
    case 'MultiEdit': {
      const path = str(result?.filePath) ?? str(input.file_path)
      if (path === undefined) return undefined
      const edits = editsOf(name, input)
      if (edits.length === 0) return undefined
      return { card: 'diff', title: displayPath(path, cwd), diffs: editDiffs(path, edits, str(result?.originalFile)), ...meta }
    }
    case 'Bash':
    case 'PowerShell': {
      const stdout = str(result?.stdout) ?? outcome.text
      const stderr = str(result?.stderr) ?? ''
      const output = [stdout, stderr].filter(part => part !== '').join('\n')
      return { card: 'terminal', output: result?.interrupted === true ? `${output}\n[aborted]` : output, exitCode: 0, ...meta }
    }
    case 'Glob': {
      const paths = Array.isArray(result?.filenames) ? result.filenames.filter((path): path is string => typeof path === 'string') : outcome.text.split('\n').filter(line => line !== '')
      return { card: 'search', shape: 'paths', paths: paths.map(path => displayPath(path, cwd)), truncated: result?.truncated === true, total: num(result?.numFiles) ?? paths.length, ...meta }
    }
    case 'Grep': {
      const content = str(result?.content)
      if (str(result?.mode) === 'content' && content !== undefined) {
        const files = grepMatches(content).map(file => ({ path: displayPath(file.path, cwd), matches: file.matches }))
        return { card: 'search', shape: 'matches', files, truncated: false, total: files.reduce((sum, file) => sum + file.matches.length, 0), ...meta }
      }
      const paths = Array.isArray(result?.filenames) ? result.filenames.filter((path): path is string => typeof path === 'string') : []
      if (paths.length === 0) return undefined
      return { card: 'search', shape: 'paths', paths: paths.map(path => displayPath(path, cwd)), truncated: false, total: num(result?.numFiles) ?? paths.length, ...meta }
    }
    default:
      return undefined
  }
}
