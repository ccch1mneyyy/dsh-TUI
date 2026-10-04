import React from 'react'
import type { Token, Tokens } from 'marked'
import { Box, Image, Text, useTerminalImageCellSize, useTerminalImageProtocol, useTerminalImages } from '../ui.js'
import type { DOMElement } from '../ink/dom.js'
import measureElement from '../ink/measure-element.js'
import { useTerminalSize } from '../ink/hooks/use-terminal-size.js'
import { INLINE_MEDIA_MAX, inlineMediaPlaceholder, layoutInlineMedia, type InlineRow } from '../math/inline-layout.js'
import { peekMathRaster, renderMathRaster, type MathRaster, type MathRenderRequest, type MathRenderResult } from '../math/renderer.js'
import { getTheme } from '../theme.js'
import type { CliHighlight } from '../terminal-utils/cliHighlight.js'
import { formatToken } from '../terminal-utils/markdown.js'
import { isMathToken, renderInlineMath, type MathToken } from '../terminal-utils/math.js'
import { useTerminalBackground, useTheme } from './design-system/ThemeProvider.js'
import { themeInkHex } from './MathBlock.js'
import { getMathImageBacking, subscribeMathImageBacking } from '../tuiDisplayPrefs.js'
import { useMathPreviewOpener } from './mathPreview.js'

/**
 * A top-level paragraph whose inline formulas show as terminal images
 * (`mathRendering: image`, Kitty or Sixel graphics, a measured cell size).
 *
 * It renders exactly like the plain <Text> paragraph until it can switch
 * whole: the paragraph's width is measured, and every formula has settled
 * (typeset into a one-row image, or failed). The switch then happens once,
 * so formulas arriving one by one never shift the wrap points. Formulas that
 * failed or would shrink below legibility on one row keep their Unicode
 * form. Each row is laid out by `layoutInlineMedia` and drawn as text
 * pieces with one-row <Image> slots between them.
 */

type Props = {
  token: Tokens.Paragraph
  highlight: CliHighlight | null
}

const WIDTH_PROBE = ' '.repeat(1024)

/** Distinct widths applied before measurement freezes (see Divider). */
const MAX_APPLIED_MEASUREMENTS = 4

export function InlineMathParagraph({ token, highlight }: Props): React.ReactNode {
  const plain = React.useMemo(() => formatToken(token, 0, null, null, highlight).trim(), [token, highlight])
  const formulas = React.useMemo(() => collectInlineMath(token).slice(0, INLINE_MEDIA_MAX), [token])
  const graphics = useTerminalImages(formulas.length > 0)
  const protocol = useTerminalImageProtocol()
  const cellSize = useTerminalImageCellSize()
  const [themeName] = useTheme()
  const color = themeInkHex(getTheme(themeName).text)
  const previewMath = useMathPreviewOpener()
  const backdrop = React.useSyncExternalStore(subscribeMathImageBacking, getMathImageBacking)
  const composited = backdrop === 'terminal'
  const terminalBackground = useTerminalBackground()
  const width = useMeasuredWidth()

  const requests = React.useMemo((): MathRenderRequest[] | undefined => {
    if (!graphics || (protocol !== 'kitty' && protocol !== 'sixel') || cellSize === undefined || color === undefined) return undefined
    if (width.value === undefined || formulas.length === 0) return undefined
    return formulas.map(formula => ({
      tex: formula.text, display: false, color, cellSize, maxColumns: width.value!, maxRows: 1,
    }))
  }, [graphics, protocol, cellSize, color, width.value, formulas])
  const results = useSettledRasters(requests)

  const layout = React.useMemo((): { rows: InlineRow[]; media: MediaSlot[] } | undefined => {
    if (results === undefined || width.value === undefined) return undefined
    const media: MediaSlot[] = []
    const slot = new Map<MathToken, string>()
    formulas.forEach((formula, index) => {
      const result = results[index]!
      // Failures and formulas that did not fit one row keep their Unicode.
      if (!result.ok || result.raster.rows !== 1) return
      slot.set(formula, inlineMediaPlaceholder(media.length, result.raster.columns))
      media.push({ formula, raster: result.raster })
    })
    if (media.length === 0) return undefined
    const formatted = formatToken(withPlaceholders(token, slot), 0, null, null, highlight).trim()
    const rows = layoutInlineMedia(formatted, width.value, media.map(entry => entry.raster.columns))
    return rows === undefined ? undefined : { rows, media }
  }, [results, width.value, formulas, token, highlight])

  return (
    <Box ref={width.ref} flexDirection="column">
      {/* Width probe: the message column shrinks to its widest line, and
          images are wider than the Unicode they replace. A zero-height line
          of spaces stretches this box to the width the parent can grant, so
          the measurement is the available width, not the plain text's. */}
      <Box height={0} overflow="hidden">
        <Text wrap="truncate">{WIDTH_PROBE}</Text>
      </Box>
      {layout === undefined
        ? <Text>{plain}</Text>
        : layout.rows.map((row, rowIndex) => (
          <Box
            key={rowIndex}
            flexDirection="row"
            height={1}
            softWrapContinuation={row.continuation ? layout.rows[rowIndex - 1]?.width : undefined}
          >
            {row.pieces.map((piece, pieceIndex) => {
              if (piece.kind === 'text') {
                return (
                  <Box key={`t${pieceIndex}`} width={piece.width} flexShrink={0}>
                    <Text wrap="truncate">{piece.text}</Text>
                  </Box>
                )
              }
              const { formula, raster } = layout.media[piece.index]!
              // Keyed by the formula slot, so an unchanged layout keeps the
              // same image node (placements follow node identity). The
              // transcript presentation is what lets Sixel paint the one-row
              // slot at all, and crops instead of dropping it at a viewport
              // edge — the same contract block formulas use.
              const formulaRequest = requests?.[piece.index]
              const painted = (
                <Image {...(composited ? {} : { transparent: true })} lineArt presentation="transcript" source={raster.source} width={piece.columns} height={1} alt={formula.text} copyText={formula.raw}>
                  <Text dimColor wrap="truncate">{renderInlineMath(formula.text) ?? formula.raw}</Text>
                </Image>
              )
              const image = composited
                ? (
                  <Box width={piece.columns} height={1} flexShrink={0} backgroundColor={terminalBackground}>
                    {painted}
                  </Box>
                )
                : painted
              return previewMath === undefined || formulaRequest === undefined
                ? <React.Fragment key={`m${piece.index}:${raster.key}`}>{image}</React.Fragment>
                : (
                  <Box key={`m${piece.index}:${raster.key}`} onClick={event => { event.stopImmediatePropagation(); previewMath({ tex: formula.text, request: formulaRequest, source: raster.source }) }}>
                    {image}
                  </Box>
                )
            })}
          </Box>
        ))}
    </Box>
  )
}

type MediaSlot = { readonly formula: MathToken; readonly raster: MathRaster }

/** Inline math tokens of a paragraph, in reading order. */
function collectInlineMath(token: Token): MathToken[] {
  const found: MathToken[] = []
  const walk = (tokens: readonly Token[] | undefined): void => {
    for (const child of tokens ?? []) {
      if (isMathToken(child)) found.push(child)
      else walk((child as { tokens?: Token[] }).tokens)
    }
  }
  walk((token as { tokens?: Token[] }).tokens)
  return found
}

/** A copy of `token` whose listed math tokens format as placeholder runs. */
function withPlaceholders<T extends Token>(token: T, slot: ReadonlyMap<MathToken, string>): T {
  const children = (token as { tokens?: Token[] }).tokens
  if (children === undefined) return token
  return {
    ...token,
    tokens: children.map(child => {
      const placeholder = isMathToken(child) ? slot.get(child) : undefined
      return placeholder !== undefined
        ? { type: 'escape', raw: child.raw, text: placeholder } as Tokens.Escape
        : withPlaceholders(child, slot)
    }),
  }
}

/**
 * Results for every request once all have settled; a cached set is used on
 * the first render (a paragraph scrolled back into view switches at once).
 */
function useSettledRasters(requests: readonly MathRenderRequest[] | undefined): readonly MathRenderResult[] | undefined {
  const key = requests === undefined ? undefined : requests.map(requestKey).join('\u0001')
  const cached = React.useMemo(() => {
    if (requests === undefined) return undefined
    const peeked = requests.map(peekMathRaster)
    return peeked.every(result => result !== undefined) ? peeked as MathRenderResult[] : undefined
    // `key` captures every field of every request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  const [settled, setSettled] = React.useState<{ readonly key: string; readonly results: readonly MathRenderResult[] }>()
  React.useEffect(() => {
    if (requests === undefined || cached !== undefined || key === undefined) return
    let live = true
    void Promise.all(requests.map(renderMathRaster)).then(results => {
      if (live) setSettled({ key, results })
    })
    return () => { live = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  if (cached !== undefined) return cached
  return settled !== undefined && settled.key === key ? settled.results : undefined
}

function requestKey(request: MathRenderRequest): string {
  return [request.tex, request.color, request.cellSize.width, request.cellSize.height, request.maxColumns, request.maxRows].join('\u0000')
}

/**
 * The laid-out width of the paragraph box. Its width comes from the parent,
 * not from its content, but the guard from Divider still bounds how many
 * distinct widths are applied per terminal width in case a layout ever
 * feeds back.
 */
function useMeasuredWidth(): { ref: React.RefObject<DOMElement | null>; value: number | undefined } {
  const { columns } = useTerminalSize()
  const ref = React.useRef<DOMElement | null>(null)
  const [value, setValue] = React.useState<number>()
  const negotiation = React.useRef({ columns, applied: [] as number[], frozen: false })
  React.useLayoutEffect(() => {
    const node = ref.current
    if (node === null) return
    const state = negotiation.current
    if (state.columns !== columns) {
      state.columns = columns
      state.applied = []
      state.frozen = false
    }
    if (state.frozen) return
    const measured = Math.floor(measureElement(node).width)
    if (measured <= 0 || measured === value) return
    if (state.applied.includes(measured) || state.applied.length >= MAX_APPLIED_MEASUREMENTS) {
      state.frozen = true
      return
    }
    state.applied.push(measured)
    setValue(measured)
  })
  return { ref, value }
}
