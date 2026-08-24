/**
 * The session browser as a pi-tui `Component` (plan §1.3, WP-03) — the
 * migration of the old Ink `src/screens/SessionBrowser.tsx`.
 *
 * Root-slot citizen: the screen renders its full content for the width it is
 * given and owns its list windowing itself (`anchorTop`/`windowEnd` over the
 * pure view model in `src/sessions/view.ts` — rows are one or two lines each
 * and the window must keep the focused row fully visible, which is exactly
 * the arithmetic those helpers already do; an outer ScrollView would only
 * double-scroll). Vertical size arrives through `setViewportHeight()` — the
 * chat screen/app shell feeds `ui.terminal.rows` on mount and on resize, so
 * the component itself never touches stdio. Before any hint arrives the
 * screen renders at its natural height (every rule, every row).
 *
 * Data flows in through `update(vm)` pushes of the bounded
 * `SessionsProjection` (controller-owned, fenced; see WP-02). Mutations
 * (delete/rename/clean) go through the `TuiCommands` sink and re-list through
 * it too: `query.listSessions()` is fenced by the sink, so a reload settling
 * after a session swap comes back `undefined` and is dropped. The async
 * preview is double-guarded the same way the old effect was — the sink drops
 * results from a dead session epoch, and the screen drops any result whose
 * session id is no longer the one under the cursor.
 *
 * Outward signals: `onClose` fires only after a resume actually succeeded (a
 * refusal is explained on screen, because the transcript is not visible while
 * this screen is); `onChange`, when the host sets it, fires after every ASYNC
 * state transition (preview settled, mutation reported, reload applied) so
 * the host can `ui.requestRender()`. Key-driven transitions are re-rendered
 * by the TUI's own post-input render and need no signal.
 */
import chalk from 'chalk'
import {
  CURSOR_MARKER,
  Key,
  decodeKittyPrintable,
  matchesKey,
  visibleWidth,
  type Component,
  type PointerEvent,
} from '../public.js'
import type { TuiCommands } from '../commands.js'
import type { SessionsProjection } from '../view-model.js'
import {
  anchorTop,
  buildView,
  DEFAULT_FILTERS,
  moveSelection,
  rowHeight,
  seekSelectable,
  sessionAt,
  windowEnd,
  type BrowserFilters,
  type BrowserRow,
  type BrowserView,
} from '../../sessions/view.js'
import {
  formatBytes,
  formatProject,
  formatWhen,
  kindLabel,
  kindMark,
  spreadRow,
  tailWidth,
  titleColor,
  truncateWidth,
  wrapWidth,
} from '../../sessions/format.js'
import { getActiveTheme, type Theme } from '../../theme.js'
import { paint as paintColor } from '../components/rows/style.js'
import { isMac, modLabel } from '../../utils/modifiers.js'
import { t } from '../../i18n.js'
import type { PreviewEntry, SessionSummary } from '../../dsh-adapter/sessions/types.js'

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

/** Role marker and colour for a preview entry. */
const PREVIEW_ROLE = {
  user: { glyph: '❯', color: 'suggestion' as const },
  assistant: { glyph: '✦', color: 'claude' as const },
}

/** A thrown value's message, for a notification that has to say something. */
function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Rendered width of a hint: the `**` emphasis markers are not printed. */
function hintWidth(text: string): number {
  return visibleWidth(text.replace(/\*\*/gu, ''))
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

interface PaintOptions {
  readonly bold?: boolean
  readonly dim?: boolean
  readonly italic?: boolean
  readonly inverse?: boolean
}

/**
 * Style one segment: chalk for the text modifiers, `paint` for the theme
 * colour (its `rgb(...)`/`ansi:*` values are plain strings, which chalk's
 * own typed API would reject). Colour goes on outermost; chalk re-opens the
 * outer styles after any inner `bold` segment closes.
 */
function paint(theme: Theme, text: string, color?: keyof Theme, options?: PaintOptions): string {
  let out = text
  if (options?.inverse === true) out = chalk.inverse(out)
  if (options?.italic === true) out = chalk.italic(out)
  if (options?.bold === true) out = chalk.bold(out)
  if (options?.dim === true) out = chalk.dim(out)
  if (color !== undefined) out = paintColor(out, theme[color])
  return out
}

/**
 * Text a key event contributes to a field, if any.
 *
 * Kitty CSI-u printable sequences decode to their character; bracketed-paste
 * chunks are unwrapped first (the terminal layer re-wraps pastes in the
 * markers and components see them); a raw chunk is text when it starts on a
 * printable byte. Everything else — escape sequences, control bytes, modifier
 * chords — is not text.
 */
function printableText(data: string): string | undefined {
  const kitty = decodeKittyPrintable(data)
  if (kitty !== undefined) return kitty
  const unwrapped =
    data.includes('\x1b[200~') || data.includes('\x1b[201~')
      ? data.replaceAll('\x1b[200~', '').replaceAll('\x1b[201~', '')
      : data
  return unwrapped.length > 0 && unwrapped.charCodeAt(0) >= 32 ? unwrapped : undefined
}

export interface SessionBrowserScreenDeps {
  readonly commands: TuiCommands
  /** Home directory, for collapsing project paths to `~`. */
  readonly home: string
  /** Whether a stored cwd belongs to the same project as the live session. */
  readonly sameProject: (a: string, b: string) => boolean
  readonly onClose: () => void
}

export class SessionBrowserScreen implements Component {
  /**
   * Focusable contract: the TUI sets this on focus changes. The screen paints
   * its caret (and emits `CURSOR_MARKER` for IME) only while focused.
   * Defaults to true so a host that never manages focus still gets a caret.
   */
  focused = true
  /**
   * Host hook: fired after every async state transition (preview settled,
   * mutation reported, list reloaded) so the host can request a render.
   * Key-driven transitions re-render through the TUI input path instead.
   */
  onChange: (() => void) | undefined

  private readonly commands: TuiCommands
  private readonly home: string
  private readonly sameProject: (a: string, b: string) => boolean
  private readonly onClose: () => void

  private sessions: readonly SessionSummary[] = []
  /**
   * Last sessions array taken from a projection push. A post-mutation reload
   * the screen ran itself leaves the controller's cached projection behind;
   * a re-push of that same array must not clobber the fresher list.
   */
  private projectionSessions: readonly SessionSummary[] | undefined
  private loaded = false
  private cwd = ''
  private gitBranch: string | undefined
  private currentAgentId = ''

  private filters: BrowserFilters = DEFAULT_FILTERS
  /**
   * The cursor is a session ID, not a row index. Rows are reordered by almost
   * everything the browser does — a rename touches MRU, a filter rebuilds the
   * list, a delete removes one — so an index would silently land on a
   * different session after any of them. Tracking identity makes "the cursor
   * stays on the session you were looking at" true by construction.
   */
  private focusId: string | undefined
  /** Resolved position of `focusId` in the current view; kept in sync by
   *  `resolveFocus` on every view rebuild and by `step` on every move, so
   *  several key events from one stdin chunk all read the current position. */
  private focus = 0
  /**
   * Anchors of the fork families the user has opened with →. Held as identity
   * (anchor session id) for the same reason the cursor is: rows reorder under
   * every mutation, the expansion must survive them — reloads included.
   */
  private expandedFamilies: ReadonlySet<string> = new Set<string>()
  /** Scroll anchor: derived from the focus each render and read back to keep
   *  a stationary cursor from re-shuffling the screen. */
  private windowTop = 0
  private mode: BrowserMode = 'list'
  private renameText = ''
  /**
   * The browser owns the whole screen, so it carries its own messages: the
   * command sink's `notify` renders into the conversation — which is exactly
   * what is NOT on screen — so a failed delete or a refused resume also gets
   * this line below the list.
   */
  private notice: { text: string; tone: 'error' | 'info' } | undefined
  private previewOpen = false
  private previewEntries: readonly PreviewEntry[] = []
  private previewLoading = false
  /** Session the current preview entries (or in-flight fetch) belong to. */
  private previewId: string | undefined
  /** Re-entrancy lock: a repeated Enter from one stdin chunk must not start
   *  the same async action twice before its mode change is visible. */
  private actionPending = false
  /** Host-fed viewport height in rows; 0 = unset, render at natural height. */
  private viewportHeight = 0
  private viewCache: BrowserView | undefined
  private viewDirty = true
  /**
   * List geometry of the last render, for pointer hit-testing: the region's
   * line offset within the render output, the list's column width (a split
   * preview owns the columns beyond it), and one span per visible row —
   * `rowIndex` is the row's ABSOLUTE index in the current view, so a click
   * resolves the session by identity, never by a stale position.
   */
  private pointerRegionStart = 0
  private pointerListWidth = 0
  private pointerSplit = false
  private pointerRows: ReadonlyArray<{ start: number; end: number; rowIndex: number }> = []

  constructor(deps: SessionBrowserScreenDeps) {
    this.commands = deps.commands
    this.home = deps.home
    this.sameProject = deps.sameProject
    this.onClose = deps.onClose
  }

  /**
   * Rows this screen wants for a terminal of `terminalRows`: all of them —
   * the browser fills the screen it is given, as the old alt-screen version
   * did. The host feeds the value back through `setViewportHeight`.
   */
  static desiredHeight(terminalRows: number): number {
    return Math.max(0, Math.floor(terminalRows))
  }

  /** Host height hint (terminal rows); re-applied on every resize. */
  setViewportHeight(rows: number): void {
    this.viewportHeight = SessionBrowserScreen.desiredHeight(rows)
  }

  /**
   * Push the newest sessions projection. Context fields are always applied;
   * the sessions array only when the controller actually produced a new one
   * (see {@link projectionSessions}). The first push ends the loading state.
   */
  update(vm: SessionsProjection): void {
    this.cwd = vm.cwd
    this.gitBranch = vm.gitBranch
    this.currentAgentId = vm.currentAgentId
    if (vm.sessions !== this.projectionSessions) {
      this.projectionSessions = vm.sessions
      this.sessions = vm.sessions
      this.loaded = true
    }
    this.viewDirty = true
    this.syncPreview()
  }

  invalidate(): void {
    // Colours are resolved per render, so only the view cache can go stale.
    this.viewDirty = true
  }

  handleInput(data: string): void {
    if (this.actionPending) return
    // A notice describes what the LAST action did; the next keystroke makes
    // it stale, so it goes as soon as the user acts again.
    this.notice = undefined

    const view = this.getView()
    const focused = sessionAt(view.rows, this.focus)

    if (this.mode === 'confirm-delete') {
      if (matchesKey(data, Key.enter)) {
        this.mode = 'list'
        if (focused !== undefined) this.runDelete(focused)
      } else if (matchesKey(data, Key.escape)) {
        this.mode = 'list'
      }
      return
    }
    if (this.mode === 'confirm-clean') {
      if (matchesKey(data, Key.enter)) {
        this.mode = 'list'
        this.runClean()
      } else if (matchesKey(data, Key.escape)) {
        this.mode = 'list'
      }
      return
    }
    if (this.mode === 'rename') {
      if (matchesKey(data, Key.enter)) {
        this.mode = 'list'
        const title = this.renameText.trim()
        if (focused !== undefined && title.length > 0) this.runRename(focused, title)
      } else if (matchesKey(data, Key.escape)) {
        this.mode = 'list'
      } else if (matchesKey(data, Key.backspace) || matchesKey(data, Key.delete)) {
        this.renameText = this.renameText.slice(0, -1)
      } else {
        const text = printableText(data)
        if (text !== undefined) this.renameText += text.replace(/[\r\n]+/g, ' ')
      }
      return
    }

    if (matchesKey(data, Key.up)) {
      this.step(-1)
    } else if (matchesKey(data, Key.down)) {
      this.step(1)
    } else if (matchesKey(data, Key.pageUp) || matchesKey(data, Key.pageDown)) {
      // A page is "as many rows as half the window holds", taken as repeated
      // single steps so it lands on a selectable row like every other move.
      const halfWindow = Math.max(1, Math.floor(this.layoutMetrics().listHeight / 2))
      this.step(matchesKey(data, Key.pageDown) ? 1 : -1, halfWindow)
    } else if (matchesKey(data, Key.right) || matchesKey(data, Key.left)) {
      // Fork-family folding. → opens the folded family under the cursor; ←
      // closes it — from anywhere inside it, so a member row's ← lands the
      // cursor on the family's row rather than on a row that just folded away.
      const row = view.rows[this.focus]
      const family = row?.kind === 'session' ? row.family : undefined
      if (family !== undefined) {
        if (matchesKey(data, Key.right) && family.role === 'rep' && !family.expanded && family.size > 1) {
          this.expandedFamilies = new Set(this.expandedFamilies).add(family.anchor)
          this.viewDirty = true
        } else if (matchesKey(data, Key.left) && (family.role === 'member' || family.expanded)) {
          const next = new Set(this.expandedFamilies)
          next.delete(family.anchor)
          this.expandedFamilies = next
          this.viewDirty = true
          if (family.role === 'member') {
            this.focusId = family.rep
            // Rows above the family are untouched by the fold, so the rep's
            // index in the current rows is its index after it too.
            const repIndex = view.rows.findIndex((r) => r.kind === 'session' && r.session.id === family.rep)
            if (repIndex >= 0) this.focus = repIndex
          }
        }
      }
    } else if (matchesKey(data, Key.enter)) {
      if (focused !== undefined) this.runResume(focused)
    } else if (matchesKey(data, Key.escape)) {
      // Esc backs out one layer at a time: a live query first, the screen
      // second. Closing on the first Esc would discard a search the user is
      // still refining.
      if (this.filters.query.length > 0) this.applyFilters(() => ({ query: '' }))
      else this.onClose()
    } else if (matchesKey(data, Key.tab)) {
      this.previewOpen = !this.previewOpen
      if (!this.previewOpen) {
        // Reopening refetches, as the old effect did; an in-flight result for
        // the closed pane is dropped by the id guard in syncPreview.
        this.previewId = undefined
        this.previewLoading = false
      }
    } else if (this.isModKey(data, 'a')) {
      this.applyFilters((current) => ({ allProjects: !current.allProjects }))
    } else if (this.isModKey(data, 'b')) {
      this.applyFilters((current) => ({ branchOnly: !current.branchOnly }))
    } else if (this.isModKey(data, 's')) {
      this.applyFilters((current) => ({ showSubagents: !current.showSubagents }))
    } else if (this.isModKey(data, 'r') && focused !== undefined) {
      this.renameText = focused.title.text
      this.mode = 'rename'
    } else if (this.isModKey(data, 'd') && focused !== undefined) {
      this.mode = 'confirm-delete'
    } else if (this.isModKey(data, 'x') && view.emptyCount > 0) {
      this.mode = 'confirm-clean'
    } else if (matchesKey(data, Key.backspace) || matchesKey(data, Key.delete)) {
      this.applyFilters((current) => ({ query: current.query.slice(0, -1) }))
    } else {
      // Only real characters reach the query. Anything else the terminal
      // delivers — an unbound control byte, a chord this screen does not
      // claim, the newlines inside a paste — would otherwise be typed into
      // the search box invisibly, leaving a filter that matches nothing for
      // no reason the user can see.
      const text = printableText(data)
      if (text !== undefined) {
        const typed = text.replace(/\p{Cc}/gu, '')
        if (typed.length > 0) this.applyFilters((current) => ({ query: current.query + typed }))
      }
    }
    this.syncPreview()
  }

  /**
   * Pointer parity (research §4.3): a primary-button click on a session row
   * focuses it BY SESSION ID and resumes it — the keyboard Enter on that row
   * (a refusal stays on screen, same as Enter). The high-risk actions keep
   * their keyboard seats: delete/rename/clean are only reachable through
   * ctrl+d/ctrl+r/ctrl+x and their confirm/input rows, and while one of those
   * modes is open every click is consumed without acting. A wheel event steps
   * the cursor like ↑/↓ (moveSelection clamps at the ends; the window and the
   * preview follow). Clicks anywhere else — project headers, the preview
   * pane, the search box, blank rows — are consumed without acting.
   * press/release/move stay unconsumed so drag-selection copy keeps working
   * on the list; a drag never produces a click, so it never resumes.
   */
  handlePointer(event: PointerEvent): boolean | void {
    if (event.type === 'click') {
      if (event.button !== 0) return true
      if (this.mode !== 'list' || this.actionPending) return true
      if (this.pointerSplit && event.localX >= this.pointerListWidth) return true
      const local = event.localY - this.pointerRegionStart
      const hit = this.pointerRows.find((row) => local >= row.start && local < row.end)
      if (hit === undefined) return true
      const view = this.getView()
      const row = view.rows[hit.rowIndex]
      if (row?.kind !== 'session') return true
      this.notice = undefined
      this.focus = hit.rowIndex
      this.focusId = row.session.id
      this.runResume(row.session)
      return true
    }
    if (event.type === 'wheel') {
      if (event.deltaY === 0) return true
      if (this.mode !== 'list' || this.actionPending) return true
      this.step(event.deltaY > 0 ? 1 : -1)
      this.syncPreview()
      return true
    }
    return undefined
  }

  render(width: number): string[] {
    // One clock per render pass: every relative time on screen must agree.
    const now = Date.now()
    const theme = getActiveTheme()
    const view = this.getView()
    const focus = this.focus
    const focusedSession = sessionAt(view.rows, focus)
    const { rules, listHeight } = this.layoutMetrics()

    // Wide terminals put the preview beside the list; narrow ones put it in
    // the list's place. Tab must always visibly do something — a preview that
    // silently declines to appear below some width is a dead key.
    const splitPreview = this.previewOpen && width >= SPLIT_MIN_COLUMNS
    const soloPreview = this.previewOpen && width < SPLIT_MIN_COLUMNS
    const previewWidth = splitPreview ? Math.min(56, Math.floor(width * 0.42)) : width
    const listWidth = Math.max(20, width - (splitPreview ? previewWidth : 0))
    /** One budget for every full-width single-line region: the search box,
     *  the confirmations, the rename editor, the notice. */
    const inputBudget = Math.max(0, width - 2)

    const lines: string[] = []

    const counts: string[] = [t('session-count-shown', { n: view.shown })]
    if (view.hiddenSubagents > 0) counts.push(t('session-count-subagents', { n: view.hiddenSubagents }))
    if (view.emptyCount > 0) counts.push(t('session-count-empty', { n: view.emptyCount }))
    // The header is one pre-measured row: `spreadRow` owns the column
    // arithmetic (CJK-safe) and guarantees the row never exceeds its budget.
    const header = spreadRow(` ${t('resume-title')}`, counts.join(' · '), Math.max(0, width - 1))
    lines.push(
      `${paint(theme, header.left, 'remember', { bold: true })}${' '.repeat(header.gap)}${paint(theme, header.right, undefined, { dim: true })}`,
    )
    if (rules.has(0)) lines.push(this.renderDivider(theme, width))
    const scope = this.filters.allProjects ? t('session-scope-all') : formatProject(this.cwd, this.home)
    lines.push(
      this.renderInputRow(theme, {
        prefix: '⌕',
        text: this.filters.query,
        placeholder: t('session-search-placeholder', { scope }),
        showCaret: this.focused && this.mode === 'list',
        width,
      }),
    )
    if (rules.has(1)) lines.push(this.renderDivider(theme, width))

    this.pointerRegionStart = lines.length
    lines.push(...this.renderRegion(theme, view, focus, focusedSession, listWidth, previewWidth, listHeight, splitPreview, soloPreview, now))

    if (this.notice !== undefined) {
      lines.push(
        paint(
          theme,
          ` ${truncateWidth(this.notice.text, inputBudget)}`,
          this.notice.tone === 'error' ? 'error' : 'success',
        ),
      )
    }
    if (this.mode === 'confirm-delete' && focusedSession !== undefined) {
      lines.push(
        paint(theme, ` ${truncateWidth(t('resume-delete-confirm', { name: focusedSession.title.text }), inputBudget)}`, 'error'),
      )
    }
    if (this.mode === 'confirm-clean') {
      lines.push(
        paint(theme, ` ${truncateWidth(t('session-clean-confirm', { n: view.emptyCount }), inputBudget)}`, 'warning'),
      )
    }
    if (this.mode === 'rename') {
      lines.push(
        this.renderInputRow(theme, {
          prefix: '✎',
          text: this.renameText,
          placeholder: t('resume-rename-placeholder'),
          showCaret: this.focused,
          width,
        }),
      )
    }

    if (rules.has(2)) lines.push(this.renderDivider(theme, width))
    lines.push(this.renderHint(theme, inputBudget))

    // The regions above sum to exactly `viewportHeight` by construction; a
    // suppressed row (a confirm without a target) is the only way to fall
    // short, and the screen still owes the host a full-height frame.
    if (this.viewportHeight > 0) {
      while (lines.length < this.viewportHeight) lines.push('')
    }
    return lines
  }

  // -------------------------------------------------------------------------
  // Input helpers
  // -------------------------------------------------------------------------

  /** Mod+<letter>: Ctrl everywhere, plus Super on macOS (mirrors `isMod`). */
  private isModKey(data: string, letter: 'a' | 'b' | 's' | 'r' | 'd' | 'x'): boolean {
    return matchesKey(data, Key.ctrl(letter)) || (isMac && matchesKey(data, Key.super(letter)))
  }

  /** Move the cursor by rows, then store the session it landed on. */
  private step(by: 1 | -1, times = 1): void {
    const view = this.getView()
    let next = this.focus
    for (let taken = 0; taken < times; taken++) next = moveSelection(view.rows, next, by)
    this.focus = next
    const landed = sessionAt(view.rows, next)
    if (landed !== undefined) this.focusId = landed.id
  }

  /**
   * Change the view from the CURRENT filters and restart the scroll anchor.
   * Class fields make the "current value" semantics the old functional
   * setState guarded against: several key events from one stdin chunk each
   * see the previous one's patch.
   */
  private applyFilters(update: (current: BrowserFilters) => Partial<BrowserFilters>): void {
    this.filters = { ...this.filters, ...update(this.filters) }
    this.viewDirty = true
    this.windowTop = 0
  }

  // -------------------------------------------------------------------------
  // Async actions (all behind the re-entrancy lock)
  // -------------------------------------------------------------------------

  private runAction(action: () => Promise<void>): void {
    if (this.actionPending) return
    this.actionPending = true
    void action().finally(() => {
      this.actionPending = false
    })
  }

  /** Say something on screen and in the transcript — both, deliberately: the
   *  line below the list is what the user can read right now, the transcript
   *  entry is what they still have after they leave. */
  private report(text: string, tone: 'error' | 'info'): void {
    this.notice = { text, tone }
    this.commands.info.notify(text, tone === 'error' ? { color: 'error' } : {})
  }

  /** Run one mutation, report it, and re-list — reporting a failure either way. */
  private mutate(action: () => Promise<boolean>, done: string, failed: string): void {
    this.runAction(async () => {
      let ok = false
      let reason: string | undefined
      try {
        ok = await action()
      } catch (error) {
        reason = message(error)
      }
      this.report(ok ? done : reason === undefined ? failed : `${failed} · ${reason}`, ok ? 'info' : 'error')
      await this.reload()
    })
  }

  private runDelete(target: SessionSummary): void {
    this.mutate(
      () => this.commands.session.deleteSession(target.id),
      t('resume-deleted', { name: target.title.text }),
      t('resume-delete-failed', { name: target.title.text }),
    )
  }

  private runRename(target: SessionSummary, title: string): void {
    this.mutate(
      () => this.commands.session.renameSessionTo(target.id, title),
      t('rename-done', { title }),
      t('resume-rename-failed', { name: target.title.text }),
    )
  }

  private runClean(): void {
    // Snapshot the ids before any await: the view is rebuilt by the reload
    // below, and deleting from a list that moved under us would be a
    // destructive action aimed at whatever happens to be there now.
    const ids = [...this.getView().emptyIds]
    this.runAction(async () => {
      let removed = 0
      for (const id of ids) {
        try {
          if (await this.commands.session.deleteSession(id)) removed += 1
        } catch {
          // One unremovable log must not abandon the rest of the sweep.
        }
      }
      this.report(t('session-cleaned', { n: removed }), 'info')
      await this.reload()
    })
  }

  private runResume(target: SessionSummary): void {
    // The screen closes only once the resume actually happened. Closing first
    // and letting a refusal fall through to a notification would send that
    // explanation to the conversation the user is not looking at, and leave
    // them staring at an unchanged transcript wondering what Enter did.
    // `resumeTo` reports its own reasons; this only has to stay put.
    this.runAction(async () => {
      try {
        const result = await this.commands.session.resumeTo(target.id)
        if (result.ok) {
          this.commands.info.notify(t('resume-resumed'))
          this.onClose()
          return
        }
        if (result.reason === 'cancelled') return
        const text =
          result.reason === 'working'
            ? t('resume-while-working')
            : result.reason === 'unavailable'
              ? t('resume-unavailable')
              : t('session-resume-failed', { err: result.error })
        this.notice = { text, tone: 'error' }
      } catch (error) {
        this.notice = { text: t('session-resume-failed', { err: message(error) }), tone: 'error' }
      }
      this.onChange?.()
    })
  }

  /**
   * Re-list after a mutation, through the sink's fence: a reload settling
   * after a session/agent swap comes back `undefined` and leaves the browser
   * standing with whatever it already had (the screen is about to be torn
   * down anyway).
   */
  private async reload(): Promise<void> {
    try {
      const sessions = await this.commands.query.listSessions()
      if (sessions !== undefined) {
        this.sessions = sessions
        this.viewDirty = true
      }
    } catch (error) {
      this.report(t('session-list-failed', { err: message(error) }), 'error')
    } finally {
      this.loaded = true
    }
    this.syncPreview()
    this.onChange?.()
  }

  /**
   * Fetch the preview for the session under the cursor when it is not the one
   * already loaded/loading. The sink's fence drops results from a dead
   * session epoch; the id guard drops results for a cursor that has moved on
   * or a pane that was closed meanwhile.
   */
  private syncPreview(): void {
    if (!this.previewOpen) return
    const focused = sessionAt(this.getView().rows, this.focus)
    if (focused === undefined || focused.id === this.previewId) return
    const id = focused.id
    this.previewId = id
    this.previewLoading = true
    void this.commands.query.previewSession(id).then(
      (entries) => {
        if (entries === undefined) return
        if (!this.previewOpen || this.previewId !== id) return
        this.previewEntries = entries
        this.previewLoading = false
        this.onChange?.()
      },
      () => {
        if (!this.previewOpen || this.previewId !== id) return
        this.previewEntries = []
        this.previewLoading = false
        this.onChange?.()
      },
    )
  }

  // -------------------------------------------------------------------------
  // View model and layout
  // -------------------------------------------------------------------------

  /** The current rows; rebuilt lazily after any input to `buildView` moved. */
  private getView(): BrowserView {
    if (this.viewCache === undefined || this.viewDirty) {
      this.viewCache = buildView(this.sessions, this.filters, {
        cwd: this.cwd,
        branch: this.gitBranch,
        currentId: this.currentAgentId,
        sameProject: this.sameProject,
      }, this.expandedFamilies)
      this.viewDirty = false
      this.resolveFocus(this.viewCache)
    }
    return this.viewCache
  }

  /**
   * Resolve identity to a position once per view build. A cursor whose
   * session is gone — deleted, filtered out, or never there — falls to the
   * first selectable row rather than to nothing, so the list is never
   * unusable. `focusId` itself is left alone until a move lands.
   */
  private resolveFocus(view: BrowserView): void {
    const byId = view.rows.findIndex((row) => row.kind === 'session' && row.session.id === this.focusId)
    this.focus = byId >= 0 ? byId : Math.max(0, seekSelectable(view.rows, 0, 1))
  }

  /**
   * The vertical layout, in one place: mandatory rows first, then a row for
   * each region the current state actually needs, then the rules while rows
   * remain, and the list gets what is left — which may be nothing. With no
   * host height hint the screen renders at its natural height instead.
   */
  private layoutMetrics(): { rules: ReadonlySet<number>; listHeight: number } {
    const extraLines = (this.mode === 'list' ? 0 : 1) + (this.notice === undefined ? 0 : 1)
    if (this.viewportHeight <= 0) {
      let natural = 0
      for (const row of this.getView().rows) natural += rowHeight(row)
      return { rules: new Set(RULE_PRIORITY), listHeight: Math.max(natural, 1) }
    }
    const ruleBudget = Math.max(0, Math.min(RULE_PRIORITY.length, this.viewportHeight - MANDATORY_LINES - extraLines))
    const rules = new Set<number>(RULE_PRIORITY.slice(0, ruleBudget))
    const listHeight = Math.max(0, this.viewportHeight - MANDATORY_LINES - extraLines - rules.size)
    return { rules, listHeight }
  }

  // -------------------------------------------------------------------------
  // Region renderers
  // -------------------------------------------------------------------------

  private renderDivider(theme: Theme, width: number): string {
    return paint(theme, '─'.repeat(Math.max(0, width)), undefined, { dim: true })
  }

  /**
   * One single-line input row (the `⌕` search box, the `✎` rename editor):
   * prefix, the text windowed to its tail (the caret lives at the end), and —
   * while focused — an inverse block caret with `CURSOR_MARKER` on its cell
   * so the terminal-painted IME preedit lands on the input. Unfocused rows
   * render the same content dimmed, with the placeholder standing in for an
   * empty text.
   */
  private renderInputRow(
    theme: Theme,
    opts: { prefix: string; text: string; placeholder: string; showCaret: boolean; width: number },
  ): string {
    const prefixText = `${opts.prefix} `
    const budget = Math.max(0, opts.width - 2 - visibleWidth(prefixText))
    if (!opts.showCaret) {
      const content = opts.text.length > 0 ? tailWidth(opts.text, budget) : truncateWidth(opts.placeholder, budget)
      return paint(theme, `${prefixText}${content}`, undefined, { dim: true })
    }
    const caret = `${CURSOR_MARKER}${paint(theme, ' ', undefined, { inverse: true })}`
    if (opts.text.length > 0) return `${prefixText}${tailWidth(opts.text, budget)}${caret}`
    // Empty and focused: caret at the start, placeholder right-aligned (dimmed)
    // — kept off the caret's cell so IME preedit can never be overlaid on it.
    const placeholder = truncateWidth(opts.placeholder, Math.max(0, opts.width - visibleWidth(prefixText) - 1))
    const gap = Math.max(0, opts.width - visibleWidth(prefixText) - 1 - visibleWidth(placeholder))
    return `${prefixText}${caret}${' '.repeat(gap)}${paint(theme, placeholder, undefined, { dim: true })}`
  }

  /** The middle region: the windowed list, optionally joined or replaced by
   *  the preview pane; always exactly `listHeight` lines. */
  private renderRegion(
    theme: Theme,
    view: BrowserView,
    focus: number,
    focusedSession: SessionSummary | undefined,
    listWidth: number,
    previewWidth: number,
    listHeight: number,
    splitPreview: boolean,
    soloPreview: boolean,
    now: number,
  ): string[] {
    if (soloPreview) {
      this.pointerRows = []
      this.pointerSplit = false
      this.pointerListWidth = 0
      return focusedSession === undefined
        ? Array.from({ length: listHeight }, () => '')
        : this.renderPreviewLines(theme, focusedSession, previewWidth, listHeight, now)
    }

    const windowTop = anchorTop(view.rows, focus, listHeight, this.windowTop)
    this.windowTop = windowTop
    const visibleRows = view.rows.slice(windowTop, windowEnd(view.rows, windowTop, listHeight))
    this.pointerSplit = splitPreview
    this.pointerListWidth = listWidth
    const pointerRows: Array<{ start: number; end: number; rowIndex: number }> = []
    const listLines: string[] = []
    if (!this.loaded) {
      listLines.push(paint(theme, ` ${truncateWidth(t('session-loading'), Math.max(0, listWidth - 2))}`, undefined, { dim: true, italic: true }))
    } else if (view.rows.length === 0) {
      listLines.push(paint(theme, ` ${truncateWidth(t('resume-none-in-cwd'), Math.max(0, listWidth - 2))}`, undefined, { dim: true, italic: true }))
    }
    visibleRows.forEach((row, index) => {
      const rowStart = listLines.length
      if (row.kind === 'project') {
        listLines.push(
          `${paint(theme, truncateWidth(` ${formatProject(row.project, this.home)}`, Math.max(0, listWidth - 6)), 'planMode')}${paint(theme, `  ${row.count}`, undefined, { dim: true })}`,
        )
      } else {
        listLines.push(...this.renderSessionRow(theme, row.session, row.depth, windowTop + index === focus, listWidth, now, row.family))
      }
      pointerRows.push({ start: rowStart, end: listLines.length, rowIndex: windowTop + index })
    })
    this.pointerRows = pointerRows
    const clipped = listLines.slice(0, Math.max(0, listHeight))
    while (clipped.length < listHeight) clipped.push('')

    if (!splitPreview || focusedSession === undefined) return clipped
    // Side-by-side: the list keeps its width, the preview takes the rest;
    // both regions are exactly `listHeight` tall, so they zip line by line.
    const previewLines = this.renderPreviewLines(theme, focusedSession, previewWidth, listHeight, now)
    return clipped.map(
      (line, index) => `${line}${' '.repeat(Math.max(0, listWidth - visibleWidth(line)))}${previewLines[index] ?? ''}`,
    )
  }

  /**
   * One session in the list: a title line and a metadata line. Two lines
   * rather than one because the two carry different jobs — the title answers
   * "is this the conversation I mean", the metadata "which of the three that
   * look alike is it". Widths are resolved arithmetically: the row must stay
   * exactly two lines at every terminal width.
   */
  private renderSessionRow(
    theme: Theme,
    session: SessionSummary,
    depth: number,
    focusedRow: boolean,
    width: number,
    now: number,
    family?: Extract<BrowserRow, { kind: 'session' }>['family'],
  ): string[] {
    const indent = depth * 2
    // Two cells for the focus marker, plus the indent for a nested run.
    const body = Math.max(8, width - 2 - indent)
    const mark = kindMark(session.kind)
    // A folded family's badge sits after the title and must never squeeze it
    // past usefulness, so its width comes out of the title's budget up front.
    const badge = family?.role === 'rep' && family.size > 1
      ? `${family.expanded ? '▾' : '▸'}${family.size}`
      : undefined
    const badgeCells = badge === undefined ? 0 : badge.length + 1

    const facts: string[] = [formatWhen(session.updatedAt, now)]
    if (session.branch !== undefined) facts.push(session.branch)
    const size = formatBytes(session.bytes)
    if (size !== undefined) facts.push(size)
    if (session.model !== undefined) facts.push(session.model)
    if (session.childCount > 0 && depth === 0) facts.push(t('session-children', { n: session.childCount }))

    const marker = paint(theme, `${' '.repeat(indent)}${focusedRow ? '❯ ' : '  '}`, focusedRow ? 'suggestion' : 'subtle')
    const glyph = mark === undefined ? '' : paint(theme, `${mark.glyph} `, mark.color)
    const title = paint(
      theme,
      truncateWidth(session.label ?? session.title.text, body - (mark === undefined ? 0 : 2) - badgeCells),
      titleColor(session.title.source, focusedRow),
      { bold: focusedRow },
    )
    const badgeText = badge === undefined ? '' : paint(theme, ` ${badge}`, undefined, { dim: true })
    const meta = paint(theme, `${' '.repeat(indent + 2)}${truncateWidth(facts.join(' · '), body)}`, undefined, { dim: true })
    return [marker + glyph + title + badgeText, meta]
  }

  /**
   * The preview pane: what this session actually says, END first — the title
   * already carries the beginning, and "is this the one I was in the middle
   * of" is answered by the last exchange. Exactly `height` lines; an overlong
   * preview is cut at the TOP so the last thing said stays last.
   */
  private renderPreviewLines(theme: Theme, session: SessionSummary, width: number, height: number, now: number): string[] {
    const body = Math.max(8, width - 2)
    const lines: string[] = []
    lines.push(paint(theme, truncateWidth(session.title.text, body), 'remember', { bold: true }))
    lines.push(
      paint(theme, truncateWidth([kindLabel(session.kind), formatProject(session.cwd, this.home)].join(' · '), body), undefined, { dim: true }),
    )
    lines.push(
      paint(
        theme,
        truncateWidth(
          t('session-preview-times', { created: formatWhen(session.createdAt, now), updated: formatWhen(session.updatedAt, now) }),
          body,
        ),
        undefined,
        { dim: true },
      ),
    )
    lines.push(' ')

    if (this.previewLoading) {
      lines.push(paint(theme, t('session-preview-loading'), undefined, { dim: true, italic: true }))
    } else if (this.previewEntries.length === 0) {
      lines.push(paint(theme, t('session-preview-empty'), undefined, { dim: true, italic: true }))
    } else {
      for (const entry of this.previewEntries) {
        const role = PREVIEW_ROLE[entry.role]
        wrapWidth(entry.text, body - 2).forEach((line, index) => {
          const text = `${index === 0 ? `${role.glyph} ` : '  '}${line}`
          lines.push(
            index === 0
              ? paint(theme, text, role.color, { dim: entry.role === 'assistant' })
              : paint(theme, text, undefined, { dim: entry.role === 'assistant' }),
          )
        })
        lines.push(' ')
      }
    }

    const visible = lines.length > height ? lines.slice(lines.length - height) : [...lines]
    while (visible.length < height) visible.push('')
    // The pane's own left margin (the old Box's paddingLeft={2}).
    return visible.map((line) => `  ${line}`)
  }

  /** The hint row: dim italic, `**primary**` segments bolded. */
  private renderHint(theme: Theme, budget: number): string {
    const hint =
      this.mode === 'confirm-delete' || this.mode === 'confirm-clean'
        ? fitHint([t('resume-hint-delete')], budget)
        : this.mode === 'rename'
          ? fitHint([t('resume-hint-rename')], budget)
          : fitHint(
              [
                t('session-hint-list', {
                  mod: modLabel,
                  projects: this.filters.allProjects ? t('session-toggle-on') : t('session-toggle-off'),
                  runs: this.filters.showSubagents ? t('session-toggle-on') : t('session-toggle-off'),
                }),
                t('session-hint-list-mid', { mod: modLabel }),
                t('session-hint-list-short'),
              ],
              budget,
            )
    const parts = hint.split('**')
    const assembled = parts.length < 3 ? hint : parts.map((part, index) => (index % 2 === 1 ? chalk.bold(part) : part)).join('')
    return paint(theme, assembled, undefined, { dim: true, italic: true })
  }
}
