import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'

function readManifest(path, label) {
  const manifest = JSON.parse(readFileSync(path, 'utf8'))
  if (typeof manifest?.name !== 'string' || typeof manifest?.version !== 'string') {
    throw new Error(`${label} manifest is missing name/version`)
  }
  return manifest
}

function copyManifest(sourcePath, targetDir, label) {
  const manifest = readManifest(sourcePath, label)
  mkdirSync(targetDir, { recursive: true })
  writeFileSync(join(targetDir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  return manifest
}

function safeExportPath(packageRoot, target, label) {
  if (typeof target !== 'string' || !target.startsWith('./')) {
    throw new Error(`${label} must be a relative package export`)
  }
  const path = resolve(packageRoot, target)
  const inside = relative(packageRoot, path)
  if (inside === '' || inside.startsWith(`..${sep}`) || inside === '..') {
    throw new Error(`${label} escapes its package root`)
  }
  return path
}

/**
 * Build a tiny package-resolution tree for source-only upstream checkouts.
 *
 * Alpha is not published to npm and its checkout does not contain generated
 * lib/. The production patch deliberately probes package exports with
 * require.resolve(), so the verifier materializes only the declared export
 * target after first checking that its TypeScript source exists. Preset files
 * are copied from the real checkout; no product code is replaced by a mock.
 */
export function prepareUpstreamSourceResolver(sourceRoot) {
  const tempRoot = mkdtempSync(join(tmpdir(), 'dsh-tui-upstream-resolver-'))
  const scopeRoot = join(tempRoot, 'node_modules', '@deepseek-ai')

  const presetsSource = join(sourceRoot, 'packages/preset/agent-presets')
  const presetsTarget = join(scopeRoot, 'dsh-agent-presets')
  copyManifest(join(presetsSource, 'package.json'), presetsTarget, 'dsh-agent-presets')
  const shippedPresets = join(presetsSource, 'presets')
  if (!existsSync(shippedPresets)) throw new Error('dsh-agent-presets source has no shipped presets')
  cpSync(shippedPresets, join(presetsTarget, 'presets'), { recursive: true })

  const subagentSource = join(sourceRoot, 'packages/subagent/tool-subagent')
  const subagentTarget = join(scopeRoot, 'dsh-tool-subagent')
  const subagentManifest = copyManifest(
    join(subagentSource, 'package.json'),
    subagentTarget,
    'dsh-tool-subagent',
  )
  const exportEntry = subagentManifest.exports?.['./model-selection-settings']
  const exportTarget = typeof exportEntry === 'string' ? exportEntry : exportEntry?.default
  const sourceName = `${basename(exportTarget ?? '', '.js')}.ts`
  if (!existsSync(join(subagentSource, 'src', sourceName))) {
    throw new Error('dsh-tool-subagent model-selection-settings export has no matching source')
  }
  const materializedExport = safeExportPath(
    subagentTarget,
    exportTarget,
    'dsh-tool-subagent model-selection-settings export',
  )
  mkdirSync(dirname(materializedExport), { recursive: true })
  writeFileSync(materializedExport, 'export {}\n')

  const sourceWebManifest = readManifest(
    join(sourceRoot, 'packages/bundle/web-app/package.json'),
    'dsh-web-app',
  )
  const resolverManifest = join(scopeRoot, 'dsh-web-app', 'package.json')
  mkdirSync(dirname(resolverManifest), { recursive: true })
  writeFileSync(resolverManifest, `${JSON.stringify({
    name: sourceWebManifest.name,
    version: sourceWebManifest.version,
    type: 'module',
  }, null, 2)}\n`)

  let cleaned = false
  const cleanup = () => {
    if (cleaned) return
    cleaned = true
    rmSync(tempRoot, { recursive: true, force: true })
  }
  process.once('exit', cleanup)
  return { baseUrl: pathToFileURL(resolverManifest).href, cleanup }
}
