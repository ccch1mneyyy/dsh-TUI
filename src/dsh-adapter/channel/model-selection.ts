import type { Context } from '@deepseek-ai/cordis'
import type { Agent, ModelSelection } from '@deepseek-ai/dsh-agent'
import { boundContextSummary, createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import { snapshotLiveSessionEvents } from '../compat/liveSession.js'
import { createChannelOwner, type ChannelOwner } from './owner.js'

/**
 * The foreground selection facade. Modern hosts read the Agent-owned durable
 * choice live; only legacy hosts keep a mutable route locally. `assembled`
 * captures the selection the current step entered prompt assembly with.
 */
export interface ModelSelectionRef {
  /** Model selected for the next step that enters prompt assembly. */
  current: ModelSelection | undefined
  /** Selection captured when the current step entered prompt assembly. */
  assembled: ModelSelection | undefined
}

/**
 * The upstream seam that replaced the mutable ref: `current()` folds the
 * session's recorded selection over the last request and the creation
 * options, `select()` records a new one durably. Absent on hosts before
 * 0.2.2, where the channel drives the same pipeline through its own
 * waterfalls; probed by shape so older installs keep working.
 */
interface ModelSeam {
  current(): Readonly<ModelSelection> | undefined
  select(selection: Readonly<ModelSelection>): void
}

/** The public durable seam, absent on legacy hosts. */
export function modelSeamOf(agent: Agent): ModelSeam | undefined {
  const model = (agent as { readonly model?: Partial<ModelSeam> }).model
  return typeof model?.current === 'function' && typeof model.select === 'function'
    ? model as ModelSeam
    : undefined
}

function sameRoute(a: ModelSelection | undefined, b: Readonly<ModelSelection> | undefined): boolean {
  if (a === undefined || b === undefined) return a === b
  return a.provider === b.provider && a.model === b.model && a.reasoningEffort === b.reasoningEffort
}

/** Routing belongs to the live agent, including turns running while parked.
 * The foreground facade follows the binding; each waterfall captures its own
 * agent's ref so a later binding can never supply its route. */
export function createModelSelection(ctx: Context, deps: {
  owner: ChannelOwner
  agent(): Agent
}) {
  interface Entry {
    ref: ModelSelectionRef
    seam: ModelSeam | undefined
    release(): void
  }
  const entries = new Map<Agent, Entry>()
  const foreground = (): Entry => {
    const entry = entries.get(deps.agent())
    if (entry === undefined) throw new Error('dsh-tui: model selection has not been bound')
    return entry
  }
  /** Write the next step's route, through the durable seam when the host has one. */
  const write = (entry: Entry, value: ModelSelection | undefined): void => {
    if (entry.seam === undefined) {
      entry.ref.current = value
    } else if (value !== undefined && !sameRoute(value, entry.seam.current())) {
      entry.seam.select(value)
    }
  }
  const selection: ModelSelectionRef = {
    get current() {
      const entry = foreground()
      return entry.seam === undefined ? entry.ref.current : entry.seam.current()
    },
    set current(value) { write(foreground(), value) },
    get assembled() { return foreground().ref.assembled },
    set assembled(value) { foreground().ref.assembled = value },
  }
  deps.owner.own(ctx.on('agent/disposed', ({ agent }) => entries.get(agent)?.release()))

  /** Bind without selecting; return whether the session owns its effort too. */
  const bind = (agent: Agent, route: { provider: string; model: string }): boolean => {
    deps.owner.assertActive()
    const seam = modelSeamOf(agent)
    const recorded = agent.session.requestHeader?.()?.config
    const durable = seam !== undefined && (recorded !== undefined ||
      snapshotLiveSessionEvents(agent.session).some(event => (event as { type: string }).type === 'model/selection'))
    if (entries.has(agent)) return durable
    const hasCreatedRoute = agent.options?.provider !== undefined && agent.options.model !== undefined
    // Seeded children can deliberately replace the inherited header's route.
    // Restore a recorded pin only when the caller actually adopted that route.
    const usesRecordedRoute = recorded?.provider === route.provider && recorded?.model === route.model
    // The pre-0.2.2 seed: creation options plus the persisted request header.
    const legacySeed: ModelSelection | undefined = usesRecordedRoute && recorded?.reasoningEffort !== undefined
      ? { ...route, reasoningEffort: recorded.reasoningEffort }
      : route.provider !== '' && route.model !== '' &&
      (!hasCreatedRoute || (usesRecordedRoute &&
        (route.provider !== agent.options.provider || route.model !== agent.options.model)))
      ? { ...route } : undefined
    const adopted = seam?.current()
    const seed: ModelSelection | undefined = adopted !== undefined ? { ...adopted } : legacySeed
    const ref: ModelSelectionRef = { current: seed, assembled: undefined }
    const lifetime = createChannelOwner()
    lifetime.bind(deps.owner.current)
    let assemblyOperation = 0
    const current = lifetime.current
    const release = deps.owner.own(() => {
      entries.delete(agent)
      lifetime.dispose()
    })
    entries.set(agent, { ref, seam, release })
    // Only a host with no recorded route or creation options needs a seed.
    if (seam !== undefined && adopted === undefined && seed !== undefined) seam.select(seed)
    const own = (dispose: () => void): void => {
      lifetime.own(dispose)
      lifetime.assertActive()
    }
    try {
      own(agent.ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
        const operation = ++assemblyOperation
        // A step fixes its choice before asynchronous tool/prompt resolution.
        // Diagnostics have no fixed step and inspect the current durable choice.
        const selected = seam === undefined ? ref.current
          : (context as { readonly modelSelection?: Readonly<ModelSelection> }).modelSelection ?? seam.current()
        const assembled = await next()
        if (!current()) return assembled
        // A slow context-panel inspection must not replace a newer turn's route.
        if (operation === assemblyOperation) ref.assembled = selected
        if (selected === undefined) return assembled
        return { ...assembled, variables: { ...assembled.variables, provider: selected.provider, model: selected.model } }
      }))
      // Modern hosts fix request routing upstream and reject rewrites here.
      if (seam === undefined) {
        own(agent.ctx.on('agent/request', async (_payload, next) => {
          const resolved = await next()
          if (!current()) return resolved
          const selected = ref.assembled
          if (selected === undefined) return resolved
          const { reasoningEffort: _inheritedEffort, ...withoutInheritedEffort } = resolved
          return {
            ...withoutInheritedEffort,
            provider: selected.provider,
            model: selected.model,
            ...(selected.reasoningEffort === undefined ? {} : { reasoningEffort: selected.reasoningEffort }),
          }
        }))
      }
      // Match upstream installModelSelection's admission-time provenance.
      // Not every composition installs it, but one step must have at most one notice.
      own(agent.ctx.on('agent/pre-step', async (payload, next) => {
        const { agent: subject, messages, signal, step } = payload
        const decision = await next()
        if (!current() || decision.kind === 'reject' || signal.aborted) return decision
        if (decision.messages.length === 0 && (step === 1 || messages.length > 0)) return decision
        const selected = seam === undefined ? ref.assembled
          : (payload as { readonly modelSelection?: Readonly<ModelSelection> }).modelSelection
        const previous = subject.session.requestHeader()?.config
        if (selected === undefined || previous === undefined ||
            (selected.provider === previous.provider && selected.model === previous.model) ||
            decision.messages.some(message => (message.source as { kind?: string } | undefined)?.kind === 'model-selection')) return decision
        const from = selected.provider === previous.provider ? previous.model : `${previous.provider}/${previous.model}`
        const to = selected.provider === previous.provider ? selected.model : `${selected.provider}/${selected.model}`
        return { ...decision, messages: [...decision.messages, createUserMessage({
          content: [{ type: 'text', text: `[model changed: assistant turns above this point were generated by ${from}; the session continues with ${to}]` }],
          // Older source unions lack this kind; the runtime shape is unchanged.
          source: { kind: 'model-selection', form: 'notice', summary: boundContextSummary(`${from} → ${to}`) } as unknown as UserMessage['source'],
        })] }
      }, { prepend: true }))
    } catch (error) {
      try { release() } catch { /* preserve the registration failure */ }
      throw error
    }
    return durable
  }
  return { selection, bind }
}
