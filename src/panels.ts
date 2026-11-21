// Re-export shim: the Cordis-backed implementation lives behind the adapter
// boundary so UI consumers never import official @deepseek-ai/* packages.
export { name, TuiPanelRuntime, TUI_PANEL_API_VERSION } from './dsh-adapter/panels.js'
export type {
  TuiPanelDescriptor,
  TuiPanelProps,
  TuiPanelCompactProps,
  TuiPanelCompactUi,
  TuiPanelMarkdownProps,
  TuiPanelCodeBlockProps,
  TuiPanelHostApi,
  TuiPanelSnapshot,
  TuiPanelCompactSnapshot,
  TuiPanelUsage,
  TuiPanelKeyEvent,
  TuiPanelUi,
  TuiPanelEvent,
  TuiPanelSummary,
  TuiJsonValue,
  TuiSurfaceHostApi,
  TuiSurfaceOpenFileOptions,
} from './dsh-adapter/panels.js'
export { default } from './dsh-adapter/panels.js'
