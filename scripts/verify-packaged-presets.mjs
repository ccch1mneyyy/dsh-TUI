import assert from 'node:assert/strict'
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { discoverPresets } from '@deepseek-ai/dsh-agent-presets'
import { ensurePackagedPresets, packagedPresetRoot } from '../lib/types/dsh-adapter/packaged-presets.js'

const workspace = new URL('..', import.meta.url)
const packagedRoot = join(fileURLToPath(workspace), 'presets')
const temporary = await mkdtemp(join(tmpdir(), 'dsh-tui-presets-'))

try {
  assert.equal(packagedPresetRoot(), packagedRoot)
  const dshHome = join(temporary, 'home')
  assert.deepEqual(ensurePackagedPresets({ dshHome, sourceRoot: packagedRoot }), [
    { id: 'liangshen', status: 'installed' },
  ])
  assert.deepEqual(ensurePackagedPresets({ dshHome, sourceRoot: packagedRoot }), [
    { id: 'liangshen', status: 'current' },
  ])

  const discovered = await discoverPresets([
    { path: join(dshHome, '.agent-presets'), trust: 'user' },
  ])
  const liangshen = discovered.find(preset => preset.id === 'liangshen')
  assert.equal(liangshen?.name, '梁神模式')
  assert.equal(liangshen?.broken, undefined)

  const conflictingHome = join(temporary, 'conflicting-home')
  const conflictingPreset = join(conflictingHome, '.agent-presets', 'liangshen')
  await mkdir(conflictingPreset, { recursive: true })
  await writeFile(join(conflictingPreset, 'keep.txt'), 'user-owned\n')
  assert.deepEqual(ensurePackagedPresets({ dshHome: conflictingHome, sourceRoot: packagedRoot }), [
    { id: 'liangshen', status: 'conflict' },
  ])
  assert.equal(await readFile(join(conflictingPreset, 'keep.txt'), 'utf8'), 'user-owned\n')

  const nextRoot = join(temporary, 'next')
  await cp(packagedRoot, nextRoot, { recursive: true })
  const markerPath = join(nextRoot, 'liangshen', '.dsh-tui-managed.json')
  const marker = JSON.parse(await readFile(markerPath, 'utf8'))
  marker.revision = `${marker.revision}-test-update`
  await writeFile(markerPath, `${JSON.stringify(marker, null, 2)}\n`)
  assert.deepEqual(ensurePackagedPresets({ dshHome, sourceRoot: nextRoot }), [
    { id: 'liangshen', status: 'updated' },
  ])
  assert.equal(JSON.parse(await readFile(join(dshHome, '.agent-presets', 'liangshen', '.dsh-tui-managed.json'), 'utf8')).revision, marker.revision)
} finally {
  await rm(temporary, { recursive: true, force: true })
}

console.log('packaged presets OK (install, discover, preserve conflict, update)')
