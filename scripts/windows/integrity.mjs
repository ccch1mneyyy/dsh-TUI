/** Hash large offline archives without buffering the whole runtime in memory. */
import { createHash } from 'node:crypto'
import { closeSync, openSync, readSync } from 'node:fs'

export function sha256File(file) {
  const descriptor = openSync(file, 'r')
  const hash = createHash('sha256')
  const buffer = Buffer.allocUnsafe(1024 * 1024)
  try {
    let size
    while ((size = readSync(descriptor, buffer, 0, buffer.length, null)) !== 0) hash.update(buffer.subarray(0, size))
    return hash.digest('hex')
  } finally { closeSync(descriptor) }
}

export function verifyArchive(file, expected) {
  if (typeof expected !== 'string' || !/^[a-f\d]{64}$/.test(expected)) throw new Error('Invalid payload archive checksum')
  if (sha256File(file) !== expected) throw new Error('Payload archive checksum mismatch')
}
