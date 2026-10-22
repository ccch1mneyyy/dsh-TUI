/** Run after compile: node scripts/verify-packed-row-budget.mjs
 * Exercise the actual compiled reader with a spy at its decoder call boundary.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, rmSync, readdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const root = mkdtempSync(join(tmpdir(), 'packed-budget-'))
// Keep relative imports anchored to the production module; change only the
// decoder entry to count calls, retaining its original implementation.
const original = new URL('../lib/types/dsh-adapter/compat/sessionLog.js', import.meta.url)
const fixture = new URL(`./sessionLog.budget-${process.pid}.js`, original)
const source = readFileSync(original, 'utf8')
assert.ok(source.includes('function decodeStorageRecord(value) {'))
writeFileSync(fixture, source.replace('function decodeStorageRecord(value) {', 'export let decoderCalls = 0\nfunction decodeStorageRecord(value) {\n  decoderCalls++'))
try {
  const reader = await import(fixture.href)
  const fdCount = existsSync('/proc/self/fd') ? readdirSync('/proc/self/fd').length : undefined
  const path = join(root, 'session.jsonl')
  const header = { type: 'session', version: 1 }
  for (const type of ['text-chunks', 'reasoning-chunks', 'tool-call-chunks']) {
    const data = { turn: 1, step: 2, index: 0, dt: Array(9999).fill(1), ...(type === 'tool-call-chunks' ? { id: 'call-1', name: 'tool', args: Array.from({ length: 10000 }, (_, i) => `${i}`) } : { texts: Array.from({ length: 10000 }, (_, i) => `${i}`) }) }
    const row = { type, seq0: 10, time0: 100, data }
    const write = value => writeFileSync(path, `${JSON.stringify(header)}\n${JSON.stringify(value)}\n`)
    write(row)
    const calls = reader.decoderCalls
    const limited = reader.readSessionEventsFromFile(path, 10000, 10)
    assert.equal(limited.complete, false)
    assert.equal(limited.failed, undefined)
    assert.equal(limited.scanned, 10, 'a rejected packed row consumes the remaining shared scan budget')
    assert.equal(limited.events.length, 0)
    assert.equal(reader.decoderCalls - calls, 1, `${type}: only header decoded`)
    const full = reader.readSessionEventsFromFile(path, 10000, 10001)
    assert.equal(full.complete, true)
    assert.equal(full.events.length, 10000)
    for (const [i, event] of full.events.entries()) {
      assert.equal(event.seq, 10 + i)
      assert.equal(event.time, 100 + i)
      const chunk = event.data.chunk
      assert.equal(type === 'tool-call-chunks' ? chunk.argumentsDelta : chunk.text, `${i}`)
      if (type === 'tool-call-chunks') assert.equal(chunk.id, 'call-1')
    }
    // Full structural validation still detects corruption before truncation.
    data.dt[3] = 0.5
    write(row)
    assert.equal(reader.readSessionEventsFromFile(path, 10000, 10).failed, true)
    assert.equal(reader.readSessionEventsFromFile(path, 10000, 10001).failed, true)
  }
  if (fdCount !== undefined) assert.equal(readdirSync('/proc/self/fd').length, fdCount, 'all reader descriptors close on truncation, corruption and success')
  console.log('PASS: all three 10,000-member forms, remaining-budget predecode gate, exact order/seq/call-ID, corrupt rows fail')
} finally {
  rmSync(fixture, { force: true })
  rmSync(root, { recursive: true, force: true })
}
