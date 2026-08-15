/**
 * Cross-platform modifier-key helpers. Windows/Linux muscle memory uses
 * Ctrl+<key>; on macOS the same action maps to Cmd+<key>. Terminals deliver
 * Cmd as the `super` flag (kitty CSI-u / xterm modifyOtherKeys — see
 * src/ink/parse-keypress.ts); Ctrl keeps working everywhere, so `isMod`
 * accepts either on the mac and stays Ctrl-only elsewhere.
 */
export declare const isMac: boolean;
/** True when the key event carries the platform's "primary" modifier. */
export declare function isMod(key: {
    ctrl?: boolean;
    super?: boolean;
}): boolean;
/**
 * Display prefix for shortcut labels: "⌘" on macOS (Apple style, no "+"),
 * "ctrl+" everywhere else. Pair with the bare key, e.g. `${modLabel}o`.
 */
export declare const modLabel: string;
//# sourceMappingURL=modifiers.d.ts.map