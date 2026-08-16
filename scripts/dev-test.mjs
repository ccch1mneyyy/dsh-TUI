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
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { commandInvocation } from './dev-command.mjs'
import { resolveDevPaths } from './dev-copy-config.mjs'

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
    '  DSH_SOURCE_HOME    Source settings directory (default: ~/.dsh).',
  ].join('\n'))
}

function run(name, args, options = {}) {
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
if (args[0] === '--help' || args[0] === '-h') {
  usage()
  process.exit(0)
}
const noLaunch = args[0] === '--no-launch'
if (noLaunch) args = args.slice(1)

try {
  requireCommand('pnpm')
  requireCommand('dsh')

  const { devRoot, isolatedHome, dshHome, sessionRoot } = resolveDevPaths()
  const packageRoot = join(devRoot, 'packages')
  const runId = `${new Date().toISOString().replaceAll(/[-:.]/gu, '')}-${process.pid}`
  const packDir = join(packageRoot, runId)

  for (const directory of [devRoot, isolatedHome, dshHome, sessionRoot, packageRoot, packDir]) {
    secureDirectory(directory)
  }

  run('pnpm', ['install', '--frozen-lockfile'])
  run('pnpm', ['build'])
  run('pnpm', ['pack', '--pack-destination', packDir], { stdio: 'ignore' })

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

  const installed = join(
    dshHome,
    'profiles',
    'dsh-tui',
    'node_modules',
    '@deepseek-harness-tui',
    'dsh-tui',
  )
  for (const file of [
    'bin/dsh-tui.js',
    'cordis.patch.yml',
    'lib/types/index.js',
  ]) {
    assertSameFile(join(repoRoot, file), join(installed, file))
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
