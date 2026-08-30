/** Regression checks for the official two-tool Minimal preset. Run against
 * compiled output. */

import assert from 'node:assert/strict'
import { createChannel } from '../lib/types/dsh-adapter/channel.js'
import {
  composePreset,
  filterMinimalPresetTools,
  resolvePersistedPreset,
  runningPresetOf,
} from '../lib/types/dsh-adapter/presets.js'
import { settled } from './lib/term-test.mjs'

const bash = { name: 'bash' }
const editor = { name: 'str_replace_editor' }
const ask = { name: 'ask_user_question' }
const assembly = {
  sections: [],
  contexts: [],
  tools: [bash, editor, ask],
  variables: {},
}

const minimal = filterMinimalPresetTools(assembly, 'minimal')
assert.deepEqual(minimal.tools.map(tool => tool.name), ['bash', 'str_replace_editor'])
assert.notEqual(minimal, assembly)

for (const preset of ['standard', 'ptc', 'cordis', 'liangshen', undefined]) {
  assert.equal(filterMinimalPresetTools(assembly, preset), assembly)
}

const alreadyTwoTools = { ...assembly, tools: [bash, editor] }
assert.equal(filterMinimalPresetTools(alreadyTwoTools, 'minimal'), alreadyTwoTools)

const legacyHeaderSession = {
  header: { agentPreset: 'code' },
  events: [],
}
const legacyEventSession = {
  header: { agentPreset: 'standard' },
  events: [{ type: 'agent-preset/selected', data: { agentPreset: 'code' } }],
}
const malformedLatestEventSession = {
  header: { agentPreset: 'standard' },
  events: [
    { type: 'agent-preset/selected', data: { agentPreset: 'code' } },
    { type: 'agent-preset/selected', data: null },
  ],
}
assert.equal(runningPresetOf(legacyHeaderSession), 'code')
assert.equal(runningPresetOf(legacyEventSession), 'code')
assert.equal(runningPresetOf(malformedLatestEventSession), 'code')
assert.equal(legacyHeaderSession.header.agentPreset, 'code')
assert.equal(legacyEventSession.events[0].data.agentPreset, 'code')

function presetContext(available, broken = new Set()) {
  const attempts = []
  const service = {
    defaultId: 'standard',
    async list() {
      return [...available].map(id => ({ id, trust: 'system' }))
    },
    async resolve(id) {
      attempts.push(id)
      if (broken.has(id)) throw new Error(`broken ${id} preset`)
      if (!available.has(id)) throw new Error(`missing ${id}`)
      return { id, trust: 'system' }
    },
    async mount() {},
    async recompose() { throw new Error('not used') },
  }
  return {
    attempts,
    ctx: {
      get(name) {
        if (name !== 'agentPresets') return undefined
        return service
      },
      logger: { warn() {} },
    },
  }
}

const alphaRoster = presetContext(new Set(['standard', 'ptc']))
const alphaComposition = await composePreset(alphaRoster.ctx, 'code')
assert.deepEqual(alphaRoster.attempts, ['ptc'])
assert.equal(alphaComposition.agentPreset, 'ptc')
assert.equal(legacyHeaderSession.header.agentPreset, 'code')

const rcRoster = presetContext(new Set(['standard', 'code']))
const rcComposition = await composePreset(rcRoster.ctx, 'code')
assert.deepEqual(rcRoster.attempts, ['code'])
assert.equal(rcComposition.agentPreset, 'code')

const rcNewName = presetContext(new Set(['standard', 'code']))
const rcFallback = await composePreset(rcNewName.ctx, 'ptc')
assert.deepEqual(rcNewName.attempts, ['code'])
assert.equal(rcFallback.agentPreset, 'code')

const brokenExact = presetContext(new Set(['standard', 'code', 'ptc']), new Set(['code']))
const brokenComposition = await composePreset(brokenExact.ctx, 'code')
assert.deepEqual(brokenExact.attempts, ['code'])
assert.deepEqual(brokenComposition, {})

const persistedPreset = await resolvePersistedPreset({
  get(name) {
    if (name !== 'sessionPersistence') return undefined
    return { async load() { return { meta: legacyHeaderSession.header, events: legacyHeaderSession.events } } }
  },
}, 'legacy-session')
assert.equal(persistedPreset, 'code')

let directResolveId
const directChannel = createChannel({
  on() { return () => {} },
  get(name) {
    if (name !== 'agentPresets') return undefined
    return {
      defaultId: 'standard',
      async list() { return [] },
      async resolve(id) {
        directResolveId = id
        if (id !== 'ptc') throw new Error(`missing ${id}`)
        return { id, trust: 'system' }
      },
      async mount() {},
      async recompose() { throw new Error('not used') },
    }
  },
  logger: { warn() {} },
}, {
  id: 'preset-alias-agent',
  status: 'idle',
  session: {
    id: 'preset-alias-session',
    seq: 1,
    events: [{
      type: 'agent-preset/selected',
      seq: 1,
      time: 1,
      data: { agentPreset: 'code' },
    }],
  },
  ctx: { on() { return () => {} } },
  followup() {},
  steer() {},
}, {
  model: 'deepseek-chat',
  cwd: '/tmp',
  provider: 'deepseek',
  activity: false,
  agentPreset: 'ptc',
})
assert.equal(directChannel.agentPreset, 'ptc')
assert.equal(directChannel.rows.some(row => row.text.includes('ptc')), true)
assert.equal(directChannel.rows.some(row => row.text.includes('code')), false)
assert.equal(await directChannel.switchPreset('ptc'), true)
assert.equal(directResolveId, 'ptc')

const bundledSkills = [{
  name: 'audit',
  description: 'Audit code',
  invocation: { modelInvocable: true, userInvocable: true },
  source: 'bundled',
}, {
  name: 'manual-only',
  description: 'Manual only',
  invocation: { modelInvocable: false, userInvocable: true },
  source: 'bundled',
}]

async function loadedContextWith(tools, complete = true) {
  let unscopedReads = 0
  const skills = {
    async list() {
      unscopedReads += 1
      return bundledSkills
    },
    async snapshot(options) {
      if (options?.scope !== agent || options.cwd !== '/tmp') {
        unscopedReads += 1
        return { skills: [], complete: true }
      }
      return { skills: bundledSkills, complete }
    },
  }
  const ctx = {
    on: () => () => {},
    get(name) {
      if (name === 'systemPrompt') {
        return { assemble: async () => ({ sections: [], contexts: [], tools, variables: {} }) }
      }
      if (name === 'skills') return skills
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
  const channel = createChannel(ctx, agent, {
    model: 'deepseek-chat', cwd: '/tmp', provider: 'deepseek', activity: false,
  })
  assert.equal(await settled(() => channel.loadedContext !== undefined), true)
  return { context: channel.loadedContext, unscopedReads }
}

const minimalContext = await loadedContextWith([bash, editor])
assert.deepEqual(minimalContext.context.skills, [])
assert.equal(minimalContext.unscopedReads, 0)

const standardContext = await loadedContextWith([bash, editor, { name: 'skill' }])
assert.deepEqual(standardContext.context.skills, [{ name: 'audit', description: 'Audit code' }])
assert.equal(standardContext.unscopedReads, 0)

const incompleteContext = await loadedContextWith([bash, editor, { name: 'skill' }], false)
assert.deepEqual(incompleteContext.context.skills, [])
assert.deepEqual(incompleteContext.context.tools.map(tool => tool.name), ['bash', 'str_replace_editor', 'skill'])
assert.equal(incompleteContext.unscopedReads, 0)

console.log('minimal preset tool filtering verified')
