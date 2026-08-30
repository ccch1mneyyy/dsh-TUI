/**
 * Regression gate for mixed dsh-web + dsh-tui profiles.
 *
 * The installed web-app is always checked. A source checkout supplies the
 * unpublished alpha baseline; CI requires it instead of silently skipping it.
 * Scoped TUI host rows must never collide with either bundle generation and
 * must yield to every official row that generation owns.
 */

import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parse } from 'yaml'
import { applyEntryPatches } from '@deepseek-ai/cordis-plugin-include'
import { evaluate } from '@deepseek-ai/cordis-plugin-loader'
import { prepareUpstreamSourceResolver } from './upstream-source-baseline.mjs'

const yamlOptions = { logLevel: 'silent' }
const loadPatch = path => parse(readFileSync(path, 'utf8'), yamlOptions)
const insertedRows = patches => patches.flatMap(patch => Array.isArray(patch?.insert) ? patch.insert : [])

const tuiPath = fileURLToPath(new URL('../cordis.patch.yml', import.meta.url))
const installedWebPath = fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-web-app/cordis.patch.yml'))
const installedWebManifest = fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-web-app/package.json'))
const installedWebVersion = JSON.parse(readFileSync(installedWebManifest, 'utf8')).version
const baselines = [{
  label: `installed web-app ${installedWebVersion}`,
  version: installedWebVersion,
  baseUrl: pathToFileURL(tuiPath).href,
  webPath: installedWebPath,
}]

const sourceRoot = process.env.DSH_HARNESS_SOURCE_ROOT === undefined
  ? fileURLToPath(new URL('../../deepseek-harness/', import.meta.url))
  : resolve(process.env.DSH_HARNESS_SOURCE_ROOT)
const sourceWebPath = join(sourceRoot, 'packages/bundle/web-app/cordis.patch.yml')
const sourceWebManifest = join(sourceRoot, 'packages/bundle/web-app/package.json')
const sourceBasePath = join(sourceRoot, 'packages/bundle/base/cordis.patch.yml')
const requireAlphaBaseline = process.env.DSH_REQUIRE_ALPHA_BASELINE === '1'
if (existsSync(sourceWebPath) && existsSync(sourceWebManifest) && existsSync(sourceBasePath)) {
  const sourceWebVersion = JSON.parse(readFileSync(sourceWebManifest, 'utf8')).version
  if (requireAlphaBaseline && sourceWebVersion !== '0.1.2-alpha.2') {
    throw new Error(`required alpha baseline is 0.1.2-alpha.2, got ${sourceWebVersion}`)
  }
  const resolver = prepareUpstreamSourceResolver(sourceRoot)
  baselines.push({
    label: `source web-app ${sourceWebVersion}`,
    version: sourceWebVersion,
    baseUrl: resolver.baseUrl,
    basePath: sourceBasePath,
    webPath: sourceWebPath,
  })
} else if (requireAlphaBaseline) {
  throw new Error(`required alpha baseline missing under ${sourceRoot}`)
}

const tuiPatches = loadPatch(tuiPath)
assert.ok(Array.isArray(tuiPatches), 'dsh-tui patch must be a top-level list')

const evaluateFor = (baseline, expression, entries = []) => evaluate({
  baseUrl: baseline.baseUrl,
  loader: { entries: () => entries },
}, expression)

const shared = [
  { id: 'storage', name: '@deepseek-ai/dsh-storage' },
  { id: 'storage-json', name: '@deepseek-ai/dsh-storage-json' },
  { id: 'storage-domain', name: '@deepseek-ai/dsh-storage-domain' },
  { id: 'workspace', name: '@deepseek-ai/dsh-workspace' },
  { id: 'code-runtime', name: '@deepseek-ai/dsh-code-runtime-worker-thread' },
  { id: 'subagent-model-selection-settings', name: '@deepseek-ai/dsh-tool-subagent/model-selection-settings' },
  { id: 'agent-presets', name: '@deepseek-ai/dsh-agent-presets' },
  { id: 'cordis-host-runner', name: '@deepseek-ai/dsh-cordis-host-runner' },
]

for (const baseline of baselines) {
  const alpha = baseline.version.startsWith('0.1.2-alpha.')
  const basePatches = baseline.basePath === undefined ? [] : loadPatch(baseline.basePath)
  const webPatches = loadPatch(baseline.webPath)
  assert.ok(Array.isArray(basePatches), `${baseline.label}: base patch must be a top-level list`)
  assert.ok(Array.isArray(webPatches), `${baseline.label}: web-app patch must be a top-level list`)

  const officialRows = insertedRows([...basePatches, ...webPatches])
  const composed = applyEntryPatches([], [...basePatches, ...webPatches, ...tuiPatches], () => {})
  const counts = new Map()
  for (const row of composed) {
    if (typeof row?.id !== 'string') continue
    counts.set(row.id, (counts.get(row.id) ?? 0) + 1)
  }
  const duplicates = [...counts].filter(([, count]) => count > 1).map(([id]) => id)
  assert.deepEqual(
    duplicates,
    [],
    `${baseline.label}: dsh-tui reuses official loader ids: ${duplicates.join(', ')}`,
  )

  for (const { id, name } of shared) {
    const officialExpected = officialRows.some(row => row?.id === id && row?.name === name)
    const official = composed.find(row => row?.id === id && row?.name === name)
    assert.equal(Boolean(official), officialExpected, `${baseline.label}: official ${id} ownership drifted`)

    const scopedId = `dsh-tui-${id}`
    const tuiRow = composed.find(row => row?.id === scopedId && row?.name === name)
    assert.ok(tuiRow, `${baseline.label}: dsh-tui patch must mount ${scopedId}`)
    assert.equal(typeof tuiRow.disabled, 'string', `${baseline.label}: ${scopedId} needs a !!js disabled expression`)
    assert.ok(
      tuiRow.disabled.includes(`entry.options.id === '${id}'`) && tuiRow.disabled.includes(`'${name}'`),
      `${baseline.label}: ${scopedId} must yield to ${id}/${name}`,
    )
    if (id === 'subagent-model-selection-settings') {
      assert.ok(
        tuiRow.disabled.includes("require.resolve('@deepseek-ai/dsh-tool-subagent/model-selection-settings')"),
        `${baseline.label}: ${scopedId} must probe its own package subpath`,
      )
      assert.equal(
        tuiRow.disabled.includes('plugin-package-inventory-deepseek'),
        false,
        `${baseline.label}: ${scopedId} must not use the optional package inventory row as a capability probe`,
      )

      const disabledInventory = [{
        options: {
          id: 'plugin-package-inventory-deepseek',
          name: '@deepseek-ai/dsh-plugin-package-inventory-deepseek',
        },
        disabled: true,
      }]
      assert.equal(
        Boolean(evaluateFor(baseline, tuiRow.disabled, disabledInventory)),
        !alpha,
        `${baseline.label}: ${scopedId} capability must follow the package export, not inventory state`,
      )
      if (alpha) {
        assert.equal(
          Boolean(evaluateFor(baseline, tuiRow.disabled, [{
            options: { id, name },
            disabled: false,
          }])),
          true,
          `${baseline.label}: ${scopedId} must yield to an enabled official row`,
        )
        assert.equal(
          Boolean(evaluateFor(baseline, tuiRow.disabled, [{
            options: { id, name },
            disabled: true,
          }])),
          false,
          `${baseline.label}: ${scopedId} may serve when the official row is disabled`,
        )
      }
    }
  }

  const commandGoalPatch = tuiPatches.find(row => row?.id === 'command-goal')
  assert.equal(typeof commandGoalPatch?.disabled, 'string', `${baseline.label}: command-goal needs a !!js condition`)
  assert.ok(
    commandGoalPatch.disabled.includes('.split(/\\r?\\n/u)'),
    `${baseline.label}: command-goal capability probe must accept LF and CRLF presets`,
  )
  assert.equal(
    Boolean(evaluateFor(baseline, commandGoalPatch.disabled)),
    alpha,
    `${baseline.label}: host command-goal must remain on for rc presets and yield to alpha shipped presets`,
  )

  const presetRow = composed.find(row => row?.id === 'dsh-tui-agent-presets')
  assert.equal(typeof presetRow?.config, 'string', `${baseline.label}: preset config needs a !!js generation condition`)
  const presetConfig = evaluateFor(baseline, presetRow.config)
  assert.equal(presetConfig?.default, 'standard', `${baseline.label}: standard remains the default preset`)
  assert.equal(
    Object.hasOwn(presetConfig ?? {}, 'roots'),
    !alpha,
    `${baseline.label}: rc needs the dsh CLI preset root; alpha must use agent-presets includeShippedRoot`,
  )
  if (!alpha) {
    assert.equal(Array.isArray(presetConfig.roots), true, `${baseline.label}: rc preset roots must be an array`)
    assert.equal(presetConfig.roots.length, 1, `${baseline.label}: rc needs exactly one system preset root`)
    assert.equal(presetConfig.roots[0]?.trust, 'system', `${baseline.label}: rc preset root must keep system trust`)
  }
}

console.log(`web coexistence OK (${baselines.map(({ label }) => label).join(' + ')})`)
