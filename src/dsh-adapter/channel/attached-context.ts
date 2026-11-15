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
 *  projection minus the fields the channel derives itself (id/chars). */
export type AttachedContextInput = Pick<AttachedContext, 'source' | 'sourceId' | 'title' | 'content'> & {
  /** Set by a caller that already capped this body (a retracted row's snapshot
   *  re-staged by the composer): the flag must ride along instead of being
   *  re-derived from a body that now fills the cap exactly. */
  readonly truncated?: boolean
}

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

/** NUL cannot appear in either part, so the join is unambiguous. */
const keyOf = (sourceId: string, title: string): string => `${sourceId}\u0000${title}`

/**
 * Snapshot-first merge: a dock re-send keeps the contexts its row saved and
 * still carries anything staged while the row sat in the dock. The live chips
 * were already taken by `captureOrigin()`, so dropping them here would lose
 * them for good. A duplicate key is the same panel staged again: the newer
 * staged snapshot replaces the saved one (the user just edited it).
 */
export function mergeAttachedContexts(
  saved: readonly AttachedContext[],
  staged: readonly AttachedContext[],
): readonly AttachedContext[] {
  if (staged.length === 0) return saved
  // A duplicate key is the same panel staged again: the newer snapshot wins,
  // or the model gets the text the user just replaced. `saved` keeps its
  // order; only its stale copies are swapped out.
  const byKey = new Map(staged.map(context => [keyOf(context.sourceId, context.title), context]))
  const merged = saved.map(context => byKey.get(keyOf(context.sourceId, context.title)) ?? context)
  const savedKeys = new Set(saved.map(context => keyOf(context.sourceId, context.title)))
  const extra = staged.filter(context => !savedKeys.has(keyOf(context.sourceId, context.title)))
  return extra.length === 0 && merged.every((context, index) => context === saved[index]) ? saved : [...merged, ...extra]
}

/** A `$cmd` context whose command is still running: the body arrives (or
 *  doesn't, when the run is interrupted) through `settle`. */
export interface DeferredShellContext {
  /** Resolves with the staged context once the run settles, or `undefined`
   *  when it produced nothing to stage (interrupted / session gone). */
  readonly promise: Promise<AttachedContext | undefined>
  /** Deliver the run's body (`$ cmd\n<output>`), or `undefined` for no
   *  context. Idempotent; an unconsumed entry materializes as a chip. */
  settle(content: string | undefined): void
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
  /** Register a `$cmd` run whose output becomes a staged context when it
   *  settles: a submission that consumes it first (see `consumeShell`)
   *  waits for the run instead of missing its output. */
  deferShell(sourceId: string, title: string): DeferredShellContext
  /** Take every deferred shell context registered so far, in registration
   *  order: the submission being enqueued owns them (its delivery awaits
   *  their runs); later registrations belong to later submissions. */
  consumeShell(): readonly Promise<AttachedContext | undefined>[]
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
  /** `$cmd` runs registered but not yet consumed by a submission. An entry
   *  leaves when a submission takes it (consumeShell) or when it settles
   *  unconsumed — then it materializes as an ordinary chip instead. */
  interface PendingShell {
    readonly sourceId: string
    readonly title: string
    consumed: boolean
    settled: boolean
    resolve(context: AttachedContext | undefined): void
    readonly promise: Promise<AttachedContext | undefined>
  }
  const pendingShell: PendingShell[] = []
  /** Build one capped context entry (shared by `attach` and deferred shell
   *  settles so both cap and label identically). */
  const build = (input: AttachedContextInput, id: string): AttachedContext => {
    // A snapshot that is already capped knows whether it was cut; re-deriving
    // the flag from its body would read a cut body as a full one.
    const capped = input.truncated === true
      ? { content: input.content.slice(0, MENTION_MAX_FILE_CHARS), truncated: true }
      : capContent(input.content)
    return {
      id,
      source: input.source,
      sourceId: input.sourceId,
      title: input.title,
      content: capped.content,
      chars: capped.content.length,
      truncated: capped.truncated,
    }
  }
  return {
    attach(input: AttachedContextInput): void {
      const list = holder().attachedContexts
      const key = keyOf(input.sourceId, input.title)
      const index = list.findIndex(item => keyOf(item.sourceId, item.title) === key)
      const existing = index === -1 ? undefined : list[index]
      const next = build(input, existing === undefined ? `ctx-${++sequence}` : existing.id)
      holder().attachedContexts = index === -1
        ? [...list, next]
        : list.map((item, at) => (at === index ? next : item))
      // The projection is read through the detached read view, which keys its
      // frozen snapshots on `version`: every change must bump it or the
      // composer keeps rendering the previous array.
      emit()
    },
    deferShell(sourceId: string, title: string): DeferredShellContext {
      let resolve!: (context: AttachedContext | undefined) => void
      const promise = new Promise<AttachedContext | undefined>((res) => { resolve = res })
      const entry: PendingShell = { sourceId, title, consumed: false, settled: false, resolve, promise }
      pendingShell.push(entry)
      return {
        promise,
        settle(content: string | undefined): void {
          if (entry.settled) return
          entry.settled = true
          const at = pendingShell.indexOf(entry)
          if (at !== -1) pendingShell.splice(at, 1)
          if (content === undefined) { entry.resolve(undefined); return }
          const context = build({ source: 'shell', sourceId, title, content }, `ctx-${++sequence}`)
          if (!entry.consumed) {
            // Nobody is waiting for this run: it becomes a chip, exactly
            // like a context staged after the fact always has.
            holder().attachedContexts = [...holder().attachedContexts, context]
            emit()
          }
          entry.resolve(context)
        },
      }
    },
    consumeShell(): readonly Promise<AttachedContext | undefined>[] {
      if (pendingShell.length === 0) return []
      const taken = pendingShell.splice(0)
      for (const entry of taken) entry.consumed = true
      return taken.map(entry => entry.promise)
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
