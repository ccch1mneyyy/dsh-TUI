/**
 * CI gate for the upstream compatibility contract: fails when any blessed
 * official package is installed at a version other than the validated
 * release line, so a mismatched install breaks CI before user machines.
 *
 * Run via `node --import tsx/esm scripts/verify-upstream-contract.ts`.
 */
import assert from 'node:assert/strict'

const {
  compareVersions,
  installedUpstreamLines,
  parseUpstreamVersion,
  upstreamDrift,
  upstreamDriftSummary,
  UPSTREAM_BLESSED_PACKAGES,
  UPSTREAM_FRAMEWORK_MAJORS,
  UPSTREAM_VALIDATED_LABEL,
} = await import('../src/dsh-adapter/contract.js')

const alpha = parseUpstreamVersion('0.1.2-alpha.2')!
const beta = parseUpstreamVersion('0.1.2-beta.1')!
const rc = parseUpstreamVersion('0.1.2-rc.1')!
assert.deepEqual(alpha, [0, 1, 2, 'alpha', 2])
assert.ok(compareVersions(alpha, beta) < 0 && compareVersions(beta, rc) < 0)
assert.ok(compareVersions(rc, parseUpstreamVersion('0.1.1-rc.2')!) > 0)
assert.equal(parseUpstreamVersion('0.1.2'), undefined)
assert.match(UPSTREAM_VALIDATED_LABEL, /0\.1\.2-alpha\.2/u)

const mixedVersions = Object.fromEntries(UPSTREAM_BLESSED_PACKAGES.map(packageName => [
  packageName,
  UPSTREAM_FRAMEWORK_MAJORS[packageName] === 4
    ? '4.0.1'
    : UPSTREAM_FRAMEWORK_MAJORS[packageName] === 3
      ? '3.18.1'
      : '0.1.1-rc.2',
]))
mixedVersions['@deepseek-ai/dsh-agent'] = '0.1.2-alpha.2'
assert.deepEqual(installedUpstreamLines(mixedVersions), ['0.1.1-rc.2', '0.1.2-alpha.2'])
assert.deepEqual(upstreamDrift(mixedVersions), [])
assert.deepEqual(upstreamDriftSummary(mixedVersions), {
  kind: 'mixed',
  versions: ['0.1.1-rc.2', '0.1.2-alpha.2'],
})

const installedLines = installedUpstreamLines()
const drift = upstreamDrift()
if (installedLines.length > 1) {
  console.error(`Upstream contract violated (mixed harness lines: ${installedLines.join(', ')})`)
}
if (drift.length > 0) {
  console.error(`Upstream contract violated (validated: ${UPSTREAM_VALIDATED_LABEL}):`)
  for (const entry of drift) {
    console.error(`  - ${entry.package}: installed=${entry.installed ?? 'missing'}`)
  }
}
if (installedLines.length > 1 || drift.length > 0) process.exit(1)
console.log(`upstream contract OK (validated: ${UPSTREAM_VALIDATED_LABEL})`)
