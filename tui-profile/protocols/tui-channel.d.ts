import type { ApiReference, ProtocolDefinition } from '@dsh-std/core'

export type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue }

export const TUI_CHANNEL: Readonly<ApiReference & {
  apiVersion: 'tui.dsh/v1alpha1'
  kind: 'Channel'
}>
export const TUI_CHANNEL_WIRE_REVISION: 6
export const TUI_CHANNEL_FEATURES: readonly string[]

export interface TuiChannelRequirementSpec {
  readonly wireRevision: number
  readonly features: readonly string[]
}
export interface TuiChannelSupportSpec extends TuiChannelRequirementSpec {}

export interface TuiChannelSnapshot {
  readonly wireRevision: number
  readonly channelId: string
  readonly version: number
  readonly state: Readonly<Record<string, JsonValue>>
}

export interface TuiChannelWorkspaceFlowChoice {
  readonly id: string
  readonly label: string
  readonly description?: string
  readonly badge?: string
  readonly action: string
  readonly input?: {
    readonly action: string
    readonly initialValue?: string
    readonly placeholder?: string
  }
}

export type TuiChannelWorkspaceFlowResult =
  | { readonly kind: 'target'; readonly target: import('./tui-contributions.js').WorkspaceTarget }
  | { readonly kind: 'choices'; readonly title: string; readonly choices: readonly TuiChannelWorkspaceFlowChoice[] }

export type TuiChannelInput =
  | { readonly operation: 'open'; readonly value: { readonly workspace?: string; readonly sessionId?: string; readonly options?: JsonValue } }
  | { readonly operation: 'subscribe'; readonly value: { readonly channelId: string; readonly afterVersion: number } }
  | { readonly operation: 'invoke'; readonly value: { readonly channelId: string; readonly method: string; readonly arguments: readonly JsonValue[] } }
  | { readonly operation: 'close'; readonly value: { readonly channelId: string } }

export interface TuiChannelInvokeOutput {
  readonly value: JsonValue
  readonly valueDefined?: boolean
  readonly snapshot?: TuiChannelSnapshot
}

export const tuiChannelDefinition: ProtocolDefinition
export function validateTuiChannelRequirement(value: unknown): TuiChannelRequirementSpec
export function validateTuiChannelSupport(value: unknown): TuiChannelSupportSpec
export function validateTuiChannelInput(operation: string, value: unknown): object
export function validateTuiChannelSnapshot(value: unknown): TuiChannelSnapshot
export function validateTuiChannelOutput(operation: string, value: unknown): object
