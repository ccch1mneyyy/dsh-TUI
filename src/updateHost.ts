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
import { accessSync, constants, existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { basename, delimiter, dirname, join, resolve, sep } from 'node:path'
import gt from 'semver/functions/gt.js'
import prerelease from 'semver/functions/prerelease.js'
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
  /** PNPM_HOME to drive `pnpm add -g`; derived from the owning group, never ambient. */
  readonly pnpmHome?: string
  /**
   * The pnpm isolated install group that owns `packageDir`. Only set when the
   * ownership was proven (the package path itself names `global/<n>`, or a
   * `dsh` shim on PATH leads to the group). `pnpm add -g <one package>`
   * replaces the whole group, so an unproven group is never auto-installed
   * into.
   */
  readonly groupRoot?: string
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
   * A pnpm install whose owning group cannot be proven to contain this package
   * alone. `pnpm add -g <one package>` replaces every group that contains it,
   * deleting co-installed CLIs, so this is refused instead of guessed at.
   */
  | 'group-unproven'

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
    /**
     * A newer engine release is published, but outside the target TUI's
     * enumerated line — the set is settled on the validated line, and the
     * notice must say it is waiting for a TUI release instead of looking
     * like a failed upgrade. Alpha lines never set this: they are never
     * selected by policy, so naming one would be noise.
     */
    readonly newerPublished?: string
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
 * The newest published engine release outside the target TUI's enumerated
 * line. This only feeds the "waiting for a TUI release" notice: the line
 * itself stays the selection rule, and an unvalidated alpha is not named
 * (policy never selects it, so reporting it would be noise rather than an
 * actionable wait).
 *
 * @param available - Published registry versions, or undefined when the
 *   lookup failed.
 * @param newestAllowed - Highest version in the target TUI's peer range.
 * @returns The newer release, or undefined when the line already covers the
 *   registry's newest.
 */
function newerReleaseOutsideLine(
  available: readonly string[] | undefined,
  newestAllowed: string | undefined,
): string | undefined {
  if (available === undefined || newestAllowed === undefined) return undefined
  let newest: string | undefined
  for (const version of available) {
    const parsed = valid(version)
    if (parsed === null || !gt(parsed, newestAllowed)) continue
    // Skip only the alpha line, not the whole answer: a newer alpha must not
    // hide an rc/beta release outside the range that IS worth waiting for.
    if (prerelease(parsed)?.includes('alpha') === true) continue
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

/** `pnpm`'s global groups: `<home>/global/<n>` (pnpm 11) or `<home>/global/v<n>/<hash>` (pnpm 12). */
const GROUP_SLOT = /^v?\d+$/u
/** The `dsh` executable names a PATH entry can carry. */
function dshShimNames(platform: NodeJS.Platform): string[] {
  return platform === 'win32' ? ['dsh.cmd', 'dsh.ps1', 'dsh'] : ['dsh']
}

/** Read one group manifest's direct dependencies (the installed set). */
function pnpmGroupMembers(groupRoot: string): string[] | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(groupRoot, 'package.json'), 'utf8'))
    if (!isRecord(parsed) || !isRecord(parsed.dependencies)) return undefined
    return Object.keys(parsed.dependencies)
  } catch {
    return undefined
  }
}

/** Every candidate group root under a pnpm home, bounded like pnpm itself. */
function pnpmGroupRoots(pnpmHome: string): string[] {
  let slots: string[]
  try {
    slots = readdirSync(join(pnpmHome, 'global')).filter(name => GROUP_SLOT.test(name)).slice(0, 8)
  } catch {
    return []
  }
  const roots: string[] = []
  for (const slot of slots) {
    const slotDir = join(pnpmHome, 'global', slot)
    roots.push(slotDir)
    try {
      for (const name of readdirSync(slotDir)) {
        if (roots.length >= 64) break
        if (name !== 'node_modules') roots.push(join(slotDir, name))
      }
    } catch {
      // An unreadable slot proves nothing; the remaining slots still count.
    }
  }
  return roots
}

/**
 * Prove which pnpm home/group owns `packageDir` from the `dsh` shim on PATH.
 *
 * A pnpm 12 global install resolves through the shared virtual store, so the
 * package realpath no longer names its `global/` group — and the ambient
 * `PNPM_HOME` may belong to a completely different install. The shim that
 * launched this process is the ownership evidence: derive candidate homes from
 * PATH entries carrying `dsh`, then accept exactly one group whose declared
 * dependency really resolves to `packageDir`. No evidence or an ambiguous
 * result returns undefined (the caller refuses to write).
 *
 * pnpm >= 11.21 keeps BOTH the real install directory and a hash symlink that
 * points at it in the same slot. They are one group, not two owners: compare
 * canonical (realpath) group roots so the alias is not counted twice. Two
 * genuinely distinct groups that both claim the package stay ambiguous.
 */
function pnpmOwnedGroup(
  packageDir: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): { readonly home: string; readonly groupRoot: string } | undefined {
  const names = dshShimNames(platform)
  const homes = new Set<string>()
  for (const dir of (env.PATH ?? env.Path ?? '').split(delimiter)) {
    if (dir === '') continue
    if (!names.some(name => existsSync(join(dir, name)))) continue
    homes.add(resolve(dir))
    homes.add(dirname(resolve(dir)))
  }
  const owned: { home: string; groupRoot: string }[] = []
  const groupRootKey = (groupRoot: string): string => {
    try {
      return realpathSync(groupRoot)
    } catch {
      return resolve(groupRoot)
    }
  }
  for (const home of homes) {
    for (const groupRoot of pnpmGroupRoots(home)) {
      const members = pnpmGroupMembers(groupRoot)
      if (members === undefined) continue
      const owns = members.some((name) => {
        try {
          return realpathSync(join(groupRoot, 'node_modules', name)) === packageDir
        } catch {
          return false
        }
      })
      // Canonicalize the entity, not the alias: `pnpm add -g` needs the real
      // group directory, and both spellings must collapse to one owner.
      const key = groupRootKey(groupRoot)
      if (owns && !owned.some(candidate => candidate.groupRoot === key)) owned.push({ home, groupRoot: key })
    }
  }
  return owned.length === 1 ? owned[0] : undefined
}

/**
 * Whether a pnpm step may be automated: the owning group must be proven and
 * must contain this package alone. `pnpm add -g <pkg>` replaces every group
 * containing `<pkg>`, so a multi-member group would lose its other CLIs.
 */
function pnpmGroupProven(install: HostInstall, packageName: string): boolean {
  if (install.installer !== 'pnpm' || install.groupRoot === undefined) return false
  const members = pnpmGroupMembers(install.groupRoot)
  return members !== undefined && members.length === 1 && members[0] === packageName
}

/**
 * Whether `dir` lives in a volta package image. The default `~/.volta` is not
 * the only valid home: `VOLTA_HOME` (honoured by `host-dsh.ts` when it follows
 * a volta shim) moves the image anywhere, and a custom image that is missed
 * here would be rewritten by `npm install -g --prefix` instead of left to
 * volta. The literal `/.volta/` fallback keeps the old classification for an
 * unexported home.
 */
function isVoltaImage(dir: string, env: NodeJS.ProcessEnv): boolean {
  const homes: string[] = []
  if (env.VOLTA_HOME !== undefined && env.VOLTA_HOME !== '') homes.push(env.VOLTA_HOME)
  const home = env.HOME ?? env.USERPROFILE
  if (home !== undefined && home !== '') homes.push(join(home, '.volta'))
  const roots = new Set<string>()
  for (const voltaHome of homes) {
    const image = resolve(join(voltaHome, 'tools', 'image'))
    roots.add(image)
    try {
      roots.add(realpathSync(image))
    } catch {
      // A missing image cannot be the one we are classifying; keep the path.
    }
  }
  for (const root of roots) {
    if (dir === root || dir.startsWith(root + sep)) return true
  }
  return /[\\/]\.volta[\\/]tools[\\/]image[\\/]/u.test(dir)
}

/**
 * Classify a host package directory by layout. Only recognized global npm /
 * pnpm layouts are auto-installable; volta and anything else are reported as
 * such so the caller prints a manual command instead of guessing.
 *
 * @param packageDir - The installed `@deepseek-ai/dsh` package directory.
 * @param env - Process environment (`PNPM_HOME`, `VOLTA_HOME`, `DSH_TUI_DSH_PM`).
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

  // volta's image tree is owned by volta itself (default or custom home).
  if (isVoltaImage(dir, env)) {
    return { packageDir: dir, version, installer: 'volta', writable: false }
  }
  // pnpm's global projects: `<pnpm home>/global/<n>/…` (pnpm 11) or
  // `<pnpm home>/global/v<n>/…` (pnpm 12). The layout itself proves both the
  // home and the owning group; an ambient PNPM_HOME that disagrees must not
  // send the install elsewhere (plan §3.3: "PNPM_HOME 取 global 的父目录").
  const globalRoot = /^(.*?)[\\/]global[\\/]v?\d+[\\/]/u.exec(dir)
  const globalGroup = /^(.*?[\\/]global[\\/]v?\d+)[\\/]/u.exec(dir)
  if (globalRoot !== null && globalRoot[1] !== '' && globalGroup !== null) {
    const home = globalRoot[1]
    return {
      packageDir: dir,
      version,
      installer: forced ?? 'pnpm',
      pnpmHome: home,
      groupRoot: globalGroup[1],
      writable: isWritable(home),
    }
  }
  // pnpm 12's global store links: the realpath has no `global/` segment, and
  // the store root is often NOT the PNPM_HOME. Ownership must come from the
  // `dsh` shim on PATH; an inherited PNPM_HOME is never adopted by guesswork,
  // or the install would land in an unrelated home.
  if (/[\\/]store[\\/]v\d+[\\/]links[\\/]/u.test(dir)) {
    const owned = pnpmOwnedGroup(dir, env, platform)
    if (owned === undefined) {
      return { packageDir: dir, version, installer: forced ?? 'pnpm', writable: false }
    }
    return {
      packageDir: dir,
      version,
      installer: forced ?? 'pnpm',
      pnpmHome: owned.home,
      groupRoot: owned.groupRoot,
      writable: isWritable(owned.home),
    }
  }
  // A project-local pnpm store: `pnpm add -g` would install elsewhere.
  if (/[\\/]\.pnpm[\\/]/u.test(dir)) {
    return { packageDir: dir, version, installer: 'unknown', writable: false }
  }
  const prefix = npmPrefix(dir, platform)
  if (prefix !== undefined) {
    if (forced === 'pnpm') {
      const owned = pnpmOwnedGroup(dir, env, platform)
      if (owned === undefined) {
        return { packageDir: dir, version, installer: 'pnpm', writable: false }
      }
      return {
        packageDir: dir,
        version,
        installer: 'pnpm',
        pnpmHome: owned.home,
        groupRoot: owned.groupRoot,
        writable: isWritable(owned.home),
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
    // `set "NAME=value"` is the cmd form that keeps spaces, `&`, `|`, `<`, `>`
    // and `^` literal; the outer quotes belong to cmd, not to the value.
    ? entries.map(([name, value]) => `set "${name}=${value}" && `).join('')
    : entries.map(([name, value]) => `${name}=${shellPath(value, platform)} `).join('')
}

/** Quote a path for a printed command; it may contain spaces or shell metacharacters. */
function shellPath(value: string, platform: NodeJS.Platform): string {
  if (platform === 'win32') {
    // cmd.exe: double quotes keep spaces and & | < > ^ ( ) literal. A literal
    // quote cannot appear in a Windows path, so it needs no escaping.
    return /[\s&|<>^()]/u.test(value) ? `"${value}"` : value
  }
  // POSIX: a conservative safe set stays bare; everything else becomes a
  // single-quoted literal, where $, backticks, \, ;, & and globbing are inert.
  if (/^[A-Za-z0-9_./:@%+,-]+$/u.test(value)) return value
  return `'${value.replaceAll("'", "'\\''")}'`
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
    case 'pnpm': {
      // `pnpm add -g <one package>` replaces every group containing it. Only a
      // proven singleton group may print that command; anything else gets an
      // inspection step instead of a command that would delete sibling CLIs.
      if (install.groupRoot === undefined || !pnpmGroupProven(install, packageName)) {
        return [
          `pnpm list -g --depth 0\n  Inspect the install group before aligning ${spec}; preserve every member and its peers. ` +
            'A single-package `pnpm add -g` replaces the whole group, so align it with the command that created that group.',
        ]
      }
      // The owner home is part of the command. Detection proves the group from
      // the owning shim even when the ambient PNPM_HOME names a DIFFERENT
      // install; dropping it from the printed form would repair the wrong
      // global install (the automated command pins it too).
      const env = install.pnpmHome === undefined
        ? PNPM_RELEASE_AGE_ENV
        : { ...PNPM_RELEASE_AGE_ENV, PNPM_HOME: install.pnpmHome }
      return [`${shellEnvPrefix(env, platform)}pnpm add -g ${spec}`]
    }
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
 * An engine AHEAD of the window counts as usable for the boot/restart
 * decision: this project never downgrades, and the boot drift notice reports
 * the newer line. This is NOT the official plugin manager's install check: the
 * manager validates a new TUI against the running engine with exact semver
 * membership, where an ahead engine is outside the line. Use
 * {@link hostSatisfiesLine} for that decision.
 */
export function hostCompatibility(input: {
  readonly current: string | undefined
  readonly allowed: readonly string[]
  readonly step?: HostStep
}): boolean | undefined {
  if (input.step?.kind === 'install') return true
  const current = input.current === undefined ? null : valid(input.current)
  if (current === null) return undefined
  const allowed = input.allowed.map(version => valid(version)).filter((version): version is string => version !== null)
  if (allowed.length === 0) return undefined
  if (allowed.includes(current)) return true
  const newest = newestVersion(allowed)
  return newest !== undefined && gt(current, newest) ? true : false
}

/**
 * Strict line membership for the official plugin manager's install check.
 *
 * The manager evaluates the target TUI's peer ranges against the RUNNING
 * engine with semver `satisfies()`; an engine ABOVE the enumerated line is
 * outside it exactly like an older one, so it cannot install that TUI.
 * `hostCompatibility` deliberately keeps an ahead engine usable for the
 * boot/restart decision and must not be used here.
 *
 * @param input - The current engine and the target TUI's enumerated line.
 * @returns true when the current version is one of the enumerated versions;
 *   false when it is outside; undefined when either side cannot be read.
 */
export function hostSatisfiesLine(input: {
  readonly current: string | undefined
  readonly allowed: readonly string[]
}): boolean | undefined {
  if (input.current === undefined) return undefined
  const current = valid(input.current)
  if (current === null) return undefined
  const allowed = input.allowed.map(version => valid(version)).filter((version): version is string => version !== null)
  if (allowed.length === 0) return undefined
  return allowed.includes(current)
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
    // A settled line can still have a newer release outside it. Remember it
    // so the idle notice explains the wait instead of reading as "nothing to
    // see" (the "TUI has not declared support yet" case from #1849 review).
    const newerPublished = selection.reason === 'newest'
      ? newerReleaseOutsideLine(input.available, manualVersion)
      : undefined
    return {
      kind: 'none',
      reason: selection.reason,
      from: input.current,
      ...(selection.reason === 'newer-than-validated' ? { to: manualVersion } : {}),
      ...(newerPublished === undefined ? {} : { newerPublished }),
    }
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
  // A pnpm step is only safe in a proven singleton group: `pnpm add -g` removes
  // every co-installed package from the group. Refuse to guess.
  if (input.install !== undefined && input.install.installer === 'pnpm' && !pnpmGroupProven(input.install, input.packageName)) {
    return { kind: 'unavailable', reason: 'group-unproven', from: input.current, to: selection.to, manual }
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
