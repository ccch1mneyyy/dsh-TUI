import assert from "node:assert";
import { describe, it } from "node:test";
import { Text } from "../src/components/text.ts";
import { TuiAltScreen } from "../src/tui-alt-screen.ts";
import type { OverlayHitRegion } from "../src/tui.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

class TestTui extends TuiAltScreen {
	get hitRegions(): readonly OverlayHitRegion[] {
		return this.overlayHitRegions;
	}
}

describe("overlay hit regions", () => {
	it("records the region where the overlay actually renders", async () => {
		const terminal = new VirtualTerminal(20, 6);
		const tui = new TestTui(terminal);
		tui.addChild(new Text("base", 0, 0));
		tui.start();
		await terminal.waitForRender();

		tui.showOverlay(new Text("POPUP", 0, 0), { width: 8 });
		await terminal.waitForRender();

		assert.strictEqual(tui.hitRegions.length, 1);
		const region = tui.hitRegions[0]!;
		// Centered in 20x6: col = (20-8)/2 = 6, row = floor((6-1)/2) = 2.
		assert.deepStrictEqual(region.rect, { x: 6, y: 2, width: 8, height: 1 });
		const viewport = terminal.getViewport();
		assert.strictEqual(viewport[2]?.indexOf("POPUP"), region.rect.x);
		assert.ok(viewport.every((line, row) => row === region.rect.y || !line.includes("POPUP")));
		tui.stop();
	});

	it("records the actual line count after maxHeight slicing", async () => {
		const terminal = new VirtualTerminal(20, 6);
		const tui = new TestTui(terminal);
		tui.start();
		await terminal.waitForRender();

		tui.showOverlay(new Text("A1\nA2\nA3", 0, 0), { width: 10, maxHeight: 2, anchor: "top-left" });
		await terminal.waitForRender();

		assert.strictEqual(tui.hitRegions.length, 1);
		assert.deepStrictEqual(tui.hitRegions[0]?.rect, { x: 0, y: 0, width: 10, height: 2 });
		const viewport = terminal.getViewport();
		assert.ok(viewport[0]?.includes("A1"));
		assert.ok(viewport[1]?.includes("A2"));
		assert.ok(!viewport.some((line) => line.includes("A3")));
		tui.stop();
	});

	it("orders regions topmost-first by focusOrder", async () => {
		const terminal = new VirtualTerminal(20, 6);
		const tui = new TestTui(terminal);
		tui.start();
		await terminal.waitForRender();

		const first = new Text("FIRST", 0, 0);
		const second = new Text("SECOND", 0, 0);
		const firstHandle = tui.showOverlay(first, { width: 8 });
		tui.showOverlay(second, { width: 8 });
		await terminal.waitForRender();

		assert.deepStrictEqual(
			tui.hitRegions.map((region) => region.component),
			[second, first],
		);
		assert.ok(tui.hitRegions.every((region, index, regions) => index === 0 || regions[index - 1]!.focusOrder > region.focusOrder));

		firstHandle.focus();
		await terminal.waitForRender();

		assert.deepStrictEqual(
			tui.hitRegions.map((region) => region.component),
			[first, second],
		);
		assert.ok(tui.hitRegions[0]!.focusOrder > tui.hitRegions[1]!.focusOrder);
		tui.stop();
	});

	it("marks nonCapturing overlays as not capturing", async () => {
		const terminal = new VirtualTerminal(20, 6);
		const tui = new TestTui(terminal);
		tui.start();
		await terminal.waitForRender();

		tui.showOverlay(new Text("CAPTURING", 0, 0), { width: 10, anchor: "top-left" });
		tui.showOverlay(new Text("PASSIVE", 0, 0), { width: 10, anchor: "bottom-right", nonCapturing: true });
		await terminal.waitForRender();

		assert.strictEqual(tui.hitRegions.length, 2);
		const byCapturing = new Map(tui.hitRegions.map((region) => [region.capturing, region]));
		assert.ok(byCapturing.get(true));
		assert.ok(byCapturing.get(false));
		tui.stop();
	});

	it("tracks hidden and removed overlays", async () => {
		const terminal = new VirtualTerminal(20, 6);
		const tui = new TestTui(terminal);
		tui.start();
		await terminal.waitForRender();

		// No overlay: empty regions.
		assert.deepStrictEqual(tui.hitRegions, []);

		const hidden = new Text("HIDDEN", 0, 0);
		const shown = new Text("SHOWN", 0, 0);
		const hiddenHandle = tui.showOverlay(hidden, { width: 8, anchor: "top-left" });
		const shownHandle = tui.showOverlay(shown, { width: 8, anchor: "bottom-right" });
		await terminal.waitForRender();
		assert.strictEqual(tui.hitRegions.length, 2);

		// setHidden(true) drops the region while keeping the entry.
		hiddenHandle.setHidden(true);
		await terminal.waitForRender();
		assert.deepStrictEqual(
			tui.hitRegions.map((region) => region.component),
			[shown],
		);

		// hide() removes the last overlay; compositing then clears the regions.
		shownHandle.hide();
		await terminal.waitForRender();
		assert.deepStrictEqual(tui.hitRegions, []);
		tui.stop();
	});
});
