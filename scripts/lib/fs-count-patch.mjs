/**
 * Preload counter for scripts/perf-session-scan.ts: wraps the CJS `node:fs`
 * surface with counting pass-throughs BEFORE the tsx loader (and with it the
 * ESM builtin wrappers every later import resolves against) initializes.
 * Counts only; never alters behavior. Installed via:
 *   node --import ./scripts/lib/fs-count-patch.mjs --import tsx/esm <script>
 * The counters live on globalThis[Symbol.for('dsh-tui.fs-count')] so the
 * probed script can read them without a second import path.
 */
import { createRequire } from 'node:module'
const fs = createRequire(import.meta.url)('node:fs')
const counters = { stat: 0, syncReadBytes: 0, promiseReadBytes: 0, promiseReads: 0, rename: 0, readdir: 0 }
globalThis[Symbol.for('dsh-tui.fs-count')] = counters

const wrapCounting = (original, key) => function (...args) {
  counters[key] += 1
  return original.apply(this, args)
}
const wrapBytes = original => function (fd, buffer, offset, length, position) {
  const read = original.call(this, fd, buffer, offset, length, position)
  counters.syncReadBytes += read
  return read
}
const { statSync, readSync, renameSync, readdirSync } = fs
fs.statSync = wrapCounting(statSync, 'stat')
fs.readSync = wrapBytes(readSync)
fs.renameSync = wrapCounting(renameSync, 'rename')
fs.readdirSync = wrapCounting(readdirSync, 'readdir')
const originalOpen = fs.promises.open.bind(fs.promises)
fs.promises.open = async (...args) => {
  const handle = await originalOpen(...args)
  const originalRead = handle.read.bind(handle)
  handle.read = async (...readArgs) => {
    counters.promiseReads += 1
    const result = await originalRead(...readArgs)
    counters.promiseReadBytes += result.bytesRead
    return result
  }
  return handle
}
