/**
 * Codex tool items as tool cards (docs/codex-backend-design.md §7.4, §8):
 * the tool name the transcript records, its arguments, and the card shape
 * each call and result renders as, in the backend-neutral presentation
 * vocabulary. The UI never picks a card by tool name; this module does,
 * from the item itself.
 *
 * Titles carry only the item's own text (commands, paths, queries): the
 * localized tool name comes from `displayKey`, so a language switch repaints.
 *
 * Diffs: an added file's `diff` is its content, a deleted one's is the old
 * content (C0 V13), an update is an unheaded unified hunk. Until the shared
 * patch view exists (N5, C2) an update renders as old/new text rebuilt from
 * its hunks (line numbers restart at 1 for each file).
 */
import type { ContentBlockView } from '../../../agent/events.js'
import type { ToolFileDiff } from '../../../adapter/ports/channel-view.js'
import type { ToolCallPresentation, ToolPresentationMeta, ToolResultPresentation } from '../../../agent/presentation.js'
import { displayPath } from '../../shared/display-path.js'
import { arr, num, rec, str, type Rec } from '../narrow.js'
import { classifyCommand, commandTitle, unwrapCommand, type CommandKind } from './commands.js'

/** The item types this module renders as tool cards. */
export const TOOL_ITEM_TYPES: ReadonlySet<string> = new Set([
  'commandExecution', 'fileChange', 'mcpToolCall', 'dynamicToolCall', 'webSearch',
  'imageView', 'imageGeneration', 'sleep', 'collabAgentToolCall',
])

/** How a tool item's call is recorded. */
export interface CodexToolCall {
  readonly name: string
  readonly argsJson: string
  readonly presentation?: ToolCallPresentation
}

/** How a tool item's settled result is recorded. */
export interface CodexToolResult {
  readonly isError: boolean
  readonly text: string
  readonly content: readonly ContentBlockView[]
  /** Set exactly when `isError`: the failure's own words, or a fixed one. */
  readonly errorText?: string
  readonly structured?: unknown
  readonly presentation?: ToolResultPresentation
}

/** Fixed result texts the translator localizes (the caller passes `t`). */
export interface ResultWords {
  readonly declined: string
  readonly failed: string
}

const EXEC: ToolPresentationMeta = { displayKey: 'tool-name-bash', category: 'exec' }
const READ: ToolPresentationMeta = { displayKey: 'tool-name-read', category: 'other' }
const GREP: ToolPresentationMeta = { displayKey: 'tool-name-grep', category: 'other' }
const GLOB: ToolPresentationMeta = { displayKey: 'tool-name-glob', category: 'other' }
const EDIT: ToolPresentationMeta = { displayKey: 'tool-name-edit', category: 'mutate' }
const WRITE: ToolPresentationMeta = { displayKey: 'tool-name-write', category: 'mutate' }
const SEARCH: ToolPresentationMeta = { displayKey: 'tool-name-web_search', category: 'other' }

/** The command a `commandExecution` item ran, unwrapped (§8.1). */
const commandOf = (item: Rec): string => unwrapCommand(str(item.command) ?? '', item.commandActions)

/** The kind and title of a command item. */
function commandShape(item: Rec, cwd: string): { kind: CommandKind; title: string; meta: ToolPresentationMeta } {
  const command = commandOf(item)
  const kind = classifyCommand(item.commandActions)
  const shell = str(item.source) === 'userShell'
  switch (kind.kind) {
    case 'read':
      return { kind, title: kind.paths.map(path => displayPath(path, cwd)).join(', '), meta: READ }
    case 'search': {
      const where = kind.path === undefined ? undefined : displayPath(kind.path, cwd)
      const title = kind.query === undefined ? (where ?? commandTitle(command)) : where === undefined ? kind.query : `${kind.query} · ${where}`
      return { kind, title, meta: GREP }
    }
    case 'list':
      return { kind, title: kind.path === undefined ? '.' : displayPath(kind.path, cwd), meta: GLOB }
    default:
      return { kind, title: `${shell ? '!' : ''}${commandTitle(command)}`, meta: EXEC }
  }
}

/** Rebuild old/new text from an unheaded unified hunk (the C1 fallback). */
export function hunkTexts(patch: string): { oldText: string; newText: string } {
  const before: string[] = []
  const after: string[] = []
  const lines = patch.split('\n')
  if (lines.at(-1) === '') lines.pop()
  for (const line of lines) {
    if (line.startsWith('@@') || line.startsWith('--- ') || line.startsWith('+++ ') || line.startsWith('\\')) continue
    const mark = line[0]
    const body = line.slice(1)
    if (mark === '-') before.push(body)
    else if (mark === '+') after.push(body)
    else {
      // ' ' (context) — or an empty line some writers leave unprefixed.
      before.push(mark === ' ' ? body : line)
      after.push(mark === ' ' ? body : line)
    }
  }
  const joined = (list: string[]): string => list.length === 0 ? '' : `${list.join('\n')}\n`
  return { oldText: joined(before), newText: joined(after) }
}

/** The file diffs of a `fileChange` item. */
function diffsOf(item: Rec): ToolFileDiff[] {
  return arr(item.changes).flatMap((raw): ToolFileDiff[] => {
    const change = rec(raw)
    const path = str(change?.path)
    if (change === undefined || path === undefined) return []
    const diff = str(change.diff) ?? ''
    const kind = rec(change.kind)
    switch (str(kind?.type)) {
      case 'add':
        return [{ path, oldText: null, newText: diff }]
      case 'delete':
        return [{ path, oldText: diff, newText: '' }]
      default: {
        const moved = str(kind?.move_path)
        return [{ path: moved ?? path, ...hunkTexts(diff) }]
      }
    }
  })
}

/** The title of a `fileChange` card: the file (or files) it touches. */
function changeTitle(item: Rec, cwd: string): string {
  return arr(item.changes).flatMap(raw => {
    const change = rec(raw)
    const path = str(change?.path)
    if (path === undefined) return []
    const moved = str(rec(change?.kind)?.move_path)
    return [moved === undefined ? displayPath(path, cwd) : `${displayPath(path, cwd)} → ${displayPath(moved, cwd)}`]
  }).join(', ')
}

const allAdds = (item: Rec): boolean => {
  const changes = arr(item.changes)
  return changes.length > 0 && changes.every(raw => str(rec(rec(raw)?.kind)?.type) === 'add')
}

/** How a tool item's call is recorded; undefined for a non-tool item. */
export function toolCallOf(item: Rec, cwd: string): CodexToolCall | undefined {
  const type = str(item.type)
  if (type === undefined || !TOOL_ITEM_TYPES.has(type)) return undefined
  switch (type) {
    case 'commandExecution': {
      const shape = commandShape(item, cwd)
      const name = str(item.source) === 'userShell' ? 'user_shell' : 'shell'
      const argsJson = JSON.stringify({ command: commandOf(item), cwd: str(item.cwd) ?? cwd })
      const presentation: ToolCallPresentation = shape.kind.kind === 'read'
        ? { card: 'generic', title: shape.title, ...shape.meta }
        : { card: 'terminal', title: shape.title, cwd: str(item.cwd) ?? cwd, ...shape.meta }
      return { name, argsJson, presentation }
    }
    case 'fileChange': {
      const changes = arr(item.changes).map(raw => {
        const change = rec(raw)
        return { path: str(change?.path) ?? '', kind: str(rec(change?.kind)?.type) ?? 'update' }
      })
      return {
        name: 'apply_patch',
        argsJson: JSON.stringify({ changes }),
        presentation: { card: 'diff', title: changeTitle(item, cwd), diffs: diffsOf(item), ...(allAdds(item) ? WRITE : EDIT) },
      }
    }
    case 'mcpToolCall': {
      const server = str(item.server) ?? 'mcp'
      const tool = str(item.tool) ?? 'tool'
      return { name: `mcp__${server}__${tool}`, argsJson: JSON.stringify(item.arguments ?? {}), presentation: { card: 'generic', title: `${server} › ${tool}` } }
    }
    case 'dynamicToolCall': {
      const namespace = str(item.namespace)
      const tool = str(item.tool) ?? 'tool'
      const label = namespace === undefined ? tool : `${namespace}.${tool}`
      return { name: label, argsJson: JSON.stringify(item.arguments ?? {}), presentation: { card: 'generic', title: label } }
    }
    case 'webSearch': {
      const action = rec(item.action)
      const query = str(item.query) || str(action?.query) || str(action?.url) || ''
      return { name: 'web_search', argsJson: JSON.stringify({ query }), presentation: { card: 'generic', title: query, ...SEARCH } }
    }
    case 'imageView': {
      const path = str(item.path) ?? ''
      return { name: 'view_image', argsJson: JSON.stringify({ path }), presentation: { card: 'generic', title: displayPath(path, cwd) } }
    }
    case 'imageGeneration':
      return { name: 'image_generation', argsJson: JSON.stringify({ prompt: str(item.revisedPrompt) ?? '' }), presentation: { card: 'generic', title: str(item.revisedPrompt) ?? '' } }
    case 'sleep': {
      const ms = num(item.durationMs)
      return { name: 'sleep', argsJson: JSON.stringify({ durationMs: ms ?? null }), presentation: { card: 'generic', title: ms === undefined ? '' : `${Math.round(ms / 1000)}s` } }
    }
    case 'collabAgentToolCall':
      return { name: 'collab_agent', argsJson: JSON.stringify({ tool: str(item.tool) ?? '', prompt: str(item.prompt) ?? null }), presentation: { card: 'generic', title: str(item.tool) ?? '' } }
    default:
      return undefined
  }
}

const textBlocks = (text: string): readonly ContentBlockView[] => text === '' ? [] : [{ type: 'text', text }]

/** A failed command's card text: its output, then the exit code. */
function failureText(output: string, exitCode: number | undefined, failed: string): string {
  const tail = exitCode === undefined ? failed : `exit ${exitCode}`
  return output.trim() === '' ? tail : `${output.trimEnd()}\n${tail}`
}

/** How a settled tool item's result is recorded. */
export function toolResultOf(item: Rec, cwd: string, words: ResultWords): CodexToolResult {
  const type = str(item.type)
  const status = str(item.status)
  switch (type) {
    case 'commandExecution': {
      const output = str(item.aggregatedOutput) ?? ''
      const exitCode = num(item.exitCode)
      if (status === 'declined') return { isError: true, text: '', content: [], errorText: words.declined }
      const failed = status !== 'completed' || (exitCode ?? 0) !== 0
      const shape = commandShape(item, cwd)
      if (!failed && shape.kind.kind === 'read') {
        const presentation: ToolResultPresentation = shape.kind.paths.length === 1
          ? { card: 'read', title: shape.title, path: shape.kind.paths[0]!, content: [{ type: 'text', text: output }], ...shape.meta }
          : { card: 'generic', title: shape.title, content: [{ type: 'text', text: output }], ...shape.meta }
        return { isError: false, text: output, content: textBlocks(output), presentation }
      }
      const presentation: ToolResultPresentation = { card: 'terminal', output, ...(exitCode === undefined ? {} : { exitCode }), ...shape.meta }
      return failed
        ? { isError: true, text: '', content: [], errorText: failureText(output, exitCode, words.failed), presentation }
        : { isError: false, text: output, content: textBlocks(output), presentation }
    }
    case 'fileChange': {
      if (status === 'declined') return { isError: true, text: '', content: [], errorText: words.declined }
      const presentation: ToolResultPresentation = { card: 'diff', title: changeTitle(item, cwd), diffs: diffsOf(item), ...(allAdds(item) ? WRITE : EDIT) }
      if (status !== 'completed') return { isError: true, text: '', content: [], errorText: words.failed, presentation }
      return { isError: false, text: '', content: [], presentation }
    }
    case 'mcpToolCall': {
      const result = rec(item.result)
      const error = str(rec(item.error)?.message)
      const content: ContentBlockView[] = arr(result?.content).flatMap(raw => {
        const block = rec(raw)
        const kind = str(block?.type)
        if (block === undefined || kind === undefined) return []
        return [kind === 'text' ? { type: 'text', text: str(block.text) ?? '' } : { type: kind }]
      })
      const text = content.flatMap(block => block.type === 'text' && block.text !== undefined ? [block.text] : []).join('\n')
      const failed = error !== undefined || status === 'failed'
      return failed
        ? { isError: true, text: '', content, errorText: error ?? words.failed }
        : { isError: false, text, content, ...(result?.structuredContent === undefined || result.structuredContent === null ? {} : { structured: result.structuredContent }) }
    }
    case 'dynamicToolCall': {
      const content: ContentBlockView[] = arr(item.contentItems).flatMap(raw => {
        const block = rec(raw)
        const kind = str(block?.type)
        if (block === undefined || kind === undefined) return []
        return [kind === 'inputText' ? { type: 'text', text: str(block.text) ?? '' } : { type: kind }]
      })
      const text = content.flatMap(block => block.type === 'text' && block.text !== undefined ? [block.text] : []).join('\n')
      const failed = item.success === false || status === 'failed'
      return failed ? { isError: true, text: '', content, errorText: text !== '' ? text : words.failed } : { isError: false, text, content }
    }
    case 'webSearch': {
      const action = rec(item.action)
      const queries = arr(action?.queries).filter((query): query is string => typeof query === 'string')
      const summary = str(action?.url) ?? (queries.length > 0 ? queries.join('\n') : str(action?.query) ?? str(item.query) ?? '')
      return { isError: false, text: summary, content: textBlocks(summary) }
    }
    case 'imageGeneration': {
      const failure = rec(item.failure)
      if (failure !== undefined || status === 'failed') return { isError: true, text: '', content: [], errorText: str(failure?.message) ?? words.failed }
      const saved = str(item.savedPath) ?? ''
      return { isError: false, text: saved, content: textBlocks(saved) }
    }
    default:
      return { isError: status === 'failed', text: '', content: [], ...(status === 'failed' ? { errorText: words.failed } : {}) }
  }
}
