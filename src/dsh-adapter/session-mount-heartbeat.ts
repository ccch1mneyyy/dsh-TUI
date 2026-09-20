/**
 * Publishes this TUI process's mounted-session set to the cross-process
 * ledger ({@link ../../sessionMounts.js}).
 *
 * A TUI terminal hosts several agent sessions at once — the attached one plus
 * every parked background session — and two processes driving the same
 * session log would interleave writes into one append-only transcript. The
 * ledger is what lets another TUI see "this session is already mounted" and
 * refuse it, so the published set has to cover EVERY live agent in this
 * process, not just the attached one.
 *
 * Reading the agent registry is what makes that automatic, and the small timer
 * is what keeps it honest: agents are created from more than seven paths
 * (`/new`, `/resume`, `/bg`, fork, rewind, model switch, boot attach), so an
 * announce-at-each-call-site design would silently drop a session the day
 * someone adds an eighth. Deriving the set from the registry has exactly one
 * place to be right.
 *
 * Publishing is NOT a liveness witness: {@link ../../sessionMounts.js} decides
 * liveness from the owner's pid alone, so a late or missed publish cannot keep
 * a dead process's claim alive and there is no timestamp here to expire. The
 * timer's only job is to keep the published SET current, and it is deliberately
 * unref'd: it must never be the reason a quitting TUI stays alive. Teardown
 * removes the record outright so a clean exit frees its sessions immediately.
 *
 * Registered through the host's single teardown funnel by the caller, so both
 * the interval and the ledger record are released exactly once.
 *
 * @module
 */

import type { Context } from '@deepseek-ai/cordis'
import { clearOwnMounts, publishMounts } from '../sessionMounts.js'

/**
 * How often the mounted set is republished. One small file write, not tied to
 * any render frame; it bounds how long a peer can read a set that predates a
 * session this process just mounted.
 */
const PUBLISH_INTERVAL_MS = 15_000

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
 * The first publish runs synchronously so a session mounted during boot is
 * claimed before the user can reach a second terminal.
 * @param ctx - The plugin context, for the agent registry.
 * @returns A disposer that stops publishing and releases the claim.
 */
export function startSessionMountHeartbeat(ctx: Context): () => void {
  let stopped = false
  const beat = (): void => {
    if (stopped) return
    try {
      publishMounts(mountedSessionIds(ctx))
    } catch {
      // PUBLISHING is best-effort; DECIDING is not. A beat that cannot write
      // costs announcement until the next one, and must not disturb this
      // session — while the paths that grant a mount refuse outright when they
      // cannot read the ledger, because that is the one error nothing can
      // repair afterwards.
    }
  }
  beat()
  const timer = setInterval(beat, PUBLISH_INTERVAL_MS)
  // Never let the publisher hold the process open: quitting the TUI must not
  // wait for a timer that exists only to describe a process that is leaving.
  timer.unref?.()

  return () => {
    stopped = true
    clearInterval(timer)
    try {
      clearOwnMounts()
    } catch {
      // A leftover record is ignored once this pid is gone.
    }
  }
}
