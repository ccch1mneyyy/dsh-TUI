/**
 * `/team` availability follows the Agent Teams service: the command is absent
 * from Help and `/` completion while `agentTeams` is not mounted, appears when
 * the service mounts, and disappears again when it unloads. The same
 * `internal/service` signal the team store reads drives the republish.
 *
 * Run: node --import tsx/esm scripts/verify-team-command-visibility.ts
 */
import './lib/fake-home.mjs'

process.env.DSH_TUI_LANG = 'en'

const [{ default: assert }, { createChannel }] = await Promise.all([
  import('node:assert/strict'),
  import('../src/dsh-adapter/channel.js'),
])

/** The agent fixture a real channel binds as its startup session. */
function makeAgent(id: string, sessionId: string) {
  return {
    id, status: 'idle',
    session: { id: sessionId, seq: 0, events: [], header: {} },
    ctx: { on: () => () => undefined },
    followup() {}, steer() {}, inbox: { remove: () => true },
  }
}

const services: { agentTeams?: object } = {}
const serviceListeners: ((name: unknown) => void)[] = []
const ctx = {
  on(name: string, listener: (name: unknown) => void) {
    if (name === 'internal/service') serviceListeners.push(listener)
    return () => undefined
  },
  get(name: string) {
    if (name === 'agentTeams') return services.agentTeams
    return undefined
  },
  logger: { warn: () => undefined, info: () => undefined, debug: () => undefined },
}
const emitService = (name: string): void => {
  for (const listener of [...serviceListeners]) listener(name)
}

const channel = createChannel(ctx as never, makeAgent('team-visibility', 's-team-visibility') as never, {
  model: 'fake-model', provider: '', cwd: process.cwd(), activity: false,
})
const hasTeam = (): boolean => channel.commandList.some(command => command.name === 'team')

assert.equal(hasTeam(), false, 'the command starts hidden while agentTeams is absent')

services.agentTeams = {}
emitService('agentTeams')
assert.equal(hasTeam(), true, 'mounting the service publishes /team')

services.agentTeams = undefined
emitService('agentTeams')
assert.equal(hasTeam(), false, 'unloading the service hides /team again')

// Another service's change must not republish the team command.
services.agentTeams = {}
emitService('agentTeams')
services.agentTeams = undefined
emitService('agents')
assert.equal(hasTeam(), true, 'a different service event leaves the team row alone')

console.log('PASS /team visibility follows the agentTeams service')
