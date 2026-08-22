// Re-export shim: the Cordis-backed implementation lives behind the adapter
// boundary so plugin consumers do not import host internals.
export { name, TUI_SCENE_VERSION, TuiSceneRuntime } from './dsh-adapter/scenes.js'
export type {
  TuiSceneContext,
  TuiSceneDescriptor,
  TuiSceneOverlayDescriptor,
  TuiSceneRootDescriptor,
  TuiSceneVersion,
} from './dsh-adapter/scenes.js'
// Public contracts used by a scene factory; implementations stay in the host.
export type { Component } from './tui/public.js'
export type { TuiCommands } from './tui/commands.js'
export type { ChatViewModel } from './tui/view-model.js'
export { default } from './dsh-adapter/scenes.js'
