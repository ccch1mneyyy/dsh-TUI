/**
 * The host contract of this package's entry (ADAPTER.md): what the entry
 * loads from the installed `dsh` and what it reproduces. Read by
 * ./host-dsh.ts, ./contract.ts and scripts/verify-host-contract.ts.
 * Pure data, no imports.
 */

/** The host CLI package whose installation the entry loads. */
export const HOST_PACKAGE = '@deepseek-ai/dsh'

/** The host line the reproduced pieces were checked against (host-replica.snapshot.json). */
export const HOST_REPLICA_VERSION = '0.2.0-rc.2'

/** Where the entry resolves a host module from. */
export type HostModuleVia =
  /** The host package's own `createRequire` (its nested node_modules). */
  | 'host'
  /** `@deepseek-ai/dsh-app-boot`'s `createRequire`: the instance app-boot itself uses. */
  | 'app-boot'

export interface HostModuleSpec {
  /** The `HostDsh` field it fills. */
  readonly key: string
  readonly specifier: string
  readonly via: HostModuleVia
  /** Every export the entry reads; the probe requires each to be defined. */
  readonly exports: readonly string[]
}

/** The host modules the entry loads, all from one installation, in load order. */
export const HOST_MODULES = [
  { key: 'cordis', specifier: '@deepseek-ai/cordis', via: 'host', exports: ['Context'] },
  {
    key: 'appBoot',
    specifier: '@deepseek-ai/dsh-app-boot',
    via: 'host',
    exports: ['loadLayeredEnv', 'createRuntimeResolution', 'PluginPackages', 'installFailLoud', 'readProfilePatches', 'mountRootInclude', 'auditStartupEntries', 'StartupError', 'getDshRuntimeVersion'],
  },
  // The Loader's builtins must be the instance app-boot mounts includes with.
  { key: 'loader', specifier: '@deepseek-ai/cordis-plugin-loader', via: 'app-boot', exports: ['default'] },
  { key: 'homePaths', specifier: '@deepseek-ai/dsh-home-paths', via: 'app-boot', exports: ['dshHomePath', 'resolveDshHome'] },
  { key: 'launchEnvironment', specifier: '@deepseek-ai/dsh-launch-environment', via: 'host', exports: ['DSH_LAUNCH_ENVIRONMENT_KEY'] },
  { key: 'cmdline', specifier: '@deepseek-ai/dsh-cmdline', via: 'host', exports: ['provideCmdline'] },
  { key: 'profileBoot', specifier: '@deepseek-ai/dsh/profile-boot', via: 'host', exports: ['prepareProfile', 'INSTALL_ANCHOR', 'PROFILE_ROOT_FILENAME'] },
  { key: 'httpProxy', specifier: '@deepseek-ai/dsh-http-proxy', via: 'host', exports: ['installProxyFromEnvironment'] },
] as const satisfies readonly HostModuleSpec[]

/**
 * The packages ./host-dsh.ts takes types from (`import type` only); each is
 * an optional peer + dev dependency and blessed. Not the host package itself
 * (its dependency tree is the whole CLI).
 */
export const HOST_TYPE_PACKAGES = [
  '@deepseek-ai/dsh-app-boot',
  '@deepseek-ai/dsh-cmdline',
  '@deepseek-ai/dsh-home-paths',
  '@deepseek-ai/dsh-http-proxy',
  '@deepseek-ai/dsh-launch-environment',
] as const

/** One upstream body the entry reproduces (fingerprinted by verify:contract). */
export interface HostReplica {
  readonly id: string
  /** The package holding the upstream body; its `lib/*.js` are searched. */
  readonly package: string
  /** A top-level `function` (sync or async) or `const` in that package's lib. */
  readonly symbol: string
  readonly kind: 'function' | 'const'
  /** What in ./host-dsh.ts reproduces it, and how far. */
  readonly local: string
}

/**
 * The reproduced upstream pieces. A changed fingerprint means: re-read the
 * upstream body against `local`, carry the change over, regenerate the snapshot.
 */
export const HOST_REPLICAS: readonly HostReplica[] = [
  { id: 'process-shutdown', package: HOST_PACKAGE, symbol: 'createProcessShutdown', kind: 'function', local: 'createProcessShutdown: the `shutdown` half only (`interrupt` is replaced by process-exit.ts, see HOST_DEVIATIONS)' },
  { id: 'process-shutdown-timeout', package: HOST_PACKAGE, symbol: 'PROCESS_SHUTDOWN_TIMEOUT_MS', kind: 'const', local: 'process-exit.ts PROCESS_SHUTDOWN_TIMEOUT_MS' },
  { id: 'app-ready', package: HOST_PACKAGE, symbol: 'createAppReady', kind: 'function', local: 'createAppReady' },
  { id: 'compose-profile', package: HOST_PACKAGE, symbol: 'composeProfile', kind: 'function', local: 'prepareHostRoot steps 1–2 (no overlays, no resolvedProfile)' },
  { id: 'run-profile', package: HOST_PACKAGE, symbol: 'runProfile', kind: 'function', local: 'prepareHostRoot steps 3, 5–7 (proxy, fail-loud, profileContext, launch environment, PluginPackages, provideCmdline) and HostRoot.compose\'s appReady.commit' },
  { id: 'boot', package: '@deepseek-ai/dsh-app-boot', symbol: 'boot', kind: 'function', local: 'prepareHostRoot step 4 (baseUrl, dshHomePath, internal/update, Loader) and HostRoot.compose (startup-log exporter, mountRootInclude, loader.await, auditStartupEntries, StartupError.startup)' },
  { id: 'startup-report', package: HOST_PACKAGE, symbol: 'reportStartupFailure', kind: 'function', local: 'writeStartupReport: the file half' },
  { id: 'run-cli', package: HOST_PACKAGE, symbol: 'runCli', kind: 'function', local: 'prepareHostRoot\'s loadLayeredEnv call before the profile; the StartupError-only report' },
]

/** Where the entry deliberately differs from `dsh --profile`. Documentation only; ADAPTER.md points here. */
export const HOST_DEVIATIONS: readonly { readonly id: string; readonly what: string }[] = [
  { id: 'no-interrupt', what: 'runProfile\'s SIGTERM/SIGINT handlers and createProcessShutdown().interrupt are not reproduced: the entry owns SIGTERM/SIGHUP/SIGINT (process-exit.ts installEntrySignals) and ends by the signal after the TUI\'s exit funnel, where interrupt exits 0 (TERM) / 130 (INT) — the launcher reads a numeric 130 as a crash (verify-entry-process-exit)' },
  { id: 'exit-seam', what: 'ctx.appExit (provideCmdline exit) goes to the TUI\'s exit funnel through ProcessExitSeam first, and to the reproduced shutdown only when the funnel refuses (prepareHostRoot exitSeam)' },
  { id: 'fail-loud-removable', what: 'installFailLoud\'s uninstaller is kept and called once apply() returned and processGuardActive() (host-entry.ts): from then on the TUI\'s process guard is the single owner of a fatal error; DSH_TUI_NO_185_PROCESS_GUARD=1 keeps fail-loud (verify-entry-process-exit)' },
  { id: 'startup-report-always', what: 'bin.js saves a report for a StartupError only and lets other startup errors crash; the entry saves one for every composition failure (HostComposeError carries the path) because the screen stays up' },
  { id: 'startup-report-no-terminal', what: 'reportStartupFailure\'s terminal half is not reproduced: the screen is up, the failure row names the report' },
  { id: 'no-overlays', what: '--patch overlays, --from-default-profile and resolvedProfile are not reproduced (the launcher passes none)' },
  { id: 'defer-root-guard', what: 'deferRootCapabilityGuard(root) (host-access.ts) keeps the TUI\'s root-capability guard off while the screen mounts; armRootCapabilityGuard then lets the first TUI row activation install it, as on the profile path, and the composition\'s settling installs it if no TUI row activated' },
  { id: 'report-exclude-network', what: 'host-entry.ts sets process.report.excludeNetwork = true for the process: DSH\'s flock libc probe (process.report.getReport) otherwise blocked ~10s on reverse lookups of sockets the mounted screen already opened' },
  { id: 'hijack-before-tui', what: 'the host\'s PluginPackages resolution is installed before any TUI module loads, for both kernels; runProfile installs it inside boot()\'s prepare' },
]
