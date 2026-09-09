import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { assembleContextFor } from '@deepseek-ai/dsh-agent'
import { loadBaselineInstructions } from '@deepseek-ai/dsh-agent-instructions'
import { isModelInvocable, type SkillSummary } from '@deepseek-ai/dsh-skill'
import { renderContextSections, renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import type { LoadedContextEntry, LoadedContextFile, LoadedContextSkill, LoadedContextTool } from './types.js'
import type { ChannelOwner } from './owner.js'

export type SkillRegistry = {
  snapshot(options?: { scope?: unknown; cwd?: string }): Promise<{
    skills: readonly SkillSummary[]
    complete: boolean
  }>
  get(name: string, options?: { scope?: unknown; cwd?: string; signal?: AbortSignal }): Promise<unknown>
}

/** Assembles the loaded-context panel. A result belongs only to its origin Agent. */
export function createLoadedContextRefresher(
  ctx: Context,
  deps: {
    owner: Pick<ChannelOwner, 'current'>
    agent(): Agent
    cwd(): string
    publish(context: { sections: LoadedContextEntry[]; contexts: LoadedContextEntry[]; files: LoadedContextFile[]; skills: LoadedContextSkill[]; tools: LoadedContextTool[] }): void
    skillRegistryFor(agent: Agent): SkillRegistry | undefined
    skillViewOptions(agent: Agent): { scope: Agent; cwd: string }
  },
) {
  const refresh = async (): Promise<void> => {
    if (!deps.owner.current()) return
    const target = deps.agent()
    const sections: LoadedContextEntry[] = []
    const contexts: LoadedContextEntry[] = []
    const files: LoadedContextFile[] = []
    const skills: LoadedContextSkill[] = []
    const tools: LoadedContextTool[] = []
    try {
      const systemPrompt = ctx.get('systemPrompt')
      if (systemPrompt !== undefined) {
        const assembly = await systemPrompt.assemble(assembleContextFor(target))
        if (!deps.owner.current() || target !== deps.agent()) return
        for (const section of assembly.sections) {
          const text = renderPrompt({ sections: [section], contexts: [], tools: [], variables: assembly.variables })
          if (text.length > 0) sections.push({ name: section.name, text })
        }
        contexts.push(...renderContextSections(assembly))
        for (const tool of assembly.tools) tools.push({ name: tool.name, description: tool.description ?? '' })
      }
      const renderedInstructions = await loadBaselineInstructions({
        cwd: deps.cwd(), maxBytes: 1024 * 1024, maxSourceBytes: 1024 * 1024,
      }, ctx.get('fs'))
      if (!deps.owner.current() || target !== deps.agent()) return
      const sources = renderedInstructions as (typeof renderedInstructions & { represented?: readonly { displayPath: string }[] })
      const paths = new Set([
        ...(sources?.represented ?? []).map(file => file.displayPath),
        ...(renderedInstructions?.omitted ?? []).map(file => file.displayPath),
        ...(renderedInstructions?.truncated ?? []).map(file => file.displayPath),
      ])
      files.push(...[...paths].map(displayPath => ({ displayPath })))
      const registry = tools.some(tool => tool.name === 'skill') ? deps.skillRegistryFor(target) : undefined
      if (registry !== undefined) {
        const observation = await registry.snapshot(deps.skillViewOptions(target))
        if (!deps.owner.current() || target !== deps.agent()) return
        if (observation.complete) {
          skills.push(...observation.skills.filter(isModelInvocable).map(skill => ({ name: skill.name, description: skill.description })))
        }
      }
    } catch (error) {
      ctx.logger.warn('loaded-context snapshot failed: %o', error)
      return
    }
    if (!deps.owner.current() || target !== deps.agent()) return
    deps.publish({ sections, contexts, files, skills, tools })
  }
  return { refresh }
}
