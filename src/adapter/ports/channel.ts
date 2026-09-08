/**
 * Internal Host Ports for the TUI live Channel.
 *
 * The Channel is the host-internal, stateful terminal projection of one DSH
 * Agent/Session/Workspace. These ports intentionally split that projection
 * into five small internal surfaces:
 *   - projection: the serializable renderer projection (rows/status/tokens);
 *   - actions:    user-driven Channel mutations (submit/cancel/rewind/…);
 *   - state:      the live state snapshot;
 *   - plugins:    plugin-facing seams (external commands, scenes, settings);
 *   - transcript: durable transcript/event access.
 *
 * Boundary rules:
 * - These are TUI host-internal interfaces, not dsh-std/dsh-ecosystem-spec
 *   protocol definitions. No apiVersion/kind/negotiation/permission/manifest
 *   semantics appear here.
 * - No caller-supplied owner/principal/activation identity is accepted;
 *   ownership is derived by the Kernel from the Cordis activation.
 * - Secret values and live function handles are never part of a state or
 *   projection snapshot.
 */

import type { HostDisposer } from './owner.js'

// ── projection ────────────────────────────────────────────────────────────

export interface HostChannelToolProjection {
  readonly callId: string
  readonly name: string
  readonly status: 'running' | 'ok' | 'error'
  readonly argsPreview: string
  readonly resultPreview?: string
  readonly errorText?: string
  readonly startedAt: number
  readonly durationMs?: number
}

export interface HostChannelRowProjection {
  readonly id: number
  readonly kind: string
  readonly text: string
  readonly label?: string
  readonly streaming?: boolean
  readonly time?: number
  readonly seq?: number
  readonly tool?: HostChannelToolProjection
}

export interface HostChannelProjectionSnapshot {
  readonly version: number
  readonly rows: readonly HostChannelRowProjection[]
  readonly status: string
  readonly sessionTitle: string
  readonly agentId: string
  readonly model: string
  readonly provider: string
  readonly cwd: string
  readonly displayCwd: string
  readonly working: boolean
  readonly activeToolCount: number
  readonly lastUserText: string
  readonly commandList: readonly { readonly name: string; readonly description?: string }[]
  readonly contextSegments: Readonly<Record<string, number>>
  readonly subagents: readonly unknown[]
}

export interface HostChannelProjectionPort {
  snapshot(): HostChannelProjectionSnapshot
  subscribe(listener: () => void): HostDisposer
}

// ── actions ───────────────────────────────────────────────────────────────

export interface HostChannelActionsPort {
  submit(text: string): void
  steer(text: string): void
  cancel(): void
  interruptAndDeliver(texts: readonly string[]): number
  clear(): void
  loadOlder(): number
  notify(text: string, options?: { readonly color?: 'error' | 'warning' | 'success'; readonly timeoutMs?: number }): HostDisposer
}

// ── state ─────────────────────────────────────────────────────────────────

export interface HostChannelStateSnapshot {
  readonly version: number
  readonly status: string
  readonly sessionTitle: string
  readonly sessionColor: string
  readonly agentId: string
  readonly agentBindingGeneration: number
  readonly model: string
  readonly provider: string
  readonly cwd: string
  readonly displayCwd: string
  readonly gitBranch?: string
  readonly working: boolean
  readonly cancelPending: boolean
  readonly spinnerMode: string
  readonly responseChars: number
  readonly activeToolCount: number
  readonly turnStart: number
  readonly lastUserText: string
  readonly tokens: Readonly<Record<string, number>>
  readonly lastUsage?: Readonly<Record<string, number>>
  readonly workingActivity?: Readonly<Record<string, unknown>>
  readonly activityFrames?: string
  readonly goal?: Readonly<Record<string, unknown>>
  readonly todos: readonly Readonly<Record<string, unknown>>[]
  readonly loadedContext?: Readonly<Record<string, unknown>>
  readonly pending: readonly Readonly<Record<string, unknown>>[]
  readonly pluginScene?: Readonly<Record<string, unknown>>
  readonly mode: Readonly<Record<string, unknown>>
  readonly agentPreset?: string
}

export interface HostChannelStatePort {
  snapshot(): HostChannelStateSnapshot
}

// ── plugins ───────────────────────────────────────────────────────────────

export interface HostChannelSettingsSectionProjection {
  readonly ns: string
  readonly title: string
  readonly groups?: readonly { readonly id: string; readonly title: string }[]
  readonly fields: readonly Readonly<Record<string, unknown>>[]
}

export interface HostChannelPluginsPort {
  runExternalCommand(name: string, rawInput: string): Promise<string | undefined>
  openPluginScene(id: string): boolean
  closePluginScene(): void
  settingsSections(): readonly HostChannelSettingsSectionProjection[]
  subscribeSettingsSections(listener: () => void): HostDisposer
}

// ── transcript ────────────────────────────────────────────────────────────

export interface HostChannelTranscriptPort {
  rows(): readonly HostChannelRowProjection[]
  traceEvents(): readonly unknown[]
}

// ── aggregate channel port ────────────────────────────────────────────────

export interface HostChannelPort {
  readonly projection: HostChannelProjectionPort
  readonly actions: HostChannelActionsPort
  readonly state: HostChannelStatePort
  readonly plugins: HostChannelPluginsPort
  readonly transcript: HostChannelTranscriptPort
}

export type HostChannelDisposer = HostDisposer
