import assert from "node:assert";
import { describe, it } from "node:test";
import { ScrollView } from "../src/components/scroll-view.ts";
import { Text } from "../src/components/text.ts";

/** Guard for the local ScrollView content-metrics getters (see AGENTS.md
 *  "Local commits"): hosts steering a timeline/pill need the exact clamp
 *  ceiling, which only the layout-fed state can provide. */
describe("ScrollView content metrics", () => {
	it("exposes contentHeight and maxScrollTop from updateLayout", () => {
		const scroll = new ScrollView(new Text("a\nb\nc", 0, 0), { follow: "end" });
		assert.equal(scroll.contentHeight, 0);
		assert.equal(scroll.maxScrollTop, 0);

		scroll.updateLayout(100, 10, () => {});
		assert.equal(scroll.contentHeight, 100);
		assert.equal(scroll.viewportHeight, 10);
		assert.equal(scroll.maxScrollTop, 90);
	});

	it("floors maxScrollTop at 0 when the content fits the viewport", () => {
		const scroll = new ScrollView(new Text("a", 0, 0), { follow: "end" });
		scroll.updateLayout(6, 10, () => {});
		assert.equal(scroll.contentHeight, 6);
		assert.equal(scroll.maxScrollTop, 0);
		assert.equal(scroll.scrollTop, 0);
	});

	it("keeps the getters in sync with the scroll clamp", () => {
		const scroll = new ScrollView(new Text("a\nb\nc", 0, 0), { follow: "end" });
		scroll.updateLayout(100, 10, () => {});
		scroll.scrollTo(50);
		assert.equal(scroll.scrollTop, 50);
		assert.equal(scroll.maxScrollTop, 90);

		// Clamped to maxScrollTop, and follow-end re-pins at the ceiling.
		scroll.scrollTo(Number.MAX_SAFE_INTEGER);
		assert.equal(scroll.scrollTop, scroll.maxScrollTop);
		assert.equal(scroll.isFollowingEnd, true);

		// Shrinking content re-clamps scrollTop; the getters follow.
		scroll.updateLayout(40, 10, () => {});
		assert.equal(scroll.contentHeight, 40);
		assert.equal(scroll.maxScrollTop, 30);
		assert.equal(scroll.scrollTop, 30);
	});
});
