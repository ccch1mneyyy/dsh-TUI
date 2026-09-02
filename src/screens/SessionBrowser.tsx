import React from 'react'
import { Box, Text, useInput, useTerminalSize } from '../ui.js'
import type { ContextMenuEvent } from '../ink/events/context-menu-event.js'
import type { WheelEvent } from '../ink/events/wheel-event.js'
import { Divider } from '../components/design-system/Divider.js'
import { HintLine } from '../components/design-system/HintLine.js'
import { SearchBox } from '../components/SearchBox.js'
import { PageInsetContext } from '../components/PageMargin.js'
import { SessionListRow } from '../components/sessions/SessionListRow.js'
import { SessionPreview } from '../components/sessions/SessionPreview.js'
import { WorkspaceListRow } from '../components/sessions/WorkspaceListRow.js'
import { useTerminalFocus } from '../ink/hooks/use-terminal-focus.js'
import { isMod, isPlainReturn, modLabel } from '../utils/modifiers.js'
import { formatProject, projectName, spreadRow, tailWidth, truncateWidth } from '../sessions/format.js'
import { stringWidth } from '../ink/stringWidth.js'
import { TICK, MULTIPLICATION_X } from '../cc/figures.js'
import {
  anchorTop,
  buildView,
  buildWorkspaceGroups,
  DEFAULT_FILTERS,
  moveSelection,
  normalizeWorkspaceCwd,
  seekSelectable,
  sessionAt,
  windowEnd,
  type BrowserFilters,
  type WorkspaceGroup,
} from '../sessions/view.js'
import { t, type I18nKey } from '../i18n.js'
import { readSessionPins, setSessionPinned } from '../sessionPins.js'
import type { Channel } from '../dsh-adapter/channel.js'
import type { PreviewEntry, SessionSummary } from '../dsh-adapter/sessions/index.js'

/** What the browser is doing with the focused row. */
type BrowserMode = 'list' | 'confirm-delete' | 'rename' | 'confirm-clean'
type BrowserLevel = 'sessions' | 'workspaces'
type WorkspaceChoice =
  | { readonly id: 'all'; readonly kind: 'all'; readonly count: number }
  | { readonly id: string; readonly kind: 'workspace'; readonly workspace: WorkspaceGroup }

/**
 * Rows the layout cannot do without: the header, the four-row scope/search
 * card, the notice slot, and the hints. Everything else yields before these.
 */
const REGULAR_MANDATORY_LINES = 7
const COMPACT_MANDATORY_LINES = 5

/**
 * The one remaining horizontal rule, above the hints.
 *
 * The search card's own border separates it from the header and the list, so
 * the two rules that used to flank it are gone; what remains lifts the hints
 * off the content — decoration, and the first thing a short terminal drops.
 */
const RULE_PRIORITY = [2] as const
/** Wide screens keep the working-directory rail visible beside sessions. */
const WORKSPACE_RAIL_MIN_COLUMNS = 120
/** Content width below which preview replaces the session list. */
const SPLIT_MIN_COLUMNS = 100
const WORKSPACE_ROW_HEIGHT = 2

/**
 * The right-click session menu, top to bottom. Index doubles as the
 * keyboard cursor: ↑/↓ move it, Enter activates the highlighted action.
 */
const MENU_ACTIONS = ['open', 'pin', 'rename', 'delete'] as const
type MenuAction = (typeof MENU_ACTIONS)[number]
/** Popup size, border included; clamped to the terminal so it never clips. */
const MENU_WIDTH = 22
const MENU_HEIGHT = MENU_ACTIONS.length + 2
const MENU_LABEL_KEYS = {
  open: 'resume-menu-open',
  rename: 'resume-menu-rename',
  delete: 'resume-menu-delete',
} as const
/** The pin item's label depends on the target's current pin state. */
const menuLabelKey = (action: MenuAction, pinned: boolean): I18nKey =>
  action === 'pin'
    ? (pinned ? 'resume-menu-unpin' : 'resume-menu-pin')
    : MENU_LABEL_KEYS[action]

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
 * - Working-directory scope is visible and selectable. Wide terminals keep a
 *   directory rail beside the sessions; narrow terminals drill into the same
 *   directory list without sacrificing title width.
 * - Search is always live in the active list. There is no mode to enter;
 *   typing filters, because the list is the search results.
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
 * Steady-state listings reuse a revision-keyed digest cache. The rare legacy
 * log whose opening prompt sits beyond the cheap window is scanned
 * progressively and cached, so it recovers a real title without making every
 * browser open pay for full history.
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
  const inset = React.useContext(PageInsetContext)
  const isTerminalFocused = useTerminalFocus()

  const [sessions, setSessions] = React.useState<readonly SessionSummary[]>([])
  const [loaded, setLoaded] = React.useState(false)
  const [filters, setFilters] = React.useState<BrowserFilters>(DEFAULT_FILTERS)
  const [level, setLevel] = React.useState<BrowserLevel>('sessions')
  const [selectedWorkspaceId, setSelectedWorkspaceId] = React.useState('current')
  const [workspaceFocusId, setWorkspaceFocusId] = React.useState('current')
  const [workspaceQuery, setWorkspaceQuery] = React.useState('')
  const [scopeHovered, setScopeHovered] = React.useState(false)
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
  const workspaceTopRef = React.useRef(0)
  const [mode, setMode] = React.useState<BrowserMode>('list')
  const [renameText, setRenameText] = React.useState('')
  /** Hover state for the confirm rows (only one is ever mounted). */
  const [confirmHovered, setConfirmHovered] = React.useState(false)
  // The browser owns the whole screen, so it has to carry its own messages.
  // `channel.notify` renders into the conversation — which is exactly what is
  // NOT on screen right now — so a failed delete, a refused resume, or an
  // unreadable listing would otherwise report itself to a hidden surface and
  // look to the user like nothing happened at all.
  const [notice, setNotice] = React.useState<{ text: string; tone: 'error' | 'info' } | undefined>()
  const [previewOpen, setPreviewOpen] = React.useState(false)
  const [preview, setPreview] = React.useState<readonly PreviewEntry[]>([])
  const [previewLoading, setPreviewLoading] = React.useState(false)
  /**
   * Pinned session ids, from `~/.dsh-tui/session-pins.json`. Pins whose
   * sessions no longer exist are inert: the view filters them against the
   * live listing, and the file is left alone (lazy tolerance — a preference
   * file is not an index and rewrites cost more than stale entries).
   */
  const [pins, setPins] = React.useState<ReadonlySet<string>>(() => readSessionPins())
  // Keep pin toggles synchronous across several keys delivered in one stdin
  // chunk. The state render may lag, but the next command must see the set the
  // previous command successfully persisted.
  const pinsRef = React.useRef(pins)
  pinsRef.current = pins
  /**
   * The right-click session menu: which session it belongs to, where the
   * pointer was (0-indexed screen coords, for anchoring), and which item
   * the keyboard cursor is on. Undefined = no menu.
   */
  const [menu, setMenu] = React.useState<{ sessionId: string; col: number; row: number; item: number } | undefined>(undefined)
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

  const browserContext = React.useMemo(() => ({
    cwd: channel.cwd,
    branch: channel.gitBranch,
    currentId: channel.agentId,
    sameProject,
  }), [channel.cwd, channel.gitBranch, channel.agentId, sameProject])
  const workspaceGroups = React.useMemo(
    () => buildWorkspaceGroups(sessions, browserContext),
    [sessions, browserContext],
  )
  const totalWorkspaceSessions = workspaceGroups.reduce((sum, group) => sum + group.count, 0)
  const workspaceChoices = React.useMemo<readonly WorkspaceChoice[]>(() => {
    return [
      { id: 'all', kind: 'all', count: totalWorkspaceSessions },
      ...workspaceGroups.map((workspace): WorkspaceChoice => ({
        id: workspace.id,
        kind: 'workspace',
        workspace,
      })),
    ]
  }, [workspaceGroups, totalWorkspaceSessions])
  const filteredWorkspaceChoices = React.useMemo(() => {
    const needle = workspaceQuery.trim().toLowerCase()
    if (needle === '') return workspaceChoices
    return workspaceChoices.filter((choice) => {
      if (choice.kind === 'all') {
        return `${t('session-workspace-all')} ${t('session-scope-all')} ${t('session-workspace-all-detail', { n: choice.count })}`
          .toLowerCase()
          .includes(needle)
      }
      const state = choice.workspace.current
        ? t('session-workspace-current')
        : choice.workspace.count === 0
          ? t('session-workspace-empty')
          : ''
      return `${projectName(choice.workspace.cwd)} ${formatProject(choice.workspace.cwd, home)} ${state}`
        .toLowerCase()
        .includes(needle)
    })
  }, [workspaceChoices, workspaceQuery, home])
  const selectedWorkspace = selectedWorkspaceId === 'all'
    ? undefined
    : workspaceGroups.find(group => group.id === selectedWorkspaceId) ?? workspaceGroups[0]

  React.useEffect(() => {
    if (selectedWorkspaceId === 'all' || workspaceGroups.some(group => group.id === selectedWorkspaceId)) return
    setSelectedWorkspaceId('current')
    setWorkspaceFocusId('current')
    setFilters(current => ({ ...current, allProjects: false }))
  }, [selectedWorkspaceId, workspaceGroups])

  const scopeCwd = selectedWorkspace?.cwd ?? channel.cwd
  const scopeSameProject = React.useMemo(
    () => selectedWorkspace?.current !== false
      ? sameProject
      : (left: string, right: string): boolean =>
          normalizeWorkspaceCwd(left) === normalizeWorkspaceCwd(right),
    [selectedWorkspace?.id, selectedWorkspace?.current, sameProject],
  )
  const view = React.useMemo(
    () =>
      buildView(sessions, filters, {
        cwd: scopeCwd,
        branch: channel.gitBranch,
        currentId: channel.agentId,
        sameProject: scopeSameProject,
      }, pins),
    [sessions, filters, scopeCwd, channel.gitBranch, channel.agentId, scopeSameProject, pins],
  )

  // Resolve identity to a position once per render. A cursor whose session is
  // gone — deleted, filtered out, or never there — falls to the first
  // selectable row rather than to nothing, so the list is never unusable.
  const focus = React.useMemo(() => {
    const byId = view.rows.findIndex(row => row.kind === 'session' && row.session.id === focusId)
    return byId >= 0 ? byId : Math.max(0, seekSelectable(view.rows, 0, 1))
  }, [view.rows, focusId])

  const focused = sessionAt(view.rows, focus)
  /** The session the open menu acts on; undefined once it leaves the view. */
  const menuTarget = React.useMemo(() => {
    if (menu === undefined) return undefined
    for (const row of view.rows) {
      if (row.kind === 'session' && row.session.id === menu.sessionId) return row.session
    }
    return undefined
  }, [view.rows, menu])
  // A menu whose session vanished (filtered out, deleted by another path)
  // must not linger invisible but still capture keys.
  React.useEffect(() => {
    if (menu !== undefined && menuTarget === undefined) closeMenu()
  }, [menu, menuTarget])
  const workspaceFocus = React.useMemo(() => {
    const byId = filteredWorkspaceChoices.findIndex(choice => choice.id === workspaceFocusId)
    if (byId >= 0) return byId
    const selected = filteredWorkspaceChoices.findIndex(choice => choice.id === selectedWorkspaceId)
    return Math.max(0, selected)
  }, [filteredWorkspaceChoices, workspaceFocusId, selectedWorkspaceId])
  const focusedWorkspace = filteredWorkspaceChoices[workspaceFocus]

  /**
   * Resume a session (Enter and row-click share this path). The screen closes
   * only once the resume actually happened. Closing first and letting a
   * refusal fall through to a notification would send that explanation to the
   * conversation the user is not looking at, and leave them staring at an
   * unchanged transcript wondering what Enter did. `resumeTo` reports its own
   * reasons; this only has to stay put.
   */
  const resumeSession = (target: NonNullable<typeof focused>): void => {
    runAction(async () => {
      try {
        const result = await channel.resumeTo(target.id)
        if (result.ok) {
          channel.notify(t('resume-resumed'))
          onClose()
        } else {
          if (result.reason === 'cancelled') return
          const text = result.reason === 'working'
            ? t('resume-while-working')
            : result.reason === 'unavailable'
              ? t('resume-unavailable')
              : t('session-resume-failed', { err: result.error })
          setNotice({ text, tone: 'error' })
        }
      } catch (error) {
        setNotice({ text: t('session-resume-failed', { err: message(error) }), tone: 'error' })
      }
    })
  }

  const chooseWorkspace = (choice: WorkspaceChoice): void => {
    if (mode !== 'list' || actionPendingRef.current) return
    closeMenu()
    setSelectedWorkspaceId(choice.id)
    setWorkspaceFocusId(choice.id)
    setFilters(current => ({ ...current, query: '', allProjects: choice.kind === 'all' }))
    setFocusId(undefined)
    setPreviewOpen(false)
    setPreview([])
    topRef.current = 0
    setLevel('sessions')
  }

  const openWorkspaceMenu = (): void => {
    if (mode !== 'list' || actionPendingRef.current) return
    closeMenu()
    setScopeHovered(false)
    setWorkspaceFocusId(selectedWorkspaceId)
    setLevel('workspaces')
  }

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
  const workspaceFocusRef = React.useRef(workspaceFocus)
  workspaceFocusRef.current = workspaceFocus
  const stepWorkspace = (by: 1 | -1, times = 1): void => {
    if (filteredWorkspaceChoices.length === 0) return
    let next = workspaceFocusRef.current
    for (let taken = 0; taken < times; taken++) {
      next = (next + by + filteredWorkspaceChoices.length) % filteredWorkspaceChoices.length
    }
    workspaceFocusRef.current = next
    const landed = filteredWorkspaceChoices[next]
    if (landed !== undefined) setWorkspaceFocusId(landed.id)
  }

  // The menu cursor has the same problem the session cursor has: several
  // keys from one stdin chunk are all handled before React re-renders, so
  // a ↓ then Enter in the same chunk would read the pre-↓ item from the
  // closure. Move the item through a ref, like `step`/`stepWorkspace`.
  const menuRef = React.useRef(menu)
  menuRef.current = menu
  const stepMenuItem = (by: 1 | -1): void => {
    const current = menuRef.current
    if (current === undefined) return
    const next = { ...current, item: (current.item + by + MENU_ACTIONS.length) % MENU_ACTIONS.length }
    menuRef.current = next
    setMenu(next)
  }
  /**
   * Dismiss the context menu. State and ref are cleared TOGETHER: the
   * keyboard branch gates on menuRef, and a mouse dismissal followed by a
   * keystroke in the same stdin chunk must not re-activate the stale menu.
   */
  const closeMenu = (): void => {
    menuRef.current = undefined
    setMenu(undefined)
  }

  const handleSessionWheel = (event: WheelEvent): void => {
    if (mode !== 'list' || actionPendingRef.current) return
    // 菜单开着时滚轮只是关掉菜单，不滚动列表——行是惰性的，滚轮
    // 不该在用户还没看清菜单时把目标行换走。
    if (menu !== undefined) {
      closeMenu()
      return
    }
    setLevel('sessions')
    step(event.deltaY >= 0 ? 1 : -1)
  }
  const handleWorkspaceWheel = (event: WheelEvent): void => {
    if (mode !== 'list' || actionPendingRef.current) return
    if (menu !== undefined) {
      closeMenu()
      return
    }
    setLevel('workspaces')
    stepWorkspace(event.deltaY >= 0 ? 1 : -1)
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

  // Wide terminals keep a directory rail visible. Narrow terminals drill into
  // the same list as a page, so classification stays explicit without leaving
  // too little width for two-line session rows.
  const compactChrome = rows < 10
  const mandatoryLines = compactChrome ? COMPACT_MANDATORY_LINES : REGULAR_MANDATORY_LINES
  const workspaceRail = columns >= WORKSPACE_RAIL_MIN_COLUMNS
  const workspaceWidth = workspaceRail
    ? Math.min(34, Math.max(26, Math.floor(columns * 0.24)))
    : columns
  const workspaceGap = workspaceRail ? 1 : 0
  const sessionAreaWidth = Math.max(20, columns - (workspaceRail ? workspaceWidth + workspaceGap : 0))
  const workspaceAreaVisible = workspaceRail || level === 'workspaces'
  const sessionAreaVisible = workspaceRail || level === 'sessions'
  // Preview joins the session list only when the SESSION area itself is wide;
  // otherwise it replaces that list while the directory rail (if any) remains.
  const canPreview = focused !== undefined
  const splitPreview = previewOpen && canPreview && sessionAreaVisible && sessionAreaWidth >= SPLIT_MIN_COLUMNS
  const soloPreview = previewOpen && canPreview && sessionAreaVisible && !splitPreview
  const previewWidth = splitPreview
    ? Math.min(56, Math.floor(sessionAreaWidth * 0.42))
    : sessionAreaWidth
  const listWidth = Math.max(20, sessionAreaWidth - (splitPreview ? previewWidth : 0))

  // Height is distributed, never assumed. The permanent notice slot prevents
  // mutation/error feedback from shifting the list under the cursor.
  const extraLines = mode === 'list' ? 0 : 1
  // Decoration yields before the first complete two-line selectable row.
  const ruleBudget = Math.max(
    0,
    Math.min(RULE_PRIORITY.length, rows - mandatoryLines - extraLines - WORKSPACE_ROW_HEIGHT),
  )
  const rules = new Set<number>(RULE_PRIORITY.slice(0, ruleBudget))
  const listHeight = Math.max(0, rows - mandatoryLines - extraLines - rules.size)

  const windowTop = anchorTop(view.rows, focus, listHeight, topRef.current)
  topRef.current = windowTop
  const visible = view.rows.slice(windowTop, windowEnd(view.rows, windowTop, listHeight))
  const workspaceCapacity = Math.max(0, Math.floor(listHeight / WORKSPACE_ROW_HEIGHT))
  let workspaceTop = Math.min(
    Math.max(0, workspaceTopRef.current),
    Math.max(0, filteredWorkspaceChoices.length - workspaceCapacity),
  )
  if (workspaceFocus < workspaceTop) workspaceTop = workspaceFocus
  if (workspaceCapacity > 0 && workspaceFocus >= workspaceTop + workspaceCapacity) {
    workspaceTop = workspaceFocus - workspaceCapacity + 1
  }
  workspaceTopRef.current = workspaceTop
  const visibleWorkspaces = workspaceCapacity === 0
    ? []
    : filteredWorkspaceChoices.slice(workspaceTop, workspaceTop + workspaceCapacity)

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

  /** Persist one pin mutation and synchronously adopt the returned full set. */
  const persistPin = (id: string, pinned: boolean): boolean => {
    const result = setSessionPinned(id, pinned)
    if (!result.ok) return false
    pinsRef.current = result.pins
    setPins(result.pins)
    return true
  }

  /**
   * Pin or unpin one session. A pure view preference: no reload needed, the
   * pinned group is derived from the listing already on screen. Persistence
   * failure is visible and never paints a star that will disappear on restart.
   */
  const togglePin = (target: SessionSummary): void => {
    if (mode !== 'list' || actionPendingRef.current) return
    closeMenu()
    const pinning = !pinsRef.current.has(target.id)
    if (!persistPin(target.id, pinning)) {
      report(t('resume-pin-save-failed'), 'error')
      return
    }
    report(t(pinning ? 'resume-pinned' : 'resume-unpinned', { name: target.title.text }), 'info')
  }

  const runDelete = (target: SessionSummary): void =>
    mutate(
      async (): Promise<boolean> => {
        const ok = await channel.deleteSession(target.id)
        // A deleted session's pin must not linger into the next launch's
        // pinned group (where its row would then be silently missing).
        if (ok && pinsRef.current.has(target.id)) {
          // Failure is harmless here: the deleted id is lazily invisible, and
          // a later pin mutation retries from the persisted set.
          persistPin(target.id, false)
        }
        return ok
      },
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

  /**
   * Run the action the menu cursor points at, then close the menu. Shares
   * the keyboard paths: open = Enter, rename = Ctrl+R, delete = Ctrl+D.
   */
  const activateMenu = (target: SessionSummary, item: number): void => {
    closeMenu()
    const action: MenuAction = MENU_ACTIONS[item]
    if (action === 'open') {
      resumeSession(target)
    } else if (action === 'pin') {
      togglePin(target)
    } else if (action === 'rename') {
      setRenameText(target.title.text)
      setMode('rename')
    } else {
      setMode('confirm-delete')
    }
  }

  useInput((input, key) => {
    if (actionPendingRef.current) return
    // A notice describes what the LAST action did; the next keystroke makes it
    // stale, so it goes as soon as the user acts again.
    if (notice !== undefined) setNotice(undefined)
    // The context menu is modal like the confirmations: ↑/↓/Enter drive it,
    // Esc dismisses it, and any other key dismisses it without acting
    // (DOM-menu semantics — a stray keystroke should not also type into the
    // search box behind a menu the user has not dismissed). The gate reads
    // the REF so a right-click and a keystroke in the same stdin chunk (the
    // click handler sets the ref before React renders) behave like the
    // separate chunks they visually are.
    if (menuRef.current !== undefined) {
      if (key.upArrow) {
        stepMenuItem(-1)
      } else if (key.downArrow) {
        stepMenuItem(1)
      } else if (isPlainReturn(key)) {
        const current = menuRef.current
        if (current !== undefined && menuTarget !== undefined) activateMenu(menuTarget, current.item)
      } else {
        closeMenu()
      }
      return
    }
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

    if (level === 'workspaces') {
      if (key.upArrow || key.wheelUp) {
        stepWorkspace(-1)
      } else if (key.downArrow || key.wheelDown) {
        stepWorkspace(1)
      } else if (key.pageUp || key.pageDown) {
        stepWorkspace(key.pageDown ? 1 : -1, Math.max(1, workspaceCapacity))
      } else if (isPlainReturn(key) || key.rightArrow) {
        if (focusedWorkspace !== undefined) chooseWorkspace(focusedWorkspace)
      } else if (key.escape || key.leftArrow) {
        if (workspaceQuery.length > 0) {
          setWorkspaceQuery('')
          workspaceTopRef.current = 0
        } else {
          setLevel('sessions')
        }
      } else if (isMod(key) && input === 'a') {
        const all = workspaceChoices[0]
        if (all !== undefined) chooseWorkspace(all)
      } else if (key.backspace || key.delete) {
        setWorkspaceQuery(query => query.slice(0, -1))
        workspaceTopRef.current = 0
      } else if (!isMod(key) && !key.meta && !key.super && input && !key.return) {
        const typed = input.replace(/\p{Cc}/gu, '')
        if (typed.length > 0) {
          setWorkspaceQuery(query => query + typed)
          workspaceTopRef.current = 0
        }
      }
      return
    }

    if (key.leftArrow) {
      openWorkspaceMenu()
    } else if (key.upArrow) {
      step(-1)
    } else if (key.downArrow) {
      step(1)
    } else if (key.wheelUp) {
      // 滚轮在列表上：与 ↑ 同路径——焦点跟随窗口下移焦点即滚动
      step(-1)
    } else if (key.wheelDown) {
      step(1)
    } else if (key.pageUp || key.pageDown) {
      // A page is "as many rows as the window holds", taken as repeated single
      // steps so it lands on a selectable row like every other move.
      step(key.pageDown ? 1 : -1, Math.max(1, Math.floor(listHeight / 2)))
    } else if (isPlainReturn(key)) {
      if (focused === undefined) return
      resumeSession(focused)
    } else if (key.escape) {
      // Esc backs out one layer at a time: a live query first, the screen
      // second. Closing on the first Esc would discard a search the user is
      // still refining.
      if (filters.query.length > 0) applyFilters(() => ({ query: '' }))
      else if (previewOpen) setPreviewOpen(false)
      else onClose()
    } else if (key.tab) {
      if (focused !== undefined) setPreviewOpen(open => !open)
    } else if (isMod(key) && input === 'a') {
      const target = filters.allProjects
        ? workspaceChoices.find(choice => choice.id === 'current')
        : workspaceChoices[0]
      if (target !== undefined) chooseWorkspace(target)
    } else if (isMod(key) && input === 'b') {
      applyFilters(current => ({ branchOnly: !current.branchOnly }))
    } else if (isMod(key) && input === 's') {
      applyFilters(current => ({ showSubagents: !current.showSubagents }))
    } else if (isMod(key) && input === 'r' && focused !== undefined) {
      setRenameText(focused.title.text)
      setMode('rename')
    } else if (isMod(key) && input === 'p') {
      // Resolve through focusRef, not the render closure: Down + Ctrl+P may
      // arrive in one stdin chunk, and the pin must follow the moved cursor.
      // Plain `p` remains search text like every unbound character.
      const target = sessionAt(view.rows, focusRef.current)
      if (target !== undefined) togglePin(target)
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
  if (level === 'workspaces') {
    counts.push(t('session-workspace-project-count', { n: workspaceGroups.length }))
    counts.push(t('session-count-shown', { n: totalWorkspaceSessions }))
  } else {
    counts.push(t('session-count-shown', { n: view.shown }))
    if (view.hiddenSubagents > 0) counts.push(t('session-count-subagents', { n: view.hiddenSubagents }))
    if (view.emptyCount > 0) counts.push(t('session-count-empty', { n: view.emptyCount }))
  }
  // Every chrome row is pre-measured in terminal cells; flex truncation at an
  // exact fit can otherwise wrap one localized character and shift the footer.
  const heading = ` ↻ ${t('resume-title')}`
  const header = spreadRow(heading, counts.join(' · '), Math.max(0, columns - 1))
  const scope = filters.allProjects
    ? t('session-scope-all')
    : formatProject(selectedWorkspace?.cwd ?? channel.cwd, home)

  // The scope and search share one four-row card (border + two content rows),
  // making directory classification visible without stacking two big panels.
  const inputBudget = Math.max(0, columns - (compactChrome ? 1 : 4))
  const scopeLeft = level === 'workspaces'
    ? `▣ ${t('session-workspace-select-title')}`
    : `▣ ${t('session-workspace-scope')}  ${scope}`
  const scopeRight = level === 'workspaces'
    ? t('session-workspace-project-count', { n: workspaceGroups.length })
    : t('session-workspace-switch')
  const scopeRow = spreadRow(scopeLeft, scopeRight, inputBudget)
  const activeQuery = level === 'workspaces' ? workspaceQuery : filters.query
  const searchPlaceholder = level === 'workspaces'
    ? t('session-workspace-search-placeholder')
    : t('session-search-placeholder', { scope })
  const hint =
    mode === 'confirm-delete' || mode === 'confirm-clean'
      ? fitHint([t('resume-hint-delete')], inputBudget)
      : mode === 'rename'
        ? fitHint([t('resume-hint-rename')], inputBudget)
        : level === 'workspaces'
          ? fitHint(
            [
              t('session-hint-workspaces', { mod: modLabel }),
              t('session-hint-workspaces-short'),
            ],
            inputBudget,
          )
          : fitHint(
            [
              t('session-hint-list', {
                mod: modLabel,
                projects: filters.allProjects ? t('session-toggle-on') : t('session-toggle-off'),
                runs: filters.showSubagents ? t('session-toggle-on') : t('session-toggle-off'),
              }),
              t('session-hint-list-mid', { mod: modLabel }),
              t('session-hint-list-short', { mod: modLabel }),
            ],
            inputBudget,
          )

  return (
    <Box
      flexDirection="column"
      width={columns}
      height={rows}
      onClick={menu !== undefined ? closeMenu : undefined}
    >
      <Box flexShrink={0}>
        <Text color="remember" bold>{header.left}</Text>
        <Text dimColor>{`${' '.repeat(header.gap)}${header.right}`}</Text>
      </Box>
      {/* Directory scope + search are one compact card. The first row is a
          real mouse target, not a hidden keyboard-only filter. */}
      <Box
        flexDirection="column"
        flexShrink={0}
        borderStyle={compactChrome ? undefined : 'round'}
        borderColor={!compactChrome && mode === 'list' ? 'permission' : undefined}
        borderDimColor={!compactChrome && mode !== 'list'}
        paddingX={compactChrome ? 0 : 1}
      >
        <Box
          height={1}
          flexShrink={0}
          overflow="hidden"
          onClick={level === 'sessions' && mode === 'list' ? openWorkspaceMenu : undefined}
          onMouseEnter={level === 'sessions' && mode === 'list' ? () => setScopeHovered(true) : undefined}
          onMouseLeave={level === 'sessions' && mode === 'list' ? () => setScopeHovered(false) : undefined}
          backgroundColor={scopeHovered ? 'userMessageBackgroundHover' : undefined}
        >
          <Text color="remember" bold>{scopeRow.left}</Text>
          <Text dimColor>{`${' '.repeat(scopeRow.gap)}${scopeRow.right}`}</Text>
        </Box>
        <SearchBox
          query={activeQuery}
          isFocused={mode === 'list'}
          isTerminalFocused={isTerminalFocused}
          placeholder={truncateWidth(searchPlaceholder, inputBudget)}
          borderless
          width="100%"
        />
      </Box>

      <ink-box style={{ flexDirection: 'row', gap: workspaceGap, flexGrow: 1, flexShrink: 1, overflow: 'hidden' }}>
        {workspaceAreaVisible && (
          <ink-box
            style={{
              flexDirection: 'column',
              width: workspaceRail ? workspaceWidth : columns,
              height: listHeight,
              flexShrink: 0,
              overflow: 'hidden',
            }}
            onWheel={handleWorkspaceWheel}
          >
            {!loaded && (
              <Text dimColor italic>{` ${truncateWidth(t('session-loading'), workspaceWidth - 2)}`}</Text>
            )}
            {loaded && filteredWorkspaceChoices.length === 0 && (
              <Text dimColor italic>{` ${truncateWidth(t('session-workspace-no-match'), workspaceWidth - 2)}`}</Text>
            )}
            {visibleWorkspaces.map((choice, index) => (
              <WorkspaceListRow
                key={choice.id}
                workspace={choice.kind === 'workspace' ? choice.workspace : undefined}
                all={choice.kind === 'all'}
                totalProjects={workspaceGroups.length}
                totalSessions={totalWorkspaceSessions}
                width={workspaceRail ? workspaceWidth : columns}
                focused={workspaceTop + index === workspaceFocus && level === 'workspaces'}
                selected={choice.id === selectedWorkspaceId}
                home={home}
                now={now}
                onClick={mode === 'list' ? () => chooseWorkspace(choice) : undefined}
              />
            ))}
          </ink-box>
        )}

        {sessionAreaVisible && (
          <ink-box
            style={{
              flexDirection: 'row',
              width: sessionAreaWidth,
              height: listHeight,
              flexShrink: 0,
              overflow: 'hidden',
            }}
            onWheel={handleSessionWheel}
          >
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
                      <Text color="planMode" bold>
                        {truncateWidth(` ▣ ${formatProject(row.project, home)}`, listWidth - 8)}
                      </Text>
                      <Text dimColor>{`  ${row.count}`}</Text>
                    </Box>
                  ) : row.kind === 'pin' ? (
                    <Box key="pin-header" flexShrink={0}>
                      <Text color="remember" bold>
                        {truncateWidth(` ★ ${t('session-pinned-group')}`, listWidth - 8)}
                      </Text>
                      <Text dimColor>{`  ${row.count}`}</Text>
                    </Box>
                  ) : (
                    <SessionListRow
                      key={row.session.id}
                      session={row.session}
                      width={listWidth}
                      depth={row.depth}
                      focused={windowTop + index === focus && level === 'sessions'}
                      pinned={pins.has(row.session.id)}
                      now={now}
                      onClick={mode === 'list' && menu === undefined ? () => {
                        if (actionPendingRef.current) return
                        setLevel('sessions')
                        setFocusId(row.session.id)
                        resumeSession(row.session)
                      } : undefined}
                      onTogglePin={
                        mode === 'list' && menu === undefined && !actionPendingRef.current
                          ? () => {
                              setFocusId(row.session.id)
                              togglePin(row.session)
                            }
                          : undefined
                      }
                      onContextMenu={mode === 'list' ? (event: ContextMenuEvent) => {
                        if (actionPendingRef.current) return
                        setLevel('sessions')
                        setFocusId(row.session.id)
                        // Write the ref alongside the state: the keyboard
                        // gate reads menuRef, so a right-click followed by a
                        // keystroke in the same stdin chunk must see the
                        // menu as open.
                        const next = { sessionId: row.session.id, col: event.col, row: event.row, item: 0 }
                        menuRef.current = next
                        setMenu(next)
                      } : undefined}
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
          </ink-box>
        )}
      </ink-box>

      {/* Permanent notice slot (blank while quiet) with a toast glyph — a
          delete/rename report must never shift the list by arriving. */}
      <Box flexShrink={0}>
        <Text color={notice?.tone === 'error' ? 'error' : 'success'}>
          {notice === undefined
            ? ' '
            : ` ${notice.tone === 'error' ? MULTIPLICATION_X : TICK} ${truncateWidth(notice.text, Math.max(0, columns - 4))}`}
        </Text>
      </Box>
      {mode === 'confirm-delete' && focused !== undefined && (
        <Box
          flexShrink={0}
          onClick={() => {
            // 点击确认行 = 确认删除（与 Enter 同路径）；确认屏本身就是
            // 显式确认层，取消保留键盘 Esc，防误点
            setMode('list')
            runDelete(focused)
          }}
          onMouseEnter={(): void => setConfirmHovered(true)}
          onMouseLeave={(): void => setConfirmHovered(false)}
          backgroundColor={confirmHovered ? 'userMessageBackgroundHover' : undefined}
        >
          <Text color="error">
            {` ${truncateWidth(t('resume-delete-confirm', { name: focused.title.text }), inputBudget)}`}
          </Text>
        </Box>
      )}
      {mode === 'confirm-clean' && (
        <Box
          flexShrink={0}
          onClick={() => {
            setMode('list')
            runClean()
          }}
          onMouseEnter={(): void => setConfirmHovered(true)}
          onMouseLeave={(): void => setConfirmHovered(false)}
          backgroundColor={confirmHovered ? 'userMessageBackgroundHover' : undefined}
        >
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
            // 同搜索卡片：自适应宽度会让窗口化预算跟随内容收缩，
            // 追加字符后预填标题的头部被丢弃。
            width="100%"
          />
        </Box>
      )}

      {rules.has(2) && (<Box flexShrink={0}>
        <Divider bleed />
      </Box>)}
      <Box flexShrink={0}>
        <Text dimColor italic>
          <HintLine text={hint} />
        </Text>
      </Box>

      {/* Right-click session menu: a floating popup anchored one cell past
          the pointer, clamped so it never clips off the terminal. Its own
          clicks hit-test first (absolute hit list), and the root Box's
          onClick dismisses it on any outside click. 指针坐标是屏幕坐标，
          而 absolute 盒相对内容区原点——有 PageMargin 页边距时需补回
          inset（同 TooltipLayer 的补偿规则）。 */}
      {menu !== undefined && menuTarget !== undefined && (
        <Box
          position="absolute"
          left={Math.max(inset.x, Math.min(menu.col + 1, inset.x + Math.max(0, columns - MENU_WIDTH)))}
          top={Math.max(inset.y, Math.min(menu.row + 1, inset.y + Math.max(0, rows - MENU_HEIGHT)))}
          width={MENU_WIDTH}
          height={MENU_HEIGHT}
          flexDirection="column"
          flexShrink={0}
          borderStyle="round"
          borderColor="permission"
          backgroundColor="toolCardBackground"
        >
          {MENU_ACTIONS.map((action, index) => (
            <Box
              key={action}
              height={1}
              flexShrink={0}
              backgroundColor={index === menu.item ? 'userMessageBackgroundHover' : undefined}
              onMouseEnter={(): void => setMenu(m => (m === undefined ? m : { ...m, item: index }))}
              onClick={(): void => {
                if (actionPendingRef.current) return
                activateMenu(menuTarget, index)
              }}
            >
              <Text color={action === 'delete' ? 'error' : undefined}>
                {` ${index === menu.item ? '❯' : ' '} ${t(menuLabelKey(action, pins.has(menuTarget.id)))}`}
              </Text>
            </Box>
          ))}
        </Box>
      )}
    </Box>
  )
}
