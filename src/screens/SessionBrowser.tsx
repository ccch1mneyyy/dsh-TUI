import React from 'react'
import { Box, Text, useInput, useTerminalSize } from '../ui.js'
import { Divider } from '../components/design-system/Divider.js'
import { HintLine } from '../components/design-system/HintLine.js'
import { SearchBox } from '../components/SearchBox.js'
import { SessionListRow } from '../components/sessions/SessionListRow.js'
import { SessionPreview } from '../components/sessions/SessionPreview.js'
import { useTerminalFocus } from '../ink/hooks/use-terminal-focus.js'
import { isMod, isPlainReturn, modLabel } from '../utils/modifiers.js'
import { formatProject, spreadRow, tailWidth, truncateWidth } from '../sessions/format.js'
import { stringWidth } from '../ink/stringWidth.js'
import {
  anchorTop,
  buildView,
  DEFAULT_FILTERS,
  moveSelection,
  seekSelectable,
  sessionAt,
  windowEnd,
  type BrowserFilters,
} from '../sessions/view.js'
import { t } from '../i18n.js'
import type { Channel } from '../dsh-adapter/channel.js'
import type { PreviewEntry, SessionSummary } from '../dsh-adapter/sessions/index.js'

/** What the browser is doing with the focused row. */
type BrowserMode = 'list' | 'confirm-delete' | 'rename' | 'confirm-clean'

/**
 * Rows the layout cannot do without: the header, the search box, the hints.
 * Everything else — the rules, the list itself — yields before these do.
 */
const MANDATORY_LINES = 3

/**
 * The three horizontal rules, in the order they earn their row.
 *
 * 0 frames the header, 2 lifts the hints off the content, 1 separates the
 * search box — and that last one is the least load-bearing, so on a terminal
 * too short for all three it is the one that goes. Rules are decoration; a
 * row of content, or the hint line telling the user which keys exist, is not.
 */
const RULE_PRIORITY = [0, 2, 1] as const
/** Terminal width below which the preview replaces the list instead of joining it. */
const SPLIT_MIN_COLUMNS = 100

/** A thrown value's message, for a notification that has to say something. */
function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Rendered width of a hint: `HintLine` strips the `**` emphasis markers. */
function hintWidth(text: string): number {
  return stringWidth(text.replace(/\*\*/gu, ''))
}

/**
 * The widest hint that fits, cut only when even the shortest will not.
 *
 * A wrapped hint is worse than an abbreviated one in two ways: it eats rows
 * the list needs, and — being the last region on screen — the part that falls
 * off the bottom is its own tail, so the keys nobody can guess are exactly
 * the ones that disappear.
 *
 * @param candidates - Variants from widest to narrowest.
 * @param budget - Columns available to the row.
 */
function fitHint(candidates: readonly string[], budget: number): string {
  for (const candidate of candidates) {
    if (hintWidth(candidate) <= budget) return candidate
  }
  return truncateWidth((candidates[candidates.length - 1] ?? '').replace(/\*\*/gu, ''), budget)
}

/**
 * The session browser — `/resume` as a screen of its own.
 *
 * The old picker was a panel of eight titles and a timestamp, and the reason
 * it could not be more than that was never layout: the data behind it was five
 * fields wide. With every session now arriving classified, sized, dated and
 * attributed, the surface that shows them can do the job a person actually
 * came for — find one conversation among many.
 *
 * What that means concretely:
 *
 * - Search is always live. There is no mode to enter; typing filters, because
 *   the list is the search results.
 * - Delegated sub-agent runs are folded away by default and revealed under
 *   their parents on demand. They are not noise to be deleted — they are the
 *   model's own work, and it is worth being able to open one — but they are
 *   not what "resume a conversation" means, and there are five of them for
 *   every conversation.
 * - Sessions that hold no conversation are never listed, only counted, with
 *   one action to clear them.
 * - The preview shows the end of a session, so "is this the one I was in the
 *   middle of" is answerable without resuming it.
 *
 * Every one of those reads bounded data, so the screen behaves the same on a
 * fifty-session history as on a five-session one.
 */
export function SessionBrowser({
  channel,
  home,
  sameProject,
  onClose,
}: {
  channel: Channel
  /** Home directory, for collapsing project paths to `~`. */
  home: string
  /** Whether a stored cwd belongs to the same project as the live session. */
  sameProject: (a: string, b: string) => boolean
  onClose: () => void
}): React.ReactNode {
  const { columns, rows } = useTerminalSize()
  const isTerminalFocused = useTerminalFocus()

  const [sessions, setSessions] = React.useState<readonly SessionSummary[]>([])
  const [loaded, setLoaded] = React.useState(false)
  const [filters, setFilters] = React.useState<BrowserFilters>(DEFAULT_FILTERS)
  // The cursor is a session ID, not a row index.
  //
  // Rows are reordered by almost everything the browser does: a rename touches
  // MRU and moves its row to the top, a filter rebuilds the list, a delete
  // removes one. An index survives none of those — it keeps pointing at a
  // POSITION, so the cursor silently lands on a different session and the next
  // Enter or ctrl+d acts on the wrong one. Tracking identity makes "the cursor
  // stays on the session you were looking at" true by construction instead of
  // something every mutation has to remember to restore.
  const [focusId, setFocusId] = React.useState<string | undefined>(undefined)
  // The window start is a scroll anchor, not state: it is derived from the
  // focus every render and only ever read back to keep a stationary cursor
  // from re-shuffling the screen. Holding it in state would mean setting
  // state during render to resolve a layout that render already knows.
  const topRef = React.useRef(0)
  const [mode, setMode] = React.useState<BrowserMode>('list')
  const [renameText, setRenameText] = React.useState('')
  // The browser owns the whole screen, so it has to carry its own messages.
  // `channel.notify` renders into the conversation — which is exactly what is
  // NOT on screen right now — so a failed delete, a refused resume, or an
  // unreadable listing would otherwise report itself to a hidden surface and
  // look to the user like nothing happened at all.
  const [notice, setNotice] = React.useState<{ text: string; tone: 'error' | 'info' } | undefined>()
  const [previewOpen, setPreviewOpen] = React.useState(false)
  const [preview, setPreview] = React.useState<readonly PreviewEntry[]>([])
  const [previewLoading, setPreviewLoading] = React.useState(false)
  // React batches every parsed key from one stdin chunk. Lock actions in a
  // ref so a repeated Enter cannot start the same async operation twice
  // before the mode change is rendered.
  const actionPendingRef = React.useRef(false)

  // One clock per render pass: every relative time on screen must agree, and
  // re-reading it per row would let two rows a millisecond apart round to
  // different minutes.
  const now = Date.now()

  /**
   * Say something, on screen and in the transcript.
   *
   * Both, deliberately: the line below the list is what the user can actually
   * read right now, and the transcript entry is what they still have after
   * they leave.
   */
  const report = React.useCallback(
    (text: string, tone: 'error' | 'info'): void => {
      setNotice({ text, tone })
      channel.notify(text, tone === 'error' ? { color: 'error' } : {})
    },
    [channel],
  )

  // Every await below is wrapped. The adapter's own paths are total functions
  // that degrade rather than throw, but this is the UI: a rejection escaping
  // an event handler here becomes an unhandled rejection with the terminal in
  // raw mode and the alternate screen active — the worst possible place to
  // find out a promise was not caught. A failure leaves the browser standing
  // with whatever it already had.
  const reload = React.useCallback(async () => {
    try {
      setSessions(await channel.listSessions())
    } catch (error) {
      report(t('session-list-failed', { err: message(error) }), 'error')
    } finally {
      setLoaded(true)
    }
  }, [channel, report])

  React.useEffect(() => {
    void reload()
  }, [reload])

  const view = React.useMemo(
    () =>
      buildView(sessions, filters, {
        cwd: channel.cwd,
        branch: channel.gitBranch,
        currentId: channel.agentId,
        sameProject,
      }),
    [sessions, filters, channel.cwd, channel.gitBranch, channel.agentId, sameProject],
  )

  // Resolve identity to a position once per render. A cursor whose session is
  // gone — deleted, filtered out, or never there — falls to the first
  // selectable row rather than to nothing, so the list is never unusable.
  const focus = React.useMemo(() => {
    const byId = view.rows.findIndex(row => row.kind === 'session' && row.session.id === focusId)
    return byId >= 0 ? byId : Math.max(0, seekSelectable(view.rows, 0, 1))
  }, [view.rows, focusId])

  const focused = sessionAt(view.rows, focus)

  // Where the cursor is RIGHT NOW, including moves made earlier in this same
  // tick. A held arrow key (or a paste) delivers several key events from one
  // stdin chunk, and every one of them runs before React re-renders — so a
  // handler that read the position from the render closure would compute all
  // of them from the same starting row and keep only the last, silently
  // dropping every move but one.
  const focusRef = React.useRef(focus)
  focusRef.current = focus

  /** Move the cursor by rows, then store the session it landed on. */
  const step = (by: 1 | -1, times = 1): void => {
    let next = focusRef.current
    for (let taken = 0; taken < times; taken++) next = moveSelection(view.rows, next, by)
    focusRef.current = next
    const landed = sessionAt(view.rows, next)
    if (landed !== undefined) setFocusId(landed.id)
  }

  // Preview follows the cursor. Keyed on the id so arrowing past a row does
  // not refetch the one it came from, and guarded on unmount so a slow read
  // landing after the cursor moved cannot overwrite a newer preview.
  React.useEffect(() => {
    if (!previewOpen || focused === undefined) return
    let live = true
    setPreviewLoading(true)
    void channel
      .previewSession(focused.id)
      .then(entries => (live ? entries : undefined))
      .catch(() => (live ? [] : undefined))
      .then((entries) => {
        if (entries === undefined) return
        setPreview(entries)
        setPreviewLoading(false)
      })
    return () => {
      live = false
    }
  }, [channel, previewOpen, focused?.id])

  // Wide terminals put the preview beside the list; narrow ones put it in the
  // list's place. Tab must always visibly do something — a preview that
  // silently declines to appear below some width is a dead key.
  const splitPreview = previewOpen && columns >= SPLIT_MIN_COLUMNS
  const soloPreview = previewOpen && columns < SPLIT_MIN_COLUMNS
  const previewWidth = splitPreview ? Math.min(56, Math.floor(columns * 0.42)) : columns
  const listWidth = Math.max(20, columns - (splitPreview ? previewWidth : 0))
  // Height is distributed, never assumed. Mandatory rows first, then a row
  // for each region the current state actually needs, then the rules while
  // rows remain, and the list gets what is left — which may be nothing.
  //
  // The arithmetic below is the whole vertical layout: the regions sum to
  // exactly `rows` at every height down to MANDATORY_LINES. Anything that
  // assumed a fixed chrome would overflow on a short terminal, and the row
  // that falls off the bottom is always the last one — the hints.
  const extraLines = (mode === 'list' ? 0 : 1) + (notice === undefined ? 0 : 1)
  const ruleBudget = Math.max(0, Math.min(RULE_PRIORITY.length, rows - MANDATORY_LINES - extraLines))
  const rules = new Set<number>(RULE_PRIORITY.slice(0, ruleBudget))
  const listHeight = Math.max(0, rows - MANDATORY_LINES - extraLines - rules.size)

  const windowTop = anchorTop(view.rows, focus, listHeight, topRef.current)
  topRef.current = windowTop
  const visible = view.rows.slice(windowTop, windowEnd(view.rows, windowTop, listHeight))

  /**
   * Change the view.
   *
   * Takes a function of the CURRENT filters rather than a ready-made patch,
   * for the same reason the cursor keeps a ref: several key events can be
   * handled before React re-renders, and a patch built from the render
   * closure would compute each of them from the same starting filters — two
   * toggles in one chunk cancelling to one, or typed characters overwriting
   * each other instead of accumulating.
   */
  const applyFilters = (update: (current: BrowserFilters) => Partial<BrowserFilters>): void => {
    setFilters(current => ({ ...current, ...update(current) }))
    topRef.current = 0
  }

  const runAction = (action: () => Promise<void>): void => {
    if (actionPendingRef.current) return
    actionPendingRef.current = true
    void action().finally(() => {
      actionPendingRef.current = false
    })
  }

  /** Run one mutation, report it, and re-list — reporting a failure either way. */
  const mutate = (
    action: () => Promise<boolean>,
    done: string,
    failed: string,
  ): void => {
    runAction(async () => {
      let ok = false
      let reason: string | undefined
      try {
        ok = await action()
      } catch (error) {
        reason = message(error)
      }
      report(ok ? done : reason === undefined ? failed : `${failed} · ${reason}`, ok ? 'info' : 'error')
      await reload()
    })
  }

  const runDelete = (target: SessionSummary): void =>
    mutate(
      () => channel.deleteSession(target.id),
      t('resume-deleted', { name: target.title.text }),
      t('resume-delete-failed', { name: target.title.text }),
    )

  const runRename = (target: SessionSummary, title: string): void =>
    mutate(
      () => channel.renameSessionTo(target.id, title),
      t('rename-done', { title }),
      t('resume-rename-failed', { name: target.title.text }),
    )

  const runClean = (): void => {
    // Snapshot the ids before any await: the view is rebuilt by the reload
    // below, and deleting from a list that moved under us would be a
    // destructive action aimed at whatever happens to be there now.
    const ids = [...view.emptyIds]
    runAction(async () => {
      let removed = 0
      for (const id of ids) {
        try {
          if (await channel.deleteSession(id)) removed += 1
        } catch {
          // One unremovable log must not abandon the rest of the sweep.
        }
      }
      report(t('session-cleaned', { n: removed }), 'info')
      await reload()
    })
  }

  useInput((input, key) => {
    if (actionPendingRef.current) return
    // A notice describes what the LAST action did; the next keystroke makes it
    // stale, so it goes as soon as the user acts again.
    if (notice !== undefined) setNotice(undefined)
    if (mode === 'confirm-delete') {
      if (isPlainReturn(key)) {
        setMode('list')
        if (focused !== undefined) runDelete(focused)
      } else if (key.escape) {
        setMode('list')
      }
      return
    }
    if (mode === 'confirm-clean') {
      if (isPlainReturn(key)) {
        setMode('list')
        runClean()
      } else if (key.escape) {
        setMode('list')
      }
      return
    }
    if (mode === 'rename') {
      if (isPlainReturn(key)) {
        setMode('list')
        const title = renameText.trim()
        if (focused !== undefined && title.length > 0) runRename(focused, title)
      } else if (key.escape) {
        setMode('list')
      } else if (key.backspace || key.delete) {
        setRenameText(text => text.slice(0, -1))
      } else if (!isMod(key) && !key.meta && input) {
        setRenameText(text => text + input.replace(/[\r\n]+/g, ' '))
      }
      return
    }

    if (key.upArrow) {
      step(-1)
    } else if (key.downArrow) {
      step(1)
    } else if (key.pageUp || key.pageDown) {
      // A page is "as many rows as the window holds", taken as repeated single
      // steps so it lands on a selectable row like every other move.
      step(key.pageDown ? 1 : -1, Math.max(1, Math.floor(listHeight / 2)))
    } else if (isPlainReturn(key)) {
      if (focused === undefined) return
      const target = focused
      // The screen closes only once the resume actually happened. Closing
      // first and letting a refusal fall through to a notification would send
      // that explanation to the conversation the user is not looking at, and
      // leave them staring at an unchanged transcript wondering what Enter
      // did. `resumeTo` reports its own reasons; this only has to stay put.
      runAction(async () => {
        try {
          const ok = await channel.resumeTo(target.id)
          if (ok) {
            channel.notify(t('resume-resumed'))
            onClose()
          } else {
            setNotice({ text: t('session-resume-refused'), tone: 'error' })
          }
        } catch (error) {
          setNotice({ text: t('session-resume-failed', { err: message(error) }), tone: 'error' })
        }
      })
    } else if (key.escape) {
      // Esc backs out one layer at a time: a live query first, the screen
      // second. Closing on the first Esc would discard a search the user is
      // still refining.
      if (filters.query.length > 0) applyFilters(() => ({ query: '' }))
      else onClose()
    } else if (key.tab) {
      setPreviewOpen(open => !open)
    } else if (isMod(key) && input === 'a') {
      applyFilters(current => ({ allProjects: !current.allProjects }))
    } else if (isMod(key) && input === 'b') {
      applyFilters(current => ({ branchOnly: !current.branchOnly }))
    } else if (isMod(key) && input === 's') {
      applyFilters(current => ({ showSubagents: !current.showSubagents }))
    } else if (isMod(key) && input === 'r' && focused !== undefined) {
      setRenameText(focused.title.text)
      setMode('rename')
    } else if (isMod(key) && input === 'd' && focused !== undefined) {
      setMode('confirm-delete')
    } else if (isMod(key) && input === 'x' && view.emptyCount > 0) {
      setMode('confirm-clean')
    } else if (key.backspace || key.delete) {
      applyFilters(current => ({ query: current.query.slice(0, -1) }))
    } else if (!isMod(key) && !key.meta && !key.super && input && !key.return) {
      // Only real characters reach the query. Anything else the terminal
      // delivers — an unbound control byte, a chord this screen does not
      // claim, the newlines inside a paste — would otherwise be typed into
      // the search box invisibly, leaving a filter that matches nothing for
      // no reason the user can see.
      const typed = input.replace(/\p{Cc}/gu, '')
      if (typed.length > 0) applyFilters(current => ({ query: current.query + typed }))
    }
  })

  const counts: string[] = []
  counts.push(t('session-count-shown', { n: view.shown }))
  if (view.hiddenSubagents > 0) counts.push(t('session-count-subagents', { n: view.hiddenSubagents }))
  if (view.emptyCount > 0) counts.push(t('session-count-empty', { n: view.emptyCount }))
  // The header is laid out as one pre-measured row rather than a flex row: at
  // an exact fit, flex truncation eats a character and the row reflows, which
  // pushes every region below it down by one. `spreadRow` owns the column
  // arithmetic and the regression pins its invariant directly.
  const heading = ` ${t('resume-title')}`
  const header = spreadRow(heading, counts.join(' · '), Math.max(0, columns - 1))
  const scope = filters.allProjects
    ? t('session-scope-all')
    : formatProject(channel.cwd, home)

  // One budget for every full-width single-line region: the search box, the
  // confirmations, the rename editor, the notice. Each of them carries text
  // whose length nobody controls — a session title, a filesystem path, an
  // error message — and each of them sits between the list and the hints,
  // where one wrapped row costs the list a line and can push the hints off
  // the bottom of the screen.
  const inputBudget = Math.max(0, columns - 2)
  const hint =
    mode === 'confirm-delete' || mode === 'confirm-clean'
      ? fitHint([t('resume-hint-delete')], inputBudget)
      : mode === 'rename'
        ? fitHint([t('resume-hint-rename')], inputBudget)
        : fitHint(
          [
            t('session-hint-list', {
              mod: modLabel,
              projects: filters.allProjects ? t('session-toggle-on') : t('session-toggle-off'),
              runs: filters.showSubagents ? t('session-toggle-on') : t('session-toggle-off'),
            }),
            t('session-hint-list-mid', { mod: modLabel }),
            t('session-hint-list-short'),
          ],
          inputBudget,
        )

  return (
    <Box flexDirection="column" width={columns} height={rows}>
      <Box flexShrink={0}>
        <Text color="remember" bold>{header.left}</Text>
        <Text dimColor>{`${' '.repeat(header.gap)}${header.right}`}</Text>
      </Box>
      {rules.has(0) && (<Box flexShrink={0}>
        <Divider width={columns} />
      </Box>)}
      <Box flexShrink={0}>
        <SearchBox
          query={tailWidth(filters.query, inputBudget)}
          isFocused={mode === 'list'}
          isTerminalFocused={isTerminalFocused}
          placeholder={truncateWidth(t('session-search-placeholder', { scope }), inputBudget)}
          borderless
        />
      </Box>
      {rules.has(1) && (<Box flexShrink={0}>
        <Divider width={columns} />
      </Box>)}

      <Box flexGrow={1} flexShrink={1}>
        {!soloPreview && (
        <Box flexDirection="column" width={listWidth} height={listHeight} flexShrink={0}>
          {!loaded && (
            <Text dimColor italic>{` ${truncateWidth(t('session-loading'), listWidth - 2)}`}</Text>
          )}
          {loaded && view.rows.length === 0 && (
            <Text dimColor italic>{` ${truncateWidth(t('resume-none-in-cwd'), listWidth - 2)}`}</Text>
          )}
          {visible.map((row, index) =>
            row.kind === 'project' ? (
              <Box key={`project:${row.project}:${index}`} flexShrink={0}>
                <Text color="planMode">
                  {truncateWidth(` ${formatProject(row.project, home)}`, listWidth - 6)}
                </Text>
                <Text dimColor>{`  ${row.count}`}</Text>
              </Box>
            ) : (
              <SessionListRow
                key={row.session.id}
                session={row.session}
                width={listWidth}
                depth={row.depth}
                focused={windowTop + index === focus}
                now={now}
              />
            ),
          )}
        </Box>
        )}
        {(splitPreview || soloPreview) && focused !== undefined && (
          <SessionPreview
            session={focused}
            entries={preview}
            loading={previewLoading}
            width={previewWidth}
            height={listHeight}
            home={home}
            now={now}
          />
        )}
      </Box>

      {notice !== undefined && (
        <Box flexShrink={0}>
          <Text color={notice.tone === 'error' ? 'error' : 'success'}>
            {` ${truncateWidth(notice.text, Math.max(0, columns - 2))}`}
          </Text>
        </Box>
      )}
      {mode === 'confirm-delete' && focused !== undefined && (
        <Box flexShrink={0}>
          <Text color="error">
            {` ${truncateWidth(t('resume-delete-confirm', { name: focused.title.text }), inputBudget)}`}
          </Text>
        </Box>
      )}
      {mode === 'confirm-clean' && (
        <Box flexShrink={0}>
          <Text color="warning">
            {` ${truncateWidth(t('session-clean-confirm', { n: view.emptyCount }), inputBudget)}`}
          </Text>
        </Box>
      )}
      {mode === 'rename' && (
        <Box flexShrink={0}>
          <SearchBox
            query={tailWidth(renameText, inputBudget)}
            isFocused
            isTerminalFocused={isTerminalFocused}
            placeholder={truncateWidth(t('resume-rename-placeholder'), inputBudget)}
            prefix="✎"
            borderless
          />
        </Box>
      )}

      {rules.has(2) && (<Box flexShrink={0}>
        <Divider width={columns} />
      </Box>)}
      <Box flexShrink={0}>
        <Text dimColor italic>
          <HintLine text={hint} />
        </Text>
      </Box>
    </Box>
  )
}
