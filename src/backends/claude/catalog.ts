/**
 * The Claude Agent backend's offline session catalog: the SDK's session-store
 * API is the source of truth — the CLI
 * writes `~/.claude/projects/<cwd>/<id>.jsonl`, the SDK lists, reads, renames,
 * deletes and forks — and this module only maps its records onto the session
 * browser's `SessionSummary` rows. Nothing is written to the transcripts here
 * beyond what the SDK's own mutations write (a rename appends a
 * `custom-title` entry), and no second index is kept.
 *
 * Listing: `includeProgrammatic` is passed `true`. Sessions this
 * backend creates carry the SDK entrypoint `sdk-ts`, which
 * `includeProgrammatic:false` (the parity setting of the CLI's own `/resume`
 * picker) hides — they would vanish from the browser that made them. The
 * price is that other headless runs (`claude -p`, other SDK hosts) list too.
 *
 * Titles: SDK 0.3.287 reports the user's `/rename` title and the CLI's
 * generated title through the same `customTitle` field (it falls back to
 * `aiTitle`), so a titled row is `auto`; an untitled one shows its first
 * prompt (`prompt`), else the directory name (`fallback`).
 */
import { basename } from 'node:path'
import type { SDKSessionInfo } from '@anthropic-ai/claude-agent-sdk'
import type { SessionCatalog, SessionListScope } from '../../agent/backend.js'
import type { PreviewEntry, SessionSummary } from '../../adapter/ports/channel-session.js'
import { CLAUDE_BACKEND_ID } from './contract.js'
import { previewEntries } from './replay.js'
import type { ClaudeSessionStoreSdk } from './sdk.js'

export interface ClaudeCatalogDeps {
  /** The session-store API (loaded on first use; the SDK is an optional peer). */
  loadSdk(): Promise<Pick<ClaudeSessionStoreSdk, 'listSessions' | 'getSessionInfo' | 'getSessionMessages' | 'renameSession' | 'deleteSession'>>
  /** The directory a listing without a scope looks in. */
  cwd(): string
  /** This install's last-used notes (epoch ms by session id). */
  lastUsed?(): Readonly<Record<string, number>>
  snapshotKey?(): string | undefined
}

/** Preview depth when the caller names none. */
const PREVIEW_LIMIT = 6
const FIRST_PAGE = 32

/** One SDK record as a browser row. */
export function claudeSessionSummary(info: SDKSessionInfo, lastUsed: Readonly<Record<string, number>> = {}): SessionSummary {
  const cwd = info.cwd ?? ''
  const titled = info.customTitle?.trim()
  const prompt = info.firstPrompt?.trim()
  const summary = info.summary.trim()
  const title: SessionSummary['title'] = titled !== undefined && titled !== ''
    ? { text: titled, source: 'auto' }
    : prompt !== undefined && prompt !== ''
      ? { text: prompt, source: 'prompt' }
      : summary !== ''
        ? { text: summary, source: 'prompt' }
        : { text: basename(cwd) || info.sessionId, source: 'fallback' }
  const used = lastUsed[info.sessionId]
  return {
    id: info.sessionId,
    backendId: CLAUDE_BACKEND_ID,
    kind: { kind: 'root' },
    title,
    cwd,
    createdAt: info.createdAt ?? info.lastModified,
    // The later of the transcript's own mtime and this install's last-used
    // note (the DSH rule: two lower bounds on "last touched").
    updatedAt: Math.max(info.lastModified, used ?? 0),
    bytes: info.fileSize,
    // The SDK lists only sessions with an extractable prompt or title.
    hasPrompt: true,
    agentPreset: undefined,
    model: undefined,
    label: undefined,
    branch: info.gitBranch === undefined || info.gitBranch === '' ? undefined : info.gitBranch,
    childCount: 0,
  }
}

/** The catalog over one SDK session store. */
export function createClaudeCatalog(deps: ClaudeCatalogDeps): SessionCatalog {
  const lastUsed = (): Readonly<Record<string, number>> => deps.lastUsed?.() ?? {}
  const dirOption = (cwd: string | undefined): { dir: string } | undefined => cwd === undefined || cwd === '' ? undefined : { dir: cwd }
  return {
    ...(deps.snapshotKey === undefined ? {} : { snapshotKey: deps.snapshotKey }),
    async list(scope: SessionListScope = {}, onPartial?: (rows: readonly SessionSummary[]) => void): Promise<readonly SessionSummary[]> {
      const sdk = await deps.loadSdk()
      const options = { includeProgrammatic: true, ...(scope.allProjects === true ? {} : { dir: scope.cwd ?? deps.cwd() }) }
      const used = lastUsed()
      const summaries = (infos: readonly SDKSessionInfo[]): SessionSummary[] =>
        infos.map(info => claudeSessionSummary(info, used)).sort((a, b) => b.updatedAt - a.updatedAt)
      if (onPartial !== undefined) {
        // A bounded SDK read extracts metadata only for the newest sessions.
        // Both reads keep the SDK's project scope, including git worktrees.
        // An unlimited read confirms completeness: a short limited page does
        // not promise exhaustion. Avoid repeatedly scanning offset pages.
        const first = await sdk.listSessions({ ...options, limit: FIRST_PAGE })
        const rows = summaries(first)
        onPartial(rows)
      }
      return summaries(await sdk.listSessions(options))
    },
    async info(sessionId: string, cwd?: string): Promise<SessionSummary | undefined> {
      const sdk = await deps.loadSdk()
      // A session recorded elsewhere than `cwd` is still found: the scoped
      // lookup first (one directory), then every project.
      const info = (cwd === undefined ? undefined : await sdk.getSessionInfo(sessionId, { dir: cwd })) ?? await sdk.getSessionInfo(sessionId)
      return info === undefined ? undefined : claudeSessionSummary(info, lastUsed())
    },
    async preview(sessionId, options = {}): Promise<readonly PreviewEntry[]> {
      const sdk = await deps.loadSdk()
      const messages = await sdk.getSessionMessages(sessionId, { ...dirOption(options.cwd) })
      return previewEntries(messages, options.limit ?? PREVIEW_LIMIT)
    },
    async rename(sessionId: string, title: string, cwd?: string): Promise<void> {
      const sdk = await deps.loadSdk()
      await sdk.renameSession(sessionId, title, dirOption(cwd))
    },
    async delete(sessionId: string, cwd?: string): Promise<void> {
      const sdk = await deps.loadSdk()
      await sdk.deleteSession(sessionId, dirOption(cwd))
    },
  }
}
