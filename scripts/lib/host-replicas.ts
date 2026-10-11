/**
 * Fingerprints of the upstream bodies the standalone entry reproduces
 * (host-contract.ts HOST_REPLICAS): the sha256 of the bundled `lib/*.js` file
 * that declares the symbol at top level (read as text, never imported).
 * Coarser than the body alone: any change in that file asks for a review.
 */
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { HostReplica } from '../../src/dsh-adapter/host-contract.js'

/** The sha256 of the file declaring `replica` inside the package installed at `packageDir`. */
export function fingerprintReplica(packageDir: string, replica: HostReplica): string {
  const libDir = join(packageDir, 'lib')
  const declaration = replica.kind === 'const'
    ? new RegExp(`^(?:export\\s+)?const\\s+${replica.symbol}\\s*=`, 'mu')
    : new RegExp(`^(?:export\\s+)?(?:async\\s+)?function\\s*\\*?\\s*${replica.symbol}\\s*\\(`, 'mu')
  const sources = readdirSync(libDir).filter(name => name.endsWith('.js')).sort()
    .map(file => readFileSync(join(libDir, file), 'utf8'))
    .filter(source => declaration.test(source))
  if (sources.length === 0) throw new Error(`${replica.package}: no top-level ${replica.kind} ${replica.symbol} in lib/*.js`)
  // A chunk and an entry can both declare it only if the bundle duplicated it.
  return createHash('sha256').update(sources.join('\0')).digest('hex')
}
