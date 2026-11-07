import React from 'react'
import type { Tokens } from 'marked'
import { Box, Image, Text, useTerminalImageCellSize, useTerminalImages } from '../ui.js'
import { useTerminalSize } from '../ink/hooks/use-terminal-size.js'
import { DEFAULT_TERMINAL_CELL_SIZE } from '../ink/terminal-image.js'
import { getTheme } from '../theme.js'
import { useTheme } from './design-system/ThemeProvider.js'
import { CodeBlockFrame } from './CodeBlockFrame.js'
import { themeInkHex } from './MathBlock.js'
import type { CliHighlight } from '../terminal-utils/cliHighlight.js'
import { getTikzRendering, subscribeTikzRendering } from '../tuiDisplayPrefs.js'
import {
  hasCompleteTikzFigure,
  isClosedCodeFence,
} from '../tikz/source.js'
import {
  peekTikzRaster,
  renderTikzRaster,
  tikzRequestKey,
  type TikzRaster,
  type TikzRenderRequest,
} from '../tikz/renderer.js'

/**
 * A ```tikz / ```tikzcd fence (or a display-math block whose body is a
 * tikzpicture/tikzcd/axis) rendered as a terminal image.
 *
 * The source block is the resting state: it shows while the setting is off,
 * while the terminal lacks graphics, while a figure is still streaming, and
 * whenever TeX rejects the figure. A balanced `\begin…\end` starts the compile
 * before the closing fence arrives — that is what keeps the transcript feeling
 * live — and the most recent successful raster stays on screen while a newer
 * source version compiles. The image never blocks the render thread: TeX is a
 * child process and sharp runs off the React commit.
 *
 * Layout follows MathBlock: an image box of exactly the raster's cells, with
 * the source text under it so a partially visible box (before the protocol
 * paint or while scrolled) still carries the figure's content.
 */

/** Same viewport slack MarkdownTable, MermaidDiagram and MathBlock keep. */
const SAFETY_MARGIN = 4
/** Left padding in columns, matching the code-block body indent. */
const INDENT_WIDTH = 2
/** Tallest image a figure may take; taller figures shrink, then keep source. */
const IMAGE_MAX_ROWS = 24

type Props = {
  /** Figure body without fences or math delimiters. */
  source: string
  /** Original source span, used by the fallback frame and copy text. */
  raw: string
  /** Fence language for the fallback header; `tex` for display-math TikZ. */
  lang?: string
  dimColor: boolean
  /** The enclosing fence or math block has its closer. */
  closed: boolean
  highlight: CliHighlight | null
  /** Override terminal width (useful for testing). */
  forceWidth?: number
}

export function TikzDiagram({ source: rawSource, raw, lang, dimColor, closed, highlight, forceWidth }: Props): React.ReactNode {
  // Whitespace-only growth (the closing fence is still a token away) must not
  // invalidate the SVG/raster cache; TeX trims the same edges.
  const source = rawSource.trim()
  const mode = React.useSyncExternalStore(subscribeTikzRendering, getTikzRendering)
  const enabled = mode !== 'source'
  const { columns } = useTerminalSize()
  const width = Math.max(0, forceWidth ?? columns)
  const budget = width - INDENT_WIDTH - SAFETY_MARGIN
  // Start compiling as soon as the figure is balanced, even if the closing
  // fence is still a few tokens away. Dimmed thinking blocks never become
  // images (an image cannot dim), and an unclosed, unbalanced fence keeps its
  // source.
  const renderable = enabled && !dimColor && source !== '' &&
    (closed || isClosedCodeFence(raw) || hasCompleteTikzFigure(source))
  const graphics = useTerminalImages(renderable && budget > 0)
  // Kitty/Sixel may answer the graphics probe but omit their pixel-cell
  // geometry. The image manager already has the same default; using it here
  // keeps a valid diagram visible instead of silently falling back to source.
  const cellSize = useTerminalImageCellSize() ?? DEFAULT_TERMINAL_CELL_SIZE
  const [themeName] = useTheme()
  const color = themeInkHex(getTheme(themeName).text)
  const request: TikzRenderRequest | undefined =
    renderable && graphics && color !== undefined && budget > 0
      ? { source, color, cellSize, maxColumns: budget, maxRows: IMAGE_MAX_ROWS }
      : undefined
  const raster = useTikzRaster(request)

  if (raster === undefined) {
    return (
      <SourceFallback
        source={source}
        raw={raw}
        {...(lang === undefined ? {} : { lang })}
        dimColor={dimColor}
        highlight={highlight}
        {...(forceWidth === undefined ? {} : { forceWidth })}
      />
    )
  }

  return (
    <Box paddingLeft={INDENT_WIDTH}>
      <Image
        transparent
        lineArt
        presentation="transcript"
        source={raster.source}
        width={raster.columns}
        height={raster.rows}
        alt={source}
        copyText={raw.trim()}
      >
        <Box width={raster.columns} height={raster.rows} overflow="hidden">
          <Text dimColor={dimColor} wrap="truncate">{source}</Text>
        </Box>
      </Image>
    </Box>
  )
}

/**
 * The source block. A fence keeps its code-block frame (header + rail, copy
 * and highlighting included); a display-math block gets the same frame with
 * a `tex` header so the reader still sees exactly what the model wrote.
 */
function SourceFallback({
  source,
  raw,
  lang,
  dimColor,
  highlight,
  forceWidth,
}: {
  source: string
  raw: string
  lang?: string
  dimColor: boolean
  highlight: CliHighlight | null
  forceWidth?: number
}): React.ReactNode {
  const token: Tokens.Code = {
    type: 'code',
    raw,
    text: source,
    lang: lang ?? 'tikz',
  }
  return <CodeBlockFrame token={token} highlight={highlight} dimColor={dimColor} {...(forceWidth === undefined ? {} : { forceWidth })} />
}

/**
 * The raster for `request`, or undefined while it renders, when it failed, or
 * when there is no request. A cached raster is used on the first render, so a
 * block scrolled back into view does not flash its fallback.
 *
 * While a new source version compiles, the last successful raster stays put:
 * a streaming figure updates as successive balanced snapshots finish instead
 * of blinking back to source on every token. A failure for the *current* key
 * clears it (the fallback is the honest state for a rejected figure).
 */
function useTikzRaster(request: TikzRenderRequest | undefined): TikzRaster | undefined {
  const key = request === undefined ? undefined : tikzRequestKey(request)
  const cached = request === undefined ? undefined : peekTikzRaster(request)
  const [settled, setSettled] = React.useState<{ readonly key: string; readonly raster?: TikzRaster }>()
  const [lastGood, setLastGood] = React.useState<TikzRaster>()

  React.useEffect(() => {
    if (request === undefined || key === undefined) return
    if (peekTikzRaster(request) !== undefined) return
    let live = true
    void renderTikzRaster(request).then(result => {
      if (!live) return
      if (result.ok) {
        setLastGood(result.raster)
        setSettled({ key, raster: result.raster })
      } else {
        setSettled({ key })
      }
    })
    return () => { live = false }
    // `key` captures every field of the request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  if (request === undefined) return undefined
  if (cached !== undefined) return cached
  if (settled !== undefined && settled.key === key) return settled.raster
  return lastGood
}

