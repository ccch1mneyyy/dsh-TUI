/**
 * Compact cards for DSH's Agent Teams tool results. The tools ship no
 * presenters, so the plain card would show a capitalised tool id and a raw
 * `⎿ {"messageId":…}` line. These views fold known shapes into one line;
 * anything else (an error text, a changed upstream shape) falls back to the
 * plain card. A presenter the tool itself registers always wins: these run
 * only when it has none.
 *
 * Two upstream generations of the same tools are read by shape:
 *
 * - **Team copies** (`0.2.2-rc.1` and earlier): `send_message` takes `target`,
 *   `list_agents` rows carry `target`, `interrupt_agent` answers
 *   `{previousStatus}`, and `spawn_teammate` is the delegation tool (it renders
 *   as the subagent row and as a plain card only when it fails before the
 *   teammate exists — translate.ts).
 * - **Standard controls** (`0.2.2-rc.2` and later): the same tools take
 *   `agent` (a name or a Session id), `list_agents` rows are
 *   `{name, status, description?}`, `send_message` answers `{messageId}`,
 *   `interrupt_agent` `{accepted}`, and `wait_agent` no longer reports
 *   `noProgress`. `spawn_teammate` is gone; `subagent` / `subagent_fork` are
 *   the delegation tools.
 *
 * Older logs keep rendering: a team call is still recognised by its `target`
 * argument, and a legacy control call (`agent_id`) keeps the plain card.
 * Task results carry `owner` (the owner's name) on `0.2.2-rc.2` and
 * `ownerName` before it; both are read.
 *
 * {@link teamMessageOf} reads a delivered team message for the transcript
 * translator.
 *
 * @module
 */

import { agentRelaySourceOf } from '../agent/messages.js'
import type { ToolCallView, ToolResultView } from './channel/types.js'
import { legacySendMessageStatus } from './compat/agent-team-0.2.0.js'

type Args = Record<string, unknown>

const DISPLAY_KEYS: Readonly<Record<string, string>> = {
  send_message: 'tool-name-team-message',
  list_agents: 'tool-name-team-roster',
  wait_agent: 'tool-name-team-wait',
  interrupt_agent: 'tool-name-team-interrupt',
  team_task_create: 'tool-name-team-task',
  team_task_list: 'tool-name-team-task',
  team_task_get: 'tool-name-team-task',
  team_task_update: 'tool-name-team-task',
}

/** The bundle-host delegation tool; its presence is what "team on" means there. */
export const TEAM_SPAWN_TOOL = 'spawn_teammate'

/** Whether `name` is a team tool with a compact card here (not `spawn_teammate`). */
export function isTeamToolName(name: string): boolean {
  return DISPLAY_KEYS[name] !== undefined
}

function isRecord(value: unknown): value is Args {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

function firstLine(text: string): string {
  return text.split('\n', 1)[0]!.trim()
}

/**
 * Which generation of a shared-name control tool this call belongs to.
 * `agent` is the `0.2.2-rc.2` argument name; `target` is the team copy's; a
 * call with `agent_id` (or neither) is a legacy control and stays a plain card.
 */
function controlFlavor(args: Args): 'switch' | 'team' | undefined {
  if (str(args.agent) !== undefined) return 'switch'
  if (str(args.target) !== undefined) return 'team'
  return undefined
}

function callTitle(name: string, args: Args): string | undefined {
  switch (name) {
    case 'send_message': {
      const target = str(args.agent) ?? str(args.target)
      if (target === undefined) return undefined
      const message = str(args.message)
      return message === undefined ? `→ ${target}` : `→ ${target} · ${firstLine(message)}`
    }
    // `list_agents` / `wait_agent` calls carry nothing that tells them from the
    // legacy subagent controls of the same names; only their results do.
    case 'interrupt_agent':
      return str(args.agent) ?? str(args.target)
    case 'team_task_create':
      return str(args.subject)
    case 'team_task_list':
      return ['status', 'owner', 'ready', 'unowned'].flatMap(key => (args[key] === undefined ? [] : [`${key}=${String(args[key])}`])).join(' ') || undefined
    case 'team_task_get':
      return str(args.task_id)
    case 'team_task_update': {
      const id = str(args.task_id)
      const action = str(args.action)
      if (id === undefined || action === undefined) return undefined
      const owner = str(args.owner)
      return owner === undefined ? `${id} ${action}` : `${id} ${action} → ${owner}`
    }
    default:
      return undefined
  }
}

/**
 * Call card for a team tool without its own presenter.
 * @param name - Tool name.
 * @param rawArgs - The call's JSON arguments.
 * @returns the card, or `undefined` when this is not a team tool call it knows.
 */
export function teamToolCallView(name: string, rawArgs: string): ToolCallView | undefined {
  const displayKey = DISPLAY_KEYS[name]
  if (displayKey === undefined) return undefined
  const title = titleOf(name, rawArgs)
  return title === undefined ? undefined : { card: 'generic', title, displayKey, category: 'other' }
}

function titleOf(name: string, rawArgs: string): string | undefined {
  let args: unknown
  try { args = JSON.parse(rawArgs) } catch { return undefined }
  return isRecord(args) ? callTitle(name, args) : undefined
}

function argsOf(rawArgs: string): Args | undefined {
  try {
    const args = JSON.parse(rawArgs) as unknown
    return isRecord(args) ? args : undefined
  } catch {
    return undefined
  }
}

function taskLine(task: Args): string | undefined {
  const id = str(task.id)
  const status = str(task.status)
  if (id === undefined || status === undefined || typeof task.revision !== 'number') return undefined
  // `owner` is the owner's name on 0.2.2-rc.2; earlier views publish `ownerName`.
  const owner = str(task.owner) ?? str(task.ownerName)
  return `${id} r${task.revision} · ${status}${owner === undefined ? '' : ` · ${owner}`}`
}

function resultLine(name: string, value: unknown, args: Args | undefined): string | undefined {
  switch (name) {
    case 'send_message': {
      if (!isRecord(value)) return undefined
      if (value.sent === true) return 'sent'
      // compat(dsh 0.2.0, log): the mailbox status a 0.2.0 send answered.
      const legacyStatus = legacySendMessageStatus(value)
      if (legacyStatus !== undefined) return legacyStatus
      // The rc.2 control answers `{messageId}`; the legacy control's identical
      // record stays raw (its call carries `agent_id`, not `agent`).
      return args !== undefined && controlFlavor(args) === 'switch' && str(value.messageId) !== undefined ? 'sent' : undefined
    }
    case 'list_agents': {
      if (!Array.isArray(value)) return undefined
      const members = value.flatMap(member => {
        if (!isRecord(member) || str(member.status) === undefined) return []
        // `target` is the team copy's row; `name` is the standard control's.
        const label = str(member.target) ?? str(member.name)
        return label === undefined ? [] : [`${label} ${String(member.status)}`]
      })
      return members.length === value.length ? members.join(' · ') : undefined
    }
    case 'wait_agent':
      if (!isRecord(value) || typeof value.timedOut !== 'boolean') return undefined
      // compat(team, log): the team copy's 0.2.2-rc.1 wait reported noProgress.
      if (value.noProgress) return 'noProgress'
      return value.timedOut ? 'timedOut' : 'changed'
    case 'interrupt_agent': {
      if (!isRecord(value)) return undefined
      const previous = str(value.previousStatus)
      if (previous !== undefined) return previous
      // The standard control's `{accepted}` only means something for a call
      // this card understands; a legacy control call keeps the raw result.
      return controlFlavor(args ?? {}) === undefined ? undefined : typeof value.accepted === 'boolean' ? 'accepted' : undefined
    }
    case 'team_task_list': {
      if (!isRecord(value) || !Array.isArray(value.tasks)) return undefined
      const tasks = value.tasks.map(task => (isRecord(task) ? taskLine(task) : undefined))
      if (tasks.includes(undefined)) return undefined
      return tasks.join('\n')
    }
    case 'team_task_create':
    case 'team_task_get':
    case 'team_task_update':
      return isRecord(value) ? taskLine(value) : undefined
    default:
      return undefined
  }
}

/**
 * Result card for a team tool without its own presenter. It replaces the
 * call card, so it carries the call's title too.
 * @param name - Tool name.
 * @param rawArgs - The call's JSON arguments.
 * @param text - The result's text content.
 * @returns the card, or `undefined` for anything but a known result record.
 */
export function teamToolResultView(name: string, rawArgs: string, text: string): ToolResultView | undefined {
  const displayKey = DISPLAY_KEYS[name]
  if (displayKey === undefined || !text.startsWith('{') && !text.startsWith('[')) return undefined
  let value: unknown
  try { value = JSON.parse(text) } catch { return undefined }
  const line = resultLine(name, value, argsOf(rawArgs))
  if (line === undefined) return undefined
  const title = titleOf(name, rawArgs)
  return {
    card: 'generic', displayKey, category: 'other',
    ...title === undefined || title === '' ? {} : { title },
    content: line === '' ? [] : line.split('\n').map(text => ({ type: 'text', text })),
  }
}

/** Relay framing: one whole leading block, `Team message from <name>:`. */
const RELAY_FRAMING = /^Team message from ([^\n]+):$/

/**
 * An Agent Teams message delivered to a session (`user/message`): the
 * generic relay (`agent-message` / `relay`) whose first block is exactly
 * `Team message from <name>:`. A relay is any agent's message (the legacy
 * `send_message` writes one too), so only the team's framing block marks it
 * as a team message; the sender label replaces that block. The relay also
 * reaches the agent-message feed, which owns it on a teammate's own pages;
 * this reading is for the receiving transcript. A 0.2.0 log is read through
 * `compat/agent-team-0.2.0.ts` first.
 */
export function teamMessageOf<B extends { readonly type: string }>(source: unknown, content: readonly B[]): { sender: string; blocks: readonly B[]; text: string } | undefined {
  const first = content[0] as { type: string; text?: unknown } | undefined
  const framing = agentRelaySourceOf(source) !== undefined && first?.type === 'text' && typeof first.text === 'string'
    ? RELAY_FRAMING.exec(first.text)
    : null
  if (framing === null) return undefined
  const sender = framing[1]!
  const blocks = content.slice(1)
  const text = blocks
    .flatMap(block => {
      const value = (block as { text?: unknown }).text
      return block.type === 'text' && typeof value === 'string' ? [value] : []
    })
    .join('\n')
    .trim()
  return { sender, blocks, text }
}
