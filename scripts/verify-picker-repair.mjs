#!/usr/bin/env node
/**
 * Regression: opening the /resume picker repairs listed session logs before
 * reading their titles (channel listSessions + compat repair wiring).
 *
 * Builds two cold sessions with unmarked third-party `activity/status`
 * events under a temp DSH_TUI_SESSION_ROOT, serves their headers through a
 * fake ctx.sessionPersistence, then calls channel.listSessions():
 *   1. both sessions keep their titles from the tolerant reader;
 *   2. the persisted logs are repaired in place (activity/status gets
 *      ignorable:true), so web/history readers sharing the root can load
 *      them after the picker has been opened;
 *   3. the live agent's session is never fed to the repair path.
 * Exits non-zero on any assertion failure (CI gate).
 */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib'

const root = mkdtempSync(join(tmpdir(), 'dsh-tui-picker-repair-'))
process.env.DSH_TUI_SESSION_ROOT = root

// Import AFTER the env override (root resolves at call time).
const { createChannel } = await import('../lib/types/channel.js')
const { repairSessionLogForResume } = await import('../lib/types/compat/sessionLog.js')

const writeSession = (sessionId, frames) => {
  const dir = join(root, '--work-space--', sessionId)
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'session.jsonl.zstd')
  writeFileSync(
    file,
    Buffer.concat(frames.map((f) => zstdCompressSync(Buffer.from(f.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8')))),
  )
  return file
}

const decodeAll = (file) => {
  const buf = readFileSync(file)
  const offsets = []
  for (let i = 0; i + 4 <= buf.length; i++) if (buf.readUInt32LE(i) === 0xfd2fb528) offsets.push(i)
  return offsets.flatMap((start, i) => {
    const end = i + 1 < offsets.length ? offsets[i + 1] : buf.length
    return zstdDecompressSync(buf.subarray(start, end)).toString('utf8')
      .split('\n').filter(Boolean).map((l) => JSON.parse(l))
  })
}

const headerOf = (id, createdAt) => ({ type: 'session', version: 0, id, createdAt, cwd: '/tmp', delegationDepth: 0, agentPreset: 'standard' })
const userMessage = (seq, text) => ({ type: 'user/message', seq, time: seq, data: { content: [{ type: 'text', text }] } })
const activity = (seq) => ({ type: 'activity/status', seq, time: seq, data: { phase: 'thinking', line: 'thinking…' } })

const idA = 'aaaaaaaa-0000-0000-0000-00000000000a'
const fileA = writeSession(idA, [
  [headerOf(idA, 10)],
  [userMessage(0, 'hello from A'), activity(1)],
  [{ type: 'session/title', seq: 2, time: 2, data: { title: 'Session A title' } }],
])
const idB = 'bbbbbbbb-0000-0000-0000-00000000000b'
const fileB = writeSession(idB, [
  [headerOf(idB, 9)],
  [userMessage(0, 'hello from B'), activity(1)],
])

const handlers = new Map()
const ctx = {
  on(event, handler) {
    handlers.set(event, handler)
    return () => handlers.delete(event)
  },
  get(name) {
    if (name === 'sessionPersistence') {
      return {
        async list() {
          return [
            { id: idA, createdAt: 10, cwd: '/tmp' },
            { id: idB, createdAt: 9, cwd: '/tmp' },
          ]
        },
      }
    }
    return undefined
  },
  logger: { warn() {} },
}
const agent = {
  id: 'live-agent',
  status: 'idle',
  session: { id: 'live-session', seq: 0, events: [] },
  ctx: { on: () => () => {} },
  followup() {},
  steer() {},
}

const channel = createChannel(ctx, agent, {
  model: 'deepseek-chat',
  cwd: '/tmp',
  provider: 'deepseek',
  activity: false,
})

const records = await channel.listSessions()
assert.equal(records.length, 2, 'picker returns both cold sessions')
assert.equal(records.find((r) => r.id === idA)?.title, 'Session A title', 'titled session keeps its title')
assert.equal(records.find((r) => r.id === idB)?.title, 'hello from B', 'untitled session falls back to first user message')

for (const file of [fileA, fileB]) {
  const events = decodeAll(file)
  const marked = events.find((e) => e.type === 'activity/status')
  assert.equal(marked?.ignorable, true, 'picker repaired the listed log on disk')
}

// The repair is idempotent: a second picker open keeps the files stable.
const before = [readFileSync(fileA), readFileSync(fileB)]
assert.equal(await repairSessionLogForResume(idA), 'clean', 'second repair pass is clean')
assert.deepEqual([readFileSync(fileA), readFileSync(fileB)], before, 'second picker pass leaves bytes unchanged')

rmSync(root, { recursive: true, force: true })
console.log('verify-picker-repair: OK')
