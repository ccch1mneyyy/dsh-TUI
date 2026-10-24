#!/usr/bin/env node
/** Cold/warm archive loading without credentials, a profile or Node on PATH.
 * Run after make-standalone-bundle --skip-pkg, or pass --binary <extracted executable>.
 * Use --out <directory> to retain compact diagnostics; failed scratch homes
 * are also preserved for inspection, without uploading the full runtime.
 * This verifies module loading; the Windows terminal smoke covers interaction.
 */
import assert from 'node:assert/strict'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runStandaloneProcess } from './lib/standalone-test-process.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const expected = {
  tui: JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version,
  dsh: readFileSync(join(root, 'src/dsh-adapter/contract.ts'), 'utf8')
    .match(/^export const UPSTREAM_VALIDATED_VERSION\s*=\s*'([^']+)'/m)?.[1],
}
assert.ok(expected.dsh, 'Missing primary DSH version')
const binaryIndex = process.argv.indexOf('--binary')
if (binaryIndex >= 0 && !process.argv[binaryIndex + 1]) throw new Error('--binary requires an executable path')
const binary = binaryIndex < 0 ? undefined : resolve(process.argv[binaryIndex + 1])
const outIndex = process.argv.indexOf('--out')
if (outIndex >= 0 && !process.argv[outIndex + 1]) throw new Error('--out requires a diagnostics directory')
const timeoutMs = 120_000
const scratch = mkdtempSync(join(tmpdir(), 'dsh-tui-standalone-'))
const out = outIndex < 0 ? join(scratch, 'diagnostics') : resolve(process.argv[outIndex + 1])
const home = join(scratch, '用户 home')
const workspace = join(home, '项目 workspace')
const cache = join(home, 'runtime cache')
const profileHome = join(home, 'standalone home')
const marker = join(cache, `tui-${expected.tui}-dsh-${expected.dsh}`, '.complete')
mkdirSync(workspace, { recursive: true })
mkdirSync(join(home, 'empty-bin'))
mkdirSync(out, { recursive: true })
// Keep only Windows process essentials. No inherited credentials, profiles,
// NODE_OPTIONS or global package resolution may make this check pass.
const env = Object.fromEntries(Object.entries(process.env)
  .filter(([key]) => /^(systemroot|systemdrive|windir|comspec|pathext)$/i.test(key)))
Object.assign(env, {
  HOME: home, USERPROFILE: home, TMP: scratch, TEMP: scratch, TMPDIR: scratch,
  PATH: join(home, 'empty-bin'), NODE_ENV: 'production', DSH_TELEMETRY_MODE: 'DISABLED',
  DSH_HOME: profileHome, DSH_TUI_STANDALONE_HOME: profileHome,
  DSH_TUI_STANDALONE_CACHE: cache, DSH_TUI_LANG: 'en',
})
const cacheState = () => ({
  completeMarkerPresent: existsSync(marker),
  entries: existsSync(cache) ? readdirSync(cache).sort().map(name => {
    const path = join(cache, name)
    const stat = lstatSync(path)
    return { name, type: stat.isDirectory() ? 'directory' : 'file', bytes: stat.isFile() ? stat.size : undefined,
      completeMarkerPresent: stat.isDirectory() ? existsSync(join(path, '.complete')) : undefined }
  }) : [],
})
let passed = false
try {
  let firstMarkerTime
  for (const mode of ['cold', 'warm']) {
    const start = performance.now()
    const result = await runStandaloneProcess(binary ?? process.execPath,
      [...(binary ? [] : [join(root, 'standalone/entry.mjs')]), '--self-test'],
      { cwd: workspace, env, timeoutMs, maxBuffer: 4 * 1024 * 1024 })
    // Capture output before asserting result.error: a timeout may have useful
    // extraction progress even though the child never reached its OK marker.
    const stdout = result.stdout ?? ''
    const stderr = result.stderr ?? ''
    const report = {
      mode, timeoutMs, elapsedMs: Math.round(performance.now() - start), scratch,
      status: result.status, signal: result.signal,
      error: result.error ? { code: result.error.code, message: result.error.message } : null,
      cleanup: result.cleanup,
      cache: cacheState(),
    }
    writeFileSync(join(out, `${mode}.stdout.log`), stdout)
    writeFileSync(join(out, `${mode}.stderr.log`), stderr)
    writeFileSync(join(out, `${mode}.result.json`), `${JSON.stringify(report, null, 2)}\n`)
    if (stdout) process.stdout.write(stdout)
    if (stderr) process.stderr.write(stderr)
    console.log(`DSH_TUI_STANDALONE_DIAGNOSTIC ${JSON.stringify(report)}`)
    assert.equal(result.error, undefined, `${mode}: ${result.error?.message}`)
    assert.equal(result.status, 0, `${mode}: standalone self-test failed\n${result.stdout}\n${result.stderr}`)
    const line = result.stdout.split(/\r?\n/).find(value => value.startsWith('DSH_TUI_STANDALONE_OK '))
    assert.ok(line, `${mode}: runtime did not report a successful plugin import`)
    assert.deepEqual(JSON.parse(line.slice('DSH_TUI_STANDALONE_OK '.length)), expected)
    assert.ok(existsSync(marker), `${mode}: extraction did not complete`)
    assert.ok(!existsSync(join(profileHome, 'profiles')), `${mode}: self-test created a user profile`)
    const markerTime = statSync(marker).mtimeMs
    if (mode === 'warm') assert.equal(markerTime, firstMarkerTime, 'Warm start extracted the runtime again')
    firstMarkerTime = markerTime
    console.log(`PASS: ${mode} standalone runtime import (${expected.tui}, DSH ${expected.dsh}; Unicode/space paths, empty PATH)`)
  }
  passed = true
} finally {
  if (passed) rmSync(scratch, { recursive: true, force: true })
  else console.error(`Standalone verification failed; isolated runtime retained at ${scratch}; diagnostics: ${out}`)
}
