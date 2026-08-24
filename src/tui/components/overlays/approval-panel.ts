/**
 * The approval panel as an imperative pi-tui component (plan §1.3, WP-03) —
 * the Claude Code style permission prompt for the DSH approval seam
 * (`ctx.approval`), migrated from the retired React
 * `src/components/approvals/ApprovalPanel.tsx`.
 *
 * One ask per panel: a permission-colored divider naming the tool, the gated
 * command (recovered by the store from the paired tool call), the asker's
 * reason, "Do you want to proceed?", and a numbered Yes/No list. The
 * protocol's outcome set is closed (allowed-once / rejected / cancelled) with
 * no allow-always, so the panel deliberately offers exactly two rows; Esc and
 * Ctrl+C reject (fail closed).
 *
 * Contract: the chat screen pushes the store snapshot via {@link update}
 * (null hides the panel — zero rows) and routes the keyboard to
 * {@link handleInput} while a snapshot is pending. A new snapshot `key`
 * remounts the panel state (fresh focus), mirroring the old React
 * `key={snapshot.key}` remount. Decisions go through
 * `commands.overlays.decideApproval`; the component never touches the store
 * itself. Only a modifier-free Enter commits (`matchesKey(data, Key.enter)`:
 * Option+Enter arrives as ESC CR and Ctrl+Enter as CSI 13;5u — neither
 * matches, see fork keys.ts). Pointer: a primary-button click on an option
 * row commits it (the retired React panel's onClick); everything inside the
 * panel rect is consumed — see {@link handlePointer}.
 */
import { t } from '../../../i18n.js'
import { POINTER } from '../../../cc/figures.js'
import type { ApprovalSnapshot } from '../../../dsh-adapter/approvals.js'
import type { TuiCommands } from '../../commands.js'
import { Key, matchesKey, wrapTextWithAnsi, type Component, type PointerEvent, type TUI } from '../../public.js'
import { bold, dim, dividerLine, themePainter } from './overlay-chrome.js'

const OUTCOMES = ['allowed-once', 'rejected'] as const

/** Left padding of the panel body (the old Box paddingLeft={2}). */
const PAD = '  '

/** A clickable option row span: [start, end) line offsets within the last
 *  render output, plus the option index it activates. */
interface RowSpan {
  readonly start: number
  readonly end: number
  readonly index: number
}

export class ApprovalPanelView implements Component {
  private snapshot: ApprovalSnapshot | null = null
  /** The key of the snapshot the state below belongs to (remount marker). */
  private key: string | null = null
  private focusIndex = 0
  /** Click hit map recorded by the last render (panel-local line offsets). */
  private optionRows: RowSpan[] = []

  constructor(
    private readonly commands: TuiCommands,
    private readonly ui: TUI,
  ) {}

  /** Push the current approval snapshot; null hides the panel. */
  update(approval: ApprovalSnapshot | null): void {
    const key = approval?.key ?? null
    if (key !== this.key) {
      this.key = key
      this.focusIndex = 0
    }
    this.snapshot = approval
    this.ui.requestRender()
  }

  invalidate(): void {
    // No cached state to invalidate (render recomputes from the snapshot).
  }

  handleInput(data: string): void {
    const snapshot = this.snapshot
    if (snapshot === null) return

    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl('c'))) {
      this.commands.overlays.decideApproval('rejected')
      return
    }
    if (matchesKey(data, Key.up)) {
      this.focusIndex = (this.focusIndex + OUTCOMES.length - 1) % OUTCOMES.length
      this.ui.requestRender()
      return
    }
    if (matchesKey(data, Key.down)) {
      this.focusIndex = (this.focusIndex + 1) % OUTCOMES.length
      this.ui.requestRender()
      return
    }
    // Number quick-pick commits outright.
    if (matchesKey(data, '1') || matchesKey(data, '2')) {
      this.commands.overlays.decideApproval(OUTCOMES[matchesKey(data, '1') ? 0 : 1]!)
      return
    }
    // Modifier-free Enter only (see the module header).
    if (matchesKey(data, Key.enter)) {
      this.commands.overlays.decideApproval(OUTCOMES[this.focusIndex]!)
    }
  }

  /**
   * Click parity with the retired React ApprovalPanel (research §4.3): a
   * primary-button click on an option row commits that outcome outright —
   * the keyboard equivalent of moving the focus to the row and pressing
   * Enter. Every event reaching this handler lies inside the panel rect and
   * is consumed (blocking modal: no selection start, no scroll-through, no
   * pass-through); blank cells and non-option rows consume without acting.
   */
  handlePointer(event: PointerEvent): boolean | void {
    if (this.snapshot === null) return undefined
    if (event.type === 'click' && event.button === 0 && !event.cellIsBlank) {
      const hit = this.optionRows.find(row => event.localY >= row.start && event.localY < row.end)
      if (hit !== undefined) {
        this.focusIndex = hit.index
        this.commands.overlays.decideApproval(OUTCOMES[hit.index]!)
      }
    }
    return true
  }

  render(width: number): string[] {
    const snapshot = this.snapshot
    if (snapshot === null) return []
    this.optionRows = []

    const claude = themePainter('claude')
    const lines: string[] = ['']

    lines.push(PAD + dividerLine(width - 4, t('approval-waiting', { tool: snapshot.toolName }), 'permission'))
    lines.push('')

    if (snapshot.command !== undefined) {
      for (const line of wrapTextWithAnsi(snapshot.command, Math.max(1, width - 8))) {
        lines.push(`${PAD}  ${dim(line)}`)
      }
    }
    if (snapshot.reason !== undefined) {
      for (const line of wrapTextWithAnsi(snapshot.reason, Math.max(1, width - 4))) {
        lines.push(PAD + dim(line))
      }
    }
    lines.push(PAD + dim(t('approval-proceed')))

    lines.push('')
    const labels = [t('approval-yes'), t('approval-no')]
    for (let index = 0; index < labels.length; index += 1) {
      const focused = index === this.focusIndex
      if (focused) lines.push('') // the old row's marginTop={focused ? 1 : 0}
      const pointer = focused ? claude(bold(POINTER)) : ' '
      const label = `${index + 1}. ${labels[index]!}`
      const wrapped = wrapTextWithAnsi(label, Math.max(1, width - 5))
      const start = lines.length
      for (const [lineIndex, line] of wrapped.entries()) {
        const text = focused ? claude(bold(line)) : line
        lines.push(lineIndex === 0 ? `${PAD}${pointer}${text}` : `${PAD} ${text}`)
      }
      this.optionRows.push({ start, end: lines.length, index })
    }

    lines.push('')
    lines.push(PAD + dim(t('approval-hint')))
    return lines
  }
}
