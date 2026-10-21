import { lstatSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const LOG_BYTES = 64 * 1024
const LOG_COUNT = 4
const OWNED_FILE = /^dsh-tui-heap-watch-\d+-(\d+)-[0-9a-f-]{36}(?:\.log|-\d+mb\.heapsnapshot)(\.writing)?$/

/** Publish bounded, complete log files; each caller owns a unique filename. */
export function createHeapWatchLog(file: string): (line: string) => void {
  let tail: Buffer = Buffer.alloc(0)
  return line => {
    tail = Buffer.concat([tail, Buffer.from(line)]).subarray(-LOG_BYTES)
    const temporary = `${file}.writing`
    try {
      writeFileSync(temporary, tail)
      renameSync(temporary, file)
    } finally {
      try { unlinkSync(temporary) } catch { /* absent or unwritable */ }
    }
  }
}

/** Keep only completed diagnostics within budget; never reap a live writer. */
export function pruneHeapWatchFiles(directory: string, maxSnapshots: number, maxBytes: number): void {
  try {
    const files = readdirSync(directory).flatMap(name => {
      const match = OWNED_FILE.exec(name)
      if (!match) return []
      const file = join(directory, name)
      try {
        const stat = lstatSync(file)
        if (!stat.isFile()) return []
        if (match[2]) {
          // Only ESRCH proves that the owner is gone. EPERM, PID reuse and
          // other uncertainty leave the incomplete file alone.
          try { process.kill(Number(match[1]), 0) } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ESRCH') unlinkSync(file)
          }
          return []
        }
        return [{ file, log: name.endsWith('.log'), size: stat.size, time: stat.mtimeMs }]
      } catch { return [] } // Another sampler may already have removed it.
    }).sort((a, b) => b.time - a.time || b.file.localeCompare(a.file))
    let logs = 0
    let snapshots = 0
    let bytes = 0
    for (const file of files) {
      const keep = file.log
        ? ++logs <= LOG_COUNT
        : snapshots < maxSnapshots && bytes + file.size <= maxBytes
      if (keep && !file.log) {
        snapshots += 1
        bytes += file.size
      }
      if (!keep) {
        try { unlinkSync(file.file) } catch { /* retention is best effort */ }
      }
    }
  } catch { /* diagnostics must never prevent boot */ }
}
