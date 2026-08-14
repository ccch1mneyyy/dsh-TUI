import type { LoadedContext } from '../channel.js'
import { t } from '../i18n.js'

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
  return `${text.slice(0, max)}${t('context-truncated')}`
}

/**
 * One-line collapsed summary of a loaded-context snapshot, naming only the
 * non-empty groups (`${t('context-sections', { n: context.sections.length })} · ${t('context-files', { n: context.files.length })} · ${t('context-skills', { n: context.skills.length })} · ${t('context-tools', { n: context.tools.length })}`).
 * @param context - the loaded-context snapshot.
 * @returns the summary, or `''` when every group is empty.
 */
export function summarizeLoadedContext(context: LoadedContext): string {
  const parts: string[] = []
  if (context.sections.length > 0) parts.push(t('context-sections', { n: context.sections.length }))
  if (context.files.length > 0) parts.push(t('context-files', { n: context.files.length }))
  if (context.contexts.length > 0) parts.push(t('context-runtime', { n: context.contexts.length }))
  if (context.skills.length > 0) parts.push(t('context-skills', { n: context.skills.length }))
  if (context.tools.length > 0) parts.push(t('context-tools', { n: context.tools.length }))
  return parts.join(' · ')
}
