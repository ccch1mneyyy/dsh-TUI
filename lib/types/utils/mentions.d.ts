/**
 * `@` file-mention parsing (issue #15).
 *
 * A mention is an `@` that starts a whitespace-delimited token (string start
 * or after whitespace) — `hello@world` never triggers. The token body is
 * either a run of non-whitespace characters (`@src/a.ts`) or a double-quoted
 * path (`@"my dir/a.ts"`, for paths containing spaces).
 */
export interface MentionToken {
    /** Start index of the `@` in the source text. */
    start: number;
    /** End index (exclusive) of the whole token, quote included. */
    end: number;
    /** The referenced path as typed (unquoted, no leading `@`). */
    path: string;
}
/** Extract every `@` mention in `text` (typed order, duplicates kept out). */
export declare function extractMentions(text: string): MentionToken[];
/**
 * The mention token the caret is currently editing, if any: an `@` token
 * that starts at or before the caret with the caret inside it. Used by the
 * prompt's completion trigger so `@` works mid-message, not only at the
 * start of the input.
 */
export declare function mentionAtCaret(value: string, cursor: number): {
    start: number;
    end: number;
    query: string;
} | undefined;
//# sourceMappingURL=mentions.d.ts.map