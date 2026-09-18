/**
 * IDE selection consumption: turn a live editor-selection snapshot into the
 * model-facing `<attached-file … selection>` block. The loopback link carries
 * coordinates only — the file is resolved and read here, at submit time, and
 * every failure mode is silent (an IDE-side extra must never block a send).
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
  if (sliced === undefined || sliced === '') return undefined
  // Capped like @-mention attachments: a huge selection would otherwise
  // exceed the context window. Same policy as expandMentions
  // (MENTION_MAX_FILE_CHARS), with the same visible truncation marker so the
  // model knows the tail was cut.
  let body = sliced
  if (body.length > MENTION_MAX_FILE_CHARS) {
    body = `${body.slice(0, MENTION_MAX_FILE_CHARS)}\n[… truncated]`
  }
  return {
    text: `<attached-file path="${escapeSnippetAttr(selection.path)}" selection>\n${body}\n</attached-file>`,
    lines: sliced.split('\n').length,
  }
}

/**
 * Append the selection's attached-file block to a message's content. Returns
 * what was attached ({lines, path}) or undefined when there is nothing to
 * attach — no selection, or an unresolvable/unreadable file. The caller
 * passes the ENQUEUE-time snapshot (and its fs handle) so a selection made
 * after submit can never attach to the wrong message.
 */
export async function attachIdeSelection(
  blocks: MentionExpansion['blocks'],
  cwd: string,
  selection: ChannelSelection | undefined,
  fs: MentionFs | undefined,
): Promise<SelectionAttachment | undefined> {
  if (selection === undefined || selection.isEmpty) return undefined
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
