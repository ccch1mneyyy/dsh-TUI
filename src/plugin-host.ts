// Re-export shim: the Cordis-backed implementation lives behind the adapter
// boundary so UI consumers never import official @deepseek-ai/* packages.
// Plugin authors import the plugin-host types from here
// (`@deepseek-harness-tui/dsh-tui/plugin-host`); importing the module also
// applies the `declare module '@deepseek-ai/cordis'` augmentation for the
// `tuiPluginHost` property on Context.
export * from './dsh-adapter/plugin-host.js'
export * from './dsh-adapter/grants.js'
export * from './dsh-adapter/host-descriptor.js'
export * from './dsh-adapter/plugin-storage.js'
export * from './dsh-adapter/message-observer.js'
export * from './dsh-adapter/effect-ledger.js'
export * from './dsh-adapter/command-errors.js'
export { commandOwner, fiberNameOf, stampCommandOwner, unstampCommandOwner } from './dsh-adapter/command-attribution.js'
export {
  DECISION_EVENT_PERMISSIONS,
  decisionHandlersOf,
  registerDecisionHandler,
  withDecisionRegistration,
} from './dsh-adapter/decision-guard.js'
export {
  DECISION_HANDLER_TIMEOUT_MS,
  DECISION_TOTAL_TIMEOUT_MS,
  dispatchTuiNotification,
} from './dsh-adapter/extension-events.js'
export {
  DECISION_EVENTS_COORDINATE,
  TUI_EXTENSION_API_VERSION,
  TUI_DECISION_EVENT_NAMES,
  TUI_EXTENSION_PERMISSION_NAMES,
  createAdmissionCatalog,
} from './plugin-spec/tui-extension.js'
// The spec vocabulary the descriptor/grant answers are phrased in.
export type {
  ContractCoordinate,
  ContractRef,
  HostContract,
  HostDescriptor,
  NegotiationDecision,
  PermissionEntry,
  PermissionRegistry,
} from './plugin-spec/types.js'
