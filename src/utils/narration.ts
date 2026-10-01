/**
 * Strip the `⏵` self-narration line from assistant text. The
 * dsh-working-activity narrate contract puts exactly one `⏵` line at the
 * very top of a reply; the live working line already surfaces it, so
 * showing it again in the transcript would double it. Only the FIRST line
 * is checked — the contract allows one `⏵` line per reply.
 * Settled replies can preserve a narration-only response so the transcript
 * does not silently discard the model's entire answer.
 * @param text - Assistant text to strip.
 * @param preserveNarrationOnly - Preserve the only text of a settled reply.
 * @returns The body, or the original narration-only text when preserved.
 */
export function stripNarration(text: string, preserveNarrationOnly = false): string {
  const newline = text.indexOf('\n')
  const firstLine = newline === -1 ? text : text.slice(0, newline)
  if (!firstLine.trimStart().startsWith('⏵')) return text
  const body = newline === -1 ? '' : text.slice(newline + 1).replace(/^\n+/, '')
  return preserveNarrationOnly && body.trim() === '' ? text : body
}
