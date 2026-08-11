/**
 * Windows clipboard access for Ctrl+V paste. The TUI runs in raw mode, so
 * the console never performs its own paste for Ctrl+V — the key arrives at
 * the app and the clipboard is read here. PowerShell `Get-Clipboard` is the
 * zero-dependency route: file drops (Explorer copy) come back as a
 * FileDropList (the user pastes a file → insert its path), anything else
 * comes back as text. Text is base64-encoded on the PowerShell side so the
 * line-oriented stdout parse survives multi-line clipboard content (a raw
 * write would put every line on its own output line and drop all but the
 * first); CJK survives because base64 is pure ASCII.
 */
/**
 * Read the Windows clipboard: file paths when Explorer copied files,
 * otherwise the plain text. Returns null when the clipboard holds neither.
 * Clipboard access is retried — another process (e.g. Explorer) briefly
 * holding the clipboard open makes OpenClipboard fail with a transient
 * error.
 *
 * @returns `{ kind: 'files'; paths: string[] }` for file drops,
 *   `{ kind: 'text'; text: string }` for text, or null when empty/blocked.
 */
export declare function readClipboard(): Promise<{
    kind: 'files';
    paths: string[];
} | {
    kind: 'text';
    text: string;
} | null>;
/**
 * Render pasted clipboard content for insertion into the prompt: file paths
 * quoted when they contain whitespace, joined with single spaces.
 * @param content - Clipboard content as read by {@link readClipboard}.
 * @returns The prompt-ready text: quoted, space-joined paths, or the text
 *   with line endings normalized.
 */
export declare function formatClipboardInsert(content: {
    kind: 'files';
    paths: string[];
} | {
    kind: 'text';
    text: string;
}): string;
//# sourceMappingURL=clipboard.d.ts.map