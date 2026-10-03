import path from 'node:path'
import { pathToFileURL } from 'node:url'

const packageNames = [
  'core',
  'connection',
  'manifest',
  'command',
  'storage',
  'messages',
  'presentation',
  'workspace',
  'lifecycle',
]

const stdRoot = process.env.DSH_STD_ROOT

const specifier = packageName => stdRoot === undefined
  ? `@dsh-std/${packageName}`
  : pathToFileURL(path.join(stdRoot, 'packages', packageName, 'lib', 'index.js')).href

const modules = Object.fromEntries(await Promise.all(packageNames.map(async packageName => [
  packageName,
  await import(specifier(packageName)),
])))

export const {
  ProtocolCatalog,
  defineProtocolDeclaration,
} = modules.core

export const {
  defineCapabilityProtocol,
} = modules.connection

export const {
  ManifestDefinitionCatalog,
  parseManifest,
  projectManifest,
} = modules.manifest

export const registerCommand = modules.command.register
export const registerStorage = modules.storage.register
export const registerMessages = modules.messages.register
export const validateMessageEvent = modules.messages.validateMessageEvent
export const registerPresentation = modules.presentation.register
export const registerWorkspace = modules.workspace.register
export const facetModuleActivationDefinition = modules.lifecycle.facetModuleActivationDefinition
