// Re-export shim: the Cordis-backed implementation lives behind the adapter
// boundary so UI consumers never import official @deepseek-ai/* packages.
// Plugin authors import the plugin-host types from here
// (`@deepseek-harness-tui/dsh-tui/plugin-host`); importing the module also
// applies the `declare module '@deepseek-ai/cordis'` augmentation for the
// `tuiPluginHost` property on Context.
export * from './dsh-adapter/plugin-host.js'
export * from './dsh-adapter/grants.js'
export * from './dsh-adapter/host-descriptor.js'
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
