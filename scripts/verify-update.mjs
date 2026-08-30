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
 * - isEexistTmpRenameFailure() classifies the deterministic Linux rename
 *   collision (issue #479) — recovery territory, never a plain retry — and
 *   removeStalePackageInstall() clears the stale package dir plus leftover
 *   `_tmp_` staging dirs without traversing a junction/symlink
 * - the /update restart tail reuses the hardened restartTui handoff
 *   (issues #284/#307/#483) with kind: 'update'
 *
 * Run: node scripts/verify-update.mjs
 */
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
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
  isEexistTmpRenameFailure,
  profilePackageDir,
  removeStalePackageInstall,
  ensureProfileAllowBuilds,
  ensureProfileReleaseAgeExclude,
  profileWorkspaceYamlPath,
  isStandaloneRuntime,
  getStandaloneBinaryPath,
  getStandaloneAssetName,
} = await import('../lib/types/update.js')
const compiledModulePath = fileURLToPath(new URL('../lib/types/update.js', import.meta.url))
const compiledShellQuotePath = fileURLToPath(new URL('../lib/types/utils/shellQuote.js', import.meta.url))
const compiledPathsPath = fileURLToPath(new URL('../lib/types/utils/paths.js', import.meta.url))
const repoRoot = fileURLToPath(new URL('..', import.meta.url))

/**
 * Mirror compiled update module and its dependencies into a scratch directory.
 *
 * @param {string} dstDir - Destination directory to receive the modules.
 */
function copyUpdateModule(dstDir) {
  mkdirSync(join(dstDir, 'utils'), { recursive: true })
  cpSync(compiledModulePath, join(dstDir, 'update.js'))
  cpSync(compiledShellQuotePath, join(dstDir, 'utils', 'shellQuote.js'))
  cpSync(compiledPathsPath, join(dstDir, 'utils', 'paths.js'))
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

// ---- pnpm allowBuilds pre-seed: pnpm ≥11 kills installs whose tree carries
// un-allowlisted build scripts (ERR_PNPM_IGNORED_BUILDS); the update flow
// must seed the profile workspace with explicit `false` entries first.
{
  const DSH_HOME_BACKUP = process.env.DSH_HOME
  const allowScratch = mkdtempSync(join(tmpdir(), 'verify-allowbuilds-'))
  const profileRoot = join(allowScratch, 'profiles', 'tui')
  try {
    process.env.DSH_HOME = allowScratch
    mkdirSync(profileRoot, { recursive: true })
    const yamlPath = profileWorkspaceYamlPath('tui')

    // Case 1: no workspace file yet → created with all four entries.
    let outcome = ensureProfileAllowBuilds('tui')
    check(
      'allowBuilds: missing file is created with all entries',
      outcome !== undefined && outcome.added.length === 4 && existsSync(yamlPath),
      JSON.stringify(outcome),
    )
    let text = readFileSync(yamlPath, 'utf8')
    check(
      'allowBuilds: file contains the four false entries',
      /'@google\/genai': false/u.test(text) && /esbuild: false/u.test(text) &&
        /koffi: false/u.test(text) && /protobufjs: false/u.test(text),
      text,
    )

    // Case 2: idempotent — a second run adds nothing and leaves the file alone.
    const before = readFileSync(yamlPath, 'utf8')
    outcome = ensureProfileAllowBuilds('tui')
    check(
      'allowBuilds: second run is a no-op',
      outcome !== undefined && outcome.added.length === 0 && readFileSync(yamlPath, 'utf8') === before,
      JSON.stringify(outcome),
    )

    // Case 3: an existing file without an allowBuilds block keeps its content.
    const legacyYaml = join(profileRoot, 'pnpm-workspace.yaml')
    writeFileSync(legacyYaml, 'packages:\n  - .\n\nnodeLinker: hoisted\n')
    outcome = ensureProfileAllowBuilds('tui')
    text = readFileSync(legacyYaml, 'utf8')
    check(
      'allowBuilds: block appended, existing keys preserved',
      outcome !== undefined && outcome.added.length === 4 &&
        text.startsWith('packages:\n  - .\n\nnodeLinker: hoisted\n') &&
        text.includes('allowBuilds:') && /protobufjs: false/u.test(text),
      text,
    )

    // Case 4: a partial block is completed without touching existing entries
    // (an explicit user `true`/`false` decision wins).
    writeFileSync(legacyYaml, "allowBuilds:\n  '@google/genai': true\n  esbuild: false\n")
    outcome = ensureProfileAllowBuilds('tui')
    text = readFileSync(legacyYaml, 'utf8')
    check(
      'allowBuilds: missing entries appended, existing values untouched',
      outcome !== undefined && outcome.added.length === 2 &&
        outcome.existing.includes('@google/genai') && outcome.existing.includes('esbuild') &&
        /'@google\/genai': true/u.test(text) && /koffi: false/u.test(text) && /protobufjs: false/u.test(text),
      `${JSON.stringify(outcome)} :: ${text}`,
    )

    // Case 5: entries in the middle of the file (other top-level keys after
    // the block) still insert inside the block, after existing entries.
    writeFileSync(legacyYaml, 'packages: []\nallowBuilds:\n  esbuild: false\nminimumReleaseAgeExclude:\n  - x@1.0.0\n')
    outcome = ensureProfileAllowBuilds('tui')
    text = readFileSync(legacyYaml, 'utf8')
    check(
      'allowBuilds: insertion stays inside the block before later keys',
      outcome !== undefined && outcome.added.length === 3 &&
        /allowBuilds:\n  esbuild: false\n  '@google\/genai': false\n  koffi: false\n  protobufjs: false\nminimumReleaseAgeExclude:/u.test(text),
      text,
    )

    // Case 6: missing profile directory → undefined, nothing written.
    outcome = ensureProfileAllowBuilds('missing-profile')
    check(
      'allowBuilds: absent profile directory yields undefined',
      outcome === undefined,
      JSON.stringify(outcome),
    )
  } finally {
    if (DSH_HOME_BACKUP === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = DSH_HOME_BACKUP
    rmSync(allowScratch, { recursive: true, force: true })
  }
}

// ---- pnpm minimumReleaseAgeExclude pre-seed: pnpm ≥11 delays installs of
// packages published within minimumReleaseAge (24h default) — on release day
// that gate refuses the exact version /update pins, so the update flow must
// exempt this package at the exact target before pnpm runs.
{
  const DSH_HOME_BACKUP = process.env.DSH_HOME
  const ageScratch = mkdtempSync(join(tmpdir(), 'verify-releaseage-'))
  const profileRoot = join(ageScratch, 'profiles', 'tui')
  try {
    process.env.DSH_HOME = ageScratch
    mkdirSync(profileRoot, { recursive: true })
    const yamlPath = profileWorkspaceYamlPath('tui')

    // Case 1: no workspace file yet → created with the exact-version entry.
    let outcome = ensureProfileReleaseAgeExclude('tui', '0.10.0-beta.1')
    check(
      'releaseAge: missing file is created with the exact entry',
      outcome !== undefined && outcome.changed === true &&
        outcome.entries.length === 1 &&
        outcome.entries[0] === '@deepseek-harness-tui/dsh-tui@0.10.0-beta.1' &&
        existsSync(yamlPath),
      JSON.stringify(outcome),
    )
    let text = readFileSync(yamlPath, 'utf8')
    check(
      'releaseAge: file carries the quoted list entry',
      /minimumReleaseAgeExclude:\n  - '@deepseek-harness-tui\/dsh-tui@0\.10\.0-beta\.1'\n/u.test(text),
      text,
    )

    // Case 2: idempotent — the same version again changes nothing.
    const before = readFileSync(yamlPath, 'utf8')
    outcome = ensureProfileReleaseAgeExclude('tui', '0.10.0-beta.1')
    check(
      'releaseAge: second run for the same version is a no-op',
      outcome !== undefined && outcome.changed === false && readFileSync(yamlPath, 'utf8') === before,
      JSON.stringify(outcome),
    )

    // Case 3: a stale entry for this package is replaced (no accumulation)
    // while foreign entries survive.
    writeFileSync(yamlPath, "minimumReleaseAgeExclude:\n  - 'x@1.0.0'\n  - '@deepseek-harness-tui/dsh-tui@0.9.3'\n")
    outcome = ensureProfileReleaseAgeExclude('tui', '0.10.0-beta.1')
    text = readFileSync(yamlPath, 'utf8')
    check(
      'releaseAge: stale own entry replaced, foreign entry kept',
      outcome !== undefined && outcome.changed === true &&
        text.includes("- 'x@1.0.0'") &&
        text.includes("- '@deepseek-harness-tui/dsh-tui@0.10.0-beta.1'") &&
        !text.includes('0.9.3'),
      `${JSON.stringify(outcome)} :: ${text}`,
    )

    // Case 4: a file without the block keeps its content and gains one.
    writeFileSync(yamlPath, 'packages:\n  - .\n\nnodeLinker: hoisted\n')
    outcome = ensureProfileReleaseAgeExclude('tui', '1.2.3')
    text = readFileSync(yamlPath, 'utf8')
    check(
      'releaseAge: block appended, existing keys preserved',
      outcome !== undefined && outcome.changed === true &&
        text.startsWith('packages:\n  - .\n\nnodeLinker: hoisted\n') &&
        text.includes("minimumReleaseAgeExclude:\n  - '@deepseek-harness-tui/dsh-tui@1.2.3'\n"),
      text,
    )

    // Case 5: absent profile directory → undefined, nothing written.
    outcome = ensureProfileReleaseAgeExclude('missing-profile', '1.2.3')
    check(
      'releaseAge: absent profile directory yields undefined',
      outcome === undefined,
      JSON.stringify(outcome),
    )
  } finally {
    if (DSH_HOME_BACKUP === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = DSH_HOME_BACKUP
    rmSync(ageScratch, { recursive: true, force: true })
  }
}

// ---- isBootDeadlockTarget: the 0.7.0–0.7.1 hard-inject range only
check('deadlock: 0.7.0 is refused', isBootDeadlockTarget('0.7.0'))
check('deadlock: 0.7.1 is refused', isBootDeadlockTarget('0.7.1'))
check('deadlock: 0.6.1 predates the inject and is fine', !isBootDeadlockTarget('0.6.1'))
check('deadlock: 0.7.2 dropped the hard inject', !isBootDeadlockTarget('0.7.2'))
check('deadlock: 0.8.0 is fine', !isBootDeadlockTarget('0.8.0'))
check('deadlock: invalid input is never a deadlock target', !isBootDeadlockTarget('banana'))

const compiledSource = readFileSync(compiledModulePath, 'utf8')
// P1: the node restart must NOT go through a shell — assert the compiled
// restart spawn call has no shell option while the dsh call does. The
// restart spawn now lives inside restartTui() (shared by /restart and the
// /update restart tail); the dsh calls live in updateTuiAndRestart().
const dshSpawn = compiledSource.indexOf('runProcess(dsh')
const nodeSpawn = compiledSource.indexOf('spawn(process.execPath')
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
const stampEnvUse = compiledSource.indexOf('[UPDATED_FROM_ENV]: updatedFrom')
check(
  'stamp: restart env reuses the captured value, not a fresh read',
  stampEnvUse !== -1 && stampEnvUse > dshSpawn,
)
// The --latest fallback (preflight failed) can also land on the deadlock
// range on a stale mirror: the post-install guard must refuse a restart
// into a version that JUST moved into 0.7.0–0.7.1. Three occurrences = the
// export + the post-install guard in updateTui + the CLI preflight refusal
// in cliUpdate — a plain count would pass with the guard deleted, so pin
// the guard's own call shape too.
check(
  'deadlock: post-install guard refuses a fresh landing on the range',
  (compiledSource.match(/isBootDeadlockTarget/g) ?? []).length >= 3
    && /installedNow !== updatedFrom && isBootDeadlockTarget\(installedNow\)/.test(compiledSource),
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

// ---- isEexistTmpRenameFailure: the deterministic Linux flavor (issue #479)
const eexistSample =
  "ERR_PNPM_EEXIST  EEXIST: file already exists, rename " +
  "'/root/.dsh/profiles/dsh-tui/node_modules/@deepseek-harness-tui/dsh-tui/node_modules' " +
  "-> '/root/.dsh/profiles/dsh-tui/node_modules/@deepseek-harness-tui/dsh-tui_tmp_2424672_1/node_modules'"
check(
  'eexist: pnpm tmp-rename EEXIST qualifies (#479 verbatim stderr)',
  isEexistTmpRenameFailure(eexistSample),
)
check(
  'eexist: EEXIST without the tmp token does not qualify',
  !isEexistTmpRenameFailure('EEXIST: file already exists, mkdir /root/.cache/pnpm'),
)
check(
  'eexist: transient ENOENT is not the EEXIST flavor',
  !isEexistTmpRenameFailure("[ERR_PNPM_ENOENT] [importPackage] ENOENT: scandir 'D:\\p\\dsh-tui_tmp_40044_1\\node_modules'"),
)
check(
  'transient: EEXIST is NOT plain-retry transient (needs stale-install recovery, #479)',
  !isTransientUpdateFailure(eexistSample),
)

// ---- profilePackageDir: where the recovery path clears a stale install
const DSH_HOME_BACKUP = process.env.DSH_HOME
const staleSandbox = mkdtempSync(join(tmpdir(), 'verify-update-stale-'))
try {
  const sandboxRoot = join(staleSandbox, 'dsh-root')
  process.env.DSH_HOME = sandboxRoot
  check(
    'profilePackageDir: DSH_HOME root wins',
    profilePackageDir('dsh-tui') === join(sandboxRoot, 'profiles', 'dsh-tui', 'node_modules', '@deepseek-harness-tui', 'dsh-tui'),
    `got ${profilePackageDir('dsh-tui')}`,
  )
  delete process.env.DSH_HOME
  check(
    'profilePackageDir: defaults to ~/.dsh',
    profilePackageDir('custom') === join(homedir(), '.dsh', 'profiles', 'custom', 'node_modules', '@deepseek-harness-tui', 'dsh-tui'),
    `got ${profilePackageDir('custom')}`,
  )
  process.env.DSH_HOME = sandboxRoot

  // ---- removeStalePackageInstall: clears the package dir + tmp staging dirs
  const scope = join(sandboxRoot, 'profiles', 'dsh-tui', 'node_modules', '@deepseek-harness-tui')
  const pkgDir = join(scope, 'dsh-tui')
  mkdirSync(join(pkgDir, 'lib'), { recursive: true })
  writeFileSync(join(pkgDir, 'lib', 'marker.txt'), 'stale install')
  mkdirSync(join(scope, 'dsh-tui_tmp_2424672_1'))
  writeFileSync(join(scope, 'dsh-tui_tmp_2424672_1', 'leftover'), 'x')
  // Look-alike dirs must survive: other packages and foreign tmp names.
  mkdirSync(join(scope, 'unrelated-pkg'))
  mkdirSync(join(scope, 'other_tmp_999_1'))
  const removal = removeStalePackageInstall('dsh-tui')
  check(
    'stale: package dir removed',
    !existsSync(pkgDir),
  )
  check(
    'stale: leftover tmp staging dir removed',
    !existsSync(join(scope, 'dsh-tui_tmp_2424672_1')),
  )
  check(
    'stale: removal reports both halves',
    removal.packageDir === 'removed' && removal.tmpDirs.length === 1 && removal.tmpDirs[0] === 'dsh-tui_tmp_2424672_1',
    `got ${JSON.stringify(removal)}`,
  )
  check(
    'stale: sibling packages and foreign tmp names survive',
    existsSync(join(scope, 'unrelated-pkg')) && existsSync(join(scope, 'other_tmp_999_1')),
  )

  // A junction/symlink at the package dir: the LINK goes, the target tree
  // it points at (a dev checkout) must never be traversed or deleted.
  const precious = join(staleSandbox, 'precious-checkout')
  mkdirSync(join(precious, 'src'), { recursive: true })
  writeFileSync(join(precious, 'src', 'keep.txt'), 'do not delete')
  symlinkSync(precious, pkgDir, process.platform === 'win32' ? 'junction' : 'dir')
  const linkRemoval = removeStalePackageInstall('dsh-tui')
  check(
    'stale: link at the package dir is unlinked',
    !existsSync(pkgDir),
  )
  check(
    'stale: link target is never traversed',
    existsSync(join(precious, 'src', 'keep.txt')),
  )
  check(
    'stale: link removal still reports removed',
    linkRemoval.packageDir === 'removed',
  )

  const absent = removeStalePackageInstall('never-existed')
  check(
    'stale: absent package dir reports absent (custom roots just miss)',
    absent.packageDir === 'absent' && absent.tmpDirs.length === 0,
  )
} finally {
  if (DSH_HOME_BACKUP === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = DSH_HOME_BACKUP
  rmSync(staleSandbox, { recursive: true, force: true })
}

// ---- recovery wiring (issue #479): the EEXIST signature and the stale
// install removal must be reachable from the shared install half (updateTui,
// which updateTuiAndRestart delegates to), and the /update restart tail must
// ride the hardened restartTui handoff (#483).
const updateFnStart = compiledSource.indexOf('export async function updateTui')
const restartFnStart = compiledSource.indexOf('export async function restartTui')
const updateSegment = compiledSource.slice(updateFnStart, restartFnStart)
check(
  'recovery: EEXIST failure routes to the stale-install removal (#479)',
  updateSegment.includes('isEexistTmpRenameFailure(updateStderr)') && updateSegment.includes('removeStalePackageInstall(profile)'),
)
check(
  'recovery: transient retry failure also escalates to removal (#225 leftovers)',
  updateSegment.includes('isTransientUpdateFailure(updateStderr)'),
)
check(
  'update restart: reuses the hardened restartTui handoff with kind update (#483)',
  updateSegment.includes("kind: 'update'") && updateSegment.includes('restartTui(sessionId, {'),
)
check(
  'restartTui: update kind skips the /restart boot-diagnosis marker',
  /kind === 'restart' \? \{ \[RESTART_CHILD_ENV\]: '1' \} : \{\}/.test(compiledSource),
)

// ---- CLI update（issue #509）：安装半程与 /update 共用同一实现 ----------------
// updateTui 是 updateTuiAndRestart 的安装半程，cliUpdate 是 bin 启动器
// 动态 import 的无头入口——两者必须存在于编译产物，且 updateTuiAndRestart
// 委托 updateTui 而不是保留一份拷贝（DRY 契约：装机逻辑只有一份）。
{
  const mod = await import('../lib/types/update.js')
  check('cli: updateTui is exported from the compiled lib', typeof mod.updateTui === 'function')
  check('cli: cliUpdate is exported from the compiled lib', typeof mod.cliUpdate === 'function')
  check(
    'cli: updateTuiAndRestart delegates to updateTui (single install path)',
    /updateTuiAndRestart[\s\S]{0,400}await updateTui\(/.test(compiledSource),
  )
}

// ---- cli: 真实 cliUpdate 的「版本未前进」路径（预检失败 + --latest no-op）------
// 拷贝的编译模块 + 版本固定的 manifest：registry 指向必然拒绝连接的地址
// （预检 → unknown → --latest 兜底），stub dsh 什么都不装、返回 0。安装前后
// installedTuiVersion 相同——必须如实打印 version did not advance，绝不打印
// 虚假的 updated X → X。真实模块、真实子进程，只有网络与 dsh 是假的。
{
  const scratch3 = mkdtempSync(join(tmpdir(), 'verify-update-cli-'))
  const ENV_BACKUP = { reg: process.env.NPM_CONFIG_REGISTRY, regL: process.env.npm_config_registry, path: process.env.PATH }
  try {
    symlinkSync(join(repoRoot, 'node_modules'), join(scratch3, 'node_modules'))
    const pkgRoot = join(scratch3, 'pkg')
    copyUpdateModule(join(pkgRoot, 'lib', 'types'))
    writeFileSync(join(pkgRoot, 'package.json'), JSON.stringify({ name: '@deepseek-harness-tui/dsh-tui', version: '2.0.0', type: 'module' }))
    const stubDir = join(scratch3, 'stub-bin')
    mkdirSync(stubDir, { recursive: true })
    writeFileSync(join(stubDir, 'dsh'), '#!/bin/sh\nexit 0\n')
    chmodSync(join(stubDir, 'dsh'), 0o755)
    // Windows spawns the launcher through cmd.exe (shell: true), which does
    // not run sh scripts — provide a .cmd stub that exits 0 as well.
    writeFileSync(join(stubDir, 'dsh.cmd'), '@exit /b 0\r\n')
    // Isolate the profile workspace: ensureProfileAllowBuilds inside
    // updateTui must touch this scratch home, never the real ~/.dsh.
    const DSH_HOME_BACKUP = process.env.DSH_HOME
    process.env.DSH_HOME = join(scratch3, 'home')
    process.env.NPM_CONFIG_REGISTRY = 'http://127.0.0.1:1'
    // NOTE: no `delete process.env.npm_config_registry` here — Windows env
    // vars are case-insensitive, so deleting the lowercase spelling would
    // also drop the uppercase value just set, silently pointing the probe at
    // the real npmjs registry (and making this test network-dependent).
    process.env.PATH = stubDir
    const cliMod = await import(`${pathToFileURL(join(pkgRoot, 'lib', 'types', 'update.js'))}?probe=cli`)
    let captured = ''
    const origWrite = process.stdout.write.bind(process.stdout)
    process.stdout.write = chunk => { captured += String(chunk); return true }
    let code
    try {
      code = await cliMod.cliUpdate('dsh-tui')
    } finally {
      process.stdout.write = origWrite
    }
    if (DSH_HOME_BACKUP === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = DSH_HOME_BACKUP
    check('cli: no-op --latest 兜底以 0 退出', code === 0, `code=${code}`)
    check('cli: 版本未前进时如实提示', captured.includes('version did not advance'), JSON.stringify(captured.slice(0, 120)))
    check('cli: 不打印虚假的 updated X → X', !captured.includes('updated 2.0.0'))
  } finally {
    if (ENV_BACKUP.reg === undefined) delete process.env.NPM_CONFIG_REGISTRY
    else process.env.NPM_CONFIG_REGISTRY = ENV_BACKUP.reg
    if (ENV_BACKUP.regL === undefined) delete process.env.npm_config_registry
    else process.env.npm_config_registry = ENV_BACKUP.regL
    process.env.PATH = ENV_BACKUP.path
    rmSync(scratch3, { recursive: true, force: true })
  }
}

// ---- standalone: 便携包环境检测与资产名称解析 --------------------------------
{
  const origEnv = {
    standalone: process.env.DSH_TUI_STANDALONE,
    binary: process.env.DSH_TUI_STANDALONE_BINARY,
    dshHome: process.env.DSH_HOME,
  }
  try {
    delete process.env.DSH_TUI_STANDALONE
    delete process.env.DSH_TUI_STANDALONE_BINARY
    process.env.DSH_HOME = '/home/user/.dsh'
    check('standalone: 默认非便携模式', isStandaloneRuntime() === false)

    process.env.DSH_TUI_STANDALONE = '1'
    check('standalone: DSH_TUI_STANDALONE=1 识别为便携模式', isStandaloneRuntime() === true)

    delete process.env.DSH_TUI_STANDALONE
    process.env.DSH_TUI_STANDALONE_BINARY = '/tmp/dsh-tui'
    check('standalone: DSH_TUI_STANDALONE_BINARY 识别为便携模式', isStandaloneRuntime() === true)
    check('standalone: getStandaloneBinaryPath 返回指定路径', getStandaloneBinaryPath() === '/tmp/dsh-tui')

    delete process.env.DSH_TUI_STANDALONE_BINARY
    process.env.DSH_HOME = '/home/user/.dsh-tui-standalone'
    check('standalone: DSH_HOME 包含 dsh-tui-standalone 识别为便携模式', isStandaloneRuntime() === true)

    // 资产名称匹配
    check('standalone: Windows 资产名匹配', getStandaloneAssetName('win32', 'x64') === 'dsh-tui-standalone-win-x64.zip')
    check('standalone: macOS arm64 资产名匹配', getStandaloneAssetName('darwin', 'arm64') === 'dsh-tui-standalone-darwin-arm64.tar.gz')
    check('standalone: macOS x64 资产名匹配', getStandaloneAssetName('darwin', 'x64') === 'dsh-tui-standalone-darwin-x64.tar.gz')
    check('standalone: Linux x64 资产名匹配', getStandaloneAssetName('linux', 'x64') === 'dsh-tui-standalone-linux-x64.tar.gz')
    check('standalone: Linux arm64 资产名匹配', getStandaloneAssetName('linux', 'arm64') === 'dsh-tui-standalone-linux-arm64.tar.gz')
  } finally {
    if (origEnv.standalone === undefined) delete process.env.DSH_TUI_STANDALONE
    else process.env.DSH_TUI_STANDALONE = origEnv.standalone
    if (origEnv.binary === undefined) delete process.env.DSH_TUI_STANDALONE_BINARY
    else process.env.DSH_TUI_STANDALONE_BINARY = origEnv.binary
    if (origEnv.dshHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = origEnv.dshHome
  }
}

if (failed > 0) {
  console.error(`\n${failed} check(s) failed`)
  process.exit(1)
}
console.log('\nall checks passed')

