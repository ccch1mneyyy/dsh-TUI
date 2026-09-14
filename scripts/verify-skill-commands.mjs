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
import { decisionRegistryOf } from '../lib/types/dsh-adapter/decision-guard.js'
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
    return () => { registered.delete(descriptor.name) }
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
  // R3 guard (#842): the fallback must never deliver the skill body through
  // the inbox inject/steer lane — those land in the RUNNING turn, ahead of the
  // user line. Recording stubs make a regression observable instead of silent.
  injects: [],
  inject(message) { this.injects.push(message) },
  steers: [],
  steer(message) { this.steers.push(message) },
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
  LOCAL_COMMANDS.every(local => names.includes(local.name)),
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
  // 固定窗:探针 the stale read must change nothing — no warning, no menu edit;
  // a settle over an already-true condition returns immediately.
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
    const decisionRegistry = decisionRegistryOf(ctx)
    const originalGrants = decisionRegistry.grants
    const originalInputHandlers = decisionRegistry.handlers.get('tui/input')
    const seenSkillInputs = []
    decisionRegistry.grants = { ...originalGrants, allows: () => true }
    const inputRecorder = {
      event: 'tui/input',
      scope: 'tui/input',
      componentId: 'verify-skill-command',
      activationId: 'verify-skill-command',
      order: 'verify-skill-command',
      identity: {},
      ownerContext: ctx,
      listener(payload) {
        seenSkillInputs.push(payload)
        return undefined
      },
    }
    decisionRegistry.handlers.set('tui/input', new Map([['verify-skill-command', inputRecorder]]))
    agent.followups.length = 0
    const outcome = await descriptor.handler({ agent, rawInput: ' 做年终总结', signal: undefined })
    check('kernel path reports success', outcome?.kind === 'success', JSON.stringify(outcome))
    check('kernel path delivers exactly one message', await settled(() => agent.followups.length === 1))
    check(
      'kernel path crosses tui/input exactly once',
      seenSkillInputs.length === 1
        && seenSkillInputs[0]?.text === '/i-h 做年终总结'
        && seenSkillInputs[0]?.delivery === 'followup',
      JSON.stringify(seenSkillInputs),
    )
    const gesture = agent.followups[0]
    check(
      'kernel path submits the gesture as a plain user message with args',
      gesture?.source?.kind === 'user' && gesture.content?.[0]?.text === '/i-h 做年终总结',
      JSON.stringify({ source: gesture?.source, text: gesture?.content?.[0]?.text }),
    )

    // Fallback path: no `skill` tool (e.g. the minimal preset) → the handler
    // must ride the SAME delivery pipeline as the kernel path: submit
    // `/name rawInput` as a plain user message and attach the rendered skill
    // body, which the channel's resident `agent/pre-step` listener appends at
    // the END of that message's admitted batch (#842). The old shape — the
    // body as its own `followup` — is exactly the bug, so its assertions are
    // rewritten below rather than dropped.
    ctx.get = name => {
      if (name === 'commands') return commandService
      if (name === 'skills') return skillsService
      return undefined
    }
    const preStepHandlers = handlers.get('agent/pre-step') ?? []
    check('the channel registered an agent/pre-step listener', preStepHandlers.length >= 1, `handlers=${preStepHandlers.length}`)
    // Replay the REAL `agent/pre-step` waterfall instead of calling the last
    // listener alone (CodeRabbit on PR #849): every registered listener runs in
    // registration order and each one's `next()` continues into the next
    // listener, so an earlier listener's after-`next()` transform unwinds LAST
    // — that reverse-order unwind is exactly what puts the channel's append at
    // the end of the batch. The base continuation returns the admitted batch,
    // matching the loop's default decision.
    const preStepPayload = messages => ({ agent, messages, turn: 1, step: 1, signal: new AbortController().signal })
    const runPreStepChain = async (payload, index) => {
      if (index === preStepHandlers.length) return { kind: 'enter', messages: payload.messages }
      return preStepHandlers[index](payload, () => runPreStepChain(payload, index + 1))
    }
    const firePreStep = messages => runPreStepChain(preStepPayload(messages), 0)

    // AC-1: the fallback delivers the user's line, args preserved, as exactly
    // ONE followup — the body must not become a turn of its own.
    agent.followups.length = 0
    const fallbackOutcome = await descriptor.handler({ agent, rawInput: ' 我的参数', signal: undefined })
    check('fallback reports success', fallbackOutcome?.kind === 'success', JSON.stringify(fallbackOutcome))
    check('fallback delivers exactly one followup', await settled(() => agent.followups.length === 1))
    check(
      'fallback rides the delivery pipeline (tui/input crossed once with the args)',
      seenSkillInputs.length === 2
        && seenSkillInputs[1]?.text === '/i-h 我的参数'
        && seenSkillInputs[1]?.delivery === 'followup',
      JSON.stringify(seenSkillInputs),
    )
    const delivered = agent.followups[0]
    check(
      'AC-1: the delivery is a plain user message carrying `/i-h 我的参数`',
      delivered?.source?.kind === 'user' && delivered.content?.[0]?.text === '/i-h 我的参数',
      JSON.stringify({ source: delivered?.source, text: delivered?.content?.[0]?.text }),
    )

    // AC-2: the body rides the SAME batch, appended after the user line, and
    // the injection opens no second turn.
    const admitted = await firePreStep([delivered])
    const appended = admitted?.messages?.at(-1)
    check(
      'AC-2: body is appended at the END of the batch',
      admitted?.messages?.length === 2
        && admitted.messages[0] === delivered
        && appended?.source?.kind === 'skill-invocation'
        && appended.source.name === 'i-h'
        && appended.source.form === 'instructions'
        && typeof appended.content?.[0]?.text === 'string'
        && appended.content[0].text.includes('HELP BODY'),
      JSON.stringify({ source: appended?.source, text: appended?.content?.[0]?.text }),
    )
    check('AC-2: injection creates no second followup/turn', agent.followups.length === 1)

    // AC-3: empty rawInput still delivers the bare `/i-h` line and the body is
    // injected exactly once through the same pre-step path.
    const emptyOutcome = await descriptor.handler({ agent, rawInput: '', signal: undefined })
    check('fallback without args reports success', emptyOutcome?.kind === 'success', JSON.stringify(emptyOutcome))
    check('fallback without args delivers exactly one more followup', await settled(() => agent.followups.length === 2))
    const bare = agent.followups[1]
    check(
      'AC-3: the delivery is a plain user message carrying `/i-h`',
      bare?.source?.kind === 'user' && bare.content?.[0]?.text === '/i-h',
      JSON.stringify({ source: bare?.source, text: bare?.content?.[0]?.text }),
    )
    const admittedBare = await firePreStep([bare])
    check(
      'AC-3: body is appended once, after the bare user line',
      admittedBare?.messages?.length === 2
        && admittedBare.messages[0] === bare
        && admittedBare.messages.at(-1)?.source?.kind === 'skill-invocation'
        && admittedBare.messages.at(-1).content?.[0]?.text.includes('HELP BODY'),
    )
    const replayed = await firePreStep([bare])
    check(
      'AC-3: a claimed attachment is never injected twice',
      replayed?.messages?.length === 1 && replayed.messages[0] === bare,
    )
    check('AC-2/AC-3: injection creates no additional followup/turn', agent.followups.length === 2)

    // AC-4: a `tui/input` cancel drops the submission before a message exists
    // — no followup, and a later step has nothing to inject.
    decisionRegistry.handlers.set('tui/input', new Map([
      ['verify-skill-command', inputRecorder],
      ['verify-skill-command-cancel', {
        event: 'tui/input',
        scope: 'tui/input',
        componentId: 'verify-skill-command-cancel',
        activationId: 'verify-skill-command-cancel',
        order: 'verify-skill-command-cancel',
        identity: {},
        ownerContext: ctx,
        listener() { return { cancel: true, reason: 'verify cancel' } },
      }],
    ]))
    const cancelledOutcome = await descriptor.handler({ agent, rawInput: ' 我的参数', signal: undefined })
    check(
      'cancelled fallback reports success (the decision owns the pipeline)',
      cancelledOutcome?.kind === 'success',
      JSON.stringify(cancelledOutcome),
    )
    check(
      'AC-4: the cancelled line reached the tui/input decision',
      await settled(() => seenSkillInputs.length === 4 && seenSkillInputs[3]?.text === '/i-h 我的参数'),
      JSON.stringify(seenSkillInputs),
    )
    check('AC-4: cancel delivers no followup', agent.followups.length === 2, `followups=${agent.followups.length}`)
    const neverDelivered = { id: 'verify-never-delivered', content: [{ type: 'text', text: '/i-h 我的参数' }], source: { kind: 'user' } }
    const cancelledStep = await firePreStep([neverDelivered])
    check(
      'AC-4: a cancelled submission leaves no skill-invocation injection',
      cancelledStep?.messages?.length === 1
        && cancelledStep.messages[0] === neverDelivered
        && !cancelledStep.messages.some(message => message.source?.kind === 'skill-invocation'),
    )

    // REQUIREMENT AC-3 · mid-turn delivery: while the agent is running the
    // user line is queued for the NEXT turn (fake agent: one more followup),
    // and the in-flight turn's batch must NOT receive the body — only the
    // batch that claims the queued line does. This is the R3-protection
    // regression for "never inject into the running turn".
    decisionRegistry.handlers.set('tui/input', new Map([['verify-skill-command', inputRecorder]]))
    agent.status = 'running'
    const runningOutcome = await descriptor.handler({ agent, rawInput: ' 运行中', signal: undefined })
    check('running fallback reports success', runningOutcome?.kind === 'success', JSON.stringify(runningOutcome))
    check('running fallback queues exactly one followup', await settled(() => agent.followups.length === 3))
    const queued = agent.followups[2]
    const inFlight = { id: 'verify-in-flight', content: [{ type: 'text', text: 'in-flight turn step' }], source: { kind: 'user' } }
    const inFlightStep = await firePreStep([inFlight])
    check(
      'AC-3(running): the in-flight batch receives no skill body',
      inFlightStep?.messages?.length === 1
        && inFlightStep.messages[0] === inFlight
        && !inFlightStep.messages.some(message => message.source?.kind === 'skill-invocation'),
    )
    const queuedStep = await firePreStep([queued])
    check(
      'AC-3(running): the body follows the queued line in its own batch',
      queuedStep?.messages?.length === 2
        && queuedStep.messages[0] === queued
        && queuedStep.messages.at(-1)?.source?.kind === 'skill-invocation'
        && queuedStep.messages.at(-1).content?.[0]?.text.includes('HELP BODY'),
    )
    agent.status = 'idle'

    // CodeRabbit (PR #849): a competing after-`next()` transform registered
    // AFTER the channel's listener unwinds BEFORE it, so the body must still be
    // the LAST message of the final batch; a later listener that rejects the
    // batch must stop the append entirely.
    const competingOutcome = await descriptor.handler({ agent, rawInput: ' 竞争', signal: undefined })
    check('waterfall: competing case reports success', competingOutcome?.kind === 'success', JSON.stringify(competingOutcome))
    check('waterfall: competing case queues one more followup', await settled(() => agent.followups.length === 4))
    const competingLine = agent.followups[3]
    const competitorListener = async (payload, next) => {
      const decision = await next()
      if (decision.kind === 'reject') return decision
      return {
        ...decision,
        messages: [...decision.messages, { id: 'verify-competing-context', role: 'user', content: [{ type: 'text', text: 'COMPETING-CONTEXT' }], source: { kind: 'plugin', plugin: 'verify-competitor' } }],
      }
    }
    preStepHandlers.push(competitorListener)
    const competingStep = await firePreStep([competingLine])
    check(
      'waterfall: a competing after-next transform cannot push the body off the end',
      competingStep?.messages?.length === 3
        && competingStep.messages[0] === competingLine
        && competingStep.messages[1]?.content?.[0]?.text === 'COMPETING-CONTEXT'
        && competingStep.messages.at(-1)?.source?.kind === 'skill-invocation'
        && competingStep.messages.at(-1).content?.[0]?.text.includes('HELP BODY'),
      JSON.stringify(competingStep?.messages?.map(message => message.source?.kind ?? message.content?.[0]?.text)),
    )
    const rejectingListener = async (payload, next) => {
      await next()
      return { kind: 'reject' }
    }
    preStepHandlers.push(rejectingListener)
    const rejectingOutcome = await descriptor.handler({ agent, rawInput: ' 拒绝', signal: undefined })
    check('waterfall: reject case reports success', rejectingOutcome?.kind === 'success', JSON.stringify(rejectingOutcome))
    check('waterfall: reject case queues one more followup', await settled(() => agent.followups.length === 5))
    const rejectedStep = await firePreStep([agent.followups[4]])
    check('waterfall: a rejected batch never receives the appended body', rejectedStep?.kind === 'reject', JSON.stringify(rejectedStep))
    preStepHandlers.pop()
    preStepHandlers.pop()

    // R3 guard: the fallback must never use the inbox inject/steer lane.
    check('R3: fallback never calls agent.inject', agent.injects.length === 0, `injects=${agent.injects.length}`)
    check('R3: fallback never calls agent.steer', agent.steers.length === 0, `steers=${agent.steers.length}`)

    if (originalInputHandlers === undefined) decisionRegistry.handlers.delete('tui/input')
    else decisionRegistry.handlers.set('tui/input', originalInputHandlers)
    decisionRegistry.grants = originalGrants
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

console.log(failed === 0 ? 'ALL PASS' : `${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
