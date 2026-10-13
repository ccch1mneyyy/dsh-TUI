import type { AgentEvent, AgentEventMeta } from '../../agent/events.js'
import stripAnsi from 'strip-ansi'
import { Lexer, type MarkedToken, type Token } from 'marked'
import { textOfBlocks } from '../../channel/projection.js'
import { getGraphemeSegmenter } from '../../utils/intl.js'
import type { ChannelOwner } from './owner.js'
import type { ChannelState } from './types.js'

/** Notify once a successful live turn has settled with no automatic follow-up. */
export function createTaskCompletion(state: ChannelState, owner: ChannelOwner, notify: (preview?: string) => void) {
  let generation = -1
  let completedTurn = -1
  let pending = false
  let responseTurn: number | undefined
  let responseSeq = -1
  let preview: string | undefined
  let timer: ReturnType<typeof setImmediate> | undefined
  const reset = (): void => {
    if (timer !== undefined) clearImmediate(timer)
    timer = undefined
    completedTurn = -1
    pending = false
    responseTurn = undefined
    responseSeq = -1
    preview = undefined
  }
  owner.own(reset)

  return (batch: readonly AgentEvent[], meta: AgentEventMeta, current: () => boolean): void => {
    if (!current() || meta.replay) return
    if (generation !== state.agentBindingGeneration) {
      reset()
      generation = state.agentBindingGeneration
    }
    for (const event of batch) {
      if (event.type === 'session.reset') reset()
      else if (event.type === 'turn.start') {
        pending = false
        responseTurn = event.turn
        responseSeq = -1
        preview = undefined
      } else if (event.type === 'assistant.message' && event.parentCallId === undefined && !event.interrupted) {
        // Only settled main-session replies; provisional stream output and
        // child agents must never become the completion notification body.
        responseTurn ??= event.turn
        if (event.turn !== responseTurn || event.seq <= responseSeq) continue
        responseSeq = event.seq
        const text = textOfBlocks(event.blocks)
        if (text.trim()) preview = notificationPreview(text)
      } else if (event.type === 'turn.end' && event.turn > completedTurn) {
        completedTurn = event.turn
        pending = event.reason.kind === 'completed'
      }
    }
    if (!pending || timer !== undefined) return
    // Queue/status changes can follow turn.end in the same dispatch. Wait
    // for that dispatch, then retain the candidate until status is idle.
    timer = setImmediate(() => {
      timer = undefined
      if (!current()) { pending = false; return }
      if (pending && !state.working && state.status !== 'running') {
        pending = false
        if (state.status !== 'disposed' && !state.pending.some(item => !item.docked) && state.goal?.phase !== 'active') {
          notify(responseTurn === completedTurn ? preview : undefined)
        }
      }
    })
  }
}

/** Plain-text preview; notification daemons may interpret raw Markdown headings. */
function notificationPreview(text: string): string | undefined {
  const plain = markdownText(Lexer.lex(stripAnsi(text), { gfm: true }))
  const flat = plain.replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').replace(/\s+/g, ' ').trim()
  const graphemes: string[] = []
  for (const { segment } of getGraphemeSegmenter().segment(flat)) {
    if (graphemes.length === 200) return `${graphemes.slice(0, 199).join('')}…`
    graphemes.push(segment)
  }
  return graphemes.join('') || undefined
}

function isMarkdownToken<K extends MarkedToken['type']>(token: Token, kind: K): token is Extract<MarkedToken, { type: K }> {
  return token.type === kind
}

/** Extract visible text before flattening lines or truncating emphasis/link pairs. */
function markdownText(tokens: readonly Token[]): string {
  return tokens.map(token => {
    if (isMarkdownToken(token, 'heading') || isMarkdownToken(token, 'paragraph') || isMarkdownToken(token, 'blockquote')) return `${markdownText(token.tokens)}\n`
    if (isMarkdownToken(token, 'strong') || isMarkdownToken(token, 'em') || isMarkdownToken(token, 'del') || isMarkdownToken(token, 'link')) return markdownText(token.tokens)
    if (isMarkdownToken(token, 'text')) return token.tokens === undefined ? token.text : markdownText(token.tokens)
    if (isMarkdownToken(token, 'codespan') || isMarkdownToken(token, 'escape') || isMarkdownToken(token, 'image')) return token.text
    if (isMarkdownToken(token, 'code')) return `${token.text}\n`
    if (isMarkdownToken(token, 'list')) return `${token.items.map(item => markdownText(item.tokens)).join('\n')}\n`
    if (isMarkdownToken(token, 'table')) return `${[token.header, ...token.rows].map(row => row.map(cell => markdownText(cell.tokens)).join(' ')).join('\n')}\n`
    if (isMarkdownToken(token, 'html')) return token.text.replace(/<[^>]*>/g, '')
    if (isMarkdownToken(token, 'space') || isMarkdownToken(token, 'br') || isMarkdownToken(token, 'hr')) return '\n'
    return ''
  }).join('')
}
