/**
 * dsh-ecosystem-spec derived protocol constants.
 *
 * This is the explicit derivation layer required by the adapter boundary.
 *
 * Sources (all are committed dsh-ecosystem-spec assets, not local patches):
 * - `registry/permissions-0.1.json` is the machine-readable permission policy
 *   table; `EXPECTED_PERMISSIONS` and the intercept permission names are
 *   derived directly from it.
 * - `registry/registry-0.15.json` defines the host contract set used by the
 *   descriptor driver.
 * - The TUI decision event point names are not present as a standalone
 *   machine-readable JSON array in the committed spec revision. They are
 *   therefore authored ONCE here (the TUI spec-boundary derivation file) and
 *   validated by `verify:protocol-single-source` against the committed
 *   `adapters/dsh-tui-v0.15.md` + `rfc/0005-decision-events.md`/registry
 *   vocabulary. Product/standard code must never declare a second copy.
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

interface PermissionRow {
  readonly name: string
  readonly default: 'allow' | 'deny'
  readonly revocable: boolean
  readonly scope: string
}

/** The permission registry is policy, pinned in the vendored spec. */
export const EXPECTED_PERMISSIONS: readonly PermissionRow[] = (() => {
  const dir = locateSpecRoot()
  if (dir === undefined) {
    // The gate/loader fails closed earlier in production; this fallback keeps
    // type/build safe for environments without the submodule.
    return Object.freeze([])
  }
  try {
    const raw = JSON.parse(readFileSync(join(dir, 'registry', 'permissions-0.1.json'), 'utf8')) as {
      permissions?: unknown
    }
    const rows = Array.isArray(raw.permissions)
      ? raw.permissions.filter((row): row is PermissionRow =>
          row !== null
          && typeof row === 'object'
          && typeof (row as { name?: unknown }).name === 'string'
          && ((row as { default?: unknown }).default === 'allow' || (row as { default?: unknown }).default === 'deny')
          && typeof (row as { revocable?: unknown }).revocable === 'boolean'
          && typeof (row as { scope?: unknown }).scope === 'string')
      : []
    return Object.freeze(rows.map(row => Object.freeze({
      name: row.name,
      default: row.default,
      revocable: row.revocable,
      scope: row.scope,
    } as PermissionRow)))
  } catch {
    return Object.freeze([])
  }
})()

/**
 * TUI decision event point names.
 *
 * These are the RFC 0005 decision points run through the D-7 gate. The
 * committed spec revision does not yet export them as a machine-readable
 * array, so this is the single TUI-side derivation/validation site.
 */
export const TUI_DECISION_EVENT_NAMES: readonly string[] = Object.freeze([
  'tui/input',
  'tui/rewind-prompt',
  'tui/rewind-done',
  'tui/session-switch',
  'tui/session-switched',
  'tui/compact',
])

/**
 * TUI intercept permission names. Derived from the committed permission
 * registry rather than authored in product code.
 */
export const TUI_EXTENSION_PERMISSION_NAMES: readonly string[] = Object.freeze(
  EXPECTED_PERMISSIONS
    .filter(permission => /^session\..+\.intercept$/u.test(permission.name))
    .map(permission => permission.name),
)

/** All intercept permissions exported by dsh-ecosystem-spec. */
export const INTERCEPT_PERMISSIONS: ReadonlySet<string> = new Set(TUI_EXTENSION_PERMISSION_NAMES)

/** Decision event point names (subscribe/notification vocabulary). */
export const TUI_EVENT_SCOPE_NAMES: ReadonlySet<string> = new Set(TUI_DECISION_EVENT_NAMES)

/**
 * Single spec-layer derivation of the decision-point -> intercept permission
 * map. Product code must import from here instead of declaring a second copy.
 */
export const DECISION_EVENT_PERMISSIONS: Readonly<Record<string, string>> = Object.freeze({
  'tui/input': 'session.input.intercept',
  'tui/rewind-prompt': 'session.rewind.intercept',
  'tui/session-switch': 'session.switch.intercept',
  'tui/compact': 'session.compact.intercept',
})

/** Inverse view, also spec-layer derived. */
export const INTERCEPT_EVENT_SCOPE_BY_PERMISSION: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(
    Object.entries(DECISION_EVENT_PERMISSIONS).map(([event, permission]) => [permission, event]),
  ) as Record<string, string>,
)

/** Host-supported contract coordinates, derived from the vendored registry's
 * machine-readable entries selected by the TUI driver set. This is the single
 * source used by the upstream descriptor driver; product code must not keep a
 * second handwritten list. */
export const HOST_SUPPORTED_CONTRACTS: readonly { apiVersion: string; kind: string }[] = (() => {
  const dir = locateSpecRoot()
  if (dir === undefined) return Object.freeze([])
  try {
    const raw = JSON.parse(readFileSync(join(dir, 'registry', 'registry-0.15.json'), 'utf8')) as {
      imports?: unknown
      definitions?: unknown
    }
    const entries = [
      ...((Array.isArray(raw.imports) ? raw.imports : []) as unknown[]),
      ...((Array.isArray(raw.definitions) ? raw.definitions : []) as unknown[]),
    ] as Array<{
      name?: unknown
      coordinates?: { apiVersion?: unknown; kind?: unknown }
    }>
    const supported = new Set(['commands', 'storage.local', 'messages.observe', 'tui.decision-events'])
    const coords = entries
      .filter(entry => typeof entry.name === 'string' && supported.has(entry.name))
      .map(entry => ({
        apiVersion: entry.coordinates?.apiVersion,
        kind: entry.coordinates?.kind,
      }))
      .filter((coord): coord is { apiVersion: string; kind: string } =>
        typeof coord.apiVersion === 'string' && typeof coord.kind === 'string')
    return Object.freeze(coords.map(coord => Object.freeze({ ...coord })))
  } catch {
    return Object.freeze([])
  }
})()

function locateSpecRoot(start: string = dirname(fileURLToPath(import.meta.url))): string | undefined {
  let dir = start
  for (let index = 0; index < 8; index++) {
    if (existsSync(join(dir, 'dsh-ecosystem-spec', 'registry', 'permissions-0.1.json'))) {
      return join(dir, 'dsh-ecosystem-spec')
    }
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
  return undefined
}
