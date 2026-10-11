/**
 * Line-delimited JSON reading: a malformed line costs that line, never the
 * file. Legal JSON that is not a record (`null`, scalars, arrays) is skipped
 * silently since it is well-formed, just not a row; text that fails to parse
 * is counted, so a truncated or corrupted source can be reported.
 *
 * Backend-neutral (D15): the migration sources (via
 * `src/dsh-adapter/migrate/parse/jsonl.ts`) and the Claude backend's
 * transcript reader both read JSONL, and a backend must not reach into
 * `src/utils/` (B-3's boundary rule). Pure, zero imports.
 */

/** A decoded JSON object row. */
export type JsonRecord = Record<string, unknown>

/** Narrow an unknown JSON value to an object record (rejects `null` and arrays). */
export function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Parsed rows of one JSONL document. */
export interface JsonlRows {
  readonly records: readonly JsonRecord[]
  /** Non-empty lines that were not valid JSON. */
  readonly badLines: number
}

/**
 * Split and decode a JSONL document.
 * @param raw - Whole file text; `\n` and `\r\n` line ends are both accepted.
 * @returns Every object row in file order plus the count of unparseable lines.
 */
export function parseJsonl(raw: string): JsonlRows {
  const records: JsonRecord[] = []
  let badLines = 0
  for (const line of raw.split('\n')) {
    const text = line.endsWith('\r') ? line.slice(0, -1) : line
    if (text.trim() === '') continue
    let value: unknown
    try {
      value = JSON.parse(text)
    } catch {
      badLines += 1
      continue
    }
    if (isRecord(value)) records.push(value)
  }
  return { records, badLines }
}
