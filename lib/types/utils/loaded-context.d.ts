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
 * non-empty groups (`系统提示词 5 段 · 工作区指令 ×2 · 技能 3 · 工具 28`).
 * @param context - the loaded-context snapshot.
 * @returns the summary, or `''` when every group is empty.
 */
export declare function summarizeLoadedContext(context: LoadedContext): string;
//# sourceMappingURL=loaded-context.d.ts.map