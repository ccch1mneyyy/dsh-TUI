import React from 'react'
import { Box, Text } from '../ui.js'
import { useTerminalSize } from '../ink/hooks/use-terminal-size.js'
import { stringWidth } from '../ink/stringWidth.js'
import { renderDisplayMath, renderInlineMath, type MathToken } from '../terminal-utils/math.js'
import { getLatexMath, subscribeLatexMath } from '../tuiDisplayPrefs.js'

/**
 * A `$$…$$` / `\[…\]` block rendered as display-mode Unicode: fractions and
 * operator limits stacked over several rows, indented like a code-block body.
 * The indent is layout padding rather than leading spaces, so a wrapped
 * single-line fallback keeps it on every row.
 *
 * A stacked layout cannot wrap, so when it is wider than the viewport the
 * block falls back to the single-line form (which wraps like prose), and
 * when there is none of that either, to the exact source. The source is also
 * what shows while the block is still streaming (no closer yet), when the
 * formula is unsupported, and when the setting is off.
 */

/** Same viewport slack MarkdownTable and MermaidDiagram keep. */
const SAFETY_MARGIN = 4
/** Left padding in columns, matching the code-block body indent. */
const INDENT_WIDTH = 2

type Props = {
  token: MathToken
  dimColor: boolean
  /** Override terminal width (useful for testing). */
  forceWidth?: number
}

export function MathBlock({ token, dimColor, forceWidth }: Props): React.ReactNode {
  const enabled = React.useSyncExternalStore(subscribeLatexMath, getLatexMath)
  const { columns } = useTerminalSize()
  const width = Math.max(0, forceWidth ?? columns)
  const renderable = enabled && token.pending !== true

  // Layout is width-independent; a resize only re-checks the fit.
  const lines = React.useMemo(
    () => (renderable ? renderDisplayMath(token.text) : undefined),
    [renderable, token.text],
  )
  const budget = width - INDENT_WIDTH - SAFETY_MARGIN
  if (lines !== undefined && lines.every(line => stringWidth(line) <= budget)) {
    return (
      <Box paddingLeft={INDENT_WIDTH}>
        <Text dimColor={dimColor}>{lines.join('\n')}</Text>
      </Box>
    )
  }

  const linear = renderable && lines !== undefined ? renderInlineMath(token.text) : undefined
  if (linear !== undefined) {
    return (
      <Box paddingLeft={INDENT_WIDTH}>
        <Text dimColor={dimColor}>{linear}</Text>
      </Box>
    )
  }
  return <Text dimColor={dimColor}>{token.raw.trim()}</Text>
}
