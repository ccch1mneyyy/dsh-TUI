import type { ApiReference, ProtocolCatalog, ProtocolDefinition } from '@dsh-std/core'
export { registerTuiContributionExtensions } from './tui-contributions.js'
export * from './tui-channel.js'

export const DECISION_EVENTS: Readonly<ApiReference & {
  apiVersion: 'tui.dsh/v1alpha1'
  kind: 'DecisionEvents'
}>

export const decisionEventsDefinition: ProtocolDefinition
export const profileDefinitions: readonly ProtocolDefinition[]

export function registerProfileProtocols(catalog: ProtocolCatalog): () => void
