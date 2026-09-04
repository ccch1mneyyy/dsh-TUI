/**
 * Agent-preset resolution across upstream prerelease lines.
 *
 * Legacy rc.2 exports `resolveSessionPreset` and ships `code`; the 0.1.2 line
 * replaces the helper with a projection definition and renames that preset to `ptc`.
 * Keeping both compatibility decisions here prevents composition and channel
 * code from acquiring prerelease-specific branches.
 */

import type { Context } from '@deepseek-ai/cordis'

/** One roster entry, as returned by `agentPresets.list()`/`resolve()`. */
export interface AgentPresetInfo {
  readonly id: string
  readonly trust: 'system' | 'user'
  readonly name?: string
  readonly description?: string
  /** Present when the preset cannot compose a session (human-readable). */
  readonly broken?: string
}

/** The `ctx.agentPresets` service surface dsh-tui consumes. */
export interface AgentPresetsLike {
  readonly defaultId: string
  list(): Promise<readonly AgentPresetInfo[]>
  resolve(id?: string): Promise<AgentPresetInfo>
  mount(agentCtx: Context, id?: string): Promise<AgentPresetInfo>
  recompose(agentCtx: Context, id: string): Promise<AgentPresetInfo>
  /** Read one service from the agent's own scope chain (preset realms). */
  serviceFor?(agent: { ctx: Context }, key: string): unknown
}

/** The mounted preset roster, or undefined in a rosterless composition. */
export function rosterOf(ctx: Context): AgentPresetsLike | undefined {
  return ctx.get('agentPresets') as AgentPresetsLike | undefined
}

/** Resolve the durable preset projection: newest selection wins over header. */
export function resolveRecordedPreset(session: {
  header: { agentPreset?: string }
  events: readonly { type: string; data: unknown }[]
}): string | undefined {
  for (let index = session.events.length - 1; index >= 0; index -= 1) {
    const event = session.events[index]
    if (event?.type !== 'agent-preset/selected') continue
    if (event.data === null || typeof event.data !== 'object') continue
    const selected = (event.data as { agentPreset?: unknown }).agentPreset
    if (typeof selected === 'string') return selected
  }
  return session.header.agentPreset
}

/**
 * Resolve an exact roster id first, then bridge the official rename in either
 * direction. A successful list is required before aliasing so roster I/O or
 * a broken exact preset can never be mistaken for an unknown id.
 */
export async function resolveCompatiblePreset(
  presets: AgentPresetsLike,
  requested?: string,
): Promise<AgentPresetInfo> {
  const fallback = requested === 'code' ? 'ptc' : requested === 'ptc' ? 'code' : undefined
  if (fallback === undefined) return presets.resolve(requested)

  const roster = await presets.list()
  if (roster.some(preset => preset.id === requested)) return presets.resolve(requested)
  if (roster.some(preset => preset.id === fallback)) return presets.resolve(fallback)
  return presets.resolve(requested)
}
