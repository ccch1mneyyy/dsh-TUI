/** Regression check: the TUI host tool remains available everywhere except
 * the official two-tool Minimal preset. Run against compiled output. */

import assert from 'node:assert/strict'
import { filterMinimalPresetTools } from '../lib/types/dsh-adapter/presets.js'

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

console.log('minimal preset tool filtering verified')
