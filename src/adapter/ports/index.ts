/**
 * TUI Host Ports: pure internal capability interfaces.
 *
 * Boundary rules for this directory:
 * - No imports from `@deepseek-ai/*`.
 * - No imports from `@dsh-std/*` or `dsh-ecosystem-spec` private protocol
 *   definitions.
 * - No protocol version / negotiation / manifest / permission semantics.
 * - No caller-supplied OwnerRef / activationId / principal on capability
 *   methods; ownership is derived by the Kernel from Cordis activation.
 * - Sensitive operations (admission, permission evaluation, ledger writes)
 *   live in Kernel/Standard internal services, not in Host Ports.
 */

export type { HostOwnerRef, HostDisposer, HostEffectClass } from './owner.js'
export type { HostDescriptorSnapshot, HostDescriptorPort } from './descriptor.js'
export type {
  HostPresentationPort,
  HostPresentationDisposer,
  HostQuestionRequest,
  HostQuestionAnswer,
  HostApprovalRequest,
  HostApprovalOutcome,
  HostDialogRequest,
  HostDialogAnswer,
} from './presentation.js'
export type {
  HostWorkspacePort,
  HostWorkspaceDisposer,
  HostWorkspaceTarget,
  HostWorkspaceCommandResult,
  HostWorkspaceCommand,
  HostCommandShell,
} from './workspace.js'
export type {
  HostScenesPort,
  HostScenesDisposer,
  HostSceneDescriptor,
} from './scenes.js'
export type {
  HostSettingsPort,
  HostSettingsDisposer,
  HostSettingsSection,
  HostSettingsField,
  HostSettingsFieldKind,
  HostSettingsFieldOption,
  HostSettingsGroup,
} from './settings.js'
export type {
  HostStatusPort,
  HostShortcutsPort,
  HostRenderersPort,
  HostThemesPort,
  HostToastPort,
  HostCommandTreesPort,
  HostStatusEntry,
  HostShortcutKey,
  HostShortcutOptions,
  HostShortcutEntry,
  HostRenderResult,
  HostEntryRenderer,
  HostThemeDescriptor,
  HostThemeRegistration,
  HostToastDelivery,
  HostCommandTreeProvider,
  HostExtensionsDisposer,
} from './extensions.js'
export type {
  HostDecisionsPort,
  HostDecisionsDisposer,
} from './decisions.js'
export type {
  HostChannelPort,
  HostChannelProjectionPort,
  HostChannelActionsPort,
  HostChannelStatePort,
  HostChannelPluginsPort,
  HostChannelTranscriptPort,
  HostChannelProjectionSnapshot,
  HostChannelStateSnapshot,
  HostChannelRowProjection,
  HostChannelToolProjection,
  HostChannelSettingsSectionProjection,
  HostChannelDisposer,
} from './channel.js'
