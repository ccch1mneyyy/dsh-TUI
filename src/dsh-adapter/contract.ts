/**
 * Upstream compatibility contract.
 *
 * The TUI is validated against a set of upstream release lines — the
 * current primary (0.1.0-rc.8) plus older lines kept in backward
 * compatibility (0.1.0-rc.7, 0.1.0-rc.6). Every official package this
 * adapter touches is blessed here; anything else must go through upstream
 * channels or the adapter, never the UI.
 *
 * `upstreamDrift()` powers both the boot-time warning (dev visibility) and
 * the CI gate (scripts/verify-upstream-contract.ts) so a mismatched
 * install fails in CI before it fails on a user's machine.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/** Primary validated upstream line (newest). */
export const UPSTREAM_VALIDATED_VERSION = '0.1.0-rc.8'

/** Every upstream rc line the adapter has been validated against.
 *
 * rc.8 = primary; rc.7 = previous line (full CI coverage); rc.6 = legacy
 * line (install- and type-level compatibility, feature surface may lack
 * rc.7/rc.8 additions — new features must degrade gracefully there).
 * The peer range in package.json is deliberately wider than this list: an
 * install on an older line is allowed but reports drift at boot.
 */
export const UPSTREAM_VALIDATED_RC_LINES = [6, 7, 8] as const

/**
 * Framework packages version on their own lines; the contract validates
 * their MAJOR (breaking surface), not the harness rc number.
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
  '@deepseek-ai/dsh-commands',
  '@deepseek-ai/dsh-cordis-host-runner',
  '@deepseek-ai/dsh-llm',
  '@deepseek-ai/dsh-persona',
  '@deepseek-ai/dsh-session',
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
  '@deepseek-ai/dsh-user-approval',
  '@deepseek-ai/dsh-user-questions',
] as const

export interface UpstreamDriftEntry {
  package: string
  installed: string | undefined
  validated: string
}

/** Human-readable summary of the validated lines, e.g. `0.1.0-rc.8 (rc.6/rc.7/rc.8)`. */
export const UPSTREAM_VALIDATED_LABEL = `${UPSTREAM_VALIDATED_VERSION} (${UPSTREAM_VALIDATED_RC_LINES.map((n) => `rc.${n}`).join('/')})`

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
  // (e.g. the command-images line check) stay cheap.
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
  cachedVersions = result
  return result
}

/** The installed upstream rc line of one blessed package (undefined when
 *  missing or not on the 0.1.0-rc line). Feature gates compare this against
 *  the line a behavior was introduced on, so the adapter degrades on older
 *  installs instead of calling APIs they do not have. */
export function installedLineOf(packageName: string): number | undefined {
  return rcNumber(installedUpstreamVersions()[packageName])
}

function rcNumber(version: string | undefined): number | undefined {
  const match = /0\.1\.0-rc\.(\d+)/u.exec(version ?? '')
  return match === null ? undefined : Number(match[1])
}

/**
 * Report every blessed package whose installed version is NOT one of the
 * validated release lines. Empty array = the running install matches the
 * contract.
 */
export function upstreamDrift(): UpstreamDriftEntry[] {
  const drift: UpstreamDriftEntry[] = []
  for (const [packageName, installed] of Object.entries(installedUpstreamVersions())) {
    const expected = UPSTREAM_BLESSED_PACKAGES.includes(packageName as never)
    if (!expected) continue
    let matches: boolean
    const frameworkMajor = UPSTREAM_FRAMEWORK_MAJORS[packageName]
    if (frameworkMajor !== undefined) {
      const installedMajor = Number((installed ?? '').split('.')[0])
      matches = installedMajor === frameworkMajor
    } else {
      const installedLine = rcNumber(installed)
      matches = installedLine !== undefined && (UPSTREAM_VALIDATED_RC_LINES as readonly number[]).includes(installedLine)
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
