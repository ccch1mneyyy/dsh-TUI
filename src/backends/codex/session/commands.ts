/** Codex-only slash commands. Local TUI names retain precedence. */
import type { AgentEvent, CommandInfo } from '../../../agent/events.js'
import type { AgentInput, SubmitPlacement } from '../../../agent/session.js'
import { BACKEND_CHANNEL_COMMAND, BACKEND_GOAL_COMMAND, BACKEND_PERMISSION_COMMAND, LOCAL_COMMANDS } from '../../../commands.js'
import { t } from '../../../i18n.js'
import { arr, errorText, num, rec, str, type Rec } from '../narrow.js'
import { CLIENT, NOTIFY, type UserInput } from '../protocol/index.js'
import type { CodexHub } from '../rpc/hub.js'
import { rpcCode, RPC_ERROR } from '../rpc/client.js'
import type { ItemContext } from '../translate/items.js'
import { rateLimitOf } from '../translate/usage.js'

export function reviewTarget(args: string): Rec {
  const value = args.trim()
  if (value === '') return { type: 'uncommittedChanges' }
  const match = /^(base|commit)\s+(.+)$/u.exec(value)
  if (match?.[1] === 'base') return { type: 'baseBranch', branch: match[2]!.trim() }
  if (match?.[1] === 'commit') return { type: 'commit', sha: match[2]!.trim(), title: null }
  return { type: 'custom', instructions: value }
}

interface CommandDeps {
  readonly hub: CodexHub
  readonly ctx: ItemContext
  readonly cwd: string
  threadId(): string
  busy(): boolean
  emit(events: readonly AgentEvent[]): void
  lastDiff(): string | undefined
  planSupported(): boolean
  setPlan(): Promise<void>
  submit(input: AgentInput, placement: SubmitPlacement, wireInput?: readonly UserInput[]): Promise<{ readonly accepted: boolean; readonly reason?: string }>
  noteTurnStarted(id: string): void
}

export function createCodexCommands(deps: CommandDeps) {
  let skills: Promise<readonly Rec[]> | undefined
  let revision = 0
  const local = new Set([...LOCAL_COMMANDS, BACKEND_PERMISSION_COMMAND, BACKEND_CHANNEL_COMMAND, BACKEND_GOAL_COMMAND].map(command => command.name.toLowerCase()))
  const reserved = new Set([...local, 'review', 'diff', 'plan', 'usage'])
  const loadSkills = (): Promise<readonly Rec[]> => {
    if (skills !== undefined) return skills
    const loading = deps.hub.call(CLIENT.skillsList, { cwds: [deps.cwd] }).then(response => {
      const seen = new Set<string>()
      return arr(rec(response)?.data).flatMap(raw => arr(rec(raw)?.skills)).flatMap(raw => {
        const skill = rec(raw)
        const name = str(skill?.name)
        const key = name?.toLowerCase()
        if (skill === undefined || skill.enabled === false || name === undefined || key === undefined || str(skill.path) === undefined
          || !/^[a-z0-9][a-z0-9_-]*$/iu.test(name) || reserved.has(key) || seen.has(key)) return []
        seen.add(key)
        return [skill]
      })
    }).catch(error => { if (skills === loading) skills = undefined; throw error })
    skills = loading
    return loading
  }
  const output = (text: string): void => {
    const seq = deps.ctx.nextSeq()
    deps.emit([{ type: 'user.message', id: `codex-local-${seq}`, anchor: `codex-local-${seq}`, seq, time: deps.ctx.now(), source: 'command-output', text, blocks: [{ type: 'text', text }] }])
  }
  const list = async (): Promise<readonly CommandInfo[]> => [
    { name: 'review', description: t('codex-command-review') },
    { name: 'diff', description: t('codex-command-diff') },
    ...(deps.planSupported() ? [{ name: 'plan', description: t('codex-command-plan') }] : []),
    { name: 'usage', description: t('codex-command-usage') },
    ...(await loadSkills()).map(skill => ({ name: str(skill.name)!, description: str(skill.shortDescription) ?? str(skill.description) })),
  ]

  const changed = (): void => {
    skills = undefined
    const current = ++revision
    void list().then(commands => { if (current === revision) deps.emit([{ type: 'commands.changed', commands }]) }, error => {
      if (current === revision) deps.emit([{ type: 'notice', level: 'warning', key: 'codex-skills', text: t('capability-failed', { name: 'skills', err: errorText(error) }) }])
    })
  }
  return {
    capability: { list },
    changed,
    async submit(input: AgentInput, placement: SubmitPlacement): Promise<{ readonly accepted: boolean; readonly reason?: string } | undefined> {
      const match = /^\/([a-z0-9_-]+)(?:\s+([\s\S]*))?$/iu.exec(input.text.trim())
      if (match === null) return undefined
      const name = match[1]!.toLowerCase()
      const args = match[2] ?? ''
      switch (name) {
        case 'review': {
          if (deps.busy()) return { accepted: false, reason: t('codex-command-idle') }
          const result = rec(await deps.hub.call(CLIENT.reviewStart, { threadId: deps.threadId(), target: reviewTarget(args), delivery: 'inline' }))
          const id = str(rec(result?.turn)?.id)
          if (id !== undefined) deps.noteTurnStarted(id)
          return { accepted: true }
        }
        case 'plan':
          await deps.setPlan()
          return args.trim() === '' ? { accepted: true } : deps.submit({ ...input, text: args, blocks: [{ type: 'text', text: args }, ...(input.blocks?.slice(1) ?? [])] }, placement)
        case 'diff': {
          let diff = deps.lastDiff()
          if (diff === undefined || diff === '') {
            try {
              const response = rec(await deps.hub.call(CLIENT.gitDiffToRemote, { cwd: deps.cwd }))
              diff = str(response?.diff)
            } catch (error) {
              if (rpcCode(error) !== RPC_ERROR.methodNotFound && rpcCode(error) !== RPC_ERROR.invalidParams) throw error
            }
          }
          output(diff === undefined || diff === '' ? t('codex-diff-empty') : diff)
          return { accepted: true }
        }
        case 'usage': {
          const response = rec(await deps.hub.call(CLIENT.accountRateLimitsRead, {})) ?? {}
          const { view } = rateLimitOf(response)
          const buckets = Object.entries(rec(response.rateLimitsByLimitId) ?? {}).flatMap(([id, raw]) => {
            const snapshot = rec(raw)
            return snapshot === undefined ? [] : [{ id, snapshot }]
          })
          if (buckets.length === 0) buckets.push({ id: '', snapshot: rec(response.rateLimits) ?? {} })
          const lines = buckets.flatMap(({ id, snapshot }) => {
            const windows = rateLimitOf({ rateLimits: snapshot }).view?.windows ?? []
            const rows = windows.map(window => {
              const name = window.name === 'five_hour' ? t('status-rate-limit-five-hour') : window.name === 'seven_day' ? t('status-rate-limit-seven-day') : window.name
              return t('codex-usage-window', { name, used: Math.round(window.utilization * 100), reset: window.resetsAt === undefined ? t('doctor-unknown') : new Date(window.resetsAt).toLocaleString() })
            })
            const credits = rec(snapshot.credits)
            if (credits !== undefined) rows.push(t('codex-usage-credits', { balance: str(credits.balance) ?? num(credits.balance) ?? t('doctor-unknown'), unlimited: credits.unlimited === true ? t('codex-yes') : t('codex-no') }))
            return rows.length > 0 && id !== '' ? [str(snapshot.limitName) ?? id, ...rows] : rows
          })
          output(lines.length === 0 ? t('codex-usage-unavailable') : lines.join('\n'))
          if (view !== undefined) deps.emit([{ type: 'rate-limit', info: view }])
          return { accepted: true }
        }
        default: {
          if (local.has(name)) return undefined
          const skill = (await loadSkills()).find(row => str(row.name)?.toLowerCase() === name)
          const path = str(skill?.path)
          if (skill === undefined || path === undefined) return undefined
          const text = args.trim()
          const wire: UserInput[] = [{ type: 'skill', name: str(skill.name)!, path }, { type: 'text', text, text_elements: [] }]
          return deps.submit(input, placement, wire)
        }
      }
    },
    note(method: string): void { if (method === NOTIFY.skillsChanged) changed() },
  }
}
