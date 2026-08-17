/**
 * Regression checks for the compat session-log reader (sessionLog.ts):
 * packed-row expansion, budget semantics, plain/zstd layouts, chunked reads.
 * (The resume-repair sections were retired with the repair machinery itself:
 * main's resume compat registers legacy event types in-process instead of
 * rewriting logs — log bytes and 0600 permissions are never modified.)
 * Run: node --import tsx/esm scripts/sessionlog-check.ts
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { packChunkRuns, type SessionEvent } from '@deepseek-ai/dsh-session'
import {
  readSessionEventsFromFile,
  readSessionEventsFromLog,
  readSessionTitleFromLog,
  titleFromEvents,
} from '../src/dsh-adapter/compat/sessionLog.js'

// sessionsRoot() resolves DSH_TUI_SESSION_ROOT at call time, so setting it
// after the imports still isolates every lookup to this scratch root.
const root = mkdtempSync(join(tmpdir(), 'dsh-sessionlog-check-'))
process.env.DSH_TUI_SESSION_ROOT = root

let failures = 0
const check = (name: string, cond: boolean, detail?: unknown) => {
  if (!cond) {
    failures++
    console.log(`FAIL ${name}`, detail ?? '')
  } else {
    console.log(`ok   ${name}`)
  }
}

// ── Event/log fixtures ────────────────────────────────────────────────────
const HEADER = { session: { id: 'x', cwd: '/tmp/x' } }
const turnStart = (seq: number, turn: number) =>
  ({ type: 'turn/start', seq, time: 1000 + seq, data: { turn } })
const userMsg = (seq: number, text: string) =>
  ({
    type: 'user/message',
    seq,
    time: 1000 + seq,
    data: { source: { kind: 'user' }, content: [{ type: 'text', text }] },
  })
/** Packable chunk: exact whitelisted shape (envelope/data/chunk keys). */
const chunk = (seq: number, turn: number, step: number, index: number, text: string) =>
  ({
    type: 'assistant/chunk',
    seq,
    time: 1000 + seq,
    data: { turn, step, chunk: { type: 'text-delta', index, text } },
  }) as unknown as SessionEvent
const turnEnd = (seq: number, turn: number) =>
  ({ type: 'turn/end', seq, time: 1000 + seq, data: { turn, reason: { kind: 'completed' } } })
const activity = (seq: number) =>
  ({ type: 'activity/status', seq, time: 1000 + seq, ignorable: true, data: { text: 'working' } })

const writeZstd = (sessionId: string, lines: readonly unknown[]): string => {
  const dir = join(root, 'ws-a', sessionId)
  mkdirSync(dir, { recursive: true })
  const payload = lines.map(line => JSON.stringify(line)).join('\n') + '\n'
  const file = join(dir, 'session.jsonl.zstd')
  writeFileSync(file, zstdCompressSync(Buffer.from(payload, 'utf8')))
  return file
}
const writePlain = (sessionId: string, lines: readonly unknown[]): string => {
  const dir = join(root, 'ws-a', sessionId)
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'session.jsonl')
  writeFileSync(file, lines.map(line => JSON.stringify(line)).join('\n') + '\n')
  return file
}
/** Raw-text write for torn-tail fixtures (no trailing newline appended). */
const writeRaw = (name: string, text: string): string => {
  const dir = join(root, 'ws-a', name)
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'session.jsonl')
  writeFileSync(file, text)
  return file
}

// ── 1. Packed rows expand back to their member events ─────────────────────
// 8 consecutive same-block text chunks pack into ONE text-chunks line; the
// reader must hand the tree the expanded events, in order, seqs intact.
const texts = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']
const members = texts.map((text, i) => chunk(2 + i, 0, 0, 0, text))
const packed = packChunkRuns([
  turnStart(0, 0),
  userMsg(1, 'hello'),
  ...members,
  turnEnd(10, 0),
] as SessionEvent[])
check('fixture actually packs', packed.some(row => (row as { type?: string }).type === 'text-chunks'),
  packed.map(row => (row as { type?: string }).type))
writeZstd('packed', [HEADER, ...packed])

const full = readSessionEventsFromLog('packed')
check('packed log reads', full !== undefined && full.complete === true)
check('packed expands to member events', full?.events.length === 11, full?.events.length)
check('expanded seqs contiguous', full?.events.every((event, i) => event.seq === i) === true,
  full?.events.map(event => event.seq))
const expandedText = full?.events
  .filter(event => event.type === 'assistant/chunk')
  .map(event => (event.data as { chunk: { text?: string } }).chunk.text ?? '')
  .join('')
check('expanded text lossless', expandedText === 'abcdefgh', expandedText)

// ── 2. Budget counts EXPANDED events, checked before the push ─────────────
const capped = readSessionEventsFromLog('packed', 5)
check('budget bounds expanded events', capped?.events.length === 5 && capped.complete === false,
  { count: capped?.events.length, complete: capped?.complete })
const exact = readSessionEventsFromLog('packed', 11)
check('exact-fit budget reports complete', exact?.events.length === 11 && exact.complete === true,
  { count: exact?.events.length, complete: exact?.complete })
const zero = readSessionEventsFromLog('packed', 0)
check('limit 0 collects nothing, incomplete', zero?.events.length === 0 && zero.complete === false,
  { count: zero?.events.length, complete: zero?.complete })

// ── 3. Header rows and ignorable envelopes never count ────────────────────
writeZstd('noise', [
  HEADER,
  turnStart(0, 0),
  activity(1),
  userMsg(2, 'real'),
  turnEnd(3, 0),
])
const noise = readSessionEventsFromLog('noise')
check('header + ignorable skipped', noise?.events.length === 3 && noise.complete === true,
  noise?.events.map(event => `${event.type}@${event.seq}`))

// ── 3b. The scan budget bounds SKIPPED envelopes too ──────────────────────
// ignorable/seq-less rows are skipped AFTER their I/O + decompress + parse
// are paid, so the event budget alone never bounded the read's real cost: an
// ignorable-heavy log (repair-marked activity frames) forced a full scan to
// collect a handful of events. maxScanned caps inspected envelopes; the
// default (4× maxEvents + 4096) leaves legitimate interleavings untouched.
writePlain('ignorable-heavy', [
  HEADER,
  ...Array.from({ length: 1000 }, (_, i) => activity(100 + i)),
  turnStart(2000, 0),
  userMsg(2001, 'real'),
  turnEnd(2002, 0),
])
const heavyDefault = readSessionEventsFromLog('ignorable-heavy')
check('ignorable-heavy reads fully by default', heavyDefault?.events.length === 3 && heavyDefault.complete === true,
  { count: heavyDefault?.events.length, complete: heavyDefault?.complete })
// scanned counts EVERY expanded envelope — header, 1000 ignorable, 3 real.
check('full read reports the real scan cost', heavyDefault?.scanned === 1004, heavyDefault?.scanned)
const heavyCapped = readSessionEventsFromLog('ignorable-heavy', Number.POSITIVE_INFINITY, 100)
check('scan budget truncates an ignorable flood', heavyCapped !== undefined
  && heavyCapped.events.length === 0 && heavyCapped.complete === false,
  { count: heavyCapped?.events.length, complete: heavyCapped?.complete })
// The cap returns as soon as the (maxScanned+1)-th envelope is inspected.
check('capped read reports scanned = budget + 1', heavyCapped?.scanned === 101, heavyCapped?.scanned)
const heavySmallEventBudget = readSessionEventsFromLog('ignorable-heavy', 10)
check('default scan budget follows maxEvents', heavySmallEventBudget?.events.length === 3
  && heavySmallEventBudget.complete === true && heavySmallEventBudget.scanned === 1004,
  heavySmallEventBudget?.scanned)

// ── 4. Plain layout (compression:"none") reads identically ────────────────
writePlain('plain', [HEADER, ...packed])
const plainRead = readSessionEventsFromLog('plain')
check('plain log expands packed rows', plainRead?.events.length === 11 && plainRead.complete === true,
  { count: plainRead?.events.length, complete: plainRead?.complete })
const plainCapped = readSessionEventsFromLog('plain', 4)
check('plain budget bounded', plainCapped?.events.length === 4 && plainCapped.complete === false)
// Unpacked plain lines (packChunks off) read the same way.
writePlain('plain-raw', [HEADER, turnStart(0, 0), userMsg(1, 'raw'), ...members, turnEnd(10, 0)])
const plainRaw = readSessionEventsFromLog('plain-raw')
check('plain unpacked lines read', plainRaw?.events.length === 11 && plainRaw.complete === true,
  plainRaw?.events.length)

// ── 5. Reads stay correct across the 64 KiB chunk boundary ────────────────
// One giant text blob forces the frame (and its lines) to straddle several
// read chunks; a magic split across the boundary must still delimit frames.
const big = 'x'.repeat(200_000)
writeZstd('big', [
  HEADER,
  turnStart(0, 0),
  userMsg(1, big),
  turnEnd(2, 0),
  turnStart(3, 1),
  userMsg(4, 'tail'),
  turnEnd(5, 1),
])
const bigRead = readSessionEventsFromLog('big')
check('large frame across read chunks', bigRead?.events.length === 6 && bigRead.complete === true,
  bigRead?.events.map(event => `${event.type}@${event.seq}`))
const bigTail = readSessionEventsFromLog('big', 2)
check('large log budget stops early', bigTail?.events.length === 2 && bigTail.complete === false)

// ── 7. Torn tails: plain ignores the uncommitted line, zstd rejects it ────
// Plain: a final line WITHOUT its newline is a crash-mid-append residue —
// the backend ignores it, and the reader must not show events load() would
// not acknowledge (even when the fragment happens to parse).
const tornPlain = writeRaw('torn-plain',
  `${JSON.stringify(HEADER)}\n${JSON.stringify(userMsg(0, 'committed'))}\n${JSON.stringify(userMsg(1, 'uncommitted'))}`)
const tornPlainRead = readSessionEventsFromLog('torn-plain')
check('plain torn tail ignored', tornPlainRead?.events.length === 1 && tornPlainRead.complete === true,
  tornPlainRead?.events.map(event => event.seq))
// Zstd: an unterminated record INSIDE a complete frame is corruption — and
// the check runs BEFORE any line is yielded, so no event budget can skip it
// and misread the frame as merely truncated. An existing-but-undecodable log
// reports failed: true (never undefined — that means ABSENT), so the tree
// degrades to a placeholder instead of escalating to an unbounded re-read.
const tornFrame = zstdCompressSync(Buffer.from(
  `${JSON.stringify(HEADER)}\n${JSON.stringify(userMsg(0, 'committed'))}\n${JSON.stringify(userMsg(1, 'torn'))}`,
  'utf8'))
const tornZstdDir = join(root, 'ws-a', 'torn-zstd')
mkdirSync(tornZstdDir, { recursive: true })
writeFileSync(join(tornZstdDir, 'session.jsonl.zstd'), tornFrame)
check('zstd torn record → failed (unbounded)', readSessionEventsFromLog('torn-zstd')?.failed === true)
check('zstd torn record → failed (limit 0)', readSessionEventsFromLog('torn-zstd', 0)?.failed === true)
check('zstd torn record → failed (limit 1)', readSessionEventsFromLog('torn-zstd', 1)?.failed === true)
check('zstd torn record → failed (exact fit)', readSessionEventsFromLog('torn-zstd', 2)?.failed === true)

// ── 7b. A torn FINAL frame is uncommitted — committed frames survive ──────
// A crash mid-flush leaves a PREFIX of the next frame; the structural frame
// walker knows the exact frame end, so it drops the partial tail like the
// plain reader's unterminated line instead of failing the whole log.
const committedFrame = zstdCompressSync(Buffer.from(
  `${JSON.stringify(HEADER)}\n${JSON.stringify(userMsg(0, 'committed'))}\n`, 'utf8'))
const uncommittedFrame = zstdCompressSync(Buffer.from(
  `${JSON.stringify(userMsg(1, 'uncommitted'))}\n`, 'utf8'))
const tornTailDir = join(root, 'ws-a', 'torn-tail')
mkdirSync(tornTailDir, { recursive: true })
writeFileSync(join(tornTailDir, 'session.jsonl.zstd'),
  Buffer.concat([committedFrame, uncommittedFrame.subarray(0, uncommittedFrame.length >> 1)]))
const tornTail = readSessionEventsFromLog('torn-tail')
check('torn final frame dropped, committed prefix kept',
  tornTail?.events.map(event => `${event.type}@${event.seq}`).join(',') === 'user/message@0'
  && tornTail.complete === true && tornTail.failed !== true,
  { events: tornTail?.events.map(event => event.seq), complete: tornTail?.complete, failed: tornTail?.failed })
// A log whose FIRST frame is torn has nothing committed at all: that stays a
// hard failure (failed), never a silently empty read.
const headTornDir = join(root, 'ws-a', 'head-torn')
mkdirSync(headTornDir, { recursive: true })
writeFileSync(join(headTornDir, 'session.jsonl.zstd'),
  uncommittedFrame.subarray(0, uncommittedFrame.length >> 1))
check('torn first frame → failed', readSessionEventsFromLog('head-torn')?.failed === true)

// ── 8. Backend-resolved paths (locate): content-sniffed encoding ──────────
// readSessionEventsFromFile takes the physical path directly, and also the
// logical name (no encoding suffix) — the .zstd twin is probed.
const viaFile = readSessionEventsFromFile(join(root, 'ws-a', 'packed', 'session.jsonl.zstd'))
check('file-level read (physical path)', viaFile?.events.length === 11 && viaFile.complete === true)
const viaLogical = readSessionEventsFromFile(join(root, 'ws-a', 'packed', 'session.jsonl'))
check('file-level read (logical name → .zstd twin)',
  viaLogical?.events.length === 11 && viaLogical.complete === true)
const viaPlainFile = readSessionEventsFromFile(join(root, 'ws-a', 'plain', 'session.jsonl'))
check('file-level read sniffs plain encoding', viaPlainFile?.events.length === 11)
// A backend-resolved path OUTSIDE the stock root (custom root) reads the
// same way — the tree reader follows locate() hints, not just the id scan.
const customDir = mkdtempSync(join(tmpdir(), 'dsh-custom-root-'))
const customFile = join(customDir, 'artifact.jsonl')
writeFileSync(customFile, [HEADER, turnStart(0, 0), userMsg(1, 'custom root'), turnEnd(2, 0)]
  .map(line => JSON.stringify(line)).join('\n') + '\n')
check('file-level read outside the stock root',
  readSessionEventsFromFile(customFile)?.events.length === 3)

// ── 9. locate() is AUTHORITATIVE — a same-id stock copy must lose ─────────
// Stale trap: the same session id exists under the stock root (an older
// backend configuration's leftover) while the current backend's custom root
// holds the real log. The hint must win for reads; null means the backend
// authoritatively owns no per-session file (no stock fallback).
const staleId = 'stale-session'
writePlain(staleId, [HEADER, turnStart(0, 0), userMsg(1, 'STALE'), turnEnd(2, 0)])
const authoritativeFile = join(customDir, `${staleId}.jsonl`)
writeFileSync(authoritativeFile,
  [HEADER, turnStart(0, 0), userMsg(1, 'AUTHORITATIVE'), turnEnd(3, 0)]
    .map(line => JSON.stringify(line)).join('\n') + '\n')
check('events reader prefers the located path',
  readSessionEventsFromFile(authoritativeFile)?.events.length === 3)
check('title reader prefers the located path',
  readSessionTitleFromLog(staleId, authoritativeFile)?.title === 'AUTHORITATIVE')
check('title reader with null hint reads nothing',
  readSessionTitleFromLog(staleId, null) === undefined)
check('id scan still finds the stock copy',
  readSessionTitleFromLog(staleId)?.title === 'STALE')

// ── 11. Resource caps: decompression bombs and oversized frames ───────────
// maxOutputLength caps the DECOMPRESSED size of a frame: a tiny on-disk bomb
// (70 MiB of one byte ≈ a few KiB compressed) must be refused, not exploded.
const bombPayload = zstdCompressSync(Buffer.alloc(70 * 1024 * 1024, 0x78))
const bombDir = join(root, 'ws-a', 'bomb')
mkdirSync(bombDir, { recursive: true })
writeFileSync(join(bombDir, 'session.jsonl.zstd'), bombPayload)
check('decompression bomb → failed', readSessionEventsFromLog('bomb')?.failed === true)
check('bomb refused at any budget', readSessionEventsFromLog('bomb', 0)?.failed === true)
// The compressed size of a single frame is likewise capped at 64 MiB, and the
// check fires DURING accumulation (before any decompress attempt). A bare
// magic prefix followed by 65 MiB of inert bytes parses as an endless run of
// empty raw blocks; the reader must bail at the cap instead of buffering
// unboundedly.
const giantDir = join(root, 'ws-a', 'giant-frame')
mkdirSync(giantDir, { recursive: true })
writeFileSync(join(giantDir, 'session.jsonl.zstd'),
  Buffer.concat([Buffer.from([0x28, 0xb5, 0x2f, 0xfd]), Buffer.alloc(65 * 1024 * 1024)]))
check('oversized compressed frame → failed', readSessionEventsFromLog('giant-frame')?.failed === true)

// ── 11b. Structural walk: RAW-block frames (no compressed payload) ────────
// Hand-built per RFC 8878: magic, descriptor 0x20 (single-segment, 1-byte
// FCS — the 2-byte FCS form stores size-256, too easy to underflow here),
// one LAST RAW block. The walker must delimit the frame without any
// compressed payload to lean on.
const rawPayload = Buffer.from(
  `${JSON.stringify(HEADER)}\n${JSON.stringify(userMsg(0, 'raw block text'))}\n`, 'utf8')
if (rawPayload.length > 255) throw new Error('raw-block fixture must fit a 1-byte FCS')
const rawBlockHeader = 1 | (rawPayload.length << 3) // last=1, type=raw, size
const rawFrame = Buffer.concat([
  Buffer.from([0x28, 0xb5, 0x2f, 0xfd]),
  Buffer.from([0x20, rawPayload.length]),
  Buffer.from([rawBlockHeader & 0xff, (rawBlockHeader >> 8) & 0xff, (rawBlockHeader >> 16) & 0xff]),
  rawPayload,
])
const rawDir = join(root, 'ws-a', 'raw-frame')
mkdirSync(rawDir, { recursive: true })
writeFileSync(join(rawDir, 'session.jsonl.zstd'), rawFrame)
const rawRead = readSessionEventsFromLog('raw-frame')
check('raw-block frame walks and decodes',
  rawRead?.events.map(event => `${event.type}@${event.seq}`).join(',') === 'user/message@0'
  && rawRead.complete === true,
  { events: rawRead?.events.map(event => event.seq), complete: rawRead?.complete, failed: rawRead?.failed })

// ── 12. Titles read from both layouts ─────────────────────────────────────
const titled = [
  HEADER,
  turnStart(0, 0),
  userMsg(1, 'first prompt text'),
  { type: 'session/title', seq: 2, time: 1002, data: { title: 'Renamed Title' } },
  turnEnd(3, 0),
]
writeZstd('titled-zstd', titled)
writePlain('titled-plain', titled)
check('zstd title prefers last session/title',
  readSessionTitleFromLog('titled-zstd')?.title === 'Renamed Title')
check('plain title prefers last session/title',
  readSessionTitleFromLog('titled-plain')?.title === 'Renamed Title')
writePlain('titled-fallback', [HEADER, turnStart(0, 0), userMsg(1, 'fallback prompt'), turnEnd(2, 0)])
const fallback = readSessionTitleFromLog('titled-fallback')
check('title falls back to first user message',
  fallback?.title === 'fallback prompt' && fallback.hasUserMessage === true)

// titleFromEvents is the same derivation over DECODED backend events — the
// /resume picker's non-JSONL (sqlite/foreign-kind) parity path.
const fromBackend = titleFromEvents([
  turnStart(0, 0) as SessionEvent,
  userMsg(1, 'backend prompt') as SessionEvent,
  { type: 'session/title', seq: 2, time: 1002, data: { title: 'BACKEND TITLE' } } as SessionEvent,
  turnEnd(3, 0) as SessionEvent,
])
check('backend events: last session/title wins',
  fromBackend.title === 'BACKEND TITLE' && fromBackend.hasUserMessage === true)
const fromBackendFallback = titleFromEvents([userMsg(0, 'backend fallback') as SessionEvent])
check('backend events: first user message fallback',
  fromBackendFallback.title === 'backend fallback' && fromBackendFallback.hasUserMessage === true)
const fromBackendEmpty = titleFromEvents([turnStart(0, 0) as SessionEvent, turnEnd(1, 0) as SessionEvent])
check('backend events: empty session flagged',
  fromBackendEmpty.title === undefined && fromBackendEmpty.hasUserMessage === false)

// ── 13. Corruption and absence degrade to undefined ───────────────────────
const corruptFile = writeZstd('corrupt', [HEADER, turnStart(0, 0), userMsg(1, 'x'), turnEnd(2, 0)])
const bytes = readFileSync(corruptFile)
bytes[bytes.length - 3] = bytes[bytes.length - 3]! ^ 0xff
writeFileSync(corruptFile, bytes)
check('corrupt frame → failed', readSessionEventsFromLog('corrupt')?.failed === true)
check('missing session → undefined', readSessionEventsFromLog('no-such-session') === undefined)
check('missing title → undefined', readSessionTitleFromLog('no-such-session') === undefined)

// ── 14. Inherited-prefix skip (session-tree dedup) ────────────────────────
// skipBelowSeq cuts the inherited seed prefix OUT of the event budget: an
// ancestor already shows those seqs. Skipped envelopes still cost the scan
// budget (their bytes were read and parsed); session/title collects through
// the cutoff (branch-head labels need it; it never becomes an entry).
writePlain('skip', [
  HEADER,
  turnStart(0, 0),
  userMsg(1, 'inherited prompt'),
  { type: 'session/title', seq: 2, time: 1002, data: { title: 'Kept Title' } },
  turnEnd(3, 0),
  turnStart(4, 1),
  userMsg(5, 'own prompt'),
  turnEnd(6, 1),
])
const skipped = readSessionEventsFromLog('skip', Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, 4)
check('skip collects own events + titles through the cutoff',
  skipped?.events.map(event => `${event.type}@${event.seq}`).join(',')
    === 'session/title@2,turn/start@4,user/message@5,turn/end@6',
  skipped?.events.map(event => `${event.type}@${event.seq}`))
check('skipped envelopes still cost the scan budget', skipped?.scanned === 8, skipped?.scanned)
const skipCapped = readSessionEventsFromLog('skip', 2, Number.POSITIVE_INFINITY, 4)
check('event budget counts only post-cutoff events (+ titles)',
  skipCapped?.events.map(event => `${event.type}@${event.seq}`).join(',') === 'session/title@2,turn/start@4'
  && skipCapped.complete === false,
  { events: skipCapped?.events.map(event => event.seq), complete: skipCapped?.complete })
const skipAll = readSessionEventsFromLog('skip', Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, 100)
check('cutoff past the tip collects titles only',
  skipAll?.events.map(event => `${event.type}@${event.seq}`).join(',') === 'session/title@2'
  && skipAll.complete === true,
  skipAll?.events.map(event => `${event.type}@${event.seq}`))

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
