import autoBind from 'auto-bind';
import { closeSync, constants as fsConstants, openSync, readSync, writeSync } from 'fs';
import noop from 'lodash-es/noop.js';
import throttle from 'lodash-es/throttle.js';
import React, { type ReactNode } from 'react';
import type { FiberRoot } from 'react-reconciler';
import { ConcurrentRoot } from 'react-reconciler/constants.js';
import { onExit } from 'signal-exit';
import { flushInteractionTime } from '../bootstrap/state.js';
import { getYogaCounters } from '../native-ts/yoga-layout/index.js';
import { logForDebugging } from '../utils/debug.js';
import { logError } from '../utils/log.js';
import { isEnvTruthy } from '../utils/envUtils.js';
import { format } from 'util';
import { colorize } from './colorize.js';
import App from './components/App.js';
import type { CursorDeclaration, CursorDeclarationSetter } from './components/CursorDeclarationContext.js';
import { FRAME_INTERVAL_MS, PTY_BACKLOG_BYTES } from './constants.js';
import * as dom from './dom.js';
import { beginGeometryFrame, endGeometryFrame, GEOMETRY_TRACE_ENABLED, noteFrameCause } from './geometry-trace.js';
import { callWithUpdateOverflowGuard, installNestedUpdateOverflowProcessGuard } from './update-overflow-guard.js';
import { KeyboardEvent } from './events/keyboard-event.js';
import type { DragEvent } from './events/drag-event.js';
import { FocusManager } from './focus.js';
import { emptyFrame, type Frame, type FrameEvent } from './frame.js';
import { dispatchClick, dispatchContextMenu, dispatchDragEvent as bubbleDragEvent, dispatchHover, dispatchWheel, findDragTarget, clearHovered, invalidateNoInterestRect } from './hit-test.js';
import { logMouseDebug } from '../utils/debug.js';
import { noteTerminalFlush } from './flush-tick.js';
import instances from './instances.js';
import { suppressInputFor } from './input-suppression.js';
import { LogUpdate } from './log-update.js';
import { KittyGraphicsManager } from './kitty-graphics.js';
import { SixelGraphicsManager } from './sixel-graphics.js';
import { selectTerminalImageProtocol } from './terminal-image-protocol.js';
import { nodeCache } from './node-cache.js';
import { optimize } from './optimizer.js';
import Output from './output.js';
import type { ParsedKey } from './parse-keypress.js';
import reconciler, { dispatcher, getLastCommitMs, getLastYogaMs, isDebugRepaintsEnabled, recordYogaMs, resetProfileCounters } from './reconciler.js';
import renderNodeToOutput, { consumeFollowScroll, consumeViewportResizes, didLayoutShift } from './render-node-to-output.js';
import { applyPositionedHighlight, type MatchPosition, scanPositions } from './render-to-screen.js';
import createRenderer, { type Renderer } from './renderer.js';
import { CellWidth, CharPool, cellAt, createScreen, HyperlinkPool, isEmptyCellAt, migrateScreenPools, StylePool } from './screen.js';
import { applySearchHighlight } from './transcript-highlight.js';
import { applySelectionOverlay, captureScrolledRows, clearSelection, createSelectionState, extendSelection, type FocusMove, findPlainTextUrlAt, getSelectedText, hasSelection, moveFocus, pickFollowForSelection, type SelectionState, selectLineAt, selectWordAt, shiftAnchor, shiftSelection, shiftSelectionForFollow, shiftSelectionForViewportResize, shiftSelectionForViewportTranslation, startSelection, updateSelection } from './selection.js';
import { isDecstbmSafe, SYNC_OUTPUT_SUPPORTED, serializeDiff, supportsDecrqmProbe, supportsExtendedKeys, supportsWin32InputMode, type Terminal, writeDiffToTerminal } from './terminal.js';
import { CURSOR_HOME, cursorMove, cursorPosition, DISABLE_KITTY_KEYBOARD, DISABLE_MODIFY_OTHER_KEYS, DISABLE_WIN32_INPUT_MODE, ENABLE_KITTY_KEYBOARD, ENABLE_MODIFY_OTHER_KEYS, ENABLE_WIN32_INPUT_MODE, ERASE_SCREEN, ERASE_SCROLLBACK, SGR_RESET } from './termio/csi.js';
import { DBP, DFE, DISABLE_MOUSE_TRACKING, ENABLE_MOUSE_TRACKING, ENTER_ALT_SCREEN, EXIT_ALT_SCREEN, SHOW_CURSOR } from './termio/dec.js';
import { CLEAR_ITERM2_PROGRESS, CLEAR_TAB_STATUS, setClipboard, supportsTabStatus, wrapForMultiplexer } from './termio/osc.js';
import { decrqm, kittyGraphics, terminalCellSizePixels, terminalWindowSizePixels } from './terminal-querier.js';
import { TerminalWriteProvider } from './useTerminalNotification.js';
import { TerminalImagesContext } from './hooks/use-terminal-images.js';
import { DEFAULT_TERMINAL_CELL_SIZE, resolveTerminalCellSize, type TerminalImagePlacement } from './terminal-image.js';

// Alt-screen: renderer.ts sets cursor.visible = !isTTY || screen.height===0,
// which is always false in alt-screen (TTY + content fills screen).
// Reusing a frozen object saves 1 allocation per frame.
const ALT_SCREEN_ANCHOR_CURSOR = Object.freeze({
  x: 0,
  y: 0,
  visible: false
});
const CURSOR_HOME_PATCH = Object.freeze({
  type: 'stdout' as const,
  content: CURSOR_HOME
});
const ERASE_THEN_HOME_PATCH = Object.freeze({
  type: 'stdout' as const,
  content: ERASE_SCREEN + CURSOR_HOME
});
const TERMINAL_REPLY_QUARANTINE_MS = 120;

// Cached per-Ink-instance, invalidated on resize. frame.cursor.y for
// alt-screen is always terminalRows - 1 (renderer.ts).
function makeAltScreenParkPatch(terminalRows: number) {
  return Object.freeze({
    type: 'stdout' as const,
    content: cursorPosition(terminalRows, 1)
  });
}

export type Options = {
  stdout: NodeJS.WriteStream;
  stdin: NodeJS.ReadStream;
  stderr: NodeJS.WriteStream;
  exitOnCtrlC: boolean;
  patchConsole: boolean;
  terminalImages?: boolean;
  waitUntilExit?: () => Promise<void>;
  onFrame?: (event: FrameEvent) => void;
};
export default class Ink {
  private readonly log: LogUpdate;
  private readonly terminal: Terminal;
  private readonly kittyGraphicsManager = new KittyGraphicsManager();
  private readonly sixelGraphicsManager = new SixelGraphicsManager(() => {
    if (this.isUnmounted || this.isPaused || this.terminalQueriesSuspended || !this.altScreenActive) return;
    dom.markTreeDirty(this.rootNode);
    this.scheduleRender();
  });
  private sixelGraphicsSupported = false;
  private kittyGraphicsSupported = false;
  private kittyGraphicsProbeStarted = false;
  private terminalImageRequests = 0;
  private measuredImageCellSize: ReturnType<typeof resolveTerminalCellSize>;
  private readonly terminalImageListeners = new Set<() => void>();
  private readonly terminalImages = {
    subscribe: (listener: () => void): (() => void) => {
      this.terminalImageListeners.add(listener);
      return () => { this.terminalImageListeners.delete(listener); };
    },
    getSnapshot: (): boolean => this.altScreenActive && (this.kittyGraphicsSupported || this.sixelGraphicsSupported) &&
      !this.isPaused && !this.terminalQueriesSuspended && !this.isUnmounted,
    getCellSize: () => this.measuredImageCellSize,
    request: (): (() => void) => {
      if (this.isUnmounted) return noop;
      this.terminalImageRequests += 1;
      this.maybeProbeKittyGraphics([]);
      return () => { this.terminalImageRequests -= 1; };
    },
  };
  private terminalCellMetricsInFlight = false;
  private terminalCellMetricsRefreshPending = false;
  private terminalQueryResumeTimer: ReturnType<typeof setTimeout> | null = null;
  private app: App | null = null;
  private scheduleRender: (() => void) & {
    cancel?: () => void;
  };
  // Ignore last render after unmounting a tree to prevent empty output before exit
  private isUnmounted = false;
  private isPaused = false;
  private readonly container: FiberRoot;
  private rootNode: dom.DOMElement;
  readonly focusManager: FocusManager;
  private renderer: Renderer;
  private readonly stylePool: StylePool;
  private charPool: CharPool;
  private hyperlinkPool: HyperlinkPool;
  private exitPromise?: Promise<void>;
  private restoreConsole?: () => void;
  private restoreStderr?: () => void;
  private readonly unsubscribeTTYHandlers?: () => void;
  private terminalColumns: number;
  private terminalRows: number;
  private currentNode: ReactNode = null;
  private frontFrame: Frame;
  private backFrame: Frame;
  private lastPoolResetTime = performance.now();
  private drainTimer: ReturnType<typeof setTimeout> | null = null;
  // Every scheduled microtask carries the generation that created it. Immediate
  // renders invalidate older trailing work before it can append an old frame.
  private renderGeneration = 0;
  private pendingRenderGeneration: number | null = null;
  private lastYogaCounters: {
    ms: number;
    visited: number;
    measured: number;
    cacheHits: number;
    live: number;
  } = {
    ms: 0,
    visited: 0,
    measured: 0,
    cacheHits: 0,
    live: 0
  };
  private altScreenParkPatch: Readonly<{
    type: 'stdout';
    content: string;
  }>;
  // Text selection state (alt-screen only). Owned here so the overlay
  // pass in onRender can read it and App.tsx can update it from mouse
  // events. Public so instances.get() callers can access.
  readonly selection: SelectionState = createSelectionState();
  // Search highlight query (alt-screen only). Setter below triggers
  // scheduleRender; applySearchHighlight in onRender inverts matching cells.
  private searchHighlightQuery = '';
  // Position-based highlight. VML scans positions ONCE (via
  // scanElementSubtree, when the target message is mounted), stores them
  // message-relative, sets this for every-frame apply. rowOffset =
  // message's current screen-top. currentIdx = which position is
  // "current" (yellow). null clears. Positions are known upfront —
  // navigation is index arithmetic, no scan-feedback loop.
  private searchPositions: {
    positions: MatchPosition[];
    rowOffset: number;
    currentIdx: number;
  } | null = null;
  // React-land subscribers for selection state changes (useHasSelection).
  // Fired alongside the terminal repaint whenever the selection mutates
  // so UI (e.g. footer hints) can react to selection appearing/clearing.
  private readonly selectionListeners = new Set<() => void>();
  // DOM nodes currently under the pointer (mode-1003 motion). Held here
  // so App.tsx's handleMouseEvent is stateless — dispatchHover diffs
  // against this set and mutates it in place.
  private readonly hoveredNodes = new Set<dom.DOMElement>();
  // Set by <AlternateScreen> via setAltScreenActive(). Controls the
  // renderer's cursor.y clamping (keeps cursor in-viewport to avoid
  // LF-induced scroll when screen.height === terminalRows) and gates
  // alt-screen-aware SIGCONT/resize/unmount handling.
  private altScreenActive = false;
  // Set alongside altScreenActive so SIGCONT resume knows whether to
  // re-enable mouse tracking (not all <AlternateScreen> uses want it).
  private altScreenMouseTracking = false;
  // DEC 1049 preserves the physical main screen and cursor. Keep the matching
  // renderer state while an inline full-screen view is active so its exit can
  // diff from what the terminal actually restores instead of printing a full
  // duplicate frame into main-screen scrollback.
  private mainScreenFrameState: {
    frontFrame: Frame;
    displayCursor: { x: number; y: number } | null;
    columns: number;
    rows: number;
  } | null = null;
  // True when the previous frame's screen buffer cannot be trusted for
  // blit — selection overlay mutated it, resetFramesForAltScreen()
  // replaced it with blanks, or forceRedraw() reset it to 0×0. Forces
  // one full-render frame; steady-state frames after clear it and regain
  // the blit + narrow-damage fast path.
  private prevFrameContaminated = false;
  // Set by handleResize: prepend ERASE_SCREEN to the next onRender's patches
  // INSIDE the BSU/ESU block so clear+paint is atomic. Writing ERASE_SCREEN
  // synchronously in handleResize would leave the screen blank for the ~80ms
  // render() takes; deferring into the atomic block means old content stays
  // visible until the new frame is fully ready.
  private needsEraseBeforePaint = false;
  // Native cursor positioning: a component (via useDeclaredCursor) declares
  // where the terminal cursor should be parked after each frame. Terminal
  // emulators render IME preedit text at the physical cursor position, and
  // screen readers / screen magnifiers track it — so parking at the text
  // input's caret makes CJK input appear inline and lets a11y tools follow.
  private cursorDeclaration: CursorDeclaration | null = null;
  // Main-screen: physical cursor position after the declared-cursor move,
  // tracked separately from frame.cursor (which must stay at content-bottom
  // for log-update's relative-move invariants). Alt-screen doesn't need
  // this — every frame begins with CSI H. null = no move emitted last frame.
  private displayCursor: {
    x: number;
    y: number;
  } | null = null;
  private handleStdinError(error: NodeJS.ErrnoException): void {
    if (this.isUnmounted && error.code === 'EIO') {
      return;
    }
    throw error;
  }
  constructor(private readonly options: Options) {
    autoBind(this);
    if (options.stdin.isTTY) {
      // Keep this listener through teardown: a pending libuv TTY read can
      // report EIO only after raw mode and React have already been released.
      options.stdin.on('error', this.handleStdinError);
    }
    if (this.options.patchConsole) {
      this.restoreConsole = this.patchConsole();
      this.restoreStderr = this.patchStderr();
    }
    this.terminal = {
      stdout: options.stdout,
      stderr: options.stderr
    };
    this.terminalColumns = options.stdout.columns || 80;
    this.terminalRows = options.stdout.rows || 24;
    this.altScreenParkPatch = makeAltScreenParkPatch(this.terminalRows);
    this.stylePool = new StylePool();
    this.charPool = new CharPool();
    this.hyperlinkPool = new HyperlinkPool();
    this.frontFrame = emptyFrame(this.terminalRows, this.terminalColumns, this.stylePool, this.charPool, this.hyperlinkPool);
    this.backFrame = emptyFrame(this.terminalRows, this.terminalColumns, this.stylePool, this.charPool, this.hyperlinkPool);
    this.log = new LogUpdate({
      isTTY: options.stdout.isTTY as boolean | undefined || false,
      stylePool: this.stylePool
    });

    // scheduleRender is called from the reconciler's resetAfterCommit, which
    // runs BEFORE React's layout phase (ref attach + useLayoutEffect). Any
    // state set in layout effects — notably the cursorDeclaration from
    // useDeclaredCursor — would lag one commit behind if we rendered
    // synchronously. Deferring to a microtask runs onRender after layout
    // effects have committed, so the native cursor tracks the caret without
    // a one-keystroke lag. Same event-loop tick, so throughput is unchanged.
    // Test env uses onImmediateRender (direct onRender, no throttle) so
    // existing synchronous lastFrame() tests are unaffected. Keep a
    // generation on the microtask: an immediate render may supersede the
    // leading frame before its deferred callback runs.
    const deferredRender = (): void => {
      const generation = ++this.renderGeneration;
      this.pendingRenderGeneration = generation;
      queueMicrotask(() => {
        if (this.pendingRenderGeneration !== generation || this.renderGeneration !== generation) return;
        this.pendingRenderGeneration = null;
        this.onRender();
      });
    };
    this.scheduleRender = throttle(deferredRender, FRAME_INTERVAL_MS, {
      leading: true,
      trailing: true
    });

    // Ignore last render after unmounting a tree to prevent empty output before exit
    this.isUnmounted = false;

    // Unmount when process exits
    this.unsubscribeExit = onExit(this.unmount, {
      alwaysLast: false
    });
    if (options.stdout.isTTY) {
      options.stdout.on('resize', this.handleResize);
      process.on('SIGCONT', this.handleResume);
      this.unsubscribeTTYHandlers = () => {
        options.stdout.off('resize', this.handleResize);
        process.off('SIGCONT', this.handleResume);
      };
    }
    this.rootNode = dom.createNode('ink-root');
    this.focusManager = new FocusManager((target, event) => dispatcher.dispatchDiscrete(target, event));
    this.rootNode.focusManager = this.focusManager;
    this.renderer = createRenderer(this.rootNode, this.stylePool);
    this.rootNode.onRender = this.scheduleRender;
    this.rootNode.onImmediateRender = this.renderNow;
    this.rootNode.onComputeLayout = () => {
      // Hover no-interest cache (hit-test.ts) is strictly per-frame: every
      // React commit may attach or detach hover handlers, so drop the cache
      // at the COMMIT boundary. The renderer also invalidates at the top of
      // each render pass, but that runs up to a frame later (throttled
      // scheduleRender) — invalidating here closes the gap so a motion
      // event inside that window re-hit-tests against the fresh tree.
      invalidateNoInterestRect();
      // Calculate layout during React's commit phase so useLayoutEffect hooks
      // have access to fresh layout data
      // Guard against accessing freed Yoga nodes after unmount
      if (this.isUnmounted) {
        return;
      }
      if (this.rootNode.yogaNode) {
        const t0 = performance.now();
        this.rootNode.yogaNode.setWidth(this.terminalColumns);
        this.rootNode.yogaNode.calculateLayout(this.terminalColumns);
        const ms = performance.now() - t0;
        recordYogaMs(ms);
        const c = getYogaCounters();
        this.lastYogaCounters = {
          ms,
          ...c
        };
      }
    };

    // @ts-ignore -- runtime/type-definition mismatch: @types/react-reconciler@0.32.3 declares 11 args with transitionCallbacks,
    // but react-reconciler 0.33.0 source only accepts 10 args (no transitionCallbacks)
    this.container = reconciler.createContainer(this.rootNode, ConcurrentRoot, null, false, null, 'id', noop,
    // onUncaughtError
    noop,
    // onCaughtError
    noop,
    // onRecoverableError
    noop // onDefaultTransitionIndicator
    );
    // #185 process backstop: the nested-update overflow can surface from any
    // timer dispatch (not only the guarded hotspots), which would kill the
    // process. React resets the counter before throwing, so absorbing the
    // error class process-wide is safe — see update-overflow-guard.ts.
    installNestedUpdateOverflowProcessGuard();
    if (process.env.NODE_ENV === 'development') {
      reconciler.injectIntoDevTools({
        bundleType: 0,
        // Reporting React DOM's version, not Ink's
        // See https://github.com/facebook/react/issues/16666#issuecomment-532639905
        version: '16.13.1',
        rendererPackageName: 'ink'
      });
    }
  }
  private handleResume = () => {
    if (!this.options.stdout.isTTY) {
      return;
    }

    // Alt screen: after SIGCONT, content is stale (shell may have written
    // to main screen, switching focus away) and mouse tracking was
    // disabled by handleSuspend.
    if (this.altScreenActive) {
      this.reenterAltScreen();
      return;
    }

    // Main screen: start fresh to prevent clobbering terminal content
    this.frontFrame = emptyFrame(this.frontFrame.viewport.height, this.frontFrame.viewport.width, this.stylePool, this.charPool, this.hyperlinkPool);
    this.backFrame = emptyFrame(this.backFrame.viewport.height, this.backFrame.viewport.width, this.stylePool, this.charPool, this.hyperlinkPool);
    this.log.reset();
    // Physical cursor position is unknown after the shell took over during
    // suspend. Clear displayCursor so the next frame's cursor preamble
    // doesn't emit a relative move from a stale park position.
    this.displayCursor = null;
  };

  // NOT debounced. A debounce opens a window where stdout.columns is NEW
  // but this.terminalColumns/Yoga are OLD — any scheduleRender during that
  // window (spinner, clock) makes log-update detect a width change and
  // clear the screen, then the debounce fires and clears again (double
  // blank→paint flicker). useVirtualScroll's height scaling already bounds
  // the per-resize cost; synchronous handling keeps dimensions consistent.
  private handleResize = () => {
    const cols = this.options.stdout.columns || 80;
    const rows = this.options.stdout.rows || 24;
    // Terminals often emit 2+ resize events for one user action (window
    // settling). Same-dimension events are no-ops; skip to avoid redundant
    // frame resets and renders.
    if (cols === this.terminalColumns && rows === this.terminalRows) {
      // A font zoom or DPI move can change cell pixels without changing the
      // row/column grid. The in-flight guard coalesces duplicate events.
      this.refreshTerminalCellMetrics();
      return;
    }
    noteFrameCause('resize');
    this.terminalColumns = cols;
    this.terminalRows = rows;
    this.refreshTerminalCellMetrics();
    this.altScreenParkPatch = makeAltScreenParkPatch(this.terminalRows);
    // Reflow moved every rect the pointer state was tracking: hover sets
    // and the multi-click chain reference pre-resize geometry. Fire the
    // leave handlers FIRST — a bare clear() strands the crossed rows'
    // hovered=true React state forever (stuck highlights) — then drop the
    // set so a post-resize click is a fresh single click and hover re-fires
    // from scratch. (Coordinates in in-flight events are clamped at the
    // App boundary against the new dimensions.)
    clearHovered(this.hoveredNodes);
    this.app?.resetPointerState();
    // Same geometry wholesale-change: the cached no-interest hover rect
    // (hit-test.ts) was computed against pre-resize rects — drop it.
    invalidateNoInterestRect();

    // Invalidate every render that was scheduled against the OLD size: a
    // queued microtask generation or a scroll-drain timer would otherwise
    // fire after this resize completes and paint a frame computed for the
    // pre-resize layout (mixed-width rows, off-by-reflow writes). The
    // re-render below schedules fresh work at the new dimensions.
    this.renderGeneration++;
    this.pendingRenderGeneration = null;
    this.scheduleRender.cancel?.();
    if (this.drainTimer !== null) {
      clearTimeout(this.drainTimer);
      this.drainTimer = null;
    }

    // Every cached measurement in the tree was taken against a width that no
    // longer exists. Nothing here is "dirty" in the reconciler's sense — no
    // props changed — so without an explicit sweep the text nodes keep
    // answering with the sizes they computed for the old terminal, and the
    // rows that depend on flex arbitration come out assembled from two
    // different layouts. Setting the root's width alone does not reach them:
    // markDirty walks upward from a changed node, and here the change is the
    // constraint every node was measured against.
    dom.markTreeDirty(this.rootNode);

    // Alt screen: reset frame buffers so the next render repaints from
    // scratch (prevFrameContaminated → every cell written, wrapped in
    // BSU/ESU — old content stays visible until the new frame swaps
    // atomically). Re-assert mouse tracking (some emulators reset it on
    // resize). Do NOT write ENTER_ALT_SCREEN: iTerm2 treats ?1049h as a
    // buffer clear even when already in alt — that's the blank flicker.
    // Self-healing re-entry (if something kicked us out of alt) is handled
    // by handleResume (SIGCONT) and the sleep-wake detector; resize itself
    // doesn't exit alt-screen. Do NOT write ERASE_SCREEN: render() below
    // can take ~80ms; erasing first leaves the screen blank that whole time.
    if (this.altScreenActive && !this.isPaused && this.options.stdout.isTTY) {
      // Blind mouse re-assert + 1049 probe: conpty resets modes on resize
      // too, and a dropped 1049 means every subsequent frame paints onto
      // the MAIN screen (looks like the app spontaneously exited
      // fullscreen). The probe's re-entry is gated on a positive DECRPM
      // "reset" answer, so this stays inert on healthy terminals.
      this.probeAltScreenHealth();
      this.resetFramesForAltScreen();
      this.needsEraseBeforePaint = true;
    }

    // Re-render the React tree with updated props so the context value changes.
    // React's commit phase will call onComputeLayout() to recalculate yoga layout
    // with the new dimensions, then call onRender() to render the updated frame.
    // We don't call scheduleRender() here because that would render before the
    // layout is updated, causing a mismatch between viewport and content dimensions.
    if (this.currentNode !== null) {
      this.render(this.currentNode);
    }
  };
  resolveExitPromise: () => void = () => {};
  rejectExitPromise: (reason?: Error) => void = () => {};
  unsubscribeExit: () => void = () => {};

  /**
   * Pause Ink and hand the terminal over to an external TUI (e.g. git
   * commit editor). In non-fullscreen mode this enters the alt screen;
   * in fullscreen mode we're already in alt so we just clear it.
   * Call `exitAlternateScreen()` when done to restore Ink.
   */
  enterAlternateScreen(): void {
    this.pause();
    this.app?.querier.suspend();
    if (this.terminalQueryResumeTimer !== null) {
      clearTimeout(this.terminalQueryResumeTimer);
      this.terminalQueryResumeTimer = null;
    }
    // Replies cannot be routed while the child owns stdin. Release every
    // query hold before cooked mode is restored; an interrupted first Kitty
    // probe may be attempted again after the handoff.
    if (!this.kittyGraphicsSupported && !this.sixelGraphicsSupported) this.kittyGraphicsProbeStarted = false;
    this.suspendStdin();
    // Kitty placements are independent of the terminal cell grid: clearing
    // the screen for an external editor does not remove them. Delete every
    // renderer-owned image before handing the buffer over, otherwise a
    // negative-z preview can remain visible through the editor's default-
    // background cells. deleteAll() also forgets the ids so the restore pass
    // uploads fresh data after resetFramesForAltScreen().
    const deleteImages = this.kittyGraphicsManager.deleteAll() + this.sixelGraphicsManager.clear();
    this.options.stdout.write(
    deleteImages +
    // Disable extended key reporting first — editors that don't speak
    // CSI-u (e.g. nano) show "Unknown sequence" for every Ctrl-<key> if
    // kitty/modifyOtherKeys stays active. exitAlternateScreen re-enables.
    // win32-input-mode (native Windows) likewise must not leak into the
    // editor — it would turn every key into INPUT_RECORD sequences.
    DISABLE_WIN32_INPUT_MODE + DISABLE_KITTY_KEYBOARD + DISABLE_MODIFY_OTHER_KEYS + (this.altScreenMouseTracking ? DISABLE_MOUSE_TRACKING : '') + (
    // disable mouse (no-op if off)
    this.altScreenActive ? '' : '\x1b[?1049h') +
    // enter alt (already in alt if fullscreen)
    '\x1b[?1004l' +
    // disable focus reporting
    '\x1b[0m' +
    // reset attributes
    '\x1b[?25h' +
    // show cursor
    '\x1b[2J' +
    // clear screen
    '\x1b[H' // cursor home
    );
  }

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
  exitAlternateScreen(): void {
    if (this.altScreenActive) {
      // Fullscreen: re-enter alt FIRST — terminal editors (vim, nano, less)
      // write smcup/rmcup, so the editor's rmcup on exit dropped us to the
      // main screen; without re-entering, the 2J below would wipe the
      // user's main-screen scrollback and later renders would land in main
      // (native scroll returns, fullscreen scroll dies).
      this.options.stdout.write(ENTER_ALT_SCREEN +
      '\x1b[2J' +
      // clear screen
      '\x1b[H' + (
      // cursor home
      this.altScreenMouseTracking ? ENABLE_MOUSE_TRACKING : '') +
      // Restore mouse tracking when enabled for the alternate screen.
      '\x1b[?25l' // hide cursor (Ink manages)
      );
      this.resumeStdin();
      // Swallow the terminal's post-restore chatter (async CPR/DECRPM
      // replies, mouse fragments): resumeStdin's drain only covers bytes
      // already buffered, and a stray ESC would clear a non-empty prompt
      // (issue #123 field report).
      suppressInputFor(TERMINAL_REPLY_QUARANTINE_MS);
      this.resetFramesForAltScreen();
      this.resume();
    } else {
      // Inline: pop alt FIRST (a no-op when the editor's rmcup already did
      // it), THEN clear+home the main screen and force a full redraw from
      // home — the same proven sequence as forceRedraw()/Ctrl+L. The
      // previous order (2J before 1049l, plain repaint(), no contamination
      // flag) erased the alt buffer or left the blit fast path copying
      // from an empty frontFrame: the transcript stayed blank until the
      // next message, and the desynced log-update cursor duplicated the
      // frame below (issue #123 field report).
      this.options.stdout.write('\x1b[?1049l' +
      // exit alt before touching the main screen
      SGR_RESET + ERASE_SCREEN + CURSOR_HOME +
      // BCE-safe clear from home, cursor parked top-left for the redraw
      '\x1b[?25l' // hide cursor (Ink manages)
      );
      this.resumeStdin();
      suppressInputFor(TERMINAL_REPLY_QUARANTINE_MS);
      this.repaint();
      // repaint()'s fresh empty frontFrame would let the blit fast path
      // copy blanks and diff to nothing — same flag forceRedraw() sets.
      this.prevFrameContaminated = true;
      this.resume();
    }
    // Re-enable focus reporting and extended key reporting — terminal
    // editors (vim, nano, etc.) write their own modifyOtherKeys level on
    // entry and reset it on exit, leaving us unable to distinguish
    // ctrl+shift+<letter> from ctrl+<letter>. Pop-before-push keeps the
    // Kitty stack balanced (a well-behaved editor restores our entry, so
    // without the pop we'd accumulate depth on each editor round-trip).
    this.options.stdout.write('\x1b[?1004h' + (supportsWin32InputMode() ? ENABLE_WIN32_INPUT_MODE : supportsExtendedKeys() ? DISABLE_KITTY_KEYBOARD + ENABLE_KITTY_KEYBOARD + ENABLE_MODIFY_OTHER_KEYS : ''));
    this.resumeTerminalQueriesAfterHandoff();
  }
  /**
   * One-shot viewport re-anchor for the NEXT main-screen frame: repaint the
   * visible viewport in place instead of diffing. Exposed for callers that
   * know a layout flip just rewrote the whole frame (Ctrl+O transcript
   * toggle): the ordinary scroll-based diff pushes rows into terminal
   * scrollback on every expand and nothing removes them on collapse — rapid
   * toggles drift the virtual↔scrollback mapping until writes misland.
   * In-place repaint adds nothing to scrollback. No-op in alt-screen
   * (already CSI H-anchored every frame). ONLY sets the flag: the caller's
   * own state change (setExpanded) drives the render that consumes it —
   * forcing an extra render here would paint the OLD layout once more and
   * burn the flag before the real frame lands.
   */
  reanchorViewport() {
    if (this.altScreenActive) return;
    noteFrameCause('reanchor');
    this.log.requestViewportReanchor();
  }
  /** Render synchronously and invalidate older trailing/drain callbacks. */
  private renderNow(): void {
    noteFrameCause('immediate');
    this.renderGeneration++;
    this.pendingRenderGeneration = null;
    this.scheduleRender.cancel?.();
    if (this.drainTimer !== null) {
      clearTimeout(this.drainTimer);
      this.drainTimer = null;
    }
    this.onRender();
  }

  /**
   * Drain scrolling at quarter-frame cadence while keeping queued output
   * bounded on slow terminals. React-driven updates retain their normal
   * throttle, so typing and streaming do not wait behind a scroll backlog.
   */
  private scheduleDrain(): void {
    if (this.drainTimer !== null) return;
    const stdout = this.options.stdout;
    const backlog =
      typeof (stdout as { writableLength?: number }).writableLength === 'number'
        ? (stdout as { writableLength: number }).writableLength
        : 0;
    if (backlog > PTY_BACKLOG_BYTES) {
      this.drainTimer = setTimeout(() => {
        this.drainTimer = null;
        this.scheduleDrain();
      }, FRAME_INTERVAL_MS >> 2);
      return;
    }
    this.drainTimer = setTimeout(this.renderNow, FRAME_INTERVAL_MS >> 2);
  }

  onRender() {
    if (this.isUnmounted || this.isPaused) {
      return;
    }
    if (GEOMETRY_TRACE_ENABLED) beginGeometryFrame(this.renderGeneration);
    // Entering a render cancels any pending drain tick — this render will
    // handle the drain (and re-schedule below if needed). Prevents a
    // wheel-event-triggered render AND a drain-timer render both firing.
    if (this.drainTimer !== null) {
      clearTimeout(this.drainTimer);
      this.drainTimer = null;
    }

    // Flush deferred interaction-time update before rendering so we call
    // Date.now() at most once per frame instead of once per keypress.
    // Done before the render to avoid dirtying state that would trigger
    // an extra React re-render cycle.
    flushInteractionTime();

    // Dimension consistency: onComputeLayout laid the tree out against
    // this.terminalColumns/Rows (the cached values handleResize owns), so
    // the renderer and the diff engine MUST paint that same size. Reading
    // the live stdout size here mixed the two when a resize event had not
    // fired yet (Windows Terminal emits 'resize' after columns already
    // changed): Yoga laid out for the old width while log-update wrapped
    // and diffed at the new one — rows painted off by the reflow delta.
    // On drift, route through the resize path (cache sync + markTreeDirty
    // + re-render) and bail: the render handleResize schedules paints the
    // correctly-laid-out frame.
    const liveColumns = this.options.stdout.columns || 80;
    const liveRows = this.options.stdout.rows || 24;
    if (this.options.stdout.isTTY && (liveColumns !== this.terminalColumns || liveRows !== this.terminalRows)) {
      this.handleResize();
      return;
    }

    const renderStart = performance.now();
    const terminalWidth = this.terminalColumns;
    const terminalRows = this.terminalRows;
    const sixelActive = this.altScreenActive && this.sixelGraphicsSupported;
    this.sixelGraphicsManager.beginFrame(terminalWidth, terminalRows);
    const frame = this.renderer({
      frontFrame: this.frontFrame,
      backFrame: this.backFrame,
      isTTY: this.options.stdout.isTTY,
      terminalWidth,
      terminalRows,
      altScreen: this.altScreenActive,
      terminalImages: this.altScreenActive && (this.kittyGraphicsSupported || this.sixelGraphicsSupported),
      imageReady: sixelActive ? this.sixelGraphicsManager.prepare : undefined,
      prevFrameContaminated: this.prevFrameContaminated
    });
    const rendererMs = performance.now() - renderStart;
    this.maybeProbeKittyGraphics(frame.images ?? []);

    // Viewport-shrink translation (companion to the follow block below):
    // chrome mounting around a ScrollBox (the new-messages pill, the sticky
    // prompt header, the working spinner, prompt growth) moves the viewport
    // edges with NO scroll delta, so no followScroll event fires and the
    // block below never sees it. The selection endpoints are screen-buffer
    // rows; unhandled, the anchor strands BELOW the shrunken viewport —
    // pickFollowForSelection then rejects every follow event (anchor
    // outside the viewport) and wheel tracking silently dies, leaving the
    // highlight pinned to the chrome row: copy-on-select grabs the chrome
    // text itself (the "↓ 回到底部" pill leaking into bottom-to-top copies)
    // and the rows that scrolled under the dead highlight never reach the
    // scrolledOff accumulators. Capture the covered band from the PREVIOUS
    // frame's screen (frontFrame — the swap is below) and re-clamp the
    // endpoints BEFORE the follow pick, so the clamped anchor is in-viewport
    // and this frame's wheel drain translates normally.
    const viewportResizes = consumeViewportResizes();
    if (viewportResizes.length > 0 && this.selection.anchor) {
      const resize = pickFollowForSelection(
        viewportResizes,
        this.selection.anchor.row,
      );
      // Terminal resize rebuilds the screen at new dimensions; the
      // selection's screen-buffer coords are stale against the previous
      // frame's buffer and band capture would read garbage. Chrome-mount
      // resizes (the target case) never change the terminal size.
      if (
        resize &&
        this.frontFrame.screen.width === terminalWidth &&
        this.frontFrame.screen.height === terminalRows
      ) {
        const hadSelection = hasSelection(this.selection);
        if (resize.kind === 'translate') {
          const cleared = shiftSelectionForViewportTranslation(
            this.selection,
            resize.rowDelta,
            resize.prevTop,
            resize.prevBottom,
            resize.top,
            resize.bottom,
          );
          if (cleared) for (const cb of this.selectionListeners) cb();
        } else {
          shiftSelectionForViewportResize(
            this.selection,
            this.frontFrame.screen,
            resize.prevTop,
            resize.prevBottom,
            resize.top,
            resize.bottom,
          );
          // Both-ends-covered clear must notify React-land so useHasSelection
          // re-renders and the footer copy/escape hint disappears — direct
          // listener fire (notifySelectionChange would re-enter onRender).
          if (hadSelection && !hasSelection(this.selection)) {
            for (const cb of this.selectionListeners) cb();
          }
        }
      }
    }

    // Sticky/auto-follow or wheel-drain scrolled one or more ScrollBoxes
    // this frame. Translate the selection by the same delta so the highlight
    // stays anchored to the TEXT (native terminal behavior — the
    // selection walks up the screen as content scrolls, eventually
    // clipping at the top). frontFrame
    // still holds the PREVIOUS frame's screen (swap is at ~500 below), so
    // captureScrolledRows reads the rows that are about to scroll out
    // before they're overwritten — the text stays copyable until the
    // selection scrolls entirely off. During drag, focus tracks the mouse
    // (screen-local) so only anchor shifts — selection grows toward the
    // mouse as the anchor walks up. After release, both ends are text-
    // anchored and move as a block.
    const follow = pickFollowForSelection(
      consumeFollowScroll(),
      this.selection.anchor?.row ?? null,
    );
    // pickFollowForSelection already checked anchor-in-viewport (that IS
    // the "selection is on scrollbox content" guard — footer/prompt
    // selections on static text match no viewport and follow nothing).
    // Innermost-viewport wins attributes correctly when several boxes
    // scrolled this frame (transcript draining while an overlay panel's
    // box scrolls): panels render on top, so overlap-row selections
    // belong to the panel, not the covered transcript.
    if (follow && this.selection.anchor) {
      const {
        delta,
        viewportTop,
        viewportBottom
      } = follow;
      // Signed delta: >0 = content moved up (at-bottom follow or
      // wheel-down drain); <0 = content moved down (wheel-up drain, #438).
      // The capture window is the viewport-edge rows about to scroll out
      // (top edge when content moves up, bottom edge when it moves down),
      // and the shift re-anchors the endpoints by the same amount in the
      // OPPOSITE direction so they track the text, not the screen.
      const rows = Math.abs(delta);
      const up = delta > 0;
      const firstRow = up ? viewportTop : viewportBottom - rows + 1;
      const lastRow = up ? viewportTop + rows - 1 : viewportBottom;
      const side: 'above' | 'below' = up ? 'above' : 'below';
      const shift = up ? -rows : rows;
      // captureScrolledRows and shift* are a pair: capture grabs rows about
      // to scroll off, shift moves the selection endpoint so the same rows
      // won't intersect again next frame. Capturing without shifting leaves
      // the endpoint in place, so the SAME viewport rows re-intersect every
      // frame and scrolledOffAbove grows without bound — getSelectedText
      // then returns ever-growing text on each re-copy. Keep capture inside
      // each shift branch so the pairing can't be broken by a new guard.
      if (this.selection.isDragging) {
        if (hasSelection(this.selection)) {
          captureScrolledRows(this.selection, this.frontFrame.screen, firstRow, lastRow, side, follow.screenRowOffset);
          // Record the viewport bounds for finishSelection's deferred
          // commit-time check: the in-flight drag never clears (a wheel
          // must not kill the gesture), so a drag that wheeled fully
          // off-edge is dropped when it ENDS, not while it is running.
          this.selection.dragBounds = { top: viewportTop, bottom: viewportBottom };
        }
        // allowClear=false: both ends clamp to the edge; the ghost guard
        // runs at release via dragBounds above.
        shiftSelectionForFollow(this.selection, shift, viewportTop, viewportBottom, false);
      } else if (
      // Flag-3 guard: the anchor check above only proves ONE endpoint is
      // on scrollbox content. A drag from row 3 (scrollbox) into the
      // footer at row 6, then release, leaves focus outside the viewport
      // — shiftSelectionForFollow would clamp it to viewportBottom,
      // teleporting the highlight from static footer into the scrollbox.
      // Symmetric check: require BOTH ends inside to translate. A
      // straddling selection falls through to NEITHER shift NOR capture:
      // the footer endpoint pins the selection, text scrolls away under
      // the highlight, and getSelectedText reads the CURRENT screen
      // contents — no accumulation. Both endpoints are text-anchored in
      // the active drag branch too, so a wheel cannot leave focus on the
      // old screen row.
      !this.selection.focus || this.selection.focus.row >= viewportTop && this.selection.focus.row <= viewportBottom) {
        if (hasSelection(this.selection)) {
          captureScrolledRows(this.selection, this.frontFrame.screen, firstRow, lastRow, side, follow.screenRowOffset);
        }
        const cleared = shiftSelectionForFollow(this.selection, shift, viewportTop, viewportBottom);
        // Auto-clear (both ends overshot an edge — off the top via
        // follow/wheel-down, off the bottom via wheel-up) must notify
        // React-land so useHasSelection re-renders and the footer
        // copy/escape hint disappears. notifySelectionChange() would
        // recurse into onRender; fire the listeners directly — they
        // schedule a React update for LATER, they don't re-enter this
        // frame. (#185 self-heal guard: same as selection.notify.)
        if (cleared) for (const cb of this.selectionListeners) callWithUpdateOverflowGuard('selection.notify', cb);
      }
    }

    // Selection overlay: invert cell styles in the screen buffer itself,
    // so the diff picks up selection as ordinary cell changes and
    // LogUpdate remains a pure diff engine.
    //
    // Full-screen damage (PR #20120) is a correctness backstop for the
    // sibling-resize bleed: when flexbox siblings resize between frames
    // (spinner appears → bottom grows → scrollbox shrinks), the
    // cached-clear + clip-and-cull + setCellAt damage union can miss
    // transition cells at the boundary. But that only happens when layout
    // actually SHIFTS — didLayoutShift() tracks exactly this (any node's
    // cached yoga position/size differs from current, or a child was
    // removed). Steady-state frames (spinner rotate, clock tick, text
    // stream into fixed-height box) don't shift layout, so normal damage
    // bounds are correct and diffEach only compares the damaged region.
    //
    // Selection also requires full damage: overlay writes via setCellStyleId
    // which doesn't track damage, and prev-frame overlay cells need to be
    // compared when selection moves/clears. prevFrameContaminated covers
    // the frame-after-selection-clears case.
    let selActive = false;
    let hlActive = false;
    if (this.altScreenActive) {
      selActive = hasSelection(this.selection);
      if (selActive) {
        applySelectionOverlay(frame.screen, this.selection, this.stylePool);
      }
      // Scan-highlight: inverse on ALL visible matches (less/vim style).
      // Position-highlight (below) overlays CURRENT (yellow) on top.
      hlActive = applySearchHighlight(frame.screen, this.searchHighlightQuery, this.stylePool);
      // Position-based CURRENT: write yellow at positions[currentIdx] +
      // rowOffset. No scanning — positions came from a prior scan when
      // the message first mounted. Message-relative + rowOffset = screen.
      if (this.searchPositions) {
        const sp = this.searchPositions;
        const posApplied = applyPositionedHighlight(frame.screen, this.stylePool, sp.positions, sp.rowOffset, sp.currentIdx);
        hlActive = hlActive || posApplied;
      }
    }

    // Full-damage backstop: applies on BOTH alt-screen and main-screen.
    // Layout shifts (spinner appears, status line resizes) can leave stale
    // cells at sibling boundaries that per-node damage tracking misses.
    // Selection/highlight overlays write via setCellStyleId which doesn't
    // track damage. prevFrameContaminated covers the cleanup frame.
    if (didLayoutShift() || selActive || hlActive || this.prevFrameContaminated) {
      frame.screen.damage = {
        x: 0,
        y: 0,
        width: frame.screen.width,
        height: frame.screen.height
      };
    }

    // Alt-screen: anchor the physical cursor to (0,0) before every diff.
    // All cursor moves in log-update are RELATIVE to prev.cursor; if tmux
    // (or any emulator) perturbs the physical cursor out-of-band (status
    // bar refresh, pane redraw, Cmd+K wipe), the relative moves drift and
    // content creeps up 1 row/frame. CSI H resets the physical cursor;
    // passing prev.cursor=(0,0) makes the diff compute from the same spot.
    // Self-healing against any external cursor manipulation. Main-screen
    // can't do this — cursor.y tracks scrollback rows CSI H can't reach.
    // The CSI H write is deferred until after the diff is computed so we
    // can skip it for empty diffs (no writes → physical cursor unused).
    let prevFrame = this.frontFrame;
    const sixelFrame = sixelActive
      ? this.sixelGraphicsManager.reconcile(frame.screen, prevFrame.screen, frame.images)
      : { erase: '', baseline: prevFrame.screen };
    if (sixelFrame.baseline !== prevFrame.screen) prevFrame = { ...prevFrame, screen: sixelFrame.baseline };
    if (this.altScreenActive) {
      prevFrame = {
        ...prevFrame,
        cursor: ALT_SCREEN_ANCHOR_CURSOR
      };
    }
    const tDiff = performance.now();
    const diff = this.log.render(prevFrame, frame, this.altScreenActive,
    // DECSTBM needs BSU/ESU atomicity — without it the outer terminal
    // renders the scrolled-but-not-yet-repainted intermediate state.
    // tmux is the main case (re-emits DECSTBM with its own timing and
    // doesn't implement DEC 2026, so SYNC_OUTPUT_SUPPORTED is false).
    // JediTerm is separately excluded in isDecstbmSafe(): its DECSTBM
    // implementation deviates from xterm and garbles scrolling content.
    isDecstbmSafe() && !(sixelActive && (this.sixelGraphicsManager.hasImage || sixelFrame.erase !== '')));
    const diffMs = performance.now() - tDiff;
    // Swap buffers
    this.backFrame = this.frontFrame;
    this.frontFrame = frame;

    // Periodically reset char/hyperlink pools to prevent unbounded growth
    // during long sessions. 5 minutes is infrequent enough that the O(cells)
    // migration cost is negligible. Reuses renderStart to avoid extra clock call.
    if (renderStart - this.lastPoolResetTime > 5 * 60 * 1000) {
      this.resetPools();
      this.lastPoolResetTime = renderStart;
    }
    const flickers: FrameEvent['flickers'] = [];
    for (const patch of diff) {
      if (patch.type === 'clearTerminal') {
        flickers.push({
          desiredHeight: frame.screen.height,
          availableHeight: frame.viewport.height,
          reason: patch.reason
        });
        if (isDebugRepaintsEnabled() && patch.debug) {
          const chain = dom.findOwnerChainAtRow(this.rootNode, patch.debug.triggerY);
          logForDebugging(`[REPAINT] full reset · ${patch.reason} · row ${patch.debug.triggerY}\n` + `  prev: "${patch.debug.prevLine}"\n` + `  next: "${patch.debug.nextLine}"\n` + `  culprit: ${chain.length ? chain.join(' < ') : '(no owner chain captured)'}`, {
            level: 'warn'
          });
        }
      }
    }
    const tOptimize = performance.now();
    if (flickers.length > 0 || this.needsEraseBeforePaint) {
      this.kittyGraphicsManager.invalidateAll();
      this.sixelGraphicsManager.invalidateAll();
    }
    const optimized = optimize(diff);
    const optimizeMs = performance.now() - tOptimize;
    const graphicsOutput =
      this.altScreenActive && this.kittyGraphicsSupported
        ? this.kittyGraphicsManager.reconcile(frame.images ?? [])
        : sixelActive ? this.sixelGraphicsManager.paint(optimized) : '';
    const hasDiff = optimized.length > 0 || graphicsOutput !== '' || sixelFrame.erase !== '';
    if (this.altScreenActive && hasDiff) {
      // Prepend CSI H to anchor the physical cursor to (0,0) so
      // log-update's relative moves compute from a known spot (self-healing
      // against out-of-band cursor drift, see the ALT_SCREEN_ANCHOR_CURSOR
      // comment above). Append CSI row;1 H to park the cursor at the bottom
      // row (where the prompt input is) — without this, the cursor ends
      // wherever the last diff write landed (a different row every frame),
      // making iTerm2's cursor guide flicker as it chases the cursor.
      // BSU/ESU protects content atomicity but iTerm2's guide tracks cursor
      // position independently. Parking at bottom (not 0,0) keeps the guide
      // where the user's attention is.
      //
      // After resize, prepend ERASE_SCREEN too. The diff only writes cells
      // that changed; cells where new=blank and prev-buffer=blank get skipped
      // — but the physical terminal still has stale content there (shorter
      // lines at new width leave old-width text tails visible). ERASE inside
      // BSU/ESU is atomic: old content stays visible until the whole
      // erase+paint lands, then swaps in one go. Writing ERASE_SCREEN
      // synchronously in handleResize would blank the screen for the ~80ms
      // render() takes.
      if (this.needsEraseBeforePaint) {
        this.needsEraseBeforePaint = false;
        optimized.unshift(ERASE_THEN_HOME_PATCH);
      } else {
        optimized.unshift(CURSOR_HOME_PATCH);
      }
      if (sixelFrame.erase !== '') optimized.unshift({ type: 'stdout', content: sixelFrame.erase });
      if (graphicsOutput !== '') {
        optimized.push({ type: 'stdout', content: graphicsOutput });
      }
      optimized.push(this.altScreenParkPatch);
    }

    // Native cursor positioning: park the terminal cursor at the declared
    // position so IME preedit text renders inline and screen readers /
    // magnifiers can follow the input. nodeCache holds the absolute screen
    // rect populated by renderNodeToOutput this frame (including scrollTop
    // translation) — if the declared node didn't render (stale declaration
    // after remount, or scrolled out of view), it won't be in the cache
    // and no move is emitted.
    const decl = this.cursorDeclaration;
    const rect = decl !== null ? nodeCache.get(decl.node) : undefined;
    // Keep the declared target in the same full-frame coordinate system as
    // frame.cursor and displayCursor. Main-screen cursor moves are relative:
    // subtracting the scrollback height from target alone makes the physical
    // cursor climb that height on every park/preamble cycle, so later streaming
    // diffs overwrite thinking, tool, and assistant rows. The terminal maps the
    // full-frame relative move onto its viewport/scrollback position itself.
    const target = decl !== null && rect !== undefined ? {
      x: rect.x + decl.relativeX,
      y: rect.y + decl.relativeY
    } : null;
    const parked = this.displayCursor;
    // Diagnostics: the resolved park target per frame (DSH_TUI_DEBUG only).
    // ConPTY's readback drops trailing cursor moves, so pty probes can't
    // observe the park position — this trace is the ground truth of where
    // the native cursor is being told to go.
    logForDebugging(`park target=${target !== null ? target.x + ',' + target.y : 'null'} decl=${decl !== null} rect=${rect !== undefined} moved=${target !== null && (parked === null || parked.x !== target.x || parked.y !== target.y)}`);

    // Preserve the empty-diff zero-write fast path: skip all cursor writes
    // when nothing rendered AND the park target is unchanged.
    const targetMoved = target !== null && (parked === null || parked.x !== target.x || parked.y !== target.y);
    if (hasDiff || targetMoved || target === null && parked !== null) {
      // Main-screen preamble: log-update's relative moves assume the
      // physical cursor is at prevFrame.cursor. If last frame parked it
      // elsewhere, move back before the diff runs. Alt-screen's CSI H
      // already resets to (0,0) so no preamble needed.
      if (parked !== null && !this.altScreenActive && hasDiff) {
        const pdx = prevFrame.cursor.x - parked.x;
        const pdy = prevFrame.cursor.y - parked.y;
        if (pdx !== 0 || pdy !== 0) {
          optimized.unshift({
            type: 'stdout',
            content: cursorMove(pdx, pdy)
          });
        }
      }
      if (target !== null) {
        if (this.altScreenActive) {
          // Absolute CUP (1-indexed); next frame's CSI H resets regardless.
          // Emitted after altScreenParkPatch so the declared position wins.
          const row = Math.min(Math.max(target.y + 1, 1), terminalRows);
          const col = Math.min(Math.max(target.x + 1, 1), terminalWidth);
          optimized.push({
            type: 'stdout',
            content: cursorPosition(row, col)
          });
        } else {
          // After the diff (or preamble), cursor is at frame.cursor. If no
          // diff AND previously parked, it's still at the old park position
          // (log-update wrote nothing). Otherwise it's at frame.cursor.
          const from = !hasDiff && parked !== null ? parked : {
            x: frame.cursor.x,
            y: frame.cursor.y
          };
          const dx = target.x - from.x;
          const dy = target.y - from.y;
          if (dx !== 0 || dy !== 0) {
            optimized.push({
              type: 'stdout',
              content: cursorMove(dx, dy)
            });
          }
        }
        this.displayCursor = target;
      } else {
        // Declaration cleared (input blur, unmount). Restore physical cursor
        // to frame.cursor before forgetting the park position — otherwise
        // displayCursor=null lies about where the cursor is, and the NEXT
        // frame's preamble (or log-update's relative moves) computes from a
        // wrong spot. The preamble above handles hasDiff; this handles
        // !hasDiff (e.g. accessibility mode where blur doesn't change
        // renderedValue since invert is identity).
        if (parked !== null && !this.altScreenActive && !hasDiff) {
          const rdx = frame.cursor.x - parked.x;
          const rdy = frame.cursor.y - parked.y;
          if (rdx !== 0 || rdy !== 0) {
            optimized.push({
              type: 'stdout',
              content: cursorMove(rdx, rdy)
            });
          }
        }
        this.displayCursor = null;
      }
    }
    const tWrite = performance.now();
    writeDiffToTerminal(this.terminal, optimized, this.altScreenActive && !SYNC_OUTPUT_SUPPORTED);
    const writeMs = performance.now() - tWrite;
    // One frame reached the terminal. Components holding a widened mount
    // window until its content is actually flushed (MessageList's paint
    // expansion hold) key off this tick — a commit can be superseded before
    // its frame flushes, so "mounted" alone must never unlock tightening.
    noteTerminalFlush();

    // Update blit safety for the NEXT frame. The frame just rendered
    // becomes frontFrame (= next frame's prevScreen). If we applied the
    // selection overlay, that buffer has inverted cells. selActive/hlActive
    // are only ever true in alt-screen; in main-screen this is false→false.
    // poisonNextFrame: an absolute overlay shrank/moved this frame and its
    // vacated cells were blitted stale — the next frame must render without
    // prevScreen to re-derive them from the tree.
    this.prevFrameContaminated = selActive || hlActive || frame.poisonNextFrame === true;

    // A ScrollBox has pendingScrollDelta left to drain — schedule the next
    // frame via scheduleDrain (cadence + pty backpressure gate, see there).
    // MUST NOT call this.scheduleRender() here: we're inside a trailing-edge
    // throttle invocation, timerId is undefined, and lodash's debounce sees
    // timeSinceLastCall >= wait (last call was at the start of this window)
    // → leadingEdge fires IMMEDIATELY → double render ~0.1ms apart → jank.
    // If a wheel event or immediate render arrives first, renderNow cancels
    // this timer — no double.
    if (frame.scrollDrainPending || frame.poisonNextFrame === true) {
      noteFrameCause(frame.scrollDrainPending ? 'scroll-drain' : 'overlay-shrink');
      this.scheduleDrain();
    }
    const yogaMs = getLastYogaMs();
    const commitMs = getLastCommitMs();
    const yc = this.lastYogaCounters;
    // Reset so drain-only frames (no React commit) don't repeat stale values.
    resetProfileCounters();
    this.lastYogaCounters = {
      ms: 0,
      visited: 0,
      measured: 0,
      cacheHits: 0,
      live: 0
    };
    endGeometryFrame(performance.now() - renderStart);
    this.options.onFrame?.({
      durationMs: performance.now() - renderStart,
      phases: {
        renderer: rendererMs,
        diff: diffMs,
        optimize: optimizeMs,
        write: writeMs,
        patches: diff.length,
        yoga: yogaMs,
        commit: commitMs,
        yogaVisited: yc.visited,
        yogaMeasured: yc.measured,
        yogaCacheHits: yc.cacheHits,
        yogaLive: yc.live
      },
      flickers
    });
  }
  pause(): void {
    // Flush pending React updates and render before pausing.
    // @ts-ignore -- runtime/type-definition mismatch: flushSyncFromReconciler exists in react-reconciler 0.31 but not in @types/react-reconciler
    reconciler.flushSyncFromReconciler();
    this.renderNow();
    this.isPaused = true;
    this.notifyTerminalImagesChange();
  }
  resume(): void {
    this.isPaused = false;
    this.notifyTerminalImagesChange();
    this.renderNow();
    if (
      this.terminalCellMetricsRefreshPending &&
      !this.terminalCellMetricsInFlight &&
      !this.terminalQueriesSuspended
    ) {
      this.terminalCellMetricsRefreshPending = false;
      this.refreshTerminalCellMetrics();
    }
  }

  /**
   * Reset frame buffers so the next render writes the full screen from scratch.
   * Call this before resume() when the terminal content has been corrupted by
   * an external process (e.g. tmux, shell, full-screen TUI).
   */
  repaint(): void {
    this.frontFrame = emptyFrame(this.frontFrame.viewport.height, this.frontFrame.viewport.width, this.stylePool, this.charPool, this.hyperlinkPool);
    this.backFrame = emptyFrame(this.backFrame.viewport.height, this.backFrame.viewport.width, this.stylePool, this.charPool, this.hyperlinkPool);
    this.log.reset();
    // Physical cursor position is unknown after external terminal corruption.
    // Clear displayCursor so the cursor preamble doesn't emit a stale
    // relative move from where we last parked it.
    this.displayCursor = null;
  }

  /**
   * Clear the physical terminal and force a full redraw.
   *
   * The traditional readline ctrl+l — clears the visible screen and
   * redraws the current content. Also the recovery path when the terminal
   * was cleared externally (macOS Cmd+K) and Ink's diff engine thinks
   * unchanged cells don't need repainting. Scrollback is preserved.
   */
  forceRedraw(): void {
    if (!this.options.stdout.isTTY || this.isUnmounted || this.isPaused) return;
    // SGR reset first — ERASE_SCREEN fills with the current background
    // (BCE); ctrl+l is exactly the recovery a user reaches for when the
    // screen is already wrecked (e.g. a stuck colored SGR after a torn
    // frame), so the clear must not repaint the wreckage color.
    this.options.stdout.write(SGR_RESET + ERASE_SCREEN + CURSOR_HOME);
    if (this.altScreenActive) {
      this.resetFramesForAltScreen();
    } else {
      this.repaint();
      // repaint() resets frontFrame to 0×0. Without this flag the next
      // frame's blit optimization copies from that empty screen and the
      // diff sees no content. onRender resets the flag at frame end.
      this.prevFrameContaminated = true;
    }
    this.renderNow();
  }

  /**
   * Establish a genuinely fresh terminal page: clear both the visible screen
   * and native scrollback, reset frame correspondence, then redraw the current
   * React tree. This is intentionally stronger than Ctrl+L/forceRedraw(),
   * which preserves history; use it only at a destructive UI boundary such as
   * `/new`, where showing the previous conversation above the new session is
   * misleading.
   */
  clearScrollbackAndRedraw(): void {
    if (!this.options.stdout.isTTY || this.isUnmounted || this.isPaused) return;
    // Keep 3J outside synchronized output. Windows Terminal can relocate the
    // viewport when erase-buffer commands execute inside BSU/ESU.
    this.options.stdout.write(
      SGR_RESET + ERASE_SCROLLBACK + ERASE_SCREEN + CURSOR_HOME,
    );
    if (this.altScreenActive) {
      this.resetFramesForAltScreen();
    } else {
      this.repaint();
      this.prevFrameContaminated = true;
    }
    this.renderNow();
  }

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
  invalidatePrevFrame(): void {
    this.prevFrameContaminated = true;
  }

  /**
   * Called by the <AlternateScreen> component on mount/unmount.
   * Controls cursor.y clamping in the renderer and gates alt-screen-aware
   * behavior in SIGCONT/resize/unmount handlers. The first alt-screen frame
   * redraws from blank; exit restores the saved main frame for a physical-
   * screen-matched diff, with repaint as the resize fallback.
   */
  setAltScreenActive(active: boolean, mouseTracking = false): void {
    if (this.altScreenActive === active) return;
    const resetOldPointerContext = (): void => {
      // Fire leave handlers before dropping the set — a bare clear strands
      // old rows with hovered=true. resetPointerState also emits dragend for
      // a captured drag before its geometry disappears.
      clearHovered(this.hoveredNodes);
      this.app?.resetPointerState();
      invalidateNoInterestRect();
    };
    // Leaving must settle dragend WHILE the dispatch gate is still active;
    // flipping altScreenActive first would silently drop the cleanup event.
    if (!active) {
      resetOldPointerContext();
      const deleteImages = this.kittyGraphicsManager.deleteAll() + this.sixelGraphicsManager.clear();
      if (deleteImages !== '') this.options.stdout.write(deleteImages);
    }
    this.altScreenActive = active;
    this.notifyTerminalImagesChange();
    this.altScreenMouseTracking = active && mouseTracking;
    // Entering has no old alt-screen drag to notify, but the main-screen
    // hover/click geometry still needs to be cleared after the gate flips.
    if (active) resetOldPointerContext();
    if (active) {
      this.mainScreenFrameState = {
        frontFrame: this.frontFrame,
        displayCursor: this.displayCursor,
        columns: this.terminalColumns,
        rows: this.terminalRows
      };
      this.resetFramesForAltScreen();
      // Alt-screen reactivation is a safe boundary: the component just
      // remounted, so no gesture can be in flight. Drain any deferred
      // re-entry confirmed while the alt screen was inactive.
      this.drainAltScreenReentry();
    } else {
      const saved = this.mainScreenFrameState;
      this.mainScreenFrameState = null;
      if (saved && saved.columns === this.terminalColumns && saved.rows === this.terminalRows) {
        this.frontFrame = saved.frontFrame;
        this.displayCursor = saved.displayCursor;
        this.log.reset();
        // The main React subtree may have changed while the alternate screen
        // was mounted. Disable blitting once, but keep the restored frame as
        // the diff baseline that matches the terminal's physical contents.
        this.prevFrameContaminated = true;
      } else {
        // A resize reflows the terminal's saved main buffer, so the old frame
        // is no longer a trustworthy physical baseline.
        this.repaint();
      }
    }
  }
  get isAltScreenActive(): boolean {
    return this.altScreenActive;
  }

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
  reassertTerminalModes = (includeAltScreen = false): void => {
    if (!this.options.stdout.isTTY) return;
    // Shutdown latch: the >5s idle-gap trigger (or an event-loop stall
    // detector firing during the dispose window) must not re-assert mouse
    // tracking after the exit cleanup disabled it (issue #522).
    if (this.isUnmounted) return;
    // Don't touch the terminal during an editor handoff — re-enabling kitty
    // keyboard here would undo enterAlternateScreen's disable and nano would
    // start seeing CSI-u sequences again.
    if (this.isPaused) return;
    // Extended keys — re-assert if enabled (App.tsx enables these on
    // allowlisted terminals at raw-mode entry; a terminal reset clears them).
    // Pop-before-push keeps Kitty stack depth at 1 instead of accumulating
    // on each call. win32-input-mode is a plain DEC private mode (no stack),
    // so a bare re-set suffices.
    if (supportsWin32InputMode()) {
      this.options.stdout.write(ENABLE_WIN32_INPUT_MODE);
    } else if (supportsExtendedKeys()) {
      this.options.stdout.write(DISABLE_KITTY_KEYBOARD + ENABLE_KITTY_KEYBOARD + ENABLE_MODIFY_OTHER_KEYS);
    }
    if (!this.altScreenActive) {
      // Main-screen self-heal: alt-screen re-anchors the cursor with CSI H
      // every frame, but inline diffs are purely relative — a third-party
      // tty write during the idle gap (an MCP subprocess's stderr, issue
      // #17) shifts every subsequent write by N rows and nothing detects
      // it after the fact (see requestViewportReanchor). The same
      // gap-then-keypress signal that re-asserts DEC modes is the natural
      // moment to blindly re-sync: repaint the viewport from the physical
      // cursor position. Idempotent when nothing drifted — the user sees
      // no change, at O(viewport) bytes once per >5s idle gap.
      this.log.requestViewportReanchor();
      this.renderNow();
      return;
    }
    // Mouse tracking + alt-screen health — the probe re-asserts mouse
    // blindly (idempotent) and re-enters alt only if the terminal answers
    // DECRPM with "1049 reset".
    this.probeAltScreenHealth();
    // Drain any deferred re-entry: a >5s stdin gap is a safe boundary (no
    // button can be held — the terminal would have sent motion events), and
    // resume is exactly the moment a confirmed 1049 loss should heal.
    this.drainAltScreenReentry();
    // Alt-screen re-entry — destructive (ERASE_SCREEN). Only for callers that
    // have a strong signal the terminal actually dropped mode 1049.
    if (includeAltScreen) {
      this.reenterAltScreen();
    }
  };

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
  detachForShutdown(): void {
    this.isUnmounted = true;
    this.terminalImageListeners.clear();
    // Cancel any pending throttled render so it doesn't fire between
    // cleanupTerminalModes() and process.exit() and write to main screen.
    this.scheduleRender.cancel?.();
    if (this.drainTimer !== null) {
      clearTimeout(this.drainTimer);
      this.drainTimer = null;
    }
    if (this.terminalQueryResumeTimer !== null) {
      clearTimeout(this.terminalQueryResumeTimer);
      this.terminalQueryResumeTimer = null;
    }
    // Delete Kitty placements before terminal mode cleanup. This write uses
    // the renderer's own ordered stream, matching the rest of this shutdown
    // path and leaving unmount's synchronous cleanup safely idempotent.
    const deleteImages = this.kittyGraphicsManager.deleteAll() + this.sixelGraphicsManager.dispose();
    if (deleteImages !== '' && this.options.stdout.isTTY) {
      this.options.stdout.write(deleteImages);
    }
    this.app?.detachForShutdown();
    // Shutdown bypasses the normal unmount path, so release the process and
    // stdout listeners here as well. Otherwise a SIGCONT or resize arriving
    // while an updater is running can re-enter the alternate screen or render
    // through this detached instance after terminal cleanup has completed.
    this.unsubscribeTTYHandlers?.();
    this.unsubscribeExit();
    // unmount() early-returns on isUnmounted above, so its instances.delete
    // never runs — a detached instance would stay in the map and a later
    // instances.get(stdout) lookup (Chat's reanchorViewport plumbing) could
    // hand out a dead renderer. Remove the mapping here too.
    instances.delete(this.options.stdout);
    // `detachForShutdown()` deliberately makes later `unmount()` calls a
    // no-op, so release process-level output patches here rather than relying
    // on unmount() to do it. The shutdown continuation may run an updater
    // (or report its failure) after this point; leaving stderr intercepted
    // would silently route those messages to the debug log instead of the
    // terminal.
    if (typeof this.restoreConsole === 'function') {
      this.restoreConsole();
    }
    this.restoreStderr?.();
    // Restore stdin from raw mode. unmount() used to do this via React
    // unmount (App.componentWillUnmount → handleSetRawMode(false)) but we're
    // short-circuiting that path. Must use this.options.stdin — NOT
    // process.stdin — because getStdinOverride() may have opened /dev/tty
    // when stdin is piped.
    const stdin = this.options.stdin as NodeJS.ReadStream & {
      isRaw?: boolean;
      setRawMode?: (m: boolean) => void;
    };
    this.drainStdin();
    if (stdin.isTTY && stdin.isRaw && stdin.setRawMode) {
      try {
        stdin.setRawMode(false);
      } catch {
        // The TTY may have been revoked (for example after an SSH
        // disconnect). Shutdown must continue even if raw-mode restoration
        // is no longer possible.
      }
    }
  }

  /**
   * Fully detach stdin before handing the terminal to a child process that
   * inherits it (the /update restart). `detachForShutdown()` restores
   * cooked mode but leaves the App's 'readable' pump attached — ordinary
   * exits don't care because the process dies right after, but a parent
   * that lingers waiting on the child keeps a libuv read pending on the
   * console and races the child for every keypress: the restarted TUI
   * sees dropped or entirely swallowed input (issues #284/#307). Remove
   * the listeners and pause the pump so the child is the sole reader.
   */
  detachStdinForHandoff(): void {
    const stdin = this.options.stdin as NodeJS.ReadStream;
    try {
      this.drainStdin();
    } catch {
      // A destroyed stream must not block the handoff.
    }
    stdin.removeAllListeners('readable');
    stdin.removeAllListeners('data');
    try {
      stdin.pause();
    } catch {
      // Same destroyed-stream tolerance as above.
    }
    try {
      stdin.unref();
    } catch {
      // unref on a closed stream can throw on some Node versions.
    }
  }

  /** @see drainStdin */
  drainStdin(): void {
    drainStdin(this.options.stdin);
  }

  /**
   * Self-heal after a terminal-side mode reset. Windows conpty drops DEC
   * private modes on DPI changes, window moves between monitors and renderer
   * restarts — the user sees the app "exit fullscreen" with a dead mouse
   * while altScreenActive still claims we are in alt. Two layers:
   *
   * 1. Blind, idempotent mouse-tracking re-assert (covers the mode reset
   *    without a round trip; ~30 bytes).
   * 2. DECRQM probe of mode 1049. Re-entry (destructive: ERASE) happens
   *    ONLY on a positive "reset" answer, so iTerm2's
   *    enter-clears-when-already-in-alt quirk can never fire on a healthy
   *    screen, and terminals that ignore DECRQM stay inert.
   *
   * Called from every interaction dispatch (click/hover/wheel/key) plus the
   * focus/resize/stdin-gap triggers. The 250ms throttle keeps the round
   * trip bounded while active use is going on — a dropped 1049 heals on
   * the FIRST interaction after the drop instead of waiting for a focus
   * event or a >5s idle gap (mouse motion keeps lastStdinTime fresh, so
   * the gap path never fires during active use — the exact pattern that
   * left the app broken until the user gave up).
   */
  private lastHealthProbeAt = 0;
  /**
   * True while a mouse button is held (press seen, no release/reset yet).
   * Set by App via setPointerGestureActive. The health probe must not write
   * while a gesture is in flight: the blind ENABLE_MOUSE_TRACKING re-assert
   * mid-drag resets button tracking on some emulators (WezTerm, xterm.js
   * family), silently killing the gesture's motion stream, and a DECRQM
   * "1049 reset" reply resolving mid-drag would erase the screen under the
   * user's pointer.
   */
  private pointerGestureActive = false;
  /**
   * Protocol-candidate latch: an SGR mouse prefix is in flight (parser hold
   * or tokenizer incomplete buffer). Cleared by App on any complete event
   * (mouse or key), ordinary text, paste/response boundary, or the 1s hold
   * deadline. Distinct from pointerGestureActive: a split wheel report
   * resolves to a ParsedKey (no physical button), and a stale candidate
   * must not leave the probe permanently blocked.
   */
  private protocolCandidateActive = false;
  /**
   * Set when a DECRPM reply confirmed "1049 reset" while a gesture was
   * latched. The re-entry (ENTER_ALT_SCREEN + ERASE_SCREEN + mouse
   * re-assert) is destructive mid-drag — it erases the screen under the
   * user's pointer and resets button tracking — so it is deferred to the
   * gesture's end and drained by setPointerGestureActive(false).
   */
  private pendingAltScreenReentry = false;
  /**
   * Set when probeAltScreenHealth was blocked by an active gesture. The
   * probe is retried at the release tail (drainAltScreenReentry) with the
   * original caller's skipMouseReassert semantics.
   */
  private pendingProbeRequest: { skipMouseReassert?: boolean } | undefined = undefined;
  setPointerGestureActive = (active: boolean): void => {
    this.pointerGestureActive = active;
    // Do NOT drain pendingAltScreenReentry here: the gesture latch clears at
    // the START of release handling, but the destructive re-entry must wait
    // until the full release/click/drag tail completes (dispatchClick reads
    // frontFrame for cellIsBlank / getHyperlinkAt — reenterAltScreen resets
    // those frames synchronously). App calls drainAltScreenReentry() after
    // the release tail instead.
  };
  setProtocolCandidateActive = (active: boolean): void => {
    this.protocolCandidateActive = active;
  };
  /**
   * Execute a deferred alt-screen re-entry, if one was confirmed while a
   * gesture was latched. Called by App after the release tail completes.
   * Only clears the pending flag when the re-entry actually runs — a pause
   * or alt-screen exit during the gesture keeps the recovery signal alive
   * for the next safe boundary (resume, focus, or a later release).
   */
  drainAltScreenReentry = (): void => {
    if (!this.pendingAltScreenReentry) return;
    if (this.isUnmounted || this.isPaused || !this.altScreenActive) return;
    // Dual latch: never re-enter while a physical button is held OR while a
    // protocol candidate (split SGR prefix) is in flight. The destructive
    // re-entry (1049h + 2J + mouse DECSET) would erase the screen under the
    // user's pointer and reset button tracking mid-drag, or corrupt a
    // half-parsed report.
    if (this.pointerGestureActive || this.protocolCandidateActive) return;
    this.pendingAltScreenReentry = false;
    this.reenterAltScreen();
  };
  /**
   * Retry a health probe that was blocked by an active gesture. Called by
   * App after the release tail completes, with the original caller's
   * skipMouseReassert semantics preserved. The request is cleared ONLY
   * after the probe actually writes — a throttle hit keeps it pending and
   * schedules a retry once the 250ms window expires.
   */
  drainPendingProbe = (): void => {
    const req = this.pendingProbeRequest;
    if (!req) return;
    // Dual latch: never probe while a physical button is held OR while a
    // protocol candidate is in flight — the probe's DECSET/DECRQM writes
    // would corrupt the stream.
    if (this.pointerGestureActive || this.protocolCandidateActive) return;
    const now = Date.now();
    const throttleLeft = 250 - (now - this.lastHealthProbeAt);
    if (throttleLeft > 0) {
      // Still inside the throttle window: keep the request pending and
      // schedule the retry for when the window closes. The timer is
      // best-effort — a later drain (focus, release, resume) may fire
      // first; the guard inside probeAltScreenHealth makes a duplicate
      // harmless.
      setTimeout(() => this.drainPendingProbe(), throttleLeft);
      return;
    }
    this.pendingProbeRequest = undefined;
    this.probeAltScreenHealth(req);
  };
  /**
   * Combined drain for the release tail: re-entry first (destructive),
   * then the blocked probe retry (may discover a new 1049 loss and
   * schedule the NEXT re-entry).
   */
  drainReleaseTail = (): void => {
    this.drainAltScreenReentry();
    this.drainPendingProbe();
  };
  probeAltScreenHealth = (options?: { skipMouseReassert?: boolean }): void => {
    // Shutdown latch: during the dispose window after detachForShutdown
    // (up to the 5s fallback exit) stray input, focus, resize or a pending
    // DECRPM reply would otherwise re-write ENABLE_MOUSE_TRACKING AFTER the
    // exit cleanup's DISABLE_MOUSE_TRACKING — the mouse-reporting residue
    // the shell then echoes as SGR garbage (issue #522). isUnmounted is set
    // by detachForShutdown() before any cleanup sequence is written.
    if (this.isUnmounted) return;
    // Dual latch: never write while a physical button is held OR while a
    // protocol candidate (split SGR prefix) is in flight. The physical latch
    // covers press→release; the candidate latch covers the window between
    // the first byte of a report and its completion — a DECSET re-assert
    // there corrupts the stream mid-parse.
    if (this.pointerGestureActive || this.protocolCandidateActive) {
      this.pendingProbeRequest = { ...options };
      return;
    }
    const now = Date.now();
    if (now - this.lastHealthProbeAt < 250) return;
    this.lastHealthProbeAt = now;
    if (!this.options.stdout.isTTY || this.isPaused || !this.altScreenActive) return;
    // Mouse-driven callers pass skipMouseReassert: the event that triggered
    // the probe already proves tracking is alive, so the blind DECSET
    // re-assert is pure risk near gestures — only the 1049 query below is
    // worth sending (conpty can drop 1049 while mouse tracking survives;
    // without a mouse-path probe a mouse-only user never recovers, since
    // mouse input keeps lastStdinTime fresh and starves the >5s gap path).
    if (this.altScreenMouseTracking && !options?.skipMouseReassert) {
      this.options.stdout.write(ENABLE_MOUSE_TRACKING);
    }
    const querier = this.app?.querier;
    if (querier === undefined) return;
    // macOS Terminal.app prints the trailing `p` of `CSI ? 1049 $ p` as
    // literal text instead of ignoring the unsupported query, leaking a
    // visible character at the cursor on every probe. The blind
    // mouse-tracking re-assert above still runs there — only the round trip
    // is skipped, which costs nothing: Terminal.app never answered it.
    if (!supportsDecrqmProbe()) return;
    void Promise.all([querier.send(decrqm(1049)), querier.flush()]).then(([reply]) => {
      if (this.isUnmounted || this.isPaused || this.terminalQueriesSuspended) return;
      // DECRPM status: 1/3 = set, 2/4 = reset, 0/undefined = unknown.
      // Heal only on a POSITIVE reset — an unanswered probe must not
      // trigger the destructive re-entry.
      if (reply === undefined || (reply.status !== 2 && reply.status !== 4)) return;
      // The reply resolves asynchronously: focus/keyboard/resize issued the
      // query, but a mouse press may have latched a gesture since (or a
      // protocol candidate may be in flight). Re-entering now would erase
      // the screen under the user's pointer and reset button tracking
      // mid-drag — defer to the gesture's end instead.
      if (this.pointerGestureActive || this.protocolCandidateActive) {
        this.pendingAltScreenReentry = true;
        return;
      }
      // Same re-check for the wider world: the probe ran with alt-screen
      // active, but an exit or editor handoff may have landed meanwhile.
      if (this.isUnmounted || this.isPaused || !this.altScreenActive) return;
      this.reenterAltScreen();
    }).catch(() => {
      /* probe is best-effort; the next trigger retries */
    });
  };

  /** Refocus = first observable moment after a conpty-side mode reset. */
  handleTerminalFocusProbe = (focused: boolean): void => {
    if (focused) {
      this.probeAltScreenHealth();
      // Refocus is a safe boundary: the OS delivered the focus event, so no
      // button can be held (a held button would have generated motion or a
      // release first). Drain any deferred re-entry confirmed while the
      // window was unfocused.
      this.drainAltScreenReentry();
    }
  };

  private notifyTerminalImagesChange(): void {
    // AlternateScreen changes modes in an insertion effect. Notify React
    // after that commit, when scheduling a subscriber update is safe.
    queueMicrotask(() => {
      for (const listener of this.terminalImageListeners) listener();
    });
  }

  /** Probe on image demand, before lazy consumers need to decode a source. */
  private maybeProbeKittyGraphics(
    placements: readonly TerminalImagePlacement[],
  ): void {
    if (
      (placements.length === 0 && this.terminalImageRequests === 0) ||
      this.isUnmounted ||
      this.kittyGraphicsProbeStarted ||
      this.options.terminalImages === false ||
      !this.altScreenActive ||
      this.isPaused ||
      this.terminalQueriesSuspended ||
      !this.options.stdout.isTTY ||
      process.env.TMUX !== undefined ||
      process.env.STY !== undefined ||
      isEnvTruthy(process.env.DSH_TUI_ACCESSIBILITY) ||
      isEnvTruthy(process.env.DSH_TUI_DISABLE_TERMINAL_IMAGES)
      || process.env.DSH_TUI_IMAGE_PROTOCOL === 'none'
    ) {
      return;
    }
    const querier = this.app?.querier;
    if (querier === undefined) return;
    this.kittyGraphicsProbeStarted = true;
    const queryId = 31;
    const columns = this.terminalColumns;
    const rows = this.terminalRows;
    void Promise.all([
      querier.send(kittyGraphics(queryId)),
      querier.send(terminalCellSizePixels()),
      querier.send(terminalWindowSizePixels()),
      querier.flush({ attributes: true }),
    ])
      .then(async ([reply, cellPixels, windowPixels, attributes]) => {
        if (this.isUnmounted || this.isPaused || this.terminalQueriesSuspended) {
          return;
        }
        const protocol = selectTerminalImageProtocol(reply?.status, attributes?.params, process.env.DSH_TUI_IMAGE_PROTOCOL);
        if (protocol === 'none') return;
        if (protocol === 'sixel') {
          const [mode] = await Promise.all([querier.send(decrqm(80)), querier.flush()]);
          if (this.isUnmounted || this.isPaused || this.terminalQueriesSuspended) return;
          // A permanently set display mode cannot place a preview at CUP.
          if (mode?.status === 3) return;
          this.sixelGraphicsManager.setDisplayMode(mode?.status === 1);
        }
        this.kittyGraphicsSupported = protocol === 'kitty';
        this.sixelGraphicsSupported = protocol === 'sixel';
        this.notifyTerminalImagesChange();
        if (
          columns === this.terminalColumns &&
          rows === this.terminalRows
        ) {
          this.measuredImageCellSize = resolveTerminalCellSize(cellPixels, windowPixels, columns, rows);
          this.kittyGraphicsManager.setCellSize(
            this.measuredImageCellSize ??
              DEFAULT_TERMINAL_CELL_SIZE,
          );
          this.sixelGraphicsManager.setCellSize(
            this.measuredImageCellSize ?? DEFAULT_TERMINAL_CELL_SIZE,
          );
        } else {
          // The capability result is still valid, but its geometry snapshot
          // is not. Start one fresh metrics batch after this sentinel.
          this.refreshTerminalCellMetrics();
        }
        if (!this.altScreenActive) return;
        // The preceding frame painted text fallback cells. Force one complete
        // paint so image nodes replace those cells with blank backing before
        // their graphics placements are uploaded.
        dom.markTreeDirty(this.rootNode);
        this.prevFrameContaminated = true;
        this.scheduleRender();
      })
      .catch(() => {
        /* Capability detection is best-effort; fallback remains visible. */
      });
  }

  /** Refresh image pixel geometry after a resize, coalescing resize bursts. */
  private refreshTerminalCellMetrics(): void {
    if (
      (!this.kittyGraphicsSupported && !this.sixelGraphicsSupported) ||
      this.isUnmounted ||
      !this.options.stdout.isTTY
    ) {
      return;
    }
    if (this.isPaused || this.terminalQueriesSuspended) {
      this.terminalCellMetricsRefreshPending = true;
      return;
    }
    const querier = this.app?.querier;
    if (querier === undefined) return;
    if (this.terminalCellMetricsInFlight) {
      this.terminalCellMetricsRefreshPending = true;
      return;
    }

    this.terminalCellMetricsInFlight = true;
    this.terminalCellMetricsRefreshPending = false;
    const columns = this.terminalColumns;
    const rows = this.terminalRows;
    void Promise.all([
      querier.send(terminalCellSizePixels()),
      querier.send(terminalWindowSizePixels()),
      querier.flush(),
    ])
      .then(([cellPixels, windowPixels]) => {
        if (this.isUnmounted) return;
        if (this.isPaused || this.terminalQueriesSuspended) {
          this.terminalCellMetricsRefreshPending = true;
          return;
        }
        if (
          columns !== this.terminalColumns ||
          rows !== this.terminalRows
        ) {
          this.terminalCellMetricsRefreshPending = true;
          return;
        }
        const cellSize = resolveTerminalCellSize(
          cellPixels,
          windowPixels,
          columns,
          rows,
        );
        if (cellSize === undefined) return;
        if (this.measuredImageCellSize?.width !== cellSize.width || this.measuredImageCellSize?.height !== cellSize.height) {
          this.measuredImageCellSize = cellSize;
          this.notifyTerminalImagesChange();
        }
        const changed = this.kittyGraphicsManager.setCellSize(cellSize);
        const sixelChanged = this.sixelGraphicsManager.setCellSize(cellSize);
        if ((changed || sixelChanged) && this.altScreenActive) {
          dom.markTreeDirty(this.rootNode);
          this.scheduleRender();
        }
      })
      .catch(() => {
        /* Pixel geometry is best-effort; retain the last known value. */
      })
      .finally(() => {
        this.terminalCellMetricsInFlight = false;
        if (
          this.terminalCellMetricsRefreshPending &&
          !this.isPaused &&
          !this.terminalQueriesSuspended
        ) {
          this.terminalCellMetricsRefreshPending = false;
          this.refreshTerminalCellMetrics();
        }
      });
  }

  /** Reopen terminal queries only after late handoff replies are quarantined. */
  private resumeTerminalQueriesAfterHandoff(): void {
    if (this.terminalQueryResumeTimer !== null) {
      clearTimeout(this.terminalQueryResumeTimer);
    }
    this.terminalQueryResumeTimer = setTimeout(() => {
      this.terminalQueryResumeTimer = null;
      if (this.isUnmounted) return;
      this.app?.querier.resume();
      this.notifyTerminalImagesChange();
      this.app?.scheduleXtversionProbe();
      if (
        this.terminalCellMetricsRefreshPending &&
        !this.terminalCellMetricsInFlight
      ) {
        this.terminalCellMetricsRefreshPending = false;
        this.refreshTerminalCellMetrics();
      } else if (!this.kittyGraphicsSupported && !this.sixelGraphicsSupported) {
        this.scheduleRender();
      }
    }, TERMINAL_REPLY_QUARANTINE_MS);
  }

  private get terminalQueriesSuspended(): boolean {
    return this.app?.querier.isSuspended ?? false;
  }

  /**
   * Re-enter alt-screen, clear, home, re-enable mouse tracking, and reset
   * frame buffers so the next render repaints from scratch. Self-heal for
   * SIGCONT, resize, and stdin-gap/event-loop-stall (sleep/wake) — any of
   * which can leave the terminal in main-screen mode while altScreenActive
   * stays true. ENTER_ALT_SCREEN is a terminal-side no-op if already in alt.
   */
  private reenterAltScreen(): void {
    // Same shutdown latch as probeAltScreenHealth: a DECRPM reply resolving
    // after detachForShutdown (or a SIGCONT racing unmount) must not re-enter
    // the alt screen or re-enable mouse tracking past the exit cleanup
    // (issue #522).
    if (this.isUnmounted) return;
    this.options.stdout.write(ENTER_ALT_SCREEN + ERASE_SCREEN + CURSOR_HOME + (this.altScreenMouseTracking ? ENABLE_MOUSE_TRACKING : ''));
    this.resetFramesForAltScreen();
  }

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
  private resetFramesForAltScreen(): void {
    const rows = this.terminalRows;
    const cols = this.terminalColumns;
    const blank = (): Frame => ({
      screen: createScreen(cols, rows, this.stylePool, this.charPool, this.hyperlinkPool),
      viewport: {
        width: cols,
        height: rows + 1
      },
      cursor: {
        x: 0,
        y: 0,
        visible: true
      }
    });
    this.frontFrame = blank();
    this.backFrame = blank();
    this.log.reset();
    this.kittyGraphicsManager.invalidateAll();
    this.sixelGraphicsManager.invalidateAll();
    // Defense-in-depth: alt-screen skips the cursor preamble anyway (CSI H
    // resets), but a stale displayCursor would be misleading if we later
    // exit to main-screen without an intervening render.
    this.displayCursor = null;
    // Fresh frontFrame is blank rows×cols — blitting from it would copy
    // blanks over content. Next alt-screen frame must full-render.
    this.prevFrameContaminated = true;
  }

  /**
   * Copy the current selection to the clipboard without clearing the
   * highlight. Matches iTerm2's copy-on-select behavior where the selected
   * region stays visible after the automatic copy.
   */
  copySelectionNoClear(): string {
    if (!hasSelection(this.selection)) return '';
    const text = getSelectedText(this.selection, this.frontFrame.screen);
    if (text) {
      // Raw OSC 52, or DCS-passthrough-wrapped OSC 52 inside tmux (tmux
      // drops it silently unless allow-passthrough is on — no regression).
      void setClipboard(text).then(raw => {
        if (raw) this.writeRaw(raw);
      });
    }
    return text;
  }

  /**
   * Copy the current text selection to the system clipboard via OSC 52
   * and clear the selection. Returns the copied text (empty if no selection).
   */
  copySelection(): string {
    if (!hasSelection(this.selection)) return '';
    const text = this.copySelectionNoClear();
    clearSelection(this.selection);
    this.notifySelectionChange();
    return text;
  }

  /** Clear the current text selection without copying. */
  clearTextSelection(): void {
    if (!hasSelection(this.selection)) return;
    clearSelection(this.selection);
    this.notifySelectionChange();
  }

  /**
   * Set the search highlight query. Non-empty → all visible occurrences
   * are inverted (SGR 7) on the next frame; first one also underlined.
   * Empty → clears (prevFrameContaminated handles the frame after). Same
   * damage-tracking machinery as selection — setCellStyleId doesn't track
   * damage, so the overlay forces full-frame damage while active.
   */
  setSearchHighlight(query: string): void {
    if (this.searchHighlightQuery === query) return;
    this.searchHighlightQuery = query;
    this.scheduleRender();
  }

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
  scanElementSubtree(el: dom.DOMElement): MatchPosition[] {
    if (!this.searchHighlightQuery || !el.yogaNode) return [];
    const width = Math.ceil(el.yogaNode.getComputedWidth());
    const height = Math.ceil(el.yogaNode.getComputedHeight());
    if (width <= 0 || height <= 0) return [];
    // renderNodeToOutput adds el's OWN computedLeft/Top to offsetX/Y.
    // Passing -elLeft/-elTop nets to 0 → paints at (0,0) in our buffer.
    const elLeft = el.yogaNode.getComputedLeft();
    const elTop = el.yogaNode.getComputedTop();
    const screen = createScreen(width, height, this.stylePool, this.charPool, this.hyperlinkPool);
    const output = new Output({
      width,
      height,
      stylePool: this.stylePool,
      screen
    });
    renderNodeToOutput(el, output, {
      offsetX: -elLeft,
      offsetY: -elTop,
      prevScreen: undefined
    });
    const rendered = output.get();
    // renderNodeToOutput wrote our offset positions to nodeCache —
    // corrupts the main render (it'd blit from wrong coords). Mark the
    // subtree dirty so the next main render repaints + re-caches
    // correctly. One extra paint of this message, but correct > fast.
    dom.markDirty(el);
    const positions = scanPositions(rendered, this.searchHighlightQuery);
    logForDebugging(`scanElementSubtree: q='${this.searchHighlightQuery}' ` + `el=${width}x${height}@(${elLeft},${elTop}) n=${positions.length} ` + `[${positions.slice(0, 10).map(p => `${p.row}:${p.col}`).join(',')}` + `${positions.length > 10 ? ',…' : ''}]`);
    return positions;
  }

  /** Set the position-based highlight state. Every frame, writes CURRENT
   *  style at positions[currentIdx] + rowOffset. null clears. The scan-
   *  highlight (inverse on all matches) still runs — this overlays yellow
   *  on top. rowOffset changes as the user scrolls (= message's current
   *  screen-top); positions stay stable (message-relative). */
  setSearchPositions(state: {
    positions: MatchPosition[];
    rowOffset: number;
    currentIdx: number;
  } | null): void {
    this.searchPositions = state;
    this.scheduleRender();
  }

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
  /**
   * The colour a backdrop shade (`<Box backdrop="dim">`) fades explicit
   * colours toward — the terminal background from OSC 11, or black/white
   * by theme lightness when unknown. See StylePool.setShadeTarget.
   */
  setShadeTarget(rgb: { r: number; g: number; b: number } | null): void {
    this.stylePool.setShadeTarget(rgb);
  }

  setSelectionBgColor(color: string): void {
    // Wrap a NUL marker, then split on it to extract the open/close SGR.
    // colorize returns the input unchanged if the color string is bad —
    // no NUL-split then, so fall through to null (inverse fallback).
    const wrapped = colorize('\0', color, 'background');
    const nul = wrapped.indexOf('\0');
    if (nul <= 0 || nul === wrapped.length - 1) {
      this.stylePool.setSelectionBg(null);
      return;
    }
    this.stylePool.setSelectionBg({
      type: 'ansi',
      code: wrapped.slice(0, nul),
      endCode: wrapped.slice(nul + 1) // always \x1b[49m for bg
    });
    // No scheduleRender: this is called from a React effect that already
    // runs inside the render cycle, and the bg only matters once a
    // selection exists (which itself triggers a full-damage frame).
  }

  /**
   * Capture text from rows about to scroll out of the viewport during
   * drag-to-scroll. Must be called BEFORE the ScrollBox scrolls so the
   * screen buffer still holds the outgoing content. Accumulated into
   * the selection state and joined back in by getSelectedText.
   */
  captureScrolledRows(firstRow: number, lastRow: number, side: 'above' | 'below'): void {
    captureScrolledRows(this.selection, this.frontFrame.screen, firstRow, lastRow, side);
  }

  /**
   * Shift anchor AND focus by dRow, clamped to [minRow, maxRow]. Used by
   * keyboard scroll handlers (PgUp/PgDn etc.) so the highlight tracks the
   * content instead of disappearing. Unlike shiftAnchor (drag-to-scroll),
   * this moves BOTH endpoints — the user isn't holding the mouse at one
   * edge. Supplies screen.width for the col-reset-on-clamp boundary.
   */
  shiftSelectionForScroll(dRow: number, minRow: number, maxRow: number): void {
    const hadSel = hasSelection(this.selection);
    shiftSelection(this.selection, dRow, minRow, maxRow, this.frontFrame.screen.width);
    // shiftSelection clears when both endpoints overshoot the same edge
    // (Home/g/End/G page-jump past the selection). Notify subscribers so
    // useHasSelection updates. Safe to call notifySelectionChange here —
    // this runs from keyboard handlers, not inside onRender().
    if (hadSel && !hasSelection(this.selection)) {
      this.notifySelectionChange();
    }
  }

  /**
   * Keyboard selection extension (shift+arrow/home/end). Moves focus;
   * anchor stays fixed so the highlight grows or shrinks relative to it.
   * Left/right wrap across row boundaries — native macOS text-edit
   * behavior: shift+left at col 0 wraps to end of the previous row.
   * Up/down clamp at viewport edges (no scroll-to-extend yet). Drops to
   * char mode. No-op outside alt-screen or without an active selection.
   */
  moveSelectionFocus(move: FocusMove): void {
    if (!this.altScreenActive) return;
    const {
      focus
    } = this.selection;
    if (!focus) return;
    const {
      width,
      height
    } = this.frontFrame.screen;
    const maxCol = width - 1;
    const maxRow = height - 1;
    let {
      col,
      row
    } = focus;
    switch (move) {
      case 'left':
        if (col > 0) col--;else if (row > 0) {
          col = maxCol;
          row--;
        }
        break;
      case 'right':
        if (col < maxCol) col++;else if (row < maxRow) {
          col = 0;
          row++;
        }
        break;
      case 'up':
        if (row > 0) row--;
        break;
      case 'down':
        if (row < maxRow) row++;
        break;
      case 'lineStart':
        col = 0;
        break;
      case 'lineEnd':
        col = maxCol;
        break;
    }
    if (col === focus.col && row === focus.row) return;
    moveFocus(this.selection, col, row);
    this.notifySelectionChange();
  }

  /** Whether there is an active text selection. */
  hasTextSelection(): boolean {
    return hasSelection(this.selection);
  }

  /**
   * Subscribe to selection state changes. Fires whenever the selection
   * is started, updated, cleared, or copied. Returns an unsubscribe fn.
   */
  subscribeToSelectionChange(cb: () => void): () => void {
    this.selectionListeners.add(cb);
    return () => this.selectionListeners.delete(cb);
  }
  private notifySelectionChange(): void {
    this.renderNow();
    // #185 self-heal: selection listeners drive React state; an overflow
    // throw resets React's nested counter, so absorb and keep the rest.
    for (const cb of this.selectionListeners) {
      callWithUpdateOverflowGuard('selection.notify', cb);
    }
  }

  /**
   * Hit-test the rendered DOM tree at (col, row) and bubble a ClickEvent
   * from the deepest hit node up through ancestors with onClick handlers.
   * Returns true if a DOM handler consumed the click. Gated on
   * altScreenActive — clicks only make sense with a fixed viewport where
   * nodeCache rects map 1:1 to terminal cells (no scrollback offset).
   * The button byte is the raw SGR release code; its modifier bits land
   * on ClickEvent.shift/alt/ctrl.
   */
  /** Batch-tail probe for release-path clicks that deferred via deferProbe. */
  clickProbeAtBatchTail = (): void => {
    this.probeAltScreenHealth({ skipMouseReassert: true });
  };
  dispatchClick(col: number, row: number, button = 0, deferProbe = false): boolean {
    // Safe-boundary probe: clicks are dispatched from the RELEASE tail,
    // after App cleared the gesture latch — no button is held here. A
    // received mouse report proves tracking is alive but says nothing about
    // mode 1049 (conpty drops them independently), and mouse input keeps
    // lastStdinTime fresh so the >5s stdin-gap path never fires for a
    // mouse-only user — without a mouse-path probe, a silently dropped
    // alt-screen would never recover. skipMouseReassert: the arriving event
    // already proves tracking, so only the DECRQM 1049 query is sent.
    // deferProbe: release-path clicks defer the probe to the batch tail — a
    // single stdin chunk can carry `release → next press`, and the probe
    // must not write before the next press latch is established.
    if (!deferProbe) {
      this.probeAltScreenHealth({ skipMouseReassert: true });
    }
    if (!this.altScreenActive) {
      logMouseDebug('dispatchClick skipped — alt screen inactive', { col, row });
      return false;
    }
    const blank = isEmptyCellAt(this.frontFrame.screen, col, row);
    const handled = dispatchClick(this.rootNode, col, row, blank, button);
    logMouseDebug('dispatchClick', { col, row, handled });
    return handled;
  }
  /**
   * Hit-test the rendered DOM tree at (col, row) and bubble a
   * ContextMenuEvent from the deepest hit node up through ancestors with
   * onContextMenu handlers. Returns true if a DOM handler consumed it.
   * Gated on altScreenActive like dispatchClick. The button byte is the
   * raw SGR press code; its low bits are 2 for the right button and the
   * modifier bits land on ContextMenuEvent.shift/alt/ctrl.
   */
  dispatchContextMenu(col: number, row: number, button = 0): boolean {
    // No probe: this runs at right-PRESS time, inside the gesture window
    // (App latches before dispatching) — the probe would be latch-blocked
    // here anyway. Recovery lives at the safe boundaries (click release,
    // hover, wheel — see dispatchClick).
    if (!this.altScreenActive) {
      logMouseDebug('dispatchContextMenu skipped — alt screen inactive', { col, row });
      return false;
    }
    const handled = dispatchContextMenu(this.rootNode, col, row, button);
    logMouseDebug('dispatchContextMenu', { col, row, handled });
    return handled;
  }
  /**
   * Route a wheel event to the ScrollBox (any onWheel handler) under the
   * pointer. Returns true when a handler consumed it, so App can skip the
   * legacy global wheel-key path and exactly one layer scrolls. Gated on
   * altScreenActive like dispatchClick — without mouse tracking there are
   * no wheel coordinates to route by.
   */
  dispatchWheelAt(
    col: number,
    row: number,
    deltaY: number,
    deltaX = 0,
    button = 0,
  ): boolean {
    // Safe-boundary probe (skipMouseReassert — see dispatchClick). Wheel is
    // the recovery entry for mouse-only users on mode-1002-only terminals,
    // where no-button hover motion never arrives: SGR wheel reports carry
    // no held-button state and never engage the gesture latch.
    this.probeAltScreenHealth({ skipMouseReassert: true });
    if (!this.altScreenActive) return false;
    const handled = dispatchWheel(this.rootNode, col, row, deltaY, deltaX, button);
    if (handled) {
      logMouseDebug('dispatchWheelAt consumed', { col, row, deltaY, deltaX });
    }
    return handled;
  }
  dispatchHover(col: number, row: number): void {
    // Safe-boundary probe (skipMouseReassert — see dispatchClick). Hover is
    // no-button motion; App already cleared the gesture latch before routing
    // here, so no button can be held.
    this.probeAltScreenHealth({ skipMouseReassert: true });
    if (!this.altScreenActive) return;
    dispatchHover(this.rootNode, col, row, this.hoveredNodes);
  }
  /**
   * Drag protocol entry: find the drag target at an unmodified left
   * press — the deepest node at (col, row) whose ancestor chain carries
   * an onDragStart handler. Gated on altScreenActive like dispatchClick
   * (drag needs mouse tracking + a fixed viewport). Returns null when no
   * drag target is under the pointer, in which case App keeps the
   * baseline selection/click path untouched.
   */
  findDragTargetAt(col: number, row: number): dom.DOMElement | null {
    // No probe: this runs AT PRESS TIME, inside the gesture window — a
    // probe here writes the blind ENABLE_MOUSE_TRACKING re-assert + DECRQM
    // query while the user is holding the button, and some emulators
    // (WezTerm, xterm.js family) reset button tracking on DECSET re-assert,
    // killing the drag's motion stream mid-gesture (field-confirmed: drags
    // intermittently produced zero motion events). Recovery lives at the
    // safe boundaries (see dispatchClick).
    if (!this.altScreenActive) return null;
    const target = findDragTarget(this.rootNode, col, row);
    logMouseDebug('findDragTargetAt', { col, row, found: Boolean(target) });
    return target;
  }
  /**
   * Dispatch a drag event to the drag session target captured at press
   * time (bubbles through its ancestors). Gated on altScreenActive like
   * dispatchClick.
   */
  dispatchDrag(target: dom.DOMElement, event: DragEvent): void {
    // No probe: dragmove IS mid-gesture by definition (gesture latched) —
    // a re-assert write here kills the very motion stream that feeds it
    // (see dispatchClick for the safe-boundary probes).
    if (!this.altScreenActive) return;
    logMouseDebug('dispatchDrag', { type: event.type, col: event.col, row: event.row });
    bubbleDragEvent(target, event);
  }
  dispatchKeyboardEvent(parsedKey: ParsedKey): void {
    this.probeAltScreenHealth();
    const target = this.focusManager.activeElement ?? this.rootNode;
    const event = new KeyboardEvent(parsedKey);
    dispatcher.dispatchDiscrete(target, event);

    // Tab cycling is the default action — only fires if no handler
    // called preventDefault(). Mirrors browser behavior.
    if (!event.defaultPrevented && parsedKey.name === 'tab' && !parsedKey.ctrl && !parsedKey.meta) {
      if (parsedKey.shift) {
        this.focusManager.focusPrevious(this.rootNode);
      } else {
        this.focusManager.focusNext(this.rootNode);
      }
    }
  }
  /**
   * Look up the URL at (col, row) in the current front frame. Checks for
   * an OSC 8 hyperlink first, then falls back to scanning the row for a
   * plain-text URL (mouse tracking intercepts the terminal's native
   * Cmd+Click URL detection, so we replicate it). This is a pure lookup
   * with no side effects — call it synchronously at click time so the
   * result reflects the screen the user actually clicked on, then defer
   * the browser-open action via a timer.
   */
  getHyperlinkAt(col: number, row: number): string | undefined {
    if (!this.altScreenActive) return undefined;
    const screen = this.frontFrame.screen;
    const cell = cellAt(screen, col, row);
    let url = cell?.hyperlink;
    // SpacerTail cells (right half of wide/CJK/emoji chars) store the
    // hyperlink on the head cell at col-1.
    if (!url && cell?.width === CellWidth.SpacerTail && col > 0) {
      url = cellAt(screen, col - 1, row)?.hyperlink;
    }
    return url ?? findPlainTextUrlAt(screen, col, row);
  }

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
  openHyperlink(url: string): void {
    this.onHyperlinkClick?.(url);
  }

  /**
   * Handle a double- or triple-click at (col, row): select the word or
   * line under the cursor by reading the current screen buffer. Called on
   * PRESS (not release) so the highlight appears immediately and drag can
   * extend the selection word-by-word / line-by-line. Falls back to
   * char-mode startSelection if the click lands on a noSelect cell.
   */
  handleMultiClick(col: number, row: number, count: 2 | 3): void {
    if (!this.altScreenActive) return;
    const screen = this.frontFrame.screen;
    // selectWordAt/selectLineAt no-op on noSelect/out-of-bounds. Seed with
    // a char-mode selection so the press still starts a drag even if the
    // word/line scan finds nothing selectable.
    startSelection(this.selection, col, row);
    if (count === 2) selectWordAt(this.selection, screen, col, row);else selectLineAt(this.selection, screen, row);
    // Ensure hasSelection is true so release doesn't re-dispatch onClickAt.
    // selectWordAt no-ops on noSelect; selectLineAt no-ops out-of-bounds.
    if (!this.selection.focus) this.selection.focus = this.selection.anchor;
    this.notifySelectionChange();
  }

  /**
   * Handle a drag-motion at (col, row). In char mode updates focus to the
   * exact cell. In word/line mode snaps to word/line boundaries so the
   * selection extends by word/line like native macOS. Gated on
   * altScreenActive for the same reason as dispatchClick.
   */
  handleSelectionDrag(col: number, row: number): void {
    if (!this.altScreenActive) return;
    const sel = this.selection;
    if (sel.anchorSpan) {
      extendSelection(sel, this.frontFrame.screen, col, row);
    } else {
      updateSelection(sel, col, row);
    }
    this.notifySelectionChange();
  }

  // Methods to properly suspend stdin for external editor usage
  // This is needed to prevent Ink from swallowing keystrokes when an external editor is active
  private stdinListeners: Array<{
    event: string;
    listener: (...args: unknown[]) => void;
  }> = [];
  private wasRawMode = false;
  suspendStdin(): void {
    const stdin = this.options.stdin;
    if (!stdin.isTTY) {
      return;
    }

    // Store and remove all 'readable' event listeners temporarily
    // This prevents Ink from consuming stdin while the editor is active
    const readableListeners = stdin.listeners('readable');
    logForDebugging(`[stdin] suspendStdin: removing ${readableListeners.length} readable listener(s), wasRawMode=${(stdin as NodeJS.ReadStream & {
      isRaw?: boolean;
    }).isRaw ?? false}`);
    readableListeners.forEach(listener => {
      this.stdinListeners.push({
        event: 'readable',
        listener: listener as (...args: unknown[]) => void
      });
      stdin.removeListener('readable', listener as (...args: unknown[]) => void);
    });

    // If raw mode is enabled, disable it temporarily
    const stdinWithRaw = stdin as NodeJS.ReadStream & {
      isRaw?: boolean;
      setRawMode?: (mode: boolean) => void;
    };
    if (stdinWithRaw.isRaw && stdinWithRaw.setRawMode) {
      stdinWithRaw.setRawMode(false);
      this.wasRawMode = true;
    }
  }
  resumeStdin(): void {
    const stdin = this.options.stdin;
    if (!stdin.isTTY) {
      return;
    }

    // Re-attach all the stored listeners
    if (this.stdinListeners.length === 0 && !this.wasRawMode) {
      logForDebugging('[stdin] resumeStdin: called with no stored listeners and wasRawMode=false (possible desync)', {
        level: 'warn'
      });
    }

    // Raw mode FIRST: the editor restored the tty to canonical mode on
    // exit, so keystrokes typed during the handoff window are sitting in
    // the kernel line buffer; setRawMode(true) makes them readable.
    if (this.wasRawMode) {
      const stdinWithRaw = stdin as NodeJS.ReadStream & {
        setRawMode?: (mode: boolean) => void;
      };
      if (stdinWithRaw.setRawMode) {
        stdinWithRaw.setRawMode(true);
      }
      this.wasRawMode = false;
    }

    // Drain every already-buffered byte BEFORE the listeners come back:
    // line-buffer leftovers, editor exit-sequence replies (CPR/DECRPM),
    // mouse-event fragments. Parsed as input they are destructive — a
    // stray ESC clears a non-empty prompt, the rest lands as text garbage
    // (issue #123 field report). Bytes arriving LATE (async terminal
    // replies) are covered by the suppression window in
    // exitAlternateScreen.
    let chunk: unknown;
    while ((chunk = stdin.read()) !== null) {
      void chunk;
    }

    logForDebugging(`[stdin] resumeStdin: re-attaching ${this.stdinListeners.length} listener(s)`);
    this.stdinListeners.forEach(({
      event,
      listener
    }) => {
      stdin.addListener(event, listener);
    });
    this.stdinListeners = [];
  }

  // Stable identity for TerminalWriteContext. An inline arrow here would
  // change on every render() call (initial mount + each resize), which
  // cascades through useContext → <AlternateScreen>'s useLayoutEffect dep
  // array → spurious exit+re-enter of the alt screen on every SIGWINCH.
  private writeRaw(data: string): void {
    if (data.includes('\x1b[?1049')) {
      logMouseDebug('stdout:1049', { len: data.length, head: data.slice(0, 60) });
    }
    this.options.stdout.write(data);
  }
  private setCursorDeclaration: CursorDeclarationSetter = (decl, clearIfNode) => {
    if (decl === null && clearIfNode !== undefined && this.cursorDeclaration?.node !== clearIfNode) {
      return;
    }
    this.cursorDeclaration = decl;
  };
  private setAppRef(app: App | null): void {
    this.app = app;
  }
  render(node: ReactNode): void {
    this.currentNode = node;
    const tree = <App ref={this.setAppRef} stdin={this.options.stdin} stdout={this.options.stdout} stderr={this.options.stderr} exitOnCtrlC={this.options.exitOnCtrlC} onExit={this.unmount} terminalColumns={this.terminalColumns} terminalRows={this.terminalRows} selection={this.selection} onSelectionChange={this.notifySelectionChange} onClickAt={this.dispatchClick} onContextMenuAt={this.dispatchContextMenu} onHoverAt={this.dispatchHover} onWheelAt={this.dispatchWheelAt} getHyperlinkAt={this.getHyperlinkAt} onOpenHyperlink={this.openHyperlink} onMultiClick={this.handleMultiClick} onSelectionDrag={this.handleSelectionDrag} onDragTargetAt={this.findDragTargetAt} onDragDispatch={this.dispatchDrag} onPointerGestureChange={this.setPointerGestureActive} onProtocolCandidateChange={this.setProtocolCandidateActive} onReleaseTail={this.drainReleaseTail} onClickProbe={this.clickProbeAtBatchTail} onStdinResume={this.reassertTerminalModes} onTerminalFocus={this.handleTerminalFocusProbe} onCursorDeclaration={this.setCursorDeclaration} dispatchKeyboardEvent={this.dispatchKeyboardEvent}>
        <TerminalWriteProvider value={this.writeRaw}>
          <TerminalImagesContext.Provider value={this.terminalImages}>
            {node}
          </TerminalImagesContext.Provider>
        </TerminalWriteProvider>
      </App>;

    // @ts-ignore -- runtime/type-definition mismatch: updateContainerSync exists in react-reconciler but not in @types/react-reconciler
    reconciler.updateContainerSync(tree, this.container, null, noop);
    // @ts-ignore -- runtime/type-definition mismatch: flushSyncWork exists in react-reconciler but not in @types/react-reconciler
    reconciler.flushSyncWork();
  }
  unmount(error?: Error | number | null): void {
    if (this.isUnmounted) {
      return;
    }
    // The final frame render is best-effort: a mid-state React commit can
    // throw (agent still working at the exact exit moment). It must NOT
    // skip the synchronous cleanup block below — a skipped DISABLE_*
    // leaves mouse reporting on past process exit, and the shell echoes
    // SGR garbage for every click/drag/wheel (issue #522).
    try {
      this.renderNow();
    } catch (renderError) {
      logError(renderError instanceof Error ? renderError : new Error(String(renderError)));
    }
    this.unsubscribeExit();
    if (typeof this.restoreConsole === 'function') {
      this.restoreConsole();
    }
    this.restoreStderr?.();
    this.unsubscribeTTYHandlers?.();

    // Non-TTY environments don't handle erasing ansi escapes well, so it's better to
    // only render last frame of non-static output
    const diff = this.log.renderPreviousOutput_DEPRECATED(this.frontFrame);
    const lastFrame = serializeDiff(this.terminal, optimize(diff));
    const sixelCleanup = this.sixelGraphicsManager.dispose();

    // Clean up terminal modes synchronously before process exit.
    // React's componentWillUnmount won't run in time when process.exit() is called,
    // so we must reset terminal modes here to prevent escape sequence leakage.
    // Use writeSync to the stdout stream's own fd (not a hard-coded 1 — a
    // host that runs the TUI on a non-1 TTY would drop every sequence while
    // the enable writes still reach the TTY, issue #522) to ensure writes
    // complete before exit. We unconditionally send all disable sequences
    // because terminal detection may not work correctly (e.g., in tmux,
    // screen) and these are no-ops on terminals that don't support them.
    /* eslint-disable custom-rules/no-sync-fs -- process exiting; async writes would be dropped */
    if (this.options.stdout.isTTY) {
      // Node's TTY WriteStream exposes .fd; the NodeJS.WriteStream interface
      // doesn't declare it, hence the local intersection cast.
      const stdoutWithFd = this.options.stdout as NodeJS.WriteStream & { fd?: number | null };
      const stdoutFd = typeof stdoutWithFd.fd === 'number' ? stdoutWithFd.fd : 1;
      // The last frame must land on the ALT screen while it is still up:
      // writing it through the async stream would race the synchronous
      // EXIT_ALT_SCREEN below and the frame bytes would arrive AFTER the
      // switch to the main screen, painting misplaced residue over the
      // shell (issue #522).
      if (lastFrame !== '') {
        writeSync(stdoutFd, lastFrame);
      }
      const deleteImages = this.kittyGraphicsManager.deleteAll() + sixelCleanup;
      if (deleteImages !== '') {
        writeSync(stdoutFd, deleteImages);
      }
      if (this.altScreenActive) {
        // <AlternateScreen>'s unmount effect won't run during signal-exit.
        // Exit alt screen FIRST so other cleanup sequences go to the main screen.
        writeSync(stdoutFd, EXIT_ALT_SCREEN);
      }
      // Disable mouse tracking — unconditional because altScreenActive can be
      // stale if AlternateScreen's unmount (which flips the flag) raced a
      // blocked event loop + SIGINT. No-op if tracking was never enabled.
      writeSync(stdoutFd, DISABLE_MOUSE_TRACKING);
      // Drain stdin so in-flight mouse events don't leak to the shell
      this.drainStdin();
      // Disable extended key reporting (both kitty and modifyOtherKeys)
      writeSync(stdoutFd, DISABLE_MODIFY_OTHER_KEYS);
      writeSync(stdoutFd, DISABLE_KITTY_KEYBOARD);
      // Disable win32-input-mode (no-op where never enabled)
      writeSync(stdoutFd, DISABLE_WIN32_INPUT_MODE);
      // Disable focus events (DECSET 1004)
      writeSync(stdoutFd, DFE);
      // Disable bracketed paste mode
      writeSync(stdoutFd, DBP);
      // Show cursor
      writeSync(stdoutFd, SHOW_CURSOR);
      // Clear iTerm2 progress bar
      writeSync(stdoutFd, CLEAR_ITERM2_PROGRESS);
      // Clear tab status (OSC 21337) so a stale dot doesn't linger
      if (supportsTabStatus()) writeSync(stdoutFd, wrapForMultiplexer(CLEAR_TAB_STATUS));
    }
    /* eslint-enable custom-rules/no-sync-fs */

    this.isUnmounted = true;

    this.terminalImageListeners.clear();

    // Cancel any pending throttled renders to prevent accessing freed Yoga nodes
    this.scheduleRender.cancel?.();
    if (this.drainTimer !== null) {
      clearTimeout(this.drainTimer);
      this.drainTimer = null;
    }
    if (this.terminalQueryResumeTimer !== null) {
      clearTimeout(this.terminalQueryResumeTimer);
      this.terminalQueryResumeTimer = null;
    }

    // @ts-ignore -- runtime/type-definition mismatch: updateContainerSync exists in react-reconciler but not in @types/react-reconciler
    reconciler.updateContainerSync(null, this.container, null, noop);
    // @ts-ignore -- runtime/type-definition mismatch: flushSyncWork exists in react-reconciler but not in @types/react-reconciler
    reconciler.flushSyncWork();
    instances.delete(this.options.stdout);

    // Free the root yoga node, then clear its reference. Children are already
    // freed by the reconciler's removeChildFromContainer; using .free() (not
    // .freeRecursive()) avoids double-freeing them.
    this.rootNode.yogaNode?.free();
    this.rootNode.yogaNode = undefined;
    if (error instanceof Error) {
      this.rejectExitPromise(error);
    } else {
      this.resolveExitPromise();
    }
  }
  async waitUntilExit(): Promise<void> {
    this.exitPromise ||= new Promise((resolve, reject) => {
      this.resolveExitPromise = resolve;
      this.rejectExitPromise = reject;
    });
    return this.exitPromise;
  }
  resetLineCount(): void {
    if (this.options.stdout.isTTY) {
      // Swap so old front becomes back (for screen reuse), then reset front
      this.backFrame = this.frontFrame;
      this.frontFrame = emptyFrame(this.frontFrame.viewport.height, this.frontFrame.viewport.width, this.stylePool, this.charPool, this.hyperlinkPool);
      this.log.reset();
      // frontFrame is reset, so frame.cursor on the next render is (0,0).
      // Clear displayCursor so the preamble doesn't compute a stale delta.
      this.displayCursor = null;
    }
  }

  /**
   * Replace char/hyperlink pools with fresh instances to prevent unbounded
   * growth during long sessions. Migrates the front frame's screen IDs into
   * the new pools so diffing remains correct. The back frame doesn't need
   * migration — resetScreen zeros it before any reads.
   *
   * Call between conversation turns or periodically.
   */
  resetPools(): void {
    this.charPool = new CharPool();
    this.hyperlinkPool = new HyperlinkPool();
    migrateScreenPools(this.frontFrame.screen, this.charPool, this.hyperlinkPool);
    // Back frame's data is zeroed by resetScreen before reads, but its pool
    // references are used by the renderer to intern new characters. Point
    // them at the new pools so the next frame's IDs are comparable.
    this.backFrame.screen.charPool = this.charPool;
    this.backFrame.screen.hyperlinkPool = this.hyperlinkPool;
    if (this.mainScreenFrameState) {
      migrateScreenPools(this.mainScreenFrameState.frontFrame.screen, this.charPool, this.hyperlinkPool);
    }
  }
  patchConsole(): () => void {
    // biome-ignore lint/suspicious/noConsole: intentionally patching global console
    const con = console;
    const originals: Partial<Record<keyof Console, Console[keyof Console]>> = {};
    const toDebug = (...args: unknown[]) => logForDebugging(`console.log: ${format(...args)}`);
    const toError = (...args: unknown[]) => logError(new Error(`console.error: ${format(...args)}`));
    for (const m of CONSOLE_STDOUT_METHODS) {
      originals[m] = con[m];
      con[m] = toDebug;
    }
    for (const m of CONSOLE_STDERR_METHODS) {
      originals[m] = con[m];
      con[m] = toError;
    }
    originals.assert = con.assert;
    con.assert = (condition: unknown, ...args: unknown[]) => {
      if (!condition) toError(...args);
    };
    return () => Object.assign(con, originals);
  }

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
  private patchStderr(): () => void {
    const stderr = process.stderr;
    const originalWrite = stderr.write;
    let reentered = false;
    const intercept = (chunk: Uint8Array | string, encodingOrCb?: BufferEncoding | ((err?: Error | null) => void), cb?: (err?: Error | null) => void): boolean => {
      const callback = typeof encodingOrCb === 'function' ? encodingOrCb : cb;
      // Reentrancy guard: logForDebugging → writeToStderr → here. Pass
      // through to the original so --debug-to-stderr still works and we
      // don't stack-overflow.
      if (reentered) {
        const encoding = typeof encodingOrCb === 'string' ? encodingOrCb : undefined;
        return originalWrite.call(stderr, chunk, encoding, callback);
      }
      reentered = true;
      try {
        const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
        logForDebugging(`[stderr] ${text}`, {
          level: 'warn'
        });
        if (!this.isUnmounted && !this.isPaused) {
          if (this.altScreenActive) {
            this.prevFrameContaminated = true;
            this.scheduleRender();
          } else {
            // Main-screen (inline): the diff engine's moves are purely
            // relative to the physical cursor, so ANY unobserved tty write
            // (one that slipped through before this patch existed, or via
            // a path it can't intercept — a snapshotted ESM writer) shifts
            // every later write by N rows with nothing to detect it after
            // the fact. The stdin-gap reassert covers slow leaks; this
            // per-write defensive net closes the fast ones: blind
            // idempotent viewport repaint from the physical cursor. When
            // nothing drifted (the usual case — the write was swallowed)
            // it paints the same pixels again at O(viewport) bytes.
            this.log.requestViewportReanchor();
            this.scheduleRender();
          }
        }
      } finally {
        reentered = false;
        callback?.();
      }
      return true;
    };
    stderr.write = intercept;
    return () => {
      if (stderr.write === intercept) {
        stderr.write = originalWrite;
      }
    };
  }
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
/* eslint-disable custom-rules/no-sync-fs -- must be sync; called from signal handler / unmount */
export function drainStdin(stdin: NodeJS.ReadStream = process.stdin): void {
  if (!stdin.isTTY) return;
  // Drain Node's stream buffer (bytes libuv already pulled in). read()
  // returns null when empty — never blocks.
  try {
    while (stdin.read() !== null) {
      /* discard */
    }
  } catch {
    /* stream may be destroyed */
  }
  // No /dev/tty on Windows; CONIN$ doesn't support O_NONBLOCK semantics.
  // Windows Terminal also doesn't buffer mouse reports the same way.
  if (process.platform === 'win32') return;
  // termios is per-device: flip stdin to raw so canonical-mode line
  // buffering doesn't hide partial input from the non-blocking read.
  // Restored in the finally block.
  const tty = stdin as NodeJS.ReadStream & {
    isRaw?: boolean;
    setRawMode?: (raw: boolean) => void;
  };
  const wasRaw = tty.isRaw === true;
  // Drain the kernel TTY buffer via a fresh O_NONBLOCK fd. Bounded at 64
  // reads (64KB) — a real mouse burst is a few hundred bytes; the cap
  // guards against a terminal that ignores O_NONBLOCK.
  let fd = -1;
  try {
    // setRawMode inside try: on revoked TTY (SIGHUP/SSH disconnect) the
    // ioctl throws EBADF — same recovery path as openSync/readSync below.
    if (!wasRaw) tty.setRawMode?.(true);
    fd = openSync('/dev/tty', fsConstants.O_RDONLY | fsConstants.O_NONBLOCK);
    const buf = Buffer.alloc(1024);
    for (let i = 0; i < 64; i++) {
      if (readSync(fd, buf, 0, buf.length, null) <= 0) break;
    }
  } catch {
    // EAGAIN (buffer empty — expected), ENXIO/ENOENT (no controlling tty),
    // EBADF/EIO (TTY revoked — SIGHUP, SSH disconnect)
  } finally {
    if (fd >= 0) {
      try {
        closeSync(fd);
      } catch {
        /* ignore */
      }
    }
    if (!wasRaw) {
      try {
        tty.setRawMode?.(false);
      } catch {
        /* TTY may be gone */
      }
    }
  }
}
/* eslint-enable custom-rules/no-sync-fs */

const CONSOLE_STDOUT_METHODS = ['log', 'info', 'debug', 'dir', 'dirxml', 'count', 'countReset', 'group', 'groupCollapsed', 'groupEnd', 'table', 'time', 'timeEnd', 'timeLog'] as const;
const CONSOLE_STDERR_METHODS = ['warn', 'error', 'trace'] as const;
