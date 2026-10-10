/**
 * The `sessionListMetadata` session projection — this app's half of the web
 * sidebar's "is this session blank?" marker.
 *
 * ## Why a mirror instead of an import
 *
 * `dsh web` hides the sessions it believes never saw a prompt by reading a
 * projection key that only the web host registered (`ApiSessionList`). A session
 * created here therefore carried no row for that key at all, and the sidebar
 * fell back to `metadata?.blank ?? false` — a fallback that deliberately keeps
 * unknown sessions visible. Registering the **same key** with the **same
 * version** and the **same fold** is what puts the row there. The semantics stay
 * owned by the web host: this module adds no field and invents no rule.
 *
 * ## Mirror source (host line `0.2.0-rc.2`) — re-read it before editing
 *
 * | what | host location |
 * |---|---|
 * | state schema `{blank, lastPromptAt}` | `dsh-api-session-controller/lib/types/list.js:9-12` |
 * | fold | `dsh-api-session-controller/lib/types/list.js:27-35` |
 * | registration (`stateVersion: 1`, identity `wire`, no `init` args) | `dsh-api-session-controller/lib/types/list.js:59-66` |
 * | key ownership, refs, version check, first-registration-wins | `dsh-session-projection/lib/index.js:81-93` |
 * | checkpoint writes one row per registered key | `dsh-session-projection/lib/index.js:195-207` |
 * | every WIRE read skips a definition without `wire` | `dsh-session-projection/lib/index.js:147`, `:170`, `:249` |
 * | `stateSchema.parse`: hot read guarded, cold `restore()` NOT guarded | `dsh-session-projection/lib/index.js:255`, `:297` |
 *
 * **Any change on either side must be made on both sides.** A drifted fold or
 * version fails silently rather than loudly: the row is written with the wrong
 * meaning, or discarded by the version check, and the original symptom
 * (untitled shells in the sidebar) simply comes back with nothing in the log.
 * `scripts/verify-session-list-metadata.ts` folds this definition side by side
 * with the installed host's own `applySessionListMetadata` and goes red when the
 * two disagree; run it after any host upgrade.
 *
 * ## Why the identity wire is registered
 *
 * A registration without `wire` still writes its row (`index.js:195-207`), which
 * is why the original fix looked sufficient — but every *read* face the web
 * sidebar uses (`snapshot`, `cachedSnapshot`, `viewCheckpoint`, `restore`)
 * returns nothing for a key whose winning definition has no `wire`
 * (`index.js:147`, `:170`, `:249`). Because the first registration of a key
 * keeps the key (`:81-93`), a mirror registered before the host's own definition
 * blanked the key for that read face: `snapshot(session, ['sessionListMetadata'])`
 * served `{values: {}}`, the sidebar fell back to `metadata?.blank ?? false` and
 * #1342 came straight back. The wire is the identity (`view: state => state`,
 * `list.js:64`) parsed with the VERY SAME schema object the state already
 * passed, so it cannot be the stricter of the two `viewSchema.parse` call sites
 * (`index.js:259`, `:305`) — it can only fail where `stateSchema` would have.
 *
 * ## What is deliberately absent
 *
 * No second schema, no copy of the state, and none of the legacy definition-level
 * spellings (`schema` / `viewSchema` / `view`): those belong to older host lines
 * whose registration shape this mirror does not speak (ADR-0011 decision 8), and
 * a separate copy could drift into being stricter than the state it views.
 *
 * ## Failure is not an option here
 *
 * Registration is best-effort by design: a host line without the registration
 * seam, or one that already owns the key at another `stateVersion` (the host
 * `register` throws), must leave the app running exactly as before. The reason
 * goes to the opt-in debug channel and nowhere else.
 * @module dsh-tui/dsh-adapter/session-list-metadata
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { z } from 'zod'
import type { ProjectionRegistrationLike, ProjectionRegistryLike } from './activity-store.js'

/** The projection key the web host owns and this app mirrors. */
export const SESSION_LIST_METADATA_KEY = 'sessionListMetadata'

/**
 * The persisted-state version of that unit.
 *
 * Must equal the host's `stateVersion` (`list.js:65`): a second registration of
 * one key is accepted only at the same version, and a stored row is discarded
 * when its `ver` differs (`index.js:85-93`, `:297`).
 */
export const SESSION_LIST_METADATA_STATE_VERSION = 1

/**
 * The mirrored value: what `ApiSessionList` folds and what the sidebar reads.
 *
 * Structural copy of the host's **state** (there is no separate view — the host
 * registers `view: state => state`, `list.js:64`).
 */
export interface SessionListMetadataState {
  /** `true` while no turn has ever started; the sidebar hides sessions that stay blank. */
  readonly blank: boolean
  /** Wall clock of the last human prompt, or `null` before the first one. */
  readonly lastPromptAt: number | null
}

/** Field-for-field the host's `sessionListMetadataSchema` (`list.js:9-12`). */
const sessionListMetadataSchema = z.object({
  blank: z.boolean(),
  lastPromptAt: z.number().nullable(),
})

/**
 * The value a session starts from (`list.js:62`).
 * @returns fresh metadata for a session that has not seen an event yet.
 */
export function initSessionListMetadata(): SessionListMetadataState {
  return { blank: true, lastPromptAt: null }
}

/**
 * Advance the mirrored metadata by one committed event.
 *
 * Verbatim copy of the host's `applySessionListMetadata` (`list.js:27-35`),
 * including both of its observable properties: an event that changes nothing
 * returns the **same reference** (the host re-publishes on `Object.is`), and
 * `blank` can only ever go from `true` to `false`.
 *
 * `event.data.source` is read unguarded on purpose — that is what the host does,
 * and the session codec refuses to store a `user/message` without a valid source
 * at all ("seed user/message ... has invalid source"). A defensive branch would
 * be a *second* semantic, and because the first registration wins
 * (`index.js:85-93`) the two sides would then disagree depending on mount order.
 * @param state - metadata before the event.
 * @param event - next committed session event.
 * @returns the original state, or the advanced value.
 */
export function applySessionListMetadata(
  state: SessionListMetadataState,
  event: SessionEvent,
): SessionListMetadataState {
  const blank = state.blank && event.type !== 'turn/start'
  const lastPromptAt = event.type === 'user/message' && event.data.source.kind === 'user'
    ? event.time
    : state.lastPromptAt
  return blank === state.blank && lastPromptAt === state.lastPromptAt
    ? state
    : { blank, lastPromptAt }
}

/**
 * The mirror's registration plus the identity wire its read faces need.
 *
 * {@link ProjectionRegistrationLike} is the activity store's slice and has no
 * read face of its own, so `wire` is added here rather than there. The host's
 * registration carries exactly these two members (`list.js:64`).
 */
interface WiredProjectionRegistration extends ProjectionRegistrationLike {
  readonly wire: {
    readonly viewSchema: { parse(value: unknown): unknown }
    /** The identity view: the host serves the state itself, uncloned. */
    view(state: SessionListMetadataState): SessionListMetadataState
  }
}

/**
 * The definition handed to the host registry — the mirror's whole contract.
 * @returns one registration object (the caller owns nothing on failure).
 */
function sessionListMetadataDefinition(): WiredProjectionRegistration {
  return {
    key: SESSION_LIST_METADATA_KEY,
    stateSchema: sessionListMetadataSchema,
    init: initSessionListMetadata,
    apply: applySessionListMetadata,
    // Identity, and the SAME schema object the state was parsed with: the host
    // parses this view outside a try (`index.js:259`, `:305`), so it must not be
    // able to reject a value `stateSchema` accepted (`list.js:64`).
    wire: { viewSchema: sessionListMetadataSchema, view: state => state },
    stateVersion: SESSION_LIST_METADATA_STATE_VERSION,
  }
}

/**
 * Register the mirrored projection on the host's registry, whatever happens.
 *
 * Never throws: a missing entry point (a host line before the registration
 * seam) and a version conflict (the host refuses to share a key, `index.js:85-93`)
 * both leave the composition as it was. The registration itself is bound to the
 * registry's own fiber by the host, so a re-provided service re-runs this from
 * the fresh registry instead of stacking references on the old one.
 * @param registry - The host projection registry slice.
 * @param debug - Opt-in diagnostics sink (never stdout).
 */
function registerSessionListMetadata(
  registry: ProjectionRegistryLike,
  debug: (message: string) => void,
): void {
  if (typeof registry.register !== 'function') {
    debug(`dsh-tui: sessionProjections has no register(); the ${SESSION_LIST_METADATA_KEY} mirror stays off on this host line`)
    return
  }
  try {
    registry.register(sessionListMetadataDefinition())
  } catch (error) {
    debug(`dsh-tui: could not register the ${SESSION_LIST_METADATA_KEY} mirror; web keeps its current session list: ${String(error)}`)
  }
}

/**
 * The opt-in debug channel, when the composition has one.
 * @param ctx - Context to read the logger from.
 * @returns a sink that swallows its own failures — diagnostics must never be a startup risk.
 */
function debugSink(ctx: Context): (message: string) => void {
  const logger = (ctx as unknown as { logger?: { debug?: (message: string) => void } }).logger
  return message => {
    try {
      logger?.debug?.(message)
    } catch {
      // A logger that cannot log is not a reason to skip a registration.
    }
  }
}

/**
 * Wire the mirrored projection into the host composition.
 *
 * Deferred through `inject` for the same reason the activity feed is: the
 * registry belongs to a plugin mounted alongside this one, so it may not exist
 * yet — and on a host line without it, never. Everything past the presence check
 * is best-effort; see {@link registerSessionListMetadata}.
 * @param ctx - Host context of the composition root.
 */
export function attachSessionListMetadata(ctx: Context): void {
  ctx.inject(['sessionProjections'] as never, ((projectionCtx: Context) => {
    const registry = (projectionCtx as unknown as {
      sessionProjections?: ProjectionRegistryLike
    }).sessionProjections
    if (registry === undefined) return
    registerSessionListMetadata(registry, debugSink(ctx))
  }) as never)
}
