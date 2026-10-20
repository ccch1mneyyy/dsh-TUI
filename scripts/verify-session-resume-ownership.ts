/**
 * Resume ownership vs corruption through the real upstream stack
 * (issue #1635: sessions from dsh web and `/fork` copies refused to open).
 *
 * 1. A parent log carrying a web-style `session-log-deepseek/delivery-accepted`
 *    marker, forked the OLD `/fork` way (seed copy, isSeeded + inherited cut,
 *    but NO parentSession), must resume — the marker names the parent, and
 *    without lineage the resume-time validator reports "names the wrong
 *    Session". The fixed `/fork` (with parentSession, mirroring upstream
 *    `sessions.fork()` and `/rewind`) exempts the inherited prefix, so this
 *    row pins the exemption through the real persistence read path.
 * 2. A second write-open of a held session must reject with
 *    `SessionAlreadyOwnedError` — the identity the TUI maps to "held by
 *    another process" instead of "stored log is corrupt" — and the session
 *    must open again once the holder closes.
 *
 * Run: node --import tsx/esm scripts/verify-session-resume-ownership.ts
 * Uses disposable temp roots only; no credentials or live sessions.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import SessionStore from '@deepseek-ai/dsh-session'
import * as JsonlSessionPersistenceModule from '@deepseek-ai/dsh-session-persistence-jsonl'
import { isSessionOwnershipError } from '../src/sessions/resumeFailure.js'

const JsonlSessionPersistence = 'default' in JsonlSessionPersistenceModule ? JsonlSessionPersistenceModule.default : JsonlSessionPersistenceModule

async function withStack<T>(run: (ctx: Context, persistence: {
  create(header: unknown, options?: unknown): Promise<{
    append(events: readonly SessionEvent[]): Promise<void>
    close(): Promise<void>
  }>
  open(id: unknown, access: 'read' | 'write'): Promise<{
    append(events: readonly SessionEvent[]): Promise<void>
    read(from?: number, length?: number): Promise<{ events: readonly SessionEvent[] }>
    close(): Promise<void>
  } & { header: { cwd?: string } }>
}) => Promise<T>): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), 'dsh-tui-resume-ownership-'))
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(JsonlSessionPersistence, { root } as unknown as Record<string, unknown>)
  try {
    const persistence = ctx.get('sessionPersistence') as Parameters<typeof run>[1]
    assert.ok(persistence, 'sessionPersistence mounted')
    return await run(ctx, persistence)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

// A minimal but validator-complete turn: turn/start, a user message, a
// completed turn/end. The marker stands in for the web upload receipt.
function parentEvents(parentId: string): SessionEvent[] {
  const live = Session.create(
    SessionId(parentId),
    [],
    { id: SessionId(parentId), version: 4, createdAt: 1, cwd: '/tmp/verify', isSeeded: false, delegationDepth: 0 },
  )
  live.append('turn/start', { turn: 1 })
  live.append(
    'user/message',
    { ...createUserMessage({ content: [{ type: 'text', text: 'hello' }] }), source: { kind: 'user' } },
    { surfaceOp: 'append' },
  )
  live.append(
    'session-log-deepseek/delivery-accepted',
    { sessionId: parentId, sessionFormatVersion: 4, throughSeq: 1 },
  )
  live.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  return [...live.snapshotEvents()]
}

const PARENT_ID = '11111111-1111-4111-8111-111111111111'

// --- Row 1: fork lineage exempts the inherited delivery marker -------------
await withStack(async (ctx, persistence) => {
  const created = await persistence.create(
    { id: PARENT_ID, version: 4, createdAt: 1, cwd: '/tmp/verify', isSeeded: false, delegationDepth: 0 },
    {},
  )
  await created.append(parentEvents(PARENT_ID))
  await created.close()

  const reader = await persistence.open(PARENT_ID, 'read')
  const { events } = await reader.read(0, undefined)
  await reader.close()

  // The fixed `/fork`: seed copy + isSeeded + inherited cut + parentSession.
  const childId = SessionId('22222222-2222-4222-8222-222222222222')
  const sessions = ctx.get('sessions') as {
    prepare(id: unknown, options: unknown): {
      header: { isSeeded: boolean }
      inheritedEventCount: number
      snapshotEvents(from: number): readonly SessionEvent[]
    }
  }
  const seed = events.map((event) => ({ ...event }))
  const child = sessions.prepare(childId, {
    seed,
    meta: { cwd: '/tmp/verify', isSeeded: true, parentSession: PARENT_ID },
    inheritedEventCount: seed.length,
  })
  const stored = await persistence.create(child.header, {
    inheritedEventCount: child.inheritedEventCount,
  })
  await stored.append([...child.snapshotEvents(0)])
  await stored.close()

  const reopened = await persistence.open(childId, 'write')
  const back = await reopened.read(0, undefined)
  assert.equal(back.events.length, seed.length + 1, 'fork child resumes with its inherited prefix')
  await reopened.close()
})
console.log('ok   fork child with parentSession resumes past an inherited delivery marker')

// --- Row 2: the old shape (no parentSession) still fails loudly ------------
await withStack(async (ctx, persistence) => {
  const created = await persistence.create(
    { id: PARENT_ID, version: 4, createdAt: 1, cwd: '/tmp/verify', isSeeded: false, delegationDepth: 0 },
    {},
  )
  await created.append(parentEvents(PARENT_ID))
  await created.close()

  const reader = await persistence.open(PARENT_ID, 'read')
  const { events } = await reader.read(0, undefined)
  await reader.close()

  const childId = SessionId('33333333-3333-4333-8333-333333333333')
  const sessions = ctx.get('sessions') as {
    prepare(id: unknown, options: unknown): {
      header: { isSeeded: boolean }
      inheritedEventCount: number
      snapshotEvents(from: number): readonly SessionEvent[]
    }
  }
  const seed = events.map((event) => ({ ...event }))
  const child = sessions.prepare(childId, {
    seed,
    meta: { cwd: '/tmp/verify', isSeeded: true },
    inheritedEventCount: seed.length,
  })
  const stored = await persistence.create(child.header, {
    inheritedEventCount: child.inheritedEventCount,
  })
  await stored.append([...child.snapshotEvents(0)])
  await stored.close()

  await assert.rejects(
    () => persistence.open(childId, 'write'),
    (error: unknown) => {
      assert.match(String((error as Error).message ?? error), /names the wrong Session/)
      return true
    },
    'a lineage-less fork child is still refused (documents what the fix heals)',
  )
})
console.log('ok   lineage-less fork child still refused loudly (pre-fix shape)')

// --- Row 3: held write handle reads as ownership, then reopens -------------
await withStack(async (_ctx, persistence) => {
  const id = SessionId('44444444-4444-4444-8444-444444444444')
  const holder = await persistence.create(
    { id, version: 4, createdAt: 1, cwd: '/tmp/verify', isSeeded: false, delegationDepth: 0 },
    {},
  )
  await holder.append(parentEvents(String(id)).slice(0, 1))
  await assert.rejects(
    () => persistence.open(id, 'write'),
    (error: unknown) => {
      assert.ok(isSessionOwnershipError(error), 'second write open is an ownership refusal')
      return true
    },
    'a held session refuses the second writer',
  )
  await holder.close()
  const reopened = await persistence.open(id, 'write')
  await reopened.close()
})
console.log('ok   held session refuses as ownership, reopens after close')

console.log('session resume ownership checks passed')
