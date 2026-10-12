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

export const BACKEND = Object.freeze({
  apiVersion: API_VERSION,
  kind: 'Backend',
})

/**
 * Ids the host owns. A **contribution** may not wear one: `dsh` serializes
 * session refs without a prefix, and the bundled backends' rows are the host's own
 * vocabulary — a plugin claiming either would render as first-party. The host's
 * own seed legitimately carries them, so this is deliberately **not** a shape rule
 * (one declaration shape is valid for the seed and invalid for a bundle): the host
 * refuses a contribution whose `id` is in this set at admission, with
 * `BACKEND_ID_RESERVED`. Mirrored by the host registry (`BUILTIN_BACKEND_IDS`); the
 * two lists are compared bidirectionally by
 * `scripts/verify-backend-contribution.ts`.
 */
export const BACKEND_RESERVED_IDS = Object.freeze(['dsh', 'claude', 'codex'])

/**
 * The confirmation policies this host implements (roadmap §6 item 5 ②).
 *
 * A contribution **requests** a policy; the host decides. `confirm` (the default
 * when the field is absent) always asks the user. `trusted-source` asks for the
 * host's trusted-source path: the host applies *its own* judgment of where the
 * package came from — a curated, offline-readable list of first-party packages,
 * cross-checked against provenance when the registry offers it — and **falls back
 * to `confirm` whenever that judgment does not hold**. A declaration therefore
 * never exempts itself: wearing this value is a request, not a grant, and any
 * mismatch (not on the list, publisher disagrees, provenance disagrees) is
 * fail-closed. Exempting an entry from the interactive confirmation never exempts
 * it from the effect ledger or from being listed.
 *
 * An unknown value is refused: a contribution may never exempt itself from a
 * confirmation this host does not implement. The vocabulary only grows — a later
 * decision adds a value rather than widening the field (additive, not breaking).
 */
export const BACKEND_CONFIRMATION_POLICIES = Object.freeze(['confirm', 'trusted-source'])

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

/**
 * One backend's public declaration (`tui.dsh/v1alpha1#Backend`).
 *
 * The body is **shape + honesty**, never authority: an in-process backend runs
 * with this host's own privileges (`securityBoundary: false` in the contract
 * profile), so nothing here is enforced against a hostile plugin — what it buys
 * is that the host can state what a backend claims *before* it runs, and that a
 * claim the host cannot honor (a reserved id, a host label key, a native channel,
 * a self-granted confirmation exemption) is refused at admission rather than
 * discovered later.
 *
 * Deliberately absent: `inTree` (a host fact, not a contribution one),
 * `alwaysAvailable`, `nativeKey` (refused outright — a native channel is derived
 * from an in-tree manifest, never declared) and `backendExport` (the build-time
 * index resolves an export name from a module namespace; a contribution hands
 * over its handler object at registration instead).
 */
export const backendExtensionDefinition = Object.freeze({
  ...BACKEND,
  validateMetadata(metadata) {
    contributionName(metadata?.name, 'Backend metadata.name')
  },
  validateSpec: validateBackendSpec,
})

export function validateBackendSpec(value) {
  const spec = exactRecord(value, [
    'id', 'label', 'shortLabel', 'product', 'capabilities', 'grants', 'install', 'unloadExport', 'confirmation',
  ], 'Backend content')
  if (typeof spec.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,31}$/u.test(spec.id)) {
    throw new TypeError('Backend content.id is invalid (lowercase letters, digits and dashes, at most 32 characters)')
  }
  // Literal text only: a host i18n key here would let a contribution paint
  // itself with the host's own vocabulary (D2). The host expands its in-tree
  // `{ kind: 'key' }` labels into literals before projecting them here.
  const label = exactRecord(spec.label, ['text'], 'Backend content.label')
  nonEmpty(label.text, 'Backend content.label.text')
  nonEmpty(spec.shortLabel, 'Backend content.shortLabel')
  if (spec.product !== undefined) nonEmpty(spec.product, 'Backend content.product')
  stringArray(spec.capabilities, 'Backend content.capabilities')
  stringArray(spec.grants, 'Backend content.grants')
  if (spec.install !== undefined) {
    const install = exactRecord(spec.install, ['executor', 'specifier', 'version'], 'Backend content.install')
    for (const field of ['executor', 'specifier', 'version']) {
      nonEmpty(install[field], `Backend content.install.${field}`)
    }
  }
  if (spec.unloadExport !== undefined) nonEmpty(spec.unloadExport, 'Backend content.unloadExport')
  let confirmation
  if (spec.confirmation !== undefined) {
    const declared = exactRecord(spec.confirmation, ['policy'], 'Backend content.confirmation')
    if (!BACKEND_CONFIRMATION_POLICIES.includes(declared.policy)) {
      throw new TypeError('Backend content.confirmation.policy is not a policy this host implements')
    }
    confirmation = Object.freeze({ policy: declared.policy })
  }
  return Object.freeze({
    id: spec.id,
    label: Object.freeze({ text: label.text }),
    shortLabel: spec.shortLabel,
    ...(spec.product === undefined ? {} : { product: spec.product }),
    capabilities: Object.freeze([...spec.capabilities]),
    grants: Object.freeze([...spec.grants]),
    ...(spec.install === undefined ? {} : {
      install: Object.freeze({
        executor: spec.install.executor,
        specifier: spec.install.specifier,
        version: spec.install.version,
      }),
    }),
    ...(spec.unloadExport === undefined ? {} : { unloadExport: spec.unloadExport }),
    ...(confirmation === undefined ? {} : { confirmation }),
  })
}

export const contributionExtensionDefinitions = Object.freeze([
  settingsSectionExtensionDefinition,
  sceneExtensionDefinition,
  backendExtensionDefinition,
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

/**
 * The handler a contribution binds at registration — the runtime form of
 * `AgentBackend`, asserted at the same boundary `assertSceneHandler` guards: the
 * declaration above is validated as data, this is the object the host is about to
 * call. `catalog`, `launch` and `descriptor` are objects when present, never
 * silently ignored.
 */
export function assertBackendHandler(value) {
  const handler = runtimeObject(value, 'Backend handler')
  nonEmpty(handler.id, 'Backend handler.id')
  for (const method of ['detect', 'open']) {
    if (typeof handler[method] !== 'function') throw new TypeError(`Backend handler.${method} must be a function`)
  }
  for (const member of ['descriptor', 'catalog', 'launch']) {
    if (handler[member] !== undefined) runtimeObject(handler[member], `Backend handler.${member}`)
  }
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

/** Names a backend declares. The *vocabulary* is the host's (admission maps an
 *  unknown name to a pending item, never to a rejection); the shape is not. */
function stringArray(value, label) {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`)
  for (const entry of value) {
    if (typeof entry !== 'string' || entry.trim() === '') throw new TypeError(`${label} must contain non-empty strings`)
  }
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
