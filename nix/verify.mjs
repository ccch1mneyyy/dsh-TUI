import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, existsSync, readFileSync, writeFileSync, mkdirSync, readlinkSync, unlinkSync, symlinkSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const [packageRoot, runtimeRoot, shell] = process.argv.slice(2)
const modules = join(runtimeRoot, 'lib/dsh-tui/node_modules')
const tui = join(modules, '@deepseek-harness-tui/dsh-tui')
const temporary = mkdtempSync(join(tmpdir(), 'dsh-tui-nix-'))
const home = join(temporary, 'home')
const env = { ...process.env, HOME: home, DSH_HOME: join(home, 'dsh'), PATH: '' }
const run = (binary, args, environment = env) => spawnSync(join(packageRoot, 'bin', binary), args, {
  env: environment, encoding: 'utf8', timeout: 60000,
})

try {
  mkdirSync(home)
  const version = run('dsh', ['--version'])
  assert.equal(version.status, 0, version.stderr)
  assert.equal(version.stdout.trim(), '0.2.1-rc.3')
  const help = run('dsh-tui', ['--help'])
  assert.equal(help.status, 0, help.stderr)
  assert.equal(existsSync(env.DSH_HOME), false, 'help does not create a profile')
  const dump = run('dsh-tui', ['--dump-config'])
  assert.equal(dump.status, 0, dump.stderr)
  assert.match(dump.stdout, /@deepseek-ai\/dsh-base/)
  assert.match(dump.stdout, /@deepseek-harness-tui\/dsh-tui/)
  const profile = join(env.DSH_HOME, 'profiles/dsh-tui')
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
    const terminate = () => {
      try { process.kill(-boot.pid, 'SIGKILL') } catch (error) { if (error.code !== 'ESRCH') throw error }
    }
    const timeout = setTimeout(() => { terminate(); reject(new Error(`TUI startup timed out: ${output.slice(-2000)}`)) }, 20000)
    boot.onData(data => {
      output += data
      if (data.includes('\x1b[c')) boot.write('\x1b[?62c')
      if (data.includes('\x1b[6n')) boot.write('\x1b[1;1R')
      if (output.includes('Welcome to dsh-TUI')) {
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
  console.log('Nix runtime: DSH, profile upgrades, PTY, math rasters and full TUI startup passed')
} finally {
  rmSync(temporary, { recursive: true, force: true })
}
