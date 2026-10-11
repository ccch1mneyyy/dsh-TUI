/**
 * Opt-in real-profile startup check, not a headless component fixture.
 * Run: node scripts/verify-installed-startup.mjs
 * Requires installed dsh/dsh-tui launchers and the host's node-pty dependency.
 * Copies profile composition into an isolated HOME, reuses installed packages,
 * waits for the injection endpoint (bound to the adopted session, never the
 * placeholder), then sends only /quit. A
 * second launch overrides the dsh-tui row in the profile's own patch layer and
 * starts from another directory: the session must open in the row's `cwd`.
 * Does not copy the credential store or submit a model request. Failed probes keep a
 * private temporary log; successful probes remove their temporary state.
 */
import assert from 'node:assert/strict'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import xterm from '@xterm/headless'
import { resolveWindowsShim } from '../lib/types/utils/externalEditor.js'
import { settled } from './lib/term-test.mjs'

const isWin = process.platform === 'win32'
/**
 * Resolve an installed launcher through PATH. POSIX npm publishes a symlink to
 * the package's JS entry; Windows publishes `dsh.cmd` / `dsh-tui.cmd` shims
 * plus an extensionless sh script, so walk PATHEXT and keep the shim path.
 */
const executable = name => {
  if (isWin) {
    const { command } = resolveWindowsShim(name)
    if (!existsSync(command)) throw new Error(`missing launcher: ${name}`)
    return realpathSync(command)
  }
  const path = (process.env.PATH ?? '').split(delimiter).map(dir => join(dir, name)).find(existsSync)
  if (path === undefined) throw new Error(`missing launcher: ${name}`)
  return realpathSync(path)
}
/** The installed package's JS entry: on Windows the npm prefix keeps it beside the shim. */
const packageEntry = (shim, scope, name, ...rest) =>
  isWin ? join(dirname(shim), 'node_modules', scope, name, ...rest) : shim
const dsh = executable('dsh')
const launcherShim = executable('dsh-tui')
// Spawn the JS entry rather than the `.cmd` shim: node-pty would have to route
// it through cmd.exe and re-quote the payload. The shim itself is covered by
// scripts/verify-launcher.mjs; this probe is about the installed profile.
const launcher = packageEntry(launcherShim, '@deepseek-harness-tui', 'dsh-tui', 'bin', 'dsh-tui.js')
const dshEntry = packageEntry(dsh, '@deepseek-ai', 'dsh', 'lib', 'bin.js')
/**
 * node-pty is a native dependency of the installed dsh, not of this repo.
 * DSH_TUI_NODE_PTY points at a built node-pty directory (the layer holding its
 * package.json) for hosts where neither anchor resolves.
 */
const pty = (() => {
  const override = process.env.DSH_TUI_NODE_PTY
  for (const anchor of override === undefined ? [dshEntry, launcher] : [override]) {
    try {
      return createRequire(anchor)('node-pty')
    } catch {
      // Try the next anchor.
    }
  }
  throw new Error('cannot resolve node-pty from the installed dsh; set DSH_TUI_NODE_PTY to a built node-pty directory')
})()
const sourceHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const profile = join(sourceHome, 'profiles', 'dsh-tui')
const YAML_JS = { tag: 'tag:yaml.org,2002:js', resolve: source => ({ js: source }) }
const YAML_JS_OUT = { tag: 'tag:yaml.org,2002:js', identify: value => typeof value?.js === 'string', stringify: ({ value }) => value.js }

/** The dsh-tui row's config in the installed package's bundle patch. */
function bundleRowConfig() {
  const patch = join(profile, 'node_modules', '@deepseek-harness-tui', 'dsh-tui', 'cordis.patch.yml')
  const find = entries => {
    for (const entry of Array.isArray(entries) ? entries : []) {
      if (entry?.id === 'dsh-tui' && entry.config !== undefined) return entry.config
      const nested = find(entry?.insert)
      if (nested !== undefined) return nested
    }
    return undefined
  }
  const config = find(parseYaml(readFileSync(patch, 'utf8'), { customTags: [YAML_JS] }))
  assert.ok(config !== undefined, `no dsh-tui row in ${patch}`)
  return config
}

/**
 * One launch on a copy of the installed profile. `row` edits the copied
 * dsh-tui row's config; `check` runs once the prompt has painted.
 */
async function launch(name, { row, cwd = process.cwd(), env: extraEnv = {}, unsetEnv = [], check }) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-tui-startup-'))
  const targetHome = join(root, '.dsh')
  const targetProfile = join(targetHome, 'profiles', 'dsh-tui')
  mkdirSync(targetProfile, { recursive: true, mode: 0o700 })
  if (existsSync(join(profile, 'cordis.yml'))) cpSync(join(profile, 'cordis.yml'), join(targetProfile, 'cordis.yml'))
  // dsh-purge (when the profile bundles it) rewrites the GLOBAL dsh bin.js on
  // start and breaks every dsh launch; the copy leaves it out, bundle and
  // patch rows alike.
  if (existsSync(join(profile, 'cordis.patch.yml'))) {
    const rows = parseYaml(readFileSync(join(profile, 'cordis.patch.yml'), 'utf8'), { customTags: [YAML_JS] }) ?? []
    const kept = Array.isArray(rows) ? rows.filter(entry => !String(entry?.id ?? '').startsWith('dsh-purge')) : rows
    if (row !== undefined) {
      // A user override the way a profile owner writes one: an id-targeted
      // entry in the profile's own patch layer, replacing the bundle's whole
      // `config` (so it starts from the bundle's own row config).
      const config = structuredClone(bundleRowConfig())
      row(config, root)
      kept.push({ id: 'dsh-tui', config })
    }
    writeFileSync(join(targetProfile, 'cordis.patch.yml'), stringifyYaml(kept, { customTags: [YAML_JS_OUT] }))
  }
  const manifest = JSON.parse(readFileSync(join(profile, 'package.json'), 'utf8'))
  delete manifest.dependencies?.['dsh-purge']
  if (Array.isArray(manifest.dsh?.profile?.bundles)) {
    manifest.dsh.profile.bundles = manifest.dsh.profile.bundles.filter(bundle => bundle !== 'dsh-purge')
  }
  writeFileSync(join(targetProfile, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  // Junctions need no elevation on Windows; directory symlinks do.
  const linkKind = isWin ? 'junction' : 'dir'
  symlinkSync(join(profile, 'node_modules'), join(targetProfile, 'node_modules'), linkKind)
  const fallback = join(sourceHome, 'profiles', 'node_modules')
  if (existsSync(fallback)) symlinkSync(fallback, join(targetHome, 'profiles', 'node_modules'), linkKind)

  const env = {
    ...process.env,
    HOME: root,
    USERPROFILE: root,
    DSH_HOME: targetHome,
    DSH_TUI_SESSION_ROOT: join(root, 'sessions'),
    DSH_TUI_WORKSPACE_TARGET: process.cwd(),
    DSH_TUI_PRESET: 'liangshen',
    DSH_TUI_LANG: 'zh',
    DSH_TELEMETRY_MODE: 'DISABLED',
    NODE_ENV: 'production',
    TERM: 'xterm-256color',
    ...extraEnv,
  }
  for (const key of ['DSH_TUI_RESUME_SESSION', 'DSH_TUI_RESTART_CHILD', 'DSH_TUI_RESTART_SESSION', ...unsetEnv]) delete env[key]
  const startedAt = Date.now()
  const child = pty.spawn(process.execPath, [launcher], {
    name: 'xterm-256color', cols: 100, rows: 32, cwd: typeof cwd === 'function' ? cwd(root) : cwd, env,
  })
  let output = ''
  let exit
  const terminal = new xterm.Terminal({ cols: 100, rows: 32, scrollback: 1000, allowProposedApi: true })
  terminal.onData(data => { if (exit === undefined) child.write(data) })
  child.onData(data => { output = (output + data).slice(-1024 * 1024); terminal.write(data) })
  child.onExit(event => { exit = event })
  const screen = () => {
    const buffer = terminal.buffer.active
    return Array.from({ length: 32 }, (_, index) => buffer.getLine(buffer.baseY + index)?.translateToString(true) ?? '').join('\n')
  }
  const discovery = join(root, '.dsh-tui', 'inject', 'servers.json')
  const servers = () => {
    try { return JSON.parse(readFileSync(discovery, 'utf8')) }
    catch { return [] }
  }
  const ready = () => servers().length > 0
  let passed = false
  try {
    assert.ok(await settled(() => exit !== undefined || ready(), { timeoutMs: 30000 }), `${name}: timed out before UI mount`)
    assert.equal(exit, undefined, `${name}: profile exited before UI mount (code ${exit?.exitCode})`)
    assert.ok(ready(), `${name}: post-render injection endpoint is missing`)
    // The endpoint binds the adopted session, never the placeholder's empty id
    // (two launches would otherwise share `inject/.sock` and one record).
    assert.ok(servers().every(record => record.sessionId !== ''), `${name}: an injection record has no session id: ${JSON.stringify(servers())}`)
    assert.ok(!existsSync(join(root, '.dsh-tui', 'inject', '.sock')), `${name}: the placeholder bound an injection socket`)
    // The launch stayed in the package's entry (not handed to `dsh --profile`).
    if (process.platform === 'linux') {
      const cmdline = readFileSync(`/proc/${servers()[0].pid}/cmdline`, 'utf8')
      assert.ok(cmdline.includes('host-entry.js'), `${name}: the TUI does not run in the package entry: ${cmdline.replaceAll('\0', ' ')}`)
    }
    // The endpoint appears with the adoption, which is also when an isolated
    // HOME's first-launch wizard opens over the prompt: skip it.
    // An Esc that lands before the wizard binds its keys is dropped: repeat.
    const onboarding = () => screen().includes('Esc 跳过引导')
    if (await settled(onboarding, { timeoutMs: 3000 })) {
      for (let attempt = 0; attempt < 10 && onboarding(); attempt += 1) {
        child.write('\x1b')
        await settled(() => !onboarding(), { timeoutMs: 500 })
      }
      assert.ok(!onboarding(), `${name}: the first-launch wizard did not close`)
    }
    // The chat screen's status row, or the landing page a launch without a
    // workspace target opens on (its banner is art; its footer names the package).
    assert.ok(await settled(() => screen().includes('\u276f') && /dsh-TUI|dsh-tui v/u.test(screen()), { timeoutMs: 5000 }), `${name}: prompt has not painted`)
    const bootMs = Date.now() - startedAt
    const detail = check === undefined ? '' : await check({ root, screen, servers })
    child.write('/quit')
    assert.ok(await settled(() => screen().includes('/quit'), { timeoutMs: 5000 }), `${name}: prompt did not accept /quit`)
    child.write('\r')
    assert.ok(await settled(() => exit !== undefined, { timeoutMs: 20000 }), `${name}: /quit did not exit`)
    assert.equal(exit.exitCode, 0, `${name}: /quit must exit successfully`)
    assert.doesNotMatch(output, /plugin tree failed to load|session\.events is not iterable|UnhandledPromiseRejection/)
    assert.ok(output.includes('\u001b[?25h'), `${name}: exit must restore the cursor`)
    console.log(`PASS ${name}: session adopted (injection endpoint up) in ${bootMs}ms, /quit exited 0, cursor restored${detail === '' ? '' : `; ${detail}`}`)
    passed = true
  } finally {
    const finalScreen = screen()
    if (exit === undefined) {
      child.kill()
      if (!await settled(() => exit !== undefined, { timeoutMs: 5000 })) {
        child.kill('SIGKILL')
        await settled(() => exit !== undefined, { timeoutMs: 5000 })
      }
    }
    if (passed) rmSync(root, { recursive: true, force: true })
    else {
      const log = join(root, 'startup.log')
      writeFileSync(log, output, { mode: 0o600 })
      writeFileSync(join(root, 'screen.txt'), finalScreen, { mode: 0o600 })
      console.error(`startup probe log: ${log}`)
    }
    terminal.dispose()
  }
  return passed
}

let passed = await launch('installed profile', {}).catch(error => { console.error(error); return false })

// The entry mounts on rebuilt row defaults, then the DSH side attaches with
// the profile's real dsh-tui row: the session must open in the row's `cwd`,
// not in the launch directory (no workspace target set).
const ROW_CWD = 'row-cwd-target'
const LAUNCH_DIR = 'launch-dir'
passed = await launch('row cwd from another launch directory', {
  cwd: root => { const launchDir = join(root, LAUNCH_DIR); mkdirSync(launchDir); return launchDir },
  unsetEnv: ['DSH_TUI_WORKSPACE_TARGET'],
  row: (config, root) => {
    mkdirSync(join(root, ROW_CWD))
    config.cwd = join(root, ROW_CWD)
  },
  check: async ({ root, screen, servers }) => {
    // The injection endpoint (what launch() waits for) binds at the adoption.
    assert.ok(await settled(() => screen().includes(ROW_CWD), { timeoutMs: 10000 }), `the session did not open in the row's cwd:\n${screen()}`)
    assert.ok(!screen().includes(LAUNCH_DIR), `the launch directory is still shown:\n${screen()}`)
    assert.ok(servers().some(record => record.cwd === join(root, ROW_CWD)), `the injection record keeps the launch cwd: ${JSON.stringify(servers())}`)
    return `session cwd ${ROW_CWD}`
  },
}).catch(error => { console.error(error); return false }) && passed

// A ConPTY handle can keep the event loop alive after the child has exited, so
// end the probe explicitly rather than waiting for the loop to drain (a pass
// would otherwise hang instead of reporting its status to the caller).
process.exit(passed ? 0 : 1)
