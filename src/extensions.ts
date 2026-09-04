// Re-export shim: the Cordis-backed implementation lives behind the adapter
// boundary so UI consumers never import official @deepseek-ai/* packages.
// Plugin authors import the seam types from here
// (`@deepseek-harness-tui/dsh-tui/extensions`); importing the module also
// applies the `declare module '@deepseek-ai/cordis'` augmentation for the
// decision events and the five service properties on Context.
export * from './dsh-adapter/extensions.js'
// Decision dispatch is a host/channel operation.  Export only the event
// vocabulary and safe normalizers; dispatching an arbitrary payload through
// this module would let a plugin trigger every other plugin's handlers.
export {
  DECISION_HANDLER_TIMEOUT_MS,
  DECISION_TOTAL_TIMEOUT_MS,
  normalizeCancelDecision,
} from './dsh-adapter/extension-events.js'
export type {
  TuiDecisionContext,
  TuiInputEvent,
  TuiInputDecision,
  TuiRewindPromptEvent,
  TuiRewindMode,
  TuiRewindPromptDecision,
  TuiRewindDoneEvent,
  TuiSessionSwitchEvent,
  TuiSessionSwitchDecision,
  TuiSessionSwitchedEvent,
  TuiCompactEvent,
  TuiCompactDecision,
} from './dsh-adapter/extension-events.js'
// Keep host accessors out of the plugin-facing export. The implementation
// modules expose them only so the TUI host can wire Chat/channel; exporting
// them here would let a plugin recover the private queue/store/dispatcher.
export {
  DIALOG_DEFAULT_TIMEOUT_MS,
  INPUT_CELLS,
  TuiDialogRuntime,
  TuiDialogStore,
} from './dsh-adapter/dialogs.js'
export type {
  TuiDialogAnswer,
  TuiDialogBase,
  TuiDialogConfirmRequest,
  TuiDialogInputRequest,
  TuiDialogSelectOption,
  TuiDialogSelectRequest,
  TuiDialogSnapshot,
} from './dsh-adapter/dialogs.js'
export { TuiStatusRuntime, TuiStatusStore } from './dsh-adapter/status.js'
export type { TuiStatusEntry, TuiStatusSegment, SegmentColor } from './dsh-adapter/status.js'
export { matchShortcut, parseShortcutCombo, TuiShortcutRuntime } from './dsh-adapter/shortcuts.js'
export type { TuiShortcutKey, TuiShortcutOptions } from './dsh-adapter/shortcuts.js'
export { TuiRendererRuntime } from './dsh-adapter/renderers.js'
export type { TuiEntryRenderer, TuiEntryRenderResult } from './dsh-adapter/renderers.js'
export { TuiToastRuntime } from './dsh-adapter/toast.js'
export type { TuiToastDelivery, TuiToastOptions, TuiToastSink } from './dsh-adapter/toast.js'
// Runtime themes expose only the registration capability. The host snapshot,
// resolver and subscription accessor stay behind the adapter boundary.
export { TuiThemeRuntime } from './dsh-adapter/themes.js'
export type {
  TuiThemeBase,
  TuiThemeDescriptor,
  TuiThemeRegistration,
} from './dsh-adapter/themes.js'
// The D-7 permission vocabulary (which grant each decision event needs) is
// part of the plugin-facing contract too.
export { DECISION_EVENT_PERMISSIONS } from './dsh-adapter/decision-guard.js'
