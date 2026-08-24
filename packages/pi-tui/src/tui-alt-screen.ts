import * as fs from "node:fs";
import * as path from "node:path";
import {
	AltScreenSearchComponent,
	type AltScreenSearchMatch,
	findAltScreenSearchMatches,
	getAltScreenSearchMatchKey,
} from "./alt-screen-search.ts";
import { AltScreenFlashContainer } from "./components/alt-screen-flash.ts";
import { ScrollView } from "./components/scroll-view.ts";
import { getKeybindings } from "./keybindings.ts";
import { isKeyRelease } from "./keys.ts";
import {
	getHitChainAt,
	getScrollbarGeometry,
	getScrollViewBox,
	getScrollViewsAt,
	type LayoutBox,
	type LayoutFrame,
	type LayoutRect,
	renderLayoutFrame,
	type ScrollbarGeometry,
} from "./layout.ts";
import type { PointerEvent, PointerEventType } from "./pointer.ts";
import type { Terminal } from "./terminal.ts";
import {
	deleteAllKittyImages,
	deleteAllKittyPlacements,
	deleteKittyImage,
	getCapabilities,
	getKittyImagePlacement,
	type ImageProtocol,
	isImageLine,
	setCapabilities,
	type TerminalCapabilities,
} from "./terminal-image.ts";
import {
	type Component,
	CURSOR_MARKER,
	compositeTuiLine,
	type OverlayHandle,
	TuiBase,
	type TuiStopOptions,
	VIEWPORT_TUI,
	type ViewportTUI,
} from "./tui.ts";
import {
	extractAnsiCode,
	getGraphemeCellRange,
	getOsc8LinkAtColumn,
	getWordSegmenter,
	sliceByColumn,
	stripTerminalSequences,
	visibleWidth,
} from "./utils.ts";

const ENTER_ALT_SCREEN = "\x1b[?1049h";
const EXIT_ALT_SCREEN = "\x1b[?1049l";
const DISABLE_AUTOWRAP = "\x1b[?7l";
const ENABLE_AUTOWRAP = "\x1b[?7h";
const ENABLE_BUTTON_MOTION_MOUSE = "\x1b[?1000h\x1b[?1002h\x1b[?1004h\x1b[?1006h";
const ENABLE_ALL_MOTION_MOUSE = "\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1004h\x1b[?1006h";
const DISABLE_MOUSE = "\x1b[?1006l\x1b[?1004l\x1b[?1003l\x1b[?1002l\x1b[?1000l";
const FOCUS_IN = "\x1b[I";
const FOCUS_OUT = "\x1b[O";
const BEGIN_SYNCHRONIZED_OUTPUT = "\x1b[?2026h";
const END_SYNCHRONIZED_OUTPUT = "\x1b[?2026l";
const OSC133_ZONE_PREFIX = /^(?:\x1b\]133;[ABC](?:\x07|\x1b\\))+/;
const OSC133_PROMPT_START = /^\x1b\]133;A(?:\x07|\x1b\\)/;
const PAGE_SCROLL_OVERLAP = 4;
const MAX_CACHED_OFFSCREEN_KITTY_IMAGES = 16;
const MAX_CACHED_OFFSCREEN_KITTY_TRANSMISSION_BYTES = 32 * 1024 * 1024;
const MAX_CACHED_OFFSCREEN_KITTY_DECODED_BYTES = 64 * 1024 * 1024;
const DOUBLE_CLICK_INTERVAL_MS = 500;
const wordSegmenter = getWordSegmenter();

interface CachedKittyImage {
	transmissionGeneration: number;
	transmissionBytes: number;
	estimatedDecodedBytes: number;
}

interface SelectionPoint {
	row: number;
	col: number;
	scrollView?: ScrollView;
	/** Whether this point lies between terminal cells rather than on a cell. */
	boundary?: boolean;
}

interface SelectionRange {
	start: SelectionPoint;
	end: SelectionPoint;
}

type SelectionGranularity = "character" | "word" | "line";

interface ClickTarget {
	timestamp: number;
	count: number;
	row: number;
	scrollView?: ScrollView;
	wordStart: number;
	wordEnd: number;
}

/** Mouse event decoded from an SGR (`ESC[<b;x;yM/m`) or X10 (`ESC[M` + 3 bytes) sequence. */
interface SgrMouseEvent {
	button: number;
	x: number;
	y: number;
	release: boolean;
}

/**
 * Protocol-decoded pointer input ready for dispatch: button/modifiers extracted
 * from the raw protocol bits, wheel deltas folded in.
 */
interface PointerDispatchSource {
	x: number;
	y: number;
	/** 0 = left, 1 = middle, 2 = right; -1 for move/wheel/enter/leave and X10 releases. */
	button: number;
	shift: boolean;
	alt: boolean;
	ctrl: boolean;
	deltaX: number;
	deltaY: number;
}

/**
 * Pointer capture established by a consumed press: the components that received
 * the press, deepest-first. Rects are re-resolved per event (against
 * `overlayHitRegions` first, then the committed layout frame) so capture
 * survives re-renders and scrolling.
 */
interface PointerCaptureState {
	components: Component[];
}

function rectContainsPoint(rect: LayoutRect, x: number, y: number): boolean {
	return x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height;
}

interface WheelEvent {
	direction: -1 | 1;
	x: number;
	y: number;
}

interface ScrollbarDrag {
	scrollView: ScrollView;
	grabOffset: number;
}

interface ScrollbarTarget {
	scrollView: ScrollView;
	geometry: ScrollbarGeometry;
}

type SearchSelectionMode = "query" | "retain" | "next" | "previous";

interface ActiveSearch {
	component: AltScreenSearchComponent;
	overlay?: OverlayHandle;
	query: string;
	matches: AltScreenSearchMatch[];
	selectedIndex: number;
	selectedKey?: string;
	anchorRow: number;
	selectionMode: SearchSelectionMode;
}

interface SearchHighlightRange {
	startCol: number;
	endCol: number;
	current: boolean;
}

/**
 * Granular mouse capture control. `wheel` keeps wheel-scroll routing
 * (component dispatch first, then ScrollView routing); `buttons` covers every
 * button-driven interaction: pointer press/release/click/hover dispatch,
 * application-owned text selection, scrollbar hover/drag and right-click
 * paste. `buttons: false` with `wheel` on gives scroll-only mouse support —
 * clicks fall to no handler rather than starting a selection. Mouse tracking
 * stays enabled while either flag is on, so the terminal's native selection
 * remains intercepted (same trade-off as a full `mouse: true`).
 */
export interface TuiMouseOptions {
	/** Route wheel events (default true). */
	wheel?: boolean;
	/** Dispatch button-driven pointer events and text selection (default true). */
	buttons?: boolean;
}

export interface TuiAltScreenOptions {
	/** Number of logical lines moved for each mouse-wheel event. */
	wheelScrollLines?: number;
	/**
	 * Capture mouse events for viewport scrolling and application-owned text
	 * selection. `false` never enables terminal mouse tracking (the terminal's
	 * native behavior is untouched); an object enables tracking but gates the
	 * two interaction families independently (see {@link TuiMouseOptions}).
	 */
	mouse?: boolean | TuiMouseOptions;
	/** Style a non-current transcript search match. */
	searchMatchStyle?: (text: string) => string;
	/** Style the current transcript search match. */
	searchCurrentMatchStyle?: (text: string) => string;
	/** Open an OSC 8 hyperlink activated with a primary-button click. */
	openUrl?: (url: string) => void;
	/** Handle an unmodified secondary-button press for clipboard paste. Currently enabled on Windows only. */
	onRightClickPaste?: () => void;
	/**
	 * Copy selected text to the system clipboard. Return `true` on success; the caller flashes
	 * an error otherwise. When omitted, the selection is copied via an OSC 52 write.
	 */
	copySelection?: (text: string) => Promise<boolean>;
}

/** Alternate-screen TUI with a scrollable, application-owned viewport. */
export class TuiAltScreen extends TuiBase implements ViewportTUI {
	readonly mode = "fullscreen" as const;
	readonly [VIEWPORT_TUI] = true as const;
	private previousScreen: string[] = [];
	private lastDocument: string[] = [];
	private previousScreenWidth = 0;
	private previousScreenHeight = 0;
	private layoutRoot: Component | undefined;
	private currentLayout: LayoutFrame | undefined;
	private readonly implicitDocument: Component;
	private readonly implicitScrollView: ScrollView;
	private readonly flashes: AltScreenFlashContainer;
	private altScreenActive = false;
	private imageProtocol: ImageProtocol = null;
	private savedCapabilities?: TerminalCapabilities;
	private readonly uploadedKittyImages = new Map<number, CachedKittyImage>();
	private selectionAnchor?: SelectionPoint;
	private selectionFocus?: SelectionPoint;
	private selectionGranularity: SelectionGranularity = "character";
	private selectionInitialRange?: SelectionRange;
	private lastClick?: ClickTarget;
	private selectionDragPointer?: { x: number; y: number };
	private selectionAutoScrollDirection: -1 | 0 | 1 = 0;
	private selectionAutoScrollTimer?: NodeJS.Timeout;
	private selectionPressActive = false;
	private scrollbarDrag?: ScrollbarDrag;
	private scrollbarHover?: ScrollView;
	private pointerCapture?: PointerCaptureState;
	private pointerPressCell?: { x: number; y: number };
	private pointerHoverChain: Component[] = [];
	private lastHoverCell?: { x: number; y: number };
	private lastPointerCell?: { x: number; y: number };
	private activeSearch?: ActiveSearch;
	private pressedUrl?: string;
	private selectionDragged = false;
	private readonly wheelScrollLines: number;
	private readonly mouseEnabled: boolean;
	private readonly mouseWheel: boolean;
	private readonly mouseButtons: boolean;
	private readonly searchMatchStyle: (text: string) => string;
	private readonly searchCurrentMatchStyle: (text: string) => string;
	private readonly openUrl?: (url: string) => void;
	private readonly onRightClickPaste?: () => void;
	private readonly copySelection?: (text: string) => Promise<boolean>;

	constructor(
		terminal: Terminal,
		showHardwareCursor?: boolean,
		logDirectory?: string,
		options: TuiAltScreenOptions = {},
	) {
		super(terminal, showHardwareCursor, logDirectory);
		this.implicitDocument = {
			render: (width) => super.render(width),
			invalidate: () => {
				for (const child of this.children) child.invalidate();
			},
		};
		this.implicitScrollView = new ScrollView(this.implicitDocument, { follow: "end", primary: true });
		this.flashes = new AltScreenFlashContainer(() => this.requestRender());
		this.wheelScrollLines = Math.max(1, Math.floor(options.wheelScrollLines ?? 1));
		const mouse = options.mouse ?? true;
		this.mouseWheel = typeof mouse === "object" ? (mouse.wheel ?? true) : mouse;
		this.mouseButtons = typeof mouse === "object" ? (mouse.buttons ?? true) : mouse;
		// Terminal mouse tracking stays on while either family is enabled; with
		// tracking off entirely the terminal never sends mouse sequences.
		this.mouseEnabled = this.mouseWheel || this.mouseButtons;
		this.searchMatchStyle = options.searchMatchStyle ?? ((text) => `\x1b[4m${text}\x1b[24m`);
		this.searchCurrentMatchStyle = options.searchCurrentMatchStyle ?? ((text) => `\x1b[1;7m${text}\x1b[22;27m`);
		this.openUrl = options.openUrl;
		this.onRightClickPaste = options.onRightClickPaste;
		this.copySelection = options.copySelection;
		this.addInputListener((data) => this.handleViewportInput(data));
	}

	get viewportTop(): number {
		return this.getPrimaryScrollView().scrollTop;
	}

	get isFollowingOutput(): boolean {
		return this.getPrimaryScrollView().isFollowingEnd;
	}

	setLayoutRoot(component: Component | undefined): void {
		if (this.layoutRoot === component) return;
		this.layoutRoot = component;
		this.currentLayout = undefined;
		this.requestRender();
	}

	override render(width: number): string[] {
		return this.layoutRoot?.render(width) ?? super.render(width);
	}

	protected override getMountedRoots(): readonly Component[] {
		return this.layoutRoot ? [this.layoutRoot] : this.children;
	}

	private getPrimaryScrollView(): ScrollView {
		return this.currentLayout?.primaryScrollView ?? this.implicitScrollView;
	}

	protected override beforeTerminalStart(): void {
		this.stopSelectionAutoScroll();
		this.selectionPressActive = false;
		this.stopScrollbarHover();
		this.stopScrollbarDrag();
		this.clearPointerInteraction(false);
		this.flashes.dispose();
		this.altScreenActive = true;
		const capabilities = getCapabilities();
		this.imageProtocol = capabilities.images;
		this.uploadedKittyImages.clear();
		if (capabilities.images === "iterm2") {
			this.savedCapabilities = capabilities;
			setCapabilities({ ...capabilities, images: null });
			this.invalidate();
		}
		this.lastDocument = [];
		this.selectionAnchor = undefined;
		this.selectionFocus = undefined;
		this.selectionGranularity = "character";
		this.selectionInitialRange = undefined;
		this.lastClick = undefined;
		this.pressedUrl = undefined;
		this.selectionDragged = false;
		this.resetRenderState();
		const term = process.env.TERM?.toLowerCase() ?? "";
		// Multiplexers can lag when every pointer movement is forwarded. Button-motion
		// tracking preserves clicks, wheel events, selections, and scrollbar dragging.
		const mouseSequence =
			process.env.TMUX !== undefined ||
			process.env.ZELLIJ !== undefined ||
			process.env.STY !== undefined ||
			term.startsWith("tmux") ||
			term.startsWith("screen")
				? ENABLE_BUTTON_MOTION_MOUSE
				: ENABLE_ALL_MOTION_MOUSE;
		this.terminal.write(
			`${ENTER_ALT_SCREEN}${DISABLE_AUTOWRAP}${this.mouseEnabled ? mouseSequence : ""}\x1b[2J\x1b[H\x1b[?25l`,
		);
	}

	protected override beforeTerminalStop(_options: TuiStopOptions): void {
		this.closeSearch();
		this.stopSelectionAutoScroll();
		this.selectionPressActive = false;
		this.stopScrollbarHover();
		this.stopScrollbarDrag();
		this.clearPointerInteraction(true);
		this.flashes.dispose();
		if (!this.altScreenActive) return;
		this.terminal.write(
			`${BEGIN_SYNCHRONIZED_OUTPUT}${this.deleteKittyImages()}${this.mouseEnabled ? DISABLE_MOUSE : ""}${ENABLE_AUTOWRAP}${END_SYNCHRONIZED_OUTPUT}`,
		);
		this.uploadedKittyImages.clear();
	}

	protected override afterTerminalStop(options: TuiStopOptions): void {
		if (!this.altScreenActive) return;
		this.altScreenActive = false;
		if (options.preserveScreen) {
			this.terminal.write(`${BEGIN_SYNCHRONIZED_OUTPUT}${EXIT_ALT_SCREEN}\x1b[?25h${END_SYNCHRONIZED_OUTPUT}`);
		} else {
			const width = Math.max(1, this.terminal.columns);
			const documentLines = this.render(width).map((line) => line.replace(OSC133_ZONE_PREFIX, ""));
			this.lastDocument = this.applyLineResets(documentLines.map((line) => line.replaceAll(CURSOR_MARKER, ""))).map(
				(line) => (isImageLine(line) || visibleWidth(line) <= width ? line : sliceByColumn(line, 0, width, true)),
			);
			let buffer = `${BEGIN_SYNCHRONIZED_OUTPUT}${EXIT_ALT_SCREEN}${DISABLE_AUTOWRAP}`;
			for (let row = 0; row < this.lastDocument.length; row++) {
				if (row > 0) buffer += "\r\n";
				buffer += `\r\x1b[2K${this.lastDocument[row] ?? ""}`;
			}
			buffer += `\x1b[0m${ENABLE_AUTOWRAP}\r\n\x1b[?25h${END_SYNCHRONIZED_OUTPUT}`;
			this.terminal.write(buffer);
		}
		if (this.savedCapabilities) {
			setCapabilities(this.savedCapabilities);
			this.savedCapabilities = undefined;
		}
	}

	private deleteKittyImages(): string {
		return this.imageProtocol === "kitty" ? deleteAllKittyImages() : "";
	}

	private prepareKittyScreen(screen: string[]): { lines: string[]; evictedImageDeletion: string } {
		const visibleImageIds = new Set<number>();
		const lines = screen.map((line) => {
			const placement = getKittyImagePlacement(line);
			if (!placement) return line;
			visibleImageIds.add(placement.imageId);

			const cachedImage = this.uploadedKittyImages.get(placement.imageId);
			const nextCachedImage = {
				transmissionGeneration: placement.transmissionGeneration,
				transmissionBytes: placement.transmissionBytes,
				estimatedDecodedBytes: placement.estimatedDecodedBytes,
			};
			if (cachedImage) this.uploadedKittyImages.delete(placement.imageId);
			this.uploadedKittyImages.set(placement.imageId, nextCachedImage);

			return cachedImage?.transmissionGeneration === placement.transmissionGeneration
				? placement.replacementLine
				: line;
		});

		let cachedOffscreenImageCount = 0;
		let cachedOffscreenTransmissionBytes = 0;
		let cachedOffscreenDecodedBytes = 0;
		for (const [imageId, cachedImage] of this.uploadedKittyImages) {
			if (visibleImageIds.has(imageId)) continue;
			cachedOffscreenImageCount += 1;
			cachedOffscreenTransmissionBytes += cachedImage.transmissionBytes;
			cachedOffscreenDecodedBytes += cachedImage.estimatedDecodedBytes;
		}

		let evictedImageDeletion = "";
		for (const [imageId, cachedImage] of this.uploadedKittyImages) {
			if (
				cachedOffscreenImageCount <= MAX_CACHED_OFFSCREEN_KITTY_IMAGES &&
				cachedOffscreenTransmissionBytes <= MAX_CACHED_OFFSCREEN_KITTY_TRANSMISSION_BYTES &&
				cachedOffscreenDecodedBytes <= MAX_CACHED_OFFSCREEN_KITTY_DECODED_BYTES
			) {
				break;
			}
			if (visibleImageIds.has(imageId)) continue;
			evictedImageDeletion += deleteKittyImage(imageId);
			this.uploadedKittyImages.delete(imageId);
			cachedOffscreenImageCount -= 1;
			cachedOffscreenTransmissionBytes -= cachedImage.transmissionBytes;
			cachedOffscreenDecodedBytes -= cachedImage.estimatedDecodedBytes;
		}
		return { lines, evictedImageDeletion };
	}

	protected override resetRenderState(): void {
		this.previousScreen = [];
		this.previousScreenWidth = 0;
		this.previousScreenHeight = 0;
		this.currentLayout = undefined;
	}

	scrollBy(lines: number): void {
		this.getPrimaryScrollView().scrollBy(lines);
		this.requestRender();
	}

	scrollToTop(): void {
		this.getPrimaryScrollView().scrollToStart();
		this.requestRender();
	}

	scrollToBottom(): void {
		this.getPrimaryScrollView().scrollToEnd();
		this.requestRender();
	}

	private scrollToPrompt(direction: -1 | 1): void {
		if (!this.currentLayout) return;
		const scrollView = this.getPrimaryScrollView();
		const lines = getScrollViewBox(this.currentLayout, scrollView)?.scrollContentLines;
		if (!lines) return;

		for (let row = scrollView.scrollTop + direction; row >= 0 && row < lines.length; row += direction) {
			if (!OSC133_PROMPT_START.test(lines[row] ?? "")) continue;
			scrollView.scrollTo(row);
			this.requestRender();
			return;
		}
	}

	private openSearch(): void {
		if (this.activeSearch) {
			this.activeSearch.overlay?.focus();
			return;
		}
		const component = new AltScreenSearchComponent((query) => this.updateSearchQuery(query));
		const search: ActiveSearch = {
			component,
			query: "",
			matches: [],
			selectedIndex: -1,
			anchorRow: this.getPrimaryScrollView().scrollTop,
			selectionMode: "query",
		};
		this.activeSearch = search;
		search.overlay = this.showOverlay(component, {
			anchor: "top-right",
			width: "40%",
			minWidth: 24,
			margin: 1,
		});
	}

	private closeSearch(): void {
		const search = this.activeSearch;
		if (!search) return;
		this.activeSearch = undefined;
		search.overlay?.hide();
		this.requestRender();
	}

	private updateSearchQuery(query: string): void {
		const search = this.activeSearch;
		if (!search || query === search.query) return;
		const selected = search.matches[search.selectedIndex];
		search.anchorRow = selected?.segments[0]?.row ?? this.getPrimaryScrollView().scrollTop;
		search.query = query;
		search.selectionMode = "query";
		search.component.setResult(-1, 0);
		this.requestRender();
	}

	private navigateSearch(direction: -1 | 1): void {
		const search = this.activeSearch;
		if (!search?.query) return;
		search.selectionMode = direction < 0 ? "previous" : "next";
		this.requestRender();
	}

	private refreshSearch(layout: LayoutFrame): boolean {
		const search = this.activeSearch;
		if (!search) return false;
		const scrollView = layout.primaryScrollView ?? this.implicitScrollView;
		const box = getScrollViewBox(layout, scrollView);
		const lines = box?.scrollContentLines;
		if (!lines || !search.query.trim()) {
			search.matches = [];
			search.selectedIndex = -1;
			search.selectedKey = undefined;
			search.selectionMode = "retain";
			search.component.setResult(-1, 0);
			return false;
		}

		const shouldRevealSelection = search.selectionMode !== "retain";
		const matches = findAltScreenSearchMatches(lines, search.query);
		const exactIndex = search.selectedKey
			? matches.findIndex((match) => getAltScreenSearchMatchKey(match) === search.selectedKey)
			: -1;
		let selectedIndex = -1;
		if (matches.length > 0) {
			if (search.selectionMode === "query") {
				selectedIndex = matches.findIndex((match) => (match.segments[0]?.row ?? 0) >= search.anchorRow);
				if (selectedIndex < 0) selectedIndex = 0;
			} else if (search.selectionMode === "next") {
				const baseIndex = exactIndex >= 0 ? exactIndex : Math.min(search.selectedIndex, matches.length - 1);
				selectedIndex = baseIndex < 0 ? 0 : (baseIndex + 1) % matches.length;
			} else if (search.selectionMode === "previous") {
				const baseIndex = exactIndex >= 0 ? exactIndex : Math.min(search.selectedIndex, matches.length - 1);
				selectedIndex = baseIndex < 0 ? matches.length - 1 : (baseIndex - 1 + matches.length) % matches.length;
			} else {
				selectedIndex =
					exactIndex >= 0 ? exactIndex : Math.min(Math.max(0, search.selectedIndex), matches.length - 1);
			}
		}

		search.matches = matches;
		search.selectedIndex = selectedIndex;
		search.selectedKey = selectedIndex >= 0 ? getAltScreenSearchMatchKey(matches[selectedIndex]!) : undefined;
		search.selectionMode = "retain";
		search.component.setResult(selectedIndex, matches.length);
		if (!shouldRevealSelection) return false;

		const selected = matches[selectedIndex];
		const firstSegment = selected?.segments[0];
		const lastSegment = selected?.segments[selected.segments.length - 1];
		if (!box || !firstSegment || !lastSegment || scrollView.viewportHeight <= 0) return false;
		const before = scrollView.scrollTop;
		const visibleBottom = before + scrollView.viewportHeight - 1;
		let target = before;
		if (firstSegment.row < before || lastSegment.row > visibleBottom) {
			target = firstSegment.row - Math.floor(scrollView.viewportHeight / 3);
		}
		scrollView.scrollTo(target, { disableFollow: true });
		return scrollView.scrollTop !== before;
	}

	/** Show a transient message in the alternate-screen flash stack. */
	flash(message: string, durationMs?: number): void {
		this.flashes.flash(message, durationMs);
	}

	private shouldDeferViewportInputToOverlay(): boolean {
		return this.isOverlayFocused() && this.activeSearch?.overlay?.isFocused() !== true;
	}

	private handleViewportInput(data: string): { consume?: boolean } | undefined {
		if (data === FOCUS_OUT) {
			const hadActiveSelection = this.selectionPressActive;
			const hadNonEmptyActiveSelection = hadActiveSelection && this.getSelectionBounds() !== undefined;
			this.selectionPressActive = false;
			this.stopSelectionAutoScroll();
			this.stopScrollbarHover();
			this.stopScrollbarDrag();
			this.clearPointerInteraction(true);
			this.pressedUrl = undefined;
			this.selectionDragged = false;
			if (hadActiveSelection) {
				this.selectionAnchor = undefined;
				this.selectionFocus = undefined;
				this.selectionGranularity = "character";
				this.selectionInitialRange = undefined;
				if (hadNonEmptyActiveSelection) this.requestRender();
			}
			this.lastClick = undefined;
			return { consume: true };
		}
		if (data === FOCUS_IN) return { consume: true };

		const wheelEvent = this.parseWheelEvent(data);
		if (wheelEvent) {
			// Pointer dispatch layering: components/overlays get the wheel event first;
			// only an unconsumed event falls through to the legacy ScrollView routing.
			if (
				this.mouseWheel &&
				this.dispatchPointerEvent("wheel", {
					x: wheelEvent.x,
					y: wheelEvent.y,
					button: -1,
					shift: false,
					alt: false,
					ctrl: false,
					deltaX: 0,
					deltaY: wheelEvent.direction,
				})
			) {
				this.updateScrollbarHover(wheelEvent.x, wheelEvent.y);
				this.requestRender();
				return { consume: true };
			}
			if (this.shouldDeferViewportInputToOverlay()) return undefined;
			// The legacy route stays live whenever tracking is off entirely
			// (mouse:false — a stray sequence behaves as before the granular
			// split); an explicit wheel:false with tracking on drops the scroll.
			if (this.mouseWheel || !this.mouseEnabled) this.routeWheel(wheelEvent);
			return { consume: true };
		}
		const mouseEvent = this.parseMouseEvent(data);
		if (mouseEvent) {
			if (!this.mouseEnabled) {
				// With mouse disabled the terminal never sends these sequences; if one
				// still arrives, keep the pre-pointer-dispatch behavior byte-identical.
				if (this.handleRightClickPaste(mouseEvent)) return { consume: true };
				const handled = this.handleScrollbarMouseEvent(mouseEvent);
				if (!this.scrollbarDrag) this.updateScrollbarHover(mouseEvent.x, mouseEvent.y);
				if (!handled) this.handleSelectionMouseEvent(mouseEvent);
				return { consume: true };
			}
			if (this.mouseButtons) {
				if (this.handleRightClickPaste(mouseEvent)) return { consume: true };
				const handled = this.handleScrollbarMouseEvent(mouseEvent);
				if (!this.scrollbarDrag) this.updateScrollbarHover(mouseEvent.x, mouseEvent.y);
				if (!handled) this.handlePointerMouseEvent(mouseEvent);
			}
			// Buttons gated off with tracking on (wheel-only mode): swallow the
			// event — no dispatch, no selection, no scrollbar interaction.
			return { consume: true };
		}
		if (this.isMouseSequence(data)) return { consume: true };

		const keybindings = getKeybindings();
		const isRelease = isKeyRelease(data);
		if (keybindings.matches(data, "tui.altScreen.search")) {
			if (!isRelease) this.openSearch();
			return { consume: true };
		}
		if (this.activeSearch?.overlay?.isFocused()) {
			if (keybindings.matches(data, "tui.altScreen.searchNext")) {
				if (!isRelease) this.navigateSearch(1);
				return { consume: true };
			}
			if (keybindings.matches(data, "tui.altScreen.searchPrevious")) {
				if (!isRelease) this.navigateSearch(-1);
				return { consume: true };
			}
			if (keybindings.matches(data, "tui.altScreen.searchClose")) {
				if (!isRelease) this.closeSearch();
				return { consume: true };
			}
		}
		if (this.shouldDeferViewportInputToOverlay()) return undefined;
		if (keybindings.matches(data, "tui.altScreen.pageUp")) {
			if (!isRelease) {
				this.scrollBy(-Math.max(1, this.getPrimaryScrollView().viewportHeight - PAGE_SCROLL_OVERLAP));
			}
			return { consume: true };
		}
		if (keybindings.matches(data, "tui.altScreen.pageDown")) {
			if (!isRelease) {
				this.scrollBy(Math.max(1, this.getPrimaryScrollView().viewportHeight - PAGE_SCROLL_OVERLAP));
			}
			return { consume: true };
		}
		if (keybindings.matches(data, "tui.altScreen.halfPageUp")) {
			if (!isRelease) this.scrollBy(-Math.max(1, Math.floor(this.getPrimaryScrollView().viewportHeight / 2)));
			return { consume: true };
		}
		if (keybindings.matches(data, "tui.altScreen.halfPageDown")) {
			if (!isRelease) this.scrollBy(Math.max(1, Math.floor(this.getPrimaryScrollView().viewportHeight / 2)));
			return { consume: true };
		}
		if (keybindings.matches(data, "tui.altScreen.lineUp")) {
			if (!isRelease) this.scrollBy(-1);
			return { consume: true };
		}
		if (keybindings.matches(data, "tui.altScreen.lineDown")) {
			if (!isRelease) this.scrollBy(1);
			return { consume: true };
		}
		if (keybindings.matches(data, "tui.altScreen.previousPrompt")) {
			if (!isRelease) this.scrollToPrompt(-1);
			return { consume: true };
		}
		if (keybindings.matches(data, "tui.altScreen.nextPrompt")) {
			if (!isRelease) this.scrollToPrompt(1);
			return { consume: true };
		}
		if (keybindings.matches(data, "tui.altScreen.top")) {
			if (!isRelease) this.scrollToTop();
			return { consume: true };
		}
		if (keybindings.matches(data, "tui.altScreen.bottom")) {
			if (!isRelease) this.scrollToBottom();
			return { consume: true };
		}
		return undefined;
	}

	private parseWheelEvent(data: string): WheelEvent | undefined {
		const sgr = /^\x1b\[<(\d+);(\d+);(\d+)[Mm]$/.exec(data);
		if (sgr) {
			const button = Number.parseInt(sgr[1], 10);
			if ((button & 64) === 0) return undefined;
			const direction = button & 3;
			if (direction !== 0 && direction !== 1) return undefined;
			return {
				direction: direction === 0 ? -1 : 1,
				x: Number.parseInt(sgr[2], 10) - 1,
				y: Number.parseInt(sgr[3], 10) - 1,
			};
		}
		if (data.length === 6 && data.startsWith("\x1b[M")) {
			const button = data.charCodeAt(3) - 32;
			if ((button & 64) === 0) return undefined;
			const direction = button & 3;
			if (direction !== 0 && direction !== 1) return undefined;
			return {
				direction: direction === 0 ? -1 : 1,
				x: data.charCodeAt(4) - 33,
				y: data.charCodeAt(5) - 33,
			};
		}
		return undefined;
	}

	private routeWheel(event: WheelEvent): void {
		let remaining = event.direction * this.wheelScrollLines;
		const seen = new Set<ScrollView>();
		for (const scrollView of this.currentLayout ? getScrollViewsAt(this.currentLayout, event.x, event.y) : []) {
			seen.add(scrollView);
			remaining = scrollView.scrollBy(remaining);
			if (remaining === 0 || scrollView.overscroll === "contain") break;
		}
		const primary = this.getPrimaryScrollView();
		if (remaining !== 0 && !seen.has(primary)) primary.scrollBy(remaining);
		this.updateScrollbarHover(event.x, event.y);
		this.requestRender();
	}

	private parseMouseEvent(data: string): SgrMouseEvent | undefined {
		const match = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/.exec(data);
		if (match) {
			return {
				button: Number.parseInt(match[1], 10),
				x: Number.parseInt(match[2], 10) - 1,
				y: Number.parseInt(match[3], 10) - 1,
				release: match[4] === "m",
			};
		}
		// X10: ESC[M followed by button+32 and 1-based coords+33. Wheel events
		// (bit 6) are handled by parseWheelEvent before this parser runs.
		if (data.length === 6 && data.startsWith("\x1b[M")) {
			const button = data.charCodeAt(3) - 32;
			if ((button & 64) !== 0) return undefined;
			return {
				button,
				x: data.charCodeAt(4) - 33,
				y: data.charCodeAt(5) - 33,
				// X10 has no release final byte: button 3 without the motion bit is a release.
				release: (button & 32) === 0 && (button & 3) === 3,
			};
		}
		return undefined;
	}

	private handleRightClickPaste(event: SgrMouseEvent): boolean {
		if (!this.onRightClickPaste || process.platform !== "win32" || event.release || event.button !== 2) {
			return false;
		}
		try {
			this.onRightClickPaste();
		} catch {
			// Clipboard paste is best-effort.
		}
		return true;
	}

	private getScrollbarTargetAt(x: number, y: number): ScrollbarTarget | undefined {
		if (this.hasOverlay() || !this.currentLayout) return undefined;
		for (const scrollView of getScrollViewsAt(this.currentLayout, x, y)) {
			const box = getScrollViewBox(this.currentLayout, scrollView);
			const geometry = box ? getScrollbarGeometry(box) : undefined;
			if (
				geometry &&
				x === geometry.column &&
				y >= geometry.thumbTop &&
				y < geometry.thumbTop + geometry.thumbHeight
			) {
				return { scrollView, geometry };
			}
		}
		return undefined;
	}

	private setScrollbarHover(scrollView: ScrollView | undefined): void {
		if (scrollView === this.scrollbarHover) return;
		this.scrollbarHover?.setScrollbarActive(false);
		this.scrollbarHover = scrollView;
		this.scrollbarHover?.setScrollbarActive(true);
	}

	private updateScrollbarHover(x: number, y: number): void {
		this.setScrollbarHover(this.getScrollbarTargetAt(x, y)?.scrollView);
	}

	private stopScrollbarHover(): void {
		this.setScrollbarHover(undefined);
	}

	private handleScrollbarMouseEvent(event: SgrMouseEvent): boolean {
		if (this.scrollbarDrag) {
			if (event.release) {
				this.stopScrollbarDrag();
				return true;
			}
			const box = this.currentLayout
				? getScrollViewBox(this.currentLayout, this.scrollbarDrag.scrollView)
				: undefined;
			const geometry = box ? getScrollbarGeometry(box) : undefined;
			if (geometry) {
				const maxThumbOffset = geometry.trackHeight - geometry.thumbHeight;
				const thumbOffset = Math.max(
					0,
					Math.min(maxThumbOffset, event.y - geometry.trackTop - this.scrollbarDrag.grabOffset),
				);
				const scrollTop =
					maxThumbOffset === 0 ? 0 : Math.round((thumbOffset / maxThumbOffset) * geometry.maxScrollTop);
				this.scrollbarDrag.scrollView.scrollTo(scrollTop);
			}
			return true;
		}

		if (event.release || (event.button & 32) !== 0 || (event.button & 3) !== 0) return false;
		const target = this.getScrollbarTargetAt(event.x, event.y);
		if (!target) return false;
		this.resetSelectionInteraction();
		this.setScrollbarHover(target.scrollView);
		this.scrollbarDrag = {
			scrollView: target.scrollView,
			grabOffset: event.y - target.geometry.thumbTop,
		};
		return true;
	}

	private stopScrollbarDrag(): void {
		this.scrollbarDrag = undefined;
	}

	private resetSelectionInteraction(): void {
		this.stopSelectionAutoScroll();
		this.selectionPressActive = false;
		this.selectionAnchor = undefined;
		this.selectionFocus = undefined;
		this.selectionGranularity = "character";
		this.selectionInitialRange = undefined;
		this.lastClick = undefined;
		this.pressedUrl = undefined;
		this.selectionDragged = false;
	}

	// --- Generic pointer dispatch (see pointer.ts for the dispatch contract) ---

	private makePointerSource(event: SgrMouseEvent): PointerDispatchSource {
		const motion = (event.button & 32) !== 0;
		return {
			x: event.x,
			y: event.y,
			// Motion and X10 releases (button 3) carry no button identity.
			button: motion || (event.release && (event.button & 3) === 3) ? -1 : event.button & 3,
			shift: (event.button & 4) !== 0,
			alt: (event.button & 8) !== 0,
			ctrl: (event.button & 16) !== 0,
			deltaX: 0,
			deltaY: 0,
		};
	}

	private neutralPointerSource(): PointerDispatchSource {
		const cell = this.lastPointerCell ?? this.lastHoverCell ?? { x: -1, y: -1 };
		return { x: cell.x, y: cell.y, button: -1, shift: false, alt: false, ctrl: false, deltaX: 0, deltaY: 0 };
	}

	private handlePointerMouseEvent(event: SgrMouseEvent): void {
		this.lastPointerCell = { x: event.x, y: event.y };
		const source = this.makePointerSource(event);
		if (event.release) {
			this.handlePointerRelease(event, source);
			return;
		}
		if ((event.button & 32) !== 0) {
			this.handlePointerMotion(event, source);
			return;
		}
		if ((event.button & 3) === 3) {
			// A non-motion button-3 press carries no usable button identity; the
			// selection path ignores it exactly as before pointer dispatch existed.
			this.handleSelectionMouseEvent(event);
			return;
		}
		this.pointerPressCell = { x: event.x, y: event.y };
		const dispatched: Component[] = [];
		if (this.dispatchPointerEvent("press", source, dispatched)) {
			// A consumed press captures the pointer and suppresses the selection candidate.
			this.pointerCapture = { components: dispatched };
			this.resetSelectionInteraction();
			this.requestRender();
			return;
		}
		this.handleSelectionMouseEvent(event);
	}

	private handlePointerRelease(event: SgrMouseEvent, source: PointerDispatchSource): void {
		const pressCell = this.pointerPressCell;
		this.pointerPressCell = undefined;
		const capture = this.pointerCapture;
		this.pointerCapture = undefined;
		if (capture) {
			// Pairing guarantee: every component that received the captured press also
			// receives the release (bubbling does not stop at a consumer), delivered
			// even when the release lands outside the target's rect.
			for (const component of capture.components) {
				const rect = this.resolvePointerRect(component);
				if (rect) this.dispatchToPointerComponent(component, "release", source, rect, false);
			}
		} else {
			this.dispatchPointerEvent("release", source);
		}
		// A release on the press cell without an intervening drag is a click.
		// Selection drags never produce one (their release completes the copy path).
		const sameCell = pressCell !== undefined && pressCell.x === event.x && pressCell.y === event.y;
		if (sameCell && !this.selectionDragged) {
			const clickConsumed = capture
				? this.dispatchToCapturedChain(capture, "click", source)
				: this.dispatchPointerEvent("click", source);
			if (clickConsumed) {
				// A consumed click suppresses the fallback copy/OSC 8 activation path.
				this.resetSelectionInteraction();
				this.requestRender();
				return;
			}
		}
		// A captured press never created a selection candidate; nothing to complete.
		if (capture) return;
		this.handleSelectionMouseEvent(event);
	}

	private handlePointerMotion(event: SgrMouseEvent, source: PointerDispatchSource): void {
		if (this.pointerCapture) {
			this.dispatchToCapturedChain(this.pointerCapture, "move", source);
			return;
		}
		if ((event.button & 3) !== 3) {
			// Button-motion drag without a consumed press belongs to text selection.
			this.handleSelectionMouseEvent(event);
			return;
		}
		// Pure hover move. Only DECSET 1003 (all-motion) terminals emit these;
		// multiplexers negotiate button-motion tracking instead, so hover simply
		// never happens there — no mux-specific code is required.
		this.lastHoverCell = { x: event.x, y: event.y };
		const chain = this.resolveHoverChain(event.x, event.y);
		this.diffHoverChain(chain, source);
		if (chain.length === 0) return;
		const frame = this.currentLayout;
		const cellIsBlank = frame ? this.isCellBlank(frame, event.x, event.y) : true;
		for (const component of chain) {
			const rect = this.resolvePointerRect(component);
			if (!rect) continue;
			if (this.dispatchToPointerComponent(component, "move", source, rect, cellIsBlank)) break;
		}
	}

	/**
	 * Dispatch a pointer event: overlay hit regions first (topmost-first), then
	 * the base layout tree (deepest-first bubbling over the clip-aware hit chain).
	 * Returns true when a handler consumed the event; the components that received
	 * it are collected into `dispatched` (for capture pairing).
	 */
	private dispatchPointerEvent(type: PointerEventType, source: PointerDispatchSource, dispatched?: Component[]): boolean {
		const regions = this.overlayHitRegions;
		if (regions.length > 0) {
			const hit = regions.find((region) => rectContainsPoint(region.rect, source.x, source.y));
			const topmostCapturing = regions.find((region) => region.capturing);
			if (hit) {
				dispatched?.push(hit.component);
				if (this.dispatchToPointerComponent(hit.component, type, source, hit.rect, false)) return true;
				// A hit capturing region never passes through to the base tree.
				if (hit.capturing) return false;
				if (topmostCapturing) {
					// A visible modal owns pointer input: an unconsumed hit on a
					// non-capturing overlay is delivered to the modal itself (locals may
					// lie outside its rect), never to the base tree.
					dispatched?.push(topmostCapturing.component);
					return this.dispatchToPointerComponent(topmostCapturing.component, type, source, topmostCapturing.rect, false);
				}
				// Unconsumed non-capturing overlay: the event passes through to the base tree.
			} else if (topmostCapturing) {
				// Click-outside delivery: with a visible capturing overlay, events that
				// hit no region go to the topmost capturing component itself, with
				// out-of-bounds local coordinates (click-outside-to-close support).
				dispatched?.push(topmostCapturing.component);
				return this.dispatchToPointerComponent(topmostCapturing.component, type, source, topmostCapturing.rect, false);
			}
		}
		const frame = this.currentLayout;
		if (!frame) return false;
		const cellIsBlank = this.isCellBlank(frame, source.x, source.y);
		for (const box of getHitChainAt(frame, source.x, source.y)) {
			if (!box.component.handlePointer) continue;
			dispatched?.push(box.component);
			if (this.dispatchToPointerComponent(box.component, type, source, box.rect, cellIsBlank)) return true;
		}
		return false;
	}

	/** Bubble an event through a captured chain, deepest-first, stopping at a consumer. */
	private dispatchToCapturedChain(capture: PointerCaptureState, type: PointerEventType, source: PointerDispatchSource): boolean {
		for (const component of capture.components) {
			const rect = this.resolvePointerRect(component);
			if (!rect) continue;
			if (this.dispatchToPointerComponent(component, type, source, rect, false)) return true;
		}
		return false;
	}

	private dispatchToPointerComponent(
		component: Component,
		type: PointerEventType,
		source: PointerDispatchSource,
		rect: LayoutRect,
		cellIsBlank: boolean,
	): boolean {
		const handler = component.handlePointer;
		if (!handler) return false;
		// Each dispatch level receives a fresh event object with locals recomputed
		// against that level's rect; handlers must not retain or mutate it.
		const event: PointerEvent = {
			type,
			x: source.x,
			y: source.y,
			localX: source.x - rect.x,
			localY: source.y - rect.y,
			button: source.button,
			shift: source.shift,
			alt: source.alt,
			ctrl: source.ctrl,
			deltaX: source.deltaX,
			deltaY: source.deltaY,
			cellIsBlank,
		};
		try {
			return handler.call(component, event) === true;
		} catch (error) {
			// Handler exceptions are isolated: the event counts as consumed so a
			// faulty component cannot break the input loop or leak into fallbacks.
			this.logPointerHandlerError(component, error);
			return true;
		}
	}

	private logPointerHandlerError(component: Component, error: unknown): void {
		if (process.env.PI_DEBUG_POINTER !== "1") return;
		try {
			const logPath = path.join(this.logDirectory, "pi-debug.log");
			const message = `[${new Date().toISOString()}] pointer handler error in ${component.constructor.name}: ${String(error)}\n`;
			fs.mkdirSync(path.dirname(logPath), { recursive: true });
			fs.appendFileSync(logPath, message);
		} catch {
			// Debug logging is best-effort.
		}
	}

	/** Resolve a dispatch target's current rect: visible overlay region first, then the committed layout frame. */
	private resolvePointerRect(component: Component): LayoutRect | undefined {
		const region = this.overlayHitRegions.find((candidate) => candidate.component === component);
		if (region) return region.rect;
		return this.findLayoutBox(component)?.rect;
	}

	private findLayoutBox(component: Component): LayoutBox | undefined {
		const frame = this.currentLayout;
		if (!frame) return undefined;
		const visit = (box: LayoutBox): LayoutBox | undefined => {
			if (box.component === component) return box;
			for (const child of box.children) {
				const match = visit(child);
				if (match) return match;
			}
			return undefined;
		};
		return visit(frame.root);
	}

	/**
	 * Blankness of a base-tree hit cell, computed from the committed layout frame
	 * (not the composited screen, so non-capturing overlay pixels never leak in).
	 * Overlay hits always report false.
	 */
	private isCellBlank(frame: LayoutFrame, x: number, y: number): boolean {
		if (y < 0 || y >= frame.lines.length) return true;
		return stripTerminalSequences(sliceByColumn(frame.lines[y] ?? "", x, 1, true)).trim().length === 0;
	}

	private isOverlayComponent(component: Component): boolean {
		return this.overlayHitRegions.some((region) => region.component === component);
	}

	/** Hover chain for a cell, deepest-first: overlay hit first, then the filtered base hit chain. */
	private resolveHoverChain(x: number, y: number): Component[] {
		const hit = this.overlayHitRegions.find((region) => rectContainsPoint(region.rect, x, y));
		if (hit) return hit.component.handlePointer ? [hit.component] : [];
		// A visible capturing overlay suppresses base-tree hover outside its region.
		if (this.overlayHitRegions.some((region) => region.capturing)) return [];
		const frame = this.currentLayout;
		if (!frame) return [];
		return getHitChainAt(frame, x, y)
			.filter((box) => box.component.handlePointer !== undefined)
			.map((box) => box.component);
	}

	/** Diff the hover chain: leave fires deepest-first, enter shallowest-first. */
	private diffHoverChain(next: Component[], source: PointerDispatchSource): void {
		const previous = this.pointerHoverChain;
		for (const component of previous) {
			if (next.includes(component)) continue;
			const rect = this.resolvePointerRect(component) ?? { x: source.x, y: source.y, width: 0, height: 0 };
			this.dispatchToPointerComponent(component, "leave", source, rect, false);
		}
		for (let index = next.length - 1; index >= 0; index--) {
			const component = next[index]!;
			if (previous.includes(component)) continue;
			const rect = this.resolvePointerRect(component);
			if (rect) this.dispatchToPointerComponent(component, "enter", source, rect, false);
		}
		this.pointerHoverChain = next;
	}

	/**
	 * Reconcile pointer state with a freshly committed frame: clear capture whose
	 * targets vanished (synthesizing leave), and re-hit the last hover cell so
	 * content that moved under a stationary pointer (scroll, resize, overlay
	 * show/hide) produces the correct enter/leave transitions.
	 */
	private syncPointerStateAfterCommit(): void {
		if (this.pointerCapture) {
			const vanished = this.pointerCapture.components.filter(
				(component) => this.resolvePointerRect(component) === undefined,
			);
			if (vanished.length > 0) {
				const source = this.neutralPointerSource();
				const rect = { x: source.x, y: source.y, width: 0, height: 0 };
				for (const component of vanished) {
					this.dispatchToPointerComponent(component, "leave", source, rect, false);
				}
				this.pointerCapture = undefined;
			}
		}
		if (this.lastHoverCell) {
			this.diffHoverChain(this.resolveHoverChain(this.lastHoverCell.x, this.lastHoverCell.y), this.neutralPointerSource());
		}
	}

	/**
	 * Clear capture/hover state on focus loss, stop, and (silently) start. When
	 * `synthesizeRelease` is set, a captured press is paired with a synthetic
	 * release first, so components never wait for a release that will not come.
	 */
	private clearPointerInteraction(synthesizeRelease: boolean): void {
		const capture = this.pointerCapture;
		this.pointerCapture = undefined;
		this.pointerPressCell = undefined;
		if (capture && synthesizeRelease) {
			const source = this.neutralPointerSource();
			for (const component of capture.components) {
				const rect = this.resolvePointerRect(component);
				if (rect) this.dispatchToPointerComponent(component, "release", source, rect, false);
			}
		}
		if (this.pointerHoverChain.length > 0) this.diffHoverChain([], this.neutralPointerSource());
		this.lastHoverCell = undefined;
	}

	private getScrollSelectionPoint(scrollView: ScrollView, x: number, y: number): SelectionPoint | undefined {
		if (!this.currentLayout) return undefined;
		const box = getScrollViewBox(this.currentLayout, scrollView);
		if (!box || box.rect.height <= 0 || box.clip.height <= 0) return undefined;
		const visibleTop = Math.max(0, box.rect.y, box.clip.y);
		const visibleBottom = Math.min(
			this.terminal.rows - 1,
			box.rect.y + box.rect.height - 1,
			box.clip.y + box.clip.height - 1,
		);
		if (visibleBottom < visibleTop) return undefined;
		const pointerRow = Math.max(visibleTop, Math.min(visibleBottom, y));
		const maxContentRow = Math.max(0, (box.scrollContentLines?.length ?? 1) - 1);
		return {
			row: Math.max(0, Math.min(maxContentRow, scrollView.scrollTop + pointerRow - box.rect.y)),
			col: Math.max(0, Math.min(box.rect.width - 1, x - box.rect.x)),
			scrollView,
		};
	}

	private getSelectionPoint(event: SgrMouseEvent, scrollView?: ScrollView): SelectionPoint {
		if (scrollView) {
			const point = this.getScrollSelectionPoint(scrollView, event.x, event.y);
			if (point) return point;
		}
		return {
			row: Math.max(0, Math.min(this.terminal.rows - 1, event.y)),
			col: Math.max(0, Math.min(this.terminal.columns - 1, event.x)),
		};
	}

	private getSelectionSourceLine(point: SelectionPoint): string {
		if (point.scrollView && this.currentLayout) {
			const lines = getScrollViewBox(this.currentLayout, point.scrollView)?.scrollContentLines;
			if (lines) return lines[point.row] ?? "";
		}
		return this.previousScreen[point.row] ?? "";
	}

	private getWordSelection(point: SelectionPoint): SelectionRange | undefined {
		const line = stripTerminalSequences(this.getSelectionSourceLine(point));
		let start = 0;
		for (const segment of wordSegmenter.segment(line)) {
			const end = start + visibleWidth(segment.segment);
			if (point.col >= start && point.col < end) {
				return {
					start: { ...point, col: start },
					end: { ...point, col: end, boundary: true },
				};
			}
			start = end;
		}
		return undefined;
	}

	private getLineSelection(point: SelectionPoint): SelectionRange {
		return {
			start: { ...point, col: 0 },
			end: { ...point, col: visibleWidth(this.getSelectionSourceLine(point)), boundary: true },
		};
	}

	private updateSelectionFocus(point: SelectionPoint): void {
		if (this.selectionGranularity === "character" || !this.selectionInitialRange) {
			this.selectionFocus = point;
			return;
		}
		const range = this.selectionGranularity === "word" ? this.getWordSelection(point) : this.getLineSelection(point);
		if (!range) return;
		const initial = this.selectionInitialRange;
		const targetBeforeInitial =
			range.start.row < initial.start.row ||
			(range.start.row === initial.start.row && range.start.col < initial.start.col);
		if (targetBeforeInitial) {
			this.selectionAnchor = initial.end;
			this.selectionFocus = range.start;
		} else {
			this.selectionAnchor = initial.start;
			this.selectionFocus = range.end;
		}
	}

	private getClickCount(point: SelectionPoint, word: SelectionRange | undefined): number {
		const now = Date.now();
		const previous = this.lastClick;
		const count =
			word &&
			previous &&
			now - previous.timestamp <= DOUBLE_CLICK_INTERVAL_MS &&
			previous.row === point.row &&
			previous.scrollView === point.scrollView &&
			previous.wordStart === word.start.col &&
			previous.wordEnd === word.end.col
				? (previous.count % 3) + 1
				: 1;
		this.lastClick = word
			? {
					timestamp: now,
					count,
					row: point.row,
					scrollView: point.scrollView,
					wordStart: word.start.col,
					wordEnd: word.end.col,
				}
			: undefined;
		return count;
	}

	private updateSelectionAutoScroll(event: SgrMouseEvent): void {
		const scrollView = this.selectionAnchor?.scrollView;
		if (!scrollView || !this.currentLayout) {
			this.stopSelectionAutoScroll();
			return;
		}
		const box = getScrollViewBox(this.currentLayout, scrollView);
		if (!box || box.rect.height <= 0 || box.clip.height <= 0) {
			this.stopSelectionAutoScroll();
			return;
		}
		const visibleTop = Math.max(0, box.rect.y, box.clip.y);
		const visibleBottom = Math.min(
			this.terminal.rows - 1,
			box.rect.y + box.rect.height - 1,
			box.clip.y + box.clip.height - 1,
		);
		this.selectionDragPointer = { x: event.x, y: event.y };
		this.selectionAutoScrollDirection = event.y <= visibleTop ? -1 : event.y >= visibleBottom ? 1 : 0;
		if (this.selectionAutoScrollDirection === 0) {
			this.stopSelectionAutoScroll();
			return;
		}
		if (this.selectionAutoScrollTimer) return;
		this.selectionAutoScrollTimer = setInterval(() => this.autoScrollSelection(), 50);
		this.selectionAutoScrollTimer.unref();
	}

	private autoScrollSelection(): void {
		const scrollView = this.selectionAnchor?.scrollView;
		const pointer = this.selectionDragPointer;
		const direction = this.selectionAutoScrollDirection;
		if (!scrollView || !pointer || direction === 0) {
			this.stopSelectionAutoScroll();
			return;
		}
		const remaining = scrollView.scrollBy(direction);
		if (remaining === direction) {
			this.stopSelectionAutoScroll();
			return;
		}
		const point = this.getScrollSelectionPoint(scrollView, pointer.x, pointer.y);
		if (point) this.updateSelectionFocus(point);
		this.requestRender();
	}

	private stopSelectionAutoScroll(): void {
		if (this.selectionAutoScrollTimer) {
			clearInterval(this.selectionAutoScrollTimer);
			this.selectionAutoScrollTimer = undefined;
		}
		this.selectionAutoScrollDirection = 0;
		this.selectionDragPointer = undefined;
	}

	private handleSelectionMouseEvent(event: SgrMouseEvent): void {
		const button = event.button & 3;
		if (button !== 0 && !(event.release && button === 3)) return;
		const anchorScrollView = this.selectionAnchor?.scrollView;
		const point = this.getSelectionPoint(event, anchorScrollView);
		if (event.release) {
			if (!this.selectionPressActive) return;
			this.selectionPressActive = false;
			this.stopSelectionAutoScroll();
			if (!this.selectionAnchor) return;
			this.updateSelectionFocus(point);
			const clickedUrl =
				!this.selectionDragged &&
				this.selectionAnchor.scrollView === point.scrollView &&
				this.selectionAnchor.row === point.row &&
				this.selectionAnchor.col === point.col
					? this.pressedUrl
					: undefined;
			this.pressedUrl = undefined;
			if (clickedUrl && this.openUrl) {
				this.selectionAnchor = undefined;
				this.selectionFocus = undefined;
				try {
					this.openUrl(clickedUrl);
				} catch {
					// URL activation is best-effort.
				}
				this.requestRender();
				return;
			}
			void this.copySelectionToClipboard();
			this.requestRender();
			return;
		}
		if ((event.button & 32) !== 0) {
			if (!this.selectionPressActive || !this.selectionAnchor) return;
			this.selectionDragged = true;
			this.lastClick = undefined;
			this.pressedUrl = undefined;
			this.updateSelectionFocus(point);
			this.updateSelectionAutoScroll(event);
			this.requestRender();
			return;
		}
		this.stopSelectionAutoScroll();
		this.selectionPressActive = true;
		const scrollView =
			!this.hasOverlay() && this.currentLayout
				? getScrollViewsAt(this.currentLayout, event.x, event.y)[0]
				: undefined;
		const anchor = this.getSelectionPoint(event, scrollView);
		const word = this.getWordSelection(anchor);
		const clickCount = this.getClickCount(anchor, word);
		const range = clickCount === 2 ? word : clickCount === 3 ? this.getLineSelection(anchor) : undefined;
		this.selectionGranularity = range ? (clickCount === 2 ? "word" : "line") : "character";
		this.selectionInitialRange = range;
		this.selectionAnchor = range?.start ?? anchor;
		this.selectionFocus = range?.end ?? anchor;
		this.selectionDragged = false;
		this.pressedUrl = range
			? undefined
			: getOsc8LinkAtColumn(
					this.previousScreen[Math.max(0, Math.min(this.terminal.rows - 1, event.y))] ?? "",
					Math.max(0, Math.min(this.terminal.columns - 1, event.x)),
				);
		this.requestRender();
	}

	private getSelectionBounds(): { start: SelectionPoint; end: SelectionPoint } | undefined {
		if (!this.selectionAnchor || !this.selectionFocus) return undefined;
		if (this.selectionAnchor.scrollView !== this.selectionFocus.scrollView) return undefined;
		const anchorBeforeFocus =
			this.selectionAnchor.row < this.selectionFocus.row ||
			(this.selectionAnchor.row === this.selectionFocus.row && this.selectionAnchor.col < this.selectionFocus.col);
		if (
			this.selectionAnchor.row === this.selectionFocus.row &&
			this.selectionAnchor.col === this.selectionFocus.col
		) {
			return undefined;
		}
		return anchorBeforeFocus
			? { start: this.selectionAnchor, end: this.selectionFocus }
			: { start: this.selectionFocus, end: this.selectionAnchor };
	}

	private getSelectionColumns(
		line: string,
		row: number,
		selection: { start: SelectionPoint; end: SelectionPoint },
		minColumn = 0,
		maxColumn = visibleWidth(line),
	): { start: number; end: number } {
		const lineWidth = visibleWidth(line);
		let start = Math.max(0, minColumn);
		let end = Math.min(lineWidth, maxColumn);
		if (row === selection.start.row) {
			start = getGraphemeCellRange(line, selection.start.col)?.start ?? Math.min(selection.start.col, lineWidth);
		}
		if (row === selection.end.row) {
			end = selection.end.boundary
				? Math.min(selection.end.col, lineWidth)
				: (getGraphemeCellRange(line, selection.end.col)?.end ?? Math.min(selection.end.col + 1, lineWidth));
		}
		return { start: Math.max(minColumn, start), end: Math.min(maxColumn, end) };
	}

	private async copySelectionToClipboard(): Promise<void> {
		const selection = this.getSelectionBounds();
		if (!selection) return;
		let sourceLines: readonly string[] = this.previousScreen;
		if (selection.start.scrollView) {
			if (!this.currentLayout) return;
			const box = getScrollViewBox(this.currentLayout, selection.start.scrollView);
			if (!box?.scrollContentLines) return;
			sourceLines = box.scrollContentLines;
		}
		const lines: string[] = [];
		for (let row = selection.start.row; row <= selection.end.row; row++) {
			const line = sourceLines[row] ?? "";
			const columns = this.getSelectionColumns(line, row, selection);
			lines.push(
				stripTerminalSequences(
					sliceByColumn(line, columns.start, Math.max(0, columns.end - columns.start), true),
				).trimEnd(),
			);
		}
		const text = lines.join("\n");
		if (text.length === 0) return;
		// Prefer an injected clipboard implementation (native clipboard + platform tools with a
		// verified success path) when the host app provides one. A bare OSC 52 write can show
		// "Copied!" while leaving the system clipboard untouched (e.g. macOS Terminal.app, tmux
		// without OSC 52 clipboard passthrough), so only report success when it actually copies.
		if (this.copySelection) {
			const ok = await this.copySelection(text);
			this.flash(ok ? "Copied!" : "Copy failed");
			return;
		}
		this.terminal.write(`\x1b]52;c;${Buffer.from(text).toString("base64")}\x07`);
		this.flash("Copied!");
	}

	private applySearchTextHighlight(text: string, current: boolean): string {
		const style = current ? this.searchCurrentMatchStyle : this.searchMatchStyle;
		let result = "";
		let plainStart = 0;
		let index = 0;
		while (index < text.length) {
			const ansi = extractAnsiCode(text, index);
			if (!ansi) {
				index += 1;
				continue;
			}
			if (index > plainStart) result += style(text.slice(plainStart, index));
			result += ansi.code;
			index += ansi.length;
			plainStart = index;
		}
		if (plainStart < text.length) result += style(text.slice(plainStart));
		return result;
	}

	private applySearchHighlights(screen: string[], layout: LayoutFrame): string[] {
		const search = this.activeSearch;
		if (!search || search.selectedIndex < 0 || search.matches.length === 0) return screen;
		const scrollView = layout.primaryScrollView ?? this.implicitScrollView;
		const box = getScrollViewBox(layout, scrollView);
		if (!box) return screen;

		const rangesByRow = new Map<number, SearchHighlightRange[]>();
		const scrollbarColumn = getScrollbarGeometry(box)?.column;
		const minRow = Math.max(0, box.rect.y, box.clip.y);
		const maxRow = Math.min(screen.length, box.rect.y + box.rect.height, box.clip.y + box.clip.height);
		const minColumn = Math.max(0, box.rect.x, box.clip.x);
		const maxColumn = Math.min(
			this.terminal.columns,
			box.rect.x + box.rect.width,
			box.clip.x + box.clip.width,
			scrollbarColumn ?? Number.POSITIVE_INFINITY,
		);
		for (let matchIndex = 0; matchIndex < search.matches.length; matchIndex++) {
			for (const segment of search.matches[matchIndex]!.segments) {
				const row = box.rect.y + segment.row - scrollView.scrollTop;
				if (row < minRow || row >= maxRow) continue;
				const startCol = Math.max(minColumn, box.rect.x + segment.startCol);
				const endCol = Math.min(maxColumn, box.rect.x + segment.endCol);
				if (endCol <= startCol) continue;
				const ranges = rangesByRow.get(row) ?? [];
				ranges.push({ startCol, endCol, current: matchIndex === search.selectedIndex });
				rangesByRow.set(row, ranges);
			}
		}

		const result = [...screen];
		for (const [row, ranges] of rangesByRow) {
			let line = result[row] ?? "";
			if (isImageLine(line)) continue;
			const lineWidth = visibleWidth(line);
			for (const range of ranges.sort((a, b) => b.startCol - a.startCol)) {
				const startCol = Math.min(range.startCol, lineWidth);
				const endCol = Math.min(range.endCol, lineWidth);
				if (endCol <= startCol) continue;
				const before = sliceByColumn(line, 0, startCol, true);
				const highlighted = sliceByColumn(line, startCol, endCol - startCol, true);
				const after = sliceByColumn(line, endCol, Math.max(0, lineWidth - endCol), true);
				line = `${before}${this.applySearchTextHighlight(highlighted, range.current)}${after}`;
			}
			result[row] = line;
		}
		return result;
	}

	private applySelectionHighlight(text: string): string {
		let result = "\x1b[7m";
		let index = 0;
		while (index < text.length) {
			const ansi = extractAnsiCode(text, index);
			if (!ansi) {
				result += text[index];
				index += 1;
				continue;
			}
			result += ansi.code;
			if (ansi.code.endsWith("m")) result += "\x1b[7m";
			index += ansi.length;
		}
		return `${result}\x1b[27m`;
	}

	private applySelection(screen: string[], layout = this.currentLayout): string[] {
		const selection = this.getSelectionBounds();
		if (!selection) return screen;
		let screenSelection = selection;
		let minRow = 0;
		let maxRow = screen.length - 1;
		let minColumn = 0;
		let maxColumn = this.terminal.columns;
		if (selection.start.scrollView) {
			if (!layout) return screen;
			const box = getScrollViewBox(layout, selection.start.scrollView);
			if (!box) return screen;
			minRow = Math.max(0, box.rect.y, box.clip.y);
			maxRow = Math.min(screen.length - 1, box.rect.y + box.rect.height - 1, box.clip.y + box.clip.height - 1);
			minColumn = Math.max(0, box.rect.x, box.clip.x);
			maxColumn = Math.min(this.terminal.columns, box.rect.x + box.rect.width, box.clip.x + box.clip.width);
			screenSelection = {
				start: {
					...selection.start,
					row: box.rect.y + selection.start.row - selection.start.scrollView.scrollTop,
					col: box.rect.x + selection.start.col,
				},
				end: {
					...selection.end,
					row: box.rect.y + selection.end.row - selection.start.scrollView.scrollTop,
					col: box.rect.x + selection.end.col,
				},
			};
		}
		return screen.map((line, row) => {
			if (
				row < minRow ||
				row > maxRow ||
				row < screenSelection.start.row ||
				row > screenSelection.end.row ||
				isImageLine(line)
			) {
				return line;
			}
			const lineWidth = visibleWidth(line);
			const columns = this.getSelectionColumns(line, row, screenSelection, minColumn, maxColumn);
			if (columns.end <= columns.start) return line;
			const before = sliceByColumn(line, 0, columns.start, true);
			const selected = sliceByColumn(line, columns.start, columns.end - columns.start, true);
			const after = sliceByColumn(line, columns.end, Math.max(0, lineWidth - columns.end), true);
			return `${before}${this.applySelectionHighlight(selected)}${after}`;
		});
	}

	private isMouseSequence(data: string): boolean {
		return /^\x1b\[<\d+;\d+;\d+[Mm]$/.test(data) || (data.length === 6 && data.startsWith("\x1b[M"));
	}

	private compositeFlashes(screen: string[], width: number, height: number): string[] {
		const flashLines = this.flashes.render(width).slice(-height);
		if (flashLines.length === 0) return screen;
		const result = [...screen];
		while (result.length < height) result.push("");
		for (let row = 0; row < flashLines.length; row++) {
			const line = flashLines[row]!;
			const flashWidth = visibleWidth(line);
			if (flashWidth === 0) continue;
			result[row] = compositeTuiLine(result[row] ?? "", line, width - flashWidth, flashWidth, width);
		}
		return result;
	}

	protected override doRender(): void {
		if (this.stopped || !this.altScreenActive) return;
		const width = Math.max(1, this.terminal.columns);
		const height = Math.max(1, this.terminal.rows);
		const root = this.layoutRoot ?? this.implicitScrollView;
		let nextLayout = renderLayoutFrame(root, width, height, () => this.requestRender());
		if (this.refreshSearch(nextLayout)) {
			nextLayout = renderLayoutFrame(root, width, height, () => this.requestRender());
		}
		let screen = nextLayout.lines.map((line) => line.replace(OSC133_ZONE_PREFIX, ""));
		screen = this.applySearchHighlights(screen, nextLayout);
		screen = this.compositeOverlays(screen, width, height);
		if (screen.length > height) screen = screen.slice(screen.length - height);
		screen = this.applySelection(screen, nextLayout);
		screen = this.compositeFlashes(screen, width, height);

		const cursorPos = this.extractCursorPosition(screen, height);
		screen = this.applyLineResets(screen).map((line) => {
			if (isImageLine(line) || visibleWidth(line) <= width) return line;
			return sliceByColumn(line, 0, width, true);
		});

		const fullRedraw =
			this.previousScreen.length === 0 || this.previousScreenWidth !== width || this.previousScreenHeight !== height;
		const imagesNeedRedraw = screen.some(
			(line, row) =>
				line !== this.previousScreen[row] && (isImageLine(line) || isImageLine(this.previousScreen[row] ?? "")),
		);
		const redrawImages = fullRedraw || imagesNeedRedraw;
		const hadUploadedKittyImages = this.uploadedKittyImages.size > 0;
		const preparedKittyScreen =
			redrawImages && this.imageProtocol === "kitty"
				? this.prepareKittyScreen(screen)
				: { lines: screen, evictedImageDeletion: "" };

		let buffer = BEGIN_SYNCHRONIZED_OUTPUT;
		if (fullRedraw) {
			this.fullRedrawCount += 1;
			const clearImages =
				this.imageProtocol === "kitty" && hadUploadedKittyImages
					? deleteAllKittyPlacements()
					: this.deleteKittyImages();
			buffer += `${clearImages}\x1b[2J`;
		} else if (imagesNeedRedraw) {
			if (this.imageProtocol === "iterm2") buffer += "\x1b[2J";
			else if (this.imageProtocol === "kitty") buffer += deleteAllKittyPlacements();
		}
		buffer += preparedKittyScreen.evictedImageDeletion;

		for (let row = 0; row < height; row++) {
			if (!fullRedraw && !imagesNeedRedraw && screen[row] === this.previousScreen[row]) continue;
			buffer += `\x1b[${row + 1};1H\x1b[2K${preparedKittyScreen.lines[row] ?? ""}`;
		}

		if (cursorPos) {
			buffer += `\x1b[${cursorPos.row + 1};${Math.min(width, cursorPos.col) + 1}H`;
			buffer += this.getShowHardwareCursor() ? "\x1b[?25h" : "\x1b[?25l";
		} else {
			buffer += "\x1b[?25l";
		}
		buffer += END_SYNCHRONIZED_OUTPUT;
		this.terminal.write(buffer);

		this.previousScreen = screen;
		this.previousScreenWidth = width;
		this.previousScreenHeight = height;
		this.currentLayout = nextLayout;
		this.syncPointerStateAfterCommit();
	}
}
