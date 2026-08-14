import { type ReactNode } from 'react';
import * as dom from './dom.js';
import { FocusManager } from './focus.js';
import { type FrameEvent } from './frame.js';
import type { ParsedKey } from './parse-keypress.js';
import { type MatchPosition } from './render-to-screen.js';
import { type FocusMove, type SelectionState } from './selection.js';
export type Options = {
    stdout: NodeJS.WriteStream;
    stdin: NodeJS.ReadStream;
    stderr: NodeJS.WriteStream;
    exitOnCtrlC: boolean;
    patchConsole: boolean;
    waitUntilExit?: () => Promise<void>;
    onFrame?: (event: FrameEvent) => void;
};
export default class Ink {
    private readonly options;
    private readonly log;
    private readonly terminal;
    private scheduleRender;
    private isUnmounted;
    private isPaused;
    private readonly container;
    private rootNode;
    readonly focusManager: FocusManager;
    private renderer;
    private readonly stylePool;
    private charPool;
    private hyperlinkPool;
    private exitPromise?;
    private restoreConsole?;
    private restoreStderr?;
    private readonly unsubscribeTTYHandlers?;
    private terminalColumns;
    private terminalRows;
    private currentNode;
    private frontFrame;
    private backFrame;
    private lastPoolResetTime;
    private drainTimer;
    private lastYogaCounters;
    private altScreenParkPatch;
    readonly selection: SelectionState;
    private searchHighlightQuery;
    private searchPositions;
    private readonly selectionListeners;
    private readonly hoveredNodes;
    private altScreenActive;
    private altScreenMouseTracking;
    private prevFrameContaminated;
    private needsEraseBeforePaint;
    private cursorDeclaration;
    private displayCursor;
    constructor(options: Options);
    private handleResume;
    private handleResize;
    resolveExitPromise: () => void;
    rejectExitPromise: (reason?: Error) => void;
    unsubscribeExit: () => void;
    /**
     * Pause Ink and hand the terminal over to an external TUI (e.g. git
     * commit editor). In non-fullscreen mode this enters the alt screen;
     * in fullscreen mode we're already in alt so we just clear it.
     * Call `exitAlternateScreen()` when done to restore Ink.
     */
    enterAlternateScreen(): void;
    /**
     * Resume Ink after an external TUI handoff with a full repaint.
     * In non-fullscreen mode this exits the alt screen back to main;
     * in fullscreen mode we re-enter alt and clear + repaint.
     *
     * The re-enter matters: terminal editors (vim, nano, less) write
     * smcup/rmcup (?1049h/?1049l), so even though we started in alt,
     * the editor's rmcup on exit drops us to main screen. Without
     * re-entering, the 2J below wipes the user's main-screen scrollback
     * and subsequent renders land in main — native terminal scroll
     * returns, fullscreen scroll is dead.
     */
    exitAlternateScreen(): void;
    onRender(): void;
    pause(): void;
    resume(): void;
    /**
     * Reset frame buffers so the next render writes the full screen from scratch.
     * Call this before resume() when the terminal content has been corrupted by
     * an external process (e.g. tmux, shell, full-screen TUI).
     */
    repaint(): void;
    /**
     * Clear the physical terminal and force a full redraw.
     *
     * The traditional readline ctrl+l — clears the visible screen and
     * redraws the current content. Also the recovery path when the terminal
     * was cleared externally (macOS Cmd+K) and Ink's diff engine thinks
     * unchanged cells don't need repainting. Scrollback is preserved.
     */
    forceRedraw(): void;
    /**
     * Mark the previous frame as untrustworthy for blit, forcing the next
     * render to do a full-damage diff instead of the per-node fast path.
     *
     * Lighter than forceRedraw() — no screen clear, no extra write. Call
     * from a useLayoutEffect cleanup when unmounting a tall overlay: the
     * blit fast path can copy stale cells from the overlay frame into rows
     * the shrunken layout no longer reaches, leaving a ghost title/divider.
     * onRender resets the flag at frame end so it's one-shot.
     */
    invalidatePrevFrame(): void;
    /**
     * Called by the <AlternateScreen> component on mount/unmount.
     * Controls cursor.y clamping in the renderer and gates alt-screen-aware
     * behavior in SIGCONT/resize/unmount handlers. Repaints on change so
     * the first alt-screen frame (and first main-screen frame on exit) is
     * a full redraw with no stale diff state.
     */
    setAltScreenActive(active: boolean, mouseTracking?: boolean): void;
    get isAltScreenActive(): boolean;
    /**
     * Re-assert terminal modes after a gap (>5s stdin silence or event-loop
     * stall). Catches tmux detach→attach, ssh reconnect, and laptop
     * sleep/wake — none of which send SIGCONT. The terminal may reset DEC
     * private modes on reconnect; this method restores them.
     *
     * Always re-asserts extended key reporting and mouse tracking. Mouse
     * tracking is idempotent (DEC private mode set-when-set is a no-op). The
     * Kitty keyboard protocol is NOT — CSI >1u is a stack push, so we pop
     * first to keep depth balanced (pop on empty stack is a no-op per spec,
     * so after a terminal reset this still restores depth 0→1). Without the
     * pop, each >5s idle gap adds a stack entry, and the single pop on exit
     * or suspend can't drain them — the shell is left in CSI u mode where
     * Ctrl+C/Ctrl+D leak as escape sequences. The alt-screen
     * re-entry (ERASE_SCREEN + frame reset) is NOT idempotent — it blanks the
     * screen — so it's opt-in via includeAltScreen. The stdin-gap caller fires
     * on ordinary >5s idle + keypress and must not erase; the event-loop stall
     * detector fires on genuine sleep/wake and opts in. tmux attach / ssh
     * reconnect typically send a resize, which already covers alt-screen via
     * handleResize.
     */
    reassertTerminalModes: (includeAltScreen?: boolean) => void;
    /**
     * Mark this instance as unmounted so future unmount() calls early-return.
     * Called by gracefulShutdown's cleanupTerminalModes() after it has sent
     * EXIT_ALT_SCREEN but before the remaining terminal-reset sequences.
     * Without this, signal-exit's deferred ink.unmount() (triggered by
     * process.exit()) runs the full unmount path: onRender() + writeSync
     * cleanup block + updateContainerSync → AlternateScreen unmount cleanup.
     * The result is 2-3 redundant EXIT_ALT_SCREEN sequences landing on the
     * main screen AFTER printResumeHint(), which tmux (at least) interprets
     * as restoring the saved cursor position — clobbering the resume hint.
     */
    detachForShutdown(): void;
    /** @see drainStdin */
    drainStdin(): void;
    /**
     * Re-enter alt-screen, clear, home, re-enable mouse tracking, and reset
     * frame buffers so the next render repaints from scratch. Self-heal for
     * SIGCONT, resize, and stdin-gap/event-loop-stall (sleep/wake) — any of
     * which can leave the terminal in main-screen mode while altScreenActive
     * stays true. ENTER_ALT_SCREEN is a terminal-side no-op if already in alt.
     */
    private reenterAltScreen;
    /**
     * Seed prev/back frames with full-size BLANK screens (rows×cols of empty
     * cells, not 0×0). In alt-screen mode, next.screen.height is always
     * terminalRows; if prev.screen.height is 0 (emptyFrame's default),
     * log-update sees heightDelta > 0 ('growing') and calls renderFrameSlice,
     * whose trailing per-row CR+LF at the last row scrolls the alt screen,
     * permanently desyncing the virtual and physical cursors by 1 row.
     *
     * With a rows×cols blank prev, heightDelta === 0 → standard diffEach
     * → moveCursorTo (CSI cursorMove, no LF, no scroll).
     *
     * viewport.height = rows + 1 matches the renderer's alt-screen output,
     * preventing a spurious resize trigger on the first frame. cursor.y = 0
     * matches the physical cursor after ENTER_ALT_SCREEN + CSI H (home).
     */
    private resetFramesForAltScreen;
    /**
     * Copy the current selection to the clipboard without clearing the
     * highlight. Matches iTerm2's copy-on-select behavior where the selected
     * region stays visible after the automatic copy.
     */
    copySelectionNoClear(): string;
    /**
     * Copy the current text selection to the system clipboard via OSC 52
     * and clear the selection. Returns the copied text (empty if no selection).
     */
    copySelection(): string;
    /** Clear the current text selection without copying. */
    clearTextSelection(): void;
    /**
     * Set the search highlight query. Non-empty → all visible occurrences
     * are inverted (SGR 7) on the next frame; first one also underlined.
     * Empty → clears (prevFrameContaminated handles the frame after). Same
     * damage-tracking machinery as selection — setCellStyleId doesn't track
     * damage, so the overlay forces full-frame damage while active.
     */
    setSearchHighlight(query: string): void;
    /** Paint an EXISTING DOM subtree to a fresh Screen at its natural
     *  height, scan for query. Returns positions relative to the element's
     *  bounding box (row 0 = element top).
     *
     *  The element comes from the MAIN tree — built with all real
     *  providers, yoga already computed. We paint it to a fresh buffer
     *  with offsets so it lands at (0,0). Same paint path as the main
     *  render. Zero drift. No second React root, no context bridge.
     *
     *  ~1-2ms (paint only, no reconcile — the DOM is already built). */
    scanElementSubtree(el: dom.DOMElement): MatchPosition[];
    /** Set the position-based highlight state. Every frame, writes CURRENT
     *  style at positions[currentIdx] + rowOffset. null clears. The scan-
     *  highlight (inverse on all matches) still runs — this overlays yellow
     *  on top. rowOffset changes as the user scrolls (= message's current
     *  screen-top); positions stay stable (message-relative). */
    setSearchPositions(state: {
        positions: MatchPosition[];
        rowOffset: number;
        currentIdx: number;
    } | null): void;
    /**
     * Set the selection highlight background color. Replaces the per-cell
     * SGR-7 inverse with a solid theme-aware bg (matches native terminal
     * selection). Accepts the same color formats as Text backgroundColor
     * (rgb(), ansi:name, #hex, ansi256()) — colorize() routes through
     * chalk so the tmux/xterm.js level clamps in colorize.ts apply and
     * the emitted SGR is correct for the current terminal.
     *
     * Called by React-land once theme is known (ScrollKeybindingHandler's
     * useEffect watching useTheme). Before that call, withSelectionBg
     * falls back to withInverse so selection still renders on the first
     * frame; the effect fires before any mouse input so the fallback is
     * unobservable in practice.
     */
    setSelectionBgColor(color: string): void;
    /**
     * Capture text from rows about to scroll out of the viewport during
     * drag-to-scroll. Must be called BEFORE the ScrollBox scrolls so the
     * screen buffer still holds the outgoing content. Accumulated into
     * the selection state and joined back in by getSelectedText.
     */
    captureScrolledRows(firstRow: number, lastRow: number, side: 'above' | 'below'): void;
    /**
     * Shift anchor AND focus by dRow, clamped to [minRow, maxRow]. Used by
     * keyboard scroll handlers (PgUp/PgDn etc.) so the highlight tracks the
     * content instead of disappearing. Unlike shiftAnchor (drag-to-scroll),
     * this moves BOTH endpoints — the user isn't holding the mouse at one
     * edge. Supplies screen.width for the col-reset-on-clamp boundary.
     */
    shiftSelectionForScroll(dRow: number, minRow: number, maxRow: number): void;
    /**
     * Keyboard selection extension (shift+arrow/home/end). Moves focus;
     * anchor stays fixed so the highlight grows or shrinks relative to it.
     * Left/right wrap across row boundaries — native macOS text-edit
     * behavior: shift+left at col 0 wraps to end of the previous row.
     * Up/down clamp at viewport edges (no scroll-to-extend yet). Drops to
     * char mode. No-op outside alt-screen or without an active selection.
     */
    moveSelectionFocus(move: FocusMove): void;
    /** Whether there is an active text selection. */
    hasTextSelection(): boolean;
    /**
     * Subscribe to selection state changes. Fires whenever the selection
     * is started, updated, cleared, or copied. Returns an unsubscribe fn.
     */
    subscribeToSelectionChange(cb: () => void): () => void;
    private notifySelectionChange;
    /**
     * Hit-test the rendered DOM tree at (col, row) and bubble a ClickEvent
     * from the deepest hit node up through ancestors with onClick handlers.
     * Returns true if a DOM handler consumed the click. Gated on
     * altScreenActive — clicks only make sense with a fixed viewport where
     * nodeCache rects map 1:1 to terminal cells (no scrollback offset).
     */
    dispatchClick(col: number, row: number): boolean;
    dispatchHover(col: number, row: number): void;
    dispatchKeyboardEvent(parsedKey: ParsedKey): void;
    /**
     * Look up the URL at (col, row) in the current front frame. Checks for
     * an OSC 8 hyperlink first, then falls back to scanning the row for a
     * plain-text URL (mouse tracking intercepts the terminal's native
     * Cmd+Click URL detection, so we replicate it). This is a pure lookup
     * with no side effects — call it synchronously at click time so the
     * result reflects the screen the user actually clicked on, then defer
     * the browser-open action via a timer.
     */
    getHyperlinkAt(col: number, row: number): string | undefined;
    /**
     * Optional callback fired when clicking an OSC 8 hyperlink in fullscreen
     * mode. Set by FullscreenLayout via useLayoutEffect.
     */
    onHyperlinkClick: ((url: string) => void) | undefined;
    /**
     * Stable prototype wrapper for onHyperlinkClick. Passed to <App> as
     * onOpenHyperlink so the prop is a bound method (autoBind'd) that reads
     * the mutable field at call time — not the undefined-at-render value.
     */
    openHyperlink(url: string): void;
    /**
     * Handle a double- or triple-click at (col, row): select the word or
     * line under the cursor by reading the current screen buffer. Called on
     * PRESS (not release) so the highlight appears immediately and drag can
     * extend the selection word-by-word / line-by-line. Falls back to
     * char-mode startSelection if the click lands on a noSelect cell.
     */
    handleMultiClick(col: number, row: number, count: 2 | 3): void;
    /**
     * Handle a drag-motion at (col, row). In char mode updates focus to the
     * exact cell. In word/line mode snaps to word/line boundaries so the
     * selection extends by word/line like native macOS. Gated on
     * altScreenActive for the same reason as dispatchClick.
     */
    handleSelectionDrag(col: number, row: number): void;
    private stdinListeners;
    private wasRawMode;
    suspendStdin(): void;
    resumeStdin(): void;
    private writeRaw;
    private setCursorDeclaration;
    render(node: ReactNode): void;
    unmount(error?: Error | number | null): void;
    waitUntilExit(): Promise<void>;
    resetLineCount(): void;
    /**
     * Replace char/hyperlink pools with fresh instances to prevent unbounded
     * growth during long sessions. Migrates the front frame's screen IDs into
     * the new pools so diffing remains correct. The back frame doesn't need
     * migration — resetScreen zeros it before any reads.
     *
     * Call between conversation turns or periodically.
     */
    resetPools(): void;
    patchConsole(): () => void;
    /**
     * Intercept process.stderr.write so stray writes (config.ts, hooks.ts,
     * third-party deps) don't corrupt the alt-screen buffer. patchConsole only
     * hooks console.* methods — direct stderr writes bypass it, land at the
     * parked cursor, scroll the alt-screen, and desync frontFrame from the
     * physical terminal. Next diff writes only changed-in-React cells at
     * absolute coords → interleaved garbage.
     *
     * Swallows the write (routes text to the debug log) and, in alt-screen,
     * forces a full-damage repaint as a defensive recovery. Not patching
     * process.stdout — Ink itself writes there.
     */
    private patchStderr;
}
/**
 * Discard pending stdin bytes so in-flight escape sequences (mouse tracking
 * reports, bracketed-paste markers) don't leak to the shell after exit.
 *
 * Two layers of trickiness:
 *
 * 1. setRawMode is termios, not fcntl — the stdin fd stays blocking, so
 *    readSync on it would hang forever. Node doesn't expose fcntl, so we
 *    open /dev/tty fresh with O_NONBLOCK (all fds to the controlling
 *    terminal share one line-discipline input queue).
 *
 * 2. By the time forceExit calls this, detachForShutdown has already put
 *    the TTY back in cooked (canonical) mode. Canonical mode line-buffers
 *    input until newline, so O_NONBLOCK reads return EAGAIN even when
 *    mouse bytes are sitting in the buffer. We briefly re-enter raw mode
 *    so reads return any available bytes, then restore cooked mode.
 *
 * Safe to call multiple times. Call as LATE as possible in the exit path:
 * DISABLE_MOUSE_TRACKING has terminal round-trip latency, so events can
 * arrive for a few ms after it's written.
 */
export declare function drainStdin(stdin?: NodeJS.ReadStream): void;
//# sourceMappingURL=ink.d.ts.map