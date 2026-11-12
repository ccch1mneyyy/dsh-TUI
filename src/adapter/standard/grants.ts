/** Live, scoped plugin grant evaluation. */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { PermissionRegistry } from './types.js'
import { normalizePermissionScope, permissionScopeCovers } from './permission-scope.js'
import { loadSpecData } from './registry.js'
import {
  assertCapabilityShadowPolicy,
  defaultAdapterRuntime,
  type AdapterRuntimeOptions,
} from '../kernel/runtime.js'
import { DATA_DIR } from '../../utils/paths.js'

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
  runtime: AdapterRuntimeOptions = defaultAdapterRuntime(),
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
      assertCapabilityShadowPolicy('host.grants.evaluate', runtime.mode, runtime.slices)
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

/**
 * One write to the grants document, as the lifecycle flows ask for it.
 *
 * The shapes are the ones `parseTable`/`parseRule` accept — this module owns
 * both the reader and the writer, so a mutation can never produce a document
 * its own reader calls corrupt.
 */
export interface GrantPermissionWrite {
  readonly name: string
  readonly scope: string
}

export type GrantMutation =
  /**
   * Add every declared `{name, scope}` that is not already a global rule.
   * Existing rules, other components, other sections and legacy string rows
   * are left exactly as they are.
   */
  | { readonly kind: 'ensure'; readonly id: string; readonly permissions: readonly GrantPermissionWrite[] }
  /**
   * Remove every rule of one component whose permission name is listed —
   * any scope, activation-scoped rules included. `denies` is untouched, an
   * emptied array loses its key, and every other component stays.
   */
  | { readonly kind: 'revoke'; readonly id: string; readonly names: readonly string[] }
  /**
   * Drop the component's `grants` and `denies` entries entirely. Used on
   * removal: a surviving rule would be inherited by any later package that
   * reuses the same component id.
   */
  | { readonly kind: 'forget'; readonly id: string }

export interface GrantRewrite {
  /** The document after the mutation; the input unchanged when `changed` is false. */
  readonly text: string
  /** Whether the mutation actually altered the document. */
  readonly changed: boolean
}

/** A rule that already grants exactly this permission at exactly this scope. */
function isGlobalRule(value: unknown, permission: GrantPermissionWrite): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const rule = value as Record<string, unknown>
  return rule.name === permission.name && rule.scope === permission.scope && rule.activationId === undefined
}

/** The permission name a valid rule row carries (`parseRule` accepted it already). */
function ruleName(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const name = (value as Record<string, unknown>).name
  return typeof name === 'string' ? name : undefined
}

/** The mutable JSON shape behind one non-corrupt document. */
interface GrantDocument {
  grants?: Record<string, unknown[]>
  denies?: Record<string, unknown[]>
}

/**
 * Apply one mutation to a grants document, returning the new text.
 *
 * The caller owns the file: this function never touches the filesystem, so
 * what is writable is decided here by the same strict parser that decides what
 * is readable. A document the store already calls corrupt — bad JSON, an
 * unknown root key, a malformed rule — is refused rather than repaired, and
 * zero bytes are corruption exactly like `readGrantStore` says (an absent file
 * is the caller's empty `{}`, not this function's).
 */
export function rewriteGrantDocument(text: string, mutation: GrantMutation): GrantRewrite | { readonly error: 'corrupt' } {
  if (parseTable(text).corrupt) return { error: 'corrupt' }
  const root = JSON.parse(text) as GrantDocument
  let changed = false

  if (mutation.kind === 'ensure') {
    const section = root.grants ?? (root.grants = {})
    const rules = section[mutation.id] ?? (section[mutation.id] = [])
    for (const permission of mutation.permissions) {
      if (rules.some(rule => isGlobalRule(rule, permission))) continue
      rules.push({ name: permission.name, scope: permission.scope })
      changed = true
    }
  } else if (mutation.kind === 'revoke') {
    const section = root.grants
    const rules = section?.[mutation.id]
    if (section !== undefined && rules !== undefined) {
      const names = new Set(mutation.names)
      const kept = rules.filter(rule => {
        const name = ruleName(rule)
        return name === undefined || !names.has(name)
      })
      if (kept.length !== rules.length) {
        changed = true
        if (kept.length === 0) delete section[mutation.id]
        else section[mutation.id] = kept
        if (Object.keys(section).length === 0) delete root.grants
      }
    }
  } else {
    for (const key of ['grants', 'denies'] as const) {
      const section = root[key]
      if (section === undefined || section[mutation.id] === undefined) continue
      delete section[mutation.id]
      changed = true
      if (Object.keys(section).length === 0) delete root[key]
    }
  }

  return { text: changed ? `${JSON.stringify(root, null, 2)}\n` : text, changed }
}

/** Parse a fixed snapshot, primarily for deterministic tests. */
export function parseGrantStore(
  text: string,
  registry?: PermissionRegistry,
  runtime: AdapterRuntimeOptions = defaultAdapterRuntime(),
): GrantStore {
  const parsed = text === ''
    ? { grants: new Map(), denies: new Map(), corrupt: false } as GrantTable
    : parseTable(text)
  return storeFrom(() => parsed, resolveRegistry(registry), () => () => undefined, runtime)
}

/**
 * Read grants on every decision. File changes therefore affect the next
 * operation without a restart. onChange uses a non-persistent watcher so
 * grant-owned subscriptions can be released even when no event is flowing.
 *
 * When called from a Cordis composition, pass the same immutable
 * `adapterRuntimeFor(ctx)` snapshot so grant evaluation uses the same shadow
 * policy as every other service in that composition root.
 */
export function readGrantStore(
  dir: string = DATA_DIR,
  registry?: PermissionRegistry,
  runtime: AdapterRuntimeOptions = defaultAdapterRuntime(),
): GrantStore {
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
      signature: text,
    }
  }
  const listeners = new Set<() => void>()
  let watching = false
  let watchTimer: ReturnType<typeof setInterval> | undefined
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
  const onChange = (listener: () => void): (() => void) => {
    listeners.add(listener)
    if (!watching) {
      watching = true
      // A small unref'ed poll is deterministic across filesystems and
      // timestamp granularities. The synchronous read on every operation
      // remains the authorization source of truth; this loop only releases
      // grant-owned subscriptions promptly after a revocation.
      watchTimer = setInterval(changed, 50)
      watchTimer.unref?.()
    }
    return () => {
      listeners.delete(listener)
      if (watching && listeners.size === 0) {
        watching = false
        if (watchTimer !== undefined) clearInterval(watchTimer)
        watchTimer = undefined
      }
    }
  }
  return storeFrom(() => readCurrent().table, resolveRegistry(registry), onChange, runtime)
}
