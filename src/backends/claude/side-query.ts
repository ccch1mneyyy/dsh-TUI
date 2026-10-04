/**
 * `/btw` and `/recap` on a Claude session: one tool-less, single-turn side query over the current
 * conversation, never a feature of its own —
 *
 *   query({ prompt, options: { resume: <session id>, forkSession: true,
 *     persistSession: false, tools: [], maxTurns: 1, model: <current> } })
 *
 * with the session's own environment, credential and route pin (auth.ts),
 * executable and settings sources. Its text streams to the caller as it
 * arrives; the query is closed when the answer is complete, on the caller's
 * abort, and on any failure.
 *
 * With CLI 2.1.287 the fork answers from the conversation with no tools
 * offered (~3 s on haiku), even when it ended in a tool call, and writes no
 * transcript file (`persistSession:false` + `forkSession`): the session's
 * own record is untouched.
 *
 * A session the CLI has not persisted yet has nothing to fork: the side
 * query says so instead of starting one.
 */
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { t } from '../../i18n.js'
import { buildSideQueryOptions } from './options.js'
import type { ClaudeSdkModule } from './sdk.js'
import { errorText, rec, str } from './narrow.js'

/** One side answer: the text, or why there is none (null + no error =
 *  the caller aborted). */
export interface SideQueryOutcome {
  readonly answer: string | null
  readonly error?: string
}

export interface ClaudeSideQueryDeps {
  readonly sdk: Pick<ClaudeSdkModule, 'query'>
  readonly cwd: string
  /** The session the side query forks (it changes after a reset). */
  sessionId(): string
  /** The CLI has written the session's transcript (a fork needs one). */
  persisted(): boolean
  /** The model the session runs ('' = not known yet: the CLI's default). */
  model(): string
  /** The session's spawn environment and route pin, as of now. */
  spawn(): { readonly env: Record<string, string>; readonly settings?: { readonly env: Readonly<Record<string, string>> }; readonly executable: string | undefined }
  debug(message: string): void
}

/** The one prompt of a side query, as a closed single-message stream. */
async function* singlePrompt(text: string): AsyncGenerator<SDKUserMessage> {
  yield { type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null }
}

export function createClaudeSideQuery(deps: ClaudeSideQueryDeps) {
  return {
    async ask(prompt: string, options: { readonly signal?: AbortSignal; readonly onText?: (delta: string) => void } = {}): Promise<SideQueryOutcome> {
      const { signal, onText } = options
      if (signal?.aborted) return { answer: null }
      if (!deps.persisted()) return { answer: null, error: t('claude-side-query-empty') }
      const abortController = new AbortController()
      const onAbort = (): void => { abortController.abort() }
      signal?.addEventListener('abort', onAbort, { once: true })
      const spawn = deps.spawn()
      const model = deps.model()
      const query = deps.sdk.query({
        prompt: singlePrompt(prompt),
        options: buildSideQueryOptions({
          cwd: deps.cwd,
          resume: deps.sessionId(),
          env: spawn.env,
          ...(spawn.settings === undefined ? {} : { settings: spawn.settings }),
          executable: spawn.executable,
          abortController,
          stderr: line => { deps.debug(`[claude-side-stderr] ${line.trimEnd()}`) },
          ...(model === '' ? {} : { model }),
        }),
      })
      let streamed = ''
      let settled = ''
      let failure: string | undefined
      let incomplete: string | undefined
      try {
        for await (const raw of query) {
          if (signal?.aborted) break
          const message = rec(raw)
          if (message?.type === 'stream_event') {
            const event = rec(message.event)
            const delta = rec(event?.delta)
            if (event?.type === 'content_block_delta' && delta?.type === 'text_delta') {
              const text = str(delta.text) ?? ''
              if (text !== '') {
                streamed += text
                onText?.(text)
              }
            }
            continue
          }
          if (message?.type === 'assistant') {
            for (const block of Array.isArray(rec(message.message)?.content) ? rec(message.message)!.content as unknown[] : []) {
              const value = rec(block)
              if (value?.type === 'text') settled += str(value.text) ?? ''
            }
            continue
          }
          if (message?.type === 'result') {
            const errors = Array.isArray(message.errors) ? message.errors.filter((line): line is string => typeof line === 'string' && !line.startsWith('[ede_diagnostic]')) : []
            const reason = str(message.result) ?? (errors.join('\n') || str(message.subtype) || 'error')
            // An error result fails; a non-success close (the turn bound)
            // fails only when it left no answer.
            if (message.is_error === true) failure = reason
            else if (message.subtype !== 'success') incomplete = reason
            break
          }
        }
      } catch (error) {
        if (!signal?.aborted) failure = errorText(error)
      } finally {
        signal?.removeEventListener('abort', onAbort)
        try { query.close() } catch (error) { deps.debug(`claude: side query close failed (${errorText(error)})`) }
        abortController.abort()
      }
      if (signal?.aborted) return { answer: null }
      // A gateway that does not stream still settles the whole text.
      if (streamed === '' && settled !== '') onText?.(settled)
      const answer = (streamed !== '' ? streamed : settled).trim()
      if (failure !== undefined) return { answer: null, error: failure }
      if (answer === '') return { answer: null, error: incomplete ?? t('claude-side-query-no-answer') }
      return { answer }
    },
  }
}

export type ClaudeSideQuery = ReturnType<typeof createClaudeSideQuery>
