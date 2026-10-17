/** Pure installer decisions, shared by preflight, installation and regression tests. */
import semver from 'semver'

export const TUI_PACKAGE = '@deepseek-harness-tui/dsh-tui'
export const DSH_PACKAGE = '@deepseek-ai/dsh'

export function supportsNode(version, architecture, range) {
  return architecture === 'x64' && semver.satisfies(version, range)
}

function version(value) {
  if (!semver.valid(value)) throw new Error(`Invalid package version: ${value}`)
  return value
}

/** Read the maintained upstream contract without importing the application. */
export function extractContract(pkg, source) {
  const primary = source.match(/export const UPSTREAM_VALIDATED_VERSION\s*=\s*'([^']+)'/)?.[1]
  const list = source.match(/export const UPSTREAM_VALIDATED_VERSIONS\s*=\s*\[([\s\S]*?)\]\s*as const/)?.[1]
  if (!primary || !list) throw new Error('Cannot extract upstream version contract')
  const supported = [...list.matchAll(/'([^']+)'/g)].map(match => version(match[1])).sort(semver.compare)
  const range = pkg.peerDependencies?.['@deepseek-ai/dsh-agent']
  if (!supported.includes(primary) || !semver.satisfies(primary, range ?? '')) {
    throw new Error('Upstream primary is outside the declared peer contract')
  }
  return {
    schemaVersion: 1, tuiVersion: version(pkg.version), kernelVersion: version(primary),
    kernelMinimum: supported[0], kernelMaximum: supported.at(-1), kernelPeerRange: range,
    validatedKernelVersions: supported, nodeRange: pkg.engines.node,
  }
}

export function kernelAction(installed, metadata) {
  if (installed === undefined) return 'install'
  version(installed)
  if (semver.lt(installed, metadata.kernelVersion)) return 'upgrade'
  if (semver.gt(installed, metadata.kernelMaximum)) return 'downgrade'
  return semver.satisfies(installed, metadata.kernelPeerRange) ? 'keep' : 'incompatible'
}

/** Published RC versions inside the maintained contract, newest first. */
export function compatibleKernelVersions(versions, metadata) {
  if (!Array.isArray(versions)) throw new Error('Invalid registry version list')
  return versions.filter(value => semver.valid(value)
    && semver.prerelease(value)?.[0] === 'rc'
    && semver.gte(value, metadata.kernelMinimum) && semver.lte(value, metadata.kernelMaximum)
    && semver.satisfies(value, metadata.kernelPeerRange)).sort(semver.rcompare)
}

/** Published RC versions newer than the validated contract, newest first. */
export function newerKernelVersions(versions, metadata) {
  if (!Array.isArray(versions)) throw new Error('Invalid registry version list')
  return versions.filter(value => semver.valid(value)
    && semver.prerelease(value)?.[0] === 'rc'
    && semver.gt(value, metadata.kernelMaximum)).sort(semver.rcompare)
}

/** Accept an explicit RC only while it stays inside the maintained contract. */
export function assertKernelVersion(candidate, metadata) {
  version(candidate)
  if (semver.prerelease(candidate)?.[0] !== 'rc') throw new Error(`DSH ${candidate} is not an RC release`)
  if (semver.lt(candidate, metadata.kernelMinimum) || semver.gt(candidate, metadata.kernelMaximum)) throw new Error(`DSH ${candidate} is outside the validated range ${metadata.kernelMinimum}..${metadata.kernelMaximum}`)
  if (!semver.satisfies(candidate, metadata.kernelPeerRange)) throw new Error(`DSH ${candidate} does not satisfy the declared peer range`)
  return candidate
}

/** Select the newest published RC inside the contract, never an unrelated alpha channel. */
export function selectKernelVersion(versions, metadata) {
  const selected = compatibleKernelVersions(versions, metadata)[0]
  if (!selected) throw new Error('No published compatible RC version of DSH')
  return selected
}

export function tuiNeedsDowngrade(installed, metadata) {
  return installed !== undefined && semver.gt(version(installed), version(metadata.tuiVersion))
}

/** Preserve profile-owned settings and unrelated plugin declarations. */
export function mergeProfile(existing, tuiVersion) {
  const profile = existing === undefined ? { name: 'dsh-profile-dsh-tui', private: true } : structuredClone(existing)
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) throw new Error('Invalid profile manifest')
  if (profile.dependencies !== undefined && (!profile.dependencies || typeof profile.dependencies !== 'object' || Array.isArray(profile.dependencies))) throw new Error('Invalid profile dependencies')
  profile.dsh ??= {}
  profile.dsh.profile ??= {}
  const bundles = profile.dsh.profile.bundles ?? ['@deepseek-ai/dsh-base']
  if (!Array.isArray(bundles) || bundles.some(item => typeof item !== 'string')) throw new Error('Invalid profile bundles')
  profile.dependencies = { ...profile.dependencies, [TUI_PACKAGE]: tuiVersion }
  profile.dsh.profile.bundles = [...new Set([...bundles, TUI_PACKAGE])]
  return profile
}

/** Only remove an installer-owned PATH entry when no shared commands need it. */
export function updatePath(current, prefix, operation, owned = false, sharedCommands = false) {
  const normalize = value => value.trim().replace(/^"(.*)"$/, '$1').replace(/[\\/]+$/, '').toLowerCase()
  const parts = current.split(';')
  const matches = item => normalize(item) === normalize(prefix)
  if (operation === 'add') {
    if (parts.some(matches)) return { value: current, changed: false }
    return { value: `${current}${current && !current.endsWith(';') ? ';' : ''}${prefix}`, changed: true }
  }
  if (!owned || sharedCommands || !parts.some(matches)) return { value: current, changed: false }
  return { value: parts.filter(item => !matches(item)).join(';'), changed: true }
}
