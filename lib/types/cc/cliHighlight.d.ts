/** The cli-highlight surface dsh-tui consumes: the syntax highlighter and the language support check. */
export type CliHighlight = {
    highlight: typeof import('cli-highlight').highlight;
    supportsLanguage: typeof import('cli-highlight').supportsLanguage;
};
/**
 * Return the shared cli-highlight load promise, starting the lazy load on first call.
 * @returns A promise of the loaded cli-highlight surface, or null when the dynamic import fails.
 */
export declare function getCliHighlightPromise(): Promise<CliHighlight | null>;
/**
 * eg. "foo/bar.ts" → "TypeScript". Awaits the shared cli-highlight load,
 * then reads highlight.js's language registry. All callers are telemetry
 * (OTel counter attributes, permission-dialog unary events) — none block
 * on this, they fire-and-forget or the consumer already handles Promise<string>.
 * @param file_path - Source file path whose extension names the language.
 * @returns The language display name, or 'unknown' when the extension is empty or unregistered.
 */
export declare function getLanguageName(file_path: string): Promise<string>;
//# sourceMappingURL=cliHighlight.d.ts.map