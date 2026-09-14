import { statSync } from 'node:fs'
import { t } from '../../i18n.js'
import type { TuiWorkspaceEntry, TuiWorkspaceHost, TuiWorkspaceTarget } from '../workspaces.js'
import type { ChannelOwner } from './owner.js'
import type { NewSessionTarget } from './session-resume.js'
import type { ChannelState } from './types.js'

/** Workspace command/query surface. The selected cwd is published only by a successful session adoption. */
export function createWorkspaceActions(
  state: Pick<ChannelState, 'cwd' | 'displayCwd' | 'working' | 'emit'>,
  deps: {
    owner: Pick<ChannelOwner, 'assertActive'>
    service: TuiWorkspaceHost
    newSession(target?: NewSessionTarget): Promise<boolean>
    refreshGitBranch(): void
    notify: ChannelState['notify']
  },
) {
  const { service, notify } = deps
  const listWorkspaces = () => service.list(state.cwd)
  const resolveWorkspace = (uri: string) => service.resolve(uri, state.cwd)
  /**
   * The workspace home screen's sidebar: the durable ledger's own listing.
   *
   * `listWorkspaces()` cannot serve this — it merges provider targets, drops
   * entries with no sessions, and appends the live cwd, so a registered-but-
   * empty workspace would not be listed at all. This reads the registry
   * directly and only adds what the ledger does not know: whether the
   * directory still exists.
   */
  const listWorkspaceRegistry = (): Promise<readonly TuiWorkspaceEntry[]> => service.listRegistry()
  /**
   * "Add this directory to my workspaces", without starting a session.
   *
   * The path is resolved through the same provider-aware seam every other
   * workspace entry point uses, so a provider URI is routed to its owner; the
   * durable record is only minted for a local path (providers own their own
   * listings).
   */
  const registerWorkspace = async (path: string, title?: string): Promise<TuiWorkspaceEntry | undefined> => {
    deps.owner.assertActive()
    const target = await service.resolve(path, state.cwd)
    if (target === undefined) {
      notify(t('workspace-uri-invalid', { target: path }), { color: 'error', timeoutMs: 8000 })
      return undefined
    }
    if (target.kind !== 'local') {
      notify(t('workspace-register-provider', { target: target.label }), { color: 'warning', timeoutMs: 8000 })
      return undefined
    }
    try {
      if (!statSync(target.cwd).isDirectory()) throw new Error('not a directory')
    } catch {
      notify(t('workspace-open-invalid', { target: target.label }), { color: 'error', timeoutMs: 8000 })
      return undefined
    }
    const registered = await service.create(target.cwd, title)
    notify(t('workspace-added', { title: registered.label }))
    return {
      id: registered.uri,
      path: target.cwd,
      title: registered.label,
      present: true,
      sessionCount: 0,
    }
  }
  /** Forget a registration. Sessions are untouched; removing the live workspace is refused. */
  const removeWorkspace = async (path: string): Promise<boolean> => {
    deps.owner.assertActive()
    try {
      const removed = await service.remove(path)
      if (!removed) {
        notify(t('workspace-remove-unknown', { target: path }), { color: 'warning', timeoutMs: 8000 })
        return false
      }
      notify(t('workspace-removed', { target: path }))
      return true
    } catch (error) {
      notify(t('workspace-remove-failed', { err: error instanceof Error ? error.message : String(error) }), { color: 'error', timeoutMs: 8000 })
      return false
    }
  }
  /** Rename the workspace at `path` (not necessarily the live one). */
  const renameWorkspaceAt = async (path: string, title: string): Promise<boolean> => {
    deps.owner.assertActive()
    try {
      const renamed = await service.rename(path, title)
      notify(t('workspace-renamed', { title: renamed.label }))
      return true
    } catch (error) {
      notify(t('workspace-rename-failed', { err: error instanceof Error ? error.message : String(error) }), { color: 'error', timeoutMs: 8000 })
      return false
    }
  }
  const switchWorkspace = async (target: TuiWorkspaceTarget): Promise<boolean> => {
    deps.owner.assertActive()
    if (state.working) { notify(t('workspace-switch-working'), { color: 'warning' }); return false }
    if (target.kind === 'local') {
      try { if (!statSync(target.cwd).isDirectory()) throw new Error('not a directory') }
      catch { notify(t('workspace-open-invalid', { target: target.label }), { color: 'error', timeoutMs: 8000 }); return false }
    }
    // Keep the target private to the guarded create/adopt transaction.  In
    // particular, do not speculate into shared cwd/displayCwd and then try to
    // roll it back: a slower failed request must never erase a newer success.
    try {
      const switched = await deps.newSession({ cwd: target.cwd, displayCwd: target.description ?? target.uri })
      if (!switched) return false
      deps.refreshGitBranch()
      notify(t('workspace-switched', { target: target.label }))
      state.emit()
      return true
    } catch (error) {
      notify(t('workspace-command-failed', { err: error instanceof Error ? error.message : String(error) }), { color: 'error', timeoutMs: 8000 })
      return false
    }
  }
  const renameWorkspace = async (title: string): Promise<boolean> => {
    deps.owner.assertActive()
    try {
      const renamed = await service.rename(state.cwd, title)
      state.displayCwd = renamed.description ?? renamed.uri
      notify(t('workspace-renamed', { title: renamed.label }))
      state.emit()
      return true
    } catch (error) {
      notify(t('workspace-rename-failed', { err: error instanceof Error ? error.message : String(error) }), { color: 'error', timeoutMs: 8000 })
      return false
    }
  }
  return { listWorkspaces, listWorkspaceRegistry, registerWorkspace, removeWorkspace, renameWorkspaceAt, resolveWorkspace, switchWorkspace, renameWorkspace, workspaceCommands: () => service.commands(), runWorkspaceCommand: (name: string, input: string) => service.runCommand(name, input, state.cwd) }
}
