/**
 * DSH Agent Teams read side (issue #1241, phase 1): the `agentTeam` roster
 * store, team-message bubbles and the team tool cards, on both upstream wire
 * shapes:
 *
 * - the durable roster wire (`0.2.2-rc.1` and earlier: `{members, tasks}`),
 *   recorded from the 0.2.1 line; 0.2.0 records are covered apart by
 *   verify-agent-teams-compat-0.2.0.ts;
 * - the per-session selection wire (`0.2.2-rc.2` and later:
 *   `{enabled, tasks, failure?}`), whose members are synthesised from the
 *   Lead's `subagentCatalog` (payload v3 names).
 *
 * No team package is imported. Preset delegation rows are covered by
 * verify-bundled-presets.mjs.
 *
 * Run: node --import tsx/esm scripts/verify-agent-teams.ts
 */
import assert from 'node:assert/strict'
import { createDshTranslator } from '../src/dsh-adapter/backend/translate.js'
import { isSubagentToolName } from '../src/dsh-adapter/channel/projection-helpers.js'
import type { ProjectionRegistryLike } from '../src/dsh-adapter/activity-store.js'
import { attachSessionProjection, createSessionProjectionStore } from '../src/dsh-adapter/session-projection-store.js'
import {
  asTeamView, createTeamRosterStore, teamRootOf, TEAM_PROJECTION_KEY, SUBAGENT_CATALOG_KEY,
} from '../src/dsh-adapter/team-roster.js'
import { teamToolCallView, teamToolResultView } from '../src/dsh-adapter/team-tools.js'
import { SubagentActivityStore } from '../src/dsh-adapter/subagents.js'
import { createProjectorHarness } from './lib/projector-harness.js'

const LEAD = 'lead-1'
const MATE = 'd760b893-aa5a-450f-8d8e-472b8c09e6cd'
const SECOND = 'b2b6a2b8-1f7f-4b4d-9d0b-2b2b6f6a1c3e'
const lead = { id: LEAD, name: 'lead', role: 'lead', phase: 'active' }
const reviewer = { id: MATE, name: 'reviewer', role: 'teammate', phase: 'active' }
const task = { id: 'task-1', revision: 1, subject: 'Review', description: 'review it', status: 'pending', blockedBy: [], writeScopes: ['src'], ready: true, writeScopeWarnings: [] }
/** What every root session publishes once the legacy service is mounted. */
const baseline = { members: [lead], tasks: [] }
const team = { members: [lead, reviewer], tasks: [task] }
/** rc.2's switch wire: no members; the catalog supplies them. */
const switchBaseline = { enabled: false, tasks: [] }
const switchOn = { enabled: true, tasks: [] }
const catalog = [
  { id: MATE, createdAt: 1, mode: 'continuable', label: 'Review the diff', name: 'reviewer' },
  { id: 'unnamed-child', createdAt: 2, mode: 'one-shot', label: 'one shot' },
]

// ── narrowing: legacy roster wire ────────────────────────────────────────
assert.equal(asTeamView(baseline, LEAD), undefined, 'the implicit one-member team is no team')
assert.deepEqual(asTeamView(team, LEAD),
  { leadSessionId: LEAD, mode: 'roster', enabled: true, members: team.members, tasks: team.tasks })
assert.equal(asTeamView({ members: [lead], tasks: [task] }, LEAD)?.tasks.length, 1, 'a task alone is a team')
assert.equal(asTeamView({ ...baseline, failure: 'bad record' }, LEAD)?.failure, 'bad record', 'a failure is always shown')
assert.equal(asTeamView({ members: [{ ...reviewer, phase: 'gone' }], tasks: [] }, LEAD), undefined, 'malformed rows drop the value')
assert.equal(asTeamView({ members: [lead], tasks: [{ ...task, status: 'deleted' }] }, LEAD), undefined)
assert.equal(asTeamView(undefined, LEAD), undefined)
console.log('PASS roster wire narrowing (baseline hidden, teammate/task/failure shown, malformed dropped)')

// ── narrowing: rc.2 selection wire ───────────────────────────────────────
assert.equal(asTeamView(switchBaseline, LEAD), undefined, 'a root that never selected Team reads as none')
assert.deepEqual(asTeamView(switchOn, LEAD),
  { leadSessionId: LEAD, mode: 'switch', enabled: true, members: [lead], tasks: [] },
  'an enabled root is a team even before a subagent exists')
assert.deepEqual(asTeamView({ enabled: true, tasks: [task] }, LEAD)?.tasks.length, 1)
assert.deepEqual(asTeamView({ enabled: false, tasks: [task] }, LEAD),
  { leadSessionId: LEAD, mode: 'switch', enabled: false, members: [lead], tasks: [task] },
  'a disabled root keeps its task board (read-only), it does not disappear')
assert.equal(asTeamView({ enabled: true, tasks: [], failure: 'bad task' }, LEAD)?.failure, 'bad task', 'a failure is always shown')
assert.equal(asTeamView({ enabled: 'yes', tasks: [] }, LEAD), undefined, 'a malformed selection drops the value')
assert.equal(asTeamView({ enabled: true, tasks: [{ ...task, status: 'deleted' }] }, LEAD), undefined)
assert.deepEqual(asTeamView(switchOn, LEAD, catalog)?.members,
  [
    { id: LEAD, name: 'lead', role: 'lead', phase: 'active' },
    { id: MATE, name: 'reviewer', role: 'teammate', phase: 'active', description: 'Review the diff' },
  ],
  'named catalog children become teammates; unnamed ones stay out of the roster')
assert.equal(asTeamView({ members: [lead, reviewer], tasks: [], enabled: false }, LEAD)?.mode, 'roster', 'the roster wire wins when it carries members')
console.log('PASS switch wire narrowing (selection, disabled board, catalog members, malformed dropped)')

// ── team root of a bound session ─────────────────────────────────────────
const leadSession = { id: LEAD, header: { version: 4, id: LEAD } }
const mateSession = { id: MATE, header: { version: 4, id: MATE, parentSession: LEAD, origin: 'subagent', delegationDepth: 1 } }
const nestedSession = { id: SECOND, header: { version: 4, id: SECOND, parentSession: MATE, origin: 'subagent', delegationDepth: 2 } }
const agents = { list: () => [{ session: leadSession }, { session: mateSession }, { session: nestedSession }] }
assert.deepEqual(teamRootOf(leadSession, agents), { id: LEAD, session: leadSession })
assert.deepEqual(teamRootOf(mateSession, agents), { id: LEAD, session: leadSession }, 'a teammate reads its Lead')
assert.deepEqual(teamRootOf(nestedSession, agents), { id: LEAD, session: leadSession }, 'a nested subagent walks to the tree root')
assert.deepEqual(teamRootOf(mateSession, { list: () => [] }), { id: LEAD }, 'an unloaded Lead still names the watched id')
const forked = { id: 'fork-1', header: { parentSession: LEAD } }
assert.deepEqual(teamRootOf(forked, agents), { id: 'fork-1', session: forked }, 'a fork is its own root')
console.log('PASS team root (Lead itself, teammate → parentSession, nested → tree root, fork stays own root)')

// ── store over a fake registry: legacy roster wire ───────────────────────
{
  const published = new Map<string, unknown>([[LEAD, team]])
  let feed: ((session: { readonly id: unknown }, key: string, value: unknown, seq: number) => void) | undefined
  const registry: ProjectionRegistryLike = {
    onChanged(listener) { feed = listener; return () => { feed = undefined } },
    snapshot(session, keys) {
      // The team store asks for its key; the catalog store for the member source.
      const requested = keys[0]!
      return { values: { [requested]: requested === TEAM_PROJECTION_KEY ? published.get(String((session as { id: unknown }).id)) : undefined } }
    },
  }
  let effect: (() => void) | undefined
  const ctx = {
    inject(_deps: unknown, callback: (ctx: unknown) => void) {
      callback({ sessionProjections: registry, effect: (fn: () => () => void) => { effect = fn() } })
    },
  }
  const store = createSessionProjectionStore({ key: TEAM_PROJECTION_KEY, narrow: asTeamView, watch: session => teamRootOf(session, agents) })
  let emits = 0
  store.subscribe(() => { emits++ })
  store.seed(mateSession)
  assert.equal(store.read(), undefined, 'no registry yet: nothing to read')
  attachSessionProjection(ctx as never, TEAM_PROJECTION_KEY, store as never)
  assert.equal(store.read()?.members[1]?.name, 'reviewer', 'a late registry seeds the bound teammate with its Lead team')
  assert.equal(store.read()?.leadSessionId, LEAD)
  assert.equal(emits, 1)
  const before = store.read()
  feed!({ id: LEAD }, TEAM_PROJECTION_KEY, team, 3)
  assert.equal(store.read(), before, 'the same value reference is no change')
  feed!({ id: 'other-root' }, TEAM_PROJECTION_KEY, { members: [lead, reviewer], tasks: [] }, 4)
  feed!({ id: LEAD }, 'workingActivity', {}, 5)
  assert.equal(emits, 1, 'other sessions and other keys are ignored')
  feed!({ id: LEAD }, TEAM_PROJECTION_KEY, baseline, 6)
  assert.equal(store.read(), undefined, 'a value that reads as no team clears the store')
  assert.equal(emits, 2)
  published.set('plain-1', baseline)
  store.seed({ id: 'plain-1' })
  assert.equal(store.read(), undefined)
  assert.equal(emits, 2, 'binding a session without a team emits nothing')
  effect!()
  assert.equal(feed, undefined, 'the feed listener goes with the injected fiber')
}
{
  // A registry that leaves is never read again; its value clears, and the
  // read-failure warning re-arms for the next registry.
  let reads = 0
  let fail = false
  const registry: ProjectionRegistryLike = {
    onChanged: () => () => undefined,
    snapshot() {
      reads++
      if (fail) throw new Error('disposed')
      return { values: { [TEAM_PROJECTION_KEY]: team } }
    },
  }
  let effect: (() => void) | undefined
  const ctx = {
    inject(_deps: unknown, callback: (ctx: unknown) => void) {
      callback({ sessionProjections: registry, effect: (fn: () => () => void) => { effect = fn() } })
    },
  }
  const warnings: string[] = []
  const store = createSessionProjectionStore({ key: TEAM_PROJECTION_KEY, narrow: asTeamView, warn: message => { warnings.push(message) } })
  store.seed(leadSession)
  attachSessionProjection(ctx as never, TEAM_PROJECTION_KEY, store as never)
  assert.equal(store.read()?.leadSessionId, LEAD)
  fail = true
  store.reseed()
  store.reseed()
  assert.equal(warnings.length, 1, 'one registry warns once')
  effect!()
  assert.equal(store.read(), undefined, 'a registry that left clears the value')
  const left = reads
  store.reseed()
  assert.equal(reads, left, 'a registry that left is not read again')
  assert.equal(store.read(), undefined, 'a reseed without a registry keeps nothing stale')
  attachSessionProjection(ctx as never, TEAM_PROJECTION_KEY, store as never)
  assert.equal(warnings.length, 2, 'a new registry re-arms the warning')
  fail = false
  store.reseed()
  assert.equal(store.read()?.leadSessionId, LEAD, 'a registry that comes back seeds again')
}
console.log('PASS isolated team projection store (late registry, identity, isolation, baseline clear, disposal, registry leaving, read failure)')

// ── composition-root store: legacy wire ──────────────────────────────────
{
  const registry: ProjectionRegistryLike = {
    onChanged: () => () => undefined,
    snapshot: session => ({ values: { [TEAM_PROJECTION_KEY]: String((session as { id: unknown }).id) === LEAD ? team : undefined } }),
  }
  const ctx = {
    get: (name: string) => (name === 'agents' ? agents : name === 'agentTeams' ? {} : undefined),
    logger: { warn: () => undefined },
    inject(_deps: unknown, callback: (ctx: unknown) => void) { callback({ sessionProjections: registry, effect: () => undefined }) },
    on: () => () => undefined,
  }
  const store = createTeamRosterStore(ctx as never)
  store.seed(mateSession)
  assert.equal(store.teamOf(MATE)?.leadSessionId, LEAD, 'inside a teammate the channel reads the Lead team')
  assert.equal(store.teamOf(LEAD), undefined, 'only the seeded session reads it')
  assert.equal(store.teamOf('claude-session'), undefined, 'a session that never seeds (another backend) reads no stale team')
  // A plain child of the Lead watches the same parent but is on no team.
  store.seed({ id: 'plain-child', header: { version: 4, id: 'plain-child', parentSession: LEAD, origin: 'subagent', delegationDepth: 1 } })
  assert.equal(store.watchedId, LEAD)
  assert.equal(store.teamOf('plain-child'), undefined, 'a non-teammate child of the Lead reads no team')
  store.seed(leadSession)
  assert.equal(store.teamOf(LEAD)?.leadSessionId, LEAD, 'the Lead reads its own team')
}
console.log('PASS composition store on the roster wire (late registry seed, teammate → Lead, identity, isolation, baseline clear)')

// ── composition-root store: rc.2 selection wire + catalog members ────────
{
  let teamValue: unknown = switchOn
  let catalogValue: unknown = catalog
  let service = true
  const changes: Array<(session: unknown, key: string, value: unknown) => void> = []
  const registry: ProjectionRegistryLike = {
    onChanged(listener) { changes.push(listener); return () => undefined },
    snapshot(session, keys) {
      const requested = keys[0]!
      return {
        values: {
          [requested]: requested === TEAM_PROJECTION_KEY ? teamValue
            : requested === SUBAGENT_CATALOG_KEY ? catalogValue
              : undefined,
        },
      }
    },
  }
  const ctx = {
    get: (name: string) => (name === 'agents' ? agents : name === 'agentTeams' ? (service ? {} : undefined) : undefined),
    logger: { warn: () => undefined },
    inject(_deps: unknown, callback: (ctx: unknown) => void) { callback({ sessionProjections: registry, effect: () => undefined }) },
    on: () => () => undefined,
  }
  const store = createTeamRosterStore(ctx as never)
  let emits = 0
  store.subscribe(() => { emits++ })
  store.seed(leadSession)
  assert.equal(store.teamOf(LEAD)?.mode, 'switch', 'the selection wire reads as a switch team')
  assert.equal(store.teamOf(LEAD)?.enabled, true)
  assert.deepEqual(store.teamOf(LEAD)?.members.map(member => member.name), ['lead', 'reviewer'],
    'named catalog children compose the members (unnamed ones stay out)')
  assert.equal(store.teamOf(LEAD)?.members[1]?.description, 'Review the diff', 'the creation label is the member description')
  // The team view is read at the Lead's own session id only.
  store.seed(mateSession)
  assert.equal(store.teamOf(MATE)?.members.length, 2, 'a teammate session reads the root team')
  assert.equal(store.teamOf(LEAD), undefined, 'only the seeded session reads it')

  // A catalog fact arriving after the team value recomposes the members.
  emits = 0
  catalogValue = [...catalog, { id: SECOND, createdAt: 3, mode: 'continuable', label: 'checker', name: 'checker' }]
  const beforeFeed = store.teamOf(MATE)
  for (const listener of changes) listener({ id: LEAD }, SUBAGENT_CATALOG_KEY, catalogValue)
  assert.equal(store.teamOf(MATE)?.members.length, 3, 'a new catalog row joins the roster')
  assert.notEqual(store.teamOf(MATE), beforeFeed, 'the view is re-read, not left stale')
  assert.ok(emits > 0, 'the recomposition reaches subscribers')

  // A disabled root keeps its board but the team is no longer a team when empty.
  teamValue = { enabled: false, tasks: [task] }
  for (const listener of changes) listener({ id: LEAD }, TEAM_PROJECTION_KEY, teamValue)
  assert.equal(store.teamOf(MATE)?.enabled, false, 'a disabled root reads as switched off')
  assert.equal(store.teamOf(MATE)?.tasks.length, 1, 'its tasks stay readable')
  teamValue = switchBaseline
  for (const listener of changes) listener({ id: LEAD }, TEAM_PROJECTION_KEY, teamValue)
  assert.equal(store.teamOf(MATE), undefined, 'an empty disabled root reads as no team')

  // A nested subagent still belongs to the root's tree on the switch wire.
  store.seed(nestedSession)
  teamValue = switchOn
  for (const listener of changes) listener({ id: LEAD }, TEAM_PROJECTION_KEY, teamValue)
  assert.equal(store.teamOf(SECOND)?.leadSessionId, LEAD, 'a nested subagent reads the root team')

  // The service leaving clears the view even while the projection stays registered.
  store.seed(leadSession)
  service = false
  // A fresh value reference, as a host publication after a service change is.
  for (const listener of changes) listener({ id: LEAD }, TEAM_PROJECTION_KEY, { enabled: true, tasks: [] })
  assert.equal(store.teamOf(LEAD), undefined, 'no service, no team')
}
console.log('PASS composition store on the selection wire (catalog members, late catalog, disabled board, nested tree, service presence)')

// ── binding switch: one seed rebinds both watches ────────────────────────
{
  // Two root sessions with their own agents; a real channel binds one at a
  // time. Seeding the next root must compose its members from ITS catalog:
  // the old composite seed let the catalog-change reseed run while the team
  // store still pointed at the previous session, which rebound the catalog
  // back and mixed the previous root's members into the new team.
  const rootA = { id: 'root-a', header: { version: 4, id: 'root-a' } }
  const rootB = { id: 'root-b', header: { version: 4, id: 'root-b' } }
  const twoRoots = { list: () => [{ session: rootA }, { session: rootB }] }
  const catalogs: Record<string, unknown> = {
    'root-a': [{ id: 'child-a', createdAt: 1, mode: 'continuable', label: 'A', name: 'reviewer' }],
    'root-b': [{ id: 'child-b', createdAt: 1, mode: 'continuable', label: 'B', name: 'checker' }],
  }
  const twoRootRegistry: ProjectionRegistryLike = {
    onChanged: () => () => undefined,
    snapshot(session, keys) {
      const id = String((session as { id: unknown }).id)
      const requested = keys[0]!
      return { values: { [requested]: requested === TEAM_PROJECTION_KEY ? switchOn : requested === SUBAGENT_CATALOG_KEY ? catalogs[id] : undefined } }
    },
  }
  const twoRootCtx = {
    get: (name: string) => (name === 'agents' ? twoRoots : name === 'agentTeams' ? {} : undefined),
    logger: { warn: () => undefined },
    inject(_deps: unknown, callback: (ctx: unknown) => void) { callback({ sessionProjections: twoRootRegistry, effect: () => undefined }) },
    on: () => () => undefined,
  }
  const switching = createTeamRosterStore(twoRootCtx as never)
  switching.seed(rootA)
  assert.deepEqual(switching.teamOf('root-a')?.members.map(member => member.name), ['lead', 'reviewer'])
  switching.seed(rootB)
  assert.equal(switching.boundId, 'root-b')
  assert.deepEqual(switching.teamOf('root-b')?.members.map(member => member.name), ['lead', 'checker'],
    'one seed after a session switch composes the new root catalog, never the previous one')
  assert.equal(switching.teamOf('root-a'), undefined)
}
console.log('PASS a bound-session switch rebinds the catalog with the team (no previous-root members)')

// ── team messages ────────────────────────────────────────────────────────
const deps = { tools: () => undefined, scope: () => ({}), attachments: () => undefined }
{
  // What 0.2.1-alpha.5 records: the sender only in the framing block, the
  // generic agent-message relay as the source.
  const relayed = {
    type: 'user/message', seq: 21, time: 1792133614950,
    data: {
      role: 'user', id: '6e645a6d-4967-45bc-abee-06b1f92f5c23',
      content: [{ type: 'text', text: 'Team message from reviewer:' }, { type: 'text', text: 'reviewer report: diff ok' }],
      source: { kind: 'agent-message', form: 'relay', senderSessionId: MATE },
    },
  }
  for (const replaying of [false, true]) {
    const translator = createDshTranslator(deps)
    const events = replaying ? translator.translateReplay([relayed] as never) : translator.translateEvent(relayed as never)
    const message = events.find(event => event.type === 'user.message')
    assert.ok(message !== undefined && message.type === 'user.message')
    assert.equal(message.source, 'team-message')
    assert.equal(message.sender, 'reviewer')
    assert.equal(message.text, 'reviewer report: diff ok', 'the framing block is dropped')
    const harness = createProjectorHarness()
    harness.apply(events, replaying)
    assert.deepEqual(harness.state.rows.filter(row => row.kind === 'user').map(row => ({ text: row.text, sender: row.sender, label: row.label, seq: row.seq })),
      [{ text: 'reviewer report: diff ok', sender: 'reviewer', label: 'team-message', seq: 21 }], 'one bubble in the receiving transcript')
    assert.equal(harness.state.lastUserText, '', 'a peer message is not the human prompt')
  }
  // A relay without the team framing (the legacy send_message) is no team message.
  const legacy = { ...relayed, data: { ...relayed.data, content: [{ type: 'text', text: 'plain relay' }] } }
  const harness = createProjectorHarness()
  harness.apply(createDshTranslator(deps).translateEvent(legacy as never))
  assert.deepEqual(harness.state.rows.filter(row => row.kind === 'user'), [])
  // Framing on a non-relay source is the human's own text.
  const typed = { ...relayed, data: { ...relayed.data, source: { kind: 'user' } } }
  const own = createDshTranslator(deps).translateEvent(typed as never).find(event => event.type === 'user.message')
  assert.ok(own?.type === 'user.message' && own.source === 'user')
  // Other injected sources stay hidden.
  const injected = { ...relayed, data: { ...relayed.data, source: { kind: 'subagent-settled', form: 'notice', summary: 's', senderSessionId: MATE } } }
  const hidden = createProjectorHarness()
  hidden.apply(createDshTranslator(deps).translateEvent(injected as never))
  assert.deepEqual(hidden.state.rows.filter(row => row.kind === 'user'), [])
  // Inside the teammate the agent-message feed owns it: no line of its own.
  const store = new SubagentActivityStore()
  store.onSpawned(MATE)
  store.onSessionEvent(MATE, { ...relayed, data: { ...relayed.data, content: [{ type: 'text', text: 'Team message from lead:' }, { type: 'text', text: 'check src/ too' }], source: { ...relayed.data.source, senderSessionId: LEAD } } })
  assert.deepEqual(store.get(MATE)?.outputEvents, [], 'a team message adds no line to the child')
}
console.log('PASS team message (live + replay → sender bubble from the framing name, not the last prompt; legacy relay, typed framing and other injected stay hidden; the child leaves it to the agent-message feed)')

// ── tool cards ───────────────────────────────────────────────────────────
assert.equal(isSubagentToolName('spawn_teammate'), true, 'a historical spawn_teammate call still renders as the subagent row')
// Calls: the team copy used `target`; the 0.2.2-rc.2 standard control uses `agent`.
assert.deepEqual(teamToolCallView('send_message', JSON.stringify({ target: 'reviewer', message: 'check src/\nthen report' })),
  { card: 'generic', title: '→ reviewer · check src/', displayKey: 'tool-name-team-message', category: 'other' })
assert.equal(teamToolCallView('send_message', JSON.stringify({ agent: 'reviewer', message: 'check src/\nthen report' }))?.title,
  '→ reviewer · check src/', 'the rc.2 argument key renders the same one-line call')
assert.equal(teamToolCallView('send_message', JSON.stringify({ agent_id: 'x', message: 'legacy' })), undefined, 'the legacy control keeps the plain card')
assert.equal(teamToolCallView('interrupt_agent', JSON.stringify({ agent_id: 'x' })), undefined)
assert.equal(teamToolCallView('interrupt_agent', JSON.stringify({ target: 'reviewer' }))?.title, 'reviewer')
assert.equal(teamToolCallView('interrupt_agent', JSON.stringify({ agent: 'reviewer' }))?.title, 'reviewer', 'rc.2 agent key')
assert.equal(teamToolCallView('list_agents', '{}'), undefined, 'a list call cannot tell team from the standard control')
assert.equal(teamToolCallView('team_task_update', JSON.stringify({ task_id: 'task-1', expected_revision: 1, action: 'reassign', owner: 'reviewer' }))?.title, 'task-1 reassign → reviewer')
assert.equal(teamToolCallView('team_task_list', JSON.stringify({ status: 'pending', ready: true }))?.title, 'status=pending ready=true')
assert.equal(teamToolCallView('team_task_list', JSON.stringify({ unowned: true }))?.title, 'unowned=true')
assert.equal(teamToolCallView('team_task_list', '{}'), undefined, 'an unfiltered list keeps the plain card, never a blank title')
assert.equal(teamToolCallView('bash', '{}'), undefined)

// Results: the legacy team copy answered `{sent}` / `{previousStatus}`; the
// rc.2 standard control answers `{messageId}` / `{accepted}` / `{timedOut}`.
const sendArgsLegacy = JSON.stringify({ target: 'lead', message: 'reviewer report: diff ok' })
const sendArgsSwitch = JSON.stringify({ agent: 'lead', message: 'reviewer report: diff ok' })
const sendArgsControl = JSON.stringify({ agent_id: 'x', message: 'legacy' })
assert.deepEqual(teamToolResultView('send_message', sendArgsLegacy, '{"sent":true}'),
  { card: 'generic', displayKey: 'tool-name-team-message', category: 'other', title: '→ lead · reviewer report: diff ok', content: [{ type: 'text', text: 'sent' }] })
assert.deepEqual(teamToolResultView('send_message', sendArgsSwitch, '{"messageId":"m"}')?.content, [{ type: 'text', text: 'sent' }],
  'the rc.2 control result folds to one line')
assert.equal(teamToolResultView('send_message', sendArgsControl, '{"messageId":"m"}'), undefined, 'the legacy control result stays raw')
assert.equal(teamToolResultView('send_message', sendArgsSwitch, 'message delivered to agent x'), undefined, 'plain text results stay raw')
assert.deepEqual(teamToolResultView('list_agents', '{}', '[{"target":"lead","role":"lead","status":"running","diagnostics":[]},{"target":"reviewer","role":"teammate","status":"inactive","diagnostics":[]}]')?.content,
  [{ type: 'text', text: 'lead running · reviewer inactive' }], 'the team copy rows still render')
assert.deepEqual(teamToolResultView('list_agents', '{}', '[{"name":"lead","status":"running","description":"root agent"},{"name":"reviewer/checker","status":"inactive","description":"check the diff"}]')?.content,
  [{ type: 'text', text: 'lead running · reviewer/checker inactive' }], 'the rc.2 rows render the named path')
assert.deepEqual(teamToolResultView('wait_agent', '{}', '{"timedOut":false,"noProgress":{"message":"m"}}')?.content, [{ type: 'text', text: 'noProgress' }])
assert.deepEqual(teamToolResultView('wait_agent', '{}', '{"timedOut":false,"noProgress":false}')?.content, [{ type: 'text', text: 'changed' }])
assert.deepEqual(teamToolResultView('wait_agent', '{}', '{"timedOut":true}')?.content, [{ type: 'text', text: 'timedOut' }], 'rc.2 dropped noProgress')
assert.deepEqual(teamToolResultView('interrupt_agent', JSON.stringify({ target: 'reviewer' }), '{"previousStatus":"running"}')?.content,
  [{ type: 'text', text: 'running' }], 'the team copy result')
assert.deepEqual(teamToolResultView('interrupt_agent', JSON.stringify({ agent: 'reviewer' }), '{"accepted":true}')?.content,
  [{ type: 'text', text: 'accepted' }], 'the rc.2 control result')
assert.equal(teamToolResultView('interrupt_agent', JSON.stringify({ agent_id: 'x' }), '{"accepted":true}'), undefined, 'the legacy control stays raw')
assert.deepEqual(teamToolResultView('team_task_create', JSON.stringify({ subject: 'Review', description: 'r' }), JSON.stringify(task))?.content, [{ type: 'text', text: 'task-1 r1 · pending' }])
assert.deepEqual(teamToolResultView('team_task_list', '{}', JSON.stringify({ tasks: [task, { ...task, id: 'task-2', status: 'in_progress', ownerName: 'reviewer' }] }))?.content,
  [{ type: 'text', text: 'task-1 r1 · pending' }, { type: 'text', text: 'task-2 r1 · in_progress · reviewer' }], 'the legacy team copy reads ownerName')
assert.deepEqual(teamToolResultView('team_task_list', '{}', JSON.stringify({ tasks: [{ ...task, owner: 'reviewer' }], nextCursor: 1 }))?.content,
  [{ type: 'text', text: 'task-1 r1 · pending · reviewer' }], 'rc.2 reads the owner name and ignores the page cursor')
assert.deepEqual(teamToolResultView('team_task_list', '{}', '{"tasks":[]}')?.content, [], 'an empty board is an empty card')
assert.equal(teamToolResultView('team_task_get', '{}', '{"unexpected":true}'), undefined, 'an unknown shape stays raw')
{
  // The translator asks a presenter-less tool's team fallback; a real presenter wins.
  const call = (tool: unknown, args: string) => createDshTranslator({ ...deps, tools: () => ({ get: () => tool }) as never })
    .translateEvent({ type: 'tool/call', seq: 30, time: 1, data: { callId: 'c1', name: 'send_message', arguments: args, turn: 1, step: 1 } } as never)
    .find(event => event.type === 'tool.call')
  const fallback = call({}, sendArgsSwitch)
  assert.ok(fallback?.type === 'tool.call' && fallback.presentation !== undefined && 'title' in fallback.presentation && fallback.presentation.title === '→ lead · reviewer report: diff ok')
  const owned = call({ presentCall: () => ({ card: 'generic', title: 'own' }) }, sendArgsSwitch)
  assert.ok(owned?.type === 'tool.call' && owned.presentation !== undefined && 'title' in owned.presentation && owned.presentation.title === 'own')
}
{
  // The legacy team (0.2.2-rc.1 and earlier, and historical logs) refuses a
  // teammate before it writes the member: only the call and its error are on
  // the log, so the translator brings back the plain card for the failure. rc.2
  // never records this tool; the path stays inert there.
  const spawnArgs = JSON.stringify({ name: 'reviewer', description: 'Review the diff', prompt: 'review' })
  const spawnCall = { type: 'tool/call', seq: 40, time: 1, data: { callId: 'spawn-1', name: 'spawn_teammate', arguments: spawnArgs, turn: 1, step: 1 } }
  const refused = 'teammate name "reviewer" was already used in this Team'
  const spawnResult = (isError: boolean) => ({
    type: 'tool/result', seq: 41, time: 2,
    data: {
      turn: 1, step: 1,
      message: { id: 'msg-spawn', role: 'tool', content: [{ type: 'text', text: isError ? refused : '{"id":"m1","name":"reviewer"}' }], source: { kind: 'tool', callId: 'spawn-1' }, toolCallId: 'spawn-1', ...isError ? { isError: true } : {} },
      ...isError ? { error: { name: 'TeamError', code: 'TEAM_MEMBER_NAME_TAKEN', reason: refused } } : {},
    },
  })
  for (const replaying of [false, true]) {
    // Exercise the real replay seed path (prepareReplayEvents + the
    // translator's replay-mode reset), not just the projector's replay flag.
    const translateAll = (translator: ReturnType<typeof createDshTranslator>, events: unknown[]) =>
      replaying ? translator.translateReplay(events as never) : events.flatMap(event => translator.translateEvent(event as never))
    const translator = createDshTranslator(deps)
    const harness = createProjectorHarness()
    harness.apply(translateAll(translator, [spawnCall, spawnResult(true)]), replaying)
    const cards = harness.state.rows.filter(row => row.kind === 'tool')
    assert.equal(cards.length, 1, `a refused spawn shows one card (${replaying ? 'replay' : 'live'})`)
    assert.equal(cards[0]!.tool?.name, 'spawn_teammate')
    assert.equal(cards[0]!.tool?.status, 'error')
    assert.match(cards[0]!.tool?.errorText ?? '', /already used in this Team/, 'the upstream reason is on the card')
    const accepted = createProjectorHarness()
    const fresh = createDshTranslator(deps)
    accepted.apply(translateAll(fresh, [spawnCall, spawnResult(false)]), replaying)
    assert.deepEqual(accepted.state.rows.filter(row => row.kind === 'tool'), [], 'an accepted spawn leaves the teammate to the subagent row')
    // A spawn that fails after writing its member (start failure, interrupt):
    // the failed member carries the error on the roster, so no card.
    const member = (seq: number, phase: string) => ({ type: 'team/member', seq, time: 1, data: { version: 2, teamId: 'lead', member: { id: 'm1', name: 'reviewer', description: 'Review the diff', provider: 'p', phase } } })
    const written = createProjectorHarness()
    const late = createDshTranslator(deps)
    written.apply(translateAll(late, [spawnCall, member(41, 'provisioning'), member(42, 'failed'), { ...spawnResult(true), seq: 43 }]), replaying)
    assert.deepEqual(written.state.rows.filter(row => row.kind === 'tool'), [], `a spawn failing after its member is written stays on the roster (${replaying ? 'replay' : 'live'})`)
  }
}
console.log('PASS team tool cards (target/agent call keys, roster and named list_agents rows, wait without noProgress, interrupt shapes, task owner name, legacy names and unknown shapes stay raw, a legacy refused spawn shows one error card live and on replay, none once its member is written)')

console.log('ALL PASS')
