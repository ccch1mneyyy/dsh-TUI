/** Fork, rewind and rename a session through the persisted SDK store. */
import type { Query } from '@anthropic-ai/claude-agent-sdk'
import type { RewindOutcome, RewindPreview } from '../../../agent/capabilities.js'
import type { AgentEvent } from '../../../agent/events.js'
import type { AgentSessionRef } from '../../../agent/refs.js'
import type { AgentSession } from '../../../agent/session.js'
import { claudeText } from '../text.js'
import { CLAUDE_BACKEND_ID } from '../contract.js'
import { errorText } from '../narrow.js'
import { rewindCutPoint } from '../replay.js'
import type { ClaudeSessionDeps, Run } from './types.js'

export function createSessionStore(context: {
  readonly deps: ClaudeSessionDeps
  readonly run: Run
  readonly persisted: boolean
  readonly currentSessionId: string
  readonly ownRef: AgentSessionRef
  emit(events: readonly AgentEvent[]): void
}) {
  const { deps, ownRef, emit } = context
  /** A `/rename` made before the CLI wrote the transcript (flushRename). */
  let pendingTitle: string | undefined
  /** The live query's checkpoint restore (`enableFileCheckpointing`). */
  const rewindFiles = async (anchor: string, dryRun: boolean): Promise<RewindPreview> => {
    const query = context.run.query as Partial<Pick<Query, 'rewindFiles'>>
    if (typeof query.rewindFiles !== 'function') throw new Error(claudeText('claude-rewind-files-unavailable'))
    const result = await query.rewindFiles(anchor, dryRun ? { dryRun: true } : undefined)
    if (!result.canRewind) throw new Error(result.error ?? claudeText('claude-rewind-files-unavailable'))
    return {
      filesChanged: result.filesChanged ?? [],
      ...(result.insertions === undefined ? {} : { insertions: result.insertions }),
      ...(result.deletions === undefined ? {} : { deletions: result.deletions }),
    }
  }

  /**
   * `/fork` and the conversation rewind, both through the
   * session store: a fork is a persisted copy under a new id (the live
   * session is untouched); a conversation rewind forks up to the entry
   * right before the picked user message, for the channel to open and adopt.
   */
  function sessionStoreCapabilities(): Pick<AgentSession['capabilities'], 'fork' | 'rewind'> {
    const store = deps.store
    if (store === undefined) return {}
    const fork = async (options: { readonly upToMessageId?: string; readonly title?: string }): Promise<AgentSessionRef> => {
      // Nothing to copy before the CLI wrote the transcript.
      if (!context.persisted) throw new Error(claudeText('claude-fork-empty'))
      const forked = await store.forkSession(context.currentSessionId, { dir: deps.cwd, ...options })
      return { backendId: CLAUDE_BACKEND_ID, sessionId: forked.sessionId }
    }
    return {
      fork: {
        fork: (anchor, title) => fork({ ...(anchor === undefined ? {} : { upToMessageId: anchor }), ...(title === undefined ? {} : { title }) }),
      },
      rewind: {
        preview: anchor => rewindFiles(anchor, true),
        async rewind(anchor, mode): Promise<RewindOutcome> {
          let cut: string | undefined
          if (mode !== 'files') {
            // Resolve the cut before touching any file: a conversation the
            // rewind cannot cut must not leave the files rewound alone.
            const chain = await store.getSessionMessages(context.currentSessionId, { dir: deps.cwd, includeSystemMessages: true })
            if (!chain.some(message => message.uuid === anchor)) return { kind: 'refused', reason: claudeText('claude-rewind-not-found') }
            cut = rewindCutPoint(chain, anchor)
            if (cut === undefined) return { kind: 'refused', reason: claudeText('rewind-first-message') }
          }
          let files: RewindPreview | undefined
          if (mode !== 'conversation') {
            try {
              files = await rewindFiles(anchor, false)
            } catch (error) {
              return { kind: 'refused', reason: errorText(error) }
            }
          }
          if (cut === undefined) return { kind: 'rewound', session: ownRef, ...(files === undefined ? {} : { files }) }
          try {
            const session = await fork({ upToMessageId: cut })
            return { kind: 'rewound', session, ...(files === undefined ? {} : { files }) }
          } catch (error) {
            // The files are restored already: that outcome must not be lost
            // with the failed conversation half.
            if (files === undefined) throw error
            return { kind: 'rewound', session: ownRef, files, conversationError: errorText(error) }
          }
        },
      },
    }
  }

  /**
   * `/rename`: `renameSession()` writes the title into the
   * transcript (the browser and `claude --resume` read it), and the live
   * session reports it at once. Before the CLI wrote the transcript there is
   * no file to append to: the title is kept and written with the first
   * persisted frame.
   */
  function flushRename(): void {
    const title = pendingTitle
    const rename = deps.store?.renameSession
    if (title === undefined || rename === undefined || !context.persisted) return
    pendingTitle = undefined
    void rename(context.currentSessionId, title, { dir: deps.cwd }).catch((error: unknown) => {
      deps.host.debug(`claude: deferred rename failed (${errorText(error)})`)
      emit([{ type: 'notice', level: 'warning', text: claudeText('rename-failed', { err: errorText(error) }) }])
    })
  }
  function renameCapability(): Pick<AgentSession['capabilities'], 'rename'> {
    const rename = deps.store?.renameSession
    if (rename === undefined) return {}
    return {
      rename: {
        async rename(title: string): Promise<void> {
          const trimmed = title.trim()
          if (trimmed === '') throw new Error(claudeText('rename-usage'))
          if (context.persisted) await rename(context.currentSessionId, trimmed, { dir: deps.cwd })
          else pendingTitle = trimmed
          emit([{ type: 'session.title', title: trimmed, source: 'user' }])
        },
      },
    }
  }
  return { sessionStoreCapabilities, renameCapability, flushRename }
}
