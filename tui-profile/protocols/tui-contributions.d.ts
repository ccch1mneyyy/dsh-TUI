import type { ApiReference } from '@dsh-std/core'
import type { ManifestDefinitionCatalog, ManifestObjectDefinition } from '@dsh-std/manifest'

export const API_VERSION: 'tui.dsh/v1alpha1'
export const SETTINGS_SECTION: Readonly<ApiReference & { kind: 'SettingsSection' }>
export const SCENE: Readonly<ApiReference & { kind: 'Scene' }>
export const BACKEND: Readonly<ApiReference & { kind: 'Backend' }>
export const BACKEND_RESERVED_IDS: readonly string[]
export const BACKEND_CONFIRMATION_POLICIES: readonly ('confirm' | 'trusted-source')[]

export type LocalizedText = Readonly<Record<string, string>>
export type SettingsFieldKind = 'text' | 'number' | 'boolean' | 'select'
export interface SettingsFieldOption { readonly value: string; readonly label: string; readonly titles?: LocalizedText }
export interface SettingsFieldSpec {
  readonly path: readonly string[]
  readonly label: string
  readonly titles?: LocalizedText
  readonly hint?: string
  readonly hintTitles?: LocalizedText
  readonly kind: SettingsFieldKind
  readonly options?: readonly SettingsFieldOption[]
  readonly placeholder?: string
  readonly secretRef?: string
}
export interface SettingsSectionSpec {
  readonly namespace: string
  readonly title: string
  readonly titles?: LocalizedText
  readonly fields: readonly SettingsFieldSpec[]
}
export interface SettingsSectionHandler {}

export interface SceneSpec { readonly title?: string; readonly titles?: LocalizedText }
export interface SceneHandler<Props = unknown, Result = unknown> {
  readonly component: (props: Props) => Result
}

/**
 * The install recipe the host's wizard would run: `executor` names one of the
 * host's executors, `specifier`/`version` are what it would add. An executor this
 * host does not implement means "no install surface", never a refused
 * declaration. Absent = nothing to install (the user's own binary is the
 * dependency).
 */
export interface BackendInstallRecipe {
  readonly executor: string
  readonly specifier: string
  readonly version: string
}

/**
 * One backend's public declaration.
 *
 * Plain `string`, literal label text and plain arrays only, on purpose (roadmap
 * §6 item 10): this value arrives from JSON/YAML, across versions, where a
 * compile-time brand protects nothing. Discriminated unions and brands stay
 * inside the host package.
 */
export interface BackendSpec {
  readonly id: string
  /** Literal only — a host i18n key is refused (D2). */
  readonly label: { readonly text: string }
  readonly shortLabel: string
  readonly product?: string
  readonly capabilities: readonly string[]
  readonly grants: readonly string[]
  readonly install?: BackendInstallRecipe
  /** Module export closing this backend's process-wide resource pool. See the
   *  definition body: session-scoped resources belong to `session.dispose()`. */
  readonly unloadExport?: string
  /** The confirmation this contribution requests; absent means the default
   *  `confirm`. `trusted-source` asks for the host's own source judgment and is
   *  honored only when that judgment holds — it never exempts by itself. */
  readonly confirmation?: { readonly policy: 'confirm' | 'trusted-source' }
}

/** The handler a contribution binds at registration (the runtime `AgentBackend`). */
export interface BackendHandler {
  readonly id: string
  readonly descriptor?: object
  detect(...args: unknown[]): Promise<unknown>
  open(...args: unknown[]): Promise<unknown>
  readonly catalog?: object
  readonly launch?: object
}

export const settingsSectionExtensionDefinition: ManifestObjectDefinition
export const sceneExtensionDefinition: ManifestObjectDefinition
export const backendExtensionDefinition: ManifestObjectDefinition
export const contributionExtensionDefinitions: readonly ManifestObjectDefinition[]
export function validateSettingsSectionSpec(value: unknown): Readonly<SettingsSectionSpec>
export function validateSceneSpec(value: unknown): Readonly<SceneSpec>
export function validateBackendSpec(value: unknown): Readonly<BackendSpec>
export function registerTuiContributionExtensions(catalog: ManifestDefinitionCatalog): () => void
export function assertSettingsSectionHandler(value: unknown): asserts value is SettingsSectionHandler
export function assertSceneHandler(value: unknown): asserts value is SceneHandler
export function assertBackendHandler(value: unknown): asserts value is BackendHandler
