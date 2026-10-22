#!/usr/bin/env node
/** Build, pack, install, verify, and launch the current worktree in isolation. */
import { spawn, spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { commandInvocation } from './dev-command.mjs'
import { resolveDevPaths } from './dev-copy-config.mjs'
import { devInputHash, devOutputHash, treeHash, installedHash, reusableInstall } from './lib/dev-install-cache.mjs'

const isWindows = process.platform === 'win32'
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const workspaceTarget = process.cwd()

function usage() {
  console.log([
    'Usage: pnpm dev [-- dsh arguments...]',
    '       pnpm dev:test',
    '',
    'Environment:',
    '  DSH_TUI_DEV_ROOT   Persistent isolated test root.',
    '  DSH_TUI_DEV_FAST=1 Compile without build gates; reuse a verified unchanged install.',
    '  DSH_SOURCE_HOME    Source settings directory (default: ~/.dsh).',
  ].join('\n'))
}

function run(name, args, options = {}) {
  const started = performance.now()
  const result = spawnSync(...commandInvocation(name, args), {
    cwd: repoRoot,
    stdio: 'inherit',
    shell: isWindows,
    ...options,
  })
  console.log(`dev-test: ${name} ${args[0]} took ${((performance.now() - started) / 1000).toFixed(1)}s`)
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`${name} ${args.join(' ')} exited with ${String(result.status)}`)
  }
  return result
}

function requireCommand(name) {
  const result = spawnSync(...commandInvocation(name, ['--version']), {
    stdio: 'pipe',
    encoding: 'utf8',
    shell: isWindows,
  })
  if (result.error || result.status !== 0) {
    throw new Error(`required command not found: ${name}`)
  }
  const version = String(result.stdout).trim()
  return /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version) ? `${name}:${version}` : undefined
}

function assertSameFile(source, installed) {
  if (!readFileSync(source).equals(readFileSync(installed))) {
    throw new Error(`installed artifact does not match worktree: ${source}`)
  }
}

function secureDirectory(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 })
  if (!isWindows) chmodSync(path, 0o700)
}

let args = process.argv.slice(2)
while (args[0] === '--') args = args.slice(1)
if (args[0] === '--help' || args[0] === '-h') {
  usage()
  process.exit(0)
}
const noLaunch = args[0] === '--no-launch'
if (noLaunch) args = args.slice(1)

try {
  const toolVersions = [requireCommand('pnpm'), requireCommand('dsh'), requireCommand('npm')]

  const { devRoot, isolatedHome, dshHome, sessionRoot } = resolveDevPaths()
  const packageRoot = join(devRoot, 'packages')
  let runId = `${new Date().toISOString().replaceAll(/[-:.]/gu, '')}-${process.pid}`
  let packDir = join(packageRoot, runId)

  for (const directory of [devRoot, isolatedHome, dshHome, sessionRoot, packageRoot, packDir]) {
    secureDirectory(directory)
  }

  const installed = join(dshHome, 'profiles', 'dsh-tui', 'node_modules', '@deepseek-harness-tui', 'dsh-tui')
  const stampFile = join(devRoot, 'dev-install-cache.json')
  const fast = process.env.DSH_TUI_DEV_FAST === '1'
  let inputs = fast ? devInputHash(repoRoot, devRoot, toolVersions) : undefined
  let stamp
  try { stamp = JSON.parse(readFileSync(stampFile, 'utf8')) } catch { /* Cache miss. */ }
  let tarball
  if (fast && reusableInstall(stamp, { repoRoot, packageRoot, installed, inputs })) {
    tarball = stamp.tarball
    packDir = dirname(tarball)
    runId = dirname(tarball).split(/[\\/]/u).at(-1)
    console.log('dev-test: cache hit; skipping install, compile, pack and plugin add')
  } else {
    if (fast) console.log('dev-test: cache miss; preparing current worktree')
    // Invalidate before any command can partially change outputs or the profile.
    rmSync(stampFile, { force: true })
    run('pnpm', ['install', '--frozen-lockfile'])
    inputs = fast ? devInputHash(repoRoot, devRoot, toolVersions) : undefined
    run('pnpm', [fast ? 'compile' : 'build'])
    // Fast mode has just compiled; npm pack's prepare would compile again.
    // The full path keeps every original lifecycle and build gate.
    const packed = run('npm', ['pack', ...(fast ? ['--ignore-scripts', '--json'] : []), '--pack-destination', packDir],
      fast ? { stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8' } : {})
    const packedFiles = fast ? JSON.parse(packed.stdout)[0]?.files : undefined
    if (fast && (!Array.isArray(packedFiles) || packedFiles.length === 0)) {
      throw new Error('npm pack did not report its packaged files')
    }
    const tarballs = readdirSync(packDir).filter(file => file.endsWith('.tgz')).map(file => join(packDir, file))
    if (tarballs.length !== 1) throw new Error(`expected one tarball in ${packDir}, found ${tarballs.length}`)
    tarball = tarballs[0]
    run('dsh', ['plugin', '--profile', 'dsh-tui', 'add', tarball], {
      env: { ...process.env, DSH_HOME: dshHome },
    })
    for (const file of ['bin/dsh-tui.js', 'cordis.patch.yml', 'lib/types/index.js']) {
      assertSameFile(join(repoRoot, file), join(installed, file))
    }
    if (fast) {
      // Verify the actual package manifest, including non-entry modules,
      // presets and assets, before blessing a successful install for reuse.
      for (const entry of packedFiles) {
        if (typeof entry.path !== 'string' || !entry.path || entry.path.split(/[\\/]/u).includes('..')
          || /^(?:[\\/]|[A-Za-z]:)/u.test(entry.path)) {
          throw new Error('npm pack reported an invalid packaged path')
        }
        assertSameFile(join(repoRoot, entry.path), join(installed, entry.path))
      }
      const expected = new Set(packedFiles.map(entry => entry.path))
      for (const entry of readdirSync(installed, { recursive: true, withFileTypes: true })) {
        if (!entry.isDirectory()) {
          const path = relative(installed, join(entry.parentPath, entry.name)).replaceAll('\\', '/')
          if (!expected.has(path)) throw new Error(`installed package contains an unpacked file: ${path}`)
        }
      }
    }
    if (fast && inputs !== undefined && inputs === devInputHash(repoRoot, devRoot, toolVersions)) {
      const outputs = devOutputHash(repoRoot)
      const profile = installedHash(installed)
      const artifact = treeHash(tarball)
      if (outputs && profile && artifact) {
        writeFileSync(stampFile, JSON.stringify({ repoRoot, inputs, outputs, profile, tarball, artifact }))
      }
    }
  }

  // Keep the current file dependency available, but cap the script-owned cache
  // so repeated same-version development runs do not accumulate tarballs.
  for (const entry of readdirSync(packageRoot, { withFileTypes: true })) {
    if (
      entry.isDirectory()
      && entry.name !== runId
      && /^\d{8}T\d{9}Z-\d+$/u.test(entry.name)
    ) {
      rmSync(join(packageRoot, entry.name), { recursive: true, force: true })
    }
  }

  console.log('dev-test: installed current worktree')
  console.log(`  package:  ${tarball}`)
  console.log(`  HOME:     ${isolatedHome}`)
  console.log(`  DSH_HOME: ${dshHome}`)
  console.log(`  sessions: ${sessionRoot}`)
  const hasSettings = existsSync(join(dshHome, 'settings.yaml'))
  const hasCredentials = existsSync(join(dshHome, '.credentials.yaml'))
  console.log(`  config:   ${hasSettings ? 'settings ready' : 'missing settings.yaml'}`)
  console.log(`  key:      ${hasCredentials ? 'credentials ready' : 'missing .credentials.yaml'}`)
  if (!hasSettings || !hasCredentials) {
    console.warn('  hint:     run pnpm dev:copy-config to refresh isolated model/key configuration')
  }

  if (noLaunch) process.exit(0)

  const child = spawn(...commandInvocation('dsh', ['--profile', 'dsh-tui', ...args]), {
    cwd: repoRoot,
    stdio: 'inherit',
    shell: isWindows,
    env: {
      ...process.env,
      HOME: isolatedHome,
      USERPROFILE: isolatedHome,
      DSH_HOME: dshHome,
      DSH_TUI_SESSION_ROOT: sessionRoot,
      DSH_TUI_WORKSPACE_TARGET: workspaceTarget,
      NODE_ENV: process.env.DSH_TUI_REACT_DEV === '1' ? 'development' : 'production',
    },
  })
  child.on('error', error => {
    console.error(`dev-test: failed to launch dsh: ${error.message}`)
    process.exit(1)
  })
  child.on('exit', (code, signal) => {
    if (signal) process.kill(process.pid, signal)
    else process.exit(code ?? 0)
  })
} catch (error) {
  console.error(`dev-test: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
