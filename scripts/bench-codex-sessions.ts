/** Bounded native catalog benchmark in an isolated CODEX_HOME.
 * Seeds 250 synthetic rollouts and measures runtime acquisition, first
 * progress, discovery of a newly added rollout, and full listing time.
 * No login, personal sessions, network fixture, or model turns.
 * Run: node --import tsx/esm scripts/bench-codex-sessions.ts */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { liveCodexHome, assertCheapRequest } from './lib/codex-cheap-only.mjs'

const sandbox = liveCodexHome({ provider: false })
process.env.HOME = sandbox.home
process.env.USERPROFILE = sandbox.home
process.env.CODEX_HOME = sandbox.home
process.env.CODEX_SQLITE_HOME = sandbox.home
process.env.DSH_TUI_LANG = 'en'
for (const key of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'OPENAI_BASE_URL', 'CHATGPT_BASE_URL']) delete process.env[key]
const [{ prepareCodexRuntime, codexBackend }, { createCodexCatalog }, { closeAllCodexHubs }, { spawnTransport }] = await Promise.all([
  import('../src/backends/codex/backend.js'),
  import('../src/backends/codex/catalog.js'),
  import('../src/backends/codex/rpc/hub.js'),
  import('../src/backends/codex/rpc/transport.js'),
])
const seed = (cwd: string, at: number): string => {
  const id = randomUUID()
  const timestamp = new Date(at).toISOString()
  const folder = join(sandbox.home, 'sessions', ...timestamp.slice(0, 10).split('-'))
  mkdirSync(folder, { recursive: true })
  const rows = [
    { type: 'session_meta', payload: { id, session_id: id, timestamp, cwd, originator: 'dsh-tui-bench', cli_version: '0.160.1', source: 'cli', model_provider: 'openai', history_mode: 'legacy', base_instructions: { text: 'Synthetic offline fixture.' } } },
    { type: 'event_msg', payload: { type: 'user_message', message: 'synthetic benchmark prompt', images: [], local_images: [], text_elements: [] } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'synthetic benchmark prompt' }] } },
  ]
  writeFileSync(join(folder, `rollout-${timestamp.slice(0, 19).replaceAll(':', '-')}-${id}.jsonl`), rows.map(row => JSON.stringify({ timestamp, ...row })).join('\n') + '\n', { mode: 0o600 })
  return id
}
const host = { cwd: sandbox.cwd, debug: () => undefined, warn: () => undefined, locale: () => 'en' as const }
let started = 0
let acquired = 0
let rpc: { db: boolean; limit: unknown; ms: number }[] = []
const catalog = createCodexCatalog({
  cwd: () => sandbox.cwd,
  acquire: async cwd => {
    const runtime = await prepareCodexRuntime({ kind: 'create', cwd: cwd ?? sandbox.cwd }, host, {
      hubDeps: {
        transportFactory: options => {
          const transport = spawnTransport(options)
          return { ...transport, write: line => {
            const request = JSON.parse(line)
            assertCheapRequest('bench-codex-sessions', request.method, request.params)
            assert.notEqual(request.method, 'turn/start', 'benchmark never starts a model turn')
            transport.write(line)
          } }
        },
      },
    })
    acquired = performance.now() - started
    return { release: runtime.release, hub: { call: async <T>(method: string, params?: unknown, options?: Parameters<typeof runtime.hub.call>[2]): Promise<T> => {
      const at = performance.now()
      const answer = await runtime.hub.call<T>(method, params, options)
      if (method === 'thread/list') {
        const request = params as { useStateDbOnly?: boolean; limit?: number }
        rpc.push({ db: request.useStateDbOnly === true, limit: request.limit, ms: Math.round(performance.now() - at) })
      }
      return answer
    } } }
  },
})
const measure = async (label: string, expected: number, newest?: string, listing = catalog): Promise<void> => {
  started = performance.now()
  rpc = []
  let first: number | undefined
  let discovered: number | undefined
  const rows = await listing.list({ cwd: sandbox.cwd }, rows => {
    if (rows.length > 0) first ??= performance.now() - started
    if (newest !== undefined && rows.some(row => row.id === newest)) discovered ??= performance.now() - started
  })
  const total = performance.now() - started
  assert.equal(rows.length, expected, 'benchmark verifies that every scoped fixture is actually listed')
  console.log(JSON.stringify({ label, rows: rows.length, ...(listing === catalog ? { acquireMs: Math.round(acquired), rpc } : {}), firstMs: first === undefined ? null : Math.round(first), discoveredMs: discovered === undefined ? null : Math.round(discovered), totalMs: Math.round(total) }))
}
try {
  const at = Date.now() - 600_000
  for (let index = 0; index < 250; index++) seed(index % 5 === 4 ? join(sandbox.cwd, 'other') : sandbox.cwd, at + index * 1000)
  await measure('cold', 200)
  await measure('warm', 200)
  await measure('new external rollout', 201, seed(sandbox.cwd, Date.now()))
  await measure('native catalog priming', 201, undefined, codexBackend.catalog!)
  await measure('native reused runtime, new external rollout', 202, seed(sandbox.cwd, Date.now() + 1000), codexBackend.catalog!)
} finally {
  await closeAllCodexHubs()
  sandbox.cleanup()
}
