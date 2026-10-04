/**
 * The backend-neutral prompt contracts of the TUI's side calls (`/btw`,
 * `/recap`): what one tool-less, single-answer auxiliary call is asked, and
 * how a recap answer is read back. Every backend's side call uses the same
 * words — DSH sends them over its own derived history (`dsh-adapter/
 * sideQuestion.ts`, `recap.ts`), Claude over a throwaway fork of the
 * conversation (`backends/claude/side-query.ts`).
 *
 * Pure text: no I/O, no vendor types.
 */

/**
 * Describe the auxiliary call's scope: one answer from existing context,
 * with no tools, follow-up actions, or interruption of the main session.
 * `running` names the main task's in-flight work, one line each (the
 * caller formats them), when the context the call sees ends mid-step.
 */
export function sideQuestionPrompt(question: string, running: readonly string[] = []): string {
  const pending = running.length === 0 ? '' : `
The main task is still executing these tool calls; their results are not available yet:
${running.map(line => `- ${line}`).join('\n')}`
  return `<side-question-context>
Give one concise answer to the question below using the conversation already provided.
This auxiliary call runs alongside the main session. The main task continues independently;
do not describe it as interrupted, resumed, or as work performed by this call.
No tools are available here: do not claim to inspect files, execute commands, browse,
or carry out future actions. There will be no follow-up turn for this call.
When the available context is insufficient, state what is unknown without promising research.${pending}
</side-question-context>

${question}`
}

/**
 * One earlier Q/A pair of a `/btw` side thread, as the thread store hands
 * it to the next ask (answers already clipped to the per-answer budget).
 */
export interface SideThreadPriorTurn {
  readonly question: string
  readonly answer: string
}

/**
 * Carry the recent turns of a side thread into the NEXT single-turn ask:
 * the pairs travel as explicit quoted context inside the question payload,
 * so every backend's one-shot side call keeps its own contract unchanged
 * (the wrapper still sees "one question, one answer, no tools"). The result
 * is what the caller passes to `sideQuery.ask` as the question — never a
 * second conversation: nothing here writes a session record anywhere.
 *
 * `omittedOlder` is the count of completed pairs the budget dropped from
 * the front of the thread (turn-window or character budget); the note lets
 * the model know earlier turns existed instead of silently forgetting.
 */
export function sideThreadQuestion(
  question: string,
  prior: readonly SideThreadPriorTurn[] = [],
  omittedOlder = 0,
): string {
  if (prior.length === 0 && omittedOlder === 0) return question
  const omitted = omittedOlder > 0
    ? `
${omittedOlder} earlier pair(s) of this thread are omitted here to stay within the context budget.`
    : ''
  const pairs = prior
    .map((turn, index) => `<side-thread-pair n="${index + 1}">
Q: ${turn.question}
A: ${turn.answer}
</side-thread-pair>`)
    .join('\n')
  return `<side-thread-context>
The quoted pairs below are the recent history of this side thread: quick
questions the user asked alongside the main session, with the answers given
at the time. Treat them as shared context for the new question at the end.
They are not turns of the main conversation and carry no tool results.${omitted}
</side-thread-context>

${pairs}

${question}`
}

/** The recap answer contract (one JSON object: title + one-line summary). */
const RECAP_CONTRACT = `Use the user's language and describe the work and its current outcome accurately.
Return one JSON object with two string fields:
- "title": a descriptive title of about 2-6 words.
- "summary": one line of about 10-20 words covering the most recent progress.
Do not include Markdown fences or any text outside the JSON object.`

/**
 * Wrap a recent-activity excerpt with the single-response, JSON-only recap
 * contract (a call that does not see the conversation itself).
 */
export function wrapRecapPrompt(activity: string): string {
  return `Create a compact session recap from the activity excerpt below.
${RECAP_CONTRACT}

Activity excerpt:
${activity}`
}

/**
 * The recap request for a call that runs over the conversation itself (a
 * fork of it): the same contract, about the conversation so far, with an
 * emphasis on its recent part.
 */
export function conversationRecapPrompt(): string {
  return `<side-question-context>
This auxiliary call runs alongside the main session; no tools are available and there is no follow-up turn.
</side-question-context>

Create a compact session recap of the conversation so far, focused on its most recent activity.
${RECAP_CONTRACT}`
}

/**
 * Parse the model's recap response: extract the JSON object (tolerating
 * stray prose around it); on failure the whole text becomes the summary
 * and no title is proposed.
 */
export function parseRecapResponse(raw: string): { summary: string; title?: string } {
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start !== -1 && end > start) {
    try {
      const parsed: unknown = JSON.parse(raw.slice(start, end + 1))
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const record = parsed as Record<string, unknown>
        const summary =
          typeof record['summary'] === 'string' && record['summary'].trim() !== ''
            ? record['summary'].trim()
            : undefined
        const title =
          typeof record['title'] === 'string' && record['title'].trim() !== ''
            ? record['title'].trim()
            : undefined
        if (summary !== undefined) {
          return title === undefined ? { summary } : { summary, title }
        }
      }
    } catch {
      // Fall through to the raw-text fallback below.
    }
  }
  return { summary: raw.trim() }
}
