/**
 * SidePanelLayout: owns the two-column row — chat surface left, divider,
 * side-panel surface right (design doc §4.1). useSidePanel owns the width
 * state; this component arranges boxes, re-provides contexts, and forwards
 * divider drags as chat-column widths in cells.
 *
 * What each column subtree gets (the PageMargin trick, one level down):
 * - TerminalSizeContext narrowed to the column width, so every existing
 *   component that reads useTerminalSize() (MessageList, PromptInput,
 *   tool cards, Markdown tables…) automatically lays out for the column;
 * - SurfaceEdgesContext re-provided per column: chat bleeds left into the
 *   page margin but stops at the divider, the panel bleeds right;
 * - a numeric-width box with overflow="hidden" (never "%": ink resolves
 *   percentages against the padding-inclusive parent).
 *
 * PageInsetContext is deliberately NOT overridden: the chat column's
 * origin is still the content-area origin, so screen-coordinate overlays
 * (tooltips) keep their math.
 *
 * STRUCTURAL STABILITY (2026-10-02 crash fix). The collapsed state used to
 * render bare `children`, which made split↔collapsed a tree-SHAPE change:
 * React unmounted the whole chat column and mounted a fresh one on every
 * Ctrl+B / editor-open / resize-across-the-threshold. That cost more than
 * a repaint — the deletion commit ran ScrollBox's useImperativeHandle
 * cleanup, whose ref is Chat's `setHandle` state setter, so the detached
 * ref scheduled a state update INSIDE a commit; combined with the
 * fullscreen editor publishing its node from an insertion effect (a store
 * notification that renders synchronously inside the same commit) the
 * nested-update counter ratcheted past React's limit and the process died
 * with Minified React error #185. Keeping the chat column at a stable tree
 * position turns every geometry change into a prop update, so nothing is
 * deleted, no ref detaches mid-commit, and chat-side state (scroll
 * position, draft, transcript measure cache) survives the toggle.
 *
 * While collapsed the wrappers are invisible by construction: the contexts
 * re-provide the PARENT's own values (referentially identical), the chat
 * box gets no width / no overflow / no click handler, and the outer row
 * does not clip — so the collapsed frame stays byte-identical to the
 * no-layout render (locked by verify-side-panel-layout).
 */
import React from 'react'
import { Box, Text } from '../../ui.js'
import { TerminalSizeContext } from '../../ink/components/TerminalSizeContext.js'
import { useTerminalSize } from '../../ink/hooks/use-terminal-size.js'
import { SurfaceEdgesContext, useSurfaceEdges } from '../SurfaceEdges.js'
import type { DragEvent } from '../../ink/events/drag-event.js'
import type { SidePanelFocus } from './useSidePanel.js'
import type { SidePanelSplit } from './dimensions.js'

export interface SidePanelLayoutProps {
  readonly geometry: SidePanelSplit | null
  readonly focus: SidePanelFocus
  /** Right-column content (PanelBar + PanelHost + hint). */
  readonly side: React.ReactNode
  readonly onActivateChat?: () => void
  readonly onActivatePanel?: () => void
  /** Resize the chat column in cells; the controller clamps both columns. */
  readonly onResize?: (chatColumns: number) => void
  readonly children: React.ReactNode
}

/**
 * The 1-column seam. Rendered as an explicit glyph block (not a border) so
 * it can tee into the panel column's horizontal rules: rows that line up
 * with a rule draw '├', everything else '│' — the seam and the rules read
 * as one framed surface instead of two crossing lines.
 */
function DividerColumn({
  focused,
  rows,
  junctionRows,
  chatColumns,
  onResize,
}: {
  readonly focused: boolean
  readonly rows: number
  readonly junctionRows: readonly number[]
  readonly chatColumns: number
  readonly onResize?: (chatColumns: number) => void
}): React.ReactNode {
  const [hovered, setHovered] = React.useState(false)
  const [dragging, setDragging] = React.useState(false)
  const startChatColumns = React.useRef<number | null>(null)
  const resizeHandler = React.useRef(onResize)
  // Ink keeps the captured node after removal. Withdraw its callback on
  // unmount so a scene switch cannot resize the hidden sidebar.
  React.useLayoutEffect(() => {
    resizeHandler.current = onResize
    return () => { resizeHandler.current = undefined }
  }, [onResize])
  const resize = (event: DragEvent): void => {
    event.stopImmediatePropagation()
    if (startChatColumns.current !== null) {
      resizeHandler.current?.(startChatColumns.current + event.col - event.startCol)
    }
  }
  const junctions = new Set(junctionRows)
  const glyphs: string[] = []
  for (let y = 0; y < Math.max(1, rows); y += 1) {
    glyphs.push(junctions.has(y) ? '├' : '│')
  }
  return (
    <Box
      width={1}
      flexShrink={0}
      overflow="hidden"
      noSelect
      onMouseEnter={onResize === undefined ? undefined : () => setHovered(true)}
      onMouseLeave={onResize === undefined ? undefined : () => setHovered(false)}
      onDragStart={onResize === undefined ? undefined : event => {
        // Keep the press geometry for the entire captured gesture: the
        // divider moves on every frame and localCol moves with it.
        startChatColumns.current = chatColumns
        setDragging(true)
        resize(event)
      }}
      onDragMove={onResize === undefined ? undefined : resize}
      onDragEnd={onResize === undefined ? undefined : event => {
        resize(event)
        startChatColumns.current = null
        setDragging(false)
      }}
    >
      <Text color={focused || hovered || dragging ? 'accent' : 'inactive'}>{glyphs.join('\n')}</Text>
    </Box>
  )
}

export function SidePanelLayout({
  geometry,
  focus,
  side,
  onActivateChat,
  onActivatePanel,
  onResize,
  children,
}: SidePanelLayoutProps): React.ReactNode {
  const outerEdges = useSurfaceEdges()
  const parentSize = useTerminalSize()
  const rows = parentSize.rows
  const screenRows = parentSize.screenRows ?? parentSize.rows
  const split = geometry !== null
  const panelColumns = geometry?.panel ?? 0
  const chatEdges = React.useMemo(
    () => ({ left: outerEdges.left, right: 0 }),
    [outerEdges.left],
  )
  const panelEdges = React.useMemo(
    () => ({ left: 0, right: outerEdges.right }),
    [outerEdges.right],
  )
  // Collapsed: hand the parent's own objects straight back so consumers see
  // byte-identical context values (and keep their memoization).
  const chatSize = React.useMemo(
    () => (geometry === null ? parentSize : { columns: geometry.chat, rows, screenRows }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- geometry identity changes with the split
    [parentSize, geometry, rows, screenRows],
  )
  const panelSize = React.useMemo(
    () => ({ columns: panelColumns, rows, screenRows }),
    [panelColumns, rows, screenRows],
  )
  return (
    <Box flexDirection="row" flexGrow={1} flexShrink={1} overflow={split ? 'hidden' : undefined}>
      <SurfaceEdgesContext.Provider value={split ? chatEdges : outerEdges}>
        <TerminalSizeContext.Provider value={chatSize}>
          <Box
            flexDirection="column"
            flexGrow={split ? 0 : 1}
            width={geometry === null ? undefined : geometry.chat}
            flexShrink={0}
            overflow={split ? 'hidden' : undefined}
            onClick={split ? onActivateChat : undefined}
          >
            {children}
          </Box>
        </TerminalSizeContext.Provider>
      </SurfaceEdgesContext.Provider>
      {split && (
        <>
          {/* Junction contract: SidePanelColumn keeps its PanelBar on row 0,
              a rule on row 1, and the hint + its rule as the last two rows, so
              the seam tees at exactly 1 and rows-2. */}
          <DividerColumn
            focused={focus === 'panel'}
            rows={rows}
            junctionRows={[1, Math.max(1, rows - 2)]}
            chatColumns={geometry.chat}
            onResize={onResize}
          />
          <SurfaceEdgesContext.Provider value={panelEdges}>
            <TerminalSizeContext.Provider value={panelSize}>
              <Box
                flexDirection="column"
                width={panelColumns}
                flexShrink={0}
                overflow="hidden"
                onClick={onActivatePanel}
                /* The right column is fenced out of the fullscreen linear text
                   selection: a drag across chat rows must not capture panel
                   glyphs (design doc §4.6). Panels carry their own copy action. */
                noSelect
              >
                {side}
              </Box>
            </TerminalSizeContext.Provider>
          </SurfaceEdgesContext.Provider>
        </>
      )}
    </Box>
  )
}
