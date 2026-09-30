/**
 * Tool-call pairing for imported conversations.
 *
 * The one hard rule for replaying tool traffic is wire legality: every tool
 * call is answered by exactly one tool message before any later assistant
 * message, and every tool message answers a call. Sources do not guarantee
 * that — results arrive steps after their call (Claude batches them behind
 * consecutive assistant rows), transcripts start mid-conversation, runs are
 * interrupted before a result lands. This module restores the rule:
 *
 * - {@link CallIndex} attaches a late result to the STEP that made the call,
 *   never to whatever step is newest;
 * - {@link closeToolPairs} orders each step's results by call order, drops
 *   orphans and duplicates (counted), and answers unanswered calls with an
 *   empty result.
 *
 * @module @deepseek-harness-tui/dsh-tui/migrate/parse/tools
 */
import type { ImportStep, ImportTurn } from '../types.js'

/** Largest tool-result text kept per result, in UTF-8 bytes. */
export const TOOL_RESULT_MAX_BYTES = 64 * 1024

/** Placeholder written instead of image bytes (never base64 into the log). */
export const IMAGE_PLACEHOLDER = '[image]'

/** A fresh empty step. */
export function newStep(model?: string): ImportStep {
  return model === undefined ? { inputs: [], blocks: [], results: [] } : { inputs: [], blocks: [], results: [], model }
}

/**
 * Clamp a tool-result text to {@link TOOL_RESULT_MAX_BYTES}, cutting on a
 * character boundary and noting how much was dropped.
 */
export function clampToolText(text: string): string {
  // Cheap pre-check: UTF-8 needs at most 3 bytes per UTF-16 unit.
  if (text.length * 3 <= TOOL_RESULT_MAX_BYTES) return text
  const bytes = Buffer.from(text, 'utf8')
  if (bytes.length <= TOOL_RESULT_MAX_BYTES) return text
  let end = TOOL_RESULT_MAX_BYTES
  // Back off continuation bytes (10xxxxxx) so the cut never splits a character.
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1
  return `${bytes.subarray(0, end).toString('utf8')}…[truncated ${bytes.length - end} bytes]`
}

/**
 * Session-wide call-id → step index. Register a step's calls when the step
 * is built; attach results as they arrive, wherever they arrive.
 */
export class CallIndex {
  private readonly stepOf = new Map<string, ImportStep>()
  /** Results whose call id was never registered. */
  orphans = 0

  /** Index every tool-call block currently in `step`. */
  register(step: ImportStep): void {
    for (const block of step.blocks) {
      if (block.type === 'tool-call') this.stepOf.set(block.id, step)
    }
  }

  /** Whether a call with this id has been registered. */
  has(callId: string): boolean {
    return this.stepOf.has(callId)
  }

  /**
   * Attach one result to the step that made the call.
   * @returns false (and counts an orphan) when no such call is known.
   */
  attach(callId: string, text: string, isError: boolean): boolean {
    const step = this.stepOf.get(callId)
    if (step === undefined) {
      this.orphans += 1
      return false
    }
    step.results.push({ callId, text: clampToolText(text), isError })
    return true
  }
}

/**
 * Make every step wire-legal, in place.
 *
 * Per step: results follow call order; a result for a call not in the step,
 * or a second result for one call, is dropped; a call without a result gets
 * an empty one. Across the session, a call id reused by a later step (a
 * source retry the source-specific cleanup did not collapse) is renamed
 * `<id>#<n>` together with its result — the session log folds tool calls by
 * id, and a duplicate id would swallow everything after it.
 *
 * @returns How many results were dropped.
 */
export function closeToolPairs(turns: readonly ImportTurn[]): number {
  let dropped = 0
  const seen = new Set<string>()
  for (const turn of turns) {
    for (const step of turn.steps) {
      const renamed = new Map<string, string>()
      step.blocks = step.blocks.map(block => {
        if (block.type !== 'tool-call') return block
        let id = block.id
        for (let n = 2; seen.has(id); n += 1) id = `${block.id}#${n}`
        seen.add(id)
        if (id === block.id) return block
        renamed.set(block.id, id)
        return { ...block, id }
      })
      const byCall = new Map<string, ImportStep['results'][number]>()
      for (const result of step.results) {
        const callId = renamed.get(result.callId) ?? result.callId
        if (byCall.has(callId)) {
          dropped += 1
          continue
        }
        byCall.set(callId, callId === result.callId ? result : { ...result, callId })
      }
      const ordered: ImportStep['results'] = []
      for (const block of step.blocks) {
        if (block.type !== 'tool-call') continue
        ordered.push(byCall.get(block.id) ?? { callId: block.id, text: '', isError: false })
        byCall.delete(block.id)
      }
      dropped += byCall.size
      step.results = ordered
    }
  }
  return dropped
}
