/**
 * Local-only transcript actions every session gets: `/clear`, local report
 * rows, `!cmd` / `!!cmd` through the session's workspace shell,
 * `/activity frames`, and the "load earlier" restore of folded rows. The
 * restore only works when the backend can slice its own durable history;
 * otherwise nothing is ever folded and the action restores 0 rows.
 */
import type { ServiceLookup } from '../channel-host.js'
import { randomUUID } from 'node:crypto'
import { markChannelReadDirty } from '../../../adapter/channel/read-view.js'
import { writeActivityFrames } from '../../../activityPrefs.js'
import { isPresetName, normalizeActivityPreset } from '../../../components/activityFrames.js'
import { t } from '../../../i18n.js'
import { runForegroundShell, type ForegroundShell } from '../../compat/shell.js'
import { cleanCommandReport } from '../../sanitize.js'
import type { ChannelBinding } from '../binding.js'
import type { ChannelOwner } from '../owner.js'
import { LOCAL_OUTPUT_LIMIT, preview, previewIndented, trimLocalRows } from '../transcript.js'
import { sessionWorkingDirectory } from '../../../channel/working-directory.js'
import type { ChannelState, LocalCommandMode } from '../types.js'
import type { CoreHost } from './host.js'

/** `/activity frames <name>`: validate, persist, re-render. */
export function setActivityFrames(
  state: Pick<ChannelState, 'activityFrames' | 'emit'>,
  notify: ChannelState['notify'],
  name: string,
): boolean {
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
}

export function createCoreLocalActions(ctx: ServiceLookup, deps: {
  owner: Pick<ChannelOwner, 'current'>
  binding: Pick<ChannelBinding, 'capture' | 'isCurrent'>
  state: ChannelState
  rowIds: { value: number }
  workspace: CoreHost['workspaceService']
  resetProjection(): void
  notify: ChannelState['notify']
  unavailable(name: string): void
  /** Extension projections whose rows `/clear` drops with the transcript. */
  dropRows(): void
  /** Restore folded rows from the backend's durable history; absent = the
   *  backend cannot slice it (and nothing is folded). */
  loadOlder(): (() => number) | undefined
  /** Stage a `$cmd` run on the composer (the attached-context registry). */
  stageContext: ChannelState['attachContext']
  /** An input on its way to the session (`!!`): returns its end. */
  beginInput?(): () => void
}) {
  const { owner, binding, state, rowIds, notify } = deps

  return {
    loadOlder(): number {
      const restore = deps.loadOlder()
      if (restore === undefined) return 0
      const restored = restore()
      if (restored > 0) state.emit()
      return restored
    },

    clear(): void {
      state.rows.length = 0
      markChannelReadDirty(state.rows)
      rowIds.value = 0
      deps.resetProjection()
      deps.dropRows()
      state.activeToolCount = 0
      state.responseChars = 0
      state.rows.push({ id: rowIds.value++, kind: 'notice', text: t('session-cleared') })
      state.emit()
    },

    pushLocal(title: string, lines: readonly string[], options?: { readonly lineLimit?: number; readonly preserveWhitespace?: boolean }): void {
      // A report whose line IS the payload (the /goal objective) raises the
      // budget; every other report keeps the shared 240-cell preview.
      const limit = options?.lineLimit ?? LOCAL_OUTPUT_LIMIT
      const render = options?.preserveWhitespace ? previewIndented : preview
      // Local reports cannot be restored from backend history. Retain whole
      // recent blocks within the existing row budget, without folding facts.
      trimLocalRows(state.rows, lines.length + 1)
      markChannelReadDirty(state.rows)
      state.rows.push({ id: rowIds.value++, kind: 'local', text: title })
      for (const line of lines) state.rows.push({ id: rowIds.value++, kind: 'local-output', text: render(line, limit) })
      state.emit()
    },

    setActivityFrames: (name: string): boolean => setActivityFrames(state, notify, name),

    /**
     * `!cmd` / `!!cmd` / `$cmd`: the workspace's own command shell when it
     * has one (a remote workspace runs the command there), else the host
     * shell; `!!` sends the output on as a followup of the session it ran
     * for, `$` stages command + output as an attached context for the next
     * message (no turn starts).
     */
    async runLocalCommand(command: string, mode: LocalCommandMode): Promise<void> {
      // `!!` is an input from its first keystroke: `/new` must not adopt
      // over a command whose output is about to reach this session.
      const end = mode === 'send' ? deps.beginInput?.() : undefined
      try {
        await runLocal(command, mode)
      } finally {
        end?.()
      }
    },
  }

  async function runLocal(command: string, mode: LocalCommandMode): Promise<void> {
    const capture = binding.capture()
    const current = (): boolean => owner.current() && binding.isCurrent(capture)
    const cwd = sessionWorkingDirectory(state)
    const target = deps.workspace.describe(cwd)
    state.rows.push({ id: rowIds.value++, kind: 'local', text: command, executionTarget: target.kind === 'local' ? target.badge : `${target.badge} · ${target.label}` })
    state.emit()
    const executor = await deps.workspace.commandShell(cwd) ?? ctx.get('shell') as ForegroundShell | undefined
    if (!current()) return
    if (executor === undefined) {
      deps.unavailable('shell')
      return
    }
    let output: string
    try {
      const result = await runForegroundShell(executor, { command, workdir: cwd, timeoutMs: 30000 })
      output = result.stdout.text.trim() || result.stderr.text.trim() || (result.timedOut ? '(timed out)' : '(no output)')
    } catch (error) {
      output = error instanceof Error ? error.message : String(error)
    }
    if (!current()) return
    // One `local-output` row per output line (the same bounded report shape
    // backend command reports use): newlines are the output's structure, not
    // whitespace to flatten into a single preview line.
    const report = cleanCommandReport(output)
    trimLocalRows(state.rows, report.lines.length + Number(report.truncated))
    markChannelReadDirty(state.rows)
    for (const line of report.lines) state.rows.push({ id: rowIds.value++, kind: 'local-output', text: previewIndented(line, 65_536) })
    if (report.truncated) state.rows.push({ id: rowIds.value++, kind: 'local-output', text: t('command-output-truncated') })
    state.emit()
    if (mode === 'stage') {
      // A fresh id per run: repeated commands stack instead of replacing.
      deps.stageContext({ source: 'shell', sourceId: `shell-${randomUUID()}`, title: `$ ${command}`, content: `$ ${command}\n${output}` })
      return
    }
    if (mode === 'send') {
      // This runs detached (`void runLocalCommand`): a session that closed
      // meanwhile (a backend process that exited) must not surface as an
      // unhandled rejection.
      try {
        const result = await capture.session.submit({ text: `<bash-stdout>\n${output}\n</bash-stdout>`, clientMessageId: randomUUID() }, 'followup')
        // A refused submit resolves rather than throwing: without this check
        // the output looks delivered (its rows are in the transcript) while
        // the model never received it.
        if (!result.accepted && current()) {
          notify(t('send-failed', { err: result.reason ?? t('input-not-accepted') }), { color: 'error', timeoutMs: 8000 })
        }
      } catch (error) {
        if (current()) notify(t('send-failed', { err: error instanceof Error ? error.message : String(error) }), { color: 'error', timeoutMs: 8000 })
      }
    }
  }
}

export type CoreLocalActions = ReturnType<typeof createCoreLocalActions>
