import type { Context } from '@deepseek-ai/cordis'
import type { Agent, ModelSelection } from '@deepseek-ai/dsh-agent'
import { boundContextSummary, createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import { createChannelOwner, type ChannelOwner } from './owner.js'

/**
 * The mutable route this channel owns for one agent.
 *
 * Upstream 0.2.2 replaced the exported `ModelSelectionRef` with an
 * Agent-owned, session-durable selection (`Agent.model`, `model/selection`),
 * so the shape is declared here instead of imported; `assembled` stays a
 * channel-local capture of the route the current step entered assembly with.
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

function modelSeamOf(agent: Agent): ModelSeam | undefined {
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
    entry.ref.current = value
    // Recorded so a resumed session and the upstream loop agree; an equal
    // selection is a no-op upstream.
    if (value !== undefined && entry.seam !== undefined && !sameRoute(value, entry.seam.current())) {
      entry.seam.select(value)
    }
  }
  const selection: ModelSelectionRef = {
    get current() { return foreground().ref.current },
    set current(value) { write(foreground(), value) },
    get assembled() { return foreground().ref.assembled },
    set assembled(value) { foreground().ref.assembled = value },
  }
  deps.owner.own(ctx.on('agent/disposed', ({ agent }) => entries.get(agent)?.release()))

  const bind = (agent: Agent, route: { provider: string; model: string }): void => {
    deps.owner.assertActive()
    if (entries.has(agent)) return
    const seam = modelSeamOf(agent)
    const recorded = agent.session.requestHeader?.()?.config
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
    // 0.2.2+: the session already owns the answer (recorded selection, last
    // request, then creation options), so adopt it instead of re-deriving it.
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
    // Adopt-first: a resumed session's durable route is authoritative and must
    // not be re-recorded on rebind. Only an agent with no route at all (no
    // recorded selection, no request, no creation options) needs the seed
    // recorded, or the next step fails upstream's "has no provider/model".
    if (seam !== undefined && adopted === undefined && seed !== undefined) seam.select(seed)
    const own = (dispose: () => void): void => {
      lifetime.own(dispose)
      lifetime.assertActive()
    }
    try {
      own(agent.ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
        const operation = ++assemblyOperation
        const selected = ref.current
        const assembled = await next()
        if (!current()) return assembled
        // A slow context-panel inspection must not replace a newer turn's route.
        if (operation === assemblyOperation) ref.assembled = selected
        if (selected === undefined) return assembled
        return { ...assembled, variables: { ...assembled.variables, provider: selected.provider, model: selected.model } }
      }))
      // Hosts before 0.2.2 fix the route only through this waterfall. Later
      // hosts fix it at step preparation and reject a waterfall that rewrites
      // it, so the override must not be registered there.
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
      own(agent.ctx.on('agent/pre-step', async ({ agent: subject, messages, signal, step }, next) => {
        const decision = await next()
        if (!current() || decision.kind === 'reject' || signal.aborted) return decision
        if (decision.messages.length === 0 && (step === 1 || messages.length > 0)) return decision
        const selected = ref.assembled
        const previous = subject.session.requestHeader()?.config
        if (selected === undefined || previous === undefined ||
            (selected.provider === previous.provider && selected.model === previous.model)) return decision
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
  }
  return { selection, bind }
}
