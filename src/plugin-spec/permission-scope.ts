/** Permission scope normalization shared by admission and runtime checks. */

export const STORAGE_PERMISSIONS = new Set(['storage.local.read', 'storage.local.write'])
export const INTERCEPT_PERMISSIONS = new Set([
  'session.input.intercept',
  'session.rewind.intercept',
  'session.switch.intercept',
  'session.compact.intercept',
])

/** The decision point controlled by each intercept permission.  Keeping this
 * mapping in the scope adapter (rather than accepting every `tui/*` name for
 * every permission) prevents a manifest or grant from silently crossing an
 * event boundary. */
export const INTERCEPT_EVENT_SCOPE_BY_PERMISSION: Readonly<Record<string, string>> = Object.freeze({
  'session.input.intercept': 'tui/input',
  'session.rewind.intercept': 'tui/rewind-prompt',
  'session.switch.intercept': 'tui/session-switch',
  'session.compact.intercept': 'tui/compact',
})

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
    return /^[a-z][a-z0-9]*(?:[.-][a-z0-9][a-z0-9-]*)+$/u.test(scope)
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

export function scopeCovers(declared: NormalizedPermissionScope, actual: NormalizedPermissionScope): boolean {
  if (declared.kind !== actual.kind) return false
  return declared.value === actual.value
    || (declared.kind === 'session' && declared.value === 'session:*' && actual.value.startsWith('session:'))
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

/** Decision permission scopes may be expressed as one named event point. */
export const TUI_EVENT_SCOPE_NAMES = new Set([
  'tui/input',
  'tui/rewind-prompt',
  'tui/rewind-done',
  'tui/session-switch',
  'tui/session-switched',
  'tui/compact',
])

export function rawScopeCovers(permission: string, declared: string, actual: string, componentId: string): boolean {
  const normalizedDeclared = normalizePermissionScope(permission, declared, componentId)
  const normalizedActual = normalizePermissionScope(permission, actual, componentId)
  return normalizedDeclared !== undefined
    && normalizedActual !== undefined
    && permissionScopeCovers(permission, normalizedDeclared, normalizedActual)
}
