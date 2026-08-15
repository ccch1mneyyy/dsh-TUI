/**
 * Cross-platform clipboard access for Ctrl+V paste. The TUI runs in raw
 * mode, so the terminal never performs its own paste for Ctrl+V — the key
 * arrives at the app and the clipboard is read here, per platform:
 *
 * - **Windows**: PowerShell `Get-Clipboard` (zero-dependency). File drops
 *   (Explorer copy) come back as a FileDropList, a raw image (screenshot)
 *   is saved as PNG via System.Drawing, anything else as text.
 * - **macOS**: `osascript` for files («class furl») and images («class
 *   PNGf»/«class TIFF», written to a temp file), `pbpaste` for text.
 * - **Linux/other**: the paste tools `wl-paste` (Wayland), `xclip` (X11)
 *   and `xsel` (X11, text only) are tried in session order until one
 *   connects — an installed tool whose session is unreachable (stale
 *   WAYLAND_DISPLAY/DISPLAY) falls through to the next candidate.
 *   `text/uri-list` offers become file paths, `image/*` offers are
 *   exported to a temp file whose path is inserted.
 *
 * Priority is always files → image → text (a screenshot copy offers only an
 * image; a file-manager copy offers a file list; everything else falls
 * through to text). Exported images go into a per-process private
 * directory (mkdtemp, mode 0700) under the OS temp dir and are created
 * with mode 0600 — clipboard screenshots routinely contain sensitive
 * content and must not be world-readable in a shared /tmp. The directory
 * lives until the OS cleans temp; files are referenced by the prompt as
 * paths, so they must outlive the read itself. When the directory cannot
 * be created (bad TMPDIR, permissions), an image offer degrades to the
 * text branch instead of failing the read — and the failure is not
 * cached, so the next paste retries.
 *
 * Text is base64-encoded on the PowerShell side so the line-oriented
 * stdout parse survives multi-line clipboard content (a raw write would
 * put every line on its own output line and drop all but the first); CJK
 * survives because base64 is pure ASCII. The Linux/macOS tools write raw
 * UTF-8 to stdout, which Node decodes directly.
 */
/**
 * Clipboard content as read by {@link readClipboard}: file paths when a
 * file manager copied files, an exported temp-file path when the clipboard
 * holds a raw image (screenshot), or plain text otherwise.
 */
export type ClipboardContent = {
    kind: 'files';
    paths: string[];
} | {
    kind: 'image';
    path: string;
} | {
    kind: 'text';
    text: string;
};
/**
 * Outcome of {@link readClipboard}: the clipboard {@link ClipboardContent},
 * `null` when the clipboard holds nothing usable (empty or read failure),
 * or `{ kind: 'unavailable' }` when no clipboard backend can be reached at
 * all (Linux/Unix without wl-paste/xclip/xsel, or none of the installed
 * ones connecting to a live session).
 */
export type ClipboardRead = ClipboardContent | {
    kind: 'unavailable';
} | null;
/**
 * Parse `text/uri-list` clipboard content into local file paths. Lines are
 * parsed as real URLs: comment lines (`#…`), non-`file:` URIs and remote
 * authorities (`file://server/share` — a network share must not silently
 * become a local `/share` path) are skipped; only an empty authority or
 * `localhost` is accepted. Percent-escapes decode via fileURLToPath, the
 * single-slash form `file:/path` works, and query/fragment parts never
 * leak into the file name. Entries whose escapes are malformed keep their
 * undecoded path rather than being dropped. The first line of GNOME/KDE's
 * `x-special/gnome-copied-files` (`copy`/`cut`) is not a URL and is
 * skipped by the same filter, so that format can be fed through unchanged.
 * @param uriList - Raw `text/uri-list` payload (CRLF or LF separated).
 * @returns The decoded local paths, in offer order.
 */
export declare function parseUriList(uriList: string): string[];
/**
 * Pick the image MIME type to capture from the offered clipboard target
 * list: `image/png` when offered (screenshots are lossless PNG), otherwise
 * the first `image/*` offer.
 * @param targets - MIME types advertised by the clipboard owner.
 * @returns The chosen MIME type, or null when no image is offered.
 */
export declare function pickImageMime(targets: readonly string[]): string | null;
/**
 * Pick the text MIME type to read from the offered clipboard target list:
 * the first match of {@link TEXT_MIME_PRIORITY}, otherwise any other
 * `text/*` offer except `text/uri-list` (already consumed by the files
 * branch — falling back to it would insert raw URIs as text).
 * @param targets - MIME types advertised by the clipboard owner.
 * @returns The chosen MIME type, or null when no text is offered.
 */
export declare function pickTextMime(targets: readonly string[]): string | null;
/**
 * Read the system clipboard for Ctrl+V paste, dispatching on platform:
 * PowerShell on Windows, osascript/pbpaste on macOS, wl-paste/xclip/xsel
 * on Linux and other Unixes.
 * @returns The clipboard content, null when empty/unreadable, or
 *   'unavailable' when no clipboard backend can be reached.
 */
export declare function readClipboard(): Promise<ClipboardRead>;
/**
 * Reset the cached Linux paste tool, forcing the next read to re-probe.
 * @internal test-only
 */
export declare function _resetLinuxPasteCache(): void;
/**
 * Render pasted clipboard content for insertion into the prompt: file paths
 * and exported image paths quoted when they contain whitespace, text with
 * line endings normalized.
 * @param content - Clipboard content as read by {@link readClipboard}.
 * @returns The prompt-ready text: quoted, space-joined paths, or the text
 *   with line endings normalized.
 */
export declare function formatClipboardInsert(content: ClipboardContent): string;
//# sourceMappingURL=clipboard.d.ts.map