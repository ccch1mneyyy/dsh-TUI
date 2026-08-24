/**
 * Timeline rail and scrollbar gutter views (research §3.3/§3.4) — the two
 * occupants of the fullscreen transcript's 2-column right gutter (the
 * `dsh-tui.scrollGutter` setting picks which; `hidden` mounts neither).
 *
 * Both views are pure consumers: they pull a readonly, already-ticked
 * {@link TimelineViewInputs} through a screen-wired `source` and report
 * intent through callbacks. Neither reads the Channel, the ScrollView, or
 * settings — the chat screen owns all of that (research §3.4.5: the view
 * layer never re-derives what the snapshot already decided).
 *
 * Rail semantics (ported from the source main's TimelineRail):
 *
 * - one tick per user turn, conversation order (never scroll proportion);
 *   `━━` marks the turn owning the viewport top, `──` the hovered tick,
 *   ` ─` an idle tick; `▴`/`▾` step to the nearest turn strictly
 *   above/below the viewport top (dimmed when the snapshot names none);
 * - tick/chevron clicks jump by the turn's measured content coordinate
 *   through `onJumpToTurn` (folded turns resolve to the reveal path on the
 *   screen side); the whole 2-column width is the hit target;
 * - the wheel is NEVER consumed — it falls through to the conversation
 *   ScrollView (the rail has no scroll of its own, source semantics);
 * - a consumed press fences the rail out of drag selection (pi has no
 *   NoSelect region concept; the dispatch contract's press-capture is its
 *   equivalent — M3.6 components do the same);
 * - hovering a tick for HOVER_DWELL_MS pops the preview card through
 *   `onHoverCard` (hover is a DECSET-1003-only enhancement — mux terminals
 *   get full click/wheel function with no hover at all, research §4.3);
 * - any published-state change (scroll crossing a turn boundary slides the
 *   tick window under a stationary pointer) clears hover and the card, the
 *   source's scroll-subscription clear ported to the pull model.
 *
 * The scrollbar gutter is the minimal proportional-scrollbar port of the
 * source's ScrollbarGutter: a `██` thumb encoding the visible window's
 * position and size, click-to-position on the track, same eligibility and
 * selection fences, no thumb dragging (the source's Grok-MVP rule).
 *
 * Rendering is memoized on the pulled inputs' signature: an unchanged frame
 * replays the cached lines with zero allocation (research §3.4.9/§5).
 */
import { visibleWidth, type Component, type PointerEvent, type TUI } from '../public.js'
import {
  RAIL_MIN_TERMINAL_WIDTH,
  RAIL_WIDTH,
  computeRailGeometry,
  railEligible,
  railHit,
  type RailGeometry,
  type TimelineTurn,
} from '../timeline-model.js'
import type { TimelineState } from '../timeline.js'
import { fg } from './rows/style.js'

/** ▴ / ▾ (U+25B4 / U+25BE — the small triangles; CP437-safe on ConHost too). */
const CHEVRON_UP = ' ▴'
const CHEVRON_DOWN = ' ▾'
/** Tick glyphs across the 2-col rail: active = heavy stroke, hover = wide
 *  light stroke, idle = short dim stroke in the rightmost cell. */
const TICK_ACTIVE = '━━'
const TICK_HOVER = '──'
const TICK_IDLE = ' ─'
/** Scrollbar-gutter thumb glyph (deliberately distinct from the active tick). */
const THUMB = '██'

/** Pointer rest time before the hover preview card pops (ms). Sweeps never
 *  mount a card; only a deliberate pause does. */
export const HOVER_DWELL_MS = 120

/** Everything the gutter views pull per frame, gathered and ticked by the
 *  chat screen (the scroll metrics come straight off the ScrollView; `state`
 *  is the ChatTimeline's frozen, signature-gated publication). */
export interface TimelineViewInputs {
  readonly state: TimelineState
  readonly terminalWidth: number
  readonly viewportRows: number
  readonly scrollTop: number
  readonly maxScrollTop: number
}

/** The rail's dwell-gated preview card request: the turn to narrate and the
 *  tick's rail-local row (the screen translates it into overlay geometry and
 *  owns the card's lifecycle). */
export interface TimelineHoverCard {
  readonly turn: TimelineTurn
  readonly row: number
}

/** What the pointer is over. One state so tick/chevron hovers never overlap
 *  (the rail is 2 cols wide — a row is one target or the other). */
type RailHover =
  | { kind: 'up' }
  | { kind: 'down' }
  | { kind: 'tick'; index: number }

interface RailMemo {
  readonly state: TimelineState
  readonly terminalWidth: number
  readonly viewportRows: number
  readonly hover: RailHover | null
  readonly geometry: RailGeometry | null
  readonly turns: readonly TimelineTurn[]
  readonly lines: string[]
}

export class TimelineRailView implements Component {
  /** Pull source for the latest ticked inputs, wired by the chat screen;
   *  undefined (or an undefined pull) means "no frame yet" — render []. */
  source: (() => TimelineViewInputs | undefined) | undefined
  /** Turn navigation (tick/chevron click): the screen resolves the measured
   *  scrollTo top or the folded-turn reveal path (jumpTargetForTurn). */
  onJumpToTurn: ((turn: TimelineTurn) => void) | undefined
  /** Dwell-gated preview card pop/clear; the screen owns the overlay. */
  onHoverCard: ((card: TimelineHoverCard | null) => void) | undefined
  /** The §1.3 ownership gate, mirrored one level down like the transcript's:
   *  while a modal/panel owns the keyboard the rail consumes every pointer
   *  event without acting. */
  isPointerBlocked: (() => boolean) | undefined

  private hover: RailHover | null = null
  private dwellTimer: ReturnType<typeof setTimeout> | null = null
  private cardShown = false
  private memo: RailMemo | undefined

  constructor(private readonly ui?: TUI) {}

  /** Drop the render memo (theme switch — colors resolve at build time). */
  invalidate(): void {
    this.memo = undefined
  }

  /** Stop the dwell timer and drop a popped card. */
  dispose(): void {
    this.clearDwell()
    this.hover = null
  }

  render(width: number): string[] {
    const inputs = this.source?.()
    if (inputs === undefined || width < RAIL_WIDTH) {
      this.clearHover()
      this.memo = undefined
      return []
    }
    const { state, terminalWidth, viewportRows } = inputs
    const eligible = railEligible({
      turnCount: state.snapshot.turns.length,
      terminalWidth,
      viewportRows,
      scrollable: state.scrollable,
    })
    const memo = this.memo
    if (
      memo !== undefined &&
      memo.state === state &&
      memo.terminalWidth === terminalWidth &&
      memo.viewportRows === viewportRows &&
      hoverEquals(memo.hover, this.hover)
    ) {
      return memo.lines
    }
    if (memo !== undefined && memo.state !== state) {
      // The world moved under a stationary pointer (a scroll crossed a turn
      // boundary and slid the tick window): clear hover rather than narrate
      // whichever turn now sits under the pointer cell (source: the scroll
      // subscription's hover clear).
      this.clearHover()
    }
    if (!eligible || viewportRows <= 0) {
      // The rail is gone (narrow terminal, content fits, too few turns): any
      // hover/card state is stale by construction.
      this.clearHover()
      this.memo = { state, terminalWidth, viewportRows, hover: null, geometry: null, turns: [], lines: [] }
      return []
    }

    const turns = state.snapshot.turns
    const activeId = state.snapshot.activeId
    const activeIndex = turns.findIndex(turn => turn.id === activeId)
    const geometry = computeRailGeometry(
      turns.length,
      viewportRows,
      activeIndex === -1 ? null : activeIndex,
      state.atBottom,
    )
    if (geometry === null) {
      this.memo = { state, terminalWidth, viewportRows, hover: this.hover, geometry: null, turns, lines: [] }
      return []
    }

    const lines: string[] = new Array<string>(viewportRows).fill('')
    lines[geometry.upRow] = this.chevronLine('up', state.snapshot.upId !== null)
    lines[geometry.downRow] = this.chevronLine('down', state.snapshot.downId !== null)
    for (let row = geometry.tickTop; row < geometry.downRow; row++) {
      const index = geometry.windowStart + (row - geometry.tickTop)
      const isActive = index === activeIndex
      const isHovered = this.hover?.kind === 'tick' && this.hover.index === index
      const glyph = isActive ? TICK_ACTIVE : isHovered ? TICK_HOVER : TICK_IDLE
      lines[row] = isActive || isHovered ? fg('text', glyph) : fg('subtle', glyph)
    }
    this.memo = { state, terminalWidth, viewportRows, hover: this.hover, geometry, turns, lines }
    return lines
  }

  /**
   * Pointer contract (research §4.3 timeline row): click navigates, press
   * fences the rail out of drag selection, hover dwell-pops the preview
   * card, the wheel always falls through to the conversation scroll.
   */
  handlePointer(event: PointerEvent): boolean | void {
    if (this.isPointerBlocked?.() === true) return true
    const memo = this.memo
    if (memo === undefined || memo.geometry === null) return undefined
    switch (event.type) {
      case 'press':
        // Consume primary presses anywhere on the rail rect: the capture
        // suppresses the selection candidate (pi's NoSelect equivalent).
        return event.button === 0 ? true : undefined
      case 'click': {
        if (event.button !== 0) return undefined
        const hit = railHit(memo.geometry, event.localY)
        if (hit === null) return true // blank spacer row: ours, no action
        this.clearHover()
        if (hit.kind === 'tick') {
          const turn = memo.turns[hit.index]
          if (turn !== undefined) this.onJumpToTurn?.(turn)
          return true
        }
        const id = hit.kind === 'up' ? memo.state.snapshot.upId : memo.state.snapshot.downId
        const turn = id === null ? undefined : memo.turns.find(candidate => candidate.id === id)
        if (turn !== undefined) this.onJumpToTurn?.(turn)
        return true
      }
      case 'enter':
      case 'move':
        this.updateHover(memo, event.localY)
        return undefined
      case 'leave':
        this.clearHover()
        return undefined
      default:
        // wheel/release: never consumed — the wheel falls through to the
        // conversation ScrollView (the rail has no scroll of its own).
        return undefined
    }
  }

  private chevronLine(kind: 'up' | 'down', enabled: boolean): string {
    const hovered = this.hover?.kind === kind
    const glyph = kind === 'up' ? CHEVRON_UP : CHEVRON_DOWN
    return !enabled ? fg('subtle', glyph) : hovered ? fg('text', glyph) : fg('inactive', glyph)
  }

  /** Track the hovered rail row; arm the dwell timer only on ticks. */
  private updateHover(memo: RailMemo, row: number): void {
    const hit = memo.geometry === null ? null : railHit(memo.geometry, row)
    const next: RailHover | null =
      hit === null ? null : hit.kind === 'tick' ? { kind: 'tick', index: hit.index } : { kind: hit.kind }
    if (hoverEquals(this.hover, next)) return
    this.clearDwell()
    if (this.cardShown) {
      this.cardShown = false
      this.onHoverCard?.(null)
    }
    this.hover = next
    if (next?.kind === 'tick' && memo.geometry !== null) {
      const index = next.index
      const cardRow = memo.geometry.tickTop + (index - memo.geometry.windowStart)
      const turn = memo.turns[index]
      if (turn !== undefined && turn.preview.length > 0) {
        this.dwellTimer = setTimeout(() => {
          this.dwellTimer = null
          if (this.hover?.kind !== 'tick' || this.hover.index !== index) return
          this.cardShown = true
          this.onHoverCard?.({ turn, row: cardRow })
        }, HOVER_DWELL_MS)
        this.dwellTimer.unref?.()
      }
    }
    this.ui?.requestRender()
  }

  private clearHover(): void {
    this.clearDwell()
    this.hover = null
    if (this.cardShown) {
      this.cardShown = false
      this.onHoverCard?.(null)
    }
  }

  private clearDwell(): void {
    if (this.dwellTimer !== null) {
      clearTimeout(this.dwellTimer)
      this.dwellTimer = null
    }
  }
}

function hoverEquals(a: RailHover | null, b: RailHover | null): boolean {
  if (a === null || b === null) return a === b
  if (a.kind !== b.kind) return false
  return a.kind !== 'tick' || (b.kind === 'tick' && a.index === b.index)
}

interface GutterMemo {
  readonly scrollTop: number
  readonly maxScrollTop: number
  readonly viewportRows: number
  readonly terminalWidth: number
  readonly scrollable: boolean
  readonly thumbHeight: number
  readonly lines: string[]
}

/**
 * The proportional scrollbar gutter (`scrollGutter: 'scrollbar'`): `██`
 * thumb over a blank track, click maps the track row back to a scrollTop
 * (classic scrollbar semantics — the thumb centers under the click through
 * the follow-up frames). Thumb dragging is intentionally NOT implemented
 * (source's Grok-MVP rule); the timeline rail remains the semantic
 * navigator.
 */
export class ScrollbarGutterView implements Component {
  source: (() => TimelineViewInputs | undefined) | undefined
  /** Click-to-position: the screen forwards it to the conversation
   *  ScrollView's scrollTo. */
  onScrollTo: ((scrollTop: number) => void) | undefined
  isPointerBlocked: (() => boolean) | undefined

  private memo: GutterMemo | undefined

  invalidate(): void {
    this.memo = undefined
  }

  render(width: number): string[] {
    const inputs = this.source?.()
    if (inputs === undefined || width < RAIL_WIDTH) {
      this.memo = undefined
      return []
    }
    const { state, terminalWidth, viewportRows, scrollTop, maxScrollTop } = inputs
    const memo = this.memo
    if (
      memo !== undefined &&
      memo.scrollTop === scrollTop &&
      memo.maxScrollTop === maxScrollTop &&
      memo.viewportRows === viewportRows &&
      memo.terminalWidth === terminalWidth &&
      memo.scrollable === state.scrollable
    ) {
      return memo.lines
    }
    // Source ScrollbarGutter eligibility: room for a track, content actually
    // overflows, and the terminal is wide enough to spare the columns.
    if (viewportRows < 2 || !state.scrollable || terminalWidth < RAIL_MIN_TERMINAL_WIDTH) {
      this.memo = { scrollTop, maxScrollTop, viewportRows, terminalWidth, scrollable: state.scrollable, thumbHeight: 0, lines: [] }
      return []
    }
    const contentHeight = viewportRows + maxScrollTop
    const thumbHeight = Math.max(
      Math.min(2, viewportRows),
      Math.min(viewportRows, Math.round((viewportRows * viewportRows) / contentHeight)),
    )
    const trackHeight = Math.max(1, viewportRows - thumbHeight)
    const thumbTop = maxScrollTop === 0 ? 0 : Math.round((scrollTop / maxScrollTop) * trackHeight)
    const thumbBottom = Math.min(viewportRows, thumbTop + thumbHeight)
    const lines: string[] = new Array<string>(viewportRows).fill('')
    for (let row = thumbTop; row < thumbBottom; row++) lines[row] = fg('inactive', THUMB)
    this.memo = { scrollTop, maxScrollTop, viewportRows, terminalWidth, scrollable: state.scrollable, thumbHeight, lines }
    return lines
  }

  handlePointer(event: PointerEvent): boolean | void {
    if (this.isPointerBlocked?.() === true) return true
    const memo = this.memo
    if (memo === undefined || memo.thumbHeight === 0) return undefined
    switch (event.type) {
      case 'press':
        return event.button === 0 ? true : undefined
      case 'click': {
        if (event.button !== 0) return undefined
        const trackHeight = Math.max(1, memo.viewportRows - memo.thumbHeight)
        const y = event.localY
        const target = y <= 0 ? 0 : y >= trackHeight ? memo.maxScrollTop
          : Math.round((y / trackHeight) * memo.maxScrollTop)
        this.onScrollTo?.(target)
        return true
      }
      default:
        return undefined
    }
  }
}

/**
 * The rail's hover preview card (research §3.4.3): a rounded box carrying
 * the turn's wrapped prompt preview, mounted by the chat screen as a
 * non-capturing pi overlay beside the hovered tick. Fixed content — the
 * screen rebuilds the component per pop, so render just replays the box.
 * Layout: `╭─…─╮`, one `│ line │` row per wrapped line, `╰─…─╯`; width is
 * the widest content line + 4 (border + 1-cell padding per side).
 */
export function createTurnPreviewCard(lines: readonly string[], width: number): Component {
  const inner = Math.max(1, width - 2)
  const border = (text: string): string => fg('subtle', text)
  const top = border(`╭${'─'.repeat(inner)}╮`)
  const bottom = border(`╰${'─'.repeat(inner)}╯`)
  const body = lines.map(line => {
    const pad = Math.max(0, inner - 2 - visibleWidth(line))
    return `${border('│')} ${line}${' '.repeat(pad)} ${border('│')}`
  })
  const rendered = [top, ...body, bottom]
  return {
    render: () => rendered,
    invalidate: () => {},
  }
}
