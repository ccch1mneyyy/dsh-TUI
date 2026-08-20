/**
 * Channel-level verification of the header whale-art toggle (settings
 * `dsh-tui.whale`, default on): real Channel via createChannel + fake
 * ctx/agent, plain node against the compiled lib.
 *
 * - whale defaults to on, `whale: false` opts out
 * - setWhale flips the flag and notifies subscribers exactly once;
 *   setting the same value is a no-op (no re-emit)
 *
 * Run with plain node against the compiled lib: `node scripts/verify-whale-toggle.mjs`
 */
import { createChannel } from '../lib/types/dsh-adapter/channel.js'

let failed = 0
function check(name, ok, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed += 1
}

function makeChannel(options = {}) {
  const handlers = new Map()
  const ctx = {
    on(event, handler) {
      handlers.set(event, handler)
      return () => handlers.delete(event)
    },
    get() {
      return undefined
    },
    logger: { warn() {} },
  }
  const agent = {
    id: 'a1',
    status: 'idle',
    session: { id: 's1', seq: 0, events: [] },
    ctx: { on: () => () => {} },
    followup() {},
    steer() {},
  }
  return createChannel(ctx, agent, {
    model: 'deepseek-chat',
    cwd: '/tmp',
    provider: 'deepseek',
    activity: false,
    ...options,
  })
}

// ---- default on / explicit opt-out
check('whale defaults to on', makeChannel().whale === true)
check('whale: false opts out', makeChannel({ whale: false }).whale === false)

// ---- setWhale flips once, idempotent on repeat
const channel = makeChannel()
let notified = 0
channel.subscribe(() => { notified += 1 })
channel.setWhale(false)
check('setWhale(false) flips the flag', channel.whale === false)
check('subscriber notified once', notified === 1)
channel.setWhale(false)
check('repeat setWhale is a no-op', notified === 1)
channel.setWhale(true)
check('setWhale(true) restores the default view', channel.whale === true && notified === 2)

process.exit(failed === 0 ? 0 : 1)
