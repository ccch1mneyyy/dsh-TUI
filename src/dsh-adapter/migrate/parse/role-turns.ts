/**
 * Flat role list → imported turns, plus the shared size measure.
 *
 * The first migration adapters normalized every source into an alternating
 * user/assistant list. {@link fromRoleTurns} folds that list into the turn
 * model mechanically — a user message opens a turn, every assistant message
 * after it is one step — so an adapter that still produces the list imports
 * exactly as it did before the turn model existed.
 *
 * @module @deepseek-harness-tui/dsh-tui/migrate/parse/role-turns
 */
import type { ImportBlock, ImportStats, ImportTurn, MigrationSession, MigrationTurn } from '../types.js'
import { newStep } from './tools.js'

/** Counters for a source that reports nothing it left out. */
export function emptyStats(): ImportStats {
  return { badLines: 0, droppedToolResults: 0, filtered: 0, meta: 0 }
}

/**
 * Fold a role list into turns.
 *
 * A list that starts with an assistant message opens a turn with no prompt
 * (the source lost its head); a trailing user message is a step-less turn.
 */
export function fromRoleTurns(list: readonly MigrationTurn[]): ImportTurn[] {
  const turns: ImportTurn[] = []
  let current: ImportTurn | undefined
  for (const message of list) {
    if (message.role === 'user') {
      current = { prompt: message.text, steps: [] }
      turns.push(current)
      continue
    }
    if (current === undefined) {
      current = { prompt: '', steps: [] }
      turns.push(current)
    }
    const step = newStep(message.model)
    const blocks: ImportBlock[] = []
    if (message.reasoning !== undefined && message.reasoning !== '') blocks.push({ type: 'reasoning', text: message.reasoning })
    if (message.text !== '') blocks.push({ type: 'text', text: message.text })
    step.blocks = blocks
    current.steps.push(step)
  }
  return turns
}

/**
 * How many conversation messages an imported session carries: prompts,
 * mid-turn inputs and assistant steps (tool results are not counted). For a
 * role-list source this equals the list length.
 */
export function messageCount(session: Pick<MigrationSession, 'turns'>): number {
  let count = 0
  for (const turn of session.turns) {
    if (turn.prompt !== '') count += 1
    for (const step of turn.steps) count += 1 + step.inputs.length
  }
  return count
}
