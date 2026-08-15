#!/usr/bin/env node
/**
 * Regression: /resume picker rename BEYOND the title window (issue #112
 * review). channel.listSessions resolves persisted titles only for the MRU
 * top SESSION_TITLE_DEPTH (20) sessions; a rename must not leave a deeper
 * session showing the cwd-basename fallback while reporting success.
 *
 * Seeds 25 sessions under a temp DSH_TUI_SESSION_ROOT (HOME is also
 * redirected so last-used.json stays in the sandbox), renames the OLDEST
 * one (rank 25, outside the window), and asserts:
 *   1. before the rename its row shows the basename fallback (proving it
 *      sits outside the title window);
 *   2. renameSessionTo returns true and the append lands in the log;
 *   3. after the rename the re-listed row carries the NEW title (the rename
 *      touches MRU, pulling the session into the window) — this is what
 *      keeps the name visible after a restart too;
 *   4. last-used.json actually recorded the touch.
 * Run with plain node against the compiled lib: `node scripts/verify-resume-rename-mru.mjs`
 * Exits non-zero on any assertion failure (CI gate).
 */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'

const root = mkdtempSync(join(tmpdir(), 'dsh-tui-rename-mru-'))
const home = mkdtempSync(join(tmpdir(), 'dsh-tui-rename-mru-home-'))
process.env.DSH_TUI_SESSION_ROOT = root
// sessionHistory resolves os.homedir() at module load — HOME on POSIX,
// USERPROFILE on Windows. Set BOTH so a manual run can never write the
// test's last-used entries into the real user profile.
process.env.HOME = home
process.env.USERPROFILE = home

// Import AFTER the env overrides: sessionHistory resolves ~/.dsh-tui at
// module load, sessionLog resolves roots at call time.
const { createChannel } = await import('../lib/types/channel.js')

const CWD = '/tmp'
const COUNT = 25
const ids = Array.from({ length: COUNT }, (_, i) => `s${String(i).padStart(3, '0')}`)
// createdAt ascending: s000 oldest => MRU rank 25, outside the depth-20 window.
const headers = ids.map((id, i) => ({ id, cwd: CWD, createdAt: 1000 + i }))

for (const [i, id] of ids.entries()) {
  const dir = join(root, '--work-space--', id)
  mkdirSync(dir, { recursive: true })
  const header = { type: 'session', version: 0, id, createdAt: 1000 + i, cwd: CWD, delegationDepth: 0 }
  const message = { type: 'user/message', seq: 0, time: 1, data: { content: [{ type: 'text', text: `question ${id}` }] } }
  const title = { type: 'session/title', seq: 1, time: 2, data: { title: `old-${id}` } }
  const frames = [[header], [message, title]]
  writeFileSync(
    join(dir, 'session.jsonl.zstd'),
    Buffer.concat(frames.map((f) => zstdCompressSync(Buffer.from(f.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8')))),
  )
}

const ctx = {
  on() { return () => {} },
  get(name) {
    if (name === 'sessionPersistence') {
      return { list: async () => headers, load: async () => ({ events: [] }) }
    }
    return undefined
  },
  logger: { warn() {} },
}
const agent = {
  id: 'a1',
  status: 'idle',
  session: { id: 'live-session', seq: 0, events: [] },
  ctx: { on: () => () => {} },
}
const channel = createChannel(ctx, agent, { model: 'm', cwd: CWD, provider: 'p', activity: false })

const target = ids[0] // oldest — MRU rank 25, outside the title window
const before = await channel.listSessions()
assert.equal(before.length, COUNT, 'all sessions listed')
const rowBefore = before.find(r => r.id === target)
assert.ok(rowBefore, 'target session is listed')
// Sanity: the target really sits outside the title window, so its row shows
// the cwd-basename fallback (basename('/tmp')), NOT its persisted old title.
assert.equal(rowBefore.title, 'tmp', 'target starts on the basename fallback')
assert.equal(before[0].id, ids[COUNT - 1], 'MRU order: newest first')
assert.equal(before.findIndex(r => r.id === target), COUNT - 1, 'target is the last row')

// In-window control: the newest session shows its persisted title.
assert.equal(before[0].title, `old-${ids[COUNT - 1]}`, 'in-window session shows its log title')

// ── Rename the deep session ─────────────────────────────────────────────
assert.equal(await channel.renameSessionTo(target, 'renamed-deep'), true, 'rename reports success')

const after = await channel.listSessions()
const rowAfter = after.find(r => r.id === target)
assert.ok(rowAfter, 'target still listed after rename')
assert.equal(rowAfter.title, 'renamed-deep', 'renamed title resolves (no snap back to fallback)')
assert.equal(after[0].id, target, 'rename touched MRU: target pulled to the top row')

// The MRU touch must be durable (last-used.json under the sandboxed HOME).
const lastUsed = JSON.parse(readFileSync(join(home, '.dsh-tui', 'last-used.json'), 'utf8'))
assert.equal(typeof lastUsed[target], 'number', 'last-used entry recorded for the renamed session')

// And the log itself carries the appended title event (restart durability).
const { readSessionTitleFromLog } = await import('../lib/types/compat/sessionLog.js')
assert.equal(readSessionTitleFromLog(target)?.title, 'renamed-deep', 'title event persisted in the log')

rmSync(root, { recursive: true, force: true })
rmSync(home, { recursive: true, force: true })
console.log('verify-resume-rename-mru: OK')
