import assert from "node:assert";
import { describe, it } from "node:test";
import { SettingsList, type SettingsListTheme } from "../src/components/settings-list.ts";

const testTheme: SettingsListTheme = {
	label: (text) => text,
	value: (text) => text,
	description: (text) => text,
	cursor: "> ",
	hint: (text) => text,
};

const items = [
	{
		id: "tui-mode",
		label: "TUI mode",
		currentValue: "regular",
		values: ["regular", "fullscreen"],
	},
];

describe("SettingsList", () => {
	it("includes spaces in an active search instead of changing the selected setting", () => {
		const changes: Array<{ id: string; value: string }> = [];
		const list = new SettingsList(
			items.map((item) => ({ ...item })),
			10,
			testTheme,
			(id, value) => changes.push({ id, value }),
			() => {},
			{ enableSearch: true },
		);

		for (const character of "TUI mode") list.handleInput(character);

		assert.deepStrictEqual(changes, []);
		assert.match(list.render(80)[0] ?? "", /TUI mode/);

		list.handleInput("\r");
		assert.deepStrictEqual(changes, [{ id: "tui-mode", value: "fullscreen" }]);
	});

	it("keeps Space as a change shortcut before a search query is entered", () => {
		const changes: Array<{ id: string; value: string }> = [];
		const list = new SettingsList(
			items.map((item) => ({ ...item })),
			10,
			testTheme,
			(id, value) => changes.push({ id, value }),
			() => {},
			{ enableSearch: true },
		);

		list.handleInput(" ");

		assert.deepStrictEqual(changes, [{ id: "tui-mode", value: "fullscreen" }]);
	});

	it("renders localized string overrides for hint and empty states", () => {
		const list = new SettingsList(items.map((item) => ({ ...item })), 10, testTheme, () => {}, () => {}, {
			enableSearch: true,
			strings: { hint: "  HINT-OVERRIDE", noMatches: "  NOTHING-MATCHES", noSettings: "  NOTHING-AT-ALL" },
		});

		for (const character of "zzz-no-match") list.handleInput(character);
		const filtered = list.render(80).join("\n");
		assert.ok(filtered.includes("NOTHING-MATCHES"));
		assert.ok(filtered.includes("HINT-OVERRIDE"));
		assert.ok(!filtered.includes("Esc to cancel"));

		const empty = new SettingsList([], 10, testTheme, () => {}, () => {}, {
			strings: { noSettings: "  NOTHING-AT-ALL" },
		});
		assert.ok(empty.render(80).join("\n").includes("NOTHING-AT-ALL"));
	});
});
