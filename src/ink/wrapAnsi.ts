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
 * Single-slot incremental wrap for the one over-long input that grows every
 * frame during streaming (a tool command's args, a long answer line).
 * Greedy wrapping (hard:true, trim:false) is prefix-stable: every row of the
 * previous wrap except the last consumed an identical input span, so
 * wrap(prefix + suffix) === headRows + wrap(lastRow + suffix). Re-wrapping
 * only `remainder + suffix` turns the per-frame cost from O(total) — the
 * dominant long-output stall (string-width via wrap-ansi, 60%+ of CPU in
 * profiles) — into O(tail). Guarded to plain (ANSI-free) inputs: a remainder
 * cut inside an escape sequence would re-wrap with the wrong SGR state.
 */
interface WrapSlot {
  columns: number
  input: string
  headRows: string[]
  remainder: string
}

const SLOT_MIN_LENGTH = 2048
let slot: WrapSlot | null = null

function slotOptionsApply(options: WrapAnsiOptions | undefined): boolean {
  return options?.hard === true && (options?.trim ?? false) === false
}

function wrapAnsiNpmIncremental(
  input: string,
  columns: number,
  options: WrapAnsiOptions | undefined,
): string {
  const slottable =
    input.length > SLOT_MIN_LENGTH && slotOptionsApply(options)
  if (slottable && slot !== null && slot.columns === columns && input.startsWith(slot.input)) {
    const suffix = input.slice(slot.input.length)
    if (!suffix.includes('\x1b') && !slot.remainder.includes('\x1b')) {
      const tail = wrapAnsiNpm(slot.remainder + suffix, columns, options).split('\n')
      const rows = [...slot.headRows, ...tail]
      slot = { columns, input, headRows: rows.slice(0, -1), remainder: rows[rows.length - 1] ?? '' }
      return rows.join('\n')
    }
  }
  const result = wrapAnsiNpm(input, columns, options)
  if (slottable && !input.includes('\x1b')) {
    const rows = result.split('\n')
    slot = { columns, input, headRows: rows.slice(0, -1), remainder: rows[rows.length - 1] ?? '' }
  } else {
    slot = null
  }
  return result
}

/**
 * Wrap a string to a maximum column width, preserving ANSI escape sequences.
 *
 * Uses Bun.wrapAnsi when available; otherwise falls back to the wrap-ansi
 * package (with the incremental fast path for growing streaming inputs).
 * @param input - the string to wrap.
 * @param columns - the maximum width in columns.
 * @param options - wrap options: hard breaks long words, wordWrap splits on word boundaries, trim strips trailing whitespace.
 * @returns the wrapped string.
 */
const wrapAnsi: (
  input: string,
  columns: number,
  options?: WrapAnsiOptions,
) => string =
  wrapAnsiBun ??
  wrapAnsiNpmIncremental

export { wrapAnsi }
