/**
 * Opt-in real-profile startup check, not a headless component fixture.
 * Run: node scripts/verify-installed-startup.mjs
 * Requires installed dsh/dsh-tui launchers and the host's node-pty dependency.
 * Copies profile composition into an isolated HOME, reuses installed packages,
 * waits for the post-render injection endpoint, then sends only /quit.
 * Does not copy the credential store or submit a model request. Failed probes keep a
 * private temporary log; successful probes remove their temporary state.
 */
import assert from 'node:assert/strict'
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
const root = mkdtempSync(join(tmpdir(), 'dsh-tui-startup-'))
const targetHome = join(root, '.dsh')
const targetProfile = join(targetHome, 'profiles', 'dsh-tui')
mkdirSync(targetProfile, { recursive: true, mode: 0o700 })
for (const name of ['package.json', 'cordis.yml', 'cordis.patch.yml']) {
  if (existsSync(join(profile, name))) cpSync(join(profile, name), join(targetProfile, name))
}
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
}
delete env.DSH_TUI_RESUME_SESSION
delete env.DSH_TUI_RESTART_CHILD
delete env.DSH_TUI_RESTART_SESSION
const startedAt = Date.now()
const child = pty.spawn(process.execPath, [launcher], {
  name: 'xterm-256color', cols: 100, rows: 32, cwd: process.cwd(), env,
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
const ready = () => {
  try { return JSON.parse(readFileSync(discovery, 'utf8')).length > 0 }
  catch { return false }
}
let passed = false
try {
  assert.ok(await settled(() => exit !== undefined || ready(), { timeoutMs: 30000 }), 'timed out before UI mount')
  assert.equal(exit, undefined, `profile exited before UI mount (code ${exit?.exitCode})`)
  assert.ok(ready(), 'post-render injection endpoint is missing')
  assert.ok(await settled(() => screen().includes('\u276f') && screen().includes('dsh-TUI'), { timeoutMs: 5000 }), 'prompt has not painted')
  const bootMs = Date.now() - startedAt
  child.write('/quit')
  assert.ok(await settled(() => screen().includes('/quit'), { timeoutMs: 5000 }), 'prompt did not accept /quit')
  child.write('\r')
  assert.ok(await settled(() => exit !== undefined, { timeoutMs: 20000 }), '/quit did not exit')
  assert.equal(exit.exitCode, 0, '/quit must exit successfully')
  assert.doesNotMatch(output, /plugin tree failed to load|session\.events is not iterable|UnhandledPromiseRejection/)
  assert.ok(output.includes('\u001b[?25h'), 'exit must restore the cursor')
  console.log(`PASS installed profile: Agent created, UI mounted in ${bootMs}ms, /quit exited 0, cursor restored`)
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

// A ConPTY handle can keep the event loop alive after the child has exited, so
// end the probe explicitly rather than waiting for the loop to drain (a pass
// would otherwise hang instead of reporting its status to the caller).
process.exit(passed ? 0 : 1)
