/** Regression checks for the official Minimal preset (one persistent shell tool)
 * and its three host-layer carve-outs — the host-mounted ask_user_question,
 * the experimental session-search bundle's five tools plus its prompt section
 * (which must go together: guidance without tools is worse than neither), and
 * the experimental worktree bundle's create_worktree (also hidden from the
 * bundled liangshen preset, whose POSIX bash is the same persistent shell).
 * Run against compiled output. */

import assert from 'node:assert/strict'
import { createChannel } from '../lib/types/dsh-adapter/channel.js'
import {
  composePreset,
  filterMinimalPresetSections,
  filterMinimalPresetTools,
  presetHidesHostAskTool,
  presetToolDeny,
  resolvePersistedPreset,
  runningPresetOf,
} from '../lib/types/dsh-adapter/presets.js'
import { settled } from './lib/term-test.mjs'
import { setLang } from '../lib/types/i18n.js'

// The official Minimal composition
// (`@deepseek-ai/dsh-web-app/presets/minimal.patch.yml`: `persona` +
// `persistent-shell`) exposes EXACTLY ONE tool — the persistent shell, which is
// `bash` on POSIX and `pwsh` on Windows. `str_replace_editor` became opt-in in
// 0.1.3-alpha.2 and is not part of it; neither is the host-mounted
// ask_user_question.
const shell = process.platform === 'win32' ? 'pwsh' : 'bash'
const SESSION_SEARCH_TOOLS = ['session_search', 'session_event_search', 'session_trace',
  'session_event_trace', 'session_event_read']
const WORKTREE_TOOL = 'create_worktree'

// Tool carve-outs are per-agent registry restrictions since 0.2.2 (the prompt
// assembly no longer carries tool declarations): presetToolDeny names them and
// tool-scope.ts hands the list to tools.restrict() on the agent's own scope.
// Minimal is also a persistent-shell preset, so it denies the worktree move too.
assert.deepEqual([...presetToolDeny('minimal')].sort(), ['ask_user_question', WORKTREE_TOOL, ...SESSION_SEARCH_TOOLS].sort())
assert.deepEqual([...presetToolDeny('liangshen')], [WORKTREE_TOOL])
assert.equal(presetHidesHostAskTool('minimal'), true)
// A user preset that merely mentions the shell keeps the host tool: only the
// official id is carved out (see presets.presetHidesHostAskTool).
for (const preset of ['standard', 'ptc', 'cordis', undefined, 'minimal-copy']) {
  assert.deepEqual([...presetToolDeny(preset)], [])
  assert.equal(presetHidesHostAskTool(preset), false)
}

// The session-search bundle
// (`@deepseek-ai/dsh-tool-session-query@0.2.1-rc.2`) contributes five tools AND
// a `tool:session-query` prompt section at the host layer. Minimal must lose
// both: leaving the section behind would tell the model to use tools it cannot
// call. The section half still rides the assembly waterfall.
const sessionSection = { name: 'tool:session-query', text: 'Use session_search to find relevant work' }
const shellSection = { name: 'tool:bash', text: 'shell guidance' }
const presentation = { sections: [shellSection, sessionSection], contexts: [], variables: {} }

const filteredBundle = filterMinimalPresetSections(presentation, 'minimal')
assert.deepEqual(filteredBundle.sections, [shellSection])
assert.notEqual(filteredBundle, presentation)
// The input is never mutated, and every other preset keeps its guidance (same object).
assert.equal(presentation.sections.length, 2)
for (const preset of ['standard', 'ptc', 'cordis', 'liangshen', undefined, 'minimal-copy']) {
  assert.equal(filterMinimalPresetSections(presentation, preset), presentation)
}
assert.equal(filterMinimalPresetSections({ sections: [shellSection], contexts: [], variables: {} }, 'minimal').sections.length, 1)

// Legacy waterfalls still carry declarations: the compiled consumer must
// preserve the same guard, not merely export the expected deny-list names.
const legacyAssembly = {
  ...presentation,
  tools: [shell, 'ask_user_question', WORKTREE_TOOL, ...SESSION_SEARCH_TOOLS].map(name => ({ name })),
}
const legacyMinimal = filterMinimalPresetTools(legacyAssembly, 'minimal')
assert.deepEqual(legacyMinimal.tools.map(tool => tool.name), [shell])
assert.deepEqual(legacyMinimal.sections, [shellSection])
assert.equal(legacyAssembly.tools.length, 8)
assert.equal(legacyAssembly.sections.length, 2)
assert.deepEqual(filterMinimalPresetTools(legacyAssembly, 'liangshen').tools.map(tool => tool.name),
  legacyAssembly.tools.map(tool => tool.name).filter(name => name !== WORKTREE_TOOL))
assert.equal(filterMinimalPresetTools(legacyAssembly, 'standard'), legacyAssembly)
assert.deepEqual(filterMinimalPresetTools(presentation, 'minimal').sections, [shellSection])

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

// Display localization: the 0.1.2 roster id `ptc` must resolve the en
// dictionary surface keyed under the legacy `code` id (preset-name-code /
// preset-desc-code), never the Chinese roster copy — same bug as issue #8.
setLang('en')
const displayChannel = createChannel({
  on() { return () => {} },
  get(name) {
    if (name !== 'agentPresets') return undefined
    return {
      defaultId: 'standard',
      async list() {
        return [
          { id: 'standard', trust: 'system', name: '标准模式', description: '标准描述' },
          { id: 'ptc', trust: 'system', name: 'PTC 模式', description: 'PTC 描述' },
          { id: 'minimal', trust: 'system', name: '极简模式', description: '极简描述' },
        ]
      },
      async resolve() { throw new Error('not used') },
      async mount() {},
      async recompose() { throw new Error('not used') },
    }
  },
  logger: { warn() {} },
}, {
  id: 'preset-display-agent',
  status: 'idle',
  session: { id: 'preset-display-session', seq: 1, events: [] },
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
const displayList = await displayChannel.listPresets()
const ptcOption = displayList.find(preset => preset.id === 'ptc')
assert.equal(ptcOption.name, 'PTC')
assert.equal(ptcOption.description, 'Everything standard mode offers, with tools exposed through the Code Mode SDK so the model composes multi-step operations in one TypeScript program.')
assert.equal(displayList.find(preset => preset.id === 'standard').name, 'Standard')
assert.equal(displayList.find(preset => preset.id === 'minimal').name, 'Minimal')
setLang('zh')

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

// The Minimal-shaped catalogs below keep the real one-tool shape (the
// persistent shell) at the front; the skill catalog read is decided by the
// `skill` tool, not by the shell.
const minimalContext = await loadedContextWith([shell])
assert.deepEqual(minimalContext.context.skills, [])
assert.equal(minimalContext.unscopedReads, 0)

const standardContext = await loadedContextWith([shell, { name: 'skill' }])
assert.deepEqual(standardContext.context.skills, [{ name: 'audit', description: 'Audit code' }])
assert.equal(standardContext.unscopedReads, 0)

const incompleteContext = await loadedContextWith([shell, { name: 'skill' }], false)
assert.deepEqual(incompleteContext.context.skills, [])
assert.deepEqual(incompleteContext.context.tools.map(tool => tool.name), [shell.name, 'skill'])
assert.equal(incompleteContext.unscopedReads, 0)

console.log('minimal preset tool filtering verified')
