/** Verified Component identity bound to one Cordis activation owner. */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { ComponentManifest, PluginManifest } from '../adapter/standard/types.js'
import { normalizePermissionScope, scopeCovers } from '../adapter/standard/permission-scope.js'
import { activationFiber, bindCallerEffect, parentFiberOf, registerIdentityHolderProbe } from './host-access.js'

export type ComponentIdentityErrorCode = 'COMPONENT_NOT_ADMITTED' | 'COMPONENT_ALREADY_ADMITTED'

export class ComponentIdentityError extends Error {
  constructor(readonly code: ComponentIdentityErrorCode, message: string) {
    super(message)
    this.name = 'ComponentIdentityError'
  }
}

export interface VerifiedComponentIdentity {
  readonly componentId: string
  readonly version: string
  readonly facet: 'host'
  readonly activationId: string
  readonly manifest: PluginManifest
  readonly projection: ComponentManifest
}

/** Activation ids are host-issued opaque values. Keep them bounded and free
 * of control characters because the same value is written to the effect
 * ledger and used as a grant principal selector. */
export const ACTIVATION_ID_MAX_LENGTH = 128

function validateActivationId(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > ACTIVATION_ID_MAX_LENGTH
    || /[\x00-\x1f\x7f-\x9f]/u.test(value)) {
    throw new ComponentIdentityError(
      'COMPONENT_NOT_ADMITTED',
      `activationId must be a non-empty control-free string of at most ${ACTIVATION_ID_MAX_LENGTH} characters`,
    )
  }
  return value
}

const identities = new WeakMap<object, VerifiedComponentIdentity>()
/** Activations that are plugins in their own right (a Loader row's own fiber,
 *  marked by the admission loader before the row's `apply`). Inheritance
 *  never crosses one: a nested row whose own admission is pending, refused
 *  or impossible must not act under the identity of the row around it. */
const admissionBoundaries = new WeakSet<object>()
// assertCallerContext admits a plugin's ancestor ctx only while no fiber on
// the way holds an identity of its own (the same walk as componentIdentityOf).
registerIdentityHolderProbe(fiber => identities.has(fiber) || admissionBoundaries.has(fiber))

/** Mark `fiber` as its own plugin: identity lookups stop there unless it is
 *  admitted itself. */
export function markAdmissionBoundary(fiber: object): void {
  admissionBoundaries.add(fiber)
}

function ownerKey(context: Context): object {
  const fiber = activationFiber(context)
  if (fiber !== undefined) return fiber
  throw new ComponentIdentityError('COMPONENT_NOT_ADMITTED', 'a Component activation requires an owning Cordis fiber')
}

export function bindComponentIdentity(
  context: Context,
  manifest: PluginManifest,
  projection: ComponentManifest,
  activationId: string = randomUUID(),
): VerifiedComponentIdentity {
  const key = ownerKey(context)
  if (identities.has(key)) {
    throw new ComponentIdentityError('COMPONENT_ALREADY_ADMITTED', 'this activation already has a verified Component identity')
  }
  const identity: VerifiedComponentIdentity = Object.freeze({
    componentId: projection.metadata.name,
    version: projection.metadata.version,
    facet: 'host',
    activationId: validateActivationId(activationId),
    manifest,
    projection,
  })
  identities.set(key, identity)
  const release = (): void => {
    if (identities.get(key) === identity) identities.delete(key)
  }
  if (!bindCallerEffect(context, release)) {
    identities.delete(key)
    throw new ComponentIdentityError(
      'COMPONENT_NOT_ADMITTED',
      'cannot bind Component identity to an inactive activation',
    )
  }
  return identity
}

/** How far up the fiber chain an identity lookup walks before giving up. */
const IDENTITY_LOOKUP_DEPTH = 64

/**
 * The verified identity the calling context acts under: its own activation's,
 * or else the nearest admitted ancestor's. A plugin's nested fibers — every
 * `ctx.inject([...], cb)` and `ctx.plugin(...)` it creates — are part of that
 * plugin, so a panel registered or a grant checked from inside one carries the
 * plugin's identity instead of none. A nested plugin with its own admitted
 * manifest is found first and keeps its own; a nested Loader row that is not
 * admitted (an admission boundary) gets none. The walk stops at the root fiber
 * (`runtime === null`), which never holds an identity, and follows the parent
 * Cordis set at creation (`parentFiberOf`) — never the live, writable
 * `fiber.parent`, which would let a plugin adopt another plugin's identity.
 */
export function componentIdentityOf(context: Context): VerifiedComponentIdentity | undefined {
  let fiber: unknown
  try {
    fiber = ownerKey(context)
  } catch {
    return undefined
  }
  const seen = new Set<object>()
  for (let depth = 0; depth < IDENTITY_LOOKUP_DEPTH; depth += 1) {
    if (typeof fiber !== 'object' || fiber === null || seen.has(fiber)) return undefined
    seen.add(fiber)
    const identity = identities.get(fiber)
    if (identity !== undefined) return identity
    if (admissionBoundaries.has(fiber)) return undefined
    try {
      if ((fiber as { readonly runtime?: unknown }).runtime === null) return undefined
    } catch {
      return undefined
    }
    fiber = parentFiberOf(fiber)
  }
  return undefined
}

/**
 * The identity bound to the calling activation's OWN fiber, without
 * inheritance. Admission asks this — "has this activation been admitted?" —
 * so a nested plugin with its own manifest is still admitted under it,
 * not mistaken for already admitted through its parent's identity.
 */
export function ownComponentIdentityOf(context: Context): VerifiedComponentIdentity | undefined {
  try {
    return identities.get(ownerKey(context))
  } catch {
    return undefined
  }
}

export function requireComponentIdentity(context: Context): VerifiedComponentIdentity {
  const identity = componentIdentityOf(context)
  if (identity === undefined) {
    throw new ComponentIdentityError(
      'COMPONENT_NOT_ADMITTED',
      'the calling activation has no verified dsh-plugin.json Component identity',
    )
  }
  return identity
}

export function declaresPermission(
  identity: VerifiedComponentIdentity,
  permission: string,
  actualScope: string,
): boolean {
  const actual = normalizePermissionScope(permission, actualScope, identity.componentId)
  if (actual === undefined) return false
  return identity.manifest.permissions.some(request => {
    if (request.name !== permission) return false
    const declared = normalizePermissionScope(permission, request.scope, identity.componentId)
    return declared !== undefined && scopeCovers(declared, actual)
  })
}

export function declaresCommand(identity: VerifiedComponentIdentity, commandId: string): boolean {
  return identity.manifest.contributes.commands.some(command => command.id === commandId)
}

export function declaresObserverScope(identity: VerifiedComponentIdentity, actualScope: string): boolean {
  const actual = normalizePermissionScope('messages.observe.read', actualScope, identity.componentId)
  if (actual === undefined) return false
  return identity.manifest.subscriptions.some(subscription => {
    if (typeof subscription === 'string') return subscription === 'messages.observe'
    if (subscription.apiVersion !== 'messages.dsh/v1alpha1' || subscription.kind !== 'MessageObserver') return false
    if (subscription.scope === undefined) return true
    const declared = normalizePermissionScope('messages.observe.read', subscription.scope, identity.componentId)
    return declared !== undefined && scopeCovers(declared, actual)
  })
}

export function requiresDecisionEvents(identity: VerifiedComponentIdentity): boolean {
  return requiresContract(identity, 'tui.dsh/v1alpha1', 'DecisionEvents')
}

/** Whether admission negotiated the protocol that backs a mediated runtime
 * capability.  Permissions alone are not a capability grant: a plugin must
 * explicitly require the corresponding contract before the host can expose
 * its calls. */
export function requiresContract(
  identity: VerifiedComponentIdentity,
  apiVersion: string,
  kind: string,
): boolean {
  return identity.manifest.requires.contracts.some(requirement =>
    requirement.apiVersion === apiVersion && requirement.kind === kind)
}
