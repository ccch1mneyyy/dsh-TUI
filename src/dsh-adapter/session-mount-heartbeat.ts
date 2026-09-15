/**
 * Publishes this TUI process's mounted-session set to the cross-process
 * ledger ({@link ../../sessionMounts.js}) on a small heartbeat.
 *
 * A TUI terminal hosts several agent sessions at once — the attached one plus
 * every parked background session — and two processes driving the same
 * session log would interleave writes into one append-only transcript. The
 * ledger is what lets another TUI see "this session is already mounted" and
 * refuse it, so the heartbeat has to cover EVERY live agent in this process,
 * not just the attached one. Reading the agent registry is what makes that
 * automatic: a session dispatched from `/resume`, parked by a switch, or
 * created by `/new` is published on the next beat without any call site
 * having to remember to announce it.
 *
 * The timer is deliberately unref'd: it must never be the reason a quitting
 * TUI stays alive. Teardown removes the record outright so a clean exit frees
 * its sessions immediately instead of leaving them claimed for one TTL.
 *
 * Registered through the host's single teardown funnel by the caller, so both
 * the interval and the ledger record are released exactly once.
 *
 * @module
 */

import type { Context } from '@deepseek-ai/cordis'
import { clearOwnMounts, HEARTBEAT_INTERVAL_MS, publishMounts } from '../sessionMounts.js'

/** The subset of the host agent registry this module reads. */
type AgentRoster = {
  list?(): readonly { readonly id: unknown; readonly session: { readonly header: { readonly origin?: string } } }[]
}

/**
 * Collect the session ids this process currently has mounted: every live agent
 * the registry knows about, minus sub-agent runs.
 *
 * Sub-agents are excluded because they are not independently mountable: they
 * are a parent session's own work, they never appear as `/resume` rows, and
 * claiming their ids would make the parent look occupied to a TUI that only
 * wants to read the parent.
 * @param ctx - The plugin context, for the agent registry.
 * @returns Session ids as strings.
 */
export function mountedSessionIds(ctx: Context): string[] {
  const roster = ctx.get('agents') as AgentRoster | undefined
  const ids: string[] = []
  for (const agent of roster?.list?.() ?? []) {
    if (agent.session.header.origin === 'subagent') continue
    const id = String(agent.id)
    if (id.length > 0) ids.push(id)
  }
  return ids
}

/**
 * Start publishing this process's mounted sessions.
 *
 * The first beat runs synchronously so a session mounted during boot is
 * claimed before the user can reach a second terminal, and every later beat is
 * a self-contained read-modify-write that also prunes owners that died since
 * the previous one.
 * @param ctx - The plugin context, for the agent registry.
 * @returns A disposer that stops the heartbeat and releases the claim.
 */
export function startSessionMountHeartbeat(ctx: Context): () => void {
  let stopped = false
  const beat = (): void => {
    if (stopped) return
    try {
      publishMounts(mountedSessionIds(ctx))
    } catch {
      // The ledger is a safety net around corrupting a shared transcript, and
      // it is also best-effort by contract. A failed beat costs cross-process
      // protection until the next one, which must not disturb this session.
    }
  }
  beat()
  const timer = setInterval(beat, HEARTBEAT_INTERVAL_MS)
  // Never let the heartbeat hold the process open: quitting the TUI must not
  // wait for a timer that exists only to describe a process that is leaving.
  timer.unref?.()

  return () => {
    stopped = true
    clearInterval(timer)
    try {
      clearOwnMounts()
    } catch {
      // A leftover record is reclaimed by liveness on the next reader.
    }
  }
}
