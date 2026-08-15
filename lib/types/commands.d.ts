/**
 * Local slash commands for the dsh-tui TUI. Claude Code's command system is
 * deeply wired into its engine; dsh-tui ships a small built-in set with the
 * same `/name — description` suggestion chrome, and merges plugin-registered
 * commands (plan/goal/…) from the DSH command registry (`dsh-commands`) —
 * `runCommand` in the Chat screen dispatches either kind, with the registry
 * handler winning for names both sides declare.
 */
export interface LocalCommand {
    /** The command name without the slash, e.g. `clear`. */
    name: string;
    /**
     * One-line description shown in the suggestion overlay — the English text
     * and the fallback for languages without a `cmd-desc-<name>` dict entry
     * (see {@link localizedDescription}).
     */
    description: string;
    /** Optional bracket tag shown between name and description. */
    tag?: string;
    /** True when a DSH plugin registered this command (not built in). */
    external?: boolean;
    /**
     * True when the entry is a user-invocable skill discovered by the DSH
     * skill registry (issue #86). Skill entries are completion-only: dispatch
     * falls through to the model as plain text, where dsh-tool-skill's
     * pre-step hook injects the skill body — the same path a hand-typed
     * `/skill-name` takes. The help menu hides them (chrome commands only).
     */
    skill?: boolean;
}
/**
 * The built-in slash commands (name + description pairs). Plugin-registered
 * commands merge in at runtime; locals win on name collisions.
 */
export declare const LOCAL_COMMANDS: LocalCommand[];
/**
 * Resolve a command's description in the active UI language. The en text in
 * `LOCAL_COMMANDS` (and the registry's own text for external commands) is
 * the fallback; zh translations live in the i18n dict under
 * `cmd-desc-<name>`. Resolved at call time — components call this during
 * render, so a `/lang` switch repaints descriptions immediately.
 * @param command - The command whose description to localize.
 */
export declare function localizedDescription(command: LocalCommand): string;
/**
 * Parse a slash-command line into its name and the verbatim input following
 * the name (separator whitespace included) — the same split the DSH command
 * registry uses, so `/plan off` dispatches `plan` with ` off`.
 *
 * @param line - Complete candidate command line.
 * @returns The parsed name and raw input, or `undefined` when the line is
 *   not a command.
 */
export declare function parseCommandName(line: string): {
    name: string;
    rawInput: string;
} | undefined;
/**
 * Whether the input names a local command. Local commands must never be sent
 * to the model when typed alone; trailing whitespace is legal.
 * @param input - Candidate command line (slash optional).
 * @param list - Command list to match against; defaults to LOCAL_COMMANDS.
 * @returns True when the trimmed input names a command in `list`.
 */
export declare function isLocalCommandName(input: string, list?: readonly LocalCommand[]): boolean;
/**
 * Filter commands by a `/…` input prefix (matches the CC overlay behavior).
 * The prefix is the whole input after the slash, so `/plan off` matches
 * nothing and the overlay stays closed — Enter still dispatches through
 * `parseCommandName`.
 * @param input - Slash-command input; the prefix is the whole text after the slash.
 * @param list - Command list to filter; defaults to LOCAL_COMMANDS.
 * @returns Commands whose name starts with the prefix, in list order.
 */
export declare function filterCommands(input: string, list?: readonly LocalCommand[]): LocalCommand[];
//# sourceMappingURL=commands.d.ts.map