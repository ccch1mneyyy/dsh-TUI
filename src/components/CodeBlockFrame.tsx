import React from 'react'
import type { Tokens } from 'marked'
import { Box, NoSelect, Text } from '../ui.js'
import { useTerminalSize } from '../ink/hooks/use-terminal-size.js'
import { colorize } from '../ink/colorize.js'
import type { Color } from '../ink/styles.js'
import { getTheme } from '../theme.js'
import { useTheme } from './design-system/ThemeProvider.js'
import { codeLanguageTag, formatCodeBody, formatToken } from '../terminal-utils/markdown.js'
import type { CliHighlight } from '../terminal-utils/cliHighlight.js'

/**
 * A fenced code block rendered as a light frame (design spec §1):
 *
 *     ┌─ ts ──────────────────────
 *     │   const answer = await agent.run()
 *     │   return answer
 *
 * The top edge carries only the left corner, the language label and a
 * subtle divider; every body row gets the rail and one column of padding;
 * there is no right wall or bottom edge - chat transcripts want the block
 * visible without paying a card's height. Hybrid architecture (~7 Yoga
 * nodes per block): the body stays ONE ANSI string (the streaming
 * stable-prefix memo keeps working), only header/rail/padding become
 * structural so wrapped continuation rows keep the gutter.
 *
 * Copy contract (§1.2): header and rail are NoSelect components, the body
 * is a plain selectable Text. A selection anchored on the body copies the
 * clean code; a selection anchored on the decorations copies just the
 * decorated region - the existing anchor semantics, explicitly accepted.
 * The pure-ANSI fence stays as the fallback for very narrow terminals
 * (net body width < 8) where a frame would only squeeze the code.
 */

/** Same viewport slack MarkdownTable/MermaidDiagram keep for gutters and
 *  message insets: the content column is the terminal width minus this. */
const SAFETY_MARGIN = 4
/** Content column width that earns the full-width dash header. */
const WIDE_HEADER_MIN_COLUMNS = 56
/** Below this NET body width the frame falls back to the ANSI fence. */
const MIN_NET_BODY_WIDTH = 8
/** Rail column + the single padding column. */
const FRAME_OVERHEAD = 2

type Props = {
  token: Tokens.Code
  highlight: CliHighlight | null
  /** Dim the body (thinking blocks); decorations stay theme-muted. */
  dimColor?: boolean
  /** Override terminal width (useful for testing). */
  forceWidth?: number
}

export function CodeBlockFrame({ token, highlight, dimColor = false, forceWidth }: Props): React.ReactNode {
  const { columns } = useTerminalSize()
  const [themeName] = useTheme()
  const theme = getTheme(themeName)
  // Theme values are raw color strings; the ink-level border props take the
  // Color type directly (NoSelect is not theme-aware like ThemedBox).
  const subtle = theme.subtle as Color
  const width = Math.max(0, forceWidth ?? columns)
  const contentWidth = width - SAFETY_MARGIN
  const label = codeLanguageTag(token) || 'code'
  const body = formatCodeBody(token, highlight)

  if (contentWidth - FRAME_OVERHEAD < MIN_NET_BODY_WIDTH) {
    // Too narrow to frame: keep the existing pure-ANSI Kimi fence so the
    // block never stretches or squeezes the surrounding column.
    return <Text dimColor={dimColor}>{formatToken(token, 0, null, null, highlight).trimEnd()}</Text>
  }

  return (
    <Box flexDirection="column" width="100%">
      {contentWidth >= WIDE_HEADER_MIN_COLUMNS ? (
        <NoSelect
          borderStyle="single"
          borderTop
          borderLeft
          borderRight={false}
          borderBottom={false}
          borderColor={subtle}
          borderText={{
            content: colorize(` ${label} `, theme.subtle, 'foreground'),
            position: 'top',
            align: 'start',
            offset: 1,
          }}
        />
      ) : (
        <NoSelect>
          <Text color="subtle">{'┌─ ' + label}</Text>
        </NoSelect>
      )}
      <Box flexDirection="row">
        <NoSelect
          borderStyle="single"
          borderLeft
          borderTop={false}
          borderRight={false}
          borderBottom={false}
          borderColor={subtle}
        />
        <Box paddingLeft={1}>
          <Text dimColor={dimColor}>{body}</Text>
        </Box>
      </Box>
    </Box>
  )
}
