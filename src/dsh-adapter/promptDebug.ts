/**
 * On-demand capture of every final AgentLoop request context observed for a
 * live session.
 *
 * The LLM waterfall is the last provider-neutral boundary before adapter
 * dispatch. Capturing there records the fully assembled system prompt,
 * messages, and tool schemas after prompt/tool plugins have contributed.
 * @module @deepseek-harness-tui/dsh-tui/prompt-debug
 */
import { join, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CommandRuntime } from '@deepseek-ai/dsh-commands'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { isAgentLoopRequest, type GenerateOptions } from '@deepseek-ai/dsh-llm'
import { snapshotLiveSessionEvents } from './compat/liveSession.js'
import { t } from '../i18n.js'

export const PROMPT_DEBUG_FILENAME = '.dsh-prompt-debug.json'

interface CapturedRequest {
  capturedAt: string
  requestIndex: number
  turn: number
  step: number
  attempt: number
  requestHeaderReason?: string
  finalLlmContext: {
    provider: string
    model: string
    reasoningEffort?: GenerateOptions['reasoningEffort']
    system?: string
    messages: GenerateOptions['messages']
    tools?: GenerateOptions['tools']
    temperature?: number
    maxTokens?: number
    stop?: string[]
  }
}

interface TurnCapture {
  turn: number
  requests: CapturedRequest[]
}

interface SessionCapture {
  requests: CapturedRequest[]
}

interface AgentRegistryLike {
  get(id: NonNullable<GenerateOptions['sessionId']>): Agent | undefined
}

function latestPosition(agent: Agent): { turn: number; step: number } | undefined {
  const events = snapshotLiveSessionEvents(agent.session)
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type === 'step/start') return event.data
  }
  return undefined
}

function latestRequestHeaderReason(agent: Agent): string | undefined {
  const events = snapshotLiveSessionEvents(agent.session)
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type === 'request/header') return event.data.reason
  }
  return undefined
}

function turnCompleted(agent: Agent, turn: number): boolean {
  return snapshotLiveSessionEvents(agent.session).some(
    event => event.type === 'turn/end' && event.data.turn === turn,
  )
}

function captureRequest(
  agent: Agent,
  options: GenerateOptions,
  requestIndex: number,
  position: { turn: number; step: number },
  attempt: number,
): CapturedRequest {
  const requestHeaderReason = latestRequestHeaderReason(agent)
  return {
    capturedAt: new Date().toISOString(),
    requestIndex,
    ...position,
    attempt,
    ...(requestHeaderReason === undefined ? {} : { requestHeaderReason }),
    finalLlmContext: {
      provider: options.provider,
      model: options.model,
      ...(options.reasoningEffort === undefined ? {} : { reasoningEffort: options.reasoningEffort }),
      ...(options.system === undefined ? {} : { system: options.system }),
      messages: options.messages,
      ...(options.tools === undefined ? {} : { tools: options.tools }),
      ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
      ...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
      ...(options.stop === undefined ? {} : { stop: options.stop }),
    },
  }
}

/**
 * Register `/debug-prompt` and retain the final requests observed for each
 * live session (most recent {@link DEBUG_PROMPT_MAX_REQUESTS} kept). The
 * command writes one private, atomic snapshot into the receiving session's
 * workspace; it never records credentials, transport headers, or
 * AbortSignals.
 */

/** Retention cap per session: every capture holds the fully assembled
 * request context (messages + tools), so an unbounded list grows
 * quadratically with an uncompacted conversation — the dominant long-session
 * memory term. Retries of the current step stay well inside this window. */
const DEBUG_PROMPT_MAX_REQUESTS = 8

export function registerPromptDebug(ctx: Context): void {
  const commands = ctx.get('commands') as CommandRuntime | undefined
  const agents = ctx.get('agents') as AgentRegistryLike | undefined
  if (commands === undefined || agents === undefined || ctx.get('llm') === undefined) return

  const captureStartedAt = new Date().toISOString()
  const captures = new Map<string, SessionCapture>()

  ctx.on('llm/stream', (options, next) => {
    if (!isAgentLoopRequest(options) || options.sessionId === undefined) return next()

    const agent = agents.get(options.sessionId)
    if (agent === undefined) return next()
    const position = latestPosition(agent)
    if (position === undefined) return next()

    const sessionId = String(options.sessionId)
    const capture = captures.get(sessionId) ?? { requests: [] }
    if (!captures.has(sessionId)) captures.set(sessionId, capture)
    const previous = capture.requests.findLast(request =>
      request.turn === position.turn && request.step === position.step)
    const attempt = (previous?.attempt ?? 0) + 1
    capture.requests.push(captureRequest(agent, options, capture.requests.length + 1, position, attempt))
    if (capture.requests.length > DEBUG_PROMPT_MAX_REQUESTS) {
      capture.requests.splice(0, capture.requests.length - DEBUG_PROMPT_MAX_REQUESTS)
    }
    return next()
  })

  // Replaced agents are no longer addressable by `/debug-prompt`; release
  // their potentially large message/tool snapshots with the agent lifecycle.
  ctx.on('agent/disposed', ({ agent }) => {
    captures.delete(String(agent.session.id))
  })

  ctx.effect(() => commands.register({
    name: 'debug-prompt',
    description: 'Write every observed final LLM request context for this session to the workspace root',
    recordInput: false,
    handler: async ({ agent, rawInput }) => {
      if (rawInput.trim().length > 0) {
        return { kind: 'error', text: 'Usage: /debug-prompt' }
      }

      const sessionId = String(agent.session.id)
      const capture = captures.get(sessionId)
      if (capture === undefined || capture.requests.length === 0) {
        return {
          kind: 'error',
          text: 'No final LLM request is available for this session. Send one prompt, wait for it to finish, then run /debug-prompt.',
        }
      }
      const latest = capture.requests.at(-1)!
      if (!turnCompleted(agent, latest.turn)) {
        return { kind: 'error', text: 'The latest model turn is still running. Wait for it to finish, then run /debug-prompt.' }
      }

      const root = resolve(agent.session.header.cwd ?? process.cwd())
      const output = join(root, PROMPT_DEBUG_FILENAME)
      const turns = new Map<number, TurnCapture>()
      for (const request of capture.requests) {
        const turn = turns.get(request.turn) ?? { turn: request.turn, requests: [] }
        if (!turns.has(request.turn)) turns.set(request.turn, turn)
        turn.requests.push(request)
      }
      const document = {
        schemaVersion: 2,
        generatedAt: new Date().toISOString(),
        captureStartedAt,
        captureScope: 'Requests observed by this dsh-tui process; requests from before a session resume cannot be reconstructed.',
        warning: 'Sensitive debug data: contains system prompts, conversation messages, tool schemas, and tool results. It intentionally excludes credentials and transport headers.',
        sessionId,
        turnCount: turns.size,
        requestCount: capture.requests.length,
        turns: [...turns.values()].map(turn => ({
          ...turn,
          requestCount: turn.requests.length,
        })),
      }

      try {
        await writeFileAtomic(output, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 })
      } catch (error) {
        return {
          kind: 'error',
          text: `Could not write prompt debug file: ${error instanceof Error ? error.message : String(error)}`,
        }
      }

      return {
        kind: 'success',
        // Localized copy carries the synced/shared-workspace cleanup reminder
        // (the snapshot lands in the workspace root, 0600); see i18n.ts.
        text: t('prompt-debug-saved', { count: capture.requests.length, file: output }),
      }
    },
  }))
}
