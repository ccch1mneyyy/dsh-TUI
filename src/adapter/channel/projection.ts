/**
 * Channel projection module (P4 channel split).
 *
 * This is the pure projection half of the live Channel: it maps the legacy
 * Channel/ChannelState surface into a serializable host-internal projection
 * used by the Kernel Channel Port. It deliberately strips functions, handles,
 * secrets and renderer-only objects from the snapshot.
 */

import type { Channel, ChatRow, ToolRow } from '../../dsh-adapter/channel.js'
import type {
  HostChannelProjectionSnapshot,
  HostChannelRowProjection,
  HostChannelToolProjection,
} from '../ports/channel.js'

function projectTool(row: ToolRow): HostChannelToolProjection {
  return Object.freeze({
    callId: row.callId,
    name: row.name,
    status: row.status,
    argsPreview: row.argsText,
    ...(row.resultText === undefined ? {} : { resultPreview: row.resultText }),
    ...(row.errorText === undefined ? {} : { errorText: row.errorText }),
    startedAt: row.startedAt,
    ...(row.durationMs === undefined ? {} : { durationMs: row.durationMs }),
  })
}

function projectRow(row: ChatRow): HostChannelRowProjection {
  return Object.freeze({
    id: row.id,
    kind: row.kind,
    text: row.text,
    ...(row.label === undefined ? {} : { label: row.label }),
    ...(row.streaming === undefined ? {} : { streaming: row.streaming }),
    ...(row.time === undefined ? {} : { time: row.time }),
    ...(row.seq === undefined ? {} : { seq: row.seq }),
    ...(row.tool === undefined ? {} : { tool: projectTool(row.tool) }),
  })
}

/** Project the current channel transcript rows into a JSON-safe view. */
export function projectChannelRows(rows: readonly ChatRow[]): readonly HostChannelRowProjection[] {
  return Object.freeze(rows.map(projectRow))
}

/** Project the live Channel into the serializable renderer projection. */
export function projectChannelSnapshot(channel: Channel): HostChannelProjectionSnapshot {
  return Object.freeze({
    version: channel.version,
    rows: projectChannelRows(channel.rows),
    status: channel.status,
    sessionTitle: channel.sessionTitle,
    agentId: channel.agentId,
    model: channel.model,
    provider: channel.provider,
    cwd: channel.cwd,
    displayCwd: channel.displayCwd,
    working: channel.working,
    activeToolCount: channel.activeToolCount,
    lastUserText: channel.lastUserText,
    commandList: Object.freeze(channel.commandList.map(command => Object.freeze({
      name: command.name,
      ...(command.description === undefined ? {} : { description: command.description }),
    }))),
    contextSegments: Object.freeze({ ...channel.contextSegments }),
    subagents: Object.freeze([...channel.subagents]),
  })
}
