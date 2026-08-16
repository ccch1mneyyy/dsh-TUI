#!/usr/bin/env node
/**
 * Package boundary regression for host-provided DeepSeek Harness modules.
 *
 * A profile must resolve every @deepseek-ai package from DSH's module
 * fallback tree. Shipping one as a normal dependency creates a second module
 * instance inside the profile; shared Symbols such as the tool scheduler then
 * stop matching between the host and plugin trees.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const dependencies = manifest.dependencies ?? {}
const peerDependencies = manifest.peerDependencies ?? {}
const devDependencies = manifest.devDependencies ?? {}

const bundledFrameworkPackages = Object.keys(dependencies)
  .filter(name => name.startsWith('@deepseek-ai/'))
  .sort()

assert.deepEqual(
  bundledFrameworkPackages,
  [],
  `host-provided @deepseek-ai packages must be peerDependencies, not dependencies:\n${bundledFrameworkPackages.join('\n')}`,
)

const missingDevCopies = Object.keys(peerDependencies)
  .filter(name => name.startsWith('@deepseek-ai/') && devDependencies[name] === undefined)
  .sort()

assert.deepEqual(
  missingDevCopies,
  [],
  `host peers must also be devDependencies for local builds:\n${missingDevCopies.join('\n')}`,
)

console.log(`host peer dependency boundary OK (${Object.keys(peerDependencies).length} peers)`)
