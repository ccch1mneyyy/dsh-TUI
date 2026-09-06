#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, win32 } from 'node:path'
import { commandInvocation } from './dev-command.mjs'
import { copyDevConfig, resolveDevPaths } from './dev-copy-config.mjs'
import { computeDevFingerprints, readDevLoopCache, writeDevLoopCache } from './dev-fingerprint.mjs'

const unixArgs = ['--profile', 'dsh-tui', '/tmp/work tree']
assert.deepEqual(commandInvocation('dsh', unixArgs, 'linux'), ['dsh', unixArgs])
assert.deepEqual(commandInvocation('dsh', unixArgs, 'darwin'), ['dsh', unixArgs])

const [windowsCommand, windowsArgs] = commandInvocation(
  'dsh',
  ['--profile', 'dsh-tui', String.raw`C:\work tree\a&b`],
  'win32',
)
assert.deepEqual(windowsArgs, [])
assert.match(windowsCommand, /^dsh\.cmd /u)
assert.match(windowsCommand, /\^&/u)
assert.doesNotMatch(windowsCommand, /C:\\work tree\\a&b/u)

assert.deepEqual(
  resolveDevPaths({ XDG_CACHE_HOME: '/cache', DSH_SOURCE_HOME: '/source' }, '/home/dev', 'linux'),
  {
    devRoot: '/cache/dsh-tui-dev',
    sourceHome: '/source',
    isolatedHome: '/cache/dsh-tui-dev/home',
    dshHome: '/cache/dsh-tui-dev/dsh-home',
    sessionRoot: '/cache/dsh-tui-dev/sessions',
  },
)
assert.equal(
  resolveDevPaths({ LOCALAPPDATA: String.raw`C:\Users\dev\AppData\Local` }, String.raw`C:\Users\dev`, 'win32').devRoot,
  win32.resolve(String.raw`C:\Users\dev\AppData\Local\dsh-tui-dev`),
)

const fixture = mkdtempSync(join(tmpdir(), 'dsh-tui-dev-config-'))
try {
  const sourceHome = join(fixture, 'source')
  const devRoot = join(fixture, 'dev')
  mkdirSync(sourceHome)
  writeFileSync(join(sourceHome, 'settings.yaml'), 'providers: {}\n')
  writeFileSync(join(sourceHome, '.credentials.yaml'), 'test: secret\n')
  writeFileSync(join(sourceHome, 'cordis.patch.yml'), 'must not copy\n')

  const copied = copyDevConfig({ DSH_TUI_DEV_ROOT: devRoot, DSH_SOURCE_HOME: sourceHome })
  assert.deepEqual(copied.copied, ['settings.yaml', '.credentials.yaml'])
  assert.equal(readFileSync(join(copied.dshHome, 'settings.yaml'), 'utf8'), 'providers: {}\n')
  assert.equal(readFileSync(join(copied.dshHome, '.credentials.yaml'), 'utf8'), 'test: secret\n')
  assert.throws(() => readFileSync(join(copied.dshHome, 'cordis.patch.yml')))
  if (process.platform !== 'win32') {
    assert.equal(statSync(join(copied.dshHome, 'settings.yaml')).mode & 0o777, 0o600)
    assert.equal(statSync(join(copied.dshHome, '.credentials.yaml')).mode & 0o777, 0o600)
  }
} finally {
  rmSync(fixture, { recursive: true, force: true })
}

// --- dev-fingerprint: deterministic content hashes, per-layer isolation, cache roundtrip
{
  const fixture = mkdtempSync(join(tmpdir(), 'dsh-tui-dev-fingerprint-'))
  try {
    const write = (relativePath, content) => {
      const path = join(fixture, relativePath)
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, content)
    }
    write('package.json', '{}')
    write('pnpm-lock.yaml', 'lockfileVersion: 1')
    write('pnpm-workspace.yaml', 'packages: []')
    write('tsconfig.json', '{}')
    write('tsconfig.typecheck.json', '{}')
    write('src/index.ts', 'export const a = 1')
    write('bin/dsh-tui.js', '#!/usr/bin/env node')
    write('presets/preset-a.yml', 'name: a')
    write('dsh-ecosystem-spec/registry/r.json', '{}')
    write('dsh-ecosystem-spec/protocols/p.js', '')
    write('dsh-ecosystem-spec/schemas/s.json', '{}')
    write('cordis.yml', 'x')
    write('cordis.patch.yml', 'y')
    write('vendor/dsh-std/pnpm-lock.yaml', 'lockfileVersion: 1')
    write('vendor/dsh-std/pnpm-workspace.yaml', 'packages: []')
    write('vendor/dsh-std/tsconfig.base.json', '{}')
    for (const pkg of ['core', 'manifest', 'connection', 'presentation', 'command', 'storage', 'messages']) {
      write(`vendor/dsh-std/packages/${pkg}/package.json`, '{}')
      write(`vendor/dsh-std/packages/${pkg}/tsconfig.json`, '{}')
      write(`vendor/dsh-std/packages/${pkg}/tsdown.config.ts`, '')
      write(`vendor/dsh-std/packages/${pkg}/src/index.ts`, `export const ${pkg} = 1`)
    }
    write('dsh-auth/package.json', '{}')
    write('dsh-auth/pnpm-lock.yaml', 'lockfileVersion: 1')
    write('dsh-auth/pnpm-workspace.yaml', 'packages: []')
    write('dsh-auth/tsconfig.json', '{}')
    write('dsh-auth/cordis.patch.yml', 'y')
    write('dsh-auth/dsh-plugin.json', '{}')
    write('dsh-auth/src/index.ts', 'export const auth = 1')

    const first = computeDevFingerprints(fixture)
    assert.deepEqual(computeDevFingerprints(fixture), first, 'same tree must hash identically')

    utimesSync(join(fixture, 'src', 'index.ts'), new Date(), new Date())
    assert.deepEqual(computeDevFingerprints(fixture), first, 'mtime-only touch must not invalidate')

    write('src/index.ts', 'export const a = 2')
    const srcEdit = computeDevFingerprints(fixture)
    assert.notEqual(srcEdit.app, first.app)
    assert.notEqual(srcEdit.pkg, first.pkg)
    assert.equal(srcEdit.deps, first.deps)
    assert.equal(srcEdit.vendor, first.vendor)
    assert.equal(srcEdit.auth, first.auth)

    write('vendor/dsh-std/packages/core/src/index.ts', 'export const core = 2')
    const vendorEdit = computeDevFingerprints(fixture)
    assert.notEqual(vendorEdit.vendor, srcEdit.vendor)
    assert.notEqual(vendorEdit.app, srcEdit.app, 'vendor .d.ts feeds tsc, app must cascade')
    assert.notEqual(vendorEdit.pkg, srcEdit.pkg)
    assert.equal(vendorEdit.deps, srcEdit.deps)
    assert.equal(vendorEdit.auth, srcEdit.auth)

    write('pnpm-lock.yaml', 'lockfileVersion: 2')
    const lockEdit = computeDevFingerprints(fixture)
    assert.notEqual(lockEdit.deps, vendorEdit.deps)
    assert.equal(lockEdit.app, vendorEdit.app)

    write('bin/dsh-tui.js', '#!/usr/bin/env node\n// edit')
    const binEdit = computeDevFingerprints(fixture)
    assert.notEqual(binEdit.pkg, lockEdit.pkg)
    assert.equal(binEdit.app, lockEdit.app, 'packaged-only inputs must not trigger recompiles')

    const devRoot = join(fixture, 'dev-root')
    writeDevLoopCache(devRoot, fixture, { ...binEdit, installed: binEdit.pkg })
    assert.deepEqual(readDevLoopCache(devRoot, fixture), { ...binEdit, installed: binEdit.pkg })
    assert.equal(readDevLoopCache(devRoot, join(fixture, 'other-worktree')), null)
    assert.equal(readDevLoopCache(join(fixture, 'no-such-root'), fixture), null)
  } finally {
    rmSync(fixture, { recursive: true, force: true })
  }
}

console.log('dev command invocation OK (Linux, macOS, WSL, Windows quoting and paths)')
