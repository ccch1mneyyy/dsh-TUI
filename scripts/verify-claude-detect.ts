/**
 * Offline kernel detection: installed rows offer in-session login; an SDK
 * miss preserves install guidance and optionally reports a local CLI.
 * Children use isolated homes and synthetic credentials. A copy of src/
 * without the SDK reaches the missing-peer branch; a counting CLI proves
 * resolution's version is reused rather than probed twice.
 *
 * Run: node --import tsx/esm scripts/verify-claude-detect.ts
 */
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { chmodSync, copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { setLang } from '../src/i18n.js'
import { VALIDATED_SDK_VERSION } from '../src/backends/claude/contract.js'
import { claudeText, installClaudeLocale } from '../src/backends/claude/text.js'
import { COUNT_LOG_ENV, PACKAGE_ENTRY, countingEntry, probeCalls } from './lib/claude-counting-cli.mjs'

setLang('en')
// The Claude dictionary reads the host's locale, not `setLang`: the parent
// renders the expectation for the child, which reports from an English host.
installClaudeLocale(() => 'en')
let passed = 0
const check = (label: string, ok: boolean, detail?: unknown): void => {
  assert.ok(ok, detail === undefined ? label : `${label}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`)
  passed += 1
  console.log(`PASS ${label}`)
}

/** The version the shared counting CLI reports in this script's fixture. */
const COUNTED_CLI_VERSION = '2.1.287'

// ── the isolated child: two detections over a scrubbed environment ───────────
{
  const home = mkdtempSync(join(tmpdir(), 'dshtui-claude-detect-'))
  const configDir = join(home, '.claude')
  const dshHome = join(home, '.dsh')
  mkdirSync(configDir, { recursive: true })
  mkdirSync(dshHome, { recursive: true })
  const backendUrl = new URL('../src/backends/claude/index.ts', import.meta.url).href
  const root = fileURLToPath(new URL('..', import.meta.url))
  const child = [
    "const [backendUrl, home, configDir, dshHome] = process.argv.slice(2)",
    "process.env.DSH_TUI_LANG = 'en'",
    "const fs = await import('node:fs')",
    "const path = await import('node:path')",
    "process.env.HOME = home",
    "process.env.USERPROFILE = home",
    "process.env.CLAUDE_CONFIG_DIR = configDir",
    "process.env.DSH_HOME = dshHome",
    "for (const key of Object.keys(process.env)) {",
    "  const upper = key.toUpperCase()",
    "  if (upper.startsWith('ANTHROPIC_') || upper === 'CLAUDECODE' || (upper.startsWith('CLAUDE_CODE_') && upper !== 'CLAUDE_CODE_EXECUTABLE')) delete process.env[key]",
    "}",
    "process.env.CLAUDE_CODE_EXECUTABLE = process.execPath",
    "const dataDir = path.join(home, '.dsh-tui', 'backends', 'claude')",
    "fs.mkdirSync(dataDir, { recursive: true })",
    "const detect = async backend => {",
    "  try {",
    "    const status = await backend.detect({ cwd: home, debug: () => undefined, warn: () => undefined })",
    "    return { installed: status.installed, auth: status.auth, loginInSession: status.loginInSession === true }",
    "  } catch (error) { return { crashed: error instanceof Error ? error.message : String(error) } }",
    "}",
    "const report = outcome => console.log('@@RESULT@@' + JSON.stringify(outcome))",
    "try {",
    "  const { claudeBackend } = await import(backendUrl)",
    // bare: no channel, nothing ambient — the row must still offer in-session login.
    "  const bare = await detect(claudeBackend)",
    // no channel, a token in the environment: ok through the unchanged ambient path.
    "  process.env.ANTHROPIC_AUTH_TOKEN = 'synthetic-env-token-not-real'",
    "  const ambient = await detect(claudeBackend)",
    "  report({ bare, ambient })",
    "} catch (error) {",
    "  report({ crashed: error instanceof Error ? error.message : String(error) })",
    "}",
  ].join('\n')
  const probe = join(home, 'detect-probe.mjs')
  writeFileSync(probe, child)
  type Row = { readonly installed?: boolean; readonly auth?: string; readonly loginInSession?: boolean; readonly crashed?: string }
  type Outcome = { readonly bare?: Row; readonly ambient?: Row; readonly crashed?: string }
  try {
    const ran = await new Promise<{ code: number | null; stdout: string; stderr: string }>(resolve => {
      execFile(process.execPath, ['--import', 'tsx/esm', probe, backendUrl, home, configDir, dshHome], {
        cwd: root,
        timeout: 60_000,
        env: { ...process.env, TMP: home, TEMP: home, TMPDIR: home },
      }, (error, stdout, stderr) => {
        resolve({ code: error === null ? 0 : (error.code ?? 1), stdout: String(stdout), stderr: String(stderr) })
      })
    })
    const line = ran.stdout.split(/\r?\n/u).find(l => l.startsWith('@@RESULT@@'))
    const parsed = line === undefined ? undefined : JSON.parse(line.slice('@@RESULT@@'.length)) as Outcome
    const outcomeText = JSON.stringify(parsed ?? {})
    const row = (name: keyof Outcome): Row | undefined => parsed?.[name]
    check('detect-backend: the isolated child ran and reported both scenarios',
      parsed !== undefined && parsed.crashed === undefined && ran.code === 0
        && row('bare')?.crashed === undefined && row('bare')?.installed === true
        && row('ambient')?.crashed === undefined && row('ambient')?.installed === true,
      { code: ran.code, stderr: ran.stderr.slice(0, 300), stdout: ran.stdout.slice(0, 300) })
    // On darwin the CLI keeps its login in the keychain: the bare case is
    // `unknown` there, not `missing` (detectClaudeAuth's platform rule).
    const bareAuth = process.platform === 'darwin' ? 'unknown' : 'missing'
    check('detect-backend: no credential anywhere still offers in-session login (the switch is never blocked)',
      row('bare')?.auth === bareAuth && row('bare')?.loginInSession === true, row('bare'))
    check('detect-backend: an ambient env token still reads ok',
      row('ambient')?.auth === 'ok' && row('ambient')?.loginInSession === true, row('ambient'))
    check('detect-backend: no synthetic credential material travels in the status',
      !outcomeText.includes('synthetic-env-token-not-real'), outcomeText.slice(0, 300))
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

// ── the SDK-missing branch: a copy of src/ has no SDK to resolve ────────────
{
  // Resolve from the copy, linking only yaml for channel-tokens.ts. Linking
  // the checkout's whole node_modules would make the SDK available again.
  const checkout = fileURLToPath(new URL('..', import.meta.url))
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'dshtui-claude-nosdk-')))
  const win = process.platform === 'win32'
  const systemRoot = process.env.SystemRoot ?? 'C:/Windows'
  const systemPath = win ? join(systemRoot, 'System32') : '/usr/bin:/bin'
  const home = join(root, 'home-native-cli')
  const bareHome = join(root, 'home-no-cli')
  const configDir = join(root, '.claude')
  const dshHome = join(root, '.dsh')
  // A native-directory wrapper forces one counting-entry run per probe.
  const cliPath = join(home, '.local', 'bin', win ? 'claude.exe' : 'claude')
  const cliEntry = countingEntry(join(home, '.local', 'bin'), COUNTED_CLI_VERSION)
  const cliLog = join(root, 'cli-probe-calls.log')
  mkdirSync(bareHome, { recursive: true })
  mkdirSync(configDir, { recursive: true })
  mkdirSync(dshHome, { recursive: true })
  // Keep separators native so POSIX can reach the same parser fixture.
  writeFileSync(cliPath, `"%dp0%${join(...PACKAGE_ENTRY)}" %*\n`)
  // An explicit, versionless CLI must still be reported by its path.
  const versionlessPath = join(root, win ? 'claude-versionless.exe' : 'claude-versionless')
  if (win) copyFileSync(join(systemRoot, 'System32', 'where.exe'), versionlessPath)
  else {
    writeFileSync(versionlessPath, '#!/bin/sh\necho definitely not a claude version\n')
    chmodSync(versionlessPath, 0o755)
  }
  cpSync(join(checkout, 'src'), join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module' }))
  mkdirSync(join(root, 'node_modules'), { recursive: true })
  symlinkSync(realpathSync(join(checkout, 'node_modules', 'yaml')), join(root, 'node_modules', 'yaml'), 'junction')
  const backendUrl = pathToFileURL(join(root, 'src', 'backends', 'claude', 'index.ts')).href
  const child = [
    "const [backendUrl, home, bareHome, versionlessCli, systemPath, configDir, dshHome, cliLog] = process.argv.slice(2)",
    "process.env.DSH_TUI_LANG = 'en'",
    "const fs = await import('node:fs')",
    "const path = await import('node:path')",
    "process.env.HOME = home",
    "process.env.USERPROFILE = home",
    "process.env.CLAUDE_CONFIG_DIR = configDir",
    "process.env.DSH_HOME = dshHome",
    `process.env.${COUNT_LOG_ENV} = cliLog`,
    // Allow the lookup tool and node, but fence out the machine's own CLI.
    "process.env.PATH = [home, path.dirname(process.execPath), systemPath].join(path.delimiter)",
    "for (const key of Object.keys(process.env)) {",
    "  const upper = key.toUpperCase()",
    "  if (upper.startsWith('ANTHROPIC_') || upper === 'CLAUDECODE' || upper.startsWith('CLAUDE_CODE_')) delete process.env[key]",
    "}",
    "const dataDir = path.join(home, '.dsh-tui', 'backends', 'claude')",
    "fs.mkdirSync(dataDir, { recursive: true })",
    "const debug = []",
    "const host = { cwd: home, locale: () => 'en', debug: message => debug.push(message), warn: () => undefined }",
    "const detect = async backend => {",
    "  try {",
    "    const status = await backend.detect(host)",
    "    return { installed: status.installed, hint: status.hint, version: status.version }",
    "  } catch (error) { return { crashed: error instanceof Error ? error.message : String(error) } }",
    "}",
    "const report = outcome => console.log('@@RESULT@@' + JSON.stringify(outcome))",
    "try {",
    "  const { claudeBackend } = await import(backendUrl)",
    // The CLI is there, the SDK is not: the branch AC-5 is about.
    "  const withCli = await detect(claudeBackend)",
    // The same machine with no CLI anywhere: a bare home, the PATH above and
    // no CLAUDE_CODE_EXECUTABLE.
    "  process.env.HOME = bareHome",
    "  process.env.USERPROFILE = bareHome",
    "  const withoutCli = await detect(claudeBackend)",
    "  process.env.CLAUDE_CODE_EXECUTABLE = versionlessCli",
    "  const pathOnly = await detect(claudeBackend)",
    "  report({ withCli, withoutCli, pathOnly, debug })",
    "} catch (error) {",
    "  report({ crashed: error instanceof Error ? error.message : String(error) })",
    "}",
  ].join('\n')
  const probe = join(root, 'sdk-missing-probe.mjs')
  writeFileSync(probe, child)
  type Row = { readonly installed?: boolean; readonly hint?: string; readonly version?: string; readonly crashed?: string }
  type Outcome = { readonly withCli?: Row; readonly withoutCli?: Row; readonly pathOnly?: Row; readonly debug?: readonly string[]; readonly crashed?: string }
  const expected = claudeText('claude-sdk-missing', { version: VALIDATED_SDK_VERSION })
  try {
    const ran = await new Promise<{ code: number | null; stdout: string; stderr: string }>(resolve => {
      execFile(process.execPath, ['--import', 'tsx/esm', probe, backendUrl, home, bareHome, versionlessPath, systemPath, configDir, dshHome, cliLog], {
        cwd: checkout,
        timeout: 60_000,
        env: { ...process.env, TMP: root, TEMP: root, TMPDIR: root },
      }, (error, stdout, stderr) => {
        resolve({ code: error === null ? 0 : (error.code ?? 1), stdout: String(stdout), stderr: String(stderr) })
      })
    })
    const line = ran.stdout.split(/\r?\n/u).find(l => l.startsWith('@@RESULT@@'))
    const parsed = line === undefined ? undefined : JSON.parse(line.slice('@@RESULT@@'.length)) as Outcome
    const withCli = parsed?.withCli
    const withoutCli = parsed?.withoutCli
    const pathOnly = parsed?.pathOnly
    const hint = withCli?.hint ?? ''
    const lines = hint.split('\n')
    const detected = (row: Row | undefined): boolean => row?.crashed === undefined && row?.installed === false
    check('detect-backend: the copied child resolves no SDK and still detects every CLI shape',
      parsed !== undefined && parsed.crashed === undefined && ran.code === 0
        && detected(withCli) && detected(withoutCli) && detected(pathOnly),
      { code: ran.code, stderr: ran.stderr.slice(0, 300), stdout: ran.stdout.slice(0, 300) })
    // Verify the SDK import failed, rather than an unrelated child error.
    check('detect-backend: loadClaudeSdk() is the import that failed in that child',
      (parsed?.debug ?? []).some(message => message.includes('SDK import failed') && message.includes('claude-agent-sdk')),
      parsed?.debug)
    check('AC-5 a CLI found without the SDK travels in the detection payload (version or path)',
      hint === `${expected}\n${claudeText('claude-sdk-missing-found-cli', { version: COUNTED_CLI_VERSION, path: cliEntry })}`, hint)
    check('#1920 the installed CLI version reaches the kernel row even when the SDK is missing',
      withCli?.version === COUNTED_CLI_VERSION, withCli)
    check('#1920 absent and versionless CLIs do not gain a fabricated version',
      withoutCli?.version === undefined && pathOnly?.version === undefined, { withoutCli, pathOnly })
    check('AC-5 the install guidance stays word for word, the found CLI on a line of its own',
      lines.length === 2 && lines[0] === expected && (lines[1] ?? '').trim() !== '', lines)
    check('AC-5 a CLI that answers no version is still reported, by its path',
      (pathOnly?.hint ?? '').startsWith(`${expected}\n`) && (pathOnly?.hint ?? '').includes(versionlessPath), pathOnly?.hint)
    check('AC-6 without any CLI the hint is the plain SDK-missing sentence, word for word',
      withoutCli?.hint === expected, { got: withoutCli?.hint, expected })
    // The payload proves the fixture ran; the log distinguishes one probe from two.
    check('F-2 the SDK-missing branch that found a CLI probes it once, not twice',
      probeCalls(cliLog).length === 1, { calls: probeCalls(cliLog), hint })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

console.log(`\nverify-claude-detect OK (${passed} checks)`)
