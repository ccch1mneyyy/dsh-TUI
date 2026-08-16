#!/usr/bin/env node
/**
 * Regression: bounded log reads and the revision-keyed session index.
 *
 * The picker this replaces decompressed every frame of the twenty most
 * recently used logs on every open — measured at 3.9 s over a 31 MB history —
 * to recover one line of text per session. Two mechanisms removed that: the
 * reader walks only the frames at the ends of a log, and the result is cached
 * against the backend's own per-log change token.
 *
 * Both mechanisms can fail silently, so both are checked against oracles
 * rather than by inspection:
 *
 *  - The bounded reader is checked against a FULL decode of the same log. Any
 *    difference is the bug; there is no theory to get wrong.
 *  - The cache is checked by rewriting a log's CONTENT while preserving the
 *    size and mtime its change token is derived from. A reader that honours
 *    the token cannot notice; one that silently re-derives shows the new text
 *    and fails here.
 *  - The index is checked for final-state equivalence: an index grown across
 *    a sequence of mutations must be byte-identical to one built from
 *    scratch at the same final state.
 *
 * Run: `node scripts/verify-session-index.mjs`
 * Exits non-zero on any assertion failure (CI gate).
 */
import assert from 'node:assert/strict'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'

const root = mkdtempSync(join(tmpdir(), 'dsh-tui-index-'))
const home = mkdtempSync(join(tmpdir(), 'dsh-tui-index-home-'))
process.env.DSH_TUI_SESSION_ROOT = root
process.env.HOME = home
process.env.USERPROFILE = home

const { walkFrames, resyncFrames, decodeFrames, decodeTail, readWindow } =
  await import('../lib/types/dsh-adapter/sessions/frames.js')

/** The digest's own head read, composed from the same primitives it uses. */
const headLinesOf = (file, bytes = 64 * 1024, maxFrames = 128) => {
  const window = readWindow(file, bytes)
  return window === undefined ? [] : decodeFrames(window.buffer, walkFrames(window.buffer, 0, maxFrames))
}
/** The digest's own tail read. */
const tailLinesOf = (file, bytes = 128 * 1024) => {
  const window = readWindow(file, bytes, true)
  return window === undefined ? [] : decodeTail(window)
}
const { digestSession, previewSession } = await import('../lib/types/dsh-adapter/sessions/digest.js')
const { listSummaries } = await import('../lib/types/dsh-adapter/sessions/list.js')
const { readIndex } = await import('../lib/types/dsh-adapter/sessions/store.js')

let checks = 0
function check(name, actual, expected) {
  assert.deepEqual(actual, expected, name)
  checks += 1
}
function ok(name, condition, detail = '') {
  assert.ok(condition, `${name}${detail ? ` (${detail})` : ''}`)
  checks += 1
}

const INDEX_FILE = join(home, '.dsh-tui', 'session-index.json')

/** One zstd frame per event batch — the container the backend writes. */
function encode(batches) {
  return Buffer.concat(
    batches.map(batch =>
      zstdCompressSync(Buffer.from(batch.map(e => JSON.stringify(e)).join('\n') + '\n', 'utf8')),
    ),
  )
}

function seed(id, batches, { cwd = '/proj', ...extra } = {}) {
  const dir = join(root, '--proj--', id)
  mkdirSync(dir, { recursive: true })
  const header = { type: 'session', version: 0, id, createdAt: 1000, cwd, ...extra }
  const file = join(dir, 'session.jsonl.zstd')
  writeFileSync(file, encode([[header], ...batches]))
  return file
}

const userPrompt = (text, seq = 1) => ({
  type: 'user/message',
  seq,
  time: 2000 + seq,
  data: { content: [{ type: 'text', text }], source: { kind: 'user' } },
})
const autoTitle = (title, seq) => ({
  type: 'session/title',
  seq,
  time: 2000 + seq,
  data: { title, source: { kind: 'provider', provider: 'session-title-first-prompt-llm' } },
})
const manualTitle = (title, seq) => ({ type: 'session/title', seq, time: 2000 + seq, data: { title } })

// ── 1. Frame walking is structural, not a magic scan ────────────────────
const batches = [
  [{ type: 'session', version: 0, id: 'walk', createdAt: 1, cwd: '/proj' }],
  [userPrompt('hello')],
  [autoTitle('Hello', 2)],
  [{ type: 'turn/end', seq: 3, time: 3, data: { turn: 1 } }],
]
const walkBuf = encode(batches)
const frames = walkFrames(walkBuf)
check('every written frame is found', frames.length, batches.length)
check('the walk consumes the file exactly', frames[frames.length - 1].end, walkBuf.length)
check('frames are contiguous', frames.every((f, i) => i === 0 || f.start === frames[i - 1].end), true)
check('maxFrames bounds the walk', walkFrames(walkBuf, 0, 2).length, 2)
check(
  'a buffer cut mid-frame reports one fewer COMPLETE frame, never a partial one',
  walkFrames(walkBuf.subarray(0, walkBuf.length - 3)).length,
  batches.length - 1,
)
check('a buffer that is not a frame yields nothing', walkFrames(Buffer.from('not zstd at all')).length, 0)
check('an empty buffer yields nothing', walkFrames(Buffer.alloc(0)).length, 0)

// Re-synchronizing from an arbitrary offset must land on a real boundary.
const tailOnly = walkBuf.subarray(frames[1].start + 5)
const resynced = resyncFrames(tailOnly)
check('resync recovers the frames whose chain ends at the buffer end', resynced.length, 2)
check(
  'resynced frames decode to the events they held',
  decodeFrames(tailOnly, resynced).map(e => e.type),
  ['session/title', 'turn/end'],
)

// A frame that cannot be decompressed must cost only itself.
const damaged = Buffer.from(walkBuf)
damaged[frames[1].start + 9] ^= 0xff
const survived = decodeFrames(damaged, walkFrames(damaged))
ok('a damaged frame does not take the rest of the log with it', survived.length >= 2, `got ${survived.length}`)
check('and the surviving frames keep their order', survived[0].type, 'session')

// ── 2. Bounded reads agree with a full decode ───────────────────────────
// Deterministic high-entropy filler: zstd would squeeze a repeated character
// down to nothing, and the point of the fixture is to EXCEED the head window.
let noise = 12345
const filler = (n) => {
  let out = ''
  for (let i = 0; i < n; i++) {
    noise = (noise * 1103515245 + 12345) & 0x7fffffff
    out += String.fromCharCode(33 + (noise % 90))
  }
  return out
}
const bigBatches = [[{ type: 'session', version: 0, id: 'big', createdAt: 1, cwd: '/proj' }], [userPrompt('the real question')]]
for (let i = 0; i < 400; i++) {
  bigBatches.push([{ type: 'assistant/chunk', seq: 10 + i, time: 3000 + i, data: { text: filler(500) } }])
}
bigBatches.push([manualTitle('renamed at the very end', 900)])
const bigFile = seed('big', bigBatches.slice(1), { cwd: '/proj' })
const bigSize = statSync(bigFile).size
ok('the fixture is larger than the head window', bigSize > 64 * 1024, `${bigSize} bytes`)

const full = decodeFrames(readFileSync(bigFile), walkFrames(readFileSync(bigFile)))
const head = headLinesOf(bigFile)
const tail = tailLinesOf(bigFile)
check('the head window reaches the opening prompt', head.some(e => e.type === 'user/message'), true)
check('the head window is a prefix of the full decode', head.map(e => e.type), full.slice(0, head.length).map(e => e.type))
check('the tail window is a suffix of the full decode', tail.map(e => e.type), full.slice(full.length - tail.length).map(e => e.type))
check('the tail window reaches the last title', tail.some(e => e.type === 'session/title'), true)

const bigDigest = digestSession(bigFile, '/proj')
check('title comes from the END of the log, where a rename lands', bigDigest.title.text, 'renamed at the very end')
check('a title with no provider source is a rename', bigDigest.title.source, 'renamed')
check('a log this size obviously holds a conversation', bigDigest.hasPrompt, true)

// ── 3. Title provenance and prompt detection ────────────────────────────
const autoFile = seed('auto', [[userPrompt('what is this')], [autoTitle('What is this', 2)]])
check('a provider-written title reads as auto', digestSession(autoFile, '/proj').title, {
  text: 'What is this',
  source: 'auto',
})

const promptFile = seed('prompt', [[userPrompt('no title event here')]])
check('with no title event the opening prompt stands in', digestSession(promptFile, '/proj').title, {
  text: 'no title event here',
  source: 'prompt',
})

const bootFile = seed('boot', [
  [{ type: 'permission/preset', seq: 0, time: 1, data: { preset: 'danger-full-access' } }],
  [{ type: 'sandbox/mode', seq: 1, time: 2, data: { mode: 'danger-full-access' } }],
  [{ type: 'approval/policy', seq: 2, time: 3, data: { policy: 'never' } }],
])
const bootDigest = digestSession(bootFile, '/proj')
check('a session holding only boot policy has no conversation', bootDigest.hasPrompt, false)
check('and falls back to the directory name, saying so', bootDigest.title, { text: 'proj', source: 'fallback' })

const injectedFile = seed('injected', [
  [{
    type: 'user/message',
    seq: 1,
    time: 2,
    data: { content: [{ type: 'text', text: 'plugin text' }], source: { kind: 'plugin', plugin: 'x' } },
  }],
])
check(
  'a user-role message injected by a plugin is not a conversation',
  digestSession(injectedFile, '/proj').hasPrompt,
  false,
)

const splicedFile = seed('spliced', [
  [{
    type: 'agent/inbox/spliced',
    seq: 1,
    time: 2,
    data: { target: 'next-turn', start: 0, inserted: [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'via the inbox' }] }] },
  }],
])
check(
  'the inbox splice counts as the opening prompt (it reaches the log first)',
  digestSession(splicedFile, '/proj').title,
  { text: 'via the inbox', source: 'prompt' },
)

check('a missing log degrades instead of throwing', digestSession(join(root, 'nope', 'x.zstd'), '/proj'), {
  title: undefined,
  hasPrompt: false,
  model: undefined,
  label: undefined,
})
check('a missing log has no window', readWindow(join(root, 'nope', 'x.zstd'), 100), undefined)

const modelFile = seed('model', [
  [userPrompt('hi')],
  [{ type: 'request/context', seq: 5, time: 5, data: { provider: 'deepseek-official', model: 'deepseek-v4-pro', contextWindow: 1000000 } }],
])
check('the route is read from the last request context', digestSession(modelFile, '/proj').model, 'deepseek-v4-pro')

const runFile = seed(
  'run',
  [
    [{ type: 'subagent/descriptor', seq: 0, time: 1, data: { version: 2, mode: 'continuable', provider: 'spawn', label: 'consistency audit' } }],
    [userPrompt('you are an auditor')],
  ],
  { origin: 'subagent', parentSession: 'auto', delegationDepth: 1 },
)
check('a delegated run carries the label it was started under', digestSession(runFile, '/proj').label, 'consistency audit')

const previewFile = seed('preview', [
  [userPrompt('first question', 1)],
  [{ type: 'assistant/message', seq: 2, time: 5, data: { message: { role: 'assistant', content: [{ type: 'reasoning', text: 'thinking' }, { type: 'text', text: 'first answer' }] } } }],
  [userPrompt('second question', 3)],
  [{ type: 'assistant/message', seq: 4, time: 7, data: { message: { role: 'assistant', content: [{ type: 'text', text: 'second answer' }] } } }],
])
check(
  'the preview reads the exchanges, skipping reasoning blocks',
  previewSession(previewFile, 8).map(e => [e.role, e.text]),
  [['user', 'first question'], ['assistant', 'first answer'], ['user', 'second question'], ['assistant', 'second answer']],
)
check('the preview keeps the NEWEST entries when it must choose', previewSession(previewFile, 2).map(e => e.text), [
  'second question',
  'second answer',
])

// ── 4. The index: hit, miss, prune, self-heal ───────────────────────────
const headers = () => [
  { id: 'auto', cwd: '/proj', createdAt: 1000 },
  { id: 'prompt', cwd: '/proj', createdAt: 1001 },
  { id: 'boot', cwd: '/proj', createdAt: 1002 },
]
const source = { list: async () => headers() }

const first = await listSummaries(source)
check('every listed session is summarized', first.map(s => s.id).sort(), ['auto', 'boot', 'prompt'])
check('the boot artifact is reported honestly, not hidden here', first.find(s => s.id === 'boot').hasPrompt, false)
check('the index was written', statSync(INDEX_FILE).isFile(), true)
check('one entry per session', readIndex().size, 3)

// Does the cache actually honour the token? Hold the backend's revision fixed
// and change the log underneath it. A reader that re-derives anyway shows the
// new text; one that honours the token cannot see the change at all. Driving
// the revision explicitly is what makes this decisive — a token derived from
// the file could not be held still while the file moves.
let pinnedRevision = 'rev-1'
const pinned = {
  listSnapshots: async () =>
    headers().map(header => ({
      header,
      revision: header.id === 'auto' ? pinnedRevision : `fixed-${header.id}`,
    })),
  locate: meta => ({ kind: 'jsonl', path: join(root, '--proj--', meta.id, 'session.jsonl.zstd') }),
}

rmSync(INDEX_FILE, { force: true })
const pinnedFirst = await listSummaries(pinned)
check('baseline title under a pinned revision', pinnedFirst.find(s => s.id === 'auto').title.text, 'What is this')

writeFileSync(
  autoFile,
  encode([
    [{ type: 'session', version: 0, id: 'auto', createdAt: 1000, cwd: '/proj' }],
    [userPrompt('what is this')],
    [autoTitle('IMPOSTOR TITLE — this log was rewritten', 2)],
  ]),
)

const cached = await listSummaries(pinned)
check(
  'an unchanged revision means an unchanged entry — the log was not re-read',
  cached.find(s => s.id === 'auto').title.text,
  'What is this',
)

pinnedRevision = 'rev-2'
const invalidated = await listSummaries(pinned)
check(
  'a moved revision forces a re-derivation, which sees the new content',
  invalidated.find(s => s.id === 'auto').title.text,
  'IMPOSTOR TITLE — this log was rewritten',
)

// The degraded path has no backend token, so it derives one from the file
// itself; a later mtime must invalidate it just the same.
rmSync(INDEX_FILE, { force: true })
await listSummaries(source)
writeFileSync(
  autoFile,
  encode([
    [{ type: 'session', version: 0, id: 'auto', createdAt: 1000, cwd: '/proj' }],
    [userPrompt('what is this')],
    [autoTitle('SECOND REWRITE', 2)],
  ]),
)
const stat2 = statSync(autoFile)
utimesSync(autoFile, new Date(stat2.mtime.getTime() + 5000), new Date(stat2.mtime.getTime() + 5000))
check(
  'the file-derived token invalidates on a later mtime',
  (await listSummaries(source)).find(s => s.id === 'auto').title.text,
  'SECOND REWRITE',
)

// Pruning: a session the backend stops listing loses its entry.
const shrunk = { list: async () => headers().filter(h => h.id !== 'boot') }
await listSummaries(shrunk)
check('an unlisted session is pruned from the index', readIndex().has('boot'), false)
check('the rest survive the prune', readIndex().size, 2)

// Self-healing: a corrupt cache costs a rebuild and nothing else.
writeFileSync(INDEX_FILE, '{ this is not json')
const healed = await listSummaries(source)
check('a corrupt index rebuilds instead of throwing', healed.length, 3)
check('and is valid again afterwards', readIndex().size, 3)

writeFileSync(INDEX_FILE, JSON.stringify({ version: 999, entries: { auto: { derived: { revision: 'x' } } } }))
const upgraded = await listSummaries(source)
check('an index from another schema version is discarded, not misread', upgraded.length, 3)
ok('and rewritten at the current version', JSON.parse(readFileSync(INDEX_FILE, 'utf8')).version === 1)

// ── 5. Final-state equivalence ──────────────────────────────────────────
// An index grown across a sequence of changes must equal one built fresh at
// the same final state. Any difference is a stale or missing entry.
seed('later', [[userPrompt('a session added along the way')]])
const allHeaders = [...headers(), { id: 'later', cwd: '/proj', createdAt: 1003 }]
const grown = { list: async () => allHeaders }
await listSummaries(grown)
utimesSync(promptFile, new Date(3e12), new Date(3e12))
await listSummaries(grown)
const incremental = readFileSync(INDEX_FILE, 'utf8')

rmSync(INDEX_FILE, { force: true })
await listSummaries(grown)
const fresh = readFileSync(INDEX_FILE, 'utf8')

check('an incrementally grown index equals one built from scratch', incremental, fresh)

// The summaries themselves must agree too, not merely the cache behind them.
const fromWarm = await listSummaries(grown)
rmSync(INDEX_FILE, { force: true })
const fromCold = await listSummaries(grown)
check(
  'and a warm listing equals a cold one, field for field',
  JSON.stringify(fromWarm),
  JSON.stringify(fromCold),
)

// ── 6. The authoritative path: listSnapshots + locate ───────────────────
const snapshotSource = {
  listSnapshots: async () =>
    allHeaders.map(header => ({ header, revision: `rev:${header.id}:${statSync(join(root, '--proj--', header.id, 'session.jsonl.zstd')).size}` })),
  locate: meta => ({ kind: 'jsonl', path: join(root, '--proj--', meta.id, 'session.jsonl.zstd') }),
}
rmSync(INDEX_FILE, { force: true })
const viaSnapshots = await listSummaries(snapshotSource)
check(
  'the backend-token path resolves the same titles as the derived-token path',
  viaSnapshots.map(s => [s.id, s.title.text]).sort(),
  fromCold.map(s => [s.id, s.title.text]).sort(),
)
check('a backend that lists nothing yields nothing', (await listSummaries({})).length, 0)
check('a backend that throws yields nothing rather than propagating', (await listSummaries({ list: async () => { throw new Error('boom') } })).length, 0)

rmSync(root, { recursive: true, force: true })
rmSync(home, { recursive: true, force: true })
console.log(`verify-session-index: OK (${checks} checks)`)
