/**
 * Harness-injection recognition and user-text unwrapping.
 *
 * Every foreign agent writes machine text into its user role: environment
 * blocks, instruction files, reminders, slash-command echoes. None of it is
 * the human's words, so it must never open a turn or become a title. The
 * other half is wrappers the harness puts AROUND real words (`<user_query>`,
 * pasted-content envelopes, interrupt notices): those keep the words and
 * drop the frame.
 *
 * Every scan here is linear: tag bodies are located with indexOf, never a
 * lazy `[\s\S]*?` regex, whose per-unclosed-tag rescans a hostile single
 * line can turn quadratic (deep-review m1 on the first claude adapter).
 *
 * @module @deepseek-harness-tui/dsh-tui/migrate/parse/injection
 */

/**
 * Line-start markers of injected blocks, matched case-insensitively after
 * trimming. A user text that STARTS with one of these is harness output.
 */
export const INJECTED_PREFIXES: readonly string[] = [
  '<environment_context>',
  '<system-reminder>',
  '<user_instructions>',
  '<local-command-caveat>',
  '<local-command-stdout>',
  '<command-name>',
  '<command-message>',
  '<task-notification>',
  '<permissions>',
  '<user_info>',
  '# AGENTS.md instructions',
  '# Context from my IDE setup:',
]

const LOWER_PREFIXES = INJECTED_PREFIXES.map(prefix => prefix.toLowerCase())

/** Whether a user text is harness injection rather than the human's words. */
export function isInjectedText(text: string): boolean {
  const head = text.trimStart().slice(0, 64).toLowerCase()
  return LOWER_PREFIXES.some(prefix => head.startsWith(prefix))
}

/**
 * Remove every `<tag>…</tag>` span. An opening tag with no closing tag
 * swallows the rest of the text (the block was cut off, nothing after it is
 * the user's).
 */
function removeTagSpans(text: string, tag: string): string {
  const open = `<${tag}>`
  const close = `</${tag}>`
  let out = ''
  let from = 0
  for (;;) {
    const start = text.indexOf(open, from)
    if (start === -1) return out + text.slice(from)
    out += text.slice(from, start)
    const end = text.indexOf(close, start + open.length)
    if (end === -1) return out
    from = end + close.length
  }
}

/** Strip inline `<system-reminder>` blocks (Claude Code puts them anywhere). */
export function stripSystemReminders(text: string): string {
  if (!text.includes('<system-reminder>')) return text.trim()
  return removeTagSpans(text, 'system-reminder').trim()
}

/** Bodies of every `<user_query>` block; an unclosed tag runs to the end. */
function userQueryBodies(text: string): string[] {
  const open = '<user_query>'
  const close = '</user_query>'
  const bodies: string[] = []
  let from = 0
  for (;;) {
    const start = text.indexOf(open, from)
    if (start === -1) return bodies
    const bodyStart = start + open.length
    const end = text.indexOf(close, bodyStart)
    bodies.push(text.slice(bodyStart, end === -1 ? undefined : end).trim())
    if (end === -1) return bodies
    from = end + close.length
  }
}

/** Notices a harness prepends when the user speaks over a running turn. */
const INTERJECTION_PREFIXES: readonly string[] = [
  'The user interrupted the previous turn:',
  'The user sent a message while you were working:',
]

/** Whether a user text is an interrupt notice (the previous turn was cut short). */
export function isInterruptNotice(text: string): boolean {
  return text.trimStart().startsWith(INTERJECTION_PREFIXES[0]!)
}

/** Drop `<pasted_content …>` / `</pasted_content …>` tags, keeping the pasted body. */
function stripPastedTags(text: string): string {
  if (!text.includes('pasted_content')) return text
  return text.replace(/<\/?pasted_content(?:\s[^<>]*)?>/gu, ' ').replace(/[ \t]{2,}/gu, ' ')
}

/**
 * Reduce a user text to the human's own words.
 *
 * - `<user_query>` wrappers keep only their bodies — this also covers the
 *   interrupt / "sent a message while you were working" notices, whose
 *   human part is always inside a `<user_query>`;
 * - a notice without a `<user_query>` keeps what follows the notice line;
 * - pasted-content envelopes lose their tags but keep the pasted text.
 *
 * @returns The unwrapped, trimmed text ('' when nothing human remains).
 */
export function unwrapUserText(text: string): string {
  const lead = text.trimStart()
  if (!text.includes('<') && !lead.startsWith('The user ')) return text.trim()
  let body = text
  const queries = userQueryBodies(body)
  if (queries.length > 0) {
    body = queries.join('\n\n')
  } else {
    const notice = INTERJECTION_PREFIXES.find(prefix => lead.startsWith(prefix))
    if (notice !== undefined) body = lead.slice(notice.length)
  }
  return stripPastedTags(body).trim()
}
