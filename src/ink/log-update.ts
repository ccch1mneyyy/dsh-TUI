import {
  type AnsiCode,
  ansiCodesToString,
  diffAnsiCodes,
} from '@alcalzone/ansi-tokenize'
import { logForDebugging } from '../utils/debug.js'
import type { Diff, FlickerReason, Frame } from './frame.js'
import type { Point } from './layout/geometry.js'
import {
  type Cell,
  CellWidth,
  cellAt,
  charInCellAt,
  diffEach,
  type Hyperlink,
  isEmptyCellAt,
  type Screen,
  type StylePool,
  shiftRows,
  visibleCellAtIndex,
} from './screen.js'
import {
  CURSOR_HOME,
  cursorUp,
  eraseToEndOfScreen,
  scrollDown as csiScrollDown,
  scrollUp as csiScrollUp,
  RESET_SCROLL_REGION,
  SGR_RESET,
  setScrollRegion,
} from './termio/csi.js'
import { LINK_END, link as oscLink } from './termio/osc.js'

type State = {
  previousOutput: string
  /** One-shot: the next main-screen frame repaints the whole viewport from
   *  the physical cursor position instead of diffing. See
   *  requestViewportReanchor. */
  reanchorPending: boolean
}

type Options = {
  isTTY: boolean
  stylePool: StylePool
}

const CARRIAGE_RETURN = { type: 'carriageReturn' } as const
const NEWLINE = { type: 'stdout', content: '\n' } as const

/**
 * Converts frame diffs into terminal write patches. Holds per-instance
 * state (previous output, style pool, TTY mode) across frames.
 */
export class LogUpdate {
  private state: State

  constructor(private readonly options: Options) {
    this.state = {
      previousOutput: '',
      reanchorPending: false,
    }
  }

  /**
   * Request a one-shot viewport re-anchor on the next main-screen frame.
   *
   * The main-screen diff engine addresses rows purely relative to where it
   * left the cursor — it has no absolute anchor and no way to notice when a
   * third party moved it. A subprocess writing directly to the tty (an MCP
   * server's stderr, a stray native log line — issue #17) advances the
   * cursor and scrolls the terminal; every subsequent diff then lands N
   * rows off, garbling the UI (missing labels, shifted rows — issue #16)
   * until some full repaint happens to run. There is nothing to detect
   * after the fact (a newline-terminated write parks the cursor back at
   * the bottom column 0, exactly where the engine expects it), so the
   * recovery is a blind idempotent repaint: rebuild the viewport from the
   * physical cursor position, which re-syncs the virtual↔physical mapping
   * no matter how far they had drifted. Wired to the stdin-gap reassert
   * (>5s idle then a keypress) — the same trigger that re-asserts DEC
   * modes after tmux attach / ssh reconnect.
   */
  requestViewportReanchor(): void {
    this.state.reanchorPending = true
  }

  /**
   * Render the terminal state for a finished run, for streams that no
   * longer support string output.
   * @param prevFrame - the previously rendered frame.
   * @returns the patches that restore the terminal to the previous frame's state.
   */
  renderPreviousOutput_DEPRECATED(prevFrame: Frame): Diff {
    if (!this.options.isTTY) {
      // Non-TTY output is no longer supported (string output was removed)
      return [NEWLINE]
    }
    return this.getRenderOpsForDone(prevFrame)
  }

  // Called when process resumes from suspension (SIGCONT) to prevent clobbering terminal content
  /** Drop the previous-output state after the process resumes from suspension (SIGCONT) so terminal content is not clobbered. */
  reset(): void {
    this.state.previousOutput = ''
  }

  private renderFullFrame(frame: Frame): Diff {
    const { screen } = frame
    const lines: string[] = []
    let currentStyles: AnsiCode[] = []
    let currentHyperlink: Hyperlink = undefined
    for (let y = 0; y < screen.height; y++) {
      let line = ''
      for (let x = 0; x < screen.width; x++) {
        const cell = cellAt(screen, x, y)
        if (cell && cell.width !== CellWidth.SpacerTail) {
          // Handle hyperlink transitions
          if (cell.hyperlink !== currentHyperlink) {
            if (currentHyperlink !== undefined) {
              line += LINK_END
            }
            if (cell.hyperlink !== undefined) {
              line += oscLink(cell.hyperlink)
            }
            currentHyperlink = cell.hyperlink
          }
          const cellStyles = this.options.stylePool.get(cell.styleId)
          const styleDiff = diffAnsiCodes(currentStyles, cellStyles)
          if (styleDiff.length > 0) {
            line += ansiCodesToString(styleDiff)
            currentStyles = cellStyles
          }
          line += cell.char
        }
      }
      // Close any open hyperlink before resetting styles
      if (currentHyperlink !== undefined) {
        line += LINK_END
        currentHyperlink = undefined
      }
      // Reset styles at end of line so trimEnd doesn't leave dangling codes
      const resetCodes = diffAnsiCodes(currentStyles, [])
      if (resetCodes.length > 0) {
        line += ansiCodesToString(resetCodes)
        currentStyles = []
      }
      lines.push(line.trimEnd())
    }

    if (lines.length === 0) {
      return []
    }
    return [{ type: 'stdout', content: lines.join('\n') }]
  }

  private getRenderOpsForDone(prev: Frame): Diff {
    this.state.previousOutput = ''

    if (!prev.cursor.visible) {
      return [{ type: 'cursorShow' }]
    }
    return []
  }

  /**
   * Diff the previous and next frames and produce the patches that update
   * the terminal from one to the other.
   * @param prev - the previously rendered frame.
   * @param next - the frame to render.
   * @param altScreen - whether the frame renders to the alternate screen.
   * @param decstbmSafe - whether the DECSTBM scroll sequence can be made atomic (DEC 2026 / BSU/ESU).
   * @returns the terminal write patches.
   */
  render(
    prev: Frame,
    next: Frame,
    altScreen = false,
    decstbmSafe = true,
  ): Diff {
    if (!this.options.isTTY) {
      return this.renderFullFrame(next)
    }

    const startTime = performance.now()
    const stylePool = this.options.stylePool

    // Since we assume the cursor is at the bottom on the screen, we only need
    // to clear when the viewport gets shorter (i.e. the cursor position drifts)
    // or when it gets thinner (and text wraps). We _could_ figure out how to
    // not reset here but that would involve predicting the current layout
    // _after_ the viewport change which means calcuating text wrapping.
    // Resizing is a rare enough event that it's not practically a big issue.
    if (
      next.viewport.height < prev.viewport.height ||
      (prev.viewport.width !== 0 && next.viewport.width !== prev.viewport.width)
    ) {
      return fullResetSequence_CAUSES_FLICKER(next, 'resize', stylePool)
    }

    // One-shot viewport re-anchor (see requestViewportReanchor): repaint
    // the whole visible window from the physical cursor position, blind to
    // whatever a third-party tty write did to it. Main-screen only — the
    // alt-screen path already self-heals with CSI H every frame. Checked
    // after the resize reset (which supersedes it; the flag survives to
    // the next frame) and before the DECSTBM path (alt-screen only, so
    // mutually exclusive anyway).
    if (this.state.reanchorPending && !altScreen) {
      this.state.reanchorPending = false
      return repaintViewportInPlace(prev, next, stylePool)
    }

    // DECSTBM scroll optimization: when a ScrollBox's scrollTop changed,
    // shift content with a hardware scroll (CSI top;bot r + CSI n S/T)
    // instead of rewriting the whole scroll region. The shiftRows on
    // prev.screen simulates the shift so the diff loop below naturally
    // finds only the rows that scrolled IN as diffs. prev.screen is
    // about to become backFrame (reused next render) so mutation is safe.
    // CURSOR_HOME after RESET_SCROLL_REGION is defensive — DECSTBM reset
    // homes cursor per spec but terminal implementations vary.
    //
    // decstbmSafe: caller passes false when the DECSTBM→diff sequence
    // can't be made atomic (no DEC 2026 / BSU/ESU). Without atomicity the
    // outer terminal renders the intermediate state — region scrolled,
    // edge rows not yet painted — a visible vertical jump on every frame
    // where scrollTop moves. Falling through to the diff loop writes all
    // shifted rows: more bytes, no intermediate state. next.screen from
    // render-node-to-output's blit+shift is correct either way.
    let scrollPatch: Diff = []
    if (altScreen && next.scrollHint && decstbmSafe) {
      const { top, bottom, delta } = next.scrollHint
      if (
        top >= 0 &&
        bottom < prev.screen.height &&
        bottom < next.screen.height
      ) {
        shiftRows(prev.screen, top, bottom, delta)
        // The hardware scroll's blank fill uses the terminal's CURRENT
        // background (BCE); the SGR reset at the head of every frame buffer
        // (writeDiffToTerminal) guarantees the default background here even
        // after a truncated previous frame left a colored SGR stuck.
        scrollPatch = [
          {
            type: 'stdout',
            content:
              setScrollRegion(top + 1, bottom + 1) +
              (delta > 0 ? csiScrollUp(delta) : csiScrollDown(-delta)) +
              RESET_SCROLL_REGION +
              CURSOR_HOME,
          },
        ]
      }
    }

    // We have to use purely relative operations to manipulate the cursor since
    // we don't know its starting point.
    //
    // When content height >= viewport height AND cursor is at the bottom,
    // the cursor restore at the end of the previous frame caused terminal scroll.
    // viewportY tells us how many rows are in scrollback from content overflow.
    // Additionally, the cursor-restore scroll pushes 1 more row into scrollback.
    // We need fullReset if any changes are to rows that are now in scrollback.
    //
    // This early full-reset check only applies in "steady state" (not growing).
    // For growing, the viewportY calculation below (with cursorRestoreScroll)
    // catches unreachable scrollback rows in the diff loop instead.
    const cursorAtBottom = prev.cursor.y >= prev.screen.height
    const isGrowing = next.screen.height > prev.screen.height
    // When content fills the viewport exactly (height == viewport) and the
    // cursor is at the bottom, the cursor-restore LF at the end of the
    // previous frame scrolled 1 row into scrollback. Use >= to catch this.
    const prevHadScrollback =
      cursorAtBottom && prev.screen.height >= prev.viewport.height
    const isShrinking = next.screen.height < prev.screen.height
    const nextFitsViewport = next.screen.height <= prev.viewport.height

    // When shrinking from above-viewport to at-or-below-viewport, content
    // that was in scrollback stays there — terminal clears can't pull it
    // back — but the viewport itself can be rebuilt in place: the cursor is
    // parked at the physical bottom (prevHadScrollback implies it), so the
    // viewport rows are all reachable. Repainting them directly avoids the
    // former full reset here, whose clearTerminal + whole-frame reprint
    // deposited one stale UI copy into the scrollback per shrink.
    // Use <= (not <) because even when next height equals viewport height,
    // the scrollback depth from the previous render differs from a fresh
    // render.
    if (prevHadScrollback && nextFitsViewport && isShrinking) {
      logForDebugging(
        `Viewport repaint (shrink->below): prevHeight=${prev.screen.height}, nextHeight=${next.screen.height}, viewport=${prev.viewport.height}`,
      )
      return repaintViewportInPlace(prev, next, stylePool)
    }

    // Steady-state scrollback check removed: rows above the viewport used
    // to force a full reset (ESC[2J+ESC[3J) whenever they changed, which
    // wipes terminal scrollback and snaps the viewport to the top — firing
    // on every streaming pause frame. The diff loop below now skips those
    // rows instead (y < viewportY → skip), repainting them when they
    // scroll back into view. Shrink and resize resets below are kept.

    const screen = new VirtualScreen(prev.cursor, next.viewport.width)

    // Treat empty screen as height 1 to avoid spurious adjustments on first render
    const heightDelta =
      Math.max(next.screen.height, 1) - Math.max(prev.screen.height, 1)
    const shrinking = heightDelta < 0
    const growing = heightDelta > 0

    // Handle shrinking: clear lines from the bottom
    // When prevHadScrollback, add 1 for the cursor-restore LF that scrolled
    // an additional row out of view at the end of the previous frame.
    const cursorRestoreScroll = prevHadScrollback ? 1 : 0
    if (shrinking) {
      const linesToClear = prev.screen.height - next.screen.height

      // Main-screen mode + content taller than the viewport: the terminal
      // viewport does NOT follow the content bottom when content shrinks —
      // a diff-loop path would write rows at stale physical offsets. But
      // when the cursor sits on its park row (the invariant the renderer
      // maintains every main-screen frame), the whole viewport is directly
      // addressable: repaint it in place. This branch fires on EVERY turn
      // (thinking fold, spinner/esc-hint unmount, markdown reflow shrink
      // the frame by a row or two while it is taller than the viewport) —
      // the former full reset here was the copy machine behind the
      // duplicated-UI scrollback reports (#38 #39 #19). Fall back to the
      // full reset only if the cursor is somewhere unexpected.
      if (!altScreen && prev.screen.height > prev.viewport.height) {
        if (cursorAtBottom) {
          logForDebugging(
            `Viewport repaint (shrink tall): prevHeight=${prev.screen.height}, nextHeight=${next.screen.height}, viewport=${prev.viewport.height}`,
          )
          return repaintViewportInPlace(prev, next, this.options.stylePool)
        }
        return fullResetSequence_CAUSES_FLICKER(
          next,
          'offscreen',
          this.options.stylePool,
        )
      }

      // eraseLines only works within the viewport - it can't clear scrollback.
      // If we need to clear more lines than fit in the viewport, some are in
      // scrollback, so we need a full reset.
      if (linesToClear > prev.viewport.height) {
        return fullResetSequence_CAUSES_FLICKER(
          next,
          'offscreen',
          this.options.stylePool,
        )
      }

      // clear(N) moves cursor UP by N-1 lines and to column 0
      // This puts us at line prev.screen.height - N = next.screen.height
      // But we want to be at next.screen.height - 1 (bottom of new screen)
      screen.txn(prev2 => [
        [
          { type: 'clear', count: linesToClear },
          { type: 'cursorMove', x: 0, y: -1 },
        ],
        { dx: -prev2.x, dy: -linesToClear },
      ])
    }

    // viewportY = number of rows in scrollback (not visible on terminal).
    // For shrinking: use max(prev, next) because terminal clears don't scroll.
    // For growing: use prev state because new rows haven't scrolled old ones yet.
    // When prevHadScrollback, add 1 for the cursor-restore LF that scrolled
    // an additional row out of view at the end of the previous frame. Without
    // this, the diff loop treats that row as reachable — but the cursor clamps
    // at viewport top, causing writes to land 1 row off and garbling the output.
    const viewportY = growing
      ? Math.max(
          0,
          prev.screen.height - prev.viewport.height + cursorRestoreScroll,
        )
      : Math.max(prev.screen.height, next.screen.height) -
        next.viewport.height +
        cursorRestoreScroll

    // Rows above viewportY live in terminal scrollback and are skipped by the
    // diff loop (see below). Clip the damage region to the visible area so the
    // loop doesn't scan scrollback rows cell-by-cell every frame — with a tall
    // conversation that's a per-frame O(full screen) cost and stalls rendering.
    // prev.damage participates in diffEach's region union, so clip it too
    // (blit doesn't read damage — renderer.ts uses it only in comments).
    if (viewportY > 0) {
      for (const src of [next.screen, prev.screen]) {
        const dmg = src.damage
        if (dmg && dmg.y < viewportY) {
          const overhang = viewportY - dmg.y
          src.damage = {
            x: dmg.x,
            y: viewportY,
            width: dmg.width,
            height: Math.max(0, dmg.height - overhang),
          }
        }
      }
    }

    let currentStyleId = stylePool.none
    let currentHyperlink: Hyperlink = undefined

    // First pass: render changes to existing rows (rows < prev.screen.height)
    diffEach(prev.screen, next.screen, (x, y, removed, added) => {
      // Skip new rows - we'll render them directly after
      if (growing && y >= prev.screen.height) {
        return
      }

      // Skip spacers during rendering because the terminal will automatically
      // advance 2 columns when we write the wide character itself.
      // SpacerTail: Second cell of a wide character
      // SpacerHead: Marks line-end position where wide char wraps to next line
      if (
        added &&
        (added.width === CellWidth.SpacerTail ||
          added.width === CellWidth.SpacerHead)
      ) {
        return
      }

      if (
        removed &&
        (removed.width === CellWidth.SpacerTail ||
          removed.width === CellWidth.SpacerHead) &&
        !added
      ) {
        return
      }

      // Skip empty cells that don't need to overwrite existing content.
      // This prevents writing trailing spaces that would cause unnecessary
      // line wrapping at the edge of the screen.
      // Uses isEmptyCellAt to check if both packed words are zero (empty cell).
      if (added && isEmptyCellAt(next.screen, x, y) && !removed) {
        return
      }

      // Rows above the viewport live in terminal scrollback — the cursor
      // can't reach them, and the only way to repaint them is a full reset
      // (ESC[2J+ESC[3J), which wipes the scrollback and snaps the terminal
      // viewport back to the top (user scrolled up → jumps to the very
      // first line). Skip updating them; they repaint normally when they
      // scroll back into the viewport. Chat history is static content, so
      // nothing visible is lost by leaving scrollback rows stale.
      if (y < viewportY) {
        return
      }

      moveCursorTo(screen, x, y)

      if (added) {
        const targetHyperlink = added.hyperlink
        currentHyperlink = transitionHyperlink(
          screen.diff,
          currentHyperlink,
          targetHyperlink,
        )
        const styleStr = stylePool.transition(currentStyleId, added.styleId)
        if (writeCellWithStyleStr(screen, added, styleStr)) {
          currentStyleId = added.styleId
        }
      } else if (removed) {
        // Cell was removed - clear it with a space
        // (This handles shrinking content)
        // Reset any active styles/hyperlinks first to avoid leaking into cleared cells
        const styleIdToReset = currentStyleId
        const hyperlinkToReset = currentHyperlink
        currentStyleId = stylePool.none
        currentHyperlink = undefined

        screen.txn(() => {
          const patches: Diff = []
          transitionStyle(patches, stylePool, styleIdToReset, stylePool.none)
          transitionHyperlink(patches, hyperlinkToReset, undefined)
          patches.push({ type: 'stdout', content: ' ' })
          return [patches, { dx: 1, dy: 0 }]
        })
      }
    })

    // Reset styles before rendering new rows (they'll set their own styles)
    currentStyleId = transitionStyle(
      screen.diff,
      stylePool,
      currentStyleId,
      stylePool.none,
    )
    currentHyperlink = transitionHyperlink(
      screen.diff,
      currentHyperlink,
      undefined,
    )

    // Handle growth: render new rows directly (they naturally scroll the terminal)
    if (growing) {
      renderFrameSlice(
        screen,
        next,
        prev.screen.height,
        next.screen.height,
        stylePool,
      )
    }

    // Restore cursor. Skipped in alt-screen: the cursor is hidden, its
    // position only matters as the starting point for the NEXT frame's
    // relative moves, and in alt-screen the next frame always begins with
    // CSI H (see ink.tsx onRender) which resets to (0,0) regardless. This
    // saves a CR + cursorMove round-trip (~6-10 bytes) every frame.
    //
    // Main screen: if cursor needs to be past the last line of content
    // (typical: cursor.y = screen.height), emit \n to create that line
    // since cursor movement can't create new lines.
    if (altScreen) {
      // no-op; next frame's CSI H anchors cursor
    } else if (next.cursor.y >= next.screen.height) {
      // Move to column 0 of current line, then emit newlines to reach target row
      screen.txn(prev => {
        const rowsToCreate = next.cursor.y - prev.y
        if (rowsToCreate > 0) {
          // Use CR to resolve pending wrap (if any) without advancing
          // to the next line, then LF to create each new row.
          const patches: Diff = new Array<Diff[number]>(1 + rowsToCreate)
          patches[0] = CARRIAGE_RETURN
          for (let i = 0; i < rowsToCreate; i++) {
            patches[1 + i] = NEWLINE
          }
          return [patches, { dx: -prev.x, dy: rowsToCreate }]
        }
        // At or past target row - need to move cursor to correct position
        const dy = next.cursor.y - prev.y
        if (dy !== 0 || prev.x !== next.cursor.x) {
          // Use CR to clear pending wrap (if any), then cursor move
          const patches: Diff = [CARRIAGE_RETURN]
          patches.push({ type: 'cursorMove', x: next.cursor.x, y: dy })
          return [patches, { dx: next.cursor.x - prev.x, dy }]
        }
        return [[], { dx: 0, dy: 0 }]
      })
    } else {
      moveCursorTo(screen, next.cursor.x, next.cursor.y)
    }

    const elapsed = performance.now() - startTime
    if (elapsed > 50) {
      const damage = next.screen.damage
      const damageInfo = damage
        ? `${damage.width}x${damage.height} at (${damage.x},${damage.y})`
        : 'none'
      logForDebugging(
        `Slow render: ${elapsed.toFixed(1)}ms, screen: ${next.screen.height}x${next.screen.width}, damage: ${damageInfo}, changes: ${screen.diff.length}`,
      )
    }

    return scrollPatch.length > 0
      ? [...scrollPatch, ...screen.diff]
      : screen.diff
  }
}

function transitionHyperlink(
  diff: Diff,
  current: Hyperlink,
  target: Hyperlink,
): Hyperlink {
  if (current !== target) {
    diff.push({ type: 'hyperlink', uri: target ?? '' })
    return target
  }
  return current
}

function transitionStyle(
  diff: Diff,
  stylePool: StylePool,
  currentId: number,
  targetId: number,
): number {
  const str = stylePool.transition(currentId, targetId)
  if (str.length > 0) {
    diff.push({ type: 'styleStr', str })
  }
  return targetId
}

function readLine(screen: Screen, y: number): string {
  let line = ''
  for (let x = 0; x < screen.width; x++) {
    line += charInCellAt(screen, x, y) ?? ' '
  }
  return line.trimEnd()
}

function fullResetSequence_CAUSES_FLICKER(
  frame: Frame,
  reason: FlickerReason,
  stylePool: StylePool,
  debug?: { triggerY: number; prevLine: string; nextLine: string },
): Diff {
  // After clearTerminal, cursor is at (0, 0)
  const screen = new VirtualScreen({ x: 0, y: 0 }, frame.viewport.width)
  renderFrame(screen, frame, stylePool)
  return [{ type: 'clearTerminal', reason, debug }, ...screen.diff]
}

/**
 * Repaint the visible viewport in place — the main-screen shrink recovery
 * that replaces fullResetSequence's clearTerminal + whole-frame reprint.
 *
 * Precondition (caller-guarded): the cursor is parked on the physical
 * bottom row (the renderer pins cursor.y = screen.height every main-screen
 * frame), so the viewport top is exactly viewportHeight-1 rows up. Walk
 * there, erase to the end of the screen, and repaint the frame's tail
 * directly into the viewport. Nothing scrolls: no rows are pushed into
 * (WT semantics) or spliced out of (xterm.js semantics) the terminal
 * scrollback, so the shrink frames that fire on EVERY turn — thinking
 * fold, spinner/esc-hint rows unmounting at end of turn, streaming
 * markdown reflow — stop depositing a full stale UI copy per turn into
 * the user's scroll history (issues #38 #39 #19).
 *
 * Frame-row bookkeeping stays on the steady-state formulas: the repaint
 * leaves frame rows [H-min(H,V-1), H) on the viewport with the cursor at
 * frame row H on the physical bottom row — exactly the mapping viewportY
 * derives (viewport top = H-V+1 when H >= V), so the next frame needs no
 * special casing. Cost is O(viewport) cells once per shrink frame, well
 * under the fullReset path it replaces (whole frame + 10000-row scroll).
 *
 * Also reused by the viewport re-anchor (requestViewportReanchor), where
 * the cursor may NOT be exactly on the park row — a third-party write
 * left it somewhere in the bottom region. The CR + cursorUp(V-1) still
 * lands on the viewport top because CUU clamps at the top margin, so the
 * repaint re-syncs the mapping from any bottom-region start. (On legacy
 * conhost the clamp can drag the viewport instead — see
 * hasCursorUpViewportYankBug — but only when the cursor starts above the
 * bottom row, which no known writer produces.)
 */
function repaintViewportInPlace(
  prev: Frame,
  next: Frame,
  stylePool: StylePool,
): Diff {
  const viewportHeight = prev.viewport.height
  const height = next.screen.height
  // The bottom viewport row stays reserved for the cursor park; content
  // occupies at most viewportHeight-1 rows above it (same split as the
  // steady state, where the park LF materializes one row below the frame).
  const contentRows = Math.min(height, viewportHeight - 1)
  const startY = height - contentRows
  // CR + up(V-1): from the parked bottom row to the viewport top — stays
  // inside the viewport, so conhost's CUU-into-scrollback yank bug can't
  // trigger. Erase down from there (BCE fill — the SGR reset at the head
  // of every frame buffer guarantees the default background). The erase
  // also blanks the park row, so no stale prompt/status pixels survive
  // below short content.
  const anchor = '\r' + cursorUp(viewportHeight - 1) + eraseToEndOfScreen()
  const screen = new VirtualScreen({ x: 0, y: startY }, next.viewport.width)
  renderFrameSlice(screen, next, startY, height, stylePool)
  return [{ type: 'stdout', content: anchor }, ...screen.diff]
}

function renderFrame(
  screen: VirtualScreen,
  frame: Frame,
  stylePool: StylePool,
): void {
  renderFrameSlice(screen, frame, 0, frame.screen.height, stylePool)
}

/**
 * Render a slice of rows from the frame's screen.
 * Each row is rendered followed by a newline. Cursor ends at (0, endY).
 */
function renderFrameSlice(
  screen: VirtualScreen,
  frame: Frame,
  startY: number,
  endY: number,
  stylePool: StylePool,
): VirtualScreen {
  let currentStyleId = stylePool.none
  let currentHyperlink: Hyperlink = undefined
  // Track the styleId of the last rendered cell on this line (-1 if none).
  // Passed to visibleCellAtIndex to enable fg-only space optimization.
  let lastRenderedStyleId = -1

  const { width: screenWidth, cells, charPool, hyperlinkPool } = frame.screen

  let index = startY * screenWidth
  for (let y = startY; y < endY; y += 1) {
    // Advance cursor to this row using LF (not CSI CUD / cursor-down).
    // CSI CUD stops at the viewport bottom margin and cannot scroll,
    // but LF scrolls the viewport to create new lines. Without this,
    // when the cursor is at the viewport bottom, moveCursorTo's
    // cursor-down silently fails, creating a permanent off-by-one
    // between the virtual cursor and the real terminal cursor.
    if (screen.cursor.y < y) {
      const rowsToAdvance = y - screen.cursor.y
      screen.txn(prev => {
        const patches: Diff = new Array<Diff[number]>(1 + rowsToAdvance)
        patches[0] = CARRIAGE_RETURN
        for (let i = 0; i < rowsToAdvance; i++) {
          patches[1 + i] = NEWLINE
        }
        return [patches, { dx: -prev.x, dy: rowsToAdvance }]
      })
    }
    // Reset at start of each line — no cell rendered yet
    lastRenderedStyleId = -1

    for (let x = 0; x < screenWidth; x += 1, index += 1) {
      // Skip spacers, unstyled empty cells, and fg-only styled spaces that
      // match the last rendered style (since cursor-forward produces identical
      // visual result). visibleCellAtIndex handles the optimization internally
      // to avoid allocating Cell objects for skipped cells.
      const cell = visibleCellAtIndex(
        cells,
        charPool,
        hyperlinkPool,
        index,
        lastRenderedStyleId,
      )
      if (!cell) {
        continue
      }

      moveCursorTo(screen, x, y)

      // Handle hyperlink
      const targetHyperlink = cell.hyperlink
      currentHyperlink = transitionHyperlink(
        screen.diff,
        currentHyperlink,
        targetHyperlink,
      )

      // Style transition — cached string, zero allocations after warmup
      const styleStr = stylePool.transition(currentStyleId, cell.styleId)
      if (writeCellWithStyleStr(screen, cell, styleStr)) {
        currentStyleId = cell.styleId
        lastRenderedStyleId = cell.styleId
      }
    }
    // Reset styles/hyperlinks before newline so background color doesn't
    // bleed into the next line when the terminal scrolls. The old code
    // reset implicitly by writing trailing unstyled spaces; now that we
    // skip empty cells, we must reset explicitly.
    currentStyleId = transitionStyle(
      screen.diff,
      stylePool,
      currentStyleId,
      stylePool.none,
    )
    currentHyperlink = transitionHyperlink(
      screen.diff,
      currentHyperlink,
      undefined,
    )
    // CR+LF at end of row — \r resets to column 0, \n moves to next line.
    // Without \r, the terminal cursor stays at whatever column content ended
    // (since we skip trailing spaces, this can be mid-row).
    screen.txn(prev => [[CARRIAGE_RETURN, NEWLINE], { dx: -prev.x, dy: 1 }])
  }

  // Reset any open style/hyperlink at end of slice
  transitionStyle(screen.diff, stylePool, currentStyleId, stylePool.none)
  transitionHyperlink(screen.diff, currentHyperlink, undefined)

  return screen
}

type Delta = { dx: number; dy: number }

/**
 * Write a cell with a pre-serialized style transition string (from
 * StylePool.transition). Inlines the txn logic to avoid closure/tuple/delta
 * allocations on every cell.
 *
 * Returns true if the cell was written, false if skipped (wide char at
 * viewport edge). Callers MUST gate currentStyleId updates on this — when
 * skipped, styleStr is never pushed and the terminal's style state is
 * unchanged. Updating the virtual tracker anyway desyncs it from the
 * terminal, and the next transition is computed from phantom state.
 */
function writeCellWithStyleStr(
  screen: VirtualScreen,
  cell: Cell,
  styleStr: string,
): boolean {
  const cellWidth = cell.width === CellWidth.Wide ? 2 : 1
  const px = screen.cursor.x
  const vw = screen.viewportWidth

  // Don't write wide chars that would cross the viewport edge.
  // Single-codepoint chars (CJK) at vw-2 are safe; multi-codepoint
  // graphemes (flags, ZWJ emoji) need stricter threshold.
  if (cellWidth === 2 && px < vw) {
    const threshold = cell.char.length > 2 ? vw : vw + 1
    if (px + 2 >= threshold) {
      return false
    }
  }

  const diff = screen.diff
  if (styleStr.length > 0) {
    diff.push({ type: 'styleStr', str: styleStr })
  }

  const needsCompensation = cellWidth === 2 && needsWidthCompensation(cell.char)

  // On terminals with old wcwidth tables, a compensated emoji only advances
  // the cursor 1 column, so the CHA below skips column x+1 without painting
  // it. Write a styled space there first — on correct terminals the emoji
  // glyph (width 2) overwrites it harmlessly; on old terminals it fills the
  // gap with the emoji's background. Also clears any stale content at x+1.
  // CHA is 1-based, so column px+1 (0-based) is CHA target px+2.
  if (needsCompensation && px + 1 < vw) {
    diff.push({ type: 'cursorTo', col: px + 2 })
    diff.push({ type: 'stdout', content: ' ' })
    diff.push({ type: 'cursorTo', col: px + 1 })
  }

  diff.push({ type: 'stdout', content: cell.char })

  // Force terminal cursor to correct column after the emoji.
  if (needsCompensation) {
    diff.push({ type: 'cursorTo', col: px + cellWidth + 1 })
  }

  // Update cursor — mutate in place to avoid Point allocation
  if (px >= vw) {
    screen.cursor.x = cellWidth
    screen.cursor.y++
  } else {
    screen.cursor.x = px + cellWidth
  }
  return true
}

function moveCursorTo(screen: VirtualScreen, targetX: number, targetY: number) {
  screen.txn(prev => {
    const dx = targetX - prev.x
    const dy = targetY - prev.y
    const inPendingWrap = prev.x >= screen.viewportWidth

    // If we're in pending wrap state (cursor.x >= width), use CR
    // to reset to column 0 on the current line without advancing
    // to the next line, then issue the cursor movement.
    if (inPendingWrap) {
      return [
        [CARRIAGE_RETURN, { type: 'cursorMove', x: targetX, y: dy }],
        { dx, dy },
      ]
    }

    // When moving to a different line, use carriage return (\r) to reset to
    // column 0 first, then cursor move.
    if (dy !== 0) {
      return [
        [CARRIAGE_RETURN, { type: 'cursorMove', x: targetX, y: dy }],
        { dx, dy },
      ]
    }

    // Standard same-line cursor move
    return [[{ type: 'cursorMove', x: dx, y: dy }], { dx, dy }]
  })
}

/**
 * Identify emoji where the terminal's wcwidth may disagree with Unicode.
 * On terminals with correct tables, the CHA we emit is a harmless no-op.
 *
 * Two categories:
 * 1. Newer emoji (Unicode 12.0+) missing from terminal wcwidth tables.
 * 2. Text-by-default emoji + VS16 (U+FE0F): the base codepoint is width 1
 *    in wcwidth, but VS16 triggers emoji presentation making it width 2.
 *    Examples: ⚔️ (U+2694), ☠️ (U+2620), ❤️ (U+2764).
 */
function needsWidthCompensation(char: string): boolean {
  const cp = char.codePointAt(0)
  if (cp === undefined) return false
  // U+1FA70-U+1FAFF: Symbols and Pictographs Extended-A (Unicode 12.0-15.0)
  // U+1FB00-U+1FBFF: Symbols for Legacy Computing (Unicode 13.0)
  if ((cp >= 0x1fa70 && cp <= 0x1faff) || (cp >= 0x1fb00 && cp <= 0x1fbff)) {
    return true
  }
  // Text-by-default emoji with VS16: scan for U+FE0F in multi-codepoint
  // graphemes. Single BMP chars (length 1) and surrogate pairs without VS16
  // skip this check. VS16 (0xFE0F) can't collide with surrogates (0xD800-0xDFFF).
  if (char.length >= 2) {
    for (let i = 0; i < char.length; i++) {
      if (char.charCodeAt(i) === 0xfe0f) return true
    }
  }
  return false
}

class VirtualScreen {
  // Public for direct mutation by writeCellWithStyleStr (avoids txn overhead).
  // File-private class — not exposed outside log-update.ts.
  cursor: Point
  diff: Diff = []

  constructor(
    origin: Point,
    readonly viewportWidth: number,
  ) {
    this.cursor = { ...origin }
  }

  txn(fn: (prev: Point) => [patches: Diff, next: Delta]): void {
    const [patches, next] = fn(this.cursor)
    for (const patch of patches) {
      this.diff.push(patch)
    }
    this.cursor.x += next.dx
    this.cursor.y += next.dy
  }
}
