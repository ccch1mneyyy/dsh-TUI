/** dsh-TUI private, lifecycle-owned manifest contribution definitions. */

export const API_VERSION = 'tui.dsh/v1alpha1'

export const SETTINGS_SECTION = Object.freeze({
  apiVersion: API_VERSION,
  kind: 'SettingsSection',
})

export const SCENE = Object.freeze({
  apiVersion: API_VERSION,
  kind: 'Scene',
})

export const settingsSectionExtensionDefinition = Object.freeze({
  ...SETTINGS_SECTION,
  validateMetadata(metadata) {
    contributionName(metadata?.name, 'SettingsSection metadata.name')
  },
  validateSpec: validateSettingsSectionSpec,
})

export function validateSettingsSectionSpec(value) {
  const spec = exactRecord(value, ['namespace', 'title', 'titles', 'fields'], 'SettingsSection content')
  contributionName(spec.namespace, 'SettingsSection content.namespace')
  nonEmpty(spec.title, 'SettingsSection content.title')
  localized(spec.titles, 'SettingsSection content.titles')
  if (!Array.isArray(spec.fields)) throw new TypeError('SettingsSection content.fields must be an array')
  return Object.freeze({
    namespace: spec.namespace,
    title: spec.title,
    ...(spec.titles === undefined ? {} : { titles: freezeRecord(spec.titles) }),
    fields: Object.freeze(spec.fields.map((field, index) => validateSettingsField(field, index))),
  })
}

export const sceneExtensionDefinition = Object.freeze({
  ...SCENE,
  validateMetadata(metadata) {
    contributionName(metadata?.name, 'Scene metadata.name')
  },
  validateSpec: validateSceneSpec,
})

export function validateSceneSpec(value) {
  const spec = exactRecord(value, ['title', 'titles'], 'Scene content')
  if (spec.title !== undefined) nonEmpty(spec.title, 'Scene content.title')
  localized(spec.titles, 'Scene content.titles')
  return Object.freeze({
    ...(spec.title === undefined ? {} : { title: spec.title }),
    ...(spec.titles === undefined ? {} : { titles: freezeRecord(spec.titles) }),
  })
}

export const contributionExtensionDefinitions = Object.freeze([
  settingsSectionExtensionDefinition,
  sceneExtensionDefinition,
])

export function registerTuiContributionExtensions(catalog) {
  const disposers = contributionExtensionDefinitions.map(definition => catalog.registerExtension(definition))
  return () => { for (const dispose of disposers.reverse()) dispose() }
}

export function assertSettingsSectionHandler(value) {
  runtimeObject(value, 'SettingsSection handler')
}

export function assertSceneHandler(value) {
  const handler = runtimeObject(value, 'Scene handler')
  if (typeof handler.component !== 'function') throw new TypeError('Scene handler.component must be a function')
}

function validateSettingsField(value, index) {
  const label = `SettingsSection spec.fields[${index}]`
  const field = exactRecord(value, [
    'path', 'label', 'titles', 'hint', 'hintTitles', 'kind', 'options', 'placeholder', 'secretRef',
  ], label)
  if (!Array.isArray(field.path) || field.path.length === 0
    || field.path.some(segment => typeof segment !== 'string' || segment.length === 0)) {
    throw new TypeError(`${label}.path must be a non-empty string array`)
  }
  nonEmpty(field.label, `${label}.label`)
  localized(field.titles, `${label}.titles`)
  if (field.hint !== undefined) nonEmpty(field.hint, `${label}.hint`)
  localized(field.hintTitles, `${label}.hintTitles`)
  if (!['text', 'number', 'boolean', 'select'].includes(field.kind)) {
    throw new TypeError(`${label}.kind is invalid`)
  }
  if (field.placeholder !== undefined && typeof field.placeholder !== 'string') {
    throw new TypeError(`${label}.placeholder must be a string`)
  }
  if (field.secretRef !== undefined) nonEmpty(field.secretRef, `${label}.secretRef`)
  if (field.options !== undefined) {
    if (!Array.isArray(field.options)) throw new TypeError(`${label}.options must be an array`)
    for (const [optionIndex, valueOption] of field.options.entries()) {
      const option = exactRecord(valueOption, ['value', 'label', 'titles'], `${label}.options[${optionIndex}]`)
      nonEmpty(option.value, `${label}.options[${optionIndex}].value`)
      nonEmpty(option.label, `${label}.options[${optionIndex}].label`)
      localized(option.titles, `${label}.options[${optionIndex}].titles`)
    }
  }
  return Object.freeze(structuredClone(field))
}

function exactRecord(value, allowed, label) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`)
  }
  const unknown = Object.keys(value).filter(key => !allowed.includes(key) && !key.startsWith('x-'))
  if (unknown.length > 0) throw new TypeError(`${label} contains unknown field ${JSON.stringify(unknown[0])}`)
  return value
}

function runtimeObject(value, label) {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`)
  }
  return value
}

function contributionName(value, label) {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9_-]*$/u.test(value)) {
    throw new TypeError(`${label} is invalid`)
  }
}

function nonEmpty(value, label) {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${label} must be a non-empty string`)
}

function localized(value, label) {
  if (value === undefined) return
  const record = exactRecord(value, Object.keys(value), label)
  for (const [locale, text] of Object.entries(record)) {
    if (locale.trim() === '') throw new TypeError(`${label} contains an empty locale`)
    nonEmpty(text, `${label}.${locale}`)
  }
}

function freezeRecord(value) {
  return Object.freeze({ ...value })
}
