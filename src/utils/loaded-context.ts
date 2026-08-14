import type { LoadedContext } from '../channel.js'

/** Per-entry display cap: the panel shows the beginning of long texts. */
export const CONTEXT_ENTRY_MAX_CHARS = 800

/**
 * Truncate one entry's text for the panel body. The model-visible text is
 * the source of truth and stays complete in the session log; the panel only
 * bounds its own rendering.
 * @param text - the interpolated model-visible text.
 * @param max - character cap, defaults to {@link CONTEXT_ENTRY_MAX_CHARS}.
 * @returns the text, or its head plus a truncation marker.
 */
export function truncateContextText(text: string, max = CONTEXT_ENTRY_MAX_CHARS): string {
  if (text.length <= max) return text
  return `${text.slice(0, max)}…（已截断）`
}

/**
 * One-line collapsed summary of a loaded-context snapshot, naming only the
 * non-empty groups (`系统提示词 5 段 · 工作区指令 ×2 · 技能 3 · 工具 28`).
 * @param context - the loaded-context snapshot.
 * @returns the summary, or `''` when every group is empty.
 */
export function summarizeLoadedContext(context: LoadedContext): string {
  const parts: string[] = []
  if (context.sections.length > 0) parts.push(`系统提示词 ${context.sections.length} 段`)
  if (context.files.length > 0) parts.push(`工作区指令 ×${context.files.length}`)
  if (context.contexts.length > 0) parts.push(`运行时上下文 ${context.contexts.length} 项`)
  if (context.skills.length > 0) parts.push(`技能 ${context.skills.length}`)
  if (context.tools.length > 0) parts.push(`工具 ${context.tools.length}`)
  return parts.join(' · ')
}
