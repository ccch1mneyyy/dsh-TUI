// Tab expansion, inspired by Ghostty's Tabstops.zig
// Uses 8-column intervals (POSIX default, hardcoded in terminals like Ghostty)

import { stringWidth } from './stringWidth.js'
import { createTokenizer } from './termio/tokenize.js'

const DEFAULT_TAB_INTERVAL = 8

/**
 * Expand tab characters to spaces at fixed column intervals, preserving
 * escape sequences and resetting the column on newlines.
 * @param text - the text to expand.
 * @param interval - the tab stop interval in columns; defaults to 8.
 * @returns `text` with every tab replaced by the spaces needed to reach the next stop.
 */
export function expandTabs(
  text: string,
  interval = DEFAULT_TAB_INTERVAL,
): string {
  if (!text.includes('\t')) {
    return text
  }

  const tokenizer = createTokenizer()
  const tokens = tokenizer.feed(text)
  tokens.push(...tokenizer.flush())

  let result = ''
  let column = 0

  for (const token of tokens) {
    if (token.type === 'sequence') {
      result += token.value
    } else {
      const parts = token.value.split(/(\t|\n)/)
      for (const part of parts) {
        if (part === '\t') {
          const spaces = interval - (column % interval)
          result += ' '.repeat(spaces)
          column += spaces
        } else if (part === '\n') {
          result += part
          column = 0
        } else {
          result += part
          column += stringWidth(part)
        }
      }
    }
  }

  return result
}
