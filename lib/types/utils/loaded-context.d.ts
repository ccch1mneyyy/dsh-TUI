import type { LoadedContext } from '../channel.js';
/** Per-entry display cap: the panel shows the beginning of long texts. */
export declare const CONTEXT_ENTRY_MAX_CHARS = 800;
/**
 * Truncate one entry's text for the panel body. The model-visible text is
 * the source of truth and stays complete in the session log; the panel only
 * bounds its own rendering.
 * @param text - the interpolated model-visible text.
 * @param max - character cap, defaults to {@link CONTEXT_ENTRY_MAX_CHARS}.
 * @returns the text, or its head plus a truncation marker.
 */
export declare function truncateContextText(text: string, max?: number): string;
/**
 * One-line collapsed summary of a loaded-context snapshot, naming only the
 * non-empty groups (`${t('context-sections', { n: context.sections.length })} · ${t('context-files', { n: context.files.length })} · ${t('context-skills', { n: context.skills.length })} · ${t('context-tools', { n: context.tools.length })}`).
 * @param context - the loaded-context snapshot.
 * @returns the summary, or `''` when every group is empty.
 */
export declare function summarizeLoadedContext(context: LoadedContext): string;
//# sourceMappingURL=loaded-context.d.ts.map