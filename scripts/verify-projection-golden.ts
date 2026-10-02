/**
 * Projection golden gate (docs/agent-backend-design.md §6.4): replays every
 * DSH fixture in scripts/fixtures/dsh/ through the DSH translator + shared
 * projector (replay and live paths, pipeline in
 * scripts/lib/projection-golden.ts) and deep-compares the result with the
 * committed `*.golden.json`, captured in Phase 0 from the pre-split reducer.
 * The split pipeline must keep this gate green without touching a golden.
 *
 * Fails when: a fixture file drifted from scripts/fixtures/dsh/generate.ts; a
 * golden is missing, orphaned or differs (the first differing paths are
 * printed with both values); or live differs from replay somewhere no
 * documented reason covers.
 *
 * Run: node --import tsx/esm scripts/verify-projection-golden.ts [--update]
 * (`--update` rewrites the goldens instead of comparing — review the diff.)
 */
import { buildGolden, diffPaths, goldenPath, goldenVariants, orphanGoldens, readGolden, staleFixtureFiles, valueAt, writeGolden } from './lib/projection-golden.js'
import { relative } from 'node:path'

const update = process.argv.includes('--update')
const failures: string[] = []
const show = (value: unknown): string => {
  const text = JSON.stringify(value) ?? 'undefined'
  return text.length > 160 ? `${text.slice(0, 160)}…` : text
}
const label = (path: string): string => relative(process.cwd(), path)

for (const path of staleFixtureFiles()) failures.push(`${label(path)} differs from scripts/fixtures/dsh/generate.ts output (re-run the generator)`)

const variants = goldenVariants()
let rows = 0
let liveDifferences = 0
for (const variant of variants) {
  const { golden, unexplained } = buildGolden(variant)
  const file = label(goldenPath(variant))
  for (const path of unexplained) failures.push(`${file}: live and replay differ at ${path} with no documented reason`)
  if (typeof golden === 'object' && golden !== null && !Array.isArray(golden)) {
    rows += Array.isArray(golden.rows) ? golden.rows.length : 0
    liveDifferences += Array.isArray(golden.liveDiff) ? golden.liveDiff.length : 0
  }
  if (update) {
    if (unexplained.length === 0) writeGolden(variant, golden)
    continue
  }
  const committed = readGolden(variant)
  if (committed === undefined) {
    failures.push(`${file} is missing (run with --update after reviewing the fixture)`)
    continue
  }
  const paths = diffPaths(committed, golden)
  if (paths.length === 0) continue
  failures.push(`${file}: ${paths.length} differing path(s)`)
  for (const path of paths.slice(0, 25)) {
    failures.push(`    ${path}\n      golden: ${show(valueAt(committed, path))}\n      actual: ${show(valueAt(golden, path))}`)
  }
  if (paths.length > 25) failures.push(`    … ${paths.length - 25} more`)
}
if (!update) for (const path of orphanGoldens()) failures.push(`${label(path)} has no fixture variant any more (delete it)`)

if (failures.length > 0) {
  console.error(`projection golden ${update ? 'update' : 'check'} FAILED:`)
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}
console.log(`projection golden ${update ? 'updated' : 'OK'} (${variants.length} goldens, ${rows} replay rows, ${liveDifferences} documented live differences)`)
