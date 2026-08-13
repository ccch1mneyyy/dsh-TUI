// highlight.js's type defs carry `/// <reference lib="dom" />`. SSETransport,
// mcp/client, ssh, dumpPrompts use DOM types (TextDecodeOptions, RequestInfo)
// that only typecheck because this file's `typeof import('highlight.js')` pulls
// lib.dom in. tsconfig has lib: ["ESNext"] only — fixing the actual DOM-type
// deps is a separate sweep; this ref preserves the status quo.
/// <reference lib="dom" />
import { extname } from 'path';
// One promise shared by Fallback.tsx, markdown.ts, events.ts, getLanguageName.
// The highlight.js import piggybacks: cli-highlight has already pulled it into
// the module cache, so the second import() is a cache hit — no extra bytes
// faulted in.
let cliHighlightPromise;
// highlight.js types vary by version; the language registry lookup is only
// used by optional telemetry paths, so keep a loose signature.
let loadedGetLanguage;
async function loadCliHighlight() {
    try {
        const cliHighlight = await import('cli-highlight');
        // cache hit — cli-highlight already loaded highlight.js
        const highlightJs = await import('highlight.js');
        loadedGetLanguage = highlightJs.getLanguage;
        return {
            highlight: cliHighlight.highlight,
            supportsLanguage: cliHighlight.supportsLanguage,
        };
    }
    catch {
        return null;
    }
}
/**
 * Return the shared cli-highlight load promise, starting the lazy load on first call.
 * @returns A promise of the loaded cli-highlight surface, or null when the dynamic import fails.
 */
export function getCliHighlightPromise() {
    cliHighlightPromise ??= loadCliHighlight();
    return cliHighlightPromise;
}
/**
 * eg. "foo/bar.ts" → "TypeScript". Awaits the shared cli-highlight load,
 * then reads highlight.js's language registry. All callers are telemetry
 * (OTel counter attributes, permission-dialog unary events) — none block
 * on this, they fire-and-forget or the consumer already handles Promise<string>.
 * @param file_path - Source file path whose extension names the language.
 * @returns The language display name, or 'unknown' when the extension is empty or unregistered.
 */
export async function getLanguageName(file_path) {
    await getCliHighlightPromise();
    const ext = extname(file_path).slice(1);
    if (!ext)
        return 'unknown';
    return loadedGetLanguage?.(ext)?.name ?? 'unknown';
}
