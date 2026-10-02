/**
 * Local-disk fallback for the `fs` service surface the channel reads
 * (`@` mention expansion, file completion). A DSH composition mounts the
 * host's fs service (which may be remote); a session served by another
 * backend may run without it, and its working directory is then the local
 * disk this process sees. Read-only: nothing here writes.
 */
import { open, readdir, readFile, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { MentionFs } from './types.js'

export function createLocalFs(): MentionFs {
  return {
    resolve: path => Promise.resolve({ displayPath: resolve(path) }),
    async stat(target) {
      try {
        const info = await stat(target.displayPath)
        return { type: info.isFile() ? 'file' : info.isDirectory() ? 'directory' : 'other' }
      } catch {
        return undefined
      }
    },
    readText: target => readFile(target.displayPath, 'utf8'),
    async readBytes(target, signal, maxBytes) {
      signal?.throwIfAborted()
      const handle = await open(target.displayPath, 'r')
      try {
        const size = (await handle.stat()).size
        if (size > maxBytes) throw new Error(`dsh-tui: ${target.displayPath} exceeds ${maxBytes} bytes`)
        const buffer = new Uint8Array(size)
        await handle.read(buffer, 0, size, 0)
        return buffer
      } finally {
        await handle.close()
      }
    },
    async listDir(target) {
      const entries = await readdir(target.displayPath, { withFileTypes: true })
      return entries.map(entry => ({
        name: entry.name,
        type: entry.isFile() ? 'file' as const : entry.isDirectory() ? 'directory' as const : 'other' as const,
      }))
    },
  }
}
