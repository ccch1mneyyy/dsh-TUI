/**
 * Agent Teams at run time (issue #1241, docs/agent-teams-design.md
 * 「开关机制」): the per-assembly choice of delegation tools, the team store
 * following the service across a plugin-manager change, `/team status` and its
 * service-gated visibility, and the confirmation that disabling the team
 * bundle asks while teammates are active (through `/plugin disable`). The
 * plugin manager and the registry are fakes; the live toggle itself was
 * measured against the real 0.2.0-rc.2 bundle (see the design doc).
 *
 * Run: node --import tsx/esm scripts/verify-team-mode.ts
 */
process.env.DSH_TUI_LANG = 'en'
const [{ mkdtempSync, rmSync }, { tmpdir }, { join }, assertModule] = await Promise.all([
  import('node:fs'),
  import('node:os'),
  import('node:path'),
  import('node:assert/strict'),
])
const assert = assertModule.default
const dataDir = mkdtempSync(join(tmpdir(), 'verify-team-mode-data-'))
process.env.HOME = dataDir
process.env.USERPROFILE = dataDir

const [teamMode, roster, manage] = await Promise.all([
  import('../src/dsh-adapter/team-mode.js'),
  import('../src/dsh-adapter/team-roster.js'),
  import('../src/dsh-adapter/plugin-manage.js'),
])
const {
  createTeamCommandEntry, filterTeamReplacedTools, parseTeamArgs,
  teamServiceActive, withTeamCommandVisibility,
} = teamMode
const { createTeamRosterStore, TEAM_BUNDLE, TEAM_PROJECTION_KEY } = roster
const { createPluginManageEntry } = manage
type PluginManagerView = import('../src/dsh-adapter/plugin-manager.js').PluginManagerView
type BundleInfo = Awaited<ReturnType<PluginManagerView['listBundles']>>[number]

try {
  // ── delegation tools per assembly ──────────────────────────────────────
  {
    const tool = (name: string) => ({ name })
    const assembly = (...names: string[]) => ({ sections: [], contexts: [], variables: {}, tools: names.map(tool) }) as never
    const on = assembly('bash', 'subagent', 'subagent_fork', 'spawn_teammate', 'send_message', 'list_agents')
    assert.deepEqual(filterTeamReplacedTools(on).tools.map((t: { name: string }) => t.name),
      ['bash', 'spawn_teammate', 'send_message', 'list_agents'],
      'with spawn_teammate the legacy spawners leave; the shared-name controls are the shadowing team copies')
    const off = assembly('bash', 'subagent', 'subagent_fork', 'send_message')
    assert.equal(filterTeamReplacedTools(off), off, 'without the team tools the assembly is untouched')
    const teamOnly = assembly('bash', 'spawn_teammate')
    assert.equal(filterTeamReplacedTools(teamOnly), teamOnly, 'nothing to drop keeps the reference')
    console.log('PASS delegation tools follow spawn_teammate per assembly')
  }

  // ── team store follows the service across a plugin-manager change ──────
  {
    const LEAD = 'lead-1'
    const team = {
      members: [{ id: LEAD, name: 'lead', role: 'lead', phase: 'active' }, { id: 'm1', name: 'builder', role: 'teammate', phase: 'active' }],
      tasks: [],
    }
    let mounted = true
    let changed: (() => void) | undefined
    const ctx = {
      get: (name: string) => (name === 'agentTeams' ? (mounted ? {} : undefined) : name === 'agents' ? { list: () => [] } : undefined),
      logger: { warn: () => undefined },
      inject(_deps: unknown, callback: (ctx: unknown) => void) {
        callback({
          sessionProjections: {
            onChanged: () => () => undefined,
            // An unregistered definition is absent from the snapshot.
            snapshot: () => ({ values: mounted ? { [TEAM_PROJECTION_KEY]: team } : {} }),
          },
          effect: () => undefined,
        })
      },
      on(name: string, listener: () => void) {
        if (name === 'plugin-manager/changed') changed = listener
        return () => undefined
      },
    }
    const store = createTeamRosterStore(ctx as never)
    let emits = 0
    store.subscribe(() => { emits++ })
    store.seed({ id: LEAD })
    assert.equal(store.read()?.members.length, 2)
    assert.ok(changed !== undefined, 'the store listens for plugin-manager changes')
    mounted = false
    changed!()
    assert.equal(store.read(), undefined, 'switched off: the view clears')
    assert.equal(emits, 2)
    mounted = true
    changed!()
    assert.equal(store.read()?.members[1]?.name, 'builder', 'switched on again: the Lead team comes back')
    assert.equal(emits, 3)
    console.log('PASS team store clears and comes back on plugin-manager/changed')

    // The service can leave while the projection definition is still
    // registered, the host then handing back the same cached value: the
    // narrow (which checks the service) must still run on a reseed.
    let service = true
    let notify: (() => void) | undefined
    const sameRef = createTeamRosterStore({
      ...ctx,
      get: (name: string) => (name === 'agentTeams' ? (service ? {} : undefined) : name === 'agents' ? { list: () => [] } : undefined),
      inject(_deps: unknown, callback: (ctx: unknown) => void) {
        callback({ sessionProjections: { onChanged: () => () => undefined, snapshot: () => ({ values: { [TEAM_PROJECTION_KEY]: team } }) }, effect: () => undefined })
      },
      on(name: string, listener: () => void) {
        if (name === 'plugin-manager/changed') notify = listener
        return () => undefined
      },
    } as never)
    sameRef.seed({ id: LEAD })
    assert.equal(sameRef.read()?.members.length, 2)
    service = false
    notify!()
    assert.equal(sameRef.read(), undefined, 'the service gone with the definition still registered: the view clears')
    service = true
    notify!()
    assert.equal(sameRef.read()?.members.length, 2, 'and comes back on the same cached value')
    console.log('PASS team store re-narrows an unchanged projection value on plugin-manager/changed')

    // A service change the plugin manager never announces (an HMR-applied
    // CLI edit, a late activation) is followed through `internal/service`.
    let present = true
    let serviceChanged: ((name: unknown) => void) | undefined
    const quiet = createTeamRosterStore({
      ...ctx,
      get: (name: string) => (name === 'agentTeams' ? (present ? {} : undefined) : name === 'agents' ? { list: () => [] } : undefined),
      inject(_deps: unknown, callback: (ctx: unknown) => void) {
        callback({ sessionProjections: { onChanged: () => () => undefined, snapshot: () => ({ values: { [TEAM_PROJECTION_KEY]: team } }) }, effect: () => undefined })
      },
      on(name: string, listener: (name: unknown) => void) {
        if (name === 'internal/service') serviceChanged = listener
        return () => undefined
      },
    } as never)
    quiet.seed({ id: LEAD })
    assert.equal(quiet.read()?.members.length, 2)
    present = false
    serviceChanged!('agents')
    assert.equal(quiet.read()?.members.length, 2, 'another service changing reads nothing again')
    serviceChanged!('agentTeams')
    assert.equal(quiet.read(), undefined, 'the team service gone without a manager event: the view clears')
    present = true
    serviceChanged!('agentTeams')
    assert.equal(quiet.read()?.members.length, 2, 'and comes back with it')
    console.log('PASS team store follows the agentTeams service through internal/service')

    // A teammate whose Lead is not live has no snapshot to read: a reseed
    // still narrows the value it holds, so a stopped service clears it.
    let up = true
    let feed: ((session: unknown, key: string, value: unknown) => void) | undefined
    let onService: ((name: unknown) => void) | undefined
    const orphan = createTeamRosterStore({
      ...ctx,
      get: (name: string) => (name === 'agentTeams' ? (up ? {} : undefined) : name === 'agents' ? { list: () => [] } : undefined),
      inject(_deps: unknown, callback: (ctx: unknown) => void) {
        callback({
          sessionProjections: {
            onChanged: (listener: typeof feed) => { feed = listener; return () => undefined },
            snapshot: () => { throw new Error('no snapshot for a session that is not live') },
          },
          effect: () => undefined,
        })
      },
      on(name: string, listener: (name: unknown) => void) {
        if (name === 'internal/service') onService = listener
        return () => undefined
      },
    } as never)
    orphan.seed({ id: 'm1', header: { origin: 'subagent', parentSession: LEAD } })
    assert.equal(orphan.watchedId, LEAD)
    feed!({ id: LEAD }, TEAM_PROJECTION_KEY, team)
    assert.equal(orphan.read()?.members.length, 2, 'the Lead value arrives on the feed')
    up = false
    onService!('agentTeams')
    assert.equal(orphan.read(), undefined, 'no snapshot to read: the held value is narrowed again and clears')
    up = true
    onService!('agentTeams')
    assert.equal(orphan.read()?.members.length, 2, 'and comes back from the same held value')
    console.log('PASS team store re-narrows the held value when the watched Lead has no snapshot')
  }

  // ── /team ──────────────────────────────────────────────────────────────
  assert.deepEqual(parseTeamArgs(''), { kind: 'status' })
  assert.deepEqual(parseTeamArgs(' status '), { kind: 'status' })
  assert.deepEqual(parseTeamArgs('on'), { kind: 'switch' })
  assert.deepEqual(parseTeamArgs('off now'), { kind: 'switch' })
  assert.deepEqual(parseTeamArgs('toggle'), { kind: 'unknown', sub: 'toggle' })

  // `/team` is a service-gated row: hidden from Help and `/` completion while
  // `agentTeams` is absent, restored by the signal the team store also reads.
  {
    const commands = [{ name: 'team', description: '' }, { name: 'plugin', description: '' }]
    assert.deepEqual(withTeamCommandVisibility(commands, true), commands)
    assert.deepEqual(withTeamCommandVisibility(commands, false).map(command => command.name), ['plugin'])
    assert.equal(teamServiceActive({ get: () => undefined } as never), false)
    assert.equal(teamServiceActive({ get: () => ({}) } as never), true)
    console.log('PASS /team visibility helper follows the agentTeams service')
  }

  const teamBundle = (enabled: boolean): BundleInfo => ({
    name: TEAM_BUNDLE, version: '0.2.0-rc.2', enabled, installed: true, optional: false, removable: true, rows: [], overrides: [],
  }) as BundleInfo
  function rig(options: { bundles?: BundleInfo[]; service?: boolean; manager?: boolean } = {}) {
    const manager = {
      listBundles: () => Promise.resolve(options.bundles ?? [teamBundle(true)]),
      listPlugins: () => Promise.resolve([]),
    } as unknown as PluginManagerView
    const ctx = {
      get: (name: string) => (name === 'pluginManager' ? (options.manager === false ? undefined : manager)
        : name === 'agentTeams' ? (options.service === false ? undefined : {}) : undefined),
    }
    return { ctx, manager }
  }
  const sink = (members: { total: number; active: number; unseen?: number }) => ({
    members: () => ({ unseen: 0, ...members }),
  })
  const linesOf = async (
    entry: ReturnType<typeof createTeamCommandEntry>,
    args: string,
    members: { total: number; active: number; unseen?: number } = { total: 0, active: 0 },
  ): Promise<string[]> => [...await entry(args, sink(members))]

  {
    // Mounted service, selected bundle: the full report.
    const entry = createTeamCommandEntry(rig().ctx as never)
    const status = (await linesOf(entry, '', { total: 2, active: 1 })).join('\n')
    assert.match(status, /Team bundle: on/)
    assert.match(status, /Team service: running/)
    assert.match(status, /Teammates in this session: 2, 1 running or provisioning/)
  }

  {
    // Service still mounted after the bundle was switched off: say which wins.
    const entry = createTeamCommandEntry(rig({ bundles: [teamBundle(false)] }).ctx as never)
    const pending = (await linesOf(entry, 'status')).join('\n')
    assert.match(pending, /Team bundle: off/)
    assert.match(pending, /Team service: running/)
    assert.match(pending, /profile has the team off but the service is still running/)
  }

  {
    // No plugin manager: still report the service and this session's team.
    const entry = createTeamCommandEntry(rig({ manager: false }).ctx as never)
    const unmanaged = (await linesOf(entry, '')).join('\n')
    assert.match(unmanaged, /Team service: running/)
    assert.match(unmanaged, /no profile plugin service/)
    assert.match(unmanaged, /No teammates in this session/)
  }

  {
    // A service with no listed bundle: say unknown, not "installed off".
    const entry = createTeamCommandEntry(rig({ bundles: [] }).ctx as never)
    const unknown = (await linesOf(entry, '')).join('\n')
    assert.match(unknown, /Team bundle: unknown/)
    assert.match(unknown, /Team service: running/)
  }

  {
    // Hidden but typed, bundle still selected: the profile already has it on, so
    // the answer is why no service runs — never an enable command that is a no-op.
    const entry = createTeamCommandEntry(rig({ service: false }).ctx as never)
    const hidden = (await linesOf(entry, '')).join('\n')
    assert.match(hidden, /The profile has the team on but the service is not running/)
    assert.doesNotMatch(hidden, /\/plugin enable/)
    assert.doesNotMatch(hidden, /Team bundle:/)
    assert.doesNotMatch(hidden, /\/plugin disable/, 'it is already on: off is not the route either')
  }

  {
    // Hidden but typed, bundle off: the enable route this launch can run.
    const entry = createTeamCommandEntry(rig({ service: false, bundles: [teamBundle(false)] }).ctx as never)
    const hidden = (await linesOf(entry, '')).join('\n')
    assert.match(hidden, /The team service is not running/)
    assert.match(hidden, new RegExp(`/plugin enable ${TEAM_BUNDLE}`))
    assert.doesNotMatch(hidden, /Team bundle:/)
  }

  {
    // Hidden because the launch has no profile plugin service: the in-session
    // command cannot run at all, so the hint must name the CLI route instead
    // (a `/plugin enable` here would only fail).
    const entry = createTeamCommandEntry(rig({ service: false, manager: false }).ctx as never)
    const unmanaged = (await linesOf(entry, '')).join('\n')
    assert.match(unmanaged, new RegExp(`dsh plugin --profile dsh-tui add ${TEAM_BUNDLE}@`))
    assert.doesNotMatch(unmanaged, /\/plugin enable/)
    assert.match((await linesOf(entry, 'off')).join('\n'), new RegExp(`dsh plugin --profile dsh-tui add ${TEAM_BUNDLE}@`))
  }

  {
    // The installation does not ship the bundle: `/plugin enable` would answer
    // with its generic "no such target", so say what is missing instead.
    const entry = createTeamCommandEntry(rig({ service: false, bundles: [] }).ctx as never)
    const absent = (await linesOf(entry, '')).join('\n')
    assert.match(absent, /The running DSH installation does not ship the team bundle/)
    assert.doesNotMatch(absent, /\/plugin enable/)
  }

  {
    // on / off moved: answer with the new route, mounted or not, and write nothing.
    for (const service of [true, false]) {
      const entry = createTeamCommandEntry(rig({ service }).ctx as never)
      const moved = (await linesOf(entry, 'on')).join('\n')
      assert.match(moved, new RegExp(`/plugin enable\\|disable ${TEAM_BUNDLE}`))
      assert.match(moved, /\/team only reports status/)
      assert.doesNotMatch(moved, /Team service:/)
    }
  }

  {
    const entry = createTeamCommandEntry(rig().ctx as never)
    assert.match((await linesOf(entry, 'toggle')).join('\n'), /Usage: \/team \[status\]/)
  }

  {
    // From a teammate: siblings that may be running are counted as possibly running.
    const status = (await linesOf(createTeamCommandEntry(rig().ctx as never), '', { total: 2, active: 0, unseen: 1 })).join('\n')
    assert.match(status, /Teammates in this session: 2, 0 running or provisioning, 1 may be running \(not visible from a teammate\)/)
  }

  {
    // `/plugin disable <team bundle>` asks the same question; another bundle does not.
    const { manager } = rig({ bundles: [teamBundle(true), { ...teamBundle(true), name: 'other-bundle' }] })
    const plugin = createPluginManageEntry({ get: (name: string) => (name === 'pluginManager' ? manager : undefined) } as never, { profileName: 'dsh-tui' })
    const pluginSink = { binding: () => 1, busy: () => false, onLines: () => undefined, teamActiveMembers: () => ({ active: 1, unseen: 0 }) }
    const team = plugin(`disable ${TEAM_BUNDLE}`, pluginSink)
    const step = await team!.begin()
    assert.deepEqual(step.kind === 'confirm' ? step.question : undefined, { kind: 'team-active', members: 1, unseen: 0 })
    const other = await plugin('disable other-bundle', pluginSink)!.begin()
    assert.equal(other.kind, 'done', 'only the team bundle asks')
  }
  console.log('PASS /team status (bundle, service, pending, no manager, unknown, hidden hint, CLI route, bundle-absent reason, moved switch, usage) and /plugin disable team-active')
} finally {
  rmSync(dataDir, { recursive: true, force: true })
}
console.log('ALL PASS')
