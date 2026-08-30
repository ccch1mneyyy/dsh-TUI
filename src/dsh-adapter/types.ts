/**
 * Type-only re-exports of the official upstream surface for UI layers.
 *
 * UI modules (screens/, components/, ink/, hooks/, utils/) must never import
 * `@deepseek-ai/*` directly — they import types from here. This keeps the
 * upstream coupling in one tree (src/dsh-adapter/) so an upstream prerelease bump
 * breaks exactly one module, never the whole UI.
 */
export type { LlmModelInfo, LlmProviderInfo } from '@deepseek-ai/dsh-llm'
export type { Agent, AgentHandle, AgentStatus, CreateAgentOptions, ModelSelectionRef } from '@deepseek-ai/dsh-agent'
export type { SessionId, SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
export type { CommandRuntime } from '@deepseek-ai/dsh-commands'
export type { ApprovalOutcome, ApprovalRequest } from '@deepseek-ai/dsh-user-approval'
export type { AgentSetup } from '@deepseek-ai/dsh-agent'
export type { Context } from '@deepseek-ai/cordis'
export type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

/**
 * Trajectory projection types. Not upstream types, but the same rule applies:
 * the scene is pure UI over this shape and never reaches into the projection's
 * own modules (which do import `@deepseek-ai/*`).
 */
export type {
  HotspotRow,
  HotspotSort,
  TrajAggregate,
  TrajBurst,
  TrajKind,
  TrajNode,
  TrajStatus,
  TrajTokens,
  TrajTotals,
  WaveBand,
  WaveBucket,
  WaveChannel,
  WaveProjection,
} from './trajectory/types.js'
