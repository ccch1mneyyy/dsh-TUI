/**
 * Permission-preset snapshot regression.
 *
 * Run with: node --import tsx/esm scripts/verify-permission-presets.tsx
 *
 * The fake registry deliberately uses class methods that read `this`. This
 * catches accidental method destructuring at the adapter boundary while the
 * remaining cases pin fail-closed validation and snapshot immutability.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const isolatedHome = mkdtempSync(join(tmpdir(), 'dsh-tui-permission-presets-'))
process.env.HOME = isolatedHome
process.env.USERPROFILE = isolatedHome
process.on('exit', () => rmSync(isolatedHome, { recursive: true, force: true }))

const { createChannel } = await import('../src/dsh-adapter/channel.js')
const { stablePermissionRosterOrder } = await import('../src/sessionModes.js')

type FakeEvent = { type: string; seq: number; time: number; data: Record<string, unknown> }
type Handler = (session: FakeSession, event: FakeEvent) => void
type FakeSession = {
  id: string
  seq: number
  events: FakeEvent[]
  header: { createdAt: number; cwd: string }
  append(type: string, data: Record<string, unknown>): void
}
type PermissionService = {
  names: unknown
  current?: (events: readonly FakeEvent[]) => unknown
  optionOf?: (name: string) => unknown
}

type TestEnv = {
  channel: ReturnType<typeof createChannel>
  service?: PermissionService
  warnings: string[]
}

let failures = 0
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${detail === '' ? '' : ` (${detail})`}`)
  if (!ok) failures += 1
}

const missing = Symbol('missing')

function makeService(active = 'auto'): PermissionService & { active: string; entries: Map<string, Record<string, string>> } {
  class Registry {
    names = ['read-only', 'auto', 'workspace-write']
    active = active
    entries = new Map([
      ['read-only', { value: 'read-only', name: 'Read only', description: 'No writes' }],
      ['auto', { value: 'auto', name: 'Auto', description: 'Choose automatically' }],
      ['workspace-write', { value: 'workspace-write', name: 'Workspace write', description: 'Write in the workspace' }],
      ['custom', { value: 'custom', name: 'Custom', description: 'Session-specific policy' }],
    ])

    current(_events: readonly FakeEvent[]): unknown {
      if (this !== registry) throw new Error('receiver lost')
      return this.active
    }

    optionOf(name: string): unknown {
      if (this !== registry) throw new Error('receiver lost')
      return this.entries.get(name)
    }
  }
  const registry = new Registry()
  return registry
}

function makeEnv(service: unknown | typeof missing = missing): TestEnv {
  const handlers = new Map<string, Handler>()
  const warnings: string[] = []
  const events: FakeEvent[] = []
  const session: FakeSession = {
    id: 'session-1',
    seq: 0,
    events,
    header: { createdAt: Date.now(), cwd: '/tmp' },
    append(type, data) {
      const event = { type, seq: ++session.seq, time: Date.now(), data }
      events.push(event)
      handlers.get('session/event')?.(session, event)
    },
  }
  const services: Record<string, unknown> = service === missing ? {} : { permissionPresets: service }
  const ctx = {
    on(event: string, handler: Handler) {
      handlers.set(event, handler)
      return () => handlers.delete(event)
    },
    get(name: string) {
      return services[name]
    },
    logger: { warn(message: unknown) { warnings.push(String(message)) } },
  }
  const agent = {
    id: 'agent-1',
    status: 'idle',
    session,
    ctx: { on: () => () => {} },
    followup() {},
    steer() {},
    inbox: { remove() { return true } },
  }
  const channel = createChannel(ctx as never, agent as never, {
    model: 'deepseek-chat',
    cwd: '/tmp',
    provider: 'deepseek',
    activity: false,
  })
  return { channel, ...(service === missing ? {} : { service: service as PermissionService }), warnings }
}

// 1. A class-like registry must be invoked with its receiver intact.
{
  const service = makeService()
  const { channel } = makeEnv(service)
  const snapshot = channel.permissionPresets()
  check('class-like registry is runtime-readable', snapshot.availability === 'runtime')
  check('class-like registry exposes ordered options', snapshot.options.map(option => option.value).join(',') === 'read-only,auto,workspace-write')
  check('class-like registry resolves current identity', snapshot.current?.value === 'auto' && snapshot.current?.kind === 'preset')
}

// 2. The returned value is a frozen copy, not a live view of the registry.
{
  const service = makeService()
  const { channel } = makeEnv(service)
  const first = channel.permissionPresets()
  service.active = 'workspace-write'
  service.entries.get('auto')!.name = 'Changed later'
  const second = channel.permissionPresets()
  check('snapshot object is frozen', Object.isFrozen(first))
  check('snapshot options are frozen', Object.isFrozen(first.options) && Object.isFrozen(first.options[0]))
  check('snapshot remains stable after service mutation', first.current?.value === 'auto' && first.options[1]?.name === 'Auto')
  check('next read observes the new service state', second.current?.value === 'workspace-write' && second.options[1]?.name === 'Changed later')
}

// 3. Missing service keeps the legacy compatibility roster.
{
  const { channel } = makeEnv()
  const snapshot = channel.permissionPresets()
  check('missing service uses legacy roster', snapshot.availability === 'legacy')
  check('legacy roster contains canonical presets', snapshot.options.map(option => option.value).join(',') === 'read-only,workspace-write,danger-full-access')
  check('legacy snapshot is frozen', Object.isFrozen(snapshot) && Object.isFrozen(snapshot.options))
}

// 4. A mounted but malformed or throwing service fails closed.
const malformed: Array<[string, unknown]> = [
  ['non-object service', 42],
  ['empty names', { names: [], current: () => 'auto', optionOf: () => ({ value: 'auto', name: 'Auto' }) }],
  ['duplicate names', { names: ['auto', 'auto'], current: () => 'auto', optionOf: () => ({ value: 'auto', name: 'Auto' }) }],
  ['custom sentinel in names', { names: ['custom'], current: () => 'custom', optionOf: () => ({ value: 'custom', name: 'Custom' }) }],
  ['option value mismatch', { names: ['auto'], current: () => 'auto', optionOf: () => ({ value: 'other', name: 'Auto' }) }],
  ['unknown current value', { names: ['auto'], current: () => 'missing', optionOf: () => ({ value: 'auto', name: 'Auto' }) }],
  ['throwing current', { names: ['auto'], current: () => { throw new Error('boom') }, optionOf: () => ({ value: 'auto', name: 'Auto' }) }],
  ['throwing option lookup', { names: ['auto'], current: () => 'auto', optionOf: () => { throw new Error('boom') } }],
]
for (const [name, service] of malformed) {
  const { channel } = makeEnv(service)
  check(`${name} fails closed`, channel.permissionPresets().availability === 'unavailable')
}

// 5. `custom` is a current-state sentinel, never a selectable option.
{
  const service = makeService('custom')
  const { channel } = makeEnv(service)
  const snapshot = channel.permissionPresets()
  check('custom current state is retained', snapshot.current?.value === 'custom' && snapshot.current.kind === 'custom')
  check('custom is excluded from options', !snapshot.options.some(option => option.value === 'custom'))
}

// 6. Runtime roster refreshes keep observed identities stable while honoring
// the official order for newly observed entries.
{
  check(
    'stable roster keeps first official order',
    stablePermissionRosterOrder([], ['auto', 'safe']).join(',') === 'auto,safe',
  )
  check(
    'stable roster ignores later reorder',
    stablePermissionRosterOrder(['auto', 'safe'], ['safe', 'auto', 'new']).join(',') === 'auto,safe,new',
  )
  check(
    'stable roster appends a re-added identity',
    stablePermissionRosterOrder(['auto', 'safe', 'new'], ['new', 'auto']).join(',') === 'auto,new',
  )
  check(
    'stable roster deduplicates malformed input',
    stablePermissionRosterOrder(['auto', 'auto'], ['safe', 'safe']).join(',') === 'safe',
  )
}

if (failures > 0) {
  console.error(`permission preset verification failed: ${failures}`)
  process.exitCode = 1
} else {
  console.log('permission preset verification passed')
}