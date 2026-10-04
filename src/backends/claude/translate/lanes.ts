/** Translate subagent lanes without touching main-lane attempt state. */
import type { AgentEvent, ContentBlockView } from '../../../agent/events.js'
import { arr, rec, str, type Rec } from '../narrow.js'
import { parseSendMessageInput, sendMessageCallView, sendMessageResultState, sendMessageResultView } from '../send-message.js'
import { claudeToolRole, presentClaudeToolCall, presentClaudeToolResult } from '../tools.js'
import { toolResultText } from './content.js'
import type { ClaudeTranslatorOptions } from './types.js'

/** A backgrounded command's acknowledgement: where its output goes (the
 *  rest of the line — a path may contain spaces). */
const BACKGROUND_OUTPUT = /Output is being written to: ([^\r\n]+)/u

/**
 * The output path a backgrounded command's acknowledgement names: the rest
 * of its line, cut after `<taskId>.output` (the sentence that follows on the
 * same line is not part of it), else after the first `.output` that ends a
 * word. Undefined when the text names none.
 */
export function backgroundOutputPath(text: string, taskId: string): string | undefined {
  const line = BACKGROUND_OUTPUT.exec(text)?.[1]?.trim()
  if (line === undefined || line === '') return undefined
  const marker = `${taskId}.output`
  const at = line.indexOf(marker)
  if (at !== -1) return line.slice(0, at + marker.length)
  return /^(.+?\.output)(?=[.,;:]?(?:\s|$))/u.exec(line)?.[1]
}

/** The longest lane tool-result text kept (a subagent card shows a one-line
 *  preview; the full output stays in the subagent's own transcript). */
const LANE_RESULT_CHARS = 2000

/** A lane payload cut to {@link LANE_RESULT_CHARS} (never a lone surrogate). */
function clipLane(text: string): string {
  if (text.length <= LANE_RESULT_CHARS) return text
  const code = text.charCodeAt(LANE_RESULT_CHARS - 1)
  return `${text.slice(0, code >= 0xd800 && code <= 0xdbff ? LANE_RESULT_CHARS - 1 : LANE_RESULT_CHARS)}…`
}

export function createLaneTranslator(context: {
  readonly options: ClaudeTranslatorOptions
  readonly seq: number
  readonly turn: number
  readonly step: number
  readonly openCalls: Map<string, { readonly name: string; readonly input: unknown; readonly turn: number; readonly lane?: string }>
  readonly outputFiles: Map<string, string>
  now(): number
  nextSeq(): number
  debug(message: string): void
}) {
  const { options, openCalls, outputFiles, now, nextSeq, debug } = context
  /**
   * The subagent an `Agent` / `Task` call delegates to, pre-created from the
   * call itself (the call arrives before `task_started`): keyed
   * by the call id until `task_started` names the subagent.
   */
  const delegation = (callId: string, input: unknown): AgentEvent => {
    const args = rec(input)
    return {
      type: 'subagent.start',
      agentId: callId,
      parentCallId: callId,
      description: str(args?.description) ?? '',
      ...(str(args?.subagent_type) === undefined ? {} : { kind: str(args?.subagent_type) }),
      ...(str(args?.model) === undefined ? {} : { model: str(args?.model) }),
      background: args?.run_in_background === true,
      time: now(),
    }
  }

  /**
   * A subagent's own traffic (`parent_tool_use_id` = the delegating call,
   * with `forwardSubagentText`): its text and thinking, tool calls and
   * results as child-lane events for its card and panels. The main lane's
   * turn / step / attempt state is never touched; a nested delegation is
   * pre-created like a main-lane one.
   */
  const translateLane = (lane: string, type: string, message: Rec): AgentEvent[] => {
    const body = rec(message.message)
    const out: AgentEvent[] = []
    if (type === 'assistant') {
      const id = str(body?.id) ?? `lane-${context.seq + 1}`
      const blocks: ContentBlockView[] = []
      for (const raw of arr(body?.content)) {
        const block = rec(raw)
        switch (str(block?.type)) {
          case 'thinking': {
            const text = str(block?.thinking) ?? ''
            if (text !== '') blocks.push({ type: 'reasoning', text })
            break
          }
          case 'text': {
            const text = str(block?.text) ?? ''
            if (text !== '') blocks.push({ type: 'text', text })
            break
          }
          default:
            break
        }
      }
      if (blocks.length > 0) {
        out.push({ type: 'assistant.message', seq: nextSeq(), anchor: id, turn: context.turn, step: context.step, attemptId: id, time: now(), blocks, canonical: false, parentCallId: lane })
      }
      for (const raw of arr(body?.content)) {
        const block = rec(raw)
        if (block?.type !== 'tool_use') continue
        const callId = str(block.id)
        const name = str(block.name)
        if (callId === undefined || name === undefined) continue
        openCalls.set(callId, { name, input: block.input, turn: context.turn, lane })
        const presentation = presentClaudeToolCall(name, block.input, options.cwd)
        out.push({
          type: 'tool.call',
          seq: nextSeq(),
          anchor: callId,
          turn: context.turn,
          step: context.step,
          callId,
          name,
          argsJson: JSON.stringify(block.input ?? {}),
          parentCallId: lane,
          time: now(),
          ...(presentation === undefined ? {} : { presentation }),
        })
        if (claudeToolRole(name) === 'subagent') out.push(delegation(callId, block.input))
        // A SendMessage the subagent issued is a relay from that lane (the
        // delegating call id names the sender).
        if (name === 'SendMessage') {
          const parsed = parseSendMessageInput(block.input)
          if (parsed !== undefined) out.push({ type: 'agent.message', message: sendMessageCallView({ callId, lane, input: parsed, observedAt: now() }) })
        }
      }
      return out
    }
    if (type === 'user') {
      const results = arr(body?.content).flatMap(raw => rec(raw)?.type === 'tool_result' ? [rec(raw)!] : [])
      // Message-level, as on the main lane: it describes a single result.
      const structured = results.length === 1 ? rec(message.tool_use_result) : undefined
      for (const block of results) {
        const callId = str(block.tool_use_id)
        if (callId === undefined) continue
        const call = openCalls.get(callId)
        openCalls.delete(callId)
        const isError = block.is_error === true
        const fullText = toolResultText(block.content)
        // A lane result only feeds its subagent card (a one-line preview):
        // its payload is cut, so replayed history that lives as long as the
        // session never keeps whole tool outputs.
        const text = clipLane(fullText)
        const presentation = call === undefined ? undefined : presentClaudeToolResult(call.name, call.input, { isError, text, structured: undefined }, options.cwd)
        out.push({
          type: 'tool.result',
          seq: nextSeq(),
          turn: context.turn,
          step: context.step,
          callId,
          isError,
          time: now(),
          content: [{ type: 'text', text }],
          text: isError ? '' : text,
          ...(isError ? { errorText: text } : {}),
          ...(presentation === undefined ? {} : { presentation }),
          parentCallId: lane,
        })
        // Settle the lane's SendMessage from its result: an error is a
        // refusal, anything unrecognized stays 'unknown'.
        if (call?.name === 'SendMessage') {
          out.push({ type: 'agent.message', message: sendMessageResultView({ callId, observedAt: now(), state: sendMessageResultState({ isError, structured: undefined }) }) })
        }
        // A background command a subagent started names its output file in
        // its acknowledgement too.
        const backgroundTask = str(structured?.backgroundTaskId)
        const outputFile = backgroundTask === undefined || isError ? undefined : backgroundOutputPath(fullText, backgroundTask)
        if (backgroundTask !== undefined && outputFile !== undefined) {
          outputFiles.set(backgroundTask, outputFile)
          out.push({ type: 'task.update', taskId: backgroundTask, patch: { outputFile } })
        }
      }
      // The subagent's prompt (its first user text) is not shown.
      return out
    }
    // Streamed partials of a subagent: its settled messages carry the content.
    debug(`claude: subagent stream frame ignored (${lane})`)
    return out
  }
  return { delegation, translateLane }
}
