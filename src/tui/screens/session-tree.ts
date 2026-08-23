/**
 * The double-Esc session tree as a pi-tui `Component` — the migration of the
 * old Ink `src/screens/SessionTreePanel.tsx` plus the tree slice of the old
 * Chat keyboard state machine (plan §1.3 transient-screen pattern, same host
 * contract as session-browser.ts).
 *
 * The screen is a full transient replacement (mounted via
 * `replaceTransient(..., 'session-tree')`): it owns the keyboard while open,
 * renders the cursor-centered window itself (an outer ScrollView would only
 * double-scroll), and receives its height through `setViewportHeight()` —
 * the component never touches stdio. All tree math (flatten/filter/cursor
 * geometry, rewind boundaries, family caps) lives in the pure model
 * `src/dsh-adapter/sessionTree.ts`; this class is only the state machine and
 * the paint pass. Data loads through the fenced command sink: a tree result
 * settling after a session swap comes back `undefined` and the panel closes
 * (the reopened tree rebuilds on the new session).
 *
 * Keys (pi parity): ↑/↓ move (wrapping); PgUp/PgDn and ←/→ page by the
 * window height; printable chars extend the search query; Backspace edits it;
 * ctrl+o cycles the kind filter (a bare `f` would be typed into the search);
 * ctrl+b asks to ADOPT the focused branch at its tip; Enter asks to confirm
 * the rewind/fork; Esc clears a live query first, then closes. While the
 * family loads only Esc is live; while a rewind is in flight every key is
 * swallowed (the agent swap must not race fresh input).
 */
import chalk from 'chalk'
import {
  Key,
  decodeKittyPrintable,
  matchesKey,
  visibleWidth,
  type Component,
} from '../public.js'
import type { TuiCommands } from '../commands.js'
import {
  TREE_FILTERS,
  droppedTurnInfo,
  filterTree,
  flattenTree,
  nearestVisibleIndex,
  type FlatNode,
  type SessionTreeData,
  type SessionTreeMeta,
  type TreeEntry,
  type TreeFilter,
} from '../../dsh-adapter/sessionTree.js'
import { truncateWidth } from '../../sessions/format.js'
import { getActiveTheme, type Theme } from '../../theme.js'
import { paint as paintColor } from '../components/rows/style.js'
import { modLabel } from '../../utils/modifiers.js'
import { t } from '../../i18n.js'

/**
 * The tree's confirm seat: `rewind` asks before forking at an entry (pi
 * semantics — a USER message drops its whole turn, anything else keeps
 * through its step/turn end); `adopt` asks before switching to the entry's
 * branch at its tip, keeping the branch's full content (ctrl+b).
 */
interface TreeConfirmState {
  readonly mode: 'rewind' | 'adopt'
  /** Context row shown under the action lines (for adopt: any entry of the
   *  target branch — the one ctrl+b was pressed on). */
  readonly entry: TreeEntry
  /** rewind only: the dropped turn holds every own entry of its branch, so
   *  the fork shows none of the branch's own content (the "click the branch
   *  message → lose the whole branch" trap). */
  readonly dropsBranch?: boolean
  /** adopt only: the branch tip boundary (last turn/end seq). */
  readonly tipSeq?: number
}

/** Rows of the tree visible at once at most (the window scrolls with the
 *  cursor); the actual window shrinks to fit shorter terminals. */
export const TREE_WINDOW = 14

/** Pane padding equivalent + the focus pointer column. */
const ROW_CHROME = 4
/** Smallest prefix the clamp keeps: '…' + one connector glyph + tail. */
const MIN_PREFIX_CELLS = 3
/** Reserved body width so clamping never squeezes the text to zero. */
const MIN_BODY_CELLS = 8

/** Terminal cells of each fixed kind prefix. */
const KIND_PREFIX_CELLS: Record<TreeEntry['kind'], number> = {
  user: visibleWidth('user: '),
  assistant: visibleWidth('assistant: '),
  compact: visibleWidth('[compact] '),
  tool: 0,
  interrupt: 0,
  notice: 0,
}
/** Plain-text form of each kind prefix, for the narrow-mode joined string. */
const KIND_PREFIX_TEXT: Record<TreeEntry['kind'], string> = {
  user: 'user: ',
  assistant: 'assistant: ',
  compact: '[compact] ',
  tool: '',
  interrupt: '',
  notice: '',
}

interface PaintOptions {
  readonly bold?: boolean
  readonly dim?: boolean
  readonly italic?: boolean
}

/** Style one segment (same helper shape as session-browser): chalk for the
 *  text modifiers, `paint` for the theme colour. Colour goes on outermost. */
function paint(theme: Theme, text: string, color?: keyof Theme, options?: PaintOptions): string {
  let out = text
  if (options?.italic === true) out = chalk.italic(out)
  if (options?.bold === true) out = chalk.bold(out)
  if (options?.dim === true) out = chalk.dim(out)
  if (color !== undefined) out = paintColor(out, theme[color])
  return out
}

/**
 * Text a key event contributes to the search field, if any. Kitty CSI-u
 * printable sequences decode to their character; a raw chunk is text when it
 * starts on a printable byte. Everything else — escape sequences, control
 * bytes, modifier chords — is not text.
 */
function printableText(data: string): string | undefined {
  const kitty = decodeKittyPrintable(data)
  if (kitty !== undefined) return kitty
  return data.length > 0 && data.charCodeAt(0) >= 32 ? data : undefined
}

/** pi's prefix: gutters at recorded positions, connector at indent-1. */
function treePrefix(flatNode: FlatNode, multipleRoots: boolean): string {
  const displayIndent = multipleRoots ? Math.max(0, flatNode.indent - 1) : flatNode.indent
  const hasConnector = flatNode.showConnector && !flatNode.isVirtualRootChild
  const connectorPosition = hasConnector ? displayIndent - 1 : -1
  const chars: string[] = []
  for (let i = 0; i < displayIndent * 3; i++) {
    const level = Math.floor(i / 3)
    const posInLevel = i % 3
    const gutter = flatNode.gutters.find(g => g.position === level)
    if (gutter !== undefined) {
      chars.push(posInLevel === 0 ? (gutter.show ? '│' : ' ') : ' ')
    } else if (level === connectorPosition) {
      if (posInLevel === 0) chars.push(flatNode.isLast ? '└' : '├')
      else if (posInLevel === 1) chars.push('─')
      else chars.push(' ')
    } else {
      chars.push(' ')
    }
  }
  return chars.join('')
}

/**
 * Keep the LAST `budget` cells of `s`, prefixed by '…' when anything was
 * cut. Code points accumulate from the right so a wide glyph is never split.
 */
function tailCells(s: string, budget: number): string {
  if (budget <= 0) return ''
  if (visibleWidth(s) <= budget) return s
  const inner = budget - 1
  if (inner <= 0) return '…'
  let width = 0
  let out = ''
  for (const ch of [...s].reverse()) {
    const w = visibleWidth(ch)
    if (width + w > inner) break
    out = ch + out
    width += w
  }
  return '…' + out
}

/** Rendered width of a hint: the `**` emphasis markers are not printed. */
function hintWidth(text: string): number {
  return visibleWidth(text.replace(/\*\*/gu, ''))
}

/** The widest hint that fits, cut only when even the shortest will not. */
function fitHint(candidates: readonly string[], budget: number): string {
  for (const candidate of candidates) {
    if (hintWidth(candidate) <= budget) return candidate
  }
  return truncateWidth((candidates[candidates.length - 1] ?? '').replace(/\*\*/gu, ''), budget)
}

/** A thrown value's message, for a notification that has to say something. */
function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export interface SessionTreeScreenDeps {
  readonly commands: TuiCommands
  /** `rewind` re-edits the picked turn (double-Esc, /rewind, /tree); `fork`
   *  keeps the picked entry (/fork). */
  readonly mode: 'rewind' | 'fork'
  /** Live session id at open time (cross-session confirm copy, adopt-live
   *  refusal). A mid-panel swap is caught by the channel's own guards. */
  readonly currentSessionId: string
  readonly onClose: () => void
  /** The dropped turn's prompt goes back into the input for re-editing. */
  readonly onRestoreText: (text: string) => void
}

export class SessionTreeScreen implements Component {
  /** Focusable contract; a host that never manages focus still gets keys. */
  focused = true
  /** Host hook: fired after every ASYNC state transition (tree loaded, load
   *  failed) so the host can `ui.requestRender()`. Key-driven transitions
   *  re-render through the TUI's own post-input render. */
  onChange: (() => void) | undefined

  private readonly commands: TuiCommands
  /** Rewind/fork intent: seeded from the opener (double-Esc and /tree open
   *  rewind), toggled in-panel with ctrl+f. */
  private mode: 'rewind' | 'fork'
  private readonly currentSessionId: string
  private readonly onClose: () => void
  private readonly onRestoreText: (text: string) => void

  private data: SessionTreeData | null = null
  private loading = true
  /** A rewind is in flight — the seat stays up until the swap settles. */
  private rewinding = false
  private confirm: TreeConfirmState | null = null
  private cursor = 0
  private filter: TreeFilter = 'default'
  private query = ''
  /** On-screen refusal line (the transcript toast stack is NOT visible while
   *  this transient screen owns the render). */
  private notice: { text: string; tone: 'error' | 'info' } | undefined
  /** Stale-load guard: closing/reopening invalidates an in-flight build. */
  private generation = 0
  /** Host-fed viewport height in rows; 0 = unset, render at natural height. */
  private viewportHeight = 0

  constructor(deps: SessionTreeScreenDeps) {
    this.commands = deps.commands
    this.mode = deps.mode
    this.currentSessionId = deps.currentSessionId
    this.onClose = deps.onClose
    this.onRestoreText = deps.onRestoreText
  }

  /** Host height hint (terminal rows); re-applied on every resize. */
  setViewportHeight(rows: number): void {
    this.viewportHeight = Math.max(0, Math.floor(rows))
  }

  invalidate(): void {
    // Colours and the flattened tree are recomputed per render.
  }

  /** Invalidate any in-flight load when the host tears the screen down. */
  dispose(): void {
    this.generation += 1
  }

  /**
   * Load the family tree through the fenced sink. undefined = stale-dropped
   * (a session swap landed mid-build) and null = unavailable (the channel
   * already notified the reason) — both close the panel; only real data
   * opens the list. The initial cursor lands on the live tip, walking the
   * parent chain when the default filter hides it.
   */
  load(): void {
    const generation = ++this.generation
    this.loading = true
    void this.commands.query.getSessionTree().then(
      data => {
        if (this.generation !== generation) return
        if (data === null || data === undefined) {
          this.onClose()
          return
        }
        this.loading = false
        this.data = data
        const full = flattenTree(data.roots, data.activeLeafId)
        const visible = filterTree(full, data.activeLeafId, 'default', '')
        this.cursor = nearestVisibleIndex(visible, full, data.activeLeafId)
        this.onChange?.()
      },
      () => {
        if (this.generation !== generation) return
        this.onClose()
        this.commands.info.notify(t('tree-load-failed'), { color: 'error' })
      },
    )
  }

  // -------------------------------------------------------------------------
  // Input
  // -------------------------------------------------------------------------

  handleInput(data: string): void {
    // A notice describes what the LAST key did; the next keystroke makes it
    // stale, so it goes as soon as the user acts again.
    this.notice = undefined

    if (this.loading || this.rewinding) {
      // While a rewind is in flight the seat swallows every key — closing
      // now would re-arm the prompt mid-swap.
      if (matchesKey(data, Key.escape) && !this.rewinding) this.close()
      return
    }

    if (this.confirm !== null) {
      // Confirmation state: Enter executes, Esc backs out to the tree.
      if (matchesKey(data, Key.enter)) {
        const confirm = this.confirm
        this.confirm = null
        this.rewinding = true
        void this.performConfirm(confirm)
      } else if (matchesKey(data, Key.escape)) {
        this.confirm = null
      }
      return
    }

    const nodes = this.visibleNodes()
    const cursor = this.clampedCursor(nodes)
    const last = nodes.length - 1

    if (matchesKey(data, Key.up)) {
      this.cursor = cursor <= 0 ? Math.max(0, last) : cursor - 1
    } else if (matchesKey(data, Key.down)) {
      this.cursor = cursor >= last ? 0 : cursor + 1
    } else if (matchesKey(data, Key.pageUp) || matchesKey(data, Key.left)) {
      this.cursor = Math.max(0, cursor - this.windowRows())
    } else if (matchesKey(data, Key.pageDown) || matchesKey(data, Key.right)) {
      this.cursor = Math.min(Math.max(0, last), cursor + this.windowRows())
    } else if (matchesKey(data, Key.escape)) {
      // Esc backs out one layer at a time: a live query first, the screen
      // second. Closing on the first Esc would discard a search the user is
      // still refining.
      if (this.query !== '') this.query = ''
      else this.close()
    } else if (matchesKey(data, Key.backspace) || matchesKey(data, Key.delete)) {
      this.query = this.query.slice(0, -1)
    } else if (matchesKey(data, Key.ctrl('o'))) {
      const index = TREE_FILTERS.indexOf(this.filter)
      this.filter = TREE_FILTERS[(index + 1) % TREE_FILTERS.length] ?? 'default'
      this.cursor = 0
    } else if (matchesKey(data, Key.ctrl('f'))) {
      // Toggle the rewind/fork intent (the confirm copy and the Enter action
      // follow it; the title line marks fork mode while active).
      this.mode = this.mode === 'fork' ? 'rewind' : 'fork'
    } else if (matchesKey(data, Key.enter)) {
      this.askRewind(nodes[cursor])
    } else if (matchesKey(data, Key.ctrl('b'))) {
      this.askAdopt(nodes[cursor])
    } else {
      // Only real characters reach the query. Anything else the terminal
      // delivers — an unbound control byte, a chord this screen does not
      // claim — would otherwise be typed into the search box invisibly.
      const text = printableText(data)
      if (text !== undefined) {
        const typed = text.replace(/\p{Cc}/gu, '')
        if (typed.length > 0) {
          this.query += typed
          this.cursor = 0
        }
      }
    }
  }

  /** Enter on a row: ask to rewind (or fork) at its entry. */
  private askRewind(flatNode: FlatNode | undefined): void {
    const entry = flatNode?.node.entry
    if (entry === undefined || entry === null) return
    // A user message of the log's own first turn can never rewind (dropping
    // turn 0 needs boundary -1) — refuse here with the reason, instead of
    // failing after the confirm seat. Turn-0 assistant/tool entries rewind
    // fine (they keep turn 0 whole); fork mode keeps the entry, so the
    // refusal is rewind-only.
    if (this.mode === 'rewind' && entry.firstTurn === true && entry.kind === 'user') {
      this.notice = { text: t('tree-first-message'), tone: 'error' }
      return
    }
    // The drop-turn warning rides into the confirm seat: a branch whose
    // whole own content is ONE turn loses everything visible to a
    // user-message pick. Fork mode keeps the entry, so the trap does not
    // apply there.
    const drop =
      this.mode === 'rewind' && this.data !== null ? droppedTurnInfo(this.data, entry) : undefined
    this.confirm = {
      mode: 'rewind',
      entry,
      ...(drop?.coversBranch === true ? { dropsBranch: true } : {}),
    }
  }

  /** ctrl+b: ask to ADOPT the focused entry's branch WHOLE — fork at its
   *  tip, keeping all of its content. Only a loaded-to-the-tip branch
   *  qualifies — a budget-sliced tail would fork mid-branch while claiming
   *  to keep everything, and the live session is already on its own tip. */
  private askAdopt(flatNode: FlatNode | undefined): void {
    const entry = flatNode?.node.entry
    if (entry === undefined || entry === null) return
    if (entry.sessionId === this.currentSessionId) {
      this.notice = { text: t('tree-adopt-live'), tone: 'info' }
      return
    }
    const tipBoundary = this.data?.rewindFacts.get(entry.sessionId)?.tipBoundary
    if (tipBoundary === undefined) {
      this.notice = { text: t('tree-adopt-unavailable'), tone: 'error' }
      return
    }
    this.confirm = { mode: 'adopt', entry, tipSeq: tipBoundary }
  }

  /**
   * Execute the confirmed action. rewindToNode notifies and returns null on
   * failure, so a non-null result always succeeded; either way the panel
   * closes when the await settles (the transcript the swap produced — or
   * kept — is what the user needs to see next).
   */
  private async performConfirm(confirm: TreeConfirmState): Promise<void> {
    try {
      if (confirm.mode === 'adopt') {
        // Adopt forks at the branch TIP: rewindToNode with the tip's
        // turn/end seq keeps the whole log, which is the "switch to this
        // branch with its content" gesture that picking the branch's head
        // user message never is (a rewind pick drops that turn).
        if (confirm.tipSeq === undefined) return
        const text = await this.commands.session.rewindToNode(confirm.entry.sessionId, confirm.tipSeq, 'rewind')
        if (text === null) return
        this.commands.info.notify(t('tree-adopted'))
      } else {
        const text = await this.commands.session.rewindToNode(
          confirm.entry.sessionId,
          confirm.entry.seq,
          this.mode === 'fork' ? 'fork' : 'rewind',
        )
        if (text === null) return
        if (text !== '') {
          this.onRestoreText(text)
          this.commands.info.notify(t('tree-rewound'))
        } else {
          this.commands.info.notify(this.mode === 'fork' ? t('tree-forked') : t('tree-rewound-no-text'))
        }
      }
    } catch (error) {
      // Known failures come back as null (the channel notifies); anything
      // that still throws is unexpected — report it instead of letting the
      // voided promise die as an unhandled rejection.
      this.commands.info.notify(t('tree-rewind-failed', { message: message(error) }), { color: 'error' })
    } finally {
      this.rewinding = false
      this.onClose()
    }
  }

  private close(): void {
    this.generation += 1
    this.onClose()
  }

  // -------------------------------------------------------------------------
  // Derived view
  // -------------------------------------------------------------------------

  /** The flattened, filtered row list; recomputed per call — the family is
   *  capped at build time, so this is cheap. */
  private visibleNodes(): readonly FlatNode[] {
    if (this.data === null) return []
    const full = flattenTree(this.data.roots, this.data.activeLeafId)
    return filterTree(full, this.data.activeLeafId, this.filter, this.query)
  }

  private clampedCursor(nodes: readonly FlatNode[]): number {
    return nodes.length === 0 ? 0 : Math.min(this.cursor, nodes.length - 1)
  }

  /**
   * Window size for the current terminal height: the fixed chrome (title,
   * subtitle, rules, position line, hint, plus the live query/notice rows)
   * yields before the entry window does. Without a host height hint the full
   * TREE_WINDOW renders.
   */
  private windowRows(): number {
    if (this.viewportHeight <= 0) return TREE_WINDOW
    const chrome = 6 + (this.query !== '' ? 1 : 0) + (this.notice === undefined ? 0 : 1)
    return Math.min(TREE_WINDOW, Math.max(this.viewportHeight - chrome, 1))
  }

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  render(width: number): string[] {
    const theme = getActiveTheme()
    const budget = Math.max(0, width - 1)

    if (this.loading || this.rewinding) {
      return this.pad([
        paint(theme, truncateWidth(` ${t('tree-title')}`, budget), 'remember', { bold: true }),
        paint(theme, ` ${this.rewinding ? t('tree-rewinding') : t('tree-loading')}`, undefined, { dim: true }),
      ])
    }

    if (this.confirm !== null) return this.renderConfirm(theme, width)

    const nodes = this.visibleNodes()
    const cursor = this.clampedCursor(nodes)
    const windowRows = this.windowRows()
    const start = Math.max(0, Math.min(cursor - Math.floor(windowRows / 2), nodes.length - windowRows))
    const visible = nodes.slice(start, start + windowRows)
    // pi shifts roots left when several sessions became roots (deleted
    // parent); flatten/filter stamp the flag on every row of the pass.
    const multipleRoots = nodes[0]?.multipleRoots ?? false

    const lines: string[] = []
    const title = ` ${t('tree-title')}${this.mode === 'fork' ? ` · ${t('tree-mode-fork')}` : ''}`
    lines.push(paint(theme, truncateWidth(title, budget), 'remember', { bold: true }))
    lines.push(
      paint(
        theme,
        truncateWidth(
          ` ${t('tree-subtitle', { sessions: this.data?.sessionCount ?? 0, filter: t(`tree-filter-${this.filter}`) })}`,
          budget,
        ),
        undefined,
        { dim: true },
      ),
    )
    lines.push(this.renderDivider(theme, width))

    if (visible.length === 0) {
      lines.push(paint(theme, ` ${t('tree-empty')}`, undefined, { dim: true, italic: true }))
    } else {
      visible.forEach((flatNode, offset) => {
        lines.push(this.renderRow(theme, flatNode, multipleRoots, start + offset === cursor, width))
      })
    }

    const position = `${nodes.length === 0 ? '' : `(${cursor + 1}/${nodes.length}) `}${this.data?.truncated === true ? t('tree-truncated') : ''}`
    lines.push(paint(theme, ` ${position}`, undefined, { dim: true }))
    if (this.query !== '') {
      lines.push(paint(theme, truncateWidth(` ${t('tree-search', { query: this.query })}`, budget), undefined, { dim: true }))
    }
    if (this.notice !== undefined) {
      lines.push(paint(theme, truncateWidth(` ${this.notice.text}`, budget), this.notice.tone === 'error' ? 'error' : 'success'))
    }
    lines.push(this.renderDivider(theme, width))
    lines.push(this.renderHint(theme, budget, [t('tree-hint', { mod: modLabel })]))
    return this.pad(lines)
  }

  /** The confirm seat replaces the tree view (same shape as the old panel). */
  private renderConfirm(theme: Theme, width: number): string[] {
    const confirm = this.confirm!
    const budget = Math.max(0, width - 1)
    const adopt = confirm.mode === 'adopt'
    const fork = !adopt && this.mode === 'fork'
    const cross = confirm.entry.sessionId !== this.currentSessionId
    // The action line names what the pick actually does — pi's drop-the-turn
    // semantics for a user message surprise ("回退到此处" reads as "keep up
    // to here", but the picked message itself is dropped), so each kind
    // spells out its boundary; adopt states its keep-everything promise;
    // fork's user pick keeps the message and drops only the reply.
    const action = adopt
      ? t('tree-adopt-body')
      : fork && confirm.entry.kind === 'user'
        ? t('tree-fork-keep-message')
        : confirm.entry.kind === 'user'
          ? t('tree-confirm-drop-turn')
          : confirm.entry.kind === 'compact'
            ? t('tree-confirm-here')
            : confirm.entry.kind === 'assistant' || confirm.entry.kind === 'tool'
              ? t('tree-confirm-keep-step')
              : t('tree-confirm-keep-turn')
    // compact's line already carries the "original stays a branch" promise.
    const keepsOriginalInline = !adopt && confirm.entry.kind === 'compact'

    const lines: string[] = []
    lines.push(
      paint(
        theme,
        truncateWidth(` ${t(adopt ? 'tree-adopt-title' : fork ? 'tree-fork-title' : 'tree-confirm-title')}`, budget),
        'remember',
        { bold: true },
      ),
    )
    lines.push(paint(theme, truncateWidth(` ${action}`, budget), undefined, { dim: true }))
    if (cross) {
      lines.push(
        paint(theme, truncateWidth(` ${t('tree-confirm-cross', { id: confirm.entry.sessionId.slice(0, 8) })}`, budget), undefined, { dim: true }),
      )
    }
    if (!keepsOriginalInline) {
      lines.push(paint(theme, truncateWidth(` ${t('tree-confirm-keep-original')}`, budget), undefined, { dim: true }))
    }
    if (confirm.dropsBranch === true) {
      lines.push(paint(theme, truncateWidth(` ${t('tree-confirm-drops-branch')}`, budget), 'warning'))
    }
    lines.push('')
    lines.push(
      ` ${paint(theme, truncateWidth(confirm.entry.text, Math.max(16, width - 10)), undefined)}${paint(theme, `  ${t(`tree-kind-${confirm.entry.kind}`)}`, undefined, { dim: true })}`,
    )
    lines.push(this.renderDivider(theme, width))
    lines.push(this.renderHint(theme, budget, [t('tree-hint-confirm')]))
    return this.pad(lines)
  }

  /**
   * One entry row: focus pointer, tree prefix, active-path bullet, label,
   * kind prefix, elastic body, branch-head suffix. The fixed segments are
   * clamped (suffix first, then the tree prefix collapses its leading levels
   * into a single '…') so a deep family can never wrap a logical row into
   * two physical lines.
   */
  private renderRow(theme: Theme, flatNode: FlatNode, multipleRoots: boolean, focused: boolean, width: number): string {
    const { node } = flatNode
    const rawPrefix = treePrefix(flatNode, multipleRoots)
    const label = node.entry?.label
    const onActivePath = this.data?.activePath.has(node.id) === true

    const avail = Math.max(8, width - ROW_CHROME)
    const markerCells = (onActivePath ? 2 : 0) + (label !== undefined ? visibleWidth(`[${label}] `) : 0)
    const kindCells = KIND_PREFIX_CELLS[node.entry?.kind ?? 'notice']
    const pointer = focused ? paint(theme, '❯ ', 'suggestion') : '  '

    // Extreme narrow (20-24 cols): even the clamped-to-minimum fixed run plus
    // a minimal body overflows — fall back to ONE joined fixed string cut
    // from the left (the tail — the kind prefix — is what identifies the
    // row); the suffix is dropped outright, so the row can never wrap.
    if (MIN_PREFIX_CELLS + markerCells + kindCells + MIN_BODY_CELLS > avail) {
      const fixedText =
        `${rawPrefix}${onActivePath ? '• ' : ''}` +
        `${label !== undefined ? `[${label}] ` : ''}${KIND_PREFIX_TEXT[node.entry?.kind ?? 'notice']}`
      const fixed = tailCells(fixedText, Math.max(0, avail - MIN_BODY_CELLS))
      return pointer + paint(theme, fixed, undefined, { dim: true }) + this.renderBody(theme, node, focused, Math.max(1, avail - visibleWidth(fixed)))
    }

    // Branch heads of OTHER sessions carry a session suffix (title or short id).
    let suffix = ''
    if (node.branchHead && node.sessionId !== this.currentSessionId) {
      const meta = this.data?.sessions.get(node.sessionId)
      suffix = ` · ${truncateWidth(meta?.title ?? node.sessionId.slice(0, 8), 24)}`
    }

    const maxSuffix = avail - markerCells - kindCells - MIN_PREFIX_CELLS - MIN_BODY_CELLS
    if (suffix !== '' && visibleWidth(suffix) > maxSuffix) {
      suffix = maxSuffix >= 6 ? truncateWidth(suffix, maxSuffix) : ''
    }
    const maxPrefix = Math.max(
      MIN_PREFIX_CELLS,
      avail - markerCells - kindCells - visibleWidth(suffix) - MIN_BODY_CELLS,
    )
    // All prefix glyphs are single-cell box-drawing chars, so slice == cells.
    const prefix =
      rawPrefix.length > maxPrefix
        ? '…' + rawPrefix.slice(rawPrefix.length - (maxPrefix - 1))
        : rawPrefix
    const bodyBudget = Math.max(
      1,
      avail - markerCells - kindCells - visibleWidth(prefix) - visibleWidth(suffix),
    )

    let row = pointer + paint(theme, prefix, undefined, { dim: true })
    if (onActivePath) row += paint(theme, '• ', 'suggestion')
    if (label !== undefined) row += paint(theme, `[${label}] `, 'warning')
    row += this.renderKindPrefix(theme, node.entry)
    row += this.renderBody(theme, node, focused, bodyBudget)
    if (suffix !== '') row += paint(theme, suffix, undefined, { dim: true })
    return row
  }

  /** Fixed kind prefix (`user: ` etc.) — kept out of the elastic body so
   *  truncation only ever eats the entry text. */
  private renderKindPrefix(theme: Theme, entry: TreeEntry | null): string {
    if (entry === null) return ''
    switch (entry.kind) {
      case 'user':
        return paint(theme, 'user: ', 'suggestion')
      case 'assistant':
        return paint(theme, 'assistant: ', 'success')
      case 'compact':
        return paint(theme, '[compact] ', 'remember')
      default:
        return ''
    }
  }

  /** Elastic entry body — pre-truncated to `budget` cells by the caller so
   *  the row measures exactly one line. */
  private renderBody(theme: Theme, node: FlatNode['node'], focused: boolean, budget: number): string {
    if (node.entry === null) {
      // Placeholder: session with no own entries (empty fork / unreadable
      // log / budget-unloaded), or a synthesized fork anchor that predates
      // every displayable entry.
      const meta: SessionTreeMeta | undefined = this.data?.sessions.get(node.sessionId)
      const text =
        node.children.length > 0 && meta?.unreadable !== true && meta?.unloaded !== true
          ? t('tree-fork-point')
          : meta?.unloaded === true
            ? t('tree-unloaded')
            : meta?.unreadable === true
              ? t('tree-unreadable')
              : t('tree-empty-fork')
      return paint(theme, truncateWidth(text, budget), undefined, { dim: true, italic: true })
    }

    const entry = node.entry
    const text = truncateWidth(entry.text, budget)
    switch (entry.kind) {
      case 'user':
      case 'assistant':
        return focused ? paint(theme, text, 'suggestion') : text
      case 'tool':
        return entry.toolStatus === 'error'
          ? paint(theme, text, 'error')
          : paint(theme, text, undefined, { dim: true })
      case 'compact':
      case 'interrupt':
      case 'notice':
        return paint(theme, text, undefined, { dim: true })
    }
  }

  private renderDivider(theme: Theme, width: number): string {
    return paint(theme, '─'.repeat(Math.max(0, width)), undefined, { dim: true })
  }

  /** The hint row: dim italic, `**primary**` segments bolded. */
  private renderHint(theme: Theme, budget: number, candidates: readonly string[]): string {
    const hint = fitHint(candidates, budget)
    const parts = hint.split('**')
    const assembled = parts.length < 3 ? hint : parts.map((part, index) => (index % 2 === 1 ? chalk.bold(part) : part)).join('')
    return paint(theme, ` ${assembled}`, undefined, { dim: true, italic: true })
  }

  /** The screen owes the host a full-height frame once a hint arrived. */
  private pad(lines: string[]): string[] {
    if (this.viewportHeight > 0) {
      while (lines.length < this.viewportHeight) lines.push('')
    }
    return lines
  }
}
