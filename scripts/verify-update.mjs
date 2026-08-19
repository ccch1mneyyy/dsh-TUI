/**
 * Pure-function verification for the /update machinery (real compiled lib,
 * no network, no child processes):
 *
 * - installedTuiVersion() finds the version in both the compiled-package
 *   layout and the source-checkout layout, and prefers a matching manifest
 *   over a foreign one at the nearer level
 * - resolveRegistryBase() honors NPM_CONFIG_REGISTRY (both spellings), the
 *   user ~/.npmrc `registry=` line, and falls back to npmjs.org
 * - isVersionNewer() requires a strictly greater valid semver
 * - update command args pin the preflight target version, with --latest as the
 *   fallback when preflight could not resolve one
 * - isBootDeadlockTarget() flags exactly the 0.7.0–0.7.1 hard-inject range
 * - DSH_TUI_UPDATED_FROM is stamped from the pre-update version: the stamp
 *   read happens before the first installer child runs and the restart env
 *   reuses that captured value (issue #307's new-vs-new false alarm)
 *
 * Run: node scripts/verify-update.mjs
 */
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

let failed = 0
function check(name, ok, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed += 1
}

const {
  installedTuiVersion,
  resolveRegistryBase,
  isVersionNewer,
  isBootDeadlockTarget,
  resolveDshProfileName,
  shellQuote,
  tuiUpdatePluginArgs,
  isTransientUpdateFailure,
} = await import('../lib/types/update.js')
const compiledModulePath = fileURLToPath(new URL('../lib/types/update.js', import.meta.url))
const compiledShellQuotePath = fileURLToPath(new URL('../lib/types/utils/shellQuote.js', import.meta.url))
const repoRoot = fileURLToPath(new URL('..', import.meta.url))

// The compiled update.js imports ./utils/shellQuote.js — mirror both into
// every scratch layout or the import dies with ERR_MODULE_NOT_FOUND.
function copyUpdateModule(dstDir) {
  mkdirSync(join(dstDir, 'utils'), { recursive: true })
  cpSync(compiledModulePath, join(dstDir, 'update.js'))
  cpSync(compiledShellQuotePath, join(dstDir, 'utils', 'shellQuote.js'))
}

// ---- installedTuiVersion: compiled layout is this module's own real layout
const compiled = installedTuiVersion()
check(
  'installedTuiVersion returns this package version',
  compiled !== undefined && /^\d+\.\d+\.\d+/.test(compiled),
  `got ${compiled}`,
)

const scratch = mkdtempSync(join(tmpdir(), 'verify-update-'))
try {
  // The copied module imports `semver`; point its root at this repo's deps.
  symlinkSync(join(repoRoot, 'node_modules'), join(scratch, 'node_modules'))

  // Source-checkout layout: <root>/package.json + module under <root>/src/.
  // ../../package.json lands above the root (missing) → ../package.json hits.
  const sourceRoot = join(scratch, 'source')
  copyUpdateModule(join(sourceRoot, 'src'))
  writeFileSync(join(sourceRoot, 'package.json'), JSON.stringify({ name: '@deepseek-harness-tui/dsh-tui', version: '1.2.3', type: 'module' }))
  const sourceMod = await import(`${pathToFileURL(join(sourceRoot, 'src', 'update.js'))}?probe=1`)
  check(
    'installedTuiVersion reads the source-checkout layout',
    sourceMod.installedTuiVersion() === '1.2.3',
    `got ${sourceMod.installedTuiVersion()}`,
  )

  // Compiled layout with a foreign manifest at the near level: the root
  // manifest must win over a nearer foreign one.
  const pkgRoot = join(scratch, 'pkg')
  copyUpdateModule(join(pkgRoot, 'lib', 'types'))
  writeFileSync(join(pkgRoot, 'package.json'), JSON.stringify({ name: '@deepseek-harness-tui/dsh-tui', version: '0.9.9', type: 'module' }))
  writeFileSync(join(pkgRoot, 'lib', 'package.json'), JSON.stringify({ name: 'other-pkg', version: '9.9.9' }))
  const pkgMod = await import(`${pathToFileURL(join(pkgRoot, 'lib', 'types', 'update.js'))}?probe=2`)
  check(
    'installedTuiVersion prefers the matching root manifest over a foreign near one',
    pkgMod.installedTuiVersion() === '0.9.9',
    `got ${pkgMod.installedTuiVersion()}`,
  )

  // A foreign name at BOTH levels must yield undefined, never a version.
  const foreignRoot = join(scratch, 'foreign')
  copyUpdateModule(join(foreignRoot, 'lib', 'types'))
  writeFileSync(join(foreignRoot, 'package.json'), JSON.stringify({ name: 'other-pkg', version: '9.9.9' }))
  writeFileSync(join(foreignRoot, 'lib', 'package.json'), JSON.stringify({ name: 'third-pkg', version: '8.8.8' }))
  const foreignMod = await import(`${pathToFileURL(join(foreignRoot, 'lib', 'types', 'update.js'))}?probe=3`)
  check(
    'installedTuiVersion rejects foreign manifests entirely',
    foreignMod.installedTuiVersion() === undefined,
    `got ${foreignMod.installedTuiVersion()}`,
  )
} finally {
  rmSync(scratch, { recursive: true, force: true })
}

// ---- resolveRegistryBase: env (both spellings) over npmrc over default
const HOME_BACKUP = process.env.HOME
const USERPROFILE_BACKUP = process.env.USERPROFILE
const scratch2 = mkdtempSync(join(tmpdir(), 'verify-update2-'))
try {
  writeFileSync(join(scratch2, '.npmrc'), 'registry=https://mirror.example.com/\n')

  delete process.env.NPM_CONFIG_REGISTRY
  delete process.env.npm_config_registry
  process.env.HOME = scratch2
  process.env.USERPROFILE = scratch2
  check(
    'resolveRegistryBase reads ~/.npmrc',
    resolveRegistryBase() === 'https://mirror.example.com',
    `got ${resolveRegistryBase()}`,
  )

  process.env.NPM_CONFIG_REGISTRY = 'https://env-registry.example.com/'
  check(
    'resolveRegistryBase prefers NPM_CONFIG_REGISTRY (upper)',
    resolveRegistryBase() === 'https://env-registry.example.com',
    `got ${resolveRegistryBase()}`,
  )

  delete process.env.NPM_CONFIG_REGISTRY
  process.env.npm_config_registry = 'https://lower-registry.example.com'
  check(
    'resolveRegistryBase honors npm_config_registry (lower)',
    resolveRegistryBase() === 'https://lower-registry.example.com',
    `got ${resolveRegistryBase()}`,
  )

  delete process.env.npm_config_registry
  // Default applies only with no env AND no readable user .npmrc.
  const emptyHome = mkdtempSync(join(tmpdir(), 'verify-update3-'))
  try {
    process.env.HOME = emptyHome
    process.env.USERPROFILE = emptyHome
    check(
      'resolveRegistryBase defaults to npmjs.org',
      resolveRegistryBase() === 'https://registry.npmjs.org',
      `got ${resolveRegistryBase()}`,
    )
  } finally {
    rmSync(emptyHome, { recursive: true, force: true })
  }
} finally {
  if (HOME_BACKUP === undefined) delete process.env.HOME
  else process.env.HOME = HOME_BACKUP
  if (USERPROFILE_BACKUP === undefined) delete process.env.USERPROFILE
  else process.env.USERPROFILE = USERPROFILE_BACKUP
  rmSync(scratch2, { recursive: true, force: true })
}

// ---- isVersionNewer
check('isVersionNewer: newer major wins', isVersionNewer('1.0.0', '0.4.1'))
check('isVersionNewer: newer minor wins', isVersionNewer('0.5.0', '0.4.1'))
check('isVersionNewer: same version is not newer', !isVersionNewer('0.4.1', '0.4.1'))
check('isVersionNewer: older is not newer', !isVersionNewer('0.4.0', '0.4.1'))
check('isVersionNewer: invalid input is not newer', !isVersionNewer('banana', '0.4.1'))

// ---- resolveDshProfileName: the profile /update must act on
check(
  'profile: --profile value is read',
  resolveDshProfileName(['node', 'dsh', '--profile', 'my-tui']) === 'my-tui',
)
check(
  'profile: --profile=name form is read',
  resolveDshProfileName(['node', 'dsh', '--profile=my-tui', '--resume', 'abc']) === 'my-tui',
)
check(
  'profile: missing value yields undefined',
  resolveDshProfileName(['node', 'dsh', '--profile']) === undefined,
)
check(
  'profile: no launcher flags yields undefined (source mode)',
  resolveDshProfileName(['node', 'scripts/run.ts']) === undefined,
)
check(
  'profile: inner app args do not shadow the launcher flag',
  resolveDshProfileName(['node', 'dsh', '--profile', 'dsh-tui', '--resume', 'sid', '--model', 'x']) === 'dsh-tui',
)

// ---- shellQuote: cmd.exe safety for the .cmd path (P1 companion)
check(
  'shellQuote: plain tokens pass through',
  shellQuote(['plugin', '--profile', 'dsh-tui']).join(' ') === 'plugin --profile dsh-tui',
)
check(
  'shellQuote: spaces get quoted',
  shellQuote(['C:\\Program Files\\nodejs\\node.exe']).join(' ') === '"C:\\Program Files\\nodejs\\node.exe"',
)
check(
  'shellQuote: embedded quotes are doubled',
  shellQuote(['a"b c']).join(' ') === '"a""b c"',
)

// ---- pnpm args reuse the preflight result instead of resolving latest twice
const exactUpdateArgs = tuiUpdatePluginArgs('dsh-tui', '0.7.2')
check(
  'update command pins the preflight target version',
  JSON.stringify(exactUpdateArgs) === JSON.stringify([
    'plugin', '--profile', 'dsh-tui', 'update', '@deepseek-harness-tui/dsh-tui@0.7.2',
  ]),
  `got ${JSON.stringify(exactUpdateArgs)}`,
)
const fallbackUpdateArgs = tuiUpdatePluginArgs('custom-profile')
check(
  'update command falls back to --latest when preflight failed',
  JSON.stringify(fallbackUpdateArgs) === JSON.stringify([
    'plugin', '--profile', 'custom-profile', 'update', '--latest', '@deepseek-harness-tui/dsh-tui',
  ]),
  `got ${JSON.stringify(fallbackUpdateArgs)}`,
)

// ---- isBootDeadlockTarget: the 0.7.0–0.7.1 hard-inject range only
check('deadlock: 0.7.0 is refused', isBootDeadlockTarget('0.7.0'))
check('deadlock: 0.7.1 is refused', isBootDeadlockTarget('0.7.1'))
check('deadlock: 0.6.1 predates the inject and is fine', !isBootDeadlockTarget('0.6.1'))
check('deadlock: 0.7.2 dropped the hard inject', !isBootDeadlockTarget('0.7.2'))
check('deadlock: 0.8.0 is fine', !isBootDeadlockTarget('0.8.0'))
check('deadlock: invalid input is never a deadlock target', !isBootDeadlockTarget('banana'))

const compiledSource = readFileSync(compiledModulePath, 'utf8')
// P1: the node restart must NOT go through a shell — assert the compiled
// restart spawn call has no shell option while the dsh call does.
const dshSpawn = compiledSource.indexOf("runProcess(dsh")
const nodeSpawn = compiledSource.indexOf('runProcess(process.execPath')
const dshSegment = compiledSource.slice(dshSpawn, nodeSpawn)
const nodeSegment = compiledSource.slice(nodeSpawn)
check(
  'P1: dsh.cmd spawn requests a shell',
  /\{\s*shell:\s*true[,\s}]/.test(dshSegment),
)
check(
  'P1: node restart spawn has no shell (space-safe exec path)',
  !/shell/.test(nodeSegment.replace(/shellQuote/g, '')),
)

// ---- DSH_TUI_UPDATED_FROM stamping (issue #307): the pre-update version is
// captured before the installer child runs and reused in the restart env —
// a post-update read already sees the replaced manifest (new-vs-new).
const stampRead = compiledSource.indexOf('const updatedFrom = installedTuiVersion()')
check(
  'stamp: pre-update version is captured before the installer runs',
  stampRead !== -1 && stampRead < dshSpawn,
)
check(
  'stamp: restart env reuses the captured value, not a fresh read',
  /\[UPDATED_FROM_ENV\]:\s*updatedFrom/.test(nodeSegment),
)
// The --latest fallback (preflight failed) can also land on the deadlock
// range on a stale mirror: the post-install guard must refuse a restart
// into a version that JUST moved into 0.7.0–0.7.1. Two occurrences = the
// export plus the call inside updateTuiAndRestart.
check(
  'deadlock: post-install guard refuses a fresh landing on the range',
  (compiledSource.match(/isBootDeadlockTarget/g) ?? []).length >= 2,
)

// ---- launcher bridge (0.8.3): the compiled runtime must keep the
// post-/update launcher-alignment hints — static contract against the built
// output so future refactors cannot silently drop the bridge.
const compiledPluginPath = join(repoRoot, 'lib', 'types', 'dsh-adapter', 'plugin.js')
const compiledPluginSource = readFileSync(compiledPluginPath, 'utf8')
check(
  'launcher bridge: runtime reads the launcher version marker',
  compiledPluginSource.includes('DSH_TUI_LAUNCHER_VERSION'),
)
check(
  'launcher bridge: old-launcher update path keeps a generic alignment hint',
  compiledPluginSource.includes('update-launcher-align-unknown'),
)
check(
  'launcher bridge: known older launcher gets a directional hint',
  compiledPluginSource.includes('update-launcher-outdated'),
)

// ---- isTransientUpdateFailure: the Windows tmp-rename race (issue #225)
check(
  'transient: pnpm tmp-rename ENOENT qualifies',
  isTransientUpdateFailure(
    "[ERR_PNPM_ENOENT] [importPackage D:\\p\\node_modules\\dsh-tui] ENOENT: no such file or directory, scandir 'D:\\p\\node_modules\\dsh-tui_tmp_40044_1\\node_modules'",
  ),
)
check(
  'transient: EPERM rename on a tmp staging dir qualifies',
  isTransientUpdateFailure('EPERM: operation not permitted, rename D:\\p\\dsh-tui_tmp_123_4'),
)
check(
  'transient: plain resolution ENOENT without tmp token does not qualify',
  !isTransientUpdateFailure('ENOENT: no such file or directory, open /home/u/package.json'),
)
check(
  'transient: registry 404 does not qualify',
  !isTransientUpdateFailure('ERR_PNPM_FETCH_404 GET https://registry.npmjs.org/x: Not Found - 404'),
)
check(
  'transient: empty output does not qualify',
  !isTransientUpdateFailure(''),
)

if (failed > 0) {
  console.error(`\n${failed} check(s) failed`)
  process.exit(1)
}
console.log('\nall checks passed')
