/**
 * Asynchronous file IO shared by the adapters' summary scans.
 *
 * A browse scan runs while the session screen is on screen, so it never
 * blocks the render loop: directory walks use `fs/promises` and yield to the
 * event loop every few entries, artifacts are read by bounded head/tail
 * windows instead of whole, and an unchanged artifact (same mtime and size)
 * is not read at all when the caller already has its summary.
 *
 * @module @deepseek-harness-tui/dsh-tui/migrate/adapters/scan-fs
 */
import { open, readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { Fingerprint, ForeignSessionSummary, LoadSkip, ScanEntry, ScanOptions } from '../types.js'

/** Largest artifact a full load reads (a larger one is reported, not read). */
export const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024

/** Head windows tried in order: most prompts sit in the first few KB, but a
 *  large preamble (Codex base instructions, Claude snapshots) can push the
 *  first prompt further. */
export const HEAD_WINDOWS: readonly number[] = [32 * 1024, 256 * 1024]

/** Entries handled between two event-loop yields. */
const YIELD_EVERY = 32

const yieldToLoop = (): Promise<void> => new Promise(resolve => setImmediate(resolve))

/** One file the walk matched. */
export interface WalkedFile {
  readonly path: string
  readonly dir: string
  readonly name: string
}

export interface WalkOptions {
  readonly maxDepth: number
  readonly match: (name: string) => boolean
  /** Directory names never descended into. */
  readonly skipDirs?: readonly string[]
  readonly signal?: AbortSignal
}

/** Walk roots breadth-unbounded, depth-bounded; unreadable directories cost themselves only. */
export async function* walkFiles(roots: readonly string[], options: WalkOptions): AsyncGenerator<WalkedFile> {
  let handled = 0
  const walk = async function* (dir: string, depth: number): AsyncGenerator<WalkedFile> {
    if (depth > options.maxDepth) return
    options.signal?.throwIfAborted()
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (++handled % YIELD_EVERY === 0) {
        await yieldToLoop()
        options.signal?.throwIfAborted()
      }
      if (entry.isDirectory()) {
        if (options.skipDirs?.includes(entry.name) !== true) yield* walk(join(dir, entry.name), depth + 1)
      } else if (entry.isFile() && options.match(entry.name)) {
        yield { path: join(dir, entry.name), dir, name: entry.name }
      }
    }
  }
  for (const root of roots) yield* walk(root, 0)
}

/** mtime + size of one file, or undefined when it vanished. */
export async function fingerprintOf(path: string): Promise<Fingerprint | undefined> {
  try {
    const info = await stat(path)
    return { mtimeMs: info.mtimeMs, size: info.size }
  } catch {
    return undefined
  }
}

/**
 * The first `bytes` of a file as whole lines: a window that ends mid-line
 * drops the partial line (the cut happens on bytes, before decoding, so no
 * character is split either).
 */
export async function readHead(path: string, bytes: number): Promise<string> {
  const handle = await open(path, 'r')
  try {
    const buffer = Buffer.alloc(bytes)
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0)
    if (bytesRead < bytes) return buffer.subarray(0, bytesRead).toString('utf8')
    const lastNewline = buffer.lastIndexOf(0x0a)
    return buffer.subarray(0, lastNewline === -1 ? 0 : lastNewline + 1).toString('utf8')
  } finally {
    await handle.close()
  }
}

/** The last `bytes` of a file as whole lines (the partial first line is dropped). */
export async function readTail(path: string, bytes: number, size: number): Promise<string> {
  if (size <= bytes) return readFile(path, 'utf8')
  const handle = await open(path, 'r')
  try {
    const buffer = Buffer.alloc(bytes)
    const { bytesRead } = await handle.read(buffer, 0, bytes, size - bytes)
    const firstNewline = buffer.indexOf(0x0a)
    return firstNewline === -1 ? '' : buffer.subarray(firstNewline + 1, bytesRead).toString('utf8')
  } finally {
    await handle.close()
  }
}

/**
 * Read growing head windows until `accept` finds what it needs (or the whole
 * file has been seen).
 * @returns The first accepted result, or the result for the largest window.
 */
export async function withHead<T>(path: string, size: number, accept: (head: string, whole: boolean) => T | undefined): Promise<T | undefined> {
  for (const window of HEAD_WINDOWS) {
    const whole = size <= window
    const result = accept(whole ? await readFile(path, 'utf8') : await readHead(path, window), whole)
    if (result !== undefined || whole) return result
  }
  return undefined
}

/** Whole text of an artifact for a full load, or the reason it cannot be read. */
export async function loadText(path: string): Promise<string | LoadSkip> {
  const fp = await fingerprintOf(path)
  if (fp === undefined) return { skip: 'missing' }
  if (fp.size > MAX_ARTIFACT_BYTES) return { skip: 'too-large' }
  try {
    return await readFile(path, 'utf8')
  } catch {
    return { skip: 'missing' }
  }
}

/** One candidate artifact of a scan. */
export interface ScanCandidate {
  readonly ref: string
  readonly fp: Fingerprint
}

/** Artifacts stat-ed and summarized at once during a scan. */
const SCAN_CONCURRENCY = 16

/**
 * The shared scan loop: fingerprint every artifact the walk finds, reuse the
 * cached result for an unchanged one, summarize the rest, and report
 * conversations as they are found.
 *
 * Per-artifact work runs in a bounded pool: a stat or a head read is IO-bound,
 * and doing them one after another made a scan's wall time the sum of
 * thousands of round trips. Entries therefore arrive unordered.
 * @param files - The walk.
 * @param refOf - Locator of the artifact a walked file belongs to (the file
 *   itself, or its session directory); duplicates are scanned once.
 * @param fingerprint - mtime + size of an artifact, undefined when it vanished.
 */
export async function runScan(
  files: AsyncIterable<WalkedFile>,
  refOf: (file: WalkedFile) => string,
  fingerprint: (ref: string) => Promise<Fingerprint | undefined>,
  options: ScanOptions | undefined,
  summarize: (candidate: ScanCandidate) => Promise<ForeignSessionSummary | null>,
): Promise<ScanEntry[]> {
  const entries: ScanEntry[] = []
  const seen = new Set<string>()
  const running = new Set<Promise<void>>()
  const scanOne = async (ref: string): Promise<void> => {
    const fp = await fingerprint(ref)
    if (fp === undefined) return
    let summary = options?.cached?.(ref, fp)
    if (summary === undefined) {
      try {
        summary = await summarize({ ref, fp })
      } catch {
        // An artifact that vanished or cannot be read mid-scan is skipped
        // this pass; it is retried on the next one (nothing is cached).
        return
      }
    }
    entries.push({ ref, fp, summary })
    if (summary !== null) options?.onEntry?.(summary)
  }
  for await (const file of files) {
    options?.signal?.throwIfAborted()
    const ref = refOf(file)
    if (seen.has(ref)) continue
    seen.add(ref)
    const task: Promise<void> = scanOne(ref).finally(() => running.delete(task))
    running.add(task)
    if (running.size >= SCAN_CONCURRENCY) await Promise.race(running)
  }
  await Promise.all(running)
  options?.signal?.throwIfAborted()
  return entries
}
