/**
 * The host entry's pure routing parts: `entryKernel`, `configuredBackend`,
 * `restartArgv`, `findHostDsh`
 * across npm/pnpm/volta/wrapper shims, and launcher-path expansion under
 * `path.win32` rules (no Windows needed). The launcher half (bin/dsh-tui.js)
 * is in verify-launcher.mjs.
 *
 * Run: node --import tsx/esm scripts/verify-host-entry.ts
 */
import './lib/fake-home.mjs'
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join, win32 } from 'node:path'
import { configuredBackend, entryKernel } from '../src/hostEntryRoute.js'
import { findHostDsh, launcherScriptPaths, resolveLauncherPath } from '../src/dsh-adapter/host-dsh.js'
import { stripResumeArgs } from '../src/sessionHistory.js'
import { restartArgv } from '../src/update.js'
import type { KernelBackendId } from '../src/kernelPrefs.js'

let passed = 0
const check = (label: string, ok: boolean, detail?: unknown): void => {
  assert.ok(ok, detail === undefined ? label : `${label}: ${JSON.stringify(detail)}`)
  passed += 1
  console.log(`PASS ${label}`)
}

const root = mkdtempSync(join(tmpdir(), 'verify-host-entry-'))
const memory = join(root, 'kernel.json')
const noMemory = join(root, 'absent.json')
writeFileSync(memory, JSON.stringify({ backend: 'claude' }))
/** A remembered kernel that is not installed: the registry's half rejects it. */
const ghostMemory = join(root, 'kernel-ghost.json')
writeFileSync(ghostMemory, JSON.stringify({ backend: 'ghost-backend' }))

// ── entryKernel ───────────────────────────────────────────────────────
check('nothing set: dsh', entryKernel({}, { memoryFile: noMemory }) === 'dsh')
check('kernel.json: claude', entryKernel({}, { memoryFile: memory }) === 'claude')
check('DSH_TUI_BACKEND beats kernel.json', entryKernel({ DSH_TUI_BACKEND: 'dsh' }, { memoryFile: memory }) === 'dsh')
check('an invalid DSH_TUI_BACKEND means dsh, not the memory', entryKernel({ DSH_TUI_BACKEND: 'nope' }, { memoryFile: memory }) === 'dsh')
check('a legal but uninstalled id means dsh too (membership is the registry\'s half)',
  entryKernel({ DSH_TUI_BACKEND: 'ghost-backend' }, { memoryFile: memory }) === 'dsh')
check('an uninstalled kernel.json entry does not decide the boot either',
  entryKernel({}, { memoryFile: ghostMemory }) === 'dsh')
check('the Config row beats DSH_TUI_BACKEND', entryKernel({ DSH_TUI_BACKEND: 'claude' }, { configured: 'dsh', memoryFile: noMemory }) === 'dsh')
check('a handoff beats the Config row', entryKernel({ DSH_TUI_BACKEND_HANDOFF: 'claude' }, { configured: 'dsh', memoryFile: noMemory }) === 'claude')

// ── configuredBackend ─────────────────────────────────────────────────
const patch = join(root, 'cordis.patch.yml')
check('no patch file: no pin', configuredBackend('x', patch) === undefined)
writeFileSync(patch, '- id: other\n  config: { backend: claude }\n- id: dsh-tui\n  config:\n    preset: !!js process.env.DSH_TUI_PRESET\n    backend: Claude\n')
check('the dsh-tui row\'s backend, normalized', configuredBackend('x', patch) === 'claude')
writeFileSync(patch, '- id: dsh-tui\n  config:\n    backend: !!js process.env.DSH_TUI_BACKEND\n')
check('a !!js backend is no pin', configuredBackend('x', patch) === undefined)
writeFileSync(patch, '- id: dsh-tui\n  config:\n    lang: en\n')
check('a row without backend is no pin', configuredBackend('x', patch) === undefined)
writeFileSync(patch, '- id: dsh-tui\n  config:\n    backend: ghost-backend\n')
check('a row naming an uninstalled backend is no pin', configuredBackend('x', patch) === undefined)

// ── restartArgv ───────────────────────────────────────────────────────
const entry = '/pkg/lib/types/dsh-adapter/host-entry.js'
const dshArgv = ['/node', '/dsh/lib/bin.js', '--profile', 'dsh-tui', '--', '--resume', 'abc', 'foo']
check('a kernel switch from dsh relaunches the entry with the app args, resume dropped',
  JSON.stringify(restartArgv({ execArgv: ['--x'], argv: dshArgv, switching: true, hostEntry: entry })) === JSON.stringify(['--x', entry, 'foo']),
  restartArgv({ execArgv: ['--x'], argv: dshArgv, switching: true, hostEntry: entry }))
check('a /restart under dsh moves to the entry, resume kept',
  JSON.stringify(restartArgv({ execArgv: [], argv: dshArgv, switching: false, hostEntry: entry })) === JSON.stringify([entry, '--resume', 'abc', 'foo']))
check('without the entry path the dsh argv is replayed as before',
  JSON.stringify(restartArgv({ execArgv: [], argv: dshArgv, switching: true, hostEntry: undefined })) === JSON.stringify(stripResumeArgs(dshArgv.slice(1))))
const entryArgv = ['/node', entry, '--resume', 'abc', 'foo']
check('the entry relaunches itself on a switch',
  JSON.stringify(restartArgv({ execArgv: [], argv: entryArgv, switching: true, hostEntry: entry })) === JSON.stringify([entry, 'foo']))
check('the entry is not re-targeted',
  JSON.stringify(restartArgv({ execArgv: [], argv: entryArgv, switching: false, hostEntry: entry })) === JSON.stringify(entryArgv.slice(1)))
check('a fresh /restart (after /new) on the entry drops the inherited resume flags',
  JSON.stringify(restartArgv({ execArgv: [], argv: entryArgv, switching: false, fresh: true, hostEntry: entry })) === JSON.stringify([entry, 'foo']))
check('a fresh /restart under dsh drops them too',
  JSON.stringify(restartArgv({ execArgv: [], argv: dshArgv, switching: false, fresh: true, hostEntry: undefined })) === JSON.stringify(stripResumeArgs(dshArgv.slice(1))))
const noSeparator = ['/node', '/dsh/lib/bin.js', '--profile', 'dsh-tui']
check('a dsh argv without app args gives the entry none',
  JSON.stringify(restartArgv({ execArgv: [], argv: noSeparator, switching: true, hostEntry: entry })) === JSON.stringify([entry]))

// ── findHostDsh: the first dsh on PATH, followed through launchers ───
// A fake installed host: <prefix>/lib/node_modules/@deepseek-ai/dsh.
const prefix = join(root, 'prefix')
const hostDir = join(prefix, 'lib', 'node_modules', '@deepseek-ai', 'dsh')
mkdirSync(join(hostDir, 'lib'), { recursive: true })
writeFileSync(join(hostDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.2.0-rc.2' }))
writeFileSync(join(hostDir, 'lib', 'bin.js'), '#!/usr/bin/env node\n')
const binDir = (name: string): string => {
  const dir = join(root, name)
  mkdirSync(dir, { recursive: true })
  return dir
}
const located = (dir: string, env: NodeJS.ProcessEnv = {}, platform: NodeJS.Platform = 'linux') => findHostDsh({ PATH: dir, ...env }, platform)
// npm on Unix: a link into the package.
const npmBin = binDir('npm-bin')
symlinkSync(join(hostDir, 'lib', 'bin.js'), join(npmBin, 'dsh'))
check('an npm link resolves by realpath', JSON.stringify(located(npmBin)) === JSON.stringify({ packageDir: hostDir, via: 'link' }), located(npmBin))
// pnpm's global bin: a cmd-shim sh script relative to its own directory.
const pnpmHome = binDir('pnpm-home')
const pnpmGlobal = join(pnpmHome, 'global', '5', 'node_modules', '@deepseek-ai')
mkdirSync(pnpmGlobal, { recursive: true })
symlinkSync(hostDir, join(pnpmGlobal, 'dsh'))
writeFileSync(join(pnpmHome, 'dsh'), `#!/bin/sh
basedir=$(dirname "$(echo "$0" | sed -e 's,\\\\,/,g')")

case \`uname\` in
    *CYGWIN*) basedir=\`cygpath -w "$basedir"\`;;
esac

if [ -z "$NODE_PATH" ]; then
  export NODE_PATH="${pnpmHome}/global/5/.pnpm/node_modules"
fi
if [ -x "$basedir/node" ]; then
  exec "$basedir/node"  "$basedir/global/5/node_modules/@deepseek-ai/dsh/lib/bin.js" "$@"
else
  exec node  "$basedir/global/5/node_modules/@deepseek-ai/dsh/lib/bin.js" "$@"
fi
`)
chmodSync(join(pnpmHome, 'dsh'), 0o755)
check('a pnpm cmd-shim script resolves through the script it starts', 'packageDir' in located(pnpmHome) && (located(pnpmHome) as { packageDir: string; via: string }).packageDir === realpathSync(hostDir) && (located(pnpmHome) as { via: string }).via === 'shim', located(pnpmHome))
// A hand-written wrapper with an absolute path.
const wrapperBin = binDir('wrapper-bin')
writeFileSync(join(wrapperBin, 'dsh'), `#!/bin/sh\nexec /usr/bin/node '${join(hostDir, 'lib', 'bin.js')}' "$@"\n`)
check('a wrapper script with an absolute path resolves', (located(wrapperBin) as { via?: string }).via === 'shim', located(wrapperBin))
// npm's Windows .cmd shim, parsed (not beside a node_modules here).
const cmdBin = binDir('cmd-bin')
const cmdModules = join(cmdBin, 'node_modules', '@deepseek-ai')
mkdirSync(cmdModules, { recursive: true })
symlinkSync(hostDir, join(cmdModules, 'dsh'))
writeFileSync(join(cmdBin, 'dsh.cmd'), '@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js" %*\r\n')
check('script paths in an npm .cmd shim are found', launcherScriptPaths(readFileSync(join(cmdBin, 'dsh.cmd'), 'utf8')).includes('%dp0%\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js'))
// A script that starts something else, a binary, an empty PATH: no host, and why.
const otherBin = binDir('other-bin')
writeFileSync(join(otherBin, 'dsh'), '#!/bin/sh\nexec node "$basedir/../somewhere/else/cli.js" "$@"\n')
const other = located(otherBin)
check('a launcher that starts no dsh script: no host, with the reason', 'reason' in other && other.reason.includes('launcher script'), other)
const binaryBin = binDir('binary-bin')
writeFileSync(join(binaryBin, 'dsh'), Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 0, 0, 0]))
const binary = located(binaryBin)
check('a binary that is not volta: no host, with the reason', 'reason' in binary && binary.reason.includes('neither a link'), binary)
const voltaHome = join(root, 'volta')
const voltaBin = binDir('volta/bin')
writeFileSync(join(root, 'volta-shim'), Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 0]))
symlinkSync(join(root, 'volta-shim'), join(voltaBin, 'dsh'))
const voltaImage = join(voltaHome, 'tools', 'image', 'packages', '@deepseek-ai', 'dsh', 'lib', 'node_modules', '@deepseek-ai')
mkdirSync(voltaImage, { recursive: true })
symlinkSync(hostDir, join(voltaImage, 'dsh'))
check('a volta shim resolves through volta\'s package image', (located(voltaBin, { VOLTA_HOME: voltaHome }) as { via?: string }).via === 'volta', located(voltaBin, { VOLTA_HOME: voltaHome }))
const nothing = located(binDir('empty-bin'))
check('no dsh on PATH: no host, with the reason', 'reason' in nothing && nothing.reason === 'no dsh on PATH', nothing)
check('the first dsh on PATH decides (a non-host first hides a host later)', 'reason' in findHostDsh({ PATH: [otherBin, npmBin].join(delimiter) }, 'linux'))

// ── win32 launcher paths (expansion only: no Windows file system here) ─
const npmPrefix = 'C:\\Users\\me\\AppData\\Roaming\\npm'
const hostBin = win32.join(npmPrefix, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
const cmdShim = '@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n\r\nIF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n) ELSE (\r\n  SET "_prog=node"\r\n  SET PATHEXT=%PATHEXT:;.JS;=;%\r\n)\r\n\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js" %*\r\n'
const cmdScripts = launcherScriptPaths(cmdShim)
check('win32: the .cmd shim yields its script path', JSON.stringify(cmdScripts) === JSON.stringify(['%dp0%\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js']), cmdScripts)
check('win32: %dp0% expands against the shim directory', resolveLauncherPath(cmdScripts[0]!, npmPrefix, 'win32') === hostBin, resolveLauncherPath(cmdScripts[0]!, npmPrefix, 'win32'))
check('win32: %~dp0 (trailing separator) expands to the same file', resolveLauncherPath('%~dp0\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js', npmPrefix, 'win32') === hostBin)
const ps1Shim = '#!/usr/bin/env pwsh\n$basedir=Split-Path $MyInvocation.MyCommand.Definition -Parent\n\n$exe=""\nif ($PSVersionTable.PSVersion -lt "6.0" -or $IsWindows) {\n  $exe=".exe"\n}\n$ret=0\nif (Test-Path "$basedir/node$exe") {\n  if ($MyInvocation.ExpectingInput) {\n    $input | & "$basedir/node$exe"  "$basedir/node_modules/@deepseek-ai/dsh/lib/bin.js" $args\n  } else {\n    & "$basedir/node$exe"  "$basedir/node_modules/@deepseek-ai/dsh/lib/bin.js" $args\n  }\n  $ret=$LASTEXITCODE\n}\nexit $ret\n'
const ps1Scripts = launcherScriptPaths(ps1Shim)
check('win32: the .ps1 shim yields its script path once', JSON.stringify(ps1Scripts) === JSON.stringify(['$basedir/node_modules/@deepseek-ai/dsh/lib/bin.js']), ps1Scripts)
check('win32: $basedir with forward slashes resolves to the backslashed file', resolveLauncherPath(ps1Scripts[0]!, npmPrefix, 'win32') === hostBin, resolveLauncherPath(ps1Scripts[0]!, npmPrefix, 'win32'))
check('win32: $PSScriptRoot expands like $basedir', resolveLauncherPath('$PSScriptRoot\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js', npmPrefix, 'win32') === hostBin)
check('win32: a script relative to the shim directory resolves against it', resolveLauncherPath('..\\lib\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js', 'D:\\tools\\bin', 'win32') === 'D:\\tools\\lib\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js')
check('win32: an absolute script on another drive stays as written', resolveLauncherPath('E:\\dsh\\lib\\bin.js', npmPrefix, 'win32') === 'E:\\dsh\\lib\\bin.js')
check('win32: a UNC shim directory keeps its share', resolveLauncherPath('%dp0%\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js', '\\\\server\\share\\npm', 'win32') === '\\\\server\\share\\npm\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js')
check('win32: another variable (%APPDATA%) is not followed', resolveLauncherPath('%APPDATA%\\npm\\bin.js', npmPrefix, 'win32') === undefined)
check('posix: backslashes in a unix launcher become separators', resolveLauncherPath('$basedir\\..\\lib\\bin.js', '/opt/dsh/bin', 'linux') === '/opt/dsh/lib/bin.js')

console.log(`\nverify-host-entry: ${passed} checks passed`)
