/**
 * Replay of the IDE-selection indicator from durable user-message content.
 * The submit path (`dsh-adapter/channel/ide-selection.ts`) appends an
 * `<attached-file path="…" selection count="N">` text block the channel itself
 * builds; parsing it back is channel-format knowledge, not backend knowledge,
 * so it lives beside the shared projector that needs it.
 */
import type { SelectionAttachment } from '../adapter/ports/channel-view.js'

/**
 * Derive the transcript indicator from the durable user-message content:
 * the `<attached-file path="…" selection count="N">` block the submit path
 * appended is part of the persisted event, so a replayed session can rebuild
 * the "Selected N lines from <file>" line even though the in-memory
 * message-id → attachment map starts empty. The indicator must not depend
 * on process-local state.
 */
export function replaySelectionAttachment(
  content: readonly unknown[] | undefined,
): SelectionAttachment | undefined {
  if (content === undefined) return undefined
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    const text = (block as { type?: unknown; text?: unknown }).text
    if ((block as { type?: unknown }).type !== 'text' || typeof text !== 'string') continue
    const opened = /^<attached-file path="([^"]+)" selection(?: count="(\d+)")?>\n/.exec(text)
    if (opened === null) continue
    let closed = text.slice(opened[0].length)
    if (closed.endsWith('</attached-file>')) closed = closed.slice(0, -'</attached-file>'.length)
    // The builder writes `body\n</attached-file>` — strip the newline the
    // close tag rode on, or every body counts one phantom line.
    if (closed.endsWith('\n')) closed = closed.slice(0, -1)
    const lines = closed.split('\n').length
    // `count` is authoritative when present (the builder always writes it).
    // Blocks persisted before it existed fall back to the old tail heuristic,
    // which misreads a body whose last line is literally the truncation marker.
    const counted = opened[2] === undefined ? undefined : Number(opened[2])
    return {
      lines: counted ?? (closed.endsWith('\n[… truncated]') ? lines - 1 : lines),
      // Reverse escapeSnippetAttr so the replayed indicator shows the path
      // exactly as the live one did (`&` first so entities are not re-baked).
      path: opened[1]!
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&amp;/g, '&'),
    }
  }
  return undefined
}
