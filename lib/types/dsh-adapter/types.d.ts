/**
 * Type-only re-exports of the official upstream surface for UI layers.
 *
 * UI modules (screens/, components/, ink/, hooks/, utils/) must never import
 * `@deepseek-ai/*` directly — they import types from here. This keeps the
 * upstream coupling in one tree (src/dsh-adapter/) so an upstream rc bump
 * breaks exactly one module, never the whole UI.
 */
export type { LlmModelInfo } from '@deepseek-ai/dsh-llm';
export type { Agent, AgentHandle, AgentStatus, CreateAgentOptions, ModelSelectionRef } from '@deepseek-ai/dsh-agent';
export type { SessionId, SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session';
export type { CommandRuntime } from '@deepseek-ai/dsh-commands';
export type { ApprovalOutcome, ApprovalRequest } from '@deepseek-ai/dsh-user-approval';
export type { AgentSetup } from '@deepseek-ai/dsh-agent';
export type { Context } from '@deepseek-ai/cordis';
export type { InvariantInstaller } from '@deepseek-ai/dsh-invariants';
//# sourceMappingURL=types.d.ts.map