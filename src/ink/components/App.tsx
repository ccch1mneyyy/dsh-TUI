import React, { PureComponent, type ReactNode } from "react";
import { updateLastInteractionTime } from "../../bootstrap/state.js";
import { logForDebugging } from "../../utils/debug.js";
import { stopCapturingEarlyInput } from "../../utils/earlyInput.js";
import { isEnvTruthy } from "../../utils/envUtils.js";
import { isMouseClicksDisabled } from "../../utils/fullscreen.js";
import { isInputSuppressed } from "../input-suppression.js";
import { logMouseDebug } from "../../utils/debug.js";
import { logError } from "../../utils/log.js";
import { EventEmitter } from "../events/emitter.js";
import { InputEvent } from "../events/input-event.js";
import { TerminalFocusEvent } from "../events/terminal-focus-event.js";
import { DragEvent } from "../events/drag-event.js";
import type { DOMElement } from "../dom.js";
import {
	INITIAL_STATE,
	type ParsedInput,
	type ParsedKey,
	type ParsedMouse,
	parseMultipleKeypresses,
} from "../parse-keypress.js";
import reconciler from "../reconciler.js";
import {
	finishSelection,
	hasSelection,
	type SelectionState,
	startSelection,
} from "../selection.js";
import {
	isXtermJs,
	setXtversionName,
	supportsExtendedKeys,
	supportsWin32InputMode,
} from "../terminal.js";
import {
	getTerminalFocused,
	setTerminalFocused,
} from "../terminal-focus-state.js";
import { TerminalQuerier, xtversion } from "../terminal-querier.js";
import {
	DISABLE_KITTY_KEYBOARD,
	DISABLE_MODIFY_OTHER_KEYS,
	DISABLE_WIN32_INPUT_MODE,
	ENABLE_KITTY_KEYBOARD,
	ENABLE_MODIFY_OTHER_KEYS,
	ENABLE_WIN32_INPUT_MODE,
	FOCUS_IN,
	FOCUS_OUT,
} from "../termio/csi.js";
import {
	DBP,
	DFE,
	DISABLE_MOUSE_TRACKING,
	EBP,
	EFE,
	HIDE_CURSOR,
	SHOW_CURSOR,
} from "../termio/dec.js";
import AppContext from "./AppContext.js";
import { ClockProvider } from "./ClockContext.js";
import CursorDeclarationContext, {
	type CursorDeclarationSetter,
} from "./CursorDeclarationContext.js";
import ErrorOverview from "./ErrorOverview.js";
import StdinContext from "./StdinContext.js";
import { TerminalFocusProvider } from "./TerminalFocusContext.js";
import { TerminalSizeContext } from "./TerminalSizeContext.js";
import { TerminalWriteProvider } from "../useTerminalNotification.js";

// Platforms that support Unix-style process suspension (SIGSTOP/SIGCONT)
const SUPPORTS_SUSPEND = process.platform !== "win32";

// After this many milliseconds of stdin silence, the next chunk triggers
// a terminal mode re-assert (mouse tracking). Catches tmux detach→attach,
// ssh reconnect, and laptop wake — the terminal resets DEC private modes
// but no signal reaches us. 5s is well above normal inter-keystroke gaps
// but short enough that the first scroll after reattach works.
const STDIN_RESUME_GAP_MS = 5000;
type Props = {
	readonly children: ReactNode;
	readonly stdin: NodeJS.ReadStream;
	readonly stdout: NodeJS.WriteStream;
	readonly stderr: NodeJS.WriteStream;
	readonly exitOnCtrlC: boolean;
	readonly onExit: (error?: Error) => void;
	readonly terminalColumns: number;
	readonly terminalRows: number;
	// Text selection state. App mutates this directly from mouse events
	// and calls onSelectionChange to trigger a repaint. Mouse events only
	// arrive when <AlternateScreen> (or similar) enables mouse tracking,
	// so the handler is always wired but dormant until tracking is on.
	readonly selection: SelectionState;
	readonly onSelectionChange: () => void;
	// Dispatch a click at (col, row) — hit-tests the DOM tree and bubbles
	// onClick handlers. Returns true if a DOM handler consumed the click.
	// No-op (returns false) outside fullscreen mode (Ink.dispatchClick
	// gates on altScreenActive). The button byte is the raw SGR release
	// code, carrying the modifier bits (shift/alt/ctrl) for ClickEvent.
	// deferProbe: release-path clicks defer the health probe to the batch
	// tail — a single stdin chunk can carry `release → next press`, and the
	// probe must not write before the next press latch is established.
	readonly onClickAt: (col: number, row: number, button?: number, deferProbe?: boolean) => boolean;
	// Dispatch a context-menu event at (col, row) on RIGHT-button press —
	// hit-tests the DOM tree and bubbles onContextMenu handlers, mirroring
	// the DOM contextmenu event that shows on mousedown. Returns true if a
	// DOM handler consumed it. No-op (returns false) outside fullscreen.
	// The button byte is the raw SGR press code (low bits 2 = right button,
	// modifier bits preserved) so handlers can read shift/alt/ctrl.
	readonly onContextMenuAt: (col: number, row: number, button?: number) => boolean;
	// Dispatch hover (onMouseEnter/onMouseLeave) as the pointer moves over
	// DOM elements. Called for mode-1003 motion events with no button held.
	// No-op outside fullscreen (Ink.dispatchHover gates on altScreenActive).
	readonly onHoverAt: (col: number, row: number) => void;
	// Route a wheel event by pointer position: hit-test (col, row) and
	// dispatch onWheel on the deepest scroll container under the cursor.
	// Returns true when an onWheel handler consumed the event — the caller
	// then skips the legacy global wheel-key emit so only one layer
	// scrolls. No-op outside fullscreen (Ink gates on altScreenActive).
	readonly onWheelAt: (
		col: number,
		row: number,
		deltaY: number,
		deltaX: number,
		button?: number,
	) => boolean;
	// Look up the OSC 8 hyperlink at (col, row) synchronously at click
	// time. Returns the URL or undefined. The browser-open is deferred by
	// MULTI_CLICK_TIMEOUT_MS so double-click can cancel it.
	readonly getHyperlinkAt: (col: number, row: number) => string | undefined;
	// Open a hyperlink URL in the browser. Called after the timer fires.
	readonly onOpenHyperlink: (url: string) => void;
	// Called on double/triple-click PRESS at (col, row). count=2 selects
	// the word under the cursor; count=3 selects the line. Ink reads the
	// screen buffer to find word/line boundaries and mutates selection,
	// setting isDragging=true so a subsequent drag extends by word/line.
	readonly onMultiClick: (col: number, row: number, count: 2 | 3) => void;
	// Called on drag-motion. Mode-aware: char mode updates focus to the
	// exact cell; word/line mode snaps to word/line boundaries. Needs
	// screen-buffer access (word boundaries) so lives on Ink, not here.
	readonly onSelectionDrag: (col: number, row: number) => void;
	// Drag protocol (DOM HTML5 drag subset). Find the drag target at an
	// unmodified left-button press: the deepest node at (col, row) whose
	// ancestor chain (inclusive) carries an onDragStart handler, or null.
	// When non-null, App opens a drag session INSTEAD of text selection /
	// multi-click. Optional so testing.tsx doesn't need to stub it.
	readonly onDragTargetAt?: (col: number, row: number) => DOMElement | null;
	// Dispatch a dragstart/dragmove/dragend DragEvent to the captured drag
	// session target (bubbles through its ancestors). No-op outside
	// fullscreen (Ink gates on altScreenActive). Optional like above.
	readonly onDragDispatch?: (target: DOMElement, event: DragEvent) => void;
	// Gesture latch for Ink's alt-screen health probe: true while a mouse
	// button is held (press seen, no release/reset yet), false otherwise.
	// Ink must not write its blind mode re-assert / DECRQM query mid-gesture
	// — some emulators reset button tracking on DECSET re-assert, silently
	// killing the gesture's motion stream. Optional so testing.tsx doesn't
	// need to stub it.
	readonly onPointerGestureChange?: (active: boolean) => void;
	// Called when the parser captures or releases an SGR mouse protocol
	// candidate (incomplete prefix in flight). This is a PROTOCOL-CANDIDATE
	// latch, not the physical-button latch: it clears on any complete event
	// (mouse or key), ordinary text, paste/response boundary, or the 1s
	// hold deadline. Ink's health probe must not write while a candidate
	// is in flight (a DECSET re-assert mid-report corrupts the stream).
	readonly onProtocolCandidateChange?: (active: boolean) => void;
	// Called after the full release/click/drag tail completes. Ink drains a
	// deferred alt-screen re-entry here — the gesture latch clears at the
	// START of release handling, but the destructive re-entry must wait
	// until dispatchClick has read frontFrame (cellIsBlank, getHyperlinkAt).
	readonly onReleaseTail?: () => void;
	// Called at the batch tail when a release-path click deferred its health
	// probe (deferProbe). Ink issues the skipMouseReassert probe here — after
	// the entire batch is processed, so a `release → next press` chunk never
	// sees the probe write land before the next press latch.
	readonly onClickProbe?: () => void;
	// Called when stdin data arrives after a >STDIN_RESUME_GAP_MS gap.
	// Ink re-asserts terminal modes: extended key reporting, and (when in
	// fullscreen) re-enters alt-screen + mouse tracking. Idempotent on the
	// terminal side. Optional so testing.tsx doesn't need to stub it.
	readonly onStdinResume?: () => void;
	// Called on DECSET-1004 focus events. Ink probes the alt-screen/mouse
	// mode state on refocus — the moment a conpty-side mode reset (DPI
	// change, renderer restart) becomes observable — and self-heals.
	readonly onTerminalFocus?: (focused: boolean) => void;
	// Receives the declared native-cursor position from useDeclaredCursor
	// so ink.tsx can park the terminal cursor there after each frame.
	// Enables IME composition at the input caret and lets screen readers /
	// magnifiers track the input. Optional so testing.tsx doesn't stub it.
	readonly onCursorDeclaration?: CursorDeclarationSetter;
	// Dispatch a keyboard event through the DOM tree. Called for each
	// parsed key alongside the legacy EventEmitter path.
	readonly dispatchKeyboardEvent: (parsedKey: ParsedKey) => void;
};

// Multi-click detection thresholds. 500ms is the macOS default; a small
// position tolerance allows for trackpad jitter between clicks.
const MULTI_CLICK_TIMEOUT_MS = 500;
const MULTI_CLICK_DISTANCE = 1;
type State = {
	readonly error?: Error;
};

// Root component for all Ink apps
// It renders stdin and stdout contexts, so that children can access them if needed
// It also handles Ctrl+C exiting and cursor visibility
export default class App extends PureComponent<Props, State> {
	static displayName = "InternalApp";
	static getDerivedStateFromError(error: Error) {
		return {
			error,
		};
	}
	override state = {
		error: undefined,
	};

	// Count how many components enabled raw mode to avoid disabling
	// raw mode until all components don't need it anymore
	rawModeEnabledCount = 0;
	internal_eventEmitter = new EventEmitter();
	keyParseState = INITIAL_STATE;
	// Timer for flushing incomplete escape sequences
	incompleteEscapeTimer: NodeJS.Timeout | null = null;
	// Deferred XTVERSION probe (setImmediate). Cleared on unmount so the
	// DA1 sentinel it flushes cannot land after raw mode is off.
	xtversionProbe: NodeJS.Immediate | null = null;
	xtversionAttempted = false;
	// Timeout durations for incomplete sequences (ms)
	readonly NORMAL_TIMEOUT = 50; // Short timeout for regular esc sequences
	readonly PASTE_TIMEOUT = 500; // Longer timeout for paste operations

	// Terminal query/response dispatch. Responses arrive on stdin (parsed
	// out by parse-keypress) and are routed to pending promise resolvers.
	querier = new TerminalQuerier(this.props.stdout, enabled =>
		this.handleSetRawMode(enabled),
	);

	// Multi-click tracking for double/triple-click text selection. A click
	// within MULTI_CLICK_TIMEOUT_MS and MULTI_CLICK_DISTANCE of the previous
	// click increments clickCount; otherwise it resets to 1.
	lastClickTime = 0;
	lastClickCol = -1;
	lastClickRow = -1;
	clickCount = 0;
	// Deferred hyperlink-open timer — cancelled if a second click arrives
	// within MULTI_CLICK_TIMEOUT_MS (so double-clicking a hyperlink selects
	// the word without also opening the browser). DOM onClick dispatch is
	// NOT deferred — it returns true from onClickAt and skips this timer.
	pendingHyperlinkTimer: ReturnType<typeof setTimeout> | null = null;
	/**
	 * Bitmask of currently held mouse buttons (bit 0 = left, 1 = middle,
	 * 2 = right). Updated in the transport layer of handleMouseEvent BEFORE
	 * the click-disabled gate, so DSH_TUI_DISABLE_MOUSE=1 still maintains
	 * the physical latch. X10's generic release (low bits 3) cannot identify
	 * which button ended and conservatively clears the entire set — a
	 * no-button motion or focus-out is the reliable termination signal.
	 */
	heldButtons = 0;
	/**
	 * Set when an X10 generic release (low bits 3) arrived with buttons still
	 * potentially held — the release carries no button identity, so the probe
	 * stays blocked until a reliable termination signal (no-button motion,
	 * focus-out, or a fresh press identifying the still-held button).
	 */
	ambiguousHeld = false;
	/**
	 * Set when a release, focus-out, or no-button motion cleared the gesture
	 * latch during the current batch. processKeysInBatch drains the deferred
	 * alt-screen re-entry / blocked probe at the batch tail, not mid-batch —
	 * a single stdin chunk can carry `release → next press`, and draining
	 * between them would write probe bytes into the next gesture's opening
	 * window.
	 */
	pendingReleaseTail = false;
	/**
	 * Set when FOCUS_IN arrived during the current batch. The focus probe
	 * (handleTerminalFocusProbe) is deferred to the batch tail so a single
	 * stdin chunk carrying FOCUS_IN + press doesn't write probe bytes before
	 * the press latch is established.
	 */
	pendingFocusProbe = false;
	/**
	 * Set when a release-path click deferred its health probe (deferProbe).
	 * The probe fires at the batch tail via onClickProbe.
	 */
	pendingClickProbe = false;
	// Last mode-1003 motion position. Terminals already dedupe to cell
	// granularity but this also lets us skip dispatchHover entirely on
	// repeat events (drag-then-release at same cell, etc.).
	lastHoverCol = -1;
	lastHoverRow = -1;
	// Active drag session (DOM HTML5 drag subset). Opened on an unmodified
	// left press over a node whose ancestor chain carries an onDragStart
	// handler; `started` flips on the FIRST drag motion — DOM dragstart
	// fires on first move, not on press. lastCol/lastRow track the most
	// recent pointer position so an interrupted session (focus loss,
	// screen swap) can still fire dragend near where the pointer was.
	dragSession: {
		target: DOMElement;
		startCol: number;
		startRow: number;
		lastCol: number;
		lastRow: number;
		started: boolean;
	} | null = null;

	/**
	 * End an in-flight drag session without a release event (focus lost,
	 * screen swap, pointer-state reset): fire dragend at the last known
	 * pointer position so consumers aren't left with an orphan session.
	 * A session that never started (press without movement) ends silently.
	 */
	finishDragSession(): void {
		const session = this.dragSession;
		if (!session) return;
		this.dragSession = null;
		if (session.started) {
			this.props.onDragDispatch?.(
				session.target,
				new DragEvent(
					"dragend",
					session.lastCol,
					session.lastRow,
					session.startCol,
					session.startRow,
				),
			);
		}
	}

	/**
	 * Reset all transient pointer state. Called by Ink when the alt screen
	 * is entered/exited and on resize: rects, hover targets, and the click
	 * chain from the previous screen geometry/scene must not leak into the
	 * new one (stale hover sets would suppress the next real onMouseEnter;
	 * a stale clickCount could turn the first click on a fresh screen into
	 * a double-click).
	 */
	resetPointerState(): void {
		this.clickCount = 0;
		this.lastClickTime = 0;
		this.lastClickCol = -1;
		this.lastClickRow = -1;
		this.lastHoverCol = -1;
		this.lastHoverRow = -1;
		// Do NOT clear the pointer gesture latch here. A geometry reset
		// (resize, screen swap) cancels the LOGICAL drag/selection below, but
		// says nothing about the physical button — the user may still be
		// holding it, and Ink's health probe writes (blind DECSET re-assert,
		// DECRQM) must stay barred until a confirmed termination signal:
		// release, no-button motion, or focus-out. Unlatching here let the
		// resize handler's own probe write mid-gesture.
		this.finishDragSession();
		if (this.pendingHyperlinkTimer) {
			clearTimeout(this.pendingHyperlinkTimer);
			this.pendingHyperlinkTimer = null;
		}
		// A drag interrupted by a screen swap has no release coming — settle
		// the selection so copy-on-select fires rather than orphaning
		// isDragging with its drag-to-scroll timer running.
		const sel = this.props.selection;
		if (sel.isDragging) {
			finishSelection(sel);
			this.props.onSelectionChange();
		}
	}

	// Timestamp of last stdin chunk. Used to detect long gaps (tmux attach,
	// ssh reconnect, laptop wake) and trigger terminal mode re-assert.
	// Initialized to now so startup doesn't false-trigger.
	lastStdinTime = Date.now();

	// Raw stdout writer for control sequences that must bypass the frame
	// pipeline (alt-screen enter/exit, mouse-tracking toggles, notifications).
	// A class property (not a render-local closure) so the context value keeps
	// a stable identity — a fresh function per render would re-run
	// <AlternateScreen>'s insertion effect every frame, flapping the alt
	// screen on/off.
	writeRaw = (data: string): void => {
		if (data.includes("\x1b[?1049")) {
			logMouseDebug("stdout:1049", { len: data.length, head: data.slice(0, 60) });
		}
		this.props.stdout.write(data);
	};

	// Determines if TTY is supported on the provided stdin
	isRawModeSupported(): boolean {
		return this.props.stdin.isTTY;
	}
	override render() {
		return (
			<TerminalWriteProvider value={this.writeRaw}>
			<TerminalSizeContext.Provider
				value={{
					columns: this.props.terminalColumns,
					rows: this.props.terminalRows,
				}}
			>
				<AppContext.Provider
					value={{
						exit: this.handleExit,
						stdout: this.props.stdout,
					}}
				>
					<StdinContext.Provider
						value={{
							stdin: this.props.stdin,
							setRawMode: this.handleSetRawMode,
							isRawModeSupported: this.isRawModeSupported(),
							internal_exitOnCtrlC: this.props.exitOnCtrlC,
							internal_eventEmitter: this.internal_eventEmitter,
							internal_querier: this.querier,
						}}
					>
						<TerminalFocusProvider>
							<ClockProvider>
								<CursorDeclarationContext.Provider
									value={this.props.onCursorDeclaration ?? (() => {})}
								>
									{this.state.error ? (
										<ErrorOverview error={this.state.error} />
									) : (
										this.props.children
									)}
								</CursorDeclarationContext.Provider>
							</ClockProvider>
						</TerminalFocusProvider>
					</StdinContext.Provider>
				</AppContext.Provider>
			</TerminalSizeContext.Provider>
			</TerminalWriteProvider>
		);
	}
	override componentDidMount() {
		// In accessibility mode, keep the native cursor visible for screen magnifiers and other tools
		if (
			this.props.stdout.isTTY &&
			!isEnvTruthy(process.env.DSH_TUI_ACCESSIBILITY)
		) {
			this.props.stdout.write(HIDE_CURSOR);
		}
	}
	override componentWillUnmount() {
		if (this.props.stdout.isTTY) {
			this.props.stdout.write(SHOW_CURSOR);
		}
		this.detachForShutdown();
	}

	/** Release timers and stdin ownership without requiring a React unmount. */
	detachForShutdown() {
		// Clear any pending timers
		if (this.incompleteEscapeTimer) {
			clearTimeout(this.incompleteEscapeTimer);
			this.incompleteEscapeTimer = null;
		}
		if (this.pendingHyperlinkTimer) {
			clearTimeout(this.pendingHyperlinkTimer);
			this.pendingHyperlinkTimer = null;
		}
		if (this.xtversionProbe) {
			clearImmediate(this.xtversionProbe);
			this.xtversionProbe = null;
		}
		this.querier.dispose();
		// ignore calling setRawMode on an handle stdin it cannot be called
		if (this.isRawModeSupported()) {
			while (this.rawModeEnabledCount > 0) this.handleSetRawMode(false);
		}
	}
	override componentDidCatch(error: Error) {
		this.handleExit(error);
	}
	scheduleXtversionProbe = (): void => {
		if (this.xtversionAttempted || this.xtversionProbe !== null) return;
		this.xtversionProbe = setImmediate(() => {
			this.xtversionProbe = null;
			if (this.rawModeEnabledCount === 0 || this.querier.isSuspended) return;
			void Promise.all([
				this.querier.send(xtversion()),
				this.querier.flush(),
			]).then(([r]) => {
				// A handoff may suspend and drain this batch before its sentinel.
				// Leave it retryable once the reply quarantine has ended.
				if (this.querier.isSuspended) return;
				this.xtversionAttempted = true;
				if (r) {
					setXtversionName(r.name);
					logForDebugging(`XTVERSION: terminal identified as "${r.name}"`);
				} else {
					logForDebugging("XTVERSION: no reply (terminal ignored query)");
				}
			});
		});
	};

	handleSetRawMode = (isEnabled: boolean): void => {
		const { stdin } = this.props;
		if (!this.isRawModeSupported()) {
			if (stdin === process.stdin) {
				throw new Error(
					"Raw mode is not supported on the current process.stdin, which Ink uses as input stream by default.\nRead about how to prevent this error on https://github.com/vadimdemedes/ink/#israwmodesupported",
				);
			} else {
				throw new Error(
					"Raw mode is not supported on the stdin provided to Ink.\nRead about how to prevent this error on https://github.com/vadimdemedes/ink/#israwmodesupported",
				);
			}
		}
		stdin.setEncoding("utf8");
		if (isEnabled) {
			// Ensure raw mode is enabled only once
			if (this.rawModeEnabledCount === 0) {
				// Stop early input capture right before we add our own readable handler.
				// Both use the same stdin 'readable' + read() pattern, so they can't
				// coexist -- our handler would drain stdin before Ink's can see it.
				// The buffered text is preserved for REPL.tsx via consumeEarlyInput().
				stopCapturingEarlyInput();
				stdin.ref();
				stdin.setRawMode(true);
				stdin.addListener("readable", this.handleReadable);
				// Enable bracketed paste mode
				this.props.stdout.write(EBP);
				// Enable terminal focus reporting (DECSET 1004)
				this.props.stdout.write(EFE);
				// Enable extended key reporting so ctrl+shift+<letter> is
				// distinguishable from ctrl+<letter>. On native Windows use
				// win32-input-mode instead: kitty/modifyOtherKeys there never
				// attach modifiers to Enter (microsoft/terminal#530), so
				// Shift+Enter is only visible as a win32 INPUT_RECORD
				// (issue #147). Elsewhere, write both the kitty stack push
				// (CSI >1u) and xterm modifyOtherKeys level 2 (CSI >4;2m) —
				// terminals honor whichever they implement (tmux only accepts
				// the latter).
				if (supportsWin32InputMode()) {
					this.props.stdout.write(ENABLE_WIN32_INPUT_MODE);
				} else if (supportsExtendedKeys()) {
					this.props.stdout.write(ENABLE_KITTY_KEYBOARD);
					this.props.stdout.write(ENABLE_MODIFY_OTHER_KEYS);
				}
				// Probe terminal identity. XTVERSION survives SSH (query/reply goes
				// through the pty), unlike TERM_PROGRAM. Used for wheel-scroll base
				// detection when env vars are absent. Fire-and-forget: the DA1
				// sentinel bounds the round-trip, and if the terminal ignores the
				// query, flush() still resolves and name stays undefined.
				// Deferred to next tick so it fires AFTER the current synchronous
				// init sequence completes — avoids interleaving with alt-screen/mouse
				// tracking enable writes that may happen in the same render cycle.
				this.scheduleXtversionProbe();
			}
			this.rawModeEnabledCount++;
			return;
		}

		// Cleanups may race App unmount, which already drains every borrower.
		if (this.rawModeEnabledCount === 0) return;

		// Disable raw mode only when no components left that are using it
		if (--this.rawModeEnabledCount === 0) {
			this.props.stdout.write(DISABLE_MODIFY_OTHER_KEYS);
			this.props.stdout.write(DISABLE_KITTY_KEYBOARD);
			// No-op on terminals that never entered win32-input-mode
			this.props.stdout.write(DISABLE_WIN32_INPUT_MODE);
			// Disable terminal focus reporting (DECSET 1004)
			this.props.stdout.write(DFE);
			// Disable bracketed paste mode
			this.props.stdout.write(DBP);
			stdin.setRawMode(false);
			stdin.removeListener("readable", this.handleReadable);
			stdin.unref();
		}
	};

	// Helper to flush incomplete escape sequences
	flushIncomplete = (): void => {
		// Clear the timer reference
		this.incompleteEscapeTimer = null;

		// Only proceed if we have incomplete sequences
		if (!this.keyParseState.incomplete) return;

		// Fullscreen: if stdin has data waiting, it's almost certainly the
		// continuation of the buffered sequence (e.g. `[<64;74;16M` after a
		// lone ESC). Node's event loop runs the timers phase before the poll
		// phase, so when a heavy render blocks the loop past 50ms, this timer
		// fires before the queued readable event even though the bytes are
		// already buffered. Re-arm instead of flushing: handleReadable will
		// drain stdin next and clear this timer. Prevents both the spurious
		// Escape key and the lost scroll event.
		if (this.props.stdin.readableLength > 0) {
			this.incompleteEscapeTimer = setTimeout(
				this.flushIncomplete,
				this.NORMAL_TIMEOUT,
			);
			return;
		}

		// Process incomplete as a flush operation (input=null)
		// This reuses all existing parsing logic
		this.processInput(null);
	};

	// Process input through the parser and handle the results
	processInput = (input: string | Buffer | null): void => {
		// Parse input using our state machine
		const [keys, newState] = parseMultipleKeypresses(this.keyParseState, input);
		// Gesture latch: a parser-captured SGR mouse prefix (mouseTailHold
		// transitioned to a value, or the tokenizer's `incomplete` buffer
		// starts with an SGR prefix) is byte-level evidence of a mouse event
		// in flight — possibly a press with the physical button already down.
		// Ink's health probe must not write while the report is in flight.
		// This is a PROTOCOL-CANDIDATE latch, not the physical-button latch:
		// it clears on any complete event (mouse or key), ordinary text,
		// paste/response boundary, or the 1s hold deadline — see ink.tsx's
		// setProtocolCandidateActive for the full contract.
		// Candidate state is the OR of both signals: the latch stays active
		// while EITHER a hold or an SGR-prefixed incomplete buffer remains —
		// a flush can move the prefix from `incomplete` into `mouseTailHold`
		// (or back), and treating either transition alone as a falling edge
		// would drop the latch mid-report.
		const hadCandidate = this.keyParseState.mouseTailHold !== undefined || this.keyParseState.incomplete.startsWith('\x1b[<');
		const hasCandidate = newState.mouseTailHold !== undefined || newState.incomplete.startsWith('\x1b[<');
		if (!hadCandidate && hasCandidate) {
			this.props.onProtocolCandidateChange?.(true);
		} else if (hadCandidate && !hasCandidate) {
			this.props.onProtocolCandidateChange?.(false);
			// Candidate falling edge (timeout, response, paste boundary,
			// completion): a probe/re-entry blocked by the candidate may be
			// pending — schedule a batch-end drain. The drain re-checks the
			// latch state, so a candidate that fell because a press completed
			// (physical latch now held) stays safe.
			this.pendingReleaseTail = true;
		}
		this.keyParseState = newState;

		// Process ALL keys in a SINGLE discreteUpdates call to prevent
		// "Maximum update depth exceeded" error when many keys arrive at once
		// (e.g., from paste operations or holding keys rapidly).
		// This batches all state updates from handleInput and all useInput
		// listeners together within one high-priority update context.
		if (keys.length > 0) {
			reconciler.discreteUpdates(
				processKeysInBatch,
				this,
				keys,
				undefined,
				undefined,
			);
		}

		// If we have incomplete escape sequences, set a timer to flush them
		if (this.keyParseState.incomplete) {
			// Cancel any existing timer first
			if (this.incompleteEscapeTimer) {
				clearTimeout(this.incompleteEscapeTimer);
			}
			// win32Paste.active: a decomposed bracketed paste on classic
			// conhost (markers arrive as win32 key records) gets the same
			// long grace as token-level paste — a mid-paste flush would
			// finalize early and turn the remaining body into real keys.
			const inPaste =
				this.keyParseState.mode === "IN_PASTE" ||
				this.keyParseState.win32Paste?.active === true;
			this.incompleteEscapeTimer = setTimeout(
				this.flushIncomplete,
				inPaste ? this.PASTE_TIMEOUT : this.NORMAL_TIMEOUT,
			);
		}
	};
	handleReadable = (): void => {
		// Detect long stdin gaps (tmux attach, ssh reconnect, laptop wake).
		// The terminal may have reset DEC private modes; re-assert mouse
		// tracking. One Date.now() covers all chunks in this readable event.
		const now = Date.now();
		const resumedAfterGap = now - this.lastStdinTime > STDIN_RESUME_GAP_MS;
		this.lastStdinTime = now;
		try {
			let chunk;
			while ((chunk = this.props.stdin.read() as string | null) !== null) {
				// Process the input chunk
				this.processInput(chunk);
			}
		} catch (error) {
			// In Bun, an uncaught throw inside a stream 'readable' handler can
			// permanently wedge the stream: data stays buffered and 'readable'
			// never re-emits. Catching here ensures the stream stays healthy so
			// subsequent keystrokes are still delivered.
			logError(error);

			// Re-attach the listener in case the exception detached it.
			// Bun may remove the listener after an error; without this,
			// the session freezes permanently (stdin reader dead, event loop alive).
			const { stdin } = this.props;
			if (
				this.rawModeEnabledCount > 0 &&
				!stdin.listeners("readable").includes(this.handleReadable)
			) {
				logForDebugging(
					"handleReadable: re-attaching stdin readable listener after error recovery",
					{
						level: "warn",
					},
				);
				stdin.addListener("readable", this.handleReadable);
			}
		}
		// Fire the resume hook only AFTER this batch is parsed. When the first
		// post-gap input is an SGR mouse press, the physical button is already
		// down — but the press only reaches handleMouseEvent (which engages
		// Ink's gesture latch) inside processInput above. Firing before the
		// read loop would let reassertTerminalModes write its blind
		// ENABLE_MOUSE_TRACKING re-assert mid-press, which resets button
		// tracking on WezTerm/xterm.js-family emulators and silently kills
		// the gesture's motion stream.
		if (resumedAfterGap) {
			this.props.onStdinResume?.();
		}
	};
	handleInput = (input: string | undefined): void => {
		// Exit on Ctrl+C
		if (input === "\x03" && this.props.exitOnCtrlC) {
			this.handleExit();
		}

		// Note: Ctrl+Z (suspend) is now handled in processKeysInBatch using the
		// parsed key to support both raw (\x1a) and CSI u format from Kitty
		// keyboard protocol terminals (Ghostty, iTerm2, kitty, WezTerm)
	};
	handleExit = (error?: Error): void => {
		if (this.isRawModeSupported()) {
			this.handleSetRawMode(false);
		}
		this.props.onExit(error);
	};
	handleTerminalFocus = (isFocused: boolean): void => {
		// setTerminalFocused notifies subscribers: TerminalFocusProvider (context)
		// and Clock (interval speed) — no App setState needed.
		setTerminalFocused(isFocused);
	};
	handleSuspend = (): void => {
		if (!this.isRawModeSupported()) {
			return;
		}

		// Store the exact raw mode count to restore it properly
		const rawModeCountBeforeSuspend = this.rawModeEnabledCount;

		// Completely disable raw mode before suspending
		while (this.rawModeEnabledCount > 0) {
			this.handleSetRawMode(false);
		}

		// Show cursor, disable focus reporting, and disable mouse tracking
		// before suspending. DISABLE_MOUSE_TRACKING is a no-op if tracking
		// wasn't enabled, so it's safe to emit unconditionally — without
		// it, SGR mouse sequences would appear as garbled text at the
		// shell prompt while suspended.
		if (this.props.stdout.isTTY) {
			this.props.stdout.write(SHOW_CURSOR + DFE + DISABLE_MOUSE_TRACKING);
		}

		// Notify the application of suspension. The listener manages its notification
		this.internal_eventEmitter.emit("suspend");

		// Set up resume handler
		const resumeHandler = () => {
			// Restore raw mode to exact previous state
			for (let i = 0; i < rawModeCountBeforeSuspend; i++) {
				if (this.isRawModeSupported()) {
					this.handleSetRawMode(true);
				}
			}

			// Hide cursor (unless in accessibility mode) and re-enable focus reporting after resuming
			if (this.props.stdout.isTTY) {
				if (!isEnvTruthy(process.env.DSH_TUI_ACCESSIBILITY)) {
					this.props.stdout.write(HIDE_CURSOR);
				}
				// Re-enable focus reporting to restore terminal state
				this.props.stdout.write(EFE);
			}

			// Notify the application that the terminal resumed
			this.internal_eventEmitter.emit("resume");
			process.removeListener("SIGCONT", resumeHandler);
		};
		process.on("SIGCONT", resumeHandler);
		process.kill(process.pid, "SIGSTOP");
	};
}

// Helper to process all keys within a single discrete update context.
// discreteUpdates expects (fn, a, b, c, d) -> fn(a, b, c, d)
function processKeysInBatch(
	app: App,
	items: ParsedInput[],
	_unused1: undefined,
	_unused2: undefined,
): void {
	// Mouse-chain diagnostics: the single choke point every parsed mouse and
	// wheel event passes through. Empty log here = the terminal never sent
	// the sequences (tracking modes, ConPTY) rather than an in-app loss.
	if (process.env.DSH_TUI_DEBUG_MOUSE) {
		for (const item of items) {
			if (item.kind === "mouse") {
				logMouseDebug("mouse arrive", {
					button: item.button,
					action: item.action,
					col: item.col,
					row: item.row,
					clicksDisabled: isMouseClicksDisabled(),
				});
			} else if (
				item.kind === "key" &&
				(item.name === "wheelup" || item.name === "wheeldown")
			) {
				logMouseDebug("wheel arrive", { name: item.name });
			} else if (item.kind === "key") {
				logMouseDebug("key arrive", {
					name: item.name,
					seq: (item.sequence ?? "").slice(0, 10),
				});
			}
		}
	}
	// Update interaction time for notification timeout tracking.
	// This is called from the central input handler to avoid having multiple
	// stdin listeners that can cause race conditions and dropped input.
	// Terminal responses (kind: 'response') are automated, not user input.
	// Mode-1003 no-button motion is also excluded — passive cursor drift is
	// not engagement (would suppress idle notifications + defer housekeeping).
	if (
		items.some(
			(i) =>
				i.kind === "key" ||
				(i.kind === "mouse" &&
					!((i.button & 0x20) !== 0 && (i.button & 0x03) === 3)),
		)
	) {
		updateLastInteractionTime();
	}
	for (let i = 0; i < items.length; i++) {
		const item = items[i]!;
		// Terminal responses (DECRPM, DA1, OSC replies, etc.) are not user
		// input — route them to the querier to resolve pending promises.
		if (item.kind === "response") {
			app.querier.onResponse(item.response);
			continue;
		}

		// Mouse click/drag events update selection state (fullscreen only).
		// Terminal sends 1-indexed col/row; convert to 0-indexed for the
		// screen buffer. Button bit 0x20 = drag (motion while button held).
		// Process EVERY no-button motion boundary: A→outside→A in one stdin
		// chunk must emit leave/re-enter so tooltip dwell restarts. Inert motion
		// remains cheap through dispatchHover's per-root no-interest rect, and
		// exact same-cell repeats are dropped by handleMouseEvent's coordinates.
		if (item.kind === "mouse") {
			handleMouseEvent(app, item);
			continue;
		}
		const sequence = item.sequence;

		// Handle terminal focus events (DECSET 1004)
		if (sequence === FOCUS_IN) {
			app.handleTerminalFocus(true);
			// Refocus is the first observable moment after a terminal-side
			// mode reset (conpty drops 1049/mouse on DPI moves, renderer
			// restarts, window snapping): probe and self-heal. Deferred to
			// the batch tail — a single stdin chunk can carry FOCUS_IN +
			// press, and the probe must not write before the press latch
			// is established.
			app.pendingFocusProbe = true;
			const event = new TerminalFocusEvent("terminalfocus");
			app.internal_eventEmitter.emit("terminalfocus", event);
			continue;
		}
		if (sequence === FOCUS_OUT) {
			app.handleTerminalFocus(false);
			// Gesture latch: focus loss means no release event is coming for
			// a held button (released outside the window or swallowed by the
			// OS) — clear the held-button set so the health probe may write
			// again.
			app.heldButtons = 0;
			app.ambiguousHeld = false;
			app.props.onPointerGestureChange?.(false);
			// Drag protocol: focus loss also orphans an in-flight drag
			// session — settle it with a dragend (if started) like the
			// selection recovery below.
			app.finishDragSession();
			// Defensive: if we lost the release event (mouse released outside
			// terminal window — some emulators drop it rather than capturing the
			// pointer), focus-out is the next observable signal that the drag is
			// over. Without this, drag-to-scroll's timer runs until the scroll
			// boundary is hit.
			if (app.props.selection.isDragging) {
				finishSelection(app.props.selection);
				app.props.onSelectionChange();
			}
			// Safe boundary: mark the batch for a deferred drain at the batch
			// tail (not mid-batch — see release's finally).
			app.pendingReleaseTail = true;
			const event = new TerminalFocusEvent("terminalblur");
			app.internal_eventEmitter.emit("terminalblur", event);
			continue;
		}

		// Failsafe: if we receive input, the terminal must be focused
		if (!getTerminalFocused()) {
			setTerminalFocused(true);
		}

		// Handle Ctrl+Z (suspend) using parsed key to support both raw (\x1a) and
		// CSI u format (\x1b[122;5u) from Kitty keyboard protocol terminals
		if (item.name === "z" && item.ctrl && SUPPORTS_SUSPEND) {
			app.handleSuspend();
			continue;
		}
		// Wheel keys carry the pointer position (SGR/X10 col/row). Route
		// position-first: if a scroll container sits under the pointer, its
		// onWheel consumes the event and the legacy global keybinding path
		// never fires — exactly one layer scrolls. Events without coords
		// (shouldn't happen for wheel) or over non-scroll areas fall
		// through to the normal input path (Chat scrolls the transcript).
		// Skipped during the post-handoff suppression window: a terminal
		// replay burst can contain mouse-wheel fragments, and use-input's
		// choke point never sees events consumed here.
		if (
			(item.name === "wheelup" ||
				item.name === "wheeldown" ||
				item.name === "wheelleft" ||
				item.name === "wheelright") &&
			item.mouseCol !== undefined &&
			item.mouseRow !== undefined &&
			!isInputSuppressed()
		) {
			const step =
				(item.name === "wheelup" || item.name === "wheelleft") ? -3 : 3;
			const deltaY =
				item.name === "wheelup" || item.name === "wheeldown" ? step : 0;
			const deltaX =
				item.name === "wheelleft" || item.name === "wheelright" ? step : 0;
			const consumed = app.props.onWheelAt(
				item.mouseCol,
				item.mouseRow,
				deltaY,
				deltaX,
				item.mouseButton,
			);
			if (consumed) {
				logMouseDebug("wheel routed by position", {
					col: item.mouseCol,
					row: item.mouseRow,
					deltaY,
					deltaX,
					name: item.name,
				});
				continue;
			}
		}
		app.handleInput(sequence);
		const event = new InputEvent(item);
		app.internal_eventEmitter.emit("input", event);

		// Also dispatch through the DOM tree so onKeyDown handlers fire.
		app.props.dispatchKeyboardEvent(item);
	}

	// Batch tail: drain the deferred alt-screen re-entry / blocked probe if
	// any release, focus-out, or no-button motion cleared the gesture latch
	// during this batch. The drain is deferred to the batch tail so a single
	// stdin chunk carrying `release → next press` doesn't write probe bytes
	// into the next gesture's opening window.
	if (app.pendingReleaseTail) {
		app.pendingReleaseTail = false;
		app.props.onReleaseTail?.();
	}
	// Focus-in probe is also deferred to the batch tail: a single stdin chunk
	// can carry FOCUS_IN + press, and the probe must not write before the
	// press latch is established.
	if (app.pendingFocusProbe) {
		app.pendingFocusProbe = false;
		app.props.onTerminalFocus?.(true);
	}
	// Release-click probe deferred via deferProbe fires at the batch tail.
	if (app.pendingClickProbe) {
		app.pendingClickProbe = false;
		app.props.onClickProbe?.();
	}
}

/** Exported for testing. Mutates app.props.selection and click/hover state. */
export function handleMouseEvent(app: App, m: ParsedMouse): void {
	const sel = app.props.selection;
	// Terminal coords are 1-indexed; screen buffer is 0-indexed. Clamp to
	// the current frame's dimensions: a resize (or a terminal reporting a
	// stale position) can deliver coordinates outside the screen buffer,
	// and selection/hyperlink reads assume in-bounds cells.
	const col = Math.max(0, Math.min(m.col - 1, app.props.terminalColumns - 1));
	const row = Math.max(0, Math.min(m.row - 1, app.props.terminalRows - 1));
	const baseButton = m.button & 0x03;

	// Transport-layer button state: track held buttons BEFORE the
	// click-disabled gate, so DSH_TUI_DISABLE_MOUSE=1 still maintains the
	// physical latch (probe must not write while a button is held even if
	// clicks are disabled). SGR encodes button identity in the low 2 bits;
	// X10's generic release (low bits 3) cannot identify which button ended,
	// so it conservatively enters an ambiguous-held state — the probe stays
	// blocked until a reliable termination signal (no-button motion,
	// focus-out, or a fresh press identifying the still-held button).
	const wasLatched = app.heldButtons !== 0 || app.ambiguousHeld;
	if (m.action === "press") {
		if ((m.button & 0x20) !== 0 && baseButton === 3) {
			// Mode-1003 no-button motion: no button held.
			app.heldButtons = 0;
			app.ambiguousHeld = false;
		} else {
			// Real press: add the button to the held set.
			app.heldButtons |= 1 << baseButton;
			app.ambiguousHeld = false;
		}
	} else {
		// Release: SGR encodes the released button; X10's generic release
		// (low bits 3) cannot identify which button ended — conservatively
		// keep the probe blocked (ambiguous-held) until a reliable
		// termination signal arrives.
		if (baseButton === 3) {
			app.heldButtons = 0;
			app.ambiguousHeld = true;
		} else {
			app.heldButtons &= ~(1 << baseButton);
		}
	}
	const isLatched = app.heldButtons !== 0 || app.ambiguousHeld;
	app.props.onPointerGestureChange?.(isLatched);
	// Falling edge (latched → unlatched) is a recovery boundary: schedule a
	// batch-end drain even when the click policy below will consume or skip
	// the event — pending probe/re-entry recovery must not depend on click
	// policy. The drain itself re-checks the latch state at the batch tail,
	// so a `release → next press` chunk stays safe.
	if (wasLatched && !isLatched) {
		app.pendingReleaseTail = true;
	}

	// Allow disabling click handling while keeping wheel scroll (which goes
	// through the keybinding system as 'wheelup'/'wheeldown', not here).
	if (isMouseClicksDisabled()) return;
	if (m.action === "press") {
		if ((m.button & 0x20) !== 0 && baseButton === 3) {
			// Mode-1003 motion with no button held. Dispatch hover; skip the
			// rest of this handler (no selection, no click-count side effects).
			// Lost-release recovery: no-button motion while isDragging=true means
			// the release happened outside the terminal window (iTerm2 doesn't
			// capture the pointer past window bounds, so the SGR 'm' never
			// arrives). Finish the selection here so copy-on-select fires. The
			// FOCUS_OUT handler covers the "switched apps" case but not "released
			// past the edge, came back" — and tmux drops focus events unless
			// `focus-events on` is set, so this is the more reliable signal.
			if (sel.isDragging) {
				finishSelection(sel);
				app.props.onSelectionChange();
			}
			// Transport layer above already cleared heldButtons/ambiguousHeld
			// and fired onPointerGestureChange — no duplicate unlatch here.
			// Drag protocol: no-button motion during a drag session means
			// the release was dropped (pointer left the window) — settle
			// the session before the hover path takes over.
			app.finishDragSession();
			// Safe boundary: mark the batch for a deferred drain at the batch
			// tail (not mid-batch — see release's finally).
			app.pendingReleaseTail = true;
			if (col === app.lastHoverCol && row === app.lastHoverRow) return;
			app.lastHoverCol = col;
			app.lastHoverRow = row;
			app.props.onHoverAt(col, row);
			return;
		}
		// X10 cannot report releases. A fresh button press after a captured
		// drag is therefore the first reliable evidence that the old gesture
		// ended; settle it before this press can open a replacement session.
		// The same fallback is harmless for malformed/duplicated SGR streams.
		if ((m.button & 0x20) === 0 && app.dragSession) {
			app.finishDragSession();
		}
		// Held-button state is updated in the transport layer above (before
		// the click-disabled gate); no separate latch call needed here.
		if (baseButton !== 0) {
			// Non-left press breaks the multi-click chain.
			app.clickCount = 0;
			// Right-button press fires a contextmenu (DOM semantics: the
			// menu shows on mousedown, not release). Dispatch BEFORE
			// returning so the hit-test sees the frame the pointer is
			// over; the row's own handler decides whether focus follows.
			// Right-drag (motion bit) is a selection gesture, not a menu
			// — skip it.
			if (baseButton === 2 && (m.button & 0x20) === 0) {
				app.props.onContextMenuAt(col, row, m.button);
			}
			return;
		}
		if ((m.button & 0x20) !== 0) {
			// Drag protocol motion: a live drag session owns the gesture —
			// first motion fires dragstart (DOM: dragstart fires on first
			// move, not press), then dragmove. Selection drag is skipped
			// entirely (startSelection never ran for this press).
			const session = app.dragSession;
			if (session) {
				// Anchor-cell exemption (parity with selection.ts): motion
				// landing on the press cell is hand jitter, not a drag —
				// keep the session dormant so release resolves to the plain
				// click path (and the input's double-click detector sees
				// the press). Without it, trackpads/1002 terminals turn a
				// wobbly click into a 1-cell drag selection.
				if (col === session.startCol && row === session.startRow) {
					return;
				}
				session.lastCol = col;
				session.lastRow = row;
				if (!session.started) {
					session.started = true;
					app.props.onDragDispatch?.(
						session.target,
						new DragEvent(
							"dragstart",
							col,
							row,
							session.startCol,
							session.startRow,
							{ button: m.button },
						),
					);
				}
				app.props.onDragDispatch?.(
					session.target,
					new DragEvent(
						"dragmove",
						col,
						row,
						session.startCol,
						session.startRow,
						{ button: m.button },
					),
				);
				return;
			}
			// Drag motion: mode-aware extension (char/word/line). onSelectionDrag
			// calls notifySelectionChange internally — no extra onSelectionChange.
			app.props.onSelectionDrag(col, row);
			return;
		}
		// Lost-release fallback for mode-1002-only terminals: a fresh press
		// while isDragging=true means the previous release was dropped (cursor
		// left the window). Finish that selection so copy-on-select fires
		// before startSelection/onMultiClick clobbers it. Mode-1003 terminals
		// hit the no-button-motion recovery above instead, so this is rare.
		if (sel.isDragging) {
			finishSelection(sel);
			app.props.onSelectionChange();
		}
		// Drag protocol: an UNMODIFIED left press over a node whose
		// ancestor chain carries an onDragStart handler opens a drag
		// session INSTEAD of text selection / multi-click. Modifier bits
		// (0x04 shift / 0x08 alt / 0x10 ctrl) keep the baseline selection
		// gesture — they never hijack. The session stays dormant until the
		// first drag motion; a press+release without movement resolves to
		// a normal click on release (see the release branch).
		if (app.props.onDragTargetAt && (m.button & 0x1c) === 0) {
			const dragTarget = app.props.onDragTargetAt(col, row);
			if (dragTarget) {
				app.dragSession = {
					target: dragTarget,
					startCol: col,
					startRow: row,
					lastCol: col,
					lastRow: row,
					started: false,
				};
				// A drag press must not feed the multi-click chain.
				app.clickCount = 0;
				return;
			}
		}
		// Modifier presses (shift/alt/ctrl) are selection-extension
		// gestures — Shift+click extends the input selection via the click
		// path, never a double-click word selection. Break the multi-click
		// chain here: two Shift+clicks inside the 500ms/1-cell window must
		// not fire onMultiClick (screen word select would swallow the click
		// dispatch and overwrite the clipboard).
		if ((m.button & 0x1c) !== 0) {
			app.clickCount = 0;
			app.lastClickTime = 0;
			app.lastClickCol = -1;
			app.lastClickRow = -1;
			// Do not immediately seed the chain again: a Shift+click followed by
			// a plain click in the same cell must remain two single clicks.
			startSelection(sel, col, row);
			sel.lastPressHadAlt = (m.button & 0x08) !== 0;
			app.props.onSelectionChange();
			return;
		}
		// Fresh left press. Detect multi-click HERE (not on release) so the
		// word/line highlight appears immediately and a subsequent drag can
		// extend by word/line like native macOS. Previously detected on
		// release, which meant (a) visible latency before the word highlights
		// and (b) double-click+drag fell through to char-mode selection.
		const now = Date.now();
		const nearLast =
			now - app.lastClickTime < MULTI_CLICK_TIMEOUT_MS &&
			Math.abs(col - app.lastClickCol) <= MULTI_CLICK_DISTANCE &&
			Math.abs(row - app.lastClickRow) <= MULTI_CLICK_DISTANCE;
		app.clickCount = nearLast ? app.clickCount + 1 : 1;
		app.lastClickTime = now;
		app.lastClickCol = col;
		app.lastClickRow = row;
		if (app.clickCount >= 2) {
			// Cancel any pending hyperlink-open from the first click — this is
			// a double-click, not a single-click on a link.
			if (app.pendingHyperlinkTimer) {
				clearTimeout(app.pendingHyperlinkTimer);
				app.pendingHyperlinkTimer = null;
			}
			// Cap at 3 (line select) for quadruple+ clicks.
			const count = app.clickCount === 2 ? 2 : 3;
			app.props.onMultiClick(col, row, count);
			return;
		}
		startSelection(sel, col, row);
		// SGR bit 0x08 = alt (xterm.js wires altKey here, not metaKey — see
		// comment at the hyperlink-open guard below). On macOS xterm.js,
		// receiving alt means macOptionClickForcesSelection is OFF (otherwise
		// xterm.js would have consumed the event for native selection).
		sel.lastPressHadAlt = (m.button & 0x08) !== 0;
		app.props.onSelectionChange();
		return;
	}

	// Release: settle a captured component drag BEFORE filtering on the raw
	// low button bits. Some terminals encode release as button=3 (legacy
	// "no button") or retain the motion bit. A started session still needs
	// dragend; a dormant press still needs its ordinary click replay.
	// Held-button state is updated in the transport layer above (before the
	// click-disabled gate); the release branch only handles selection/click
	// policy.
	try {
		let replayedDormantDrag = false;
		if (app.dragSession) {
			const session = app.dragSession;
			app.dragSession = null;
			if (session.started) {
				app.props.onDragDispatch?.(
					session.target,
					new DragEvent(
						"dragend",
						col,
						row,
						session.startCol,
						session.startRow,
						{ button: m.button },
					),
				);
				return;
			}
			startSelection(sel, col, row);
			replayedDormantDrag = true;
		}
		// Classic X10 encodes every release as low bits 3. If a left selection is
		// active, pair that generic release with it and continue through the normal
		// click/selection tail; an unrelated middle/right release has no active
		// selection and remains inert.
		if (baseButton !== 0 && !replayedDormantDrag && !sel.isDragging) return;
		finishSelection(sel);
		// NOTE: unlike the old release-based detection we do NOT reset clickCount
		// on release-after-drag. This aligns with NSEvent.clickCount semantics:
		// an intervening drag doesn't break the click chain. Practical upside:
		// trackpad jitter during an intended double-click (press→wobble→release
		// →press) now correctly resolves to word-select instead of breaking to a
		// fresh single click. The nearLast window (500ms, 1 cell) bounds the
		// effect — a deliberate drag past that just starts a fresh chain.
		// A press+release with no drag in char mode is a click: anchor set,
		// focus null → hasSelection false. In word/line mode the press already
		// set anchor+focus (hasSelection true), so release just keeps the
		// highlight. The anchor check guards against an orphaned release (no
		// prior press — e.g. button was held when mouse tracking was enabled).
		if (!hasSelection(sel) && sel.anchor) {
			// Single click: dispatch DOM click immediately (cursor repositioning
			// etc. are latency-sensitive). If no DOM handler consumed it, defer
			// the hyperlink check so a second click can cancel it. deferProbe:
			// the health probe is deferred to the batch tail — a single stdin
			// chunk can carry `release → next press`, and the probe must not
			// write before the next press latch is established.
			app.pendingClickProbe = true;
			if (!app.props.onClickAt(col, row, m.button, true)) {
				// Resolve the hyperlink URL synchronously while the screen buffer
				// still reflects what the user clicked — deferring only the
				// browser-open so double-click can cancel it.
				const url = app.props.getHyperlinkAt(col, row);
				// xterm.js (VS Code, Cursor, Windsurf, etc.) has its own OSC 8 link
				// handler that fires on Cmd+click *without consuming the mouse event*
				// (Linkifier._handleMouseUp calls link.activate() but never
				// preventDefault/stopPropagation). The click is also forwarded to the
				// pty as SGR, so both VS Code's terminalLinkManager AND our handler
				// here would open the URL — twice. We can't filter on Cmd: xterm.js
				// drops metaKey before SGR encoding (ICoreMouseEvent has no meta
				// field; the SGR bit we call 'meta' is wired to alt). Let xterm.js
				// own link-opening; Cmd+click is the native UX there anyway.
				// TERM_PROGRAM is the sync fast-path; isXtermJs() is the XTVERSION
				// probe result (catches SSH + non-VS Code embedders like Hyper).
				if (url && process.env.TERM_PROGRAM !== "vscode" && !isXtermJs()) {
					// Clear any prior pending timer — clicking a second link
					// supersedes the first (only the latest click opens).
					if (app.pendingHyperlinkTimer) {
						clearTimeout(app.pendingHyperlinkTimer);
					}
					app.pendingHyperlinkTimer = setTimeout(
						(app, url) => {
							app.pendingHyperlinkTimer = null;
							app.props.onOpenHyperlink(url);
						},
						MULTI_CLICK_TIMEOUT_MS,
						app,
						url,
					);
				}
			}
		}
		app.props.onSelectionChange();
	} finally {
		// The gesture latch cleared at the START of this release. Mark the
		// batch for a deferred drain at the batch tail — a single stdin chunk
		// can carry `release → next press`, and draining between them would
		// write probe bytes into the next gesture's opening window.
		app.pendingReleaseTail = true;
	}
}
