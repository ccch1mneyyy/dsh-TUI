import { stringWidth } from '../ink/stringWidth.js'
import { truncateToWidth } from '../ink/truncateToWidth.js'

/**
 * Shorten `text` to at most `maxWidth` terminal cells by replacing its
 * middle with `…`, keeping the head and the tail. A path keeps its root and
 * its file name; a file name keeps its stem's start and its extension.
 * Widths are display cells (CJK wide characters count as two), never
 * string lengths.
 */
export function truncateMiddle(text: string, maxWidth: number): string {
  if (maxWidth <= 0) return ''
  if (stringWidth(text) <= maxWidth) return text
  if (maxWidth === 1) return '…'
  const tailBudget = Math.floor((maxWidth - 1) / 2)
  const headBudget = maxWidth - 1 - tailBudget
  const chars = Array.from(text)
  let tail = ''
  for (let index = chars.length - 1; index >= 0; index -= 1) {
    const next = chars[index] + tail
    if (stringWidth(next) > tailBudget) break
    tail = next
  }
  return `${truncateToWidth(text, headBudget)}…${tail}`
}
