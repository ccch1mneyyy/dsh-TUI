/**
 * Capture the projection goldens (docs/agent-backend-design.md §6.4; the
 * committed ones are the Phase 0 capture of the pre-split reducer): runs
 * every DSH fixture through the DSH translator + shared projector (pipeline
 * and determinism rules in scripts/lib/projection-golden.ts) and writes
 * `scripts/fixtures/dsh/<fixture>[.<variant>].golden.json`.
 *
 * Refuses to write when a fixture drifted from its generator or when live and
 * replay differ somewhere no documented reason covers — a golden must never
 * bless a projection inconsistency. `verify-projection-golden.ts` is the
 * comparing counterpart (and `--update` there does the same as this script).
 *
 * Run: node --import tsx/esm scripts/capture-projection-golden.ts
 */
import { buildGolden, goldenPath, goldenVariants, staleFixtureFiles, writeGolden } from './lib/projection-golden.js'
import { relative } from 'node:path'

const stale = staleFixtureFiles()
if (stale.length > 0) {
  console.error('fixtures differ from scripts/fixtures/dsh/generate.ts; regenerate them first:')
  for (const path of stale) console.error(`  - ${relative(process.cwd(), path)}`)
  process.exit(1)
}

const builds = goldenVariants().map(variant => ({ variant, ...buildGolden(variant) }))
const unexplained = builds.flatMap(build => build.unexplained.map(path => `${build.variant.fixture}/${build.variant.variant}: ${path}`))
if (unexplained.length > 0) {
  console.error('live and replay differ with no documented reason; nothing written:')
  for (const line of unexplained) console.error(`  - ${line}`)
  process.exit(1)
}
for (const { variant, golden } of builds) {
  writeGolden(variant, golden)
  console.log(`wrote ${relative(process.cwd(), goldenPath(variant))}`)
}
