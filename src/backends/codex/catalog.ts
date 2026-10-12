/** The native app-server catalog: no rollout/sqlite parsing or second index.
 * Each bounded operation borrows the same hub and releases it in finally. */
import { basename } from 'node:path'
import type { SessionCatalog, SessionListScope } from '../../agent/backend.js'
import type { PreviewEntry, SessionSummary } from '../../agent/index.js'
import { codexText } from './text.js'
import { CODEX_BACKEND_ID } from './contract.js'
import { arr, num, rec, str, text } from './narrow.js'
import { CLIENT } from './protocol/index.js'
import { rpcCode, RPC_ERROR } from './rpc/client.js'
import type { CodexHub } from './rpc/hub.js'

export interface CodexCatalogDeps {
  acquire(cwd?: string): Promise<{ readonly hub: Pick<CodexHub, 'call'>; readonly release: () => void }>
  cwd(): string
  lastUsed?(): Readonly<Record<string, number>>
  snapshotKey?(): string | undefined
}
const LIST_LIMIT = 500
const LIST_PAGE = 200
const FIRST_PAGE = 32
const PREVIEW_LIMIT = 6

/** Metadata only. Absence of preview text is not proof of an empty thread. */
export function codexSessionSummary(value: unknown, lastUsed: Readonly<Record<string, number>> = {}): SessionSummary | undefined {
  const row = rec(value)
  const id = text(row?.id)
  if (id === undefined || row?.ephemeral === true) return undefined
  const cwd = str(row?.cwd) ?? ''
  const name = text(row?.name)?.trim()
  const prompt = text(row?.preview)?.trim()
  const parent = text(row?.parentThreadId)
  const spawn = rec(rec(rec(row?.source)?.subAgent)?.thread_spawn)
  const forkedFrom = text(row?.forkedFromId)
  return {
    id, backendId: CODEX_BACKEND_ID,
    kind: parent !== undefined || rec(row?.source)?.subAgent !== undefined
      ? { kind: 'subagent', parent: parent ?? text(spawn?.parent_thread_id), depth: num(spawn?.depth) ?? 1 }
      : forkedFrom === undefined ? { kind: 'root' } : { kind: 'fork', parent: forkedFrom },
    title: name ? { text: name, source: 'auto' } : prompt ? { text: prompt, source: 'prompt' } : { text: basename(cwd) || id, source: 'fallback' },
    cwd, createdAt: (num(row?.createdAt) ?? 0) * 1000,
    updatedAt: Math.max((num(row?.updatedAt) ?? num(row?.createdAt) ?? 0) * 1000, (num(row?.recencyAt) ?? 0) * 1000, lastUsed[id] ?? 0),
    bytes: undefined, hasPrompt: true, agentPreset: undefined,
    model: text(row?.model), label: text(row?.agentNickname), branch: text(rec(row?.gitInfo)?.branch), childCount: 0,
  }
}

/** Summary items contain text and images, never needing a tool-body read. */
export function codexPreviewEntries(turns: readonly unknown[], limit = PREVIEW_LIMIT): PreviewEntry[] {
  const entries: PreviewEntry[] = []
  for (const raw of turns) {
    const turn = rec(raw)
    const at = num(turn?.startedAt)
    for (const rawItem of arr(turn?.items)) {
      const item = rec(rawItem)
      if (item?.type === 'userMessage') {
        const content = arr(item.content).map(rec)
        const first = content.find(block => block?.type === 'text')
        const body = text(first?.text) ?? (content.some(block => block?.type === 'image' || block?.type === 'localImage') ? codexText('codex-preview-image') : undefined)
        if (body !== undefined) entries.push({ role: 'user', text: body, at: at === undefined ? undefined : at * 1000 })
      } else if (item?.type === 'agentMessage' && text(item.text) !== undefined) {
        entries.push({ role: 'assistant', text: str(item.text)!, at: at === undefined ? undefined : at * 1000 })
      }
    }
  }
  return limit <= 0 ? [] : entries.slice(-limit)
}

export function createCodexCatalog(deps: CodexCatalogDeps): SessionCatalog {
  const borrow = async <T>(cwd: string | undefined, use: (hub: Pick<CodexHub, 'call'>) => Promise<T>): Promise<T> => {
    const runtime = await deps.acquire(cwd)
    try { return await use(runtime.hub) } finally { runtime.release() }
  }
  return {
    deleteAction: 'archive',
    ...(deps.snapshotKey === undefined ? {} : { snapshotKey: deps.snapshotKey }),
    list(scope: SessionListScope = {}, onPartial?: (rows: readonly SessionSummary[]) => void) {
      const cwd = scope.allProjects === true ? undefined : scope.cwd ?? deps.cwd()
      return borrow(cwd, async hub => {
        const rows = new Map<string, SessionSummary>()
        const initial = new Map<string, SessionSummary>()
        let cursor: string | undefined
        let scanned = 0
        const seen = new Set<string>()
        // Read file-backed preferences once, rather than synchronously reading
        // and parsing them for every thread in every page.
        const used = deps.lastUsed?.()
        const params = { sortKey: 'recency_at', sortDirection: 'desc', archived: false, modelProviders: [], ...(cwd === undefined ? {} : { cwd }) }
        const publish = (): void => {
          onPartial?.([...new Map([...initial, ...rows]).values()].sort((a, b) => b.updatedAt - a.updatedAt))
        }
        const initialAbort = new AbortController()
        let finished = false
        let firstPage: Promise<void> | undefined
        if (onPartial !== undefined) {
          // The DB shortcut must not delay discovery of new rollout files.
          // Repaired rows win even if the DB response arrives later.
          firstPage = hub.call(CLIENT.threadList, { ...params, limit: FIRST_PAGE, useStateDbOnly: true }, { timeoutMs: 1000, signal: initialAbort.signal }).then(answer => {
            if (finished) return
            for (const raw of arr(rec(answer)?.data)) {
              const row = codexSessionSummary(raw, used)
              if (row !== undefined && row.kind.kind !== 'subagent') initial.set(row.id, row)
            }
            if (initial.size > 0) publish()
          }, () => { /* Older servers or unavailable DBs use the regular listing. */ })
          // Attach a rejection handler now; publication errors are rethrown
          // by the final await after the other pending RPC has settled.
          void firstPage.catch(() => {})
        }
        try {
          // Servers may cap pages below our requested size. Bound empty pages
          // separately, rather than stopping after three capped pages.
          for (let page = 0; page < Math.ceil(LIST_LIMIT / FIRST_PAGE) && scanned < LIST_LIMIT; page += 1) {
            const limit = page === 0 && onPartial !== undefined ? FIRST_PAGE : LIST_PAGE
            const answer = rec(await hub.call(CLIENT.threadList, { ...params, limit: Math.min(limit, LIST_LIMIT - scanned), ...(cursor === undefined ? {} : { cursor }) }))
            const data = arr(answer?.data)
            scanned += data.length
            for (const raw of data.slice(0, LIST_LIMIT - rows.size)) {
              const row = codexSessionSummary(raw, used)
              if (row !== undefined && row.kind.kind !== 'subagent') rows.set(row.id, row)
            }
            // Progress is cumulative; repaired rows supersede the DB metadata,
            // and only the resolved result may drop unconfirmed initial IDs.
            publish()
            cursor = text(answer?.nextCursor)
            if (cursor === undefined || seen.has(cursor)) break
            seen.add(cursor)
          }
          return [...rows.values()].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, LIST_LIMIT)
        } finally {
          finished = true
          initialAbort.abort()
          // Keep the runtime borrowed until the speculative DB request has
          // settled; it can never publish after completion or failure.
          await firstPage
        }
      })
    },
    info(sessionId, cwd) {
      return borrow(cwd, async hub => {
        try { return codexSessionSummary(rec(await hub.call(CLIENT.threadRead, { threadId: sessionId, includeTurns: false }))?.thread, deps.lastUsed?.()) }
        catch (error) {
          if (rpcCode(error) === RPC_ERROR.invalidRequest && /not found|does not exist/iu.test(error instanceof Error ? error.message : '')) return undefined
          throw error
        }
      })
    },
    preview(sessionId, options = {}) {
      const limit = Math.max(0, Math.min(20, options.limit ?? PREVIEW_LIMIT))
      if (limit === 0) return Promise.resolve([])
      return borrow(options.cwd, async hub => {
        const answer = rec(await hub.call(CLIENT.threadTurnsList, { threadId: sessionId, sortDirection: 'desc', limit, itemsView: 'summary' }))
        return codexPreviewEntries([...arr(answer?.data)].reverse(), limit)
      })
    },
    rename: (threadId, name, cwd) => borrow(cwd, async hub => { await hub.call(CLIENT.threadNameSet, { threadId, name }) }),
    delete: (threadId, cwd) => borrow(cwd, async hub => {
      try { await hub.call(CLIENT.threadArchive, { threadId }) }
      catch (error) {
        if (rpcCode(error) === RPC_ERROR.invalidRequest && /active.*worker/iu.test(error instanceof Error ? error.message : '')) throw new Error(codexText('codex-archive-busy'))
        throw error
      }
    }),
  }
}
