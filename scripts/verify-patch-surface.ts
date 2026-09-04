/**
 * Patch-surface contract for the TUI bundle overlay.
 *
 * TUI-owned inserts/config overrides are one fixed snapshot. Comparisons with
 * the official web patch are keyed by web-app version because ownership moved
 * between rc.2 and alpha.1. Dynamic disabled conditions are evaluated from
 * each baseline's package root so the snapshot records effective ownership,
 * not the raw YAML representation. The installed package is always checked; a
 * source-authoritative prerelease tree is checked too when present. CI sets
 * DSH_REQUIRE_ALPHA_BASELINE=1 so that baseline can never be skipped.
 *
 * Run via `node --import tsx/esm scripts/verify-patch-surface.ts`.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { evaluate } from '@deepseek-ai/cordis-plugin-loader'
import { parse as parseYaml } from 'yaml'
import { prepareUpstreamSourceResolver } from './upstream-source-baseline.mjs'

const root = resolve(import.meta.dirname, '..')
const tuiPatchPath = join(root, 'cordis.patch.yml')
const snapshotPath = join(root, 'patch-surface.snapshot.json')

interface ParsedPatch {
  /** Top-level rows with id and optional disabled/config. */
  overrides: Array<{ id: string; disabled: boolean | string; hasConfig: boolean }>
  /** Rows listed inside `- insert:` blocks. */
  inserts: Array<{ id: string }>
}

interface WebComparison {
  /** Rows the TUI disables that this web-app version does not. */
  disablesBeyondWebApp: string[]
  /** Rows this web-app version disables that the TUI does not. */
  webAppDisablesBeyondTui: string[]
  /** Loader ids inserted by both patches; this must stay empty. */
  insertsSharedWithWebApp: string[]
}

interface Snapshot {
  inserts: string[]
  configOverrides: string[]
  webAppComparisons: Record<string, WebComparison>
}

interface WebBaseline {
  label: string
  version: string
  baseUrl: string
  patch: ParsedPatch
}

function parsePatch(text: string): ParsedPatch {
  const doc = parseYaml(text) as unknown
  const overrides: ParsedPatch['overrides'] = []
  const inserts: ParsedPatch['inserts'] = []
  if (!Array.isArray(doc)) throw new Error('patch root is not a list')
  for (const item of doc) {
    if (item === null || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    if (Array.isArray(record.insert)) {
      for (const row of record.insert) {
        if (row !== null && typeof row === 'object' && typeof (row as Record<string, unknown>).id === 'string') {
          inserts.push({ id: (row as Record<string, unknown>).id as string })
        }
      }
      continue
    }
    if (typeof record.id === 'string') {
      overrides.push({
        id: record.id,
        disabled: record.disabled === true || typeof record.disabled === 'string'
          ? record.disabled
          : false,
        hasConfig: 'config' in record,
      })
    }
  }
  return { overrides, inserts }
}

function resolvedPackageFile(specifier: string): string {
  const path = import.meta.resolve(specifier)
  return path.startsWith('file:') ? fileURLToPath(path) : path
}

function isMissingModuleError(error: unknown): boolean {
  if (error === null || typeof error !== 'object') return false
  const code = (error as { code?: unknown }).code
  return code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND'
}

function baseline(label: string, manifestPath: string, patchPath: string, baseUrl?: string): WebBaseline {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { version?: unknown }
  if (typeof manifest.version !== 'string' || manifest.version.length === 0) {
    throw new Error(`${label} web-app manifest has no version`)
  }
  return {
    label,
    version: manifest.version,
    baseUrl: baseUrl ?? pathToFileURL(manifestPath).href,
    patch: parsePatch(readFileSync(patchPath, 'utf8')),
  }
}

function disabledIds(patch: ParsedPatch, baseUrl: string): Set<string> {
  return new Set(patch.overrides.filter(row => {
    if (row.disabled === true) return true
    if (typeof row.disabled !== 'string') return false
    return Boolean(evaluate({ baseUrl, loader: { entries: () => [] } }, row.disabled))
  }).map(row => row.id))
}

function comparison(tui: ParsedPatch, webApp: WebBaseline): WebComparison {
  const tuiDisableSet = disabledIds(tui, webApp.baseUrl)
  const webDisableSet = disabledIds(webApp.patch, webApp.baseUrl)
  const webAppPatch = webApp.patch
  const webInsertSet = new Set(webAppPatch.inserts.map(row => row.id))
  return {
    disablesBeyondWebApp: tui.overrides
      .filter(row => tuiDisableSet.has(row.id) && !webDisableSet.has(row.id))
      .map(row => row.id),
    webAppDisablesBeyondTui: webAppPatch.overrides
      .filter(row => webDisableSet.has(row.id) && !tuiDisableSet.has(row.id))
      .map(row => row.id),
    insertsSharedWithWebApp: tui.inserts.filter(row => webInsertSet.has(row.id)).map(row => row.id),
  }
}

if (!existsSync(tuiPatchPath)) {
  console.error('cordis.patch.yml missing')
  process.exit(1)
}
const tui = parsePatch(readFileSync(tuiPatchPath, 'utf8'))
const baselines: WebBaseline[] = []

let installedManifest: string | undefined
try {
  installedManifest = resolvedPackageFile('@deepseek-ai/dsh-web-app/package.json')
} catch (error) {
  if (!isMissingModuleError(error)) throw error
  console.warn('@deepseek-ai/dsh-web-app not installed — skipping installed web-app comparison')
}
if (installedManifest !== undefined) {
  baselines.push(baseline(
    'installed',
    installedManifest,
    resolvedPackageFile('@deepseek-ai/dsh-web-app/cordis.patch.yml'),
  ))
}

const sourceRoot = resolve(process.env.DSH_HARNESS_SOURCE_ROOT ?? resolve(root, '../deepseek-harness'))
const sourceManifest = join(sourceRoot, 'packages/bundle/web-app/package.json')
const sourcePatch = join(sourceRoot, 'packages/bundle/web-app/cordis.patch.yml')
const requireSourceBaseline = process.env.DSH_REQUIRE_ALPHA_BASELINE === '1'
if (existsSync(sourceManifest) && existsSync(sourcePatch)) {
  const resolver = prepareUpstreamSourceResolver(sourceRoot)
  const source = baseline('source', sourceManifest, sourcePatch, resolver.baseUrl)
  if (requireSourceBaseline && source.version !== '0.1.2-rc.1') {
    throw new Error(`required source baseline is 0.1.2-rc.1, got ${source.version}`)
  }
  baselines.push(source)
} else if (requireSourceBaseline) {
  throw new Error(`required source baseline missing under ${sourceRoot}`)
}

const ownSurface = {
  inserts: tui.inserts.map(row => row.id),
  configOverrides: tui.overrides.filter(row => !row.disabled && row.hasConfig).map(row => row.id),
}
const liveComparisons = new Map<string, WebComparison>()
for (const webApp of baselines) {
  const value = comparison(tui, webApp)
  if (value.insertsSharedWithWebApp.length > 0) {
    console.error(
      `patch-surface: TUI inserts reuse ${webApp.label} web-app ${webApp.version} ids: `
      + value.insertsSharedWithWebApp.join(', '),
    )
    process.exit(1)
  }
  const previous = liveComparisons.get(webApp.version)
  if (previous !== undefined && JSON.stringify(previous) !== JSON.stringify(value)) {
    console.error(`patch-surface: ${webApp.version} differs between installed and sibling baselines`)
    process.exit(1)
  }
  liveComparisons.set(webApp.version, value)
}

const mode = process.argv[2]
if (mode === '--snapshot') {
  if (baselines.length === 0) {
    console.error('refusing to snapshot without any @deepseek-ai/dsh-web-app baseline')
    process.exit(1)
  }
  let retained: Record<string, WebComparison> = {}
  if (existsSync(snapshotPath)) {
    const previous = JSON.parse(readFileSync(snapshotPath, 'utf8')) as Partial<Snapshot>
    retained = previous.webAppComparisons ?? {}
  }
  const next: Snapshot = {
    ...ownSurface,
    webAppComparisons: {
      ...retained,
      ...Object.fromEntries(liveComparisons),
    },
  }
  writeFileSync(snapshotPath, `${JSON.stringify(next, null, 2)}\n`)
  console.log(`patch-surface snapshot written: ${snapshotPath}`)
  process.exit(0)
}

if (!existsSync(snapshotPath)) {
  console.error('patch-surface.snapshot.json missing — run this script with --snapshot')
  process.exit(1)
}
const recorded = JSON.parse(readFileSync(snapshotPath, 'utf8')) as Snapshot
const failures: string[] = []
if (JSON.stringify(recorded.inserts) !== JSON.stringify(ownSurface.inserts)) failures.push('TUI inserts')
if (JSON.stringify(recorded.configOverrides) !== JSON.stringify(ownSurface.configOverrides)) failures.push('TUI config overrides')
for (const webApp of baselines) {
  const expected = recorded.webAppComparisons?.[webApp.version]
  const actual = liveComparisons.get(webApp.version)!
  if (expected === undefined) {
    failures.push(`${webApp.label} web-app ${webApp.version} has no recorded comparison`)
  } else if (JSON.stringify(expected) !== JSON.stringify(actual)) {
    failures.push(`${webApp.label} web-app ${webApp.version} comparison`)
  }
}

if (failures.length === 0) {
  console.log(
    `patch-surface OK (${ownSurface.inserts.length} inserts, `
    + `${ownSurface.configOverrides.length} config overrides; `
    + `${baselines.map(({ label, version }) => `${label} ${version}`).join(' + ') || 'no web baseline'})`,
  )
  process.exit(0)
}
console.error(`patch-surface drifted: ${failures.join(', ')}`)
console.error('Review the diff, then regenerate: node --import tsx/esm scripts/verify-patch-surface.ts --snapshot')
process.exit(1)
