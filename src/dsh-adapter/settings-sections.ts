/**
 * Plugin settings-section extension seam for terminal front doors.
 *
 * The TUI owns the settings screen: rendering, staged editing, and the
 * revision-fenced `settings.mutate` writes. Optional plugins declare WHAT is
 * editable — a section over their settings namespace — without coupling the
 * TUI to them, mirroring the web front door's `settings.plugin.item` slot
 * (plugins ship cards; the host ships the chrome). Storage, validation and
 * layering stay with the dsh settings service; this registry is display
 * metadata only.
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type { LocalizedDescriptions } from '../commands.js'
import { activationFiber, bindCallerEffect, compositionRoot, concreteService, requirePluginCaller } from './host-access.js'
import { vetSectionSecretRefs } from './credentialRefGuard.js'

/** Control kinds the TUI settings screen knows how to render. */
export type TuiSettingsFieldKind = 'text' | 'number' | 'boolean' | 'select'

export interface TuiSettingsFieldOption {
  /** Stored value. */
  value: string
  /** Display label (English; also the fallback). */
  label: string
  /** Provider-owned translations for the label. */
  descriptions?: LocalizedDescriptions
}

/** Optional navigation group inside one settings section. */
export interface TuiSettingsGroup {
  /** Stable identifier, unique inside the section. */
  id: string
  /** Group title (English; also the fallback). */
  title: string
  /** Provider-owned translations for the title. */
  descriptions?: LocalizedDescriptions
}

/** The write one field's draft stages when the section is saved. */
export type TuiSettingsFieldWrite =
  | { kind: 'set'; value: unknown }
  | { kind: 'clear' }

export interface TuiSettingsField {
  /**
   * Key path from the section root, in the settings service's `mutate` path
   * vocabulary (object keys; dict keys name their entry directly).
   */
  path: readonly string[]
  /** Short field label (English; also the fallback). */
  label: string
  /** Provider-owned translations for the label. */
  descriptions?: LocalizedDescriptions
  /** Optional one-line help rendered under the field. */
  hint?: string
  /** Provider-owned translations for the hint. */
  hintDescriptions?: LocalizedDescriptions
  /** Optional group id; grouped fields render on that group's subpage. */
  group?: string
  kind: TuiSettingsFieldKind
  /**
   * Choices for `kind: 'select'`; any options-bearing field (text hybrids
   * included — e.g. the page-margin presets) also cycles via ←/→ in the
   * settings list while Enter keeps the kind's own action (select cycles,
   * text opens the editor for a custom value).
   */
  options?: readonly TuiSettingsFieldOption[]
  /** Input placeholder for `kind: 'text' | 'number'`. */
  placeholder?: string
  /**
   * Credential control (mirrors the web cards' CardSecretSpec): the literal
   * never rides the settings document — the draft starts blank on every
   * open, a blank draft writes nothing, and a typed draft writes through the
   * credentials seam under `ref`. The screen shows only whether a value is
   * configured.
   */
  secret?: { ref: string }
  /**
   * Render a stored value as draft text. Defaults to the kind's conversion
   * (strings verbatim, numbers via `String`, booleans/selects by value).
   */
  format?(value: unknown): string
  /**
   * The write this draft text stages, or `undefined` when the text is not a
   * value this field accepts — an invalid draft blocks the save rather than
   * being discarded. Defaults to the kind's conversion (an empty text/number
   * draft stages a clear, letting the field re-inherit the composition
   * layer).
   */
  parse?(text: string): TuiSettingsFieldWrite | undefined
}

/** One plugin's section inside the TUI settings screen. */
export interface TuiSettingsSection {
  /**
   * Settings namespace this section edits. Should match a namespace the
   * plugin registers on the dsh settings service; the screen marks the
   * section unavailable when the composition serves no such namespace.
   */
  ns: string
  /** Section title (English; also the fallback). */
  title: string
  /** Provider-owned translations for the title. */
  descriptions?: LocalizedDescriptions
  /** Optional navigation groups, in display order. */
  groups?: readonly TuiSettingsGroup[]
  /** Editable fields, in display order. */
  fields: readonly TuiSettingsField[]
}

/** Host-only settings-section controls used by the TUI bootstrap/channel. */
export interface TuiSettingsSectionsHost {
  register(section: TuiSettingsSection): () => void
  list(): readonly TuiSettingsSection[]
  subscribe(listener: () => void): () => void
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    tuiSettingsSections: TuiSettingsSectionsRuntime
  }
}

export const name = 'dsh-tui-settings-sections'

/**
 * Small host-only registry; settings storage and validation remain owned by
 * the dsh settings service (`ctx.settings`).
 */
export class TuiSettingsSectionsRuntime extends Service {
  constructor(ctx: Context) {
    super(ctx, 'tuiSettingsSections')
    compositionRoot(ctx)
    const runtime = this
    const state: SettingsSectionState = { sections: new Map(), owners: new Map(), listeners: new Set(), host: undefined }
    state.host = Object.freeze({
      register(section: TuiSettingsSection) {
        return registerSection(runtime, section)
      },
      list() {
        return [...settingsSectionStateFor(runtime).sections.values()]
      },
      subscribe(listener: () => void) {
        return subscribeSections(runtime, listener)
      },
    })
    settingsSectionStates.set(this, state)
  }

  register(section: TuiSettingsSection): () => void {
    const caller = requirePluginCaller(this.ctx, 'tuiSettingsSections.register', this)
    const owner = activationFiber(caller)
    if (owner === undefined) throw new Error('dsh-tui: tuiSettingsSections.register requires a live activation')
    // The service path is plugin-land. A plugin's secret field names its own
    // credential ref, but nothing stopped it from naming a host-owned ref
    // (DEEPSEEK_API_KEY / DEEPSEEK_* / DSH_*) and overwriting the user's
    // shared credentials through a card that looks like plugin config.
    // Reserved refs are rejected here; host-identity registrations (the
    // owner-less host objects below) never pass through this method.
    const vetted = vetSectionSecretRefs(section)
    for (const rejection of vetted.rejected) {
      this.ctx.logger.warn(
        `dsh-tui: settings section "${section.ns}" field "${rejection.path.join('.')}" was rejected: ` +
          `credential ref "${rejection.ref}" is reserved by the host`,
      )
    }
    const dispose = registerSection(this, vetted.section, owner)
    bindCallerEffect(caller, dispose)
    return dispose
  }

  /** Registered sections in registration order. */
  list(): readonly TuiSettingsSection[] {
    const caller = requirePluginCaller(this.ctx, 'tuiSettingsSections.list', this)
    const owner = activationFiber(caller)
    return owner === undefined ? [] : [...settingsSectionStateFor(this).sections.entries()]
      .filter(([ns]) => settingsSectionStateFor(this).owners.get(ns) === owner)
      .map(([, section]) => section)
  }

  /** The section registered for a namespace, if any. */
  section(ns: string): TuiSettingsSection | undefined {
    const caller = requirePluginCaller(this.ctx, 'tuiSettingsSections.section', this)
    const owner = activationFiber(caller)
    const state = settingsSectionStateFor(this)
    const normalized = ns.trim()
    return owner !== undefined && state.owners.get(normalized) === owner ? state.sections.get(normalized) : undefined
  }

  /**
   * Subscribe to register/unregister events so an open settings screen can
   * re-read the section list (a plugin (un)loading mid-session changes it).
   */
  subscribe(listener: () => void): () => void {
    const caller = requirePluginCaller(this.ctx, 'tuiSettingsSections.subscribe', this)
    const owner = activationFiber(caller)
    if (owner === undefined) return () => {}
    const dispose = subscribeSections(this, listener, owner)
    bindCallerEffect(caller, dispose)
    return dispose
  }

}

interface SettingsSectionState {
  readonly sections: Map<string, TuiSettingsSection>
  readonly owners: Map<string, object>
  readonly listeners: Set<{ owner: object | undefined; listener: () => void }>
  host: TuiSettingsSectionsHost | undefined
}

const settingsSectionStates = new WeakMap<TuiSettingsSectionsRuntime, SettingsSectionState>()

function settingsSectionStateFor(runtime: TuiSettingsSectionsRuntime): SettingsSectionState {
  const state = settingsSectionStates.get(concreteService(runtime))
  if (state === undefined) throw new Error('tuiSettingsSections host state is unavailable')
  return state
}

function registerSection(runtime: TuiSettingsSectionsRuntime | SettingsSectionState, section: TuiSettingsSection, owner?: object): () => void {
  const state = isSectionState(runtime) ? runtime : settingsSectionStateFor(runtime)
  const ns = section.ns.trim()
  if (!/^[a-z][a-z0-9_-]*$/u.test(ns)) throw new TypeError(`invalid TUI settings-section namespace: ${section.ns}`)
  if (state.sections.has(ns)) throw new Error(`TUI settings section "${ns}" is already registered`)

  const groupIds = new Set<string>()
  const groups = section.groups === undefined
    ? undefined
    : Object.freeze(section.groups.map(group => {
      const id = group.id.trim()
      if (!/^[a-z][a-z0-9_-]*$/u.test(id)) throw new TypeError(`invalid TUI settings group id: ${group.id}`)
      if (groupIds.has(id)) throw new Error(`TUI settings group "${id}" is already declared in section "${ns}"`)
      groupIds.add(id)
      return Object.freeze({
        ...group,
        id,
        descriptions: group.descriptions === undefined ? undefined : Object.freeze({ ...group.descriptions }),
      })
    }))
  const fields = Object.freeze(section.fields.map(field => {
    const group = field.group?.trim()
    if (group !== undefined && !groupIds.has(group)) {
      throw new TypeError(`TUI settings field "${field.path.join('.')}" references unknown group "${field.group}" in section "${ns}"`)
    }
    return Object.freeze({
      ...field,
      group,
      path: Object.freeze([...field.path]),
      descriptions: field.descriptions === undefined ? undefined : Object.freeze({ ...field.descriptions }),
      hintDescriptions: field.hintDescriptions === undefined ? undefined : Object.freeze({ ...field.hintDescriptions }),
      options: field.options === undefined
        ? undefined
        : Object.freeze(field.options.map(option => Object.freeze({ ...option, descriptions: option.descriptions === undefined ? undefined : Object.freeze({ ...option.descriptions }) }))),
      secret: field.secret === undefined ? undefined : Object.freeze({ ...field.secret }),
    })
  }))
  const normalized = Object.freeze({
    ...section,
    ns,
    descriptions: section.descriptions === undefined ? undefined : Object.freeze({ ...section.descriptions }),
    groups,
    fields,
  })
  state.sections.set(ns, normalized)
  if (owner !== undefined) state.owners.set(ns, owner)
  emitSections(state, owner)
  return () => {
    if (state.sections.get(ns) !== normalized) return
    state.sections.delete(ns)
    state.owners.delete(ns)
    emitSections(state, owner)
  }
}

function subscribeSections(runtime: TuiSettingsSectionsRuntime | SettingsSectionState, listener: () => void, owner?: object): () => void {
  const state = isSectionState(runtime) ? runtime : settingsSectionStateFor(runtime)
  const entry = { owner, listener }
  state.listeners.add(entry)
  return () => {
    state.listeners.delete(entry)
  }
}

function emitSections(state: SettingsSectionState, changedOwner?: object): void {
  for (const entry of state.listeners) {
    if (entry.owner !== undefined && entry.owner !== changedOwner) continue
    entry.listener()
  }
}

export function getHostSettingsSections(runtime: TuiSettingsSectionsRuntime | undefined): TuiSettingsSectionsHost | undefined {
  if (runtime === undefined) return undefined
  try {
    return settingsSectionStateFor(runtime).host ?? undefined
  } catch {
    return undefined
  }
}

function isSectionState(value: object): value is SettingsSectionState {
  return value instanceof Map === false && 'sections' in value && 'listeners' in value
}

/**
 * In-package fallback registry: some real compositions dispose the
 * `dsh-tui-settings-sections` service row right after it loads (the whole
 * dsh-tui-* host-seam insert list is affected — see the issue-#183 skew
 * family), leaving `ctx.get('tuiSettingsSections')` permanently undefined.
 * The TUI's own section must not depend on that: plugin.ts registers into —
 * and channel.ts reads from — this local host whenever the composition
 * service is unavailable. Third-party sections still require the service
 * row; the local host only carries the TUI's own section.
 */
const localSectionsState: SettingsSectionState = {
  sections: new Map(),
  owners: new Map(),
  listeners: new Set(),
  host: undefined,
}

export function getLocalSettingsSectionsHost(): TuiSettingsSectionsHost {
  localSectionsState.host ??= Object.freeze({
    register(section: TuiSettingsSection) {
      return registerSection(localSectionsState, section)
    },
    list() {
      return [...localSectionsState.sections.values()]
    },
    subscribe(listener: () => void) {
      return subscribeSections(localSectionsState, listener)
    },
  })
  return localSectionsState.host
}

export default TuiSettingsSectionsRuntime
