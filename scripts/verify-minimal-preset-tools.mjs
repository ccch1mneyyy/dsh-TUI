/** Regression checks for the official two-tool Minimal preset. Run against
 * compiled output. */

import assert from 'node:assert/strict'
import { createChannel } from '../lib/types/dsh-adapter/channel.js'
import { filterMinimalPresetTools } from '../lib/types/dsh-adapter/presets.js'
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

for (const preset of ['standard', 'code', 'cordis', 'liangshen', undefined]) {
  assert.equal(filterMinimalPresetTools(assembly, preset), assembly)
}

const alreadyTwoTools = { ...assembly, tools: [bash, editor] }
assert.equal(filterMinimalPresetTools(alreadyTwoTools, 'minimal'), alreadyTwoTools)

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
