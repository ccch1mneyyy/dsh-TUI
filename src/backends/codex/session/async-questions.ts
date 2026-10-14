/** Nonblocking Codex assistant questions → the shared questionnaire, ordinary input back.
 * Historical replay never opens panels. Live turn completion withdraws unanswered asks,
 * matching Codex's TUI; dismissal alone does not interrupt the running turn. */
import { randomUUID } from 'node:crypto'
import type { QuestionAnswers } from '../../../agent/capabilities.js'
import type { AgentEvent, QuestionItemView } from '../../../agent/events.js'
import { arr, errorText, rec, str, type Rec } from '../narrow.js'
import { NOTIFY } from '../protocol/index.js'
import { codexText } from '../text.js'
import { parseQuestionReply, questionReplyText } from '../translate/question-reply.js'
import type { InputQueue } from './input.js'

interface PendingQuestion {
  readonly itemId: string
  readonly questionId: string
  readonly view: QuestionItemView
  sending: boolean
}

interface AsyncQuestionDeps {
  readonly input: InputQueue
  emit(events: readonly AgentEvent[]): void
}

export function createAsyncQuestions(deps: AsyncQuestionDeps) {
  const pending = new Map<string, PendingQuestion>()
  let revision = 0

  const offer = (entry: PendingQuestion): void => {
    const requestId = `codex-async:${entry.questionId}:${++revision}`
    pending.set(requestId, entry)
    deps.emit([{ type: 'question.request', request: { requestId, callId: entry.itemId, questions: [entry.view] } }])
  }
  const settle = (requestId: string): void => {
    if (!pending.delete(requestId)) return
    deps.emit([{ type: 'question.settled', requestId }])
  }
  const withdraw = (): void => {
    for (const id of [...pending.keys()]) settle(id)
  }

  return {
    notification(method: string, params: Rec): void {
      const item = rec(params.item)
      if (method === NOTIFY.itemStarted && item?.type === 'userMessage') {
        const text = arr(item.content).map(rec).find(input => input?.type === 'text')?.text
        const replies = typeof text === 'string' ? parseQuestionReply(text) : undefined
        if (replies !== undefined) {
          for (const [id, entry] of [...pending]) {
            if (replies.some(reply => reply.questionItemId === entry.questionId || reply.questionItemId === entry.itemId)) settle(id)
          }
        } else {
          withdraw()
        }
      }
      if (method !== NOTIFY.itemCompleted || item?.type !== 'agentMessage' || item.delivery !== 'async') return
      const itemId = str(item.id)
      if (itemId === undefined) return
      arr(item.questions).forEach((raw, index) => {
        const question = rec(raw)
        const title = str(question?.title)
        if (title === undefined || title.trim() === '') return
        const options = arr(question?.options).filter((label): label is string => typeof label === 'string' && label.trim() !== '').map(label => ({ label }))
        offer({
          itemId,
          questionId: JSON.stringify(['request_user_input_async', itemId, index]),
          view: { question: title, options, ...(options[0] === undefined ? {} : { defaultSelected: [options[0].label] }) },
          sending: false,
        })
      })
    },
    owns(requestId: string): boolean { return pending.has(requestId) },
    respond(requestId: string, answers: QuestionAnswers): void {
      const entry = pending.get(requestId)
      if (entry === undefined || entry.sending) return
      const answer = answers.answers[0]
      const text = [...(answer?.selected ?? []), ...(answer?.custom?.trim() ? [answer.custom.trim()] : [])].join('\n')
      if (text === '') { settle(requestId); return }
      entry.sending = true
      void deps.input.submit({ text: questionReplyText(entry.questionId, entry.view.question, text), clientMessageId: randomUUID() }, 'steer').then(result => {
        if (!result.accepted) throw new Error(result.reason ?? codexText('codex-turn-start-failed', { err: '' }))
        settle(requestId)
      }).catch((error: unknown) => {
        if (pending.get(requestId) !== entry) return
        settle(requestId)
        deps.emit([{ type: 'notice', level: 'error', text: errorText(error) }])
        entry.sending = false
        offer(entry)
      })
    },
    cancel: settle,
    withdraw,
  }
}
