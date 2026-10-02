/**
 * The channel composition root (docs/agent-backend-design.md §3.5): one
 * backend-neutral core for every `AgentSession` (`channel/core/compose.ts`),
 * plus the DSH extensions when the bound session is a DSH session
 * (`channel/extensions.ts`). Adding a backend needs no channel code: its
 * session's typed capabilities decide what the core serves.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { AgentSession } from '../agent/session.js'
import { createDshSession, isAgentSession } from './backend/session.js'
import { createCoreChannel } from './channel/core/compose.js'
import { attachDshExtensions } from './channel/extensions.js'
import { createSessionChannelWithOwner } from './channel/session-channel.js'
import { createChannelOwner } from './channel/owner.js'
import type { ChannelLaunchOptions } from './channel/state.js'
import type { ChannelState } from './channel/types.js'
export type { SubagentState } from './subagents.js'

/**
 * Create the live channel state for one agent session: replay the durable
 * transcript, subscribe to the session's events, and expose every TUI action.
 * @internal
 * @param ctx - The plugin context; optional services are resolved via ctx.get.
 * @param initial - The session the channel renders; rewinds, resumes, and
 *   model switches replace it. A raw DSH agent (direct embedders, fixtures) is
 *   wrapped as a DSH session together with `options.handle`.
 * @param options - Boot options: model route, cwd, provider, and the
 *   reasoning-effort / working-activity preferences.
 * @returns The live channel state, subscribed and ready to render.
 */
export function createChannel(
  ctx: Context,
  initial: AgentSession | Agent,
  options: ChannelLaunchOptions,
): ChannelState {
  const owner = createChannelOwner()
  try {
    const session = isAgentSession(initial) ? initial : createDshSession(ctx, { agent: initial, handle: options.handle })
    const native = session.capabilities.native.dsh
    // Phase 4a checkpoint 1: a non-DSH session still takes its own
    // composition; checkpoint 2 routes it through the core below.
    if (native === undefined) return createSessionChannelWithOwner(ctx, session, options, owner)
    const core = createCoreChannel(ctx, session, options, owner)
    // DSH specialists attach only to a DSH session (design §3.5).
    attachDshExtensions(core, ctx, native, options)
    return core.start()
  } catch (error) {
    // Setup is one transaction from the first acquired resource. Preserve the
    // construction failure while still attempting every registered rollback.
    try { owner.dispose() } catch { /* primary setup error remains authoritative */ }
    throw error
  }
}

export type { ChannelLaunchOptions } from './channel/state.js'
export { expandMentions } from './channel/mentions.js'
export { sessionCwdMatches } from './channel/paths.js'
export type { AgentViewDispatchResult, AgentViewRow, AgentViewStatus, BackgroundResult, Channel, ChannelGoal, ChannelState, ChatRow, ComposerImageRef, ComposerSubmission, CredentialStatus, EffortOption, ExternalCommandOutcome, JobControl, JobGroupRow, JobRow, LoadedContext, LoadedContextEntry, LoadedContextFile, LoadedContextSkill, LoadedContextTool, MentionAttachments, MentionExpansion, MentionFs, NotificationItem, PendingMessage, PermissionPresetAvailability, PermissionPresetCurrent, PermissionPresetOption, PermissionPresetSnapshot, PresetOption, ResumeResult, SkillInfo, StagedImageHandle, StagedImageInput, SubagentControl, SubagentRow, TodoPanelItem, TokenBucket, TokenUsage, ToolCallView, ToolFileDiff, ToolResultView, ToolRow, ToolViewPresenter, TranscriptImage } from './channel/types.js'
export { emptyTokenUsage } from './channel/usage.js'
