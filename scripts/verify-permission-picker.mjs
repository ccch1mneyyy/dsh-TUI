/**
 * Regression coverage for the permission preset picker against the DSH
 * permission-presets service.
 *
 * The service methods are class-style methods and depend on their receiver;
 * extracting them before calling made the TUI silently report an unavailable
 * roster. That prevented bare `/permission` from opening its picker, which in
 * turn made its arrow/Enter path appear broken. This fixture uses receiver-
 * dependent methods and asserts the live session object is passed through.
 *
 * Run with plain node against the compiled lib (after `pnpm build`):
 * `node scripts/verify-permission-picker.mjs`
 */
import assert from 'node:assert/strict'
import { createChannel } from '../lib/types/dsh-adapter/channel.js'

const session = { id: 'permission-picker-session', seq: 0, events: [] }

/** Dispose the no-op listener registration. */
function noopUnsubscribe() {}

/** Register no listeners in this synchronous fixture. */
function noopOn() {
  return noopUnsubscribe
}

/** Discard channel warning messages in this synchronous fixture. */
function noopWarn() {}

const agent = {
  id: 'permission-picker-agent',
  status: 'idle',
  session,
  ctx: { on: noopOn },
}

const specs = {
  'read-only': {
    sandbox: 'read-only',
    approval: 'ask',
    name: 'Read only',
    description: 'No writes or commands.',
  },
  'workspace-write': {
    sandbox: 'workspace-write',
    approval: 'ask',
    name: 'Workspace write',
    description: 'Write inside the workspace.',
  },
  'danger-full-access': {
    sandbox: 'danger-full-access',
    approval: 'never',
    name: 'Full access',
    description: 'Full access without prompts.',
  },
  confirm: {
    sandbox: 'danger-full-access',
    approval: 'ask',
    name: 'Confirm',
    description: 'Ask before writes and commands.',
  },
}

const permissionPresets = {
  names: Object.keys(specs),
  /**
   * Return the selected preset for the exact live session object.
   * @param currentSession - The session supplied by the channel adapter.
   * @returns The current fixture preset id.
   */
  current(currentSession) {
    assert.equal(currentSession, session, 'permission current() receives the live session')
    return this.currentValue
  },
  currentValue: 'confirm',
  /**
   * Build a display row while requiring the service receiver.
   * @param name - The preset id to describe.
   * @returns The display row for the requested preset.
   */
  optionOf(name) {
    const spec = this.specs[name]
    if (spec === undefined) throw new Error(`unknown fixture preset: ${name}`)
    return { value: name, name: spec.name, description: spec.description }
  },
  specs,
}

const commands = {
  /**
   * Expose the registry command descriptor to the channel fixture.
   * @returns The permission command descriptor list.
   */
  list() {
    return [{ name: 'permission', description: 'Switch the permission preset', input: { hint: '<preset>' } }]
  },
}

const ctx = {
  on: noopOn,
  /**
   * Return only the services needed by this focused channel fixture.
   * @param name - The requested service name.
   * @returns The matching fixture service, if any.
   */
  get(name) {
    if (name === 'commands') return commands
    return name === 'permissionPresets' ? permissionPresets : undefined
  },
  logger: { warn: noopWarn },
}

const channel = createChannel(ctx, agent, {
  model: 'test-model',
  provider: 'test-provider',
  cwd: '/tmp',
  activity: false,
})

const snapshot = channel.permissionPresets()
assert.equal(snapshot.availability, 'runtime')
assert.deepEqual(snapshot.options.map(option => option.value), Object.keys(specs))
assert.equal(snapshot.current?.value, 'confirm')
assert.equal(snapshot.current?.name, 'Confirm')

const completions = channel.commandCompletions('/permission ')
assert.ok(completions.some(completion => completion.name === 'permission confirm'))
assert.equal(completions.find(completion => completion.name === 'permission confirm')?.commandLine, '/permission confirm')

console.log('verify-permission-picker: registry snapshot and /permission completion passed')
