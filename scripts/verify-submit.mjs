/**
 * Channel-level verification of the send chain: a real Channel (createChannel)
 * wired to a minimal fake agent; `channel.submit` must forward every message
 * to `agent.followup` in order — this is the exact path Enter takes (DSH
 * next-turn inbox semantics: processed after the running turn, never
 * interrupting).
 *
 * Run with plain node against the compiled lib: `node scripts/verify-submit.mjs`
 */
import { createChannel } from '../lib/types/channel.js'

let failed = 0
function check(name, ok, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed += 1
}

const followupCalls = []
const ctx = {
  on() {
    return () => {}
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
  followup(message) {
    followupCalls.push(message)
  },
}

const channel = createChannel(ctx, agent, {
  model: 'deepseek-chat',
  cwd: '/tmp',
  provider: 'deepseek',
  activity: false,
})

channel.submit('  第一条消息  ')
channel.submit('第二条消息')
channel.submit('   ')

check('two messages forwarded', followupCalls.length === 2, JSON.stringify(followupCalls.length))
check('trimmed content in order', followupCalls[0]?.content?.[0]?.text === '第一条消息' && followupCalls[1]?.content?.[0]?.text === '第二条消息', JSON.stringify(followupCalls.map(m => m.content?.[0]?.text)))
check('user source kind', followupCalls.every(m => m.source?.kind === 'user'))
check('blank text not forwarded', !followupCalls.some(m => m.content?.[0]?.text === undefined || m.content?.[0]?.text.trim() === ''))

process.exit(failed)
