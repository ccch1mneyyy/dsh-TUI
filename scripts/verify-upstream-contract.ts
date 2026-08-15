/**
 * CI gate for the upstream compatibility contract: fails when any blessed
 * official package is installed at a version other than the validated
 * release line, so a mismatched install breaks CI before user machines.
 *
 * Run via `node --import tsx/esm scripts/verify-upstream-contract.ts`.
 */
const { upstreamDrift, UPSTREAM_VALIDATED_VERSION } = await import('../src/dsh-adapter/contract.js')

const drift = upstreamDrift()
if (drift.length > 0) {
  console.error(`Upstream contract violated (validated: ${UPSTREAM_VALIDATED_VERSION}):`)
  for (const entry of drift) {
    console.error(`  - ${entry.package}: installed=${entry.installed ?? 'missing'}`)
  }
  process.exit(1)
}
console.log(`upstream contract OK (validated: ${UPSTREAM_VALIDATED_VERSION})`)
