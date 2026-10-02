/**
 * Attached contexts ("Send to Chat", side-panel design §6.7): a panel stages
 * one of its rows on the channel, the composer renders a chip for it, and the
 * NEXT submission carries the model-facing `<attached-context …>` block.
 *
 * Deliberately the same seam as the IDE-selection channel next door
 * (`ide-selection.ts`): a projection the composer renders, an ENQUEUE-time
 * snapshot consumed exactly once by the submit path, and a block builder that
 * never goes through text parsing. The one difference is where the body comes
 * from — a panel hands it over in-process, so there is no disk read and no
 * failure mode to swallow. The only policy left is the shared mention size cap.
 */
import { escapeSnippetAttr } from './ide-selection.js'
import { MENTION_MAX_FILE_CHARS } from './mentions.js'
import type { AttachedContext } from '../../adapter/ports/channel-view.js'
import type { MentionExpansion } from './types.js'

/** What a panel hands to {@link AttachedContextRegistry.attach}: the staged
 *  projection minus the fields the channel derives itself (id/chars/truncated). */
export type AttachedContextInput = Pick<AttachedContext, 'source' | 'sourceId' | 'title' | 'content'>

/**
 * Cell the registry writes through — the live ChannelState. The list is
 * REPLACED on every change (never mutated in place), which is both what the
 * projection wants (a fresh array per revision) and what the port's readonly
 * element type allows the channel state to hold.
 */
export interface AttachedContextHolder {
  attachedContexts: readonly AttachedContext[]
}

/**
 * Cap one panel body at the shared mention limit. Truncation is recorded ON the
 * entry (`truncated`) rather than re-derived from the body later: the block
 * builder appends the visible `[… truncated]` marker from that flag, so a body
 * that legitimately fills the cap is never mislabelled as cut — and `chars`
 * stays "the length of what the model will actually receive".
 */
function capContent(content: string): { content: string; truncated: boolean } {
  if (content.length <= MENTION_MAX_FILE_CHARS) return { content, truncated: false }
  return { content: content.slice(0, MENTION_MAX_FILE_CHARS), truncated: true }
}

/**
 * Build one model-facing block, shaped like the selection channel's
 * `<attached-file …>`: escaped attributes, one body, the close tag. The
 * attribute values reuse `escapeSnippetAttr` — a title or source id carrying
 * `"`/`&`/`<`/`>` must not break out of the attribute or smuggle markup
 * into the model-facing block.
 */
export function buildAttachedContextBlock(context: AttachedContext): string {
  const body = context.truncated ? `${context.content}\n[… truncated]` : context.content
  return `<attached-context source="${context.source}" sourceId="${escapeSnippetAttr(context.sourceId)}" title="${escapeSnippetAttr(context.title)}">\n${body}\n</attached-context>`
}

/**
 * Append every staged context as its own block, in stage order (the order the
 * chips render in), after the typed text and every other attachment. The caller
 * passes the ENQUEUE-time snapshot: a panel that stages something while the
 * delivery FIFO is parked can never ride along with a message it was not typed
 * for. Returns how many blocks were appended (telemetry/assertions).
 */
export function appendAttachedContextBlocks(
  blocks: MentionExpansion['blocks'],
  contexts: readonly AttachedContext[],
): number {
  for (const context of contexts) {
    blocks.push({ type: 'text', text: buildAttachedContextBlock(context) })
  }
  return contexts.length
}

/** The ChannelState-facing surface (projection writes + the two actions). */
export interface AttachedContextRegistry {
  /** Stage (or re-stage) one panel context; see the REPLACE note below. */
  attach(input: AttachedContextInput): void
  /** Drop one staged context by id (unknown id = no-op, no emit). */
  detach(id: string): void
  /**
   * Take-and-clear in one step: the submission that captured the snapshot owns
   * exactly those contexts. Splitting snapshot/clear would let a second
   * submission — or a queued skill command — capture chips the first one
   * already spent (the draft takes the same "spent at submit" semantics).
   */
  consume(): readonly AttachedContext[]
}

/**
 * Registry behind `ChannelUi.attachedContexts` / `attachContext` /
 * `detachContext`. It owns no state of its own: every entry lives in the
 * channel state's array, so the session-scoped reset that clears the other
 * projections (`resetSessionProjection`) clears this one by assignment.
 *
 * Duplicate `sourceId` + `title` REPLACES the existing entry (keeping its id
 * and position) instead of stacking a second chip: a panel row re-sent after it
 * changed — or sent twice by a double 's' keypress — is the same attachment, and
 * a stable id keeps chip keys and any future detach-by-sender valid across the
 * update. Distinct titles under one id stay separate chips.
 */
export function createAttachedContextRegistry(
  holder: () => AttachedContextHolder,
  emit: () => void,
): AttachedContextRegistry {
  let sequence = 0
  /** NUL cannot appear in either part, so the join is unambiguous. */
  const keyOf = (sourceId: string, title: string): string => `${sourceId}\u0000${title}`
  return {
    attach(input: AttachedContextInput): void {
      const capped = capContent(input.content)
      const list = holder().attachedContexts
      const key = keyOf(input.sourceId, input.title)
      const index = list.findIndex(item => keyOf(item.sourceId, item.title) === key)
      const existing = index === -1 ? undefined : list[index]
      const next: AttachedContext = {
        id: existing === undefined ? `ctx-${++sequence}` : existing.id,
        source: input.source,
        sourceId: input.sourceId,
        title: input.title,
        content: capped.content,
        chars: capped.content.length,
        truncated: capped.truncated,
      }
      holder().attachedContexts = index === -1
        ? [...list, next]
        : list.map((item, at) => (at === index ? next : item))
      // The projection is read through the detached read view, which keys its
      // frozen snapshots on `version`: every change must bump it or the
      // composer keeps rendering the previous array.
      emit()
    },
    detach(id: string): void {
      const list = holder().attachedContexts
      const remaining = list.filter(item => item.id !== id)
      if (remaining.length === list.length) return
      holder().attachedContexts = remaining
      emit()
    },
    consume(): readonly AttachedContext[] {
      const list = holder().attachedContexts
      if (list.length === 0) return []
      const taken = [...list]
      holder().attachedContexts = []
      emit()
      return taken
    },
  }
}
