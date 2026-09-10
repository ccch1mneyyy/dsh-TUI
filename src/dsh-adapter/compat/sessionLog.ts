/**
 * Session-log compatibility helpers.
 *
 * Title lookup tolerates event types unknown to the current harness. Offline
 * rename and delete support the `/resume` picker when no live Agent owns the
 * selected persisted session. The resume seam registers vouched-for legacy
 * event types into every reachable KNOWN_SESSION_EVENT_TYPES copy so the
 * strict read path stops rejecting whole sessions over them (issue #153).
 *
 * Registration background: plugins like dsh-working-activity (< the publish
 * cut) appended `activity/status` through `session.append`, but rc.6's
 * append exposes no `ignorable` flag and the type is absent from
 * KNOWN_SESSION_EVENT_TYPES — so resume's seed validation rejects the WHOLE
 * session ("unknown to this harness and not marked ignorable"). Upstream's
 * catalog header defers a registration surface "until such a consumer
 * exists"; the working-activity plugin became that consumer at #119 and
 * registers its type at load. Logs written BEFORE that cut, resumed in a
 * process where the plugin's registration never ran (plugin unmounted, or
 * a bare cordis.yml), still hit the rejection — this module is the consumer
 * for exactly that residue.
 *
 * Why registration and NOT rewriting the log to mark events `ignorable`
 * (the #107 approach, restored then replaced after review): the store is
 * shared with dsh web (#24) and possibly a second TUI instance (#153), and
 * a whole-file tmp+rename swap (a) loses frames an already-open appender
 * lands on the replaced inode, (b) drops the backend's 0600 artifact mode,
 * (c) re-encodes frames without the writer's checksum flag, and (d) dies on
 * torn tails the backend itself can recover. Registration touches nothing
 * on disk and degrades to exactly the pre-patch behavior when no copy
 * resolves.
 *
 * Whitelist discipline: ONLY `activity/status` — the type the plugin
 * provably wrote as ephemeral UI frames. Anything else unknown stays
 * unknown: upstream's fail-closed ("likely written by a newer harness") is
 * a feature — silently skipping a REQUIRED future event would reconstruct
 * a wrong session. Retires the day upstream's shared catalog adopts the
 * type or ships a real registration API (the add() calls become no-ops).
 *
 * The second half of this module is the bounded, tolerant, read-only log
 * reader behind the session tree (channel.buildSessionTree): 64 KiB chunked
 * I/O, lazy per-frame zstd decode over an RFC 8878 structural frame walk (a
 * torn final frame — crash mid-flush — is dropped as uncommitted, never
 * fatal), packed-row expansion, an event budget plus a scanned-envelope
 * budget so ignorable-heavy logs cannot multiply the cost of opening the
 * panel, and an inherited-prefix skip so a fork's event budget pays only for
 * its OWN events. It never writes; both stock encodings are read.
 *
 * @module @deepseek-harness-tui/dsh-tui/compat/sessionLog
 */
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { createRequire } from 'node:module'
import {
  appendFileSync,
  closeSync,
  existsSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  rmSync,
} from 'node:fs'
import { dirname, join, sep } from 'node:path'
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib'
import { homeDir } from '../../utils/paths.js'

/**
 * Legacy third-party session-event types the TUI vouches for as ephemeral
 * UI frames — safe for the strict read path to accept and skip. Exported
 * for the regression verifier; grow it only with proof the type was always
 * inert (never load-bearing for session reconstruction).
 *
 * 0.1.5 note: the vouch is not only for OLD logs. `session/color` is written
 * by the TUI itself on every host generation (session-metadata.ts), and
 * 0.1.5's `validateStoredEvents` refuses unknown non-ignorable types at load
 * — without this registration a single color pick makes that session
 * permanently unresumable (probed: SessionFormatUnsupportedError without the
 * vouch, clean load with it). The type stays inert for reconstruction either
 * way: it only re-tints the row.
 */
export const LEGACY_SESSION_EVENT_TYPES: readonly string[] = ['activity/status', 'session/color']

/** Zstd frame magic number, little-endian (0xFD2FB528). */
const ZSTD_MAGIC = 0xfd2fb528

/**
 * Session-log storage roots, in priority order, mirroring the persistence
 * backend's `root` resolution: cordis.patch.yml sets `DSH_TUI_SESSION_ROOT ?? dshHomePath(
 * 'sessions')` where dshHomePath is `$DSH_HOME ?? ~/.dsh`; the unpatched
 * cordis.yml base falls back to ~/.dsh-tui/sessions, kept here as the legacy
 * last resort. Every candidate is scanned — the first hit wins, so an
 * explicit DSH_TUI_SESSION_ROOT always outranks the defaults.
 */
export function sessionsRoots(): string[] {
  const home = homeDir()
  const roots: string[] = []
  const override = process.env.DSH_TUI_SESSION_ROOT
  if (override !== undefined && override.trim().length > 0) roots.push(override)
  const dshHome = process.env.DSH_HOME
  roots.push(join(dshHome !== undefined && dshHome.trim().length > 0 ? dshHome : join(home, '.dsh'), 'sessions'))
  roots.push(join(home, '.dsh-tui', 'sessions'))
  return [...new Set(roots)]
}

/**
 * Session ids reach path.join() below from picker/channel callers, and
 * deleteSessionLog recursively removes the resolved parent directory — so
 * an id must be a single safe path segment. Real ids are UUIDs or
 * `session-<uuid>`; anything with separators, dots, or shell-y characters
 * is rejected outright (treated as "no such session").
 */
function isSafeSessionId(sessionId: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(sessionId)
}

/**
 * Canonical session-log generation basename, mirroring upstream
 * dsh-session-format's `CANONICAL_LOG_FILENAME` (that package is not a
 * blessed import, so the rule is re-derived here): version zero keeps the
 * original `session.jsonl`; every later generation carries a lowercase
 * numeric `.vN` component (0.1.5 writes `session.v3.jsonl`). Noncanonical,
 * uppercase, leading-zero, and `.v0` names never identify committed
 * generations. A `.zstd` suffix marks the compressed encoding.
 */
const GENERATION_LOG_NAME = /^session(?:\.v([1-9][0-9]*))?\.jsonl$/

interface GenerationCandidate {
  readonly name: string
  readonly version: number
  readonly compressed: boolean
}

function parseGenerationName(name: string): GenerationCandidate | undefined {
  const compressed = name.endsWith('.zstd')
  const match = GENERATION_LOG_NAME.exec(compressed ? name.slice(0, -'.zstd'.length) : name)
  if (match === null) return undefined
  return { name, version: match[1] === undefined ? 0 : Number(match[1]), compressed }
}

/**
 * Pick the newest committed generation inside one session directory — the
 * backend's `resolveGenerationInDirectory` rule (highest format version
 * wins), with the compressed twin preferred on a tie (the stock default
 * encoding; a mixed-encoding directory is something the backend itself
 * refuses, so either tiebreak is honest for a read-only consumer).
 * @param dir - Absolute session directory (`<root>/<workspace>/<id>`).
 * @param compressedOnly - Restrict to zstd artifacts (the rename/delete
 *   caller's historical contract).
 */
function selectGenerationLog(dir: string, compressedOnly: boolean): SessionLogFile | undefined {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return undefined
  }
  let best: GenerationCandidate | undefined
  for (const name of entries) {
    const candidate = parseGenerationName(name)
    if (candidate === undefined) continue
    if (compressedOnly && !candidate.compressed) continue
    if (
      best === undefined ||
      candidate.version > best.version ||
      (candidate.version === best.version && candidate.compressed && !best.compressed)
    ) {
      best = candidate
    }
  }
  return best === undefined ? undefined : { path: join(dir, best.name), compressed: best.compressed }
}

/**
 * Locate a session's log by scanning workspace directories for the session
 * id — deliberately NOT replicating the persistence plugin's workspace-key
 * sanitization, so the helpers survive upstream key-scheme changes. Every
 * committed generation is considered; the newest wins (the backend migrates
 * historical artifacts by publishing a `session.vN` sibling and reading only
 * it, so the newest generation is always the authoritative one).
 * @param sessionId - Session id (directory name under each workspace dir).
 * @returns Absolute path of the selected log, or undefined when absent.
 */
export function findSessionLogFile(sessionId: string): string | undefined {
  if (!isSafeSessionId(sessionId)) return undefined
  for (const root of sessionsRoots()) {
    let workspaces: string[]
    try {
      workspaces = readdirSync(root)
    } catch {
      continue
    }
    for (const ws of workspaces) {
      // Historical contract of this helper: the compressed artifact only
      // (the rename/delete/title-string paths predate plain-encoding logs).
      const selected = selectGenerationLog(join(root, ws, sessionId), true)
      if (selected !== undefined) return selected.path
    }
  }
  return undefined
}

/* ------------------------------------------------------------------------- *\
 * Bounded, tolerant, read-only log reader behind the session tree
 * (channel.buildSessionTree): 64 KiB chunked I/O, lazy per-frame zstd decode
 * over an RFC 8878 structural frame walk (a torn final frame — crash
 * mid-flush — is dropped as uncommitted, never fatal), packed-row expansion,
 * an event budget plus a scanned-envelope budget so ignorable-heavy logs
 * cannot multiply the cost of opening the panel, and an inherited-prefix
 * skip so a fork's event budget pays only for its OWN events. It never
 * writes; both stock encodings are read.
\* ------------------------------------------------------------------------- */

/**
 * decodeStorageRecord comes in LAZILY through the module's own tree: this
 * module must stay importable against ANY reachable dsh-session copy —
 * ensureLegacySessionEventTypes walks foreign/minimal copies whose only
 * contract is exposing KNOWN_SESSION_EVENT_TYPES, so no static runtime import
 * of the package is allowed here. The log readers only run where the
 * plugin's own real dsh-session is installed.
 *
 * Dual-generation: dsh-session 0.1.5 (Session format v3) REMOVED the export —
 * V3 nests compact assistant streams inside `assistant/message.stream`, so
 * the storage-row vocabulary exists only in pre-V3 artifacts. When the
 * upstream export resolves it is used verbatim (old hosts keep byte-identical
 * behavior); otherwise the local structural port below decodes the three
 * released packed-row tags with exactly the removed decoder's validate-then-
 * expand semantics, and every other value passes through unvalidated.
 */
type StorageDecoder = (value: unknown) => SessionEvent[]
let cachedDecoder: StorageDecoder | undefined
function decodeStorageRecord(value: unknown): SessionEvent[] {
  if (cachedDecoder === undefined) {
    cachedDecoder = loadUpstreamDecoder() ?? decodeStorageRecordLocal
  }
  return cachedDecoder(value)
}

function loadUpstreamDecoder(): StorageDecoder | undefined {
  try {
    const req = createRequire(import.meta.url)
    const mod = req('@deepseek-ai/dsh-session') as { decodeStorageRecord?: unknown }
    return typeof mod.decodeStorageRecord === 'function'
      ? mod.decodeStorageRecord as StorageDecoder
      : undefined
  } catch {
    // No resolvable dsh-session copy from this tree — the local decoder is
    // fully self-contained, so reads still work.
    return undefined
  }
}

/* ------------------------------------------------------------------------- *\
 * Local port of the removed dsh-session chunk-rows decoder (0.1.2-rc.1 and
 * earlier, lib/types/chunk-rows.js). Storage rows are a durable-encoding
 * vocabulary, NOT session events: the packChunks writer folded each run of
 * same-block delta chunks into ONE `text-chunks`/`reasoning-chunks`/
 * `tool-call-chunks` line. Row-tagged values validate and expand (a malformed
 * row throws — it is corrupt storage, and treating it as an event would
 * silently drop a whole run); every other value passes through as a single
 * event, unvalidated.
\* ------------------------------------------------------------------------- */

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** Exact-key check: `value` has every key in `keys` and nothing else. */
function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every(k => Object.hasOwn(value, k))
}

/** The uniform malformed-row diagnostic. */
function malformedRow(tag: string, why: string): never {
  throw new Error(`malformed ${tag} storage row: ${why}`)
}

interface ChunkRowData {
  turn: number
  step: number
  index: number
  dt: number[]
  id?: string
  name?: string
  texts?: string[]
  args?: string[]
}

interface ChunkRow {
  type: string
  seq0: number
  time0: number
  data: ChunkRowData
}

/** Validate the shared run-data fields and the payload/dt arity; returns the member payload. */
function validateRunData(tag: string, data: ChunkRowData, payloadKey: 'texts' | 'args'): string[] {
  if (typeof data.turn !== 'number' || typeof data.step !== 'number' || typeof data.index !== 'number') {
    malformedRow(tag, 'turn/step/index must be numbers')
  }
  const payload: unknown = data[payloadKey]
  if (!Array.isArray(payload) || payload.length === 0 || payload.some(entry => typeof entry !== 'string')) {
    malformedRow(tag, `${payloadKey} must be a non-empty string array`)
  }
  const dt: unknown = data.dt
  if (!Array.isArray(dt) || dt.some(gap => !Number.isSafeInteger(gap))) {
    malformedRow(tag, 'dt must be an array of safe integers')
  }
  if (dt.length !== payload.length - 1) {
    malformedRow(tag, `dt length ${dt.length} does not match ${payload.length} members`)
  }
  return payload as string[]
}

/** Validate a row-tagged parsed value's envelope and data, throwing on any malformation. */
function validateChunkRow(value: Record<string, unknown>, tag: string): ChunkRow {
  if (!hasExactKeys(value, ['type', 'seq0', 'time0', 'data'])) {
    malformedRow(tag, 'envelope must be exactly {type, seq0, time0, data}')
  }
  if (!Number.isSafeInteger(value['seq0']) || (value['seq0'] as number) < 0) {
    malformedRow(tag, 'seq0 must be a non-negative safe integer')
  }
  if (!Number.isSafeInteger(value['time0'])) {
    malformedRow(tag, 'time0 must be a safe integer')
  }
  const data: unknown = value['data']
  if (!isRecordValue(data)) malformedRow(tag, 'data must be an object')
  const row = data as Record<string, unknown>
  let payload: string[]
  if (tag === 'tool-call-chunks') {
    const withName = hasExactKeys(row, ['turn', 'step', 'index', 'id', 'name', 'dt', 'args'])
    if (!withName && !hasExactKeys(row, ['turn', 'step', 'index', 'id', 'dt', 'args'])) {
      malformedRow(tag, 'data must be exactly {turn, step, index, id, name?, dt, args}')
    }
    if (typeof row['id'] !== 'string' || (withName && typeof row['name'] !== 'string')) {
      malformedRow(tag, 'id (and name when present) must be strings')
    }
    payload = validateRunData(tag, row as unknown as ChunkRowData, 'args')
  } else {
    if (!hasExactKeys(row, ['turn', 'step', 'index', 'dt', 'texts'])) {
      malformedRow(tag, 'data must be exactly {turn, step, index, dt, texts}')
    }
    payload = validateRunData(tag, row as unknown as ChunkRowData, 'texts')
  }
  // Reconstruction bounds. The encoder only packs runs whose member seqs and
  // times are all safe integers, so a running value that leaves safe range is
  // outside any encoder's image: float arithmetic would round it to a
  // different number than exact arithmetic, a silent corruption. Within safe
  // range every step is exact, so the first departure is always caught.
  const seq0 = value['seq0'] as number
  if (!Number.isSafeInteger(seq0 + payload.length - 1)) {
    malformedRow(tag, 'member seqs must stay safe integers')
  }
  let time = value['time0'] as number
  for (const gap of row['dt'] as number[]) {
    time += gap
    if (!Number.isSafeInteger(time)) {
      malformedRow(tag, 'member times must stay safe integers')
    }
  }
  return { type: tag, seq0, time0: value['time0'] as number, data: row as unknown as ChunkRowData }
}

/** Expand a validated row back into its exact original events, in order. */
function expandChunkRow(row: ChunkRow): SessionEvent[] {
  const members = row.type === 'tool-call-chunks' ? row.data.args! : row.data.texts!
  const events: SessionEvent[] = []
  let time = row.time0
  for (let k = 0; k < members.length; k++) {
    if (k > 0) time += row.data.dt[k - 1]!
    let chunk: Record<string, unknown>
    switch (row.type) {
      case 'text-chunks':
        chunk = { type: 'text-delta', index: row.data.index, text: members[k] }
        break
      case 'reasoning-chunks':
        chunk = { type: 'reasoning-delta', index: row.data.index, text: members[k] }
        break
      default:
        chunk = {
          type: 'tool-call-delta',
          index: row.data.index,
          id: row.data.id,
          ...(row.data.name !== undefined ? { name: row.data.name } : {}),
          argumentsDelta: members[k],
        }
        break
    }
    // assistant/chunk is gone from the 0.1.5 SessionEvent union; the events
    // are reconstructed structurally for the legacy-log replay path.
    events.push({
      type: 'assistant/chunk',
      seq: row.seq0 + k,
      time,
      data: { turn: row.data.turn, step: row.data.step, chunk },
    } as unknown as SessionEvent)
  }
  return events
}

/**
 * Structural twin of the removed upstream `decodeStorageRecord`: packed
 * chunk rows expand, everything else passes through as one event.
 */
function decodeStorageRecordLocal(value: unknown): SessionEvent[] {
  if (!isRecordValue(value)) return [value as SessionEvent]
  const tag = value['type']
  if (tag !== 'text-chunks' && tag !== 'reasoning-chunks' && tag !== 'tool-call-chunks') {
    return [value as SessionEvent]
  }
  return expandChunkRow(validateChunkRow(value, tag))
}

/** I/O slice for streamed log reads. */
const READ_CHUNK = 64 * 1024

/**
 * Compressed-size cap for a single zstd frame, checked DURING accumulation
 * (before any decompress attempt): a bare magic prefix followed by inert
 * bytes must bail instead of buffering unboundedly.
 */
const MAX_FRAME_BYTES = 64 * 1024 * 1024

/**
 * Decompressed-size cap for a single frame: a tiny on-disk bomb must be
 * refused, not exploded into memory.
 */
const MAX_FRAME_TEXT_BYTES = 64 * 1024 * 1024

/** A located session log and its on-disk encoding. */
interface SessionLogFile {
  readonly path: string
  /** true for session.jsonl.zstd (default), false for compression:"none". */
  readonly compressed: boolean
}

/**
 * Dual-encoding sibling of {@link findSessionLogFile} for the bounded tree
 * reader: also accepts plain `session*.jsonl` artifacts (a
 * `compression:"none"` backend), which the rename/delete/title-string path
 * has no use for. Same multi-root scan, id whitelist, and newest-generation
 * selection; the compressed twin still wins a same-generation tie.
 * @param sessionId - Session id (directory name under each workspace dir).
 * @returns The log path and encoding, or undefined when absent.
 */
function findSessionLogFileAnyEncoding(sessionId: string): SessionLogFile | undefined {
  if (!isSafeSessionId(sessionId)) return undefined
  for (const root of sessionsRoots()) {
    let workspaces: string[]
    try {
      workspaces = readdirSync(root)
    } catch {
      continue
    }
    for (const ws of workspaces) {
      const selected = selectGenerationLog(join(root, ws, sessionId), false)
      if (selected !== undefined) return selected
    }
  }
  return undefined
}

/**
 * Yield a file's bytes in READ_CHUNK slices. Each yielded buffer is freshly
 * allocated, so consumers may hold frames/lines across yields.
 * @param fd - Open file descriptor (closed by the caller).
 * @yields Raw byte slices in file order.
 */
function* fileChunks(fd: number): Generator<Buffer, void, undefined> {
  for (;;) {
    const buf = Buffer.allocUnsafe(READ_CHUNK)
    const n = readSync(fd, buf, 0, READ_CHUNK, null)
    if (n === 0) return
    yield buf.subarray(0, n)
  }
}

/**
 * Iterate the concatenated zstd frames of a log lazily, over byte chunks,
 * walking each frame's RFC 8878 structure instead of scanning for magic
 * bytes: magic (4) → frame header descriptor → window descriptor →
 * dictionary id → frame content size → data blocks (3-byte little-endian
 * header: last-block flag, block type, block size) until the last block →
 * optional 4-byte content checksum. Structure walking wins over a magic
 * scan twice over: a magic sequence inside a COMPRESSED payload no longer
 * mis-splits its frame, and the exact frame end is known — so a crash
 * mid-flush leaves a torn FINAL frame that is dropped like the plain
 * reader's unterminated tail line (uncommitted), keeping every committed
 * frame before it readable. Frame bytes accumulate as SEGMENTS (references
 * into the 64 KiB read chunks) with one concat per completed frame; the
 * MAX_FRAME_BYTES cap is checked on the running length, so it fires while
 * the frame is still being read, not after it is buffered. Throws when no
 * complete frame exists at all (not a zstd log / nothing committed), on
 * structural corruption (a reserved block type, non-magic bytes at a frame
 * boundary), or when one frame grows past MAX_FRAME_BYTES.
 * @param chunks - Raw file bytes, in order.
 * @yields Each frame's original compressed byte span, in log order.
 */
function* zstdFrames(chunks: Iterable<Buffer>): Generator<Buffer, void, undefined> {
  const stream = chunks[Symbol.iterator]()
  let current: Buffer | null = null
  let pos = 0
  const advance = (): boolean => {
    const next = stream.next()
    if (next.done === true) {
      current = null
      return false
    }
    current = next.value
    pos = 0
    return true
  }
  let segments: Buffer[] = []
  let frameLength = 0
  const append = (bytes: Buffer): void => {
    if (bytes.length === 0) return
    segments.push(bytes)
    frameLength += bytes.length
    if (frameLength > MAX_FRAME_BYTES) {
      throw new Error(`zstd frame exceeds the ${MAX_FRAME_BYTES}-byte browse cap`)
    }
  }
  /** Pull exactly n structural bytes (≤ 18, concatenating across chunk
   *  boundaries); fewer only at EOF. The bytes join the current frame. */
  const field = (n: number): Buffer => {
    const parts: Buffer[] = []
    let left = n
    while (left > 0) {
      if (current === null && !advance()) break
      if (current === null || current.length === pos) {
        current = null
        continue
      }
      const take = Math.min(current.length - pos, left)
      parts.push(current.subarray(pos, pos + take))
      pos += take
      left -= take
    }
    const out = parts.length === 1 ? parts[0]! : Buffer.concat(parts)
    append(out)
    return out
  }
  /** Swallow exactly n payload bytes into the current frame, in per-chunk
   *  pieces (no concat — payloads can be megabytes). Returns the shortfall
   *  at EOF (0 when the payload was fully consumed). */
  const payload = (n: number): number => {
    let left = n
    while (left > 0) {
      if (current === null && !advance()) return left
      if (current === null || current.length === pos) {
        current = null
        continue
      }
      const take = Math.min(current.length - pos, left)
      append(current.subarray(pos, pos + take))
      pos += take
      left -= take
    }
    return 0
  }
  // EOF partway through a frame is a torn write: committed frames already
  // yielded stay yielded, the partial frame is dropped. Before the FIRST
  // frame completes it instead means "nothing committed" — the old magic
  // scan threw in that case, and the contract is kept.
  let frames = 0
  const torn = (): boolean => frames > 0
  for (;;) {
    const magic = field(4)
    if (magic.length < 4) {
      // Clean EOF at a frame boundary, or a 1–3 byte torn tail.
      if (magic.length === 0 && frames === 0) throw new Error('no zstd frame found')
      if (!torn()) throw new Error('no complete zstd frame found')
      return
    }
    if (magic.readUInt32LE(0) !== ZSTD_MAGIC) {
      throw new Error('non-zstd bytes at a frame boundary')
    }
    const descriptor = field(1)
    if (descriptor.length < 1) {
      if (!torn()) throw new Error('no complete zstd frame found')
      return
    }
    const d = descriptor[0]!
    const fcsFlag = d >>> 6
    const singleSegment = (d & 0x20) !== 0
    const hasChecksum = (d & 0x04) !== 0
    // Dictionary_ID flag: 0/1/2/3 → 0/1/2/4 bytes.
    const dictIdBytes = (d & 0x03) === 3 ? 4 : d & 0x03
    // Frame_Content_Size: flag 0 → 1 byte only for single-segment frames;
    // flags 1/2/3 → 2/4/8 bytes.
    const fcsBytes = fcsFlag === 0 ? (singleSegment ? 1 : 0) : fcsFlag === 1 ? 2 : fcsFlag === 2 ? 4 : 8
    const headerBytes = (singleSegment ? 0 : 1) + dictIdBytes + fcsBytes
    if (field(headerBytes).length < headerBytes) {
      if (!torn()) throw new Error('no complete zstd frame found')
      return
    }
    for (;;) {
      const blockHeader = field(3)
      if (blockHeader.length < 3) {
        if (!torn()) throw new Error('no complete zstd frame found')
        return
      }
      const packed = blockHeader[0]! | (blockHeader[1]! << 8) | (blockHeader[2]! << 16)
      const lastBlock = (packed & 1) !== 0
      const blockType = (packed >>> 1) & 0x03
      if (blockType === 3) throw new Error('reserved zstd block type')
      // RLE blocks carry a single byte; raw/compressed carry Block_Size.
      if (payload(blockType === 1 ? 1 : packed >>> 3) > 0) {
        if (!torn()) throw new Error('no complete zstd frame found')
        return
      }
      if (lastBlock) break
    }
    if (hasChecksum && field(4).length < 4) {
      if (!torn()) throw new Error('no complete zstd frame found')
      return
    }
    frames += 1
    yield Buffer.concat(segments)
    segments = []
    frameLength = 0
  }
}

/**
 * Iterate the lines of a plain-text (compression:"none") log lazily. A
 * streaming UTF-8 decoder keeps multi-byte characters intact across read
 * chunks. An unterminated FINAL line is a torn write (a crash mid-append):
 * the backend's own reader ignores uncommitted records, and so does this
 * one — the tree must never show events persistence.load() would not
 * acknowledge.
 * @param chunks - Raw file bytes, in order.
 * @yields Each non-empty newline-terminated line's text, in log order.
 */
function* plainLines(chunks: Iterable<Buffer>): Generator<string, void, undefined> {
  const decoder = new TextDecoder('utf-8')
  let pending = ''
  for (const chunk of chunks) {
    pending += decoder.decode(chunk, { stream: true })
    let idx = pending.indexOf('\n')
    while (idx !== -1) {
      const line = pending.slice(0, idx)
      pending = pending.slice(idx + 1)
      if (line.length > 0) yield line
      idx = pending.indexOf('\n')
    }
  }
  // `pending` here (plus any partial code point in the decoder) is the
  // unterminated torn tail — dropped, not yielded.
}

/**
 * Iterate the lines of a decoded zstd frame lazily: lines are located by
 * indexOf as the consumer pulls, so a reader stopping at its event budget
 * never allocates the frame's remaining line strings (a single flush can be
 * many MB of text). A COMPLETE frame must end newline-terminated — the
 * backend flushes whole frames, so an unterminated tail line inside one is
 * corruption (the strict backend rejects it too), never a torn write. The
 * check runs UP FRONT, before the first line is yielded: a budget-limited
 * reader returning early must not skip it and misjudge a corrupt frame as
 * merely truncated.
 * @param text - The frame's full decoded text.
 * @yields Each non-empty line's text, in order. Throws on a torn frame.
 */
function* frameLines(text: string): Generator<string, void, undefined> {
  if (text.length > 0 && !text.endsWith('\n')) {
    throw new Error('unterminated record inside a zstd frame')
  }
  let pos = 0
  for (;;) {
    const nl = text.indexOf('\n', pos)
    if (nl === -1) return
    if (nl > pos) yield text.slice(pos, nl)
    pos = nl + 1
  }
}

/**
 * Parse one log's storage records (one JSON value per line) lazily, in log
 * order, from whichever on-disk encoding was located. Decompression and
 * parsing happen per frame/line as the consumer pulls, so stopping early
 * (event budget reached) stops the I/O too — with one honest exception: a
 * zstd FRAME is the atomic unit. The next magic (or EOF) delimits it and the
 * whole frame is decompressed and stringified before its first line exists,
 * so a single giant flush (a big seed write, a batched append) costs its
 * full frame size in time and memory regardless of the budget. The budget
 * bounds ACROSS frames; within one frame it only stops line splitting and
 * JSON parsing early.
 * @param fd - Open file descriptor of the log.
 * @param compressed - Whether the log is zstd-framed (vs plain jsonl text).
 * @yields Each line's JSON.parse result, unvalidated.
 */
function* logRecords(fd: number, compressed: boolean): Generator<unknown, void, undefined> {
  if (compressed) {
    for (const frame of zstdFrames(fileChunks(fd))) {
      // maxOutputLength is the REAL resource bound: repetitive chunk deltas
      // compress ~56×, so the compressed-byte cap alone says nothing about
      // the text a frame inflates into. Over the limit zstd throws — the
      // log degrades to unreadable rather than ballooning the TUI's RSS.
      const text = zstdDecompressSync(frame, { maxOutputLength: MAX_FRAME_TEXT_BYTES }).toString('utf8')
      for (const line of frameLines(text)) {
        yield JSON.parse(line)
      }
    }
  } else {
    for (const line of plainLines(fileChunks(fd))) {
      yield JSON.parse(line)
    }
  }
}

/**
 * Sniff a located artifact's encoding from its first bytes: zstd framing
 * declares itself with the magic number; anything else is plain JSONL text.
 * @param path - Candidate log path (must exist).
 * @returns The path with its detected encoding, or undefined when unreadable.
 */
function sniffLogFile(path: string): SessionLogFile | undefined {
  let fd: number | undefined
  try {
    fd = openSync(path, 'r')
    const head = Buffer.alloc(4)
    const n = readSync(fd, head, 0, 4, 0)
    return { path, compressed: n === 4 && head.readUInt32LE(0) === ZSTD_MAGIC }
  } catch {
    return undefined
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {
        // A close failure leaves nothing actionable.
      }
    }
  }
}

/**
 * Resolve a `persistence.locate()` hint to a readable log. The hint may name
 * the physical artifact directly or the backend's LOGICAL name for it (the
 * jsonl backend's raw-artifact filename carries no encoding suffix), so the
 * compressed twin is probed as well. Since 0.1.5 the hint names the CURRENT
 * generation (`session.vN.jsonl[.zstd]`) without touching the filesystem —
 * for a session never opened since its format was superseded that file does
 * not exist yet, and the authoritative artifact is an older-generation
 * sibling in the same directory. Encoding is sniffed from content, never
 * inferred from the extension.
 * @param hint - Absolute path from SessionPersistence.locate().
 * @returns The readable log, or undefined when nothing materialized there.
 */
export function resolveLocatedPath(hint: string): SessionLogFile | undefined {
  const direct = existsSync(hint) ? sniffLogFile(hint) : undefined
  if (direct !== undefined) return direct
  const twin = `${hint}.zstd`
  if (existsSync(twin)) return { path: twin, compressed: true }
  // Generation fallback: only when the hint itself is a canonical
  // generation name — a foreign backend's logical name must not steer a
  // directory scan. The scan stays inside the backend's own session
  // directory, so locate's authority over root and workspace key is kept.
  const base = hint.slice(hint.lastIndexOf(sep) + 1)
  const withoutSuffix = base.endsWith('.zstd') ? base.slice(0, -'.zstd'.length) : base
  if (!GENERATION_LOG_NAME.test(withoutSuffix)) return undefined
  return selectGenerationLog(dirname(hint), false)
}

/** Outcome of reading an EXISTING log through the bounded reader. */
export interface SessionLogRead {
  readonly events: readonly SessionEvent[]
  /** Physical generation of these sequence coordinates, read from the header. */
  readonly formatVersion?: number
  /** False when the read stopped early (event/scan budget) — a plain
   *  truncation; the collected prefix is fully usable. */
  readonly complete: boolean
  /** Envelopes inspected (collected or skipped) — the real scan cost. */
  readonly scanned: number
  /** True when an EXISTING log could not be read: corruption, a torn first
   *  frame, an over-cap frame, a decode bomb. Distinct from ABSENT (which
   *  reports `undefined`): a failed log must degrade to a structure-only
   *  placeholder and must NOT be retried through an unbounded strict read —
   *  that fallback would defeat every cap this reader exists to enforce.
   *  `events` keeps the partial prefix collected before the failure, for
   *  diagnostics; callers building trees ignore it. */
  readonly failed?: boolean
}

/**
 * Shared bounded read loop over a located log. See readSessionEventsFromLog
 * for the contract; this is the file-level entry for backend-resolved paths.
 * Returns undefined ONLY when the log vanished between the location scan and
 * the open — every other failure lands in {@link SessionLogRead.failed}.
 */
function readEvents(
  file: SessionLogFile,
  maxEvents: number,
  maxScanned: number,
  skipBelowSeq: number,
): SessionLogRead | undefined {
  let fd: number | undefined
  try {
    fd = openSync(file.path, 'r')
  } catch {
    return undefined
  }
  let scanned = 0
  let formatVersion: number | undefined
  const events: SessionEvent[] = []
  const result = (complete: boolean, failed?: true): SessionLogRead => ({ events, complete, scanned, formatVersion, ...(failed ? { failed } : {}) })
  try {
    for (const record of logRecords(fd, file.compressed)) {
      if (scanned === 0 && isRecordValue(record) && record['type'] === 'session' && Number.isSafeInteger(record['version'])) {
        formatVersion = record['version'] as number
      }
      for (const event of decodeStorageRecord(record)) {
        // The SCAN budget bounds the real cost drivers — I/O, decompression,
        // JSON.parse — which are paid for EVERY envelope, collected or not.
        // Without it, a log carrying hundreds of thousands of skipped rows
        // (ignorable-marked activity frames) forces a full parse just
        // to collect a handful of events, blocking the TUI on panel open.
        scanned += 1
        if (scanned > maxScanned) return result(false)
        const envelope = event as Record<string, unknown>
        if (typeof envelope['seq'] !== 'number' || envelope['ignorable'] === true) continue
        // Inherited-prefix skip (session-tree dedup): seqs an ancestor
        // already shows are not collected. They still cost the scan budget
        // (their bytes were read and parsed), but NOT the event budget — a
        // fork of a huge parent is charged only for its OWN events, so two
        // small forks of a 70k-event parent both stay visible. Titles still
        // collect below the cutoff: branch-head labels need them and they
        // never extract into entries.
        if ((envelope['seq'] as number) < skipBelowSeq && envelope['type'] !== 'session/title') continue
        // Budget check BEFORE the push: an exact-fit log reports complete,
        // and only a surviving (maxEvents+1)-th event marks truncation.
        if (events.length >= maxEvents) return result(false)
        events.push(event)
      }
    }
    return result(true)
  } catch {
    // An EXISTING but undecodable log (corruption, over-cap frame, decode
    // bomb): fail closed — never silently empty, never eligible for an
    // unbounded fallback re-read.
    return result(false, true)
  } finally {
    try {
      closeSync(fd)
    } catch {
      // A close failure leaves nothing actionable — the read already ended.
    }
  }
}

/**
 * Default scan budget derived from the event budget: 4× headroom over the
 * collectible events (legitimate logs interleave a modest share of skipped
 * rows — headers, repair-marked ignorable frames), plus a floor so even a
 * tiny `maxEvents` tolerates a noisy prefix. Unbounded reads stay unbounded.
 */
export function defaultMaxScanned(maxEvents: number): number {
  return Number.isFinite(maxEvents) ? maxEvents * 4 + 4096 : Number.POSITIVE_INFINITY
}

/**
 * File-level sibling of {@link readSessionEventsFromLog} for paths resolved
 * by the backend itself (`persistence.locate`) — covers a custom-configured
 * root that none of the stock sessionsRoots() candidates describes.
 * @param path - Absolute artifact path (physical or logical name).
 * @param maxEvents - Stop before collecting more than this many events.
 * @param maxScanned - Stop after INSPECTING this many envelopes, collected
 *   or skipped (default: {@link defaultMaxScanned} of maxEvents).
 * @param skipBelowSeq - Inherited-prefix cutoff (session-tree dedup):
 *   seq'd events below it are skipped without spending the event budget —
 *   they still count against maxScanned. `session/title` events are always
 *   collected (branch-head labels need them; they never become entries).
 * @returns The read outcome, or undefined ONLY when nothing materialized at
 *   the path — an existing-but-undecodable log reports `failed: true`.
 */
export function readSessionEventsFromFile(
  path: string,
  maxEvents: number = Number.POSITIVE_INFINITY,
  maxScanned: number = defaultMaxScanned(maxEvents),
  skipBelowSeq: number = 0,
): SessionLogRead | undefined {
  const file = resolveLocatedPath(path)
  if (file === undefined) return undefined
  return readEvents(file, maxEvents, maxScanned, skipBelowSeq)
}

/**
 * Read a session's events from its persisted log — tolerant, read-only, and
 * cost-bounded. Built for the session tree (buildSessionTree), whose browse
 * must satisfy three constraints the strict backend read cannot:
 *
 *  - READ-ONLY: the strict backend read (`persistence.inspect` on pre-0.1.5
 *    hosts, the validated `handle.read` path since) rejects logs carrying
 *    third-party event types (working-activity's `activity/status`), and
 *    the resume seam's answer (in-process type registration, issue #153)
 *    must not be inverted here: opening a picker never rewrites a history
 *    log. This reader never writes; unknown types are simply passed through
 *    (extractEntries skips what it does not know).
 *  - TOLERANT: envelope-shape or decode anomalies degrade to
 *    `failed: true` (a structure-only tree node) instead of rejecting the
 *    whole log — and a torn FINAL zstd frame (crash mid-flush) is dropped
 *    as uncommitted, keeping the frames before it readable.
 *  - BOUNDED: the file is read in 64 KiB slices and frames decode lazily,
 *    stopping the moment `maxEvents` events have been collected — a
 *    200k-event log costs budget × per-event work, not a whole-file read +
 *    decompress + parse. `complete: false` marks the early stop (the caller
 *    surfaces it as `truncated`). One honest exception: a single zstd FRAME
 *    is the atomic unit (see logRecords) — the budget bounds work ACROSS
 *    frames, never inside one giant flush.
 *
 * Packed rows are expanded with the backend's own `decodeStorageRecord`:
 * the packChunks writer folds each run of same-block delta chunks into ONE
 * `text-chunks`/`reasoning-chunks`/`tool-call-chunks` line (the default —
 * the finding that motivated this reader's third revision), so a line is a
 * storage record, not an event, and seq-less rows must not be dropped as if
 * they were headers. The budget counts EXPANDED events, matching the tree's
 * per-event cost. Malformed packed rows throw inside decodeStorageRecord —
 * corrupt storage degrades to `undefined`, never to silently dropped runs.
 *
 * Torn-tail semantics mirror the backend's own reader: a plain log's
 * unterminated final line (crash mid-append) is uncommitted data and
 * ignored, while an unterminated record INSIDE a complete zstd frame is
 * corruption and fails the read.
 *
 * Envelopes with `ignorable: true` are skipped (the read path's own skip
 * signal) and the seq-less header row is metadata, not an event. Skipped
 * envelopes still count against the SCAN budget (maxScanned): skipping is
 * not free — the I/O, decompress and JSON.parse for them have already been
 * paid — so an ignorable-heavy log cannot bypass the cost bound by keeping
 * its collectible count low. Never throws; returns undefined ONLY when the
 * log is absent — an existing-but-undecodable log returns `failed: true`
 * so the caller degrades to a placeholder instead of escalating to an
 * unbounded strict re-read.
 * @param sessionId - Session whose log should be read.
 * @param maxEvents - Stop before collecting more than this many events
 *   (default: unbounded). 0 collects nothing and reports complete: false
 *   whenever the log holds any collectible event.
 * @param maxScanned - Stop after INSPECTING this many envelopes, collected
 *   or skipped (default: 4× maxEvents + 4096; unbounded when maxEvents is).
 * @param skipBelowSeq - Inherited-prefix cutoff (session-tree dedup):
 *   seq'd events below it are skipped without spending the event budget —
 *   they still count against maxScanned. `session/title` events are always
 *   collected (branch-head labels need them; they never become entries).
 * @returns The read outcome — events, completeness, real scan cost, and a
 *   `failed` marker for safety-cap/corruption bailouts.
 */
export function readSessionEventsFromLog(
  sessionId: string,
  maxEvents: number = Number.POSITIVE_INFINITY,
  maxScanned: number = defaultMaxScanned(maxEvents),
  skipBelowSeq: number = 0,
): SessionLogRead | undefined {
  const file = findSessionLogFileAnyEncoding(sessionId)
  if (file === undefined) return undefined
  return readEvents(file, maxEvents, maxScanned, skipBelowSeq)
}

function seedLengthOfPhysicalHeader(record: unknown): number | undefined {
  if (record === null || typeof record !== 'object' || Array.isArray(record)) return undefined
  const rec = record as Record<string, unknown>
  if (rec['type'] !== 'session') return undefined
  const seed = rec['seedLength']
  if (typeof seed === 'number' && Number.isSafeInteger(seed) && seed >= 0 && !Object.is(seed, -0)) return seed
  return undefined
}

/** The header's `isSeeded` flag (V2/V3 headers carry it instead of `seedLength`). */
function isSeededPhysicalHeader(record: unknown): boolean {
  if (record === null || typeof record !== 'object' || Array.isArray(record)) return false
  const rec = record as Record<string, unknown>
  return rec['type'] === 'session' && rec['isSeeded'] === true
}

/**
 * The inherited cut recorded by a `session/end-seed` marker: seq of the last
 * marker whose data carries `inherited: true` (the V2/V3 contract — the
 * marker closes the inherited prefix, so its seq IS the prefix length).
 */
function inheritedMarkerCut(record: unknown): number | undefined {
  if (record === null || typeof record !== 'object' || Array.isArray(record)) return undefined
  const rec = record as Record<string, unknown>
  if (rec['type'] !== 'session/end-seed') return undefined
  const data = rec['data']
  if (data === null || typeof data !== 'object' || (data as Record<string, unknown>)['inherited'] !== true) {
    return undefined
  }
  const seq = rec['seq']
  if (typeof seq === 'number' && Number.isSafeInteger(seq) && seq >= 0 && !Object.is(seq, -0)) return seq
  return undefined
}

/**
 * Envelope ceiling for the seeded-header marker scan: a fork's marker closes
 * its inherited prefix, but earlier markers can belong to an ancestor. Scan
 * the log to find the last one, bounded so a huge log degrades to "cut unknown"
 * (the tree detaches the parent edge) instead of an unbounded read.
 */
const INHERITED_CUT_SCAN_LIMIT = 2_000_000

/**
 * Read the exact inherited-prefix length from a log. Pre-V2 physical headers
 * carry it as `seedLength` on the first line; V2/V3 headers only have
 * `isSeeded`, and the cut is the seq of the `session/end-seed` marker event
 * stamped with `inherited: true` — scanned for, bounded, only when the
 * header says the session is seeded. Logical list headers never carry the
 * cut on any generation. Never guesses from snapshot length, and an
 * unseeded or marker-less log reports undefined (no cut to report).
 */
export function readPhysicalHeaderSeedLength(path: string): number | undefined {
  const file = resolveLocatedPath(path)
  if (file === undefined) return undefined
  let fd: number | undefined
  try {
    fd = openSync(file.path, 'r')
    let first = true
    let seeded = false
    let scanned = 0
    let inheritedCut: number | undefined
    for (const record of logRecords(fd, file.compressed)) {
      if (first) {
        first = false
        const seed = seedLengthOfPhysicalHeader(record)
        if (seed !== undefined) return seed
        if (!isSeededPhysicalHeader(record)) return undefined
        seeded = true
        continue
      }
      if (!seeded) return undefined
      scanned += 1
      if (scanned > INHERITED_CUT_SCAN_LIMIT) return undefined
      const cut = inheritedMarkerCut(record)
      if (cut !== undefined) inheritedCut = cut
    }
    return inheritedCut
  } catch {
    return undefined
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {
        // A close failure leaves nothing actionable.
      }
    }
  }
}

/** Locate a session log by id and read its inherited-prefix cut. */
export function readPhysicalHeaderSeedLengthForSession(sessionId: string): number | undefined {
  const file = findSessionLogFileAnyEncoding(sessionId)
  if (file === undefined) return undefined
  return readPhysicalHeaderSeedLength(file.path)
}

/**
 * Decode a (possibly multi-frame) zstd jsonl log. Frames are split by magic
 * scan; any frame failing to decode or any line failing to parse throws, so
 * callers abort instead of acting on a log they did not fully understand.
 * @param buf - Raw file bytes.
 * @returns Parsed event envelopes, in log order.
 */
function decodeEvents(buf: Buffer): Record<string, unknown>[] {
  const offsets: number[] = []
  for (let i = 0; i + 4 <= buf.length; i++) {
    if (buf.readUInt32LE(i) === ZSTD_MAGIC) offsets.push(i)
  }
  if (offsets.length === 0) throw new Error('no zstd frame found')
  return offsets.flatMap((start, i) => {
    const end = i + 1 < offsets.length ? offsets[i + 1]! : buf.length
    const text = zstdDecompressSync(buf.subarray(start, end)).toString('utf8')
    return text
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => {
        const parsed: unknown = JSON.parse(line)
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new Error('session log line is not an event envelope')
        }
        return parsed as Record<string, unknown>
      })
  })
}

/**
 * Register every {@link LEGACY_SESSION_EVENT_TYPES} type as known in EVERY
 * reachable KNOWN_SESSION_EVENT_TYPES copy, ahead of the strict read path
 * (`agents.resume` seed validation, `persistence.load`). Idempotent; never
 * throws.
 *
 * Why a walk instead of a single import: a runtime can load dsh-session
 * more than once (CLI tree vs profile tree, version overlap during
 * upgrades, pnpm peer-context splits), and the strict validator — which
 * lives in the dsh-session-persistence package — consults only ITS OWN
 * tree's copy. Registering through one import leaves the other trees'
 * copies untouched. So from EACH base anchor (this module = the dsh-tui
 * tree, the process entry point = the launcher/CLI tree) the walk
 * registers the tree's own dsh-session AND steps one edge further:
 * resolve the validator package from that same tree, then register the
 * dsh-session copy the validator's entry resolves. A branch that cannot
 * be resolved simply is not there; resolved module paths are deduped.
 */
export function ensureLegacySessionEventTypes(): void {
  const roots = [import.meta.url, process.argv[1]].filter(
    (anchor): anchor is string => typeof anchor === 'string' && anchor.length > 0,
  )
  const visitedAnchors = new Set<string>()
  const registeredCopies = new Set<string>()
  const walk = (anchor: string): void => {
    if (visitedAnchors.has(anchor)) return
    visitedAnchors.add(anchor)
    let req: ReturnType<typeof createRequire>
    try {
      req = createRequire(anchor)
    } catch {
      return
    }
    try {
      const copy = req.resolve('@deepseek-ai/dsh-session')
      if (!registeredCopies.has(copy)) {
        registeredCopies.add(copy)
        const mod = req(copy) as { KNOWN_SESSION_EVENT_TYPES?: Set<string> }
        for (const type of LEGACY_SESSION_EVENT_TYPES) {
          mod.KNOWN_SESSION_EVENT_TYPES?.add(type)
        }
      }
    } catch {
      // No resolvable dsh-session copy from this anchor — nothing here.
    }
    try {
      walk(req.resolve('@deepseek-ai/dsh-session-persistence'))
    } catch {
      // Validator package not reachable from this tree — nothing to cover.
    }
  }
  for (const root of roots) walk(root)
}

/**
 * Read a session's display title from its persisted log, tolerantly.
 *
 * Why not `persistence.load()`: the backend validates every event against
 * KNOWN_SESSION_EVENT_TYPES and throws the WHOLE load when a third-party
 * plugin wrote an unmarked unknown type. A picker label is
 * read-only UI state: decoding frames directly here keeps titles working
 * for logs the strict path refuses, now and for future plugin event types.
 *
 * Title precedence: the LAST `session/title` event wins (a /rename append
 * overrides the first-prompt auto title), falling back to the first user
 * message text. `hasUserMessage` drives the picker's launch-artifact filter.
 * @param sessionId - Session whose log should be read.
 * @returns The title info, or undefined when the log is absent/undecodable.
 */
export function readSessionTitleFromLog(
  sessionId: string,
): { title?: string; hasUserMessage: boolean } | undefined {
  try {
    const file = findSessionLogFile(sessionId)
    if (file === undefined) return undefined
    const events = decodeEvents(readFileSync(file))
    let titled: string | undefined
    let firstUser: string | undefined
    let hasUserMessage = false
    for (const event of events) {
      if (event['type'] === 'session/title') {
        const title = (event['data'] as { title?: unknown } | undefined)?.['title']
        if (typeof title === 'string' && title.trim().length > 0) titled = title
      } else if (event['type'] === 'user/message') {
        hasUserMessage = true
        if (firstUser === undefined) {
          firstUser = firstTextOfContent(
            (event['data'] as { content?: unknown } | undefined)?.['content'],
          )
        }
      }
    }
    return { title: titled ?? firstUser, hasUserMessage }
  } catch {
    return undefined
  }
}

/**
 * Extract the first text block from a user/message `content` payload.
 * Content is normally a block array; a bare string is accepted defensively.
 * @param content - The event's content field.
 * @returns The trimmed text, or undefined when no text block exists.
 */
function firstTextOfContent(content: unknown): string | undefined {
  if (typeof content === 'string') return content.trim() || undefined
  if (!Array.isArray(content)) return undefined
  for (const block of content) {
    if (
      block !== null &&
      typeof block === 'object' &&
      (block as { type?: unknown }).type === 'text' &&
      typeof (block as { text?: unknown }).text === 'string'
    ) {
      const text = ((block as { text: string }).text).trim()
      if (text.length > 0) return text
    }
  }
  return undefined
}

/**
 * Append a `session/title` event to a persisted session's log — the
 * `/resume` picker rename for a NON-LIVE session (the live one goes through
 * `session.append` in the channel). The backend flushes by appending zstd
 * frames, so the new event lands as one more frame: existing bytes stay
 * untouched (the frame-0 header invariant holds), and `last title wins` in
 * {@link readSessionTitleFromLog} surfaces the new name. The seq continues
 * the log's contiguity contract (seq = event count) by taking maxSeq + 1.
 * The frame is APPEND-ONLY (O_APPEND), matching the backend's own flush
 * discipline: this store is shared with dsh web (#24), and a
 * read-concat-rewrite (tmp + rename) would silently drop a frame another
 * writer lands between our read and replace. A single append never rewrites
 * existing bytes, so concurrent frames all survive; the worst remaining
 * race is a duplicate seq when the maxSeq read above passes another
 * appender — benign next to lost frames, since last-title-wins keeps the
 * rename semantics. Never throws.
 * @param sessionId - Session to rename.
 * @param title - New display title (already trimmed by the caller).
 * @returns 'appended', or 'unavailable' when the log is absent/undecodable.
 */
export function appendSessionTitle(sessionId: string, title: string): 'appended' | 'unavailable' {
  try {
    const file = findSessionLogFile(sessionId)
    if (file === undefined) return 'unavailable'
    const events = decodeEvents(readFileSync(file))
    let maxSeq = -1
    for (const event of events) {
      const seq = event['seq']
      if (typeof seq === 'number' && seq > maxSeq) maxSeq = seq
    }
    // Same envelope shape as a manual /rename append ({ title } only); the
    // seed validator asks only for type/seq/time/data on non-message types.
    const event = {
      type: 'session/title',
      seq: maxSeq + 1,
      time: Date.now(),
      data: { title },
    }
    const frame = zstdCompressSync(Buffer.from(JSON.stringify(event) + '\n', 'utf8'))
    appendFileSync(file, frame)
    return 'appended'
  } catch {
    return 'unavailable'
  }
}

/**
 * Delete a persisted session's log directory (`<root>/<workspace>/<id>/`),
 * the `/resume` picker delete. The directory holds only session.jsonl.zstd
 * today; removing it whole keeps future sidecar files from orphaning. The
 * backend's list() materializes entries from these logs, so the session
 * drops out of the picker on the next refresh. Never throws.
 * @param sessionId - Session to delete (must not be the live session).
 * @returns 'deleted', or 'unavailable' when the log is absent.
 */
export function deleteSessionLog(sessionId: string): 'deleted' | 'unavailable' {
  try {
    const file = findSessionLogFile(sessionId)
    if (file === undefined) return 'unavailable'
    const dir = dirname(file)
    // Containment must hold after resolving symlinks, not just lexically:
    // a symlinked workspace directory (<root>/<ws -> /outside>/<id>) would
    // steer the recursive rm outside the sessions root even with a clean
    // whitelisted id. realpath BOTH sides — the root itself may legitimately
    // live behind a symlink (macOS /tmp -> /private/tmp).
    const realDir = realpathSync(dir)
    const contained = sessionsRoots().some(root => {
      try {
        return realDir.startsWith(realpathSync(root) + sep)
      } catch {
        return false
      }
    })
    if (!contained) return 'unavailable'
    rmSync(dir, { recursive: true, force: true })
    return 'deleted'
  } catch {
    return 'unavailable'
  }
}
