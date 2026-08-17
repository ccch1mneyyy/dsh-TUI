/**
 * Unified plugin grant store (Community Consensus v0.15 §permissions): ONE
 * host-owned file `~/.dsh-tui/extension-grants.json` answers for every
 * registered permission, with defaults driven by the vendored permission
 * registry (`ecosystem-spec/registry/permissions-0.1.json`):
 *
 * ```json
 * {
 *   "grants": { "my-guard": ["session.input.intercept"] },
 *   "denies": { "noisy": ["commands.invoke"] }
 * }
 * ```
 *
 * Effective answer for `allows(plugin, permission)`:
 *
 *   1. permission not in the registry → DENY (fail closed — an unregistered
 *      permission name is a defect, not an implicit allow);
 *   2. the store is corrupt (unparseable JSON) → DENY everything, including
 *      allow-default permissions (a broken host-owned file must never open
 *      doors; wrong-shaped-but-parseable content is NOT corrupt — it just
 *      contributes no entries);
 *   3. `denies[plugin]` lists it → DENY (explicit revocation of an
 *      allow-default permission wins over everything else);
 *   4. `grants[plugin]` lists it → ALLOW (explicit grant of a deny-default
 *      permission — the v0.1..v0.8 `extension-grants.json` format carries
 *      over unchanged, zero migration);
 *   5. otherwise → the registry default (7 of 8 permissions default deny;
 *      `commands.invoke` defaults allow with a rationale).
 *
 * Registry unavailability (vendored data missing — a packaging accident) is
 * fail-closed too: every permission is unknown then, so every answer is deny.
 *
 * The file is host-owned and read-only at runtime BY DESIGN: it is read once
 * per store instance, revocation is a restart, and there is no in-session
 * mutation API to race against (D-7 re-check semantics: subscription-time
 * for intercept, call-time for storage/invoke, deliver-time for observe —
 * each checkpoint queries its own store instance).
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { PermissionRegistry } from '../plugin-spec/types.js'
import { loadSpecData } from '../plugin-spec/registry.js'
import { DATA_DIR } from '../utils/paths.js'

/** The grants file consulted by {@link readGrantStore}. */
export const EXTENSION_GRANTS_FILE = 'extension-grants.json'

export interface GrantStore {
  /** Effective answer for `plugin` + `permission` (see module doc). */
  allows(plugin: string, permission: string): boolean
  /**
   * Registry default for `permission`; `'deny'` when the permission is
   * unregistered or the registry itself is unavailable.
   */
  defaultOf(permission: string): 'allow' | 'deny'
  /** Permission names the registry knows (empty when registry unavailable). */
  knownPermissions(): readonly string[]
  /** True when the file existed but was not parseable JSON (deny-all). */
  readonly corrupt: boolean
}

interface GrantTable {
  grants: Map<string, ReadonlySet<string>>
  denies: Map<string, ReadonlySet<string>>
  corrupt: boolean
}

function parseTable(text: string): GrantTable {
  const grants = new Map<string, ReadonlySet<string>>()
  const denies = new Map<string, ReadonlySet<string>>()
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    // Unparseable JSON → corrupt → deny-all (fail closed). A MISSING file is
    // not corrupt: readGrantStore substitutes an empty document for it.
    return { grants, denies, corrupt: true }
  }
  const readSection = (key: 'grants' | 'denies', target: Map<string, ReadonlySet<string>>) => {
    const section = (parsed as Record<string, unknown> | null)?.[key]
    if (section === null || typeof section !== 'object' || Array.isArray(section)) return
    for (const [plugin, permissions] of Object.entries(section as Record<string, unknown>)) {
      if (!Array.isArray(permissions)) continue
      target.set(plugin, new Set(permissions.filter((entry): entry is string => typeof entry === 'string')))
    }
  }
  readSection('grants', grants)
  readSection('denies', denies)
  return { grants, denies, corrupt: false }
}

function resolveRegistry(registry?: PermissionRegistry): PermissionRegistry | undefined {
  return registry ?? loadSpecData()?.permissions
}

/**
 * Parse the grants file into a GrantStore.
 * @param text - Raw file contents ('' parses as an empty, non-corrupt store
 *               via the JSON error path — callers substitute it for missing
 *               files; see readGrantStore for the missing-vs-corrupt split).
 * @param registry - Permission registry (injectable for tests; defaults to
 *                   the vendored permissions-0.1.json).
 */
export function parseGrantStore(text: string, registry?: PermissionRegistry): GrantStore {
  // '' is the "missing file" placeholder, not corruption.
  const table = text === ''
    ? { grants: new Map<string, ReadonlySet<string>>(), denies: new Map<string, ReadonlySet<string>>(), corrupt: false }
    : parseTable(text)
  const permissions = resolveRegistry(registry)
  const known = new Map((permissions?.permissions ?? []).map(entry => [entry.name, entry.default] as const))
  return {
    corrupt: table.corrupt,
    allows: (plugin, permission) => {
      if (table.corrupt) return false
      const registered = known.get(permission)
      if (registered === undefined) return false
      if (table.denies.get(plugin)?.has(permission) === true) return false
      if (table.grants.get(plugin)?.has(permission) === true) return true
      return registered === 'allow'
    },
    defaultOf: permission => known.get(permission) ?? 'deny',
    knownPermissions: () => [...known.keys()],
  }
}

/**
 * Read `extension-grants.json` from the data dir. A missing file is an
 * empty (all-defaults) store — the pre-grant posture; a corrupt file is
 * deny-all.
 * @param dir - Data directory (injectable for tests).
 * @param registry - Permission registry (injectable for tests).
 */
export function readGrantStore(dir: string = DATA_DIR, registry?: PermissionRegistry): GrantStore {
  try {
    return parseGrantStore(readFileSync(join(dir, EXTENSION_GRANTS_FILE), 'utf8'), registry)
  } catch {
    return parseGrantStore('', registry)
  }
}
