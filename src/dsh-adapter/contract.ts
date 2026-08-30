/**
 * Upstream compatibility contract.
 *
 * The TUI is validated against a set of upstream prerelease lines — the
 * current primary (0.1.2-alpha.2) plus older lines kept in backward
 * compatibility across the 0.1.1 and 0.1.0 release families. Every official
 * package this adapter touches is blessed here; anything else must go
 * through upstream channels or the adapter, never the UI.
 *
 * `upstreamDrift()` powers the CI gate (scripts/verify-upstream-contract.ts)
 * so a mismatched install fails in CI before it fails on a user's machine.
 * `upstreamDriftSummary()` collapses the per-package entries into the
 * single natural-language boot notice the logo header shows (see LogoV2).
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/** Primary validated upstream line (newest). */
export const UPSTREAM_VALIDATED_VERSION = '0.1.2-alpha.2'

/**
 * Every upstream prerelease line the adapter has been validated against,
 * oldest first.
 *
 * 0.1.2-alpha.2 = primary; 0.1.1-rc.2 and rc.1 are compatibility lines
 * (install- and type-level compatibility); 0.1.0-rc.8 = previous family
 * (full CI coverage); 0.1.0-rc.7 = full CI coverage as well; 0.1.0-rc.6 =
 * legacy line (install- and type-level compatibility, feature surface may
 * lack later additions — new features must degrade gracefully there).
 * The peer range in package.json is deliberately wider than this list: an
 * install on an older or newer line is allowed but reports drift at boot.
 */
export const UPSTREAM_VALIDATED_VERSIONS = [
  '0.1.0-rc.6',
  '0.1.0-rc.7',
  '0.1.0-rc.8',
  '0.1.1-rc.1',
  '0.1.1-rc.2',
  '0.1.2-alpha.2',
] as const

/**
 * Framework packages version on their own lines; the contract validates
 * their MAJOR (breaking surface), not the harness prerelease number.
 */
export const UPSTREAM_FRAMEWORK_MAJORS: Record<string, number> = {
  '@deepseek-ai/cordis': 4,
  '@deepseek-ai/schemastery': 3,
}

/** Official packages the adapter consumes at runtime or as types. */
export const UPSTREAM_BLESSED_PACKAGES = [
  '@deepseek-ai/cordis',
  '@deepseek-ai/schemastery',
  '@deepseek-ai/dsh-invariants',
  '@deepseek-ai/dsh-agent',
  '@deepseek-ai/dsh-agent-instructions',
  '@deepseek-ai/dsh-agent-presets',
  '@deepseek-ai/dsh-atomic-write',
  '@deepseek-ai/dsh-code-runtime-worker-thread',
  '@deepseek-ai/dsh-commands',
  '@deepseek-ai/dsh-cordis-host-runner',
  '@deepseek-ai/dsh-llm',
  '@deepseek-ai/dsh-llm-pi-ai',
  '@deepseek-ai/dsh-persona',
  '@deepseek-ai/dsh-session',
  '@deepseek-ai/dsh-settings',
  '@deepseek-ai/dsh-skill',
  '@deepseek-ai/dsh-storage',
  '@deepseek-ai/dsh-storage-domain',
  '@deepseek-ai/dsh-storage-json',
  '@deepseek-ai/dsh-workspace',
  '@deepseek-ai/dsh-system-prompt',
  '@deepseek-ai/dsh-terminal',
  '@deepseek-ai/dsh-terminal-bash',
  '@deepseek-ai/dsh-tool-ask-user',
  '@deepseek-ai/dsh-tool-bash-persistent',
  '@deepseek-ai/dsh-tool-cordis',
  '@deepseek-ai/dsh-tool-subagent',
  '@deepseek-ai/dsh-user-approval',
  '@deepseek-ai/dsh-user-questions',
] as const

export interface UpstreamDriftEntry {
  package: string
  installed: string | undefined
  validated: string
}

/** Supported upstream prerelease channels in ascending precedence order. */
export type UpstreamPrereleaseChannel = 'alpha' | 'beta' | 'rc'

/** A parsed upstream prerelease version, e.g. `0.1.2-alpha.1` → `[0, 1, 2, 'alpha', 1]`. */
export type UpstreamVersionTuple = readonly [number, number, number, UpstreamPrereleaseChannel, number]

/** Parse an upstream prerelease version; undefined when unparseable. */
export function parseUpstreamVersion(version: string | undefined): UpstreamVersionTuple | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)-(alpha|beta|rc)\.(\d+)$/u.exec(version ?? '')
  return match === null
    ? undefined
    : [Number(match[1]), Number(match[2]), Number(match[3]), match[4] as UpstreamPrereleaseChannel, Number(match[5])]
}

/** Order two parsed versions: negative/positive/zero as a `<`/`>`/`=`. */
export function compareVersions(a: UpstreamVersionTuple, b: UpstreamVersionTuple): number {
  for (const index of [0, 1, 2] as const) {
    if (a[index] > b[index]) return 1
    if (a[index] < b[index]) return -1
  }
  const channelRank: Record<UpstreamPrereleaseChannel, number> = { alpha: 0, beta: 1, rc: 2 }
  const channelOrder = channelRank[a[3]] - channelRank[b[3]]
  return channelOrder !== 0 ? channelOrder : a[4] - b[4]
}

/** Collapse validated versions into per-release and per-channel groups. */
function validatedLinesLabel(): string {
  const groups: { release: string; channel: UpstreamPrereleaseChannel; numbers: number[] }[] = []
  for (const version of UPSTREAM_VALIDATED_VERSIONS) {
    const [major, minor, patch, channel, number] = parseUpstreamVersion(version)!
    const release = `${major}.${minor}.${patch}`
    let group = groups.find(candidate => candidate.release === release && candidate.channel === channel)
    if (group === undefined) {
      group = { release, channel, numbers: [] }
      groups.push(group)
    }
    group.numbers.push(number)
  }
  return groups.map(({ release, channel, numbers }) => `${release}-${channel}.${numbers.join('/')}`).join(', ')
}

/** Human-readable summary of the exact validated prerelease lines. */
export const UPSTREAM_VALIDATED_LABEL = `${UPSTREAM_VALIDATED_VERSION} (${validatedLinesLabel()})`

function resolvePackageJson(packageName: string): string | undefined {
  try {
    const path = import.meta.resolve(`${packageName}/package.json`)
    return path.startsWith('file:') ? fileURLToPath(path) : path
  } catch {
    return undefined
  }
}

let cachedVersions: Record<string, string | undefined> | undefined
export function installedUpstreamVersions(): Record<string, string | undefined> {
  // Package manifests do not change mid-process; memoize so per-call gates
  // (e.g. the command-images line check) stay cheap. Frozen so callers can
  // never corrupt the shared cache.
  if (cachedVersions !== undefined) return cachedVersions
  const result: Record<string, string | undefined> = {}
  for (const packageName of UPSTREAM_BLESSED_PACKAGES) {
    let version: string | undefined
    const path = resolvePackageJson(packageName)
    if (path !== undefined) {
      try {
        const manifest = JSON.parse(readFileSync(path, 'utf8')) as { version?: string }
        version = manifest.version
      } catch {
        version = undefined
      }
    }
    result[packageName] = version
  }
  cachedVersions = Object.freeze(result)
  return cachedVersions
}

/**
 * The installed upstream version of one blessed package, parsed; undefined
 * when missing or not on a supported `x.y.z-(alpha|beta|rc).n` line. Feature gates
 * compare this against the line a behavior was introduced on, so the
 * adapter degrades on older installs instead of calling APIs they do not
 * have.
 */
export function installedUpstreamVersion(packageName: string): UpstreamVersionTuple | undefined {
  return parseUpstreamVersion(installedUpstreamVersions()[packageName])
}

/**
 * Whether the installed version of `packageName` is at or beyond `minimum`
 * (a literal like `'0.1.0-rc.8'`). Unparseable or older installs return
 * false so features introduced on the minimum line degrade gracefully.
 */
export function installedMeetsVersion(packageName: string, minimum: string): boolean {
  const installed = installedUpstreamVersion(packageName)
  const floor = parseUpstreamVersion(minimum)
  if (installed === undefined || floor === undefined) return false
  return compareVersions(installed, floor) >= 0
}

/**
 * The distinct installed prerelease versions across the blessed harness
 * packages (framework packages excluded). One entry = coherent install;
 * several = a mixed tree, which the per-package drift check cannot see.
 * Empty when nothing (or no harness package) is installed.
 */
export function installedUpstreamLines(
  installedVersions: Readonly<Record<string, string | undefined>> = installedUpstreamVersions(),
): string[] {
  const lines = new Set<string>()
  for (const packageName of UPSTREAM_BLESSED_PACKAGES) {
    if (UPSTREAM_FRAMEWORK_MAJORS[packageName] !== undefined) continue
    const version = installedVersions[packageName]
    if (version !== undefined && parseUpstreamVersion(version) !== undefined) lines.add(version)
  }
  return [...lines].sort((a, b) => compareVersions(parseUpstreamVersion(a)!, parseUpstreamVersion(b)!))
}

/**
 * Report every blessed package whose installed version is NOT one of the
 * validated release lines. Empty array = the running install matches the
 * contract.
 */
export function upstreamDrift(
  installedVersions: Readonly<Record<string, string | undefined>> = installedUpstreamVersions(),
): UpstreamDriftEntry[] {
  const validated = new Set<string>(UPSTREAM_VALIDATED_VERSIONS)
  const drift: UpstreamDriftEntry[] = []
  for (const [packageName, installed] of Object.entries(installedVersions)) {
    const expected = UPSTREAM_BLESSED_PACKAGES.includes(packageName as never)
    if (!expected) continue
    let matches: boolean
    const frameworkMajor = UPSTREAM_FRAMEWORK_MAJORS[packageName]
    if (frameworkMajor !== undefined) {
      const installedMajor = Number((installed ?? '').split('.')[0])
      matches = installedMajor === frameworkMajor
    } else {
      matches = installed !== undefined && validated.has(installed)
    }
    if (!matches) {
      drift.push({
        package: packageName,
        installed,
        validated: frameworkMajor !== undefined ? `major ${frameworkMajor}` : UPSTREAM_VALIDATED_LABEL,
      })
    }
  }
  return drift
}

/**
 * Classification of a drifted install for the one-line boot notice:
 * `newer` / `older` — every drifted harness package sits on a single
 * parseable version off one end of the validated window; `mixed` — several
 * distinct versions coexist (unstable tree); `broken` — something is
 * missing or unparseable and wording cannot get more specific.
 */
export type UpstreamDriftKind = 'newer' | 'older' | 'mixed' | 'broken'

/** Merged drift verdict consumed by the logo header notice (LogoV2). */
export interface UpstreamDriftSummary {
  kind: UpstreamDriftKind
  /** Distinct installed versions among drifted packages ('missing' for absent ones). */
  versions: string[]
}

/**
 * Collapse {@link upstreamDrift} into a single summary for the boot notice:
 * undefined when the install matches the contract. Only harness prerelease packages
 * decide newer/older/mixed; a framework-only drift (e.g. a cordis major
 * bump) reports `broken`, since its version line is not comparable.
 */
export function upstreamDriftSummary(
  installedVersions: Readonly<Record<string, string | undefined>> = installedUpstreamVersions(),
): UpstreamDriftSummary | undefined {
  const installedLines = installedUpstreamLines(installedVersions)
  if (installedLines.length > 1) return { kind: 'mixed', versions: installedLines }
  const drift = upstreamDrift(installedVersions)
  if (drift.length === 0) return undefined
  const harness = drift.filter(entry => UPSTREAM_FRAMEWORK_MAJORS[entry.package] === undefined)
  const versions = [...new Set(drift.map(entry => entry.installed ?? 'missing'))]
  if (harness.some(entry => entry.installed === undefined)) {
    return { kind: 'broken', versions }
  }
  const harnessVersions = [...new Set(harness.map(entry => entry.installed!))]
  if (harnessVersions.length > 1) {
    return { kind: 'mixed', versions }
  }
  const installed = parseUpstreamVersion(harnessVersions[0] ?? '')
  const validated = parseUpstreamVersion(UPSTREAM_VALIDATED_VERSION)!
  if (installed === undefined) {
    return { kind: 'broken', versions }
  }
  const order = compareVersions(installed, validated)
  if (order > 0) return { kind: 'newer', versions }
  if (order < 0) return { kind: 'older', versions }
  // Identical to the primary validated version — cannot happen (it would
  // not be drift); report broken rather than staying silent.
  return { kind: 'broken', versions }
}
