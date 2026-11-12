/**
 * Where a plugin package states what it contributes (gate 1's evidence).
 *
 * A plugin declares itself by shipping a package-root `dsh-plugin.json` — the
 * pinned `@dsh-std/manifest` shape this profile's admission catalog validates
 * (`docs/plugin-admission-and-development.md`). That is the same artifact the
 * plugin-host admits third-party activations from (`./admission-loader.ts`),
 * so the list and the admission path read one declaration, not two.
 *
 * Resolution follows `./bundled-presets.ts`: bare package names resolve from
 * the composition's `baseUrl` (the profile directory a `dsh --profile` boot
 * sets), so this reads the profile's own install tree and never scans
 * node_modules. The package.json hop goes through `findPackageJSON`, which
 * still finds the package when its `exports` map hides the extra file.
 */
import { existsSync, readFileSync } from 'node:fs'
import { findPackageJSON } from 'node:module'
import { dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { BACKEND, validateBackendSpec, type BackendSpec } from '../adapter/spec/tui-contributions.js'
import { parseManifest, projectManifest } from '../adapter/standard/protocols.js'
import type { PluginManifest } from '../adapter/standard/types.js'

/** One package's declaration: the file it lives in and its exact bytes. */
export interface PluginDeclaration {
  readonly path: string
  readonly source: string
}

/**
 * The package-root `dsh-plugin.json` of `packageName`, or `undefined` when the
 * package is not resolvable from this composition or ships no declaration.
 * Tolerant by design: a broken install answers "no declaration", never a throw.
 */
export function pluginDeclarationOf(ctx: Context, packageName: string): PluginDeclaration | undefined {
  let manifestPath: string | undefined
  try {
    manifestPath = findPackageJSON(packageName, (ctx as { baseUrl?: string }).baseUrl ?? import.meta.url)
  } catch {
    return undefined
  }
  if (manifestPath === undefined) return undefined
  const file = join(dirname(manifestPath), 'dsh-plugin.json')
  if (!existsSync(file)) return undefined
  try {
    return { path: file, source: readFileSync(file, 'utf8') }
  } catch {
    return undefined
  }
}

/**
 * One `Backend` contribution a package declaration carries, as this host's own
 * `Backend` definition reads it (D-1).
 */
export interface DeclaredBackend {
  /** The declaration's own `name` (the contribution's local name, distinct from
   *  the backend id its `spec` carries). */
  readonly name: string
  /** The public declaration, already validated: `validateBackendSpec()`'s result. */
  readonly spec: BackendSpec
}

/** What one declaration contributes, and what could not be read out of it. */
export interface DeclaredBackends {
  readonly backends: readonly DeclaredBackend[]
  /** Entries that announced themselves as `Backend` contributions but are not
   *  one this host can read; each names the entry and why. Empty is the normal
   *  answer for a package that contributes no backend. */
  readonly problems: readonly string[]
}

const NO_BACKENDS: DeclaredBackends = Object.freeze({ backends: Object.freeze([]), problems: Object.freeze([]) })

/**
 * The `Backend` contributions of one `dsh-plugin.json` record.
 *
 * One reader for every consumer — the C-5 residue watch (`plugin-manage.ts`) and
 * the D-1 assembly both ask this — so the two cannot disagree about which entries
 * are backend contributions. It applies the same gates the admission path
 * applies, in the same order: the definition's own coordinate (`apiVersion` +
 * `kind`), the contribution's outer `id`, the definition's metadata rule
 * (`name`), then the family validator. An entry that fails any of them is
 * reported in `problems` rather than dropped in silence; a `null`/non-object
 * record simply contributes nothing. Below that, silence means absence only: a
 * `contributes` that is not an object, and an `x-dsh-tui` point that is not an
 * array, are malformed declarations, reported like any other gate (the canonical
 * validator refuses both shapes).
 *
 * `projectManifest` drops contributions without a string outer `id`; this
 * reader must not register one either. That contribution id may differ from
 * the backend id in `spec.id`.
 *
 * Identity is deliberately not this function's business: it reads a record the
 * caller already obtained, and says nothing about which package that record
 * belongs to (#1568 — a manifest counts only beside the package root that
 * establishes it).
 * A claimed backend also requires a valid canonical manifest projection; in
 * particular, duplicate contribution identities must not bypass admission.
 */
export function declaredBackendsOf(record: unknown): DeclaredBackends {
  if (record === null || typeof record !== 'object') return NO_BACKENDS
  const contributes = (record as Record<string, unknown>).contributes
  // Absent declares nothing — the normal answer for a package that contributes no
  // TUI row. Present but not an object (`null`, a primitive, an array) is a
  // malformed declaration, not an empty one: the canonical validator refuses those
  // shapes too (`contributes must be an object`), and reading them as "nothing
  // declared" would pass the bundle over without a word.
  if (contributes === undefined) return NO_BACKENDS
  if (contributes === null || typeof contributes !== 'object' || Array.isArray(contributes)) {
    return { backends: [], problems: ['contributes must be an object'] }
  }
  const entries = (contributes as Record<string, unknown>)['x-dsh-tui']
  // The same rule one level down, for the same reason.
  if (entries === undefined) return NO_BACKENDS
  if (!Array.isArray(entries)) {
    return { backends: [], problems: [`contributes['x-dsh-tui'] must be an array`] }
  }
  const backends: DeclaredBackend[] = []
  const problems: string[] = []
  for (const [index, entry] of entries.entries()) {
    if (entry === null || typeof entry !== 'object') continue
    const candidate = entry as Record<string, unknown>
    if (candidate.kind !== BACKEND.kind) continue
    const where = `contributes['x-dsh-tui'][${index}]`
    if (candidate.apiVersion !== BACKEND.apiVersion) {
      problems.push(`${where} is a ${BACKEND.kind} of ${String(candidate.apiVersion)}, not ${BACKEND.apiVersion}`)
      continue
    }
    // The canonical projection drops such a contribution before it reads its
    // spec (`@dsh-std/manifest`'s extension loop), so a backend it does not
    // count must not be registered here either.
    if (typeof candidate.id !== 'string') {
      problems.push(`${where}.id is missing or not a string`)
      continue
    }
    const name = candidate.name
    if (typeof name !== 'string' || !/^[a-z][a-z0-9_-]*$/u.test(name)) {
      problems.push(`${where}.name is missing or invalid`)
      continue
    }
    try {
      backends.push({ name, spec: validateBackendSpec(candidate.spec) })
    } catch (error) {
      problems.push(`${where} (${name}) has an invalid Backend content: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  if (backends.length > 0) {
    try {
      projectManifest(record as PluginManifest)
    } catch (error) {
      problems.push(`the declaration could not be projected (${error instanceof Error ? error.message : String(error)})`)
      return { backends: [], problems }
    }
  }
  return { backends, problems }
}

/**
 * {@link declaredBackendsOf} over a declaration's raw bytes. A declaration that
 * does not parse is a problem, not an empty answer: the file is there and says
 * something this host cannot read.
 */
export function declaredBackendsIn(source: string): DeclaredBackends {
  let parsed: unknown
  try {
    parsed = JSON.parse(source)
  } catch (error) {
    return { backends: [], problems: [`the declaration is not valid JSON (${error instanceof Error ? error.message : String(error)})`] }
  }
  return declaredBackendsOf(parsed)
}

/**
 * The permissions one package declares, and the component id they belong to.
 *
 * Grants are keyed by the declaration's `id`, never by the bundle/package name:
 * the two are different identities, and a rule written under the package name
 * would never authorize anything. Consumers share this one reader — the
 * install confirmation, the lifecycle flows and the residual-footprint check —
 * so no surface can disagree about which permissions a package declares.
 */
export interface DeclaredGrants {
  readonly id: string
  readonly permissions: readonly { readonly name: string; readonly scope: string }[]
}

/** The projection's answer for one already-validated manifest. */
function declaredGrantsFrom(manifest: PluginManifest): DeclaredGrants {
  return {
    id: manifest.id,
    permissions: manifest.permissions.map(permission => ({ name: permission.name, scope: permission.scope })),
  }
}

/**
 * The grants one `dsh-plugin.json` record declares, or `undefined` when the
 * record is not a declaration this profile accepts. Parsing and projection are
 * the same pair the admission path and `/plugin check` use (`parseManifest` +
 * `projectManifest`), so "declared" means the same thing everywhere. A record
 * that validates but declares no permissions answers `{ id, permissions: [] }`.
 */
export function declaredGrantsOf(record: unknown): DeclaredGrants | undefined {
  if (record === null || typeof record !== 'object' || Array.isArray(record)) return undefined
  try {
    const manifest = parseManifest(JSON.stringify(record))
    projectManifest(manifest)
    return declaredGrantsFrom(manifest)
  } catch {
    return undefined
  }
}

/** {@link declaredGrantsOf} over a declaration's raw bytes. */
export function declaredGrantsIn(source: string): DeclaredGrants | undefined {
  try {
    const manifest = parseManifest(source)
    projectManifest(manifest)
    return declaredGrantsFrom(manifest)
  } catch {
    return undefined
  }
}

/** The grants of the package installed in this composition; `undefined` when unreadable. */
export function declaredGrantsAt(ctx: Context, packageName: string): DeclaredGrants | undefined {
  const declaration = pluginDeclarationOf(ctx, packageName)
  return declaration === undefined ? undefined : declaredGrantsIn(declaration.source)
}

/** This application's own package: the composition, never a plugin of it. */
export const COMPOSITION_PACKAGE = '@deepseek-harness-tui/dsh-tui'

/**
 * What a listed bundle belongs to the composition itself rather than to the
 * plugins a person installs. Gate 1 is a statement about *plugins* ("this
 * package declares no TUI contribution"), so applying it to the host's own
 * rows — or to this application — would report the composition as a missing
 * declaration. Everything else is judged by its declaration alone.
 */
export function isCompositionOwned(packageName: string): boolean {
  return packageName.startsWith('@deepseek-ai/') || packageName === COMPOSITION_PACKAGE
}

/**
 * The package-root declaration of a directory that is not installed yet: a
 * `/plugin install <path>` spec names its directory, so the pre-install notice
 * can read the same file the admission path will read after the install.
 * Tolerant like {@link pluginDeclarationOf}: a missing or unreadable file
 * answers "no declaration", never a throw. A spec that names a tarball, a git
 * URL or a registry package has no directory here — the caller reports the
 * notice as unjudged rather than guessing.
 */
export function pluginDeclarationIn(directory: string): PluginDeclaration | undefined {
  const file = join(directory, 'dsh-plugin.json')
  if (!existsSync(file)) return undefined
  try {
    return { path: file, source: readFileSync(file, 'utf8') }
  } catch {
    return undefined
  }
}

/**
 * Gate 1's pre-install statement about a package, as data (Stage C-4).
 *
 * `unjudged` is the honest answer for anything whose declaration is not on
 * this machine yet — a registry spec has no package-root file to read before
 * the install runs. The notice therefore never claims "this package supports
 * dsh-tui"; it says either what it read, or that the answer arrives with the
 * install (the standing tag in `/plugin` is what really reports it, C-3).
 */
export type PluginInstallNotice =
  /** A declaration was read and this profile accepts it. */
  | { readonly kind: 'declared' }
  /** Read, and the package ships no package-root `dsh-plugin.json`. */
  | { readonly kind: 'undeclared' }
  /**
   * Read, and this profile cannot accept it: it does not parse, does not
   * project, or fails the admission catalog's validation. The five-state
   * negotiation is deliberately not part of this answer — it is a statement
   * about a *running* host, and the standing tag in `/plugin` reports it after
   * the install.
   */
  | { readonly kind: 'invalid'; readonly error: string }
  /** Nothing on disk to read yet: the answer arrives with the install. */
  | { readonly kind: 'unjudged' }
