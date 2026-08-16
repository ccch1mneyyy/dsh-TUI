#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, win32 } from 'node:path'
import { commandInvocation } from './dev-command.mjs'
import { copyDevConfig, resolveDevPaths } from './dev-copy-config.mjs'

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

console.log('dev command invocation OK (Linux, macOS, WSL, Windows quoting and paths)')
