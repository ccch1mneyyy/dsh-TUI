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
  kind: TuiSettingsFieldKind
  /** Choices for `kind: 'select'` (ignored otherwise). */
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
  /** Editable fields, in display order. */
  fields: readonly TuiSettingsField[]
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
  private readonly sections = new Map<string, TuiSettingsSection>()
  private readonly listeners = new Set<() => void>()

  constructor(ctx: Context) {
    super(ctx, 'tuiSettingsSections')
  }

  register(section: TuiSettingsSection): () => void {
    const ns = section.ns.trim()
    if (!/^[a-z][a-z0-9_-]*$/u.test(ns)) throw new TypeError(`invalid TUI settings-section namespace: ${section.ns}`)
    if (this.sections.has(ns)) throw new Error(`TUI settings section "${ns}" is already registered`)
    const normalized = { ...section, ns }
    this.sections.set(ns, normalized)
    this.emit()
    return () => {
      if (this.sections.get(ns) === normalized) {
        this.sections.delete(ns)
        this.emit()
      }
    }
  }

  /** Registered sections in registration order. */
  list(): readonly TuiSettingsSection[] {
    return [...this.sections.values()]
  }

  /** The section registered for a namespace, if any. */
  section(ns: string): TuiSettingsSection | undefined {
    return this.sections.get(ns.trim())
  }

  /**
   * Subscribe to register/unregister events so an open settings screen can
   * re-read the section list (a plugin (un)loading mid-session changes it).
   */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private emit(): void {
    for (const listener of this.listeners) listener()
  }
}

export default TuiSettingsSectionsRuntime
