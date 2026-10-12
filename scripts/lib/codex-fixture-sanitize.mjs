#!/usr/bin/env node
/**
 * Codex wire fixtures (`scripts/fixtures/codex/wire/*.jsonl`) are recorded
 * app-server traffic. Before one is committed it is scrubbed, and every
 * committed one is checked (docs/codex-backend-design.md §10.2):
 *
 *   node scripts/lib/codex-fixture-sanitize.mjs --check [dir]      # CI: fail on any finding
 *   node scripts/lib/codex-fixture-sanitize.mjs --write <in> <out> # scrub one recording
 *   node scripts/lib/codex-fixture-sanitize.mjs --rescrub [dir]    # re-apply the scrub in place
 *
 * Scrub (`--write`): every URL host outside {@link ALLOWED_HOSTS} becomes
 * `relay.invalid` (the relay's own host never needs to be named on the
 * command line); temporary directories become `/TMP/home` / `/TMP/cwd` /
 * `/TMP/...`; the machine-identifying remote-control fields are zeroed; the
 * `config/read` layer versions (`sha256:…` of a layer's contents — the
 * session-flags layer holds the relay URL) become `sha256:scrubbed`.
 *
 * Check (`--check`): a credential shape (`sk-…`, a Bearer header, a JWT), the
 * live key itself when `CODEX_TEST_API_KEY` is set, a URL host outside the
 * allowlist, a temporary or home directory path, an unscrubbed installation
 * id or layer hash fails. A fixture is never "fixed" by the check:
 * re-record or re-scrub it.
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

/** Hosts a fixture may name (public documentation and the placeholders). */
export const ALLOWED_HOSTS = new Set(['relay.invalid', 'developers.openai.com', 'api.openai.com', 'chatgpt.com', 'example.com', 'github.com'])

const ZERO_UUID = '00000000-0000-0000-0000-000000000000'

const SECRET_PATTERNS = [
  ['an API key (sk-…)', /\bsk-[A-Za-z0-9_-]{8,}/u],
  ['a Bearer credential', /\bBearer\s+[A-Za-z0-9._~+/-]{8,}/u],
  ['a JWT', /\beyJ[A-Za-z0-9_-]{6,}\.eyJ[A-Za-z0-9_-]{6,}\./u],
]
const PATH_PATTERNS = [
  ['a temporary directory', /(?<![A-Za-z])\/tmp\//u],
  ['a macOS temporary directory', /\/var\/folders\//u],
  ['a home directory', /(?<!\/TMP)\/home\/[A-Za-z0-9_.-]+\/|(?<!\/TMP)\/Users\/[A-Za-z0-9_.-]+\/|[A-Za-z]:\\\\Users\\\\/u],
]
const URL_HOST = /https?:\/\/([A-Za-z0-9.-]+)/gu

/** Scrub one recording's text. */
export function sanitizeFixture(text) {
  return text
    .replace(URL_HOST, (match, host) => (ALLOWED_HOSTS.has(host.toLowerCase()) ? match : match.replace(host, 'relay.invalid')))
    .replace(/\/tmp\/codex-[A-Za-z-]*home-[A-Za-z0-9]+/gu, '/TMP/home')
    .replace(/\/tmp\/codex-[A-Za-z-]*cwd-[A-Za-z0-9]+/gu, '/TMP/cwd')
    .replace(/(?<![A-Za-z])\/tmp\/[A-Za-z0-9._-]+/gu, '/TMP/dir')
    .replace(/"installationId":"[^"]*"/gu, `"installationId":"${ZERO_UUID}"`)
    // config/read layer versions hash a layer's contents (the session-flags
    // layer held the relay URL): never committed.
    .replace(/"version":"sha256:[0-9a-f]{16,}"/gu, '"version":"sha256:scrubbed"')
    .replace(/"serverName":"[^"]*"/gu, '"serverName":"ser000000000000"')
}

/** Findings of one fixture's text (`file:line: what`). A `.jsonl` file must
 *  parse line by line, a `.json` file (a golden) as a whole. */
export function checkFixture(text, file = 'fixture') {
  const findings = []
  if (file.endsWith('.json')) {
    try {
      JSON.parse(text)
    } catch {
      findings.push(`${file}: not JSON`)
    }
  }
  text.split('\n').forEach((line, index) => {
    const where = `${file}:${index + 1}`
    if (!file.endsWith('.json') && line.trim() !== '') {
      try {
        JSON.parse(line)
      } catch {
        findings.push(`${where}: not a JSON line`)
      }
    }
    for (const [label, pattern] of [...SECRET_PATTERNS, ...PATH_PATTERNS]) {
      if (pattern.test(line)) findings.push(`${where}: ${label}`)
    }
    // The live key itself, when this shell has it (never echoed).
    const key = process.env.CODEX_TEST_API_KEY
    if (key !== undefined && key.length >= 8 && line.includes(key)) findings.push(`${where}: the live API key`)
    if (/"version":"sha256:[0-9a-f]{16,}"/u.test(line)) findings.push(`${where}: an unscrubbed config layer hash`)
    for (const match of line.matchAll(URL_HOST)) {
      // The host itself is never echoed: it may be the private relay.
      if (!ALLOWED_HOSTS.has(match[1].toLowerCase())) findings.push(`${where}: a URL host outside the allowlist`)
    }
    const installation = /"installationId":"([^"]*)"/u.exec(line)
    if (installation !== null && installation[1] !== ZERO_UUID) findings.push(`${where}: an unscrubbed installationId`)
  })
  return findings
}

/** Check every `.jsonl` under `dir`. */
export function checkFixtureDir(dir) {
  const findings = []
  let files = 0
  const walk = path => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const full = join(path, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name.endsWith('.jsonl') || entry.name.endsWith('.json')) {
        files += 1
        findings.push(...checkFixture(readFileSync(full, 'utf8'), full))
      }
    }
  }
  walk(dir)
  return { files, findings }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [mode, a, b] = process.argv.slice(2)
  if (mode === '--write' && a !== undefined && b !== undefined) {
    const scrubbed = sanitizeFixture(readFileSync(a, 'utf8'))
    const findings = checkFixture(scrubbed, b)
    if (findings.length > 0) {
      console.error(findings.join('\n'))
      process.exit(1)
    }
    writeFileSync(b, scrubbed)
    console.log(`scrubbed ${a} -> ${b}`)
  } else if (mode === '--rescrub') {
    // Re-apply the scrub to committed fixtures in place (idempotent).
    const dir = resolve(a ?? join(import.meta.dirname, '..', 'fixtures', 'codex', 'wire'))
    for (const name of readdirSync(dir).filter(file => file.endsWith('.jsonl'))) {
      const path = join(dir, name)
      const before = readFileSync(path, 'utf8')
      const after = sanitizeFixture(before)
      if (after !== before) {
        writeFileSync(path, after)
        console.log(`rescrubbed ${name}`)
      }
    }
  } else if (mode === '--check') {
    const dir = resolve(a ?? join(import.meta.dirname, '..', 'fixtures', 'codex'))
    const { files, findings } = checkFixtureDir(dir)
    if (findings.length > 0) {
      console.error(`codex fixture check failed:\n${findings.join('\n')}`)
      process.exit(1)
    }
    if (files === 0) {
      console.error(`codex fixture check: no fixtures under ${dir}`)
      process.exit(1)
    }
    console.log(`codex fixture check OK (${files} files)`)
  } else {
    console.error('usage: codex-fixture-sanitize.mjs --check [dir] | --write <in> <out>')
    process.exit(2)
  }
}
