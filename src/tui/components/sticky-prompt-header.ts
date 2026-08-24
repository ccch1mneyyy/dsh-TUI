/**
 * Sticky prompt header (research §3.4.6): the one-row pinned prompt shown
 * ABOVE the fullscreen conversation ScrollView while the user has scrolled
 * away from the bottom. It carries the turn owning the viewport top row —
 * the timeline snapshot's `activeId` (scrolled up to an old turn, it shows
 * THAT turn's prompt, not the latest one) — and clicking it jumps back to
 * that turn's measured top (folded turns go through the screen's reveal
 * path). At the bottom, or with no turns at all, it disappears so the
 * ScrollView never shifts under the reader.
 *
 * Pure consumer like the rail: pulls the ticked timeline state through the
 * screen-wired `source`, reports clicks through `onJumpToTurn`, and mirrors
 * the §1.3 pointer gate through `isPointerBlocked`. Style mirrors the
 * transcript's user prompt row (`❯ ` prefix, bold `briefLabelYou` gold),
 * truncated end-wise to one row.
 */
import chalk from 'chalk'
import { truncateToWidth, type Component, type PointerEvent } from '../public.js'
import { POINTER } from '../../cc/figures.js'
import type { TimelineState } from '../timeline.js'
import { fg } from './rows/style.js'

export class StickyPromptHeaderView implements Component {
  /** Pull source for the latest ticked timeline state; an undefined pull
   *  means "no frame yet" — render []. */
  source: (() => { readonly state: TimelineState } | undefined) | undefined
  /** Click-to-jump: the screen resolves the measured scrollTo top or the
   *  folded-turn reveal path (jumpTargetForTurn). */
  onJumpToTurn: ((turn: TimelineState['snapshot']['turns'][number]) => void) | undefined
  isPointerBlocked: (() => boolean) | undefined

  private memo: { state: TimelineState; width: number; lines: string[] } | undefined

  invalidate(): void {
    this.memo = undefined
  }

  /** The active turn of the latest pull, exposed for the hit bounds. */
  private activeTurn(): TimelineState['snapshot']['turns'][number] | undefined {
    const state = this.source?.()?.state
    if (state === undefined || state.atBottom) return undefined
    const activeId = state.snapshot.activeId
    if (activeId === null) return undefined
    return state.snapshot.turns.find(turn => turn.id === activeId)
  }

  render(width: number): string[] {
    const safeWidth = Math.max(0, Math.floor(width))
    if (safeWidth <= 0) return []
    const state = this.source?.()?.state
    if (state === undefined) return []
    const memo = this.memo
    if (memo !== undefined && memo.state === state && memo.width === safeWidth) {
      return memo.lines
    }
    const turn = state.atBottom || state.snapshot.activeId === null
      ? undefined
      : state.snapshot.turns.find(candidate => candidate.id === state.snapshot.activeId)
    if (turn === undefined || turn.preview.length === 0) {
      this.memo = { state, width: safeWidth, lines: [] }
      return []
    }
    // One fixed row with a 1-cell right margin (the source's paddingRight).
    const line = truncateToWidth(chalk.bold(fg('briefLabelYou', `${POINTER} ${turn.preview}`)), Math.max(0, safeWidth - 1), '…')
    this.memo = { state, width: safeWidth, lines: [line] }
    return [line]
  }

  /**
   * Click = jump back to the pinned turn (source semantics: the whole row
   * is the target, minus the unpainted tail — the transcript's cellIsBlank
   * veto, so a selection attempt on blank cells never navigates). press/
   * release/wheel stay unconsumed: selection and the wheel route keep
   * working.
   */
  handlePointer(event: PointerEvent): boolean | void {
    if (this.isPointerBlocked?.() === true) return true
    if (event.type !== 'click' || event.button !== 0 || event.cellIsBlank) return undefined
    const turn = this.activeTurn()
    if (turn === undefined) return undefined
    this.onJumpToTurn?.(turn)
    return true
  }
}
