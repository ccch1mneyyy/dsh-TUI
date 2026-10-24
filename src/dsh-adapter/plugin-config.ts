/**
 * Generated `/settings` pages for plugin Config forms.
 *
 * DSH 0.2 serves the live part of every profile plugin entry's Cordis Config
 * as a settings form: `@deepseek-ai/dsh-settings` (`ctx.settings`) describes
 * one form per uniquely addressed, active profile entry that declares
 * `.volatile()` fields — keyed by the entry id, carrying the serialized form
 * schema (`Schema.toJSON()` of the volatile subset), the resolved / inherited
 * / profile-override values (secrets redacted, with a presence sidecar), a
 * write revision, `applies: 'live'`, and `autoGenerate`, the host's switch for
 * clients that build a page from the schema when the plugin registered no page
 * of its own (`settings.configure({ auto: false })`). Writes are
 * `ctx.settings.mutate(ns, pathOps, revision)`: the host refuses
 * non-volatile paths, validates the complete candidate Config, persists it
 * through the config editor into the active profile patch while keeping every
 * ordinary field, and the Loader applies it without a remount. The web client
 * reads the very same descriptors.
 *
 * This module is the terminal's generated-page client for those forms. It
 * only maps the serialized schema onto the existing settings-section model;
 * rendering, staging and the revision-fenced write stay with the `/settings`
 * screen's SettingsForm and the channel's settings host, exactly as for every
 * other section — there is no second storage and no second write path.
 *
 * What gets a page (precedence, highest first):
 * 1. a `tuiSettingsSections` section registered for the namespace (the
 *    plugin's own curated section) — the generated page is suppressed;
 * 2. a host-curated section (the web search forms) — same;
 * 3. otherwise a generated page, when the host says `autoGenerate`, the entry
 *    is a third-party package (not `@deepseek-ai/*`, not this application,
 *    not a `cordis:` builtin — the web likewise configures first-party rows
 *    only through curated pages that pick their fields), and the schema has
 *    at least one representable field.
 *
 * Schemas and values are untrusted: the envelope is walked as plain JSON
 * (never rehydrated — `new Schema(json)` would compile serialized callbacks),
 * every label/value is sanitized for the render path, and node/field/option
 * counts are capped. Any fault yields fewer rows, never a throw.
 */

import type { Context } from '@deepseek-ai/cordis'
import type {
  TuiSettingsField,
  TuiSettingsFieldOption,
  TuiSettingsFieldWrite,
  TuiSettingsGroup,
  TuiSettingsPage,
  TuiSettingsSection,
} from '../adapter/ports/channel-settings.js'
import { getLang, t, type Lang } from '../i18n.js'
import { stringWidth } from '../ink/stringWidth.js'
import { isCompositionOwned } from './plugin-declaration.js'
import { pluginManagerOf, pluginTitleIn } from './plugin-manager.js'
import { cleanRenderText, cleanStatusFieldText } from './sanitize.js'

/** Every generated page shares one settings tab. */
export const PLUGIN_CONFIG_PAGE: TuiSettingsPage = Object.freeze({
  id: 'plugins',
  title: 'Plugins',
  descriptions: Object.freeze({ zh: '插件' }),
})

/** Bounds on untrusted input. */
export const PLUGIN_CONFIG_LIMITS = Object.freeze({
  /** Generated sections per screen. */
  plugins: 32,
  /** Rows per section (overflow collapses into one read-only row). */
  fields: 64,
  /** Choices per select. */
  options: 48,
  /** Schema nodes read per form. */
  nodes: 4096,
  /** Non-live keys named in the "other fields" row. */
  otherKeys: 64,
})

const LABEL_CELLS = 40
const TITLE_CELLS = 48
const VALUE_CELLS = 40
const HINT_CELLS = 400

// ── Serialized schema ────────────────────────────────────────────────────

/** One schema node, read lazily from the serialized envelope. */
export interface SchemaNode {
  readonly type: string
  readonly meta: Readonly<Record<string, unknown>>
  readonly value: unknown
  dict(): readonly (readonly [string, SchemaNode])[]
  list(): readonly SchemaNode[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Read a `Schema.toJSON()` envelope (`{ uid, refs }`, children by uid) or a
 * plain inline node tree. Unknown shapes, dangling refs and budget overruns
 * read as `undefined`; cycles are representable (walkers bound the depth).
 */
export function readSchema(json: unknown): SchemaNode | undefined {
  let budget = PLUGIN_CONFIG_LIMITS.nodes
  const byUid = new Map<string, SchemaNode | null>()
  const byObject = new WeakMap<object, SchemaNode | null>()
  const refs = isRecord(json) && isRecord(json.refs) ? json.refs : undefined
  const wrap = (raw: unknown): SchemaNode | undefined => {
    if (!isRecord(raw) || typeof raw.type !== 'string') return undefined
    const known = byObject.get(raw)
    if (known !== undefined) return known ?? undefined
    if (budget <= 0) {
      byObject.set(raw, null)
      return undefined
    }
    budget -= 1
    const meta = isRecord(raw.meta) ? raw.meta : {}
    let dict: (readonly [string, SchemaNode])[] | undefined
    let list: SchemaNode[] | undefined
    const node: SchemaNode = {
      type: raw.type,
      meta,
      value: raw.value,
      dict() {
        if (dict === undefined) {
          dict = []
          if (isRecord(raw.dict)) {
            for (const [key, child] of Object.entries(raw.dict)) {
              const resolved = resolve(child)
              if (resolved !== undefined) dict.push([key, resolved])
            }
          }
        }
        return dict
      },
      list() {
        if (list === undefined) {
          list = []
          if (Array.isArray(raw.list)) {
            for (const child of raw.list) {
              const resolved = resolve(child)
              if (resolved !== undefined) list.push(resolved)
            }
          }
        }
        return list
      },
    }
    byObject.set(raw, node)
    return node
  }
  const resolve = (ref: unknown): SchemaNode | undefined => {
    if (refs === undefined) return wrap(ref)
    if (typeof ref !== 'number' && typeof ref !== 'string') return undefined
    const key = String(ref)
    const known = byUid.get(key)
    if (known !== undefined) return known ?? undefined
    const raw = Object.hasOwn(refs, key) ? refs[key] : undefined
    const node = wrap(raw)
    byUid.set(key, node ?? null)
    return node
  }
  return refs === undefined ? wrap(json) : resolve(isRecord(json) ? json.uid : undefined)
}

/** The fields an object-like node contributes: an object's dict, or the
 *  object members of an intersection (first declaration wins per key). */
function objectEntries(node: SchemaNode, depth = 0): readonly (readonly [string, SchemaNode])[] {
  if (depth > 8) return []
  if (node.type === 'object') return node.dict()
  if (node.type !== 'intersect') return []
  const seen = new Set<string>()
  const out: (readonly [string, SchemaNode])[] = []
  for (const member of node.list()) {
    for (const entry of objectEntries(member, depth + 1)) {
      if (seen.has(entry[0])) continue
      seen.add(entry[0])
      out.push(entry)
    }
  }
  return out
}

/** Objects, and intersections with object members (their non-object members
 *  — conditional unions — are not representable here and are left out). */
function isObjectLike(node: SchemaNode): boolean {
  return node.type === 'object' || (node.type === 'intersect' && objectEntries(node).length > 0)
}

// ── Text helpers ─────────────────────────────────────────────────────────

/** Pick a schemastery description (a string, or `.i18n()` locale map). */
export function localizedText(value: unknown, lang: Lang): string | undefined {
  if (typeof value === 'string') return value
  if (!isRecord(value)) return undefined
  const entries = Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1].trim() !== '')
  const other: Lang = lang === 'zh' ? 'en' : 'zh'
  const tests: ((key: string) => boolean)[] = [
    key => key === lang,
    key => key.toLowerCase().startsWith(`${lang}-`) || key.toLowerCase().startsWith(`${lang}_`),
    key => key === '',
    key => key === other || key.toLowerCase().startsWith(`${other}-`),
    () => true,
  ]
  for (const test of tests) {
    const hit = entries.find(([key]) => test(key))
    if (hit !== undefined) return hit[1]
  }
  return undefined
}

/** C0/C1 controls, bidi overrides and invisible separators: never rendered raw. */
const ESCAPABLE = /[\u0000-\u001f\u007f-\u009f\u200b\u200e\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/u

/** Reversible single-line encoding for multi-line / control-bearing strings. */
export function escapeText(value: string): string {
  let out = ''
  for (const ch of value) {
    if (ch === '\\') out += '\\\\'
    else if (ch === '\n') out += '\\n'
    else if (ch === '\r') out += '\\r'
    else if (ch === '\t') out += '\\t'
    else if (ESCAPABLE.test(ch)) out += `\\u${(ch.codePointAt(0) ?? 0).toString(16).padStart(4, '0')}`
    else out += ch
  }
  return out
}

/** Inverse of {@link escapeText}; unknown escapes stay literal. */
export function unescapeText(text: string): string {
  return text.replace(/\\(\\|n|r|t|u[0-9a-fA-F]{4})/gu, (_match, sequence: string) => {
    if (sequence === '\\') return '\\'
    if (sequence === 'n') return '\n'
    if (sequence === 'r') return '\r'
    if (sequence === 't') return '\t'
    return String.fromCharCode(Number.parseInt(sequence.slice(1), 16))
  })
}

/** A short render-safe rendition of any value (read-only rows, defaults). */
function summarize(value: unknown, cells = VALUE_CELLS): string {
  if (value === undefined) return ''
  if (typeof value === 'string') return cleanRenderText(escapeText(value), cells)
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return String(value)
  let json: string | undefined
  try {
    json = JSON.stringify(value)
  } catch {
    json = undefined
  }
  if (json !== undefined && stringWidth(json) <= cells) return cleanRenderText(json, cells)
  if (Array.isArray(value)) return t('settings-plugin-items', { count: value.length })
  if (isRecord(value)) return t('settings-plugin-keys', { count: Object.keys(value).length })
  return ''
}

function getAt(value: unknown, path: readonly string[]): unknown {
  let current = value
  for (const key of path) {
    if (!isRecord(current) || !Object.hasOwn(current, key)) return undefined
    current = current[key]
  }
  return current
}

function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function scalar(value: unknown): value is string | number | boolean | null {
  return value === null || typeof value === 'string' || typeof value === 'boolean' || finite(value) !== undefined
}

// ── Field classification ─────────────────────────────────────────────────

type Classified =
  | { kind: 'boolean' }
  | { kind: 'number'; min?: number; max?: number; step?: number }
  | { kind: 'string'; multiline: boolean; choices?: readonly ConstChoice[] }
  | { kind: 'select'; choices: readonly ConstChoice[] }
  | { kind: 'object' }
  | { kind: 'secret' }
  | { kind: 'readonly' }

interface ConstChoice {
  readonly value: string | number | boolean | null
  readonly label: string
}

function constChoice(node: SchemaNode, lang: Lang): ConstChoice | undefined {
  if (!scalar(node.value)) return undefined
  const described = localizedText(node.meta.description, lang)
  const label = cleanStatusFieldText(described ?? (node.value === null ? 'null' : String(node.value)), LABEL_CELLS)
  return { value: node.value, label: label === '' ? '""' : label }
}

function classify(node: SchemaNode, lang: Lang, value: unknown, fallback: unknown): Classified {
  if (node.meta.role === 'secret') return { kind: 'secret' }
  switch (node.type) {
    case 'boolean':
      return { kind: 'boolean' }
    case 'number': {
      const min = finite(node.meta.min)
      const max = finite(node.meta.max)
      const step = finite(node.meta.step)
      return {
        kind: 'number',
        ...(min === undefined ? {} : { min }),
        ...(max === undefined ? {} : { max }),
        ...(step === undefined || step <= 0 ? {} : { step }),
      }
    }
    case 'string': {
      const multiline = node.meta.role === 'textarea'
        || [value, fallback, node.meta.default].some(candidate => typeof candidate === 'string' && ESCAPABLE.test(candidate))
      return { kind: 'string', multiline }
    }
    case 'union': {
      const members = node.list()
      if (members.length === 0 || members.length > PLUGIN_CONFIG_LIMITS.options + 1) return { kind: 'readonly' }
      const consts = members.filter(member => member.type === 'const')
      const others = members.filter(member => member.type !== 'const')
      const choices = consts.map(member => constChoice(member, lang))
      if (choices.some(choice => choice === undefined)) return { kind: 'readonly' }
      const resolved = choices as ConstChoice[]
      if (others.length === 0 && resolved.length > 0 && resolved.length <= PLUGIN_CONFIG_LIMITS.options) {
        return { kind: 'select', choices: resolved }
      }
      // A literal list with a free-form string escape hatch: text with presets.
      if (others.length === 1 && others[0]!.type === 'string' && others[0]!.meta.role !== 'secret'
        && resolved.length <= PLUGIN_CONFIG_LIMITS.options && resolved.every(choice => typeof choice.value === 'string')) {
        const multiline = others[0]!.meta.role === 'textarea'
          || [value, fallback, node.meta.default].some(candidate => typeof candidate === 'string' && ESCAPABLE.test(candidate))
        return { kind: 'string', multiline, choices: resolved }
      }
      return { kind: 'readonly' }
    }
    case 'object':
    case 'intersect':
      return isObjectLike(node) ? { kind: 'object' } : { kind: 'readonly' }
    default:
      // array / tuple / dict / bitset / const / transform / any / is / function / never …
      return { kind: 'readonly' }
  }
}

function numberParse(spec: { min?: number; max?: number; step?: number }): (text: string) => TuiSettingsFieldWrite | undefined {
  return text => {
    const trimmed = text.trim()
    if (trimmed === '') return { kind: 'clear' }
    const value = Number(trimmed)
    if (!Number.isFinite(value)) return undefined
    if (spec.min !== undefined && value < spec.min) return undefined
    if (spec.max !== undefined && value > spec.max) return undefined
    if (spec.step !== undefined) {
      const steps = (value - (spec.min ?? 0)) / spec.step
      if (Math.abs(steps - Math.round(steps)) > 1e-9) return undefined
    }
    return { kind: 'set', value }
  }
}

// ── Section generation ───────────────────────────────────────────────────

/** What the generator knows about the Loader entry behind one form. */
export interface PluginConfigEntry {
  /** Module specifier the entry loads. */
  readonly moduleName: string
  /** Display title (already localized); the package name when absent. */
  readonly title?: string
  /** Top-level Config keys the form does not serve (not live-editable). */
  readonly otherKeys?: readonly string[]
}

export interface PluginConfigInput {
  /** `ctx.settings.describe({ redactSecrets: true })`, as returned. */
  readonly descriptors: readonly unknown[]
  /** The Loader entry behind a form namespace; undefined hides the form. */
  entry(ns: string): PluginConfigEntry | undefined
  /** Namespaces another section already renders (registered / curated). */
  readonly claimed: ReadonlySet<string>
  /** Language for schema descriptions. */
  readonly lang: Lang
  /** The profile patch the host writes (shown in read-only hints). */
  readonly documentPath?: string
  /** False when the profile refuses form writes: every row is read-only. */
  readonly writable?: boolean
}

/** The package a module specifier belongs to; undefined for host builtins. */
export function modulePackage(moduleName: string): { readonly name: string; readonly local: boolean } | undefined {
  const name = moduleName.trim()
  if (name === '' || name.startsWith('cordis:')) return undefined
  if (name.startsWith('.') || name.startsWith('/') || name.startsWith('file:') || /^[A-Za-z]:[\\/]/u.test(name)) {
    const segments = name.replace(/^file:\/*/u, '').split(/[\\/]+/u).filter(segment => segment !== '' && segment !== '.' && segment !== '..')
    // A path into an installed package is that package (a row naming
    // `…/node_modules/@deepseek-ai/x/lib/index.js` is still first-party).
    const installed = segments.lastIndexOf('node_modules')
    if (installed >= 0 && installed + 1 < segments.length) {
      const head = segments[installed + 1]!
      const scoped = head.startsWith('@') && installed + 2 < segments.length
      return { name: scoped ? `${head}/${segments[installed + 2]}` : head, local: false }
    }
    let last = segments.at(-1) ?? name
    if (/^index\.[cm]?[jt]s$/u.test(last) && segments.length > 1) last = segments.at(-2) ?? last
    return { name: last.replace(/\.[cm]?[jt]s$/u, ''), local: true }
  }
  const parts = name.split('/')
  return { name: name.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]!, local: false }
}

/** Whether a form's entry belongs to the composition rather than to a plugin someone added. */
export function isHostOwnedModule(moduleName: string): boolean {
  const pkg = modulePackage(moduleName)
  return pkg === undefined || (!pkg.local && isCompositionOwned(pkg.name))
}

/**
 * Map host form descriptors onto settings sections. Pure: the caller supplies
 * the descriptors and the entry facts, so a regression can drive it with real
 * `ctx.settings.describe()` output and fake entries.
 */
export function pluginConfigSections(input: PluginConfigInput): TuiSettingsSection[] {
  const sections: TuiSettingsSection[] = []
  const seen = new Set<string>()
  for (const descriptor of input.descriptors) {
    if (sections.length >= PLUGIN_CONFIG_LIMITS.plugins) break
    try {
      const section = sectionFor(descriptor, input, seen)
      if (section !== undefined) sections.push(section)
    } catch {
      // A malformed form costs its own page, never the screen.
    }
  }
  return sections
}

function sectionFor(descriptor: unknown, input: PluginConfigInput, seen: Set<string>): TuiSettingsSection | undefined {
  if (!isRecord(descriptor)) return undefined
  const ns = descriptor.ns
  // The id is written back verbatim and shown as the card subtitle: an id
  // carrying control or bidi characters gets no page rather than a rewrite.
  if (typeof ns !== 'string' || ns.trim() === '' || ns.length > 128 || ESCAPABLE.test(ns)) return undefined
  if (seen.has(ns) || input.claimed.has(ns)) return undefined
  // The host's page policy: a plugin that registered its own page opted out.
  if (descriptor.autoGenerate === false) return undefined
  const entry = input.entry(ns)
  if (entry === undefined || isHostOwnedModule(entry.moduleName)) return undefined
  const root = readSchema(descriptor.schema)
  if (root === undefined || !isObjectLike(root)) return undefined
  seen.add(ns)

  const patch = cleanRenderText(input.documentPath ?? '', HINT_CELLS) || t('settings-plugin-profile-patch')
  const readOnlyAll = input.writable === false
  const secrets = Array.isArray(descriptor.secrets) ? descriptor.secrets : []
  const secretSet = (path: readonly string[]): boolean => secrets.some(secret =>
    isRecord(secret) && Array.isArray(secret.path) && secret.path.length === path.length
    && secret.path.every((key, index) => key === path[index]) && secret.set === true)

  const fields: TuiSettingsField[] = []
  const groups: TuiSettingsGroup[] = []
  let overflow = 0
  const push = (field: TuiSettingsField): void => {
    if (fields.length >= PLUGIN_CONFIG_LIMITS.fields) {
      overflow += 1
      return
    }
    fields.push(field)
  }

  const label = (key: string, node: SchemaNode): { label: string; description?: string } => {
    const described = localizedText(node.meta.description, input.lang)
    const keyLabel = cleanStatusFieldText(key, LABEL_CELLS) || '""'
    if (described === undefined) return { label: keyLabel }
    const firstLine = cleanStatusFieldText(described.split(/\r?\n/u)[0] ?? '', HINT_CELLS)
    const full = cleanRenderText(described, HINT_CELLS)
    if (firstLine !== '' && stringWidth(firstLine) <= LABEL_CELLS && firstLine === full) return { label: firstLine }
    return { label: keyLabel, ...(full === '' ? {} : { description: full }) }
  }

  const hintOf = (parts: readonly (string | undefined)[]): string | undefined => {
    const text = parts.filter((part): part is string => part !== undefined && part !== '').join(' · ')
    return text === '' ? undefined : cleanRenderText(text, HINT_CELLS)
  }

  const addLeaf = (key: string, node: SchemaNode, path: readonly string[], group: string | undefined): void => {
    if (node.meta.hidden === true) return
    const value = getAt(descriptor.value, path)
    const inherited = getAt(descriptor.base, path)
    const classified = classify(node, input.lang, value, inherited)
    const { label: text, description } = label(key, node)
    const keyHint = text === cleanStatusFieldText(key, LABEL_CELLS) && path.length === 1 ? undefined : t('settings-plugin-key', { key: cleanRenderText(path.join('.'), LABEL_CELLS) })
    const badges = Array.isArray(node.meta.badges)
      ? node.meta.badges.flatMap(badge => isRecord(badge) && typeof badge.text === 'string' ? [`[${cleanStatusFieldText(badge.text, 16)}]`] : [])
      : []
    const defaultHint = node.meta.default === undefined || classified.kind === 'secret' || classified.kind === 'object'
      ? undefined
      : t('settings-plugin-default', { value: node.meta.default === '' ? '""' : summarize(node.meta.default, 24) })
    const base = { path: Object.freeze([...path]), label: text, ...(group === undefined ? {} : { group }) }
    const readOnly = (summary: (current: unknown) => string, note: string): void => {
      push({
        ...base,
        kind: 'text',
        readOnly: true,
        format: summary,
        hint: hintOf([...badges, description, defaultHint, note, keyHint]),
      })
    }
    // Deeper objects, arrays, dicts and every other kind the single-line form
    // cannot edit: shown with their current value, edited in the patch.
    if (classified.kind === 'object' || classified.kind === 'readonly') {
      readOnly(current => summarize(current), t('settings-plugin-readonly', { path: patch }))
      return
    }
    if (classified.kind === 'secret') {
      const set = secretSet(path)
      readOnly(() => t(set ? 'settings-secret-set' : 'settings-secret-unset'), t('settings-plugin-secret', { path: patch }))
      return
    }
    const locked = readOnlyAll || node.meta.disabled === true
    const lockNote = readOnlyAll ? t('settings-plugin-not-writable') : locked ? t('settings-plugin-readonly', { path: patch }) : undefined
    const lock = locked ? { readOnly: true } : {}
    if (classified.kind === 'boolean') {
      push({ ...base, ...lock, kind: 'boolean', hint: hintOf([...badges, description, defaultHint, lockNote, keyHint]) })
      return
    }
    if (classified.kind === 'number') {
      const range = [
        classified.min === undefined ? undefined : `≥ ${classified.min}`,
        classified.max === undefined ? undefined : `≤ ${classified.max}`,
        classified.step === undefined ? undefined : t('settings-plugin-step', { step: classified.step }),
      ].filter((part): part is string => part !== undefined).join(' ')
      push({
        ...base,
        ...lock,
        kind: 'number',
        parse: numberParse(classified),
        hint: hintOf([...badges, description, range, defaultHint, lockNote, keyHint]),
      })
      return
    }
    if (classified.kind === 'select') {
      const choices = classified.choices
      const token = (index: number): string => `option:${index}`
      const options: TuiSettingsFieldOption[] = choices.map((choice, index) => ({ value: token(index), label: choice.label }))
      push({
        ...base,
        ...lock,
        kind: 'select',
        options,
        format(current: unknown): string {
          if (current === undefined) return ''
          const index = choices.findIndex(choice => choice.value === current)
          return index >= 0 ? token(index) : summarize(current)
        },
        parse(text: string): TuiSettingsFieldWrite | undefined {
          const match = /^option:(\d+)$/u.exec(text)
          const choice = match === null ? undefined : choices[Number(match[1])]
          return choice === undefined ? undefined : { kind: 'set', value: choice.value }
        },
        hint: hintOf([...badges, description, defaultHint, lockNote, keyHint]),
      })
      return
    }
    // Strings: verbatim, or a reversible escaped line when the value can hold
    // line breaks / control characters the single-line editor cannot show.
    const multiline = classified.multiline
    const encode = (current: string): string => multiline ? escapeText(current) : current
    const options = classified.choices?.map(choice => ({ value: encode(String(choice.value)), label: choice.label }))
    push({
      ...base,
      ...lock,
      kind: 'text',
      ...(options === undefined || options.length === 0 ? {} : { options }),
      format(current: unknown): string {
        if (typeof current === 'string') return encode(current)
        return current === undefined ? '' : summarize(current)
      },
      parse(text: string): TuiSettingsFieldWrite | undefined {
        if (text === '') return { kind: 'clear' }
        return { kind: 'set', value: multiline ? unescapeText(text) : text }
      },
      hint: hintOf([...badges, description, defaultHint, multiline ? t('settings-plugin-multiline') : undefined, lockNote, keyHint]),
    })
  }

  const visit = (node: SchemaNode, prefix: readonly string[], group: string | undefined, depth: number): void => {
    for (const [key, child] of objectEntries(node)) {
      if (child.meta.hidden === true) continue
      const path = [...prefix, key]
      if (depth === 0 && classify(child, input.lang, undefined, undefined).kind === 'object') {
        // One level of nesting becomes an inline group of dotted paths.
        const id = `g${groups.length}`
        const before = fields.length
        const { label: title } = label(key, child)
        groups.push({ id, title, mode: 'inline' })
        visit(child, path, id, depth + 1)
        if (fields.length === before) groups.pop()
        continue
      }
      addLeaf(key, child, path, group)
    }
  }
  visit(root, [], undefined, 0)

  if (overflow > 0) {
    fields.push({
      path: Object.freeze(['\u0000more']),
      label: t('settings-plugin-more-fields', { count: overflow }),
      kind: 'text',
      readOnly: true,
      format: () => '',
      hint: t('settings-plugin-more-hint', { path: patch }),
    })
  }
  const otherKeys = (entry.otherKeys ?? []).slice(0, PLUGIN_CONFIG_LIMITS.otherKeys)
  if (otherKeys.length > 0) {
    const named = otherKeys.slice(0, 8).map(key => cleanStatusFieldText(key, 32)).filter(key => key !== '')
    fields.push({
      path: Object.freeze(['\u0000other']),
      label: t('settings-plugin-other-fields'),
      kind: 'text',
      readOnly: true,
      format: () => t('settings-plugin-other-count', { count: otherKeys.length }),
      hint: hintOf([`${named.join(', ')}${otherKeys.length > named.length ? ', …' : ''}`, t('settings-plugin-other-hint', { path: patch })]),
    })
  }
  if (fields.every(field => field.path[0]?.startsWith('\u0000') === true)) return undefined

  const pkg = modulePackage(entry.moduleName)
  const title = cleanStatusFieldText(entry.title ?? pkg?.name ?? ns, TITLE_CELLS) || cleanStatusFieldText(ns, TITLE_CELLS)
  return {
    ns,
    title,
    page: PLUGIN_CONFIG_PAGE,
    ...(groups.length === 0 ? {} : { groups }),
    fields,
  }
}

// ── Host source ──────────────────────────────────────────────────────────

/** The settings service as this module reads it (structural). */
interface SettingsFormsLike {
  describe(options?: { redactSecrets?: boolean }): readonly unknown[]
  readonly writable?: unknown
  readonly documentPath?: unknown
}

/** A Loader entry as this module reads it (structural). */
interface LoaderEntryLike {
  readonly options?: { readonly id?: unknown; readonly name?: unknown }
  readonly fiber?: { readonly state?: unknown; readonly runtime?: { readonly Config?: unknown } | null }
}

interface Snapshot {
  readonly generation: number
  readonly at: number
  readonly settings: object
  readonly descriptors: readonly unknown[]
  readonly entries: ReadonlyMap<string, { moduleName: string; otherKeys: readonly string[] }>
  readonly documentPath?: string
  readonly writable?: boolean
}

/** How long one `describe()` snapshot serves repeated screen reads. */
const SNAPSHOT_TTL_MS = 1000

/** Top-level Config keys outside the live form, from the entry's live schema. */
function otherConfigKeys(config: unknown, served: ReadonlySet<string>): string[] {
  const keys: string[] = []
  const visit = (schema: unknown, depth: number): void => {
    if (depth > 8 || (typeof schema !== 'function' && !isRecord(schema))) return
    const node = schema as { type?: unknown; dict?: unknown; list?: unknown }
    if (node.type === 'object' && isRecord(node.dict)) {
      for (const [key, child] of Object.entries(node.dict)) {
        if (served.has(key) || keys.includes(key) || keys.length >= PLUGIN_CONFIG_LIMITS.otherKeys) continue
        const meta = (child as { meta?: unknown } | undefined)?.meta
        if (isRecord(meta) && meta.hidden === true) continue
        keys.push(key)
      }
    } else if (node.type === 'intersect' && Array.isArray(node.list)) {
      for (const member of node.list) visit(member, depth + 1)
    }
  }
  try {
    visit(config, 0)
  } catch {
    return keys
  }
  return keys
}

function liveEntries(ctx: Context): readonly LoaderEntryLike[] {
  // The config editor's addressable rows are exactly the ones settings serves
  // (unique ids owned by the profile's root Include); the Loader is the
  // fallback for compositions without it.
  const editor = ctx.get('configEditor' as never) as { entries?: () => Iterable<LoaderEntryLike> } | undefined
  const loader = ctx.get('loader' as never) as { entries?: () => Iterable<LoaderEntryLike> } | undefined
  const source = typeof editor?.entries === 'function' ? editor : typeof loader?.entries === 'function' ? loader : undefined
  if (source === undefined) return []
  try {
    return [...source.entries!()]
  } catch {
    return []
  }
}

/** One channel's generated plugin pages, over the host's settings forms. */
export interface PluginConfigSource {
  /** Generated sections, minus the namespaces another section claims. */
  sections(claimed: ReadonlySet<string>): readonly TuiSettingsSection[]
  dispose(): void
}

/**
 * Read the host's settings forms and Loader entries for the screen. One
 * `describe()` snapshot serves repeated reads for a moment (the screen
 * re-reads its sections on every channel update) and is dropped as soon as
 * the host reports a form change; `changed` asks the channel to re-render so
 * an open screen picks up plugins loading or forms changing elsewhere.
 * Without a settings service (light profile, non-DSH kernels, hosts before
 * Config forms) there are simply no pages.
 */
export function createPluginConfigSource(ctx: Context, changed: () => void): PluginConfigSource {
  let generation = 0
  let snapshot: Snapshot | undefined
  let built: { key: string; sections: readonly TuiSettingsSection[] } | undefined
  let disposed = false
  let scheduled = false
  /** Plugin-manager records by entry id, for localized titles. */
  const infos = new Map<string, unknown>()
  const looked = new Set<string>()
  let lookup: Promise<void> | undefined
  let infoVersion = 0

  const notify = (): void => {
    if (scheduled || disposed) return
    scheduled = true
    queueMicrotask(() => {
      scheduled = false
      if (!disposed) changed()
    })
  }
  const invalidate = (): void => {
    generation += 1
    notify()
  }
  const offs: (() => void)[] = []
  try {
    offs.push(ctx.on('settings/document-updated' as never, (() => { invalidate() }) as never))
    offs.push(ctx.on('internal/service' as never, ((name: unknown) => {
      // A manager that (re)appears may know titles an earlier lookup missed.
      if (name === 'pluginManager') looked.clear()
      if (name === 'settings' || name === 'configEditor' || name === 'pluginManager') invalidate()
    }) as never))
  } catch {
    // A context without events still serves TTL-bounded snapshots.
  }

  const read = (): Snapshot | undefined => {
    const settings = ctx.get('settings' as never) as SettingsFormsLike | undefined
    if (settings === undefined || settings === null || typeof settings.describe !== 'function') return undefined
    const now = Date.now()
    if (snapshot !== undefined && snapshot.generation === generation && snapshot.settings === settings && now - snapshot.at < SNAPSHOT_TTL_MS) {
      return snapshot
    }
    let descriptors: unknown
    try {
      descriptors = settings.describe({ redactSecrets: true })
    } catch {
      return undefined
    }
    if (!Array.isArray(descriptors)) return undefined
    const wanted = new Map<string, readonly string[]>()
    for (const descriptor of descriptors) {
      if (!isRecord(descriptor) || typeof descriptor.ns !== 'string') continue
      const root = readSchema(descriptor.schema)
      wanted.set(descriptor.ns, root === undefined ? [] : objectEntries(root).map(([key]) => key))
    }
    const candidates = new Map<string, LoaderEntryLike[]>()
    for (const entry of liveEntries(ctx)) {
      const id = entry.options?.id
      if (typeof id !== 'string' || !wanted.has(id)) continue
      if (entry.fiber === undefined || entry.fiber.runtime === null || entry.fiber.runtime === undefined || entry.fiber.state !== 2) continue
      const list = candidates.get(id) ?? []
      list.push(entry)
      candidates.set(id, list)
    }
    const entries = new Map<string, { moduleName: string; otherKeys: readonly string[] }>()
    for (const [ns, list] of candidates) {
      const names = new Set(list.map(entry => entry.options?.name))
      // Two live rows under one id with different modules: no way to say
      // which one the form edits, so no page.
      const name = names.size === 1 ? [...names][0] : undefined
      if (typeof name !== 'string') continue
      entries.set(ns, { moduleName: name, otherKeys: otherConfigKeys(list[0]?.fiber?.runtime?.Config, new Set(wanted.get(ns))) })
    }
    let documentPath: string | undefined
    let writable: boolean | undefined
    try {
      documentPath = typeof settings.documentPath === 'string' ? settings.documentPath : undefined
      writable = typeof settings.writable === 'boolean' ? settings.writable : undefined
    } catch {
      // Optional facts; a host without a config editor still serves forms.
    }
    // Capture the generation after describe(): the update events describe()
    // itself emits describe exactly this snapshot.
    snapshot = { generation, at: now, settings, descriptors, entries, documentPath, writable }
    return snapshot
  }

  const requestTitles = (namespaces: readonly string[]): void => {
    const pending = namespaces.filter(ns => !looked.has(ns))
    if (pending.length === 0 || lookup !== undefined || disposed) return
    const manager = pluginManagerOf(ctx)
    if (manager === undefined) {
      for (const ns of pending) looked.add(ns)
      return
    }
    lookup = Promise.resolve()
      .then(() => manager.listPlugins())
      .then(list => {
        for (const info of Array.isArray(list) ? list : []) {
          const record = info as { patchId?: unknown; entryId?: unknown }
          if (typeof record.patchId === 'string') infos.set(record.patchId, info)
          else if (typeof record.entryId === 'string' && !infos.has(record.entryId)) infos.set(record.entryId, info)
        }
      }, () => undefined)
      .finally(() => {
        for (const ns of pending) looked.add(ns)
        lookup = undefined
        infoVersion += 1
        notify()
      })
  }

  return {
    sections(claimed) {
      if (disposed) return []
      const snap = read()
      if (snap === undefined) return []
      const lang = getLang()
      const key = `${snap.generation}:${snap.at}:${lang}:${infoVersion}:${[...claimed].sort().join('\u0000')}`
      if (built?.key === key) return built.sections
      const sections = pluginConfigSections({
        descriptors: snap.descriptors,
        claimed,
        lang,
        ...(snap.documentPath === undefined ? {} : { documentPath: snap.documentPath }),
        ...(snap.writable === undefined ? {} : { writable: snap.writable }),
        entry(ns) {
          const entry = snap.entries.get(ns)
          if (entry === undefined) return undefined
          const info = infos.get(ns)
          const pkg = modulePackage(entry.moduleName)
          const title = info === undefined ? undefined : pluginTitleIn(info, lang, pkg?.name ?? ns)
          return { moduleName: entry.moduleName, otherKeys: entry.otherKeys, ...(title === undefined ? {} : { title }) }
        },
      })
      requestTitles(sections.map(section => section.ns))
      built = { key, sections }
      return sections
    },
    dispose() {
      if (disposed) return
      disposed = true
      for (const off of offs.splice(0)) {
        try { off() } catch { /* already gone with its context */ }
      }
    },
  }
}
