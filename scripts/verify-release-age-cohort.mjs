/** Run: node scripts/verify-release-age-cohort.mjs [--write]
 * Exempt exactly the locked DeepSeek package/version cohort, including the legacy
 * SQLite island. Remove historical exemptions when they leave the lockfile.
 */
import assert from 'node:assert/strict'
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse, stringify } from 'yaml'
const lock = parse(readFileSync('pnpm-lock.yaml', 'utf8'))
const versions = new Map()
for (const key of Object.keys(lock.packages)) {
  const match = /^(@deepseek-ai\/[^@]+)@([^()]+)$/.exec(key)
  if (!match) continue
  const set = versions.get(match[1]) ?? new Set()
  set.add(match[2])
  versions.set(match[1], set)
}
const expected = [...versions].sort(([a], [b]) => a.localeCompare(b)).map(([name, set]) => `${name}@${[...set].sort().join(' || ')}`)
const path = 'pnpm-workspace.yaml'
let source = readFileSync(path, 'utf8')
if (process.argv.includes('--write')) {
  const start = source.indexOf('minimumReleaseAgeExclude:')
  const tail = parse(source.slice(start)).minimumReleaseAgeExclude.filter(item => !item.startsWith('@deepseek-ai/'))
  source = source.slice(0, start) + stringify({ minimumReleaseAgeExclude: [...expected, ...tail] })
  writeFileSync(path, source)
}
const workspace = parse(source)
assert.equal(workspace.minimumReleaseAge, 1440)
assert.deepEqual(workspace.minimumReleaseAgeExclude.filter(item => item.startsWith('@deepseek-ai/')), expected)
if (!process.argv.includes('--write')) {
  // Exercise the maintenance CLI itself; repeated writes must preserve valid YAML.
  const fixture = mkdtempSync(join(tmpdir(), 'release-age-cohort-'))
  try {
    for (const file of ['pnpm-lock.yaml', path]) copyFileSync(file, join(fixture, file))
    for (let run = 0; run < 2; run++) {
      execFileSync(process.execPath, [fileURLToPath(import.meta.url), '--write'], { cwd: fixture })
      assert.equal(readFileSync(join(fixture, path), 'utf8'), source, 'regeneration must be idempotent')
    }
  } finally { rmSync(fixture, { recursive: true, force: true }) }
}
console.log(`PASS: exact release-age exemptions for ${expected.length} locked packages; 24h delay retained`)
