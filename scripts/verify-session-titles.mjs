#!/usr/bin/env node
/**
 * Regression: tolerant session-title reading for the /resume picker
 * (src/compat/sessionLog.ts readSessionTitleFromLog + channel listSessions
 * title wiring).
 *
 * Why this exists: picker titles used to come from `persistence.load()`,
 * which validates every event against KNOWN_SESSION_EVENT_TYPES and throws
 * the whole load on an unmarked third-party type (for example an
 * activity/status record in a legacy log). Every such session silently
 * fell back to the cwd basename in the picker — "历史会话没有重命名".
 *
 * Asserts:
 *   1. a log carrying an unmarked unknown event type still yields its title
 *      (the strict backend load would throw on the same bytes);
 *   2. the LAST session/title event wins (a /rename append overrides the
 *      first-prompt auto title);
 *   3. without any title event, the first user message text is the title;
 *   4. a session with no user message reports hasUserMessage: false (the
 *      picker's launch-artifact filter key);
 *   5. a missing session returns undefined.
 * Exits non-zero on any assertion failure (CI gate).
 */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'

const root = mkdtempSync(join(tmpdir(), 'dsh-tui-session-titles-'))
process.env.DSH_TUI_SESSION_ROOT = root

// Import AFTER the env override (root resolves at call time, but keep the
// order obvious against future module-level reads).
const { readSessionTitleFromLog } = await import('../lib/types/dsh-adapter/compat/sessionLog.js')

const writeSession = (sessionId, frames) => {
  const dir = join(root, '--work-space--', sessionId)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'session.jsonl.zstd'),
    Buffer.concat(
      frames.map((f) => zstdCompressSync(Buffer.from(f.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8'))),
    ),
  )
}

const headerOf = (id) => ({ type: 'session', version: 0, id, createdAt: 1, cwd: 'D:\\work', delegationDepth: 0, agentPreset: 'standard' })
const userMessage = (seq, text) => ({ type: 'user/message', seq, time: seq, data: { content: [{ type: 'text', text }] } })

// Session A: unknown unmarked type (activity/status) + TWO title events —
// strict load() would throw; the reader must tolerate it and take the LAST
// title (rename semantics).
const idA = 'aaaaaaaa-0000-0000-0000-00000000000a'
writeSession(idA, [
  [headerOf(idA)],
  [userMessage(0, '你好呀'), { type: 'activity/status', seq: 1, time: 1, data: { phase: 'thinking' } }],
  [{ type: 'session/title', seq: 2, time: 2, data: { title: '旧名字' } }],
  [{ type: 'session/title', seq: 3, time: 3, data: { title: '新名字' } }],
])
const a = readSessionTitleFromLog(idA)
assert.equal(a?.title, '新名字', 'last session/title wins over the auto title')
assert.equal(a?.hasUserMessage, true, 'session A has a user message')

// Session B: no title event — first user message text is the title.
const idB = 'bbbbbbbb-0000-0000-0000-00000000000b'
writeSession(idB, [[headerOf(idB)], [userMessage(0, '  第一条消息  ')]])
const b = readSessionTitleFromLog(idB)
assert.equal(b?.title, '第一条消息', 'falls back to first user message (trimmed)')

// Session C: title event but no user message — the picker drops these as
// launch artifacts regardless of title.
const idC = 'cccccccc-0000-0000-0000-00000000000c'
writeSession(idC, [[headerOf(idC)], [{ type: 'session/title', seq: 0, time: 0, data: { title: 'x' } }]])
const c = readSessionTitleFromLog(idC)
assert.equal(c?.hasUserMessage, false, 'session C lacks a user message')

// Missing session: undefined, never throws.
assert.equal(readSessionTitleFromLog('ffffffff-ffff-ffff-ffff-ffffffffffff'), undefined, 'missing session is undefined')

rmSync(root, { recursive: true, force: true })
console.log('verify-session-titles: OK')
