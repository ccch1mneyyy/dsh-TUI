/**
 * Back-to-bottom pill (research §3.5): the dock-top chrome shown whenever
 * the fullscreen conversation is scrolled away from the end — with unseen
 * rows it reads `↓ N 条新消息`, otherwise `↓ 回到底部（Enter/End）`; a click
 * returns to the bottom (the Enter/End keyboard paths stay the keyboard
 * seats of the same action).
 *
 * `showPill = !atBottom` — the pill shows even with zero unseen rows (the
 * source's "far from bottom" rule); the unseen count is the timeline's
 * stable-row-ID anchor count, decrementing as row tops enter the viewport.
 *
 * Pure consumer: pulls the ticked timeline state through the screen-wired
 * `source`, reports clicks through `onJumpToBottom`, mirrors the §1.3
 * pointer gate through `isPointerBlocked`. The click target is the painted
 * pill only — the blank rest of the row never navigates (selection keeps
 * working there). Hover brightens the pill (DECSET 1003 terminals only;
 * cosmetic, never required).
 */
import { visibleWidth, type Component, type PointerEvent, type TUI } from '../public.js'
import { t } from '../../i18n.js'
import type { TimelineState } from '../timeline.js'
import { badge, fg } from './trajectory/paint.js'

/** Left padding before the pill (the source's paddingX={2}). */
const PILL_INDENT = 2

export class BackToBottomPillView implements Component {
  /** Pull source for the latest ticked timeline state; an undefined pull
   *  means "no frame yet" — render []. */
  source: (() => { readonly state: TimelineState } | undefined) | undefined
  /** Click-to-bottom: the screen forwards it to the conversation
   *  ScrollView's scrollToEnd. */
  onJumpToBottom: (() => void) | undefined
  isPointerBlocked: (() => boolean) | undefined

  private hovered = false
  private memo: { state: TimelineState; width: number; hovered: boolean; lines: string[]; pillRight: number } | undefined

  constructor(private readonly ui?: TUI) {}

  invalidate(): void {
    this.memo = undefined
  }

  render(width: number): string[] {
    const safeWidth = Math.max(0, Math.floor(width))
    if (safeWidth <= 0) return []
    const state = this.source?.()?.state
    if (state === undefined) return []
    const memo = this.memo
    if (memo !== undefined && memo.state === state && memo.width === safeWidth && memo.hovered === this.hovered) {
      return memo.lines
    }
    if (state.atBottom) {
      this.hovered = false
      this.memo = { state, width: safeWidth, hovered: false, lines: [], pillRight: 0 }
      return []
    }
    const label = state.unseenCount > 0
      ? t(state.unseenCount === 1 ? 'new-message' : 'new-messages', { n: state.unseenCount })
      : t('back-to-bottom')
    const text = ` ${label} `
    const pill = this.hovered
      ? badge(fg('inverseText', ''), 'userMessageBackgroundHover', text)
      : fg('inverseText', text, { bold: true })
    const pillRight = PILL_INDENT + visibleWidth(text)
    // The blank row above mirrors the source's paddingTop={1}.
    const lines = ['', `${' '.repeat(PILL_INDENT)}${pill}`]
    this.memo = { state, width: safeWidth, hovered: this.hovered, lines, pillRight }
    return lines
  }

  /**
   * Click on the painted pill returns to the bottom; everything else stays
   * unconsumed (press/release never capture — a drag selection crossing the
   * pill row keeps working; the wheel falls through to the scroll route).
   */
  handlePointer(event: PointerEvent): boolean | void {
    if (this.isPointerBlocked?.() === true) return true
    const memo = this.memo
    switch (event.type) {
      case 'click': {
        if (event.button !== 0 || memo === undefined || memo.pillRight === 0) return undefined
        if (event.localY !== 1 || event.localX < PILL_INDENT || event.localX >= memo.pillRight) return undefined
        this.onJumpToBottom?.()
        return true
      }
      case 'enter':
      case 'move': {
        const over = memo !== undefined && memo.pillRight > 0 &&
          event.localY === 1 && event.localX >= PILL_INDENT && event.localX < memo.pillRight
        if (over !== this.hovered) {
          this.hovered = over
          this.ui?.requestRender()
        }
        return undefined
      }
      case 'leave':
        if (this.hovered) {
          this.hovered = false
          this.ui?.requestRender()
        }
        return undefined
      default:
        return undefined
    }
  }
}
