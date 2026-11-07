import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const runtime = '@runtime@/lib/dsh-tui/node_modules'
const dshTui = join(runtime, '@deepseek-harness-tui/dsh-tui')
const allowUserPlugins = @allowUserPlugins@
const node = '@node@/bin/node'
// Bundled TeX Live bin directory and preloaded LaTeX format. Both are empty
// when the package is built with withTikz = false, in which case the renderer
// falls back to whatever latex/dvisvgm the inherited PATH provides.
const texBin = '@texBin@'
const tikzFormat = '@tikzFormat@'
const binDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '../bin')
const packageRoot = dirname(binDirectory)
// Bundled skill root when withTikz is on. It contains the TikZ prompt hint
// plus the package's normal guide skill (symlinked from the runtime), so the
// default bundled skill discovery keeps working. Relative to packageRoot so
// the wrapper works from the immutable store path; empty when withTikz = false.
const tikzSkillRoot = '@tikzSkillDir@'
process.env.PATH = [binDirectory, '@node@/bin', '@pnpm@/bin', '@coreutils@/bin', texBin, process.env.PATH ?? ''].filter(Boolean).join(':')
if (tikzFormat !== '' && !process.env.DSH_TUI_TIKZ_FORMAT) process.env.DSH_TUI_TIKZ_FORMAT = tikzFormat
// Expose the bundled skill only once the pinned runtime actually contains the
// renderer (lib/types/tikz). A Nix package can bundle TeX ahead of the runtime
// bump; until then the ordinary guide skill dir stays the bundled root and the
// model is not told to emit figures this build cannot draw.
const runtimeHasTikz = existsSync(join(dshTui, 'lib/types/tikz'))
if (tikzSkillRoot !== '' && runtimeHasTikz && process.env.DSH_BUNDLED_SKILL_DIR === undefined) {
  process.env.DSH_BUNDLED_SKILL_DIR = tikzSkillRoot.startsWith('/') ? tikzSkillRoot : join(packageRoot, tikzSkillRoot)
}
process.env.DSH_HOME ||= join(homedir(), '.dsh-tui-nix')
// Nix owns this immutable TUI/engine pair. Self-update would replace a store
// path with a mutable npm install, so every update surface is disabled in the
// app (src/updatePolicy.ts); upgrades happen by rebuilding the flake.
process.env.DSH_TUI_UPDATE_DISABLED = '1'
// `allowUserPlugins` is substituted at build time. The managed profile links
// node_modules at the store runtime, so install/update/remove would write into
// an immutable dependency tree; the screen hides those forms when it is off.
process.env.DSH_TUI_ALLOW_USER_PLUGINS = allowUserPlugins ? '1' : '0'
const entry = join(dshTui, 'bin/dsh-tui.js')
const readOnlyCommand = ['help', '--help', '-h', 'version', '--version', '-v'].includes(process.argv[2])

const USER_MARKER = '.nix-user-plugins'
const USER_SEED = '1'
const STORE_RUNTIME = /^\/nix\/store\/[^/]+-dsh-tui-runtime-[^/]+\/lib\/dsh-tui\/node_modules$/
const USER_WORKSPACE = `packages:
  - .

nodeLinker: hoisted
autoInstallPeers: false
dangerouslyAllowAllBuilds: true
`
const MANAGED_BUNDLES = ['@deepseek-ai/dsh-base', '@deepseek-harness-tui/dsh-tui']

const userStamp = () => `${USER_SEED} ${packageRoot} ${runtime}\n`

const statOf = path => lstatSync(path, { throwIfNoEntry: false })

const unmanaged = modules => new Error(`Refusing to replace unmanaged node_modules at ${modules}. Use a separate DSH_HOME for the Nix installation.`)

function removeModules(modules) {
  const existing = statOf(modules)
  if (existing === undefined) return
  if (existing.isSymbolicLink()) unlinkSync(modules)
  else rmSync(modules, { recursive: true, force: true })
}

function linkManagedModules(modules) {
  const temporary = `${modules}.${process.pid}`
  rmSync(temporary, { recursive: true, force: true })
  symlinkSync(runtime, temporary)
  renameSync(temporary, modules)
}

function writeFileIfChanged(path, contents) {
  if (existsSync(path) && readFileSync(path, 'utf8') === contents) return
  writeFileSync(path, contents)
}

function managedManifest(version) {
  return JSON.stringify({
    name: 'dsh-profile-dsh-tui-nix',
    private: true,
    dependencies: { '@deepseek-harness-tui/dsh-tui': version },
    dsh: { profile: { bundles: MANAGED_BUNDLES } },
  }, null, 2) + '\n'
}

function userManifest() {
  return JSON.stringify({
    name: 'dsh-profile-dsh-tui-nix',
    private: true,
    dependencies: { '@deepseek-harness-tui/dsh-tui': `link:${dshTui}` },
    dsh: { profile: { bundles: MANAGED_BUNDLES } },
  }, null, 2) + '\n'
}

function writeManagedManifest(manifest, version, reset) {
  if (reset || !existsSync(manifest)) {
    writeFileIfChanged(manifest, managedManifest(version))
    return
  }
  const current = JSON.parse(readFileSync(manifest, 'utf8'))
  current.dependencies = { ...current.dependencies, '@deepseek-harness-tui/dsh-tui': version }
  writeFileIfChanged(manifest, JSON.stringify(current, null, 2) + '\n')
}

/** Keep the Nix-pinned dsh-tui package linked from the writable profile. */
function ensureUserLink(modules) {
  const scope = join(modules, '@deepseek-harness-tui')
  const link = join(scope, 'dsh-tui')
  mkdirSync(scope, { recursive: true })
  const existing = statOf(link)
  if (existing?.isSymbolicLink() && readlinkSync(link) === dshTui) return
  if (existing !== undefined) {
    if (existing.isDirectory() && !existing.isSymbolicLink()) rmSync(link, { recursive: true, force: true })
    else unlinkSync(link)
  }
  symlinkSync(dshTui, link)
}

/**
 * Repair the user manifest around installed plugins without discarding them.
 * Returns false when the profile has no usable manifest and must be reseeded.
 */
function repairUserManifest(manifest) {
  if (!existsSync(manifest)) return false
  let current
  try {
    current = JSON.parse(readFileSync(manifest, 'utf8'))
  } catch {
    return false
  }
  if (typeof current !== 'object' || current === null || Array.isArray(current)) return false
  current.dependencies = { ...current.dependencies, '@deepseek-harness-tui/dsh-tui': `link:${dshTui}` }
  const profile = current.dsh?.profile ?? {}
  const bundles = Array.isArray(profile.bundles) ? profile.bundles : []
  current.dsh = { ...current.dsh, profile: { ...profile, bundles: [...MANAGED_BUNDLES, ...bundles.filter(bundle => !MANAGED_BUNDLES.includes(bundle))] } }
  writeFileIfChanged(manifest, JSON.stringify(current, null, 2) + '\n')
  return true
}

/**
 * A user-plugin profile is an overlay over the Nix runtime: the app itself stays
 * pinned through a `link:` dependency, while plugins live in a writable
 * node_modules. A changed runtime path reseeds the overlay, restoring the
 * declared state; sessions, credentials and cordis.patch.yml are outside it.
 */
function ensureUserProfile(profile, modules) {
  const marker = join(profile, USER_MARKER)
  const manifest = join(profile, 'package.json')
  const workspace = join(profile, 'pnpm-workspace.yaml')
  const patch = join(profile, 'cordis.patch.yml')
  const existing = statOf(modules)
  const writable = existing?.isDirectory() === true && !existing.isSymbolicLink()
  const stamped = existsSync(marker) && readFileSync(marker, 'utf8') === userStamp()

  if (writable && stamped && repairUserManifest(manifest)) {
    ensureUserLink(modules)
    writeFileIfChanged(workspace, USER_WORKSPACE)
    if (!existsSync(patch)) writeFileSync(patch, '[]\n')
    return
  }
  if (existing !== undefined && !existing.isSymbolicLink() && !writable) throw unmanaged(modules)
  if (existing?.isSymbolicLink() && !STORE_RUNTIME.test(readlinkSync(modules))) throw unmanaged(modules)
  if (writable && !stamped) {
    const link = join(modules, '@deepseek-harness-tui', 'dsh-tui')
    if (!statOf(link)?.isSymbolicLink()) throw unmanaged(modules)
  }

  removeModules(modules)
  for (const name of [USER_MARKER, 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml']) rmSync(join(profile, name), { force: true })
  writeFileIfChanged(manifest, userManifest())
  writeFileIfChanged(workspace, USER_WORKSPACE)
  if (!existsSync(patch)) writeFileSync(patch, '[]\n')
  ensureUserLink(modules)
  writeFileIfChanged(marker, userStamp())
}

/** The default profile: node_modules is a read-only link to the Nix runtime. */
function ensureManagedProfile(profile, modules) {
  const marker = join(profile, USER_MARKER)
  const manifest = join(profile, 'package.json')
  const patch = join(profile, 'cordis.patch.yml')
  const existing = statOf(modules)
  const userState = existsSync(marker)
  let reset = false

  if (existing === undefined) {
    linkManagedModules(modules)
    reset = userState
  } else if (existing.isSymbolicLink()) {
    const target = readlinkSync(modules)
    if (!STORE_RUNTIME.test(target)) throw unmanaged(modules)
    if (target !== runtime) linkManagedModules(modules)
    reset = userState
  } else if (existing.isDirectory() && userState) {
    removeModules(modules)
    linkManagedModules(modules)
    reset = true
  } else {
    throw unmanaged(modules)
  }

  if (reset) for (const name of [USER_MARKER, 'pnpm-lock.yaml', 'pnpm-workspace.yaml']) rmSync(join(profile, name), { force: true })
  const version = JSON.parse(readFileSync(join(dshTui, 'package.json'), 'utf8')).version
  writeManagedManifest(manifest, version, reset)
  if (!existsSync(patch)) writeFileSync(patch, '[]\n')
}

if (!readOnlyCommand) {
  const profile = join(resolve(process.env.DSH_HOME), 'profiles', 'dsh-tui')
  const marker = join(profile, '.nix-managed')
  const modules = join(profile, 'node_modules')
  mkdirSync(profile, { recursive: true })
  if (!existsSync(marker)) {
    if (readdirSync(profile).length !== 0) {
      throw new Error(`Refusing to replace an existing unmanaged profile at ${profile}. Use a separate DSH_HOME for the Nix installation.`)
    }
    writeFileSync(marker, '1\n', { flag: 'wx' })
  }
  if (readFileSync(marker, 'utf8') !== '1\n') throw new Error(`Invalid Nix profile marker at ${marker}`)
  if (allowUserPlugins) ensureUserProfile(profile, modules)
  else ensureManagedProfile(profile, modules)
}

process.env.DSH_TUI_CLI_NODE = node
process.argv[1] = entry
await import(pathToFileURL(entry).href)
