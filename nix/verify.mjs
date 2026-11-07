import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, existsSync, readFileSync, writeFileSync, mkdirSync, readlinkSync, lstatSync, unlinkSync, symlinkSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const [packageRoot, runtimeRoot, shell, pnpmBin, ...flags] = process.argv.slice(2)
// The launcher exports this before the entry loads; mirror it here for the
// direct module imports below (commands, tips) that do not go through it.
process.env.DSH_TUI_UPDATE_DISABLED = '1'
const allowUserPlugins = flags.includes('--allow-user-plugins')
// The launcher exports this too; mirror the variant being checked for the
// direct policy/completion imports below.
process.env.DSH_TUI_ALLOW_USER_PLUGINS = allowUserPlugins ? '1' : '0'
const modules = join(runtimeRoot, 'lib/dsh-tui/node_modules')
const tui = join(modules, '@deepseek-harness-tui/dsh-tui')
const tuiVersion = JSON.parse(readFileSync(join(tui, 'package.json'), 'utf8')).version
const { LOCAL_COMMANDS } = await import(pathToFileURL(join(tui, 'lib/types/commands.js')).href)
assert.equal(LOCAL_COMMANDS.some(command => command.name === 'update'), false,
  'the Nix package must not register /update')
const { userPluginsAllowed } = await import(pathToFileURL(join(tui, 'lib/types/pluginPolicy.js')).href)
assert.equal(userPluginsAllowed(), allowUserPlugins,
  'the plugin write policy must follow allowUserPlugins')
const { TIPS } = await import(pathToFileURL(join(tui, 'lib/types/tips.js')).href)
assert.equal(TIPS.some(tip => tip.id === 'cmd-update' || tip.id === 'pit-update'), false,
  'the Nix package must not advertise /update in tips')
const { resolveLaunchpadActions } = await import(pathToFileURL(join(tui, 'lib/types/components/launchpadActions.js')).href)
assert.equal(resolveLaunchpadActions({ jobsRunning: false, updateAvailable: true, starDue: false })
  .some(action => action.id === 'update'), false,
'the launchpad must not offer an update chip in the Nix package')
const temporary = mkdtempSync(join(tmpdir(), 'dsh-tui-nix-'))
const home = join(temporary, 'home')
const env = { ...process.env, HOME: home, DSH_HOME: join(home, 'dsh'), PATH: '', DSH_TUI_LANG: 'en' }
const run = (binary, args, environment = env) => spawnSync(join(packageRoot, 'bin', binary), args, {
  env: environment, encoding: 'utf8', timeout: 120000,
})
const pnpmDirectory = pnpmBin === undefined ? '' : dirname(pnpmBin)
const pluginEnv = { ...env, PATH: [pnpmDirectory, join(packageRoot, 'bin')].filter(Boolean).join(':') }
const runPlugin = (args, environment = pluginEnv) => spawnSync(join(packageRoot, 'bin', 'dsh'), ['plugin', ...args], {
  env: environment, encoding: 'utf8', timeout: 120000,
})
const writeJson = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n')
const managedBundles = ['@deepseek-ai/dsh-base', '@deepseek-harness-tui/dsh-tui']

function verifyManagedProfile() {
  const profile = join(env.DSH_HOME, 'profiles/dsh-tui')
  const dump = run('dsh-tui', ['--dump-config'])
  assert.equal(dump.status, 0, dump.stderr)
  assert.match(dump.stdout, /@deepseek-ai\/dsh-base/)
  assert.match(dump.stdout, /@deepseek-harness-tui\/dsh-tui/)
  const patch = join(profile, 'cordis.patch.yml')
  writeFileSync(patch, '# user settings\n[]\n')
  const moduleLink = join(profile, 'node_modules')
  unlinkSync(moduleLink)
  symlinkSync('/nix/store/old-dsh-tui-runtime-0/lib/dsh-tui/node_modules', moduleLink)
  const upgraded = run('dsh-tui', ['--dump-config'])
  assert.equal(upgraded.status, 0, upgraded.stderr)
  assert.equal(readlinkSync(moduleLink), modules, 'managed links follow Nix upgrades')
  assert.equal(readFileSync(patch, 'utf8'), '# user settings\n[]\n')
  const foreignHome = join(temporary, 'foreign')
  const foreignProfile = join(foreignHome, 'profiles/dsh-tui')
  mkdirSync(foreignProfile, { recursive: true })
  writeFileSync(join(foreignProfile, 'package.json'), '{}\n')
  const refused = run('dsh-tui', ['--dump-config'], { ...env, DSH_HOME: foreignHome })
  assert.notEqual(refused.status, 0)
  assert.match(refused.stderr, /unmanaged profile/)
  assert.equal(readFileSync(join(foreignProfile, 'package.json'), 'utf8'), '{}\n')

  // Turning the switch off restores a profile left in user-plugin mode.
  const userHome = join(temporary, 'to-managed')
  const userProfile = join(userHome, 'profiles/dsh-tui')
  mkdirSync(join(userProfile, 'node_modules', 'fake-plugin'), { recursive: true })
  writeFileSync(join(userProfile, '.nix-managed'), '1\n')
  writeJson(join(userProfile, 'package.json'), {
    name: 'dsh-profile-dsh-tui-nix',
    private: true,
    dependencies: { '@deepseek-harness-tui/dsh-tui': `link:${tui}`, 'fake-plugin': 'link:/tmp/fake-plugin' },
    dsh: { profile: { bundles: [...managedBundles, 'fake-plugin'] } },
  })
  writeFileSync(join(userProfile, '.nix-user-plugins'), 'user\n')
  writeFileSync(join(userProfile, 'pnpm-workspace.yaml'), 'packages:\n  - .\n')
  writeFileSync(join(userProfile, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n")
  writeFileSync(join(userProfile, 'cordis.patch.yml'), '# keep\n[]\n')
  const converted = run('dsh-tui', ['--dump-config'], { ...env, DSH_HOME: userHome })
  assert.equal(converted.status, 0, converted.stderr)
  const convertedModules = join(userProfile, 'node_modules')
  assert.ok(lstatSync(convertedModules).isSymbolicLink(), 'switch-off restores the managed link')
  assert.equal(readlinkSync(convertedModules), modules)
  const manifest = JSON.parse(readFileSync(join(userProfile, 'package.json'), 'utf8'))
  assert.deepEqual(manifest.dependencies, { '@deepseek-harness-tui/dsh-tui': tuiVersion })
  assert.deepEqual(manifest.dsh.profile.bundles, managedBundles)
  assert.equal(existsSync(join(userProfile, '.nix-user-plugins')), false)
  assert.equal(existsSync(join(userProfile, 'pnpm-workspace.yaml')), false)
  assert.equal(existsSync(join(userProfile, 'pnpm-lock.yaml')), false)
  assert.equal(readFileSync(join(userProfile, 'cordis.patch.yml'), 'utf8'), '# keep\n[]\n')
}

function verifyUserProfile() {
  const profile = join(env.DSH_HOME, 'profiles/dsh-tui')
  const dump = run('dsh-tui', ['--dump-config'])
  assert.equal(dump.status, 0, dump.stderr)
  assert.match(dump.stdout, /@deepseek-ai\/dsh-base/)
  assert.match(dump.stdout, /@deepseek-harness-tui\/dsh-tui/)
  const modulesPath = join(profile, 'node_modules')
  assert.ok(lstatSync(modulesPath).isDirectory(), 'user mode creates a writable node_modules')
  assert.equal(lstatSync(modulesPath).isSymbolicLink(), false)
  const tuiLink = join(modulesPath, '@deepseek-harness-tui', 'dsh-tui')
  assert.equal(readlinkSync(tuiLink), tui)
  const manifest = JSON.parse(readFileSync(join(profile, 'package.json'), 'utf8'))
  assert.equal(manifest.dependencies['@deepseek-harness-tui/dsh-tui'], `link:${tui}`)
  assert.deepEqual(manifest.dsh.profile.bundles, managedBundles)
  assert.match(readFileSync(join(profile, 'pnpm-workspace.yaml'), 'utf8'), /dangerouslyAllowAllBuilds: true/)
  assert.ok(existsSync(join(profile, '.nix-user-plugins')))
  const patch = join(profile, 'cordis.patch.yml')
  writeFileSync(patch, '# user settings\n[]\n')
  const again = run('dsh-tui', ['--dump-config'])
  assert.equal(again.status, 0, again.stderr)
  assert.equal(readFileSync(patch, 'utf8'), '# user settings\n[]\n')
  assert.equal(JSON.parse(readFileSync(join(profile, 'package.json'), 'utf8')).dependencies['@deepseek-harness-tui/dsh-tui'], `link:${tui}`)

  // Install a local fixture through the ordinary dsh plugin path.
  const plugin = join(temporary, 'fixture-plugin')
  mkdirSync(plugin)
  writeJson(join(plugin, 'package.json'), {
    name: 'nix-test-plugin',
    version: '1.0.0',
    type: 'module',
    main: './index.js',
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  })
  writeFileSync(join(plugin, 'cordis.patch.yml'), '- insert:\n    - id: nix-test-plugin\n      name: nix-test-plugin\n')
  writeFileSync(join(plugin, 'index.js'), "export const name = 'nix-test-plugin'\nexport const apply = () => {}\n")
  const added = runPlugin(['--profile', 'dsh-tui', 'add', plugin, '--offline'])
  assert.equal(added.status, 0, added.stderr)
  const withPlugin = JSON.parse(readFileSync(join(profile, 'package.json'), 'utf8'))
  assert.ok(withPlugin.dsh.profile.bundles.includes('nix-test-plugin'))
  const installed = run('dsh-tui', ['--dump-config'])
  assert.equal(installed.status, 0, installed.stderr)
  assert.match(installed.stdout, /# == nix-test-plugin/)

  // A changed runtime stamp reseeds the overlay and restores the declared state.
  writeFileSync(join(profile, '.nix-user-plugins'), 'old runtime\n')
  const reseeded = run('dsh-tui', ['--dump-config'])
  assert.equal(reseeded.status, 0, reseeded.stderr)
  const resetManifest = JSON.parse(readFileSync(join(profile, 'package.json'), 'utf8'))
  assert.deepEqual(resetManifest.dependencies, { '@deepseek-harness-tui/dsh-tui': `link:${tui}` })
  assert.deepEqual(resetManifest.dsh.profile.bundles, managedBundles)
  assert.equal(existsSync(join(modulesPath, 'nix-test-plugin')), false)
  assert.match(readFileSync(join(profile, 'pnpm-workspace.yaml'), 'utf8'), /dangerouslyAllowAllBuilds: true/)
  assert.ok(readFileSync(join(profile, '.nix-user-plugins'), 'utf8').includes(modules))
  assert.doesNotMatch(reseeded.stdout, /# == nix-test-plugin/)

  // A managed profile is promoted to the writable overlay without losing its patch.
  const managedHome = join(temporary, 'to-user')
  const managedProfile = join(managedHome, 'profiles/dsh-tui')
  mkdirSync(managedProfile, { recursive: true })
  writeFileSync(join(managedProfile, '.nix-managed'), '1\n')
  symlinkSync(modules, join(managedProfile, 'node_modules'))
  writeJson(join(managedProfile, 'package.json'), {
    name: 'dsh-profile-dsh-tui-nix',
    private: true,
    dependencies: { '@deepseek-harness-tui/dsh-tui': tuiVersion },
    dsh: { profile: { bundles: managedBundles } },
  })
  writeFileSync(join(managedProfile, 'cordis.patch.yml'), '# keep\n[]\n')
  const promoted = run('dsh-tui', ['--dump-config'], { ...env, DSH_HOME: managedHome })
  assert.equal(promoted.status, 0, promoted.stderr)
  const promotedModules = join(managedProfile, 'node_modules')
  assert.ok(lstatSync(promotedModules).isDirectory())
  assert.equal(lstatSync(promotedModules).isSymbolicLink(), false)
  assert.equal(readlinkSync(join(promotedModules, '@deepseek-harness-tui', 'dsh-tui')), tui)
  assert.equal(JSON.parse(readFileSync(join(managedProfile, 'package.json'), 'utf8')).dependencies['@deepseek-harness-tui/dsh-tui'], `link:${tui}`)
  assert.equal(readFileSync(join(managedProfile, 'cordis.patch.yml'), 'utf8'), '# keep\n[]\n')

  // An unknown writable node_modules is never deleted.
  const foreignHome = join(temporary, 'foreign-user')
  const foreignProfile = join(foreignHome, 'profiles/dsh-tui')
  mkdirSync(join(foreignProfile, 'node_modules'), { recursive: true })
  writeFileSync(join(foreignProfile, '.nix-managed'), '1\n')
  writeFileSync(join(foreignProfile, 'package.json'), '{}\n')
  writeFileSync(join(foreignProfile, 'node_modules', 'keep.txt'), 'keep\n')
  const refused = run('dsh-tui', ['--dump-config'], { ...env, DSH_HOME: foreignHome })
  assert.notEqual(refused.status, 0)
  assert.match(refused.stderr, /unmanaged node_modules/)
  assert.equal(readFileSync(join(foreignProfile, 'node_modules', 'keep.txt'), 'utf8'), 'keep\n')
}

try {
  mkdirSync(home)
  const version = run('dsh', ['--version'])
  assert.equal(version.status, 0, version.stderr)
  assert.equal(version.stdout.trim(), '0.2.2-rc.1')
  const help = run('dsh-tui', ['--help'])
  assert.equal(help.status, 0, help.stderr)
  assert.equal(existsSync(env.DSH_HOME), false, 'help does not create a profile')
  const updateHome = join(temporary, 'update')
  const update = run('dsh-tui', ['update'], { ...env, DSH_HOME: join(updateHome, 'dsh') })
  assert.equal(update.status, 1, update.stderr)
  assert.match(update.stderr, /managed by Nix/)
  if (allowUserPlugins) verifyUserProfile()
  else verifyManagedProfile()

  const require = createRequire(join(modules, 'package.json'))
  assert.equal(typeof require('node-addon-require-builtin').requireBuiltin('internal/modules/esm/loader').getOrInitializeCascadedLoader, 'function')
  const previousPath = process.env.PATH
  process.env.PATH = join(packageRoot, 'bin')
  try {
    const { loadHostDsh } = await import(pathToFileURL(join(tui, 'lib/types/dsh-adapter/host-dsh.js')))
    const host = await loadHostDsh()
    assert.ok(host)
  } finally {
    process.env.PATH = previousPath
  }
  assert.equal(typeof require('koffi').load, 'function')
  const pty = require('node-pty').spawn(shell, ['-c', 'printf nix-pty-ok'], {
    name: 'xterm', cols: 80, rows: 24, env: process.env,
  })
  let ptyOutput = ''
  pty.onData(data => { ptyOutput += data })
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { pty.kill(); reject(new Error('PTY smoke timed out')) }, 10000)
    pty.onExit(result => {
      clearTimeout(timeout)
      try { assert.equal(result.exitCode, 0); assert.match(ptyOutput, /nix-pty-ok/); resolve() } catch (error) { reject(error) }
    })
  })
  const { renderMathRaster } = await import(pathToFileURL(join(tui, 'lib/types/math/renderer.js')))
  const { transmitKittyRgba } = await import(pathToFileURL(join(tui, 'lib/types/ink/kitty-graphics.js')))
  for (const tex of [String.raw`\frac{a}{b}`, String.raw`\int_0^1 x^2\,dx = \frac{1}{3}`]) {
    const result = await renderMathRaster({
      tex, display: true, color: '#ffffff', cellSize: { width: 10, height: 20 }, maxColumns: 40, maxRows: 10,
    })
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.ok(result.raster.source.data.some(value => value !== 0))
    assert.match(transmitKittyRgba(31, result.raster.source), /^\x1b_Ga=t,t=d,f=32,/)
  }
  const { selectTerminalImageProtocol } = await import(pathToFileURL(join(tui, 'lib/types/ink/terminal-image-protocol.js')))
  assert.equal(selectTerminalImageProtocol('OK', undefined), 'kitty')
  assert.equal(selectTerminalImageProtocol(undefined, undefined), 'none')
  const bootHome = join(temporary, 'boot')
  mkdirSync(bootHome)
  const bootEnv = { ...env, HOME: bootHome, DSH_HOME: join(bootHome, 'dsh'), TERM: 'xterm', DSH_TUI_LANG: 'en' }
  delete bootEnv.DEEPSEEK_API_KEY
  delete bootEnv.TMUX
  delete bootEnv.STY
  const boot = require('node-pty').spawn(join(packageRoot, 'bin/dsh-tui'), [], {
    name: 'xterm', cols: 100, rows: 30, env: bootEnv,
  })
  await new Promise((resolve, reject) => {
    let output = ''
    let mounted = false
    let answeredDa = false
    let answeredCursor = false
    const terminate = () => {
      try { process.kill(-boot.pid, 'SIGKILL') } catch (error) { if (error.code !== 'ESRCH') throw error }
    }
    // The first-run splash animates before onboarding mounts. The Nix
    // sandbox runs it much slower than a desktop terminal, so the bound is
    // generous: a stuck process still fails, a slow frame loop does not.
    const timeout = setTimeout(() => { terminate(); reject(new Error(`TUI startup timed out: ${output.slice(-2000)}`)) }, 90000)
    boot.onData(data => {
      output += data
      // Terminal queries are not aligned to output chunks. Answer from the
      // accumulated stream, once each, so a split `ESC [ c` cannot strand the
      // startup probe under load.
      if (!answeredDa && output.includes('\x1b[c')) {
        answeredDa = true
        boot.write('\x1b[?62c')
      }
      if (!answeredCursor && output.includes('\x1b[6n')) {
        answeredCursor = true
        boot.write('\x1b[1;1R')
      }
      // The splash animation can take minutes under a loaded sandbox, and the
      // onboarding screen only follows it. The check's job is "the TUI mounted
      // and drew", not "the intro finished": the logo wordmark and tagline are
      // in the first rendered frames, while onboarding is optional.
      if (output.includes('✦ dsh-TUI') || output.includes('Explore the uncharted!')
        || output.includes('Welcome to dsh-TUI')) {
        mounted = true
        terminate()
      }
    })
    boot.onExit(() => {
      clearTimeout(timeout)
      try {
        assert.ok(mounted, `TUI exited before mounting: ${output.slice(-2000)}`)
        assert.doesNotMatch(output, /Unsupported\/no-getter|exited unexpectedly|ERR_MODULE_NOT_FOUND/)
        resolve()
      } catch (error) { reject(error) }
    })
  })
  console.log(`Nix runtime: DSH, ${allowUserPlugins ? 'user-plugin overlay' : 'managed profile'}, PTY, math rasters and full TUI startup passed`)
} finally {
  rmSync(temporary, { recursive: true, force: true })
}
