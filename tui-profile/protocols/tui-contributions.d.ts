import type { ApiReference } from '@dsh-std/core'
import type { ManifestDefinitionCatalog, ManifestObjectDefinition } from '@dsh-std/manifest'

export const API_VERSION: 'tui.dsh/v1alpha1'
export const SETTINGS_SECTION: Readonly<ApiReference & { kind: 'SettingsSection' }>
export const SCENE: Readonly<ApiReference & { kind: 'Scene' }>

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

export const settingsSectionExtensionDefinition: ManifestObjectDefinition
export const sceneExtensionDefinition: ManifestObjectDefinition
export const contributionExtensionDefinitions: readonly ManifestObjectDefinition[]
export function validateSettingsSectionSpec(value: unknown): Readonly<SettingsSectionSpec>
export function validateSceneSpec(value: unknown): Readonly<SceneSpec>
export function registerTuiContributionExtensions(catalog: ManifestDefinitionCatalog): () => void
export function assertSettingsSectionHandler(value: unknown): asserts value is SettingsSectionHandler
export function assertSceneHandler(value: unknown): asserts value is SceneHandler
