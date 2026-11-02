/**
 * Host-engine (`dsh`) update planning: peer-range parsing, target selection
 * and global-install classification.
 *
 * Backend-neutral on purpose: this module carries no `@deepseek-ai/*` import or
 * literal. The caller (`src/update.ts`) supplies the package names and the
 * registry data, so the same rules can be exercised without a network.
 *
 * The single source of truth for the engine line is the TARGET TUI's
 * `@deepseek-ai/dsh-app-boot` peer range. Published ranges are version
 * enumerations (`0.2.0-rc.2 || 0.2.1-rc.2 || …`), so parsing is exact: a range
 * with operators is refused instead of guessed at. `scripts/verify-manifest-deps.ts`
 * fails the release when the enumeration leaves the validated line, so the
 * runtime never has to trust a range it cannot enumerate.
 */
import { accessSync, constants, readFileSync, realpathSync } from 'node:fs'
import { basename, join, resolve, sep } from 'node:path'
import gt from 'semver/functions/gt.js'
import valid from 'semver/functions/valid.js'

/** `DSH_TUI_DSH_PM=npm|pnpm` forces the package-manager classification. */
export const DSH_PM_ENV = 'DSH_TUI_DSH_PM'

export type HostInstaller = 'npm' | 'pnpm' | 'volta' | 'unknown'

/** A detected global `dsh` install and the way this machine updates it. */
export interface HostInstall {
  /** Real package directory (realpath applied when readable). */
  readonly packageDir: string
  /** Manifest version; undefined when unreadable. */
  readonly version: string | undefined
  readonly installer: HostInstaller
  /** npm global prefix (`<prefix>/lib/node_modules` or `<prefix>\node_modules`). */
  readonly prefix?: string
  /** PNPM_HOME to drive `pnpm add -g`; derived from the layout when possible. */
  readonly pnpmHome?: string
  /** False = the detected prefix is not writable (or cannot be checked). */
  readonly writable: boolean
}

/** One engine install command, with the extra env the layout needs. */
export interface HostCommand {
  readonly file: string
  readonly args: readonly string[]
  /** Environment additions for the child (`PNPM_HOME` on pnpm installs). */
  readonly env?: Readonly<Record<string, string>>
}

export type HostNoneReason =
  | 'newest'
  | 'newer-than-validated'
  | 'unknown-current'
  | 'unknown-range'
  | 'disabled'

export type HostUnavailableReason =
  | 'offline'
  | 'no-version'
  | 'no-installer'
  | 'not-writable'

/**
 * The engine half of an update plan.
 *
 * `none` with `disabled` still carries `to`/`manual` when an install WOULD
 * have been needed: the switch skips the automatic install, it does not
 * silently bless an incompatible pair (the caller refuses a TUI update that
 * would leave an engine outside the new TUI's range).
 */
export type HostStep =
  | {
    readonly kind: 'none'
    readonly reason: HostNoneReason
    readonly from?: string
    readonly to?: string
    readonly manual?: readonly string[]
  }
  | {
    readonly kind: 'install'
    readonly from: string | undefined
    readonly to: string
    readonly packageDir: string
    readonly command: HostCommand
    /** Manual fallback commands if the automated install fails. */
    readonly manual: readonly string[]
  }
  | {
    readonly kind: 'unavailable'
    readonly reason: HostUnavailableReason
    readonly from?: string
    readonly to?: string
    readonly manual: readonly string[]
  }

export type HostTargetSelection =
  | { readonly kind: 'none'; readonly reason: 'newest' | 'newer-than-validated' | 'unknown-current' }
  | { readonly kind: 'install'; readonly to: string }
  | { readonly kind: 'unavailable'; readonly reason: 'no-version' }

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Parse an enumerated peer range into exact versions.
 *
 * @param raw - e.g. `'0.2.0-rc.2 || 0.2.1-rc.5'`.
 * @returns Deduplicated versions, or `[]` for an absent/operator range.
 */
export function parseHostLineRange(raw: string | undefined): string[] {
  if (raw === undefined || raw.trim() === '') return []
  const versions: string[] = []
  for (const part of raw.split('||')) {
    const version = valid(part.trim())
    if (version === null) return []
    if (!versions.includes(version)) versions.push(version)
  }
  return versions
}

function newestVersion(versions: readonly string[]): string | undefined {
  let newest: string | undefined
  for (const version of versions) {
    const parsed = valid(version)
    if (parsed === null) continue
    if (newest === undefined || gt(parsed, newest)) newest = parsed
  }
  return newest
}

/**
 * Pick the engine version for a target TUI line.
 *
 * `newest` is the highest PUBLISHED version inside `allowed`; anything newer
 * on the registry (an alpha line, say) is never selected. A current engine
 * ahead of the window is kept — this project never downgrades — and reported
 * as drift by the caller.
 *
 * @param input - Current engine, the target TUI's enumerated line, and the
 *   registry's published versions.
 */
export function selectHostTarget(input: {
  readonly current: string | undefined
  readonly allowed: readonly string[]
  readonly available: readonly string[]
}): HostTargetSelection {
  const current = input.current === undefined ? null : valid(input.current)
  if (current === null) return { kind: 'none', reason: 'unknown-current' }
  const published = new Set<string>()
  for (const version of input.available) {
    const parsed = valid(version)
    if (parsed !== null) published.add(parsed)
  }
  const candidates = input.allowed.filter(version => published.has(version))
  const newest = newestVersion(candidates)
  if (newest === undefined) return { kind: 'unavailable', reason: 'no-version' }
  if (current === newest) return { kind: 'none', reason: 'newest' }
  if (gt(current, newest)) return { kind: 'none', reason: 'newer-than-validated' }
  return { kind: 'install', to: newest }
}

/** The npm global prefix of a package dir, or undefined for other layouts. */
function npmPrefix(dir: string, platform: NodeJS.Platform): string | undefined {
  // POSIX npm puts globals under `<prefix>/lib/node_modules`, every platform's
  // project installs under `<project>/node_modules`. Only the global shape is
  // an install this module may drive.
  const posixMarker = `${sep}lib${sep}node_modules${sep}`
  const posixIndex = dir.lastIndexOf(posixMarker)
  if (posixIndex > 0) return dir.slice(0, posixIndex)
  if (platform !== 'win32') return undefined
  // npm's Windows shim tree is `<prefix>\node_modules`; accept it only when the
  // prefix is npm's own directory, so a project or a yarn/asdf tree stays
  // unclassified instead of being installed into by guesswork.
  const windowsMarker = `${sep}node_modules${sep}`
  const windowsIndex = dir.lastIndexOf(windowsMarker)
  if (windowsIndex <= 0) return undefined
  const prefix = dir.slice(0, windowsIndex)
  return basename(prefix).toLowerCase() === 'npm' ? prefix : undefined
}

function isWritable(path: string): boolean {
  try {
    accessSync(path, constants.W_OK)
    return true
  } catch {
    return false
  }
}

/**
 * Classify a host package directory by layout. Only recognized global npm /
 * pnpm layouts are auto-installable; volta and anything else are reported as
 * such so the caller prints a manual command instead of guessing.
 *
 * @param packageDir - The installed `@deepseek-ai/dsh` package directory.
 * @param env - Process environment (`PNPM_HOME`, `DSH_TUI_DSH_PM`).
 * @param platform - Test seam for the Windows npm layout.
 */
export function detectHostInstall(
  packageDir: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): HostInstall {
  let dir = resolve(packageDir)
  try {
    dir = realpathSync(dir)
  } catch {
    // Keep the logical path; the manifest read and classification still work.
  }
  let version: string | undefined
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    if (isRecord(parsed) && typeof parsed.version === 'string') version = valid(parsed.version) ?? undefined
  } catch {
    // An unreadable manifest leaves the version unknown; the caller then
    // declines to touch the engine.
  }
  const forced = env[DSH_PM_ENV] === 'npm' || env[DSH_PM_ENV] === 'pnpm' ? env[DSH_PM_ENV] : undefined

  // volta's image tree is owned by volta itself.
  if (/[\\/]\.volta[\\/]tools[\\/]image[\\/]/u.test(dir)) {
    return { packageDir: dir, version, installer: 'volta', writable: false }
  }
  // pnpm's global projects: `<pnpm home>/global/<n>/…` (pnpm 11) or
  // `<pnpm home>/global/v<n>/…` (pnpm 12). The layout itself proves the home;
  // an ambient PNPM_HOME that disagrees must not send the install elsewhere
  // (plan §3.3: "PNPM_HOME 取 global 的父目录").
  const globalRoot = /^(.*?)[\\/]global[\\/]v?\d+[\\/]/u.exec(dir)
  if (globalRoot !== null && globalRoot[1] !== '') {
    const home = globalRoot[1]
    return {
      packageDir: dir,
      version,
      installer: forced ?? 'pnpm',
      pnpmHome: home,
      writable: isWritable(home),
    }
  }
  // pnpm 12's global store links: the realpath has no `global/` segment, and
  // the store root is often NOT the PNPM_HOME, so no home is derived here.
  if (/[\\/]store[\\/]v\d+[\\/]links[\\/]/u.test(dir)) {
    return {
      packageDir: dir,
      version,
      installer: forced ?? 'pnpm',
      ...(env.PNPM_HOME === undefined ? {} : { pnpmHome: env.PNPM_HOME }),
      writable: env.PNPM_HOME === undefined ? true : isWritable(env.PNPM_HOME),
    }
  }
  // A project-local pnpm store: `pnpm add -g` would install elsewhere.
  if (/[\\/]\.pnpm[\\/]/u.test(dir)) {
    return { packageDir: dir, version, installer: 'unknown', writable: false }
  }
  const prefix = npmPrefix(dir, platform)
  if (prefix !== undefined) {
    if (forced === 'pnpm') {
      return {
        packageDir: dir,
        version,
        installer: 'pnpm',
        ...(env.PNPM_HOME === undefined ? {} : { pnpmHome: env.PNPM_HOME }),
        writable: env.PNPM_HOME === undefined ? true : isWritable(env.PNPM_HOME),
      }
    }
    return { packageDir: dir, version, installer: 'npm', prefix, writable: isWritable(prefix) }
  }
  return { packageDir: dir, version, installer: 'unknown', writable: false }
}

/**
 * pnpm >= 11 refuses versions younger than `minimumReleaseAge` (24h by
 * default) unless that exact version is exempted. The profile install writes
 * the exemption into the profile's workspace file; the one-shot global
 * installs here have no such file, and `/update` runs right after a release —
 * i.e. always inside the window. The pinned version is one the target TUI
 * validates, so the window is waived for that single invocation only. Both
 * spellings are set: pnpm 12's CLI reads PNPM_CONFIG_ (verified on 12.16.1;
 * its own error text advertises that form), while npm-style config readers
 * only understand npm_config_ - the repo pins pnpm 11 for releases, which
 * cannot be probed here, so the second spelling is kept rather than guessed
 * away. Each reader ignores the other's variable. The waiver covers the whole
 * dependency closure of this one install, not just the package: the engine's
 * closure is published in lockstep at the same version, so an exact-version
 * exclusion would not unblock it anyway.
 */
export const PNPM_RELEASE_AGE_ENV: Readonly<Record<string, string>> = {
  PNPM_CONFIG_MINIMUM_RELEASE_AGE: '0',
  npm_config_minimum_release_age: '0',
}

/** Render `NAME=value` prefixes so a printed command can be pasted as-is. */
export function shellEnvPrefix(
  vars: Readonly<Record<string, string>>,
  platform: NodeJS.Platform = process.platform,
): string {
  const entries = Object.entries(vars)
  return platform === 'win32'
    ? entries.map(([name, value]) => `set ${name}=${value} && `).join('')
    : entries.map(([name, value]) => `${name}=${value} `).join('')
}

/** Quote a path for a printed command; it may contain spaces. */
function shellPath(value: string, platform: NodeJS.Platform): string {
  if (!/[\s"]/u.test(value)) return value
  // cmd.exe and POSIX shells both accept double quotes. A literal quote cannot
  // appear in a Windows path, so only the POSIX form needs escaping.
  return platform === 'win32' ? `"${value}"` : `"${value.replaceAll('"', '\\"')}"`
}

/** The installer command for a detected layout, or undefined when unknown. */
export function hostInstallCommand(install: HostInstall, packageName: string, version: string): HostCommand | undefined {
  const spec = `${packageName}@${version}`
  if (install.installer === 'pnpm') {
    return {
      file: 'pnpm',
      args: ['add', '-g', spec],
      env: {
        ...PNPM_RELEASE_AGE_ENV,
        ...(install.pnpmHome === undefined ? {} : { PNPM_HOME: install.pnpmHome }),
      },
    }
  }
  if (install.installer === 'npm') {
    return {
      file: 'npm',
      args: install.prefix === undefined
        ? ['install', '-g', spec]
        : ['install', '-g', '--prefix', install.prefix, spec],
    }
  }
  return undefined
}

/**
 * Manual repair commands for a layout. More than one entry when the platform
 * has an alternative (e.g. the sudo form for an unwritable npm prefix).
 *
 * @param install - Detected install; undefined when detection failed.
 */
export function hostManualCommands(
  packageName: string,
  version: string,
  install: HostInstall | undefined,
  platform: NodeJS.Platform = process.platform,
): string[] {
  const spec = `${packageName}@${version}`
  switch (install?.installer) {
    case 'pnpm': return [`${shellEnvPrefix(PNPM_RELEASE_AGE_ENV, platform)}pnpm add -g ${spec}`]
    case 'volta': return [`volta install ${spec}`]
    case 'npm': {
      // A prefix with spaces must survive copy-paste as one argument.
      const prefix = install.prefix === undefined ? '' : ` --prefix ${shellPath(install.prefix, platform)}`
      // Never elevate from inside the TUI: the user runs this themselves.
      const sudo = platform !== 'win32' && !install.writable ? 'sudo ' : ''
      return [`${sudo}npm install -g${prefix} ${spec}`]
    }
    default: return [`npm install -g ${spec}`]
  }
}

/**
 * Whether the engine is usable after the planned step. `undefined` = cannot
 * tell (unknown current version or unparseable range) and the caller must not
 * claim compatibility either way.
 *
 * An engine AHEAD of the window counts as usable: this project never
 * downgrades, and the boot drift notice reports the newer line.
 */
export function hostCompatibility(input: {
  readonly current: string | undefined
  readonly allowed: readonly string[]
  readonly step: HostStep
}): boolean | undefined {
  if (input.step.kind === 'install') return true
  const current = input.current === undefined ? null : valid(input.current)
  if (current === null) return undefined
  const allowed = input.allowed.map(version => valid(version)).filter((version): version is string => version !== null)
  if (allowed.length === 0) return undefined
  if (allowed.includes(current)) return true
  const newest = newestVersion(allowed)
  return newest !== undefined && gt(current, newest) ? true : false
}

/**
 * Build the engine step of a plan.
 *
 * @param input - Current version, the target TUI's enumerated peer range, the
 *   registry's available versions (undefined = lookup failed), the detected
 *   install, the package name and the `DSH_TUI_UPDATE_ENGINE=0` switch.
 */
export function planHostStep(input: {
  readonly current: string | undefined
  readonly range: string | undefined
  readonly available: readonly string[] | undefined
  readonly install: HostInstall | undefined
  readonly packageName: string
  readonly disabled?: boolean
}): HostStep {
  if (input.current === undefined || valid(input.current) === null) return { kind: 'none', reason: 'unknown-current' }
  if (input.range === undefined) return { kind: 'none', reason: 'unknown-range' }
  const allowed = parseHostLineRange(input.range)
  if (allowed.length === 0) return { kind: 'none', reason: 'unknown-range' }
  // A failed lookup still knows the range's highest target: the manual repair
  // command names it, so a refusal is always actionable (§10 of the plan).
  const manualVersion = newestVersion(allowed) ?? 'latest'
  if (input.available === undefined) {
    return {
      kind: 'unavailable',
      reason: 'offline',
      from: input.current,
      manual: hostManualCommands(input.packageName, manualVersion, input.install),
    }
  }
  const selection = selectHostTarget({ current: input.current, allowed, available: input.available })
  if (selection.kind === 'none') {
    return { kind: 'none', reason: selection.reason, from: input.current, ...(selection.reason === 'newer-than-validated' ? { to: newestVersion(allowed) } : {}) }
  }
  if (selection.kind === 'unavailable') {
    return {
      kind: 'unavailable',
      reason: 'no-version',
      from: input.current,
      to: manualVersion === 'latest' ? undefined : manualVersion,
      manual: hostManualCommands(input.packageName, manualVersion, input.install),
    }
  }
  const manual = hostManualCommands(input.packageName, selection.to, input.install)
  if (input.disabled === true) {
    // Keep the target/command in the refusal path: skipping the automatic
    // install must not hide an incompatible pair.
    return { kind: 'none', reason: 'disabled', from: input.current, to: selection.to, manual }
  }
  const command = input.install === undefined ? undefined : hostInstallCommand(input.install, input.packageName, selection.to)
  if (input.install === undefined || command === undefined) {
    return { kind: 'unavailable', reason: 'no-installer', from: input.current, to: selection.to, manual }
  }
  if (!input.install.writable) {
    return { kind: 'unavailable', reason: 'not-writable', from: input.current, to: selection.to, manual }
  }
  return { kind: 'install', from: input.current, to: selection.to, packageDir: input.install.packageDir, command, manual }
}
