import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage, type Message } from '@deepseek-ai/dsh-llm'
import type { Context } from '@deepseek-ai/cordis'
import { clearResumeTarget, forgetSession, readResumeTarget, touchSession, writeResumeTarget } from '../../sessionHistory.js'
import { t } from '../../i18n.js'
import { appendSessionTitle, deleteSessionLog } from '../compat/index.js'
import { snapshotLiveSessionEvents } from '../compat/liveSession.js'
import { collectRecentActivity, parseRecapResponse, RECAP_RECENT_CHARS, wrapRecapPrompt } from '../recap.js'
import { listSummaries, locateSession, previewSession, type SessionSource, type SessionSummary } from '../sessions/index.js'
import { runSideQuestion, wrapSideQuestion } from '../sideQuestion.js'
import type { ChannelOwner } from './owner.js'
import type { CredentialStatus, SideQuestionLlm } from './types.js'
import { isUserInvocable } from '@deepseek-ai/dsh-skill'

const PREVIEW_ENTRIES = 8

type Capture = { readonly agent: Agent; readonly generation: number }
type Binding = {
  readonly agent: Agent
  capture(): Capture
  isCurrent(capture: Capture): boolean
}

/** Session-scoped metadata, persistence queries, and tool-less LLM reads. */
export function createSessionMetadataActions(ctx: Context, deps: {
  owner: Pick<ChannelOwner, 'current' | 'signal'>
  binding: Binding
  provider(): string
  model(): string
  emit(): void
  sessionTitle(): string
  setSessionTitle(title: string): void
  setSessionColor(color: string): void
  forgetAgentView(sessionId: string): void
  setPersistedSessions(rows: readonly SessionSummary[]): void
  skillRegistryFor(agent: Agent): { snapshot(options: { scope: Agent; cwd: string }): Promise<{ skills: readonly { name: string; description: string; source: string; invocation: unknown }[]; complete: boolean }> } | undefined
  skillViewOptions(agent: Agent): { scope: Agent; cwd: string }
}) {
  const current = (capture: Capture): boolean => deps.owner.current() && deps.binding.isCurrent(capture)
  const persistence = (): SessionSource | undefined => ctx.get('sessionPersistence') as SessionSource | undefined
  const withOwnerSignal = (signal?: AbortSignal): AbortSignal =>
    signal === undefined ? deps.owner.signal : AbortSignal.any([signal, deps.owner.signal])

  const listSessions = async (): Promise<readonly SessionSummary[]> => {
    const capture = deps.binding.capture()
    const source = persistence()
    if (!source) {
      if (current(capture)) deps.setPersistedSessions([])
      return []
    }
    const summaries = await listSummaries(source)
    if (!current(capture)) return []
    deps.setPersistedSessions(summaries)
    return summaries
  }

  const preview = async (sessionId: string) => {
    const capture = deps.binding.capture()
    const source = persistence()
    if (!source) return []
    const path = await locateSession(source, sessionId)
    if (!current(capture) || path === undefined) return []
    const entries = await previewSession(path, PREVIEW_ENTRIES)
    return current(capture) ? entries : []
  }

  const listSkills = async () => {
    const capture = deps.binding.capture()
    const target = capture.agent
    const registry = deps.skillRegistryFor(target)
    if (!registry) return []
    try {
      const observation = await registry.snapshot(deps.skillViewOptions(target))
      if (!current(capture) || !observation.complete) return undefined
      return observation.skills.map(skill => ({
        name: skill.name,
        description: skill.description,
        userInvocable: isUserInvocable(skill as Parameters<typeof isUserInvocable>[0]),
        source: skill.source,
      }))
    } catch {
      return current(capture) ? undefined : []
    }
  }

  const describeCredential = async (ref: string): Promise<CredentialStatus | undefined> => {
    const capture = deps.binding.capture()
    const credentials = ctx.get('credentials') as { describe(ref: string): Promise<CredentialStatus> } | undefined
    if (!credentials) return undefined
    try {
      const result = await credentials.describe(ref)
      return current(capture) ? result : undefined
    } catch (error) {      // `undefined` means the optional service is absent. Keep a live
      // credential service's read failure observable; only suppress it once
      // this Channel binding has been replaced or disposed.
      if (!current(capture)) return undefined
      throw error
    }
  }

  /**
   * Recaps omit conversation history but borrow its effective system text.
   * Derivation applies surface replacements and empty prompt tombstones;
   * scanning the event log would revive superseded instructions.
   */
  const currentSystemText = (capture: Capture): string | undefined => {
    try {
      const system = capture.agent.session.deriveMessages().findLast(message => message.role === 'system')
      const text = system?.content.map(block => block.type === 'text' ? block.text : '').join('') ?? ''
      return text === '' ? undefined : text
    } catch {
      // A session without derived history has no surface prompt to lend.
    }
    return undefined
  }

  const llmRequest = (capture: Capture, messages: Message[], includesHistory: boolean, signal?: AbortSignal): Record<string, unknown> => {
    const header = capture.agent.session.requestHeader()
    const config = header?.config
    // Pre-V3 headers carried the system prompt inline; V3 moved it to
    // `system/message` surface nodes (see currentSystemText).
    const legacySystem = (header as { system?: unknown } | undefined)?.system
    const system = messages.some(message => message.role === 'system')
      ? undefined
      : typeof legacySystem === 'string' ? legacySystem : includesHistory ? undefined : currentSystemText(capture)
    return {
      provider: config?.provider ?? deps.provider(),
      model: config?.model ?? deps.model(),
      messages,
      ...(system !== undefined && { system }),
      ...(config?.reasoningEffort !== undefined && { reasoningEffort: config.reasoningEffort }),
      ...(config?.temperature !== undefined && { temperature: config.temperature }),
      ...(config?.maxTokens !== undefined && { maxTokens: config.maxTokens }),
      ...(config?.stop !== undefined && { stop: [...config.stop] }),
      sessionId: capture.agent.session.id,
      ...(signal && { signal }),
    }
  }

  const sideQuestion = async (question: string, options?: { signal?: AbortSignal; onText?: (delta: string) => void }) => {
    const capture = deps.binding.capture()
    const llm = ctx.get('llm') as SideQuestionLlm | undefined
    if (!llm) return { answer: null, error: t('btw-llm-unavailable') }
    const signal = withOwnerSignal(options?.signal)
    const outcome = await runSideQuestion({
      stream: llm.stream.bind(llm),
      options: llmRequest(capture, [
        ...capture.agent.session.deriveMessages(),
        createUserMessage({ content: [{ type: 'text', text: wrapSideQuestion(question) }], source: { kind: 'plugin', plugin: 'dsh-tui/btw' } }),
      ], true, signal),
      // Do not let an old session append streamed UI facts after a switch.
      onText: delta => { if (current(capture) && !options?.signal?.aborted) options?.onText?.(delta) },
      signal,
    })
    return current(capture) ? outcome : { answer: null }
  }

  const recapRecent = async (options?: { signal?: AbortSignal; onText?: (delta: string) => void }) => {
    const capture = deps.binding.capture()
    const llm = ctx.get('llm') as Partial<SideQuestionLlm> | undefined
    // Optional host services can be partially mounted while startup is still
    // composing. A present service without its streaming capability is just
    // as unavailable as an absent service; do not throw from an auto recap.
    if (typeof llm?.stream !== 'function') return { summary: null, error: t('recap-llm-unavailable') }
    const activity = collectRecentActivity(snapshotLiveSessionEvents(capture.agent.session), RECAP_RECENT_CHARS)
    if (activity === '') return { summary: null, error: t('recap-no-activity') }
    const signal = withOwnerSignal(options?.signal)
    const outcome = await runSideQuestion({
      stream: llm.stream.bind(llm),
      options: llmRequest(capture, [
        createUserMessage({ content: [{ type: 'text', text: wrapRecapPrompt(activity) }], source: { kind: 'plugin', plugin: 'dsh-tui/recap' } }),
      ], false, signal),
      onText: delta => { if (current(capture) && !options?.signal?.aborted) options?.onText?.(delta) },
      signal,
    })
    if (!current(capture) || outcome.answer === null) return { summary: null, ...(current(capture) ? { error: outcome.error } : {}) }
    const parsed = parseRecapResponse(outcome.answer)
    return parsed.title === undefined ? { summary: parsed.summary } : { summary: parsed.summary, title: parsed.title }
  }

  const renameSession = (title: string): void => {
    const capture = deps.binding.capture()
    if (!current(capture)) return
    capture.agent.session.append('session/title', { title })
    deps.setSessionTitle(title)
    deps.emit()
  }
  const setSessionColor = (color: string): void => {
    const capture = deps.binding.capture()
    if (!current(capture)) return
    ;(capture.agent.session as unknown as { append(type: string, data: Record<string, unknown>): unknown })
      .append('session/color', { color })
    deps.setSessionColor(color)
    deps.emit()
  }
  const deleteSession = async (sessionId: string): Promise<boolean> => {
    const capture = deps.binding.capture()
    if (sessionId === capture.agent.session.id || !current(capture)) return false
    if (deleteSessionLog(sessionId) !== 'deleted' || !current(capture)) return false
    forgetSession(sessionId)
    deps.forgetAgentView(sessionId)
    if (readResumeTarget() === sessionId) clearResumeTarget()
    return true
  }
  const renameSessionTo = async (sessionId: string, title: string): Promise<boolean> => {
    const capture = deps.binding.capture()
    if (!current(capture)) return false
    if (sessionId === capture.agent.session.id) { renameSession(title); return true }
    if (appendSessionTitle(sessionId, title) !== 'appended' || !current(capture)) return false
    touchSession(sessionId)
    return true
  }

  return {
    listSessions, previewSession: preview, listSkills, describeCredential,
    sideQuestion, recapRecent, setResumeTarget: writeResumeTarget,
    renameSession, setSessionColor, deleteSession, renameSessionTo,
  }
}
