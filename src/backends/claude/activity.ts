/**
 * The Claude backend's working-activity fold (the counterpart of the DSH
 * `dsh-working-activity` plugin): the translator's own state
 * (`ClaudeActivityState` — nothing is re-parsed here) plus the permission
 * bridges' parked-prompt signal become one working-line value per phase or
 * line change, published through the session's `workingActivity` capability
 * to the same store the DSH projection feed fills.
 *
 * Semantics mirror the plugin's where this backend has the fact:
 *  - a turn works only inside itself — nothing is published before the first
 *    turn, so the classic random-verb spinner keeps its slot unchanged;
 *  - a parked permission/dialog prompt outranks everything (`waiting`: the
 *    model is waiting on you);
 *  - the newest unsettled tool call is the `tool` phase (label = tool name,
 *    detail = the input's most DSH-like short field);
 *  - otherwise `thinking`: the ⏵ self-narration line when the reply
 *    carries one, else the tracked task's `activeForm` (the CLI's own
 *    spinner wording), else a plain localized word;
 *  - turn end parks on the `done` card (kept until the next turn, exactly
 *    like the plugin — the status line shows the summary while idle).
 *
 * `live` is always false on purpose: the value is settled copy (no elapsed
 * text), and the DSH store's live tick re-reads the DSH projection registry —
 * a live foreign value would be cleared by it within one tick. The elapsed
 * and shimmer animations are renderer-side (ActivityLine derives them from
 * the stamps), so nothing is lost.
 *
 * @module dsh-tui/backends/claude/activity
 */
import type { WorkingActivityView } from '../../adapter/ports/channel-view.js'
import { getLang, t } from '../../i18n.js'
import type { Rec } from './narrow.js'
import type { ClaudeActivityState } from './translate.js'

/** Input fields that read like the DSH detail fragment, in priority order. */
const DETAIL_KEYS = ['file_path', 'command', 'pattern', 'url', 'path'] as const

/** The longest detail fragment kept (mirrors the plugin's detail limit). */
const DETAIL_CHARS = 60

/**
 * The input's most DSH-like short field: the first string among
 * file_path / command / pattern / url / path, clipped. Undefined when the
 * input names none of them.
 */
export function activityDetail(input: unknown): string | undefined {
  const record = typeof input === 'object' && input !== null && !Array.isArray(input) ? input as Rec : undefined
  if (record === undefined) return undefined
  for (const key of DETAIL_KEYS) {
    const value = record[key]
    if (typeof value !== 'string' || value === '') continue
    const flat = value.replace(/[\t\r\n]+/gu, ' ').trim()
    if (flat === '') continue
    return flat.length <= DETAIL_CHARS ? flat : flat.slice(0, DETAIL_CHARS) + '…'
  }
  return undefined
}

/** One publisher per session: it dedupes and owns the change feed. */
export interface ClaudeActivityPublisher {
  /** Fold the current state; returns (and announces) the value only when the
   *  phase or the line changed. `undefined` = nothing to publish (yet). */
  fold(state: ClaudeActivityState, waiting: boolean): WorkingActivityView | undefined
  /** The latest published value (the done card persists past the turn). */
  last(): WorkingActivityView | undefined
  /** Subscribe to values; a late subscriber immediately receives `last()`
   *  once (a rebind shows the running line without waiting for a change). */
  subscribe(listener: (view: WorkingActivityView) => void): () => void
}

/** Create one session's publisher. `now` defaults to the wall clock. */
export function createClaudeActivityPublisher(options: { now?: () => number } = {}): ClaudeActivityPublisher {
  const now = options.now ?? Date.now
  const listeners = new Set<(view: WorkingActivityView) => void>()
  let current: WorkingActivityView | undefined

  const view = (
    phase: WorkingActivityView['phase'],
    line: string,
    extra: { readonly label?: string; readonly detail?: string; readonly phrase?: string; readonly toolCount: number },
  ): WorkingActivityView => ({
    phase,
    line,
    live: false,
    ...(extra.label === undefined ? {} : { label: extra.label }),
    ...(extra.detail === undefined ? {} : { detail: extra.detail }),
    ...(extra.phrase === undefined ? {} : { phrase: extra.phrase }),
    toolCount: extra.toolCount,
    phaseStartedAt: 0,
    turnStartedAt: 0,
    updatedAt: 0,
    lang: getLang(),
  })

  return {
    fold(state, waiting) {
      let next: WorkingActivityView | undefined
      if (state.turnOpen) {
        const openTool = state.openTool
        const detail = openTool === undefined ? undefined : activityDetail(openTool.input)
        if (waiting) {
          next = view('waiting', t('claude-activity-waiting'), {
            ...(openTool === undefined ? {} : { label: openTool.name, ...(detail === undefined ? {} : { detail }) }),
            toolCount: state.toolCount,
          })
        } else if (openTool !== undefined) {
          next = view('tool', detail === undefined ? openTool.name : openTool.name + ' ' + detail, {
            label: openTool.name,
            ...(detail === undefined ? {} : { detail }),
            toolCount: state.toolCount,
          })
        } else {
          const phrase = state.narration ?? state.activeForm
          next = view('thinking', phrase ?? t('claude-activity-thinking'), {
            ...(phrase === undefined ? {} : { phrase }),
            toolCount: state.toolCount,
          })
        }
      } else if (current !== undefined) {
        // The turn closed: park on the done card (kept until the next turn,
        // like the plugin — the status line shows it while the session idles).
        next = view('done', state.toolCount > 0 ? t('claude-activity-done-tools', { count: state.toolCount }) : t('claude-activity-done'), { toolCount: state.toolCount })
      }
      if (next === undefined) return undefined
      if (current !== undefined && current.phase === next.phase && current.line === next.line) {
        // No visible change: a toolCount-only drift rides the next real one.
        return undefined
      }
      current = {
        ...next,
        phaseStartedAt: current !== undefined && current.phase === next.phase ? current.phaseStartedAt : now(),
        turnStartedAt: state.turnStartedAt,
        updatedAt: now(),
      }
      for (const listener of [...listeners]) listener(current)
      return current
    },
    last(): WorkingActivityView | undefined {
      return current
    },
    subscribe(listener) {
      listeners.add(listener)
      const last = current
      if (last !== undefined) listener(last)
      return () => { listeners.delete(listener) }
    },
  }
}
