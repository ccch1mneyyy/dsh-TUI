/** Translate session, compaction, background-task and rate-limit frames. */
import type { AgentEvent, AgentEventOf, SubagentUsage, TurnEndReason } from '../../../agent/events.js'
import { claudeText } from '../text.js'
import { arr, num, rec, str, type Rec } from '../narrow.js'
import type { ClaudeTranslatorOptions, OpenAttempt } from './types.js'

/** The user-facing name of a rate-limit window. */
function rateLimitWindow(type: string): string {
  switch (type) {
    case 'five_hour': return claudeText('status-rate-limit-five-hour')
    case 'seven_day': return claudeText('status-rate-limit-seven-day')
    case 'seven_day_opus': return `${claudeText('status-rate-limit-seven-day')} Opus`
    case 'seven_day_sonnet': return `${claudeText('status-rate-limit-seven-day')} Sonnet`
    default: return type === '' ? '?' : type
  }
}

/** A duration until a reset, coarse (`3d 1h`, `2h 5m`, `7m`). */
export function formatDuration(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000))
  const days = Math.floor(minutes / 1440)
  const hours = Math.floor((minutes % 1440) / 60)
  const rest = minutes % 60
  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${rest}m`
  return `${rest}m`
}

/** A task report's usage (`total_tokens`, `tool_uses`, `duration_ms`). */
function usageOfTask(value: unknown): SubagentUsage | undefined {
  const usage = rec(value)
  if (usage === undefined) return undefined
  const total = num(usage.total_tokens)
  const toolUses = num(usage.tool_uses)
  const durationMs = num(usage.duration_ms)
  if (total === undefined && toolUses === undefined && durationMs === undefined) return undefined
  return { ...(total === undefined ? {} : { total }), ...(toolUses === undefined ? {} : { toolUses }), ...(durationMs === undefined ? {} : { durationMs }) }
}

export function createSystemTranslator(context: {
  currentModel: string
  currentMode: string | undefined
  summaryExpected: boolean
  notificationTurnExpected: boolean
  readonly options: ClaudeTranslatorOptions
  readonly turnOpen: boolean
  readonly compactRequested: boolean
  readonly attempt: OpenAttempt | undefined
  readonly taskKinds: Map<string, 'agent' | 'job' | 'foreground'>
  readonly taskInfo: Map<string, { readonly description: string; readonly callId?: string }>
  readonly laneTasks: Map<string, string>
  readonly outputFiles: Map<string, string>
  readonly hiddenTasks: Set<string>
  readonly openCalls: Map<string, { readonly name: string; readonly input: unknown; readonly turn: number; readonly lane?: string }>
  readonly deniedReasons: Map<string, string>
  now(): number
  debug(message: string): void
  openTurn(out: AgentEvent[], origin: AgentEventOf<'turn.start'>['origin'], userMessageId?: string): void
  delta(open: OpenAttempt, value: AgentEventOf<'assistant.delta'>['delta'], index: number): AgentEvent
  forceCloseTurn(reason: TurnEndReason): AgentEvent[]
}) {
  const { options, taskKinds, taskInfo, laneTasks, outputFiles, hiddenTasks, openCalls, deniedReasons, now, debug, openTurn, delta, forceCloseTurn } = context
  /** The last `system/init` command list (re-sent every turn; only changes
   *  are reported). Undefined until the first init. */
  let initCommands: string | undefined
  /** The last rate-limit state announced (`status:window`): a warning is
   *  said once per state, not on every turn's repeat of it. */
  let rateLimitState: string | undefined
  const translateInit = (message: Rec): AgentEvent[] => {
    const model = str(message.model) ?? ''
    const permissionMode = str(message.permissionMode)
    const commands = arr(message.slash_commands).filter((name): name is string => typeof name === 'string')
    const out: AgentEvent[] = []
    if (initCommands === undefined) {
      out.push({
        type: 'session.ready',
        sessionId: str(message.session_id) ?? '',
        cwd: str(message.cwd) ?? options.cwd,
        model,
        ...(permissionMode === undefined ? {} : { permissionMode }),
        ...(str(message.claude_code_version) === undefined ? {} : { backendVersion: str(message.claude_code_version) }),
      })
    } else {
      if (model !== '' && model !== context.currentModel) out.push({ type: 'model.changed', model, source: 'settings' })
      if (permissionMode !== undefined && permissionMode !== context.currentMode) out.push({ type: 'mode.changed', modeId: permissionMode })
      if (commands.join('\n') !== initCommands) out.push({ type: 'commands.changed', commands: commands.map(name => ({ name })) })
    }
    initCommands = commands.join('\n')
    if (model !== '') context.currentModel = model
    if (permissionMode !== undefined) context.currentMode = permissionMode
    return out
  }

  /** A background job's start: its command from the launching call when
   *  that was a shell command. */
  const jobStart = (taskId: string, taskType: string | undefined): AgentEvent => {
    const hidden = hiddenTasks.has(taskId)
    const info = taskInfo.get(taskId)
    const call = info?.callId === undefined ? undefined : openCalls.get(info.callId)
    const command = call === undefined ? undefined : str(rec(call.input)?.command)
    const kind = taskType === 'local_bash' ? 'shell' : taskType === 'local_workflow' ? 'workflow' : taskType === 'monitor' || taskType === 'local_monitor' ? 'monitor' : taskType ?? 'task'
    const outputFile = outputFiles.get(taskId)
    return {
      type: 'task.start',
      taskId,
      kind,
      description: info?.description ?? '',
      ...(command === undefined ? {} : { command }),
      ...(info?.callId === undefined ? {} : { callId: info.callId }),
      background: true,
      ...(outputFile === undefined ? {} : { outputFile }),
      ...(hidden ? { hidden: true } : {}),
      time: now(),
    }
  }

  /**
   * A subscription limit warning (`allowed_warning`) or refusal (`rejected`)
   * as a notice, once per state (the CLI repeats the event every turn);
   * `allowed` re-arms it.
   */
  const rateLimitNotice = (info: Rec | undefined): AgentEvent[] => {
    const status = str(info?.status)
    const type = str(info?.rateLimitType) ?? ''
    const state = `${status ?? ''}:${type}`
    if (status !== 'allowed_warning' && status !== 'rejected') {
      rateLimitState = undefined
      return []
    }
    if (state === rateLimitState) return []
    rateLimitState = state
    const window = rateLimitWindow(type)
    const resetsAt = num(info?.resetsAt)
    const resets = resetsAt === undefined ? '' : claudeText('claude-rate-limit-resets', { time: claudeText('claude-rate-limit-in', { duration: formatDuration(resetsAt * 1000 - now()) }) })
    if (status === 'rejected') return [{ type: 'notice', level: 'error', key: 'rate-limit', text: claudeText('claude-rate-limit-rejected', { window, resets }) }]
    const utilization = num(info?.utilization)
    return [{ type: 'notice', level: 'warning', key: 'rate-limit', text: claudeText('claude-rate-limit-warning', { window, percent: utilization === undefined ? '?' : Math.round(utilization * 100), resets }) }]
  }

  const translateSystem = (message: Rec): AgentEvent[] => {
    const subtype = str(message.subtype)
    switch (subtype) {
      case 'init':
        return translateInit(message)
      case 'status': {
        const out: AgentEvent[] = []
        const status = message.status
        if (status === 'requesting') openTurn(out, 'system')
        if (status === 'compacting') out.push({ type: 'compaction.start', trigger: context.compactRequested ? 'manual' : 'auto', cancellable: false, time: now() })
        if (message.compact_result === 'failed') out.push({ type: 'compaction.end', ok: false, error: str(message.compact_error) ?? '', time: now() })
        const mode = str(message.permissionMode)
        if (mode !== undefined && mode !== context.currentMode) {
          context.currentMode = mode
          out.push({ type: 'mode.changed', modeId: mode })
        }
        return out
      }
      case 'compact_boundary': {
        const meta = rec(message.compact_metadata)
        context.summaryExpected = true
        return [{
          type: 'compaction.end',
          ok: true,
          ...(num(meta?.pre_tokens) === undefined ? {} : { preTokens: num(meta?.pre_tokens) }),
          ...(num(meta?.post_tokens) === undefined ? {} : { postTokens: num(meta?.post_tokens) }),
          time: now(),
        }]
      }
      case 'thinking_tokens': {
        const open = context.attempt
        const estimated = num(message.estimated_tokens)
        if (open === undefined || estimated === undefined) return []
        return [delta(open, { kind: 'reasoning-tokens', estimated }, 0)]
      }
      case 'session_state_changed': {
        const state = message.state
        if (state === 'running') return [{ type: 'session.status', status: 'running' }]
        if (state === 'requires_action') return [{ type: 'session.status', status: 'requires-action' }]
        if (state !== 'idle') return []
        // `idle` is the backstop for a turn that never got its `result`.
        const out: AgentEvent[] = []
        if (context.turnOpen) out.push(...forceCloseTurn({ kind: 'aborted' }))
        out.push({ type: 'session.status', status: 'idle' })
        return out
      }
      case 'task_started': {
        const taskId = str(message.task_id)
        if (taskId === undefined) return []
        const taskType = str(message.task_type)
        const background = message.is_backgrounded === true
        const description = str(message.description) ?? ''
        const callId = str(message.tool_use_id)
        taskInfo.set(taskId, { description, ...(callId === undefined ? {} : { callId }) })
        // Housekeeping / watcher tasks are not activity: no card, no chip,
        // no toast (the CLI says to keep them out of the transcript and the
        // activity indicators).
        if (message.skip_transcript === true || message.ambient === true) hiddenTasks.add(taskId)
        if (taskType === 'local_agent' || str(message.subagent_type) !== undefined) {
          taskKinds.set(taskId, 'agent')
          if (callId !== undefined) laneTasks.set(callId, taskId)
          const depth = num(message.spawn_depth)
          // Completes the subagent the `Agent` call pre-created (same lane).
          return [{ type: 'subagent.start', agentId: taskId, ...(callId === undefined ? {} : { parentCallId: callId }), description, ...(str(message.subagent_type) === undefined ? {} : { kind: str(message.subagent_type) }), background, ...(depth === undefined ? {} : { depth }), time: now() }]
        }
        // A foreground Bash that runs ~3s also reports
        // `task_started{is_backgrounded:false}`: not a background job.
        if (!background) {
          taskKinds.set(taskId, 'foreground')
          return []
        }
        taskKinds.set(taskId, 'job')
        return [jobStart(taskId, taskType)]
      }
      case 'task_progress': {
        const taskId = str(message.task_id)
        if (taskId === undefined) return []
        const summary = str(message.summary)
        // A backgrounded job's progress is its one-line status.
        if (taskKinds.get(taskId) === 'job') return summary === undefined ? [] : [{ type: 'task.update', taskId, patch: { progress: summary } }]
        const usage = usageOfTask(message.usage)
        return [{
          type: 'subagent.progress',
          agentId: taskId,
          ...(summary === undefined ? {} : { summary }),
          ...(str(message.last_tool_name) === undefined ? {} : { lastTool: str(message.last_tool_name) }),
          ...(usage === undefined ? {} : { usage }),
        }]
      }
      case 'task_updated': {
        const taskId = str(message.task_id)
        const patch = rec(message.patch)
        if (taskId === undefined || patch === undefined) return []
        const out: AgentEvent[] = []
        const kind = taskKinds.get(taskId)
        if (patch.is_backgrounded === true) {
          // A foreground Bash moved to the background is a job from now on;
          // a foreground subagent moved there runs in the background.
          if (kind === 'foreground') {
            taskKinds.set(taskId, 'job')
            out.push(jobStart(taskId, 'local_bash'))
          } else if (kind === 'agent') {
            const info = taskInfo.get(taskId)
            out.push({ type: 'subagent.start', agentId: taskId, ...(info?.callId === undefined ? {} : { parentCallId: info.callId }), description: '', background: true, time: now() })
          }
        }
        // A subagent ends with its notification (summary, usage); the status
        // patch before it adds nothing. A foreground tool's task is its card.
        const status = str(patch.status)
        if (status === undefined || taskKinds.get(taskId) !== 'job') return out
        const mapped = status === 'running' || status === 'pending' || status === 'completed' || status === 'failed' ? status : status === 'killed' || status === 'stopped' ? 'stopped' : undefined
        if (mapped !== undefined) out.push({ type: 'task.update', taskId, patch: { status: mapped, ...(str(patch.error) === undefined ? {} : { error: str(patch.error) }) } })
        return out
      }
      case 'task_notification': {
        const taskId = str(message.task_id)
        const status = str(message.status)
        if (taskId === undefined) return []
        const summary = str(message.summary)
        const done = status === 'failed' ? 'failed' : status === 'stopped' ? 'stopped' : 'completed'
        // A task never seen starting (missed frame): a usage block is what
        // only subagent reports carry.
        const kind = taskKinds.get(taskId) ?? (message.usage === undefined ? 'job' : 'agent')
        const hidden = hiddenTasks.delete(taskId) || message.skip_transcript === true || message.ambient === true
        taskKinds.delete(taskId)
        taskInfo.delete(taskId)
        if (kind === 'foreground') return []
        // A foreground tool's task report arrives inside its own turn; only a
        // report between turns starts the CLI's notification turn (never a
        // housekeeping task's).
        if (!context.turnOpen && !hidden) context.notificationTurnExpected = true
        const usage = usageOfTask(message.usage)
        const outputFile = str(message.output_file)
        if (outputFile !== undefined && outputFile !== '') outputFiles.set(taskId, outputFile)
        return kind === 'agent'
          ? [{ type: 'subagent.end', agentId: taskId, status: done === 'stopped' ? 'cancelled' : done, ...(summary === undefined ? {} : { summary }), ...(usage === undefined ? {} : { usage }), time: now() }]
          : [{ type: 'task.end', taskId, status: done, ...(summary === undefined ? {} : { summary }), ...(outputFile === undefined || outputFile === '' ? {} : { outputFile }), time: now() }]
      }
      case 'background_tasks_changed': {
        const ids = arr(message.tasks).flatMap(item => {
          const id = str(rec(item)?.task_id) ?? str(rec(item)?.id)
          return id === undefined ? [] : [id]
        })
        return [{ type: 'tasks.snapshot', taskIds: ids }]
      }
      case 'permission_denied': {
        const callId = str(message.tool_use_id)
        const reason = str(message.decision_reason) ?? str(message.message) ?? ''
        if (callId !== undefined && reason !== '' && openCalls.has(callId)) deniedReasons.set(callId, reason)
        return [{
          type: 'notice',
          level: 'warning',
          text: reason === '' ? claudeText('claude-permission-denied', { tool: str(message.tool_name) ?? '' }) : claudeText('claude-permission-denied-reason', { tool: str(message.tool_name) ?? '', reason }),
          ...(callId === undefined ? {} : { callId, key: `permission-denied:${callId}` }),
        }]
      }
      case 'api_retry': {
        // One passing toast, replaced attempt by attempt (same key).
        const status = num(message.error_status)
        return [{
          type: 'notice',
          level: 'notice',
          key: 'api-retry',
          text: claudeText('claude-api-retry', { attempt: String(num(message.attempt) ?? '?'), max: String(num(message.max_retries) ?? '?'), detail: status === undefined ? '' : claudeText('claude-api-retry-status', { status }) }),
        }]
      }
      case 'informational': {
        // Levels (SDK): `info` is transcript-only, `notice` a quiet gray
        // line — both a row here; `suggestion` a toast; `warning` both.
        // A tool use's progress messages share a key (deduplicated).
        const text = str(message.content) ?? str(message.message) ?? str(message.text)
        if (text === undefined || text.trim() === '') return []
        const level = str(message.level)
        const toolUse = str(message.tool_use_id)
        return [{
          type: 'notice',
          level: level === 'warning' || level === 'error' ? 'warning' : level === 'suggestion' ? 'notice' : 'info',
          text,
          ...(toolUse === undefined ? {} : { key: `informational:${toolUse}` }),
        }]
      }
      case 'notification': {
        // The REPL notification queue: `low` a row, `medium` a toast,
        // `high` / `immediate` a warning; the CLI's key dedupes.
        const text = str(message.text) ?? str(message.message) ?? str(message.content)
        if (text === undefined || text.trim() === '') return []
        const priority = str(message.priority)
        const key = str(message.key)
        return [{
          type: 'notice',
          level: priority === 'high' || priority === 'immediate' ? 'warning' : priority === 'medium' ? 'notice' : 'info',
          text,
          ...(key === undefined || key === '' ? {} : { key: `notification:${key}` }),
        }]
      }
      case 'memory_recall': {
        // The CLI's "Recalled from memory" line, as a transcript row.
        const memories = arr(message.memories)
        if (memories.length === 0) return []
        return [{
          type: 'notice',
          level: 'info',
          key: 'memory-recall',
          text: message.mode === 'synthesize' ? claudeText('claude-memory-synthesized') : claudeText('claude-memory-recalled', { count: memories.length }),
        }]
      }
      case 'elicitation_complete':
        // The session closes the URL elicitation it names (dialogs.ts).
        return []
      case 'local_command_output': {
        const text = str(message.content) ?? str(message.output)
        return text === undefined || text === '' ? [] : [{ type: 'notice', level: 'info', text }]
      }
      case 'session_title_changed': {
        const title = str(message.title)
        return title === undefined ? [] : [{ type: 'session.title', title, source: 'auto' }]
      }
      case 'commands_changed': {
        const commands = arr(message.commands).flatMap(item => {
          const name = typeof item === 'string' ? item : str(rec(item)?.name)
          return name === undefined ? [] : [{ name }]
        })
        return [{ type: 'commands.changed', commands }]
      }
      case 'model_refusal_fallback': {
        const model = str(message.fallback_model) ?? str(message.model)
        if (model === undefined) return []
        const original = str(message.original_model) ?? context.currentModel
        const category = str(message.api_refusal_category)
        // `local`: only a subagent / side question fell back; the session
        // model is unchanged.
        if (message.scope === 'local') return [{ type: 'notice', level: 'info', key: 'model-fallback-local', text: claudeText('claude-model-fallback-local', { model, original }) }]
        const out: AgentEvent[] = []
        if (model !== context.currentModel) {
          context.currentModel = model
          out.push({ type: 'model.changed', model, source: 'fallback' })
        }
        out.push({ type: 'notice', level: 'warning', key: 'model-fallback', text: claudeText('claude-model-fallback', { model, original, category: category === undefined || category === '' ? '' : claudeText('claude-refusal-category-suffix', { category }) }) })
        return out
      }
      case 'model_refusal_no_fallback': {
        const model = str(message.original_model) ?? context.currentModel
        const category = str(message.api_refusal_category)
        return [{ type: 'notice', level: 'warning', key: 'model-refusal', text: claudeText('claude-model-refused', { model, category: category === undefined || category === '' ? '' : claudeText('claude-refusal-category-suffix', { category }) }) }]
      }
      default:
        debug(`claude: system/${subtype ?? '?'} ignored`)
        return []
    }
  }
  return { translateSystem, rateLimitNotice }
}
