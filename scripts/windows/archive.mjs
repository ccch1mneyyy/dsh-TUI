/** Indexed component archives: bounded parallel writes, with SHA-256 checked as each file is read. */
import { createHash } from 'node:crypto'
import { closeSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, writeSync } from 'node:fs'
import { availableParallelism } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isMainThread, Worker, workerData } from 'node:worker_threads'
import { DSH_PACKAGE, TUI_PACKAGE } from './policy.mjs'
import { assertSafePath, assertWithin } from './transaction.mjs'

export const COMPONENTS = ['common', 'dsh', 'tui', 'pnpm', 'node']
const packageRoots = { dsh: `global/node_modules/${DSH_PACKAGE}/`, tui: `global/node_modules/${TUI_PACKAGE}/`, pnpm: 'global/node_modules/pnpm/', node: 'node/' }
const profileRoot = packageRoots.tui
const chunkSize = 1024 * 1024

function componentFor(name) {
  return Object.keys(packageRoots).find(id => name.startsWith(packageRoots[id])) ?? 'common'
}

function writeAll(descriptor, buffer, size) {
  let written = 0
  while (written < size) written += writeSync(descriptor, buffer, written, size - written)
}

/** Called only by the builder; inputs are checked against the per-file manifest while packing. */
export function buildArchives(payload, files, out) {
  const archives = {}
  const buffer = Buffer.allocUnsafe(chunkSize)
  for (const id of COMPONENTS) {
    const output = openSync(join(out, `${id}.bin`), 'w')
    const hash = createHash('sha256')
    const entries = []
    try {
      for (const [name, expected] of Object.entries(files)) {
        if (componentFor(name) !== id) continue
        const source = assertWithin(join(payload, name), [payload])
        if (!lstatSync(source).isFile()) throw new Error(`Invalid payload file: ${name}`)
        const input = openSync(source, 'r')
        const fileHash = createHash('sha256')
        let size = 0
        try {
          let read
          while ((read = readSync(input, buffer, 0, buffer.length, null)) !== 0) {
            hash.update(buffer.subarray(0, read)); fileHash.update(buffer.subarray(0, read))
            writeAll(output, buffer, read); size += read
          }
        } finally { closeSync(input) }
        if (fileHash.digest('hex') !== expected) throw new Error(`Payload changed during packing: ${name}`)
        entries.push({ name, size })
      }
    } finally { closeSync(output) }
    archives[id] = { sha256: hash.digest('hex'), files: entries }
  }
  return archives
}

function validateName(name) {
  if (typeof name !== 'string' || name.split('/').some(part => !part || part === '.' || part === '..'
    || /[<>:"\\|?*\x00-\x1f]|[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
    throw new Error(`Invalid archive path: ${name}`)
  }
}

/** Reject malformed indexes before creating any output directory. */
export function archiveEntries(metadata) {
  if (metadata.archiveFormat !== 'indexed-v1' || metadata.schemaVersion !== 1 || !metadata.files
    || !metadata.archives || Object.keys(metadata.archives).length !== COMPONENTS.length) throw new Error('Invalid component archive manifest')
  const seen = new Set()
  const entries = []
  for (const id of COMPONENTS) {
    const archive = metadata.archives[id]
    if (!archive || !Array.isArray(archive.files) || !/^[a-f\d]{64}$/.test(archive.sha256)) throw new Error(`Invalid component archive: ${id}`)
    let offset = 0
    for (const { name, size } of archive.files) {
      validateName(name)
      if (!Object.hasOwn(metadata.files, name) || !/^[a-f\d]{64}$/.test(metadata.files[name]) || componentFor(name) !== id
        || seen.has(name.toLowerCase()) || !Number.isSafeInteger(size) || size < 0 || !Number.isSafeInteger(offset + size)) throw new Error(`Invalid archive entry: ${name}`)
      seen.add(name.toLowerCase())
      entries.push({ id, name, size, offset, hash: metadata.files[name] }); offset += size
    }
  }
  if (!entries.length || entries.length !== Object.keys(metadata.files).length) throw new Error('Archive file count mismatch')
  for (const { name } of entries) {
    let parent = name
    while (parent.includes('/')) {
      parent = parent.slice(0, parent.lastIndexOf('/'))
      if (seen.has(parent.toLowerCase())) throw new Error(`Archive file/directory conflict: ${name}`)
    }
  }
  return entries
}

export async function extractArchives({ metadata, selected, stage, payload, profile, roots }) {
  const entries = archiveEntries(metadata)
  if (!Array.isArray(selected) || new Set(selected).size !== selected.length || selected.some(id => !COMPONENTS.includes(id))) throw new Error('Invalid component selection')
  for (const id of selected) {
    const archive = assertSafePath(join(stage, `${id}.bin`), roots)
    const stat = lstatSync(archive)
    const size = entries.filter(entry => entry.id === id).reduce((total, entry) => total + entry.size, 0)
    if (!stat.isFile() || stat.size !== size) throw new Error(`Component archive size mismatch: ${id}`)
  }
  const tasks = entries.filter(entry => selected.includes(entry.id)).map(entry => ({ ...entry,
    destinations: [assertWithin(join(payload, entry.name), [payload]), ...(profile && entry.name.startsWith(profileRoot)
      ? [assertWithin(join(profile, entry.name.slice(profileRoot.length)), [profile])] : [])],
  }))
  for (const root of [payload, ...(profile ? [profile] : [])]) {
    assertSafePath(root, roots)
    mkdirSync(root) // A fresh directory prevents inherited links or unrelated files.
  }
  const directories = new Set(tasks.flatMap(entry => entry.destinations.map(dirname)))
  for (const directory of directories) mkdirSync(directory, { recursive: true })
  const count = Math.min(16, availableParallelism(), Math.ceil(tasks.length / 256)) || 1
  const results = await Promise.allSettled(Array.from({ length: count }, (_, id) => new Promise((complete, reject) => {
    const worker = new Worker(new URL(import.meta.url), { workerData: { stage, entries: tasks.filter((_, index) => index % count === id) } })
    let failure
    worker.once('error', error => { failure = error })
    worker.once('exit', code => failure || code !== 0 ? reject(failure ?? new Error(`Archive worker exited ${code}`)) : complete())
  })))
  // Wait for every writer before the caller is allowed to roll back or clean up.
  const failure = results.find(result => result.status === 'rejected')
  if (failure) throw failure.reason
}

function extractFiles({ stage, entries }) {
  const inputs = new Map()
  const buffer = Buffer.allocUnsafe(chunkSize)
  try {
    for (const entry of entries) {
      if (!inputs.has(entry.id)) inputs.set(entry.id, openSync(join(stage, `${entry.id}.bin`), 'r'))
      const outputs = []
      const hash = createHash('sha256')
      try {
        for (const destination of entry.destinations) outputs.push(openSync(destination, 'wx'))
        let copied = 0
        while (copied < entry.size) {
          const read = readSync(inputs.get(entry.id), buffer, 0, Math.min(buffer.length, entry.size - copied), entry.offset + copied)
          if (!read) throw new Error(`Truncated component archive: ${entry.id}`)
          hash.update(buffer.subarray(0, read))
          for (const output of outputs) writeAll(output, buffer, read)
          copied += read
        }
        if (hash.digest('hex') !== entry.hash) throw new Error(`Payload checksum mismatch: ${entry.name}`)
      } finally { for (const output of outputs) closeSync(output) }
    }
  } finally { for (const input of inputs.values()) closeSync(input) }
}

if (!isMainThread) extractFiles(workerData)
else if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await extractArchives(JSON.parse(readFileSync(process.argv[2], 'utf8'))) }
  catch (error) { console.error(error.stack ?? error); process.exitCode = 1 }
}
