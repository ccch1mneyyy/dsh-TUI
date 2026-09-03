// Types-only entry (`@deepseek-harness-tui/dsh-tui/api`): every plugin-facing
// seam type from one import, without pulling any runtime module — plugin
// authors can type-check against the TUI surface with `tsc` alone.
//
// Experimental: explicitly curated (no star re-exports — the seam shims also
// carry row `name`/`apply` values which must stay out of this module). This
// module has no runtime side effects and no `declare module` augmentation;
// runtime services and event dispatch stay on `./extensions` / `./plugin-host`.
//
// adapter-v2 public API changes:
// - `GrantPrincipal` / `GrantStore` are removed from this public type module.
//   Use `HostGrantFacade` (exported from `./plugin-host`) and
//   `ctx.tuiPluginHost.grants`; the facade derives the caller activation and
//   no longer accepts an arbitrary principal.
// - The old `ctx.tuiPluginHost.grants.corrupt` field is no longer part of
//   `HostGrantFacade`. Use `ctx.tuiPluginHost.selfCheck()`, `/doctor`, or an
//   explicit host-side diagnostic query for grant-file health.
// - `createAdmissionCatalog` is no longer exported; diagnostics use
//   `ctx.tuiPluginHost.selfCheck()` and `/doctor`.
// - `src/test-utils.ts` / `src/dsh-adapter/plugin-test-utils.ts` were
//   removed from the public surface; repository-internal headless helpers
//   live in `scripts/lib/plugin-test-utils.ts`.
// - The reversible live-probe methods (`probeReversible`, `probeCommandReversible`)
//   are no longer plugin-visible service methods. They are host-only internals
//   reachable through a guarded internal accessor; plugin authors must not
//   call or rely on them. The internal host-probe token is not part of the
//   public surface, and same-process absolute-path access to internal files is
//   a trusted-in-process boundary, not a security sandbox.
// - In the default `legacy` adapter mode the host continues to publish the
//   legacy mounted-service compatibility descriptor for Command /
//   LocalStorage / MessageObserver (without starting the new Kernel or running
//   new probes). The new live-only descriptor path is used by explicit
//   non-legacy modes.
// - P3 adapter slices are loaded by non-legacy `TuiPluginHostRuntime` and are
//   published at feature granularity: only methods proven by read-only or
//   reversible probes become live; interactive/mutating methods stay
//   degraded/staged. Host-internal Port methods are additionally guarded
//   per-method by the shadow policy.
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
