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
import { createChannel } from '../lib/types/dsh-adapter/channel.js'
import { LOCAL_COMMANDS } from '../lib/types/commands.js'
import { settled, sleep } from './lib/term-test.mjs'

let failed = 0
function check(name, ok, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed += 1
}

// Multicast: `commands/change` and `skills/change` each have MORE than one
// subscriber inside the channel (the menu merge and the command registration),
// so a single-slot map would silently drop whichever registered first.
const handlers = new Map()
const fire = event => { for (const handler of handlers.get(event) ?? []) handler() }
// Mutable catalog: the skills/change phase re-reads this.
const catalog = [
  { name: 'i-h', description: 'Interactive help skill', invocation: { modelInvocable: true, userInvocable: true }, content: 'HELP BODY', resourceBase: { kind: 'directory', path: '/home/u/.agents/skills/i-h' } },
  { name: 'helper', description: 'A helper skill', invocation: { modelInvocable: true, userInvocable: true } },
  { name: 'secret', description: 'Model-only skill', invocation: { modelInvocable: true, userInvocable: false } },
  // Collisions: the registry command and the local command must win.
  { name: 'plan', description: 'Shadow skill (plan)', invocation: { modelInvocable: true, userInvocable: true } },
  { name: 'review', description: 'Shadow skill (review)', invocation: { modelInvocable: true, userInvocable: true } },
]
/** Commands the channel registered, by name — the registry the skill slash
 *  commands land in. `plan` is pre-owned by another plugin. */
const registered = new Map([['plan', { description: 'Toggle plan mode', owner: 'other-plugin' }]])
const commandService = {
  list: () => [...registered].map(([name, entry]) => ({ name, description: entry.description })),
  find: (_target, name) => registered.get(name),
  register(descriptor) {
    if (registered.has(descriptor.name)) throw new Error(`duplicate command: ${descriptor.name}`)
    registered.set(descriptor.name, descriptor)
    fire('commands/change')
    // Real dsh-commands emits commands/change on unregister too (the effect
    // disposer tears the layer down and notifyChange() fires); the menu
    // merge must hear about a disposed handler or it keeps listing skills
    // whose dispatch command no longer exists.
    return () => { registered.delete(descriptor.name); fire('commands/change') }
  },
}

const ctx = {
  on(event, handler) {
    const list = handlers.get(event) ?? []
    list.push(handler)
    handlers.set(event, list)
    return () => handlers.set(event, (handlers.get(event) ?? []).filter(h => h !== handler))
  },
  get(name) {
    if (name === 'commands') {
      return commandService
    }
    if (name === 'skills') {
      return {
        snapshot: async () => ({ skills: catalog, complete: true }),
        // A `get` miss models a SKILL.md deleted between listing and Enter.
        get: async skillName => catalog.find(skill => skill.name === skillName),
      }
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
  /** Messages the skill handler injected. */
  followups: [],
  followup(message) { this.followups.push(message) },
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

// ---- async phase: user-invocable skills merged, marked, deduped
check('user-invocable skill merged (i-h)', await settled(() => channel.commandList.some(command => command.name === 'i-h')))
check('user-invocable skill merged (helper)', await settled(() => channel.commandList.some(command => command.name === 'helper')))
check(
  'skill entries carry the skill marker + description',
  await settled(() => channel.commandList.some(command =>
    command.name === 'i-h' && command.skill === true && command.description === 'Interactive help skill')),
)
const names = channel.commandList.map(command => command.name)
check('model-only skill excluded', !names.includes('secret'))
check(
  'registry command wins a name collision',
  channel.commandList.filter(command => command.name === 'plan').length === 1 &&
    channel.commandList.find(command => command.name === 'plan')?.external === true,
)
check(
  'review (removed from locals) stays single in the menu as the registered skill command',
  channel.commandList.filter(command => command.name === 'review').length === 1 &&
    channel.commandList.find(command => command.name === 'review')?.skill !== true,
)
check(
  'locals all kept',
  // `/planPrompt` is preset-gated: it only appears in the menu when the
  // session runs the Liangshen preset (its receiver is the packaged
  // plan-aware persona). Its Liangshen listing is covered by
  // scripts/verify-plan-prompt-command.mjs.
  LOCAL_COMMANDS
    .filter(command => command.name !== 'planPrompt')
    .every(local => names.includes(local.name)),
)

// ---- live refresh: skills/change re-reads the catalog
catalog.splice(catalog.findIndex(skill => skill.name === 'helper'), 1)
catalog.push({ name: 'newskill', description: 'Added at runtime', invocation: { modelInvocable: true, userInvocable: true } })
const skillsChange = handlers.get('skills/change')
if (skillsChange === undefined || skillsChange.length === 0) {
  check('skills/change handler captured', false)
} else {
  check('skills/change handler captured', true)
  fire('skills/change')
  check('removed skill leaves the menu', await settled(() => !channel.commandList.some(command => command.name === 'helper')))
  check('added skill enters the menu', await settled(() => channel.commandList.some(command => command.name === 'newskill')))
  check('kept skill stays', channel.commandList.some(command => command.name === 'i-h'))
}

// ---- skills/change with a failed read keeps the last-good skill list
ctx.get = (name) => {
  if (name === 'commands') return { list: () => [{ name: 'plan', description: 'Toggle plan mode' }] }
  if (name === 'skills') return { snapshot: async () => { throw new Error('scan blew up') } }
  return undefined
}
let warned = 0
ctx.logger = { warn() { warned += 1 } }
fire('skills/change')
{
  check(
    'failed skill read keeps locals + registry and logs a warning',
    await settled(() => channel.commandList.some(command => command.name === 'plan') && warned >= 1),
    `warned=${warned}`,
  )
  // keep 语义：完成信号（warned）落定后同步判定，轮询已成立的条件测不到误清。
  const after = channel.commandList.map(command => command.name)
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
fire('skills/change')
{
  check(
    'incomplete observation logs a warning',
    await settled(() => warned >= 1),
    `warned=${warned}`,
  )
  const after = channel.commandList.map(command => command.name)
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
fire('skills/change')
{
  check(
    'complete empty observation authoritatively clears skills',
    await settled(() => {
      const after = channel.commandList.map(command => command.name)
      return !after.includes('i-h') && !after.includes('newskill') && after.includes('plan')
    }),
    channel.commandList.map(command => command.name).join(','),
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
  fire('skills/change') // read A: pending, superseded by B below
  fire('skills/change') // read B: wins the token race
  pending[1].resolve({
    skills: [{ name: 'live', description: 'Live skill', invocation: { modelInvocable: true, userInvocable: true } }],
    complete: true,
  })
  check('superseding read repopulates the menu', await settled(() => channel.commandList.some(command => command.name === 'live')))
  pending[0].reject(new Error('stale scan failed'))
  // Stability probe (nothing may change, nothing may warn): a settle over an
  // already-true condition returns immediately — keep the fixed window.
  await sleep(20)
  check('stale read failure logs no warning', staleWarned === 0, `warned=${staleWarned}`)
  check(
    'stale read failure does not touch the live menu',
    channel.commandList.some(command => command.name === 'live') &&
      !channel.commandList.some(command => command.name === 'i-h'),
  )
}

// ---- invocation: a menu entry is not a command until something dispatches it
//
// The merge above only puts skills in the completion list; without a host
// registry entry, typing the name and pressing Enter has nothing to run. These
// assertions cover the registration and the deterministic body injection.
{
  // The phases above deliberately swap `ctx.get` for pending/failing stubs and
  // empty the catalog; restore both so these assertions describe the
  // registration, not the leftovers.
  ctx.get = name => {
    if (name === 'commands') return commandService
    if (name === 'skills') {
      return {
        snapshot: async () => ({ skills: catalog, complete: true }),
        get: async skillName => catalog.find(skill => skill.name === skillName),
      }
    }
    return undefined
  }
  catalog.length = 0
  catalog.push(
    { name: 'i-h', description: 'Interactive help skill', invocation: { modelInvocable: true, userInvocable: true }, content: 'HELP BODY', resourceBase: { kind: 'directory', path: '/home/u/.agents/skills/i-h' } },
    { name: 'secret', description: 'Model-only skill', invocation: { modelInvocable: true, userInvocable: false } },
    { name: 'plan', description: 'Shadow skill (plan)', invocation: { modelInvocable: true, userInvocable: true } },
    { name: 'review', description: 'Shadow skill (review)', invocation: { modelInvocable: true, userInvocable: true } },
  )
  fire('skills/change')

  check(
    'user-invocable skill is registered as a real command',
    await settled(() => registered.has('i-h') && typeof registered.get('i-h')?.handler === 'function'),
  )
  check('model-only skill is not registered', !registered.has('secret'))
  check(
    'a name another plugin owns is left alone',
    registered.get('plan')?.owner === 'other-plugin',
  )
  // #496: built-in skill names are no longer LOCAL_COMMANDS entries, so the
  // collision filter no longer locks them out — the skill registers as a
  // deterministic dispatch command (handler present) instead of silently
  // falling back to the legacy activation prompt.
  check(
    'a built-in skill name registers as a dispatch command',
    registered.has('review') && typeof registered.get('review')?.handler === 'function',
  )

  const descriptor = registered.get('i-h')
  if (descriptor?.handler === undefined) {
    check('invoking the command injects the skill body', false, 'no handler')
  } else {
    check(
      'the command does not record its own raw input',
      descriptor.recordInput === false,
      `recordInput=${descriptor.recordInput}`,
    )

    // Kernel gesture path: the agent's tool registry exposes `skill`, so
    // dsh-tool-skill's pre-step boundary is mounted — the handler must
    // re-submit the gesture as a plain user message (args riding along),
    // not inject anything itself. submit() rides the async send chain.
    const skillsService = {
      snapshot: async () => ({ skills: catalog, complete: true }),
      get: async skillName => catalog.find(skill => skill.name === skillName),
    }
    ctx.get = name => {
      if (name === 'commands') return commandService
      if (name === 'skills') return skillsService
      if (name === 'tools') return { get: toolName => (toolName === 'skill' ? {} : undefined) }
      return undefined
    }
    agent.followups.length = 0
    const outcome = await descriptor.handler({ agent, rawInput: ' 做年终总结', signal: undefined })
    check('kernel path reports success', outcome?.kind === 'success', JSON.stringify(outcome))
    check('kernel path delivers exactly one message', await settled(() => agent.followups.length === 1))
    const gesture = agent.followups[0]
    check(
      'kernel path submits the gesture as a plain user message with args',
      gesture?.source?.kind === 'user' && gesture.content?.[0]?.text === '/i-h 做年终总结',
      JSON.stringify({ source: gesture?.source, text: gesture?.content?.[0]?.text }),
    )

    // Fallback path: no `skill` tool (e.g. the minimal preset) → the
    // handler injects the rendered body directly, as before.
    ctx.get = name => {
      if (name === 'commands') return commandService
      if (name === 'skills') return skillsService
      return undefined
    }
    agent.followups.length = 0
    const fallbackOutcome = await descriptor.handler({ agent, rawInput: '', signal: undefined })
    check('fallback reports success', fallbackOutcome?.kind === 'success', JSON.stringify(fallbackOutcome))
    const injected = agent.followups[0]
    check('fallback injects exactly one message', agent.followups.length === 1)
    check(
      'fallback message carries the rendered skill body',
      typeof injected?.content?.[0]?.text === 'string' && injected.content[0].text.includes('HELP BODY'),
    )
    check(
      'fallback message is marked as a user skill invocation',
      injected?.source?.kind === 'skill-invocation' && injected.source.name === 'i-h',
      JSON.stringify(injected?.source),
    )
  }

  // A SKILL.md deleted between listing and Enter must report, not throw —
  // on the fallback path (the kernel path leaves unknown names as ordinary
  // prose, the boundary's own contract).
  const goneIndex = catalog.findIndex(skill => skill.name === 'i-h')
  const gone = catalog[goneIndex]
  catalog.splice(goneIndex, 1)
  const missing = await registered.get('i-h').handler({ agent, rawInput: '', signal: undefined })
  check('a vanished skill reports an error instead of throwing', missing?.kind === 'error', JSON.stringify(missing))
  catalog.splice(goneIndex, 0, gone)

  // releaseContributions hands the names back: the registry scopes a
  // registration to the HOST context, so without this a recompose would find
  // the names taken and the re-mounted channel would stop managing them.
  channel.releaseContributions()
  check('releaseContributions disposes the skill commands', !registered.has('i-h'))
  check('releaseContributions leaves other owners alone', registered.has('plan'))
}

// ---- /skills: an isolated channel must discard a snapshot from its old agent
{
  const staleAgentA = {
    id: 'stale-a',
    status: 'idle',
    session: { id: 'stale-s1', seq: 0, events: [], header: { cwd: '/tmp' } },
    ctx: { on: () => () => {} },
    followups: [],
    followup(message) { this.followups.push(message) },
  }
  const staleAgentB = {
    id: 'stale-b',
    status: 'idle',
    session: { id: 'stale-s2', seq: 0, events: [], header: { cwd: '/tmp' } },
    ctx: { on: () => () => {} },
    followups: [],
    followup(message) { this.followups.push(message) },
  }
  let holdNextAgentASnapshot = false
  let pendingSnapshotResolve = () => {}
  let pendingSnapshotStarted = false
  let lastSnapshotScope
  const skillService = {
    list: async () => [],
    snapshot(options) {
      lastSnapshotScope = options?.scope
      if (options?.scope === staleAgentA && holdNextAgentASnapshot) {
        holdNextAgentASnapshot = false
        pendingSnapshotStarted = true
        return new Promise(resolve => { pendingSnapshotResolve = resolve })
      }
      return Promise.resolve({
        skills: options?.scope === staleAgentA
          ? [{ name: 'stable', description: 'Stable skill', invocation: { modelInvocable: true, userInvocable: true } }]
          : [{ name: 'fresh', description: 'Fresh skill', invocation: { modelInvocable: true, userInvocable: true } }],
        complete: true,
      })
    },
    get: async () => undefined,
  }
  const staleCtx = {
    on: () => () => {},
    get(name) {
      if (name === 'agents') {
        return {
          create: async () => ({ agent: staleAgentB }),
        }
      }
      if (name === 'skills') return skillService
      return undefined
    },
    logger: { warn() {} },
  }
  const staleChannel = createChannel(staleCtx, staleAgentA, {
    model: 'deepseek-chat',
    cwd: '/tmp',
    provider: 'deepseek',
    activity: false,
  })

  holdNextAgentASnapshot = true
  const pendingList = staleChannel.listSkills()
  check(
    'pending /skills read starts from the independent agent A',
    pendingSnapshotStarted && lastSnapshotScope === staleAgentA,
  )
  const switched = await staleChannel.newSession()
  check('newSession switches the independent channel to agent B', switched === true)
  pendingSnapshotResolve({
    skills: [{ name: 'stale', description: 'Stale skill', invocation: { modelInvocable: true, userInvocable: true } }],
    complete: true,
  })
  const staleSkills = await pendingList
  check(
    'stale /skills snapshot is hidden after an agent swap',
    staleSkills === undefined,
  )
  const freshSkills = await staleChannel.listSkills()
  check(
    'current agent B returns a fresh /skills snapshot',
    freshSkills?.some(skill => skill.name === 'fresh') === true,
  )
}

// ---- an observation that NEVER completes retries a bounded number of
// times with backoff, then stops polling and keeps last-good until the
// next skills/change (the provider's own invalidation). Without the cap a
// broken provider would keep an 800ms re-read loop alive forever.
{
  // Establish a last-good command set first (complete observation).
  let snapshotCalls = 0
  let incomplete = false
  let recovered = false
  ctx.get = (name) => {
    if (name === 'commands') return { list: () => [{ name: 'plan', description: 'Toggle plan mode' }] }
    if (name === 'skills') {
      return {
        snapshot: async () => {
          snapshotCalls += 1
          if (incomplete) return { skills: [], complete: false }
          if (recovered) {
            return {
              skills: [{ name: 'recovered-skill', description: 'Recovered', invocation: { modelInvocable: true, userInvocable: true } }],
              complete: true,
            }
          }
          return {
            skills: [{ name: 'kept-skill', description: 'Kept', invocation: { modelInvocable: true, userInvocable: true } }],
            complete: true,
          }
        },
      }
    }
    return undefined
  }
  ctx.logger = { warn() {} }
  fire('skills/change')
  check('retry ladder: last-good established',
    await settled(() => channel.commandList.some(command => command.name === 'kept-skill')))
  const callsAfterGood = snapshotCalls
  incomplete = true
  fire('skills/change')
  // Each skills/change fires BOTH consumers (the menu merge AND the
  // command registration), so one change costs two snapshot reads; the
  // registration ladder then retries 800+1600+3200ms (3 re-reads). The
  // bound: 2 (change) + 3 (ladder) = 5 extra snapshot calls max.
  await sleep(6800)
  const callsAfterRetries = snapshotCalls
  check('retry ladder: incomplete observation retries a bounded number of times',
    callsAfterRetries <= callsAfterGood + 5,
    `snapshot calls=${callsAfterRetries} after ladder (good=${callsAfterGood})`)
  // A further window must see ZERO additional retries: the ladder is
  // exhausted and last-good is preserved.
  await sleep(1500)
  check('retry ladder: retries stop after the cap',
    snapshotCalls === callsAfterRetries,
    `snapshot calls=${snapshotCalls}`)
  check('retry ladder: last-good skills survive the exhausted ladder',
    channel.commandList.some(command => command.name === 'kept-skill'))
  // Recovery: the provider's own skills/change re-enters and completes. The
  // provider now returns a DIFFERENT skill — asserting on `kept-skill` again
  // would be a false positive (last-good kept it visible through the whole
  // exhausted ladder, so the old check passed even if the re-read never
  // landed). The NEW command appearing is the actual proof of recovery.
  incomplete = false
  recovered = true
  fire('skills/change')
  check('retry ladder: a later skills/change recovers with fresh content',
    await settled(() => channel.commandList.some(command => command.name === 'recovered-skill')))
  check('retry ladder: recovered snapshot replaced the last-good entry',
    !channel.commandList.some(command => command.name === 'kept-skill'))
}

console.log(failed === 0 ? 'ALL PASS' : `${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
