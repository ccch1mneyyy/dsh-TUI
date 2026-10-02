/**
 * SidePanelLayout: owns the two-column row — chat surface left, divider,
 * side-panel surface right (design doc §4.1). It decides nothing about
 * state: useSidePanel hands it a resolved geometry and this component only
 * arranges boxes and re-provides contexts.
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
import type { SidePanelFocus } from './useSidePanel.js'
import type { SidePanelSplit } from './dimensions.js'

export interface SidePanelLayoutProps {
  readonly geometry: SidePanelSplit | null
  readonly focus: SidePanelFocus
  /** Right-column content (PanelBar + PanelHost + hint). */
  readonly side: React.ReactNode
  readonly onActivateChat?: () => void
  readonly onActivatePanel?: () => void
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
}: {
  readonly focused: boolean
  readonly rows: number
  readonly junctionRows: readonly number[]
}): React.ReactNode {
  const junctions = new Set(junctionRows)
  const glyphs: string[] = []
  for (let y = 0; y < Math.max(1, rows); y += 1) {
    glyphs.push(junctions.has(y) ? '├' : '│')
  }
  return (
    <Box width={1} flexShrink={0} overflow="hidden">
      <Text color={focused ? 'accent' : 'inactive'}>{glyphs.join('\n')}</Text>
    </Box>
  )
}

export function SidePanelLayout({
  geometry,
  focus,
  side,
  onActivateChat,
  onActivatePanel,
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
          <DividerColumn focused={focus === 'panel'} rows={rows} junctionRows={[1, Math.max(1, rows - 2)]} />
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
