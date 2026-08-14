/**
 * `@` file-mention parsing (issue #15).
 *
 * A mention is an `@` that starts a whitespace-delimited token (string start
 * or after whitespace) — `hello@world` never triggers. The token body is
 * either a run of non-whitespace characters (`@src/a.ts`) or a double-quoted
 * path (`@"my dir/a.ts"`, for paths containing spaces).
 */
/** True when `ch` delimits a token (whitespace). */
const isBoundary = (ch) => ch === undefined || /\s/.test(ch);
/** Extract every `@` mention in `text` (typed order, duplicates kept out). */
export function extractMentions(text) {
    const tokens = [];
    const seen = new Set();
    let index = 0;
    while (index < text.length) {
        const at = text.indexOf('@', index);
        if (at === -1)
            break;
        index = at + 1;
        if (!isBoundary(text[at - 1]))
            continue; // email-style `a@b`, mid-token
        if (text[at + 1] === '"') {
            const close = text.indexOf('"', at + 2);
            if (close === -1)
                continue; // unterminated quote — not a mention
            const path = text.slice(at + 2, close);
            if (path && !seen.has(path)) {
                seen.add(path);
                tokens.push({ start: at, end: close + 1, path });
            }
            index = close + 1;
            continue;
        }
        let end = at + 1;
        while (end < text.length && !isBoundary(text[end]))
            end++;
        const path = text.slice(at + 1, end);
        // A bare `@` or another trigger char (`@@`) carries no path.
        if (path && !path.startsWith('@') && !seen.has(path)) {
            seen.add(path);
            tokens.push({ start: at, end, path });
        }
    }
    return tokens;
}
/**
 * The mention token the caret is currently editing, if any: an `@` token
 * that starts at or before the caret with the caret inside it. Used by the
 * prompt's completion trigger so `@` works mid-message, not only at the
 * start of the input.
 */
export function mentionAtCaret(value, cursor) {
    // Token start: scan back from the caret to the previous boundary.
    let start = cursor;
    while (start > 0 && !isBoundary(value[start - 1]))
        start--;
    if (value[start] !== '@')
        return undefined;
    // Quoted form: the caret must sit before the closing quote.
    if (value[start + 1] === '"') {
        const close = value.indexOf('"', start + 2);
        if (close !== -1 && cursor > close)
            return undefined;
        return { start, end: close === -1 ? value.length : close + 1, query: value.slice(start + 2, cursor) };
    }
    // Token end: first boundary at/after the caret.
    let end = cursor;
    while (end < value.length && !isBoundary(value[end]))
        end++;
    return { start, end, query: value.slice(start + 1, cursor) };
}
