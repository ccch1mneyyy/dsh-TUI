import React from 'react'
import { Box, Image, Text, useTerminalImageCellSize, useTerminalImages } from '../ui.js'
import { useTerminalSize } from '../ink/hooks/use-terminal-size.js'
import { stringWidth } from '../ink/stringWidth.js'
import { peekMathRaster, renderMathRaster, type MathRaster, type MathRenderRequest } from '../math/renderer.js'
import { getTheme } from '../theme.js'
import { LARGE_DISPLAY_EX_TO_CELL_HEIGHT, XLARGE_DISPLAY_EX_TO_CELL_HEIGHT } from '../math/layout.js'
import { renderDisplayMath, renderInlineMath, type MathToken } from '../terminal-utils/math.js'
import { getMathImageBacking, getMathImageScale, getMathRendering, subscribeMathImageBacking, subscribeMathImageScale, subscribeMathRendering } from '../tuiDisplayPrefs.js'
import { useTerminalBackground, useTheme } from './design-system/ThemeProvider.js'
import { useMathPreviewOpener } from './mathPreview.js'

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
 *
 * With `mathRendering: image`, a complete block is typeset by MathJax and
 * shown as a terminal image in the theme's text color when the terminal
 * supports graphics and reports its cell size. The Unicode rendering shows
 * until the image is ready and stays whenever any step fails, so the image
 * path can only upgrade a block, never lose it.
 */

/** Same viewport slack MarkdownTable and MermaidDiagram keep. */
const SAFETY_MARGIN = 4
/** Left padding in columns, matching the code-block body indent. */
const INDENT_WIDTH = 2
/** Tallest image a block may take; taller formulas shrink to fit. */
const IMAGE_MAX_ROWS = 16

type Props = {
  token: MathToken
  dimColor: boolean
  /** Override terminal width (useful for testing). */
  forceWidth?: number
}

export function MathBlock({ token, dimColor, forceWidth }: Props): React.ReactNode {
  const mode = React.useSyncExternalStore(subscribeMathRendering, getMathRendering)
  // Display size is a user choice now (settings `mathImageScale`): bigger
  // images are also the only way a terminal gets more pixels per stroke.
  const imageScale = React.useSyncExternalStore(subscribeMathImageScale, getMathImageScale)
  const exToCellHeight = imageScale === 'xlarge'
    ? XLARGE_DISPLAY_EX_TO_CELL_HEIGHT
    : imageScale === 'large' ? LARGE_DISPLAY_EX_TO_CELL_HEIGHT : undefined
  // What sits behind the formula: transparent (only its own pixels) or the
  // terminal's own background colour, composited first.
  const backdrop = React.useSyncExternalStore(subscribeMathImageBacking, getMathImageBacking)
  const composited = backdrop === 'terminal'
  const terminalBackground = useTerminalBackground()
  const enabled = mode !== 'source'
  const { columns } = useTerminalSize()
  const width = Math.max(0, forceWidth ?? columns)
  const renderable = enabled && token.pending !== true
  const budget = width - INDENT_WIDTH - SAFETY_MARGIN

  // Dimmed blocks (e.g. inside thinking) keep text: an image cannot dim.
  const wantImage = mode === 'image' && renderable && !dimColor && budget > 0
  const graphics = useTerminalImages(wantImage)
  const cellSize = useTerminalImageCellSize()
  const [themeName] = useTheme()
  const color = themeInkHex(getTheme(themeName).text)
  const request: MathRenderRequest | undefined = wantImage && graphics && cellSize !== undefined && color !== undefined
    ? {
        tex: token.text, display: true, color, cellSize, maxColumns: budget, maxRows: IMAGE_MAX_ROWS,
        ...(exToCellHeight === undefined ? {} : { baseExToCellHeight: exToCellHeight }),
      }
    : undefined
  const raster = useMathRaster(request)
  const previewMath = useMathPreviewOpener()

  // Layout is width-independent; a resize only re-checks the fit.
  const lines = React.useMemo(
    () => (renderable ? renderDisplayMath(token.text) : undefined),
    [renderable, token.text],
  )
  if (raster !== undefined && request !== undefined) {
    // What the box shows when the renderer does not place the image (e.g. a
    // Kitty image partly scrolled out before cropping is available): the
    // stacked Unicode layout when it fits the box, else the one-line form
    // wrapped across it, so every visible row of the box carries the formula.
    const stackedFits = lines !== undefined && lines.length <= raster.rows &&
      lines.every(line => stringWidth(line) <= raster.columns)
    // A formula is line art: the transparent Sixel mask stays solid instead
    // of dithering, so fraction bars and hairline strokes keep their ink.
    const painted = (
      <Image {...(composited ? {} : { transparent: true })} lineArt presentation="transcript" source={raster.source} width={raster.columns} height={raster.rows} alt={token.text} copyText={token.raw.trim()}>
        <Box width={raster.columns} height={raster.rows} overflow="hidden">
          <Text dimColor wrap={stackedFits ? 'truncate' : 'wrap'}>
            {stackedFits ? lines.join('\n') : renderInlineMath(token.text) ?? token.text}
          </Text>
        </Box>
      </Image>
    )
    // A composited formula needs a real surface: the slot carries the terminal
    // background, so both the placement and its cells use that colour.
    const image = composited
      ? (
        <Box width={raster.columns} height={raster.rows} flexShrink={0} backgroundColor={terminalBackground}>
          {painted}
        </Box>
      )
      : painted
    return (
      <Box paddingLeft={INDENT_WIDTH}>
        {previewMath === undefined
          ? image
          : (
            // A click opens the preview card instead of toggling the row or
            // starting a selection underneath (same contract as thumbnails).
            <Box onClick={event => { event.stopImmediatePropagation(); previewMath({ tex: token.text, request, source: raster.source }) }}>
              {image}
            </Box>
          )}
      </Box>
    )
  }
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

/**
 * The typeset image for `request`, or undefined while it renders, when it
 * failed, or when there is no request. A cached result is used on the first
 * render, so a block scrolled back into view does not flash its fallback.
 */
function useMathRaster(request: MathRenderRequest | undefined): MathRaster | undefined {
  const cached = request === undefined ? undefined : peekMathRaster(request)
  const [settled, setSettled] = React.useState<{ readonly request: MathRenderRequest; readonly raster?: MathRaster }>()
  const pending = request !== undefined && cached === undefined ? request : undefined
  const key = pending === undefined ? undefined : requestKey(pending)
  React.useEffect(() => {
    if (pending === undefined) return
    let live = true
    void renderMathRaster(pending).then(result => {
      if (live) setSettled({ request: pending, raster: result.ok ? result.raster : undefined })
    })
    return () => { live = false }
    // `key` captures every field of the request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  if (cached !== undefined) return cached.ok ? cached.raster : undefined
  return settled !== undefined && request !== undefined && requestKey(settled.request) === requestKey(request)
    ? settled.raster
    : undefined
}

function requestKey(request: MathRenderRequest): string {
  return [request.tex, request.color, request.cellSize.width, request.cellSize.height, request.maxColumns, request.maxRows, request.baseExToCellHeight ?? ''].join('\u0000')
}

/** A theme color as `#rrggbb`, or undefined for ANSI names the image cannot match. */
export function themeInkHex(color: string): string | undefined {
  if (/^#[0-9a-f]{6}$/i.test(color)) return color
  const match = /^rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$/.exec(color)
  if (match === null) return undefined
  return `#${match.slice(1, 4).map(channel => Math.min(255, Number(channel)).toString(16).padStart(2, '0')).join('')}`
}
