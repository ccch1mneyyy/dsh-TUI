/**
 * The composer draft that a screen hands to its owner on the way out.
 *
 * Every screen that REPLACES the conversation (`/resume`'s session screen, the
 * session tree, `/settings`, the jobs panel, the trajectory scene) is an early
 * return in `Chat`, so `PromptInput` is unmounted while the user is away and
 * its text, caret and staged-image bindings live in component state. The owner
 * therefore holds one slot of this type and the composer fills it as it
 * unmounts; on the way back it is read, checked and consumed.
 *
 * Deliberately dependency-free (it does not import `PromptInput`, which would
 * be a cycle), so the component and the headless regressions can both assert
 * against the same rules.
 *
 * The snapshot shape, the image-liveness rule and the carried edit state
 * (fold block, fullscreen editor, vim mode) are taken from PR #847
 * (`promptDraftCache.ts`, branch `fix/composer-draft-retention`); the owner
 * check here adds the agent id, because a generation alone cannot tell two
 * channels with a fixed generation apart.
 */

/** One token → staged-image capability pair, in visible order. */
export type PromptDraftImage = readonly [token: string, stageId: string]

/**
 * Everything the composer needs to put a draft back exactly as it was left.
 *
 * Transient interaction state — mouse selection, drag anchor, suggestion menu,
 * history position, editor scroll, the vim undo stack — is NOT here: it
 * describes a composer that was on screen, not the draft that outlives it.
 */
export interface PromptDraftSnapshot {
  /** Agent the draft was typed into; a different one means "not this draft". */
  readonly ownerAgentId: string
  /** Binding generation at capture time; see {@link resolveBindingGeneration}. */
  readonly bindingGeneration: number
  readonly value: string
  readonly cursor: number
  /**
   * Fold block [start, end) rendering as a one-line chip, or null. Edit
   * state, not transient chrome: coming back with the text unfolded loses
   * exactly what the user folded.
   */
  readonly foldBlock: { readonly start: number; readonly end: number } | null
  /** Fullscreen draft editor open at capture time. */
  readonly expanded: boolean
  /** vim mode on (`/vim`), and whether it is in INSERT (vs NORMAL) submode. */
  readonly vimEnabled: boolean
  readonly vimInsert: boolean
  /** Visible `[Image #N]` token → staged stageId, so images survive the trip. */
  readonly images: readonly PromptDraftImage[]
}

/**
 * The single slot an owner (today: `Chat`) keeps for the composer draft.
 *
 * A mutable ref-shaped cell rather than React state: it is written from an
 * unmount cleanup and read from a mount effect, and neither may trigger a
 * render — a draft that changed the first frame would move the transcript's
 * restored scroll position.
 */
export interface PromptDraftCache {
  current: PromptDraftSnapshot | null
}

/**
 * The current binding generation, mirroring the channel expression: the agent
 * binding generation advances on every agent replacement (`/resume` to another
 * session, `/new`, `/bg`, attach, rewind) and wins; a simplified or embedded
 * channel without it falls back to the staged-image generation, and 0 when it
 * has neither.
 * @param source - The channel, or anything carrying the same two members.
 * @returns The generation the snapshot is fenced against.
 */
export function resolveBindingGeneration(source: {
  readonly agentBindingGeneration?: number
  readonly stagedImageGeneration?: () => number
}): number {
  return source.agentBindingGeneration ?? source.stagedImageGeneration?.() ?? 0
}

/**
 * Whether a stored draft belongs to the conversation in front of us now.
 *
 * Both halves are required. The generation catches a replaced binding; the
 * agent id catches the case a generation cannot describe — a test or embedded
 * channel whose generation is a constant, where a stale draft would otherwise
 * be adopted by a different conversation.
 * @param snapshot - The stored draft, if any.
 * @param ownerAgentId - Agent id of the composer that would restore it.
 * @param generation - Current binding generation.
 */
export function isUsableDraftSnapshot(
  snapshot: PromptDraftSnapshot | null | undefined,
  ownerAgentId: string,
  generation: number,
): snapshot is PromptDraftSnapshot {
  return snapshot !== null
    && snapshot !== undefined
    && snapshot.ownerAgentId === ownerAgentId
    && snapshot.bindingGeneration === generation
}

/**
 * Drop the image bindings whose capability is gone.
 *
 * A visible `[Image #N]` is only a label; what makes it an attachment is the
 * stageId behind it. A session switch (or a discard) revokes the capability and
 * the label must not be re-bound by reading the number back out of the text.
 * Entries that fail the check are dropped silently and the caller keeps the
 * visible token as ordinary text, which is the behaviour an edit already has.
 * @param images - Stored pairs.
 * @param hasStagedImage - Channel capability probe; absent means "none live".
 */
export function filterLiveImageBindings(
  images: readonly PromptDraftImage[] | null | undefined,
  hasStagedImage?: (stageId: string) => boolean,
): readonly PromptDraftImage[] {
  if (images === null || images === undefined) return []
  const live: PromptDraftImage[] = []
  for (const entry of images) {
    if (!Array.isArray(entry) || entry.length !== 2) continue
    const [token, stageId] = entry
    if (typeof token !== 'string' || typeof stageId !== 'string') continue
    if (hasStagedImage?.(stageId) !== true) continue
    live.push([token, stageId])
  }
  return live
}
