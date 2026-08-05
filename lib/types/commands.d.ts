/**
 * Local slash commands for the dsh-cc TUI. Claude Code's command system is
 * deeply wired into its engine; cc-tui ships a small built-in set with the
 * same `/name — description` suggestion chrome, and merges plugin-registered
 * commands (plan/goal/…) from the DSH command registry (`dsh-commands`) —
 * `runCommand` in the Chat screen dispatches either kind, with the registry
 * handler winning for names both sides declare.
 */
export interface LocalCommand {
    /** The command name without the slash, e.g. `clear`. */
    name: string;
    /** One-line description shown in the suggestion overlay. */
    description: string;
    /** Optional bracket tag shown between name and description. */
    tag?: string;
    /** True when a DSH plugin registered this command (not built in). */
    external?: boolean;
}
export declare const LOCAL_COMMANDS: LocalCommand[];
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
/** Commands that must not be sent to the model when typed alone. */
export declare function isLocalCommandName(input: string, list?: readonly LocalCommand[]): boolean;
/**
 * Filter commands by a `/…` input prefix (matches the CC overlay behavior).
 * The prefix is the whole input after the slash, so `/plan off` matches
 * nothing and the overlay stays closed — Enter still dispatches through
 * `parseCommandName`.
 */
export declare function filterCommands(input: string, list?: readonly LocalCommand[]): LocalCommand[];
//# sourceMappingURL=commands.d.ts.map