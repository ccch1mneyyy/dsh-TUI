import type { Context } from '@deepseek-ai/cordis'
import type { Agent, ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { ModelRoute } from '../modelRoute.js'
import { modelEfforts, type ModelReasoning } from './model-efforts.js'
import type { startupPreferencesFromCmdlineArgs } from './startup-args.js'

export type StartupPreferences = ReturnType<typeof startupPreferencesFromCmdlineArgs>
type Selection = NonNullable<ModelSelectionRef['current']>
const selections = new WeakMap<Agent, Selection>()

/** A bad/unverifiable explicit launch request is not a corrupt resume log. */
export class StartupPreferencesError extends Error {}

/** The override belongs to this agent, including deferred DSH composition and
 * foreground rebindings; it never becomes a user/global preference. */
export function startupSelectionFor(agent: Agent): Selection | undefined {
  return selections.get(agent)
}

export function rememberStartupSelection(agent: Agent, selection: Selection | undefined): void {
  if (selection !== undefined) selections.set(agent, selection)
}

/** An explicit interactive /effort choice supersedes the launch-only pin. */
export function clearStartupEffort(agent: Agent): void {
  const selection = selections.get(agent)
  if (selection !== undefined) selections.set(agent, { provider: selection.provider, model: selection.model })
}

/** Validate explicit launch requests before agent creation/resume or task input.
 * Unlike a stale saved default, an explicit option must never silently fall
 * back. Catalog/transport uncertainty is an error, not permission to guess. */
export async function validateStartupPreferences(ctx: Context, preferences: StartupPreferences | undefined, fallback: ModelRoute): Promise<Selection | undefined> {
  if (preferences?.model === undefined && preferences?.effort === undefined) return undefined
  const route = preferences.model ?? fallback
  const llm = ctx.get('llm') as {
    listModels(provider: string): Promise<readonly { id: string }[]>
    resolveModelInfo(provider: string, model: string): Promise<{ reasoning?: ModelReasoning }>
  } | undefined
  if (llm === undefined) throw new StartupPreferencesError('dsh-tui: cannot validate launch preferences: llm catalog is unavailable')
  try {
    const models = await llm.listModels(route.provider)
    if (!models.some(model => model.id === route.model)) {
      throw new Error(`model ${route.provider}/${route.model} is not advertised by the provider`)
    }
    if (preferences.effort === undefined) return { ...route }
    const info = await llm.resolveModelInfo(route.provider, route.model)
    const efforts = modelEfforts(info.reasoning)
    if (!efforts.some(effort => effort.id === preferences.effort)) {
      throw new Error(`effort "${preferences.effort}" is unsupported by ${route.provider}/${route.model} (available: ${efforts.map(effort => effort.id).join(', ') || 'none'})`)
    }
    return { ...route, reasoningEffort: ReasoningEffortId(preferences.effort) }
  } catch (error) {
    throw new StartupPreferencesError(`dsh-tui: invalid launch preferences: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
  }
}
