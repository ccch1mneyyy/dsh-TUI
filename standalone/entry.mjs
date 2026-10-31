#!/usr/bin/env node
// Polyfill Intl.Segmenter for pkg small-icu builds so string-width, wrap-ansi, and ansi-tokenize work seamlessly
if (typeof Intl !== 'undefined') {
  let needsPolyfill = false
  try {
    const test = new Intl.Segmenter()
    test.segment('test')
  } catch {
    needsPolyfill = true
  }
  if (needsPolyfill) {
    Intl.Segmenter = class Segmenter {
      constructor(locale, options) {
        this.granularity = options?.granularity || 'grapheme'
      }
      segment(input) {
        const str = String(input ?? '')
        return {
          *[Symbol.iterator]() {
            let index = 0
            for (const char of str) {
              yield {
                segment: char,
                index,
                input: str,
                isWordLike: /\w/.test(char),
              }
              index += char.length
            }
          },
        }
      }
    }
  }
}
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
const fs = require('node:fs')
const {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} = fs

// Runtime cache integrity guard (hash manifest + runtimeReady/ensureRuntime;
// single source of truth in cacheGuard.cjs, tested directly by
// scripts/verify-standalone-cache-guard.mjs).
const { ensureRuntime } = require('./cacheGuard.cjs')
const { extractRuntime } = require('./extractRuntime.cjs')

// Build seeds: make-standalone-bundle synchronizes both from package.json and
// the adapter's primary contract before resolving or archiving the runtime.
const TUI_VERSION = '0.15.0'
const DSH_VERSION = '0.2.0-rc.2'
const BUNDLE_ID = `tui-${TUI_VERSION}-dsh-${DSH_VERSION}`
const PROFILE = 'dsh-tui'
const archivePath = fileURLToPath(new URL('./runtime.tar.gz', import.meta.url))
const selfTest = process.argv[2] === '--self-test'
const diagnosticStart = performance.now()
function traceStage(stage, details = {}) {
  if (selfTest) process.stderr.write(`DSH_TUI_STANDALONE_STAGE ${JSON.stringify({ stage, elapsedMs: Math.round(performance.now() - diagnosticStart), ...details })}\n`)
}

const launchCwd = process.cwd()
const windowsPaths = process.platform === 'win32'
// The bundled libuv can abort when a watched 8.3 path receives a long-path
// event (libuv#5152). Give DSH one physical spelling of the roots we own.
// Resolve missing suffixes without creating them: cacheGuard still owns cache
// permissions, and a self-test must not initialize the user's profile.
function canonicalWindowsPath(path) {
  let current = resolve(launchCwd, path)
  if (!windowsPaths) return current
  const missing = []
  while (true) {
    try {
      const canonical = fs.realpathSync.native(current)
      if (missing.length && !fs.statSync(canonical).isDirectory()) {
        throw Object.assign(new Error(`Standalone path parent is not a directory: ${canonical}`), { code: 'ENOTDIR' })
      }
      return join(canonical, ...missing.reverse())
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
      const parent = dirname(current)
      if (parent === current) throw error
      missing.push(basename(current))
      current = parent
    }
  }
}
if (windowsPaths) process.chdir(canonicalWindowsPath(launchCwd))

const cacheBase = canonicalWindowsPath(
  process.env.DSH_TUI_STANDALONE_CACHE ??
    join(process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache'), 'dsh-tui-standalone'),
)
const runtimeRoot = join(cacheBase, BUNDLE_ID)
const dshBin = join(runtimeRoot, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
const tuiRoot = join(runtimeRoot, 'node_modules', '@deepseek-harness-tui', 'dsh-tui')

/**
 * Ensure the bundled runtime archive is unpacked into the cache directory.
 * Delegates to cacheGuard.cjs (hash-manifest guard + extraction flow).
 */
async function ensureRuntimeReady() {
  const windowsExtraction = process.platform === 'win32'
  const showProgress = !selfTest && process.stderr.isTTY
  const progressStart = performance.now()
  let lastProgressAt = progressStart
  let progressVisible = false
  const updateProgress = showProgress ? () => {
    const now = performance.now()
    if (progressVisible && now - lastProgressAt < 1000) return
    lastProgressAt = now
    progressVisible = true
    process.stderr.write(`\r[dsh-tui] 正在准备运行环境，已用 ${Math.floor((now - progressStart) / 1000)} 秒`)
  } : undefined
  await ensureRuntime({
    cacheBase,
    runtimeRoot,
    bundleId: BUNDLE_ID,
    archivePath,
    extract: async options => {
      // cacheGuard has finished copying the embedded archive before calling
      // this extractor. Diagnostics count reads; interactive progress reports time.
      let entries = 0
      await extractRuntime(options, {
        windows: windowsExtraction, trace: traceStage, onProgress: updateProgress,
        ...(selfTest || showProgress ? { onReadEntry() {
          if (selfTest) {
            entries++
            if (entries % 2000 === 0) traceStage('extract-progress', { entries })
          } else updateProgress()
        } } : {}),
      })
      traceStage('extract-done', { entries })
    },
    requiredPaths: [
      'node_modules/@deepseek-ai/dsh/lib/bin.js',
      'node_modules/@deepseek-harness-tui/dsh-tui/cordis.patch.yml',
      'node_modules/@deepseek-harness-tui/dsh-tui/cli/entry.mjs',
      'node_modules/@deepseek-harness-tui/dsh-tui/cli/adapters/dsh/management-plugin.mjs',
    ],
    log: text => {
      traceStage('archive-copy-start')
      process.stderr.write(text)
      updateProgress?.()
    },
  }).finally(() => {
    if (progressVisible) process.stderr.write('\n')
  })
}

/**
 * Link or update the node_modules symbolic link in the target profile directory.
 *
 * @param profileDir - Absolute path to the standalone profile directory.
 */
function replaceNodeModulesLink(profileDir) {
  const linkPath = join(profileDir, 'node_modules')
  const target = join(runtimeRoot, 'node_modules')
  try {
    const stat = lstatSync(linkPath)
    if (stat.isSymbolicLink() && resolve(dirname(linkPath), readlinkSync(linkPath)) === target) return
    rmSync(linkPath, { recursive: true, force: true })
  } catch {
    // Missing links are created below.
  }
  const type = process.platform === 'win32' ? 'junction' : 'dir'
  symlinkSync(target, linkPath, type)
}

/**
 * Configure and initialize the standalone profile environment with cordis patch and dependencies.
 */
function ensureProfile() {
  const standaloneHome = canonicalWindowsPath(
    process.env.DSH_TUI_STANDALONE_HOME ?? join(homedir(), '.dsh-tui-standalone'),
  )
  process.env.DSH_HOME = standaloneHome

  const profileDir = join(standaloneHome, 'profiles', PROFILE)
  mkdirSync(profileDir, { recursive: true })
  writeFileSync(
    join(profileDir, 'package.json'),
    `${JSON.stringify({
      name: 'dsh-profile-dsh-tui-standalone',
      private: true,
      dependencies: {
        '@deepseek-harness-tui/dsh-tui': TUI_VERSION,
      },
      dsh: {
        profile: {
          bundles: ['@deepseek-ai/dsh-base'],
        },
      },
    }, null, 2)}\n`,
  )
  copyFileSync(join(tuiRoot, 'cordis.patch.yml'), join(profileDir, 'cordis.patch.yml'))
  replaceNodeModulesLink(profileDir)
}

// Only a packaged executable owns this backup; a source-mode diagnostic must
// never remove a file next to the user's Node installation.
if (process.pkg && process.platform === 'win32') {
  try {
    const oldBinary = `${process.execPath}.old`
    if (existsSync(oldBinary)) rmSync(oldBinary, { force: true })
  } catch {
    // Best effort cleanup.
  }
}

traceStage('runtime-check', { node: process.versions.node, uv: process.versions.uv, launchCwd, cwd: process.cwd() })
await ensureRuntimeReady()
traceStage('runtime-ready')
if (selfTest) {
  // Import the lazy runtime too: --version and the public plugin factory alone
  // do not reach missing exports such as ToolCallId (#1660). No profile is
  // initialized and no model request is made by this diagnostic.
  for (const [name, directory, expected] of [
    ['@deepseek-ai/dsh', dirname(dirname(dshBin)), DSH_VERSION],
    ['@deepseek-harness-tui/dsh-tui', tuiRoot, TUI_VERSION],
  ]) {
    const installed = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'))
    if (installed.name !== name || installed.version !== expected) {
      throw new Error(`Standalone runtime mismatch: expected ${name}@${expected}, found ${installed.name}@${installed.version}`)
    }
  }
  const hostRequire = createRequire(join(dirname(dirname(dshBin)), 'package.json'))
  const tuiRequire = createRequire(join(tuiRoot, 'package.json'))
  for (const name of ['@deepseek-ai/cordis', '@deepseek-ai/schemastery']) {
    if (hostRequire.resolve(name) !== tuiRequire.resolve(name)) {
      throw new Error(`Standalone runtime has separate host/TUI instances of ${name}`)
    }
  }
  traceStage('public-import-start')
  await import(pathToFileURL(join(tuiRoot, 'lib/types/index.js')).href)
  traceStage('lazy-import-start')
  const runtime = await import(pathToFileURL(join(tuiRoot, 'lib/types/dsh-adapter/plugin.js')).href)
  if (typeof runtime.apply !== 'function') throw new Error('Standalone TUI runtime is missing its apply export')
  traceStage('imports-done')
  console.log(`DSH_TUI_STANDALONE_OK ${JSON.stringify({ tui: TUI_VERSION, dsh: DSH_VERSION })}`)
  process.exit(0)
}
const cliEntry = join(tuiRoot, 'cli', 'entry.mjs')
const cliCommand = process.argv.slice(2)[0]
if (['cli', 'run', '-p', '--print', 'session', 'models', 'skills', 'mcp', 'auth', 'capabilities', 'dsh'].includes(cliCommand)) {
  // Bypass TUI profile initialization. The standalone cache supplies the same
  // independently shipped CLI; DSH owns its own headless profile and home.
  process.env.DSH_HOME ??= canonicalWindowsPath(process.env.DSH_TUI_STANDALONE_HOME ?? join(homedir(), '.dsh-tui-standalone'))
  process.env.DSH_TUI_CLI_INSTALL_ANCHOR ??= dirname(dirname(dshBin))
  const node = process.env.DSH_TUI_CLI_NODE ?? 'node'
  const { spawn } = await import('node:child_process')
  const child = spawn(node, [cliEntry, ...process.argv.slice(2)], { stdio: 'inherit', shell: false })
  child.on('error', () => { console.error('CLI_NODE_UNAVAILABLE: install Node ^22.19 or >=24, or set DSH_TUI_CLI_NODE.'); process.exit(3) })
  child.on('exit', (code, signal) => { if (signal) process.kill(process.pid, signal); else process.exit(code ?? 1) })
  await new Promise(resolve => child.once('close', resolve))
  process.exit(0)
}
ensureProfile()

process.env.DSH_TUI_STANDALONE = '1'
process.env.DSH_TUI_STANDALONE_BINARY = process.execPath
process.env.DSH_TUI_LAUNCHER_VERSION = TUI_VERSION
process.argv = [process.execPath, dshBin, '--profile', PROFILE, ...process.argv.slice(2)]
// DSH's public bin only auto-runs when import.meta.main is true. Importing it
// from this packaged launcher requires one explicit call to its public entry.
const { runCli } = await import(pathToFileURL(dshBin).href)
await runCli()

