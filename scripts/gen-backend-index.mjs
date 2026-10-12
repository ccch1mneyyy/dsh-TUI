#!/usr/bin/env node
/**
 * Build the backend index: scan `src/backends/<id>/manifest.ts` and emit the
 * module the runtime registry seeds itself from (roadmap Stage A / P0, D3).
 *
 *   node --import tsx/esm scripts/gen-backend-index.mjs
 *   node --import tsx/esm scripts/gen-backend-index.mjs --dir <dir> --out <file>
 *      (the regression drives a throwaway fixture tree; both default to the
 *       repo's own paths)
 *
 * Why an index and not runtime discovery: readdir over `lib/` silently reads
 * empty after bundling or in a snapshot build, and a silently missing backend is
 * exactly the failure mode a picker cannot report. The index is a static import
 * per backend, so a missing one fails the build (fail loud) instead.
 *
 * Why it writes into `src/`: `lib/` is generated *by* tsc, so a file written
 * there is invisible to the compiler — `src/dsh-adapter/backend-registry.ts`
 * imports this module and must be type-checked against the real manifests.
 *
 * Why the output is **committed**: the CI test groups and the `gates` job reuse
 * the build artifact and deliberately do not compile, so a gitignored file under
 * `src/` does not exist there and every script that reaches the registry dies on
 * a missing module. Like `src/backends/codex/protocol/generated/`, this is a
 * generated file that ships in the tree; `pnpm compile` refreshes it (the
 * generator runs *before* tsc, so the emitted lib copy is fresh too) and
 * `--check` fails when the committed copy is out of date (the registry gate runs
 * it where nothing compiled).
 *
 * What it emits, per entry:
 *   - a **static** import of the manifest (pure data, zero runtime imports);
 *   - a **dynamic** `load: () => import(...)` returning the whole module
 *     namespace — not `.then(m => m.backend)` — because the registry resolves
 *     both `backendExport` and `unloadExport` from it, which is what keeps the
 *     "never loaded ⇒ never imported, never closed" property (D4). Emitting a
 *     value here would smuggle hand-written semantics back into a file whose
 *     only safety argument is "mechanical scan and emit, zero judgement".
 *
 * Every manifest is validated before a byte is written: a misdeclared backend
 * stops `pnpm compile` instead of quietly vanishing from the picker.
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = fileURLToPath(new URL('../', import.meta.url))

/** A manifest is a backend entry iff its directory also has an implementation
 *  barrel; `src/backends/shared/` has helpers but no `index.ts`. */
const BACKEND_ENTRY_FILE = 'index.ts'
const MANIFEST_FILE = 'manifest.ts'
const MANIFEST_EXPORT = 'manifest'

const flag = (name, fallback) => {
  const index = process.argv.indexOf(name)
  return index < 0 ? fallback : process.argv[index + 1]
}
const backendsDir = resolve(ROOT, flag('--dir', 'src/backends'))
const outputFile = resolve(ROOT, flag('--out', 'src/dsh-adapter/backends.generated.ts'))

/** Import specifier for a compiled module, relative to the emitted file. */
const specifierFor = (fromFile, targetFile) => {
  const path = relative(dirname(fromFile), targetFile).split(sep).join('/').replace(/\.tsx?$/u, '.js')
  return path.startsWith('.') ? path : `./${path}`
}

const problems = []
const fail = (message) => problems.push(message)

const isPlainObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)
const isNonEmptyString = (value) => typeof value === 'string' && value.trim() !== ''
const identifier = /^[A-Za-z_$][\w$]*$/u

/** Directories that carry both an implementation barrel and a manifest, sorted
 *  by name: entry order IS picker order, so it must not depend on the fs. */
const backendNames = () => {
  const names = []
  for (const entry of readdirSync(backendsDir)) {
    const dir = resolve(backendsDir, entry)
    if (!statSync(dir).isDirectory()) continue
    const has = (file) => {
      try {
        return statSync(resolve(dir, file)).isFile()
      } catch {
        return false
      }
    }
    if (has(BACKEND_ENTRY_FILE) && !has(MANIFEST_FILE)) {
      fail(`src/backends/${entry}/ has an ${BACKEND_ENTRY_FILE} but no ${MANIFEST_FILE}`)
      continue
    }
    if (has(MANIFEST_FILE)) names.push(entry)
  }
  return names.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
}

/** Load one manifest through tsx and check every fact the emitted index and the
 *  registry rely on. Returns undefined when the manifest is unusable. */
const readManifest = async (name) => {
  const file = resolve(backendsDir, name, MANIFEST_FILE)
  let module
  try {
    module = await import(pathToFileURL(file).href)
  } catch (error) {
    fail(`src/backends/${name}/${MANIFEST_FILE} failed to import (${error instanceof Error ? error.message : String(error)})`)
    return undefined
  }
  const manifest = module[MANIFEST_EXPORT]
  if (!isPlainObject(manifest)) {
    fail(`src/backends/${name}/${MANIFEST_FILE} must export \`${MANIFEST_EXPORT}\``)
    return undefined
  }
  if (manifest.id !== name) fail(`src/backends/${name}/${MANIFEST_FILE}: id "${String(manifest.id)}" must equal the directory name`)
  if (typeof manifest.inTree !== 'boolean') fail(`src/backends/${name}/${MANIFEST_FILE}: inTree must be a boolean`)
  if (!isNonEmptyString(manifest.shortLabel)) fail(`src/backends/${name}/${MANIFEST_FILE}: shortLabel must be a non-empty string`)
  const label = manifest.label
  if (!isPlainObject(label) || (label.kind !== 'key' && label.kind !== 'literal')) {
    fail(`src/backends/${name}/${MANIFEST_FILE}: label must be { kind: 'key' | 'literal', … }`)
  } else if (label.kind === 'key' ? !isNonEmptyString(label.key) : !isNonEmptyString(label.text)) {
    fail(`src/backends/${name}/${MANIFEST_FILE}: label.${label.kind === 'key' ? 'key' : 'text'} must be a non-empty string`)
  }
  if (manifest.backendExport !== undefined && !(isNonEmptyString(manifest.backendExport) && identifier.test(manifest.backendExport))) {
    fail(`src/backends/${name}/${MANIFEST_FILE}: backendExport must be an export name`)
  }
  if (manifest.unloadExport !== undefined && !(isNonEmptyString(manifest.unloadExport) && identifier.test(manifest.unloadExport))) {
    fail(`src/backends/${name}/${MANIFEST_FILE}: unloadExport must be an export name`)
  }
  if (manifest.nativeKey !== undefined && !isNonEmptyString(manifest.nativeKey)) {
    fail(`src/backends/${name}/${MANIFEST_FILE}: nativeKey must be a non-empty string when present`)
  }
  if (manifest.vendorPackages !== undefined && !(Array.isArray(manifest.vendorPackages) && manifest.vendorPackages.every(isNonEmptyString))) {
    fail(`src/backends/${name}/${MANIFEST_FILE}: vendorPackages must be a list of package prefixes`)
  }
  // Shape only (B-1): whether the host implements the named executor is a runtime
  // fact, decided by the registry's table lookup, so this generator must not have
  // an opinion about the value — only about the fields being there at all.
  if (manifest.install !== undefined
    && !(isPlainObject(manifest.install)
      && isNonEmptyString(manifest.install.executor)
      && isNonEmptyString(manifest.install.specifier)
      && isNonEmptyString(manifest.install.version))) {
    fail(`src/backends/${name}/${MANIFEST_FILE}: install needs a non-empty executor, specifier and version`)
  }
  return manifest
}

const names = backendNames()
const manifests = []
for (const name of names) {
  const manifest = await readManifest(name)
  if (manifest !== undefined) manifests.push({ name, manifest })
}

if (manifests.length === 0 && problems.length === 0) fail(`${backendsDir} holds no backend manifest`)
if (problems.length > 0) {
  console.error('backend index not generated:')
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exit(1)
}

/** A local binding name for a directory name (`my-backend` is not one). */
const localName = (name) => {
  const cleaned = name.replace(/[^A-Za-z0-9_$]/gu, '_')
  return `${/^[0-9]/u.test(cleaned) ? '_' : ''}${cleaned}Manifest`
}
const manifestImports = manifests.map(({ name }) =>
  `import { ${MANIFEST_EXPORT} as ${localName(name)} } from '${specifierFor(outputFile, resolve(backendsDir, name, MANIFEST_FILE))}'`)
const entries = manifests.map(({ name }) =>
  `  { manifest: ${localName(name)}, load: () => import('${specifierFor(outputFile, resolve(backendsDir, name, BACKEND_ENTRY_FILE))}') },`)

const emitted = `/**
 * GENERATED by scripts/gen-backend-index.mjs — do not edit.
 * ${manifests.length} backend manifest(s) in directory-name order (picker order):
 * ${manifests.map(({ name }) => name).join(', ')}.
 *
 * \`pnpm compile\` refreshes this file: commit the result. It is checked in
 * because the CI test groups restore the build artifact instead of compiling, and
 * the registry imports it from \`src/\` (see the generator for the whole story).
 */
import type { BackendEntry } from '../agent/backend-manifest.js'
${manifestImports.join('\n')}

export const GENERATED_BACKENDS: readonly BackendEntry[] = [
${entries.join('\n')}
]
`

if (process.argv.includes('--check')) {
  let current = ''
  try {
    current = readFileSync(outputFile, 'utf8')
  } catch {
    current = ''
  }
  if (current !== emitted) {
    console.error(`${relative(ROOT, outputFile)} is stale; run \`pnpm compile\` and commit the result`)
    process.exit(1)
  }
} else {
  writeFileSync(outputFile, emitted, 'utf8')
}
console.log(`backend index: ${manifests.length} entr${manifests.length === 1 ? 'y' : 'ies'} (${manifests.map(({ name }) => name).join(', ')}) -> ${relative(ROOT, outputFile)}`)
