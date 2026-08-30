// Types-only entry (`@deepseek-harness-tui/dsh-tui/api`): every plugin-facing
// seam type from one import, without pulling any runtime module — plugin
// authors can type-check against the TUI surface with `tsc` alone.
//
// Experimental: explicitly curated (no star re-exports — the seam shims also
// carry row `name`/`apply` values which must stay out of this module). This
// module has no runtime side effects and no `declare module` augmentation;
// runtime services and event dispatch stay on `./extensions` / `./plugin-host`.
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
  TuiDialogAnswer,
  TuiDialogBase,
  TuiDialogConfirmRequest,
  TuiDialogInputRequest,
  TuiDialogSelectOption,
  TuiDialogSelectRequest,
  TuiDialogSnapshot,
  TuiStatusEntry,
  TuiShortcutKey,
  TuiShortcutOptions,
  TuiEntryRenderer,
  TuiEntryRenderResult,
  TuiToastDelivery,
  TuiToastOptions,
  TuiToastSink,
} from './extensions.js'
export type {
  GrantPrincipal,
  GrantStore,
  HostContract,
  HostDescriptor,
  ContractCoordinate,
  ContractRef,
  NegotiationDecision,
  PermissionEntry,
  PermissionRegistry,
  TuiPluginStorage,
  PluginStorageErrorCode,
  TuiPluginStorageRuntime,
  MessagesObserveContentBlock,
  MessagesObserveEnvelope,
  MessagesObserveListener,
  MessagesObservePayload,
  TuiMessageObserverRuntime,
  LedgerEntry,
  LedgerOperation,
  LedgerResult,
  TuiEffectLedgerRuntime,
  CommandErrorCode,
  CodedCommandError,
} from './plugin-host.js'
export type { TuiSceneProps, TuiSceneDescriptor } from './scenes.js'
export type {
  TuiSettingsFieldKind,
  TuiSettingsFieldOption,
  TuiSettingsGroup,
  TuiSettingsFieldWrite,
  TuiSettingsField,
  TuiSettingsSection,
} from './settings-sections.js'
export type { TuiCommandTreeProvider } from './command-trees.js'
export type {
  TuiWorkspaceKind,
  TuiWorkspaceTarget,
  TuiWorkspaceChoice,
  TuiWorkspaceCommandResult,
  TuiWorkspaceCommand,
  TuiCommandShell,
  TuiWorkspaceProvider,
} from './workspaces.js'
