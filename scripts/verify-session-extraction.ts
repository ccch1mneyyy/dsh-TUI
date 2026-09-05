/**
 * Structural guard for L4 session-action extraction.
 *
 * This is intentionally source-level: behavioral scripts cover the compact /
 * switch race, while this prevents the transaction and common reset surface
 * from silently growing back into channel.ts.
 *
 * Run: node --import tsx/esm scripts/verify-session-extraction.ts
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const channel = readFileSync(new URL('../src/dsh-adapter/channel.ts', import.meta.url), 'utf8')
const compaction = readFileSync(new URL('../src/dsh-adapter/channel/compaction.ts', import.meta.url), 'utf8')
const reset = readFileSync(new URL('../src/dsh-adapter/channel/session-reset.ts', import.meta.url), 'utf8')
const adoption = readFileSync(new URL('../src/dsh-adapter/channel/session-adoption.ts', import.meta.url), 'utf8')
const rewind = readFileSync(new URL('../src/dsh-adapter/channel/session-rewind.ts', import.meta.url), 'utf8')
const fork = readFileSync(new URL('../src/dsh-adapter/channel/session-fork.ts', import.meta.url), 'utf8')

assert.match(channel, /createManualCompaction/u)
assert.match(channel, /resetSessionProjection/u)
assert.doesNotMatch(channel, /let manualCompaction:/u, 'manual transaction state belongs to channel/compaction.ts')
assert.doesNotMatch(channel, /const cancelledCompactions/u, 'switch cancellation bookkeeping belongs to channel/compaction.ts')
assert.doesNotMatch(channel, /compactService\.compactNow/u, 'channel.ts must delegate the compact transaction')
assert.doesNotMatch(channel, /async rewindTo\(/u, 'row rewind mechanics belong to channel/session-rewind.ts')
assert.doesNotMatch(channel, /async forkSession\(/u, 'detached fork mechanics belong to channel/session-fork.ts')
assert.match(compaction, /const settle = async/u)
assert.match(compaction, /deps\.agent\(\) !== originAgent/u, 'extracted transaction preserves the stale-agent guard')
assert.match(adoption, /export function createSessionAdoption/u)
assert.match(adoption, /deps\.binding\.adopt/u)
assert.match(rewind, /export function createRewindToAction/u)
assert.match(rewind, /waitForTurnEnd/u)
assert.match(fork, /export function createForkSessionAction/u)
assert.match(fork, /settleCompaction/u)
assert.match(reset, /export function resetSessionProjection/u)
assert.match(reset, /resetProjector\(\)/u)
assert.match(reset, /markChannelReadDirty\(state\.rows\)/u)

console.log('verify:session-extraction OK (manual compaction transaction and common adoption reset stay extracted)')
