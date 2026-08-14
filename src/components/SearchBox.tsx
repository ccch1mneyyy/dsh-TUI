import React from 'react'
import Box from '../ink/components/Box.js'
import Text from '../ink/components/Text.js'

/**
 * A single-line search input in the round-bordered box of the leak's
 * SearchBox: `⌕ ` prefix, block cursor at `cursorOffset` (inverse cell).
 * When empty and focused, a solid block caret sits at the start and the
 * placeholder is right-aligned (dimmed) — kept off the caret's cell so the
 * terminal-painted IME preedit (pinyin) can never be overlaid on it during
 * CJK composition.
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

  let content: React.ReactNode
  if (isFocused) {
    if (query) {
      content = isTerminalFocused ? (
        <>
          <Text>{query.slice(0, offset)}</Text>
          <Text inverse>{offset < query.length ? query[offset] : ' '}</Text>
          {offset < query.length && <Text>{query.slice(offset + 1)}</Text>}
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
        <Text dimColor={!isFocused}>
          {prefix} {content}
        </Text>
      )}
    </Box>
  )
}
