/**
 * IDE selection consumption: turn a live editor-selection snapshot into the
 * model-facing `<attached-file … selection>` block. Protocol 2 pushes carry
 * the editor buffer's own selection text — that is attached verbatim; the
 * disk read below remains only as the protocol-1 fallback, and every failure
 * mode is silent (an IDE-side extra must never block a send).
 *
 * The block builder never goes through text parsing (unlike `@`-mentions):
 * selection paths may contain spaces no tokenizer could survive. It reuses
 * the same line-slice semantics and size-cap policy as mention attachments.
 */
import { isAbsolute, join } from 'node:path'
import type { ChannelSelection, SelectionAttachment } from '../../adapter/ports/channel-view.js'
import { MENTION_MAX_FILE_CHARS } from './mentions.js'
import type { MentionExpansion, MentionFs } from './types.js'

/**
 * Slice `content` into the 1-based inclusive [`startLine`, `endLine`] range.
 * Returns undefined for malformed ranges (non-safe integers, zero/negative
 * start, inverted) and for a start past EOF — counted against REAL lines: a
 * trailing newline splits into a phantom final element that is not a line.
 */
function sliceLines(
  content: string,
  startLine: number,
  endLine?: number,
): string | undefined {
  const end = endLine ?? startLine
  if (!Number.isSafeInteger(startLine) || startLine < 1) return undefined
  if (!Number.isSafeInteger(end) || end < startLine) return undefined
  const lines = content.split('\n')
  // A trailing newline splits into a phantom final element that is not a line.
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
  if (startLine > lines.length) return undefined
  return lines.slice(startLine - 1, end).join('\n')
}

/**
 * Escape a path for reuse inside a quoted `<attached-file path="…">` attribute:
 * POSIX filenames are legal with `"`, `&`, `<`, `>` — a raw interpolated path
 * could break out of the attribute or smuggle markup into the model-facing
 * block. `&` first so the replacements themselves are not re-escaped.
 */
export function escapeSnippetAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/**
 * Format the attached-file block from an ALREADY-SLICED body: cap it like
 * @-mention attachments (same MENTION_MAX_FILE_CHARS policy, same visible
 * truncation marker) and count the lines the MODEL actually receives —
 * the truncated body, not the request (review round 3).
 */
function cappedSelectionBlock(path: string, sliced: string): { text: string; lines: number } | undefined {
  if (sliced === '') return undefined
  let body = sliced
  let attached = sliced
  if (body.length > MENTION_MAX_FILE_CHARS) {
    attached = body.slice(0, MENTION_MAX_FILE_CHARS)
    body = `${attached}\n[… truncated]`
  }
  return {
    text: `<attached-file path="${escapeSnippetAttr(path)}" selection>\n${body}\n</attached-file>`,
    lines: attached.split('\n').length,
  }
}

/**
 * Build the `<attached-file path="…" selection>` block for an IDE selection:
 * coordinates arrive 0-based inclusive from the extension and convert to
 * sliceLines' 1-based; an endLine past EOF clamps to the last line (the model
 * receives every remaining line), while a startLine past EOF yields undefined
 * — the caller silently skips instead of attaching an empty or stale block.
 * An empty selection is rejected here too so the guard cannot be bypassed.
 */
export function buildSelectionBlock(
  selection: ChannelSelection,
  content: string,
): { text: string; lines: number } | undefined {
  if (selection.isEmpty) return undefined
  // 0-based inclusive [start, end] → 1-based inclusive [start+1, end+1].
  // sliceLines clamps an oversized end itself (Array#slice bounds); a start
  // past EOF returns undefined and the whole attach is silently dropped.
  const sliced = sliceLines(
    content,
    selection.startLine + 1,
    selection.endLine + 1,
  )
  if (sliced === undefined) return undefined
  return cappedSelectionBlock(selection.path, sliced)
}

/**
 * Append the selection's attached-file block to a message's content. Returns
 * what was attached ({lines, path}) or undefined when there is nothing to
 * attach — no selection, or an unresolvable/unreadable file. The caller
 * passes the ENQUEUE-time snapshot (and its fs handle) so a selection made
 * after submit can never attach to the wrong message.
 *
 * Protocol 2 carries the editor buffer's own `text` (unsaved edits
 * included): when present it is attached VERBATIM and the filesystem is not
 * touched — reading the disk copy would hand the model a version the user
 * never saw (maintainer review round 3). The disk read remains only as the
 * protocol-1 fallback.
 */
export async function attachIdeSelection(
  blocks: MentionExpansion['blocks'],
  cwd: string,
  selection: ChannelSelection | undefined,
  fs: MentionFs | undefined,
): Promise<SelectionAttachment | undefined> {
  if (selection === undefined || selection.isEmpty) return undefined
  if (selection.text !== undefined) {
    // Protocol 2: `text` is the editor's OWN text for the selection
    // (document.getText(selection)) — the ABSOLUTE document coordinates ride
    // along for the badge/indicator, but they must NOT slice this string:
    // it already contains exactly the selected lines, so anything not
    // starting at line 0 would be mis-cut or dropped entirely (review
    // round 4). Attach it verbatim with the shared size cap. A full-line
    // selection ends at column 0 of the NEXT line, so getText hands back a
    // trailing '\n' — strip that one terminator or the body grows a phantom
    // blank line and the indicator over-counts by one (review round 5).
    let text = selection.text
    if (text.endsWith('\n')) text = text.slice(0, -1)
    const block = cappedSelectionBlock(selection.path, text)
    if (block === undefined) return undefined
    blocks.push({ type: 'text', text: block.text })
    return { lines: block.lines, path: selection.path }
  }
  if (fs === undefined) return undefined
  try {
    const absolute = isAbsolute(selection.path) ? selection.path : join(cwd, selection.path)
    const target = await fs.resolve(absolute)
    const info = await fs.stat(target)
    if (info?.type !== 'file') return undefined
    const content = await fs.readText(target)
    const block = buildSelectionBlock(selection, content)
    if (block === undefined) return undefined
    blocks.push({ type: 'text', text: block.text })
    return { lines: block.lines, path: selection.path }
  } catch {
    return undefined
  }
}

/**
 * Derive the transcript indicator from the DURABLE user-message content:
 * the `<attached-file path="…" selection>` block the submit path appended is
 * part of the persisted event, so a replayed session can rebuild the
 * "Selected N lines from <file>" line even though the in-memory
 * message-id → attachment map starts empty (maintainer review round 3: the
 * session log is the source of truth — the indicator must not depend on
 * process-local state).
 */
export function replaySelectionAttachment(
  content: readonly unknown[] | undefined,
): SelectionAttachment | undefined {
  if (content === undefined) return undefined
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    const text = (block as { type?: unknown; text?: unknown }).text
    if ((block as { type?: unknown }).type !== 'text' || typeof text !== 'string') continue
    const opened = /^<attached-file path="([^"]+)" selection>\n/.exec(text)
    if (opened === null) continue
    let closed = text.slice(opened[0].length)
    if (closed.endsWith('</attached-file>')) closed = closed.slice(0, -'</attached-file>'.length)
    // The builder writes `body\n</attached-file>` — strip the newline the
    // close tag rode on, or every body counts one phantom line.
    if (closed.endsWith('\n')) closed = closed.slice(0, -1)
    const lines = closed.split('\n').length
    return {
      lines: closed.endsWith('\n[… truncated]') ? lines - 1 : lines,
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

/**
 * Bounded map from a submitted message id → what its selection attached.
 * The delivery path remembers at submit; the transcript projection reads it
 * when the durable `user/message` event lands (the event carries the same
 * message id) to stamp the row's indicator. FIFO-capped like the other
 * row-keyed caches — ids grow monotonically and a miss only loses the
 * indicator, never the attachment itself.
 */
export function createSelectionAttachments(): {
  remember(messageId: string, info: SelectionAttachment): void
  take(messageId: string): SelectionAttachment | undefined
} {
  const byMessageId = new Map<string, SelectionAttachment>()
  return {
    remember(messageId: string, info: SelectionAttachment): void {
      byMessageId.set(messageId, info)
      while (byMessageId.size > 128) {
        const oldest = byMessageId.keys().next().value as string | undefined
        if (oldest === undefined) break
        byMessageId.delete(oldest)
      }
    },
    take(messageId: string): SelectionAttachment | undefined {
      return byMessageId.get(messageId)
    },
  }
}
