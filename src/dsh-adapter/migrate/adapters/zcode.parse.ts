/**
 * zcode session parsing (pure): one `<taskId>.json` → one
 * {@link MigrationSession}.
 *
 * One JSON object per conversation (`{ meta, messages }`) with plain-string
 * contents and epoch-millisecond timestamps. Only the text roles are mapped:
 * no sample of this store with tool traffic or reasoning has been available,
 * so no such field is guessed at.
 *
 * @module @deepseek-harness-tui/dsh-tui/migrate/adapters/zcode.parse
 */
import { isInjectedText, unwrapUserText } from '../parse/injection.js'
import { isRecord } from '../parse/jsonl.js'
import { emptyStats } from '../parse/role-turns.js'
import { normalizeTitle } from '../parse/title.js'
import { newStep } from '../parse/tools.js'
import type { ImportTurn, MigrationSession } from '../types.js'

/**
 * Parse one zcode session document.
 * @returns The session, or undefined when the document is not a
 *   `{ meta, messages }` object with a task id and workspace, or holds no
 *   prompt.
 */
export function parseZcodeSession(raw: string): MigrationSession | undefined {
  let doc: unknown
  try {
    doc = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (!isRecord(doc) || !isRecord(doc.meta) || !Array.isArray(doc.messages)) return undefined
  const { taskId, workspacePath, title, createdAt } = doc.meta
  if (typeof taskId !== 'string' || taskId === '') return undefined
  if (typeof workspacePath !== 'string' || workspacePath === '') return undefined
  const stats = emptyStats()
  let turns: ImportTurn[] = []
  let current: ImportTurn | undefined
  let firstTime = 0
  for (const message of doc.messages) {
    if (!isRecord(message)) continue
    if (message.role !== 'user' && message.role !== 'assistant') continue
    if (typeof message.content !== 'string' || message.content === '') continue
    if (firstTime === 0 && typeof message.timestamp === 'number') firstTime = message.timestamp
    if (message.role === 'user') {
      // Shared injection rules: harness blocks open no turn, wrappers keep
      // only the human words.
      if (isInjectedText(message.content)) {
        stats.filtered += 1
        continue
      }
      const prompt = unwrapUserText(message.content)
      if (prompt === '') continue
      current = { prompt, steps: [] }
      turns.push(current)
      continue
    }
    if (current === undefined) {
      current = { prompt: '', steps: [] }
      turns.push(current)
    }
    const step = newStep()
    step.blocks.push({ type: 'text', text: message.content })
    current.steps.push(step)
  }
  turns = turns.filter(turn => turn.prompt !== '' || turn.steps.length > 0)
  if (turns.length === 0) return undefined
  // meta.title is the store's own title (written to the log); the first real
  // prompt is only a fallback.
  const ownTitle = normalizeTitle(typeof title === 'string' ? title : undefined)
  const shownTitle = ownTitle !== '' ? ownTitle : normalizeTitle(turns.find(turn => turn.prompt !== '')?.prompt)
  return {
    sourceId: taskId,
    cwd: workspacePath,
    ...(shownTitle === '' ? {} : { title: shownTitle }),
    titleExplicit: ownTitle !== '',
    startedAt: typeof createdAt === 'number' ? createdAt : firstTime,
    turns,
    stats,
  }
}
