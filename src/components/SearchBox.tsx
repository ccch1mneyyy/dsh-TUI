import React, { useCallback, useLayoutEffect, useRef, useState } from 'react'
import Box from './design-system/ThemedBox.js'
import Text from './design-system/ThemedText.js'
import type { DOMElement } from '../ink/dom.js'
import measureElement from '../ink/measure-element.js'
import { useDeclaredCursor } from '../ink/hooks/use-declared-cursor.js'
import { useTerminalSize } from '../ink/hooks/use-terminal-size.js'
import { stringWidth } from '../ink/stringWidth.js'
import { windowInput } from '../utils/windowInput.js'

/**
 * A single-line search input in a round-bordered box: `⌕ ` prefix, block
 * cursor at `cursorOffset` (inverse cell).
 * When empty and focused, a solid block caret sits at the start and the
 * placeholder is right-aligned (dimmed) — kept off the caret's cell so the
 * terminal-painted IME preedit (pinyin) can never be overlaid on it during
 * CJK composition.
 *
 * The query row is strictly single-line: an overlong query is windowed
 * around the caret (horizontal scroll) instead of wrapping, so the native
 * cursor declaration below stays exact for any query length.
 */
export function SearchBox({
  query,
  placeholder = 'Search…',
  isFocused,
  isTerminalFocused,
  prefix = '⌕',
  width,
  cursorOffset,
  borderless = false,
}: {
  query: string
  placeholder?: string
  isFocused: boolean
  isTerminalFocused: boolean
  prefix?: string
  width?: number | string
  cursorOffset?: number
  borderless?: boolean
}): React.ReactNode {
  const offset = cursorOffset ?? query.length
  const borderStyle = borderless ? undefined : 'round'
  const borderColor = isFocused ? 'suggestion' : undefined
  const borderDimColor = !isFocused
  // Focused + empty + terminal focused: inline caret row (block caret at the
  // start, placeholder right-aligned) instead of the inline placeholder.
  const inlineCaret = isFocused && query === '' && isTerminalFocused

  // Content width of the box in display cells. Measured from yoga after
  // layout (resize re-layouts without any prop/state change, so measure on
  // every commit — the setState is a no-op when the width is unchanged);
  // the terminal-columns estimate only covers the very first frame.
  const { columns } = useTerminalSize()
  const chrome = borderless ? 0 : 4 // 2 border cells + paddingX 2
  const [measuredWidth, setMeasuredWidth] = useState<number | null>(null)
  const contentWidth = measuredWidth ?? Math.max(8, columns - chrome - 2)

  const prefixWidth = stringWidth(`${prefix} `)
  const win = windowInput(query, offset, contentWidth - prefixWidth)

  // Park the native terminal cursor at the caret so IME preedit (pinyin)
  // renders inline at the input instead of the screen's bottom row (same
  // mechanism as PromptInput). The declaration hangs on the outer Box —
  // content stays a single Text (splitting it into flex siblings
  // reorders/drops glyphs on narrow widths), so the position is computed:
  // border (1) + paddingX (1) per edge when bordered, then the `prefix `
  // run and the windowed before-caret text, all in display cells.
  const showCaret = isFocused && isTerminalFocused
  // Clamp into the box's content area: on absurdly narrow layouts the
  // prefix alone can meet or exceed the content width, and the park must
  // never land outside the box's rect.
  const edge = borderless ? 0 : 2
  const maxColumn = edge + Math.max(0, contentWidth - 1)
  const caretColumn = Math.min(edge + prefixWidth + win.caretColumn, maxColumn)
  const declarationRef = useDeclaredCursor({
    line: borderless ? 0 : 1,
    column: caretColumn,
    active: showCaret,
  })
  const boxNodeRef = useRef<DOMElement | null>(null)
  const boxRef = useCallback(
    (node: DOMElement | null) => {
      boxNodeRef.current = node
      declarationRef(node)
    },
    [declarationRef],
  )
  useLayoutEffect(() => {
    const node = boxNodeRef.current
    if (!node) return
    // Layout runs before layout effects (reconciler resetAfterCommit), so a
    // zero raw width means a genuinely zero-width box — but a zero CONTENT
    // width (chrome eats the whole box) is a real, must-clamp case.
    const raw = measureElement(node).width
    if (raw > 0) {
      const w = Math.max(0, raw - chrome)
      setMeasuredWidth(prev => (prev === w ? prev : w))
    }
  })

  let content: React.ReactNode
  if (isFocused) {
    if (query) {
      content = isTerminalFocused ? (
        <>
          <Text>{win.before}</Text>
          <Text inverse>{win.at}</Text>
          {win.after !== '' && <Text>{win.after}</Text>}
        </>
      ) : (
        <Text>{query}</Text>
      )
    } else if (!isTerminalFocused) {
      content = <Text dimColor>{placeholder}</Text>
    }
  } else {
    content = query ? <Text>{query}</Text> : <Text>{placeholder}</Text>
  }

  return (
    <Box
      ref={boxRef}
      flexShrink={0}
      borderStyle={borderStyle}
      borderColor={borderColor}
      borderDimColor={borderDimColor}
      paddingX={borderless ? 0 : 1}
      width={width}
    >
      {inlineCaret ? (
        <Box flexDirection="row" width="100%">
          <Text>{prefix} </Text>
          <Text inverse> </Text>
          <Box flexGrow={1} />
          <Text dimColor wrap="truncate">
            {placeholder}
          </Text>
        </Box>
      ) : (
        <Text dimColor={!isFocused} wrap="truncate-end">
          {prefix} {content}
        </Text>
      )}
    </Box>
  )
}
