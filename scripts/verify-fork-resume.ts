/**
 * Detached /fork -> cold JSONL read -> real Agent resume, including a nested fork.
 * Uses the installed V4 Session/Agent/JSONL services and the real channel action.
 * Closed no-op turns and delivery watermarks exercise persistence admission;
 * no model transport, credentials, network, or user-profile state is used.
 * Adapted from the regression shared in issue #1271 (jackie-cqz/dsh-TUI f4c82970).
 * Run: node --import tsx/esm scripts/verify-fork-resume.ts
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context as ContextType } from '@deepseek-ai/cordis'
import type { Session as SessionType, SessionEvent, SessionId as SessionIdType } from '@deepseek-ai/dsh-session'
import type { ChannelState } from '../src/dsh-adapter/channel.js'

const root = mkdtempSync(join(tmpdir(), 'dsh-tui-fork-resume-'))
const sessionsRoot = join(root, 'sessions')
process.env.HOME = root
process.env.USERPROFILE = root
process.env.DSH_HOME = join(root, 'home')
process.env.DSH_TUI_SESSION_ROOT = sessionsRoot
process.env.DSH_TUI_LANG = 'en'

const [
  { Context },
  { default: AgentRegistry },
  { default: AgentLoop },
  { default: LlmRuntime },
  { default: SessionStore, SessionId },
  { default: SessionProjectionRegistry },
  JsonlSessionPersistenceModule,
  { default: SystemPrompt },
  { default: ToolRuntime },
  { createChannel },
] = await Promise.all([
  import('@deepseek-ai/cordis'),
  import('@deepseek-ai/dsh-agent'),
  import('@deepseek-ai/dsh-agent-loop'),
  import('@deepseek-ai/dsh-llm'),
  import('@deepseek-ai/dsh-session'),
  import('@deepseek-ai/dsh-session-projection'),
  import('@deepseek-ai/dsh-session-persistence-jsonl'),
  import('@deepseek-ai/dsh-system-prompt'),
  import('@deepseek-ai/dsh-tools'),
  import('../src/dsh-adapter/channel.js'),
])

const JsonlSessionPersistence = 'default' in JsonlSessionPersistenceModule
  ? JsonlSessionPersistenceModule.default : JsonlSessionPersistenceModule

const contexts: ContextType[] = []
const channels: ChannelState[] = []

async function runtime(): Promise<ContextType> {
  const ctx = new Context()
  contexts.push(ctx)
  for (const plugin of [LlmRuntime, SessionStore, SessionProjectionRegistry, SystemPrompt, ToolRuntime, AgentRegistry]) {
    await ctx.plugin(plugin)
  }
  await ctx.plugin(JsonlSessionPersistence, { root: sessionsRoot })
  await ctx.plugin(AgentLoop, { agents: [] })
  return ctx
}

function closeTurnWithDelivery(session: SessionType, turn: number): void {
  session.append('turn/start', { turn })
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
  // This extension's vocabulary is accepted by the V4 format catalog even
  // though the optional upload plugin (and its TypeScript augmentation) is
  // absent. The marker names the session that originally uploaded the prefix.
  session.append('session-log-deepseek/delivery-accepted' as never, {
    sessionId: session.id,
    throughSeq: session.seq - 1,
    sessionFormatVersion: 4,
  } as never)
}

async function readCold(ctx: ContextType, id: SessionIdType) {
  const reader = await ctx.sessionPersistence.open(id, 'read')
  try {
    const read = await reader.read()
    return { ...read, header: reader.header, inheritedEventCount: reader.inheritedEventCount }
  } finally {
    await reader.close()
  }
}

async function fork(channel: ChannelState, ctx: ContextType): Promise<SessionIdType> {
  const before = new Set((await ctx.sessionPersistence.list()).map(row => row.header.id))
  assert.equal(await channel.forkSession(), true, channel.notifications.map(row => row.text).join('\n'))
  const added = (await ctx.sessionPersistence.list()).filter(row => !before.has(row.header.id))
  assert.equal(added.length, 1, 'one detached copy is persisted')
  const id = added[0]!.header.id
  assert.equal(ctx.agents.get(id), undefined, 'the detached handle releases its Agent')
  assert.equal(ctx.sessions.get(id), undefined, 'the detached handle releases its live Session')
  return id
}

function assertCopy(
  copy: Awaited<ReturnType<typeof readCold>>,
  sourceId: SessionIdType,
  inherited: readonly SessionEvent[],
  title: string,
): void {
  assert.equal(copy.header.version, 4)
  assert.equal(copy.header.parentSession, sourceId, 'the copy records its source lineage')
  assert.equal(copy.header.isSeeded, true)
  assert.equal(copy.inheritedEventCount, inherited.length, 'the inherited cut excludes the copy marker and title')
  assert.deepEqual(copy.events.slice(0, inherited.length), inherited, 'the source log is copied verbatim')
  const marker = copy.events[inherited.length]
  assert.equal(marker?.type, 'session/end-seed')
  assert.deepEqual(marker?.data, { inherited: true }, 'the final inherited marker belongs to the new Session')
  assert.deepEqual(copy.events.at(-1)?.data, { title, messageSeqs: [], source: { kind: 'user' } })
  assert.equal(copy.events.at(-1)?.type, 'session/title', 'the offline Fork title survives strict cold admission')
}

try {
  const original = await runtime()
  const route = { provider: 'fixture', model: 'fixture' }
  const handle = await original.agents.create({ sessionId: SessionId('fork-source'), meta: { cwd: root }, agentOptions: route })
  const source = handle.agent.session
  const channel = createChannel(original, handle.agent, { handle, ...route, cwd: root, activity: false })
  channels.push(channel)
  channel.renameSession('Source conversation')
  closeTurnWithDelivery(source, 1)
  await original.sessionPersistence.flush()
  const originalEvents = source.snapshotEvents()
  const originalHeader = source.header
  const copyId = await fork(channel, original)
  assert.equal(channel.sessionId, source.id, '/fork preserves the foreground Session')
  assert.equal(channel.agentId, source.id)
  assert.equal(channel.sessionTitle, 'Source conversation')
  assert.equal(channel.working, false)
  assert.equal(original.agents.get(source.id), handle.agent)
  assert.deepEqual(source.header, originalHeader)
  assert.deepEqual(source.snapshotEvents(), originalEvents, '/fork never appends to the source log')

  // A fresh provider cannot serve a pending in-memory copy or a decoded cache.
  // Its released V4 relationship validator must admit the inherited marker
  // still naming fork-source. Without parentSession, this exact read fails.
  const reopened = await runtime()
  const copy = await readCold(reopened, copyId)
  assertCopy(copy, source.id, originalEvents, 'Fork: Source conversation')
  assert.deepEqual((await readCold(reopened, source.id)).events, originalEvents)
  const resumed = await reopened.agents.resume({ resumeSessionId: copyId })
  assert.equal(resumed.agent.session.header.parentSession, source.id)
  assert.equal(resumed.agent.session.inheritedEventCount, originalEvents.length)
  assert.deepEqual(resumed.agent.session.snapshotEvents().slice(0, copy.events.length), copy.events)
  assert.equal(resumed.agent.status, 'idle', 'resume does not deliver the inherited history to a model')

  const resumedChannel = createChannel(reopened, resumed.agent, { handle: resumed, ...route, cwd: root, activity: false })
  channels.push(resumedChannel)
  assert.equal(resumedChannel.sessionTitle, 'Fork: Source conversation')
  closeTurnWithDelivery(resumed.agent.session, 2)
  await reopened.sessionPersistence.flush()
  const nestedSeed = resumed.agent.session.snapshotEvents()
  const nestedId = await fork(resumedChannel, reopened)
  assert.equal(resumedChannel.sessionId, copyId)
  assert.deepEqual(resumed.agent.session.snapshotEvents(), nestedSeed)

  const nestedRuntime = await runtime()
  const nested = await readCold(nestedRuntime, nestedId)
  assertCopy(nested, copyId, nestedSeed, 'Fork: Fork: Source conversation')
  const deliveries = nested.events.filter(event => event.type === 'session-log-deepseek/delivery-accepted')
  assert.deepEqual(deliveries.map(event => (event.data as { sessionId: string }).sessionId), [source.id, copyId])
  assert.ok(deliveries.every(event => event.seq < nested.inheritedEventCount), 'both ancestor delivery markers belong to the inherited prefix')
  const nestedResumed = await nestedRuntime.agents.resume({ resumeSessionId: nestedId })
  assert.equal(nestedResumed.agent.session.inheritedEventCount, nestedSeed.length)
  assert.deepEqual(nestedResumed.agent.session.snapshotEvents().slice(0, nested.events.length), nested.events)
  assert.equal(nestedResumed.agent.status, 'idle')
  console.log('PASS detached /fork and nested /fork: V4 cold read, real resume, exact seed, lineage, titles and unchanged foreground')
} finally {
  for (const channel of channels) channel.releaseContributions()
  for (const ctx of contexts.reverse()) await ctx.fiber.dispose()
  rmSync(root, { recursive: true, force: true })
}
