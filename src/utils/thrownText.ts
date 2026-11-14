/**
 * A thrown value as text, without ever throwing itself.
 *
 * Plugin and host code can throw anything: an Error whose `message` getter
 * throws, a value whose `Symbol.toPrimitive` throws, a revoked proxy. A catch
 * block that formats such a value for a warning or notice would throw again
 * and undo the very isolation it exists for, so every catch that reports a
 * foreign failure formats it through here.
 *
 * The text is NOT bounded or sanitized: a caller putting it on the render
 * path still cuts and cleans it.
 * @param error - The thrown value.
 * @param fallback - Text for a value that cannot be printed.
 * @returns an Error's message, else `String(error)`, else `fallback`.
 */
export function thrownText(error: unknown, fallback = 'unprintable value'): string {
  try {
    return String(error instanceof Error ? error.message : error)
  } catch {
    return fallback
  }
}
