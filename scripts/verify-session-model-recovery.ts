/** Route metadata outside both fast windows, old cache enrichment, and append updates.
 * Run: node --import tsx/esm scripts/verify-session-model-recovery.ts
 */
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
const testHome = mkdtempSync(join(tmpdir(), 'dshtui-model-recovery-'))
process.env.HOME = testHome
process.env.USERPROFILE = testHome
const [{ digestSession, recoverSessionModel }, { listSummaries }, { settled }] = await Promise.all([
  import('../src/dsh-adapter/sessions/digest.js'), import('../src/dsh-adapter/sessions/list.js'), import('./lib/term-test.mjs'),
])
const encode = (line: unknown) => zstdCompressSync(Buffer.from(JSON.stringify(line) + '\n'))
const filler = () => encode({ type: 'test/padding', data: { value: randomBytes(160_000).toString('hex') } })
const route = (model: string) => encode({ type: 'request/header', data: { header: { config: { provider: 'p', model } } } })
const headers: { id: string; cwd: string; createdAt: number }[] = []
const paths = new Map<string, string>()
for (const [id, body, expected] of [
  ['head', [route('a'), filler(), filler()], 'a'],
  ['middle', [route('a'), filler(), route('b'), filler()], 'b'],
  ['tail', [filler(), route('c')], 'c'],
  ['legacy', [encode({ type: 'request/context', data: { model: 'legacy' } }), filler()], 'legacy'],
  ['no-request', [filler(), filler()], undefined],
] as const) {
  const header = { id, cwd: '/proj', createdAt: 1 }
  headers.push(header)
  const dir = join(testHome, 'sessions', id)
  mkdirSync(dir, { recursive: true })
  const path = join(dir, 'session.jsonl.zstd')
  paths.set(id, path)
  writeFileSync(path, Buffer.concat([encode({ type: 'session', version: 0, ...header }), ...body, encode({ type: 'session/title', data: { title: id } })]))
  const recovered = await recoverSessionModel(path, statSync(path).size)
  assert.deepEqual(recovered, { model: expected, complete: true }, id)
  if (id === 'head' || id === 'middle') assert.equal(digestSession(path, '/proj').model, undefined)
}
const source = { list: async () => headers, locate: (header: { id: string }) => ({ path: paths.get(header.id) }) }
await listSummaries(source)
const indexPath = join(testHome, '.dsh-tui', 'session-index.json')
// Simulate an unchanged old cache whose titles are already conclusive but routes are missing.
const { readFileSync } = await import('node:fs')
const old = JSON.parse(readFileSync(indexPath, 'utf8'))
for (const entry of Object.values(old.entries) as { derived: Record<string, unknown> }[]) {
  delete entry.derived.model
  delete entry.derived.modelComplete
  entry.derived.titleComplete = true
}
writeFileSync(indexPath, JSON.stringify(old))
await listSummaries(source)
assert.equal(await settled(() => {
  const cache = JSON.parse(readFileSync(indexPath, 'utf8'))
  return headers.every(h => cache.entries[h.id]?.derived.modelComplete === true)
}), true, 'old cache enriches despite complete titles')
let rows = await listSummaries(source)
assert.equal(rows.find(r => r.id === 'head')?.model, 'a')
assert.equal(rows.find(r => r.id === 'middle')?.model, 'b')
assert.equal(rows.find(r => r.id === 'no-request')?.model, undefined)
appendFileSync(paths.get('middle')!, route('c'))
rows = await listSummaries(source)
assert.equal(rows.find(r => r.id === 'middle')?.model, 'c', 'append updates the recorded model')
const torn = join(testHome, 'torn.jsonl.zstd')
const damaged = Buffer.concat([encode({ type: 'session', id: 'torn' }), filler()])
writeFileSync(torn, damaged.subarray(0, damaged.length - 3))
assert.equal((await recoverSessionModel(torn, damaged.length - 3)).complete, false, 'torn log cannot prove absence')
const abort = new AbortController()
abort.abort(new Error('cancel recovery'))
await assert.rejects(recoverSessionModel(torn, damaged.length - 3, abort.signal), /cancel recovery/)
console.log('verify:session-model-recovery OK (head/middle/tail, legacy, no request, old cache, append)')
