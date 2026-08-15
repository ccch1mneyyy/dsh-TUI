/** cmd.exe joins spawn arguments with spaces; quote anything that could split. */
export declare function shellQuote(args: readonly string[]): string[];
/** Escape a command path for a cmd.exe line: caret-escape metacharacters. */
export declare function cmdEscapeCommand(command: string): string;
/**
 * Escape one argument for a cmd.exe line. Backslashes before a quote (or at
 * the end, where our own closing quote will land) are doubled and the quote
 * backslash-escaped so the target's argv parse keeps them literal; the whole
 * argument is then quoted and every cmd metacharacter caret-escaped — twice
 * when the command is a node_modules/.bin shim (those re-invoke node and
 * parse the line a second time).
 */
export declare function cmdEscapeArgument(arg: string, doubleEscapeMetaChars?: boolean): string;
//# sourceMappingURL=shellQuote.d.ts.map