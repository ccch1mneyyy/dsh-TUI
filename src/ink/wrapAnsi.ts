import wrapAnsiNpm from 'wrap-ansi'

type WrapAnsiOptions = {
  hard?: boolean
  wordWrap?: boolean
  trim?: boolean
}

const wrapAnsiBun =
  typeof Bun !== 'undefined' && typeof Bun.wrapAnsi === 'function'
    ? Bun.wrapAnsi
    : null

/**
 * Wrap a string to a maximum column width, preserving ANSI escape sequences.
 *
 * Uses Bun.wrapAnsi when available; otherwise falls back to the wrap-ansi
 * package.
 * @param input - the string to wrap.
 * @param columns - the maximum width in columns.
 * @param options - wrap options: hard breaks long words, wordWrap splits on word boundaries, trim strips trailing whitespace.
 * @returns the wrapped string.
 */
const wrapAnsi: (
  input: string,
  columns: number,
  options?: WrapAnsiOptions,
) => string = wrapAnsiBun ?? wrapAnsiNpm

export { wrapAnsi }
