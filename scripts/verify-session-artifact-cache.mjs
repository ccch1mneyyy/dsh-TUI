#!/usr/bin/env node
/**
 * Regression: derived session summaries must survive unrelated revision churn.
 *
 * The jsonl backend derives a HISTORICAL generation's revision from that file's
 * own stat PLUS a hash over every stored generation, so appending to one
 * current v4 log moves the revision of every v0/v3 log. The listing cache must
 * not answer that by re-reading those artifacts: each derived entry carries the
 * physical stamp (dev:ino:birthtime:size:mtime:ctime) of the bytes it came
 * from, and a stamp match reuses the entry verbatim, cached revision included,
 * so the recovery queue's (id, revision) dedupe/backoff key does not restart on
 * unrelated churn. An index predating the stamp field must re-derive once per
 * entry whose backend revision really moved, and a backend that hands back bare
 * headers must move its fallback token when the artifact stamp does: size+mtime
 * alone would miss an in-place rewrite that keeps both.
 *
 * Reads are counted at the SYNC fs boundary, where the bounded window reader
 * (frames.readWindow: 64 KiB head / 128 KiB tail) touches an artifact. The
 * backend's own header reads are async, and locate()'s 4-byte encoding sniff
 * stays under the counting threshold, so mandatory location work is never
 * mistaken for a summary re-read; an append is folded in through the async
 * suffix reader, so its evidence is the title it produces. No timing gate.
 *
 * Real Context + SessionStore + Jsonl (0.1.7-rc.2) over mixed v0/v3/v4
 * fixtures; every path below lives under temp ASCII dirs.
 */
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'

const home = fs.mkdtempSync(join(tmpdir(), 'dsh-tui-artifact-home-'))
const root = fs.mkdtempSync(join(tmpdir(), 'dsh-tui-artifact-root-'))
assert.match(`${basename(home)}|${basename(root)}`, /^[\x20-\x7e|]+$/, 'fixture dir names must be ASCII')
for (const [key, value] of Object.entries({ HOME: home, USERPROFILE: home, DSH_HOME: home, DSH_TUI_SESSION_ROOT: root })) process.env[key] = value
const INDEX = join(home, '.dsh-tui', 'session-index.json')

// --- artifact read accounting: sync window reads only ---------------------
let tracking = false
let lastOpened
const summaryReads = []
const realOpenSync = fs.openSync
const realReadSync = fs.readSync
fs.openSync = (path, ...rest) => { if (tracking) lastOpened = String(path); return realOpenSync.call(fs, path, ...rest) }
// A 4-byte sniff answers "which encoding?", not "what does this session say?".
fs.readSync = (fd, buffer, offset, length, position) => {
  if (tracking && length >= 256 && lastOpened !== undefined) summaryReads.push(lastOpened)
  return realReadSync.call(fs, fd, buffer, offset, length, position)
}
syncBuiltinESMExports()

const { Context } = await import('@deepseek-ai/cordis')
const { default: SessionStore } = await import('@deepseek-ai/dsh-session')
const { default: Jsonl } = await import('@deepseek-ai/dsh-session-persistence-jsonl')
const { listSummaries } = await import('../lib/types/dsh-adapter/sessions/list.js')

// --- fixtures: three historical (v0/v0/v3) + two current (v4) sessions ----
const T = 1_700_000_000 // whole seconds, so mtimeNs round-trips exactly
const frame = value => zstdCompressSync(Buffer.from(JSON.stringify(value) + '\n'))
const headerFor = (version, id) => ({ type: 'session', version, id, createdAt: 1, delegationDepth: 0, ...(version === 0 ? {} : { isSeeded: false }) })
const promptFor = id => ({ type: 'user/message', seq: 0, time: 2, surfaceOp: 'append', data: { role: 'user', content: [{ type: 'text', text: `prompt for ${id}` }], source: { kind: 'user' }, id: `msg-${id}` } })
const titleFor = (text, seq = 1) => ({ type: 'session/title', seq, time: 3, data: { title: text, messageSeqs: [], source: { kind: 'user' } } })
const logName = version => (version === 0 ? 'session.jsonl.zstd' : `session.v${version}.jsonl.zstd`)
// Incompressible, so this trailing frame is far wider than both read windows.
const PAD = randomBytes(400 * 1024).toString('base64')
const SPECS = [
  { id: 'fixture-h0a', version: 0, title: 'alpha-title-00' },
  { id: 'fixture-h0b', version: 0, title: 'bravo-title-00' },
  { id: 'fixture-h3', version: 3, title: 'charlie-tit-00' },
  { id: 'fixture-c1', version: 4, title: 'delta-title-00' },
  { id: 'fixture-c2', version: 4, title: 'echo-title-00' },
  { id: 'fixture-rec', version: 0, title: 'recover-tit-00', pad: true },
].map((spec, index) => ({ ...spec, mtime: T - index }))
const [h0a, h0b, h3, c1, c2, rec] = SPECS
const dirOf = spec => join(root, '_no-cwd', spec.id)
const fileOf = spec => join(dirOf(spec), logName(spec.version))
const statOf = spec => fs.statSync(fileOf(spec), { bigint: true })
const buildLog = (spec, title) => Buffer.concat([
  frame(headerFor(spec.version, spec.id)),
  frame(promptFor(spec.id)),
  frame(titleFor(title)),
  // Keeps the title out of the tail window, so the derived title is honestly
  // incomplete and the recovery queue picks this session up.
  ...(spec.pad === true ? [frame({ type: 'assistant/message', seq: 2, time: 4, data: { message: { role: 'assistant', content: [{ type: 'text', text: PAD }] } } })] : []),
])
function put(spec, { title = spec.title, swapInode = false } = {}) {
  const bytes = buildLog(spec, title)
  if (swapInode) {
    fs.writeFileSync(`${fileOf(spec)}.swap`, bytes)
    fs.utimesSync(`${fileOf(spec)}.swap`, spec.mtime, spec.mtime)
    fs.renameSync(`${fileOf(spec)}.swap`, fileOf(spec))
    return
  }
  fs.mkdirSync(dirOf(spec), { recursive: true })
  fs.writeFileSync(fileOf(spec), bytes)
  fs.chmodSync(fileOf(spec), 0o600) // the backend's artifact mode
  fs.utimesSync(fileOf(spec), spec.mtime, spec.mtime)
}
for (const spec of SPECS) put(spec)
/** A different title whose log is byte-for-byte the same size. */
function sameSizeTitle(spec) {
  const size = Number(statOf(spec).size)
  for (let n = 0; n < 100; n++) {
    const candidate = spec.title.slice(0, -2) + String(n).padStart(2, '0')
    if (candidate !== spec.title && buildLog(spec, candidate).length === size) return candidate
  }
  throw new Error(`no same-size replacement title for ${spec.id}`)
}
// A shape-only edit must invalidate, whatever else it leaves alone.
function expectShape(label, before, after, sameInode) {
  assert.equal(after.size, before.size, `${label}: same byte size`)
  assert.equal(after.mtimeNs, before.mtimeNs, `${label}: mtime restored exactly`)
  assert.equal(after.ino === before.ino, sameInode, `${label}: inode`)
  assert.notEqual(after.ctimeNs, before.ctimeNs, `${label}: ctime moved`)
}
const byFile = new Map(SPECS.map(spec => [fileOf(spec).toLowerCase(), spec.id]))
const readIds = () => [...new Set(summaryReads.filter(path => path.toLowerCase().startsWith(root.toLowerCase())).map(path => byFile.get(path.toLowerCase()) ?? path))].sort()
const indexEntries = () => { try { return JSON.parse(fs.readFileSync(INDEX, 'utf8')).entries ?? {} } catch { return {} } }
const cachedRevision = id => indexEntries()[id]?.derived?.revision
function rewriteIndex(mutate) {
  const parsed = JSON.parse(fs.readFileSync(INDEX, 'utf8'))
  mutate(parsed)
  // Same entries, different bytes: the store must re-read this file from disk.
  fs.writeFileSync(INDEX, JSON.stringify(parsed, null, 1))
}

let rows = []
let fork
let storeFork
try {
  const ctx = new Context()
  storeFork = ctx.plugin(SessionStore)
  fork = ctx.plugin(Jsonl, { root, compression: 'zstd' })
  await (fork?.await ? fork.await() : fork)
  const source = ctx.get('sessionPersistence')
  assert.ok(source, 'sessionPersistence mounted')
  const tokens = async () => new Map((await source.list()).map(snapshot => [snapshot.header.id, snapshot.revision]))
  const ids = () => rows.map(item => item.id)
  async function listing(from = source) {
    summaryReads.length = 0
    tracking = true
    try { rows = [...await listSummaries(from)] } finally { tracking = false }
  }
  const expectReads = (label, expected) => assert.deepEqual(readIds(), [...expected].sort(), `${label}: full-digest reads`)
  function expectTitle(label, id, text) {
    assert.equal(rows.find(item => item.id === id)?.title.text, text, `${label}: ${id} title`)
    assert.equal(rows.find(item => item.id === id)?.title.source, 'renamed', `${label}: ${id} title source`)
    assert.equal(rows.find(item => item.id === id)?.hasPrompt, true, `${label}: ${id} hasPrompt`)
  }

  // 1. Cold: every artifact is digested once and titles come from the logs.
  await listing()
  assert.deepEqual(ids(), SPECS.map(spec => spec.id), 'cold: most recently active first')
  for (const spec of SPECS) expectTitle('cold', spec.id, spec.title)
  expectReads('cold', SPECS.map(spec => spec.id))
  assert.ok(fs.existsSync(INDEX), 'cold: the derived index is persisted')
  assert.ok(statOf(rec).size > 256 * 1024, 'recovery fixture must exceed both read windows')
  const cold = Object.fromEntries(SPECS.map(spec => [spec.id, cachedRevision(spec.id)]))

  // 2. Warm: a revision hit must not touch any artifact.
  await listing()
  expectReads('warm', [])
  expectTitle('warm', h0b.id, h0b.title)
  assert.equal(cachedRevision(h0a.id), cold[h0a.id], 'warm: cached revision stable')
  // The incomplete 'rec' title keeps the recovery queue busy; its cached
  // revision must stay put below, which is what stops a re-queue on churn.

  // 3. One v4 append moves every historical token; only the appended artifact
  //    is read (through the async suffix path, witnessed by its new title), and
  //    entries merely moved by the corpus hash keep their cached revision.
  const before = await tokens()
  fs.appendFileSync(fileOf(c1), frame(titleFor('c1-appended-title', 2)))
  const after = await tokens()
  const churned = SPECS.filter(spec => before.get(spec.id) !== after.get(spec.id)).map(spec => spec.id)
  assert.ok([h0a.id, h3.id, rec.id].every(id => churned.includes(id)), `a v4 append moves every historical token (${churned})`)
  assert.ok(!churned.includes(c2.id), 'an untouched current log keeps its own token')
  await listing()
  expectReads('append', [])
  expectTitle('append', c1.id, 'c1-appended-title')
  expectTitle('append', h0a.id, h0a.title)
  assert.deepEqual(ids(), [c1.id, h0a.id, h0b.id, h3.id, c2.id, rec.id], 'append: mtime order')
  assert.equal(cachedRevision(h0a.id), cold[h0a.id], 'unrelated churn must not rewrite a cached revision')
  assert.equal(cachedRevision(rec.id), cold[rec.id], 'the recovery retry key survives unrelated churn')

  // 4-5. Shape-only edits must invalidate: an in-place rewrite that keeps size,
  //      mtime and inode (only ctime moves), and a same-size/mtime inode swap.
  for (const [spec, swapInode] of [[h0b, false], [h3, true]]) {
    const title = sameSizeTitle(spec)
    const ahead = statOf(spec)
    put(spec, { title, swapInode })
    expectShape(spec.id, ahead, statOf(spec), !swapInode)
    await listing()
    expectReads(spec.id, [spec.id])
    expectTitle(spec.id, spec.id, title)
  }

  // 6. Deletion is not resurrected from the cache.
  fs.rmSync(dirOf(h0b), { recursive: true, force: true })
  await listing()
  expectReads('delete', [])
  assert.ok(!ids().includes(h0b.id), 'delete: absent from the listing')
  assert.ok(!(h0b.id in indexEntries()), 'delete: dropped from the index')
  await listing()
  expectReads('delete again', [])
  assert.ok(!ids().includes(h0b.id), 'delete: stays absent')

  // 7. The stamp survives the index's JSON round trip and a forced reload.
  rewriteIndex(() => {})
  assert.equal(cachedRevision(h0a.id), cold[h0a.id], 'reload: the revision survived the JSON round trip')
  fs.appendFileSync(fileOf(c2), frame(titleFor('c2-appended-title', 2)))
  await listing()
  expectReads('persisted', [])
  expectTitle('persisted', c2.id, 'c2-appended-title')
  assert.equal(cachedRevision(h0a.id), cold[h0a.id], 'a reloaded index still reuses by artifact stamp')
  assert.deepEqual(ids(), [c2.id, c1.id, h0a.id, h3.id, rec.id], 'persisted: mtime order')

  // 8. A schema-4 index written before the stamp existed cannot certify any
  //    artifact: entries whose backend revision moved are read once more, an
  //    unchanged revision stays authoritative, and the re-read is paid exactly
  //    once because the fresh derivations rewrite their stamps.
  rewriteIndex(parsed => { for (const entry of Object.values(parsed.entries ?? {})) if (entry.derived !== undefined) delete entry.derived.artifactStamp })
  fs.appendFileSync(fileOf(c1), frame(titleFor('c1-appended-again', 3)))
  await listing()
  expectReads('legacy', [h0a.id, h3.id, rec.id])
  expectTitle('legacy', c1.id, 'c1-appended-again')
  expectTitle('legacy', h0a.id, h0a.title)
  await listing()
  expectReads('legacy once only', [])

  // 9. A backend whose listing carries no revision must still invalidate on the
  //    whole stamp: a same-size, same-mtime in-place rewrite moves only ctime
  //    and would be invisible to a size+mtime fallback token.
  fs.rmSync(INDEX, { force: true })
  const bare = {
    list: async () => SPECS.filter(spec => spec.id !== h0b.id).map(spec => headerFor(spec.version, spec.id)),
    // The current generation's path, exactly as the real backend answers it.
    locate: meta => ({ path: join(root, '_no-cwd', meta.id, logName(4)) }),
  }
  await listing(bare)
  assert.deepEqual(ids(), [c1.id, c2.id, h0a.id, h3.id, rec.id], 'bare headers: mtime order')
  expectReads('bare headers', [c1.id, c2.id, h0a.id, h3.id, rec.id])
  const bareEdited = sameSizeTitle(h0a)
  const h0aAhead = statOf(h0a)
  put(h0a, { title: bareEdited })
  expectShape('bare edit fixture', h0aAhead, statOf(h0a), true)
  await listing(bare)
  expectReads('bare header edit', [h0a.id])
  expectTitle('bare header edit', h0a.id, bareEdited)

  console.log('verify-session-artifact-cache: OK')
} finally {
  tracking = false
  fs.openSync = realOpenSync
  fs.readSync = realReadSync
  syncBuiltinESMExports()
  for (const plugin of [fork, storeFork]) {
    try { await plugin?.dispose?.() } catch { /* teardown is best effort */ }
  }
  fs.rmSync(root, { recursive: true, force: true })
  fs.rmSync(home, { recursive: true, force: true })
}
process.exit(0)
