/** Codex-only slash commands. The host's merge drops a name that collides with
 *  a local command ("local names win"), so this module never has to know the
 *  host's command table. */
import type { AgentEvent, CommandInfo } from '../../../agent/events.js'
import type { AgentInput, SubmitPlacement } from '../../../agent/session.js'
import { manifest } from '../manifest.js'
import { codexText } from '../text.js'
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
  /** Leave Plan for the permission preset that was active before it (the
   *  catalog's `off` token). */
  exitPlan(): Promise<void>
  submit(input: AgentInput, placement: SubmitPlacement, wireInput?: readonly UserInput[]): Promise<{ readonly accepted: boolean; readonly reason?: string }>
  beginReview(): () => void
  noteReviewStarted(id: string): void
}

/** The name the host serves for one of this backend's declared capabilities
 *  (`src/commands.ts`'s three capability-conditional rows, which are not part
 *  of the public surface a backend may read). */
const CAPABILITY_COMMANDS: readonly (readonly [capability: string, command: string])[] = [
  ['goals', 'goal'],
  ['channels', 'channel'],
  ['permissions', 'permission'],
]

export function createCodexCommands(deps: CommandDeps) {
  let skills: Promise<readonly Rec[]> | undefined
  let revision = 0
  /** The names this backend answers itself, which a skill of the same name must
   *  not shadow: its own four plus whatever its own manifest declares (B-5).
   *  A skill that collides with a *local* command is no longer filtered here —
   *  the host drops those when it merges the lists
   *  (`dsh-adapter/channel/core/session-controls.ts`, "local names win"), which
   *  is all claude relies on. */
  const reserved = new Set([
    'review', 'diff', 'plan', 'usage',
    ...CAPABILITY_COMMANDS.filter(([capability]) => manifest.capabilities?.includes(capability) === true).map(([, command]) => command),
  ])
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
  /** Backend commands that do not enter the Codex input queue still need to
   *  retire the channel's optimistic pending row. */
  const claim = (input: AgentInput): void => {
    deps.emit([{ type: 'pending.changed', items: [], claimed: [input.clientMessageId] }])
  }
  const list = async (): Promise<readonly CommandInfo[]> => [
    { name: 'review', description: codexText('codex-command-review') },
    { name: 'diff', description: codexText('codex-command-diff') },
    ...(deps.planSupported() ? [{ name: 'plan', description: codexText('codex-command-plan') }] : []),
    { name: 'usage', description: codexText('codex-command-usage') },
    ...(await loadSkills()).map(skill => ({ name: str(skill.name)!, description: str(skill.shortDescription) ?? str(skill.description) })),
  ]

  const changed = (): void => {
    skills = undefined
    const current = ++revision
    void list().then(commands => { if (current === revision) deps.emit([{ type: 'commands.changed', commands }]) }, error => {
      if (current === revision) deps.emit([{ type: 'notice', level: 'warning', key: 'codex-skills', text: codexText('capability-failed', { name: 'skills', err: errorText(error) }) }])
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
          if (deps.busy()) return { accepted: false, reason: codexText('codex-command-idle') }
          const failStart = deps.beginReview()
          try {
            const result = rec(await deps.hub.call(CLIENT.reviewStart, { threadId: deps.threadId(), target: reviewTarget(args), delivery: 'inline' }))
            const id = str(rec(result?.turn)?.id)
            if (id !== undefined) deps.noteReviewStarted(id)
          } catch (error) {
            failStart()
            throw error
          }
          claim(input)
          return { accepted: true }
        }
        case 'plan': {
          // The TUI catalog names the two states `on`/`off` (the `/plan`
          // completion children — the on/off picker is registry-only and
          // dispatches the bare command and ` off` itself), while this grammar
          // is `/plan [prompt]`: every non-empty argument becomes the turn's
          // prompt. Map both catalog tokens back to their switches so neither
          // word leaks into the conversation as a prompt; every other argument
          // stays the prompt.
          const arg = args.trim()
          if (arg === 'off') {
            await deps.exitPlan()
            claim(input)
            return { accepted: true }
          }
          await deps.setPlan()
          const prompt = arg === 'on' ? '' : args
          if (prompt.trim() === '') {
            claim(input)
            return { accepted: true }
          }
          return deps.submit({ ...input, text: prompt, blocks: [{ type: 'text', text: prompt }, ...(input.blocks?.slice(1) ?? [])] }, placement)
        }
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
          output(diff === undefined || diff === '' ? codexText('codex-diff-empty') : diff)
          claim(input)
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
              const name = window.name === 'five_hour' ? codexText('status-rate-limit-five-hour') : window.name === 'seven_day' ? codexText('status-rate-limit-seven-day') : window.name
              return codexText('codex-usage-window', { name, used: Math.round(window.utilization * 100), reset: window.resetsAt === undefined ? codexText('doctor-unknown') : new Date(window.resetsAt).toLocaleString() })
            })
            const credits = rec(snapshot.credits)
            if (credits !== undefined) rows.push(codexText('codex-usage-credits', { balance: str(credits.balance) ?? num(credits.balance) ?? codexText('doctor-unknown'), unlimited: credits.unlimited === true ? codexText('codex-yes') : codexText('codex-no') }))
            return rows.length > 0 && id !== '' ? [str(snapshot.limitName) ?? id, ...rows] : rows
          })
          output(lines.length === 0 ? codexText('codex-usage-unavailable') : lines.join('\n'))
          if (view !== undefined) deps.emit([{ type: 'rate-limit', info: view }])
          claim(input)
          return { accepted: true }
        }
        default: {
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
