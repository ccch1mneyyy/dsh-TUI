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
import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileNoThrow } from './execFileNoThrow.js';
/** Timeout for every clipboard helper invocation (ms). */
const CLIPBOARD_TIMEOUT = 3000;
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
export function parseUriList(uriList) {
    const paths = [];
    for (const raw of uriList.split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || line.startsWith('#'))
            continue;
        let url;
        try {
            url = new URL(line);
        }
        catch {
            continue;
        }
        if (url.protocol !== 'file:')
            continue;
        const host = url.hostname.toLowerCase();
        if (host !== '' && host !== 'localhost')
            continue;
        try {
            paths.push(fileURLToPath(url));
        }
        catch {
            // Malformed percent-escape (or an encoded slash) — keep the raw path.
            paths.push(url.pathname);
        }
    }
    return paths;
}
/**
 * Pick the image MIME type to capture from the offered clipboard target
 * list: `image/png` when offered (screenshots are lossless PNG), otherwise
 * the first `image/*` offer.
 * @param targets - MIME types advertised by the clipboard owner.
 * @returns The chosen MIME type, or null when no image is offered.
 */
export function pickImageMime(targets) {
    const images = targets.map(t => t.trim()).filter(t => /^image\//i.test(t));
    if (images.length === 0)
        return null;
    return images.find(t => t.toLowerCase() === 'image/png') ?? images[0];
}
/** Text MIME types in preference order (UTF-8 variants first). */
const TEXT_MIME_PRIORITY = [
    'text/plain;charset=utf-8',
    'utf8_string',
    'text/plain',
    'text',
    'string',
];
/**
 * Pick the text MIME type to read from the offered clipboard target list:
 * the first match of {@link TEXT_MIME_PRIORITY}, otherwise any other
 * `text/*` offer except `text/uri-list` (already consumed by the files
 * branch — falling back to it would insert raw URIs as text).
 * @param targets - MIME types advertised by the clipboard owner.
 * @returns The chosen MIME type, or null when no text is offered.
 */
export function pickTextMime(targets) {
    const lowered = targets.map(t => t.trim().toLowerCase()).filter(Boolean);
    for (const want of TEXT_MIME_PRIORITY) {
        if (lowered.includes(want)) {
            return targets[lowered.indexOf(want)].trim();
        }
    }
    const anyText = targets.find(t => {
        const mime = t.trim().toLowerCase();
        return /^text\//.test(mime) && mime !== 'text/uri-list';
    });
    return anyText ? anyText.trim() : null;
}
/** File extension per image MIME type for the exported temp file. */
const IMAGE_EXTENSIONS = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'image/bmp': '.bmp',
    'image/tiff': '.tiff',
    'image/svg+xml': '.svg',
};
// Per-process private directory for exported clipboard images, created
// lazily on the first image paste. mkdtemp guarantees a fresh,
// unpredictably-named directory; mode 0700 keeps other local users out of
// whatever a screenshot contains. Only SUCCESS is cached — a failed
// creation (bad TMPDIR, permissions) must not disable image pastes for
// the rest of the process, and never rejects: callers degrade to their
// text branch instead.
let imageDir;
/**
 * Lazily create (once per process) and return the private directory that
 * holds exported clipboard images.
 * @returns Absolute path of a mode-0700 directory inside the OS temp dir,
 *   or null when it cannot be created this time (not cached — the next
 *   paste retries).
 */
async function ensureImageDir() {
    if (imageDir !== undefined)
        return imageDir;
    let dir;
    try {
        dir = await mkdtemp(join(tmpdir(), 'dsh-tui-paste-'));
    }
    catch {
        return null;
    }
    try {
        // mkdtemp(3) already creates 0700; enforce it where the platform's
        // temp-dir inheritance could widen it. Windows ACLs ignore mode —
        // %TEMP% is per-user there, so the chmod is best-effort.
        await chmod(dir, 0o700);
    }
    catch {
        // Best-effort hardening only.
    }
    imageDir = dir;
    return dir;
}
/** Per-process counter keeping exported image names unique. */
let imageCounter = 0;
/**
 * Build a unique path for an exported clipboard image inside the private
 * image directory (created on first use).
 * @param mime - The image MIME type being exported.
 * @returns An absolute, not-yet-existing path for the export, or null
 *   when the private directory is unavailable (see {@link ensureImageDir}).
 */
async function imageTempPath(mime) {
    const dir = await ensureImageDir();
    if (dir === null)
        return null;
    const ext = IMAGE_EXTENSIONS[mime.toLowerCase()] ??
        `.${mime.split('/')[1]?.replace(/[^a-z0-9]/gi, '').toLowerCase() || 'img'}`;
    imageCounter += 1;
    return join(dir, `paste-${imageCounter}${ext}`);
}
/**
 * Run a command and capture stdout as a raw Buffer (binary-safe, unlike
 * {@link execFileNoThrow} which string-decodes). Never rejects: spawn
 * failure, non-zero exit and timeout all resolve with the partial buffer
 * and a non-zero/null code.
 * @param file - The executable to spawn.
 * @param args - Command-line arguments.
 * @returns Exit code and captured stdout bytes.
 */
function spawnForBuffer(file, args) {
    return new Promise(resolve => {
        const child = spawn(file, [...args], { timeout: CLIPBOARD_TIMEOUT });
        const chunks = [];
        child.stdout.on('data', (chunk) => chunks.push(chunk));
        child.on('error', () => resolve({ code: 1, stdout: Buffer.concat(chunks) }));
        child.on('close', code => resolve({ code, stdout: Buffer.concat(chunks) }));
        child.stdin.end();
    });
}
/**
 * Capture an offered clipboard image to the private image directory via a
 * Linux paste tool. The file is created exclusively (`wx`, mode 0600) —
 * never following a pre-existing path.
 * @param tool - The paste tool to read with.
 * @param mime - The image MIME type to request.
 * @returns The written temp path, or null when the capture failed.
 */
async function captureLinuxImage(tool, mime) {
    const args = tool === 'wl-paste'
        ? ['--type', mime]
        : ['-selection', 'clipboard', '-o', '-t', mime];
    const result = await spawnForBuffer(tool, args);
    if (result.code !== 0 || result.stdout.length === 0)
        return null;
    const path = await imageTempPath(mime);
    if (path === null)
        return null;
    try {
        await writeFile(path, result.stdout, { flag: 'wx', mode: 0o600 });
    }
    catch {
        return null;
    }
    return path;
}
// Linux paste tool cache: undefined = not yet established, null = nothing
// installed/connectable last probe. Only a tool that successfully listed
// the clipboard (or proved its session by reporting it empty) is cached;
// a tool that fails to connect is evicted so the next read re-probes.
let linuxPaste;
/**
 * Order the Linux paste candidates by session: Wayland prefers wl-paste,
 * X11 prefers xclip/xsel; the other side's tools stay as fallback since
 * mixed setups (XWayland-only apps, forwarded sessions) exist.
 * @returns Candidate tools, most likely usable first.
 */
function linuxCandidateOrder() {
    const wayland = Boolean(process.env.WAYLAND_DISPLAY);
    const x11 = Boolean(process.env.DISPLAY);
    if (wayland && !x11)
        return ['wl-paste', 'xclip', 'xsel'];
    if (x11 && !wayland)
        return ['xclip', 'xsel', 'wl-paste'];
    return ['wl-paste', 'xclip', 'xsel'];
}
/**
 * Check whether a paste tool is installed (its version query exits 0).
 * @param tool - The tool to probe.
 * @returns True when the binary exists and runs.
 */
async function isPasteToolInstalled(tool) {
    const versionArg = tool === 'xclip' ? '-version' : '--version';
    const r = await execFileNoThrow(tool, [versionArg], { timeout: 2000 });
    return r.code === 0;
}
/**
 * Recognize the KNOWN "selection is empty" failures of each paste tool.
 * Anything else that goes wrong — dead display session, missing
 * permissions, protocol errors, kill-by-timeout (exit code null), the
 * binary vanishing mid-session — is a backend failure and the next
 * candidate tool gets its turn; treating those as "empty" would both
 * misreport to the user and pin a broken tool in the cache.
 * @param tool - The tool that produced the stderr.
 * @param stderr - The captured stderr text.
 * @returns True only for the tools' stable empty-selection phrasings.
 */
function isKnownEmptySelection(tool, stderr) {
    // wl-paste with an empty clipboard: "Nothing is copied" (both the C
    // original and wl-clipboard-rs phrase it this way).
    if (tool === 'wl-paste')
        return /nothing is copied|clipboard is empty/i.test(stderr);
    // xclip with no selection owner: "Error: target TARGETS not available";
    // xsel: "xsel: No selection" on some builds.
    return /target \S+ not available|no selection/i.test(stderr);
}
/**
 * Read the clipboard with one specific Linux paste tool: `text/uri-list`
 * (or GNOME/KDE's `x-special/gnome-copied-files`) becomes file paths, an
 * `image/*` offer is exported to the private image directory, and text
 * offers come back as text.
 * @param tool - The tool to read with.
 * @returns The clipboard content, null when the selection is empty or
 *   holds nothing usable, or 'backend-error' when the tool itself failed
 *   (see {@link isKnownEmptySelection} for the split).
 */
async function readWithLinuxTool(tool) {
    const opts = { timeout: CLIPBOARD_TIMEOUT };
    // xsel has no target negotiation in common builds — text only.
    if (tool === 'xsel') {
        const text = await execFileNoThrow('xsel', ['--clipboard', '--output'], opts);
        if (text.code !== 0) {
            return isKnownEmptySelection(tool, text.stderr) ? null : 'backend-error';
        }
        return text.stdout.length > 0 ? { kind: 'text', text: text.stdout } : null;
    }
    const listArgs = tool === 'wl-paste'
        ? ['--list-types']
        : ['-selection', 'clipboard', '-o', '-t', 'TARGETS'];
    const offered = await execFileNoThrow(tool, listArgs, opts);
    // Non-zero exit (or null after a timeout kill) splits into the known
    // empty-selection phrasings (→ null) and every other failure (→ try the
    // next candidate tool).
    if (offered.code !== 0) {
        return isKnownEmptySelection(tool, offered.stderr) ? null : 'backend-error';
    }
    const targets = offered.stdout.split(/\r?\n/).filter(t => t.trim().length > 0);
    // Files first: a file-manager copy offers a URI list.
    const uriMime = targets.some(t => t.trim().toLowerCase() === 'text/uri-list')
        ? 'text/uri-list'
        : targets.some(t => t.trim().toLowerCase() === 'x-special/gnome-copied-files')
            ? 'x-special/gnome-copied-files'
            : null;
    if (uriMime !== null) {
        const args = tool === 'wl-paste'
            ? ['--type', uriMime]
            : ['-selection', 'clipboard', '-o', '-t', uriMime];
        const uriList = await execFileNoThrow(tool, args, opts);
        if (uriList.code === 0) {
            const paths = parseUriList(uriList.stdout);
            if (paths.length > 0)
                return { kind: 'files', paths };
        }
    }
    // Then a raw image (screenshot) — export to a temp file, insert its path.
    const imageMime = pickImageMime(targets);
    if (imageMime !== null) {
        const path = await captureLinuxImage(tool, imageMime);
        if (path !== null)
            return { kind: 'image', path };
    }
    // Finally plain text.
    const textMime = pickTextMime(targets);
    if (textMime !== null) {
        const args = tool === 'wl-paste'
            ? ['--no-newline', '--type', textMime]
            : ['-selection', 'clipboard', '-o', '-t', textMime];
        const text = await execFileNoThrow(tool, args, opts);
        if (text.code === 0 && text.stdout.length > 0) {
            return { kind: 'text', text: text.stdout };
        }
    }
    return null;
}
/**
 * Read the clipboard on Linux/Unix: try each candidate paste tool in
 * session order, skipping ones that are not installed and falling through
 * ones that fail for any reason other than a genuinely empty selection.
 * @returns The clipboard content, null when empty/unreadable, or
 *   'unavailable' when every installed tool failed.
 */
async function readClipboardLinux() {
    const order = linuxCandidateOrder();
    // The cached winner goes first; a backend error evicts it below and the
    // remaining candidates re-probe.
    const candidates = linuxPaste != null && order.includes(linuxPaste)
        ? [linuxPaste, ...order.filter(t => t !== linuxPaste)]
        : order;
    for (const tool of candidates) {
        if (tool !== linuxPaste && !(await isPasteToolInstalled(tool)))
            continue;
        const outcome = await readWithLinuxTool(tool);
        if (outcome === 'backend-error') {
            if (tool === linuxPaste)
                linuxPaste = undefined;
            continue;
        }
        linuxPaste = tool;
        return outcome;
    }
    // Nothing installed at all, or every installed tool failed — both read
    // as "no usable clipboard" to the caller.
    return { kind: 'unavailable' };
}
/**
 * Read the clipboard on macOS: files via the «class furl» coercion (a
 * Finder copy of a single file; multi-file copies have no portable
 * AppleScript coercion and fall through to image/text), images via
 * «class PNGf»/«class TIFF» written to the private image directory, and
 * text via pbpaste.
 * @returns The clipboard content, or null when empty/unreadable.
 */
async function readClipboardDarwin() {
    const opts = { timeout: CLIPBOARD_TIMEOUT };
    const furl = await execFileNoThrow('osascript', ['-e', 'POSIX path of (the clipboard as «class furl»)'], opts);
    if (furl.code === 0 && furl.stdout.trim().length > 0) {
        return { kind: 'files', paths: [furl.stdout.trim()] };
    }
    const info = await execFileNoThrow('osascript', ['-e', 'clipboard info'], opts);
    const imageClass = /«class (PNGf|TIFF)»/.exec(info.stdout)?.[1];
    if (info.code === 0 && imageClass !== undefined) {
        const path = await imageTempPath(imageClass === 'PNGf' ? 'image/png' : 'image/tiff');
        if (path !== null) {
            const escaped = path.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
            const written = await execFileNoThrow('osascript', [
                '-e',
                [
                    `set imageData to the clipboard as «class ${imageClass}»`,
                    `set fp to open for access (POSIX file "${escaped}") with write permission`,
                    'write imageData to fp',
                    'close access fp',
                ].join('\n'),
            ], opts);
            if (written.code === 0)
                return { kind: 'image', path };
        }
    }
    const text = await execFileNoThrow('pbpaste', [], opts);
    if (text.code === 0 && text.stdout.length > 0) {
        return { kind: 'text', text: text.stdout };
    }
    return null;
}
/**
 * Build the PowerShell read script for Windows, with the target image
 * export path baked in as a single-quoted literal (only `''` needs
 * escaping there — `-Command` treats trailing argv as more command text,
 * so `$args` passing is unreliable). A null path disables the image
 * branch: file and text reads must survive an unavailable temp directory.
 * @param imagePath - Where a clipboard image should be saved as PNG, or
 *   null to skip the image attempt.
 * @returns The complete -Command script.
 */
function buildPsScript(imagePath) {
    const imageLiteral = imagePath === null ? "''" : `'${imagePath.replace(/'/g, "''")}'`;
    return [
        "$ErrorActionPreference='SilentlyContinue'",
        '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8',
        `$imagePath=${imageLiteral}`,
        '$files=$null',
        'try { $files = Get-Clipboard -Format FileDropList -ErrorAction Stop } catch {}',
        'if($files){foreach($f in $files){Write-Output ("FILE:"+$f.FullName)}}',
        '$saved=$false',
        "if(-not $files -and $imagePath -ne ''){try { Add-Type -AssemblyName System.Drawing; $img=Get-Clipboard -Format Image -ErrorAction Stop; if($img){$img.Save($imagePath,[System.Drawing.Imaging.ImageFormat]::Png); $img.Dispose(); $saved=$true} } catch {}}",
        'if($saved){Write-Output ("IMAGE:"+$imagePath)}',
        'if(-not $files -and -not $saved){$t=Get-Clipboard -Raw; if($null -ne $t){Write-Output ("TEXT64:"+[Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($t)))}}',
    ].join('; ');
}
/**
 * Read the Windows clipboard: file paths when Explorer copied files, a
 * raw image (screenshot) saved as PNG into the private image directory,
 * otherwise the plain text. Clipboard access is retried — another process
 * (e.g. Explorer) briefly holding the clipboard open makes OpenClipboard
 * fail with a transient error.
 * @returns The clipboard content, or null when empty/blocked.
 */
function readClipboardWindows() {
    return new Promise(resolve => {
        let attempts = 0;
        const attempt = () => {
            attempts += 1;
            void imageTempPath('image/png').then(imagePath => {
                const child = execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', buildPsScript(imagePath)], { encoding: 'utf8', windowsHide: true, timeout: CLIPBOARD_TIMEOUT }, (error, stdout) => {
                    if (error) {
                        if (attempts < 3) {
                            // Transient clipboard lock — retry shortly.
                            setTimeout(attempt, 150);
                            return;
                        }
                        resolve(null);
                        return;
                    }
                    const files = [];
                    const texts = [];
                    let image = null;
                    for (const line of stdout.split(/\r?\n/)) {
                        if (line.startsWith('FILE:'))
                            files.push(line.slice(5));
                        else if (line.startsWith('IMAGE:'))
                            image = line.slice(6);
                        else if (line.startsWith('TEXT64:')) {
                            texts.push(Buffer.from(line.slice(7), 'base64').toString('utf8'));
                        }
                    }
                    if (files.length > 0)
                        resolve({ kind: 'files', paths: files });
                    else if (image !== null && existsSync(image)) {
                        resolve({ kind: 'image', path: image });
                    }
                    else if (texts.length > 0) {
                        resolve({ kind: 'text', text: texts.join('\n') });
                    }
                    else
                        resolve(null);
                });
                // The app must never be held hostage by a stuck PowerShell.
                child.unref();
            });
        };
        attempt();
    });
}
/**
 * Read the system clipboard for Ctrl+V paste, dispatching on platform:
 * PowerShell on Windows, osascript/pbpaste on macOS, wl-paste/xclip/xsel
 * on Linux and other Unixes.
 * @returns The clipboard content, null when empty/unreadable, or
 *   'unavailable' when no clipboard backend can be reached.
 */
export function readClipboard() {
    switch (process.platform) {
        case 'win32':
            return readClipboardWindows();
        case 'darwin':
            return readClipboardDarwin();
        default:
            return readClipboardLinux();
    }
}
/**
 * Reset the cached Linux paste tool, forcing the next read to re-probe.
 * @internal test-only
 */
export function _resetLinuxPasteCache() {
    linuxPaste = undefined;
}
/**
 * Render pasted clipboard content for insertion into the prompt: file paths
 * and exported image paths quoted when they contain whitespace, text with
 * line endings normalized.
 * @param content - Clipboard content as read by {@link readClipboard}.
 * @returns The prompt-ready text: quoted, space-joined paths, or the text
 *   with line endings normalized.
 */
export function formatClipboardInsert(content) {
    if (content.kind === 'files') {
        return content.paths
            .map(path => (/\s/.test(path) ? `"${path}"` : path))
            .join(' ');
    }
    if (content.kind === 'image') {
        return /\s/.test(content.path) ? `"${content.path}"` : content.path;
    }
    return content.text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}
