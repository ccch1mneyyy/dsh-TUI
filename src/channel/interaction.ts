/**
 * The channel half of the human-in-the-loop bridge (docs/agent-backend-design.md
 * §4.7, §5.1): a non-DSH session announces its prompts as events, this module
 * parks them in the stores the TUI renders and routes the user's answers back
 * through the session's typed capabilities.
 *
 *   permission.request  → PermissionStore.park  → panel → permissions.respond
 *   permission.settled  → PermissionStore.withdraw (the backend took it back)
 *   question.request    → QuestionStore.ask     → panel → questions.respond / cancel
 *   question.settled    → abort that ask (the backend took it back)
 *
 * A prompt the backend withdrew is never answered again; a session that
 * leaves the binding withdraws everything it parked (`release`).
 *
 * Backend-neutral (`verify:boundary`): stores and capabilities only.
 */
import type { SessionCapabilities } from '../agent/capabilities.js'
import type { AgentEvent, QuestionRequestView } from '../agent/events.js'
import type { PermissionStore } from './permissions.js'
import type { QuestionRequest, QuestionStoreLike } from './questions.js'

export interface InteractionBridgeDeps {
  readonly permissions: PermissionStore
  readonly questions: QuestionStoreLike
  debug(message: string): void
}

/** The bound session as the bridge sees it. */
export interface InteractionSession {
  readonly sessionId: string
  readonly capabilities: Pick<SessionCapabilities, 'permissions' | 'questions'>
}

const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error)

/** Whether a questionnaire rejection was the user's own dismissal. */
const userCancelled = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ASK_CANCELLED'

/** The store request for one backend ask: ids are question indexes. */
function storeRequest(request: QuestionRequestView, signal: AbortSignal): QuestionRequest {
  return {
    signal,
    questions: request.questions.map((question, index) => ({
      id: String(index),
      question: question.question,
      ...(question.header === undefined ? {} : { header: question.header }),
      ...(question.detail === undefined ? {} : { detail: question.detail }),
      options: question.options.map(option => ({ label: option.label, ...(option.description === undefined ? {} : { description: option.description }) })),
      ...(question.multiSelect === true ? { multiSelect: true } : {}),
      ...(question.intent === undefined ? {} : { intent: question.intent }),
      ...(question.hideCustomInput === true ? { hideCustomInput: true } : {}),
      ...(question.defaultSelected === undefined || question.defaultSelected.length === 0 ? {} : { defaultSelected: [...question.defaultSelected] }),
      ...(question.link === undefined || question.link === '' ? {} : { link: question.link }),
    })),
  }
}

/** Attach one session: its events in, its answers out. */
export function attachInteraction(deps: InteractionBridgeDeps, session: InteractionSession) {
  const asks = new Map<string, AbortController>()
  let released = false

  const park = (event: Extract<AgentEvent, { type: 'permission.request' }>): void => {
    const request = event.request
    deps.permissions.park({
      sessionId: session.sessionId,
      request,
      settle: (_outcome, decision) => {
        // Only a user decision reaches the backend; a withdrawal was the
        // backend's own act (answering it again would be a second verdict).
        if (decision === undefined || released) return
        try {
          session.capabilities.permissions?.respond(request.requestId, decision)
        } catch (error) {
          deps.debug(`interaction: permission respond failed (${errorText(error)})`)
        }
      },
    })
  }

  const ask = (event: Extract<AgentEvent, { type: 'question.request' }>): void => {
    const request = event.request
    if (asks.has(request.requestId)) return
    const controller = new AbortController()
    asks.set(request.requestId, controller)
    void deps.questions.ask(storeRequest(request, controller.signal)).then(answer => {
      if (controller.signal.aborted || released) return
      const byId = new Map(answer.answers.map(item => [item.id, item]))
      session.capabilities.questions?.respond(request.requestId, {
        answers: request.questions.map((_, index) => {
          const item = byId.get(String(index))
          return { selected: item?.selected ?? [], ...(item?.custom === undefined ? {} : { custom: item.custom }) }
        }),
      })
    }, (error: unknown) => {
      // A withdrawn ask (the backend's own abort, a released session) needs
      // no answer; only the user's dismissal is reported.
      if (controller.signal.aborted || released || !userCancelled(error)) return
      session.capabilities.questions?.cancel(request.requestId)
    }).catch((error: unknown) => {
      deps.debug(`interaction: question respond failed (${errorText(error)})`)
    }).finally(() => {
      if (asks.get(request.requestId) === controller) asks.delete(request.requestId)
    })
  }

  return {
    /** Feed one batch of the bound session's events. */
    apply(batch: readonly AgentEvent[]): void {
      if (released) return
      for (const event of batch) {
        switch (event.type) {
          case 'permission.request':
            park(event)
            break
          case 'permission.settled':
            deps.permissions.withdraw(session.sessionId, event.requestId)
            break
          case 'question.request':
            ask(event)
            break
          case 'question.settled':
            asks.get(event.requestId)?.abort()
            break
          default:
            break
        }
      }
    },
    /** The session left the binding (or the channel released): withdraw all. */
    release(): void {
      if (released) return
      released = true
      deps.permissions.withdrawSession(session.sessionId)
      for (const controller of asks.values()) controller.abort()
      asks.clear()
    },
  }
}
