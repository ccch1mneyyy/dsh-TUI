/**
 * Channel-level verification of the slash-command skill merge (issue #86):
 * creates a real Channel via createChannel against a minimal fake ctx/agent
 * whose `skills` service reports a mixed catalog, and asserts that
 * user-invocable skills land in `channel.commandList` (marked `skill:
 * true`) while model-only skills and name collisions with locals/registry
 * commands stay out. Then mutates the catalog, fires the captured
 * `skills/change` handler, and asserts the menu refreshes live.
 *
 * Run with plain node against the compiled lib: `node scripts/verify-skill-commands.mjs`
 */
import { createChannel } from '../lib/types/channel.js'
import { LOCAL_COMMANDS } from '../lib/types/commands.js'

let failed = 0
function check(name, ok, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed += 1
}

const tick = () => new Promise(resolve => setTimeout(resolve, 20))

const handlers = new Map()
// Mutable catalog: the skills/change phase re-reads this.
const catalog = [
  { name: 'i-h', description: 'Interactive help skill', invocation: { modelInvocable: true, userInvocable: true } },
  { name: 'helper', description: 'A helper skill', invocation: { modelInvocable: true, userInvocable: true } },
  { name: 'secret', description: 'Model-only skill', invocation: { modelInvocable: true, userInvocable: false } },
  // Collisions: the registry command and the local command must win.
  { name: 'plan', description: 'Shadow skill (plan)', invocation: { modelInvocable: true, userInvocable: true } },
  { name: 'review', description: 'Shadow skill (review)', invocation: { modelInvocable: true, userInvocable: true } },
]
const ctx = {
  on(event, handler) {
    handlers.set(event, handler)
    return () => handlers.delete(event)
  },
  get(name) {
    if (name === 'commands') {
      return { list: () => [{ name: 'plan', description: 'Toggle plan mode' }] }
    }
    if (name === 'skills') {
      return { snapshot: async () => ({ skills: catalog, complete: true }) }
    }
    return undefined
  },
  logger: { warn() {} },
}

const agent = {
  id: 'a1',
  status: 'idle',
  session: { id: 's1', seq: 0, events: [] },
  // bindAgent 挂 installModelSelection 需要 agent.ctx 提供"可订阅、返回
  // 解除函数"的最小面（0.3.6 Shift+Tab 推理等级）。
  ctx: { on: () => () => {} },
}

const channel = createChannel(ctx, agent, {
  model: 'deepseek-chat',
  cwd: '/tmp',
  provider: 'deepseek',
  activity: false,
})

// ---- sync phase: locals + registry commands, no skills yet
check(
  'registry command merged synchronously',
  channel.commandList.some(command => command.name === 'plan' && command.external === true),
)
check(
  'skills not in the synchronous list',
  !channel.commandList.some(command => command.name === 'i-h'),
)

await tick()

// ---- async phase: user-invocable skills merged, marked, deduped
const names = channel.commandList.map(command => command.name)
check('user-invocable skill merged (i-h)', names.includes('i-h'))
check('user-invocable skill merged (helper)', names.includes('helper'))
check(
  'skill entries carry the skill marker + description',
  channel.commandList.some(command =>
    command.name === 'i-h' && command.skill === true && command.description === 'Interactive help skill'),
)
check('model-only skill excluded', !names.includes('secret'))
check(
  'registry command wins a name collision',
  channel.commandList.filter(command => command.name === 'plan').length === 1 &&
    channel.commandList.find(command => command.name === 'plan')?.external === true,
)
check(
  'local command wins a name collision',
  channel.commandList.filter(command => command.name === 'review').length === 1 &&
    channel.commandList.find(command => command.name === 'review')?.skill !== true,
)
check(
  'locals all kept',
  LOCAL_COMMANDS.every(local => names.includes(local.name)),
)

// ---- live refresh: skills/change re-reads the catalog
catalog.splice(catalog.findIndex(skill => skill.name === 'helper'), 1)
catalog.push({ name: 'newskill', description: 'Added at runtime', invocation: { modelInvocable: true, userInvocable: true } })
const skillsChange = handlers.get('skills/change')
if (skillsChange === undefined) {
  check('skills/change handler captured', false)
} else {
  check('skills/change handler captured', true)
  skillsChange()
  await tick()
  const refreshed = channel.commandList.map(command => command.name)
  check('removed skill leaves the menu', !refreshed.includes('helper'))
  check('added skill enters the menu', refreshed.includes('newskill'))
  check('kept skill stays', refreshed.includes('i-h'))
}

// ---- skills/change with a failed read keeps the last-good skill list
ctx.get = (name) => {
  if (name === 'commands') return { list: () => [{ name: 'plan', description: 'Toggle plan mode' }] }
  if (name === 'skills') return { snapshot: async () => { throw new Error('scan blew up') } }
  return undefined
}
let warned = 0
ctx.logger = { warn() { warned += 1 } }
skillsChange?.()
await tick()
{
  const after = channel.commandList.map(command => command.name)
  check(
    'failed skill read keeps locals + registry and logs a warning',
    after.includes('plan') && warned >= 1,
    `warned=${warned}`,
  )
  check(
    'failed skill read restores the last-good skills',
    after.includes('i-h') && after.includes('newskill'),
    after.join(','),
  )
}

// ---- an INCOMPLETE observation (provider failure mid-discovery) is not
// authoritative: it must not clear last-good even though it resolves with
// an empty catalog — this is the real SkillRegistry failure shape; list()
// would have hidden it, snapshot() exposes it.
ctx.get = (name) => {
  if (name === 'commands') return { list: () => [{ name: 'plan', description: 'Toggle plan mode' }] }
  if (name === 'skills') return { snapshot: async () => ({ skills: [], complete: false }) }
  return undefined
}
warned = 0
skillsChange?.()
await tick()
{
  const after = channel.commandList.map(command => command.name)
  check(
    'incomplete observation logs a warning',
    warned >= 1,
    `warned=${warned}`,
  )
  check(
    'incomplete observation keeps the last-good skills',
    after.includes('i-h') && after.includes('newskill'),
    after.join(','),
  )
}

// ---- a COMPLETE empty observation IS authoritative: skills vanish for real
catalog.length = 0
ctx.get = (name) => {
  if (name === 'commands') return { list: () => [{ name: 'plan', description: 'Toggle plan mode' }] }
  if (name === 'skills') return { snapshot: async () => ({ skills: [], complete: true }) }
  return undefined
}
skillsChange?.()
await tick()
{
  const after = channel.commandList.map(command => command.name)
  check(
    'complete empty observation authoritatively clears skills',
    !after.includes('i-h') && !after.includes('newskill') && after.includes('plan'),
    after.join(','),
  )
}

// ---- a superseded read failing later stays silent and touches nothing
{
  const pending = []
  ctx.get = (name) => {
    if (name === 'commands') return { list: () => [{ name: 'plan', description: 'Toggle plan mode' }] }
    if (name === 'skills') {
      return { snapshot: () => new Promise((resolve, reject) => pending.push({ resolve, reject })) }
    }
    return undefined
  }
  let staleWarned = 0
  ctx.logger = { warn() { staleWarned += 1 } }
  skillsChange?.() // read A: pending, superseded by B below
  skillsChange?.() // read B: wins the token race
  pending[1].resolve({
    skills: [{ name: 'live', description: 'Live skill', invocation: { modelInvocable: true, userInvocable: true } }],
    complete: true,
  })
  await tick()
  check('superseding read repopulates the menu', channel.commandList.some(command => command.name === 'live'))
  pending[0].reject(new Error('stale scan failed'))
  await tick()
  check('stale read failure logs no warning', staleWarned === 0, `warned=${staleWarned}`)
  check(
    'stale read failure does not touch the live menu',
    channel.commandList.some(command => command.name === 'live') &&
      !channel.commandList.some(command => command.name === 'i-h'),
  )
}

console.log(failed === 0 ? 'ALL PASS' : `${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
