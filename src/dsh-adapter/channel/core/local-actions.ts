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
import { startForegroundShell, type ForegroundShell, type StartedShell } from '../../compat/shell.js'
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

/** One in-flight user shell command and the levers that stop it. */
interface LocalRun {
  readonly controller: AbortController
  /** The started execution, once it exists (see `startForegroundShell`);
   *  its signal is the primary lever, its handle kill the fallback. */
  started?: StartedShell
  /** Set by whoever interrupts the run, before the levers fire: the
   *  result classification trusts this, not the executor's report. */
  interrupted: boolean
}

export function createCoreLocalActions(ctx: ServiceLookup, deps: {
  owner: Pick<ChannelOwner, 'current' | 'own'>
  binding: Pick<ChannelBinding, 'capture' | 'isCurrent' | 'subscribe'>
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
  /** Register a `$cmd` run at invocation: returns its settle lever (the
   *  run's body, or `undefined` for nothing to stage). A submission that
   *  takes the deferred context before the run settles waits for it.
   *  Absent in bare fixtures: completion falls back to `stageContext`. */
  deferShellContext?: (title: string, sourceId: string) => (content: string | undefined) => void
  /** Take a `!!` delivery slot in the input FIFO at invocation: `produce`
   *  resolves with the `<bash-stdout>` message when the run settles, or
   *  `undefined` to deliver nothing. Absent in bare fixtures: completion
   *  falls back to a direct session submit. */
  enqueueProducedOutput?: (produce: () => Promise<string | undefined>, label: string) => void
  /** An input on its way to the session (`!!`): returns its end. */
  beginInput?(): () => void
}) {
  const { owner, binding, state, rowIds, notify } = deps

  /** Every user shell command currently running on this channel. Runs are
   *  unbounded in time (no foreground deadline on a modern shell), so this
   *  registry is also the leak fence: channel disposal and every session
   *  switch interrupt whatever is still in flight. */
  const runs = new Set<LocalRun>()
  const syncRunning = (): void => {
    const running = runs.size > 0
    if (state.localCommandRunning !== running) {
      state.localCommandRunning = running
      state.emit()
    }
  }
  function cancelLocalCommands(): number {
    let count = 0
    for (const run of runs) {
      // A started legacy run cannot be stopped (its shell dropped the
      // signal and has no kill): leave it — and its classification —
      // alone instead of pretending the interrupt landed.
      if (run.started !== undefined && !run.started.interruptible) continue
      run.interrupted = true
      run.controller.abort()
      run.started?.kill()
      count += 1
    }
    return count
  }
  deps.owner.own?.(cancelLocalCommands)
  deps.binding.subscribe?.(cancelLocalCommands)

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
      const run: LocalRun = { controller: new AbortController(), interrupted: false }
      runs.add(run)
      syncRunning()
      // The timing contract, taken at invocation (this call runs
      // synchronously up to the first await inside runLocal, so no other
      // submission can slip between the gesture and its slot): a `!!`
      // delivery reserves its FIFO position now and settles with the run;
      // a `$` registers its deferred context now, so the NEXT submission —
      // whenever it is typed — owns it and waits for the run.
      let settleProduced: ((text: string | undefined) => void) | undefined
      if (mode === 'send' && deps.enqueueProducedOutput !== undefined) {
        let resolve!: (text: string | undefined) => void
        const produced = new Promise<string | undefined>((res) => { resolve = res })
        settleProduced = resolve
        deps.enqueueProducedOutput(() => produced, `!!${command}`)
      }
      const settleStage = mode === 'stage' && deps.deferShellContext !== undefined
        ? deps.deferShellContext(`$ ${command}`, `shell-${randomUUID()}`)
        : undefined
      try {
        await runLocal(command, mode, run, settleProduced, settleStage)
      } finally {
        // Every path that did not settle explicitly (interrupted, session
        // switched, shell unavailable) settles as "nothing": the FIFO slot
        // releases and a waiting submission proceeds without a context.
        settleProduced?.(undefined)
        settleStage?.(undefined)
        runs.delete(run)
        syncRunning()
        end?.()
      }
    },

    /** Interrupt every running user shell command (see the registry
     *  above); returns how many were signalled. */
    cancelLocalCommands,
  }

  async function runLocal(
    command: string,
    mode: LocalCommandMode,
    run: LocalRun,
    settleProduced: ((text: string | undefined) => void) | undefined,
    settleStage: ((content: string | undefined) => void) | undefined,
  ): Promise<void> {
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
    if (run.controller.signal.aborted) {
      // Interrupted before the spawn (a switch/dispose landed while the
      // workspace shell was being resolved): never start the command.
      output = '(interrupted)'
    } else {
      try {
        // A modern (execute) shell runs with no deadline at all: the user
        // stops it with Esc/Ctrl+C (cancelLocalCommands) instead of a
        // hardcoded foreground bound. A legacy run()-only shell cannot
        // carry the signal or the no-deadline request, so it keeps the
        // bounded request it has always had.
        const started = startForegroundShell(executor, typeof executor.execute === 'function'
          ? { command, workdir: cwd, onExpiry: 'none', signal: run.controller.signal }
          : { command, workdir: cwd, timeoutMs: 30000 })
        run.started = started
        const result = await started.result
        const base = result.stdout.text.trim() || result.stderr.text.trim()
        output = run.interrupted || result.aborted === true
          ? (base ? `${base}\n(interrupted)` : '(interrupted)')
          : base || (result.timedOut ? '(timed out)' : '(no output)')
      } catch (error) {
        output = run.interrupted ? '(interrupted)' : error instanceof Error ? error.message : String(error)
      }
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
    // An interrupted command's partial output is shown (above) but never
    // delivered: no staged `$` context, no `!!` followup. (Both settle
    // levers resolve `undefined` in the caller's finally.)
    if (run.interrupted) return
    if (mode === 'stage') {
      if (settleStage !== undefined) {
        settleStage(`$ ${command}\n${output}`)
      } else {
        // A fresh id per run: repeated commands stack instead of replacing.
        deps.stageContext({ source: 'shell', sourceId: `shell-${randomUUID()}`, title: `$ ${command}`, content: `$ ${command}\n${output}` })
      }
      return
    }
    if (mode === 'send') {
      if (settleProduced !== undefined) {
        // The ordered path: the FIFO slot taken at invocation delivers
        // this through the same delivery engine as a typed message.
        settleProduced(`<bash-stdout>\n${output}\n</bash-stdout>`)
        return
      }
      // Bare-fixture fallback (no FIFO wired): submit directly. This runs
      // detached (`void runLocalCommand`): a session that closed meanwhile
      // (a backend process that exited) must not surface as an
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
