import assert from "node:assert";
import { describe, it } from "node:test";
import type { AutocompleteProvider } from "../src/autocomplete.ts";
import { Editor } from "../src/components/editor.ts";
import { SelectList, type SelectItem } from "../src/components/select-list.ts";
import { SettingsList, type SettingItem } from "../src/components/settings-list.ts";
import { VStack } from "../src/components/v-stack.ts";
import type { PointerEvent, PointerEventType } from "../src/pointer.ts";
import { TuiAltScreen } from "../src/tui-alt-screen.ts";
import type { TUI } from "../src/tui.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { defaultEditorTheme } from "./test-themes.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

/**
 * Guard tests for the pointer support on the list-style components:
 * - SelectList.handlePointer: click a visible row = focus + onSelect (Enter
 *   parity), wheel steps the selection clamped at the ends.
 * - SettingsList.handlePointer: click a row = focus + activate (cycle/submenu),
 *   wheel steps clamped, an open submenu owns the pointer.
 * - Editor.handlePointer: routes clicks/wheel landing on the autocomplete menu
 *   rows into the menu; a menu click confirms through the keyboard Enter path.
 * - Editor click-to-caret: a primary click on the text rows moves the cursor
 *   to the grapheme boundary nearest the clicked cell (CJK/emoji/combining
 *   safe, soft-wrap aware), without consuming the event so drag selection and
 *   double/triple-click word/line selection keep working.
 */

function pointerEvent(type: PointerEventType, localY: number, overrides: Partial<PointerEvent> = {}): PointerEvent {
	return {
		type,
		x: 2,
		y: localY,
		localX: 2,
		localY,
		button: type === "click" || type === "press" ? 0 : -1,
		shift: false,
		alt: false,
		ctrl: false,
		deltaX: 0,
		deltaY: 0,
		cellIsBlank: false,
		...overrides,
	};
}

const selectTheme = {
	selectedPrefix: (text: string) => text,
	selectedText: (text: string) => `>${text}<`,
	description: (text: string) => text,
	scrollInfo: (text: string) => text,
	noMatch: (text: string) => text,
};

describe("SelectList pointer", () => {
	const items = (count: number): SelectItem[] =>
		Array.from({ length: count }, (_, index) => ({ value: `v${index}`, label: `item-${index}` }));

	it("click focuses the row and fires onSelect (Enter parity)", () => {
		const list = new SelectList(items(3), 5, selectTheme);
		const selected: string[] = [];
		const changes: string[] = [];
		list.onSelect = (item) => selected.push(item.value);
		list.onSelectionChange = (item) => changes.push(item.value);
		list.render(80);

		assert.equal(list.handlePointer(pointerEvent("click", 1)), true);
		assert.deepEqual(selected, ["v1"]);
		assert.deepEqual(changes, ["v1"]);
		assert.equal(list.getSelectedItem()?.value, "v1");
	});

	it("click beyond the item rows (scroll-info line) consumes without acting", () => {
		const list = new SelectList(items(8), 4, selectTheme);
		const selected: string[] = [];
		list.onSelect = (item) => selected.push(item.value);
		const lines = list.render(80);
		assert.equal(lines.length, 5, "4 item rows + scroll info line");

		assert.equal(list.handlePointer(pointerEvent("click", 4)), true);
		assert.deepEqual(selected, []);
		assert.equal(list.getSelectedItem()?.value, "v0");
		// A non-primary button never activates a row.
		assert.equal(list.handlePointer(pointerEvent("click", 2, { button: 2 })), true);
		assert.deepEqual(selected, []);
		assert.equal(list.getSelectedItem()?.value, "v0");
	});

	it("wheel steps the selection and clamps at the ends instead of wrapping", () => {
		const list = new SelectList(items(3), 5, selectTheme);
		list.render(80);

		assert.equal(list.handlePointer(pointerEvent("wheel", 0, { deltaY: 1 })), true);
		assert.equal(list.getSelectedItem()?.value, "v1");
		// Clamped at the bottom: the keyboard arrows would wrap to v0 here.
		list.handlePointer(pointerEvent("wheel", 0, { deltaY: 1 }));
		list.handlePointer(pointerEvent("wheel", 0, { deltaY: 1 }));
		assert.equal(list.getSelectedItem()?.value, "v2");
		// Clamped back at the top.
		list.handlePointer(pointerEvent("wheel", 0, { deltaY: -1 }));
		list.handlePointer(pointerEvent("wheel", 0, { deltaY: -1 }));
		list.handlePointer(pointerEvent("wheel", 0, { deltaY: -1 }));
		assert.equal(list.getSelectedItem()?.value, "v0");
	});

	it("press/release/move are not consumed (text selection stays available)", () => {
		const list = new SelectList(items(3), 5, selectTheme);
		list.render(80);
		assert.equal(list.handlePointer(pointerEvent("press", 0)), undefined);
		assert.equal(list.handlePointer(pointerEvent("release", 0)), undefined);
		assert.equal(list.handlePointer(pointerEvent("move", 0)), undefined);
	});
});

describe("SettingsList pointer", () => {
	const settingsTheme = {
		label: (text: string) => text,
		value: (text: string) => text,
		description: (text: string) => text,
		cursor: "❯ ",
		hint: (text: string) => text,
	};

	function makeList(options: { search?: boolean } = {}) {
		const changes: Array<[string, string]> = [];
		let cancels = 0;
		const items: SettingItem[] = [
			{ id: "a", label: "Alpha", currentValue: "on", values: ["on", "off"] },
			{ id: "b", label: "Beta", currentValue: "x", values: ["x", "y"] },
			{
				id: "g",
				label: "Group",
				currentValue: "configure",
				submenu: () => ({
					render: () => ["SUBMENU"],
					invalidate() {},
				}),
			},
		];
		const list = new SettingsList(
			items,
			8,
			settingsTheme,
			(id, value) => changes.push([id, value]),
			() => {
				cancels += 1;
			},
			options.search ? { enableSearch: true } : {},
		);
		return { list, changes, cancels: () => cancels };
	}

	it("click focuses the row and activates it like Enter (cycle)", () => {
		const { list, changes } = makeList();
		list.render(80);
		assert.equal(list.handlePointer(pointerEvent("click", 1)), true);
		assert.deepEqual(changes, [["b", "y"]]);
		// The click also moved the selection: the cursor marker follows.
		const lines = list.render(80);
		assert.ok(lines[1]!.startsWith("❯ "));
	});

	it("click on a submenu row opens the submenu, which then owns the pointer", () => {
		const { list } = makeList();
		list.render(80);
		assert.equal(list.handlePointer(pointerEvent("click", 2)), true);
		assert.deepEqual(list.render(80), ["SUBMENU"], "submenu renders instead of the list");
		// Events while the submenu is open are consumed by it (or swallowed).
		assert.equal(list.handlePointer(pointerEvent("click", 0)), true);
		assert.equal(list.handlePointer(pointerEvent("wheel", 0, { deltaY: 1 })), true);
	});

	it("with search enabled the item rows start below the search box", () => {
		const { list, changes } = makeList({ search: true });
		list.render(80);
		// Row 0/1 are the search input + spacer: consumed, no action.
		assert.equal(list.handlePointer(pointerEvent("click", 0)), true);
		assert.equal(list.handlePointer(pointerEvent("click", 1)), true);
		assert.deepEqual(changes, []);
		assert.equal(list.handlePointer(pointerEvent("click", 2)), true);
		assert.deepEqual(changes, [["a", "off"]]);
	});

	it("wheel steps the selection clamped at the ends", () => {
		const { list } = makeList();
		list.render(80);
		assert.equal(list.handlePointer(pointerEvent("wheel", 0, { deltaY: 1 })), true);
		assert.ok(list.render(80)[1]!.startsWith("❯ "));
		list.handlePointer(pointerEvent("wheel", 0, { deltaY: -1 }));
		list.handlePointer(pointerEvent("wheel", 0, { deltaY: -1 }));
		assert.ok(list.render(80)[0]!.startsWith("❯ "), "clamped at the top row");
	});
});

describe("Editor autocomplete pointer", () => {
	function createTestTUI(cols = 80, rows = 24): TUI {
		return new TuiMainScreen(new VirtualTerminal(cols, rows));
	}

	async function flushAutocomplete(): Promise<void> {
		await Promise.resolve();
		await new Promise((resolve) => setImmediate(resolve));
	}

	/** Slash-style provider: three commands, prefix replaced by the picked value. */
	function slashProvider(): AutocompleteProvider {
		return {
			getSuggestions: async (lines, cursorLine, cursorCol) => {
				const before = (lines[cursorLine] || "").slice(0, cursorCol);
				if (!before.startsWith("/")) return null;
				return {
					prefix: before,
					items: [
						{ value: "/alpha", label: "/alpha", description: "Alpha command" },
						{ value: "/beta", label: "/beta", description: "Beta command" },
						{ value: "/gamma", label: "/gamma", description: "Gamma command" },
					],
				};
			},
			applyCompletion: (lines, cursorLine, cursorCol, item, prefix) => {
				const line = lines[cursorLine] || "";
				const nextLines = [...lines];
				nextLines[cursorLine] = line.slice(0, cursorCol - prefix.length) + item.value + line.slice(cursorCol);
				return { lines: nextLines, cursorLine, cursorCol: cursorCol - prefix.length + item.value.length };
			},
		};
	}

	it("clicking a slash suggestion row confirms it through the Enter path (apply + submit)", async () => {
		const editor = new Editor(createTestTUI(), defaultEditorTheme);
		const submitted: string[] = [];
		editor.onSubmit = (text) => submitted.push(text);
		editor.setAutocompleteProvider(slashProvider());

		editor.handleInput("/");
		await flushAutocomplete();
		assert.equal(editor.isShowingAutocomplete(), true);

		const lines = editor.render(80);
		const menuStart = lines.findIndex((line) => line.includes("/alpha"));
		assert.notEqual(menuStart, -1, `menu rows must be rendered: ${JSON.stringify(lines)}`);

		// Click the second menu row (/beta).
		assert.equal(editor.handlePointer(pointerEvent("click", menuStart + 1)), true);
		assert.deepEqual(submitted, ["/beta"], "slash pick submits like Enter");
		assert.equal(editor.isShowingAutocomplete(), false);
	});

	it("wheel over the menu moves the selection (clamped), wheel elsewhere falls through", async () => {
		const editor = new Editor(createTestTUI(), defaultEditorTheme);
		editor.setAutocompleteProvider(slashProvider());

		editor.handleInput("/");
		await flushAutocomplete();
		assert.equal(editor.isShowingAutocomplete(), true);

		const lines = editor.render(80);
		const menuStart = lines.findIndex((line) => line.includes("/alpha"));
		assert.notEqual(menuStart, -1);
		assert.ok(lines[menuStart]!.includes("→"), "first row selected initially");

		assert.equal(editor.handlePointer(pointerEvent("wheel", menuStart, { deltaY: 1 })), true);
		const after = editor.render(80);
		assert.ok(after[menuStart + 1]!.includes("→"), "wheel down moved the selection to /beta");
		assert.ok(!after[menuStart]!.includes("→"));

		// Wheel above the menu (editor text area) is not consumed.
		assert.equal(editor.handlePointer(pointerEvent("wheel", 1, { deltaY: 1 })), undefined);
		// Neither are clicks outside the menu region.
		assert.equal(editor.handlePointer(pointerEvent("click", 0)), undefined);
	});

	it("with no autocomplete open the editor consumes nothing", () => {
		const editor = new Editor(createTestTUI(), defaultEditorTheme);
		editor.setText("plain text");
		editor.render(80);
		assert.equal(editor.handlePointer(pointerEvent("click", 1)), undefined);
		assert.equal(editor.handlePointer(pointerEvent("wheel", 1, { deltaY: 1 })), undefined);
		assert.equal(editor.handlePointer(pointerEvent("press", 1)), undefined);
	});
});


/** Click at (localX, localY) on the editor; returns the handler result. */
function clickAt(editor: Editor, localX: number, localY: number, overrides: Partial<PointerEvent> = {}): boolean | void {
	return editor.handlePointer(pointerEvent("click", localY, { localX, ...overrides }));
}

describe("Editor click-to-caret", () => {
	function createTestTUI(cols = 80, rows = 24): TUI {
		return new TuiMainScreen(new VirtualTerminal(cols, rows));
	}

	it("positions the caret at the nearest grapheme boundary (ASCII), without consuming", () => {
		const editor = new Editor(createTestTUI(), defaultEditorTheme);
		editor.setText("hello world"); // caret starts at the end: col 11
		editor.render(80);

		assert.equal(clickAt(editor, 2, 1), undefined);
		assert.deepEqual(editor.getCursor(), { line: 0, col: 2 });

		// First cell of a grapheme snaps before it (midpoint rule).
		assert.equal(clickAt(editor, 4, 1), undefined);
		assert.deepEqual(editor.getCursor(), { line: 0, col: 4 }, "cell of the 2nd 'o' snaps to its left edge");
	});

	it("never splits CJK wide characters: second cell of a wide char lands after it", () => {
		const editor = new Editor(createTestTUI(), defaultEditorTheme);
		editor.setText("你好吗"); // cells: 你 [0,2), 好 [2,4), 吗 [4,6)
		editor.render(80);

		clickAt(editor, 0, 1);
		assert.deepEqual(editor.getCursor(), { line: 0, col: 0 });
		clickAt(editor, 1, 1);
		assert.deepEqual(editor.getCursor(), { line: 0, col: 1 }, "right half of 你 snaps after it");
		clickAt(editor, 2, 1);
		assert.deepEqual(editor.getCursor(), { line: 0, col: 1 }, "left half of 好 snaps before it");
		clickAt(editor, 3, 1);
		assert.deepEqual(editor.getCursor(), { line: 0, col: 2 });
	});

	it("never lands inside an emoji ZWJ cluster", () => {
		const editor = new Editor(createTestTUI(), defaultEditorTheme);
		const cluster = "👨‍👩‍👧‍👦"; // 11 UTF-16 units, one grapheme, width 2
		editor.setText(`a${cluster}b`); // a: col 0 / cell 0; cluster: cols [1,12) / cells [1,3); b: col 12 / cell 3
		editor.render(80);

		clickAt(editor, 1, 1);
		assert.deepEqual(editor.getCursor(), { line: 0, col: 1 }, "left cell of the cluster snaps before it");
		clickAt(editor, 2, 1);
		assert.deepEqual(editor.getCursor(), { line: 0, col: 12 }, "right cell snaps after the whole cluster");
		clickAt(editor, 3, 1);
		assert.deepEqual(editor.getCursor(), { line: 0, col: 12 }, "left half of 'b' is the same boundary");
	});

	it("never lands inside a combining sequence", () => {
		const editor = new Editor(createTestTUI(), defaultEditorTheme);
		editor.setText("xéy"); // é = e + U+0301: cols [1,3), cell 1
		editor.render(80);

		clickAt(editor, 1, 1);
		assert.deepEqual(editor.getCursor(), { line: 0, col: 1 }, "before the é cluster");
		clickAt(editor, 2, 1);
		assert.deepEqual(editor.getCursor(), { line: 0, col: 3 }, "left half of 'y' snaps to col 3, never col 2 inside the cluster");
	});

	it("maps soft-wrapped rows back to logical line offsets", () => {
		const editor = new Editor(createTestTUI(), defaultEditorTheme);
		editor.setText("aaaa bbbb cc"); // wraps at layout width 11 into "aaaa bbbb " + "cc"
		const lines = editor.render(12);
		assert.ok(lines[1]!.startsWith("aaaa bbbb"), `first wrapped row: ${JSON.stringify(lines[1])}`);
		assert.ok(lines[2]!.startsWith("cc"), `second wrapped row: ${JSON.stringify(lines[2])}`);

		clickAt(editor, 1, 2); // second wrapped row, cell 1 = second 'c'
		assert.deepEqual(editor.getCursor(), { line: 0, col: 11 }, "wrapped row maps back into logical line 0");

		clickAt(editor, 9, 1); // last text cell of the first wrapped row (the space)
		assert.deepEqual(editor.getCursor(), { line: 0, col: 9 });
	});

	it("clicks past a row's text snap to that row's end (wrapped or not)", () => {
		const editor = new Editor(createTestTUI(), defaultEditorTheme);
		editor.setText("aaaa bbbb cc");
		editor.render(12); // rows: "aaaa bbbb " (width 10) then "cc"

		clickAt(editor, 15, 1); // blank padding past the first wrapped row's text
		assert.deepEqual(editor.getCursor(), { line: 0, col: 10 }, "end of the non-last wrapped row");

		clickAt(editor, 15, 2); // past the final row's text
		assert.deepEqual(editor.getCursor(), { line: 0, col: 12 }, "end of the logical line");
	});

	it("maps rows across logical lines and respects the scroll offset", () => {
		const editor = new Editor(createTestTUI(80, 20), defaultEditorTheme); // maxVisibleLines = 6
		editor.setText("ab\ncd");
		editor.render(80);
		clickAt(editor, 1, 2); // second logical line, cell 1 = 'd'
		assert.deepEqual(editor.getCursor(), { line: 1, col: 1 });

		// Scrolled: 10 lines keep the caret (end) visible → scrollOffset 4, rows show l4..l9.
		editor.setText(Array.from({ length: 10 }, (_, i) => `l${i}`).join("\n"));
		editor.render(80);
		clickAt(editor, 1, 1); // first visible text row = l4, cell 1 = '4'
		assert.deepEqual(editor.getCursor(), { line: 4, col: 1 });
	});

	it("left padding acts as column 0; border rows never move the caret", () => {
		const editor = new Editor(createTestTUI(), defaultEditorTheme, { paddingX: 2 });
		editor.setText("abc");
		editor.render(80); // rows: border / "  abc…" / border

		clickAt(editor, 0, 1);
		assert.deepEqual(editor.getCursor(), { line: 0, col: 0 }, "left padding = row start");
		clickAt(editor, 4, 1); // paddingX 2 + cell 2 = 'c' left half
		assert.deepEqual(editor.getCursor(), { line: 0, col: 2 });

		clickAt(editor, 4, 0); // top border
		assert.deepEqual(editor.getCursor(), { line: 0, col: 2 });
		clickAt(editor, 4, 2); // bottom border
		assert.deepEqual(editor.getCursor(), { line: 0, col: 2 });
		clickAt(editor, 4, 5); // below the rendered content
		assert.deepEqual(editor.getCursor(), { line: 0, col: 2 });
	});

	it("ignores non-primary-button clicks and non-click events", () => {
		const editor = new Editor(createTestTUI(), defaultEditorTheme);
		editor.setText("hello");
		editor.render(80);

		assert.equal(clickAt(editor, 2, 1, { button: 2 }), undefined);
		assert.deepEqual(editor.getCursor(), { line: 0, col: 5 }, "right click must not move the caret");
		for (const type of ["press", "release", "move", "wheel"] as const) {
			assert.equal(
				editor.handlePointer(pointerEvent(type, 1, { localX: 2, deltaY: type === "wheel" ? 1 : 0 })),
				undefined,
			);
		}
		assert.deepEqual(editor.getCursor(), { line: 0, col: 5 }, "press/release/move/wheel never move the caret");
	});
});

describe("Editor click-to-caret with autocomplete open", () => {
	function createTestTUI(cols = 80, rows = 24): TUI {
		return new TuiMainScreen(new VirtualTerminal(cols, rows));
	}

	async function flushAutocomplete(): Promise<void> {
		await Promise.resolve();
		await new Promise((resolve) => setImmediate(resolve));
	}

	/** Same slash provider shape as the menu-routing tests above. */
	function slashProvider(): AutocompleteProvider {
		return {
			getSuggestions: async (lines, cursorLine, cursorCol) => {
				const before = (lines[cursorLine] || "").slice(0, cursorCol);
				if (!before.startsWith("/")) return null;
				return {
					prefix: before,
					items: [
						{ value: "/alpha", label: "/alpha", description: "Alpha command" },
						{ value: "/beta", label: "/beta", description: "Beta command" },
					],
				};
			},
			applyCompletion: (lines, cursorLine, cursorCol, item, prefix) => {
				const line = lines[cursorLine] || "";
				const nextLines = [...lines];
				nextLines[cursorLine] = line.slice(0, cursorCol - prefix.length) + item.value + line.slice(cursorCol);
				return { lines: nextLines, cursorLine, cursorCol: cursorCol - prefix.length + item.value.length };
			},
		};
	}

	it("a text-area click behaves like an arrow-key move: caret moves, menu refreshes and stays", async () => {
		const editor = new Editor(createTestTUI(), defaultEditorTheme);
		editor.setAutocompleteProvider(slashProvider());
		editor.handleInput("/a");
		await flushAutocomplete();
		assert.equal(editor.isShowingAutocomplete(), true);
		editor.render(80);

		// Click cell 1 = the 'a' (still inside the slash token): caret moves to
		// col 1 and the picker re-queries against the new position ("/").
		assert.equal(clickAt(editor, 1, 1), undefined);
		assert.deepEqual(editor.getCursor(), { line: 0, col: 1 });
		await flushAutocomplete();
		assert.equal(editor.isShowingAutocomplete(), true, "slash context survives the move");
	});

	it("clicking out of the completion context closes the menu (arrow-key/Esc parity)", async () => {
		const editor = new Editor(createTestTUI(), defaultEditorTheme);
		editor.setAutocompleteProvider(slashProvider());
		editor.handleInput("/a");
		await flushAutocomplete();
		assert.equal(editor.isShowingAutocomplete(), true);
		editor.render(80);

		// Click cell 0 = before the "/": the provider yields nothing there, so
		// the picker closes itself exactly like arrowing to the line start.
		assert.equal(clickAt(editor, 0, 1), undefined);
		assert.deepEqual(editor.getCursor(), { line: 0, col: 0 });
		await flushAutocomplete();
		assert.equal(editor.isShowingAutocomplete(), false);
	});

	it("menu rows still route to the menu while text rows position the caret", async () => {
		const editor = new Editor(createTestTUI(), defaultEditorTheme);
		const submitted: string[] = [];
		editor.onSubmit = (text) => submitted.push(text);
		editor.setAutocompleteProvider(slashProvider());
		editor.handleInput("/");
		await flushAutocomplete();

		const lines = editor.render(80);
		const menuStart = lines.findIndex((line) => line.includes("/alpha"));
		assert.notEqual(menuStart, -1);

		// Text row: caret to col 0, menu then closes (no slash context).
		assert.equal(clickAt(editor, 0, 1), undefined);
		await flushAutocomplete();
		assert.equal(editor.isShowingAutocomplete(), false);
		assert.deepEqual(submitted, [], "text clicks never confirm a suggestion");
	});
});

describe("Editor click-to-caret dispatch (e2e)", () => {
	/** SGR mouse sequence for a 0-based cell. */
	function sgr(button: number, x: number, y: number, release = false): string {
		return `\x1b[<${button};${x + 1};${y + 1}${release ? "m" : "M"}`;
	}

	it("a real click positions the caret; a drag selects without moving it", async () => {
		const terminal = new VirtualTerminal(20, 6);
		const copied: string[] = [];
		const tui = new TuiAltScreen(terminal, undefined, undefined, {
			copySelection: async (text) => {
				copied.push(text);
				return true;
			},
		});
		const editor = new Editor(tui, defaultEditorTheme);
		editor.setText("hello world"); // caret at the end: col 11
		tui.setLayoutRoot(new VStack([editor]));
		tui.start();
		await terminal.waitForRender();

		// Same-cell press/release = click at cell (4, 1): caret to col 4.
		terminal.sendInput(sgr(0, 4, 1));
		terminal.sendInput(sgr(0, 4, 1, true));
		await terminal.waitForRender();
		assert.deepEqual(editor.getCursor(), { line: 0, col: 4 });

		// Cross-cell drag over the text row: no click is dispatched, the
		// terminal-level selection runs instead, and the caret stays put.
		terminal.sendInput(sgr(0, 0, 1));
		terminal.sendInput(sgr(32, 8, 1)); // drag motion
		terminal.sendInput(sgr(0, 8, 1, true));
		await terminal.waitForRender();
		assert.deepEqual(editor.getCursor(), { line: 0, col: 4 }, "selection release must not move the caret");
		assert.equal(copied.length, 1, "drag selection still completes");
		assert.ok(copied[0]!.startsWith("hello"), `selection copies the dragged text, got ${JSON.stringify(copied)}`);

		// A click on the top border row is not text: caret unchanged.
		terminal.sendInput(sgr(0, 2, 0));
		terminal.sendInput(sgr(0, 2, 0, true));
		await terminal.waitForRender();
		assert.deepEqual(editor.getCursor(), { line: 0, col: 4 });
		tui.stop();
	});
});
