/**
 * Session lifecycle actions the core serves for a session no extension
 * claims: the session browser's catalog (listing, preview, rename, delete,
 * the launcher's last-session marker), `/resume`, `/fork` and the double-Esc
 * rewind. They are backed by the backend's offline `SessionCatalog`, its
 * `openSession` and the bound session's `fork` / `rewind` capabilities. A
 * missing backing is an explicit `capability-unavailable-backend`, never a
 * silent no-op.
 *
 * Within one backend per process: the catalog lists the bound backend's
 * sessions and a resume opens one of them; switching backends inside one
 * running TUI is not offered (a launch-time choice, `--backend`).
 */
import type { SessionCatalog } from '../../../agent/backend.js'
import { formatSessionRef } from '../../../agent/refs.js'
import type { AgentSession } from '../../../agent/session.js'
import { t, type I18nKey } from '../../../i18n.js'
import { occupancyOf, readSessionOwners } from '../../../sessionMounts.js'
import type { ChannelActionDelegates } from '../action-readiness.js'
import type { ChannelOwner } from '../owner.js'
import type { ChannelLaunchOptions } from '../state.js'
import type { SessionSummary, TuiRewindMode } from '../../../adapter/ports/channel-session.js'
import type { ChannelState, ChatRow, ResumeResult } from '../types.js'

/** Preview text of a dry-run file restore (`3 files · +10 −2`). */
function filesSummary(preview: { readonly filesChanged: readonly string[]; readonly insertions?: number; readonly deletions?: number }): string {
  const parts = [t('rewind-files-count', { n: preview.filesChanged.length })]
  if (preview.insertions !== undefined || preview.deletions !== undefined) parts.push(`+${preview.insertions ?? 0} −${preview.deletions ?? 0}`)
  return parts.join(' · ')
}

const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error)

export function createCoreSessionActions(deps: {
  owner: Pick<ChannelOwner, 'current'>
  session(): AgentSession
  state: () => ChannelState
  notify: ChannelState['notify']
  unavailable(name: string): void
  catalog: SessionCatalog | undefined
  prefs: ChannelLaunchOptions['sessionPrefs']
  resumeCommand: ChannelLaunchOptions['resumeCommand']
  /** The core `/resume` transaction (session-switch.ts). */
  resume(sessionId: string, kind: 'resume' | 'rewind'): Promise<ResumeResult>
  /** Whether `/resume` is offered (the backend's `open` and catalog). */
  canOpen: boolean
}) {
  const { notify, unavailable } = deps
  const caps = (): AgentSession['capabilities'] => deps.session().capabilities
  /** The last successful listing (the browser's first paint; may be stale). */
  let cached: readonly SessionSummary[] | undefined
  const rowOf = (sessionId: string): SessionSummary | undefined => cached?.find(row => row.id === sessionId)
  const isBound = (sessionId: string): boolean => deps.session().ref.sessionId === sessionId
  const failed = (key: I18nKey, error: unknown): void => {
    if (deps.owner.current()) notify(t(key, { err: errorText(error) }), { color: 'error', timeoutMs: 8000 })
  }

  const delegates: Partial<ChannelActionDelegates> = {
    cachedSessions: () => cached,

    /**
     * The bound backend's sessions: the working directory's first (painted
     * at once through `onPartial`), then every project the backend knows,
     * which the browser's rail groups by directory. A failing all-projects
     * read keeps the directory's rows.
     */
    async listSessions(_onEnriched, onPartial) {
      const catalog = deps.catalog
      if (catalog === undefined) { unavailable('resume'); return [] }
      const local = await catalog.list({ cwd: deps.state().cwd })
      onPartial?.(local)
      let all: readonly SessionSummary[]
      try {
        all = await catalog.list({ allProjects: true })
      } catch {
        all = local
      }
      const ids = new Set(all.map(row => row.id))
      const merged = [...all, ...local.filter(row => !ids.has(row.id))].sort((a, b) => b.updatedAt - a.updatedAt)
      cached = merged
      return merged
    },

    async previewSession(sessionId) {
      const preview = deps.catalog?.preview
      if (preview === undefined) { unavailable('resume'); return [] }
      try {
        const cwd = rowOf(sessionId)?.cwd
        return await preview(sessionId, { ...(cwd === undefined || cwd === '' ? {} : { cwd }) })
      } catch {
        return []
      }
    },

    async renameSessionTo(sessionId, title) {
      const rename = deps.catalog?.rename
      if (rename === undefined) { unavailable('rename'); return false }
      const next = title.trim()
      if (next === '') return false
      try {
        await rename(sessionId, next, rowOf(sessionId)?.cwd)
      } catch (error) {
        failed('rename-failed', error)
        return false
      }
      cached = cached?.map(row => row.id === sessionId ? { ...row, title: { text: next, source: 'renamed' } } : row)
      if (isBound(sessionId) && deps.owner.current()) {
        const state = deps.state()
        state.sessionTitle = next
        state.emit()
      }
      return true
    },

    /**
     * Delete a stored session: never the bound one, and never one another
     * TUI process has mounted (its transcript is being written). The MRU note
     * and the launcher marker go with it.
     */
    async deleteSession(sessionId) {
      const remove = deps.catalog?.delete
      if (remove === undefined) { unavailable('resume'); return false }
      if (isBound(sessionId)) return false
      const key = formatSessionRef({ backendId: deps.session().ref.backendId, sessionId })
      const occupancy = occupancyOf(key, readSessionOwners())
      if (occupancy.kind === 'occupied') {
        notify(t('resume-session-occupied', { pid: occupancy.pid }), { color: 'error', timeoutMs: 8000 })
        return false
      }
      try {
        await remove(sessionId, rowOf(sessionId)?.cwd)
      } catch (error) {
        failed('session-delete-failed', error)
        return false
      }
      deps.prefs?.forget(sessionId)
      cached = cached?.filter(row => row.id !== sessionId)
      return true
    },

    setResumeTarget(sessionId) {
      if (deps.prefs === undefined) { unavailable('resume'); return }
      deps.prefs.setLastSession(sessionId)
    },

    async resumeTo(sessionId) {
      if (!deps.canOpen) { unavailable('resume'); return { ok: false, reason: 'unavailable' } }
      const result = await deps.resume(sessionId, 'resume')
      if (result.ok) deps.prefs?.setLastSession(sessionId)
      return result
    },

    /**
     * `/fork`: a persisted copy of the bound session under a new id; the live
     * session keeps running untouched (the DSH `/fork` semantics). The notice
     * names how to enter the copy.
     */
    async forkSession() {
      const fork = caps().fork
      if (fork === undefined) { unavailable('fork'); return false }
      if (deps.state().working) {
        notify(t('fork-while-working'), { color: 'warning' })
        return false
      }
      let forked: { readonly sessionId: string }
      try {
        forked = await fork.fork()
      } catch (error) {
        failed('fork-failed', error)
        return false
      }
      if (!deps.owner.current()) return true
      const command = deps.resumeCommand?.(forked.sessionId) ?? `/resume ${forked.sessionId}`
      notify(t('fork-done', { id: forked.sessionId, command }), { timeoutMs: 8000 })
      return true
    },

    /**
     * The double-Esc rewind: `files` restores the tracked files to their
     * state at the picked message. The conversation rewind (the plain
     * confirm, or `both` after the files) continues in the backend's fork cut
     * just before that message, opened and adopted like a resume, and hands
     * the picked message back for re-editing.
     */
    async rewindTo(row: ChatRow, mode: string | null = null) {
      const rewind = caps().rewind
      if (rewind === undefined) { unavailable('rewind'); return null }
      if (row.anchor === undefined) {
        notify(t('rewind-unanchored'), { color: 'warning', timeoutMs: 6000 })
        return null
      }
      if (deps.state().working) {
        notify(t('rewind-while-working'), { color: 'warning' })
        return null
      }
      const kind = mode === 'files' ? 'files' : mode === 'both' ? 'both' : 'conversation'
      const session = deps.session()
      let outcome: Awaited<ReturnType<typeof rewind.rewind>>
      try {
        outcome = await rewind.rewind(row.anchor, kind)
      } catch (error) {
        failed('rewind-fork-failed', error)
        return null
      }
      if (!deps.owner.current()) return null
      if (outcome.kind === 'refused') {
        notify(t('rewind-fork-failed', { err: outcome.reason }), { color: 'error', timeoutMs: 8000 })
        return null
      }
      if (outcome.files !== undefined) notify(t('rewind-files-restored', { summary: filesSummary(outcome.files) }), { timeoutMs: 6000 })
      if (outcome.conversationError !== undefined) {
        // Half done: the files moved, the conversation did not.
        notify(t('rewind-conversation-failed', { err: outcome.conversationError }), { color: 'warning', timeoutMs: 10000 })
        return null
      }
      if (kind === 'files' || outcome.session.sessionId === session.ref.sessionId) return null
      const forkId = outcome.session.sessionId
      const forkKept = (): null => {
        if (deps.owner.current()) {
          notify(t('rewind-fork-kept', { command: deps.resumeCommand?.(forkId) ?? `/resume ${forkId}` }), { color: 'warning', timeoutMs: 10000 })
        }
        return null
      }
      // The fork is persisted whatever happens next, so a fork the channel
      // does not adopt is named. The user may have moved to another session
      // while the backend forked: that session stays.
      if (deps.session() !== session) return forkKept()
      const adopted = await deps.resume(forkId, 'rewind')
      if (!adopted.ok) return forkKept()
      return row.text
    },
  }

  /**
   * The rewind confirm pane's choices: with a file restore available (a dry
   * run reports changed files), "restore files" and "both" join the plain
   * conversation rewind, each described by the dry run; otherwise the plain
   * confirm. Plugin rewind modes (`tui/rewind-prompt`) are a DSH seam.
   */
  const promptRewind = async (row: ChatRow): Promise<{ modes: readonly TuiRewindMode[] } | 'cancel' | null> => {
    const rewind = caps().rewind
    if (rewind === undefined) { unavailable('rewind'); return 'cancel' }
    if (row.anchor === undefined) {
      notify(t('rewind-unanchored'), { color: 'warning', timeoutMs: 6000 })
      return 'cancel'
    }
    if (rewind.preview === undefined) return null
    let preview: Awaited<ReturnType<NonNullable<typeof rewind.preview>>>
    try {
      preview = await rewind.preview(row.anchor)
    } catch {
      // Nothing to restore (no checkpoint, or the files cannot be restored):
      // the plain conversation rewind stays.
      return null
    }
    if (preview.filesChanged.length === 0) return null
    const description = filesSummary(preview)
    return {
      modes: [
        { id: 'both', label: t('rewind-mode-both'), description },
        { id: 'files', label: t('rewind-mode-files'), description },
      ],
    }
  }

  return { delegates, promptRewind }
}
