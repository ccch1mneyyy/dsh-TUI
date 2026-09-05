/**
 * Cordis-free theme catalog shared by the theme picker and channel actions.
 *
 * The catalog is an ordered projection, not a cache: static JSON palettes stay
 * owned by customTheme.ts, while runtime palettes stay owned by TuiThemeHost.
 * Ordering is the precedence contract: auto, built-ins, static files, runtime.
 */

import {
  AUTO_THEME_NAME,
  getTheme,
  THEME_NAMES,
  type Theme,
} from './theme.js'
import {
  buildTheme,
  listCustomThemes,
  type CustomThemeSpec,
  type ThemeBase,
} from './customTheme.js'
import type { TuiThemeHost, TuiThemeRegistration } from './dsh-adapter/themes.js'

/** Origin of one catalog entry. */
export type ThemeCatalogSource = 'auto' | 'builtin' | 'static' | 'runtime'

/** One selectable theme and its fully resolved palette. */
export interface ThemeCatalogEntry {
  readonly name: string
  readonly displayName: string
  readonly source: ThemeCatalogSource
  readonly theme: Theme
  readonly base?: ThemeBase
  readonly file?: string
}

function keyOf(name: string): string {
  return name.toLowerCase()
}

function entry(
  name: string,
  displayName: string,
  source: ThemeCatalogSource,
  theme: Theme,
  base?: ThemeBase,
  file?: string,
): ThemeCatalogEntry {
  return Object.freeze({
    name,
    displayName,
    source,
    theme,
    ...(base === undefined ? {} : { base }),
    ...(file === undefined ? {} : { file }),
  })
}

function builtInEntries(): ThemeCatalogEntry[] {
  return [
    entry(AUTO_THEME_NAME, AUTO_THEME_NAME, 'auto', getTheme(AUTO_THEME_NAME)),
    ...THEME_NAMES.map(name => entry(name, name, 'builtin', getTheme(name), name)),
  ]
}

function staticEntries(
  specs: readonly CustomThemeSpec[],
  seen: Set<string>,
): ThemeCatalogEntry[] {
  const entries: ThemeCatalogEntry[] = []
  for (const spec of specs) {
    const key = keyOf(spec.name)
    if (seen.has(key)) continue
    const item = entry(spec.name, spec.displayName, 'static', buildTheme(spec), spec.base, spec.file)
    entries.push(item)
    // Keep the on-disk alias reserved too: a runtime contribution must not
    // make a static file reachable through a different name accidentally.
    seen.add(key)
    seen.add(keyOf(spec.file))
  }
  return entries
}

function runtimeEntries(
  host: TuiThemeHost | undefined,
  seen: Set<string>,
): ThemeCatalogEntry[] {
  if (host === undefined) return []
  let rawSnapshot: unknown
  try {
    rawSnapshot = host.getSnapshot()
  } catch {
    return []
  }
  // A structural host may answer with anything (null, a Set, …); normalize
  // non-arrays so catalog construction never crashes picker/completion render.
  const snapshot: readonly TuiThemeRegistration[] = Array.isArray(rawSnapshot) ? rawSnapshot : []
  const entries: ThemeCatalogEntry[] = []
  // Registration order depends on plugin load timing. Sort the projection so
  // the picker and completion stay stable across equivalent compositions.
  // Filter malformed entries first: a structural host's snapshot is untrusted,
  // and the comparator must never see a non-string name. Compare on the
  // lowercased key so ordering does not depend on the runtime ICU locale.
  const ordered = snapshot
    .filter(registration => typeof registration?.name === 'string')
    .sort((a, b) => {
      const ka = keyOf(a.name)
      const kb = keyOf(b.name)
      return ka < kb ? -1 : ka > kb ? 1 : 0
    })
  for (const registration of ordered) {
    const key = keyOf(registration.name)
    if (seen.has(key)) continue
    let palette: Theme | undefined
    try {
      palette = host.resolve(registration.name)
    } catch {
      palette = undefined
    }
    if (palette === undefined) {
      // A structural host supplied by an embedder may expose metadata before
      // its resolver is wired; still provide a safe, deterministic palette.
      if (registration.base !== 'light' && registration.base !== 'dark' && registration.base !== 'dark-ansi') continue
      palette = { ...getTheme(registration.base), ...registration.colors }
    }
    entries.push(entry(
      registration.name,
      registration.displayName || registration.name,
      'runtime',
      palette,
      registration.base,
    ))
    seen.add(key)
  }
  return entries
}

/** List entries in precedence order: auto, built-ins, static, runtime. */
export function listThemeCatalog(host?: TuiThemeHost): readonly ThemeCatalogEntry[] {
  const entries = builtInEntries()
  const seen = new Set(entries.map(item => keyOf(item.name)))
  entries.push(...staticEntries(listCustomThemes(), seen))
  entries.push(...runtimeEntries(host, seen))
  return Object.freeze(entries)
}

/** Alias suited to picker/channel call sites. */
export const listThemes = listThemeCatalog

function findStaticSpec(name: string): CustomThemeSpec | undefined {
  try {
    return listCustomThemes().find(spec => spec.name === name || spec.file === name)
  } catch {
    return undefined
  }
}

/** Resolve one catalog entry, with static JSON winning over runtime names. */
export function resolveThemeEntry(name: string, host?: TuiThemeHost): ThemeCatalogEntry | undefined {
  if (typeof name !== 'string') return undefined
  if (name === AUTO_THEME_NAME) return entry(name, name, 'auto', getTheme(AUTO_THEME_NAME))
  const builtIn = THEME_NAMES.find(candidate => candidate === name)
  if (builtIn !== undefined) return entry(builtIn, builtIn, 'builtin', getTheme(builtIn), builtIn)

  const spec = findStaticSpec(name)
  if (spec !== undefined) return entry(spec.name, spec.displayName, 'static', buildTheme(spec), spec.base, spec.file)

  if (host !== undefined) {
    let registration: TuiThemeRegistration | undefined
    try {
      registration = host.getSnapshot().find(item => item.name === name || keyOf(item.name) === keyOf(name))
    } catch {
      registration = undefined
    }
    if (registration !== undefined) {
      let palette: Theme | undefined
      try {
        palette = host.resolve(registration.name)
      } catch {
        palette = undefined
      }
      if (palette !== undefined) {
        return entry(registration.name, registration.displayName || registration.name, 'runtime', palette, registration.base)
      }
    }
  }
  return undefined
}

/** Resolve to the full palette while retaining catalog precedence. */
export function resolveThemePalette(name: string, host?: TuiThemeHost): Theme | undefined {
  return resolveThemeEntry(name, host)?.theme
}

/** Resolve helper named for callers that want a catalog entry. */
export const resolveTheme = resolveThemeEntry

/** Ordered selectable names for a picker or command completion surface. */
export function themeNames(host?: TuiThemeHost): readonly string[] {
  return listThemeCatalog(host).map(item => item.name)
}

/** Explicit alias for call sites that prefer the list prefix. */
export const listThemeNames = themeNames
