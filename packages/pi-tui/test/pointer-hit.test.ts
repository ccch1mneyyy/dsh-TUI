import assert from "node:assert";
import { describe, it } from "node:test";
import { HStack } from "../src/components/h-stack.ts";
import { ScrollView } from "../src/components/scroll-view.ts";
import { Text } from "../src/components/text.ts";
import { VStack } from "../src/components/v-stack.ts";
import { getHitChainAt, type LayoutBox, type LayoutFrame, renderLayoutFrame } from "../src/layout.ts";
import type { PointerEvent } from "../src/pointer.ts";
import type { Component } from "../src/tui.ts";
import { stripTerminalSequences } from "../src/utils.ts";

function visibleLines(lines: string[]): string[] {
	return lines.map((line) => stripTerminalSequences(line).trimEnd());
}

describe("getHitChainAt", () => {
	it("returns the deepest-first chain with each layer's component identity", () => {
		const inner = new Text("inner", 0, 0);
		const nested = new VStack([inner]);
		const header = new Text("header", 0, 0);
		const root = new VStack([header, nested]);
		const frame = renderLayoutFrame(root, 10, 4, () => {});

		assert.deepStrictEqual(
			getHitChainAt(frame, 2, 1).map((box) => box.component),
			[inner, nested, root],
		);
		assert.deepStrictEqual(
			getHitChainAt(frame, 2, 0).map((box) => box.component),
			[header, root],
		);
	});

	it("hits horizontal columns and never enters zero-width children", () => {
		const left = new Text("left", 0, 0);
		const zero = new Text("zero", 0, 0);
		const right = new Text("right", 0, 0);
		const root = new HStack([
			{ component: left, basis: 4, shrink: 0 },
			{ component: zero, basis: 0, shrink: 0 },
			{ component: right, basis: 0, grow: 1 },
		]);
		const frame = renderLayoutFrame(root, 10, 2, () => {});
		assert.strictEqual(frame.root.children[1]?.rect.width, 0);

		for (const x of [2, 4, 7]) {
			const chain = getHitChainAt(frame, x, 0);
			assert.ok(chain.every((box) => box.component !== zero));
		}
		assert.deepStrictEqual(
			getHitChainAt(frame, 2, 0).map((box) => box.component),
			[left, root],
		);
		// x=4 is right's left edge: the zero-width sibling at the same x loses.
		assert.deepStrictEqual(
			getHitChainAt(frame, 4, 0).map((box) => box.component),
			[right, root],
		);
		assert.deepStrictEqual(
			getHitChainAt(frame, 7, 0).map((box) => box.component),
			[right, root],
		);
	});

	it("chains through scroll view content in content space", () => {
		const content = new Text("1\n2\n3\n4\n5\n6", 0, 0);
		const scroll = new ScrollView(content, { follow: "end" });
		let frame = renderLayoutFrame(scroll, 10, 3, () => {});
		assert.strictEqual(scroll.scrollTop, 3);

		const chain = getHitChainAt(frame, 1, 1);
		const contentIndex = chain.findIndex((box) => box.component === content);
		const scrollIndex = chain.findIndex((box) => box.scrollView === scroll);
		assert.ok(contentIndex !== -1 && scrollIndex !== -1);
		assert.ok(contentIndex < scrollIndex);

		scroll.scrollBy(-2);
		frame = renderLayoutFrame(scroll, 10, 3, () => {});
		assert.strictEqual(scroll.scrollTop, 1);
		const moved = getHitChainAt(frame, 1, 2);
		const contentBox = moved.find((box) => box.component === content);
		assert.ok(contentBox);
		// rect.y is already translated by the scroll offset, so y - rect.y is
		// the content-space row: viewport row 2 shows content line "4" (row 3).
		assert.strictEqual(contentBox.rect.y, -1);
		assert.strictEqual(2 - contentBox.rect.y, 3);
		assert.deepStrictEqual(visibleLines(frame.lines), ["2", "3", "4"]);
	});

	it("excludes scroll boxes for points outside the viewport", () => {
		const scrollContent = new Text("a\nb\nc\nd", 0, 0);
		const scroll = new ScrollView(scrollContent);
		const dock = new Text("dock", 0, 0);
		const root = new VStack([{ component: scroll, basis: 2, shrink: 0 }, dock]);
		const frame = renderLayoutFrame(root, 10, 4, () => {});

		const chain = getHitChainAt(frame, 1, 2);
		assert.deepStrictEqual(
			chain.map((box) => box.component),
			[dock, root],
		);
		assert.ok(chain.every((box) => box.scrollView === undefined));

		const inside = getHitChainAt(frame, 1, 1);
		assert.deepStrictEqual(
			inside.map((box) => box.component),
			[scrollContent, scroll, root],
		);
	});

	it("prefers the later-painted sibling when rects overlap", () => {
		const bottom = new Text("bottom", 0, 0);
		const top = new Text("top", 0, 0);
		const rootComponent = new Text("root", 0, 0);
		const rect = { x: 0, y: 0, width: 10, height: 2 };
		const boxOf = (component: Component): LayoutBox => ({
			component,
			rect: { ...rect },
			clip: { ...rect },
			children: [],
			layer: 0,
		});
		const bottomBox = boxOf(bottom);
		const topBox = boxOf(top);
		const rootBox: LayoutBox = {
			component: rootComponent,
			rect: { ...rect },
			clip: { ...rect },
			children: [bottomBox, topBox],
			layer: 0,
		};
		bottomBox.parent = rootBox;
		topBox.parent = rootBox;
		const frame: LayoutFrame = { root: rootBox, width: 10, height: 2, lines: [] };

		assert.deepStrictEqual(
			getHitChainAt(frame, 5, 1).map((box) => box.component),
			[top, rootComponent],
		);
		rootBox.children = [topBox, bottomBox];
		assert.deepStrictEqual(
			getHitChainAt(frame, 5, 1).map((box) => box.component),
			[bottom, rootComponent],
		);
	});

	it("stops at the root for blank areas and returns nothing outside it", () => {
		const root = new VStack([new Text("only", 0, 0)]);
		const frame = renderLayoutFrame(root, 10, 4, () => {});

		// Blank row inside the root rect: the chain ends at the root.
		assert.deepStrictEqual(
			getHitChainAt(frame, 5, 2).map((box) => box.component),
			[root],
		);
		// Outside the root: no chain at all.
		assert.deepStrictEqual(getHitChainAt(frame, 5, 4), []);
		assert.deepStrictEqual(getHitChainAt(frame, -1, 0), []);
		assert.deepStrictEqual(getHitChainAt(frame, 10, 0), []);
	});
});

describe("pointer contract guard", () => {
	class PointerAware implements Component {
		readonly events: PointerEvent[] = [];

		render(_width: number): string[] {
			return ["pointer-aware"];
		}

		invalidate(): void {}

		handlePointer(event: PointerEvent): boolean {
			this.events.push(event);
			return true;
		}
	}

	it("mounts and hit-tests components implementing handlePointer", () => {
		const component: Component = new PointerAware();
		const frame = renderLayoutFrame(new VStack([component]), 20, 2, () => {});
		assert.deepStrictEqual(visibleLines(frame.lines), ["pointer-aware", ""]);

		const chain = getHitChainAt(frame, 3, 0);
		assert.strictEqual(chain[0]?.component, component);
		assert.strictEqual(typeof component.handlePointer, "function");
	});
});
