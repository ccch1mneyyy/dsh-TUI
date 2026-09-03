/**
 * Channel state module (P4 channel split).
 *
 * Reads the live Channel's mutable reactive state and returns a frozen,
 * JSON-ish state snapshot. This module only projects; it never mutates.
 */

import type { Channel } from '../../dsh-adapter/channel.js'
import type { HostChannelStateSnapshot } from '../ports/channel.js'

function asRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  return Object.freeze({ ...(value as Record<string, unknown>) })
}

function asNumberRecord(value: unknown): Readonly<Record<string, number>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return Object.freeze({})
  const out: Record<string, number> = {}
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (typeof item === 'number' && Number.isFinite(item)) out[key] = item
  }
  return Object.freeze(out)
}

/** Project the live Channel state into a serializable host-internal snapshot. */
export function projectChannelState(channel: Channel): HostChannelStateSnapshot {
  return Object.freeze({
    version: channel.version,
    status: channel.status,
    sessionTitle: channel.sessionTitle,
    sessionColor: channel.sessionColor,
    agentId: channel.agentId,
    agentBindingGeneration: channel.agentBindingGeneration,
    model: channel.model,
    provider: channel.provider,
    cwd: channel.cwd,
    displayCwd: channel.displayCwd,
    ...(channel.gitBranch === undefined ? {} : { gitBranch: channel.gitBranch }),
    working: channel.working,
    cancelPending: channel.cancelPending,
    spinnerMode: channel.spinnerMode,
    responseChars: channel.responseChars,
    activeToolCount: channel.activeToolCount,
    turnStart: channel.turnStart,
    lastUserText: channel.lastUserText,
    tokens: asNumberRecord(channel.tokens),
    ...(channel.lastUsage === undefined ? {} : { lastUsage: asNumberRecord(channel.lastUsage) }),
    ...(channel.workingActivity === undefined ? {} : { workingActivity: asRecord(channel.workingActivity) }),
    ...(channel.activityFrames === undefined ? {} : { activityFrames: channel.activityFrames }),
    ...(channel.goal === undefined ? {} : { goal: asRecord(channel.goal) }),
    todos: Object.freeze(channel.todos.map(todo => Object.freeze({ ...todo }))),
    ...(channel.loadedContext === undefined ? {} : { loadedContext: asRecord(channel.loadedContext) }),
    pending: Object.freeze(channel.pending.map(pending => Object.freeze({ ...pending }))),
    ...(channel.pluginScene === undefined ? {} : { pluginScene: asRecord(channel.pluginScene) }),
    mode: asRecord(channel.mode) ?? Object.freeze({}),
    ...(channel.agentPreset === undefined ? {} : { agentPreset: channel.agentPreset }),
  })
}
