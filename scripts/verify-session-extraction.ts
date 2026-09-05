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
const liveAdoption = readFileSync(new URL('../src/dsh-adapter/channel/session-live-adoption.ts', import.meta.url), 'utf8')
const resume = readFileSync(new URL('../src/dsh-adapter/channel/session-resume.ts', import.meta.url), 'utf8')
const treeActions = readFileSync(new URL('../src/dsh-adapter/channel/session-tree-actions.ts', import.meta.url), 'utf8')

assert.match(channel, /createManualCompaction/u)
assert.doesNotMatch(channel, /resetSessionProjection/u, 'all session projection resets belong to session action modules')
assert.doesNotMatch(channel, /let manualCompaction:/u, 'manual transaction state belongs to channel/compaction.ts')
assert.doesNotMatch(channel, /const cancelledCompactions/u, 'switch cancellation bookkeeping belongs to channel/compaction.ts')
assert.doesNotMatch(channel, /compactService\.compactNow/u, 'channel.ts must delegate the compact transaction')
assert.doesNotMatch(channel, /async rewindTo\(/u, 'row rewind mechanics belong to channel/session-rewind.ts')
assert.doesNotMatch(channel, /async forkSession\(/u, 'detached fork mechanics belong to channel/session-fork.ts')
assert.doesNotMatch(channel, /(?:const|let) adoptLiveAgent\s*=\s*async/u, 'live adoption belongs to channel/session-live-adoption.ts')
assert.doesNotMatch(channel, /(?:const|let) resumeInto\s*=\s*async/u, 'persisted agent-view resume belongs to channel/session-resume.ts')
assert.doesNotMatch(channel, /async rewindToNode\(/u, 'tree-node rewind mechanics belong to channel/session-tree-actions.ts')
assert.doesNotMatch(channel, /async resumeTo\(/u, 'resume mechanics belong to channel/session-resume.ts')
assert.doesNotMatch(channel, /async newSession\(/u, 'fresh-session mechanics belong to channel/session-resume.ts')
assert.match(channel, /adoptLiveAgent = createLiveAgentAdoption\(/u)
assert.match(channel, /const resumeActions = createSessionResumeActions\(/u)
assert.match(channel, /resumeInto = resumeActions\.resumeInto/u)
assert.match(channel, /rewindToNodeAction = createTreeRewindAction\(/u)
assert.match(compaction, /const settle = async/u)
assert.match(compaction, /deps\.agent\(\) === originAgent/u, 'extracted transaction preserves the original-agent guard')
assert.match(compaction, /owner: Pick<ChannelOwner, 'current' \| 'signal' \| 'own'>/u, 'compaction receives the channel owner lifecycle')
assert.match(compaction, /controller\.abort\(new Error\('channel lifetime ended'\)\)/u, 'owner disposal aborts in-flight compaction')
assert.match(compaction, /if \(!isCurrent\(\)\) return/u, 'late decision and completion paths are fenced')
assert.match(channel, /settleCompaction: \(\) => settleManualCompaction\(\)/u, 'dependent actions lazily read the installed settle function')
assert.match(adoption, /export function createSessionAdoption/u)
assert.match(adoption, /deps\.binding\.adopt/u)
assert.match(rewind, /export function createRewindToAction/u)
assert.match(rewind, /waitForTurnEnd/u)
assert.match(fork, /export function createForkSessionAction/u)
assert.match(fork, /settleCompaction/u)
assert.match(reset, /export function resetSessionProjection/u)
assert.match(reset, /resetProjector\(\)/u)
assert.match(reset, /markChannelReadDirty\(state\.rows\)/u)
assert.match(liveAdoption, /export function createLiveAgentAdoption/u)
assert.match(liveAdoption, /deps\.binding\.switchTo/u)
assert.match(resume, /export function createSessionResumeActions/u)
assert.match(resume, /const resumeInto/u)
assert.match(resume, /const resumeTo/u)
assert.match(resume, /const newSession/u)
assert.match(treeActions, /export function createTreeRewindAction/u)
assert.match(treeActions, /rewindTarget/u)

console.log('verify:session-extraction OK (all L4 session actions and common adoption reset stay extracted)')
