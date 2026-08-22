import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { packagedSkillRoot as srcPackagedSkillRoot } from '../src/dsh-adapter/packaged-skills.ts'
import {
  packagedSkillRoot as compiledPackagedSkillRoot,
  registerPackagedSkills,
} from '../lib/types/dsh-adapter/packaged-skills.js'

const workspace = new URL('..', import.meta.url)
const workspacePath = fileURLToPath(workspace)
const packagedRoot = join(workspacePath, 'skills')

assert.equal(srcPackagedSkillRoot(), packagedRoot)
assert.equal(compiledPackagedSkillRoot(), packagedRoot)
assert.equal(existsSync(join(workspacePath, 'lib/skills')), false)

const registered = []
const ctx = {
  get(name) {
    assert.equal(name, 'skills')
    return {
      register(skill) {
        registered.push(skill)
        return () => {}
      },
    }
  },
  logger: {
    warn(message) {
      throw new Error(message)
    },
  },
}

registerPackagedSkills(ctx)
assert.deepEqual(
  registered.map(skill => skill.name).sort(),
  ['audit', 'bug', 'pr-comments', 'practice', 'release-notes', 'review', 'vuln-check'],
)
assert.equal(registered.find(skill => skill.name === 'review')?.provider, 'dsh-tui')
assert.equal(registered.find(skill => skill.name === 'review')?.source, 'bundled')

console.log('packaged skills OK (src and compiled layout roots, registry entries)')
