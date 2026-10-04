/** Translate main-lane assistant blocks, user echoes and tool results. */
import type { AgentEvent, AgentEventOf, ContentBlockView, UsageDelta } from '../../../agent/events.js'
import { t } from '../../../i18n.js'
import { arr, rec, str, type Rec } from '../narrow.js'
import { parseSendMessageInput, sendMessageCallView, sendMessageResultState, sendMessageResultView } from '../send-message.js'
import { claudeToolRole, presentClaudeToolCall, presentClaudeToolResult } from '../tools.js'
import { COMMAND_TAG, INTERRUPT_ECHO, LOCAL_COMMAND_TAG, questionRecordText, toolResultText, usageOf, userText } from './content.js'
import { backgroundOutputPath } from './lanes.js'
import type { createTaskTools } from './tasks.js'
import type { ClaudeTranslatorOptions, ClaudeUserRows, OpenAttempt, RegisteredInput } from './types.js'

export function createMessageTranslator(context: {
  readonly options: ClaudeTranslatorOptions
  readonly userRows: ClaudeUserRows
  readonly seq: number
  readonly turn: number
  readonly step: number
  currentMode: string | undefined
  toolResults: number
  summaryExpected: boolean
  readonly inputs: Map<string, RegisteredInput>
  readonly openCalls: Map<string, { readonly name: string; readonly input: unknown; readonly turn: number; readonly lane?: string }>
  readonly deniedReasons: Map<string, string>
  readonly outputFiles: Map<string, string>
  readonly tasks: ReturnType<typeof createTaskTools>
  now(): number
  nextSeq(): number
  debug(message: string): void
  ensureAttempt(out: AgentEvent[], id: string, model: string | undefined, usage: UsageDelta | undefined): OpenAttempt | undefined
  settleAttempt(out: AgentEvent[]): void
  confirmInput(out: AgentEvent[], uuid: string): void
  delegation(callId: string, input: unknown): AgentEvent
}) {
  const { options, inputs, openCalls, deniedReasons, outputFiles, tasks, now, nextSeq, debug, ensureAttempt, settleAttempt, confirmInput, delegation } = context
  const translateAssistant = (message: Rec): AgentEvent[] => {
    const body = rec(message.message)
    const id = str(body?.id)
    if (body === undefined || id === undefined) return []
    const out: AgentEvent[] = []
    const open = ensureAttempt(out, id, str(body.model), usageOf(body.usage))
    if (open === undefined) {
      debug(`claude: late block of settled message ${id} ignored`)
      return out
    }
    open.usage ??= usageOf(body.usage)
    if (message.aborted === true) open.aborted = true
    const error = str(message.error)
    if (error !== undefined) out.push({ type: 'notice', level: 'error', text: t('claude-assistant-error', { error }) })
    for (const raw of arr(body.content)) {
      const block = rec(raw)
      if (block === undefined) continue
      open.blocks += 1
      switch (str(block.type)) {
        case 'thinking':
          open.reasoning += str(block.thinking) ?? ''
          break
        case 'redacted_thinking':
          break
        case 'text':
          open.text += str(block.text) ?? ''
          break
        case 'tool_use': {
          const callId = str(block.id)
          const name = str(block.name)
          if (callId === undefined || name === undefined) break
          const input = block.input
          openCalls.set(callId, { name, input, turn: context.turn })
          // Plan-mode tools render as a mode change and the plan-review
          // panel, never as a card: no call, and their result below only
          // reports the outcome.
          if (claudeToolRole(name) === 'plan') break
          const presentation = presentClaudeToolCall(name, input, options.cwd)
          out.push({
            type: 'tool.call',
            seq: nextSeq(),
            anchor: callId,
            turn: context.turn,
            step: open.step,
            callId,
            name,
            argsJson: JSON.stringify(input ?? {}),
            time: now(),
            ...(presentation === undefined ? {} : { presentation }),
          })
          if (claudeToolRole(name) === 'subagent') out.push(delegation(callId, input))
          // The session's own SendMessage is a relay from the parent (no
          // sender id).
          if (name === 'SendMessage') {
            const parsed = parseSendMessageInput(input)
            if (parsed !== undefined) out.push({ type: 'agent.message', message: sendMessageCallView({ callId, input: parsed, observedAt: now() }) })
          }
          tasks.applyTaskInput(out, name, input)
          break
        }
        default:
          break
      }
    }
    // An aborted response gets no message_stop: it settles here with the
    // prefix it streamed.
    if (open.aborted) settleAttempt(out)
    return out
  }

  /** What a settled plan-mode tool means for the transcript and the mode. */
  const planOutcome = (name: string, isError: boolean): AgentEvent[] => {
    if (name === 'EnterPlanMode') {
      if (isError || context.currentMode === 'plan') return []
      context.currentMode = 'plan'
      return [{ type: 'mode.changed', modeId: 'plan' }]
    }
    return [{ type: 'notice', level: 'info', text: t(isError ? 'claude-plan-kept' : 'claude-plan-approved') }]
  }

  const translateUser = (message: Rec): AgentEvent[] => {
    const body = rec(message.message)
    const content = body?.content
    const out: AgentEvent[] = []
    const uuid = str(message.uuid)
    // Our own message echoed back (`--replay-user-messages` fallback).
    if (message.isReplay === true && uuid !== undefined && inputs.has(uuid)) {
      if (context.userRows === 'replay') confirmInput(out, uuid)
      return out
    }
    const results = arr(content).flatMap(raw => {
      const block = rec(raw)
      return block?.type === 'tool_result' ? [block] : []
    })
    if (results.length > 0) {
      // The open attempt is not settled here: the CLI drains finished tool
      // results while the same API message is still streaming (parallel
      // calls), so a later block of that message — another tool_use, more
      // text, the closing usage — still belongs to it. It settles on
      // `message_stop`, a new message id, an abort, `result` or a forced
      // close.
      // `tool_use_result` is message-level: it describes the one result of a
      // single-result message and nothing when several share the message.
      const structured = results.length === 1 ? message.tool_use_result : undefined
      for (const block of results) {
        const callId = str(block.tool_use_id)
        if (callId === undefined) continue
        const call = openCalls.get(callId)
        openCalls.delete(callId)
        // A TaskUpdate the CLI refused may say so only in its structured
        // result (`success:false`, no `is_error`): it failed all the same,
        // so its failure still gets a card.
        const isError = block.is_error === true || (call !== undefined && call.name === 'TaskUpdate' && rec(structured)?.success === false)
        const rawText = toolResultText(block.content)
        if (call !== undefined && claudeToolRole(call.name) === 'plan') {
          out.push(...planOutcome(call.name, isError))
          continue
        }
        // An auto-denied call: its card names the deciding component's reason.
        const denied = deniedReasons.get(callId)
        deniedReasons.delete(callId)
        const text = isError && denied !== undefined && !rawText.includes(denied)
          ? `${rawText}${rawText === '' ? '' : '\n'}${t('claude-denied-reason', { reason: denied })}`
          : call !== undefined && claudeToolRole(call.name) === 'question' && !isError
            ? questionRecordText(call.input, structured, rawText)
            : rawText
        const presentation = call === undefined ? undefined : presentClaudeToolResult(call.name, call.input, { isError, text, structured }, options.cwd)
        out.push({
          type: 'tool.result',
          seq: nextSeq(),
          turn: context.turn,
          step: context.step,
          callId,
          isError,
          time: now(),
          content: typeof block.content === 'string' ? [{ type: 'text', text }] : arr(block.content) as ContentBlockView[],
          text: isError ? '' : text,
          ...(isError ? { errorText: text } : {}),
          ...(structured === undefined ? {} : { structured }),
          ...(presentation === undefined ? {} : { presentation }),
        })
        // Settle the parent's SendMessage from its result: only an explicit
        // structured field or an error says more than 'unknown'.
        if (call?.name === 'SendMessage') {
          out.push({ type: 'agent.message', message: sendMessageResultView({ callId, observedAt: now(), state: sendMessageResultState({ isError, structured }) }) })
        }
        // Every settled main-lane result is one tool done this turn (the
        // working line's toolCount; plan-mode tools continue'd above).
        context.toolResults += 1
        tasks.applyTaskResult(out, call, isError, structured, openCalls)
        // A backgrounded command's acknowledgement names its output file
        // (`task_started` does not): the job's output tail is read from it.
        const backgroundTask = str(rec(structured)?.backgroundTaskId)
        const outputFile = backgroundTask === undefined || isError ? undefined : backgroundOutputPath(rawText, backgroundTask)
        if (backgroundTask !== undefined && outputFile !== undefined) {
          outputFiles.set(backgroundTask, outputFile)
          out.push({ type: 'task.update', taskId: backgroundTask, patch: { outputFile } })
        }
      }
      return out
    }
    const text = userText(content)?.trim()
    if (text === undefined || text === '') return out
    // Abort echoes and local-command transcript records are not bubbles.
    if (text.startsWith(INTERRUPT_ECHO) || LOCAL_COMMAND_TAG.test(text) || COMMAND_TAG.test(text)) return out
    if (message.isSynthetic === true && context.summaryExpected) {
      context.summaryExpected = false
      out.push({ type: 'user.message', id: uuid ?? `summary-${context.seq + 1}`, anchor: uuid ?? '', seq: nextSeq(), turn: context.turn, time: now(), source: 'compaction', text, blocks: [{ type: 'text', text }] })
      return out
    }
    const origin = str(rec(message.origin)?.kind)
    if (origin !== undefined && origin !== 'human') {
      // A system-originated prompt (task notification, peer, channel): not
      // a human bubble; the turn start already says what happened.
      debug(`claude: ${origin} prompt not projected as a bubble`)
      return out
    }
    debug(`claude: unconfirmed user text not projected (${text.slice(0, 40)})`)
    return out
  }
  return { translateAssistant, translateUser }
}
