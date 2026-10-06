/**
 * Atomic replace of the small files a backend keeps (prefs, channel
 * profiles, the channel-token store; shared by every backend, D15): a same-directory temporary renamed
 * over the target. A reader — or another terminal's read-modify-write — sees
 * the old document or the new one, never a truncated one, and a failed write
 * leaves the old document in place. The temporary is created owner-only:
 * these files hold user choices and credentials.
 */
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Keeps two commits in the same millisecond on distinct temporaries. */
let sequence = 0

/** The cell `Atomics.wait` sleeps on between rename retries. */
const waitCell = new Int32Array(new SharedArrayBuffer(4))

/**
 * Windows can refuse the rename for a moment while another process holds
 * the target open (EPERM/EBUSY): on Windows that pair alone is retried with
 * a short synchronous pause. Any other refusal is real and thrown at once.
 */
function renameIntoPlace(temporary: string, target: string): void {
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(temporary, target)
      return
    } catch (error) {
      const code = typeof error === 'object' && error !== null ? String((error as NodeJS.ErrnoException).code) : ''
      if (process.platform !== 'win32' || attempt >= 7 || (code !== 'EPERM' && code !== 'EBUSY')) throw error
      Atomics.wait(waitCell, 0, 0, 2 ** attempt)
    }
  }
}

/** Replace `<dir>/<file>` with `text`. Throws when it cannot; the previous
 *  document is then intact and no temporary is left behind. */
export function writeFileAtomic(dir: string, file: string, text: string): void {
  const temporary = join(dir, `${file}.${process.pid}.${Date.now()}.${sequence++}.tmp`)
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(temporary, text, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
    renameIntoPlace(temporary, join(dir, file))
  } catch (error) {
    try {
      rmSync(temporary, { force: true })
    } catch {
      // The previous document is still intact; nothing else is safe to do.
    }
    throw error
  }
}
