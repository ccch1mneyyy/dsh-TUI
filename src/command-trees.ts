// Re-export shim: the Cordis-backed implementation lives behind the adapter
// boundary so UI consumers never import official @deepseek-ai/* packages.
export { name, TuiCommandTreeRuntime } from './dsh-adapter/command-trees.js'
export type { TuiCommandTreeProvider } from './dsh-adapter/command-trees.js'
export { default } from './dsh-adapter/command-trees.js'
