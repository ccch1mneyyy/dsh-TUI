// Re-export shim: the Cordis-backed implementation lives behind the adapter
// boundary so UI consumers never import official @deepseek-ai/* packages.
// Plugin authors import the seam types from here
// (`@deepseek-harness-tui/dsh-tui/extensions`); importing the module also
// applies the `declare module '@deepseek-ai/cordis'` augmentation for the
// decision events and the four service properties on Context.
export * from './dsh-adapter/extensions.js'
export * from './dsh-adapter/extension-events.js'
export * from './dsh-adapter/dialogs.js'
export * from './dsh-adapter/status.js'
export * from './dsh-adapter/shortcuts.js'
export * from './dsh-adapter/renderers.js'
