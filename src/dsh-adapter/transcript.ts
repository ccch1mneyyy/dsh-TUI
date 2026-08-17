import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { t } from '../i18n.js'
import type { ChatRow, ToolViewPresenter } from './channel.js'

const ARGS_PREVIEW_LIMIT = 160
const RESULT_PREVIEW_LIMIT = 240

function preview(text: string, limit: number): string {
  const flat = text.replace(/\s+/gu, ' ').trim()
  return flat.length <= limit ? flat : `${flat.slice(0, limit)}…`
}

function blocksText(content: readonly ContentBlock[] | undefined, kind: 'text' | 'reasoning'): string {
  return (content ?? [])
    .map(block => block.type === kind ? block.text : '')
    .join('')
    .trim()
}

function toolResultText(event: SessionEvent<'tool/result'>): string {
  const block = event.data.message.content[0]
  if (block === undefined || block.type !== 'tool-result') return ''
  return block.content.map(item => item.type === 'text' ? item.text : '').join('').trim()
}

function toolErrorText(event: SessionEvent<'tool/result'>): string {
  const failure = event.data.error
  if (failure === undefined) return ''
  const identity = `${failure.name}: ${failure.code}`
  const detail = toolResultText(event)
  return detail === '' || detail === identity ? identity : `${identity} — ${detail}`
}

function stepKey(data: { turn: number; step: number }): string {
  return `${data.turn}:${data.step}`
}

/**
 * Project an immutable session inspection into the same ChatRow vocabulary as
 * the live conversation. Settled assistant messages are authoritative; delta
 * chunks are retained only for a currently open step that has no final
 * message yet.
 */
export function projectReadOnlyTranscript(
  events: readonly SessionEvent[],
  views?: ToolViewPresenter,
): ChatRow[] {
  const settledSteps = new Set(
    events
      .filter((event): event is SessionEvent<'assistant/message'> => event.type === 'assistant/message')
      .map(event => stepKey(event.data)),
  )
  const rows: ChatRow[] = []
  const toolCards = new Map<string, ChatRow>()
  const openAssistant = new Map<string, ChatRow>()
  const openReasoning = new Map<string, ChatRow>()
  let nextId = 0

  const pushTextRow = (
    kind: 'assistant' | 'reasoning',
    text: string,
    event: SessionEvent,
    streaming = false,
  ): ChatRow | undefined => {
    if (text === '') return undefined
    const row: ChatRow = {
      id: nextId++,
      kind,
      text,
      seq: event.seq,
      time: kind === 'assistant' ? event.time : undefined,
      streaming,
    }
    rows.push(row)
    return row
  }

  for (const event of events) {
    switch (event.type) {
      case 'user/message': {
        if (
          event.data.source.kind === 'plugin' &&
          event.data.source.plugin === 'compact'
        ) {
          rows.push({ id: nextId++, kind: 'notice', text: 'Conversation compacted', seq: event.seq })
          const summary = blocksText(event.data.content, 'text')
          if (summary !== '') rows.push({ id: nextId++, kind: 'compact', text: summary, seq: event.seq })
          break
        }
        if (event.data.source.kind !== 'user') break
        const text = event.data.content.find(block => block.type === 'text')?.text.trim() ?? ''
        if (text !== '') rows.push({ id: nextId++, kind: 'user', text, seq: event.seq })
        break
      }
      case 'assistant/chunk': {
        const key = stepKey(event.data)
        if (settledSteps.has(key)) break
        const chunk = event.data.chunk
        if (chunk.type === 'text-delta' && chunk.text) {
          const row = openAssistant.get(key) ?? pushTextRow('assistant', chunk.text, event, true)
          if (row !== undefined) {
            if (openAssistant.has(key)) row.text += chunk.text
            else openAssistant.set(key, row)
          }
        } else if (chunk.type === 'reasoning-delta' && chunk.text) {
          const row = openReasoning.get(key) ?? pushTextRow('reasoning', chunk.text, event, true)
          if (row !== undefined) {
            if (openReasoning.has(key)) row.text += chunk.text
            else openReasoning.set(key, row)
          }
        }
        break
      }
      case 'assistant/message': {
        const reasoning = blocksText(event.data.message.content, 'reasoning')
        const text = blocksText(event.data.message.content, 'text')
        pushTextRow('reasoning', reasoning, event)
        pushTextRow('assistant', text, event)
        break
      }
      case 'tool/call': {
        if (event.data.name === 'ask_user_question') break
        const card: ChatRow = {
          id: nextId++,
          kind: 'tool',
          text: '',
          seq: event.seq,
          tool: {
            callId: event.data.callId,
            name: event.data.name,
            argsText: preview(event.data.arguments, ARGS_PREVIEW_LIMIT),
            argsFull: event.data.arguments,
            status: 'running',
            callView: views?.call(event.data.name, event.data.arguments),
            startedAt: event.time,
          },
        }
        toolCards.set(event.data.callId, card)
        rows.push(card)
        break
      }
      case 'tool/result': {
        const card = toolCards.get(event.data.message.source.callId)
        if (card?.tool === undefined) break
        card.tool.durationMs = Math.max(0, event.time - card.tool.startedAt)
        if (event.data.error !== undefined) {
          card.tool.status = 'error'
          card.tool.errorText = toolErrorText(event)
        } else {
          const result = toolResultText(event)
          card.tool.status = 'ok'
          card.tool.resultFull = result || undefined
          card.tool.resultText = result ? preview(result, RESULT_PREVIEW_LIMIT) : undefined
          card.tool.resultView = views?.result(card.tool.name, card.tool.argsFull ?? '', event.data)
        }
        toolCards.delete(event.data.message.source.callId)
        break
      }
      case 'turn/end': {
        for (const row of openAssistant.values()) row.streaming = false
        for (const row of openReasoning.values()) row.streaming = false
        openAssistant.clear()
        openReasoning.clear()
        if (event.data.reason.kind === 'completed') break
        if (event.data.reason.kind === 'aborted' || event.data.reason.kind === 'interrupted') {
          rows.push({ id: nextId++, kind: 'interrupt', text: t('interrupted-by-user') + t('interrupted-ask-next'), seq: event.seq })
          break
        }
        const detail = event.data.reason.kind === 'error' ? event.data.reason.error.message : ''
        rows.push({
          id: nextId++,
          kind: 'notice',
          text: `turn ${event.data.reason.kind}${detail ? ` · ${detail}` : ''}`,
          seq: event.seq,
        })
        break
      }
      default:
        break
    }
  }

  return rows
}
