/**
 * Deterministic UUIDv5 for migration ids.
 *
 * Re-importing the same source conversation must land on the SAME DSH
 * session id, so repeats overwrite their own copy instead of stacking
 * duplicates — the id IS the dedupe. Inline SHA-1 RFC 4122 variant (no
 * runtime dependency; node:crypto does the hashing).
 *
 * @module @deepseek-harness-tui/dsh-tui/migrate/uuid
 */
import { createHash } from 'node:crypto'

/** This project's migration namespace: dsh-tui-migrate as 16 fixed bytes. */
const NAMESPACE = Buffer.from([0x9f, 0x1d, 0x3a, 0x72, 0x6c, 0x55, 0x4c, 0x8e, 0xb0, 0x2f, 0x6d, 0x69, 0x67, 0x72, 0x61, 0x74])

/**
 * RFC 4122 UUIDv5 over the migration namespace.
 * @param name - The distinguishing name (e.g. `claude-code:<file uuid>`).
 * @returns Dashed lowercase uuid v5.
 */
export function migrationUuid(name: string): string {
  const hash = createHash('sha1').update(NAMESPACE).update(name, 'utf8').digest()
  hash[6] = (hash[6]! & 0x0f) | 0x50
  hash[8] = (hash[8]! & 0x3f) | 0x80
  const hex = hash.subarray(0, 16).toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
}
