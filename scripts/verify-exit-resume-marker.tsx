/**
 * Exit resume-marker decision (PR #42 follow-up): apply()'s exit funnel used
 * to judge resumability with the boot-time agent its closure captured, but
 * /resume, /new and /model swap the active agent behind the channel
 * (channel.agentId follows; the old handle is disposed). The stale reference
 * wiped the marker /resume had just written (boot empty → resume into
 * history) or rewrote it to a fresh empty session (boot with history →
 * /new). The decision must run against the live session instead.
 *
 * This script drives the exported decision helper directly:
 * A. boot empty, live session has a user message → resumable;
 * B. boot has a user message, live session empty → not resumable;
 * C. no session switch, current session has a user message → resumable;
 * D. everything empty and nothing pending → not resumable;
 * E. pending > 0 wins regardless of events;
 * plus: a live-agent lookup miss falls back to the captured agent, and a
 * user/message injected by a non-user source does not count.
 */
const { isExitResumable } = await import('../src/dsh-adapter/plugin.js')

let failed = 0
const check = (name: string, ok: boolean) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}`)
  if (!ok) failed++
}

// Minimal structural fakes — the helper only reads session.events.
let seq = 0
const userMessageEvent = (kind = 'user') => ({
  type: 'user/message',
  seq: ++seq,
  time: 0,
  data: { source: { kind } },
})
const turnEvent = (type: 'turn/start' | 'turn/end') => ({ type, seq: ++seq, time: 0, data: {} })
const fakeAgent = (events: unknown[]) => ({ session: { events } })

const EMPTY = fakeAgent([])

// A. fresh boot (no user message), /resume switched into a session with
//    history: the live session decides → marker must stay.
{
  const live = fakeAgent([turnEvent('turn/start'), userMessageEvent(), turnEvent('turn/end')])
  check(
    'A: boot empty, live session has a user message → resumable',
    isExitResumable({ pendingCount: 0, liveAgent: live, startupAgent: EMPTY }) === true,
  )
}

// B. boot session had history, /new switched to an empty session: the stale
//    boot verdict must not leak through → no marker.
{
  const startup = fakeAgent([userMessageEvent()])
  check(
    'B: boot has a user message, live session empty → not resumable',
    isExitResumable({ pendingCount: 0, liveAgent: fakeAgent([]), startupAgent: startup }) === false,
  )
}

// C. no session switch — the captured agent IS the live one.
{
  const same = fakeAgent([turnEvent('turn/start'), userMessageEvent()])
  check(
    'C: same session with a user message → resumable',
    isExitResumable({ pendingCount: 0, liveAgent: same, startupAgent: same }) === true,
  )
}

// D. brand-new session: nothing said, nothing pending → no marker.
{
  check(
    'D: empty live session, no pending → not resumable',
    isExitResumable({ pendingCount: 0, liveAgent: fakeAgent([]), startupAgent: EMPTY }) === false,
  )
}

// E. pending work forces the marker no matter what the events say.
{
  check(
    'E: pending > 0 wins over an empty session',
    isExitResumable({ pendingCount: 1, liveAgent: fakeAgent([]), startupAgent: EMPTY }) === true,
  )
  const live = fakeAgent([userMessageEvent()])
  check(
    'E: pending > 0 stays true with events too',
    isExitResumable({ pendingCount: 2, liveAgent: live, startupAgent: EMPTY }) === true,
  )
}

// Fallback: the live lookup can miss (registry race); the captured agent's
//    session is the verdict then, exactly as before the swap-aware fix.
{
  const startup = fakeAgent([userMessageEvent()])
  check(
    'live lookup miss falls back to the captured agent (resumable)',
    isExitResumable({ pendingCount: 0, liveAgent: undefined, startupAgent: startup }) === true,
  )
  check(
    'live lookup miss falls back to the captured agent (not resumable)',
    isExitResumable({ pendingCount: 0, liveAgent: undefined, startupAgent: EMPTY }) === false,
  )
}

// Only messages the user actually produced count — injected context is a
//    user/message with a non-user source.
{
  const live = fakeAgent([userMessageEvent('plugin')])
  check(
    'user/message from a non-user source does not count',
    isExitResumable({ pendingCount: 0, liveAgent: live, startupAgent: EMPTY }) === false,
  )
}

console.log(failed === 0 ? 'ALL PASS (verify-exit-resume-marker)' : `${failed} check(s) FAILED`)
process.exit(failed)
