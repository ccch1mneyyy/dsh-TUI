// Re-export shim: the Cordis-backed implementation lives behind the adapter
// boundary so UI consumers never import official @deepseek-ai/* packages.
export { name, TuiSettingsSectionsRuntime } from './dsh-adapter/settings-sections.js'
export type {
  TuiSettingsFieldKind,
  TuiSettingsFieldOption,
  TuiSettingsFieldWrite,
  TuiSettingsField,
  TuiSettingsSection,
} from './dsh-adapter/settings-sections.js'
export { default } from './dsh-adapter/settings-sections.js'
