/**
 * The digest of the vendored Codex app-server protocol types
 * (`src/backends/codex/protocol/generated/`): sha256 over every generated
 * file except the README, in sorted posix-path order, each entry framed as
 * `<path>\0<bytes>\0`. `scripts/codex-protocol-sync.mjs` writes it into
 * `src/backends/codex/contract.ts`; `verify:codex-contract` recomputes it, so
 * a hand edit of a generated file (or a sync that forgot the contract) fails
 * the build.
 */
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

/** Files of the generated tree that are not generator output. */
const NOT_GENERATED = new Set(['README.md'])

function walk(dir, out) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) walk(path, out)
    else out.push(path)
  }
  return out
}

/** `{ digest: 'sha256:<hex>', files: <count> }` of a generated tree. */
export function protocolDigest(dir) {
  const files = walk(dir, [])
    .map(path => ({ path, rel: relative(dir, path).split(sep).join('/') }))
    .filter(file => !NOT_GENERATED.has(file.rel))
    .sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
  const hash = createHash('sha256')
  for (const file of files) {
    hash.update(file.rel)
    hash.update('\0')
    hash.update(readFileSync(file.path))
    hash.update('\0')
  }
  return { digest: `sha256:${hash.digest('hex')}`, files: files.length }
}
