/**
 * M1.6 structured `@` file suggestions (plan §2.5, ported from main
 * eacc7a97): channel-level `listFileCandidates` semantics over a real-fs
 * fixture (path-shaped directory listing, session pool ranking, per-kind
 * budgets, symlink-cycle guard, abort, pool-cache sharing), the typed sink's
 * stale fence, and the prompt provider's candidate→item mapping plus
 * kind-based accept.
 *
 * Harness style follows channel-session-mutation.test.ts /
 * scripts/verify-file-completion.mjs: redirect-home first (paths.ts freezes
 * DATA_DIR at module scope), then a REAL createChannel against a fake ctx
 * whose `fs` service is backed by a tmp fixture on the local filesystem.
 * `resolve` canonicalizes (realpath) like the local backend — the
 * visited-set cycle guard keys on it.
 */
import './redirect-home.js'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { readdir, realpath, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createChannel, type ChannelState } from '../../src/dsh-adapter/channel.js'
import type { FileCandidate } from '../../src/utils/fileSuggestions.js'
import { createTuiCommands, type TuiCommands } from '../../src/tui/commands.js'
import { PromptAutocompleteProvider } from '../../src/tui/components/prompt-editor.js'

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** Deadlock tripwire: a scan that never settles must FAIL, not hang the runner. */
function withTimeout<T>(pending: Promise<T>, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    pending,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} did not settle`)), 5000)
    }),
  ]).finally(() => clearTimeout(timer))
}

const fixture = (): string => mkdtempSync(join(tmpdir(), 'dsh-tui-file-candidates-'))

/** fs-service mock over the real fixture. Symlinks are followed for the
 *  entry type (a linked dir lists as a directory) while `target` keeps the
 *  entry's own path, so the scan re-resolves it and the visited set sees the
 *  canonical realpath. */
function makeFsService() {
  const stats = { rootListings: 0, root: '' }
  const service = {
    stats,
    async resolve(path: string): Promise<{ displayPath: string }> {
      return { displayPath: await realpath(path) }
    },
    async listDir(target: { displayPath: string }) {
      if (target.displayPath === stats.root) stats.rootListings += 1
      const entries = await readdir(target.displayPath, { withFileTypes: true })
      return Promise.all(
        entries.map(async (entry) => {
          const displayPath = join(target.displayPath, entry.name)
          let type: 'file' | 'directory' | 'other' = entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other'
          if (entry.isSymbolicLink()) {
            try {
              const followed = await stat(displayPath)
              type = followed.isDirectory() ? 'directory' : followed.isFile() ? 'file' : 'other'
            } catch {
              type = 'other'
            }
          }
          return { name: entry.name, type, target: { displayPath } }
        }),
      )
    },
  }
  return service
}

function makeAgent(id: string) {
  return {
    id,
    status: 'idle',
    options: {},
    session: {
      id: `${id}-session`,
      seq: 0,
      events: [] as unknown[],
      header: {},
      append() {},
    },
    ctx: { on: () => () => {} },
    followup() {},
    steer() {},
    inbox: { remove: () => true },
    cancel() {},
    whenIdle: () => Promise.resolve(),
  }
}

function makeChannel(cwd: string, fsService: unknown): ChannelState {
  const ctx = {
    on: () => () => {},
    get: (name: string) => (name === 'fs' ? fsService : undefined),
    logger: { warn() {} },
  }
  return createChannel(ctx as never, makeAgent(`agent-${Math.random().toString(36).slice(2)}`) as never, {
    model: 'test-model',
    cwd,
    provider: 'test',
    activity: false,
  })
}

const candidate = (path: string, kind: 'file' | 'directory' = 'file'): FileCandidate => ({
  id: path,
  path,
  displayPath: path,
  name: path.replace(/\/$/, '').split('/').pop() ?? path,
  kind,
  score: 0,
})

// --- channel: path-shaped queries ------------------------------------------

test('path-shaped queries list ONLY that directory, with kind and trailing slash', async () => {
  const cwd = fixture()
  mkdirSync(join(cwd, 'src'))
  writeFileSync(join(cwd, 'src', 'a.ts'), '')
  mkdirSync(join(cwd, 'docs'))
  writeFileSync(join(cwd, 'docs', 'b.md'), '')
  const channel = makeChannel(cwd, makeFsService())

  const listing = await channel.listFileCandidates('src/')
  assert.ok(listing.length > 0)
  assert.ok(listing.every((entry) => entry.path.startsWith('src/')))
  assert.equal(listing.find((entry) => entry.path === 'src/a.ts')?.kind, 'file')
  // Directory candidates carry the trailing slash the accept path relies on.
  mkdirSync(join(cwd, 'src', 'util'))
  const withDir = await channel.listFileCandidates('src/')
  assert.equal(withDir.find((entry) => entry.path === 'src/util/')?.kind, 'directory')

  // The trailing name fragment ranks within that one directory only.
  const filtered = await channel.listFileCandidates('src/a')
  assert.deepEqual(filtered.map((entry) => entry.path), ['src/a.ts'])

  // A missing/unreadable directory degrades to no candidates, never a throw.
  assert.deepEqual(await channel.listFileCandidates('nope/'), [])
})

test("'@./' lists the session cwd with the ./ prefix preserved", async () => {
  const cwd = fixture()
  mkdirSync(join(cwd, 'src'))
  writeFileSync(join(cwd, 'top.ts'), '')
  const channel = makeChannel(cwd, makeFsService())
  const listing = await channel.listFileCandidates('./')
  assert.ok(listing.length > 0)
  assert.ok(listing.every((entry) => entry.path.startsWith('./')))
  assert.ok(listing.some((entry) => entry.path === './src/' && entry.kind === 'directory'))
  assert.ok(listing.some((entry) => entry.path === './top.ts' && entry.kind === 'file'))
})

test("'@~/' expands against the host home", async () => {
  const home = process.env.HOME!
  mkdirSync(join(home, 'dsh-fs-notes'), { recursive: true })
  writeFileSync(join(home, 'dsh-fs-notes', 'todo.txt'), '')
  const channel = makeChannel(fixture(), makeFsService())
  const topLevel = await channel.listFileCandidates('~/')
  assert.ok(topLevel.some((entry) => entry.path === '~/dsh-fs-notes/' && entry.kind === 'directory'))
  // Continuing completion INTO a home subdirectory keeps the ~/ display prefix.
  const listing = await channel.listFileCandidates('~/dsh-fs-notes/')
  assert.deepEqual(listing.map((entry) => entry.path), ['~/dsh-fs-notes/todo.txt'])
})

test('absolute path queries pass through untouched', async () => {
  const cwd = fixture()
  mkdirSync(join(cwd, 'src'))
  writeFileSync(join(cwd, 'src', 'a.ts'), '')
  const channel = makeChannel(cwd, makeFsService())
  const listing = await channel.listFileCandidates(`${cwd}/src/`)
  assert.deepEqual(listing.map((entry) => entry.path), [`${cwd}/src/a.ts`])
})

test('directories with whitespace list as path queries (quoted-token bodies)', async () => {
  const cwd = fixture()
  mkdirSync(join(cwd, 'my dir'))
  writeFileSync(join(cwd, 'my dir', 'x.txt'), '')
  const channel = makeChannel(cwd, makeFsService())
  const listing = await channel.listFileCandidates('my dir/')
  assert.deepEqual(listing.map((entry) => entry.path), ['my dir/x.txt'])
})

// --- channel: fragment queries over the session pool ------------------------

test('plain fragments rank the session pool; a generated tree cannot crowd out sources', async () => {
  const cwd = fixture()
  mkdirSync(join(cwd, 'generated'))
  for (let index = 0; index < 120; index += 1) {
    writeFileSync(join(cwd, 'generated', `generated-${String(index).padStart(3, '0')}.ts`), '')
  }
  mkdirSync(join(cwd, 'src'))
  writeFileSync(join(cwd, 'src', 'main.cpp'), '')
  const channel = makeChannel(cwd, makeFsService())

  const ranked = await channel.listFileCandidates('main')
  assert.ok(
    ranked.some((entry) => entry.path === 'src/main.cpp' && entry.kind === 'file'),
    `source file was crowded out by the generated sibling:\n${ranked.map((entry) => entry.path).join('\n')}`,
  )
  const generated = await channel.listFileCandidates('generated')
  assert.ok(generated.some((entry) => entry.path === 'generated/' && entry.kind === 'directory'))
  // Round-robin interleave: `src/` and its file survive the 120-file sibling
  // in the shared pool (fuzzy queries reach them regardless of topK slicing).
  const sources = await channel.listFileCandidates('src')
  assert.ok(sources.some((entry) => entry.path === 'src/' && entry.kind === 'directory'))
  assert.ok(sources.some((entry) => entry.path === 'src/main.cpp'))
})

test('the pool scan is shared across concurrent first queries and cached afterwards', async () => {
  const cwd = fixture()
  writeFileSync(join(cwd, 'alpha.ts'), '')
  writeFileSync(join(cwd, 'beta.ts'), '')
  const fs = makeFsService()
  fs.stats.root = await realpath(cwd)
  const channel = makeChannel(cwd, fs)

  const [a, b] = await Promise.all([channel.listFileCandidates('alpha'), channel.listFileCandidates('beta')])
  assert.equal(fs.stats.rootListings, 1, 'concurrent first queries must share one scan')
  assert.deepEqual(a.map((entry) => entry.path), ['alpha.ts'])
  assert.deepEqual(b.map((entry) => entry.path), ['beta.ts'])
  await channel.listFileCandidates('alpha')
  assert.equal(fs.stats.rootListings, 1, 'the loaded pool is reused for the session cwd')
})

test('an empty pool scan is not cached — the next query re-scans', async () => {
  const cwd = fixture()
  const channel = makeChannel(cwd, makeFsService())
  assert.deepEqual(await channel.listFileCandidates('x'), [])
  writeFileSync(join(cwd, 'later.ts'), '')
  const retry = await channel.listFileCandidates('later')
  assert.deepEqual(retry.map((entry) => entry.path), ['later.ts'])
})

test('symlink cycles terminate via the visited set', async () => {
  const cwd = fixture()
  mkdirSync(join(cwd, 'cycle'))
  writeFileSync(join(cwd, 'cycle', 'real.txt'), '')
  symlinkSync(cwd, join(cwd, 'cycle', 'self'), 'dir') // cycle/self → the fixture root
  const channel = makeChannel(cwd, makeFsService())
  const pool = await withTimeout(channel.listFileCandidates(''), 'pool scan with a symlink cycle')
  assert.ok(pool.some((entry) => entry.path === 'cycle/real.txt'))
  // The linked directory is listed once as a candidate but never descended
  // into (its realpath is already visited) — no `cycle/self/cycle/…` blowup.
  assert.ok(pool.some((entry) => entry.path === 'cycle/self/' && entry.kind === 'directory'))
  assert.ok(pool.every((entry) => !entry.path.startsWith('cycle/self/') || entry.path === 'cycle/self/'))
})

test('an aborted signal yields no candidates in either mode', async () => {
  const cwd = fixture()
  mkdirSync(join(cwd, 'src'))
  writeFileSync(join(cwd, 'src', 'a.ts'), '')
  const channel = makeChannel(cwd, makeFsService())
  const controller = new AbortController()
  controller.abort()
  assert.deepEqual(await channel.listFileCandidates('src/', { signal: controller.signal }), [])
  assert.deepEqual(await channel.listFileCandidates('a', { signal: controller.signal }), [])
})

// --- sink: typed query + stale fence -----------------------------------------

function makeSinkHarness(result: Promise<readonly FileCandidate[]>) {
  const channel = {
    sessionEpoch: 0,
    calls: [] as { query: string; topK?: number; hasSignal: boolean }[],
    listFileCandidates(query: string, options?: { signal?: AbortSignal; topK?: number }) {
      channel.calls.push({ query, topK: options?.topK, hasSignal: options?.signal !== undefined })
      return result
    },
  }
  const fences = { sessionEpoch: () => channel.sessionEpoch, generation: () => 0 }
  const commands = createTuiCommands({ channel: channel as never, fences })
  return { channel, commands }
}

test('the typed sink forwards query/signal/topK and passes fresh results through', async () => {
  const candidates = [candidate('src/a.ts')]
  const { channel, commands } = makeSinkHarness(Promise.resolve(candidates))
  const controller = new AbortController()
  const result = await commands.query.listFileCandidates('src/', { signal: controller.signal, topK: 7 })
  assert.deepEqual(channel.calls, [{ query: 'src/', topK: 7, hasSignal: true }])
  assert.equal(result, candidates)
})

test('the typed sink drops a result that settles after a session swap', async () => {
  const gate = deferred<readonly FileCandidate[]>()
  const { channel, commands } = makeSinkHarness(gate.promise)
  const pending = commands.query.listFileCandidates('src/')
  channel.sessionEpoch += 1 // an interleaved replacement while in flight
  gate.resolve([candidate('src/a.ts')])
  assert.equal(await pending, undefined)
})

// --- provider: candidate mapping + kind-based accept --------------------------

function makeProvider(candidates: readonly FileCandidate[] | undefined) {
  const calls: { query: string; topK?: number }[] = []
  const commands = {
    query: {
      commandCompletions: () => [],
      listFileCandidates: (query: string, options?: { topK?: number }) => {
        calls.push({ query, topK: options?.topK })
        return Promise.resolve(candidates)
      },
    },
  }
  return {
    calls,
    provider: new PromptAutocompleteProvider(commands as never as TuiCommands),
  }
}

const freshSignal = (): { signal: AbortSignal } => ({ signal: new AbortController().signal })

test('provider: a mid-message mention queries the typed sink and maps structured items', async () => {
  const { calls, provider } = makeProvider([candidate('src/util/', 'directory'), candidate('src/a.ts')])
  const suggestions = await provider.getSuggestions(['check @sr tail'], 0, 9, freshSignal())
  assert.deepEqual(calls, [{ query: 'sr', topK: 50 }])
  assert.equal(suggestions?.prefix, '@sr')
  // Keep the existing basename/displayPath presentation contract; the
  // structured kind remains available to the accept path as metadata.
  assert.deepEqual(suggestions?.items, [
    { value: 'src/util/', label: 'util/', description: 'src/util/' },
    { value: 'src/a.ts', label: 'a.ts', description: 'src/a.ts' },
  ])
  assert.equal((suggestions?.items[0] as { kind?: string } | undefined)?.kind, 'directory')
  assert.equal((suggestions?.items[1] as { kind?: string } | undefined)?.kind, 'file')
})

test('provider: stale-dropped (undefined), aborted and empty results all close the menu', async () => {
  const stale = makeProvider(undefined)
  assert.equal(await stale.provider.getSuggestions(['@sr'], 0, 3, freshSignal()), null)

  const aborted = makeProvider([candidate('src/a.ts')])
  const controller = new AbortController()
  controller.abort()
  assert.equal(await aborted.provider.getSuggestions(['@sr'], 0, 3, { signal: controller.signal }), null)

  const empty = makeProvider([])
  assert.equal(await empty.provider.getSuggestions(['@zzzz'], 0, 5, freshSignal()), null)
})

test('provider: outside an @ mention there are no file suggestions', async () => {
  const { calls, provider } = makeProvider([candidate('src/a.ts')])
  assert.equal(await provider.getSuggestions(['plain text'], 0, 5, freshSignal()), null)
  assert.equal(calls.length, 0)
})

test('provider: accept completes a file with a trailing space, a directory without one', () => {
  const { provider } = makeProvider([])
  const file = provider.applyCompletion(['@sr'], 0, 3, { value: 'src/a.ts', label: 'src/a.ts', kind: 'file' }, '@sr')
  assert.deepEqual(file, { lines: ['@src/a.ts '], cursorLine: 0, cursorCol: 10 })

  // Directory by kind (no trailing-`/` guess): completion continues into it.
  const directory = provider.applyCompletion(['@sr'], 0, 3, { value: 'src/', label: 'src/', kind: 'directory' }, '@sr')
  assert.deepEqual(directory, { lines: ['@src/'], cursorLine: 0, cursorCol: 5 })

  // Fallback for items that never carried a kind: the trailing-`/` id contract.
  const legacy = provider.applyCompletion(['@sr'], 0, 3, { value: 'src/', label: 'src/' }, '@sr')
  assert.deepEqual(legacy, { lines: ['@src/'], cursorLine: 0, cursorCol: 5 })
})

test('provider: accept quotes whitespace paths and replaces only the caret token', () => {
  const { provider } = makeProvider([])
  const quoted = provider.applyCompletion(['@my'], 0, 3, { value: 'my dir/x.txt', label: 'my dir/x.txt', kind: 'file' }, '@my')
  assert.deepEqual(quoted, { lines: ['@"my dir/x.txt" '], cursorLine: 0, cursorCol: 16 })

  const mid = provider.applyCompletion(['see @sr please'], 0, 7, { value: 'src/a.ts', label: 'src/a.ts', kind: 'file' }, '@sr')
  assert.deepEqual(mid, { lines: ['see @src/a.ts  please'], cursorLine: 0, cursorCol: 14 })
})

test('provider: Tab forces completion only inside an @ mention', () => {
  const { provider } = makeProvider([])
  assert.equal(provider.shouldTriggerFileCompletion(['plain text'], 0, 2), false)
  assert.equal(provider.shouldTriggerFileCompletion(['check @sr'], 0, 9), true)
})
