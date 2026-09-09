import { statSync } from 'node:fs'
import { t } from '../../i18n.js'
import type { TuiWorkspaceHost, TuiWorkspaceTarget } from '../workspaces.js'
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
  return { listWorkspaces, resolveWorkspace, switchWorkspace, renameWorkspace, workspaceCommands: () => service.commands(), runWorkspaceCommand: (name: string, input: string) => service.runCommand(name, input, state.cwd) }
}
