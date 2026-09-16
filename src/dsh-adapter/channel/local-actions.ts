import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { markChannelReadDirty } from '../../adapter/channel/read-view.js'
import { writeActivityFrames } from '../../activityPrefs.js'
import { isPresetName, normalizeActivityPreset } from '../../components/activityFrames.js'
import { t } from '../../i18n.js'
import { snapshotLiveSessionEvents } from '../compat/liveSession.js'
import { LOCAL_OUTPUT_LIMIT, preview, type foldBack as FoldBack } from './transcript.js'
import type { ChannelState, ToolViewPresenter } from './types.js'

type Shell = {
  resolve(request: { command: string; workdir?: string; timeoutMs: number }): unknown
  run(spec: unknown): Promise<{ stdout: { text: string }; stderr: { text: string }; timedOut: boolean }>
}

/** Owns local-only transcript mutations, shell output, and live subagent queries. */
export function createLocalActions(deps: {
  ctx: { get(name: string): unknown }
  owner: { current(): boolean }
  binding: {
    capture(): unknown
    isCurrent(capture: unknown): boolean
    readonly agent: { session: unknown; followup(message: unknown): void }
  }
  state: ChannelState
  rowIds: { value: number }
  projector: { reset(): void; presentCallView: NonNullable<ToolViewPresenter>['call']; presentResultView: NonNullable<ToolViewPresenter>['result'] }
  subagents: { dropRows(): void }
  jobs: { dropRows(): void }
  foldBack: typeof FoldBack
  workspace: { describe(cwd: string): { kind: string; badge: string; label: string }; commandShell(cwd: string): Promise<Shell | undefined> }
  shell?: Shell
  notify: ChannelState['notify']
}) {
  const { ctx, owner, binding, state, rowIds, projector, subagents, jobs, foldBack, workspace, shell, notify } = deps
  const current = (capture: unknown): boolean => owner.current() && binding.isCurrent(capture)
  return {
    loadOlder(): number {
      const restored = foldBack(state.rows, snapshotLiveSessionEvents(binding.agent.session), { call: projector.presentCallView, result: projector.presentResultView })
      if (restored > 0) state.emit()
      return restored
    },
    clear(): void {
      state.rows.length = 0
      markChannelReadDirty(state.rows)
      rowIds.value = 0
      projector.reset()
      subagents.dropRows()
      jobs.dropRows()
      state.activeToolCount = 0
      state.responseChars = 0
      state.rows.push({ id: rowIds.value++, kind: 'notice', text: 'Session cleared' })
      state.emit()
    },
    pushLocal(title: string, lines: readonly string[]): void {
      state.rows.push({ id: rowIds.value++, kind: 'local', text: title })
      for (const line of lines) state.rows.push({ id: rowIds.value++, kind: 'local-output', text: preview(line, LOCAL_OUTPUT_LIMIT) })
      state.emit()
    },
    setActivityFrames(name: string): boolean {
      // A retired preset id normalizes to the current default, so the
      // in-memory state, the persisted preference and the toast agree instead
      // of diverging until restart.
      const preset = normalizeActivityPreset(name) ?? name
      if (!isPresetName(preset)) { notify(t('unknown-activity-preset', { name }), { color: 'error' }); return false }
      if (preset === state.activityFrames) { notify(t('activity-indicator-already', { name: preset }), { color: 'success' }); return true }
      if (!writeActivityFrames(preset)) { notify(t('activity-pref-write-failed'), { color: 'error' }); return false }
      state.activityFrames = preset
      state.emit()
      notify(t('activity-indicator-switched', { name: preset }))
      return true
    },
    async listSubagents(): Promise<string[]> {
      const service = ctx.get('subagents') as {
        listChildren(sessionId: unknown, signal?: AbortSignal): Promise<Array<{ mode: string; label?: string; activity: string; id: string | { value?: string } }>>
      } | undefined
      if (!service) return [t('subagent-not-mounted')]
      const capture = binding.capture()
      try {
        const children = await service.listChildren((binding.agent.session as { id?: unknown }).id)
        if (!current(capture)) throw new Error('dsh-tui: Channel lifetime has ended')
        if (children.length === 0) return [t('subagent-none')]
        return children.map(child => {
          const id = typeof child.id === 'string' ? child.id : (child.id.value ?? '')
          return t('subagent-row', { mode: child.mode === 'continuable' ? t('subagent-resumable') : t('subagent-oneshot'), label: child.label ? `「${child.label}」` : '', activity: child.activity === 'running' ? t('subagent-running') : t('subagent-archived'), id: id.slice(0, 8) })
        })
      } catch (error) {
        if (!current(capture)) throw error
        return [t('subagent-query-failed', { err: error instanceof Error ? error.message : String(error) })]
      }
    },
    async runLocalCommand(command: string, includeInContext: boolean): Promise<void> {
      const capture = binding.capture()
      const cwd = state.cwd
      const target = workspace.describe(cwd)
      state.rows.push({ id: rowIds.value++, kind: 'local', text: command, executionTarget: target.kind === 'local' ? target.badge : `${target.badge} · ${target.label}` })
      state.emit()
      let output = '(no output)'
      const executor = await workspace.commandShell(cwd) ?? shell
      if (!current(capture)) return
      if (executor) {
        try {
          const result = await executor.run(executor.resolve({ command, workdir: cwd, timeoutMs: 30000 }))
          output = result.stdout.text.trim() || result.stderr.text.trim() || (result.timedOut ? '(timed out)' : '(no output)')
        } catch (error) { output = error instanceof Error ? error.message : String(error) }
      }
      if (!current(capture)) return
      state.rows.push({ id: rowIds.value++, kind: 'local-output', text: preview(output, LOCAL_OUTPUT_LIMIT) })
      state.emit()
      if (includeInContext) binding.agent.followup(createUserMessage({ content: [{ type: 'text', text: `<bash-stdout>\n${output}\n</bash-stdout>` }], source: { kind: 'user' } }))
    },
  }
}
