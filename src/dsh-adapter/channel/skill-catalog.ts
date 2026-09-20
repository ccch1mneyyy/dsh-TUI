import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import type { CommandRuntime } from '@deepseek-ai/dsh-commands'
import { isUserInvocable, renderSkillContent, type SkillSummary } from '@deepseek-ai/dsh-skill'
import { HIDDEN_COMMAND_NAMES, isLocalCommandName, parseCommandName, LOCAL_COMMANDS, type LocalCommand, type LocalizedDescriptions } from '../../commands.js'
import { t } from '../../i18n.js'
import { serviceForAgent } from '../presets.js'
import { hasCommandErrorCode, mapCommandError } from '../command-errors.js'
import type { ChannelOwner } from './owner.js'
import type { SkillRegistry } from './loaded-context.js'

const SKILL_COMMAND_RETRY_MS = 800
const MAX_SKILL_RETRY_ATTEMPTS = 3

/** Owns the merged catalog, host registrations, retry timer and all skill reads. */
export function createSkillCatalog(
  ctx: Context,
  deps: {
    owner: Pick<ChannelOwner, 'current' | 'own'>
    commandService: CommandRuntime | undefined
    agent(): Agent
    cwd(): string
    setCommands(commands: LocalCommand[]): void
    commandDescriptions(name: string): LocalizedDescriptions | undefined
    /** Submit a user line through the channel's delivery pipeline. The
     *  fallback skill path rides this same entry point and attaches the
     *  rendered body, so the line stays a plain user message (fence, pending
     *  preview and `@` expansion included) and the body is appended to that
     *  message's step batch — never a turn of its own. */
    deliverUserText(text: string, placement: 'followup', attach?: UserMessage): void
  },
) {
  let commandListSeq = 0
  let skillCommandSeq = 0
  let lastGoodSkills: { agent: Agent; commands: LocalCommand[] } | undefined
  const registrations = new Map<string, { dispose: () => void; description: string }>()
  const refused = new Set<string>()
  let retry: ReturnType<typeof setTimeout> | undefined
  let retryAttempts = 0
  let released = false

  const resetRetry = (): void => {
    if (retry !== undefined) clearTimeout(retry)
    retry = undefined
    retryAttempts = 0
  }

  const viewOptions = (agent: Agent): { scope: Agent; cwd: string } => ({ scope: agent, cwd: deps.cwd() })
  const registryFor = (agent: Agent): SkillRegistry | undefined => serviceForAgent<SkillRegistry>(ctx, agent, 'skills')

  const refreshCommands = (): void => {
    if (!deps.owner.current()) return
    const target = deps.agent()
    const token = ++commandListSeq
    const merged: LocalCommand[] = [...LOCAL_COMMANDS]
    if (deps.commandService !== undefined) {
      for (const descriptor of deps.commandService.list(target)) {
        if (!deps.owner.current()) return
        if (HIDDEN_COMMAND_NAMES.has(descriptor.name) || merged.some(command => command.name === descriptor.name)) continue
        const descriptions = deps.commandDescriptions(descriptor.name)
        // `images` became `attachments` upstream (composer attachment
        // admission); read both so older cohorts keep their image commands.
        const input = descriptor.input as { hint?: string; attachments?: boolean; images?: boolean } | undefined
        merged.push({ name: descriptor.name, description: descriptor.description, ...(descriptions === undefined ? {} : { descriptions }), tag: input?.hint, external: true, acceptsImages: input?.attachments ?? input?.images === true, ...(registrations.has(descriptor.name) ? { skill: true } : {}) })
      }
    }
    if (!deps.owner.current() || target !== deps.agent()) return
    deps.setCommands(merged)
    if (!deps.owner.current() || target !== deps.agent()) return
    const registry = registryFor(target)
    if (registry === undefined) return
    const restore = (): void => {
      if (!deps.owner.current() || target !== deps.agent()) return
      const fallback = lastGoodSkills?.agent === target ? lastGoodSkills.commands : []
      const entries = fallback.filter(entry => !merged.some(command => command.name === entry.name))
      if (entries.length > 0) deps.setCommands([...merged, ...entries])
    }
    void registry.snapshot(viewOptions(target)).then(observation => {
      if (!deps.owner.current() || token !== commandListSeq || target !== deps.agent()) return
      if (!observation.complete) {
        ctx.logger.warn('skill command merge: incomplete catalog observation, keeping last-good skills')
        restore()
        return
      }
      // Cache the observation, not the delta: registered skills are already
      // in merged on later reads. Local/host collisions still win on restore.
      const skills: LocalCommand[] = []
      for (const skill of observation.skills) {
        if (isUserInvocable(skill) && !skills.some(command => command.name === skill.name)) {
          skills.push({ name: skill.name, description: skill.description, skill: true })
        }
      }
      lastGoodSkills = { agent: target, commands: skills }
      const added = skills.filter(entry => !merged.some(command => command.name === entry.name))
      if (added.length > 0 && deps.owner.current() && target === deps.agent()) deps.setCommands([...merged, ...added])
    }).catch((error: unknown) => {
      if (!deps.owner.current() || token !== commandListSeq || target !== deps.agent()) return
      ctx.logger.warn('skill command merge failed: %o', error)
      restore()
    })
  }

  const refreshSkillCommands = async (fromRetry = false): Promise<void> => {
    if (released || !deps.owner.current() || deps.commandService === undefined) return
    // Explicit refreshes (including skills/change and agent swaps) supersede
    // the old ladder. Only the timer continuation consumes the same budget.
    if (!fromRetry) resetRetry()
    const token = ++skillCommandSeq
    const target = deps.agent()
    const registry = registryFor(target)
    if (registry === undefined) return
    let observation
    try { observation = await registry.snapshot(viewOptions(target)) } catch (error) {
      if (deps.owner.current() && token === skillCommandSeq && target === deps.agent()) ctx.logger.warn('skill commands: catalog read failed: %o', error)
      return
    }
    if (!deps.owner.current() || token !== skillCommandSeq || target !== deps.agent()) return
    if (!observation.complete) {
      if (retry === undefined && retryAttempts < MAX_SKILL_RETRY_ATTEMPTS) {
        const delay = SKILL_COMMAND_RETRY_MS * 2 ** retryAttempts++
        retry = setTimeout(() => {
          retry = undefined
          if (token === skillCommandSeq && target === deps.agent()) void refreshSkillCommands(true)
        }, delay)
        retry.unref?.()
      }
      // Partial reads cannot revoke callable handlers or replace descriptions.
      // Keep the last-good registrations until an authoritative observation.
      return
    }
    resetRetry()
    const wanted = new Map<string, string>(observation.skills
      .filter(isUserInvocable)
      .filter(skill => parseCommandName(`/${skill.name}`)?.name === skill.name)
      .filter(skill => !isLocalCommandName(skill.name))
      .map(skill => [skill.name, skill.description] as const))
    for (const [name, entry] of registrations) {
      if (wanted.get(name) === entry.description) continue
      entry.dispose()
      registrations.delete(name)
    }
    for (const [name, description] of wanted) {
      if (registrations.has(name) || refused.has(name) || deps.commandService.find(target, name) !== undefined) continue
      try {
        const dispose = deps.commandService.register({
          name, description, recordInput: false,
          handler: async ({ agent: invoker, rawInput, signal }) => {
            // This registration is bound to this Channel; retained handlers
            // must never redirect another agent into its current session.
            if (!deps.owner.current() || invoker !== deps.agent()) return { kind: 'error', text: t('skill-unavailable', { name }) }
            const tools = ctx.get('tools') as { get(name: string, scope?: unknown): unknown } | undefined
            if (tools?.get('skill', invoker) !== undefined) {
              if (!deps.owner.current() || invoker !== deps.agent()) return { kind: 'error', text: t('skill-unavailable', { name }) }
              deps.deliverUserText(`/${name}${rawInput}`, 'followup')
              return { kind: 'success' }
            }
            const skill = await registryFor(invoker)?.get(name, { ...viewOptions(invoker), signal })
            if (skill === undefined || !isUserInvocable(skill as SkillSummary)) return { kind: 'error', text: t('skill-unavailable', { name }) }
            if (!deps.owner.current() || invoker !== deps.agent()) return { kind: 'error', text: t('skill-unavailable', { name }) }
            // No `skill` tool: deliver the gesture as the user's own line and
            // attach the rendered body. The channel's resident pre-step
            // listener appends the body AFTER the admitted batch — the same
            // shape/order as dsh-tool-skill's gesture boundary (#842).
            const bodyMessage = createUserMessage({ content: [{ type: 'text', text: renderSkillContent(skill as never) }], source: { kind: 'skill-invocation', name, form: 'instructions' } })
            deps.deliverUserText(`/${name}${rawInput}`, 'followup', bodyMessage)
            return { kind: 'success' }
          },
        })
        registrations.set(name, { dispose, description })
        ctx.get('tuiEffectLedger')?.record({ operation: 'create', resource: { kind: 'command', id: name }, result: 'applied' }, ctx)
      } catch (error) {
        const mapped = mapCommandError(error)
        refused.add(name)
        ctx.logger.warn(`skill commands: "${name}" not registrable%s: %o`, hasCommandErrorCode(mapped, 'DUPLICATE_CONTRIBUTION_ID') ? ' (DUPLICATE_CONTRIBUTION_ID)' : '', mapped)
        ctx.get('tuiEffectLedger')?.record({ operation: 'create', resource: { kind: 'command', id: name }, result: 'failed', errorCode: hasCommandErrorCode(mapped, 'DUPLICATE_CONTRIBUTION_ID') ? 'DUPLICATE_CONTRIBUTION_ID' : 'COMMAND_FAILED' }, ctx)
      }
    }
  }
  const release = (): void => {
    if (released) return
    released = true
    skillCommandSeq += 1
    resetRetry()
    for (const entry of registrations.values()) entry.dispose()
    registrations.clear()
  }
  const start = (): void => {
    if (!deps.owner.current()) return
    // Establish a single idempotent teardown before the first registration;
    // a later ctx.on() throw then rolls back every earlier listener.
    const owned: Array<() => void> = [deps.owner.own(release)]
    try {
      owned.push(deps.owner.own(ctx.on('commands/change', refreshCommands)))
      owned.push(deps.owner.own(ctx.on('skills/change', () => { refreshCommands(); void refreshSkillCommands() })))
      if (!deps.owner.current()) {
        for (const dispose of owned.reverse()) dispose()
        return
      }
      refreshCommands()
      void refreshSkillCommands()
    } catch (error) {
      for (const dispose of owned.reverse()) dispose()
      throw error
    }
  }
  return { start, release, refreshCommands, refreshSkillCommands, registryFor, viewOptions }
}
