/**
 * Generic pointer event contract.
 *
 * The dispatch runtime lives in `TuiAltScreen` (tui-alt-screen.ts); the
 * semantics below are the contract it honors and component authors write
 * handlers against.
 *
 * Dispatch contract:
 * - Events bubble from the deepest hit component up to the root; layers
 *   without a `handlePointer` handler are skipped.
 * - Each dispatch level receives a fresh event object (`localX`/`localY` are
 *   recomputed against that level's layout rect); handlers must not mutate or
 *   retain the event they receive.
 * - A `press` that is consumed captures the pointer: subsequent `move` and
 *   `release` events are directed at the same hit chain until the release,
 *   and a `release` is always dispatched to pair with the captured `press`.
 * - `click` is only dispatched for a `release` on the same cell as its
 *   `press` with no intervening drag. A consumed `click` suppresses the
 *   fallback copy/OSC 8 link behavior; an unconsumed `click` falls through.
 * - Handler exceptions are isolated (treated as consumed, never rethrown;
 *   logged to pi-debug.log when PI_DEBUG_POINTER=1), so a faulty handler
 *   cannot kill the input loop.
 * - `enter`/`leave`/`move` are only available with all-motion tracking
 *   (DECSET 1003). Terminal multiplexers typically only negotiate
 *   press/release/wheel, so handlers must never hard-depend on hover.
 */
export type PointerEventType = "press" | "release" | "move" | "click" | "wheel" | "enter" | "leave";

export interface PointerEvent {
	/** Event kind. */
	type: PointerEventType;
	/** 0-based terminal cell column, in the last committed frame's coordinate space. */
	x: number;
	/** 0-based terminal cell row, in the last committed frame's coordinate space. */
	y: number;
	/**
	 * Column relative to the current dispatch target's layout rect origin.
	 * May be negative or beyond the rect when the event was captured or the
	 * cell is clipped. For ScrollView content this is content-space, because
	 * the content rect's origin is already translated by the scroll offset.
	 */
	localX: number;
	/** Row relative to the current dispatch target's layout rect origin (see {@link localX}). */
	localY: number;
	/** Decoded button: 0 = left, 1 = middle, 2 = right; -1 for move/wheel/enter/leave. */
	button: number;
	shift: boolean;
	alt: boolean;
	ctrl: boolean;
	/** Horizontal wheel delta in cells (0 when not a wheel event). */
	deltaX: number;
	/**
	 * Vertical wheel delta in cells (0 when not a wheel event).
	 * Negative scrolls up, matching the sign convention of ScrollView.scrollBy.
	 */
	deltaY: number;
	/** True when the hit cell has no painted content in the committed frame. */
	cellIsBlank: boolean;
}
