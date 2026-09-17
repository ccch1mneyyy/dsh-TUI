import React from 'react'
import type { Tokens } from 'marked'
import { Box, Text } from '../ui.js'
import { useTerminalSize } from '../ink/hooks/use-terminal-size.js'
import { stringWidth } from '../ink/stringWidth.js'
import { getTheme } from '../theme.js'
import { useTheme } from './design-system/ThemeProvider.js'
import { formatToken } from '../terminal-utils/markdown.js'
import type { CliHighlight } from '../terminal-utils/cliHighlight.js'
import {
  getMermaidEnginePromise,
  paintMermaidArt,
  peekMermaidEngine,
  renderMermaid,
  type MermaidEngine,
} from '../terminal-utils/mermaid.js'
import { getMermaidDiagrams, subscribeMermaidDiagrams } from '../tuiDisplayPrefs.js'
import { t } from '../i18n.js'

/**
 * A ```mermaid fence rendered as Unicode box-drawing art.
 *
 * The art is shown on its own, indented like a code-block body; the
 * ```mermaid fence line is a code-block affordance and a diagram needs none.
 * Whenever there is no art to show (setting off, engine still loading or
 * unavailable, unsupported diagram type, nothing parsed, or the layout is
 * wider than the viewport) the block falls back to the ordinary code-block
 * rendering — fence line included, because that IS a code block — and a
 * too-wide diagram adds a caption with the width it needs.
 */

/** Same viewport slack MarkdownTable keeps for gutters and message insets. */
const SAFETY_MARGIN = 4
const INDENT = '  '
/** Column budget the indent takes: display width, not string length. */
const INDENT_WIDTH = stringWidth(INDENT)

type Props = {
  token: Tokens.Code
  highlight: CliHighlight | null
  dimColor: boolean
  /** Override terminal width (useful for testing). */
  forceWidth?: number
}

/** The lazily loaded engine: available on first render once any earlier
 *  diagram loaded it, otherwise resolved after mount. */
function useMermaidEngine(): MermaidEngine | null {
  const [engine, setEngine] = React.useState<MermaidEngine | null>(() => peekMermaidEngine() ?? null)
  React.useEffect(() => {
    if (engine !== null) return
    let mounted = true
    void getMermaidEnginePromise().then(loaded => {
      if (mounted && loaded !== null) setEngine(loaded)
    })
    return () => {
      mounted = false
    }
  }, [engine])
  return engine
}

export function MermaidDiagram({ token, highlight, dimColor, forceWidth }: Props): React.ReactNode {
  const enabled = React.useSyncExternalStore(subscribeMermaidDiagrams, getMermaidDiagrams)
  const engine = useMermaidEngine()
  const { columns } = useTerminalSize()
  const [themeName] = useTheme()
  const theme = getTheme(themeName)
  const width = Math.max(0, forceWidth ?? columns)

  // Layout is width-independent (the engine draws at natural size), so a
  // resize or theme switch only re-paints; streaming changes token.text
  // every frame and re-lays out — sub-millisecond for a warm engine.
  const art = React.useMemo(
    () => (enabled && engine !== null ? renderMermaid(engine, token.text) : null),
    [enabled, engine, token.text],
  )

  if (art === null || art.width > width - INDENT_WIDTH - SAFETY_MARGIN) {
    return (
      <Box flexDirection="column">
        <Text dimColor={dimColor}>{formatToken(token, 0, null, null, highlight).trimEnd()}</Text>
        {art !== null && (
          <Text color="inactive">{INDENT + t('mermaid-too-wide', { width: art.width })}</Text>
        )}
      </Box>
    )
  }

  return (
    <Text dimColor={dimColor}>
      {paintMermaidArt(art, theme).map(line => INDENT + line).join('\n')}
    </Text>
  )
}
