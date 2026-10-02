/** dsh-TUI private protocol definitions evaluated by @dsh-std/core. */

export { registerTuiContributionExtensions } from './tui-contributions.js'
export * from './tui-channel.js'
import { tuiChannelDefinition } from './tui-channel.js'

export const DECISION_EVENTS = Object.freeze({
  apiVersion: 'tui.dsh/v1alpha1',
  kind: 'DecisionEvents',
})

function featureSupport(value, label) {
  if (value === undefined) return Object.freeze({ features: Object.freeze([]) })
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} support spec must be an object`)
  }
  const unknown = Object.keys(value).filter(key => key !== 'features' && !key.startsWith('x-'))
  if (unknown.length > 0) throw new TypeError(`${label} support spec contains unknown field ${JSON.stringify(unknown[0])}`)
  if (value.features !== undefined && (!Array.isArray(value.features)
    || value.features.some(feature => typeof feature !== 'string' || feature.trim() === ''))) {
    throw new TypeError(`${label} support spec.features must be an array of non-empty strings`)
  }
  return Object.freeze({ features: Object.freeze([...(value.features ?? [])].sort()) })
}

function providerDefinition(reference, label) {
  return Object.freeze({
    ...reference,
    validateRequirement(value) {
      if (value !== undefined) throw new TypeError(`${label} requirement does not accept spec in manifest v0.15`)
      return undefined
    },
    validateSupport(value) { return featureSupport(value, label) },
    negotiate(input) {
      const providers = [...new Set(input.supports.map(row => row.participant))].sort()
      const issues = input.requirements.flatMap(row => providers.length === 0
        ? [{
            code: row.requirement.optional === true ? 'optional-support-missing' : 'required-support-missing',
            severity: row.requirement.optional === true ? 'warning' : 'error',
            participant: row.participant,
            message: `${label} has no provider in this negotiation scope`,
          }]
        : [])
      return { agreement: Object.freeze({ providers: Object.freeze(providers) }), issues: Object.freeze(issues) }
    },
  })
}

export const decisionEventsDefinition = providerDefinition(DECISION_EVENTS, 'DecisionEvents')

export const profileDefinitions = Object.freeze([
  decisionEventsDefinition,
  tuiChannelDefinition,
])

export function registerProfileProtocols(catalog) {
  const disposers = profileDefinitions.map(definition => catalog.register(definition))
  return () => { for (const dispose of disposers.reverse()) dispose() }
}
