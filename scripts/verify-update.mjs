/**
 * Pure-function verification for the /update machinery (real compiled lib,
 * no network; short-lived node launches exercise the launcher executable bit
 * and grouped sibling peer loading):
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
 * - the launcher step preserves the bin mode, reinstalls only a proven
 *   launcher-only pnpm group, preserves grouped CLIs and their required peers,
 *   derives PNPM_HOME from the pnpm shim, refuses unprovable store layouts,
 *   and fails closed when installer cleanup is unconfirmed
 * - the /update restart tail reuses the hardened restartTui handoff
 *   (issues #284/#307/#483) with kind: 'update'
 *
 * Run: node scripts/verify-update.mjs
 */
import './lib/fake-home.mjs'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import ts from 'typescript'

let failed = 0
function check(name, ok, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed += 1
}

// A test launched from a TUI tool shell must not inherit its real launcher.
for (const key of ['DSH_TUI_LAUNCHER_PATH', 'DSH_TUI_LAUNCHER_VERSION', 'DSH_TUI_UPDATE_LAUNCHER']) delete process.env[key]

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
  sharpCurrentSuffix,
  ignoredSharpOptionalPatterns,
  claudeSdkCurrentSuffix,
  ignoredClaudeSdkOptionalPatterns,
  ignoredForeignPlatformPatterns,
  ensureProfilePlatformFilter,
  ensurePlatformFilterAt,
  detectLibc,
  profileWorkspaceYamlPath,
  isStandaloneRuntime,
  getStandaloneBinaryPath,
  getStandaloneAssetName,
  engineFailureAllowsRestart,
  shouldAlignLauncher,
  blockedUpdateMessages,
  restartEnvFor,
  updatePlanLayers,
  updatePlanState,
  describeHostStepReason,
  engineSkipMessages,
  idleReportMessages,
} = await import('../lib/types/update.js')
const {
  parseHostLineRange,
  selectHostTarget,
  detectHostInstall,
  planHostStep,
  hostCompatibility,
  hostSatisfiesLine,
  hostManualCommands,
  DSH_PM_ENV,
} = await import('../lib/types/updateHost.js')
const { BUILTIN_BACKEND_IDS } = await import('../lib/types/kernelPrefs.js')
const launcherPath = fileURLToPath(new URL('../bin/dsh-tui.js', import.meta.url))
const launcherAst = ts.createSourceFile(launcherPath, readFileSync(launcherPath, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
const launcherKernelIds = launcherAst.statements.flatMap(statement =>
  ts.isVariableStatement(statement) ? statement.declarationList.declarations : [],
).find(declaration => ts.isIdentifier(declaration.name) && declaration.name.text === 'BUILTIN_BACKEND_IDS')?.initializer
check(
  // The launcher keeps a copy of the built-in ids for its messages only (P0 D1:
  // validation is the id-syntax gate now); the copy must still match the
  // compiled list, or a rescue prompt would name a backend that no longer exists.
  'launcher built-in kernel ids stay aligned with the compiled list',
  launcherKernelIds !== undefined && ts.isArrayLiteralExpression(launcherKernelIds)
    && launcherKernelIds.elements.every(ts.isStringLiteral)
    && JSON.stringify(launcherKernelIds.elements.map(element => element.text)) === JSON.stringify(BUILTIN_BACKEND_IDS),
)
const compiledModulePath = fileURLToPath(new URL('../lib/types/update.js', import.meta.url))
const compiledShellQuotePath = fileURLToPath(new URL('../lib/types/utils/shellQuote.js', import.meta.url))
const compiledPathsPath = fileURLToPath(new URL('../lib/types/utils/paths.js', import.meta.url))
// update.js imports stripResumeArgs from here (a kernel switch must not hand
// the replacement this kernel's --resume flags) — the scratch mirror has to
// carry it or the copy fails to link.
const compiledSessionHistoryPath = fileURLToPath(new URL('../lib/types/sessionHistory.js', import.meta.url))
// update.js imports KERNEL_SWITCH_HANDOFF_ENV from here (the kernel-switch
// handoff is one-shot) — the scratch mirror has to carry it or the copy
// fails to link.
const compiledKernelPrefsPath = fileURLToPath(new URL('../lib/types/kernelPrefs.js', import.meta.url))
// kernelPrefs.js imports the backend id rule (isBackendIdSyntax) from the neutral
// manifest contract (P0 D1/D2) — the mirror has to carry it or the copy fails to link.
const compiledBackendManifestPath = fileURLToPath(new URL('../lib/types/agent/backend-manifest.js', import.meta.url))
// update.js imports the kernel-switch transition events (S05 MVE) from
// handoffEvents.js, which in turn pulls kernelCatalog.js (display names)
// and i18n.js (bilingual copy). The scratch mirrors must carry all of
// them or the copy fails to link; npm deps (chalk, semver) resolve via
// the scratch node_modules junction below.
const compiledHandoffEventsPath = fileURLToPath(new URL('../lib/types/handoffEvents.js', import.meta.url))
// update.js imports the ACK protocol (S05 完整版) from handoffAck.js and
// EXIT_ALT_SCREEN from the ink dec sequences — both must ride the mirror.
const compiledHandoffAckPath = fileURLToPath(new URL('../lib/types/handoffAck.js', import.meta.url))
const compiledStdinHandoffPath = fileURLToPath(new URL('../lib/types/ink/stdin-handoff.js', import.meta.url))
const compiledTermioDir = fileURLToPath(new URL('../lib/types/ink/termio', import.meta.url))
const compiledKernelCatalogPath = fileURLToPath(new URL('../lib/types/components/kernelCatalog.js', import.meta.url))
const compiledI18nPath = fileURLToPath(new URL('../lib/types/i18n.js', import.meta.url))
// i18n.js 的字典展开平台文案的唯一真源（C-2），所以它也随镜像走。那个模块本身
// 零运行期 import（`import type` 已被抹掉），拷一个文件即可。
const compiledPlatformTextPath = fileURLToPath(new URL('../lib/types/backends/shared/platform-text.js', import.meta.url))
const repoRoot = fileURLToPath(new URL('..', import.meta.url))

/**
 * Mirror compiled update module and its dependencies into a scratch directory.
 *
 * @param {string} dstDir - Destination directory to receive the modules.
 */
function copyUpdateModule(dstDir) {
  mkdirSync(join(dstDir, 'utils'), { recursive: true })
  mkdirSync(join(dstDir, 'components'), { recursive: true })
  mkdirSync(join(dstDir, 'agent'), { recursive: true })
  mkdirSync(join(dstDir, 'backends', 'shared'), { recursive: true })
  mkdirSync(join(dstDir, 'dsh-adapter'), { recursive: true })
  cpSync(compiledModulePath, join(dstDir, 'update.js'))
  cpSync(new URL('../lib/types/updateProcess.js', import.meta.url), join(dstDir, 'updateProcess.js'))
  cpSync(new URL('../lib/types/windowsInstaller.js', import.meta.url), join(dstDir, 'windowsInstaller.js'))
  // #1844: update.js now imports the neutral engine planner and the host
  // contract constants (package name + peer key, never host modules).
  cpSync(new URL('../lib/types/updateHost.js', import.meta.url), join(dstDir, 'updateHost.js'))
  cpSync(new URL('../lib/types/dsh-adapter/contract.js', import.meta.url), join(dstDir, 'dsh-adapter', 'contract.js'))
  cpSync(new URL('../lib/types/dsh-adapter/host-contract.js', import.meta.url), join(dstDir, 'dsh-adapter', 'host-contract.js'))
  const packageRoot = dstDir.endsWith(join('lib', 'types')) ? join(dstDir, '..', '..') : join(dstDir, '..')
  mkdirSync(join(packageRoot, 'assets'), { recursive: true })
  for (const name of ['windows-installer.ps1', 'windows-installer.cs']) {
    cpSync(new URL('../assets/' + name, import.meta.url), join(packageRoot, 'assets', name))
  }
  cpSync(compiledShellQuotePath, join(dstDir, 'utils', 'shellQuote.js'))
  cpSync(compiledPathsPath, join(dstDir, 'utils', 'paths.js'))
  cpSync(compiledSessionHistoryPath, join(dstDir, 'sessionHistory.js'))
  cpSync(compiledKernelPrefsPath, join(dstDir, 'kernelPrefs.js'))
  cpSync(compiledBackendManifestPath, join(dstDir, 'agent', 'backend-manifest.js'))
  cpSync(compiledHandoffEventsPath, join(dstDir, 'handoffEvents.js'))
  cpSync(compiledHandoffAckPath, join(dstDir, 'handoffAck.js'))
  // dec.js 拉着 csi/ansi 的序列常量链——整个 termio 目录随镜像走。
  cpSync(compiledTermioDir, join(dstDir, 'ink', 'termio'), { recursive: true })
  cpSync(compiledStdinHandoffPath, join(dstDir, 'ink', 'stdin-handoff.js'))
  cpSync(compiledKernelCatalogPath, join(dstDir, 'components', 'kernelCatalog.js'))
  cpSync(compiledI18nPath, join(dstDir, 'i18n.js'))
  cpSync(compiledPlatformTextPath, join(dstDir, 'backends', 'shared', 'platform-text.js'))
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
  symlinkSync(join(repoRoot, 'node_modules'), join(scratch, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir')

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
  // Installed shape: the compiled copy lives under node_modules like a real
  // install, so the launcher resolver's `node_modules` root check applies.
  const pkgRoot = join(scratch, 'pkg', 'node_modules', '@deepseek-harness-tui', 'dsh-tui')
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

  // Use npm's external global bin footprint, not a bare node_modules tree.
  const PKG_NAME = '@deepseek-harness-tui/dsh-tui'
  const oldBin = '#!/usr/bin/env node\n// old launcher\n'
  const npmGlobal = (prefix, names = ['dsh-tui', 'dst'], platform = process.platform) => {
    const packageDir = join(prefix, ...(platform === 'win32' ? [] : ['lib']), 'node_modules', PKG_NAME)
    const binDir = platform === 'win32' ? prefix : join(prefix, 'bin')
    mkdirSync(join(packageDir, 'bin'), { recursive: true })
    mkdirSync(binDir, { recursive: true })
    writeFileSync(join(packageDir, 'package.json'), JSON.stringify({ name: PKG_NAME, version: '0.1.0' }))
    const bin = join(packageDir, 'bin', 'dsh-tui.js')
    writeFileSync(bin, oldBin)
    chmodSync(bin, 0o755)
    for (const name of names) {
      if (platform === 'win32') writeFileSync(join(binDir, `${name}.cmd`), '@echo off\r\nnode "%~dp0\\node_modules\\@deepseek-harness-tui\\dsh-tui\\bin\\dsh-tui.js" %*\r\n')
      else symlinkSync(bin, join(binDir, name))
    }
    return { packageDir, binDir }
  }
  const oldPrefix = join(scratch, 'old-global')
  const { packageDir: oldRoot } = npmGlobal(oldPrefix)
  const oldManifest = JSON.stringify({ name: PKG_NAME, version: '0.1.0' })
  const savedArgv1 = process.argv[1]
  const resetGlobal = () => {
    writeFileSync(join(oldRoot, 'package.json'), oldManifest)
    writeFileSync(join(oldRoot, 'bin', 'dsh-tui.js'), oldBin)
    // npm marks package bins executable; the migration must carry that bit.
    chmodSync(join(oldRoot, 'bin', 'dsh-tui.js'), 0o755)
  }
  try {
    for (const [root, mod, layout] of [[sourceRoot, sourceMod, 'source'], [pkgRoot, pkgMod, 'compiled']]) {
      mkdirSync(join(root, 'bin'), { recursive: true })
      const newBin = `#!/usr/bin/env node\n// ${layout} launcher\n`
      writeFileSync(join(root, 'bin', 'dsh-tui.js'), newBin)
      resetGlobal()
      process.argv[1] = join(oldRoot, 'bin', 'dsh-tui.js')
      check(`launcher migration succeeds in ${layout} layout`, mod.migrateGlobalLauncher())
      check(`${layout} migration copies both files`,
        readFileSync(process.argv[1], 'utf8') === newBin
        && readFileSync(join(oldRoot, 'package.json'), 'utf8') === readFileSync(join(root, 'package.json'), 'utf8'))
      if (process.platform !== 'win32') {
        let executable = (fs.statSync(process.argv[1]).mode & 0o111) !== 0
        try {
          fs.accessSync(process.argv[1], fs.constants.X_OK)
        } catch {
          executable = false
        }
        check(`${layout} migration preserves the executable bit`, executable)
      }

      const alias = join(scratch, `${layout}-alias`)
      symlinkSync(root, alias, process.platform === 'win32' ? 'junction' : 'dir')
      process.argv[1] = join(alias, 'bin', 'dsh-tui.js')
      check(`${layout} migration refuses its own realpath`, mod.migrateGlobalLauncher() === false)
      check(`${layout} self migration creates no staging file`, !existsSync(`${process.argv[1]}.dsh-tui-migrate`))
    }
    process.argv[1] = join(oldRoot, 'bin', 'dsh-tui.js')
    const sourceManifestPath = join(pkgRoot, 'package.json')
    const sourceManifest = readFileSync(sourceManifestPath)
    resetGlobal()
    writeFileSync(sourceManifestPath, '{broken')
    check('invalid source manifest prevents either write', pkgMod.migrateGlobalLauncher() === false
      && readFileSync(process.argv[1], 'utf8') === oldBin)
    writeFileSync(sourceManifestPath, sourceManifest)
    rmSync(join(pkgRoot, 'bin', 'dsh-tui.js'))
    check('missing source bin prevents either write', pkgMod.migrateGlobalLauncher() === false
      && readFileSync(join(oldRoot, 'package.json'), 'utf8') === oldManifest)
    writeFileSync(join(pkgRoot, 'bin', 'dsh-tui.js'), '// new launcher\n')
    writeFileSync(join(oldRoot, 'package.json'), '{broken')
    check('invalid destination manifest is not replaced', pkgMod.migrateGlobalLauncher() === false
      && readFileSync(join(oldRoot, 'package.json'), 'utf8') === '{broken')
    resetGlobal()
    const savedWrite = fs.writeFileSync
    try {
      fs.writeFileSync = (target, ...args) => {
        if (String(target).startsWith(oldRoot) && String(target).endsWith('.dsh-tui-migrate')) {
          throw Object.assign(new Error('fixture permission failure'), { code: 'EACCES' })
        }
        return savedWrite(target, ...args)
      }
      syncBuiltinESMExports()
      check('permission failure returns false without replacing either file', pkgMod.migrateGlobalLauncher() === false
        && readFileSync(process.argv[1], 'utf8') === oldBin
        && readFileSync(join(oldRoot, 'package.json'), 'utf8') === oldManifest)
    } finally {
      fs.writeFileSync = savedWrite
      syncBuiltinESMExports()
    }

    // The real regression is execution, not the mode readback: npm's POSIX
    // bin is a symlink to this file, and a 0644 replacement makes the next
    // `dsh-tui` launch fail with EACCES.
    if (process.platform !== 'win32') {
      writeFileSync(join(pkgRoot, 'bin', 'dsh-tui.js'), '#!/usr/bin/env node\n// compiled launcher\n')
      const binLink = join(oldPrefix, 'bin', 'dsh-tui')
      resetGlobal()
      process.argv[1] = join(oldRoot, 'bin', 'dsh-tui.js')
      const launched = pkgMod.migrateGlobalLauncher() ? spawnSync(binLink, [], { encoding: 'utf8' }) : undefined
      check(
        'launcher migration: the replaced bin still starts through the npm bin symlink',
        launched?.status === 0,
        launched?.error?.message ?? launched?.stderr ?? 'migration failed',
      )
      // Leave the shared fixture at its pre-update version for the next block.
      resetGlobal()
    }

    // ---- #1844: the launcher is reachable from the TUI, never downgraded,
    // and pnpm-global installs go through the package manager.
    const {
      resolveGlobalLauncherTarget,
      alignGlobalLauncher,
      launcherRestartEnv,
      GLOBAL_LAUNCHER_PATH_ENV,
      GLOBAL_LAUNCHER_VERSION_ENV,
      UPDATE_LAUNCHER_ENV,
    } = pkgMod
    const launcherVersionAt = dir => JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version

    const explicitTarget = resolveGlobalLauncherTarget({ [GLOBAL_LAUNCHER_PATH_ENV]: join(oldRoot, 'bin', 'dsh-tui.js') })
    check(
      'launcher resolve: an explicit path names the package dir, version and npm layout',
      explicitTarget?.packageDir === realpathSync(oldRoot)
        && explicitTarget?.version === '0.1.0'
        && explicitTarget?.layout === 'npm',
      JSON.stringify(explicitTarget),
    )

    // Never downgrade: an install at or ahead of the profile copy stays put.
    for (const [label, version] of [['equal', '0.9.9'], ['newer', '9.9.9']]) {
      resetGlobal()
      writeFileSync(join(oldRoot, 'package.json'), JSON.stringify({ name: PKG_NAME, version }))
      check(
        `launcher copy: an install at ${label} version is left alone`,
        pkgMod.migrateGlobalLauncher(join(oldRoot, 'bin', 'dsh-tui.js')) === false
          && readFileSync(join(oldRoot, 'bin', 'dsh-tui.js'), 'utf8') === oldBin,
      )
    }
    resetGlobal()
    check(
      'launcher copy: accepts the package directory directly (#1844 caller)',
      pkgMod.migrateGlobalLauncher(oldRoot) && launcherVersionAt(oldRoot) === '0.9.9',
    )

    // Old shims export a version but not which alias was invoked. Both aliases
    // may be accepted only when their independent PATH lookups agree.
    const { packageDir: fallbackPkg, binDir: fallbackPath } = npmGlobal(join(scratch, 'fallback-prefix'))
    const fallbackShim = join(fallbackPath, process.platform === 'win32' ? 'dsh-tui.cmd' : 'dsh-tui')
    check(
      'launcher resolve: aliases of one global package accept the version marker',
      resolveGlobalLauncherTarget({ PATH: fallbackPath, [GLOBAL_LAUNCHER_VERSION_ENV]: '0.1.0' })?.packageDir === realpathSync(fallbackPkg),
    )
    check(
      'launcher resolve: PATH fallback rejects a version mismatch',
      resolveGlobalLauncherTarget({ PATH: fallbackPath, [GLOBAL_LAUNCHER_VERSION_ENV]: '0.18.0' }) === undefined,
    )
    check(
      'launcher resolve: no marker at all means no launcher to align',
      resolveGlobalLauncherTarget({ PATH: fallbackPath }) === undefined,
    )

    const first = npmGlobal(join(scratch, 'path-first'), ['dst'])
    const second = npmGlobal(join(scratch, 'path-second'), ['dsh-tui'])
    for (const bins of [[first.binDir, second.binDir], [second.binDir, first.binDir]]) {
      const env = { PATH: bins.join(process.platform === 'win32' ? ';' : ':'), [GLOBAL_LAUNCHER_VERSION_ENV]: '0.1.0' }
      const ordered = resolveGlobalLauncherTarget(env)
      const outcome = await alignGlobalLauncher('0.9.9', { env })
      check(
        'launcher resolve: distinct same-version alias installations are ambiguous',
        ordered === undefined && outcome.kind === 'none' && outcome.reason === 'unresolved'
          && launcherVersionAt(first.packageDir) === '0.1.0' && launcherVersionAt(second.packageDir) === '0.1.0'
          && readFileSync(join(first.packageDir, 'bin', 'dsh-tui.js'), 'utf8') === oldBin
          && readFileSync(join(second.packageDir, 'bin', 'dsh-tui.js'), 'utf8') === oldBin,
        JSON.stringify({ ordered, outcome }),
      )
      check(
        'launcher resolve: explicit provenance selects the invoked alias installation',
        resolveGlobalLauncherTarget({ ...env, [GLOBAL_LAUNCHER_PATH_ENV]: join(second.packageDir, 'bin', 'dsh-tui.js') })?.packageDir === realpathSync(second.packageDir),
      )
    }

    // Windows is the only platform with its own discovery rules (`.cmd`/`.ps1`
    // shims in the npm prefix, `Path` spelling) and no CI job runs this file on
    // Windows, so the platform seam is exercised here: a regression in either
    // rule would silently leave Windows launchers unaligned.
    const winPrefix = join(scratch, 'win-npm')
    const { packageDir: winPkg } = npmGlobal(winPrefix, ['dsh-tui', 'dst'], 'win32')
    const winTarget = resolveGlobalLauncherTarget({ Path: winPrefix, [GLOBAL_LAUNCHER_VERSION_ENV]: '0.1.0' }, 'win32')
    check(
      'launcher resolve: win32 reads the .cmd shims from the npm prefix',
      winTarget?.packageDir === realpathSync(winPkg) && winTarget.layout === 'npm',
      JSON.stringify(winTarget),
    )
    check(
      'launcher resolve: win32 without the version marker fails closed',
      resolveGlobalLauncherTarget({ Path: winPrefix }, 'win32') === undefined,
    )

    const winLocalRoot = join(scratch, 'win-local')
    const winLocalPkg = join(winLocalRoot, 'node_modules', PKG_NAME)
    const winLocalBins = join(winLocalRoot, 'node_modules', '.bin')
    mkdirSync(join(winLocalPkg, 'bin'), { recursive: true })
    mkdirSync(winLocalBins, { recursive: true })
    writeFileSync(join(winLocalPkg, 'package.json'), JSON.stringify({ name: PKG_NAME, version: '0.1.0' }))
    writeFileSync(join(winLocalPkg, 'bin', 'dsh-tui.js'), oldBin)
    writeFileSync(join(winLocalBins, 'dsh-tui.cmd'), '@echo off\r\nnode "%~dp0\\..\\@deepseek-harness-tui\\dsh-tui\\bin\\dsh-tui.js" %*\r\n')
    check(
      'launcher resolve: win32 local npm .bin is not a global install',
      resolveGlobalLauncherTarget({ Path: winLocalBins, [GLOBAL_LAUNCHER_VERSION_ENV]: '0.1.0' }, 'win32')?.layout === 'unknown',
    )

    // pnpm's Windows global layout is a sibling subtree, not an ancestor
    // `node_modules`: bins in `<prefix>\bin`, packages in
    // `<prefix>\global\v11\<hash>\node_modules`. The `.cmd` shim therefore has
    // no ancestor node_modules for the walk to find (#1844 review R1).
    const winPnpmHome = join(scratch, 'win-pnpm')
    const winPnpmPkg = join(winPnpmHome, 'global', 'v11', 'hash', 'node_modules', PKG_NAME)
    mkdirSync(join(winPnpmPkg, 'bin'), { recursive: true })
    writeFileSync(join(winPnpmPkg, 'package.json'), JSON.stringify({ name: PKG_NAME, version: '0.1.0' }))
    writeFileSync(join(winPnpmPkg, 'bin', 'dsh-tui.js'), oldBin)
    mkdirSync(join(winPnpmHome, 'bin'), { recursive: true })
    writeFileSync(join(winPnpmHome, 'bin', 'dsh-tui.cmd'), '')
    const winPnpmTarget = resolveGlobalLauncherTarget({ Path: join(winPnpmHome, 'bin'), [GLOBAL_LAUNCHER_VERSION_ENV]: '0.1.0' }, 'win32')
    check(
      'launcher resolve: win32 pnpm global slot is found beside the .cmd shim',
      winPnpmTarget?.packageDir === realpathSync(winPnpmPkg)
        && winPnpmTarget?.layout === 'pnpm'
        && winPnpmTarget?.pnpmHome === realpathSync(winPnpmHome),
      JSON.stringify(winPnpmTarget),
    )

    const alignEnv = { PATH: fallbackPath, [GLOBAL_LAUNCHER_PATH_ENV]: fallbackShim }
    const copied = await alignGlobalLauncher('0.9.9', { env: alignEnv })
    check(
      'launcher align: npm layout copies the shim and reports it',
      copied.kind === 'copied' && launcherVersionAt(fallbackPkg) === '0.9.9',
      JSON.stringify(copied),
    )
    const aligned = await alignGlobalLauncher('0.9.9', { env: alignEnv })
    check('launcher align: an already-aligned install is a no-op', aligned.kind === 'none' && aligned.reason === 'aligned')
    writeFileSync(join(fallbackPkg, 'package.json'), JSON.stringify({ name: PKG_NAME, version: '9.9.9' }))
    const newer = await alignGlobalLauncher('0.9.9', { env: alignEnv })
    check('launcher align: never downgrades a newer launcher', newer.kind === 'none' && newer.reason === 'newer')
    const disabled = await alignGlobalLauncher('0.9.9', { env: { ...alignEnv, [UPDATE_LAUNCHER_ENV]: '0' } })
    check('launcher align: DSH_TUI_UPDATE_LAUNCHER=0 skips the step', disabled.kind === 'none' && disabled.reason === 'disabled')
    const savedAlignArgv = process.argv[1]
    process.argv[1] = join(pkgRoot, 'bin', 'dsh-tui.js')
    const absent = await alignGlobalLauncher('0.9.9', { env: {} })
    process.argv[1] = savedAlignArgv
    check(
      'launcher align: a profile-copy argv[1] has nothing to align',
      absent.kind === 'none' && absent.reason === 'absent',
      JSON.stringify(absent),
    )

    // A source checkout is not an installation: it must never be rewritten,
    // however the path is reached (#1844 review R1).
    const checkout = join(scratch, 'checkout')
    mkdirSync(join(checkout, 'bin'), { recursive: true })
    const checkoutManifest = JSON.stringify({ name: PKG_NAME, version: '0.0.1' })
    writeFileSync(join(checkout, 'package.json'), checkoutManifest)
    writeFileSync(join(checkout, 'bin', 'dsh-tui.js'), 'checkout launcher')
    check(
      'launcher copy: a source checkout is never rewritten',
      pkgMod.migrateGlobalLauncher(join(checkout, 'bin', 'dsh-tui.js')) === false
        && readFileSync(join(checkout, 'bin', 'dsh-tui.js'), 'utf8') === 'checkout launcher'
        && readFileSync(join(checkout, 'package.json'), 'utf8') === checkoutManifest,
    )

    // Local npm/npx installs can have the same name/version as a global one.
    // Their project pin, lockfile and package bytes must survive every route.
    for (const label of ['project', 'npm-cache/_npx/hash']) {
      const localRoot = join(scratch, label)
      const localPkg = join(localRoot, 'node_modules', PKG_NAME)
      const localBin = join(localPkg, 'bin', 'dsh-tui.js')
      const localBins = join(localRoot, 'node_modules', '.bin')
      mkdirSync(join(localPkg, 'bin'), { recursive: true })
      mkdirSync(localBins, { recursive: true })
      writeFileSync(localBin, oldBin)
      writeFileSync(join(localPkg, 'package.json'), JSON.stringify({ name: PKG_NAME, version: '0.1.0' }))
      writeFileSync(join(localRoot, 'package.json'), JSON.stringify({ private: true, dependencies: { [PKG_NAME]: '0.1.0' } }))
      writeFileSync(join(localRoot, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: { '': { dependencies: { [PKG_NAME]: '0.1.0' } } } }))
      for (const name of ['dsh-tui', 'dst']) {
        if (process.platform === 'win32') writeFileSync(join(localBins, `${name}.cmd`), '@echo off\r\nnode "%~dp0\\..\\@deepseek-harness-tui\\dsh-tui\\bin\\dsh-tui.js" %*\r\n')
        else symlinkSync(localBin, join(localBins, name))
      }
      const paths = [localBin, join(localPkg, 'package.json'), join(localRoot, 'package.json'), join(localRoot, 'package-lock.json')]
      const before = paths.map(path => readFileSync(path, 'utf8'))
      const localEnv = { PATH: localBins, [GLOBAL_LAUNCHER_VERSION_ENV]: '0.1.0' }
      for (const env of [localEnv, { ...localEnv, [GLOBAL_LAUNCHER_PATH_ENV]: localBin }]) {
        const target = resolveGlobalLauncherTarget(env)
        const outcome = await alignGlobalLauncher('0.9.9', { env })
        check(
          `launcher align: ${label} npm install stays pinned`,
          target?.layout === 'unknown' && outcome.kind === 'none' && outcome.reason === 'unresolved'
            && pkgMod.migrateGlobalLauncher(localPkg) === false
            && paths.every((path, index) => readFileSync(path, 'utf8') === before[index]),
          JSON.stringify({ target, outcome }),
        )
      }
    }

    // A `dsh --profile` boot puts dsh's own bin in argv[1]. A global dsh-tui
    // may sit beside it in the same prefix, but that launch never went
    // through it, so it is not the launcher of this chain (plan §3.5 case 3).
    const dshPrefix = join(scratch, 'dsh-prefix')
    const sibling = join(dshPrefix, 'lib', 'node_modules', PKG_NAME)
    mkdirSync(join(sibling, 'bin'), { recursive: true })
    writeFileSync(join(sibling, 'package.json'), JSON.stringify({ name: PKG_NAME, version: '0.1.0' }))
    writeFileSync(join(sibling, 'bin', 'dsh-tui.js'), oldBin)
    const dshBin = join(dshPrefix, 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
    mkdirSync(join(dshPrefix, 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'lib'), { recursive: true })
    writeFileSync(dshBin, '// dsh host\n')
    process.argv[1] = dshBin
    const siblingOut = await alignGlobalLauncher('0.9.9', { env: {} })
    process.argv[1] = savedAlignArgv
    check(
      'launcher align: a dsh bin in argv[1] never rewrites a neighbouring launcher',
      siblingOut.kind === 'none' && launcherVersionAt(sibling) === '0.1.0',
      JSON.stringify(siblingOut),
    )

    // The npm POSIX layout is a symlink in <prefix>/bin; the resolver must
    // follow it to the package (the shape the historical code also accepted).
    if (process.platform !== 'win32') {
      const linkPrefix = join(scratch, 'link-prefix')
      const linkPkg = join(linkPrefix, 'lib', 'node_modules', PKG_NAME)
      mkdirSync(join(linkPkg, 'bin'), { recursive: true })
      mkdirSync(join(linkPrefix, 'bin'), { recursive: true })
      writeFileSync(join(linkPkg, 'package.json'), JSON.stringify({ name: PKG_NAME, version: '0.1.0' }))
      writeFileSync(join(linkPkg, 'bin', 'dsh-tui.js'), oldBin)
      symlinkSync(join(linkPkg, 'bin', 'dsh-tui.js'), join(linkPrefix, 'bin', 'dsh-tui'))
      const linked = resolveGlobalLauncherTarget({ [GLOBAL_LAUNCHER_PATH_ENV]: join(linkPrefix, 'bin', 'dsh-tui') })
      check(
        'launcher resolve: an npm bin symlink follows to the package dir',
        linked?.packageDir === realpathSync(linkPkg) && linked.layout === 'npm',
        JSON.stringify(linked),
      )
    }

    // The replacement must not carry the OLD launcher generation when this
    // update just aligned it, or its boot prints a contradicting warning.
    check(
      'restart env: a copied launcher refreshes the generation marker and keeps the path',
      JSON.stringify(launcherRestartEnv({ kind: 'copied', reason: 'copy', version: '0.9.9' }))
        === JSON.stringify({ DSH_TUI_LAUNCHER_VERSION: '0.9.9' }),
    )
    // pnpm re-creates the global slot on install (11.21: `global/v11/6-…`
    // becomes `7-…` and the old slot is pruned), so the inherited bin path is
    // gone; blank it so the replacement re-locates the launcher through PATH.
    check(
      'restart env: a pnpm-installed launcher blanks the inherited bin path',
      JSON.stringify(launcherRestartEnv({ kind: 'installed', reason: 'install', version: '0.9.9' }))
        === JSON.stringify({ DSH_TUI_LAUNCHER_VERSION: '0.9.9', DSH_TUI_LAUNCHER_PATH: '' }),
    )
    check(
      'restart env: a skipped or failed launcher step leaves the inherited marker',
      Object.keys(launcherRestartEnv({ kind: 'failed', reason: 'copy', version: '0.9.9' })).length === 0
        && Object.keys(launcherRestartEnv({ kind: 'none', reason: 'aligned' })).length === 0
        && Object.keys(launcherRestartEnv(undefined)).length === 0,
    )

    // pnpm's global layout is a shim over the store: update through pnpm,
    // never by writing through the store's symlinks. Real pnpm 11/12 groups
    // carry a package.json listing every member, so the fixture does too.
    const pnpmHome = join(scratch, 'pnpm-home')
    const pnpmGroup = join(pnpmHome, 'global', 'v11', 'group-hash')
    const pnpmStore = join(pnpmGroup, 'node_modules', PKG_NAME)
    mkdirSync(join(pnpmStore, 'bin'), { recursive: true })
    writeFileSync(join(pnpmGroup, 'package.json'), JSON.stringify({ dependencies: { [PKG_NAME]: '0.1.0' } }))
    writeFileSync(join(pnpmStore, 'package.json'), JSON.stringify({ name: PKG_NAME, version: '0.1.0' }))
    const pnpmBin = join(pnpmStore, 'bin', 'dsh-tui.js')
    writeFileSync(pnpmBin, oldBin)
    const pnpmTarget = resolveGlobalLauncherTarget({ [GLOBAL_LAUNCHER_PATH_ENV]: pnpmBin })
    check(
      'launcher resolve: pnpm global store is classified and derives PNPM_HOME',
      pnpmTarget?.layout === 'pnpm' && pnpmTarget?.pnpmHome === realpathSync(pnpmHome),
      JSON.stringify(pnpmTarget),
    )
    const fakeBin = join(scratch, 'fake-bin')
    mkdirSync(fakeBin, { recursive: true })
    const pnpmLog = join(scratch, 'pnpm.log')
    writeFileSync(
      join(fakeBin, 'pnpm'),
      '#!/bin/sh\nfor a in "$@"; do printf \'<%s>\' "$a"; done >> "$PNPM_LOG"\nprintf \'%s\' "${PNPM_HOME-}" >> "$PNPM_LOG.pnpm_home"\nprintf \'%s\' "${PATH-}" >> "$PNPM_LOG.path"\nexit 0\n',
    )
    chmodSync(join(fakeBin, 'pnpm'), 0o755)
    if (process.platform === 'win32') {
      writeFileSync(
        join(fakeBin, 'pnpm.cmd'),
        '@echo off\r\nnode -e "const fs=require(\'fs\');fs.appendFileSync(process.env.PNPM_LOG,process.argv.slice(1).map(v=>\'<\'+v+\'>\').join(\'\'));fs.writeFileSync(process.env.PNPM_LOG+\'.pnpm_home\',process.env.PNPM_HOME||\'\');fs.writeFileSync(process.env.PNPM_LOG+\'.path\',process.env.PATH||\'\')" -- %*\r\n@exit /b 0\r\n',
        'ascii',
      )
    }
    const pnpmEnv = {
      ...process.env,
      PATH: [fakeBin, process.env.PATH ?? ''].join(process.platform === 'win32' ? ';' : ':'),
      PNPM_LOG: pnpmLog,
      [GLOBAL_LAUNCHER_PATH_ENV]: pnpmBin,
    }
    // The developer's own opt-out must not leak into the fixtures: the pnpm
    // assertions below unconditionally expect the installer to run.
    delete pnpmEnv[UPDATE_LAUNCHER_ENV]
    const installed = await alignGlobalLauncher('0.9.9', { env: pnpmEnv })
    check(
      'launcher align: pnpm global layout runs pnpm add -g instead of a file copy',
      installed.kind === 'installed'
        && readFileSync(pnpmLog, 'utf8').trim()
          === '<add><-g><--config.auto-install-peers=false><@deepseek-harness-tui/dsh-tui@0.9.9>'
        && launcherVersionAt(pnpmStore) === '0.1.0',
      JSON.stringify(installed),
    )
    check(
      'launcher align: pnpm add -g receives the derived PNPM_HOME',
      readFileSync(`${pnpmLog}.pnpm_home`, 'utf8') === realpathSync(pnpmHome),
      readFileSync(`${pnpmLog}.pnpm_home`, 'utf8'),
    )

    // A failed pnpm install prints the repair command. It must pin the SAME
    // owner home the automated run used: an inherited PNPM_HOME may name
    // another global install and repair the wrong one (#1849 review R3).
    const failBin = join(scratch, 'fake-bin-fail')
    mkdirSync(failBin, { recursive: true })
    writeFileSync(join(failBin, 'pnpm'), '#!/bin/sh\nexit 1\n')
    chmodSync(join(failBin, 'pnpm'), 0o755)
    if (process.platform === 'win32') writeFileSync(join(failBin, 'pnpm.cmd'), '@echo off\r\nexit /b 1\r\n')
    const failedLauncher = await alignGlobalLauncher('0.9.9', {
      env: {
        ...pnpmEnv,
        PATH: [failBin, process.env.PATH ?? ''].join(process.platform === 'win32' ? ';' : ':'),
      },
    })
    check(
      'launcher align: a failed pnpm install prints a command pinned to the owner home',
      failedLauncher.kind === 'failed'
        && failedLauncher.command?.includes(`PNPM_HOME=${realpathSync(pnpmHome)}`) === true
        && failedLauncher.command?.includes('pnpm add -g') === true,
      JSON.stringify(failedLauncher),
    )

    // A logical group owns its launcher even when its real package lives in
    // another home's shared store and the shell inherited that other home.
    const ownerHome = join(scratch, 'pnpm-owner-home')
    const otherHome = join(scratch, 'pnpm-other-home')
    const ownerGroup = join(ownerHome, 'global', 'v11', 'owner-group')
    const sharedStore = join(otherHome, 'store', 'v11', 'links', PKG_NAME, '0.1.0', 'shared', 'node_modules', PKG_NAME)
    mkdirSync(join(sharedStore, 'bin'), { recursive: true })
    writeFileSync(join(sharedStore, 'package.json'), JSON.stringify({ name: PKG_NAME, version: '0.1.0' }))
    writeFileSync(join(sharedStore, 'bin', 'dsh-tui.js'), oldBin)
    const ownerLink = join(ownerGroup, 'node_modules', PKG_NAME)
    mkdirSync(dirname(ownerLink), { recursive: true })
    symlinkSync(sharedStore, ownerLink, process.platform === 'win32' ? 'junction' : 'dir')
    writeFileSync(join(ownerGroup, 'package.json'), JSON.stringify({ dependencies: { [PKG_NAME]: '0.1.0' } }))
    const otherPkg = join(otherHome, 'global', 'v11', 'other-group', 'node_modules', PKG_NAME)
    mkdirSync(join(otherPkg, 'bin'), { recursive: true })
    const otherManifest = JSON.stringify({ name: PKG_NAME, version: '9.9.9' })
    writeFileSync(join(otherPkg, 'package.json'), otherManifest)
    writeFileSync(join(otherPkg, 'bin', 'dsh-tui.js'), 'other launcher')
    // Even a second global group sharing the exact package bytes does not
    // prove that a raw store-path invocation belongs to that inherited home.
    const sharedReferenceGroup = join(otherHome, 'global', 'v11', 'shared-reference')
    const sharedReference = join(sharedReferenceGroup, 'node_modules', PKG_NAME)
    mkdirSync(dirname(sharedReference), { recursive: true })
    symlinkSync(sharedStore, sharedReference, process.platform === 'win32' ? 'junction' : 'dir')
    writeFileSync(join(sharedReferenceGroup, 'package.json'), JSON.stringify({ dependencies: { [PKG_NAME]: '0.1.0' } }))
    const ownerBin = join(ownerLink, 'bin', 'dsh-tui.js')
    const mismatchedEnv = { ...pnpmEnv, PNPM_HOME: otherHome, [GLOBAL_LAUNCHER_PATH_ENV]: ownerBin }
    writeFileSync(pnpmLog, '')
    rmSync(`${pnpmLog}.pnpm_home`, { force: true })
    const ownedTarget = resolveGlobalLauncherTarget(mismatchedEnv)
    const ownedOutcome = await alignGlobalLauncher('0.9.9', { env: mismatchedEnv })
    check(
      'launcher align: logical group ownership wins over inherited store containment',
      ownedTarget?.pnpmHome === ownerHome && ownedOutcome.kind === 'installed'
        && readFileSync(`${pnpmLog}.pnpm_home`, 'utf8') === ownerHome
        && readFileSync(join(otherPkg, 'package.json'), 'utf8') === otherManifest
        && readFileSync(join(otherPkg, 'bin', 'dsh-tui.js'), 'utf8') === 'other launcher',
      JSON.stringify({ ownedTarget, ownedOutcome }),
    )
    writeFileSync(pnpmLog, '')
    const unownedEnv = { ...mismatchedEnv, [GLOBAL_LAUNCHER_PATH_ENV]: join(sharedStore, 'bin', 'dsh-tui.js') }
    const unownedTarget = resolveGlobalLauncherTarget(unownedEnv)
    const unownedOutcome = await alignGlobalLauncher('0.9.9', { env: unownedEnv })
    check(
      'launcher align: a store inside PNPM_HOME is not evidence of an owning group',
      unownedTarget?.pnpmHome === undefined && unownedOutcome.kind === 'failed'
        && unownedOutcome.reason === 'unresolved' && readFileSync(pnpmLog, 'utf8') === '',
      JSON.stringify({ unownedTarget, unownedOutcome }),
    )

    // pnpm 11+ replaces the entire global group. Re-adding the direct members
    // with launcher-specific peer suppression still loses their auto-installed
    // peers, so no multi-member group may reach an installer at all.
    const groupedHome = join(scratch, 'pnpm-grouped-home')
    const groupedRoot = join(groupedHome, 'global', 'v11', 'grouped-hash')
    const groupedPkg = join(groupedRoot, 'node_modules', PKG_NAME)
    const partnerName = 'partner-cli'
    const partnerPkg = join(groupedRoot, 'node_modules', partnerName)
    const peerPkg = join(groupedRoot, 'node_modules', 'partner-required-peer')
    const partnerCli = join(partnerPkg, 'cli.cjs')
    mkdirSync(join(groupedPkg, 'bin'), { recursive: true })
    mkdirSync(partnerPkg, { recursive: true })
    mkdirSync(peerPkg, { recursive: true })
    writeFileSync(join(groupedRoot, 'package.json'), JSON.stringify({
      dependencies: { [PKG_NAME]: '0.1.0', [partnerName]: '^2.0.0' },
    }))
    writeFileSync(join(groupedPkg, 'package.json'), JSON.stringify({ name: PKG_NAME, version: '0.1.0' }))
    writeFileSync(join(partnerPkg, 'package.json'), JSON.stringify({
      name: partnerName, version: '2.0.0', bin: 'cli.cjs', peerDependencies: { 'partner-required-peer': '^1.0.0' },
    }))
    writeFileSync(join(peerPkg, 'package.json'), JSON.stringify({ name: 'partner-required-peer', version: '1.0.0', main: 'index.cjs' }))
    writeFileSync(join(peerPkg, 'index.cjs'), "module.exports = 'PEER_RUNTIME_OK'\n")
    writeFileSync(partnerCli, "process.stdout.write(require('partner-required-peer') + '\\n')\n")
    writeFileSync(join(groupedPkg, 'bin', 'dsh-tui.js'), oldBin)
    const peerBefore = spawnSync(process.execPath, [partnerCli], { encoding: 'utf8', timeout: 5000 })
    check(
      'launcher align: grouped sibling really loads its required installed peer before alignment',
      peerBefore.status === 0 && peerBefore.stdout === 'PEER_RUNTIME_OK\n',
      `status=${peerBefore.status} stderr=${peerBefore.stderr}`,
    )
    writeFileSync(pnpmLog, '')
    const groupedOut = await alignGlobalLauncher('0.9.9', {
      env: { ...pnpmEnv, [GLOBAL_LAUNCHER_PATH_ENV]: join(groupedPkg, 'bin', 'dsh-tui.js') },
    })
    check(
      'launcher align: a multi-member pnpm group is refused without an installer',
      groupedOut.kind === 'failed' && groupedOut.reason === 'unresolved'
        && readFileSync(pnpmLog, 'utf8') === ''
        && launcherVersionAt(groupedPkg) === '0.1.0'
        && launcherVersionAt(partnerPkg) === '2.0.0',
      `${JSON.stringify(groupedOut)} log=${readFileSync(pnpmLog, 'utf8')}`,
    )
    const peerAfter = spawnSync(process.execPath, [partnerCli], { encoding: 'utf8', timeout: 5000 })
    check(
      'launcher align: refusing the grouped update preserves sibling peer runtime behavior',
      peerAfter.status === 0 && peerAfter.stdout === 'PEER_RUNTIME_OK\n',
      `status=${peerAfter.status} stderr=${peerAfter.stderr}`,
    )
    check(
      'launcher align: grouped repair guidance only inspects and preserves members plus peers',
      groupedOut.command?.startsWith('pnpm list -g --depth 0\n') === true
        && groupedOut.command.includes('Preserve every member and its installed peers')
        && !groupedOut.command.includes('pnpm add -g')
        && !groupedOut.command.includes('pnpm update -g'),
      groupedOut.command,
    )

    // Non-registry sources stay refused too: grouping them cannot justify
    // silently switching an alias, local link, Git or tarball to a registry
    // package. The same source check applies to a launcher-only group.
    const writeGroupFixture = (homeName, hash, dependencies, packages) => {
      const root = join(scratch, homeName, 'global', 'v11', hash)
      const launcher = join(root, 'node_modules', PKG_NAME)
      mkdirSync(join(launcher, 'bin'), { recursive: true })
      writeFileSync(join(launcher, 'package.json'), JSON.stringify({ name: PKG_NAME, version: '0.1.0' }))
      writeFileSync(join(launcher, 'bin', 'dsh-tui.js'), oldBin)
      for (const [name, manifest] of Object.entries(packages)) {
        const dir = join(root, 'node_modules', name)
        mkdirSync(dir, { recursive: true })
        writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest))
      }
      writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies }))
      return join(launcher, 'bin', 'dsh-tui.js')
    }
    const aliasBin = writeGroupFixture(
      'pnpm-alias-home', 'alias-hash',
      { [PKG_NAME]: '0.1.0', tsc: 'npm:typescript@2.0.3' },
      { tsc: { name: 'typescript', version: '2.0.3' } },
    )
    writeFileSync(pnpmLog, '')
    const aliasOut = await alignGlobalLauncher('0.9.9', {
      env: { ...pnpmEnv, [GLOBAL_LAUNCHER_PATH_ENV]: aliasBin },
    })
    check(
      'launcher align: an aliased pnpm sibling is refused, not rewritten',
      aliasOut.kind === 'failed'
        && aliasOut.reason === 'unresolved'
        && readFileSync(pnpmLog, 'utf8') === ''
        && aliasOut.command?.includes(`${PKG_NAME}@0.9.9`) === true,
      JSON.stringify(aliasOut),
    )
    for (const [label, spec, manifest] of [
      ['file:', 'file:../local-cli', { name: 'local-cli', version: '1.2.3' }],
      ['Git', 'git+https://example.com/local-cli.git', { name: 'local-cli', version: '1.2.3' }],
    ]) {
      const binPath = writeGroupFixture(
        `pnpm-${label === 'file:' ? 'file' : 'git'}-home`, 'local-hash',
        { [PKG_NAME]: '0.1.0', 'local-cli': spec },
        { 'local-cli': manifest },
      )
      writeFileSync(pnpmLog, '')
      const out = await alignGlobalLauncher('0.9.9', {
        env: { ...pnpmEnv, [GLOBAL_LAUNCHER_PATH_ENV]: binPath },
      })
      check(
        `launcher align: a ${label} pnpm sibling is refused, not rewritten`,
        out.kind === 'failed' && out.reason === 'unresolved' && readFileSync(pnpmLog, 'utf8') === '',
        JSON.stringify(out),
      )
    }

    for (const [label, spec] of [
      ['alias', `npm:${PKG_NAME}@0.1.0`],
      ['file', 'file:../local-launcher'],
      ['link', 'link:../local-launcher'],
      ['Git', 'git+https://example.com/launcher.git'],
      ['tarball', 'https://example.com/launcher.tgz'],
    ]) {
      const binPath = writeGroupFixture(`pnpm-singleton-${label}-home`, 'source-hash', { [PKG_NAME]: spec }, {})
      writeFileSync(pnpmLog, '')
      const out = await alignGlobalLauncher('0.9.9', {
        env: { ...pnpmEnv, [GLOBAL_LAUNCHER_PATH_ENV]: binPath },
      })
      check(
        `launcher align: a launcher-only ${label} source is refused without switching it to the registry`,
        out.kind === 'failed' && out.reason === 'unresolved' && readFileSync(pnpmLog, 'utf8') === ''
          && out.command?.includes('pnpm add -g') === false,
        JSON.stringify(out),
      )
    }

    // A project-local pnpm install (a bare `.pnpm` store) is neither a global
    // install nor safe to rewrite: leave it alone instead of guessing (#1844 R3).
    const localStore = join(scratch, 'proj', 'node_modules', '.pnpm', '@deepseek-harness-tui+dsh-tui@0.1.0', 'node_modules', PKG_NAME)
    mkdirSync(join(localStore, 'bin'), { recursive: true })
    writeFileSync(join(localStore, 'package.json'), JSON.stringify({ name: PKG_NAME, version: '0.1.0' }))
    writeFileSync(join(localStore, 'bin', 'dsh-tui.js'), oldBin)
    const localTarget = resolveGlobalLauncherTarget({ [GLOBAL_LAUNCHER_PATH_ENV]: join(localStore, 'bin', 'dsh-tui.js') })
    check(
      'launcher resolve: a project-local pnpm store is unknown, not pnpm-global',
      localTarget?.layout === 'unknown' && localTarget?.pnpmHome === undefined,
      JSON.stringify(localTarget),
    )

    // pnpm 12's global layout: the shim targets global/v11/<hash>/…, whose
    // realpath is a store link. The store root is configurable, so it need not
    // be named `store`; the version+links structure is the signal. With no
    // exported PNPM_HOME it must still classify as pnpm — an "npm" verdict
    // would file-overwrite the store (#1844 review R3).
    const pnpm12Home = join(scratch, 'pnpm12-home')
    const storeLink = join(pnpm12Home, 'custom-cache', 'v11', 'links', PKG_NAME, '0.1.0', 'hash', 'node_modules', PKG_NAME)
    mkdirSync(join(storeLink, 'bin'), { recursive: true })
    writeFileSync(join(storeLink, 'package.json'), JSON.stringify({ name: PKG_NAME, version: '0.1.0' }))
    writeFileSync(join(storeLink, 'bin', 'dsh-tui.js'), oldBin)
    const pnpm12Target = resolveGlobalLauncherTarget({ [GLOBAL_LAUNCHER_PATH_ENV]: join(storeLink, 'bin', 'dsh-tui.js') })
    check(
      'launcher resolve: a pnpm store link under a custom root is pnpm, not npm',
      pnpm12Target?.layout === 'pnpm' && pnpm12Target?.pnpmHome === undefined,
      JSON.stringify(pnpm12Target),
    )
    check(
      'launcher copy: a pnpm store link is never file-overwritten',
      pkgMod.migrateGlobalLauncher(join(storeLink, 'bin', 'dsh-tui.js')) === false
        && launcherVersionAt(storeLink) === '0.1.0'
        && readFileSync(join(storeLink, 'bin', 'dsh-tui.js'), 'utf8') === oldBin,
    )

    // npm link / a workspace link: the package dir is a symlink to a checkout.
    // The resolved-path check must refuse it instead of rewriting the checkout.
    const linkedCheckout = join(scratch, 'linked-checkout')
    mkdirSync(join(linkedCheckout, 'bin'), { recursive: true })
    writeFileSync(join(linkedCheckout, 'package.json'), JSON.stringify({ name: PKG_NAME, version: '0.0.1' }))
    writeFileSync(join(linkedCheckout, 'bin', 'dsh-tui.js'), 'linked checkout')
    const linkedPkgDir = join(scratch, 'link-global', 'lib', 'node_modules', PKG_NAME)
    mkdirSync(join(scratch, 'link-global', 'lib', 'node_modules', '@deepseek-harness-tui'), { recursive: true })
    symlinkSync(linkedCheckout, linkedPkgDir, process.platform === 'win32' ? 'junction' : 'dir')
    check(
      'launcher copy: a linked package dir resolves out of node_modules and is refused',
      pkgMod.migrateGlobalLauncher(linkedPkgDir) === false
        && readFileSync(join(linkedCheckout, 'bin', 'dsh-tui.js'), 'utf8') === 'linked checkout',
    )
    const linkedAlign = await alignGlobalLauncher('0.9.9', {
      env: { [GLOBAL_LAUNCHER_PATH_ENV]: join(linkedPkgDir, 'bin', 'dsh-tui.js') },
    })
    check(
      'launcher align: a linked checkout is not an align target',
      linkedAlign.kind === 'none' && linkedAlign.reason === 'unresolved',
      JSON.stringify(linkedAlign),
    )

    // A store link alone cannot name its install group, so no installer or
    // grouped add recipe is safe. The fallback only inspects and explains how
    // to preserve all group members and their installed peers.
    const pnpm12Env = { ...pnpmEnv, [GLOBAL_LAUNCHER_PATH_ENV]: join(storeLink, 'bin', 'dsh-tui.js') }
    delete pnpm12Env.PNPM_HOME
    writeFileSync(pnpmLog, '')
    rmSync(`${pnpmLog}.pnpm_home`, { force: true })
    const pnpm12Installed = await alignGlobalLauncher('0.9.9', { env: pnpm12Env })
    check(
      'launcher align: an unprovable pnpm group is refused, not guessed',
      pnpm12Installed.kind === 'failed'
        && pnpm12Installed.reason === 'unresolved'
        && pnpm12Installed.command?.includes('pnpm list -g --depth 0') === true
        && pnpm12Installed.command?.includes('pnpm update -g') === false
        && pnpm12Installed.command?.includes('pnpm add -g') === false
        && pnpm12Installed.command?.includes('Preserve every member and its installed peers') === true
        && pnpm12Installed.command?.includes(`${PKG_NAME}@0.9.9`) === true
        && readFileSync(pnpmLog, 'utf8') === ''
        && launcherVersionAt(storeLink) === '0.1.0',
      JSON.stringify(pnpm12Installed),
    )

    // A real pnpm 12 shim names global/v11/<group> even when the package
    // realpath is a store link under a custom store root: that path is enough
    // to classify it, derive PNPM_HOME and preserve the group.
    const customHome = join(scratch, 'pnpm-custom-home')
    const customGroup = join(customHome, 'global', 'v11', 'custom-hash')
    const customStore = join(scratch, 'custom-store-root', 'v11', 'links', PKG_NAME, '0.1.0', 'hash', 'node_modules', PKG_NAME)
    mkdirSync(join(customStore, 'bin'), { recursive: true })
    mkdirSync(join(customGroup, 'node_modules'), { recursive: true })
    writeFileSync(join(customStore, 'package.json'), JSON.stringify({ name: PKG_NAME, version: '0.1.0' }))
    writeFileSync(join(customStore, 'bin', 'dsh-tui.js'), oldBin)
    writeFileSync(join(customGroup, 'package.json'), JSON.stringify({ dependencies: { [PKG_NAME]: '0.1.0' } }))
    const customLink = join(customGroup, 'node_modules', PKG_NAME)
    mkdirSync(dirname(customLink), { recursive: true })
    symlinkSync(customStore, customLink, process.platform === 'win32' ? 'junction' : 'dir')
    const customBin = join(customGroup, 'node_modules', PKG_NAME, 'bin', 'dsh-tui.js')
    const customTarget = resolveGlobalLauncherTarget({ [GLOBAL_LAUNCHER_PATH_ENV]: customBin })
    check(
      'launcher resolve: the bin path names a custom-store global group',
      customTarget?.layout === 'pnpm'
        && customTarget?.pnpmHome === realpathSync(customHome)
        && customTarget?.packageDir === realpathSync(customStore),
      JSON.stringify(customTarget),
    )
    writeFileSync(pnpmLog, '')
    const customInstalled = await alignGlobalLauncher('0.9.9', {
      env: { ...pnpmEnv, [GLOBAL_LAUNCHER_PATH_ENV]: customBin },
    })
    check(
      'launcher align: a custom-store global group updates through pnpm',
      customInstalled.kind === 'installed'
        && readFileSync(pnpmLog, 'utf8').trim()
          === `<add><-g><--config.auto-install-peers=false><${PKG_NAME}@0.9.9>`,
      `${JSON.stringify(customInstalled)} log=${readFileSync(pnpmLog, 'utf8')}`,
    )

    // A REAL pnpm global install (11.x and 12.x alike) is a shim in
    // `<home>/bin` over a package that realpaths into the store, so no
    // `global/` segment survives, and a process started from a desktop entry,
    // cron or a supervisor inherits no PNPM_HOME either. The shim's own
    // directory still names the home; without that derivation the group stays
    // unprovable and the alignment refuses forever (#1847 review).
    const shimHome = join(scratch, 'pnpm-shim-home')
    const shimStore = join(shimHome, 'store', 'v11', 'links', PKG_NAME, '0.1.0', 'hash', 'node_modules', PKG_NAME)
    const shimGroup = join(shimHome, 'global', 'v11', 'b-18e46d33b4216a44-0')
    mkdirSync(join(shimStore, 'bin'), { recursive: true })
    writeFileSync(join(shimStore, 'package.json'), JSON.stringify({ name: PKG_NAME, version: '0.1.0' }))
    writeFileSync(join(shimStore, 'bin', 'dsh-tui.js'), oldBin)
    const shimLink = join(shimGroup, 'node_modules', PKG_NAME)
    mkdirSync(dirname(shimLink), { recursive: true })
    writeFileSync(join(shimGroup, 'package.json'), JSON.stringify({ dependencies: { [PKG_NAME]: '0.1.0' } }))
    symlinkSync(shimStore, shimLink, process.platform === 'win32' ? 'junction' : 'dir')
    const shimBin = join(shimHome, 'bin', 'dsh-tui')
    mkdirSync(join(shimHome, 'bin'), { recursive: true })
    writeFileSync(shimBin, '#!/bin/sh\n')
    const shimTarget = resolveGlobalLauncherTarget({ [GLOBAL_LAUNCHER_PATH_ENV]: shimBin })
    check(
      'launcher resolve: a pnpm shim names its home without PNPM_HOME',
      shimTarget?.layout === 'pnpm'
        && shimTarget?.pnpmHome !== undefined
        && realpathSync(shimTarget.pnpmHome) === realpathSync(shimHome)
        && shimTarget?.packageDir === realpathSync(shimStore),
      JSON.stringify(shimTarget),
    )
    const shimEnv = { ...pnpmEnv, [GLOBAL_LAUNCHER_PATH_ENV]: shimBin }
    delete shimEnv.PNPM_HOME
    writeFileSync(pnpmLog, '')
    rmSync(`${pnpmLog}.pnpm_home`, { force: true })
    const shimInstalled = await alignGlobalLauncher('0.9.9', { env: shimEnv })
    // A refused step runs no installer at all, so the PNPM_HOME file is absent:
    // read it optionally, or a pre-fix baseline would crash instead of failing.
    const shimInstallHome = existsSync(`${pnpmLog}.pnpm_home`) ? readFileSync(`${pnpmLog}.pnpm_home`, 'utf8') : ''
    // pnpm refuses a global install whose bin dir is not on PATH
    // (ERR_PNPM_GLOBAL_BIN_DIR_NOT_IN_PATH), so the child PATH must carry the
    // derived home's bin dir when the parent inherited no pnpm shell setup.
    const shimPath = existsSync(`${pnpmLog}.path`) ? readFileSync(`${pnpmLog}.path`, 'utf8') : ''
    const shimPathDirs = shimPath.split(process.platform === 'win32' ? ';' : ':')
    check(
      'launcher align: the shim-derived home drives the reinstall, its PNPM_HOME and PATH',
      shimInstalled.kind === 'installed'
        && readFileSync(pnpmLog, 'utf8').trim()
          === `<add><-g><--config.auto-install-peers=false><${PKG_NAME}@0.9.9>`
        && shimInstallHome !== ''
        && realpathSync(shimInstallHome) === realpathSync(shimHome)
        && shimPathDirs.includes(join(shimHome, 'bin')),
      `${JSON.stringify(shimInstalled)} log=${readFileSync(pnpmLog, 'utf8')} home=${shimInstallHome} path=${shimPath}`,
    )

    const pathWith = dir => ({
      ...pnpmEnv,
      PATH: [dir, process.env.PATH ?? ''].join(process.platform === 'win32' ? ';' : ':'),
    })

    // An installer that exits 130 on its own is a FAILURE, not a cancellation:
    // its code is indistinguishable from a stop, so only the runner stopping
    // the tree proves the user interrupted it.
    const selfExitBin = join(scratch, 'self-exit-bin')
    mkdirSync(selfExitBin, { recursive: true })
    writeFileSync(join(selfExitBin, 'pnpm'), '#!/bin/sh\nexit 130\n')
    chmodSync(join(selfExitBin, 'pnpm'), 0o755)
    if (process.platform === 'win32') writeFileSync(join(selfExitBin, 'pnpm.cmd'), '@echo off\r\n@exit /b 130\r\n', 'ascii')
    const selfExitOut = await alignGlobalLauncher('0.9.9', { env: pathWith(selfExitBin) })
    check(
      'launcher align: an installer exiting 130 on its own is a failure, not a cancel',
      selfExitOut.kind === 'failed' && selfExitOut.reason === 'install' && selfExitOut.command !== undefined,
      JSON.stringify(selfExitOut),
    )

    // A real stop (this runner kills the tree) still reports cancelled and
    // must not leave a repair command behind.
    const hangBin = join(scratch, 'hang-bin')
    mkdirSync(hangBin, { recursive: true })
    if (process.platform === 'win32') {
      // cmd.exe resolves the manager through PATHEXT: an extensionless file is
      // invisible, so the fixture would fall through to the developer's real
      // pnpm and run an actual global install before the abort.
      writeFileSync(join(hangBin, 'pnpm.cmd'), '@echo off\r\nping -n 30 127.0.0.1 >nul\r\n', 'ascii')
    } else {
      writeFileSync(join(hangBin, 'pnpm'), '#!/bin/sh\nsleep 30\n')
      chmodSync(join(hangBin, 'pnpm'), 0o755)
    }
    const cancelController = new AbortController()
    const cancelTimer = setTimeout(() => cancelController.abort(), 150)
    const cancelOut = await alignGlobalLauncher('0.9.9', { env: pathWith(hangBin), signal: cancelController.signal })
    clearTimeout(cancelTimer)
    check(
      'launcher align: a stopped installer reports cancelled, not a repair command',
      cancelOut.kind === 'none' && cancelOut.reason === 'cancelled' && cancelOut.command === undefined,
      JSON.stringify(cancelOut),
    )

    // When the runner cannot confirm the installer tree stopped, the update
    // must fail rather than restart over a process that may still be writing
    // the global install (#1844 review R4). Simulate the group-kill EPERM the
    // runner reports as `cleanup-error`; the fake installer exits on its own
    // shortly after, so the fixture leaves no process behind.
    if (process.platform !== 'win32') {
      const cleanupBin = join(scratch, 'cleanup-bin')
      mkdirSync(cleanupBin, { recursive: true })
      writeFileSync(join(cleanupBin, 'pnpm'), '#!/bin/sh\nsleep 3\n')
      chmodSync(join(cleanupBin, 'pnpm'), 0o755)
      const realKill = process.kill
      process.kill = (pid, signal) => {
        if (pid < 0) throw Object.assign(new Error('simulated EPERM'), { code: 'EPERM' })
        return realKill(pid, signal)
      }
      let cleanupOut
      try {
        const cleanupController = new AbortController()
        const cleanupTimer = setTimeout(() => cleanupController.abort(), 150)
        cleanupOut = await alignGlobalLauncher('0.9.9', {
          env: pathWith(cleanupBin),
          signal: cleanupController.signal,
        })
        clearTimeout(cleanupTimer)
      } finally {
        process.kill = realKill
      }
      check(
        'launcher align: unconfirmed cleanup fails instead of reporting success',
        cleanupOut.kind === 'failed'
          && cleanupOut.cleanupUnconfirmed === true
          && cleanupOut.command !== undefined,
        JSON.stringify(cleanupOut),
      )
    }

    // pnpm >= 11 delays just-published versions; the waiver has to reach the
    // child process, not only the printed manual command.
    if (process.platform === 'win32') {
      console.log('SKIP the release-age env check on win32 (shell env introspection)')
    } else {
      const envBin = join(scratch, 'env-bin')
      const envLog = join(scratch, 'env-child.txt')
      mkdirSync(envBin, { recursive: true })
      writeFileSync(join(envBin, 'pnpm'), `#!/bin/sh\nprintf '%s|%s' "$PNPM_CONFIG_MINIMUM_RELEASE_AGE" "$npm_config_minimum_release_age" > ${JSON.stringify(envLog)}\nexit 0\n`)
      chmodSync(join(envBin, 'pnpm'), 0o755)
      const envOut = await alignGlobalLauncher('0.9.9', { env: pathWith(envBin) })
      check(
        'launcher align: the release-age waiver reaches the pnpm child',
        envOut.kind === 'installed' && readFileSync(envLog, 'utf8').trim() === '0|0',
        `${envOut.kind} ${existsSync(envLog) ? readFileSync(envLog, 'utf8').trim() : 'no log'}`,
      )
    }
  } finally {
    if (savedArgv1 === undefined) delete process.argv[1]
    else process.argv[1] = savedArgv1
  }
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
// exempt this package at the exact versions pnpm checks before the swap: the
// target AND the still-locked old version (issue #1205).
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

    // Case 3: without a second exemption a stale own entry is replaced (no
    // accumulation) while foreign entries survive.
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

    // Case 3b: the same version is KEPT when it is the second exemption
    // (alsoExempt) — the locked version still inside the release-age window —
    // joined to the target in one union entry.
    writeFileSync(yamlPath, "minimumReleaseAgeExclude:\n  - 'x@1.0.0'\n  - '@deepseek-harness-tui/dsh-tui@0.9.3'\n")
    outcome = ensureProfileReleaseAgeExclude('tui', '0.10.0-beta.1', '0.9.3')
    text = readFileSync(yamlPath, 'utf8')
    check(
      'releaseAge: alsoExempt keeps the locked version alongside the target',
      outcome !== undefined && outcome.changed === true &&
        text.includes("minimumReleaseAgeExclude:\n  - 'x@1.0.0'\n  - '@deepseek-harness-tui/dsh-tui@0.10.0-beta.1 || 0.9.3'\n") &&
        (text.match(/@deepseek-harness-tui\/dsh-tui@/g) ?? []).length === 1,
      `${JSON.stringify(outcome)} :: ${text}`,
    )

    // Case 3c: idempotent once both exemptions are present — no rewrite.
    const bothBefore = readFileSync(yamlPath, 'utf8')
    outcome = ensureProfileReleaseAgeExclude('tui', '0.10.0-beta.1', '0.9.3')
    check(
      'releaseAge: second run with both exemptions is a no-op',
      outcome !== undefined && outcome.changed === false && readFileSync(yamlPath, 'utf8') === bothBefore,
      JSON.stringify(outcome),
    )

    // Case 3d: alsoExempt equal to the target (or empty) adds nothing twice.
    writeFileSync(yamlPath, "minimumReleaseAgeExclude:\n  - '@deepseek-harness-tui/dsh-tui@0.10.0-beta.1'\n")
    outcome = ensureProfileReleaseAgeExclude('tui', '0.10.0-beta.1', '0.10.0-beta.1')
    text = readFileSync(yamlPath, 'utf8')
    check(
      'releaseAge: alsoExempt === version keeps a single entry',
      outcome !== undefined && outcome.changed === false &&
        (text.match(/@deepseek-harness-tui\/dsh-tui@0\.10\.0-beta\.1/g) ?? []).length === 1,
      `${JSON.stringify(outcome)} :: ${text}`,
    )
    outcome = ensureProfileReleaseAgeExclude('tui', '0.10.0-beta.1', '')
    check(
      'releaseAge: empty alsoExempt is ignored',
      outcome !== undefined && outcome.changed === false && readFileSync(yamlPath, 'utf8') === text,
      JSON.stringify(outcome),
    )

    // Case 3e (issue #1205): two releases inside the window — the locked old
    // version is exempted together with the target, so the lockfile entry
    // pnpm verifies before the swap installs too. One union entry, not two:
    // pnpm 11.5.x–11.7.x honour only the first entry per package, so a
    // second entry for the locked version is ignored there (issue #1605).
    writeFileSync(yamlPath, "minimumReleaseAgeExclude:\n  - 'x@1.0.0'\n  - '@deepseek-harness-tui/dsh-tui@0.11.2'\n")
    outcome = ensureProfileReleaseAgeExclude('tui', '0.12.0', '0.11.2')
    text = readFileSync(yamlPath, 'utf8')
    check(
      'releaseAge: same-day double release exempts locked + target in one entry (#1205, #1605)',
      outcome !== undefined && outcome.changed === true &&
        JSON.stringify(outcome.entries) === JSON.stringify(['x@1.0.0', '@deepseek-harness-tui/dsh-tui@0.12.0 || 0.11.2']) &&
        text.includes("minimumReleaseAgeExclude:\n  - 'x@1.0.0'\n  - '@deepseek-harness-tui/dsh-tui@0.12.0 || 0.11.2'\n") &&
        (text.match(/@deepseek-harness-tui\/dsh-tui@/g) ?? []).length === 1,
      `${JSON.stringify(outcome)} :: ${text}`,
    )
    const doubleBefore = readFileSync(yamlPath, 'utf8')
    outcome = ensureProfileReleaseAgeExclude('tui', '0.12.0', '0.11.2')
    check(
      'releaseAge: double-release rerun is a no-op',
      outcome !== undefined && outcome.changed === false && readFileSync(yamlPath, 'utf8') === doubleBefore,
      JSON.stringify(outcome),
    )

    // Case 3f: a later update drops the entry the lockfile no longer pins —
    // the exempt list tracks locked + target, not every version ever exempt.
    outcome = ensureProfileReleaseAgeExclude('tui', '0.13.0', '0.12.0')
    text = readFileSync(yamlPath, 'utf8')
    check(
      'releaseAge: older own entry dropped once no longer needed',
      outcome !== undefined && outcome.changed === true &&
        text.includes("minimumReleaseAgeExclude:\n  - 'x@1.0.0'\n  - '@deepseek-harness-tui/dsh-tui@0.13.0 || 0.12.0'\n") &&
        (text.match(/@deepseek-harness-tui\/dsh-tui@/g) ?? []).length === 1,
      `${JSON.stringify(outcome)} :: ${text}`,
    )

    // Case 3g: the pre-#1605 two-entry pair collapses into the union, which
    // pnpm 11.5.x–11.7.x read whole.
    writeFileSync(yamlPath, "minimumReleaseAgeExclude:\n  - '@deepseek-harness-tui/dsh-tui@0.16.1'\n  - '@deepseek-harness-tui/dsh-tui@0.16.0'\n  - 'x@1.0.0'\n")
    outcome = ensureProfileReleaseAgeExclude('tui', '0.16.1', '0.16.0')
    text = readFileSync(yamlPath, 'utf8')
    check(
      'releaseAge: legacy two-entry pair rewritten as one union entry (#1605)',
      outcome !== undefined && outcome.changed === true &&
        text.includes("minimumReleaseAgeExclude:\n  - 'x@1.0.0'\n  - '@deepseek-harness-tui/dsh-tui@0.16.1 || 0.16.0'\n") &&
        (text.match(/@deepseek-harness-tui\/dsh-tui@/g) ?? []).length === 1,
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
const installCall = compiledSource.indexOf('await installProfileTui(profile')
check(
  'stamp: pre-update version is captured before the installer runs',
  stampRead !== -1 && installCall !== -1 && stampRead < installCall,
)
const stampEnvUse = compiledSource.indexOf('= restartEnvFor(outcome)')
check(
  'stamp: restart env reuses the captured value, not a fresh read',
  stampEnvUse !== -1 && stampEnvUse > installCall,
)
// The layer stamps are pure decisions: TUI moved -> UPDATED_FROM; engine
// verified + advanced -> UPDATED_DSH_FROM; a mere plan or a stale no-op must
// not arm either (#1844 §3.6).
check(
  'stamp: a moved TUI arms only DSH_TUI_UPDATED_FROM',
  JSON.stringify(restartEnvFor({ updatedFrom: '0.18.0', tuiChanged: true })) === JSON.stringify({ DSH_TUI_UPDATED_FROM: '0.18.0' }),
)
check(
  'stamp: engine-only update arms only DSH_TUI_UPDATED_DSH_FROM',
  JSON.stringify(restartEnvFor({
    updatedFrom: '0.18.0', tuiChanged: false,
    host: { from: '0.2.1-rc.4', to: '0.2.1-rc.5', code: 0, verified: true, manual: '' },
  })) === JSON.stringify({ DSH_TUI_UPDATED_DSH_FROM: '0.2.1-rc.4' }),
)
check(
  'stamp: an unverified engine install arms no engine stamp',
  JSON.stringify(restartEnvFor({
    updatedFrom: '0.18.0', tuiChanged: false,
    host: { from: '0.2.1-rc.4', to: '0.2.1-rc.5', code: 0, verified: false, manual: '' },
  })) === '{}',
)
check(
  'stamp: engine step that did not advance arms no engine stamp',
  JSON.stringify(restartEnvFor({
    updatedFrom: '0.18.0', tuiChanged: false,
    host: { from: '0.2.1-rc.5', to: '0.2.1-rc.5', code: 0, verified: true, manual: '' },
  })) === '{}',
)
check(
  'stamp: an aligned launcher keeps the inherited marker',
  JSON.stringify(restartEnvFor({ updatedFrom: '0.18.0', tuiChanged: true, launcher: { kind: 'none', reason: 'aligned' } })) === JSON.stringify({ DSH_TUI_UPDATED_FROM: '0.18.0' }),
  JSON.stringify(restartEnvFor({ updatedFrom: '0.18.0', tuiChanged: true, launcher: { kind: 'none', reason: 'aligned' } })),
)
check(
  'stamp: a proven-absent launcher arms the one-shot absent marker',
  JSON.stringify(restartEnvFor({ updatedFrom: '0.18.0', tuiChanged: true, launcher: { kind: 'none', reason: 'absent' } }))
    === JSON.stringify({ DSH_TUI_UPDATED_FROM: '0.18.0', DSH_TUI_LAUNCHER_ABSENT: '1' }),
)
check(
  'stamp: a copied launcher refreshes DSH_TUI_LAUNCHER_VERSION',
  JSON.stringify(restartEnvFor({
    updatedFrom: '0.18.0', tuiChanged: true,
    launcher: { kind: 'copied', reason: 'copy', version: '0.19.0' },
  })) === JSON.stringify({ DSH_TUI_UPDATED_FROM: '0.18.0', DSH_TUI_LAUNCHER_VERSION: '0.19.0' }),
)
{
  // Boot side: the engine stamp is consumed, deleted, and compared with the
  // freshly resolved host (a source-only assertion; the comparison needs a
  // restarted process to exercise).
  const pluginSource = readFileSync(new URL('../src/dsh-adapter/plugin.ts', import.meta.url), 'utf8')
  check(
    'boot: DSH_TUI_UPDATED_DSH_FROM is deleted and compared against installedKernelVersion',
    /updatedDshFrom = process\.env\.DSH_TUI_UPDATED_DSH_FROM[\s\S]{0,400}?delete process\.env\.DSH_TUI_UPDATED_DSH_FROM[\s\S]{0,1200}?installedKernelVersion\(\)/.test(pluginSource),
  )
}
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
const updateFnStart = compiledSource.indexOf('async function installProfileTui')
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
    symlinkSync(join(repoRoot, 'node_modules'), join(scratch3, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir')
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

// --- sharp 异平台 optional 过滤（维护群 2026-09-11 反馈：更新时下载全平台
// --- @img/sharp-*，~90MB 下载量换不来任何运行时价值）----------------------------
// 平台矩阵一律用显式输入断言：断言不得依赖跑测试的机器，否则 Windows/macOS
// 上会把本机平台当成异平台而假红（PR #861 首版即如此）。
{
  check('sharp 后缀: glibc linux x64', sharpCurrentSuffix('linux', 'x64', 'glibc') === 'linux-x64')
  check('sharp 后缀: musl linux arm64', sharpCurrentSuffix('linux', 'arm64', 'musl') === 'linuxmusl-arm64')
  check('sharp 后缀: win32 x64 直拼', sharpCurrentSuffix('win32', 'x64', 'glibc') === 'win32-x64')
  check('sharp 后缀: darwin arm64 直拼', sharpCurrentSuffix('darwin', 'arm64', 'glibc') === 'darwin-arm64')
  check('sharp 后缀: freebsd 只有 wasm 形态', sharpCurrentSuffix('freebsd', 'x64', 'glibc') === 'freebsd-wasm32')
  const onLinuxX64 = ignoredSharpOptionalPatterns('linux', 'x64', 'glibc')
  check('忽略清单: 排除本平台 wrapper 与 libvips', !onLinuxX64.includes('@img/sharp-linux-x64') && !onLinuxX64.includes('@img/sharp-libvips-linux-x64'))
  check('忽略清单: 含异平台代表项', onLinuxX64.includes('@img/sharp-win32-x64') && onLinuxX64.includes('@img/sharp-darwin-arm64') && onLinuxX64.includes('@img/sharp-libvips-linuxmusl-x64'))
  check('忽略清单: 与 registry 矩阵对齐（不列不存在的包）', !onLinuxX64.includes('@img/sharp-libvips-win32-x64') && !onLinuxX64.includes('@img/sharp-linuxmusl-arm') && !onLinuxX64.includes('@img/sharp-linux-ia32'))
  check('忽略清单: freebsd 的 wasm 形态在别的平台算异平台', onLinuxX64.includes('@img/sharp-freebsd-wasm32'))
  check('忽略清单: freebsd 保留自身唯一可加载的 wasm 形态', !ignoredSharpOptionalPatterns('freebsd', 'x64', 'glibc').includes('@img/sharp-freebsd-wasm32'))
  const onMusl = ignoredSharpOptionalPatterns('linux', 'x64', 'musl')
  check('忽略清单: musl 环境排除 linuxmusl-x64 而保留 linux-x64', !onMusl.includes('@img/sharp-linuxmusl-x64') && onMusl.includes('@img/sharp-linux-x64'))
  check('忽略清单: 不含非平台的纯 JS 包', !onMusl.some(p => p.includes('colour')))
  check('libc 判定: report 的 glibc 标记优先于 musl loader 存在', detectLibc('linux', { header: { glibcVersionRuntime: '2.36' } }, true) === 'glibc')
  check('libc 判定: 无 report 时 loader 探测兜底', detectLibc('linux', undefined, true) === 'musl' && detectLibc('linux', undefined, false) === 'glibc')
  check('libc 判定: 非 Linux 平台恒为 glibc', detectLibc('win32', undefined, true) === 'glibc' && detectLibc('darwin', undefined, true) === 'glibc')

  // 本机平台（与被测实现同源输入：report 优先，loader 路径兜底）。
  const hostLoaderPresent = existsSync('/lib/ld-musl-x86_64.so.1') || existsSync('/lib/ld-musl-aarch64.so.1') || existsSync('/etc/alpine-release')
  const hostLibc = detectLibc(process.platform, process.report?.getReport(), hostLoaderPresent)
  const hostSuffix = sharpCurrentSuffix(process.platform, process.arch, hostLibc)
  const hostIgnore = ignoredSharpOptionalPatterns(process.platform, process.arch, hostLibc)

  // 手写字面表（刻意不调用被测 helper）：本机平台自己的包，以及必须被忽略的
  // 异平台代表性包。与 helper 推导的期望互为独立 oracle——helper 少算/漏算时
  // 这组会红，反过来 helper 多算（忽略本机包）时 OWN_NAMES 会红。
  const OWN_NAMES = {
    'win32-x64': ['@img/sharp-win32-x64'],
    'darwin-arm64': ['@img/sharp-darwin-arm64', '@img/sharp-libvips-darwin-arm64'],
    'darwin-x64': ['@img/sharp-darwin-x64', '@img/sharp-libvips-darwin-x64'],
    'linux-x64': ['@img/sharp-linux-x64', '@img/sharp-libvips-linux-x64'],
    'linux-arm64': ['@img/sharp-linux-arm64', '@img/sharp-libvips-linux-arm64'],
    'linuxmusl-x64': ['@img/sharp-linuxmusl-x64', '@img/sharp-libvips-linuxmusl-x64'],
    'linuxmusl-arm64': ['@img/sharp-linuxmusl-arm64', '@img/sharp-libvips-linuxmusl-arm64'],
    'freebsd-wasm32': ['@img/sharp-freebsd-wasm32'],
  }
  const IGNORED_PROBES = {
    'win32-x64': ['@img/sharp-darwin-arm64', '@img/sharp-linux-x64', '@img/sharp-linuxmusl-x64', '@img/sharp-libvips-linux-x64', '@img/sharp-libvips-linuxmusl-x64'],
    'darwin-arm64': ['@img/sharp-darwin-x64', '@img/sharp-win32-x64', '@img/sharp-linux-x64', '@img/sharp-libvips-darwin-x64'],
    'linux-x64': ['@img/sharp-win32-x64', '@img/sharp-darwin-arm64', '@img/sharp-linux-arm64', '@img/sharp-libvips-linuxmusl-x64'],
    'linuxmusl-x64': ['@img/sharp-linux-x64', '@img/sharp-win32-x64', '@img/sharp-libvips-linux-x64'],
    'freebsd-wasm32': ['@img/sharp-linux-x64', '@img/sharp-win32-x64', '@img/sharp-libvips-linux-x64'],
  }
  const ownNames = OWN_NAMES[hostSuffix] ?? [`@img/sharp-${hostSuffix}`]
  const literalProbes = IGNORED_PROBES[hostSuffix] ?? ['@img/sharp-linux-x64', '@img/sharp-win32-x64', '@img/sharp-darwin-arm64'].filter(p => p !== `@img/sharp-${hostSuffix}`)

  const sharpScratch = mkdtempSync(join(tmpdir(), 'verify-sharp-filter-'))
  const prevDshHome = process.env.DSH_HOME
  try {
    process.env.DSH_HOME = join(sharpScratch, 'dsh-home')
    const profDir = join(process.env.DSH_HOME, 'profiles', 'dsh-tui')
    mkdirSync(profDir, { recursive: true })
    const wsPath = join(profDir, 'pnpm-workspace.yaml')
    writeFileSync(wsPath, 'packages:\n  - .\nnodeLinker: hoisted\n')
    const first = ensureProfilePlatformFilter('dsh-tui')
    const yamlText = readFileSync(profileWorkspaceYamlPath('dsh-tui'), 'utf8')
    check('workspace 预种: 块落盘且带模式行', first !== undefined && first.changed && yamlText.includes('ignoredOptionalDependencies:') && yamlText.includes(`- '${hostIgnore[0]}'`), `host=${process.platform}-${process.arch} first=${JSON.stringify(first)}`)
    check('workspace 预种: 既有内容保留', yamlText.includes('nodeLinker: hoisted'))
    check('workspace 预种: 不忽略本机平台（手写期望）', !ownNames.some(n => yamlText.includes(n)), `yaml 含本机包 ownNames=${ownNames.join(',')}`)
    check('workspace 预种: 忽略本机外的代表性包（手写期望）', literalProbes.every(p => yamlText.includes(`- '${p}'`)), `host=${hostSuffix} probes=${literalProbes.join(',')}`)
    const second = ensureProfilePlatformFilter('dsh-tui')
    const afterText = readFileSync(profileWorkspaceYamlPath('dsh-tui'), 'utf8')
    check('workspace 预种: 幂等（不重复块、不再写盘）', afterText.match(/ignoredOptionalDependencies:/gu)?.length === 1 && second !== undefined && second.changed === false && afterText === yamlText)

    // 名单跟着运行平台走：已有块里若有「本机平台的包」或别的平台算出的残留，
    // 重算必须把它换掉；块内非表内条目是用户显式决策，原样保留。
    const hostOwnLine = `- '${ownNames[0]}'`
    writeFileSync(wsPath, `ignoredOptionalDependencies:\n  - fsevents\n  ${hostOwnLine}\n  - '@img/sharp-linux-riscv64'\n`)
    const third = ensureProfilePlatformFilter('dsh-tui')
    const refreshed = readFileSync(profileWorkspaceYamlPath('dsh-tui'), 'utf8')
    check('workspace 预种: 旧名单被重算（本机平台的包被移出）', third !== undefined && third.changed && !refreshed.includes(ownNames[0]))
    check('workspace 预种: 用户自定义条目保留', refreshed.includes('- fsevents'))
    check('workspace 预种: 重算后覆盖当前平台矩阵', hostIgnore.every(p => refreshed.includes(`- '${p}'`)))
    check('workspace 预种: 重算后仍只有一个块', refreshed.match(/ignoredOptionalDependencies:/gu)?.length === 1)
    const fourth = ensureProfilePlatformFilter('dsh-tui')
    check('workspace 预种: 重算后再次运行不再写盘', fourth !== undefined && fourth.changed === false)

    // 归类必须按「包名」而不是原始字节：空行、条目尾注释、双引号都是合法 YAML，
    // 若把它们当成用户条目保留，本机平台自己的包就会留在忽略名单里——pnpm 跳过
    // 它、sharp 直接加载失败，正是本改动要消灭的跨平台故障。
    const malformed = [
      ['块内空行', `ignoredOptionalDependencies:\n  - fsevents\n\n  ${hostOwnLine}\n`],
      ['条目尾注释', `ignoredOptionalDependencies:\n  - fsevents\n  ${hostOwnLine} # keep\n`],
      ['双引号写法', `ignoredOptionalDependencies:\n  - fsevents\n  - "@img/sharp-${hostSuffix}"\n`],
    ]
    for (const [label, seeded] of malformed) {
      writeFileSync(wsPath, seeded)
      const outcome = ensureProfilePlatformFilter('dsh-tui')
      const got = readFileSync(wsPath, 'utf8')
      check(`workspace 预种: ${label}时本机包仍被重算掉`, outcome !== undefined && !got.includes(ownNames[0]) && got.includes('- fsevents'), `got=${got.replace(/\n/gu, '|')}`)
    }
    // 用户自写的、不在本模块两张表内的 @img 条目（如自带豁免 wasm 回退包）是用户
    // 决策，不能被重算抹掉。
    writeFileSync(wsPath, `ignoredOptionalDependencies:\n  - fsevents\n  - '@img/sharp-wasm32'\n`)
    const keepOutcome = ensureProfilePlatformFilter('dsh-tui')
    check('workspace 预种: 用户自写的表外 @img 条目保留', keepOutcome !== undefined && readFileSync(wsPath, 'utf8').includes(`- '@img/sharp-wasm32'`))

    // 重复键的文档本来就不是合法 YAML：不能往里写（否则 pnpm 连 workspace 都读不了）。
    const duplicated = `ignoredOptionalDependencies:\n  - fsevents\nignoredOptionalDependencies:\n  - '@img/sharp-wasm32'\n`
    writeFileSync(wsPath, duplicated)
    check('workspace 预种: 重复键原样放过', ensureProfilePlatformFilter('dsh-tui') === undefined && readFileSync(wsPath, 'utf8') === duplicated)
    // 流式写法（键行自带值）同理。
    writeFileSync(wsPath, 'ignoredOptionalDependencies: [fsevents]\n')
    check('workspace 预种: 流式写法不动用户文件', ensureProfilePlatformFilter('dsh-tui') === undefined && readFileSync(wsPath, 'utf8') === 'ignoredOptionalDependencies: [fsevents]\n')

    // 文件不存在时要新建，且不能以空行开头。
    const emptyProf = join(process.env.DSH_HOME, 'profiles', 'dsh-tui-empty')
    mkdirSync(emptyProf, { recursive: true })
    const created = ensureProfilePlatformFilter('dsh-tui-empty')
    const createdText = readFileSync(join(emptyProf, 'pnpm-workspace.yaml'), 'utf8')
    check('workspace 预种: 新建文件不以空行开头', created !== undefined && createdText.startsWith('ignoredOptionalDependencies:'))
    check('workspace 预种: profile 目录缺失返回 undefined', ensureProfilePlatformFilter('absent') === undefined)

    // --- Claude SDK 原生包（维护者实测：0.15 → 0.16 更新多下 7 个异平台包，
    // --- 每个解包约 230MB）。SDK 是按需安装的内核，但在 profile 里一天，更新
    // --- 就会按同一 pnpm 路径把全平台 optional 物化一遍。
    // 手写字面表：SDK 每个平台一个原生包，与 helper 推导互为 oracle。
    const SDK_OWN = {
      'darwin-arm64': '@anthropic-ai/claude-agent-sdk-darwin-arm64',
      'darwin-x64': '@anthropic-ai/claude-agent-sdk-darwin-x64',
      'linux-arm64': '@anthropic-ai/claude-agent-sdk-linux-arm64',
      'linux-arm64-musl': '@anthropic-ai/claude-agent-sdk-linux-arm64-musl',
      'linux-x64': '@anthropic-ai/claude-agent-sdk-linux-x64',
      'linux-x64-musl': '@anthropic-ai/claude-agent-sdk-linux-x64-musl',
      'win32-arm64': '@anthropic-ai/claude-agent-sdk-win32-arm64',
      'win32-x64': '@anthropic-ai/claude-agent-sdk-win32-x64',
    }
    check('SDK 后缀: glibc linux x64', claudeSdkCurrentSuffix('linux', 'x64', 'glibc') === 'linux-x64')
    check('SDK 后缀: musl linux x64 带 -musl', claudeSdkCurrentSuffix('linux', 'x64', 'musl') === 'linux-x64-musl')
    check('SDK 后缀: darwin arm64 直拼', claudeSdkCurrentSuffix('darwin', 'arm64', 'glibc') === 'darwin-arm64')
    check('SDK 后缀: win32 x64 直拼', claudeSdkCurrentSuffix('win32', 'x64', 'glibc') === 'win32-x64')
    const sdkLinuxX64 = ignoredClaudeSdkOptionalPatterns('linux', 'x64', 'glibc')
    check(
      'SDK 过滤: 本平台包保留、异平台包全忽略',
      !sdkLinuxX64.includes(SDK_OWN['linux-x64'])
        && sdkLinuxX64.includes(SDK_OWN['linux-x64-musl'])
        && sdkLinuxX64.includes(SDK_OWN['win32-x64'])
        && sdkLinuxX64.includes(SDK_OWN['darwin-arm64'])
        && sdkLinuxX64.length === 7,
      `entries=${sdkLinuxX64.length}`,
    )
    const sdkMusl = ignoredClaudeSdkOptionalPatterns('linux', 'x64', 'musl')
    check('SDK 过滤: musl 环境保留 musl 包、忽略 glibc 包', !sdkMusl.includes(SDK_OWN['linux-x64-musl']) && sdkMusl.includes(SDK_OWN['linux-x64']))
    // 矩阵外平台（freebsd / riscv64）：本机没有对应包，忽略全部已知包；
    // 将来 SDK 新增的平台包不在表内，因此永远不会被误忽略。
    check('SDK 过滤: 矩阵外平台忽略全部已知包', ignoredClaudeSdkOptionalPatterns('freebsd', 'x64', 'glibc').length === 8 && ignoredClaudeSdkOptionalPatterns('linux', 'riscv64', 'glibc').length === 8)
    check('SDK 过滤: 只列平台包、不碰主包', sdkLinuxX64.every(p => p.startsWith('@anthropic-ai/claude-agent-sdk-')) && !sdkLinuxX64.includes('@anthropic-ai/claude-agent-sdk'))
    check(
      '合并名单: sharp 与 SDK 同时覆盖',
      ignoredForeignPlatformPatterns('linux', 'x64', 'glibc').includes('@img/sharp-win32-x64')
        && ignoredForeignPlatformPatterns('linux', 'x64', 'glibc').includes(SDK_OWN['darwin-x64'])
        && !ignoredForeignPlatformPatterns('linux', 'x64', 'glibc').includes(SDK_OWN['linux-x64']),
    )

    // 文件级：两份名单同块落盘、幂等、换平台重算、用户条目保留，且 install
    // 路径（ensurePlatformFilterAt）与 update 路径写的是同一份名单。
    const hostSdkSuffix = claudeSdkCurrentSuffix(process.platform, process.arch, hostLibc)
    const hostSdkOwn = SDK_OWN[hostSdkSuffix]
    const hostSdkIgnore = ignoredClaudeSdkOptionalPatterns(process.platform, process.arch, hostLibc)
    writeFileSync(wsPath, 'packages:\n  - .\n')
    const sdkFirst = ensureProfilePlatformFilter('dsh-tui')
    const sdkYaml = readFileSync(wsPath, 'utf8')
    check('workspace 预种: SDK 名单落盘', sdkFirst !== undefined && sdkFirst.changed && hostSdkIgnore.every(p => sdkYaml.includes(`- '${p}'`)), `host=${hostSdkSuffix}`)
    check('workspace 预种: 本机 SDK 包不进忽略名单', hostSdkOwn === undefined || !sdkYaml.includes(`- '${hostSdkOwn}'`))
    const sdkSecond = ensureProfilePlatformFilter('dsh-tui')
    check('workspace 预种: SDK 名单幂等', sdkSecond !== undefined && sdkSecond.changed === false && readFileSync(wsPath, 'utf8') === sdkYaml)
    // 别的平台算出的残留（把本机包列进去）必须被重算掉。
    writeFileSync(wsPath, `ignoredOptionalDependencies:\n  - fsevents\n  - '${hostSdkOwn ?? SDK_OWN['linux-x64']}'\n  - '${SDK_OWN['darwin-x64']}'\n`)
    const sdkThird = ensureProfilePlatformFilter('dsh-tui')
    const sdkRefreshed = readFileSync(wsPath, 'utf8')
    check('workspace 预种: 旧 SDK 名单被重算', sdkThird !== undefined && sdkThird.changed && (hostSdkOwn === undefined || !sdkRefreshed.includes(`- '${hostSdkOwn}'`)))
    check('workspace 预种: SDK 重算保留列表外用户条目', sdkRefreshed.includes('- fsevents'))
    writeFileSync(wsPath, 'packages:\n  - .\n')
    const installPathOutcome = ensurePlatformFilterAt(wsPath)
    check('install 路径: 同一重写器写同一份名单', installPathOutcome !== undefined && readFileSync(wsPath, 'utf8') === sdkYaml)
  } finally {
    if (prevDshHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prevDshHome
    rmSync(sharpScratch, { recursive: true, force: true })
  }
}

// ── #1844: engine-range parsing, target selection and layout detection ─────
// No network: the pure rules of src/updateHost.ts plus real temp layouts.
{
  const RANGE = '0.2.0-rc.2 || 0.2.1-rc.2 || 0.2.1-rc.3 || 0.2.1-rc.4 || 0.2.1-rc.5'
  check(
    'engine range parses into its enumerated versions',
    JSON.stringify(parseHostLineRange(RANGE)) === JSON.stringify(['0.2.0-rc.2', '0.2.1-rc.2', '0.2.1-rc.3', '0.2.1-rc.4', '0.2.1-rc.5']),
  )
  check('engine range: duplicates collapse', parseHostLineRange('0.2.1-rc.5 || 0.2.1-rc.5').length === 1)
  check('engine range: an operator range is refused, never guessed', parseHostLineRange('^0.2.1-rc.5').length === 0)
  check('engine range: empty/absent ranges are empty', parseHostLineRange(undefined).length === 0 && parseHostLineRange('  ').length === 0)

  const allowed = parseHostLineRange(RANGE)
  const available = ['0.2.1-rc.3', '0.2.1-rc.4', '0.2.1-rc.5', '0.2.2-alpha.2']
  check(
    'engine target: current == newest → none/newest',
    selectHostTarget({ current: '0.2.1-rc.5', allowed, available }).reason === 'newest',
  )
  const older = selectHostTarget({ current: '0.2.1-rc.4', allowed, available })
  check(
    'engine target: in-range older → install the newest published in range',
    older.kind === 'install' && older.to === '0.2.1-rc.5',
  )
  check(
    'engine target: the unvalidated alpha line is never selected',
    older.kind === 'install' && older.to !== '0.2.2-alpha.2',
  )
  check(
    'engine target: current ahead of the served newest → newer-than-validated (no downgrade)',
    selectHostTarget({ current: '0.2.1-rc.5', allowed, available: ['0.2.1-rc.4'] }).reason === 'newer-than-validated',
  )
  check(
    'engine target: an alpha ahead of the line is kept (no downgrade)',
    selectHostTarget({ current: '0.2.2-alpha.2', allowed, available }).reason === 'newer-than-validated',
  )
  check(
    'engine target: below the supported window → install into it',
    selectHostTarget({ current: '0.1.7-rc.2', allowed, available }).to === '0.2.1-rc.5',
  )
  check(
    'engine target: empty candidate set → unavailable/no-version',
    selectHostTarget({ current: '0.2.1-rc.4', allowed, available: ['0.2.2-alpha.2'] }).reason === 'no-version',
  )
  check(
    'engine target: unreadable current → unknown-current (never touched)',
    selectHostTarget({ current: undefined, allowed, available }).reason === 'unknown-current',
  )

  // Layout fixtures: detection only classifies, it never invents a prefix.
  const hostRoot = mkdtempSync(join(tmpdir(), 'update-host-layout-'))
  const makeHost = (dir, version = '0.2.1-rc.4') => {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version }))
    return dir
  }
  try {
    const posixPrefix = join(hostRoot, 'npm-prefix')
    const posixPkg = makeHost(join(posixPrefix, 'lib', 'node_modules', '@deepseek-ai', 'dsh'))
    const posix = detectHostInstall(posixPkg, {}, 'linux')
    check(
      'layout: POSIX npm global → npm + prefix + writable',
      posix.installer === 'npm' && posix.prefix === posixPrefix && posix.version === '0.2.1-rc.4' && posix.writable,
      JSON.stringify(posix),
    )
    const windowsPrefix = join(hostRoot, 'npm')
    const windowsPkg = makeHost(join(windowsPrefix, 'node_modules', '@deepseek-ai', 'dsh'))
    const windows = detectHostInstall(windowsPkg, {}, 'win32')
    check('layout: Windows npm global → npm + prefix', windows.installer === 'npm' && windows.prefix === windowsPrefix)
    check('layout: Windows project node_modules → unknown', detectHostInstall(makeHost(join(hostRoot, 'win-project', 'node_modules', '@deepseek-ai', 'dsh')), {}, 'win32').installer === 'unknown')

    const pnpmHome = join(hostRoot, 'pnpm')
    const pnpmPkg = makeHost(join(pnpmHome, 'global', '5', 'node_modules', '@deepseek-ai', 'dsh'))
    writeFileSync(join(pnpmHome, 'global', '5', 'package.json'), JSON.stringify({ dependencies: { '@deepseek-ai/dsh': '0.2.1-rc.4' } }))
    const pnpm = detectHostInstall(pnpmPkg, {}, 'linux')
    check(
      'layout: pnpm global project → pnpm + owning group',
      pnpm.installer === 'pnpm' && pnpm.pnpmHome === pnpmHome && pnpm.groupRoot === join(pnpmHome, 'global', '5'),
      JSON.stringify(pnpm),
    )
    const forced = detectHostInstall(posixPkg, { [DSH_PM_ENV]: 'pnpm' }, 'linux')
    check(
      'layout: DSH_TUI_DSH_PM forces the manager but never invents a group',
      forced.installer === 'pnpm' && forced.groupRoot === undefined && forced.writable === false,
      JSON.stringify(forced),
    )

    // pnpm 12's shared virtual store: the package realpath no longer names its
    // group, so ownership must come from the dsh shim on PATH — never from an
    // inherited PNPM_HOME that may belong to a different install.
    const storePkg = makeHost(join(hostRoot, 'store', 'v10', 'links', '@deepseek-ai', 'dsh', '0.2.1-rc.4', 'hash', 'node_modules', '@deepseek-ai', 'dsh'))
    const ownerHome = join(hostRoot, 'pnpm-owner-a')
    const ownerGroup = join(ownerHome, 'global', 'v11', 'hash-a')
    mkdirSync(join(ownerGroup, 'node_modules', '@deepseek-ai'), { recursive: true })
    symlinkSync(storePkg, join(ownerGroup, 'node_modules', '@deepseek-ai', 'dsh'), 'dir')
    writeFileSync(join(ownerGroup, 'package.json'), JSON.stringify({ dependencies: { '@deepseek-ai/dsh': '0.2.1-rc.4' } }))
    mkdirSync(join(ownerHome, 'bin'), { recursive: true })
    writeFileSync(join(ownerHome, 'bin', 'dsh'), '#!/bin/sh\nexit 0\n')
    const otherHome = join(hostRoot, 'pnpm-owner-b')
    const otherGroup = join(otherHome, 'global', 'v11', 'hash-b')
    makeHost(join(otherGroup, 'node_modules', '@deepseek-ai', 'dsh'))
    writeFileSync(join(otherGroup, 'package.json'), JSON.stringify({ dependencies: { '@deepseek-ai/dsh': '0.2.1-rc.4' } }))
    const ownedStore = detectHostInstall(
      storePkg,
      { PATH: `${join(ownerHome, 'bin')}:${dirname(process.execPath)}`, PNPM_HOME: otherHome },
      'linux',
    )
    check(
      'layout: shared-store owner comes from the dsh shim, not PNPM_HOME',
      ownedStore.installer === 'pnpm' && ownedStore.pnpmHome === ownerHome && ownedStore.groupRoot === ownerGroup,
      JSON.stringify(ownedStore),
    )
    const unownedStore = detectHostInstall(storePkg, { PATH: dirname(process.execPath) }, 'linux')
    check(
      'layout: an unproven store link never adopts PNPM_HOME',
      unownedStore.groupRoot === undefined && unownedStore.writable === false,
      JSON.stringify(unownedStore),
    )

    // pnpm >= 11.21 leaves BOTH the real install dir and a hash symlink to it
    // inside global/<slot>. One group, not two owners: canonical (realpath)
    // dedupe must accept the pair. Two genuinely different groups that both
    // claim the package must still be refused.
    const aliasHome = join(hostRoot, 'pnpm-alias')
    const aliasSlot = join(aliasHome, 'global', 'v11')
    const aliasEntity = join(aliasSlot, 'install-entity')
    mkdirSync(join(aliasEntity, 'node_modules', '@deepseek-ai'), { recursive: true })
    symlinkSync(storePkg, join(aliasEntity, 'node_modules', '@deepseek-ai', 'dsh'), 'dir')
    writeFileSync(join(aliasEntity, 'package.json'), JSON.stringify({ dependencies: { '@deepseek-ai/dsh': '0.2.1-rc.4' } }))
    symlinkSync(aliasEntity, join(aliasSlot, 'hash-alias'), 'dir')
    mkdirSync(join(aliasHome, 'bin'), { recursive: true })
    writeFileSync(join(aliasHome, 'bin', 'dsh'), '#!/bin/sh\nexit 0\n')
    const aliasInstall = detectHostInstall(
      storePkg,
      { PATH: `${join(aliasHome, 'bin')}:${dirname(process.execPath)}` },
      'linux',
    )
    check(
      'layout: a pnpm entity plus its hash alias is one owner, not two',
      aliasInstall.installer === 'pnpm' && aliasInstall.pnpmHome === aliasHome
        && aliasInstall.groupRoot === aliasEntity && aliasInstall.writable,
      JSON.stringify(aliasInstall),
    )
    const aliasSecond = join(aliasSlot, 'install-second')
    mkdirSync(join(aliasSecond, 'node_modules', '@deepseek-ai'), { recursive: true })
    symlinkSync(storePkg, join(aliasSecond, 'node_modules', '@deepseek-ai', 'dsh'), 'dir')
    writeFileSync(join(aliasSecond, 'package.json'), JSON.stringify({ dependencies: { '@deepseek-ai/dsh': '0.2.1-rc.4' } }))
    const ambiguousInstall = detectHostInstall(
      storePkg,
      { PATH: `${join(aliasHome, 'bin')}:${dirname(process.execPath)}` },
      'linux',
    )
    check(
      'layout: two genuinely different pnpm groups stay ambiguous',
      ambiguousInstall.groupRoot === undefined && ambiguousInstall.writable === false,
      JSON.stringify(ambiguousInstall),
    )

    const projectPkg = makeHost(join(hostRoot, 'project', 'node_modules', '@deepseek-ai', 'dsh'))
    check('layout: project-local node_modules → unknown, never guessed', detectHostInstall(projectPkg, {}, 'linux').installer === 'unknown')

    const voltaPkg = makeHost(join(hostRoot, '.volta', 'tools', 'image', 'packages', '@deepseek-ai', 'dsh', 'lib', 'node_modules', '@deepseek-ai', 'dsh'))
    const volta = detectHostInstall(voltaPkg, {}, 'linux')
    check('layout: volta image → volta (manual install)', volta.installer === 'volta' && volta.writable === false)

    // VOLTA_HOME moves the image; missing it would let the npm-prefix branch
    // rewrite volta's own tree.
    const customVoltaHome = join(hostRoot, 'custom-volta')
    const customVoltaPkg = makeHost(join(customVoltaHome, 'tools', 'image', 'packages', '@deepseek-ai', 'dsh', 'lib', 'node_modules', '@deepseek-ai', 'dsh'))
    const customVolta = detectHostInstall(customVoltaPkg, { VOLTA_HOME: customVoltaHome }, 'linux')
    check(
      'layout: a custom VOLTA_HOME image is still volta, never npm',
      customVolta.installer === 'volta' && customVolta.writable === false,
      JSON.stringify(customVolta),
    )
    const customVoltaStep = planHostStep({
      current: '0.2.1-rc.4', range: RANGE,
      available: ['0.2.1-rc.4', '0.2.1-rc.5'],
      install: customVolta, packageName: '@deepseek-ai/dsh',
    })
    check(
      'host step: a custom-volta image only gets the volta command',
      customVoltaStep.kind === 'unavailable' && customVoltaStep.reason === 'no-installer'
        && (customVoltaStep.manual[0] ?? '') === 'volta install @deepseek-ai/dsh@0.2.1-rc.5',
      JSON.stringify(customVoltaStep),
    )

    if (typeof process.getuid === 'function' && process.getuid() !== 0) {
      const readonlyPrefix = join(hostRoot, 'readonly-prefix')
      const readonlyPkg = makeHost(join(readonlyPrefix, 'lib', 'node_modules', '@deepseek-ai', 'dsh'))
      chmodSync(readonlyPrefix, 0o555)
      const readonly = detectHostInstall(readonlyPkg, {}, 'linux')
      chmodSync(readonlyPrefix, 0o755)
      check('layout: unwritable npm prefix is reported, not attempted', readonly.installer === 'npm' && readonly.writable === false)
    }

    const npmPkg = detectHostInstall(posixPkg, {}, 'linux')
    const installStep = planHostStep({
      current: '0.2.1-rc.4', range: RANGE,
      available: ['0.2.1-rc.4', '0.2.1-rc.5', '0.2.2-alpha.2'],
      install: npmPkg, packageName: '@deepseek-ai/dsh',
    })
    check(
      'host step: plan installs the in-range newest with the detected manager',
      installStep.kind === 'install' && installStep.to === '0.2.1-rc.5'
        && installStep.command.file === 'npm'
        && installStep.command.args.includes('--prefix')
        && installStep.command.args.at(-1) === '@deepseek-ai/dsh@0.2.1-rc.5',
      JSON.stringify(installStep),
    )
    const newerPublishedStep = planHostStep({
      current: '0.2.1-rc.5', range: RANGE,
      available: [...allowed, '0.2.2-rc.1'],
      install: npmPkg, packageName: '@deepseek-ai/dsh',
    })
    check(
      'host step: a newer release outside the line is remembered for the idle notice',
      newerPublishedStep.kind === 'none' && newerPublishedStep.reason === 'newest'
        && newerPublishedStep.newerPublished === '0.2.2-rc.1',
      JSON.stringify(newerPublishedStep),
    )
    const newerAlphaStep = planHostStep({
      current: '0.2.1-rc.5', range: RANGE,
      available: [...allowed, '0.2.2-alpha.3'],
      install: npmPkg, packageName: '@deepseek-ai/dsh',
    })
    check(
      'host step: an unvalidated alpha is not surfaced as a waiting release',
      newerAlphaStep.kind === 'none' && newerAlphaStep.newerPublished === undefined,
      JSON.stringify(newerAlphaStep),
    )
    const newerMixedStep = planHostStep({
      current: '0.2.1-rc.5', range: RANGE,
      available: [...allowed, '0.3.0-alpha.1', '0.2.2-rc.1'],
      install: npmPkg, packageName: '@deepseek-ai/dsh',
    })
    check(
      'host step: a newer alpha does not hide the rc release worth waiting for',
      newerMixedStep.kind === 'none' && newerMixedStep.newerPublished === '0.2.2-rc.1',
      JSON.stringify(newerMixedStep),
    )
    const unproven = planHostStep({
      current: '0.2.1-rc.4', range: RANGE, available: ['0.2.1-rc.4', '0.2.1-rc.5'],
      install: unownedStore, packageName: '@deepseek-ai/dsh',
    })
    check(
      'host step: an unproven pnpm group is refused, never auto-installed',
      unproven.kind === 'unavailable' && unproven.reason === 'group-unproven'
        && (unproven.manual[0] ?? '').startsWith('pnpm list -g'),
      JSON.stringify(unproven),
    )
    const multiPkg = makeHost(join(pnpmHome, 'global', '6', 'node_modules', '@deepseek-ai', 'dsh'))
    writeFileSync(
      join(pnpmHome, 'global', '6', 'package.json'),
      JSON.stringify({ dependencies: { '@deepseek-ai/dsh': '0.2.1-rc.4', '@scope/other-cli': '1.0.0' } }),
    )
    const multiInstall = detectHostInstall(multiPkg, {}, 'linux')
    const multiStep = planHostStep({
      current: '0.2.1-rc.4', range: RANGE, available: ['0.2.1-rc.4', '0.2.1-rc.5'],
      install: multiInstall, packageName: '@deepseek-ai/dsh',
    })
    check(
      'host step: a multi-member pnpm group is refused before installing',
      multiInstall.groupRoot === join(pnpmHome, 'global', '6')
        && multiStep.kind === 'unavailable' && multiStep.reason === 'group-unproven'
        && (multiStep.manual[0] ?? '').startsWith('pnpm list -g'),
      JSON.stringify(multiStep),
    )

    check(
      'host step: DSH_TUI_UPDATE_ENGINE=0 keeps the target for the refusal path',
      (() => {
        const step = planHostStep({
          current: '0.2.1-rc.4', range: RANGE,
          available: ['0.2.1-rc.4', '0.2.1-rc.5'], install: npmPkg,
          packageName: '@deepseek-ai/dsh', disabled: true,
        })
        return step.kind === 'none' && step.reason === 'disabled' && step.to === '0.2.1-rc.5'
          && (step.manual ?? []).length > 0
      })(),
    )
    check(
      'host step: offline degrades to unavailable/offline',
      planHostStep({ current: '0.2.1-rc.4', range: RANGE, available: undefined, install: npmPkg, packageName: '@deepseek-ai/dsh' }).reason === 'offline',
    )
    check(
      'host step: unknown installer degrades to unavailable/no-installer',
      planHostStep({
        current: '0.2.1-rc.4', range: RANGE, available: ['0.2.1-rc.5'],
        install: detectHostInstall(projectPkg, {}, 'linux'), packageName: '@deepseek-ai/dsh',
      }).reason === 'no-installer',
    )
    check(
      'host step: unreadable current version is never touched',
      planHostStep({ current: undefined, range: RANGE, available: ['0.2.1-rc.5'], install: npmPkg, packageName: '@deepseek-ai/dsh' }).reason === 'unknown-current',
    )
    check(
      'host manual commands carry the detected prefix (sudo only when needed)',
      hostManualCommands('@deepseek-ai/dsh', '0.2.1-rc.5', npmPkg, 'linux')[0] === 'npm install -g --prefix ' + posixPrefix + ' @deepseek-ai/dsh@0.2.1-rc.5',
      JSON.stringify(hostManualCommands('@deepseek-ai/dsh', '0.2.1-rc.5', npmPkg, 'linux')),
    )

    const metacharPosix = hostManualCommands(
      '@deepseek-ai/dsh', '0.2.1-rc.5',
      { installer: 'npm', prefix: '/home/A&B/npm $dir', writable: true }, 'linux',
    )[0]
    check(
      'host manual commands: POSIX prefixes with metacharacters become one quoted argument',
      metacharPosix.includes("'/home/A&B/npm $dir'"),
      metacharPosix,
    )
    const metacharWindows = hostManualCommands(
      '@deepseek-ai/dsh', '0.2.1-rc.5',
      { installer: 'npm', prefix: 'C:\\Users\\A&B\\AppData\\Roaming\\npm', writable: true }, 'win32',
    )[0]
    check(
      'host manual commands: Windows prefixes with cmd metacharacters stay quoted as one argument',
      metacharWindows.includes('"C:\\Users\\A&B\\AppData\\Roaming\\npm"'),
      metacharWindows,
    )

    // The manual pnpm command must target the SAME owner home the automated
    // one pins: an inherited PNPM_HOME may name a different global install, and
    // repairing that one leaves the real engine untouched (#1849 review R3).
    const pnpmManual = hostManualCommands('@deepseek-ai/dsh', '0.2.1-rc.5', pnpm, 'linux')[0]
    const pnpmStep = planHostStep({
      current: '0.2.1-rc.4', range: RANGE,
      available: ['0.2.1-rc.4', '0.2.1-rc.5'],
      install: pnpm, packageName: '@deepseek-ai/dsh',
    })
    check(
      'host manual commands: pnpm pins the proven owner home, matching the automated command',
      pnpmStep.kind === 'install' && pnpmStep.command.env?.PNPM_HOME === pnpmHome
        && pnpmManual.includes(`PNPM_HOME=${pnpmHome}`)
        && pnpmManual.includes('pnpm add -g @deepseek-ai/dsh@0.2.1-rc.5'),
      pnpmManual,
    )
    const spacedPnpmHome = join(hostRoot, 'pnpm A&B')
    const spacedPnpmPkg = makeHost(join(spacedPnpmHome, 'global', '5', 'node_modules', '@deepseek-ai', 'dsh'))
    writeFileSync(join(spacedPnpmHome, 'global', '5', 'package.json'), JSON.stringify({ dependencies: { '@deepseek-ai/dsh': '0.2.1-rc.4' } }))
    const spacedPnpmManual = hostManualCommands(
      '@deepseek-ai/dsh', '0.2.1-rc.5', detectHostInstall(spacedPnpmPkg, {}, 'linux'), 'linux',
    )[0]
    check(
      'host manual commands: a pnpm home with spaces and metacharacters stays one quoted value',
      spacedPnpmManual.includes(`PNPM_HOME='${spacedPnpmHome}'`) && spacedPnpmManual.includes('pnpm add -g'),
      spacedPnpmManual,
    )

    check(
      'compatibility: planned install is compatible',
      hostCompatibility({ current: '0.2.1-rc.4', allowed, step: installStep }) === true,
    )
    check(
      'compatibility: in-range current is compatible',
      hostCompatibility({ current: '0.2.1-rc.3', allowed, step: { kind: 'none', reason: 'newest' } }) === true,
    )
    check(
      'compatibility: a newer line is kept (true) instead of downgraded',
      hostCompatibility({ current: '0.2.2-alpha.2', allowed, step: { kind: 'none', reason: 'newer-than-validated' } }) === true,
    )
    check(
      'compatibility: an older out-of-range current is incompatible',
      hostCompatibility({ current: '0.1.7-rc.2', allowed, step: { kind: 'none', reason: 'disabled' } }) === false,
    )
    check(
      'compatibility: unknown current is undefined, never a claim',
      hostCompatibility({ current: undefined, allowed, step: { kind: 'none', reason: 'unknown-current' } }) === undefined,
    )
    check(
      'compatibility: strict line membership rejects an engine above the line',
      hostSatisfiesLine({ current: '0.2.2-alpha.2', allowed }) === false
        && hostSatisfiesLine({ current: '0.2.1-rc.5', allowed }) === true
        && hostSatisfiesLine({ current: '0.1.7-rc.2', allowed }) === false
        && hostSatisfiesLine({ current: undefined, allowed }) === undefined,
      JSON.stringify([
        hostSatisfiesLine({ current: '0.2.2-alpha.2', allowed }),
        hostSatisfiesLine({ current: '0.2.1-rc.5', allowed }),
      ]),
    )
    const layerPlan = (host, launcher = { kind: 'none', reason: 'absent' }) => ({
      tui: { kind: 'update', current: '0.18.0', latest: '0.19.0' },
      host, launcher, compatible: true, hostRange: RANGE, currentHost: '0.2.1-rc.3', blocked: false,
    })
    check(
      'plan layers: a real engine install is announced',
      updatePlanLayers(layerPlan({ kind: 'install', from: '0.2.1-rc.3', to: '0.2.1-rc.5', packageDir: '/x', command: { file: 'npm', args: [] }, manual: [] }))
        .some(layer => layer === 'dsh 0.2.1-rc.3 → 0.2.1-rc.5'),
    )
    check(
      'plan layers: never-downgrade engine is not announced as a change',
      updatePlanLayers(layerPlan({ kind: 'none', reason: 'newer-than-validated', to: '0.2.1-rc.5' }))
        .every(layer => !layer.startsWith('dsh ')),
    )
    const newerSettled = {
      tui: { kind: 'latest', current: '0.18.0' },
      host: { kind: 'none', reason: 'newer-than-validated', from: '0.2.2-alpha.2', to: '0.2.1-rc.5' },
      launcher: { kind: 'none', reason: 'absent' },
      compatible: true, hostRange: RANGE, currentHost: '0.2.2-alpha.2', blocked: false,
    }
    check(
      'plan state: an engine ahead of the validated line is idle drift, not already aligned',
      updatePlanState(newerSettled) === 'idle'
        && (describeHostStepReason(newerSettled.host).includes('newer than')
          || describeHostStepReason(newerSettled.host).includes('更新')),
      `${updatePlanState(newerSettled)} :: ${describeHostStepReason(newerSettled.host)}`,
    )
    const newerPublishedPlan = {
      tui: { kind: 'latest', current: '0.18.0' },
      host: { kind: 'none', reason: 'newest', from: '0.2.1-rc.5', newerPublished: '0.2.2-rc.1' },
      launcher: { kind: 'none', reason: 'absent' },
      compatible: true, hostRange: RANGE, currentHost: '0.2.1-rc.5', blocked: false,
    }
    check(
      'plan state: a newer release outside the validated line is idle, not already aligned',
      updatePlanState(newerPublishedPlan) === 'idle',
      updatePlanState(newerPublishedPlan),
    )
    const newerReport = idleReportMessages(newerPublishedPlan)
    check(
      'idle report: names the newer release and says it waits for a TUI release',
      newerReport !== undefined
        && newerReport.report.includes('0.2.2-rc.1')
        && (newerReport.report.includes('adds support') || newerReport.report.includes('适配'))
        && !newerReport.report.includes('npm install'),
      newerReport?.report ?? 'undefined',
    )
    check(
      'plan layers: a disabled engine step is not announced as a change',
      updatePlanLayers(layerPlan({ kind: 'none', reason: 'disabled', to: '0.2.1-rc.5', manual: [] }))
        .every(layer => !layer.startsWith('dsh ')),
    )
    const launcherPlan = (launcher) => layerPlan({ kind: 'none', reason: 'newest' }, launcher)
    check(
      'launcher step: a proven-absent launcher is never re-aligned after a moved TUI',
      shouldAlignLauncher(launcherPlan({ kind: 'none', reason: 'absent' }), true) === false,
    )
    check(
      'launcher step: a disabled step stays skipped after a moved TUI',
      shouldAlignLauncher(launcherPlan({ kind: 'none', reason: 'disabled' }), true) === false,
    )
    check(
      'launcher step: planned copy/install work always runs',
      shouldAlignLauncher(launcherPlan({ kind: 'copy', version: '0.19.0', from: '0.17.0', path: '/x' }), false) === true
        && shouldAlignLauncher(launcherPlan({ kind: 'install', version: '0.19.0', from: '0.17.0', command: { file: 'pnpm', args: [] } }), false) === true,
    )
    check(
      'launcher step: an unresolved/aligned launcher is re-resolved only when the TUI moved',
      shouldAlignLauncher(launcherPlan({ kind: 'none', reason: 'unresolved' }), true) === true
        && shouldAlignLauncher(launcherPlan({ kind: 'none', reason: 'aligned' }), false) === false,
    )

    const blockedPlan = {
      ...layerPlan({ kind: 'none', reason: 'disabled', from: '0.1.7-rc.2', to: '0.2.1-rc.5', manual: ['npm install -g @deepseek-ai/dsh@0.2.1-rc.5'] }),
      compatible: false, hostRange: RANGE, currentHost: '0.1.7-rc.2', blocked: true,
    }
    const blockedMessages = blockedUpdateMessages(blockedPlan)
    check(
      'blocked refusal: the report carries the exact manual command',
      blockedMessages.report.includes('npm install -g @deepseek-ai/dsh@0.2.1-rc.5') && blockedMessages.report.includes(RANGE),
    )
    check(
      'blocked refusal: the toast stays one short line (the composer truncates one row)',
      !blockedMessages.toast.includes('\n') && blockedMessages.toast.length < 200,
      blockedMessages.toast,
    )
    check(
      'blocked refusal: a disabled engine names the switch to drop',
      blockedMessages.report.includes('DSH_TUI_UPDATE_ENGINE=0'),
      blockedMessages.report,
    )
    // An engine that CAN be installed is not "cannot be upgraded": it must run
    // BEFORE the TUI, because the official manager validates the new TUI
    // against the running engine (#1849 review R2).
    const engineFirstBlocked = {
      ...blockedPlan,
      host: {
        kind: 'install', from: '0.2.1-rc.4', to: '0.2.1-rc.5', packageDir: '/x',
        command: { file: 'npm', args: [] }, manual: ['npm install -g @deepseek-ai/dsh@0.2.1-rc.5'],
      },
    }
    const engineFirstMessages = blockedUpdateMessages(engineFirstBlocked)
    check(
      'blocked refusal: an installable engine says to align it first, not that it cannot be upgraded',
      (engineFirstMessages.report.includes('Upgrade the engine first') || engineFirstMessages.report.includes('先升级引擎'))
        && !(engineFirstMessages.report.includes('cannot be upgraded automatically') || engineFirstMessages.report.includes('无法自动升级'))
        && engineFirstMessages.report.includes('npm install -g @deepseek-ai/dsh@0.2.1-rc.5'),
      engineFirstMessages.report,
    )
    // An engine ABOVE the target line is outside the manager's exact peer
    // check just like an older one: the refusal is a wait for a TUI release,
    // never an install/downgrade (#1849 review, R1 of the fix round).
    const tooNewBlocked = {
      ...layerPlan({ kind: 'none', reason: 'newer-than-validated', from: '0.2.2-rc.1', to: '0.2.1-rc.5' }),
      compatible: true, hostRange: RANGE, currentHost: '0.2.2-rc.1', blocked: true,
    }
    const tooNewMessages = blockedUpdateMessages(tooNewBlocked)
    check(
      'blocked refusal: an engine above the line asks for a TUI release, not an install',
      tooNewMessages.report.includes('0.2.2-rc.1') && tooNewMessages.report.includes(RANGE)
        && !tooNewMessages.report.includes('npm install') && !tooNewMessages.report.includes('pnpm add')
        && (tooNewMessages.report.includes('does not declare support') || tooNewMessages.report.includes('尚未声明支持'))
        && (tooNewMessages.title.includes('does not declare support') || tooNewMessages.title.includes('尚未声明支持')),
      tooNewMessages.report,
    )
    check(
      'blocked refusal: the above-line toast does not claim the TUI needs a newer dsh',
      !tooNewMessages.toast.includes('needs a newer dsh')
        && !tooNewMessages.toast.includes('需要更新的 dsh')
        && tooNewMessages.toast.length < 200,
      tooNewMessages.toast,
    )
    const engineSkip = engineSkipMessages(layerPlan({
      kind: 'unavailable', reason: 'group-unproven', from: '0.2.1-rc.4', to: '0.2.1-rc.5',
      manual: ['pnpm list -g --depth 0\n  Inspect the install group before aligning @deepseek-ai/dsh@0.2.1-rc.5'],
    }))
    check(
      'engine skip: a ready TUI update reports the unalignable layer and its command',
      engineSkip !== undefined
        && engineSkip.report.includes('pnpm list -g')
        && engineSkip.report.includes('0.2.1-rc.5')
        && !engineSkip.report.includes('已是最新')
        && !engineSkip.report.includes('already current')
        && engineSkip.title.includes('0.2.1-rc.5')
        && engineSkip.toast.length < 200,
      engineSkip?.report ?? 'undefined',
    )
    {
      const pluginSource = readFileSync(new URL('../src/dsh-adapter/plugin.ts', import.meta.url), 'utf8')
      check(
        'engine skip: the TUI ready path writes the report before starting the update',
        /engineSkipMessages\(plan\)[\s\S]{0,900}?channel\.pushLocal\([\s\S]{0,300}?updatePlan = plan/.test(pluginSource),
      )
    }
    const offlineBlocked = {
      ...blockedPlan,
      host: { kind: 'unavailable', reason: 'offline', from: '0.1.7-rc.2', manual: ['npm install -g @deepseek-ai/dsh@0.2.1-rc.5'] },
    }
    const offlineReport = blockedUpdateMessages(offlineBlocked).report
    check(
      'blocked refusal: an offline lookup tells the user to retry, not to repair versions',
      (offlineReport.includes('Retry /update') || offlineReport.includes('重新 /update'))
        && offlineReport.includes('npm install -g @deepseek-ai/dsh@0.2.1-rc.5'),
      offlineReport,
    )
    const unpublishedBlocked = {
      ...blockedPlan,
      host: { kind: 'unavailable', reason: 'no-version', from: '0.1.7-rc.2', to: '0.2.1-rc.5', manual: ['npm install -g @deepseek-ai/dsh@0.2.1-rc.5'] },
    }
    const unpublishedReport = blockedUpdateMessages(unpublishedBlocked).report
    check(
      'blocked refusal: an unpublished release asks the user to wait and prints no impossible command',
      !unpublishedReport.includes('npm install')
        && (unpublishedReport.includes('not published yet') || unpublishedReport.includes('尚未发布')),
      unpublishedReport,
    )
    const unprovenBlocked = {
      ...blockedPlan,
      host: { kind: 'unavailable', reason: 'group-unproven', from: '0.1.7-rc.2', to: '0.2.1-rc.5', manual: ['pnpm list -g --depth 0'] },
    }
    const unprovenReport = blockedUpdateMessages(unprovenBlocked).report
    check(
      'blocked refusal: an unprovable install points at repairing the install',
      unprovenReport.includes('pnpm list -g') && (unprovenReport.includes('Fix it') || unprovenReport.includes('修复')),
      unprovenReport,
    )
    check(
      'restart gate: a TUI that did not move never blocks on an old engine',
      engineFailureAllowsRestart({ tuiChanged: false, currentHost: '0.1.7-rc.2', hostRange: RANGE }) === true,
    )
    check(
      'restart gate: moved TUI + in-range engine may restart after a failed step',
      engineFailureAllowsRestart({ tuiChanged: true, currentHost: '0.2.1-rc.3', hostRange: RANGE }) === true,
    )
    check(
      'restart gate: moved TUI + below-range engine must not restart',
      engineFailureAllowsRestart({ tuiChanged: true, currentHost: '0.1.7-rc.2', hostRange: RANGE }) === false,
    )
    check(
      'restart gate: a newer engine line is kept, not refused',
      engineFailureAllowsRestart({ tuiChanged: true, currentHost: '0.2.2-alpha.2', hostRange: RANGE }) === true,
    )
    check(
      'restart gate: an unknown range cannot justify a refusal',
      engineFailureAllowsRestart({ tuiChanged: true, currentHost: '0.1.7-rc.2', hostRange: undefined }) === true,
    )
  } finally {
    rmSync(hostRoot, { recursive: true, force: true })
  }
}

if (failed > 0) {
  console.error(`\n${failed} check(s) failed`)
  process.exit(1)
}
console.log('\nall checks passed')
