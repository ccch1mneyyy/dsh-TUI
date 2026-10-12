/**
 * Recorded Codex turns → Agent Domain events (docs/codex-backend-design.md
 * §7.6): every item of every turn through the shared mapping (`items.ts`),
 * `started` then `completed`, oldest turn first. The context is handed on
 * to the live translator afterwards, so live numbering continues where the
 * replay ended.
 *
 * - Turns must carry full items (`itemsView: 'full'`, C0 V4).
 * - Times: a turn's `startedAt` / `completedAt` (seconds) when recorded.
 * - An in-progress turn (the last one of a running thread) stays open: its
 *   in-progress items only start, and live traffic completes them.
 * - History carries no approvals, questions, stream deltas or token usage.
 */
import type { AgentEvent } from '../../../agent/events.js'
import { arr, num, rec, str, type Rec } from '../narrow.js'
import { closeTurn, itemEvents, type ItemContext } from './items.js'
import { turnEndReason } from './notices.js'

/** Replay turns (oldest first) into events, advancing `ctx`. */
export function replayTurns(turns: readonly unknown[], ctx: ItemContext): AgentEvent[] {
  const out: AgentEvent[] = []
  for (const raw of turns) {
    const turn = rec(raw)
    if (turn === undefined) continue
    const id = str(turn.id)
    if (id !== undefined) ctx.turnId = id
    const startedAt = num(turn.startedAt)
    const completedAt = num(turn.completedAt)
    const start = startedAt === undefined ? ctx.now() : startedAt * 1000
    const end = completedAt === undefined ? start : completedAt * 1000
    const running = str(turn.status) === 'inProgress'
    for (const entry of arr(turn.items)) {
      const item = rec(entry) as Rec | undefined
      if (item === undefined) continue
      out.push(...itemEvents(item, 'started', ctx, start))
      // A running turn's unfinished item completes live.
      if (running && str(item.status) === 'inProgress') continue
      out.push(...itemEvents(item, 'completed', ctx, start))
    }
    if (!running) closeTurn(ctx, out, turnEndReason(turn), end)
  }
  return out
}
