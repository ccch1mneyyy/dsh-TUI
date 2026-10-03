/**
 * The `dsh-tui` row's Config as the host will compose it — read BEFORE dsh
 * boots, for the `dst` preload (src/preboot/mount.ts).
 *
 * Since 0.1.7 the settings DSH edits (`/settings`, the settings API) live in
 * the plugin's own volatile Config fields, i.e. in the profile's patch
 * layers, and the host imports a leftover `$DSH_HOME/settings.yaml` into
 * them once. Re-deriving where those values sit (bundle patches, the
 * profile's `cordis.patch.yml`, the home-level `cordis.patch.yml`, `--patch`
 * overlays) would trail every upstream change, so this asks the host's own
 * composition instead: the `@deepseek-ai/dsh-app-boot` copy of the dsh
 * install that is about to run, `readProfilePatches` + `composeEntries` —
 * what dsh itself calls at boot and `dsh --dump-config` prints. Nothing is
 * evaluated: `!!js` values stay `{ __jsExpr }` objects, which every preboot
 * reader ignores as the wrong type.
 *
 * Capability-gated, not version-gated: a host whose app-boot lacks
 * `readProfilePatches` (0.1.5 and older) still keeps settings in
 * `settings.yaml` behind `settings.register()`, and the caller reads that
 * file instead. A newer host can still run a settings service with
 * `register()` — a plugin that patches the host's `@deepseek-ai/dsh-settings`
 * back to the legacy API (dsh-purge does) — and then the plugin reads its
 * settings from that service's document, with Config only filling what the
 * document leaves unset (src/dsh-adapter/compat/settings.ts makes the same
 * `register` check at runtime). `legacySettings` reports which of the two
 * the live plugin will see. Fail-soft throughout: any problem yields
 * `undefined` and the caller falls back to settings.yaml — the boot screen
 * must never be the reason a launch fails.
 *
 * Cost (0.2.0-rc.2, warm disk): ~45ms to import app-boot and ~20ms more for
 * dsh-settings — both the same resolved files dsh imports right after, so
 * the module cache serves them — plus ~20ms reading the profile and bundle
 * manifests.
 */
import { readFileSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/** The diagnostic prefix app-boot puts on its own errors. */
const BIN_NAME = 'dsh'
const APP_BOOT = '@deepseek-ai/dsh-app-boot'
const SETTINGS = '@deepseek-ai/dsh-settings'
/** The Loader entry id the dsh-tui bundle gives the plugin row. */
const TUI_ENTRY_ID = 'dsh-tui'
const PROFILE_PATCH_FILENAME = 'cordis.patch.yml'

interface ProfileContext {
  readonly dir: string
  readonly installAnchor: string
  readonly patchPath: string
  readonly home: string
  readonly overlays: readonly unknown[]
  readonly telemetryDisabledEnv: string | undefined
}

/** The slice of app-boot this module drives (0.1.7-rc.1 … 0.2.0-rc.2 agree on it). */
interface AppBoot {
  readProfilePatches(binName: string, context: ProfileContext): unknown[]
  composeEntries(layers: readonly unknown[][]): unknown[]
  loadOverlayPatches(binName: string, file: string): unknown[]
  /** Validates the name too (`..`, separators); `$DSH_HOME/profiles/<name>`. */
  resolveProfileDir?(name: string, home: string): string
}

function isAppBoot(value: unknown): value is AppBoot {
  if (value === null || typeof value !== 'object') return false
  const exports = value as Record<string, unknown>
  // loadProfileDirectory is what readProfilePatches reads bundles through;
  // 0.1.5 has it but not readProfilePatches, and keeps settings.yaml.
  return ['readProfilePatches', 'loadProfileDirectory', 'composeEntries', 'loadOverlayPatches']
    .every(name => typeof exports[name] === 'function')
}

/**
 * `--patch <file>` / `--patch=<file>` overlays in the host prefix (before the
 * `--` dsh consumes), in argv order — dsh's own collector is repeatable and
 * single-valued.
 */
export function patchOverlaysFromHostArgv(argv: readonly string[]): string[] {
  const separator = argv.indexOf('--')
  const host = separator === -1 ? argv : argv.slice(0, separator)
  const files: string[] = []
  for (let i = 0; i < host.length; i++) {
    const arg = host[i]!
    if (arg === '--patch') {
      const value = host[i + 1]
      if (value !== undefined && value !== '') files.push(value)
      i++
    } else if (arg.startsWith('--patch=')) {
      const value = arg.slice('--patch='.length)
      if (value !== '') files.push(value)
    }
  }
  return files
}

/**
 * The dsh install's package.json for an entry script: the nearest one
 * upward from the (realpath of the) entry. The host's own anchor is
 * `lib/../package.json`; walking keeps a source checkout's `src/` entry
 * working too.
 */
function findInstallAnchor(entry: string): string | undefined {
  let dir = entry
  for (;;) {
    const parent = join(dir, '..')
    if (parent === dir) return undefined
    dir = parent
    const candidate = join(dir, 'package.json')
    try {
      const manifest: unknown = JSON.parse(readFileSync(candidate, 'utf8'))
      if (manifest !== null && typeof manifest === 'object' && typeof (manifest as { name?: unknown }).name === 'string') return candidate
    } catch {
      // No manifest at this level; keep walking.
    }
  }
}

export interface HostTuiConfigOptions {
  /** The dsh entry script about to run (the preload's `process.argv[1]`). */
  readonly hostEntry: string | undefined
  /** `--profile` value; undefined means no profile launch (nothing to compose). */
  readonly profile: string | undefined
  readonly dshHome: string
  /** The dsh process argv after `node <entry>` (for `--patch` overlays). */
  readonly argv: readonly string[]
}

export interface HostTuiConfig {
  /** The composed `dsh-tui` row Config (`!!js` values left as `{ __jsExpr }`). */
  readonly config: Readonly<Record<string, unknown>>
  /**
   * The host's settings service exposes `register()`: the plugin will read a
   * settings document through it (`value ?? config`), not Config alone.
   */
  readonly legacySettings: boolean
}

/**
 * Whether the host's settings service class carries the legacy
 * `register()`. A host that cannot resolve the package has no settings
 * service to patch, so it reads as Config-only.
 */
async function hostSettingsRegister(require: NodeJS.Require): Promise<boolean> {
  let path: string
  try {
    path = require.resolve(SETTINGS)
  } catch {
    return false
  }
  const module: unknown = await import(pathToFileURL(path).href)
  if (module === null || typeof module !== 'object') return false
  const forms = (module as { SettingsForms?: unknown }).SettingsForms
  return typeof forms === 'function'
    && typeof (forms as { prototype?: { register?: unknown } }).prototype?.register === 'function'
}

/**
 * The composed `dsh-tui` row Config and the settings mode, or undefined when
 * the host cannot compose one (no profile launch, an older host, a missing
 * row, any error).
 */
export async function readHostTuiConfig(options: HostTuiConfigOptions): Promise<HostTuiConfig | undefined> {
  if (options.hostEntry === undefined || options.profile === undefined) return undefined
  try {
    const entry = realpathSync(options.hostEntry)
    const installAnchor = findInstallAnchor(entry)
    if (installAnchor === undefined) return undefined
    // The host's copy, resolved from its entry — never this package's peer
    // copy, which may sit on another line.
    const require = createRequire(entry)
    const appBoot: unknown = await import(pathToFileURL(require.resolve(APP_BOOT)).href)
    if (!isAppBoot(appBoot)) return undefined
    const dir = typeof appBoot.resolveProfileDir === 'function'
      ? appBoot.resolveProfileDir(options.profile, options.dshHome)
      : join(options.dshHome, 'profiles', options.profile)
    const context: ProfileContext = {
      dir,
      installAnchor,
      patchPath: join(dir, PROFILE_PATCH_FILENAME),
      home: options.dshHome,
      overlays: patchOverlaysFromHostArgv(options.argv).flatMap(file => appBoot.loadOverlayPatches(BIN_NAME, file)),
      // The telemetry row it toggles is not the dsh-tui row.
      telemetryDisabledEnv: undefined,
    }
    // 0.1.7-rc.1 reports a skipped bundle straight to stderr; before the
    // first frame that line would land on the terminal. The call is
    // synchronous, so the swap covers exactly it. dsh repeats the report
    // when it composes for real.
    const write = process.stderr.write
    let entries: unknown[]
    try {
      process.stderr.write = (() => true) as typeof process.stderr.write
      entries = appBoot.composeEntries([appBoot.readProfilePatches(BIN_NAME, context)])
    } finally {
      process.stderr.write = write
    }
    const row = entries.find(item =>
      item !== null && typeof item === 'object' && (item as { id?: unknown }).id === TUI_ENTRY_ID) as { config?: unknown } | undefined
    if (row === undefined) return undefined
    const config = row.config
    return {
      // A row with no config block composes to schema defaults.
      config: config !== null && typeof config === 'object' && !Array.isArray(config)
        ? config as Readonly<Record<string, unknown>>
        : {},
      legacySettings: await hostSettingsRegister(require),
    }
  } catch {
    return undefined
  }
}
