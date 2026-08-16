#!/usr/bin/env node
/**
 * Regression: a rename is visible on the row it renamed, at ANY depth.
 *
 * History: `listSessions` used to resolve persisted titles for only the 20
 * most recently used sessions, so a rename deeper than that reported success
 * while the row snapped back to the cwd-basename fallback. The session index
 * removed the window — every listed session resolves its own title from a
 * bounded read — so this now asserts the stronger property the window used to
 * make impossible: the OLDEST of 25 sessions shows its persisted title before
 * the rename and the new one after it.
 *
 * Seeds 25 sessions under a temp DSH_TUI_SESSION_ROOT (HOME is also
 * redirected so last-used.json and the session index stay in the sandbox),
 * renames the OLDEST one, and asserts:
 *   1. before the rename the deep row already carries its persisted title;
 *   2. renameSessionTo returns true and the append lands in the log;
 *   3. after the rename the re-listed row carries the NEW title;
 *   4. the rename touched MRU, pulling the row to the top;
 *   5. last-used.json actually recorded the touch.
 *
 * The persistence stub deliberately offers only `list` — no `listSnapshots`
 * and no `locate` — so this also covers the degraded path: change tokens
 * derived from the file itself, and log paths resolved by the compat scan.
 *
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
const { createChannel } = await import('../lib/types/dsh-adapter/channel.js')

const CWD = '/tmp'
const COUNT = 25
const ids = Array.from({ length: COUNT }, (_, i) => `s${String(i).padStart(3, '0')}`)
// createdAt ascending: s000 oldest => MRU rank 25, the deepest row.
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

const target = ids[0] // oldest — the deepest row
const before = await channel.listSessions()
assert.equal(before.length, COUNT, 'all sessions listed')
const rowBefore = before.find(r => r.id === target)
assert.ok(rowBefore, 'target session is listed')
// The deep row resolves its own persisted title — no depth window any more.
assert.equal(rowBefore.title.text, `old-${target}`, 'deep row carries its persisted title')
assert.equal(rowBefore.hasPrompt, true, 'seeded sessions hold a user prompt')
assert.equal(rowBefore.kind.kind, 'root', 'a session with no lineage is a root conversation')
assert.equal(before[0].id, ids[COUNT - 1], 'MRU order: newest first')
assert.equal(before.findIndex(r => r.id === target), COUNT - 1, 'target is the last row')

// In-window control: the newest session shows its persisted title too.
assert.equal(before[0].title.text, `old-${ids[COUNT - 1]}`, 'newest session shows its log title')

// ── Rename the deep session ─────────────────────────────────────────────
assert.equal(await channel.renameSessionTo(target, 'renamed-deep'), true, 'rename reports success')

const after = await channel.listSessions()
const rowAfter = after.find(r => r.id === target)
assert.ok(rowAfter, 'target still listed after rename')
assert.equal(rowAfter.title.text, 'renamed-deep', 'renamed title resolves (no snap back to fallback)')
assert.equal(rowAfter.title.source, 'renamed', 'a title with no provider source reads as a rename')
assert.equal(after[0].id, target, 'rename touched MRU: target pulled to the top row')

// The MRU touch must be durable (last-used.json under the sandboxed HOME).
const lastUsed = JSON.parse(readFileSync(join(home, '.dsh-tui', 'last-used.json'), 'utf8'))
assert.equal(typeof lastUsed[target], 'number', 'last-used entry recorded for the renamed session')

// And the log itself carries the appended title event (restart durability).
const { readSessionTitleFromLog } = await import('../lib/types/dsh-adapter/compat/sessionLog.js')
assert.equal(readSessionTitleFromLog(target)?.title, 'renamed-deep', 'title event persisted in the log')

rmSync(root, { recursive: true, force: true })
rmSync(home, { recursive: true, force: true })
console.log('verify-resume-rename-mru: OK')
