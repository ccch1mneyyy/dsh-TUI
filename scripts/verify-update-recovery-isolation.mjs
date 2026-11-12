/**
 * The real recovery regression must ignore launcher markers inherited from a
 * surrounding TUI/tool shell. Run it as a subprocess with disposable npm/pnpm
 * global installs outside its TMPDIR, then compare every outside entry and
 * reject any pnpm invocation. No real manager, registry or user home is used.
 * Requires a prior build. Run: node scripts/verify-update-recovery-isolation.mjs
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = fileURLToPath(new URL('..', import.meta.url))
const recovery = join(repo, 'scripts', 'verify-update-recovery.mjs')
const { resolveGlobalLauncherTarget } = await import('../lib/types/update.js')
const packageName = '@deepseek-harness-tui/dsh-tui'
const oldVersion = '0.0.1'
const isWindows = process.platform === 'win32'
const tempBase = realpathSync(tmpdir())
const root = mkdtempSync(join(tempBase, 'verify-recovery-isolation-'))

// Links are recorded, not followed: each snapshot concerns the fixture itself,
// and no path outside it may become writable just because a fixture links there.
function snapshot(directory, writableTmp) {
  const entries = []
  function walk(path) {
    if (path === writableTmp) return
    const stat = lstatSync(path)
    const name = relative(directory, path)
    if (stat.isSymbolicLink()) entries.push([name, 'link', readlinkSync(path)])
    else if (stat.isDirectory()) {
      entries.push([name, 'directory'])
      for (const child of readdirSync(path).sort()) walk(join(path, child))
    } else {
      entries.push([name, stat.mode & 0o777, createHash('sha256').update(readFileSync(path)).digest('hex')])
    }
  }
  walk(directory)
  return entries
}

function launcherPackage(directory) {
  mkdirSync(join(directory, 'bin'), { recursive: true })
  writeFileSync(join(directory, 'package.json'), JSON.stringify({
    name: packageName, version: oldVersion, type: 'module',
    bin: { 'dsh-tui': './bin/dsh-tui.js', dst: './bin/dsh-tui.js' },
  }))
  const bin = join(directory, 'bin', 'dsh-tui.js')
  writeFileSync(bin, '#!/usr/bin/env node\n// disposable external launcher, not a recovery fixture\n')
  chmodSync(bin, 0o755)
  return bin
}

function launcherShims(binDir, bin, cmdTarget) {
  mkdirSync(binDir, { recursive: true })
  for (const name of ['dsh-tui', 'dst']) {
    if (isWindows) {
      writeFileSync(join(binDir, `${name}.cmd`), `@echo off\r\n"${process.execPath}" "%~dp0\\${cmdTarget}" %*\r\n`)
    } else {
      symlinkSync(bin, join(binDir, name))
    }
  }
}

try {
  for (const scenario of ['npm-path', 'npm-version', 'pnpm-path']) {
    const outer = join(root, scenario)
    const childTmp = join(outer, 'recovery-tmp')
    const home = join(outer, 'home')
    const dshHome = join(outer, 'dsh-home')
    const guardBin = join(outer, 'guard-bin')
    for (const dir of [childTmp, home, dshHome, guardBin]) mkdirSync(dir, { recursive: true })
    const pnpmLog = join(outer, 'unexpected-pnpm.json')
    const pnpmGuard = join(guardBin, 'pnpm-guard.mjs')
    writeFileSync(pnpmGuard, `import { writeFileSync } from 'node:fs'\nwriteFileSync(${JSON.stringify(pnpmLog)}, JSON.stringify(process.argv.slice(2)))\nprocess.exit(99)\n`)
    if (isWindows) {
      writeFileSync(join(guardBin, 'pnpm.cmd'), `@echo off\r\n"${process.execPath}" "%~dp0pnpm-guard.mjs" %*\r\n`)
    } else {
      symlinkSync(process.execPath, join(guardBin, 'node'))
      writeFileSync(join(guardBin, 'pnpm'), '#!/bin/sh\nexec node "$(dirname "$0")/pnpm-guard.mjs" "$@"\n')
      chmodSync(join(guardBin, 'pnpm'), 0o755)
      // The recovery script's fake dsh uses dirname; provide it without adding
      // real package-manager directories to this subprocess's PATH.
      writeFileSync(join(guardBin, 'dirname'), '#!/bin/sh\nprintf \'%s\\n\' "${1%/*}"\n')
      chmodSync(join(guardBin, 'dirname'), 0o755)
    }

    const pnpmHome = join(outer, 'pnpm-home')
    let bin
    let binDir
    if (scenario === 'pnpm-path') {
      const group = join(pnpmHome, 'global', 'v11', 'fixture-group')
      bin = launcherPackage(join(group, 'node_modules', packageName))
      writeFileSync(join(group, 'package.json'), JSON.stringify({ dependencies: { [packageName]: oldVersion } }))
      binDir = join(pnpmHome, 'bin')
      launcherShims(binDir, bin, `..\\global\\v11\\fixture-group\\node_modules\\${packageName.replaceAll('/', '\\')}\\bin\\dsh-tui.js`)
    } else {
      const prefix = join(outer, 'npm-prefix')
      bin = launcherPackage(join(prefix, ...(isWindows ? [] : ['lib']), 'node_modules', packageName))
      binDir = isWindows ? prefix : join(prefix, 'bin')
      launcherShims(binDir, bin, `node_modules\\${packageName.replaceAll('/', '\\')}\\bin\\dsh-tui.js`)
    }
    mkdirSync(pnpmHome, { recursive: true })
    const env = {
      HOME: home, USERPROFILE: home, DSH_HOME: dshHome,
      TMPDIR: childTmp, TMP: childTmp, TEMP: childTmp,
      PATH: [guardBin, binDir, ...(isWindows ? [dirname(process.execPath)] : [])].join(delimiter),
      PNPM_HOME: pnpmHome,
      DSH_TUI_LANG: 'zh',
      DSH_TUI_LAUNCHER_VERSION: oldVersion,
      DSH_TUI_UPDATE_LAUNCHER: '1',
    }
    if (scenario !== 'npm-version') env.DSH_TUI_LAUNCHER_PATH = bin
    if (isWindows) {
      for (const key of ['ComSpec', 'SystemRoot', 'windir']) {
        if (process.env[key] !== undefined) env[key] = process.env[key]
      }
      env.PATHEXT = '.COM;.EXE;.BAT;.CMD'
    }
    const target = resolveGlobalLauncherTarget(env)
    assert.equal(target?.layout, scenario === 'pnpm-path' ? 'pnpm' : 'npm', `${scenario}: inherited launcher fixture is a recognized global install`)
    assert.equal(target?.version, oldVersion, `${scenario}: inherited launcher fixture really needs alignment`)
    const before = snapshot(outer, childTmp)
    const result = spawnSync(process.execPath, [recovery], {
      cwd: repo, env, encoding: 'utf8', timeout: 60000, maxBuffer: 1024 * 1024,
    })
    assert.equal(result.status, 0, `${scenario}: recovery must execute successfully\n${result.error ?? ''}\n${result.stdout}\n${result.stderr}`)
    for (const label of ['A: update succeeds after recovery', 'B: update succeeds after escalation', 'C: no replacement spawned']) {
      assert.ok(result.stdout.includes(`PASS: ${label}`), `${scenario}: recovery scenario executed: ${label}`)
    }
    assert.equal(existsSync(pnpmLog), false, `${scenario}: recovery must never invoke pnpm`)
    assert.deepEqual(snapshot(outer, childTmp), before, `${scenario}: recovery must not write outside its own temporary fixture`)
    console.log(`PASS: ${scenario}: real recovery runs, inherited global install unchanged, no pnpm invocation`)
  }
} finally {
  assert.equal(dirname(root), tempBase)
  assert.ok(relative(tempBase, root).startsWith('verify-recovery-isolation-'))
  assert.equal(realpathSync(root), resolve(root))
  rmSync(root, { recursive: true, force: true })
}
