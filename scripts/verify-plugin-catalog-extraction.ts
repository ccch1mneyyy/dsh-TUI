/** L4-4c source gate: plugin commands, skill lifecycle and loaded context stay owned modules. */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = (path: string) => readFileSync(new URL(`../src/dsh-adapter/${path}`, import.meta.url), 'utf8')
const root = source('channel.ts')
const external = source('channel/external-commands.ts')
const skills = source('channel/skill-catalog.ts')
const context = source('channel/loaded-context.ts')

for (const [label, text] of Object.entries({ external, skills, context })) {
  assert.match(text, /^import /mu, `${label} must remain a focused real module`)
}
assert.match(root, /createExternalCommandInvoker\(/u)
assert.match(root, /createSkillCatalog\(/u)
assert.match(root, /createLoadedContextRefresher\(/u)
assert.doesNotMatch(root, /const registryCommandImages =/u)
assert.doesNotMatch(root, /const refreshSkillCommands = async/u)
assert.doesNotMatch(root, /const refreshLoadedContext = async/u)
assert.doesNotMatch(root, /const commandServiceSupportsImages =/u)
assert.match(external, /commandOwner\(ctx, definition\)/u)
assert.match(external, /service\.find\(commandAgent, name\) !== definition/u, 'same-name replacement is rejected after image IO')
assert.match(external, /const denied = authorize\(definition, name\)/u, 'actual definition and live grants are reauthorized before execute')
assert.match(external, /if \(!deps\.bindingCurrent\(capture\)\) return \{ kind: 'error', text: '', consumeDraft: false \}\n      if \(execution === undefined\)/u, 'command result origin is fenced before notices/returns')
assert.match(external, /const execution = batch\.kind === 'legacy'/u, 'legacy and image-bearing execute shapes stay split')
assert.match(skills, /let retry/u, 'skill retry timer has one owner')
assert.match(skills, /const owned: Array<\(\) => void> = \[deps\.owner\.own\(release\)\]/u, 'catalog startup establishes cleanup before listeners')
assert.match(skills, /invoker !== deps\.agent\(\)/u, 'skill handler remains agent-origin bound')
assert.match(skills, /if \(!deps\.owner\.current\(\)\) return\n    const target/u, 'synchronous catalog refresh rejects a released owner')
assert.match(context, /target !== deps\.agent\(\)/u, 'loaded context discards stale agent results')
assert.match(context, /deps\.owner\.current\(\)/u, 'loaded context observes Channel lifetime')
console.log('verify:plugin-catalog-extraction OK')
