/**
 * The UI's capability snapshot of a bound session (`ChannelUi.backendCapabilities`):
 * plain readonly data derived once per binding from the session's typed
 * capabilities. The composition root says whether the session is a DSH
 * session (only the DSH directory may look at `native.dsh`); a DSH session
 * supports everything the TUI offers today, any other session exactly what
 * its capabilities declare.
 */
import type { ChannelCapabilities } from '../adapter/ports/channel-view.js'
import type { SessionCapabilities } from '../agent/capabilities.js'
import { supportedLocalCommandNames } from '../commands.js'

/** Build the snapshot for one bound session. */
export function channelCapabilities(input: {
  readonly backendId: string
  readonly backendLabel: string
  readonly capabilities: SessionCapabilities
  /** The session carries the DSH specialists' escape hatch. */
  readonly dsh: boolean
  /** The channel can reopen this backend's persisted sessions (its catalog
   *  and `open` are wired); DSH sessions always can. */
  readonly resume?: boolean
}): ChannelCapabilities {
  const caps = input.capabilities
  const flags = {
    permissions: input.dsh || caps.permissions !== undefined,
    models: input.dsh || caps.models !== undefined,
    effort: input.dsh || caps.effort !== undefined,
    modes: input.dsh || caps.modes !== undefined,
    compact: input.dsh || caps.compact !== undefined,
    rewind: input.dsh || caps.rewind !== undefined,
    fork: input.dsh || caps.fork !== undefined,
    // Resume is a backend-level act (re-open a persisted session): the
    // channel offers it when the backend's catalog and `open` are wired.
    resume: input.dsh || input.resume === true,
    subagents: input.dsh || caps.subagents !== undefined,
    tasks: input.dsh || caps.tasks !== undefined,
    mcp: input.dsh || caps.mcp !== undefined,
    context: input.dsh || caps.context !== undefined,
    login: input.dsh || caps.auth !== undefined,
    sideQuery: input.dsh || caps.sideQuery !== undefined,
    rename: input.dsh || caps.rename !== undefined,
    color: input.dsh || caps.color !== undefined,
  }
  return Object.freeze({
    backendId: input.backendId,
    backendLabel: input.backendLabel,
    commands: Object.freeze([...supportedLocalCommandNames({ dsh: input.dsh, has: capability => flags[capability] })]),
    retractPending: caps.retractPending === true,
    ...flags,
    // Not a command requirement: `/mcp` itself stays on every backend.
    mcpControl: !input.dsh && caps.mcp?.reconnect !== undefined && caps.mcp.toggle !== undefined,
  })
}
