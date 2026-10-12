/**
 * Mirror dsh-api-session-controller's sessionListMetadata projection (0.2.0-rc.2).
 * The web sidebar treats a missing row as nonblank, so TUI checkpoints need the
 * same key, stateVersion, schema and fold. verify-session-list-metadata checks
 * the installed host definition for drift.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { z } from 'zod'

export const SESSION_LIST_METADATA_KEY = 'sessionListMetadata'
export const SESSION_LIST_METADATA_STATE_VERSION = 1

export interface SessionListMetadataState {
  readonly blank: boolean
  readonly lastPromptAt: number | null
}

const sessionListMetadataSchema = z.object({
  blank: z.boolean(),
  lastPromptAt: z.number().nullable(),
})

export function initSessionListMetadata(): SessionListMetadataState {
  return { blank: true, lastPromptAt: null }
}

/** Match the host fold, including reference identity when neither field changes. */
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

function sessionListMetadataDefinition() {
  const view = (state: SessionListMetadataState): SessionListMetadataState => state
  return {
    key: SESSION_LIST_METADATA_KEY,
    stateVersion: SESSION_LIST_METADATA_STATE_VERSION,
    stateSchema: sessionListMetadataSchema,
    init: initSessionListMetadata,
    apply: applySessionListMetadata,
    wire: { viewSchema: sessionListMetadataSchema, view },
    // rc.6 and alpha.2 registries accept register() but read these older fields.
    // Reuse the same schema and view so registration order cannot change meaning.
    schema: sessionListMetadataSchema,
    viewSchema: sessionListMetadataSchema,
    view,
  }
}

interface ProjectionRegistry {
  register?(definition: ReturnType<typeof sessionListMetadataDefinition>): unknown
}

/** Register before creating the boot agent, so its first checkpoint has the key. */
export function attachSessionListMetadata(ctx: Context): void {
  ctx.inject(['sessionProjections'] as never, ((projectionCtx: Context) => {
    const registry = (projectionCtx as unknown as { sessionProjections?: ProjectionRegistry }).sessionProjections
    if (typeof registry?.register !== 'function') return
    try {
      // The host binds this registration to the calling context's fiber.
      registry.register(sessionListMetadataDefinition())
    } catch (error) {
      try {
        ctx.logger.debug(`dsh-tui: could not register sessionListMetadata: ${String(error)}`)
      } catch {
        // Diagnostics must not turn a missing seam or version conflict into a startup failure.
      }
    }
  }) as never)
}
