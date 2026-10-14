/** Codex's persisted async-question reply envelope (also used by its desktop/TUI). */
import { rec, str } from '../narrow.js'

const OPEN = '<send_user_message_question_reply>'
const CLOSE = '</send_user_message_question_reply>'

export interface AsyncQuestionReply {
  readonly questionItemId: string
  readonly question: string
  readonly answer: string
}

/** Only complete envelopes are interpreted; ordinary user text stays literal. */
export function parseQuestionReply(text: string): readonly AsyncQuestionReply[] | undefined {
  let body = text.trim()
  if (body.startsWith('# Context from my IDE setup:\n')) {
    const marker = '\n## My request for Codex:\n'
    const index = body.lastIndexOf(marker)
    if (index < 0) return undefined
    body = body.slice(index + marker.length).trim()
  }
  if (!body.startsWith(OPEN) || !body.endsWith(CLOSE)) return undefined
  try {
    const parsed: unknown = JSON.parse(body.slice(OPEN.length, -CLOSE.length))
    const values = Array.isArray(parsed) ? parsed : [parsed]
    const replies: AsyncQuestionReply[] = []
    for (const raw of values) {
      const value = rec(raw)
      const questionItemId = str(value?.questionItemId)
      const question = str(value?.question)
      const answer = str(value?.answer)
      if (questionItemId === undefined || question === undefined || answer === undefined) return undefined
      replies.push({ questionItemId, question, answer })
    }
    return replies.length === 0 ? undefined : replies
  } catch {
    return undefined
  }
}

export function displayQuestionReply(replies: readonly AsyncQuestionReply[]): string {
  return replies.map(reply => `> ${reply.question.replaceAll('\n', '\n> ')}\n\n${reply.answer}`).join('\n\n')
}

/** Bound model-authored framing to Codex's 512-byte budget, keeping Unicode whole. */
export function questionReplyText(questionItemId: string, title: string, answer: string): string {
  let question = ''
  let bytes = 0
  for (const char of title) {
    bytes += Buffer.byteLength(char)
    if (bytes > 512) break
    question += char
  }
  question = question.replace(/[\r\n]/gu, ' ')
  if (Buffer.byteLength(questionItemId) > 512) return `> ${question}\n\n${answer}`
  return `${OPEN}\n${JSON.stringify([{ questionItemId, question, answer }])}\n${CLOSE}`
}
