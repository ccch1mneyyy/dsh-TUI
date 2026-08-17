// Re-export shim: the Cordis-backed implementation lives behind the adapter
// boundary so UI consumers never import official @deepseek-ai/* packages.
export * from './dsh-adapter/status-items.js'
export { default } from './dsh-adapter/status-items.js'
