#!/usr/bin/env node
/**
 * Build, pack, install, verify, and launch the current worktree in isolation.
 *
 * Two modes:
 *
 *   default (fast)  Content-hash fingerprints (scripts/dev-fingerprint.mjs)
 *                   decide per layer what reruns: dependency install, the
 *                   vendor/dsh-auth builds, and pack + profile install only run
 *                   when their inputs changed. src/ changes trigger a full
 *                   clean + emit compile, so deleted sources never linger in
 *                   lib/ and leak into the tarball; when nothing changed, a
 *                   fast incremental no-emit typecheck still guards the tree.
 *                   The verify:* build gates are NOT part of this loop — pnpm
 *                   build, pnpm dev:full and CI still run them. --force
 *                   invalidates all fingerprints for one run. Concurrent runs
 *                   sharing DSH_TUI_DEV_ROOT are serialized by
 *                   scripts/dev-lock.mjs; the lock is released before the TUI
 *                   launches so it never waits on an interactive session.
 *
 *   --full          The original pipeline, unchanged: pnpm install (prepare
 *                   compiles), pnpm build (clean compile + every build gate),
 *                   pack, install. Use it before releases and whenever a cached
 *                   fast loop looks suspect.
 */
import { spawn, spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { commandInvocation } from './dev-command.mjs'
import { resolveDevPaths } from './dev-copy-config.mjs'
import {
  VENDOR_PACKAGES,
  computeDevFingerprints,
  readDevLoopCache,
  writeDevLoopCache,
} from './dev-fingerprint.mjs'
import { acquireDevLoopLock } from './dev-lock.mjs'

const isWindows = process.platform === 'win32'
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const workspaceTarget = process.cwd()

function usage() {
  console.log([
    'Usage: pnpm dev [--force] [--no-launch] [-- dsh arguments...]',
    '       pnpm dev:full [--no-launch]',
    '       pnpm dev:test',
    '',
    'Fast mode (default) reruns only the layers whose inputs changed since the',
    'last successful run; the verify:* build gates stay with pnpm dev:full,',
    'pnpm build, and CI. --force ignores all fingerprints once.',
    '',
    'Environment:',
    '  DSH_TUI_DEV_ROOT   Persistent isolated test root.',
    '  DSH_SOURCE_HOME    Source settings directory (default: ~/.dsh).',
  ].join('\n'))
}

function run(name, args, options = {}) {
  const startedAt = performance.now()
  const result = spawnSync(...commandInvocation(name, args), {
    cwd: repoRoot,
    stdio: 'inherit',
    shell: isWindows,
    ...options,
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`${name} ${args.join(' ')} exited with ${String(result.status)}`)
  }
  return (performance.now() - startedAt) / 1000
}

function requireCommand(name) {
  const result = spawnSync(...commandInvocation(name, ['--version']), {
    stdio: 'ignore',
    shell: isWindows,
  })
  if (result.error || result.status !== 0) {
    throw new Error(`required command not found: ${name}`)
  }
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
let full = false
let force = false
let noLaunch = false
while (args.length > 0) {
  const flag = args[0]
  if (flag === '--full') full = true
  else if (flag === '--force') force = true
  else if (flag === '--no-launch') noLaunch = true
  else break
  args = args.slice(1)
}
if (args[0] === '--help' || args[0] === '-h') {
  usage()
  process.exit(0)
}

try {
  requireCommand('pnpm')
  requireCommand('dsh')

  const { devRoot, isolatedHome, dshHome, sessionRoot } = resolveDevPaths()
  const packageRoot = join(devRoot, 'packages')
  for (const directory of [devRoot, isolatedHome, dshHome, sessionRoot, packageRoot]) {
    secureDirectory(directory)
  }

  // Serialize the build/pack/install phase against other dev runs sharing
  // this dev root. Released before the TUI launches; the exit listener is the
  // backstop for process.exit and crash paths (release is idempotent).
  const releaseLock = acquireDevLoopLock(devRoot)
  process.on('exit', () => releaseLock())

  const installed = join(
    dshHome,
    'profiles',
    'dsh-tui',
    'node_modules',
    '@deepseek-harness-tui',
    'dsh-tui',
  )

  const installTarball = () => {
    const runId = `${new Date().toISOString().replaceAll(/[-:.]/gu, '')}-${process.pid}`
    const packDir = join(packageRoot, runId)
    secureDirectory(packDir)

    run('npm', ['pack', '--pack-destination', packDir])
    // npm pack, not pnpm: @dsh-std/* are bundledDependencies (#308) and pnpm
    // refuses to pack them under the isolated linker
    // (ERR_PNPM_BUNDLED_DEPENDENCIES_WITHOUT_HOISTED) - same reason publish.yml
    // switched to npm publish (1801177).
    const tarballs = readdirSync(packDir)
      .filter(file => file.endsWith('.tgz'))
      .map(file => join(packDir, file))
    if (tarballs.length !== 1) {
      throw new Error(`expected one tarball in ${packDir}, found ${tarballs.length}`)
    }
    const tarball = tarballs[0]

    run('dsh', ['plugin', '--profile', 'dsh-tui', 'add', tarball], {
      env: { ...process.env, DSH_HOME: dshHome },
    })

    for (const file of [
      'bin/dsh-tui.js',
      'cordis.patch.yml',
      'lib/types/index.js',
    ]) {
      assertSameFile(join(repoRoot, file), join(installed, file))
    }

    // Keep the current file dependency available, but cap the script-owned cache
    // so repeated same-version development runs do not accumulate tarballs.
    // Serialized by the dev-loop lock: no concurrent run can be mid-pack in a
    // directory this cleanup removes.
    for (const entry of readdirSync(packageRoot, { withFileTypes: true })) {
      if (
        entry.isDirectory()
        && entry.name !== runId
        && /^\d{8}T\d{9}Z-\d+$/u.test(entry.name)
      ) {
        rmSync(join(packageRoot, entry.name), { recursive: true, force: true })
      }
    }
    return tarball
  }

  const fingerprints = computeDevFingerprints(repoRoot)
  const timings = []
  let tarball = null
  const timedInstall = () => {
    const startedAt = performance.now()
    tarball = installTarball()
    timings.push(['pack + install', (performance.now() - startedAt) / 1000])
  }

  if (full) {
    console.log('dev: full pipeline (install + clean compile + all build gates)')
    timings.push(['install', run('pnpm', ['install', '--frozen-lockfile'])])
    timings.push(['build (compile + gates)', run('pnpm', ['build'])])
    timedInstall()
  } else {
    const cache = force ? null : readDevLoopCache(devRoot, repoRoot)

    if (cache?.deps !== fingerprints.deps || !existsSync(join(repoRoot, 'node_modules'))) {
      // --ignore-scripts: the prepare hook would run a full compile here,
      // duplicating the layered builds below.
      console.log('dev: dependency inputs changed, install (prepare skipped; builds run per layer)')
      timings.push(['install', run('pnpm', ['install', '--frozen-lockfile', '--ignore-scripts'])])
    } else {
      console.log('dev: dependencies unchanged, skip install')
    }

    const vendorBuilt = VENDOR_PACKAGES.every(pkg =>
      existsSync(join(repoRoot, 'vendor/dsh-std/packages', pkg, 'lib/index.js')))
    if (cache?.vendor !== fingerprints.vendor || !vendorBuilt) {
      console.log('dev: vendor/dsh-std inputs changed, build')
      timings.push(['vendor build', run('pnpm', ['run', 'build:dsh-std'])])
    } else {
      console.log('dev: vendor/dsh-std unchanged, skip build')
    }

    if (cache?.auth !== fingerprints.auth || !existsSync(join(repoRoot, 'dsh-auth', 'lib', 'index.js'))) {
      console.log('dev: dsh-auth inputs changed, build')
      timings.push(['dsh-auth build', run('pnpm', ['run', 'build:dsh-auth'])])
    } else {
      console.log('dev: dsh-auth unchanged, skip build')
    }

    if (cache?.app !== fingerprints.app || !existsSync(join(repoRoot, 'lib', 'types', 'index.js'))) {
      // Clean first (same as clean-lib.mjs): tsc never prunes orphan outputs,
      // and lib/ goes straight into the packed tarball.
      console.log('dev: src inputs changed, compile (clean + emit; covers typecheck)')
      rmSync(join(repoRoot, 'lib'), { recursive: true, force: true })
      timings.push(['compile', run('tsc', ['-p', 'tsconfig.json'])])
    } else {
      console.log('dev: src unchanged, incremental typecheck only')
      timings.push(['typecheck', run('tsc', ['-p', 'tsconfig.typecheck.json'])])
    }

    if (cache?.installed !== fingerprints.pkg || !existsSync(join(installed, 'lib', 'types', 'index.js'))) {
      console.log('dev: packaged inputs changed, pack + install into isolated profile')
      timedInstall()
    } else {
      console.log('dev: packaged inputs unchanged, skip pack + install')
    }
  }

  writeDevLoopCache(devRoot, repoRoot, { ...fingerprints, installed: fingerprints.pkg })
  if (timings.length > 0) {
    console.log(`dev: layer timings — ${timings.map(([label, secs]) => `${label} ${secs.toFixed(1)}s`).join(' | ')}`)
  }

  releaseLock()

  console.log(tarball ? 'dev-test: installed current worktree' : 'dev-test: cached install up to date')
  console.log(`  package:  ${tarball ?? 'unchanged (cache hit)'}`)
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
      NODE_ENV: 'production',
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
