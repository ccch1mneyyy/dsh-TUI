#!/usr/bin/env node
/**
 * Re-vendor the Codex app-server protocol types (docs/codex-backend-design.md
 * D3, §11 C0): run the given `codex` binary's own generator, replace
 * `src/backends/codex/protocol/generated/` with its output verbatim, write
 * the tree's README, and record the version and digest in
 * `src/backends/codex/contract.ts` (`PROTOCOL_VERSION`, `PROTOCOL_DIGEST`).
 *
 *   node scripts/codex-protocol-sync.mjs --bin <path to codex>
 *
 * The generator runs under a throwaway CODEX_HOME: it never reads or writes
 * the user's ~/.codex. Nothing here touches the network.
 *
 * After a sync: review the generated diff, add the version to
 * `VALIDATED_CODEX_VERSIONS` once the fixtures and §2 facts are re-checked,
 * then `pnpm build` (verify:codex-contract recomputes the digest).
 */
import { execFileSync } from 'node:child_process'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { protocolDigest } from './lib/codex-protocol-digest.mjs'

const ROOT = resolve(import.meta.dirname, '..')
const TARGET = join(ROOT, 'src', 'backends', 'codex', 'protocol', 'generated')
const CONTRACT = join(ROOT, 'src', 'backends', 'codex', 'contract.ts')

const binIndex = process.argv.indexOf('--bin')
const bin = binIndex === -1 ? undefined : process.argv[binIndex + 1]
if (bin === undefined || bin === '') {
  console.error('usage: node scripts/codex-protocol-sync.mjs --bin <path to codex>')
  process.exit(2)
}

const home = mkdtempSync(join(tmpdir(), 'codex-sync-home-'))
const out = mkdtempSync(join(tmpdir(), 'codex-sync-out-'))
try {
  const env = { ...process.env, CODEX_HOME: home }
  const versionText = execFileSync(bin, ['--version'], { env, encoding: 'utf8' })
  const version = /(\d+\.\d+\.\d+(?:-[\w.]+)?)/u.exec(versionText)?.[1]
  if (version === undefined) throw new Error(`cannot read a version from \`${bin} --version\`: ${versionText.trim()}`)
  execFileSync(bin, ['app-server', 'generate-ts', '--experimental', '--out', out], { env, stdio: ['ignore', 'ignore', 'inherit'] })

  rmSync(TARGET, { recursive: true, force: true })
  cpSync(out, TARGET, { recursive: true })
  writeFileSync(join(TARGET, 'README.md'), [
    '# Codex app-server protocol types (generated)',
    '',
    `Generated from \`codex-cli ${version}\` with:`,
    '',
    '```sh',
    'node scripts/codex-protocol-sync.mjs --bin <path to codex>',
    '# which runs: codex app-server generate-ts --experimental --out <dir>',
    '```',
    '',
    'Do not edit these files by hand: `verify:codex-contract` compares their digest with',
    '`PROTOCOL_DIGEST` in `../../contract.ts`. They are compile-time types only; every',
    'runtime value is narrowed from `unknown` (`../../narrow.ts`). Only `../index.ts`',
    're-exports what the backend uses.',
    '',
  ].join('\n'))

  const { digest, files } = protocolDigest(TARGET)
  const contract = readFileSync(CONTRACT, 'utf8')
  const next = contract
    .replace(/export const PROTOCOL_VERSION = '[^']*'/u, `export const PROTOCOL_VERSION = '${version}'`)
    .replace(/export const PROTOCOL_DIGEST = '[^']*'/u, `export const PROTOCOL_DIGEST = '${digest}'`)
  if (!next.includes(`PROTOCOL_DIGEST = '${digest}'`) || !next.includes(`PROTOCOL_VERSION = '${version}'`)) {
    throw new Error('contract.ts has no PROTOCOL_VERSION / PROTOCOL_DIGEST constants to update')
  }
  writeFileSync(CONTRACT, next)
  console.log(`codex protocol synced: codex-cli ${version}, ${files} files, ${digest}`)
  console.log('next: review the diff, update VALIDATED_CODEX_VERSIONS when validated, run `pnpm build`')
} finally {
  rmSync(home, { recursive: true, force: true })
  rmSync(out, { recursive: true, force: true })
}
