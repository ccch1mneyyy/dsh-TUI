/**
 * The Claude backend's kernel detection (what the picker's row says):
 *
 *  - an installed row always offers in-session login (`loginInSession`): a
 *    missing credential keeps the row selectable — switching kernels is
 *    never blocked on auth, `/login` (and `/channel`) work once the session
 *    is open;
 *  - the credential probe itself is unchanged and still passes through: an
 *    ambient env token reads ok, nothing reads missing (or unknown on
 *    darwin, whose login lives in the keychain).
 *
 * Both scenarios run in one isolated child (temp HOME/USERPROFILE/
 * CLAUDE_CONFIG_DIR/DSH_HOME, every ambient ANTHROPIC_ and CLAUDE_CODE_
 * variable scrubbed before the first import); the SDK peer resolves from
 * the checkout and the "CLI" is node itself, so no network and no spend.
 *
 * Run: node --import tsx/esm scripts/verify-claude-detect.ts
 */
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setLang } from '../src/i18n.js'

setLang('en')
let passed = 0
const check = (label: string, ok: boolean, detail?: unknown): void => {
  assert.ok(ok, detail === undefined ? label : `${label}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`)
  passed += 1
  console.log(`PASS ${label}`)
}

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

console.log(`\nverify-claude-detect OK (${passed} checks)`)
