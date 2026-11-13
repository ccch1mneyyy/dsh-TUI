import type { Context } from '@deepseek-ai/cordis'
import type { EntrySlot } from './entry-slot.js'

/** What the entry's runtime lends the `dsh-tui` row hand-off (#1651). */
export interface RowAttachmentDeps {
  /** The composition failed or the process is leaving: no row takes over. */
  closed(): boolean
  /** The screen's channel can resume a session. */
  ready(): boolean
  /** Mount the row's seams (presets, ask_user, approvals, the assembly
   *  filters) on its context; they unload with it. */
  mountSeams(rowCtx: Context): Promise<void>
  /** A returning row's config becomes the screen's. */
  readConfig(rowRuntimeConfig: unknown): void
  /** The screen's session ended with the previous row. */
  ended(): boolean
  /** Reopen the ended session; it outlives the row that triggered it. */
  reopen(): Promise<void>
  /** A reattach failed: the screen keeps the ended session. */
  failed(error: unknown): void
}

export interface RowAttachment {
  /** Mount a row's seams; the row counts as mounted until its context unloads. */
  mount(rowCtx: Context): Promise<void>
  /** The `EntrySlot.reattachDsh` hook: undefined while a row is mounted. */
  reattach(): EntrySlot['attachDsh']
}

/** The row seams the entry's DSH side mounts on the first `dsh-tui` row and
 *  again on any row that applies after the previous one unloaded. */
export function createRowAttachment(deps: RowAttachmentDeps): RowAttachment {
  let mounted = false
  const mount = async (rowCtx: Context): Promise<void> => {
    mounted = true
    rowCtx.effect(() => () => { mounted = false })
    await deps.mountSeams(rowCtx)
  }
  const reattach = (): EntrySlot['attachDsh'] => {
    if (deps.closed() || mounted || !deps.ready()) return undefined
    return async (rowCtx, rowRuntimeConfig) => {
      if (deps.closed() || mounted) return
      try {
        // The row may come back with a changed config: read it like the first.
        deps.readConfig(rowRuntimeConfig)
        await mount(rowCtx as Context)
        if (deps.ended()) await deps.reopen()
      } catch (error) {
        deps.failed(error)
      }
    }
  }
  return { mount, reattach }
}
