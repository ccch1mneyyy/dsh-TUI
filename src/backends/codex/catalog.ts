/** The native app-server catalog: no rollout/sqlite parsing or second index.
 * Each bounded operation borrows the same hub and releases it in finally. */
import { basename } from 'node:path'
import type { SessionCatalog, SessionListScope } from '../../agent/backend.js'
import type { PreviewEntry, SessionSummary } from '../../adapter/ports/channel-session.js'
import { t } from '../../i18n.js'
import { CODEX_BACKEND_ID } from './contract.js'
import { arr, num, rec, str, text, type Rec } from './narrow.js'
import { CLIENT } from './protocol/index.js'
import { rpcCode, RPC_ERROR } from './rpc/client.js'
import type { CodexHub } from './rpc/hub.js'

export interface CodexCatalogDeps {
  acquire(cwd?: string): Promise<{ readonly hub: Pick<CodexHub, 'call'>; readonly release: () => void }>
  cwd(): string
  lastUsed?(): Readonly<Record<string, number>>
}
const LIST_LIMIT = 500
const LIST_PAGE = 200
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
        const body = text(first?.text) ?? (content.some(block => block?.type === 'image' || block?.type === 'localImage') ? t('codex-preview-image') : undefined)
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
    list(scope: SessionListScope = {}) {
      const cwd = scope.allProjects === true ? undefined : scope.cwd ?? deps.cwd()
      return borrow(cwd, async hub => {
        const rows = new Map<string, SessionSummary>()
        let cursor: string | undefined
        let scanned = 0
        const seen = new Set<string>()
        // The row budget also bounds the number of empty/malformed pages.
        for (let page = 0; page < Math.ceil(LIST_LIMIT / LIST_PAGE) && scanned < LIST_LIMIT; page += 1) {
          const answer = rec(await hub.call(CLIENT.threadList, { limit: Math.min(LIST_PAGE, LIST_LIMIT - scanned), sortKey: 'recency_at', sortDirection: 'desc', archived: false, modelProviders: [], ...(cwd === undefined ? {} : { cwd }), ...(cursor === undefined ? {} : { cursor }) }))
          const data = arr(answer?.data)
          scanned += data.length
          for (const raw of data.slice(0, LIST_LIMIT - rows.size)) {
            const row = codexSessionSummary(raw, deps.lastUsed?.())
            if (row !== undefined && row.kind.kind !== 'subagent') rows.set(row.id, row)
          }
          cursor = text(answer?.nextCursor)
          if (cursor === undefined || seen.has(cursor)) break
          seen.add(cursor)
        }
        return [...rows.values()].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, LIST_LIMIT)
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
        if (rpcCode(error) === RPC_ERROR.invalidRequest && /active.*worker/iu.test(error instanceof Error ? error.message : '')) throw new Error(t('codex-archive-busy'))
        throw error
      }
    }),
  }
}
