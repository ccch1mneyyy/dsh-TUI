// Re-export shim: the Cordis-backed implementation lives behind the adapter
// boundary so UI consumers never import official @deepseek-ai/* packages.
export { name, TuiSceneRuntime } from './dsh-adapter/scenes.js'
export type {
  TuiSceneProps,
  TuiSceneDescriptor,
  TuiSceneHostApi,
  TuiSceneUi,
  TuiJsonValue,
  TuiSurfaceHostApi,
  TuiSurfaceOpenFileOptions,
} from './dsh-adapter/scenes.js'
export { default } from './dsh-adapter/scenes.js'
