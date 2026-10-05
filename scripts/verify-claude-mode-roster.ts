/**
 * Claude 权限模式名册回归：/permission 选择器里的「跳过权限」能选中，每一行
 * 都带一句说明（不是把名字再写一遍）。
 *
 * 覆盖：
 *
 *  1. 闸门常开、起始 mode 不变：allowDangerouslySkipPermissions 对应 CLI 的
 *     --allow-dangerously-skip-permissions，只让 bypass 可达（没有它启动的
 *     进程以后进不了 bypassPermissions），不会直接进入 bypass。所以它总是随
 *     query options 下发，permissionMode 仍是解析出的起始 mode。
 *  2. 运行期名册：default → acceptEdits → plan → bypassPermissions →
 *     auto（模型声明 supportsAutoMode 时）→ 当前 mode（不在名册里时）；每行
 *     都有非空 description，且不等于自己的 label。
 *  3. 选择器能切进去：modes.set('bypassPermissions') 直达 CLI，失败由 CLI
 *     返回、由 channel 的 guarded setMode 提示。
 *  4. 循环面更窄：Shift+Tab 走 modes.cycle()：default → acceptEdits → plan →
 *     auto（supportsAutoMode 时）→ 当前 mode；bypassPermissions 只在 list()
 *     （/permission 选择器）里，循环永不进入（误按一次不能关掉全部确认；这个
 *     收窄在能力层声明，不在 UI 里写死）。
 *  5. settings 文件里的 permissions.defaultMode = bypassPermissions 仍降级为
 *     default，并给出指向 /permission 的提示（克隆来的仓库不能静默关掉全部
 *     确认）。
 *  6. 记住的选择：modes.set 写进 backend 作用域的 prefs（permissionMode，
 *     与 model/effort 一样 best-effort）；下一次 resolveStartPermissionMode
 *     的优先级是 env 覆盖 > 记住的选择 > settings 级联 > default，命中记住的
 *     选择时 source='pref'，不走 settings 降级、不发降级提示；非法值读作没有。
 *     记住的 bypassPermissions 不带进新会话：按 settings 级联 / default 启动，
 *     起始提示说明一次（指向 /permission）并清掉这条记录；只有 env 覆盖能直接
 *     以 bypass 启动。
 *
 * Run: node --import tsx/esm scripts/verify-claude-mode-roster.ts
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { modeDescription } from '../src/backends/claude/controls.js'
import { startModeNotices } from '../src/backends/claude/backend.js'
import { buildQueryOptions, resolveStartPermissionMode } from '../src/backends/claude/options.js'
import { fileClaudePrefs, memoryClaudePrefs } from '../src/backends/claude/prefs.js'
import { openClaudeSession } from '../src/backends/claude/session.js'
import { createChannel } from '../src/dsh-adapter/channel.js'
import { i18nDict, setLang, t } from '../src/i18n.js'
import { claudeDeps, fakeClaudeSdk, tick } from './lib/claude-fake-sdk.js'

setLang('en')
let passed = 0
const check = (label: string, ok: boolean, detail?: unknown): void => {
  assert.ok(ok, detail === undefined ? label : label + ': ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)))
  passed += 1
  console.log('PASS ' + label)
}

/** Every backend-native permission mode the SDK vocabulary holds. */
const MODES = ['default', 'acceptEdits', 'plan', 'auto', 'dontAsk', 'bypassPermissions'] as const
/** The ids the roster must explain. */
const DESCRIBED = ['default', 'acceptEdits', 'plan', 'auto', 'dontAsk', 'bypassPermissions'] as const

const models = [
  { value: 'sonnet', resolvedModel: 'claude-sonnet-x', displayName: 'Sonnet', description: '' },
  { value: 'opus', resolvedModel: 'claude-opus-x', displayName: 'Opus', description: '', supportsAutoMode: true },
]
const MODE_CALLS: string[] = []
const controls = {
  setPermissionMode: (mode: string) => { MODE_CALLS.push(mode) },
  supportedModels: () => models,
}
const init = {
  type: 'system', subtype: 'init', session_id: 's', cwd: '/fixture/project', model: 'claude-opus-x', permissionMode: 'default',
  slash_commands: [], terminal_slash_commands: [], apiKeySource: 'none', claude_code_version: '2.1.287', capabilities: [],
}
const fakeSettings = (defaultMode: unknown) => ({
  resolveSettings: () => Promise.resolve({ effective: { permissions: { defaultMode } } }),
  filterEscalatingDefaultMode: (resolved: unknown) => (resolved as { effective: unknown }).effective,
}) as unknown as Parameters<typeof resolveStartPermissionMode>[0]

// ---- 1. the gate rides along, the start mode stays what it was ------------
{
  for (const mode of MODES) {
    const options = buildQueryOptions({
      cwd: '/fixture/project', sessionId: 's', permissionMode: mode, executable: undefined, env: {},
      canUseTool: (() => undefined) as never, stderr: () => undefined, abortController: new AbortController(), replayUserMessages: true,
    })
    check('options: ' + mode + ' keeps its permissionMode', options.permissionMode === mode, options.permissionMode)
    check('options: ' + mode + ' carries the SDK bypass gate', options.allowDangerouslySkipPermissions === true, options.allowDangerouslySkipPermissions)
  }
}

// ---- 2. the resolved start mode is what the query spawns with ------------
{
  const start = await resolveStartPermissionMode(fakeSettings('acceptEdits'), '/p', {})
  check('start mode: settings defaultMode is still the start mode', start.mode === 'acceptEdits' && start.source === 'settings', start)
  const fake = fakeClaudeSdk(() => ({ capabilities: [], models }), controls)
  const session = await openClaudeSession(claudeDeps(fake.sdk, { start }))
  const spawn = fake.queries[0]!.options
  check('start mode: the query spawns with the resolved mode AND the gate', spawn.permissionMode === 'acceptEdits' && spawn.allowDangerouslySkipPermissions === true, { mode: spawn.permissionMode, gate: spawn.allowDangerouslySkipPermissions })
  await session.dispose()
}

// ---- 3. the roster: bypass listed, every row explained -------------------
{
  const fake = fakeClaudeSdk(() => ({ capabilities: ['msg_lifecycle_v1'], models }), controls)
  const session = await openClaudeSession(claudeDeps(fake.sdk, { prefs: memoryClaudePrefs() }))
  await tick()
  fake.queries[0]!.emit(init)
  await tick()
  const roster = session.capabilities.modes!.list()
  check('roster: order is default, acceptEdits, plan, bypassPermissions, auto', roster.map(mode => mode.id).join() === 'default,acceptEdits,plan,bypassPermissions,auto', roster.map(mode => mode.id))
  check('roster: bypassPermissions is offered (the whole point of the gate)', roster.some(mode => mode.id === 'bypassPermissions'))
  for (const row of roster) {
    check('roster: ' + row.id + ' carries a non-empty description', typeof row.description === 'string' && row.description.trim() !== '', row.description)
    check('roster: ' + row.id + ' does not repeat its own name', row.description !== row.label, { label: row.label, description: row.description })
  }
  // The cycle is a NARROWER surface than the roster: bypass stays listed for
  // the explicit /permission pick but is never walked into by Shift+Tab.
  const cycle = session.capabilities.modes.cycle!()
  check('cycle: order is default, acceptEdits, plan, auto (pre-bypass cycle, verbatim)', cycle.map(mode => mode.id).join() === 'default,acceptEdits,plan,auto', cycle.map(mode => mode.id))
  check('cycle: bypassPermissions is unreachable from the cycle', !cycle.some(mode => mode.id === 'bypassPermissions'), cycle.map(mode => mode.id))
  check('cycle: rows are the same ModeOption rows the roster lists', JSON.stringify(cycle) === JSON.stringify(roster.filter(mode => cycle.some(c => c.id === mode.id))), cycle)
  await session.dispose()
}
{
  // A session started in dontAsk (not in the fixed roster) keeps the live
  // mode listed last — the pre-existing retention rule, unchanged.
  const fake = fakeClaudeSdk(() => ({ capabilities: [], models }), controls)
  const session = await openClaudeSession(claudeDeps(fake.sdk, { start: { mode: 'dontAsk', source: 'settings' } }))
  await tick()
  fake.queries[0]!.emit({ ...init, permissionMode: 'dontAsk' })
  await tick()
  const ids = session.capabilities.modes!.list().map(mode => mode.id)
  check('roster: a live mode outside the roster trails it', ids.at(-1) === 'dontAsk', ids)
  const cycleIds = session.capabilities.modes.cycle!().map(mode => mode.id)
  check('cycle: a live mode outside the cycle still trails it (the away-out)', cycleIds.at(-1) === 'dontAsk', cycleIds)
  check('cycle: bypassPermissions stays unreachable even next to a foreign live mode', !cycleIds.includes('bypassPermissions'), cycleIds)
  await session.dispose()
}
{
  // A model without supportsAutoMode: the roster keeps bypass (picker),
  // the cycle is exactly the three pre-bypass modes and nothing else.
  const fake = fakeClaudeSdk(() => ({ capabilities: [], models }), controls)
  const session = await openClaudeSession(claudeDeps(fake.sdk, { prefs: memoryClaudePrefs() }))
  await tick()
  fake.queries[0]!.emit({ ...init, model: 'claude-sonnet-x' })
  await tick()
  const ids = session.capabilities.modes!.list().map(mode => mode.id)
  check('roster: no autoMode row drops auto but keeps bypass', ids.join() === 'default,acceptEdits,plan,bypassPermissions', ids)
  const cycleIds = session.capabilities.modes.cycle!().map(mode => mode.id)
  check('cycle: without autoMode the cycle is default, acceptEdits, plan', cycleIds.join() === 'default,acceptEdits,plan', cycleIds)
  check('cycle: bypassPermissions is not in it', !cycleIds.includes('bypassPermissions'), cycleIds)
  await session.dispose()
}

// ---- 4. modeDescription: the roster's ids are explained, others not ------
{
  setLang('en')
  const en = DESCRIBED.map(id => modeDescription(id))
  check('modeDescription: every roster id is explained (en)', en.every(text => typeof text === 'string' && text.trim() !== ''), en)
  check('modeDescription: no description is the bare id', DESCRIBED.every((id, index) => en[index] !== id))
  setLang('zh')
  const zh = DESCRIBED.map(id => modeDescription(id))
  check('modeDescription: every roster id is explained (zh)', zh.every(text => typeof text === 'string' && text.trim() !== ''), zh)
  check('modeDescription: zh and en are actually different copy', DESCRIBED.every((_id, index) => zh[index] !== en[index]))
  check('modeDescription: an unknown id has no description', modeDescription('nonsense') === undefined && modeDescription('') === undefined)
  setLang('en')
  check('the old refusal key is gone (nothing may claim bypass is unavailable)', !('claude-mode-bypass-refused' in i18nDict))
}

// ---- 5. the picker can really switch into bypass ------------------------
{
  const calls = MODE_CALLS.length
  const fake = fakeClaudeSdk(() => ({ capabilities: ['msg_lifecycle_v1'], models }), controls)
  const session = await openClaudeSession(claudeDeps(fake.sdk, { start: { mode: 'default', source: 'default' }, prefs: memoryClaudePrefs() }))
  await tick()
  const spawn = fake.queries[0]!.options
  check('gate: a default-started session is pre-warmed for bypass', spawn.permissionMode === 'default' && spawn.allowDangerouslySkipPermissions === true, { mode: spawn.permissionMode, gate: spawn.allowDangerouslySkipPermissions })
  const events: string[] = []
  session.subscribe(batch => { for (const event of batch) if (event.type === 'mode.changed') events.push(event.modeId) })
  fake.queries[0]!.emit(init)
  await tick()
  const outcome = await session.capabilities.modes!.set('bypassPermissions').then(() => 'resolved', (error: unknown) => error instanceof Error ? error.message : String(error))
  check('set: bypassPermissions resolves instead of being refused', outcome === 'resolved', outcome)
  check('set: the request reaches the CLI verbatim', MODE_CALLS.length === calls + 1 && MODE_CALLS.at(-1) === 'bypassPermissions', MODE_CALLS.slice(calls))
  check('set: the confirmed mode is reported as mode.changed', events.at(-1) === 'bypassPermissions' && session.capabilities.modes!.current() === 'bypassPermissions', { events, current: session.capabilities.modes!.current() })
  await session.dispose()
}

// ---- 6. the channel roster passes the copy through ----------------------
{
  const fake = fakeClaudeSdk(() => ({ capabilities: ['msg_lifecycle_v1'], models }), controls)
  const session = await openClaudeSession(claudeDeps(fake.sdk, { prefs: memoryClaudePrefs() }))
  await tick()
  fake.queries[0]!.emit(init)
  await tick()
  const ctx = { on: () => () => undefined, get: () => undefined, logger: { warn: () => undefined, info: () => undefined, debug: () => undefined } } as never
  const channel = createChannel(ctx, session, { model: 'Claude Agent', provider: 'claude', cwd: '/fixture/project', activity: false, backendLabel: 'Claude Agent' })
  try {
    const roster = channel.backendModes()!.snapshot()
    check('channel: the picker roster carries bypassPermissions', roster.modes.some(mode => mode.id === 'bypassPermissions'), roster.modes.map(mode => mode.id))
    check('channel: the current mode is pointed at', roster.currentIndex === roster.modes.findIndex(mode => mode.id === 'default'), roster.currentIndex)
    check('channel: name is the label, description is the copy', roster.modes.every(mode => mode.description !== undefined && mode.description !== '' && mode.description !== mode.name), roster.modes)
    check('channel: the rows are the capability rows verbatim', JSON.stringify(roster.modes.map(mode => [mode.id, mode.name, mode.description])) === JSON.stringify(session.capabilities.modes!.list().map(mode => [mode.id, mode.label, mode.description])))
  } finally {
    channel.releaseContributions()
    await session.dispose()
  }
}

// ---- 7. the safety line: settings-level bypass still downgrades, loudly --
{
  const start = await resolveStartPermissionMode(fakeSettings('bypassPermissions'), '/p', {})
  check('safety: settings-level bypass still starts in default', start.mode === 'default' && start.source === 'settings', start)
  check('safety: the downgrade is reported as a downgrade', start.downgradedFrom === 'bypassPermissions', start)
  // backend.ts pushes this sentence as a start notice; the copy must tell the
  // user where the explicit choice lives.
  const notice = t('claude-start-mode-downgraded', { mode: start.downgradedFrom ?? '' })
  check('safety: the notice names the mode and points at /permission', notice.includes('bypassPermissions') && notice.includes('/permission'), notice)
  const fake = fakeClaudeSdk(() => ({ capabilities: [] }), controls)
  const session = await openClaudeSession(claudeDeps(fake.sdk, { start, startNotices: [notice] }))
  const notices: string[] = []
  session.subscribe(batch => { for (const event of batch) if (event.type === 'notice') notices.push(event.text) })
  await tick()
  check('safety: the downgrade notice reaches the user', notices.includes(notice), notices)
  await session.dispose()
}

// ---- 8. the remembered choice: /permission persists across sessions ----
{
  // ① modes.set writes the pick to the backend-scoped prefs store — the same
  //    best-effort persistence model / effort already ride (controls.ts).
  const prefs = memoryClaudePrefs()
  const callsBefore = MODE_CALLS.length
  const fake = fakeClaudeSdk(() => ({ capabilities: ['msg_lifecycle_v1'], models }), controls)
  const session = await openClaudeSession(claudeDeps(fake.sdk, { prefs }))
  await tick()
  fake.queries[0]!.emit(init)
  await tick()
  await session.capabilities.modes!.set('acceptEdits')
  check('pref: modes.set reaches the CLI verbatim', MODE_CALLS.length === callsBefore + 1 && MODE_CALLS.at(-1) === 'acceptEdits', MODE_CALLS.slice(callsBefore))
  check('pref: modes.set persists the pick into the prefs store', prefs.read().permissionMode === 'acceptEdits', prefs.read())
  await session.dispose()

  // ② the next session's start resolution reads that pick back and STARTS in
  //    it — source 'pref', a value no consumer may mistake for 'settings'.
  const remembered = await resolveStartPermissionMode(fakeSettings(undefined), '/p', {}, prefs.read().permissionMode)
  check('pref: the remembered pick is the next start mode', remembered.mode === 'acceptEdits' && remembered.source === 'pref', remembered)
  check('pref: a remembered start is not a downgrade (no notice path)', remembered.downgradedFrom === undefined, remembered)
  const fakeNext = fakeClaudeSdk(() => ({ capabilities: [], models }), controls)
  const sessionNext = await openClaudeSession(claudeDeps(fakeNext.sdk, { start: remembered }))
  const spawnNext = fakeNext.queries[0]!.options
  check('pref: the next session spawns in the remembered mode AND the gate', spawnNext.permissionMode === 'acceptEdits' && spawnNext.allowDangerouslySkipPermissions === true, { mode: spawnNext.permissionMode, gate: spawnNext.allowDangerouslySkipPermissions })
  await sessionNext.dispose()

  // ③ the pick outranks the settings cascade — including a settings-level
  //    bypass, which alone would downgrade to default (section 7).
  const beats = await resolveStartPermissionMode(fakeSettings('bypassPermissions'), '/p', {}, prefs.read().permissionMode)
  check('pref: the remembered pick outranks settings (even a settings bypass)', beats.mode === 'acceptEdits' && beats.source === 'pref' && beats.downgradedFrom === undefined, beats)

  // ④ the env override still outranks everything (the developer override).
  const envWins = await resolveStartPermissionMode(fakeSettings('plan'), '/p', { DSH_TUI_CLAUDE_PERMISSION_MODE: 'dontAsk' }, prefs.read().permissionMode)
  check('pref: the env override still outranks the remembered pick', envWins.mode === 'dontAsk' && envWins.source === 'env', envWins)

  // ⑤ an illegal persisted value reads as no choice at all: prefs.ts narrows
  //    the file to the six SDK modes, and the resolver defends the same line.
  const illegal = await resolveStartPermissionMode(fakeSettings('acceptEdits'), '/p', {}, 'yolo')
  check('pref: an illegal pick is ignored (falls back to settings)', illegal.mode === 'acceptEdits' && illegal.source === 'settings', illegal)
  const scratch = mkdtempSync(join(tmpdir(), 'dsh-tui-mode-pref-'))
  try {
    writeFileSync(join(scratch, 'prefs.json'), JSON.stringify({ permissionMode: 'nonsense', model: 'claude-opus-x' }))
    const narrowed = fileClaudePrefs(scratch).read()
    check('pref: prefs.json reads an illegal mode as absent (other fields kept)', narrowed.permissionMode === undefined && narrowed.model === 'claude-opus-x', narrowed)
    writeFileSync(join(scratch, 'prefs.json'), JSON.stringify({ permissionMode: 'dontAsk' }))
    check('pref: prefs.json keeps a legal mode on read', fileClaudePrefs(scratch).read().permissionMode === 'dontAsk', fileClaudePrefs(scratch).read())
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }

  // ⑥ a remembered bypass is NOT carried into a new session: the start
  //    resolves as if nothing were remembered (settings, then default), the
  //    start notices say so once and forget the pick. Only the env override
  //    starts in bypass.
  const bypassPrefs = memoryClaudePrefs({ permissionMode: 'bypassPermissions', model: 'claude-opus-x' })
  const start = await resolveStartPermissionMode(fakeSettings('default'), '/p', {}, bypassPrefs.read().permissionMode)
  check('pref: a remembered bypass does not start in bypassPermissions', start.mode === 'default' && start.source === 'settings' && start.bypassNotCarried === true, start)
  const bare = await resolveStartPermissionMode(fakeSettings(undefined), '/p', {}, 'bypassPermissions')
  check('pref: … with nothing configured it starts in default', bare.mode === 'default' && bare.source === 'default' && bare.bypassNotCarried === true, bare)
  const cascade = await resolveStartPermissionMode(fakeSettings('acceptEdits'), '/p', {}, 'bypassPermissions')
  check('pref: … the settings cascade still applies', cascade.mode === 'acceptEdits' && cascade.source === 'settings' && cascade.bypassNotCarried === true, cascade)
  const envBypass = await resolveStartPermissionMode(fakeSettings('default'), '/p', { DSH_TUI_CLAUDE_PERMISSION_MODE: 'bypassPermissions' }, 'bypassPermissions')
  check('pref: the env override still starts in bypassPermissions', envBypass.mode === 'bypassPermissions' && envBypass.source === 'env' && envBypass.bypassNotCarried === undefined, envBypass)
  setLang('zh')
  const zhNotice = t('claude-start-mode-bypass-not-carried')
  setLang('en')
  const notice = t('claude-start-mode-bypass-not-carried')
  check('pref: the not-carried notice is real copy in both languages, both naming /permission', zhNotice.includes('/permission') && notice.includes('/permission') && zhNotice !== notice && zhNotice !== 'claude-start-mode-bypass-not-carried', { zhNotice, notice })
  const startNotices = startModeNotices(start, bypassPrefs)
  check('pref: the start notices say the bypass was not carried', startNotices.includes(notice), startNotices)
  check('pref: … and the remembered bypass is forgotten (other prefs kept)', bypassPrefs.read().permissionMode === undefined && bypassPrefs.read().model === 'claude-opus-x', bypassPrefs.read())
  const after = await resolveStartPermissionMode(fakeSettings('default'), '/p', {}, bypassPrefs.read().permissionMode)
  check('pref: the next start is quiet', after.bypassNotCarried === undefined && !startModeNotices(after, bypassPrefs).includes(notice), after)
  const fakeBypass = fakeClaudeSdk(() => ({ capabilities: [] }), controls)
  const sessionBypass = await openClaudeSession(claudeDeps(fakeBypass.sdk, { start, startNotices }))
  const spawnBypass = fakeBypass.queries[0]!.options
  check('pref: the new session spawns in default, the gate still on for /permission', spawnBypass.permissionMode === 'default' && spawnBypass.allowDangerouslySkipPermissions === true, { mode: spawnBypass.permissionMode, gate: spawnBypass.allowDangerouslySkipPermissions })
  const notices: string[] = []
  sessionBypass.subscribe(batch => { for (const event of batch) if (event.type === 'notice') notices.push(event.text) })
  await tick()
  check('pref: the not-carried notice reaches the transcript', notices.includes(notice), notices)
  await sessionBypass.dispose()
}


// ---- 7. model labels tell the channel truth (modelEnv) ---------------------
{
  const { envSlotsServeModel, readModelEnvTruth } = await import('../src/backends/claude/modelEnv.js')
  // The session's explicit-model omission predicate: an env slot already
  // routing to the model (base id, [1M] suffixes and case ignored) serves
  // it; anything else does not.
  check('modelEnv: env slots serve the model they route to (base-normalized)', envSlotsServeModel({ ANTHROPIC_DEFAULT_SONNET_MODEL: 'glm-5.3' }, 'GLM-5.3[1m]') === true)
  check('modelEnv: ANTHROPIC_MODEL and every tier slot counts', envSlotsServeModel({ ANTHROPIC_MODEL: 'glm-5.3' }, 'glm-5.3') === true && envSlotsServeModel({ ANTHROPIC_DEFAULT_HAIKU_MODEL: 'glm-5.3' }, 'glm-5.3') === true && envSlotsServeModel({ ANTHROPIC_DEFAULT_OPUS_MODEL: 'glm-5.3' }, 'glm-5.3') === true && envSlotsServeModel({ ANTHROPIC_DEFAULT_FABLE_MODEL: 'glm-5.3' }, 'glm-5.3') === true)
  check('modelEnv: a slot routing elsewhere does not serve the model', envSlotsServeModel({ ANTHROPIC_MODEL: 'glm-4.7' }, 'glm-5.3[1M]') === false)
  check('modelEnv: no slots set serves nothing', envSlotsServeModel({}, 'glm-5.3') === false)
  check('modelEnv: an empty-string slot counts as unset', envSlotsServeModel({ ANTHROPIC_MODEL: '  ' }, 'glm-5.3') === false)
  const truth = readModelEnvTruth({
    ANTHROPIC_MODEL: 'glm-5.3[1M]',
    ANTHROPIC_DEFAULT_OPUS_MODEL: 'glm-5.3[1M]',
    ANTHROPIC_DEFAULT_SONNET_MODEL: 'glm-5.3[1M]',
    ANTHROPIC_DEFAULT_HAIKU_MODEL: 'glm-5.3-flash',
  })
  check('modelEnv: opus tier (any [1m] casing) maps to the configured actual', truth.actualFor('claude-opus-5-5[1m]') === 'glm-5.3[1M]')
  check('modelEnv: haiku tier maps to its own actual', truth.actualFor('claude-haiku-x') === 'glm-5.3-flash')
  check('modelEnv: a non-tier custom value maps to ANTHROPIC_MODEL', truth.actualFor('Claude Agent') === 'glm-5.3[1M]')
  const honest = readModelEnvTruth({ ANTHROPIC_DEFAULT_OPUS_MODEL: 'claude-opus-x' })
  check('modelEnv: a mapping equal to the request changes nothing', honest.actualFor('claude-opus-x') === undefined)
  check('modelEnv: an alias still resolves to its tier actual', honest.actualFor('opus') === 'claude-opus-x')
  check('modelEnv: no env = no truth', readModelEnvTruth({}).actualFor('claude-opus-5-5[1m]') === undefined)
  const localTruth = readModelEnvTruth({}, { 'claude-opus-5-5[1m]': 'GLM 5.3 (1M)' })
  check('modelEnv: a local model-names entry wins without any env', localTruth.actualFor('claude-opus-5-5[1m]') === 'GLM 5.3 (1M)')
  check('modelEnv: local entries match base-normalized ids too', localTruth.actualFor('claude-opus-5-5[1M]') === 'GLM 5.3 (1M)')
  const envTruth = readModelEnvTruth({ ANTHROPIC_DEFAULT_OPUS_MODEL: 'glm-5.3[1M]' }, { 'claude-opus-5-5[1m]': 'GLM 5.3 (1M)' })
  check('modelEnv: the local map outranks the env tiers', envTruth.actualFor('claude-opus-5-5[1m]') === 'GLM 5.3 (1M)')
  // 渠道档案（channels.json，/channel 二期）：active channel 的映射是用户自己的
  // 数据，整体压过旧 model-names.json 与 env 档位——精确 models 最高、tiers 次之。
  const channelExact = readModelEnvTruth({ ANTHROPIC_DEFAULT_OPUS_MODEL: 'glm-5.3[1M]' }, { 'claude-opus-5-5[1m]': 'GLM 5.3 (1M)' }, { models: { 'claude-opus-5-5[1m]': 'channel-exact' }, tiers: { opus: 'channel-tier' } })
  check('modelEnv: the active channel\'s exact map outranks the local file and the env', channelExact.actualFor('claude-opus-5-5[1m]') === 'channel-exact')
  check('modelEnv: the active channel\'s tier rules outrank the local file too', readModelEnvTruth({}, { 'claude-opus-5-5[1m]': 'GLM 5.3 (1M)' }, { tiers: { opus: 'channel-tier' } }).actualFor('claude-opus-5-5[1m]') === 'channel-tier')
  check('modelEnv: with channels.json present but nothing active the old priority stands', readModelEnvTruth({}, { 'claude-opus-5-5[1m]': 'GLM 5.3 (1M)' }).actualFor('claude-opus-5-5[1m]') === 'GLM 5.3 (1M)')

  // Session level: the list relabels from the settings env the CLI applies.
  const relayModels = [
    { value: 'claude-opus-5-5[1m]', displayName: 'Opus 5.5 (1M)', description: 'codelife: claude-opus-5-5[1m]' },
    { value: 'haiku', resolvedModel: 'claude-haiku-x', displayName: 'Haiku', description: '' },
  ]
  const relayControls = { ...controls, supportedModels: () => relayModels }
  const withEnvDir = mkdtempSync(join(tmpdir(), 'dshtui-modelenv-'))
  writeFileSync(join(withEnvDir, 'settings.json'), JSON.stringify({ env: {
    ANTHROPIC_MODEL: 'glm-5.3[1M]',
    ANTHROPIC_DEFAULT_OPUS_MODEL: 'glm-5.3[1M]',
    ANTHROPIC_DEFAULT_SONNET_MODEL: 'glm-5.3[1M]',
    ANTHROPIC_DEFAULT_HAIKU_MODEL: 'glm-5.3-flash',
  } }))
  const emptyDir = mkdtempSync(join(tmpdir(), 'dshtui-modelenv-empty-'))
  const previousConfigDir = process.env.CLAUDE_CONFIG_DIR
  try {
    process.env.CLAUDE_CONFIG_DIR = withEnvDir
    const fake = fakeClaudeSdk(() => ({ capabilities: [], models: relayModels }), relayControls)
    const session = await openClaudeSession(claudeDeps(fake.sdk, { prefs: memoryClaudePrefs() }))
    await tick()
    fake.queries[0]!.emit({ ...init, models: relayModels })
    await tick()
    const rows = await session.capabilities.models!.list()
    check('model list: relay opus row shows the actual model as the label', rows[0]?.label === 'glm-5.3[1M]', rows[0])
    check('model display: the capability resolves the live id to the actual', session.capabilities.models?.display?.() === 'glm-5.3[1M]', session.capabilities.models?.display?.())
    check('model list: the cosmetic name survives in the description', rows[0]?.description?.includes('Opus 5.5 (1M)') === true, rows[0]?.description)
    check('model list: haiku alias row resolves through its tier env', rows[1]?.label === 'glm-5.3-flash', rows[1])
    check('model list: ids stay the CLI row values (selection unchanged)', rows[0]?.id === 'claude-opus-5-5[1m]' && rows[1]?.id === 'haiku', rows)
    await session.dispose()
    // 接线 tripwire：展示面必须消费 display——Chat 的四个 model prop 与
    // StatusLine 的页脚/详情两处（行为级由 capability 断言覆盖，此处防
    // 未来重构悄悄拆线）。
    const { readFileSync: readSrc } = await import('node:fs')
    const readRepo = (rel: string): string => readSrc(new URL(rel, import.meta.url), 'utf8')
    const chatSrc = readRepo('../src/screens/Chat.tsx')
    const lineSrc = readRepo('../src/screens/StatusLine.tsx')
    check('model display: every Chat model prop prefers the display name', !chatSrc.includes('model={channel.model}') && (chatSrc.match(/model=\{channel\.modelDisplay \?\? channel\.model\}/g) ?? []).length === 4)
    check('model display: the footer and the detail line prefer the display name', (lineSrc.match(/channel\.modelDisplay \?\? channel\.model/g) ?? []).length === 2)
  } finally {
    process.env.CLAUDE_CONFIG_DIR = previousConfigDir
    try { rmSync(withEnvDir, { recursive: true, force: true }) } catch { /* best effort */ }
  }
  {
    // Without a channel env the labels are the CLI names verbatim — pinned
    // to an EMPTY config dir so the real ~/.claude settings on this machine
    // cannot leak into the assertion.
    process.env.CLAUDE_CONFIG_DIR = emptyDir
    try {
      const fake = fakeClaudeSdk(() => ({ capabilities: [], models }), controls)
      const session = await openClaudeSession(claudeDeps(fake.sdk, { prefs: memoryClaudePrefs() }))
      await tick()
      fake.queries[0]!.emit(init)
      await tick()
      const rows = await session.capabilities.models!.list()
      check('model list: without a channel env the labels stay the CLI displayName', rows.every(row => row.label === 'Sonnet' || row.label === 'Opus'), rows)
      await session.dispose()
    } finally {
      process.env.CLAUDE_CONFIG_DIR = previousConfigDir
      try { rmSync(emptyDir, { recursive: true, force: true }) } catch { /* best effort */ }
    }
  }
}

console.log('\nverify-claude-mode-roster OK (' + passed + ' checks)')
process.exit(0)
