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
 * (tooltips) keep their math. Geometry == null renders children bare —
 * the collapsed layout is byte-identical to today.
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
  if (geometry === null) return <>{children}</>
  const chatEdges = { left: outerEdges.left, right: 0 }
  const panelEdges = { left: 0, right: outerEdges.right }
  return (
    <Box flexDirection="row" flexGrow={1} flexShrink={1} overflow="hidden">
      <SurfaceEdgesContext.Provider value={chatEdges}>
        <TerminalSizeContext.Provider value={{ columns: geometry.chat, rows, screenRows }}>
          <Box
            flexDirection="column"
            width={geometry.chat}
            flexShrink={0}
            overflow="hidden"
            onClick={onActivateChat}
          >
            {children}
          </Box>
        </TerminalSizeContext.Provider>
      </SurfaceEdgesContext.Provider>
      {/* Junction contract: SidePanelColumn keeps its PanelBar on row 0,
          a rule on row 1, and the hint + its rule as the last two rows, so
          the seam tees at exactly 1 and rows-2. */}
      <DividerColumn focused={focus === 'panel'} rows={rows} junctionRows={[1, Math.max(1, rows - 2)]} />
      <SurfaceEdgesContext.Provider value={panelEdges}>
        <TerminalSizeContext.Provider value={{ columns: geometry.panel, rows, screenRows }}>
          <Box
            flexDirection="column"
            width={geometry.panel}
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
    </Box>
  )
}
