/**
 * Declaratively set the terminal tab/window title.
 *
 * Pass a string to set the title. ANSI escape sequences are stripped
 * automatically so callers don't need to know about terminal encoding.
 * Pass `null` to opt out — the hook becomes a no-op and leaves the
 * terminal title untouched.
 *
 * On Windows, uses `process.title` (classic conhost doesn't support OSC).
 * Elsewhere, writes OSC 0 (set title+icon) via Ink's stdout.
 * @param title - the title to set, or null to opt out.
 */
export declare function useTerminalTitle(title: string | null): void;
//# sourceMappingURL=use-terminal-title.d.ts.map