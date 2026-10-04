import React from 'react'
import type { Tokens } from 'marked'
import { Box, NoSelect, Text } from '../ui.js'
import { useTerminalSize } from '../ink/hooks/use-terminal-size.js'
import { colorize } from '../ink/colorize.js'
import type { Color, TextDecoration } from '../ink/styles.js'
import { getTheme } from '../theme.js'
import { useTheme } from './design-system/ThemeProvider.js'
import { codeLanguageTag, formatCodeBody, formatToken } from '../terminal-utils/markdown.js'
import { getCodeFrameStyle, subscribeCodeFrameStyle } from '../tuiDisplayPrefs.js'
import type { CliHighlight } from '../terminal-utils/cliHighlight.js'

/**
 * A fenced code block rendered as a light frame (design spec §1):
 *
 *     ┌─ ts ─────────────────
 *     │   const answer = await agent.run()
 *     │   return answer
 *
 * The top edge carries only the left corner, the language label and a
 * subtle divider; every body row gets the rail and one column of padding;
 * there is no right wall or bottom edge - chat transcripts want the block
 * visible without paying a card's height.
 *
 * Two frame engines share this component's visual contract (spec §2):
 *
 * - typed (default): ONE ink-text leaf. The header row and the per-row
 *   rail/padding are typed decoration carried by the Text paint - zero
 *   structural Yoga nodes per block, so the streaming stable-prefix memo
 *   and the paint budget behave exactly as for a plain ANSI string.
 * - hybrid (DSH_TUI_CODE_FRAME=hybrid): the Batch B layout - header/rail
 *   as NoSelect components around the body Text (~7 Yoga nodes/block).
 *   Retained as the fallback: if the typed path ever fails the streaming
 *   performance gate or the selection contract, the env switch restores
 *   it without a code change.
 *
 * Copy contract (§1.2): header and rail are excluded from selection and
 * the body is selectable - in the typed engine via the decoration's
 * noSelect metadata (same Screen.noSelect bitmap the components used). A
 * selection anchored on the body copies the clean code; a selection
 * anchored on the decorations copies just the decorated region - the
 * existing anchor semantics, explicitly accepted. The pure-ANSI fence
 * stays as the fallback for very narrow terminals (net body width < 8)
 * where a frame would only squeeze the code.
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

/**
 * Which frame engine renders code fences. `typed` is the default;
 * `DSH_TUI_CODE_FRAME=hybrid` restores the Batch B component layout
 * (spec §2: hybrid stays the fallback, never a hard cut).
 */
export function codeFrameEngine(): 'typed' | 'hybrid' {
  return process.env.DSH_TUI_CODE_FRAME === 'hybrid' ? 'hybrid' : 'typed'
}

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
  // Live setting (settings `dsh-tui.codeFrameStyle`): read at render
  // time so settled blocks re-render when the style flips; the store
  // mirrors both the /settings edit and cordis.yml.
  const frameStyle = React.useSyncExternalStore(subscribeCodeFrameStyle, getCodeFrameStyle)
  const [themeName] = useTheme()
  const theme = getTheme(themeName)
  // Theme values are raw color strings; the ink-level border props take the
  // Color type directly (NoSelect is not theme-aware like ThemedBox).
  const subtle = theme.subtle as Color
  const width = Math.max(0, forceWidth ?? columns)
  const contentWidth = width - SAFETY_MARGIN
  const label = codeLanguageTag(token) || 'code'
  const body = formatCodeBody(token, highlight)

  // Hooks run before every branch: the narrow fallback and the hybrid
  // engine return early, so the typed memos must be unconditional.
  const headerText = React.useMemo(() => {
    // The fixed part: corner, dash, label. The WIDE frame keeps one
    // trailing space before the fill run; the narrow label stays tight
    // (`┌─ ts` exactly - a trailing space would claim one extra
    // noSelect column the hybrid header never marked).
    const wide = contentWidth >= WIDE_HEADER_MIN_COLUMNS
    return colorize('┌─ ' + label + (wide ? ' ' : ''), theme.subtle, 'foreground')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [label, theme.subtle, contentWidth])
  const headerFill = React.useMemo(() => {
    if (contentWidth < WIDE_HEADER_MIN_COLUMNS) return undefined
    return colorize('─', theme.subtle, 'foreground')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [theme.subtle, contentWidth])
  const decoration = React.useMemo<TextDecoration>(() => {
    if (body === '') {
      // Header-only frame: the empty fenced block still shows its rail
      // header row, nothing else.
      return { header: headerText, headerFill }
    }
    return {
      header: headerText,
      headerFill,
      prefix: {
        // Rail glyph colored subtle; the padding column stays unstyled and
        // selectable (spec §1.2: only rail/header are excluded).
        text: colorize('│', theme.subtle, 'foreground') + ' ',
        width: FRAME_OVERHEAD,
        noSelect: 1,
      },
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [headerText, headerFill, body, theme.subtle])

  if (contentWidth - FRAME_OVERHEAD < MIN_NET_BODY_WIDTH) {
    // Too narrow to frame: keep the existing pure-ANSI Kimi fence so the
    // block never stretches or squeezes the surrounding column.
    return <Text dimColor={dimColor}>{formatToken(token, 0, null, null, highlight).trimEnd()}</Text>
  }

  if (frameStyle === 'full') {
    // The closed form is structural by nature (the right wall must
    // follow the content column and stay continuous across wrapped
    // rows), so it rides the hybrid layout with the wall and bottom
    // edge added - regardless of the typed/hybrid engine switch.
    return (
      <CodeBlockFrameFull
        contentWidth={contentWidth}
        label={label}
        body={body}
        subtle={subtle}
        themeSubtle={theme.subtle}
        dimColor={dimColor}
      />
    )
  }

  if (codeFrameEngine() === 'hybrid') {
    return (
      <CodeBlockFrameHybrid
        contentWidth={contentWidth}
        label={label}
        body={body}
        subtle={subtle}
        themeSubtle={theme.subtle}
        dimColor={dimColor}
      />
    )
  }

  // Typed engine: one ink-text leaf whose paint carries the frame.
  return (
    <Text dimColor={dimColor} decoration={decoration}>{body}</Text>
  )
}

/**
 * The `full` style: the hybrid layout with the box closed - a right wall
 * (a layout border, so it stays continuous across wrapped rows and
 * follows the content column) and a bottom edge under the whole block.
 * Header/rail/wall/bottom stay NoSelect; the body (and its padding
 * column) stay selectable - the same copy contract as the light frame.
 */
function CodeBlockFrameFull({
  contentWidth,
  label,
  body,
  subtle,
  themeSubtle,
  dimColor,
}: {
  contentWidth: number
  label: string
  body: string
  subtle: Color
  themeSubtle: string
  dimColor: boolean
}): React.ReactNode {
  return (
    <Box flexDirection="column" width="100%">
      <NoSelect
        borderStyle="single"
        borderTop
        borderLeft
        borderRight
        borderBottom={false}
        borderColor={subtle}
        borderText={{
          content: colorize(' ' + label + ' ', themeSubtle, 'foreground'),
          position: 'top',
          align: 'start',
          offset: 1,
        }}
      />
      <Box flexDirection="row">
        <NoSelect
          borderStyle="single"
          borderLeft
          borderTop={false}
          borderRight={false}
          borderBottom={false}
          borderColor={subtle}
        />
        <Box paddingLeft={1} flexGrow={1}>
          <Text dimColor={dimColor}>{body}</Text>
        </Box>
        <NoSelect
          borderStyle="single"
          borderRight
          borderTop={false}
          borderLeft={false}
          borderBottom={false}
          borderColor={subtle}
        />
      </Box>
      <NoSelect
        borderStyle="single"
        borderLeft
        borderRight
        borderBottom
        borderTop={false}
        borderColor={subtle}
      />
    </Box>
  )
}

/** The Batch B hybrid layout, kept verbatim as the fallback engine. */
function CodeBlockFrameHybrid({
  contentWidth,
  label,
  body,
  subtle,
  themeSubtle,
  dimColor,
}: {
  contentWidth: number
  label: string
  body: string
  subtle: Color
  themeSubtle: string
  dimColor: boolean
}): React.ReactNode {
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
            content: colorize(' ' + label + ' ', themeSubtle, 'foreground'),
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
