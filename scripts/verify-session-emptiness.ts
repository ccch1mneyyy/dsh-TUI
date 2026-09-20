/**
 * Empty-session classification must never hide or offer to delete real history.
 * Run: node --import tsx/esm scripts/verify-session-emptiness.ts
 * Logs and preferences are isolated under a disposable temporary directory.
 */
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { appendFileSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { constants, zstdCompressSync, zstdDecompressSync } from 'node:zlib'
import { Context } from '@deepseek-ai/cordis'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { settled } from './lib/term-test.mjs'

const root = mkdtempSync(join(tmpdir(), 'dsh-tui-empty-'))
process.env.HOME = root
process.env.USERPROFILE = root
process.env.DSH_HOME = join(root, 'dsh')
process.env.DSH_TUI_SESSION_ROOT = join(root, 'logs')
const cwd = join(root, 'project')
const indexFile = join(root, '.dsh-tui', 'session-index.json')
const { digestSession, recoverSessionTitle, HEAD_MAX_FRAMES, HEAD_WINDOW_BYTES } = await import('../src/dsh-adapter/sessions/digest.js')
const { listSummaries } = await import('../src/dsh-adapter/sessions/list.js')
const { readIndex } = await import('../src/dsh-adapter/sessions/store.js')
const { buildView, DEFAULT_FILTERS } = await import('../src/sessions/view.js')

let failures = 0
async function test(name: string, run: () => Promise<void> | void) {
  try {
    rmSync(indexFile, { force: true })
    await run()
    console.log(`PASS ${name}`)
  } catch (error) {
    failures++
    console.error(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

type Row = Record<string, unknown>
type CachedIndex = {
  version: number
  entries: Record<string, { branch?: string; derived: { hasPrompt?: boolean } }>
}
const frame = (rows: readonly unknown[]) => zstdCompressSync(Buffer.from(rows.map(row => JSON.stringify(row)).join('\n') + '\n'))
const prompt = (content: unknown = [{ type: 'text', text: 'saved question' }]): Row => ({
  type: 'user/message', seq: 1, time: 1, data: { content, source: { kind: 'user' } },
})
const policy: Row = { type: 'sandbox/mode', seq: 0, time: 0, data: { mode: 'workspace-write' } }
const corruptFrame = zstdCompressSync(Buffer.from(JSON.stringify(prompt()) + '\n'), {
  params: { [constants.ZSTD_c_checksumFlag]: 1 },
})
corruptFrame[corruptFrame.length - 1] ^= 0xff

function fixture(id: string, frames: readonly Buffer[]) {
  const header = { type: 'session', version: 0, id, createdAt: 1, cwd }
  const path = join(root, `${id}.zstd`)
  writeFileSync(path, Buffer.concat([frame([header]), ...frames]))
  const source = {
    listSnapshots: async () => [{ header, revision: String(statSync(path).size) }],
    locate: () => ({ kind: 'jsonl', path }),
  }
  return { path, source }
}

async function assertVisible(source: Parameters<typeof listSummaries>[0]) {
  for (const cache of ['cold', 'warm']) {
    const summaries = await listSummaries(source)
    assert.equal(summaries.length, 1)
    assert.equal(summaries[0]!.hasPrompt, true, `${cache}: not proven empty`)
    const view = buildView(summaries, DEFAULT_FILTERS, {
      cwd, branch: undefined, currentId: 'new-launch', sameProject: (a, b) => a === b,
    })
    assert.equal(view.shown, 1, `${cache}: visible after reopening /resume`)
    assert.deepEqual(view.emptyIds, [], `${cache}: never a cleanup candidate`)
  }
}

try {
  await test('a complete boot-only log is still empty', async () => {
    const { path, source } = fixture('boot', [frame([policy])])
    assert.equal(digestSession(path, cwd).hasPrompt, false)
    assert.equal((await listSummaries(source))[0]!.hasPrompt, false)
  })
  await test('progressive recovery can still prove a long boot-only log empty', async () => {
    const { path, source } = fixture('long-boot', Array.from({ length: HEAD_MAX_FRAMES }, () => frame([policy])))
    assert.equal(digestSession(path, cwd).hasPrompt, true, 'bounded read is inconclusive')
    assert.equal((await listSummaries(source))[0]!.hasPrompt, false, 'complete recovery proves empty')
  })
  for (const titled of [false, true]) {
    await test(`frame limit, title=${titled}: a small log is not necessarily empty`, async () => {
      const { path, source } = fixture(`frame-limit-${titled}`, [
        ...Array.from({ length: HEAD_MAX_FRAMES }, () => frame([policy])),
        frame([prompt(), ...(titled ? [{ type: 'session/title', data: { title: 'real conversation' } }] : [])]),
      ])
      assert.ok(statSync(path).size < HEAD_WINDOW_BYTES)
      assert.equal(digestSession(path, cwd).hasPrompt, true)
      await assertVisible(source)
    })
  }
  for (const kind of ['user/message', 'agent/inbox/spliced']) {
    await test(`${kind}: image-only user input is not empty`, async () => {
      const content = [{ type: 'image', url: 'fixture.png' }]
      const row = kind === 'user/message' ? prompt(content) : {
        type: kind, data: { inserted: [{ role: 'user', source: { kind: 'user' }, content }] },
      }
      const { path, source } = fixture(kind.replaceAll('/', '-'), [frame([row])])
      assert.equal(digestSession(path, cwd).hasPrompt, true)
      assert.equal((await recoverSessionTitle(path, statSync(path).size)).hasPrompt, true)
      await assertVisible(source)
    })
  }
  for (const [name, bytes] of [
    ['torn tail', frame([prompt()]).subarray(0, -4)],
    ['undecodable frame', corruptFrame],
    ['invalid JSON', zstdCompressSync(Buffer.from('{broken json\n'))],
    ['non-object row', frame([null])],
  ] as const) {
    await test(`${name}: incomplete evidence cannot prove emptiness`, async () => {
      if (name === 'undecodable frame') assert.throws(() => zstdDecompressSync(bytes))
      const { path, source } = fixture(name.replaceAll(' ', '-'), [frame([policy]), bytes])
      assert.equal(digestSession(path, cwd).hasPrompt, true)
      await assertVisible(source)
    })
  }
  await test('an unreadable log cannot prove emptiness', () => {
    assert.equal(digestSession(join(root, 'missing'), cwd).hasPrompt, true)
  })
  await test('a zero-byte artifact is not a successfully scanned session', async () => {
    const { path, source } = fixture('zero-byte', [])
    writeFileSync(path, '')
    assert.equal(digestSession(path, cwd).hasPrompt, true)
    assert.equal((await recoverSessionTitle(path, 0)).complete, false)
    await assertVisible(source)
  })
  await test('appending conversation does not inherit the old empty cache', async () => {
    const { path, source } = fixture('appended', [frame([policy])])
    assert.equal((await listSummaries(source))[0]!.hasPrompt, false)
    appendFileSync(path, frame([prompt(), { type: 'session/title', data: { title: 'new title' } }]))
    // Keep the title outside the cheap tail so the append-only cache path runs.
    appendFileSync(path, Buffer.concat(Array.from({ length: 240 }, () => frame([
      { type: 'plugin/noise', data: { text: randomBytes(1200).toString('hex') } },
    ]))))
    await assertVisible(source)
  })
  await test('old empty classifications are invalidated without losing branch notes', async () => {
    const { source } = fixture('old-cache', [frame([prompt()])])
    await listSummaries(source)
    const cached = JSON.parse(readFileSync(indexFile, 'utf8')) as CachedIndex
    cached.version = 2
    cached.entries['old-cache'].branch = 'keep-this-branch'
    cached.entries['old-cache'].derived.hasPrompt = false
    writeFileSync(indexFile, JSON.stringify(cached))
    await assertVisible(source)
    assert.equal(readIndex().get('old-cache')?.branch, 'keep-this-branch')
  })
  await test('malformed cached hasPrompt is not treated as false', async () => {
    const { source } = fixture('bad-cache', [frame([prompt()])])
    await listSummaries(source)
    const cached = JSON.parse(readFileSync(indexFile, 'utf8')) as CachedIndex
    delete cached.entries['bad-cache'].derived.hasPrompt
    writeFileSync(indexFile, JSON.stringify(cached))
    await assertVisible(source)
  })
  for (const compression of ['zstd', 'none'] as const) {
    await test(`real JSONL ${compression}: persisted conversation survives a fresh backend`, async () => {
      const storeRoot = join(root, `backend-${compression}`)
      const ctx = new Context()
      const plugin = ctx.plugin(JsonlSessionPersistence, { root: storeRoot, compression })
      const id = SessionId(`persisted-${compression}`)
      try {
        assert.ok(await settled(() => ctx.get('sessionPersistence') !== undefined))
        const session = Session.create(id, [], { version: 3, id, createdAt: 1, cwd, isSeeded: false })
        session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'durable input' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
        const writer = await ctx.sessionPersistence.create(session.header)
        try { await writer.append(session.snapshotEvents()); await writer.flush() }
        finally { await writer.close() }
      } finally { await plugin.dispose() }
      const reopened = new Context()
      const readerPlugin = reopened.plugin(JsonlSessionPersistence, { root: storeRoot, compression })
      try {
        assert.ok(await settled(() => reopened.get('sessionPersistence') !== undefined))
        const reader = await reopened.sessionPersistence.open(id, 'read')
        try { assert.ok((await reader.read()).events.some(event => event.type === 'user/message')) }
        finally { await reader.close() }
        await assertVisible(reopened.sessionPersistence as unknown as Parameters<typeof listSummaries>[0])
      } finally { await readerPlugin.dispose() }
    })
  }
} finally {
  rmSync(root, { recursive: true, force: true })
}
assert.equal(failures, 0, `${failures} empty-session regressions failed`)
