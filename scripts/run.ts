/**
 * Boot the cc-tui surface directly: load the three bundle patch layers from
 * workspace source (dsh-base → dsh-working-activity → dsh-cc-tui), compose
 * them, and hand them to boot() with a root config anchored in the healed
 * module-fallback directory. This bypasses the profile directory system
 * (loadProfile / resolveBundleDir / profile package.json) entirely — those
 * are designed for end-user web/headless profiles, not a developer workspace
 * TUI.
 */
import { existsSync, readFileSync, writeFileSync, unlinkSync, statSync, readdirSync, mkdirSync, rmSync, symlinkSync } from 'node:fs'
import { resolve, join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

// Pin DSH_HOME before any import that reads it. The cmd launcher's
// `set DSH_HOME=...` does not reliably survive PowerShell → cmd → tsx.cmd.
if (!process.env.DSH_HOME?.endsWith('.dsh-cc')) {
  process.env.DSH_HOME = resolve(homedir(), '.dsh-cc')
}

// app-boot is loaded through pnpm symlink → lib/index.js. Rebuild after
// src/ changes (pnpm run build or tsc -b + tsdown -F @deepseek-ai/dsh-app-boot).
import {
  boot,
  healProfilesModuleFallback,
  installFailLoud,
  loadOverlayPatches,
  watchUserPatches,
  type PatchOptions,
} from '@deepseek-ai/dsh-app-boot'
import type { Context } from 'cordis'

const here = fileURLToPath(new URL('.', import.meta.url))
const workspace = resolve(here, '../../../..')
const dshHome = process.env.DSH_HOME
const profileDir = join(dshHome, 'profiles', 'cc-tui')
const rootConfig = join(profileDir, 'cordis.yml')
const userPatch = join(profileDir, 'cordis.patch.yml')
const homePatch = join(dshHome, 'cordis.patch.yml')
const diagFile = join(dshHome, 'last-boot-diagnostic.txt')

// The installation anchor: apps/cli/package.json. healProfilesModuleFallback
// BFS-traverses its dependency closure to build a flat node_modules at
// $DSH_HOME/profiles/node_modules so every in-box plugin resolves.
const INSTALL_ANCHOR = resolve(workspace, 'apps/cli/package.json')

// Bootstrap DEEPSEEK_API_KEY from the workspace .env.
if (!process.env.DEEPSEEK_API_KEY) {
  try {
    const text = readFileSync(resolve(workspace, '.env'), 'utf8')
    for (const line of text.split('\n')) {
      const match = /^DEEPSEEK_API_KEY=(.*)$/.exec(line.trim())
      if (match) {
        process.env.DEEPSEEK_API_KEY = match[1].trim()
        break
      }
    }
  } catch {
    // No .env — rely on the ambient environment (setx or export).
  }
}

/**
 * Write a pre-boot diagnostic with every state variable that could explain
 * a failure. Deleted 5 s after successful boot; appended with the error on
 * failure.
 */
function writePreBootDiagnostic(): void {
  const lines: string[] = []
  lines.push(`cc-tui boot diagnostic — ${new Date().toISOString()}`)
  lines.push(`node: ${process.version}  platform: ${process.platform}/${process.arch}`)
  lines.push(`workspace: ${workspace}`)
  lines.push(`DSH_HOME: ${dshHome}`)
  lines.push(`profileDir: ${profileDir}`)
  lines.push(`rootConfig: ${rootConfig}`)
  lines.push(`INSTALL_ANCHOR: ${INSTALL_ANCHOR}`)
  lines.push(`DEEPSEEK_API_KEY: ${process.env.DEEPSEEK_API_KEY ? 'set (' + process.env.DEEPSEEK_API_KEY.length + ' chars)' : '(unset)'}`)
  lines.push(`stdout.isTTY: ${process.stdout.isTTY}`)
  lines.push('--- bundle patch sources ---')
  for (const label of ['base', 'working-activity', 'cc-tui']) {
    const p = label === 'base'
      ? resolve(workspace, 'packages/bundle/base/cordis.patch.yml')
      : label === 'working-activity'
        ? resolve(workspace, 'packages/activity/working-activity/cordis.patch.yml')
        : resolve(workspace, 'packages/ui/cc-tui/cordis.patch.yml')
    lines.push(`${label}: ${existsSync(p) ? 'exists (' + statSync(p).size + ' bytes)' : 'MISSING'}`)
  }
  lines.push('--- module fallback ---')
  const nmDir = join(dshHome, 'profiles', 'node_modules', '@deepseek-ai')
  try {
    const pkgs = readdirSync(nmDir)
    lines.push(`profiles/node_modules/@deepseek-ai: ${pkgs.length} packages`)
  } catch {
    lines.push('profiles/node_modules/@deepseek-ai: (not created yet)')
  }
  try {
    writeFileSync(diagFile, lines.join('\n') + '\n')
  } catch {
    // Best effort.
  }
}

writePreBootDiagnostic()

// --- Build the patch stack (same order as profile bundles) ---

// External plugin bundles live under $DSH_HOME/plugins/<name>/.
// Each has a cordis.patch.yml that the Loader applies as an additional
// layer. They are loaded between working-activity and cc-tui so cc-tui's
// overrides (persona, llm config) take precedence.
const pluginsDir = join(dshHome, 'plugins')
const externalPatchFiles: string[] = []
if (existsSync(pluginsDir)) {
  for (const name of readdirSync(pluginsDir)) {
    const patchFile = join(pluginsDir, name, 'cordis.patch.yml')
    if (existsSync(patchFile)) externalPatchFiles.push(patchFile)
  }
}

// Create module-resolution symlinks for external plugins so the Loader can
// find them (they live outside the workspace's dependency closure).
const profilesNm = join(dshHome, 'profiles', 'node_modules')
if (existsSync(profilesNm)) {
  for (const patchFile of externalPatchFiles) {
    const pluginDir = dirname(patchFile)
    try {
      const pj = JSON.parse(readFileSync(join(pluginDir, 'package.json'), 'utf8'))
      if (pj.name) {
        const linkDir = join(profilesNm, pj.name)
        const linkParent = dirname(linkDir)
        mkdirSync(linkParent, { recursive: true })
        // Remove stale link/dir, then create fresh symlink (junction on Win)
        try { rmSync(linkDir, { recursive: true, force: true }) } catch {}
        symlinkSync(pluginDir, linkDir, 'junction')
      }
    } catch {
      // package.json missing or unreadable — skip this plugin.
    }
  }
}

// 1. dsh-base: inserts all core plugin rows (~80 entries).
const basePatchPath = resolve(workspace, 'packages/bundle/base/cordis.patch.yml')
const basePatches: PatchOptions[] = loadOverlayPatches('dsh', basePatchPath)

// 2. dsh-working-activity: inserts the working-activity row.
const activityPatchPath = resolve(workspace, 'packages/activity/working-activity/cordis.patch.yml')
const activityPatches: PatchOptions[] = loadOverlayPatches('dsh', activityPatchPath)

// 3. External plugin bundles (dsh-vision, dsh-pi-adapter, etc.):
//    loaded before cc-tui so cc-tui's overrides take precedence.
const externalPatches: PatchOptions[] = externalPatchFiles.flatMap(f => loadOverlayPatches('dsh', f))

// 4. dsh-cc-tui: overrides base rows (persona, llm, compact, etc.),
//    overrides working-activity cadence, inserts cc-tui front door + SQLite.
const ccTuiPatchPath = resolve(workspace, 'packages/ui/cc-tui/cordis.patch.yml')
const ccTuiPatches: PatchOptions[] = loadOverlayPatches('dsh', ccTuiPatchPath)

// 4. User layers (optional): profile-local + home-level patches.
const userProfilePatches: PatchOptions[] = existsSync(userPatch)
  ? loadOverlayPatches('dsh', userPatch)
  : []
const homeProfilePatches: PatchOptions[] = existsSync(homePatch)
  ? loadOverlayPatches('dsh', homePatch)
  : []

const allPatches: PatchOptions[] = [
  ...basePatches,
  ...activityPatches,
  ...externalPatches,
  ...ccTuiPatches,
  ...userProfilePatches,
  ...homeProfilePatches,
]

// --- Boot ---

// Ensure the module fallback exists so the Loader can resolve every plugin.
healProfilesModuleFallback(INSTALL_ANCHOR)

// Write the empty root config the Loader anchors on.
writeFileSync(rootConfig, '# cc-tui root — composed from bundle patches\n[]\n')

const app: { current?: Context } = {}

// Capture ALL errors before installFailLoud swallows them. This handler
// runs first (registered before installFailLoud) and writes the full error
// to the diagnostic file so we can debug crashes the user sees.
process.on('unhandledRejection', (error) => {
  const detail = error instanceof Error ? (error.stack ?? error.message) : String(error)
  try {
    const existing = readFileSync(diagFile, 'utf8')
    writeFileSync(diagFile, existing + `\n--- UNHANDLED REJECTION (crash on user action) ---\n${new Date().toISOString()}\n${detail}\n`)
  } catch {
    try { writeFileSync(diagFile, `${new Date().toISOString()} — UNHANDLED REJECTION\n${detail}\n`) } catch {}
  }
})

// Fail-loud: surface unhandled rejections as stderr + cleanup.
installFailLoud('dsh', process, async () => {
  await app.current?.fiber.dispose()
})

process.on('SIGTERM', () => process.exit(0))
process.on('SIGINT', () => process.exit(130))

try {
  app.current = await boot('dsh', rootConfig, allPatches, async (hostCtx) => {
    app.current = hostCtx
  })

  // Boot succeeded — schedule diagnostic cleanup.
  setTimeout(() => {
    try { unlinkSync(diagFile) } catch { /* already gone */ }
  }, 5_000)

  // Config-only HMR for the user patch layers (bundle layers are static).
  if (app.current.get('loader') !== undefined) {
    if (app.current.get('hmr') === undefined) {
      if (app.current.get('timer') === undefined) {
        await app.current.loader.create({ name: '@cordisjs/plugin-timer' })
      }
      await app.current.loader.create({ name: '@cordisjs/plugin-hmr', config: { root: [] } })
    }
    const composeLive = (): PatchOptions[] => structuredClone([
      ...basePatches,
      ...activityPatches,
      ...ccTuiPatches,
      ...existsSync(userPatch) ? loadOverlayPatches('dsh', userPatch) : [],
      ...existsSync(homePatch) ? loadOverlayPatches('dsh', homePatch) : [],
    ])
    if (existsSync(userPatch)) {
      await watchUserPatches(app.current, { binName: 'dsh', filename: userPatch, compose: composeLive })
    }
    if (existsSync(homePatch)) {
      await watchUserPatches(app.current, { binName: 'dsh', filename: homePatch, compose: composeLive })
    }
  }
} catch (error) {
  const detail = error instanceof Error ? error.stack ?? error.message : String(error)
  process.stderr.write(`cc-tui boot failed: ${detail}\n`)
  // Append error to diagnostic.
  try {
    const existing = readFileSync(diagFile, 'utf8')
    writeFileSync(diagFile, existing + `\n--- BOOT ERROR ---\n${detail}\n`)
  } catch {
    // Best effort.
  }
  process.exit(1)
}

process.on('uncaughtException', (error) => {
  const detail = error instanceof Error ? (error.stack ?? error.message) : String(error)
  try {
    writeFileSync(diagFile, `${new Date().toISOString()} — UNCAUGHT EXCEPTION\n${detail}\n`)
  } catch {
    // Best effort.
  }
  process.exit(1)
})

await new Promise(() => {})
