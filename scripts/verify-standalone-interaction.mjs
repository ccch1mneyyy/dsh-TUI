#!/usr/bin/env node
/**
 * Exercise the packaged executable through a real PTY, with no user credentials
 * or Node/pnpm on PATH. Windows uses the bundled node-pty's ConPTY driver.
 * Run: node scripts/verify-standalone-interaction.mjs --binary <exe> --out <evidence-dir>
 * Requires this checkout's @xterm/headless. Only /help and /quit are submitted;
 * this checks local interaction, not a paid provider request or account login.
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import xterm from '@xterm/headless'
import { settled, viewportLines, writeParsed } from './lib/term-test.mjs'
import { runStandaloneProcess, terminateStandaloneTree } from './lib/standalone-test-process.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const option = name => {
  const index = process.argv.indexOf(name)
  if (index < 0 || !process.argv[index + 1] || process.argv[index + 1].startsWith('--')) {
    throw new Error(`${name} requires a path`)
  }
  return resolve(process.argv[index + 1])
}
const binary = option('--binary')
const out = option('--out')
assert.ok(existsSync(binary), `Missing standalone executable: ${binary}`)
mkdirSync(out, { recursive: true })
const tuiVersion = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version
const dshVersion = readFileSync(join(root, 'src/dsh-adapter/contract.ts'), 'utf8')
  .match(/^export const UPSTREAM_VALIDATED_VERSION\s*=\s*'([^']+)'/m)?.[1]
assert.ok(dshVersion, 'Missing primary DSH version')
const bundleId = `tui-${tuiVersion}-dsh-${dshVersion}`
const scratch = mkdtempSync(join(tmpdir(), 'dsh-tui-interaction-'))
const home = join(scratch, '首次 用户')
const workspace = join(home, '项目 workspace')
mkdirSync(workspace, { recursive: true })

function environment(userHome) {
  const env = Object.fromEntries(Object.entries(process.env)
    .filter(([key]) => /^(systemroot|systemdrive|windir|comspec|pathext)$/i.test(key)))
  const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT
  const path = process.platform === 'win32' && systemRoot
    ? [join(systemRoot, 'System32'), systemRoot].join(delimiter)
    : join(userHome, 'empty-bin')
  Object.assign(env, {
    HOME: userHome, USERPROFILE: userHome,
    APPDATA: join(userHome, 'AppData', 'Roaming'), LOCALAPPDATA: join(userHome, 'AppData', 'Local'),
    XDG_CONFIG_HOME: join(userHome, '.config'), XDG_CACHE_HOME: join(userHome, '.cache'),
    TMP: scratch, TEMP: scratch, TMPDIR: scratch, PATH: path,
    DSH_HOME: join(userHome, 'standalone home'), DSH_TUI_STANDALONE_HOME: join(userHome, 'standalone home'),
    DSH_TUI_STANDALONE_CACHE: join(userHome, 'runtime cache'),
    DSH_TUI_SESSION_ROOT: join(userHome, 'sessions'), DSH_TUI_LANG: 'en',
    DSH_TELEMETRY_MODE: 'DISABLED', NODE_ENV: 'production', TERM: 'xterm-256color', COLORTERM: 'truecolor',
  })
  return env
}

const results = []
let passed = false
try {
  // A separate home supplies the native test driver. The actual user journey
  // below still starts from an empty cache and uninitialized profile.
  const driverHome = join(scratch, 'driver home')
  mkdirSync(driverHome)
  const driver = await runStandaloneProcess(binary, ['--self-test'], {
    cwd: driverHome, env: environment(driverHome), timeoutMs: 120_000,
    maxBuffer: 4 * 1024 * 1024,
  })
  writeFileSync(join(out, 'driver-self-test.log'), `${driver.stdout ?? ''}${driver.stderr ?? ''}`)
  if (driver.cleanup) writeFileSync(join(out, 'driver-cleanup.json'), `${JSON.stringify(driver.cleanup, null, 2)}\n`)
  assert.equal(driver.error, undefined, `Driver extraction failed: ${driver.error?.message}`)
  assert.equal(driver.status, 0, 'Driver extraction failed; see driver-self-test.log')
  const driverRuntime = join(driverHome, 'runtime cache', bundleId)
  const pty = createRequire(join(driverRuntime, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'))('node-pty')
  const marker = join(home, 'runtime cache', bundleId, '.complete')
  assert.ok(!existsSync(marker), 'The first launch must have a fresh runtime cache')

  async function launch(mode) {
    const terminal = new xterm.Terminal({ cols: 100, rows: 36, scrollback: 1000, allowProposedApi: true })
    let cursorVisible
    const cursorModes = ['h', 'l'].map(final => terminal.parser.registerCsiHandler({ prefix: '?', final }, params => {
      if (params.includes(25)) cursorVisible = final === 'h'
      return false
    }))
    const startedAt = Date.now()
    const child = pty.spawn(binary, [], {
      name: 'xterm-256color', cols: 100, rows: 36, cwd: workspace, env: environment(home),
    })
    let output = ''
    let exited
    const dataListener = child.onData(data => {
      output = (output + data).slice(-4 * 1024 * 1024)
      terminal.write(data)
    })
    const exitListener = child.onExit(event => { exited = event })
    const replies = terminal.onData(data => { if (!exited) child.write(data) })
    const screen = () => viewportLines(terminal).join('\n')
    const capture = label => writeFileSync(join(out, `${mode}-${label}.txt`), `${screen()}\n`)
    const guide = () => screen().includes('skip the guide')
    const prompt = () => !guide() && screen().includes('❯') && /dsh-TUI|dsh-tui v/.test(screen())
    const help = () => screen().includes('? for this help') && screen().includes('commands:')
    const expectScreen = async (predicate, label, timeoutMs = 10_000) => {
      assert.ok(await settled(() => exited !== undefined || predicate(), { timeoutMs }), `${mode}: ${label} timed out`)
      assert.equal(exited, undefined, `${mode}: exited before ${label} (code ${exited?.exitCode})`)
      assert.ok(predicate(), `${mode}: ${label} was not rendered`)
    }
    try {
      await expectScreen(guide, 'first-run guide', 90_000)
      // Inspect output as soon as the guide appears, so a message printed
      // later cannot make a silent preparation phase pass this check.
      const preparationElapsed = [...output.matchAll(/\[dsh-tui\] 正在准备运行环境，已用 (\d+) 秒/g)]
        .map(match => Number(match[1]))
      if (mode === 'cold') {
        assert.match(output, /首次运行，正在释放内置 DSH\/TUI 运行时/, 'Cold start did not explain runtime preparation')
        assert.ok(preparationElapsed.length > 0, 'Cold start did not show elapsed preparation time before the guide')
      }
      capture('welcome')
      // The first painted frame can precede the input listener. Retry only Esc
      // while the guide is still visible; never replay a submitted command.
      for (let attempt = 0; attempt < 10 && guide(); attempt++) {
        child.write('\x1b')
        await settled(() => exited !== undefined || !guide(), { timeoutMs: 500 })
      }
      await expectScreen(prompt, 'launchpad prompt')
      capture('launchpad')
      const startupMs = Date.now() - startedAt
      child.write('/help')
      await expectScreen(() => screen().includes('/help'), 'typed /help')
      child.write('\r')
      await expectScreen(help, 'local help')
      capture('help')
      child.write('\x1b')
      await expectScreen(() => !help() && prompt(), 'closed help')
      child.write('/quit')
      await expectScreen(() => screen().includes('/quit'), 'typed /quit')
      child.write('\r')
      assert.ok(await settled(() => exited !== undefined, { timeoutMs: 20_000 }), `${mode}: /quit did not exit`)
      assert.equal(exited.exitCode, 0, `${mode}: /quit must exit successfully`)
      await writeParsed(terminal, '')
      assert.doesNotMatch(output, /fatal load failure|plugin tree failed to load|UnhandledPromiseRejection|does not provide an export named/)
      if (mode === 'warm') {
        assert.doesNotMatch(output, /首次运行，正在释放内置 DSH\/TUI 运行时|正在准备运行环境，已用 \d+ 秒/,
          'Warm start unexpectedly showed runtime preparation')
      }
      assert.equal(cursorVisible, true, `${mode}: exit did not restore the cursor`)
      capture('exit')
      results.push({ mode, startupMs, preparationElapsedSeconds: preparationElapsed.at(-1) ?? null,
        totalMs: Date.now() - startedAt, exitCode: exited.exitCode, interaction: '/help → Esc → /quit' })
      console.log(`PASS: ${mode} standalone ${process.platform === 'win32' ? 'ConPTY' : 'PTY'}: local /help, /quit exited 0 (${startupMs}ms to prompt)`)
    } finally {
      if (!exited) {
        if (process.platform === 'win32') {
          const cleanup = terminateStandaloneTree(child.pid)
          writeFileSync(join(out, `${mode}-cleanup.json`), `${JSON.stringify(cleanup, null, 2)}\n`)
        }
        try { child.kill() }
        catch (error) { writeFileSync(join(out, `${mode}-pty-cleanup-error.log`), `${error.stack ?? error}\n`) }
        await settled(() => exited !== undefined, { timeoutMs: 5000 })
      }
      writeFileSync(join(out, `${mode}-terminal.log`), output)
      capture('last-screen')
      replies.dispose()
      dataListener.dispose()
      exitListener.dispose()
      for (const listener of cursorModes) listener.dispose()
      terminal.dispose()
    }
  }

  await launch('cold')
  assert.ok(existsSync(marker), 'Cold start did not complete runtime extraction')
  const markerTime = statSync(marker).mtimeMs
  await launch('warm')
  assert.equal(statSync(marker).mtimeMs, markerTime, 'Warm launch extracted the runtime again')
  passed = true
} catch (error) {
  console.error(error)
  writeFileSync(join(out, 'failure.txt'), `${error.stack ?? error}\nTemporary state: ${scratch}\n`)
} finally {
  writeFileSync(join(out, 'result.json'), `${JSON.stringify({ passed, platform: process.platform, tuiVersion, dshVersion,
    cwd: { requested: workspace, real: realpathSync.native(workspace) }, results }, null, 2)}\n`)
  if (passed) {
    // Windows can keep the verifier's loaded node-pty DLL open until process
    // exit; any locked remainder belongs to the runner's temporary directory.
    try { rmSync(scratch, { recursive: true, force: true }) } catch {}
  }
}
// The Windows node-pty bridge retains native handles after onExit. All child
// exits and evidence writes above have finished before this verifier terminates.
process.exit(passed ? 0 : 1)
