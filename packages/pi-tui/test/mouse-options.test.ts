import assert from "node:assert";
import { describe, it } from "node:test";
import { ScrollView } from "../src/components/scroll-view.ts";
import { Text } from "../src/components/text.ts";
import { VStack } from "../src/components/v-stack.ts";
import type { PointerEvent, PointerEventType } from "../src/pointer.ts";
import { TuiAltScreen } from "../src/tui-alt-screen.ts";
import type { Component } from "../src/tui.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

/** SGR mouse sequence for a 0-based cell. */
function sgr(button: number, x: number, y: number, release = false): string {
	return `\x1b[<${button};${x + 1};${y + 1}${release ? "m" : "M"}`;
}

function types(component: { events: PointerEvent[] }): PointerEventType[] {
	return component.events.map((event) => event.type);
}

/** Leaf component with a pointer handler; records every event it receives. */
class PointerBox implements Component {
	readonly events: PointerEvent[] = [];
	private readonly lines: string[];
	private readonly respond: (event: PointerEvent) => boolean;

	constructor(lines: string[], respond?: (event: PointerEvent) => boolean) {
		this.lines = lines;
		this.respond = respond ?? (() => true);
	}

	render(_width: number): string[] {
		return this.lines;
	}

	invalidate(): void {}

	handlePointer(event: PointerEvent): boolean {
		this.events.push(event);
		return this.respond(event);
	}
}

const TEN_LINES = Array.from({ length: 10 }, (_, index) => `line ${index + 1}`).join("\n");

describe("mouse option granularity", () => {
	it("buttons:false disables click dispatch and selection but keeps wheel scroll", async () => {
		const terminal = new VirtualTerminal(20, 6);
		const copied: string[] = [];
		const tui = new TuiAltScreen(terminal, undefined, undefined, {
			mouse: { buttons: false },
			copySelection: async (text) => {
				copied.push(text);
				return true;
			},
		});
		const scroll = new ScrollView(new Text(TEN_LINES, 0, 0), { follow: "end", primary: true });
		const panel = new PointerBox(["panel"]);
		tui.setLayoutRoot(
			new VStack([
				{ component: scroll, basis: 0, grow: 1, minSize: 1 },
				{ component: panel, basis: 1, shrink: 0 },
			]),
		);
		tui.start();
		await terminal.waitForRender();
		const initialTop = scroll.scrollTop;

		// A click on the panel dispatches nothing and starts no selection.
		terminal.sendInput(sgr(0, 3, 5));
		terminal.sendInput(sgr(0, 3, 5, true));
		// A drag across the scroll content never starts a selection either.
		terminal.sendInput(sgr(0, 0, 0));
		terminal.sendInput(sgr(32, 4, 1));
		terminal.sendInput(sgr(0, 4, 1, true));
		await terminal.waitForRender();

		assert.deepStrictEqual(types(panel), [], "button events must not dispatch when buttons are off");
		assert.deepStrictEqual(copied, [], "button events must not drive selection when buttons are off");
		assert.strictEqual(scroll.scrollTop, initialTop);

		// Wheel still routes to components first, then to the ScrollView.
		terminal.sendInput(sgr(64, 3, 5)); // wheel up over the panel row
		await terminal.waitForRender();
		assert.deepStrictEqual(types(panel), ["wheel"], "wheel dispatch survives buttons:false");

		terminal.sendInput(sgr(64, 3, 1)); // wheel up over the scroll content
		await terminal.waitForRender();
		assert.ok(scroll.scrollTop < initialTop, "wheel must still scroll when buttons are off");
		tui.stop();
	});

	it("wheel:false disables scroll routing but keeps click dispatch", async () => {
		const terminal = new VirtualTerminal(20, 6);
		const tui = new TuiAltScreen(terminal, undefined, undefined, { mouse: { wheel: false } });
		const scroll = new ScrollView(new Text(TEN_LINES, 0, 0), { follow: "end", primary: true });
		const panel = new PointerBox(["panel"]);
		tui.setLayoutRoot(
			new VStack([
				{ component: scroll, basis: 0, grow: 1, minSize: 1 },
				{ component: panel, basis: 1, shrink: 0 },
			]),
		);
		tui.start();
		await terminal.waitForRender();
		const initialTop = scroll.scrollTop;

		terminal.sendInput(sgr(65, 3, 1)); // wheel down over the scroll content
		await terminal.waitForRender();
		assert.strictEqual(scroll.scrollTop, initialTop, "wheel must not scroll when wheel is off");

		terminal.sendInput(sgr(0, 3, 5));
		terminal.sendInput(sgr(0, 3, 5, true));
		await terminal.waitForRender();
		assert.deepStrictEqual(types(panel), ["press", "release", "click"], "click dispatch survives wheel:false");
		tui.stop();
	});

	it("mouse:false keeps tracking off and the legacy selection path for stray sequences", async () => {
		const terminal = new VirtualTerminal(20, 6);
		const copied: string[] = [];
		const tui = new TuiAltScreen(terminal, undefined, undefined, {
			mouse: false,
			copySelection: async (text) => {
				copied.push(text);
				return true;
			},
		});
		const scroll = new ScrollView(new Text(TEN_LINES, 0, 0), { follow: "end", primary: true });
		const panel = new PointerBox(["panel"]);
		tui.setLayoutRoot(
			new VStack([
				{ component: scroll, basis: 0, grow: 1, minSize: 1 },
				{ component: panel, basis: 1, shrink: 0 },
			]),
		);
		tui.start();
		await terminal.waitForRender();
		const initialTop = scroll.scrollTop;

		// Tracking was never enabled, yet a stray sequence keeps the pre-pointer
		// dispatch behavior byte-identical: selection still works.
		terminal.sendInput(sgr(0, 0, 0));
		terminal.sendInput(sgr(32, 4, 1));
		terminal.sendInput(sgr(0, 4, 1, true));
		await terminal.waitForRender();
		// The ScrollView follows the end, so the visible top row is "line 6".
		assert.deepStrictEqual(copied, ["line 6\nline"], "stray button sequences keep the legacy selection path");
		assert.deepStrictEqual(types(panel), [], "pointer dispatch stays off with mouse:false");

		// Stray wheel sequences keep the legacy route as well (the stage-2
		// contract: with tracking off, arriving sequences behave as before).
		terminal.sendInput(sgr(64, 3, 1));
		await terminal.waitForRender();
		assert.strictEqual(scroll.scrollTop, initialTop - 1, "stray wheel keeps the legacy route with mouse:false");
		tui.stop();
	});
});
