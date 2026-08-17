/** dsh-TUI private protocol registration on the shared dsh-std catalog. */

import { ProtocolCatalog, type ProtocolDefinition, type ProtocolIssue } from '@dsh-std/core'
import { ManifestDefinitionCatalog } from '@dsh-std/manifest'
import { register as registerCommand } from '@dsh-std/command'
import { register as registerMessages } from '@dsh-std/messages'
import { register as registerPresentation } from '@dsh-std/presentation'
import { register as registerStorage } from '@dsh-std/storage'
import type { ContractCoordinate } from './types.js'

export const TUI_EXTENSION_API_VERSION = 'x-ccch1mneyyy.tui/v1alpha1'

export const DECISION_EVENTS_COORDINATE: Readonly<ContractCoordinate> = Object.freeze({
  apiVersion: TUI_EXTENSION_API_VERSION,
  kind: 'DecisionEvents',
})

export const TUI_DECISION_EVENT_NAMES = Object.freeze([
  'tui/input',
  'tui/rewind-prompt',
  'tui/rewind-done',
  'tui/session-switch',
  'tui/session-switched',
  'tui/compact',
] as const)

export const TUI_EXTENSION_PERMISSION_NAMES = Object.freeze([
  'session.input.intercept',
  'session.rewind.intercept',
  'session.switch.intercept',
  'session.compact.intercept',
] as const)

function featureSupport(value: unknown): Readonly<{ features: readonly string[] }> {
  if (value === undefined) return Object.freeze({ features: Object.freeze([]) })
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('DecisionEvents support spec must be an object')
  }
  const record = value as Record<string, unknown>
  const unknown = Object.keys(record).filter(key => key !== 'features' && !key.startsWith('x-'))
  if (unknown.length > 0) throw new TypeError(`DecisionEvents support spec contains unknown field ${JSON.stringify(unknown[0])}`)
  if (record.features !== undefined && (!Array.isArray(record.features)
    || record.features.some(feature => typeof feature !== 'string' || feature.trim() === ''))) {
    throw new TypeError('DecisionEvents support spec.features must be an array of non-empty strings')
  }
  return Object.freeze({ features: Object.freeze([...(record.features ?? []) as string[]].sort()) })
}

export const decisionEventsDefinition: ProtocolDefinition = Object.freeze({
  ...DECISION_EVENTS_COORDINATE,
  validateRequirement(value: unknown): undefined {
    if (value !== undefined) throw new TypeError('DecisionEvents requirement does not accept spec in manifest v0.15')
    return undefined
  },
  validateSupport: featureSupport,
  negotiate(input) {
    const providers = [...new Set(input.supports.map(row => row.participant))].sort()
    const issues: ProtocolIssue[] = input.requirements.flatMap(row => providers.length === 0
      ? [{
          code: row.requirement.optional === true ? 'optional-support-missing' : 'required-support-missing',
          severity: row.requirement.optional === true ? 'warning' as const : 'error' as const,
          participant: row.participant,
          message: 'DecisionEvents has no provider in this negotiation scope',
        }]
      : [])
    return {
      agreement: Object.freeze({ providers: Object.freeze(providers) }),
      issues: Object.freeze(issues),
    }
  },
})

export interface AdmissionCatalog {
  protocols: ProtocolCatalog
  manifests: ManifestDefinitionCatalog
}

/** Register public and private definitions into one evaluator-owned catalog. */
export function createAdmissionCatalog(): AdmissionCatalog {
  const protocols = new ProtocolCatalog({ name: 'dsh-tui-admission', version: '0.15' })
  const manifests = new ManifestDefinitionCatalog()
  registerCommand(protocols, manifests)
  registerStorage(protocols)
  registerMessages(protocols)
  registerPresentation(protocols)
  protocols.register(decisionEventsDefinition)
  return { protocols, manifests }
}
