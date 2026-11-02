/**
 * Explain a missing Host-scope service when the row that would provide it is
 * disabled in the profile (issue #1842).
 *
 * dsh's compatibility gate can disable every row of an incompatible plugin,
 * print one `disabling profile plugin row` line on stderr, and keep booting.
 * A preset that switched the capability on then fails inside `agents.create`
 * naming only the missing service — never the plugin. The Loader still holds
 * the disabled row (or several rows sharing one specifier), but it does not
 * record *why* a row was disabled, so the diagnostic states only what it can
 * see and gives each cause its own fix.
 *
 * Failure diagnostics, not policy: this never re-evaluates compatibility and
 * never suppresses the original error — including when reading the row itself
 * fails, because `Entry.disabled` evaluates `!!js` expressions. The full text is
 * only guaranteed on the stderr boot-failure path; the in-TUI notice and `/new`
 * toast render one truncated line, which is why {@link missingHostServiceHint}
 * exists. The text stays English like the other boot-failure messages in
 * plugin.ts and is deliberately not part of the i18n UI dictionary.
 */

import { readFileSync } from 'node:fs'
import { findPackageJSON } from 'node:module'

const HOST_SCOPE_REQUIREMENT = /requires (\S+) in the Host scope/u

/** The Loader fields read here; `disabled`/`options.name` follow bundled-presets.ts. */
export interface LoaderRow {
  readonly disabled: boolean
  readonly options?: { readonly id?: unknown; readonly name?: unknown }
}

/** The slice of a Cordis context this needs; {@link describeMissingHostService} stays testable. */
export interface HostServiceLookup {
  readonly baseUrl?: string
  get(name: string): unknown
}

interface MissingHostService {
  readonly specifier: string
  readonly packageName: string
  readonly ids: readonly string[]
}

/** The package a specifier belongs to: `@scope/pkg/sub` → `@scope/pkg`, `pkg/sub` → `pkg`. */
export function packageNameOf(specifier: string): string {
  const [head, second] = specifier.split('/')
  return specifier.startsWith('@') && second !== undefined ? `${head}/${second}` : head
}

/**
 * The version installed where the profile resolves it, undefined when unreadable.
 * `findPackageJSON` walks node_modules instead of the exports map, so a package
 * that hides `./package.json` still reports its version.
 */
export function installedVersion(ctx: HostServiceLookup, packageName: string): string | undefined {
  try {
    const manifestPath = findPackageJSON(packageName, ctx.baseUrl ?? import.meta.url)
    if (manifestPath === undefined) return undefined
    const manifest: unknown = JSON.parse(readFileSync(manifestPath, 'utf8'))
    return typeof manifest === 'object' && manifest !== null && 'version' in manifest
      && typeof manifest.version === 'string' ? manifest.version : undefined
  } catch {
    return undefined
  }
}

/**
 * Resolve the disabled rows and the missing specifier, or undefined when the
 * error is not this case. Shared by the long message and the one-line hint.
 */
function analyzeMissingHostService(
  ctx: HostServiceLookup,
  message: string,
): MissingHostService | undefined {
  const specifier = HOST_SCOPE_REQUIREMENT.exec(message)?.[1]
  if (specifier === undefined) return undefined
  let rows: LoaderRow[]
  try {
    const loader = ctx.get('loader') as { entries(): Iterable<LoaderRow> } | undefined
    rows = [...(loader?.entries() ?? [])].filter(row => row.options?.name === specifier)
    if (rows.length === 0) return undefined
    // Reading `disabled` evaluates the row's `!!js` expression and walks its
    // parents; a throwing expression must not replace the failure being explained.
    if (rows.some(row => row.disabled !== true)) return undefined
  } catch {
    return undefined
  }
  // Same-name rows are a real configuration — the patch row and the official row
  // can share one specifier — so name every disabled one: pointing at the first
  // would send the user to the wrong row. The current Loader always fills in an
  // id (`ensureId`); the unnamed fallback only guards a future shape change,
  // since `options.id` is typed `unknown` here.
  // `options.id` is the id the user edits in the profile; the Loader's
  // qualified `Entry.id` can gain a subtree prefix and would not match the yml.
  const ids = [...new Set(rows.flatMap(row => typeof row.options?.id === 'string' ? [row.options.id] : []))].sort()
  return { specifier, packageName: packageNameOf(specifier), ids }
}

/**
 * Explain a missing Host-scope service when the row naming it is disabled.
 * @param ctx - the TUI plugin context (profile resolution base + Loader service).
 * @param message - the original failure message; left untouched otherwise.
 * @returns one actionable line, or undefined when the error is not this case.
 */
export function describeMissingHostService(ctx: HostServiceLookup, message: string): string | undefined {
  const found = analyzeMissingHostService(ctx, message)
  if (found === undefined) return undefined
  const { specifier, packageName: pkg, ids } = found
  const named = ids.length === 0
    ? `the Host row for "${specifier}"`
    : ids.length === 1
      ? `the Host row "${ids[0]}" ("${specifier}")`
      : `the Host rows ${ids.map(id => `"${id}"`).join(', ')} ("${specifier}")`
  const subject = `${named} ${ids.length > 1 ? 'are' : 'is'}`
  const version = installedVersion(ctx, pkg)
  // The Loader does not record why the row was disabled, so never assert a cause
  // or an installation the profile could not resolve.
  const installed = version === undefined
    ? 'Its installed version could not be read.'
    : `${pkg}@${version} is installed there.`
  return `dsh-tui: ${subject} disabled in this profile, so nothing provides that service. `
    + `${installed} `
    + `Align ${pkg} with the running dsh first: upgrade the plugin, or upgrade dsh if the installed plugin is newer. `
    + 'If dsh\'s compatibility gate disabled it, the "disabling profile plugin row" line above names the mismatch, '
    + 'and re-enabling the row alone will be rejected again. '
    + 'If the profile disabled the row itself, re-enable it only once the condition its row checks no longer fails.'
}

/**
 * One-line recovery hint for {@link describeMissingHostService}: the channel
 * renders it on its own notice row (`StartupOpenError.hint`), where the long
 * message is truncated after its first line.
 */
export function missingHostServiceHint(ctx: HostServiceLookup, message: string): string | undefined {
  const found = analyzeMissingHostService(ctx, message)
  if (found === undefined) return undefined
  return `Align ${found.packageName} with the running dsh, or re-enable the row if the profile disabled it.`
}
