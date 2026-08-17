/** Verified Component identity bound to one Cordis activation owner. */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { ComponentManifest, PluginManifest } from '@dsh-std/manifest'
import { normalizePermissionScope, scopeCovers } from '../plugin-spec/permission-scope.js'

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

function ownerKey(context: Context): object {
  try {
    const fiber: unknown = context.fiber
    if (typeof fiber === 'object' && fiber !== null) return fiber
  } catch {
    // A real plugin context always has a fiber; reject degraded callers below.
  }
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
  try {
    context.effect(() => release)
  } catch (error) {
    identities.delete(key)
    throw new ComponentIdentityError(
      'COMPONENT_NOT_ADMITTED',
      `cannot bind Component identity to an inactive activation: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  return identity
}

export function componentIdentityOf(context: Context): VerifiedComponentIdentity | undefined {
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
  return identity.manifest.requires.contracts.some(requirement =>
    requirement.apiVersion === 'x-ccch1mneyyy.tui/v1alpha1' && requirement.kind === 'DecisionEvents')
}
