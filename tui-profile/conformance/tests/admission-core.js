// Shared admission core: profile/registry/permission loading, catalog and
// protocol registration (incl. TUI private protocols), manifest parse+validate,
// host validation and the five-state admission decision.
//
// Used by BOTH the conformance suite (conformance/tests/run.js) and the real-plugin
// CLI (scripts/validate-manifest.js), so a plugin's conformance evidence is computed
// by exactly the same algorithm the suite exercises.
//
// Inputs are either repo-relative paths (suite style) or absolute paths (CLI style);
// both are resolved to a file via `toFile`.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ProtocolCatalog,
  defineProtocolDeclaration,
} from './std-modules.js'
import {
  ManifestDefinitionCatalog,
  parseManifest,
  projectManifest,
} from './std-modules.js'
import { registerCommand, registerStorage } from './std-modules.js'
import { registerMessages } from './std-modules.js'
import {
  facetModuleActivationDefinition,
  registerPresentation,
  registerWorkspace,
} from './std-modules.js'
import { registerProfileProtocols, registerTuiContributionExtensions } from '../../protocols/profile-definitions.js'

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

/** Resolve a repo-relative path against the repo root. */
export const resolveRepo = relative => path.join(root, relative)
/** Resolve either a repo-relative or an absolute user path to a file. */
const toFile = input => (path.isAbsolute(input) ? input : path.join(root, input))
export const loadFile = input => JSON.parse(fs.readFileSync(toFile(input), 'utf8'))
export const sourceFile = input => fs.readFileSync(toFile(input), 'utf8')
/** Repo-relative loaders kept for suite-style callers. */
export const load = relative => loadFile(relative)
export const source = relative => sourceFile(relative)

export const schemas = {
  host: load('schemas/host-descriptor.schema.json'),
  ledger: load('schemas/effect-ledger-record.schema.json'),
  claim: load('schemas/conformance-claim.schema.json'),
}
export const profile = load('registry/registry-0.15.json')
export const permissionRegistry = load('registry/permissions-0.1.json')
export const facetApiVersions = profile.facetApiVersions ?? []
const profileEntries = [...profile.imports, ...profile.definitions]
export const coordinateKey = value => `${value.apiVersion ?? value.coordinates.apiVersion}#${value.kind ?? value.coordinates.kind}`
export const familyKey = value => `${(value.apiVersion ?? value.coordinates.apiVersion).split('/')[0]}#${value.kind ?? value.coordinates.kind}`
export const byCoordinate = new Map(profileEntries.map(entry => [coordinateKey(entry.coordinates), entry]))
export const byFamily = new Map(profileEntries.map(entry => [familyKey(entry.coordinates), entry]))
export const byName = new Map(profileEntries.filter(entry => entry.name !== undefined).map(entry => [entry.name, entry]))

export const protocols = new ProtocolCatalog({ name: 'dsh-tui-admission', version: '0.15' })
export const manifestDefinitions = new ManifestDefinitionCatalog({ name: 'dsh-tui-admission', version: '0.15' })
manifestDefinitions.registerActivation(facetModuleActivationDefinition)
registerCommand(protocols, manifestDefinitions)
registerStorage(protocols)
registerMessages(protocols)
registerPresentation(protocols)
registerWorkspace(protocols, manifestDefinitions)
registerProfileProtocols(protocols)
registerTuiContributionExtensions(manifestDefinitions)

export function resolveRef(rootSchema, ref) {
  if (!ref.startsWith('#/')) throw new Error(`external ref is not supported by the profile runner: ${ref}`)
  return ref.slice(2).split('/').reduce((value, key) => value[key.replace(/~1/g, '/').replace(/~0/g, '~')], rootSchema)
}

export function check(value, schema, rootSchema, where = '$') {
  if (schema.$ref) return check(value, resolveRef(rootSchema, schema.$ref), rootSchema, where)
  if (schema.oneOf) {
    let matches = 0
    const errors = []
    for (const variant of schema.oneOf) {
      try { check(value, variant, rootSchema, where); matches += 1 } catch (error) { errors.push(error.message) }
    }
    if (matches !== 1) throw new Error(`${where}: expected exactly one oneOf match, got ${matches}: ${errors.join(' | ')}`)
    return
  }
  if (schema.const !== undefined && value !== schema.const) throw new Error(`${where}: expected ${JSON.stringify(schema.const)}`)
  if (schema.enum && !schema.enum.includes(value)) throw new Error(`${where}: value is not in enum`)
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${where}: expected object`)
    for (const key of schema.required ?? []) if (!(key in value)) throw new Error(`${where}.${key}: required`)
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        const declared = Object.hasOwn(schema.properties ?? {}, key)
        const patterned = Object.keys(schema.patternProperties ?? {}).some(pattern => new RegExp(pattern).test(key))
        if (!declared && !patterned) throw new Error(`${where}.${key}: additional property`)
      }
    }
    for (const [key, child] of Object.entries(schema.properties ?? {})) if (key in value) check(value[key], child, rootSchema, `${where}.${key}`)
    for (const [pattern, child] of Object.entries(schema.patternProperties ?? {})) {
      for (const key of Object.keys(value)) if (new RegExp(pattern).test(key)) check(value[key], child, rootSchema, `${where}.${key}`)
    }
  } else if (schema.type === 'array') {
    if (!Array.isArray(value)) throw new Error(`${where}: expected array`)
    if (schema.minItems !== undefined && value.length < schema.minItems) throw new Error(`${where}: too few items`)
    if (schema.maxItems !== undefined && value.length > schema.maxItems) throw new Error(`${where}: too many items`)
    for (const [index, item] of value.entries()) check(item, schema.items, rootSchema, `${where}[${index}]`)
    if (schema.uniqueItems) {
      const encoded = value.map(item => JSON.stringify(item))
      if (new Set(encoded).size !== encoded.length) throw new Error(`${where}: duplicate items`)
    }
  } else if (schema.type === 'string') {
    if (typeof value !== 'string') throw new Error(`${where}: expected string`)
    if (schema.minLength !== undefined && value.length < schema.minLength) throw new Error(`${where}: too short`)
    if (schema.maxLength !== undefined && value.length > schema.maxLength) throw new Error(`${where}: too long`)
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) throw new Error(`${where}: pattern mismatch`)
    if (schema.format === 'uri') { try { new URL(value) } catch { throw new Error(`${where}: invalid URI`) } }
    if (schema.format === 'date-time' && Number.isNaN(Date.parse(value))) throw new Error(`${where}: invalid date-time`)
  } else if (schema.type === 'integer') {
    if (!Number.isInteger(value)) throw new Error(`${where}: expected integer`)
    if (schema.minimum !== undefined && value < schema.minimum) throw new Error(`${where}: below minimum`)
  } else if (schema.type === 'boolean' && typeof value !== 'boolean') throw new Error(`${where}: expected boolean`)
}

export function resolveProfileReference(reference) {
  const exact = byCoordinate.get(coordinateKey(reference))
  if (exact !== undefined) return { entry: exact, unknownVersion: false }
  const family = byFamily.get(familyKey(reference))
  if (family !== undefined) return { entry: family, unknownVersion: true }
  throw new Error(`protocol definition is not admitted by this profile: ${coordinateKey(reference)}`)
}

export function resolveSubscription(subscription) {
  const entry = typeof subscription === 'string'
    ? byName.get(subscription)
    : byCoordinate.get(coordinateKey(subscription))
  if (entry === undefined) throw new Error(`unknown subscription: ${typeof subscription === 'string' ? subscription : coordinateKey(subscription)}`)
  if (entry.kind !== 'event') throw new Error(`subscription must reference an event: ${entry.name ?? coordinateKey(entry.coordinates)}`)
  return entry
}

/** Structural + semantic manifest validation. Same algorithm as the suite. */
export function parseAndValidateManifest(input) {
  const parsed = parseManifest(sourceFile(input), { source: input })
  if (!facetApiVersions.includes(parsed.facets.host.apiVersion)) {
    throw new Error(`facet apiVersion is not admitted: ${parsed.facets.host.apiVersion}`)
  }
  for (const requirement of parsed.requires.contracts) {
    resolveProfileReference(requirement)
    if (requirement.optional === true && !requirement.fallback) {
      throw new Error(`optional protocol requires a TUI fallback: ${coordinateKey(requirement)}`)
    }
  }
  for (const subscription of parsed.subscriptions) resolveSubscription(subscription)
  const projected = projectManifest(parsed)
  const report = manifestDefinitions.validate(projected, protocols, { source: input })
  const errors = report.issues.filter(issue => issue.severity === 'error')
  if (errors.length > 0) throw new Error(errors.map(issue => issue.message).join('; '))
  return { parsed, projected }
}

/** Validate a host descriptor against the registry (definition/hash/permission/duplicate). */
export function validateHost(host) {
  const seen = new Set()
  const knownPermissions = new Set(permissionRegistry.permissions.map(permission => permission.name))
  for (const contract of host.contracts) {
    const key = coordinateKey(contract)
    if (seen.has(key)) throw new Error(`host declares duplicate protocol: ${key}`)
    seen.add(key)
    const entry = byCoordinate.get(key)
    if (entry === undefined || !protocols.understands(contract)) throw new Error(`host declares an unknown protocol: ${key}`)
    if (contract.definition.source === 'dsh-std') {
      if (entry.package !== contract.definition.package) throw new Error(`host std definition source mismatch: ${key}`)
    } else if (entry.profileHash !== contract.definition.profileHash) {
      throw new Error(`host profile definition hash mismatch: ${key}`)
    }
    for (const permission of contract.permissions) {
      if (!knownPermissions.has(permission)) throw new Error(`host declares unknown permission: ${permission}`)
    }
  }
}

/** Five-state admission decision. Identical algorithm to the suite's admissionDecision. */
export function admissionDecision(input, host, grants = []) {
  const raw = loadFile(input)
  let parsed
  try { parsed = parseManifest(JSON.stringify(raw), { source: input }) } catch (error) {
    return { decision: 'rejected', reasonCode: 'INVALID_MANIFEST', message: error.message }
  }
  const unknown = parsed.requires.contracts.filter(requirement => {
    try { return resolveProfileReference(requirement).unknownVersion } catch { return false }
  })
  if (unknown.length > 0) return {
    decision: 'unknown', reasonCode: 'UNKNOWN_PROTOCOL_VERSION',
    unknownContracts: unknown.map(coordinateKey),
  }
  if (!host.facetApiVersions.includes(parsed.facets.host.apiVersion)) return {
    decision: 'rejected', reasonCode: 'FACET_API_VERSION_UNAVAILABLE',
    facetApiVersion: parsed.facets.host.apiVersion,
  }
  const projected = projectManifest(parsed)
  const facet = projected.spec.facets[0]
  const supportKeys = new Set(host.contracts.map(coordinateKey))
  const requirements = facet.protocols?.requires ?? []
  const missingRequired = requirements.filter(row => row.optional !== true && !supportKeys.has(coordinateKey(row)))
  const missingOptional = requirements.filter(row => row.optional === true && !supportKeys.has(coordinateKey(row)))
  if (missingRequired.length > 0) return {
    decision: 'rejected', reasonCode: 'REQUIRED_PROTOCOL_UNAVAILABLE',
    missingRequired: missingRequired.map(coordinateKey),
  }
  const declaration = defineProtocolDeclaration({ participant: { id: parsed.id }, requires: requirements })
  const hostDeclaration = defineProtocolDeclaration({
    participant: { id: host.hostId },
    supports: host.contracts.map(contract => ({
      apiVersion: contract.apiVersion,
      kind: contract.kind,
      ...(contract.spec === undefined ? {} : { spec: contract.spec }),
    })),
  })
  const report = protocols.negotiate([declaration, hostDeclaration])
  if (!report.compatible && missingOptional.length === 0) return {
    decision: 'rejected', reasonCode: 'PROTOCOL_NEGOTIATION_FAILED', issues: report.issues,
  }
  const hostPermissions = new Set(host.contracts.flatMap(contract => contract.permissions))
  const granted = new Set(grants)
  const deniedPermissions = parsed.permissions.filter(request => {
    if (!hostPermissions.has(request.name)) return true
    const definition = permissionRegistry.permissions.find(permission => permission.name === request.name)
    return definition === undefined || (definition.default === 'deny' && !granted.has(request.name))
  })
  if (deniedPermissions.length > 0) return {
    decision: 'waiting_authorization', reasonCode: 'PERMISSION_NOT_GRANTED',
    deniedPermissions: deniedPermissions.map(request => request.name),
  }
  return {
    decision: missingOptional.length > 0 ? 'compatible_degraded' : 'compatible',
    missingOptional: missingOptional.map(coordinateKey),
  }
}
