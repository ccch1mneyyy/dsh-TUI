/** Host discovery through actual owned Vite+ dispatcher/metadata layouts.
 * POSIX file symlinks; Windows file hardlinks and a directory junction.
 * Does not execute Vite+, install globals, or compose a full DSH host.
 * Run: node --import tsx/esm scripts/verify-vite-plus-host.ts
 */
import './lib/fake-home.mjs'
import assert from 'node:assert/strict'
import { linkSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmdirSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const { findHostDsh } = await import(process.argv.includes('--compiled')
  ? '../lib/types/dsh-adapter/host-dsh.js'
  : '../src/dsh-adapter/host-dsh.js') as typeof import('../src/dsh-adapter/host-dsh.js')

let passed = 0
const check = (label: string, ok: boolean, detail?: unknown): void => {
  assert.ok(ok, `${label}: ${JSON.stringify(detail)}`)
  passed += 1
  console.log(`PASS ${label}`)
}
const root = realpathSync(mkdtempSync(join(tmpdir(), 'verify-vite-plus-host-')))
const located = (dir: string): ReturnType<typeof findHostDsh> => findHostDsh({ PATH: dir })
const vpExecutable = process.platform === 'win32' ? 'vp.exe' : 'vp'
const dshExecutable = process.platform === 'win32' ? 'dsh.exe' : 'dsh'
try {
// Vite+ dispatches by argv[0]. Its two registries select an active install,
// even when the package store also contains another copy of that version.
const vpRoot = join(root, 'vite-plus')
const vpVersion = join(vpRoot, '1.4.0')
mkdirSync(join(vpVersion, 'bin'), { recursive: true })
writeFileSync(join(vpVersion, 'bin', vpExecutable), Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 0]))
symlinkSync(vpVersion, join(vpRoot, 'current'), process.platform === 'win32' ? 'junction' : 'dir')
mkdirSync(join(vpRoot, 'bin'), { recursive: true })
for (const name of [vpExecutable, dshExecutable]) {
  const target = join(vpRoot, 'current', 'bin', vpExecutable)
  if (process.platform === 'win32') linkSync(target, join(vpRoot, 'bin', name))
  else symlinkSync(target, join(vpRoot, 'bin', name))
}
mkdirSync(join(vpRoot, 'bins'), { recursive: true })
mkdirSync(join(vpRoot, 'packages', '@deepseek-ai'), { recursive: true })
const vpId = '987e6543-e21b-42d3-a456-426614174000'
const staleId = '123e4567-e89b-42d3-a456-426614174000'
const vpPackage = (id: string): string => {
  const prefix = id.startsWith('#') ? join(vpRoot, 'packages', '@deepseek-ai', 'dsh' + id) : join(vpRoot, 'packages', '@deepseek-ai', 'dsh', id)
  const dir = join(prefix, 'lib', 'node_modules', '@deepseek-ai', 'dsh')
  mkdirSync(join(dir, 'lib'), { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.2.2-rc.2', bin: { dsh: 'lib/bin.js' } }))
  writeFileSync(join(dir, 'lib', 'bin.js'), '#!/usr/bin/env node\n')
  return realpathSync(dir)
}
vpPackage(staleId)
const vpActive = vpPackage(vpId)
const vpBinRecord = { name: 'dsh', package: '@deepseek-ai/dsh', version: '0.2.2-rc.2', source: 'vp' }
const vpMetadata = { name: '@deepseek-ai/dsh', version: '0.2.2-rc.2', installId: vpId, bins: ['dsh'] }
const vpRecords = (bin: unknown = vpBinRecord, metadata: unknown = vpMetadata): void => {
  writeFileSync(join(vpRoot, 'bins', 'dsh.json'), JSON.stringify(bin))
  writeFileSync(join(vpRoot, 'packages', '@deepseek-ai', 'dsh.json'), JSON.stringify(metadata))
}
vpRecords()
const vpLocation = (): ReturnType<typeof findHostDsh> => located(join(vpRoot, 'bin'))
const nativeVp = vpLocation()
check('vite-plus: native dispatcher filename resolves the active install', 'packageDir' in nativeVp && nativeVp.packageDir === vpActive, nativeVp)
// Also exercise the report's extensionless dsh entry on Windows.
if (process.platform === 'win32') linkSync(join(vpRoot, 'current', 'bin', vpExecutable), join(vpRoot, 'bin', 'dsh'))
for (const [label, bin, metadata] of [
  ['another package', { ...vpBinRecord, package: '@deepseek-ai/other' }, vpMetadata],
  ['another binary', { ...vpBinRecord, name: 'other' }, vpMetadata],
  ['npm interception', { ...vpBinRecord, source: 'npm' }, vpMetadata],
  ['stale bin version', { ...vpBinRecord, version: '9.9.9' }, vpMetadata],
  ['stale metadata version', vpBinRecord, { ...vpMetadata, version: '9.9.9' }],
  ['wrong metadata package', vpBinRecord, { ...vpMetadata, name: '@deepseek-ai/other' }],
  ['binary absent from metadata', vpBinRecord, { ...vpMetadata, bins: ['other'] }],
  ['missing active installation', vpBinRecord, { ...vpMetadata, installId: '11111111-1111-4111-8111-111111111111' }],
  ['invalid install ID', vpBinRecord, { ...vpMetadata, installId: '../dsh' }],
  ['null install ID', vpBinRecord, { ...vpMetadata, installId: null }],
  ['numeric install ID', vpBinRecord, { ...vpMetadata, installId: 1 }],
] as const) {
  vpRecords(bin, metadata)
  check(`vite-plus: ${label} does not select a store copy`, 'reason' in vpLocation(), vpLocation())
}
vpRecords()
const activeVp = vpLocation()
check('vite-plus: active install ID wins over a stale copy of the same version', 'packageDir' in activeVp && activeVp.packageDir === vpActive && activeVp.via === 'vite-plus', activeVp)
for (const id of ['', '#' + vpId]) {
  const dir = vpPackage(id)
  vpRecords(vpBinRecord, { ...vpMetadata, installId: id })
  const legacy = vpLocation()
  check(`vite-plus: official legacy install ID ${id || '(empty)'} resolves directly`, 'packageDir' in legacy && legacy.packageDir === dir, legacy)
}
vpRecords(vpBinRecord, { ...vpMetadata, installId: undefined })
check('vite-plus: omitted install ID uses the legacy empty default', 'packageDir' in vpLocation(), vpLocation())

vpRecords()
vpRecords({ ...vpBinRecord, source: undefined })
check('vite-plus: omitted source uses the official vp default', 'packageDir' in vpLocation(), vpLocation())
vpRecords()
const manifestPath = join(vpActive, 'package.json')
const manifest = { name: '@deepseek-ai/dsh', version: '0.2.2-rc.2', bin: { dsh: 'lib/bin.js' } }
for (const [label, value] of [
  ['wrong package version', { ...manifest, version: '9.9.9' }],
  ['wrong package name', { ...manifest, name: '@deepseek-ai/other' }],
  ['missing bin', { ...manifest, bin: {} }],
  ['escaping bin', { ...manifest, bin: { dsh: '../../../../../dsh.json' } }],
  ['directory bin', { ...manifest, bin: { dsh: 'lib' } }],
] as const) {
  writeFileSync(manifestPath, JSON.stringify(value))
  check(`vite-plus: ${label} remains on fallback`, 'reason' in vpLocation(), vpLocation())
}
writeFileSync(manifestPath, JSON.stringify(manifest))
for (const content of ['{', ' '.repeat(65537), '[]']) {
  writeFileSync(join(vpRoot, 'bins', 'dsh.json'), content)
  check('vite-plus: malformed/oversized/non-record registry remains on fallback', 'reason' in vpLocation(), vpLocation())
}
vpRecords()
const other = join(root, 'other', 'bin')
mkdirSync(other, { recursive: true })
writeFileSync(join(other, dshExecutable), Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0]))
check('vite-plus: an unrelated first PATH entry still hides a later host', 'reason' in findHostDsh({ PATH: other + (process.platform === 'win32' ? ';' : ':') + join(vpRoot, 'bin') }))
// Matching metadata alone must not turn an unrelated binary into a host.
const unproven = join(vpRoot, 'bin', 'dsh')
unlinkSync(unproven)
writeFileSync(unproven, Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0]))
check('vite-plus: valid registries do not prove an unrelated dispatcher', 'reason' in vpLocation(), vpLocation())

console.log(`verify-vite-plus-host: ${passed} checks passed`)
} finally {
  // Remove only our known directory alias, before the outer fixture owner
  // inventories/deletes its own TMP. Never relax that owner's reparse guard.
  const current = join(root, 'vite-plus', 'current')
  if (lstatSync(current, { throwIfNoEntry: false })?.isSymbolicLink()) {
    assert.equal(realpathSync(current), realpathSync(join(root, 'vite-plus', '1.4.0')))
    if (process.platform === 'win32') rmdirSync(current)
    else unlinkSync(current)
  }
}
