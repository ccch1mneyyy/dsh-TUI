/** Live, scoped plugin grant evaluation. */

import { readFileSync, watch as watchFile } from 'node:fs'
import { dirname, join } from 'node:path'
import type { PermissionRegistry } from '../plugin-spec/types.js'
import { normalizePermissionScope, permissionScopeCovers } from '../plugin-spec/permission-scope.js'
import { loadSpecData } from '../plugin-spec/registry.js'
import { DATA_DIR } from '../utils/paths.js'

export const EXTENSION_GRANTS_FILE = 'extension-grants.json'

export interface GrantPrincipal {
  componentId: string
  activationId?: string
}

export interface GrantStore {
  /** Evaluate one concrete operation scope. Missing/unsupported scopes deny. */
  allows(principal: GrantPrincipal | string, permission: string, scope: string): boolean
  defaultOf(permission: string): 'allow' | 'deny'
  knownPermissions(): readonly string[]
  /** Subscribe to file changes. Used to actively release grant-owned effects. */
  onChange?(listener: () => void): () => void
  readonly corrupt: boolean
}

interface GrantRule {
  permission: string
  scope?: string
  activationId?: string
  legacy: boolean
}

interface GrantTable {
  grants: Map<string, readonly GrantRule[]>
  denies: Map<string, readonly GrantRule[]>
  corrupt: boolean
}

function parseRule(value: unknown): GrantRule | undefined {
  if (typeof value === 'string') return { permission: value, legacy: true }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  if (Object.keys(record).some(key => !['name', 'scope', 'activationId'].includes(key))) return undefined
  if (typeof record.name !== 'string' || typeof record.scope !== 'string') return undefined
  if (record.activationId !== undefined && typeof record.activationId !== 'string') return undefined
  return {
    permission: record.name,
    scope: record.scope,
    ...(record.activationId === undefined ? {} : { activationId: record.activationId }),
    legacy: false,
  }
}

function parseTable(text: string): GrantTable {
  const grants = new Map<string, readonly GrantRule[]>()
  const denies = new Map<string, readonly GrantRule[]>()
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { grants, denies, corrupt: true }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { grants, denies, corrupt: true }
  }
  const root = parsed as Record<string, unknown>
  if (Object.keys(root).some(key => key !== 'grants' && key !== 'denies')) {
    return { grants, denies, corrupt: true }
  }
  const readSection = (key: 'grants' | 'denies', target: Map<string, readonly GrantRule[]>): boolean => {
    const section = root[key]
    if (section === undefined) return true
    if (section === null || typeof section !== 'object' || Array.isArray(section)) return false
    for (const [componentId, values] of Object.entries(section as Record<string, unknown>)) {
      if (componentId === '' || !Array.isArray(values)) return false
      const rules = values.map(parseRule)
      if (rules.some(rule => rule === undefined)) return false
      target.set(componentId, rules as GrantRule[])
    }
    return true
  }
  if (!readSection('grants', grants) || !readSection('denies', denies)) {
    return { grants: new Map(), denies: new Map(), corrupt: true }
  }
  return { grants, denies, corrupt: false }
}

function resolveRegistry(registry?: PermissionRegistry): PermissionRegistry | undefined {
  return registry ?? loadSpecData()?.permissions
}

function principalParts(principal: GrantPrincipal | string): GrantPrincipal {
  return typeof principal === 'string' ? { componentId: principal } : principal
}

function ruleMatches(
  rule: GrantRule,
  principal: GrantPrincipal,
  permission: string,
  scope: string,
  mode: 'grant' | 'deny' = 'grant',
): boolean {
  if (rule.permission !== permission) return false
  if (rule.activationId !== undefined && rule.activationId !== principal.activationId) return false
  const actual = normalizePermissionScope(permission, scope, principal.componentId)
  if (actual === undefined) return false
  // A legacy string row carries no resource/session/command scope. Treating a
  // legacy GRANT as a wildcard would silently enlarge a grant during the v0.15
  // migration, so it never authorizes. A legacy DENY is safe to apply
  // conservatively to every enforceable scope: it can reduce availability but
  // cannot widen access or make revocation ineffective.
  if (rule.legacy) return mode === 'deny'
  const declared = normalizePermissionScope(permission, rule.scope ?? '', principal.componentId)
  return declared !== undefined && permissionScopeCovers(permission, declared, actual)
}

/** An unbound/diagnostic principal cannot safely inherit a default or an
 * unscoped rule when an activation-specific rule could apply. Returning deny
 * here is conservative: callers must admit a real activation before using a
 * grant whose lifetime is activation-scoped. */
function hasUnknownActivationRule(
  rules: readonly GrantRule[],
  principal: GrantPrincipal,
  permission: string,
  scope: string,
): boolean {
  if (principal.activationId !== undefined) return false
  const actual = normalizePermissionScope(permission, scope, principal.componentId)
  if (actual === undefined) return false
  return rules.some(rule => {
    if (rule.legacy || rule.permission !== permission || rule.activationId === undefined) return false
    const declared = normalizePermissionScope(permission, rule.scope ?? '', principal.componentId)
    return declared !== undefined && permissionScopeCovers(permission, declared, actual)
  })
}

function storeFrom(
  table: () => GrantTable,
  registry: PermissionRegistry | undefined,
  onChange: GrantStore['onChange'],
): GrantStore {
  const known = new Map((registry?.permissions ?? []).map(entry => [entry.name, entry.default] as const))
  // The store is a capability, not a mutable configuration object.  Keep the
  // live table in the closure and freeze the facade so a traceable Cordis
  // proxy (or an accidentally retained reference) cannot replace `allows`
  // and turn an authorization check into an unconditional allow.
  return Object.freeze({
    get corrupt() {
      return table().corrupt
    },
    allows(principalValue, permission, scope) {
      const current = table()
      if (current.corrupt || known.get(permission) === undefined) return false
      const principal = principalParts(principalValue)
      if (normalizePermissionScope(permission, scope, principal.componentId) === undefined) return false
      const denies = current.denies.get(principal.componentId) ?? []
      const grants = current.grants.get(principal.componentId) ?? []
      if (hasUnknownActivationRule(denies, principal, permission, scope)
        || hasUnknownActivationRule(grants, principal, permission, scope)) return false
      if (denies.some(rule => ruleMatches(rule, principal, permission, scope, 'deny'))) return false
      if (grants.some(rule => ruleMatches(rule, principal, permission, scope, 'grant'))) return true
      return known.get(permission) === 'allow'
    },
    defaultOf: permission => known.get(permission) ?? 'deny',
    knownPermissions: () => [...known.keys()],
    onChange,
  })
}

/** Parse a fixed snapshot, primarily for deterministic tests. */
export function parseGrantStore(text: string, registry?: PermissionRegistry): GrantStore {
  const parsed = text === ''
    ? { grants: new Map(), denies: new Map(), corrupt: false } as GrantTable
    : parseTable(text)
  return storeFrom(() => parsed, resolveRegistry(registry), () => () => undefined)
}

/**
 * Read grants on every decision. File changes therefore affect the next
 * operation without a restart. onChange uses a non-persistent watcher so
 * grant-owned subscriptions can be released even when no event is flowing.
 */
export function readGrantStore(dir: string = DATA_DIR, registry?: PermissionRegistry): GrantStore {
  const file = join(dir, EXTENSION_GRANTS_FILE)
  const readCurrent = (): { table: GrantTable; signature: string } => {
    let text: string
    let missing = false
    try {
      text = readFileSync(file, 'utf8')
    } catch (error) {
      missing = (error as NodeJS.ErrnoException).code === 'ENOENT'
      text = missing ? '' : '{unreadable'
    }
    return {
      // An existing zero-byte file is corruption, not the same state as an
      // absent grants file. Only ENOENT receives the registry defaults.
      table: missing
        ? { grants: new Map(), denies: new Map(), corrupt: false }
        : parseTable(text),
      // The existence bit is part of the signature: a missing file and an
      // existing empty file both read as '' but are different states.
      signature: `${missing ? 'M' : 'E'}:${text}`,
    }
  }
  const listeners = new Set<() => void>()
  let watching = false
  let watchTimer: ReturnType<typeof setInterval> | undefined
  let watcher: ReturnType<typeof watchFile> | undefined
  let debounceTimer: ReturnType<typeof setTimeout> | undefined
  let signature = readCurrent().signature
  const changed = (): void => {
    const next = readCurrent().signature
    if (next === signature) return
    signature = next
    for (const listener of [...listeners]) {
      try {
        listener()
      } catch {
        // A lifecycle observer is advisory; one faulty cleanup callback must
        // not prevent the remaining subscriptions from seeing revocation.
      }
    }
  }
  // Debounced file-change notification: fs.watch can fire several events per
  // write (rename+change on atomic replace), so coalesce them into one read.
  const scheduleCheck = (): void => {
    if (debounceTimer !== undefined) return
    debounceTimer = setTimeout(() => {
      debounceTimer = undefined
      changed()
    }, 50)
  }
  const startWatching = (): void => {
    // Prefer fs.watch on the PARENT DIRECTORY, not the file itself: the
    // common atomic-replace write (temp file + rename) swaps the inode the
    // file watcher holds, after which the old watcher goes silent. A
    // directory watcher sees the rename/create/delete and the debounce
    // re-reads the (possibly new) file. A poll fallback covers filesystems
    // and edge cases where the watcher cannot be established. Both stop
    // when the last listener unsubscribes; the fallback deliberately polls
    // at a low frequency — the synchronous per-operation read remains the
    // authorization source of truth, so this loop only needs to release
    // grant-owned subscriptions promptly after a revocation, not keep them
    // perfectly current.
    let watchingFailed = false
    try {
      watcher = watchFile(dirname(file), { persistent: false }, () => scheduleCheck())
      watcher.on('error', () => {
        watchingFailed = true
        watcher?.close()
        watcher = undefined
        if (listeners.size > 0 && watchTimer === undefined) {
          watchTimer = setInterval(changed, 2000)
          watchTimer.unref?.()
        }
      })
      // fs.watch on some platforms silently misses events (or refuses to
      // watch a not-yet-existing directory); a first error already re-arms
      // the fallback above, and the watcher stays authoritative while
      // healthy.
    } catch {
      watchingFailed = true
      watcher = undefined
    }
    if (watchingFailed && watchTimer === undefined) {
      watchTimer = setInterval(changed, 2000)
      watchTimer.unref?.()
    }
  }
  const onChange = (listener: () => void): (() => void) => {
    listeners.add(listener)
    if (!watching) {
      watching = true
      startWatching()
    }
    return () => {
      listeners.delete(listener)
      if (watching && listeners.size === 0) {
        watching = false
        if (debounceTimer !== undefined) {
          clearTimeout(debounceTimer)
          debounceTimer = undefined
        }
        if (watchTimer !== undefined) {
          clearInterval(watchTimer)
          watchTimer = undefined
        }
        if (watcher !== undefined) {
          watcher.close()
          watcher = undefined
        }
      }
    }
  }
  return storeFrom(() => readCurrent().table, resolveRegistry(registry), onChange)
}
