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
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { x as extractTar } from 'tar'

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

const TUI_VERSION = '0.9.2'
const DSH_VERSION = '0.1.1-rc.2'
const BUNDLE_ID = `tui-${TUI_VERSION}-dsh-${DSH_VERSION}`
const PROFILE = 'dsh-tui'
const archivePath = fileURLToPath(new URL('./runtime.tar.gz', import.meta.url))

const cacheBase = resolve(
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
  await ensureRuntime({
    cacheBase,
    runtimeRoot,
    bundleId: BUNDLE_ID,
    archivePath,
    extract: extractTar,
    requiredPaths: [
      'node_modules/@deepseek-ai/dsh/lib/bin.js',
      'node_modules/@deepseek-harness-tui/dsh-tui/cordis.patch.yml',
    ],
    log: text => process.stderr.write(text),
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
  const standaloneHome = resolve(
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

// Clean up Windows .old backup file from a previous update
if (process.platform === 'win32') {
  try {
    const oldBinary = `${process.execPath}.old`
    if (existsSync(oldBinary)) rmSync(oldBinary, { force: true })
  } catch {
    // Best effort cleanup.
  }
}

await ensureRuntimeReady()
ensureProfile()

process.env.DSH_TUI_STANDALONE = '1'
process.env.DSH_TUI_STANDALONE_BINARY = process.execPath
process.env.DSH_TUI_LAUNCHER_VERSION = TUI_VERSION
process.argv = [process.execPath, dshBin, '--profile', PROFILE, ...process.argv.slice(2)]
await import(pathToFileURL(dshBin).href)

