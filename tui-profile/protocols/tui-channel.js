import { defineCapabilityProtocol } from '@dsh-std/connection'

export const TUI_CHANNEL = Object.freeze({
  apiVersion: 'tui.dsh/v1alpha1',
  kind: 'Channel',
})

export const TUI_CHANNEL_WIRE_REVISION = 6

export const TUI_CHANNEL_FEATURES = Object.freeze([
  'commands',
  'credentials',
  'diagnostics',
  'files',
  'models',
  'modes',
  'presets',
  'presentation',
  'provider-setup',
  'scenes',
  'session-history',
  'session-input',
  'session-lifecycle',
  'session-state',
  'settings',
  'skills',
  'subagents',
  'trace',
  'workspaces',
])

export const tuiChannelDefinition = defineCapabilityProtocol({
  ...TUI_CHANNEL,
  validateRequirement: validateTuiChannelRequirement,
  validateSupport: validateTuiChannelSupport,
})

export function validateTuiChannelRequirement(value) {
  const spec = exactRecord(value, ['wireRevision', 'features'], 'Channel requirement')
  const wireRevision = positiveInteger(spec.wireRevision, 'Channel requirement.wireRevision')
  const features = featureList(spec.features, 'Channel requirement.features')
  return Object.freeze({ wireRevision, features })
}

export function validateTuiChannelSupport(value) {
  const spec = exactRecord(value, ['wireRevision', 'features'], 'Channel support')
  const wireRevision = positiveInteger(spec.wireRevision, 'Channel support.wireRevision')
  const features = featureList(spec.features, 'Channel support.features')
  return Object.freeze({ wireRevision, features })
}

export function validateTuiChannelInput(operation, value) {
  switch (operation) {
    case 'open': {
      const input = exactRecord(value, ['workspace', 'sessionId', 'options'], 'Channel.open input')
      optionalString(input.workspace, 'Channel.open input.workspace')
      optionalString(input.sessionId, 'Channel.open input.sessionId')
      if (input.options !== undefined) jsonValue(input.options, 'Channel.open input.options', new Set())
      return input
    }
    case 'subscribe': {
      const input = exactRecord(value, ['channelId', 'afterVersion'], 'Channel.subscribe input')
      nonEmpty(input.channelId, 'Channel.subscribe input.channelId')
      nonNegativeInteger(input.afterVersion, 'Channel.subscribe input.afterVersion')
      return input
    }
    case 'invoke': {
      const input = exactRecord(value, ['channelId', 'method', 'arguments'], 'Channel.invoke input')
      nonEmpty(input.channelId, 'Channel.invoke input.channelId')
      nonEmpty(input.method, 'Channel.invoke input.method')
      if (!Array.isArray(input.arguments)) throw new TypeError('Channel.invoke input.arguments must be an array')
      jsonValue(input.arguments, 'Channel.invoke input.arguments', new Set())
      return input
    }
    case 'close': {
      const input = exactRecord(value, ['channelId'], 'Channel.close input')
      nonEmpty(input.channelId, 'Channel.close input.channelId')
      return input
    }
    default:
      throw new TypeError(`Channel operation ${JSON.stringify(operation)} is not defined`)
  }
}

export function validateTuiChannelSnapshot(value) {
  const snapshot = exactRecord(value, ['wireRevision', 'channelId', 'version', 'state'], 'Channel snapshot')
  positiveInteger(snapshot.wireRevision, 'Channel snapshot.wireRevision')
  nonEmpty(snapshot.channelId, 'Channel snapshot.channelId')
  nonNegativeInteger(snapshot.version, 'Channel snapshot.version')
  const state = exactRecord(snapshot.state, Object.keys(snapshot.state ?? {}), 'Channel snapshot.state')
  jsonValue(state, 'Channel snapshot.state', new Set())
  return snapshot
}

export function validateTuiChannelOutput(operation, value) {
  if (operation === 'open' || operation === 'subscribe') return validateTuiChannelSnapshot(value)
  if (operation === 'invoke') {
    const output = exactRecord(value, ['value', 'valueDefined', 'snapshot'], 'Channel.invoke output')
    jsonValue(output.value, 'Channel.invoke output.value', new Set())
    if (output.valueDefined !== undefined && typeof output.valueDefined !== 'boolean') {
      throw new TypeError('Channel.invoke output.valueDefined must be boolean')
    }
    if (output.snapshot !== undefined) validateTuiChannelSnapshot(output.snapshot)
    return output
  }
  if (operation === 'close') {
    const output = exactRecord(value, ['closed'], 'Channel.close output')
    if (output.closed !== true) throw new TypeError('Channel.close output.closed must be true')
    return output
  }
  throw new TypeError(`Channel operation ${JSON.stringify(operation)} is not defined`)
}

function exactRecord(value, allowed, label) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError(`${label} must be an object`)
  const unknown = Object.keys(value).filter(key => !allowed.includes(key) && !key.startsWith('x-'))
  if (unknown.length > 0) throw new TypeError(`${label} contains unknown field ${JSON.stringify(unknown[0])}`)
  return value
}

function featureList(value, label) {
  if (!Array.isArray(value) || value.length === 0) throw new TypeError(`${label} must be a non-empty array`)
  const features = value.map((feature, index) => {
    nonEmpty(feature, `${label}[${index}]`)
    return feature
  })
  if (new Set(features).size !== features.length) throw new TypeError(`${label} contains duplicates`)
  return Object.freeze([...features].sort())
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${label} must be a positive integer`)
  return value
}

function nonNegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${label} must be a non-negative integer`)
  return value
}

function nonEmpty(value, label) {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${label} must be a non-empty string`)
}

function optionalString(value, label) {
  if (value !== undefined) nonEmpty(value, label)
}

function jsonValue(value, label, ancestors) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`${label} must contain only finite numbers`)
    return
  }
  if (typeof value !== 'object') throw new TypeError(`${label} must be a JSON value`)
  if (ancestors.has(value)) throw new TypeError(`${label} must not contain cycles`)
  ancestors.add(value)
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) jsonValue(item, `${label}[${index}]`, ancestors)
  } else {
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) throw new TypeError(`${label} must contain only plain objects`)
    for (const [key, item] of Object.entries(value)) jsonValue(item, `${label}.${key}`, ancestors)
  }
  ancestors.delete(value)
}
