/** Permission scope normalization shared by admission and runtime checks. */

import {
  EXPECTED_PERMISSIONS,
  INTERCEPT_PERMISSIONS,
  INTERCEPT_EVENT_SCOPE_BY_PERMISSION,
  TUI_EVENT_SCOPE_NAMES,
} from '../spec/protocol-constants.js'
import { isManifestNamespacedId } from '../../pluginIdentity.js'

export { INTERCEPT_PERMISSIONS, INTERCEPT_EVENT_SCOPE_BY_PERMISSION, TUI_EVENT_SCOPE_NAMES }

/** Storage permission names are derived from the same vendored registry. */
export const STORAGE_PERMISSIONS = new Set(
  EXPECTED_PERMISSIONS.filter(permission => permission.name.startsWith('storage.local.')).map(permission => permission.name),
)


/** A session scope is carried through the message envelope and may also be
 * used by an intercept grant. Keep the canonical bound here so admission,
 * grant evaluation, and runtime delivery cannot disagree about whether a
 * scope is executable. */
export const SESSION_SCOPE_MAX_CHARS = 256

const CONTROL_CHARS = /[\x00-\x1f\x7f-\x9f]/u

export type ScopeKind = 'component' | 'command' | 'session' | 'event'

export interface NormalizedPermissionScope {
  kind: ScopeKind
  value: string
}

const COMMAND_WILDCARD_SUFFIX = '.*'

/**
 * The command namespace wildcard of one Component: `<componentId>.*`.
 *
 * The vendored v0.15 projection keys a facet's permissions by name, so a
 * facet carries at most one `commands.invoke` row. This scope is how that one
 * row covers several declared commands: every command id under the
 * Component's own id namespace (`<componentId>.<rest>`), and nothing else —
 * `*`, another Component's prefix, or a prefix that is not a manifest id are
 * not enforceable.
 */
export function commandNamespaceWildcard(componentId: string): string {
  return `${componentId}${COMMAND_WILDCARD_SUFFIX}`
}

/** Whether a normalized command scope is a namespace wildcard. Exact command
 * ids never contain `*`, so the suffix is unambiguous. */
export function isCommandWildcard(scope: NormalizedPermissionScope): boolean {
  return scope.kind === 'command' && scope.value.endsWith(COMMAND_WILDCARD_SUFFIX)
}

/** Return undefined when this adapter cannot enforce the supplied scope. */
export function normalizePermissionScope(
  permission: string,
  scope: string,
  componentId: string,
): NormalizedPermissionScope | undefined {
  if (typeof scope !== 'string' || scope === '') return undefined
  if (STORAGE_PERMISSIONS.has(permission)) {
    return scope === componentId ? { kind: 'component', value: componentId } : undefined
  }
  if (permission === 'commands.invoke') {
    if (isManifestNamespacedId(scope)) return { kind: 'command', value: scope }
    return scope === commandNamespaceWildcard(componentId) && isManifestNamespacedId(componentId)
      ? { kind: 'command', value: scope }
      : undefined
  }
  if (INTERCEPT_PERMISSIONS.has(permission) && TUI_EVENT_SCOPE_NAMES.has(scope)) {
    return INTERCEPT_EVENT_SCOPE_BY_PERMISSION[permission] === scope
      ? { kind: 'event', value: scope }
      : undefined
  }
  if (permission === 'messages.observe.read' || INTERCEPT_PERMISSIONS.has(permission)) {
    if (scope === 'session:*') return { kind: 'session', value: scope }
    if (scope.startsWith('session:')
      && scope.length <= SESSION_SCOPE_MAX_CHARS
      && scope.length > 'session:'.length
      && !scope.includes('*')
      && !CONTROL_CHARS.test(scope)) {
      return { kind: 'session', value: scope }
    }
    return undefined
  }
  return undefined
}

/**
 * Plain containment within one scope kind. Both broad forms are parents of
 * their concrete scopes only — `session:*` of `session:<id>`, a command
 * namespace wildcard of the exact command ids under that namespace — so a
 * narrow deny still wins over a broad grant, while a narrow grant or deny
 * never covers the broad form itself.
 */
export function scopeCovers(declared: NormalizedPermissionScope, actual: NormalizedPermissionScope): boolean {
  if (declared.kind !== actual.kind) return false
  if (declared.value === actual.value) return true
  if (declared.kind === 'session') return declared.value === 'session:*' && actual.value.startsWith('session:')
  return isCommandWildcard(declared)
    && !isCommandWildcard(actual)
    && actual.value.startsWith(declared.value.slice(0, -1))
}

/**
 * Permission-aware containment.  An event-point grant is the parent scope of
 * the sessions delivered through that point, while a session grant can never
 * be promoted into an event-point grant.  This relation is also used for
 * denies, so a narrow `session:<id>` deny wins over a broad event grant.
 */
export function permissionScopeCovers(
  permission: string,
  declared: NormalizedPermissionScope,
  actual: NormalizedPermissionScope,
): boolean {
  if (scopeCovers(declared, actual)) return true
  return INTERCEPT_PERMISSIONS.has(permission)
    && declared.kind === 'event'
    && actual.kind === 'session'
}

export function rawScopeCovers(permission: string, declared: string, actual: string, componentId: string): boolean {
  const normalizedDeclared = normalizePermissionScope(permission, declared, componentId)
  const normalizedActual = normalizePermissionScope(permission, actual, componentId)
  return normalizedDeclared !== undefined
    && normalizedActual !== undefined
    && permissionScopeCovers(permission, normalizedDeclared, normalizedActual)
}
