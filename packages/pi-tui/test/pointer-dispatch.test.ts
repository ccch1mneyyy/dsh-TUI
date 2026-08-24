import assert from "node:assert";
import { describe, it } from "node:test";
import { ScrollView } from "../src/components/scroll-view.ts";
import { Text } from "../src/components/text.ts";
import { VStack } from "../src/components/v-stack.ts";
import { LAYOUT_NODE, type LayoutNode } from "../src/layout-node.ts";
import type { PointerEvent, PointerEventType } from "../src/pointer.ts";
import { hyperlink } from "../src/terminal-image.ts";
import { TuiAltScreen } from "../src/tui-alt-screen.ts";
import type { Component } from "../src/tui.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

/** SGR mouse sequence for a 0-based cell. */
function sgr(button: number, x: number, y: number, release = false): string {
	return `\x1b[<${button};${x + 1};${y + 1}${release ? "m" : "M"}`;
}

/** X10 mouse sequence for a 0-based cell (buttonByte is the raw protocol byte). */
function x10(buttonByte: number, x: number, y: number): string {
	return `\x1b[M${String.fromCharCode(buttonByte + 32, x + 33, y + 33)}`;
}

function types(component: { events: PointerEvent[] }): PointerEventType[] {
	return component.events.map((event) => event.type);
}

/** Leaf component with a pointer handler; records every event it receives. */
class PointerBox implements Component {
	readonly events: PointerEvent[] = [];
	readonly name: string;
	private readonly lines: string[];
	private readonly respond: (event: PointerEvent) => boolean;
	readonly log?: string[];

	constructor(name: string, lines: string[], respond?: (event: PointerEvent) => boolean, log?: string[]) {
		this.name = name;
		this.lines = lines;
		this.respond = respond ?? (() => true);
		this.log = log;
	}

	render(_width: number): string[] {
		return this.lines;
	}

	invalidate(): void {}

	handlePointer(event: PointerEvent): boolean {
		this.events.push(event);
		this.log?.push(`${this.name}:${event.type}`);
		return this.respond(event);
	}
}

/** Single-child vertical container with a pointer handler (for bubbling tests). */
class PointerStack implements Component {
	readonly events: PointerEvent[] = [];
	readonly name: string;
	private readonly child: Component;
	private readonly respond: (event: PointerEvent) => boolean;
	readonly log?: string[];

	constructor(name: string, child: Component, respond?: (event: PointerEvent) => boolean, log?: string[]) {
		this.name = name;
		this.child = child;
		this.respond = respond ?? (() => true);
		this.log = log;
	}

	[LAYOUT_NODE](): LayoutNode {
		return { type: "vstack", entries: [{ component: this.child }], gap: 0, align: "stretch" };
	}

	render(width: number): string[] {
		return this.child.render(width);
	}

	invalidate(): void {
		this.child.invalidate();
	}

	handlePointer(event: PointerEvent): boolean {
		this.events.push(event);
		this.log?.push(`${this.name}:${event.type}`);
		return this.respond(event);
	}
}

const TEN_LINES = Array.from({ length: 10 }, (_, index) => `line ${index + 1}`).join("\n");

describe("pointer dispatch: wheel layering", () => {
	it("lets a component consume wheel events before ScrollView routing", async () => {
		const terminal = new VirtualTerminal(20, 6);
		const tui = new TuiAltScreen(terminal);
		const scroll = new ScrollView(new Text(TEN_LINES, 0, 0), { follow: "end", primary: true });
		const panel = new PointerBox("panel", ["panel"]);
		tui.setLayoutRoot(
			new VStack([
				{ component: scroll, basis: 0, grow: 1, minSize: 1 },
				{ component: panel, basis: 1, shrink: 0 },
			]),
		);
		tui.start();
		await terminal.waitForRender();
		assert.strictEqual(scroll.scrollTop, 5);

		terminal.sendInput(sgr(64, 3, 5)); // wheel up over the panel row
		await terminal.waitForRender();

		assert.strictEqual(scroll.scrollTop, 5, "consumed wheel must not reach ScrollView routing");
		assert.deepStrictEqual(types(panel), ["wheel"]);
		const event = panel.events[0]!;
		assert.strictEqual(event.deltaY, -1);
		assert.strictEqual(event.deltaX, 0);
		assert.strictEqual(event.button, -1);
		assert.deepStrictEqual([event.x, event.y], [3, 5]);
		assert.deepStrictEqual([event.localX, event.localY], [3, 0]);
		tui.stop();
	});

	it("routes an unconsumed wheel event through the legacy ScrollView path", async () => {
		const terminal = new VirtualTerminal(20, 6);
		const tui = new TuiAltScreen(terminal);
		const scroll = new ScrollView(new Text(TEN_LINES, 0, 0), { follow: "end", primary: true });
		const panel = new PointerBox("panel", ["panel"], () => false);
		tui.setLayoutRoot(
			new VStack([
				{ component: scroll, basis: 0, grow: 1, minSize: 1 },
				{ component: panel, basis: 1, shrink: 0 },
			]),
		);
		tui.start();
		await terminal.waitForRender();
		assert.strictEqual(scroll.scrollTop, 5);

		terminal.sendInput(sgr(64, 3, 5));
		await terminal.waitForRender();

		assert.deepStrictEqual(types(panel), ["wheel"], "handler sees the event even when not consuming");
		assert.strictEqual(scroll.scrollTop, 4, "unconsumed wheel falls back to the primary scroll view");
		tui.stop();
	});

	it("bubbles wheel deepest-first until a layer consumes it", async () => {
		const terminal = new VirtualTerminal(20, 6);
		const tui = new TuiAltScreen(terminal);
		const log: string[] = [];
		const scroll = new ScrollView(new Text(TEN_LINES, 0, 0), { follow: "end", primary: true });
		const inner = new PointerBox("inner", ["inner"], () => false, log);
		const outer = new PointerStack("outer", inner, () => true, log);
		tui.setLayoutRoot(
			new VStack([
				{ component: scroll, basis: 0, grow: 1, minSize: 1 },
				{ component: outer, basis: 1, shrink: 0 },
			]),
		);
		tui.start();
		await terminal.waitForRender();

		terminal.sendInput(sgr(65, 2, 5)); // wheel down over the inner box
		await terminal.waitForRender();

		assert.deepStrictEqual(log, ["inner:wheel", "outer:wheel"]);
		assert.strictEqual(scroll.scrollTop, 5, "wheel consumed at the outer layer must not scroll");
		const event = outer.events[0]!;
		assert.strictEqual(event.deltaY, 1);
		assert.deepStrictEqual([event.localX, event.localY], [2, 0]);
		tui.stop();
	});

	it("delivers wheel to an overlay component before base routing", async () => {
		const terminal = new VirtualTerminal(20, 6);
		const tui = new TuiAltScreen(terminal);
		const scroll = new ScrollView(new Text(TEN_LINES, 0, 0), { follow: "end", primary: true });
		tui.setLayoutRoot(scroll);
		tui.start();
		await terminal.waitForRender();
		assert.strictEqual(scroll.scrollTop, 4);

		const modal = new PointerBox("modal", ["MODAL"], (event) => event.type === "wheel");
		tui.showOverlay(modal, { width: 10, anchor: "top-left" });
		await terminal.waitForRender();

		terminal.sendInput(sgr(64, 5, 0)); // wheel up inside the overlay region
		await terminal.waitForRender();

		assert.deepStrictEqual(types(modal), ["wheel"]);
		assert.deepStrictEqual([modal.events[0]!.localX, modal.events[0]!.localY], [5, 0]);
		assert.strictEqual(modal.events[0]!.cellIsBlank, false, "overlay hits never report blank cells");
		assert.strictEqual(scroll.scrollTop, 4, "overlay-consumed wheel must not reach the base scroll view");
		tui.stop();
	});
});

describe("pointer dispatch: click vs drag", () => {
	it("dispatches click for a same-cell press/release", async () => {
		const terminal = new VirtualTerminal(20, 4);
		const tui = new TuiAltScreen(terminal);
		const box = new PointerBox("box", ["clickable"]);
		tui.setLayoutRoot(new VStack([box]));
		tui.start();
		await terminal.waitForRender();

		terminal.sendInput(sgr(0, 2, 0));
		terminal.sendInput(sgr(0, 2, 0, true));
		await terminal.waitForRender();

		assert.deepStrictEqual(types(box), ["press", "release", "click"]);
		const click = box.events[2]!;
		assert.strictEqual(click.button, 0);
		assert.deepStrictEqual([click.x, click.y], [2, 0]);
		assert.deepStrictEqual([click.localX, click.localY], [2, 0]);
		tui.stop();
	});

	it("suppresses the OSC 8 fallback for a consumed click, keeps it for an unconsumed one", async () => {
		const terminal = new VirtualTerminal(20, 3);
		const openedUrls: string[] = [];
		const tui = new TuiAltScreen(terminal, undefined, undefined, {
			openUrl: (url) => openedUrls.push(url),
		});
		const url = "https://example.com/path?q=1";
		let consume = true;
		const box = new PointerBox("box", [hyperlink("link", url)], () => consume);
		tui.setLayoutRoot(new VStack([box]));
		tui.start();
		await terminal.waitForRender();

		// Consumed click: no link activation.
		terminal.sendInput(sgr(0, 1, 0));
		terminal.sendInput(sgr(0, 1, 0, true));
		await terminal.waitForRender();
		assert.deepStrictEqual(openedUrls, []);
		assert.deepStrictEqual(types(box), ["press", "release", "click"]);

		// Unconsumed click: the legacy OSC 8 path still runs.
		consume = false;
		terminal.sendInput(sgr(0, 1, 0));
		terminal.sendInput(sgr(0, 1, 0, true));
		await terminal.waitForRender();
		assert.deepStrictEqual(openedUrls, [url]);
		tui.stop();
	});

	it("does not dispatch click for a cross-cell drag and completes the selection copy", async () => {
		const terminal = new VirtualTerminal(20, 4);
		const copied: string[] = [];
		const tui = new TuiAltScreen(terminal, undefined, undefined, {
			copySelection: async (text) => {
				copied.push(text);
				return true;
			},
		});
		const box = new PointerBox("box", ["alpha"], () => false);
		tui.setLayoutRoot(new VStack([box, new Text("beta\ngamma", 0, 0)]));
		tui.start();
		await terminal.waitForRender();

		terminal.sendInput(sgr(0, 0, 0));
		terminal.sendInput(sgr(32, 4, 1)); // drag motion
		terminal.sendInput(sgr(0, 4, 1, true));
		await terminal.waitForRender();

		assert.deepStrictEqual(copied, ["alpha\nbeta"], "drag release must complete the selection path");
		assert.deepStrictEqual(types(box), ["press"], "drag releases never dispatch click");
		tui.stop();
	});
});

describe("pointer dispatch: capture", () => {
	it("directs move/release to the captured chain, even out of bounds", async () => {
		const terminal = new VirtualTerminal(20, 6);
		const copied: string[] = [];
		const tui = new TuiAltScreen(terminal, undefined, undefined, {
			copySelection: async (text) => {
				copied.push(text);
				return true;
			},
		});
		const box = new PointerBox("box", ["panel"]);
		tui.setLayoutRoot(new VStack([box]));
		tui.start();
		await terminal.waitForRender();

		terminal.sendInput(sgr(0, 2, 0)); // consumed press captures the pointer
		terminal.sendInput(sgr(32, 8, 3)); // drag motion far outside the box
		terminal.sendInput(sgr(0, 15, 5, true)); // release outside the box
		await terminal.waitForRender();

		assert.deepStrictEqual(types(box), ["press", "move", "release"], "no click for a cross-cell release");
		assert.strictEqual(box.events[0]!.button, 0);
		assert.strictEqual(box.events[1]!.button, -1, "move events carry no button");
		assert.deepStrictEqual([box.events[1]!.localX, box.events[1]!.localY], [8, 3]);
		assert.deepStrictEqual(
			[box.events[2]!.localX, box.events[2]!.localY],
			[15, 5],
			"captured release is delivered with out-of-bounds locals",
		);
		assert.deepStrictEqual(copied, [], "a consumed press never starts a selection");
		tui.stop();
	});

	it("pairs the release with every component that received the captured press", async () => {
		const terminal = new VirtualTerminal(20, 4);
		const tui = new TuiAltScreen(terminal);
		const log: string[] = [];
		const inner = new PointerBox("inner", ["inner"], () => false, log);
		const outer = new PointerStack("outer", inner, () => true, log);
		tui.setLayoutRoot(new VStack([outer]));
		tui.start();
		await terminal.waitForRender();

		terminal.sendInput(sgr(0, 1, 0));
		terminal.sendInput(sgr(0, 1, 0, true));
		await terminal.waitForRender();

		// The press bubbled inner -> outer (consumed at outer); the release is
		// delivered to both regardless of consumption so pressed state pairs up.
		assert.deepStrictEqual(log, [
			"inner:press",
			"outer:press",
			"inner:release",
			"outer:release",
			"inner:click",
			"outer:click",
		]);
		tui.stop();
	});

	it("synthesizes a release for the captured chain on focus loss", async () => {
		const terminal = new VirtualTerminal(20, 4);
		const tui = new TuiAltScreen(terminal);
		const box = new PointerBox("box", ["panel"]);
		tui.setLayoutRoot(new VStack([box]));
		tui.start();
		await terminal.waitForRender();

		terminal.sendInput(sgr(0, 2, 0));
		terminal.sendInput("\x1b[O"); // FOCUS_OUT mid-capture
		terminal.sendInput(sgr(32, 5, 1)); // no longer directed at the box
		await terminal.waitForRender();

		assert.deepStrictEqual(types(box), ["press", "release"], "focus loss pairs the press with a release");
		tui.stop();
	});
});

describe("pointer dispatch: overlays", () => {
	it("blocks pass-through for capturing overlays and delivers outside clicks to the modal", async () => {
		const terminal = new VirtualTerminal(20, 6);
		const tui = new TuiAltScreen(terminal);
		const base = new PointerBox("base", ["base-content"]);
		tui.setLayoutRoot(new VStack([base]));
		tui.start();
		await terminal.waitForRender();

		let modalConsumes = false;
		const modal = new PointerBox("modal", ["MODAL"], () => modalConsumes);
		tui.showOverlay(modal, { width: 10, anchor: "top-left" }); // region {0,0,10,1}
		await terminal.waitForRender();

		// Hit on the capturing region: the base component under it gets nothing,
		// even though the modal does not consume the event.
		terminal.sendInput(sgr(0, 5, 0));
		terminal.sendInput(sgr(0, 5, 0, true));
		await terminal.waitForRender();
		assert.deepStrictEqual(types(modal), ["press", "release", "click"]);
		assert.deepStrictEqual(modal.events[0]!.localX, 5);
		assert.deepStrictEqual(types(base), [], "capturing overlays never pass through to the base tree");

		// Outside click: delivered to the modal itself with out-of-bounds locals.
		modalConsumes = true;
		terminal.sendInput(sgr(0, 15, 4));
		terminal.sendInput(sgr(0, 15, 4, true));
		await terminal.waitForRender();
		assert.deepStrictEqual(types(modal), ["press", "release", "click", "press", "release", "click"]);
		assert.deepStrictEqual([modal.events[3]!.localX, modal.events[3]!.localY], [15, 4]);
		assert.deepStrictEqual([modal.events[5]!.localX, modal.events[5]!.localY], [15, 4]);
		assert.deepStrictEqual(types(base), []);
		tui.stop();
	});

	it("passes an unconsumed non-capturing overlay hit through to the base tree", async () => {
		const terminal = new VirtualTerminal(20, 4);
		const tui = new TuiAltScreen(terminal);
		const log: string[] = [];
		const base = new PointerBox("base", ["base-content"], () => true, log);
		tui.setLayoutRoot(new VStack([base]));
		tui.start();
		await terminal.waitForRender();

		const passive = new PointerBox("passive", ["PASS"], () => false, log);
		tui.showOverlay(passive, { width: 10, anchor: "top-left", nonCapturing: true });
		await terminal.waitForRender();

		terminal.sendInput(sgr(0, 5, 0));
		terminal.sendInput(sgr(0, 5, 0, true));
		await terminal.waitForRender();

		// The overlay sees the event first; the base tree gets it when the overlay
		// does not consume. Both ends of the mixed capture chain pair the release.
		assert.deepStrictEqual(log, [
			"passive:press",
			"base:press",
			"passive:release",
			"base:release",
			"passive:click",
			"base:click",
		]);
		tui.stop();
	});
});

describe("pointer dispatch: robustness", () => {
	it("isolates handler exceptions as consumed and keeps the input loop alive", async () => {
		const terminal = new VirtualTerminal(20, 6);
		const copied: string[] = [];
		const tui = new TuiAltScreen(terminal, undefined, undefined, {
			copySelection: async (text) => {
				copied.push(text);
				return true;
			},
		});
		const scroll = new ScrollView(new Text(TEN_LINES, 0, 0), { follow: "end", primary: true });
		const box = new PointerBox("boom", ["boom"], () => {
			throw new Error("boom");
		});
		tui.setLayoutRoot(
			new VStack([
				{ component: scroll, basis: 0, grow: 1, minSize: 1 },
				{ component: box, basis: 1, shrink: 0 },
			]),
		);
		tui.start();
		await terminal.waitForRender();
		assert.strictEqual(scroll.scrollTop, 5);

		terminal.sendInput(sgr(0, 2, 5)); // throws: treated as consumed, captures
		terminal.sendInput(sgr(0, 2, 5, true)); // release + click throw again
		await terminal.waitForRender();
		assert.deepStrictEqual(types(box), ["press", "release", "click"]);
		assert.deepStrictEqual(copied, [], "a throwing handler still suppresses the selection fallback");

		// The input loop is unaffected: subsequent wheel input routes normally.
		terminal.sendInput(sgr(64, 2, 0));
		await terminal.waitForRender();
		assert.strictEqual(scroll.scrollTop, 4);
		tui.stop();
	});

	it("decodes X10 mouse sequences", async () => {
		const terminal = new VirtualTerminal(20, 4);
		const tui = new TuiAltScreen(terminal);
		const box = new PointerBox("box", ["clickable"]);
		tui.setLayoutRoot(new VStack([box]));
		tui.start();
		await terminal.waitForRender();

		terminal.sendInput(x10(0, 2, 0)); // left press at cell (2,0)
		terminal.sendInput(x10(3, 2, 0)); // X10 release (button byte 3)
		await terminal.waitForRender();

		assert.deepStrictEqual(types(box), ["press", "release", "click"]);
		assert.strictEqual(box.events[0]!.button, 0);
		assert.strictEqual(box.events[1]!.button, -1, "X10 releases carry no button identity");
		assert.deepStrictEqual([box.events[2]!.x, box.events[2]!.y], [2, 0]);
		tui.stop();
	});

	it("keeps legacy behavior and skips dispatch entirely with mouse: false", async () => {
		const terminal = new VirtualTerminal(20, 6);
		const tui = new TuiAltScreen(terminal, undefined, undefined, { mouse: false });
		const scroll = new ScrollView(new Text(TEN_LINES, 0, 0), { follow: "end", primary: true });
		const box = new PointerBox("box", ["panel"]);
		tui.setLayoutRoot(
			new VStack([
				{ component: scroll, basis: 0, grow: 1, minSize: 1 },
				{ component: box, basis: 1, shrink: 0 },
			]),
		);
		tui.start();
		await terminal.waitForRender();
		assert.strictEqual(scroll.scrollTop, 5);

		terminal.sendInput(sgr(0, 2, 5));
		terminal.sendInput(sgr(0, 2, 5, true));
		await terminal.waitForRender();
		assert.deepStrictEqual(box.events, [], "mouse: false disables generic pointer dispatch");

		// The legacy wheel route is untouched (terminals never send these when
		// mouse is off; if a sequence still arrives it behaves as before).
		terminal.sendInput(sgr(64, 2, 0));
		await terminal.waitForRender();
		assert.strictEqual(scroll.scrollTop, 4);
		tui.stop();
	});
});

describe("pointer dispatch: hover", () => {
	it("diffs enter/leave across move events (leave deepest-first, enter shallowest-first)", async () => {
		const terminal = new VirtualTerminal(20, 4);
		const tui = new TuiAltScreen(terminal);
		const log: string[] = [];
		const inner = new PointerBox("inner", ["in"], () => true, log);
		const outer = new PointerStack("outer", inner, () => false, log);
		const below = new PointerBox("below", ["below"], () => true, log);
		tui.setLayoutRoot(new VStack([outer, below]));
		tui.start();
		await terminal.waitForRender();

		terminal.sendInput(sgr(35, 1, 0)); // hover move over the nested box (row 0)
		await terminal.waitForRender();
		assert.deepStrictEqual(log, ["outer:enter", "inner:enter", "inner:move"]);
		assert.strictEqual(inner.events.at(-1)!.button, -1, "hover moves carry no button");

		terminal.sendInput(sgr(35, 1, 1)); // move to the sibling below (row 1)
		await terminal.waitForRender();
		assert.deepStrictEqual(log, [
			"outer:enter",
			"inner:enter",
			"inner:move",
			"inner:leave",
			"outer:leave",
			"below:enter",
			"below:move",
		]);
		tui.stop();
	});

	it("synthesizes leave when the hovered target vanishes from a committed frame", async () => {
		const terminal = new VirtualTerminal(20, 4);
		const tui = new TuiAltScreen(terminal);
		const a = new PointerBox("a", ["AAA"], () => false);
		const b = new PointerBox("b", ["BBB"], () => false);
		tui.setLayoutRoot(new VStack([a, b]));
		tui.start();
		await terminal.waitForRender();

		terminal.sendInput(sgr(35, 2, 1)); // hover b
		await terminal.waitForRender();
		assert.deepStrictEqual(types(b), ["enter", "move"]);

		// b disappears from the next committed frame: leave is synthesized.
		tui.setLayoutRoot(new VStack([a, new Text("ccc", 0, 0)]));
		await terminal.waitForRender();
		assert.deepStrictEqual(types(b), ["enter", "move", "leave"]);
		tui.stop();
	});
});
