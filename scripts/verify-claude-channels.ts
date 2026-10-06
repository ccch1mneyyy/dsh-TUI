/**
 * 渠道档案（channel profiles）回归：/channel 的存储、模型映射优先级、
 * settings 导入、命令门控、切换后的显示刷新，以及渠道连接与凭据隔离。
 *
 * 覆盖：
 *
 *  1. 存储 best-effort（channels.ts 沿用 prefs.ts 的 IO 模型）：缺文件/
 *     坏文件读作空、写失败只进 debug 日志、提交走「同目录临时文件 +
 *     renameSync 原子替换」、窄化丢掉畸形条目（重复 id 取首个、悬空 active 丢弃）。
 *  2. 模型映射优先级（modelEnv.ts 的 readModelEnvTruth，纯函数 + 会话接线
 *     两层）：active channel 的 models（精确 → base 归一）> active channel
 *     的 tiers（档位关键字 + 保留 default）> 旧 model-names.json > settings
 *     env 档位推断 > 原始 id。没有激活渠道或文件缺失时，行为与没有渠道时一致。
 *  3. 导入形状：ANTHROPIC_BASE_URL 的 host 作渠道名，
 *     ANTHROPIC_DEFAULT_{HAIKU,OPUS,SONNET,FABLE}_MODEL + ANTHROPIC_MODEL 归入
 *     tiers（default 键），不猜精确 models，重复导入刷新同 id 渠道（保留
 *     手写的 models）。
 *  4. 命令门控（/channel）：BACKEND_CHANNEL_COMMAND 随 channels 能力出现
 *     （claude 可见），DSH 快照永不列出（该 flag 刻意不走 dsh 短路）。
 *  5. 切换即刷新：backendChannels().activate 在同一次调用里写存储，并经
 *     session-controls 的 refreshModelDisplay 钩子重算 modelDisplay，页脚
 *     立即换名，不等下一次 model.changed。
 *  6. 渠道连接：channels.json 增加 baseUrl/tokenRef/env。token 只存进
 *     ~/.dsh/.credentials.yaml 凭据库，channels.json 里不出现明文（有专门
 *     断言）。激活渠道的连接在 spawn 时注入（authPlan.env + SDK settings
 *     选项的 flag 层，因为 CLI 2.1.287 的 settings env 会覆盖进程 env）；
 *     导入时一并吸收 baseUrl/token；同连接切换就地刷新，异连接走新会话
 *     重启（宿主指纹比较）；问答式向导（src/channel/channel-wizard.ts，
 *     headless 驱动）走宿主 save/remove/peekImport 三个动作。
 *  7. 凭据隔离：带连接的渠道在 flag 层显式写出三个凭据键：API_KEY=''、
 *     OAUTH=''、AUTH_TOKEN=渠道 token 或 ''（空串用来覆盖 user settings 里
 *     cc-switch 写入的旧值），并清空路由变量，child env 同步清理冲突拼写；
 *     自定义 endpoint 缺凭据时拒绝启动（含 apiKeyHelper 冲突）；mismatch
 *     notice 列出被替换凭据的键名（不报值）。出站行为用隔离的环回监听验证：
 *     真实的 resolveClaudeAuth + 已装 CLI + 127.0.0.1 动态端口 listener，
 *     六格矩阵（tokenless/token × 三种旧凭据键）断言出站请求不含旧
 *     sentinel。没有 CLI 时显式 SKIP，不算通过。
 *
 * Run: node --import tsx/esm scripts/verify-claude-channels.ts
 */
import assert from 'node:assert/strict'
import { execFile, spawn as spawnProcess } from 'node:child_process'
import http from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { channelCapabilities } from '../src/channel/capabilities.js'
import { channelSlug, fileClaudeChannels, importFromSettingsEnv, importTokenFromSettingsEnv, memoryClaudeChannels } from '../src/backends/claude/channels.js'
import { channelProfileSlug } from '../src/channel/channel-slug.js'
import { channelTokenRef, fileClaudeChannelTokens, memoryClaudeChannelTokens } from '../src/backends/shared/channel-tokens.js'
import { ClaudeChannelConflictError, channelMissingCredential, resolveClaudeAuth } from '../src/backends/claude/auth.js'
import { writeFlagSettingsFile } from '../src/backends/claude/flag-settings.js'
import { channelStartNotices } from '../src/backends/claude/backend.js'
import { loadClaudeSdk } from '../src/backends/claude/sdk.js'
import { runChannelWizard } from '../src/channel/channel-wizard.js'
import { createClaudeControls } from '../src/backends/claude/controls.js'
import { memoryClaudePrefs } from '../src/backends/claude/prefs.js'
import type { SessionCapabilities } from '../src/agent/capabilities.js'
import type { AgentSession } from '../src/agent/session.js'
import type { BackendChannelOption } from '../src/adapter/ports/channel-view.js'
import { importedModelEnv, mergedModelEnv, readModelEnvTruth } from '../src/backends/claude/modelEnv.js'
import { openClaudeSession } from '../src/backends/claude/session.js'
import { BACKEND_CHANNEL_COMMAND, LOCAL_COMMANDS } from '../src/commands.js'
import { createChannel } from '../src/dsh-adapter/channel.js'
import { localCommandsFor } from '../src/dsh-adapter/channel/core/session-controls.js'
import { setLang, t } from '../src/i18n.js'
import { claudeDeps, fakeClaudeSdk, tick } from './lib/claude-fake-sdk.js'

setLang('en')
let passed = 0
const check = (label: string, ok: boolean, detail?: unknown): void => {
  assert.ok(ok, detail === undefined ? label : label + ': ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)))
  passed += 1
  console.log('PASS ' + label)
}

const models = [
  { value: 'claude-opus-zq9x[1m]', resolvedModel: 'claude-opus-zq9x', displayName: 'Opus fixture', description: '' },
]
const controls = { supportedModels: () => models }
const init = {
  type: 'system', subtype: 'init', session_id: 's', cwd: '/fixture/project', model: 'claude-opus-zq9x[1m]', permissionMode: 'default',
  slash_commands: [], terminal_slash_commands: [], apiKeySource: 'none', claude_code_version: '2.1.287', capabilities: [],
}

// ---- 1. storage: best-effort IO, narrowing, atomic commits -----------------
{
  const mem = memoryClaudeChannels({ active: 'a', channels: [
    { id: 'a', name: 'A', models: { x: 'y' }, tiers: { opus: 'o' } },
    { id: 'b', name: 'B' },
  ] })
  check('store: memory read narrows the initial document', mem.read().channels.length === 2 && mem.read().active === 'a', mem.read())
  mem.setActive('b')
  check('store: setActive moves the active channel', mem.read().active === 'b', mem.read())
  mem.setActive('nope')
  check('store: setActive of an unknown id is a no-op', mem.read().active === 'b', mem.read())
  mem.save({ id: 'a', name: 'A2', tiers: { haiku: 'h' } })
  check('store: save upserts by id (refresh in place, roster order kept)', mem.read().channels.length === 2 && mem.read().channels[0]?.name === 'A2' && mem.read().channels[0]?.tiers?.haiku === 'h' && mem.read().channels[0]?.models === undefined, mem.read())
  mem.save({ id: 'c', name: 'C' })
  check('store: save of a new id appends', mem.read().channels.length === 3 && mem.read().channels[2]?.id === 'c', mem.read().channels.map(c => c.id))

  const dir = mkdtempSync(join(tmpdir(), 'dshtui-channels-'))
  try {
    const store = fileClaudeChannels(dir)
    check('store: a missing file reads as no channels', store.read().channels.length === 0 && store.read().active === undefined, store.read())
    store.save({ id: 'zhipu', name: 'ZhiPu', models: { 'claude-opus-zq9x[1m]': 'glm-fix-5.3' }, tiers: { opus: 'glm-fix-5.3', default: 'glm-fix-5.3' } })
    store.setActive('zhipu')
    const reread = fileClaudeChannels(dir).read()
    check('store: save + setActive round-trip through the file', reread.active === 'zhipu' && reread.channels[0]?.models?.['claude-opus-zq9x[1m]'] === 'glm-fix-5.3' && reread.channels[0]?.tiers?.opus === 'glm-fix-5.3' && reread.channels[0]?.tiers?.default === 'glm-fix-5.3', reread)
    check('store: the atomic commit leaves no temporary behind', readdirSync(dir).every(name => !name.includes('.tmp')), readdirSync(dir))
    check('store: the document ends with a newline', readFileSync(join(dir, 'channels.json'), 'utf8').endsWith('\n'))
    writeFileSync(join(dir, 'channels.json'), '{ not json')
    check('store: a corrupt file reads as no channels (never throws)', fileClaudeChannels(dir).read().channels.length === 0)
    // A hand edit gone wrong must not be lost to the next save: the damaged
    // document moves aside, byte for byte, and the save still lands.
    const damaged = '{ "channels": [ { "id": "kept", "name": "Kept", "models": { "a": "b" } }, ] }'
    writeFileSync(join(dir, 'channels.json'), damaged)
    fileClaudeChannels(dir).save({ id: 'fresh', name: 'Fresh' })
    const aside = readdirSync(dir).filter(name => name.startsWith('channels.json.damaged-'))
    check('store: saving over a corrupt file keeps the damaged document aside',
      aside.length === 1 && readFileSync(join(dir, aside[0]!), 'utf8') === damaged, readdirSync(dir))
    check('… and the save itself lands', fileClaudeChannels(dir).read().channels.map(channel => channel.id).join() === 'fresh')
    for (const name of aside) rmSync(join(dir, name))
    writeFileSync(join(dir, 'channels.json'), JSON.stringify({
      active: 'ghost',
      channels: ['nope', 42, { id: 'x', name: 'X', models: { a: 1, '': 'y', ok: ' v ' }, tiers: null }, { id: 'x', name: 'dup' }, { id: '  ', name: 'blank id' }],
    }))
    const narrowed = fileClaudeChannels(dir).read()
    check('store: narrowing drops junk, keeps the first of duplicate ids, drops a dangling active',
      narrowed.channels.length === 1 && narrowed.channels[0]?.id === 'x' && narrowed.channels[0]?.models?.ok === 'v' && narrowed.channels[0]?.models?.a === undefined && narrowed.active === undefined, narrowed)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
  const blocker = join(tmpdir(), 'dshtui-channels-block-' + Date.now() + '-' + Math.floor(Math.random() * 1e6))
  writeFileSync(blocker, 'x')
  try {
    const debugs: string[] = []
    const broken = fileClaudeChannels(join(blocker, 'sub'), message => debugs.push(message))
    let threw = false
    try { broken.save({ id: 'a', name: 'A' }) } catch { threw = true }
    check('store: a failed write never throws', threw === false)
    check('store: a failed write reports to the debug log only', debugs.length > 0 && debugs[0]!.includes('channels write failed'), debugs)
  } finally {
    rmSync(blocker, { force: true })
  }
}

// ---- 2. slug + the settings import ----------------------------------------
{
  check('slug: lowercases and collapses non-alphanumerics', channelSlug('Open.BigModel~CN') === 'open-bigmodel-cn', channelSlug('Open.BigModel~CN'))
  check('slug: a name without ASCII alphanumerics gets a stable hashed id', /^channel-[0-9a-f]{8}$/u.test(channelSlug('智谱')) && channelSlug('智谱') === channelSlug(' 智谱 '), channelSlug('智谱'))
  check('slug: two such names get different ids (and token refs)', channelSlug('智谱') !== channelSlug('硅基流动') && channelTokenRef(channelSlug('智谱')) !== channelTokenRef(channelSlug('硅基流动')), [channelSlug('智谱'), channelSlug('硅基流动')])
  check('slug: the wizard and the backend share one rule', channelSlug === channelProfileSlug)
  const env = {
    ANTHROPIC_BASE_URL: 'https://open.bigmodel.cn/api/anthropic',
    ANTHROPIC_CUSTOM_MODEL_OPTION_NAME: 'GLM',
    ANTHROPIC_DEFAULT_OPUS_MODEL: 'glm-5.3[1M]',
    ANTHROPIC_DEFAULT_HAIKU_MODEL: 'glm-5.3-flash',
    ANTHROPIC_MODEL: 'glm-5.3[1M]',
  }
  const imported = importFromSettingsEnv(env)
  check('import: the base-url host names the channel', imported?.id === 'open-bigmodel-cn' && imported?.name === 'open.bigmodel.cn', imported)
  check('import: tier envs become tiers and ANTHROPIC_MODEL becomes the default rule',
    imported?.tiers?.opus === 'glm-5.3[1M]' && imported?.tiers?.haiku === 'glm-5.3-flash' && imported?.tiers?.default === 'glm-5.3[1M]' && imported?.tiers?.sonnet === undefined && imported?.tiers?.fable === undefined, imported?.tiers)
  check('import: exact models are never guessed', imported?.models === undefined, imported?.models)
  check('import: nothing importable answers undefined', importFromSettingsEnv({}) === undefined && importFromSettingsEnv({ ANTHROPIC_CUSTOM_MODEL_OPTION_NAME: 'GLM' }) === undefined)
  const named = importFromSettingsEnv({ ANTHROPIC_MODEL: 'm1', ANTHROPIC_CUSTOM_MODEL_OPTION_NAME: 'GLM' })
  check('import: without a base url the custom option name names the channel', named?.id === 'glm' && named?.tiers?.default === 'm1', named)
  const bare = importFromSettingsEnv({ ANTHROPIC_BASE_URL: 'not a url', ANTHROPIC_MODEL: 'm2' })
  check('import: an unparseable base url falls back to the settings name', bare?.id === 'settings' && bare?.tiers?.default === 'm2', bare)
  const refreshed = importFromSettingsEnv(env, { id: 'open-bigmodel-cn', name: 'old', models: { keep: 'me' }, tiers: { stale: 'x' } })
  check('import: a re-import refreshes tiers but keeps hand-written models', refreshed?.models?.keep === 'me' && refreshed?.tiers?.opus === 'glm-5.3[1M]' && refreshed?.tiers?.stale === undefined, refreshed)
}

// ---- 3. the model-mapping priority chain (pure) ----------------------------
{
  const env = { ANTHROPIC_DEFAULT_OPUS_MODEL: 'env-opus', ANTHROPIC_MODEL: 'env-any' }
  const local = { 'claude-opus-zq9x[1m]': 'local-opus' }
  check('priority: channel.models exact wins over tiers, file and env',
    readModelEnvTruth(env, local, { models: { 'claude-opus-zq9x[1m]': 'exact-wins' }, tiers: { opus: 'tier-opus' } }).actualFor('claude-opus-zq9x[1m]') === 'exact-wins')
  check('priority: channel.models matches base-normalized ids',
    readModelEnvTruth(env, local, { models: { 'Claude-Opus-ZQ9X[1M]': 'base-wins' } }).actualFor('claude-opus-zq9x[1m]') === 'base-wins')
  check('priority: channel.tiers outrank the legacy file and the env',
    readModelEnvTruth(env, local, { tiers: { opus: 'tier-opus' } }).actualFor('claude-opus-zq9x[1m]') === 'tier-opus')
  check('priority: without a channel the legacy file still wins the env',
    readModelEnvTruth(env, local).actualFor('claude-opus-zq9x[1m]') === 'local-opus')
  check('priority: env tiers stand when neither channel nor file maps',
    readModelEnvTruth(env).actualFor('claude-opus-zq9x') === 'env-opus')
  check('priority: with no mapping at all the id stands as-is',
    readModelEnvTruth({}).actualFor('claude-opus-zq9x[1m]') === undefined)
  check('priority: the reserved default tier is the any-model rule',
    readModelEnvTruth(env, {}, { tiers: { default: 'tier-any' } }).actualFor('claude-sonnet-zq9x') === 'tier-any')
  check('priority: a tier mapping to the requested model itself changes nothing (and stops, like the env rule)',
    readModelEnvTruth(env, {}, { tiers: { opus: 'claude-opus-zq9x' } }).actualFor('claude-opus-zq9x') === undefined)
  check('priority: the default rule never swallows the literal id "default"',
    readModelEnvTruth(env, {}, { tiers: { default: 'anything' } }).actualFor('default') === undefined)
}

// ---- 4. session wiring: the mapping reads the store live -------------------
{
  const store = memoryClaudeChannels({ active: 'zhipu', channels: [
    { id: 'zhipu', name: 'ZhiPu', models: { 'claude-opus-zq9x[1m]': 'glm-fix-5.3' }, tiers: { haiku: 'glm-fix-flash' } },
    { id: 'tiers-only', name: 'Tiers Only', tiers: { opus: 'tier-only-opus' } },
  ] })
  const envDir = mkdtempSync(join(tmpdir(), 'dshtui-channels-env-'))
  writeFileSync(join(envDir, 'settings.json'), JSON.stringify({ env: { ANTHROPIC_MODEL: 'env-any-model' } }))
  const previous = process.env.CLAUDE_CONFIG_DIR
  try {
    process.env.CLAUDE_CONFIG_DIR = envDir
    const fake = fakeClaudeSdk(() => ({ capabilities: [], models }), controls)
    const session = await openClaudeSession(claudeDeps(fake.sdk, { channels: store }))
    await tick()
    fake.queries[0]!.emit(init)
    await tick()
    check('session: display resolves through the active channel exact models', session.capabilities.models?.display?.() === 'glm-fix-5.3', session.capabilities.models?.display?.())
    store.setActive('tiers-only')
    check('session: a store switch changes the truth on the next read (lazy truth)', session.capabilities.models?.display?.() === 'tier-only-opus', session.capabilities.models?.display?.())
    const list = session.capabilities.channels?.list()
    check('session: the channels capability lists the file rows in order', list?.length === 2 && list[0]?.models[0]?.from === 'claude-opus-zq9x[1m]' && list[0]?.models[0]?.to === 'glm-fix-5.3', list)
    check('session: activeId answers the live active channel', session.capabilities.channels?.activeId() === 'tiers-only', session.capabilities.channels?.activeId())
    const imported = session.capabilities.channels?.importFromSettings()
    check('session: importFromSettings reads the CLI settings env (hostless env → the settings name)', imported?.id === 'settings' && imported?.tiers.some(rule => rule.tier === 'default' && rule.to === 'env-any-model'), imported)
    check('session: the import landed in the store behind the capability', store.read().channels.some(channel => channel.id === 'settings'), store.read().channels.map(channel => channel.id))
    await session.dispose()
    // No active channel: the chain behaves as it does without channels. The
    // fixture id deliberately carries no tier keyword, so the ANTHROPIC_MODEL
    // fallback answers (a tier-keyword id stops at the unset tier env and
    // answers undefined).
    const plainModel = [{ value: 'claude-fixture-zq9x[1m]', resolvedModel: 'claude-fixture-zq9x', displayName: 'Fixture', description: '' }]
    const inactive = memoryClaudeChannels({ channels: [{ id: 'zhipu', name: 'ZhiPu', models: { 'claude-fixture-zq9x[1m]': 'glm-fix-5.3' } }] })
    const fake2 = fakeClaudeSdk(() => ({ capabilities: [], models: plainModel }), { supportedModels: () => plainModel })
    const session2 = await openClaudeSession(claudeDeps(fake2.sdk, { channels: inactive }))
    await tick()
    fake2.queries[0]!.emit({ ...init, model: 'claude-fixture-zq9x[1m]' })
    await tick()
    check('session: without an active channel the env fallback stands (byte-identical to phase 1)', session2.capabilities.models?.display?.() === 'env-any-model', session2.capabilities.models?.display?.())
    await session2.dispose()
  } finally {
    process.env.CLAUDE_CONFIG_DIR = previous
    rmSync(envDir, { recursive: true, force: true })
  }
}

// ---- 5. /channel gating ------------------------------------------------------
{
  const channelsCap = { list: () => [], activeId: () => undefined, setActive: () => undefined, importFromSettings: () => undefined, save: (input: { id: string; name: string }) => ({ ...input, models: [], tiers: [] }), remove: () => false, peekSettingsImport: () => undefined }
  const claudeSnapshot = channelCapabilities({ backendId: 'claude', backendLabel: 'Claude', capabilities: { native: {}, channels: channelsCap } as never, dsh: false })
  check('gate: a channels-capable backend lists /channel and flags channels', claudeSnapshot.commands.includes('channel') && claudeSnapshot.channels === true, claudeSnapshot.commands)
  check('gate: a backend without the capability never lists /channel', !channelCapabilities({ backendId: 'claude', backendLabel: 'Claude', capabilities: { native: {} } as never, dsh: false }).commands.includes('channel'))
  const dshSnapshot = channelCapabilities({ backendId: 'dsh', backendLabel: 'DeepSeek Harness', capabilities: { native: {} } as never, dsh: true })
  check('gate: a DSH session never lists /channel (the flag takes no dsh shortcut)', !dshSnapshot.commands.includes('channel') && dshSnapshot.channels === false, dshSnapshot.commands)
  check('gate: even a channels-capable dsh-shaped snapshot stays without /channel',
    !channelCapabilities({ backendId: 'dsh', backendLabel: 'dsh', capabilities: { native: {}, channels: channelsCap } as never, dsh: true }).commands.includes('channel'))
  check('gate: /channel is not a LOCAL_COMMANDS entry (the BACKEND_ ride-along, like /permission)', !LOCAL_COMMANDS.some(command => command.name === 'channel'))
  check('gate: localCommandsFor rides the command when the snapshot appends the name',
    localCommandsFor(['new', 'channel']).some(command => command.name === 'channel' && command.descriptionKey === 'cmd-desc-channel' && command === BACKEND_CHANNEL_COMMAND))
  check('gate: the every-builtin identity branch stays untouched (no channel appended)', localCommandsFor(LOCAL_COMMANDS.map(command => command.name)) === LOCAL_COMMANDS)
}

// ---- 6. switch → immediate modelDisplay refresh (channel bridge) -------------
{
  const store = memoryClaudeChannels({ active: 'zhipu', channels: [
    { id: 'zhipu', name: 'ZhiPu', models: { 'claude-opus-zq9x[1m]': 'glm-fix-5.3' } },
    { id: 'other', name: 'Other', tiers: { opus: 'other-opus' } },
  ] })
  const envDir = mkdtempSync(join(tmpdir(), 'dshtui-channels-env2-'))
  writeFileSync(join(envDir, 'settings.json'), JSON.stringify({ env: { ANTHROPIC_MODEL: 'env-any-model' } }))
  const previous = process.env.CLAUDE_CONFIG_DIR
  try {
    process.env.CLAUDE_CONFIG_DIR = envDir
    const fake = fakeClaudeSdk(() => ({ capabilities: [], models }), controls)
    const session = await openClaudeSession(claudeDeps(fake.sdk, { channels: store }))
    await tick()
    const ctx = { on: () => () => undefined, get: () => undefined, logger: { warn: () => undefined, info: () => undefined, debug: () => undefined } } as never
    const channel = createChannel(ctx, session, { model: 'Claude Agent', provider: 'claude', cwd: '/fixture/project', activity: false, backendLabel: 'Claude Agent' })
    try {
      fake.queries[0]!.emit(init)
      await tick()
      check('bridge: modelDisplay lands after session.ready (phase-1 path intact)', channel.modelDisplay === 'glm-fix-5.3', channel.modelDisplay)
      check('bridge: the snapshot offers /channel on a real claude channel', channel.backendCapabilities.commands.includes('channel') && channel.backendCapabilities.channels === true, channel.backendCapabilities.commands)
      check('bridge: the merged command list rides BACKEND_CHANNEL_COMMAND', channel.commandList.some(command => command.name === 'channel' && command.descriptionKey === 'cmd-desc-channel'), channel.commandList.filter(command => command.name === 'channel'))
      const roster = channel.backendChannels()!.snapshot()
      check('bridge: listChannels bridges the capability rows and the active id', roster.channels.length === 2 && roster.activeId === 'zhipu' && roster.channels[0]?.models[0]?.to === 'glm-fix-5.3', roster)
      check('bridge: setChannel switches and refreshes the display in the SAME call', channel.backendChannels()!.activate('other').ok === true && channel.modelDisplay === 'other-opus', channel.modelDisplay)
      check('bridge: the store itself moved', store.read().active === 'other', store.read())
      check('bridge: setChannel refuses an unknown id', channel.backendChannels()!.activate('nope').ok === false && channel.modelDisplay === 'other-opus')
      const imported = channel.backendChannels()!.importFromSettings()?.option
      check('bridge: importChannel lands in the roster', imported !== undefined && imported.id === 'settings' && channel.backendChannels()!.snapshot().channels.some(option => option.id === 'settings'), imported)
    } finally {
      channel.releaseContributions()
      await session.dispose()
    }
  } finally {
    process.env.CLAUDE_CONFIG_DIR = previous
    rmSync(envDir, { recursive: true, force: true })
  }
}

// ---- 7. wiring tripwires (source-level) ------------------------------------
{
  const { readFileSync: readSrc } = await import('node:fs')
  const readRepo = (rel: string): string => readSrc(new URL(rel, import.meta.url), 'utf8')
  const chatSrc = readRepo('../src/screens/Chat.tsx') + readRepo('../src/screens/chat/useBackendChannels.ts')
  check('tripwire: Chat hosts the channel overlay key branch', chatSrc.includes("overlay.kind === 'channel'"))
  check('tripwire: Chat renders ChannelPicker inside pickerPanels', chatSrc.includes('<ChannelPicker') && chatSrc.includes("import { ChannelPicker } from '../components/ChannelPicker.js'"))
  check('tripwire: the confirm path drives activation/import through the host', chatSrc.includes('host.activate(row.option.id)') && chatSrc.includes('host.importFromSettings()'))
  const controlsSrc = readRepo('../src/dsh-adapter/channel/core/compose.ts')
  check('tripwire: the switch host re-resolves the model display in the same call', controlsSrc.includes('controls.refreshModelDisplay(fence.session)'))
}

// ---- 8. connection fields in the store -------------------------------------
{
  const mem = memoryClaudeChannels({ active: 'conn', channels: [
    { id: 'conn', name: 'Conn', baseUrl: 'https://relay.example/api', tokenRef: 'CHANNEL_CONN_TOKEN', env: { ANTHROPIC_LOG: 'debug' }, tiers: { opus: 'o' } },
    { id: 'plain', name: 'Plain' },
  ] })
  const round = mem.read()
  check('conn-store: baseUrl/tokenRef/env round-trip through the narrowing',
    round.channels[0]?.baseUrl === 'https://relay.example/api' && round.channels[0]?.tokenRef === 'CHANNEL_CONN_TOKEN' && round.channels[0]?.env?.ANTHROPIC_LOG === 'debug', round)
  mem.remove('conn')
  const afterRemove = mem.read()
  check('conn-store: remove drops the row and the now-dangling active',
    afterRemove.channels.length === 1 && afterRemove.channels[0]?.id === 'plain' && afterRemove.active === undefined, afterRemove)
  mem.remove('ghost')
  check('conn-store: remove of an unknown id is a no-op', mem.read().channels.length === 1)

  const dir = mkdtempSync(join(tmpdir(), 'dshtui-channels-conn-'))
  try {
    const store = fileClaudeChannels(dir)
    store.save({ id: 'a', name: 'A', baseUrl: 'https://a.example', tokenRef: 'CHANNEL_A_TOKEN', env: { K: 'v' } })
    store.setActive('a')
    const reread = fileClaudeChannels(dir).read()
    check('conn-store: the connection fields persist through the file',
      reread.channels[0]?.baseUrl === 'https://a.example' && reread.channels[0]?.tokenRef === 'CHANNEL_A_TOKEN' && reread.channels[0]?.env?.K === 'v', reread)
    writeFileSync(join(dir, 'channels.json'), JSON.stringify({ channels: [
      { id: 'x', name: 'X', baseUrl: 42, tokenRef: '   ', env: { ok: 'v', bad: 7 } },
    ] }))
    const narrowed = fileClaudeChannels(dir).read()
    check('conn-store: junk connection fields narrow away (numbers, blanks)',
      narrowed.channels[0]?.baseUrl === undefined && narrowed.channels[0]?.tokenRef === undefined && narrowed.channels[0]?.env?.ok === 'v' && narrowed.channels[0]?.env?.bad === undefined, narrowed)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// ---- 9. the token credential store -----------------------------------------
{
  check('tokens: the ref derives the deriveKeyRef way', channelTokenRef('open-bigmodel-cn') === 'CHANNEL_OPEN_BIGMODEL_CN_TOKEN' && channelTokenRef('智谱') === 'CHANNEL_CHANNEL_TOKEN', channelTokenRef('open-bigmodel-cn'))
  const dir = mkdtempSync(join(tmpdir(), 'dshtui-channel-tokens-'))
  try {
    // A foreign-owned store the write must preserve byte-for-byte around its row.
    const foreign = ['# managed elsewhere', 'refs:', '  DEEPSEEK_API_KEY: keep-me', 'other:', '  key: value', '']
    writeFileSync(join(dir, '.credentials.yaml'), foreign.join('\n'))
    const tokens = fileClaudeChannelTokens(dir, () => undefined)
    check('tokens: read of an absent ref is undefined', tokens.read('CHANNEL_Z_TOKEN') === undefined)
    tokens.write('CHANNEL_Z_TOKEN', 'plain-secret')
    check('tokens: write inserts under refs: and keeps every foreign line',
      tokens.read('CHANNEL_Z_TOKEN') === 'plain-secret' && tokens.read('DEEPSEEK_API_KEY') === 'keep-me', readFileSync(join(dir, '.credentials.yaml'), 'utf8'))
    tokens.write('CHANNEL_Z_TOKEN', 'tok: with spaces # hash')
    check('tokens: a value needing YAML quoting round-trips', tokens.read('CHANNEL_Z_TOKEN') === 'tok: with spaces # hash', readFileSync(join(dir, '.credentials.yaml'), 'utf8'))
    tokens.write('DEEPSEEK_API_KEY', 'replaced')
    check('tokens: an existing foreign ref is replaced in place', tokens.read('DEEPSEEK_API_KEY') === 'replaced')
    check('tokens: declared answers for present and absent refs', tokens.declared('CHANNEL_Z_TOKEN') === true && tokens.declared('CHANNEL_NOPE_TOKEN') === false)
    tokens.erase('CHANNEL_Z_TOKEN')
    check('tokens: erase removes only its own row', tokens.read('CHANNEL_Z_TOKEN') === undefined && tokens.read('DEEPSEEK_API_KEY') === 'replaced')
    if (process.platform !== 'win32') {
      const { statSync } = await import('node:fs')
      check('tokens: the store file is 0600', (statSync(join(dir, '.credentials.yaml')).mode & 0o777) === 0o600)
    }
    const fresh = mkdtempSync(join(tmpdir(), 'dshtui-channel-tokens-new-'))
    try {
      const creating = fileClaudeChannelTokens(fresh)
      creating.write('CHANNEL_A_TOKEN', 'first-one')
      const text = readFileSync(join(fresh, '.credentials.yaml'), 'utf8')
      check('tokens: a missing store is created with a refs: block', text.startsWith('refs:\n') && creating.read('CHANNEL_A_TOKEN') === 'first-one', text)
    } finally {
      rmSync(fresh, { recursive: true, force: true })
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
  const mem = memoryClaudeChannelTokens({ CHANNEL_M_TOKEN: 'mem' })
  check('tokens: the in-memory store reads/writes/erases/declares',
    mem.read('CHANNEL_M_TOKEN') === 'mem' && (mem.write('CHANNEL_M_TOKEN', 'two'), mem.read('CHANNEL_M_TOKEN') === 'two') && (mem.erase('CHANNEL_M_TOKEN'), mem.read('CHANNEL_M_TOKEN') === undefined && mem.declared('CHANNEL_M_TOKEN') === false))
}

// ---- 9b. every commit parses back as valid YAML (round-trip) ---------------
{
  const yaml = await import('yaml')
  const dir = mkdtempSync(join(tmpdir(), 'dshtui-channel-tokens-yaml-'))
  const storeFile = join(dir, '.credentials.yaml')
  const seeded = (text: string): void => { writeFileSync(storeFile, text) }
  const text = (): string => readFileSync(storeFile, 'utf8')
  const parses = () => yaml.parseDocument(text())
  try {
    // (a) a flow (inline) refs library: the write must extend the same
    //     top-level key, never append a duplicate `refs:`.
    seeded('refs: { FOREIGN: synthetic }\n')
    const inline = fileClaudeChannelTokens(dir, () => undefined)
    check('yaml: a flow refs library reads its foreign ref', inline.read('FOREIGN') === 'synthetic')
    inline.write('CHANNEL_Z_TOKEN', 'inline-secret')
    const inlineDoc = parses()
    check('yaml: writing into a flow refs library keeps ONE valid top-level refs',
      inlineDoc.errors.length === 0 && inlineDoc.getIn(['refs', 'FOREIGN']) === 'synthetic' && inlineDoc.getIn(['refs', 'CHANNEL_Z_TOKEN']) === 'inline-secret', text())
    // (b) an empty flow mapping gains its first ref cleanly.
    seeded('refs: {}\n')
    fileClaudeChannelTokens(dir, () => undefined).write('CHANNEL_A_TOKEN', 'first')
    const emptyDoc = parses()
    check('yaml: an empty flow refs library gains its first ref cleanly',
      emptyDoc.errors.length === 0 && emptyDoc.getIn(['refs', 'CHANNEL_A_TOKEN']) === 'first', text())
    // (c) a quoted refs key is located semantically.
    seeded('"refs":\n  "CHANNEL_A_TOKEN": quoted\n')
    const quoted = fileClaudeChannelTokens(dir, () => undefined)
    check('yaml: a quoted refs key reads and writes',
      quoted.read('CHANNEL_A_TOKEN') === 'quoted' && (quoted.write('CHANNEL_B_TOKEN', 'b'), parses().errors.length === 0 && parses().getIn(['refs', 'CHANNEL_B_TOKEN']) === 'b'), text())
    // (d) foreign comments, a multiline scalar and sibling fields keep their
    //     meaning across an unrelated write (semantic, via the parser).
    seeded(['# host-managed', 'refs:', '  FOREIGN: |', '    line one', '    line two', 'other:', '  key: value', ''].join('\n'))
    fileClaudeChannelTokens(dir, () => undefined).write('CHANNEL_B_TOKEN', 'b-token')
    const multiDoc = parses()
    check('yaml: foreign comments, multiline scalars and siblings survive a write',
      multiDoc.errors.length === 0 && multiDoc.getIn(['refs', 'FOREIGN']) === 'line one\nline two\n'
        && multiDoc.getIn(['other', 'key']) === 'value' && multiDoc.getIn(['refs', 'CHANNEL_B_TOKEN']) === 'b-token', text())
    // (e) CRLF and no-trailing-newline inputs stay semantically intact.
    seeded('refs:\r\n  A: keep\r\n')
    const crlf = fileClaudeChannelTokens(dir, () => undefined)
    crlf.write('CHANNEL_C_TOKEN', 'c')
    const crlfDoc = parses()
    check('yaml: a CRLF library round-trips (semantics kept, still valid)',
      crlfDoc.errors.length === 0 && crlfDoc.getIn(['refs', 'A']) === 'keep' && crlfDoc.getIn(['refs', 'CHANNEL_C_TOKEN']) === 'c', text())
    seeded('refs:\n  A: keep')
    const noNewline = fileClaudeChannelTokens(dir, () => undefined)
    noNewline.write('CHANNEL_D_TOKEN', 'd')
    const noNewlineDoc = parses()
    check('yaml: a library without a trailing newline round-trips',
      noNewlineDoc.errors.length === 0 && noNewlineDoc.getIn(['refs', 'A']) === 'keep' && noNewlineDoc.getIn(['refs', 'CHANNEL_D_TOKEN']) === 'd', text())
    // (f) damaged stores are refused byte-intact (never rebuilt over).
    seeded('refs:\n  A: 1\nrefs:\n  B: 2\n')
    const debugs: string[] = []
    const damaged = fileClaudeChannelTokens(dir, message => debugs.push(message))
    damaged.write('CHANNEL_E_TOKEN', 'e')
    check('yaml: a duplicate-refs library is refused, byte-intact, with a debug line',
      text() === 'refs:\n  A: 1\nrefs:\n  B: 2\n' && damaged.read('CHANNEL_E_TOKEN') === undefined && debugs.some(message => message.includes('not valid YAML')), { text: text(), debugs })
    // (g) a refs entry that is not a mapping refuses writes.
    seeded('refs: [1, 2]\n')
    fileClaudeChannelTokens(dir, () => undefined).write('CHANNEL_E_TOKEN', 'e')
    check('yaml: a non-mapping refs value refuses writes', text() === 'refs: [1, 2]\n')
    // (h) only non-empty string scalars read as tokens.
    seeded('refs:\n  NULLV: null\n  NUMV: 42\n  TOK: real\n')
    const scalars = fileClaudeChannelTokens(dir, () => undefined)
    check('yaml: only string scalars read as tokens (non-strings: declared, not usable)',
      scalars.read('TOK') === 'real' && scalars.read('NULLV') === undefined && scalars.read('NUMV') === undefined && scalars.declared('NULLV') === true)
    // (i) erase keeps the library valid for a strict parser.
    seeded('refs:\n  KEEP: k\n  CHANNEL_F_TOKEN: gone\n')
    const erasing = fileClaudeChannelTokens(dir, () => undefined)
    erasing.erase('CHANNEL_F_TOKEN')
    const erasedDoc = parses()
    check('yaml: erase leaves a valid library with the other refs intact',
      erasedDoc.errors.length === 0 && erasedDoc.getIn(['refs', 'KEEP']) === 'k' && erasedDoc.getIn(['refs', 'CHANNEL_F_TOKEN']) === undefined, text())
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// ---- 10. the spawn injection shape (env + the flag layer) ------------------
{
  const noSettings = { settings: async () => ({}), globalConfig: () => undefined } as const
  // (a) a channel with a full connection replaces the environment's own
  //     spellings and re-states itself in the flag layer.
  const base = {
    PATH: '/usr/bin',
    ANTHROPIC_BASE_URL: 'https://stale.example',
    ANTHROPIC_API_KEY: 'stale-key',
    ANTHROPIC_AUTH_TOKEN: 'stale-token',
  }
  const plan = await resolveClaudeAuth({ ...base }, undefined, {
    ...noSettings,
    channel: { baseUrl: 'https://relay.example/api', token: 'chan-token', env: { ANTHROPIC_LOG: 'debug' } },
  })
  check('inject: the channel env carries the endpoint, the token and the private env',
    plan.env.ANTHROPIC_BASE_URL === 'https://relay.example/api' && plan.env.ANTHROPIC_AUTH_TOKEN === 'chan-token' && plan.env.ANTHROPIC_LOG === 'debug', plan.env)
  check('inject: the environment stale spellings are gone (every credential, in the child env too — R3-1)',
    plan.env.ANTHROPIC_API_KEY === undefined && plan.env.ANTHROPIC_BASE_URL !== 'https://stale.example' && plan.env.ANTHROPIC_AUTH_TOKEN !== 'stale-token' && plan.env.CLAUDE_CODE_OAUTH_TOKEN === undefined, plan.env)
  check('inject: the flag layer names all three credential keys verbatim (R3-1: an empty string suppresses the value user settings still holds)',
    plan.settings?.env?.ANTHROPIC_BASE_URL === 'https://relay.example/api' && plan.settings?.env?.ANTHROPIC_AUTH_TOKEN === 'chan-token'
    && plan.settings?.env?.ANTHROPIC_API_KEY === '' && plan.settings?.env?.CLAUDE_CODE_OAUTH_TOKEN === ''
    && plan.settings?.env?.ANTHROPIC_LOG === 'debug', plan.settings)
  check('inject: the flag layer blanks the routing variables (a settings tier cannot re-route the credential)',
    plan.settings?.env?.CLAUDE_CODE_USE_BEDROCK === '' && plan.settings?.env?.CLAUDE_CODE_API_BASE_URL === '' && plan.settings?.env?.ANTHROPIC_CUSTOM_HEADERS === ''
    && plan.settings?.env?.ANTHROPIC_UNIX_SOCKET === '' && plan.settings?.env?.CLAUDE_CODE_USE_GATEWAY === '', plan.settings?.env)
  check('inject: the route names the channel endpoint and the source says auth-token',
    plan.route?.kind === 'custom-endpoint' && (plan.route as { host?: string }).host === 'relay.example' && plan.source === 'auth-token', plan)
  // (b) the dsh-auth login is never injected alongside a channel connection,
  //     not even for a channel that pins the first-party origin.
  let freshCalls = 0
  const planFirstParty = await resolveClaudeAuth({ ...base }, { fresh: async () => { freshCalls += 1; return { access: 'oauth-token', expires: 0 } } }, {
    ...noSettings,
    channel: { baseUrl: 'https://api.anthropic.com', token: 'chan-token' },
  })
  check('inject: a channel connection outranks the dsh-auth login (no oauth alongside)',
    freshCalls === 0 && planFirstParty.source === 'auth-token' && planFirstParty.env.CLAUDE_CODE_OAUTH_TOKEN === undefined, planFirstParty)
  // (c) a channel without a stored token still pins the endpoint and pins
  //     all three credential keys empty. Production refuses to spawn a
  //     tokenless custom endpoint (backend.ts, the fail-closed checks below),
  //     but the plan itself stays complete as a second line of defence.
  const planNoToken = await resolveClaudeAuth({ ...base }, undefined, { ...noSettings, channel: { baseUrl: 'https://relay.example/api' } })
  check('inject: a tokenless channel pins the base URL and drops the split-pair ambient credentials',
    planNoToken.env.ANTHROPIC_BASE_URL === 'https://relay.example/api' && planNoToken.env.ANTHROPIC_AUTH_TOKEN === undefined && planNoToken.env.ANTHROPIC_API_KEY === undefined && planNoToken.env.CLAUDE_CODE_OAUTH_TOKEN === undefined
    && planNoToken.settings?.env?.ANTHROPIC_BASE_URL === 'https://relay.example/api' && planNoToken.settings?.env?.ANTHROPIC_AUTH_TOKEN === ''
    && planNoToken.settings?.env?.ANTHROPIC_API_KEY === '' && planNoToken.settings?.env?.CLAUDE_CODE_OAUTH_TOKEN === '', planNoToken)
  // (c2) a token without a base URL re-credentials the endpoint the ambient
  //      environment/settings already names (the pair stays), and the flag
  //      layer owns the credential keys without pinning any endpoint.
  const planTokenOnly = await resolveClaudeAuth({ ...base }, undefined, { ...noSettings, channel: { token: 'chan-token' } })
  check('inject: a token-only channel keeps the ambient endpoint and replaces only the credential',
    planTokenOnly.env.ANTHROPIC_BASE_URL === 'https://stale.example' && planTokenOnly.env.ANTHROPIC_AUTH_TOKEN === 'chan-token'
    && planTokenOnly.env.ANTHROPIC_API_KEY === undefined && planTokenOnly.env.CLAUDE_CODE_OAUTH_TOKEN === undefined
    && planTokenOnly.settings?.env?.ANTHROPIC_AUTH_TOKEN === 'chan-token' && planTokenOnly.settings?.env?.ANTHROPIC_API_KEY === ''
    && planTokenOnly.settings?.env?.CLAUDE_CODE_OAUTH_TOKEN === '' && planTokenOnly.settings?.env?.ANTHROPIC_BASE_URL === undefined, planTokenOnly)
  // (c3) an env-only profile (a model mapping with private variables) pins
  //      nothing and leaves the ambient credentials exactly as they were.
  const planEnvOnly = await resolveClaudeAuth({ ...base }, undefined, { ...noSettings, channel: { env: { ANTHROPIC_LOG: 'debug' } } })
  check('inject: an env-only channel pins only its env and keeps the ambient credentials',
    planEnvOnly.settings?.env?.ANTHROPIC_LOG === 'debug' && Object.keys(planEnvOnly.settings?.env ?? {}).length === 1
    && planEnvOnly.env.ANTHROPIC_API_KEY === 'stale-key' && planEnvOnly.env.ANTHROPIC_AUTH_TOKEN === 'stale-token' && planEnvOnly.source === 'api-key', planEnvOnly)
  // (c4) fail-closed seams: a custom endpoint without
  //      a credential the profile modeled is refusable, and an explicit
  //      helper identity in readable settings conflicts with a channel.
  check('refuse: a custom endpoint with no token and no credential-shaped env key is refusable',
    channelMissingCredential({ baseUrl: 'https://relay.example/api' }) === true
    && channelMissingCredential({ baseUrl: 'not a url' }) === true)
  check('refuse: the first-party origin, a token, or an explicitly modeled env credential are not',
    channelMissingCredential({ baseUrl: 'https://api.anthropic.com' }) === false
    && channelMissingCredential({ baseUrl: 'https://relay.example/api', token: 't' }) === false
    && channelMissingCredential({ baseUrl: 'https://relay.example/api', env: { Anthropic_Api_Key: 'k' } }) === false
    && channelMissingCredential({ env: { ANTHROPIC_LOG: 'debug' } }) === false)
  let helperConflict = ''
  try {
    await resolveClaudeAuth({ ...base }, undefined, {
      settings: async () => ({ env: {}, apiKeyHelper: '/usr/local/bin/key' }),
      globalConfig: () => undefined,
      channel: { baseUrl: 'https://relay.example/api', token: 'chan-token' },
    })
  } catch (error) {
    helperConflict = error instanceof ClaudeChannelConflictError ? error.message : 'wrong error: ' + String(error)
  }
  check('refuse: a settings apiKeyHelper conflicts with a channel (fail closed, never a double credential)',
    helperConflict === t('claude-channel-helper-conflict') && !helperConflict.includes('chan-token'), helperConflict)
  const helperless = await resolveClaudeAuth({ ...base }, undefined, {
    settings: async () => ({ env: {} }),
    globalConfig: () => undefined,
    channel: { baseUrl: 'https://relay.example/api', token: 'chan-token' },
  })
  check('refuse: no helper declared, no conflict (the plan builds)', helperless.source === 'auth-token' && helperless.env.ANTHROPIC_AUTH_TOKEN === 'chan-token', helperless.source)
  // (c5) the cc-switch notices: which settings credentials the channel pin
  //      replaces, by key name only.
  {
    const superseded = channelStartNotices({ name: 'ZhiPu', baseUrl: 'https://relay.example/api', tokenRef: 'CHANNEL_RELAY_TOKEN' },
      { ANTHROPIC_BASE_URL: 'https://old.invalid', ANTHROPIC_API_KEY: 'stale-key-secret', anthropic_auth_token: 'stale-token-secret', CLAUDE_CODE_OAUTH_TOKEN: 'stale-oauth-secret' })
    check('notice: the URL mismatch line and the superseded-credential line both appear (names only, never values)',
      superseded.length === 2
      && superseded[0] === t('channel-conn-settings-mismatch', { name: 'ZhiPu' })
      && superseded[1] === t('channel-conn-creds-superseded', { keys: 'ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, CLAUDE_CODE_OAUTH_TOKEN' })
      && !superseded.join('\n').includes('stale-key-secret') && !superseded.join('\n').includes('stale-token-secret') && !superseded.join('\n').includes('stale-oauth-secret'), superseded)
    check('notice: a mapping-only channel supersedes nothing (the ambient credentials stand)',
      channelStartNotices({ name: 'Map' }, { ANTHROPIC_API_KEY: 'k' }).length === 0)
    check('notice: matching URLs and no settings credentials stay silent',
      channelStartNotices({ name: 'Same', baseUrl: 'https://relay.example/api' }, { ANTHROPIC_BASE_URL: 'https://relay.example/api' }).length === 0)
  }
  // (d) no channel connection: the plan is what it is without channels (no
  //     flag layer, the env untouched).
  const legacy = await resolveClaudeAuth({ ...base }, undefined, noSettings)
  check('inject: without a channel the plan is unchanged (no flag layer, env as-is)',
    legacy.settings === undefined && legacy.env.ANTHROPIC_BASE_URL === 'https://stale.example' && legacy.env.ANTHROPIC_API_KEY === 'stale-key' && legacy.source === 'api-key', legacy)
  // (e) the session forwards both layers into the SDK query options.
  const fake = fakeClaudeSdk(() => ({ capabilities: [], models }), controls)
  const session = await openClaudeSession(claudeDeps(fake.sdk, {
    auth: {
      plan,
      renew: () => Promise.resolve(plan),
    },
  }))
  await tick()
  const first = fake.queries[0]!
  const options = first.options as { env?: Record<string, string>; settings?: unknown }
  check('inject: startRun passes the channel env to the child', options.env?.ANTHROPIC_AUTH_TOKEN === 'chan-token' && options.env?.ANTHROPIC_BASE_URL === 'https://relay.example/api', options.env)
  check('inject: startRun passes the flag layer through the SDK settings option', first.flagSettings?.env?.ANTHROPIC_BASE_URL === 'https://relay.example/api' && first.flagSettings?.env?.ANTHROPIC_AUTH_TOKEN === 'chan-token', first.flagSettings)
  // The SDK turns `settings` into `--settings <value>` on the CLI's command
  // line: it must be a path, never the token-bearing JSON.
  const settingsPath = typeof options.settings === 'string' ? options.settings : ''
  check('inject: the flag layer goes by file path, so the token never reaches argv',
    settingsPath !== '' && !settingsPath.includes('chan-token') && !JSON.stringify(Object.entries(options).filter(([key]) => key !== 'env')).includes('chan-token'), options.settings)
  check('inject: the flag settings file is owner-only', process.platform === 'win32' || first.flagSettingsMode === 0o600, first.flagSettingsMode?.toString(8))
  check('inject: … in its own owner-only directory', process.platform === 'win32' || (statSync(dirname(settingsPath)).mode & 0o777) === 0o700)
  await session.dispose()
  check('inject: dispose removes the flag settings file', settingsPath !== '' && !existsSync(settingsPath) && !existsSync(dirname(settingsPath)))
  // A reconnect retires the old run: its file goes with it, the new run has its own.
  const reconnecting = await openClaudeSession(claudeDeps(fake.sdk, { auth: { plan, renew: () => Promise.resolve(plan) } }))
  await tick()
  const before = fake.queries.at(-1)!.options.settings as string
  await reconnecting.capabilities.auth!.reconnect()
  const after = fake.queries.at(-1)!.options.settings as string
  check('inject: a reconnect removes the retired run\'s file and writes a fresh one', before !== after && !existsSync(before) && existsSync(after))
  await reconnecting.dispose()
  check('inject: … and dispose removes that one too', !existsSync(after))
  // A file still open when the process exits (a crash path that skipped
  // dispose) is removed on exit.
  const flagUrl = new URL('../src/backends/claude/flag-settings.ts', import.meta.url).href
  const leftover = await new Promise<string>(resolve => {
    execFile(process.execPath, ['--import', 'tsx/esm', '--input-type=module', '-e',
      `const { writeFlagSettingsFile } = await import(${JSON.stringify(flagUrl)}); const file = writeFlagSettingsFile({ env: { ANTHROPIC_AUTH_TOKEN: 'exit-token' } }); console.log(file.path); process.exit(0)`],
    { cwd: fileURLToPath(new URL('..', import.meta.url)), timeout: 30_000 }, (_error, stdout) => resolve(String(stdout).trim()))
  })
  check('inject: a flag settings file left open is removed when the process exits', leftover.endsWith('settings.json') && !existsSync(leftover) && !existsSync(dirname(leftover)), leftover)
}

// ---- 11. the settings import absorbs the connection ------------------------
{
  const dir = mkdtempSync(join(tmpdir(), 'dshtui-channels-import-'))
  const store = fileClaudeChannels(dir)
  const tokens = memoryClaudeChannelTokens()
  const envDir = mkdtempSync(join(tmpdir(), 'dshtui-channels-import-env-'))
  writeFileSync(join(envDir, 'settings.json'), JSON.stringify({ env: {
    ANTHROPIC_BASE_URL: 'https://open.bigmodel.cn/api/anthropic',
    ANTHROPIC_AUTH_TOKEN: 'cc-switch-wrote-this-token',
    ANTHROPIC_DEFAULT_OPUS_MODEL: 'glm-5.3[1M]',
  } }))
  const previous = process.env.CLAUDE_CONFIG_DIR
  try {
    process.env.CLAUDE_CONFIG_DIR = envDir
    const fake = fakeClaudeSdk(() => ({ capabilities: [], models }), controls)
    const session = await openClaudeSession(claudeDeps(fake.sdk, { channels: store, channelTokens: tokens }))
    await tick()
    fake.queries[0]!.emit(init)
    await tick()
    const imported = session.capabilities.channels?.importFromSettings()
    check('import: the connection is absorbed (baseUrl + tokenRef on the profile)',
      imported?.connection?.baseUrl === 'https://open.bigmodel.cn/api/anthropic' && imported?.connection?.hasToken === true, imported)
    const stored = store.read().channels.find(channel => channel.id === 'open-bigmodel-cn')
    check('import: the token moved to the credential store, the profile keeps only the ref',
      stored?.tokenRef === 'CHANNEL_OPEN_BIGMODEL_CN_TOKEN' && tokens.read('CHANNEL_OPEN_BIGMODEL_CN_TOKEN') === 'cc-switch-wrote-this-token', stored)
    const fileText = readFileSync(join(dir, 'channels.json'), 'utf8')
    check('import: channels.json never carries the literal token', !fileText.includes('cc-switch-wrote-this-token'), fileText)
    const peek = session.capabilities.channels?.peekSettingsImport?.()
    check('import: peekSettingsImport answers the absorbable shape without creating anything',
      peek?.baseUrl === 'https://open.bigmodel.cn/api/anthropic' && peek?.tiers?.opus === 'glm-5.3[1M]' && store.read().channels.length === 1, peek)
    await session.dispose()
  } finally {
    process.env.CLAUDE_CONFIG_DIR = previous
    rmSync(envDir, { recursive: true, force: true })
    rmSync(dir, { recursive: true, force: true })
  }
  check('import: the token-only helper picks ANTHROPIC_AUTH_TOKEN and nothing else',
    importTokenFromSettingsEnv({ ANTHROPIC_AUTH_TOKEN: ' t ', ANTHROPIC_MODEL: 'm' }) === 't' && importTokenFromSettingsEnv({}) === undefined)
  const withUrl = importFromSettingsEnv({ ANTHROPIC_BASE_URL: 'https://x.example/api', ANTHROPIC_MODEL: 'm' })
  check('import: a parseable base URL becomes the profile connection; an unparseable one does not',
    withUrl?.baseUrl === 'https://x.example/api' && importFromSettingsEnv({ ANTHROPIC_BASE_URL: 'not a url', ANTHROPIC_MODEL: 'm' })?.baseUrl === undefined, withUrl)
}

// ---- 11b. flag > settings > inherited; the import drops our own injections --
{
  const envDir = mkdtempSync(join(tmpdir(), 'dshtui-channels-r35-'))
  writeFileSync(join(envDir, 'settings.json'), JSON.stringify({ env: {
    ANTHROPIC_MODEL: 'from-settings',
    ANTHROPIC_BASE_URL: 'https://settings.example/api',
  } }))
  try {
    const injected = new Set(['ANTHROPIC_AUTH_TOKEN'])
    const live = {
      ANTHROPIC_AUTH_TOKEN: 'flag-injected-token',          // ours (the flag layer)
      ANTHROPIC_MODEL: 'inherited-model',                    // truly inherited
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'inherited-opus',        // inherited, settings silent
    }
    const merged = mergedModelEnv(envDir, live, injected)
    check('sources: a flag-injected key outranks the settings file (deliberate)',
      merged.ANTHROPIC_AUTH_TOKEN === 'flag-injected-token', merged)
    check('sources: the settings file outranks the truly inherited env (the CLI\'s own order)',
      merged.ANTHROPIC_MODEL === 'from-settings' && merged.ANTHROPIC_BASE_URL === 'https://settings.example/api', merged)
    check('sources: an inherited key fills the gaps the settings leave',
      merged.ANTHROPIC_DEFAULT_OPUS_MODEL === 'inherited-opus', merged)
    check('sources: without injected keys the settings-vs-inherited order still holds (no wholesale flip)',
      mergedModelEnv(envDir, { ANTHROPIC_MODEL: 'inherited-model' }).ANTHROPIC_MODEL === 'from-settings')
    const importSource = importedModelEnv(envDir, live, injected)
    check('sources: the import source EXCLUDES the TUI\'s own injections entirely',
      importSource.ANTHROPIC_AUTH_TOKEN === undefined, importSource)
    check('sources: the import source is settings first, inherited env for the gaps',
      importSource.ANTHROPIC_MODEL === 'from-settings' && importSource.ANTHROPIC_BASE_URL === 'https://settings.example/api'
        && importSource.ANTHROPIC_DEFAULT_OPUS_MODEL === 'inherited-opus', importSource)
  } finally {
    rmSync(envDir, { recursive: true, force: true })
  }
  // The cc-switch loop, end to end: the active channel A injects itself at
  // spawn (auth plan flag layer) and cc-switch has rewritten settings to
  // relay B; "import from settings" must land B, not re-import A.
  {
    const envDir = mkdtempSync(join(tmpdir(), 'dshtui-channels-r35-e2e-'))
    writeFileSync(join(envDir, 'settings.json'), JSON.stringify({ env: {
      ANTHROPIC_BASE_URL: 'https://relay-b.example/api',
      ANTHROPIC_AUTH_TOKEN: 'cc-switch-b-token',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'b-opus',
    } }))
    const previous = process.env.CLAUDE_CONFIG_DIR
    try {
      process.env.CLAUDE_CONFIG_DIR = envDir
      const store = memoryClaudeChannels({ active: 'relay-a-example', channels: [
        { id: 'relay-a-example', name: 'relay-a.example', baseUrl: 'https://relay-a.example/api', tokenRef: 'CHANNEL_RELAY_A_EXAMPLE_TOKEN' },
      ] })
      const tokens = memoryClaudeChannelTokens({ CHANNEL_RELAY_A_EXAMPLE_TOKEN: 'channel-a-token' })
      const plan = await resolveClaudeAuth({}, undefined, {
        settings: async () => ({}),
        globalConfig: () => undefined,
        channel: { baseUrl: 'https://relay-a.example/api', token: 'channel-a-token' },
      })
      const fake = fakeClaudeSdk(() => ({ capabilities: [], models }), controls)
      const session = await openClaudeSession(claudeDeps(fake.sdk, {
        channels: store,
        channelTokens: tokens,
        auth: { plan, renew: () => Promise.resolve(plan) },
      }))
      await tick()
      fake.queries[0]!.emit(init)
      await tick()
      const imported = session.capabilities.channels?.importFromSettings()
      check('sources: cc-switch end to end — the import lands the SETTINGS relay, not the injected one',
        imported?.id === 'relay-b-example' && imported.connection?.baseUrl === 'https://relay-b.example/api'
          && tokens.read('CHANNEL_RELAY_B_EXAMPLE_TOKEN') === 'cc-switch-b-token', imported)
      const aRow = store.read().channels.find(channel => channel.id === 'relay-a-example')
      check('sources: the active channel A survives untouched (its own row and token intact)',
        aRow?.baseUrl === 'https://relay-a.example/api' && tokens.read('CHANNEL_RELAY_A_EXAMPLE_TOKEN') === 'channel-a-token', aRow)
      await session.dispose()
    } finally {
      process.env.CLAUDE_CONFIG_DIR = previous
      rmSync(envDir, { recursive: true, force: true })
    }
  }
}

// ---- 12. save/remove through the capability (the wizard's seams) -----------
{
  const dir = mkdtempSync(join(tmpdir(), 'dshtui-channels-manage-'))
  const store = fileClaudeChannels(dir)
  const tokens = memoryClaudeChannelTokens()
  const envDir = mkdtempSync(join(tmpdir(), 'dshtui-channels-manage-env-'))
  writeFileSync(join(envDir, 'settings.json'), JSON.stringify({ env: {} }))
  const previous = process.env.CLAUDE_CONFIG_DIR
  try {
    process.env.CLAUDE_CONFIG_DIR = envDir
    const fake = fakeClaudeSdk(() => ({ capabilities: [], models }), controls)
    const session = await openClaudeSession(claudeDeps(fake.sdk, { channels: store, channelTokens: tokens }))
    await tick()
    const channels = session.capabilities.channels!
    const saved = channels.save!({ id: 'newchan', name: 'NewChan', baseUrl: 'https://new.example/api', token: 'wizard-token', env: { K: 'v' } })
    check('manage: save lands the connection and reports the fingerprinted view',
      saved.connection?.baseUrl === 'https://new.example/api' && saved.connection?.hasToken === true && saved.connection?.envKeys?.[0] === 'K' && typeof saved.connection?.fingerprint === 'string', saved)
    check('manage: the token lives in the credential store, not channels.json',
      tokens.read('CHANNEL_NEWCHAN_TOKEN') === 'wizard-token' && !readFileSync(join(dir, 'channels.json'), 'utf8').includes('wizard-token'))
    const kept = channels.save!({ id: 'newchan', name: 'Renamed' })
    check('manage: an edit without connection fields keeps them (and the token)',
      kept.name === 'Renamed' && kept.connection?.baseUrl === 'https://new.example/api' && kept.connection?.hasToken === true && store.read().channels[0]?.tokenRef === 'CHANNEL_NEWCHAN_TOKEN', kept)
    const rotated = channels.save!({ id: 'newchan', name: 'Renamed', token: 'rotated-token' })
    check('manage: a new token replaces the stored one (same ref)',
      tokens.read('CHANNEL_NEWCHAN_TOKEN') === 'rotated-token' && rotated.connection?.hasToken === true)
    const cleared = channels.save!({ id: 'newchan', name: 'Renamed', token: '' })
    check('manage: an empty token removes it and the ref',
      tokens.read('CHANNEL_NEWCHAN_TOKEN') === undefined && cleared.connection?.hasToken === false && store.read().channels[0]?.tokenRef === undefined, cleared)
    store.setActive('newchan')
    check('manage: remove drops the row, its token, and the dangling active',
      channels.remove!('newchan') === true && store.read().channels.length === 0 && store.read().active === undefined && tokens.read('CHANNEL_NEWCHAN_TOKEN') === undefined)
    check('manage: remove of an unknown id answers false', channels.remove!('ghost') === false)
    await session.dispose()
  } finally {
    process.env.CLAUDE_CONFIG_DIR = previous
    rmSync(envDir, { recursive: true, force: true })
    rmSync(dir, { recursive: true, force: true })
  }
}

// ---- 12b. tokenRef ownership (rotation reuse, conservative erase) ----------
{
  const dir = mkdtempSync(join(tmpdir(), 'dshtui-channels-refs-'))
  const store = fileClaudeChannels(dir)
  const tokens = memoryClaudeChannelTokens()
  // Hand-migrated profiles pointing at foreign-shaped refs, one of them
  // shared by a second channel: code that only knows derived refs would
  // orphan or wrongly erase these.
  store.save({ id: 'legacy-example', name: 'legacy', baseUrl: 'https://legacy.example/api', tokenRef: 'LEGACY_REF' })
  store.save({ id: 'sibling', name: 'sibling', tokenRef: 'SHARED_REF' })
  tokens.write('LEGACY_REF', 'old-secret')
  tokens.write('SHARED_REF', 'shared-secret')
  const envDir = mkdtempSync(join(tmpdir(), 'dshtui-channels-refs-env-'))
  const settingsText = JSON.stringify({ env: {
    ANTHROPIC_BASE_URL: 'https://legacy.example/api',
    ANTHROPIC_AUTH_TOKEN: 'imported-token',
  } })
  writeFileSync(join(envDir, 'settings.json'), settingsText)
  const previous = process.env.CLAUDE_CONFIG_DIR
  try {
    process.env.CLAUDE_CONFIG_DIR = envDir
    const fake = fakeClaudeSdk(() => ({ capabilities: [], models }), controls)
    const session = await openClaudeSession(claudeDeps(fake.sdk, { channels: store, channelTokens: tokens }))
    await tick()
    const channels = session.capabilities.channels!
    // (a) a rotation reuses the row's existing ref: no orphaned credential,
    //     no silent move to the derived ref.
    const rotated = channels.save!({ id: 'legacy-example', name: 'legacy', token: 'rotated-secret' })
    check('refs: a rotation reuses the existing (non-derived) ref in place',
      tokens.read('LEGACY_REF') === 'rotated-secret' && tokens.declared('CHANNEL_LEGACY_EXAMPLE_TOKEN') === false
        && rotated.connection?.hasToken === true && store.read().channels.find(channel => channel.id === 'legacy-example')?.tokenRef === 'LEGACY_REF', { rotated, rows: store.read() })
    // (b) the settings import is a copy rotating the same ref; settings.json
    //     itself is never touched.
    const imported = channels.importFromSettings()
    check('refs: the import rotates the existing ref and never edits settings.json',
      imported?.connection?.hasToken === true && tokens.read('LEGACY_REF') === 'imported-token'
        && readFileSync(join(envDir, 'settings.json'), 'utf8') === settingsText, imported)
    // (c) removing a channel sharing a ref keeps it (the sibling still reads).
    check('refs: remove of a ref-sharing channel keeps the shared credential',
      channels.remove!('sibling') === true && tokens.read('SHARED_REF') === 'shared-secret')
    // (d) removing the hand-written-ref channel keeps its (possibly foreign)
    //     credential: only a derived ref is provably ours to erase.
    check('refs: remove keeps a non-derived ref (ownership guard)',
      channels.remove!('legacy-example') === true && tokens.read('LEGACY_REF') === 'imported-token' && store.read().channels.length === 0)
    // (e) the derived-ref channel still erases on remove (section 12's
    //     behaviour, as the positive control for the ownership guard).
    channels.save!({ id: 'derived', name: 'derived', token: 'd-token' })
    check('refs: a derived ref still erases with its channel',
      channels.remove!('derived') === true && tokens.read('CHANNEL_DERIVED_TOKEN') === undefined)
    await session.dispose()
  } finally {
    process.env.CLAUDE_CONFIG_DIR = previous
    rmSync(envDir, { recursive: true, force: true })
    rmSync(dir, { recursive: true, force: true })
  }
}

// ---- 12c. shared derived refs never dangle a sibling -----------------------
{
  const dir = mkdtempSync(join(tmpdir(), 'dshtui-channels-shared-derived-'))
  const store = fileClaudeChannels(dir)
  const tokens = memoryClaudeChannelTokens()
  // B points at A's derived ref (a hand edit or migration): the ref is legal
  // and derived for A, yet two rows reference it. Erasing it on A's account
  // (remove or clear-token) would dangle B: the row survives while its
  // credential dies.
  store.save({ id: 'a', name: 'A', baseUrl: 'https://a.example', tokenRef: 'CHANNEL_A_TOKEN' })
  store.save({ id: 'b', name: 'B', tokenRef: 'CHANNEL_A_TOKEN' })
  tokens.write('CHANNEL_A_TOKEN', 'shared-secret')
  const bRow = () => store.read().channels.find(channel => channel.id === 'b')
  const envDir = mkdtempSync(join(tmpdir(), 'dshtui-channels-shared-derived-env-'))
  writeFileSync(join(envDir, 'settings.json'), JSON.stringify({ env: {} }))
  const previous = process.env.CLAUDE_CONFIG_DIR
  try {
    process.env.CLAUDE_CONFIG_DIR = envDir
    const fake = fakeClaudeSdk(() => ({ capabilities: [], models }), controls)
    const session = await openClaudeSession(claudeDeps(fake.sdk, { channels: store, channelTokens: tokens }))
    await tick()
    const channels = session.capabilities.channels!
    // (a) clearing A's token detaches the row but keeps the credential B
    //     reads: B must not lose its credential because of A.
    const cleared = channels.save!({ id: 'a', name: 'A', token: '' })
    check('shared-ref: clearing one row keeps the credential the sibling reads',
      cleared.connection?.hasToken === false
        && store.read().channels.find(channel => channel.id === 'a')?.tokenRef === undefined
        && tokens.read('CHANNEL_A_TOKEN') === 'shared-secret'
        && bRow()?.tokenRef === 'CHANNEL_A_TOKEN',
      { cleared, rows: store.read(), token: tokens.read('CHANNEL_A_TOKEN') })
    // (b) removing A (which re-adopted its derived ref) keeps the credential
    //     B still references: no dangling reference.
    channels.save!({ id: 'a', name: 'A', token: 're-set' })
    check('shared-ref: remove keeps a derived ref another row still references',
      channels.remove!('a') === true && tokens.read('CHANNEL_A_TOKEN') === 're-set'
        && bRow()?.tokenRef === 'CHANNEL_A_TOKEN' && tokens.declared('CHANNEL_A_TOKEN'),
      { rows: store.read(), token: tokens.read('CHANNEL_A_TOKEN') })
    // (c) when the last referent clears, the credential goes with it (the
    //     unshared positive control for the clear path's guard). B never had
    //     a baseUrl, so the cleared row is mapping-only: no connection slice.
    const clearedLast = channels.save!({ id: 'b', name: 'B', token: '' })
    check('shared-ref: the last referent still clears the credential',
      clearedLast.connection === undefined && tokens.read('CHANNEL_A_TOKEN') === undefined && bRow()?.tokenRef === undefined,
      { rows: store.read(), token: tokens.read('CHANNEL_A_TOKEN') })
    await session.dispose()
  } finally {
    process.env.CLAUDE_CONFIG_DIR = previous
    rmSync(envDir, { recursive: true, force: true })
    rmSync(dir, { recursive: true, force: true })
  }
}

// Wizard regressions use the production capability and subhost; only the
// SDK transport and persistent stores are replaced.
const wizardChannels: ReturnType<typeof createChannel>[] = []
const channelsChannel = (channels: NonNullable<SessionCapabilities['channels']>) => {
  const session: AgentSession = {
    ref: { backendId: 'fake', sessionId: 'wizard-fixture' }, cwd: '/fixture/project', status: 'idle',
    capabilities: { native: {}, channels }, history: async () => [],
    subscribe: () => () => undefined, submit: async () => ({ accepted: true }),
    cancel: async () => ({ stillQueued: [], outcome: 'confirmed' }), dispose: async () => undefined,
  }
  const ctx = { on: () => () => undefined, get: () => undefined, logger: { warn: () => undefined } } as never
  const channel = createChannel(ctx, session, { model: 'm', provider: '', cwd: session.cwd, activity: false })
  wizardChannels.push(channel)
  return channel
}
const wizardHarness = (initial: Parameters<typeof memoryClaudeChannels>[0], initialTokens: Record<string, string> = {}, env: Record<string, string> = {}) => {
  const store = memoryClaudeChannels(initial)
  const tokens = memoryClaudeChannelTokens(initialTokens)
  const channels = createClaudeControls({
    query: () => ({} as never), emit: () => undefined, submitText: async () => undefined,
    currentModel: () => 'm', currentMode: () => 'default', noteModel: () => [], noteMode: () => [],
    prefs: memoryClaudePrefs(), channels: store, tokens, settingsEnv: () => env, debug: () => undefined,
  }).capabilities.channels
  let saved = 0
  const channel = channelsChannel({ ...channels, save: input => { saved += 1; return channels.save(input) } })
  const deps = (selected: Record<string, string[]>, custom: Record<string, string> = {}) => ({
    ask: async (request: { questions: { id: string }[] }) => {
      const id = request.questions[0]!.id
      return { answers: [{ id, ...(selected[id] === undefined ? { custom: custom[id] ?? '' } : { selected: selected[id]! }) }] } as never
    },
    notify: () => undefined, pushLocal: () => undefined, host: channel.backendChannels()!,
  })
  return { store, tokens, channel, deps, savedCalls: () => saved }
}

try {
// ---- 13. same connection vs restart ----------------------------------------
{
  const conn = (fingerprint: string, baseUrl?: string) => ({ baseUrl, hasToken: true, envKeys: [] as string[], fingerprint })
  const row = (id: string, connection?: ReturnType<typeof conn>) => ({ id, name: id, models: [], tiers: [], ...(connection === undefined ? {} : { connection }) })
  const restartBetween = (from: BackendChannelOption | undefined, to: BackendChannelOption): boolean => {
    let list = from === undefined ? [] : [from]
    const channel = channelsChannel({
      list: () => list, activeId: () => from?.id, setActive: () => undefined,
      importFromSettings: () => undefined, save: () => to, remove: () => false, peekSettingsImport: () => undefined,
    })
    const host = channel.backendChannels()!
    list = [to]
    return host.activate(to.id).restart
  }
  check('restart: equal fingerprints are the same connection (no restart)',
    restartBetween(row('a', conn('fp1')), row('b', conn('fp1'))) === false)
  check('restart: a token rotation changes the fingerprint (restart)',
    restartBetween(row('a', conn('fp1')), row('a', conn('fp2'))) === true)
  check('restart: mapping-only channels are the same connection',
    restartBetween(row('a'), row('b')) === false)
  check('restart: no active channel to mapping-only channel keeps the process',
    restartBetween(undefined, row('mapping-only')) === false)
  check('restart: no active channel to connected channel restarts',
    restartBetween(undefined, row('connected', conn('fp1'))) === true)
  check('restart: mapping-only vs connected differs (restart)',
    restartBetween(row('a'), row('b', conn('fp1'))) === true)
}

// Host activation refuses a connection change before persistence while a
// turn runs; mapping-only changes still refresh in place.
{
  const h = wizardHarness({ active: 'map-a', channels: [
    { id: 'map-a', name: 'Map A' }, { id: 'map-b', name: 'Map B' },
    { id: 'connected', name: 'Connected', baseUrl: 'https://relay.example' },
  ] })
  h.channel.working = true
  const host = h.channel.backendChannels()!
  const mapping = host.activate('map-b')
  check('host: mapping-only activation is allowed during a turn', mapping.ok && !mapping.restart && h.store.read().active === 'map-b')
  const refused = host.activate('connected')
  check('host: a running connection switch is refused BEFORE writing active id', !refused.ok && refused.restart && h.store.read().active === 'map-b' && h.channel.notifications.some(item => item.text === t('channel-switch-while-working')))
  h.channel.working = false
  check('host: the same connection switch restarts when idle', host.activate('connected').restart && h.store.read().active === 'connected')
  const editing = h.channel.backendChannels()!
  editing.save({ id: 'connected', name: 'Connected', token: 'rotated-token' })
  check('host: save then same-id activation compares the pre-save fingerprint', editing.activate('connected').restart === true)
  check('host: a new accessor takes a new connection snapshot', h.channel.backendChannels()!.activate('connected').restart === false)
}
{
  const env = { ANTHROPIC_BASE_URL: 'https://relay.example', ANTHROPIC_AUTH_TOKEN: 'imported-token', ANTHROPIC_DEFAULT_OPUS_MODEL: 'imported-opus' }
  const draft = importFromSettingsEnv(env)!
  const active = wizardHarness({ active: draft.id, channels: [{ id: draft.id, name: draft.name, baseUrl: 'https://old.example' }] }, {}, env)
  const host = active.channel.backendChannels()!
  check('host: peekImport exposes settings without writing', host.peekImport()?.tiers.opus === 'imported-opus' && active.store.read().channels[0]?.baseUrl === 'https://old.example')
  check('host: importing over the active connection reports restart', host.importFromSettings()?.restart === true)
  check('host: re-importing the same connection needs no restart', active.channel.backendChannels()!.importFromSettings()?.restart === false)
  const switchedEnv = { ANTHROPIC_BASE_URL: 'https://new.example' }
  const importing = importFromSettingsEnv(switchedEnv)!
  const switched = wizardHarness({ active: 'map-a', channels: [{ id: 'map-a', name: 'Map A' }, { id: importing.id, name: importing.name }] }, {}, switchedEnv)
  const retained = switched.channel.backendChannels()!
  const activation = retained.activate(importing.id)
  check('host: retained mapping-only activation changes the current profile without a restart', activation.ok && !activation.restart && switched.store.read().active === importing.id)
  check('host: retained import compares the current active id with its original connection', retained.importFromSettings()?.restart === true && switched.store.read().active === importing.id)
  const inactive = wizardHarness({ active: 'keep', channels: [{ id: 'keep', name: 'Keep', baseUrl: 'https://keep.example' }] }, {}, env)
  check('host: importing an inactive channel never changes the active connection', inactive.channel.backendChannels()!.importFromSettings()?.restart === false && inactive.store.read().active === 'keep')
}

// ---- 14. the wizard, headless (scripted answers) ---------------------------
{
  const h = wizardHarness({ channels: [] }, {}, {
    ANTHROPIC_BASE_URL: 'https://open.bigmodel.cn/api/anthropic', ANTHROPIC_DEFAULT_OPUS_MODEL: 'glm-5.3[1M]',
  })
  const { store, tokens } = h
  const deps = h.deps({
    action: [t('channel-wiz-opt-add')], tiers: [t('channel-wiz-opt-tiers-skip')], switch: [t('channel-wiz-opt-switch-no')],
  }, { name: 'ZhiPu', baseurl: 'https://open.bigmodel.cn/api/anthropic', token: 'wiz-secret' })
  const outcome = await runChannelWizard(deps as never)
  const landed = store.read().channels[0]
  check('wizard: the add flow saves the channel with its connection',
    outcome.kind === 'saved' && landed?.id === 'zhipu' && landed?.baseUrl === 'https://open.bigmodel.cn/api/anthropic' && landed?.tokenRef === 'CHANNEL_ZHIPU_TOKEN', { outcome, landed })
  check('wizard: the token reached the credential seam only', tokens.read('CHANNEL_ZHIPU_TOKEN') === 'wiz-secret' && !JSON.stringify(landed).includes('wiz-secret'))
  // Same connection switch → no restart; different → restart.
  check('wizard: the host comparator drives the restart flag', deps.host.activate(landed!.id).restart === true && h.channel.backendChannels()!.activate(landed!.id).restart === false)
}

// ---- 14b. deleting or overwriting the active connection restarts -----------
{
  const { t } = await import('../src/i18n.js')
  const harness = wizardHarness
  // (a) deleting the active channel with a connection restarts: the
  //     running child still holds the erased endpoint/token.
  {
    const h = harness({ active: 'conn', channels: [
      { id: 'conn', name: 'Conn', baseUrl: 'https://relay.example/api', tokenRef: 'CHANNEL_CONN_TOKEN' },
      { id: 'plain', name: 'Plain' },
    ] })
    h.tokens.write('CHANNEL_CONN_TOKEN', 'live-token')
    const outcome = await runChannelWizard(h.deps({
      action: [t('channel-wiz-opt-manage')],
      pick: ['Conn'],
      edit: [t('channel-wiz-opt-edit-delete')],
      confirm: [t('channel-wiz-opt-delete-yes')],
    }) as never)
    check('restart: deleting the ACTIVE connected channel demands a fresh session',
      outcome.kind === 'deleted' && outcome.restart === true, outcome)
  }
  // (b) a mapping-only active row never shaped the spawn → no restart.
  {
    const h = harness({ active: 'map', channels: [{ id: 'map', name: 'Map', tiers: { opus: 'x' } } as never] })
    const outcome = await runChannelWizard(h.deps({
      action: [t('channel-wiz-opt-manage')],
      pick: ['Map'],
      edit: [t('channel-wiz-opt-edit-delete')],
      confirm: [t('channel-wiz-opt-delete-yes')],
    }) as never)
    check('restart: deleting a mapping-only ACTIVE channel restarts nothing',
      outcome.kind === 'deleted' && outcome.restart === false, outcome)
  }
  // (c) deleting an inactive connected channel leaves the running row alone.
  {
    const h = harness({ active: 'keep', channels: [
      { id: 'keep', name: 'Keep', baseUrl: 'https://keep.example' },
      { id: 'other', name: 'Other', baseUrl: 'https://other.example' },
    ] })
    const outcome = await runChannelWizard(h.deps({
      action: [t('channel-wiz-opt-manage')],
      pick: ['Other'],
      edit: [t('channel-wiz-opt-edit-delete')],
      confirm: [t('channel-wiz-opt-delete-yes')],
    }) as never)
    check('restart: deleting an inactive connected channel needs no restart',
      outcome.kind === 'deleted' && outcome.restart === false, outcome)
  }
  // (d) the add flow overwriting the active row (same name → same id) with a
  //     rotated token, then declining the switch: the connection on disk
  //     changed under the running child, so it restarts anyway.
  {
    const h = harness({ active: 'conn', channels: [
      { id: 'conn', name: 'Conn', baseUrl: 'https://relay.example/api', tokenRef: 'CHANNEL_CONN_TOKEN' },
    ] })
    h.tokens.write('CHANNEL_CONN_TOKEN', 'old-token')
    const outcome = await runChannelWizard(h.deps({
      action: [t('channel-wiz-opt-add')],
      switch: [t('channel-wiz-opt-switch-no')],
    }, { name: 'Conn', token: 'rotated-token' }) as never)
    const landed = h.store.read().channels[0]
    check('restart: overwriting the ACTIVE row restarts even when the switch is declined',
      outcome.kind === 'saved' && outcome.restart === true && landed?.tokenRef === 'CHANNEL_CONN_TOKEN' && h.tokens.read('CHANNEL_CONN_TOKEN') === 'rotated-token', { outcome, landed })
  }
  // (e) a brand-new channel (no active row touched) stays restart-free.
  {
    const h = harness({ active: 'keep', channels: [{ id: 'keep', name: 'Keep', baseUrl: 'https://keep.example' }] })
    const outcome = await runChannelWizard(h.deps({
      action: [t('channel-wiz-opt-add')],
      switch: [t('channel-wiz-opt-switch-no')],
    }, { name: 'Fresh', baseurl: 'https://fresh.example', token: 'fresh-token' }) as never)
    check('restart: adding a brand-new channel without switching restarts nothing',
      outcome.kind === 'saved' && outcome.restart === false, outcome)
  }
}

{
  const h = wizardHarness({ active: 'conn', channels: [
    { id: 'conn', name: 'Conn', baseUrl: 'https://relay.example', tokenRef: 'CHANNEL_CONN_TOKEN' },
  ] }, { CHANNEL_CONN_TOKEN: 'old-token' })
  const deps = h.deps({ action: [t('channel-wiz-opt-add')], switch: [t('channel-wiz-opt-switch-no')] }, { name: 'Conn', token: 'rotated-token' })
  const ask = deps.ask
  deps.ask = request => {
    if (request.questions[0]!.id === 'switch') h.channel.working = true
    return ask(request)
  }
  const outcome = await runChannelWizard(deps)
  check('wizard: an active save during a turn still reports next-session restart', outcome.kind === 'saved' && outcome.restart && h.store.read().active === 'conn' && h.channel.notifications.some(item => item.text === t('channel-switch-while-working')))
}

// ---- 14c. an add colliding with another channel's id confirms --------------
{
  const { t } = await import('../src/i18n.js')
  // Two different ASCII names that slug to one id.
  check('clash: two different names can still share an id', channelSlug('Open BigModel') === channelSlug('open.bigmodel') && channelSlug('open.bigmodel') === 'open-bigmodel')
  const h = (initial: Parameters<typeof memoryClaudeChannels>[0] = { active: 'open-bigmodel', channels: [
    { id: 'open-bigmodel', name: 'Open BigModel', baseUrl: 'https://open.bigmodel.cn/api/anthropic', tokenRef: 'CHANNEL_OPEN_BIGMODEL_TOKEN' },
  ] }, initialTokens: Record<string, string> = { CHANNEL_OPEN_BIGMODEL_TOKEN: 'zhipu-secret' }) => wizardHarness(initial, initialTokens)
  // (a) declining the overwrite writes nothing.
  {
    const c = h()
    const outcome = await runChannelWizard(c.deps({
      action: [t('channel-wiz-opt-add')],
      clash: [t('channel-wiz-opt-clash-cancel')],
    }, { name: 'open.bigmodel' }) as never)
    const row = c.store.read().channels[0]
    check('clash: declining the overwrite writes nothing',
      outcome.kind === 'cancelled' && outcome.restart === false && c.savedCalls() === 0
        && c.store.read().channels.length === 1 && row?.name === 'Open BigModel' && row?.baseUrl === 'https://open.bigmodel.cn/api/anthropic'
        && c.tokens.read('CHANNEL_OPEN_BIGMODEL_TOKEN') === 'zhipu-secret', { outcome, row })
  }
  // (b) confirming the overwrite saves, and because the overwritten row is
  //     active with a changed connection, a fresh-session restart follows.
  {
    const c = h()
    const outcome = await runChannelWizard(c.deps({
      action: [t('channel-wiz-opt-add')],
      clash: [t('channel-wiz-opt-clash-overwrite')],
      switch: [t('channel-wiz-opt-switch-no')],
    }, { name: 'open.bigmodel', baseurl: 'https://siliconflow.example/v1', token: 'sf-secret' }) as never)
    const row = c.store.read().channels[0]
    check('clash: confirming the overwrite replaces the row and restarts the active connection',
      outcome.kind === 'saved' && outcome.restart === true && row?.name === 'open.bigmodel' && row?.baseUrl === 'https://siliconflow.example/v1'
        && c.tokens.read('CHANNEL_OPEN_BIGMODEL_TOKEN') === 'sf-secret', { outcome, row })
  }
  // (c) re-adding the same-named channel is the edit path: no clash gate.
  {
    const c = h()
    const outcome = await runChannelWizard(c.deps({
      action: [t('channel-wiz-opt-add')],
      switch: [t('channel-wiz-opt-switch-no')],
    }, { name: 'Open BigModel', baseurl: 'https://open.bigmodel.cn/api/anthropic' }) as never)
    check('clash: re-adding the same-named channel never trips the clash gate',
      outcome.kind === 'saved' && c.savedCalls() === 1, outcome)
  }
  // (d) Chinese names: 智谱 and 硅基流动 coexist, each with its own token ref.
  {
    const c = h({ channels: [] }, {})
    await runChannelWizard(c.deps({ action: [t('channel-wiz-opt-add')], switch: [t('channel-wiz-opt-switch-no')] },
      { name: '智谱', baseurl: 'https://open.bigmodel.cn/api/anthropic', token: 'zhipu-secret' }) as never)
    const second = await runChannelWizard(c.deps({ action: [t('channel-wiz-opt-add')], switch: [t('channel-wiz-opt-switch-no')] },
      { name: '硅基流动', baseurl: 'https://siliconflow.example/v1', token: 'sf-secret' }) as never)
    const rows = c.store.read().channels
    const zhipu = rows.find(row => row.name === '智谱')
    const sf = rows.find(row => row.name === '硅基流动')
    check('chinese names: 智谱 and 硅基流动 coexist without a clash prompt',
      second.kind === 'saved' && rows.length === 2 && zhipu !== undefined && sf !== undefined && zhipu.id !== sf.id, rows)
    check('chinese names: each keeps its own token ref and token',
      zhipu?.tokenRef !== sf?.tokenRef && c.tokens.read(zhipu?.tokenRef ?? '') === 'zhipu-secret' && c.tokens.read(sf?.tokenRef ?? '') === 'sf-secret', { zhipu, sf })
  }
  // (e) a profile saved under the old rule (id `channel`) keeps its id: the
  //     same name edits it in place, and a second Chinese name sits beside it.
  {
    const c = h({ active: 'channel', channels: [
      { id: 'channel', name: '智谱', baseUrl: 'https://open.bigmodel.cn/api/anthropic', tokenRef: 'CHANNEL_CHANNEL_TOKEN' },
    ] }, { CHANNEL_CHANNEL_TOKEN: 'zhipu-secret' })
    const edit = await runChannelWizard(c.deps({ action: [t('channel-wiz-opt-add')], switch: [t('channel-wiz-opt-switch-no')] },
      { name: '智谱', baseurl: 'https://open.bigmodel.cn/api/anthropic', token: 'zhipu-rotated' }) as never)
    check('legacy id: re-adding the same name edits the existing row (no clash, no duplicate)',
      edit.kind === 'saved' && c.store.read().channels.length === 1 && c.store.read().channels[0]?.id === 'channel'
        && c.tokens.read('CHANNEL_CHANNEL_TOKEN') === 'zhipu-rotated', c.store.read())
    const add = await runChannelWizard(c.deps({ action: [t('channel-wiz-opt-add')], switch: [t('channel-wiz-opt-switch-no')] },
      { name: '硅基流动', token: 'sf-secret' }) as never)
    check('legacy id: a new Chinese name lands beside it, the old token untouched',
      add.kind === 'saved' && c.store.read().channels.length === 2 && c.tokens.read('CHANNEL_CHANNEL_TOKEN') === 'zhipu-rotated', c.store.read())
  }
}

// ---- 15. wiring tripwires (source-level) ------------------------------------
{
  const { readFileSync: readSrc } = await import('node:fs')
  const readRepo = (rel: string): string => readSrc(new URL(rel, import.meta.url), 'utf8')
  const chatSrc = readRepo('../src/screens/Chat.tsx') + readRepo('../src/screens/chat/useBackendChannels.ts')
  check('tripwire: a working wizard restart is reported as next-session activation', chatSrc.includes("if (channel.working) channel.notify(t('channel-switch-restart-unavailable'"))
  check('tripwire: Chat runs the wizard from the add/manage rows', chatSrc.includes('runChannelWizard({') && chatSrc.includes("{ kind: 'add' }") && chatSrc.includes("{ kind: 'manage' }"))
  check('tripwire: Chat routes a connection change through the fresh-session funnel', chatSrc.includes('onRestartFreshSession(t(\'channel-switch-restart\'') && chatSrc.includes('if (result.restart) restart(row.option.name)'))
  check('tripwire: Chat routes an import that changes the ACTIVE connection through the funnel (R3-2)',
    chatSrc.includes('host.importFromSettings()') && chatSrc.includes('if (imported?.restart) restart(imported.option.name)'))
  const pluginSrc = readRepo('../src/dsh-adapter/plugin.ts')
  check('tripwire: the composition root wires the funnel reusing the backend-switch branch',
    pluginSrc.includes('onRestartFreshSession: restartFreshSession') && pluginSrc.includes('backendSwitchRequested = backendChoice'))
  const authSrc = readRepo('../src/backends/claude/auth.ts')
  check('tripwire: the auth plan pins the channel connection in the flag layer', authSrc.includes('settings: { env: pinned }'))
  const actionsSrc = readRepo('../src/dsh-adapter/channel/core/compose.ts')
  check('tripwire: the channel host delegates save/remove/peekImport',
    actionsSrc.includes('save: input =>') && actionsSrc.includes('remove: id =>') && actionsSrc.includes('peekImport: () =>'))
}

} finally {
  for (const channel of wizardChannels) channel.releaseContributions()
}

// ---- 16. fail-closed refusals through the real backend.open ----------------
//
// The unit checks above cover the predicates; this drives the wiring: an
// isolated child process (temp HOME/USERPROFILE/CLAUDE_CONFIG_DIR/DSH_HOME,
// every ANTHROPIC_*/CLAUDE_CODE_* ambient variable scrubbed before the first
// import) imports the real backend and opens a session with (a) an active
// tokenless custom-endpoint channel and (b) a token channel under a settings
// apiKeyHelper. Both opens must reject with the actionable message, never
// spawn (the "CLI" is node itself, which exits at once on the SDK's args)
// and never leak the synthetic token or helper material.
{
  const home = mkdtempSync(join(tmpdir(), 'dshtui-channels-refuse-'))
  const configDir = join(home, '.claude')
  const dshHome = join(home, '.dsh')
  mkdirSync(configDir, { recursive: true })
  mkdirSync(dshHome, { recursive: true })
  const backendUrl = new URL('../src/backends/claude/index.ts', import.meta.url).href
  const root = fileURLToPath(new URL('..', import.meta.url))
  const child = [
    "const [backendUrl, home, configDir, dshHome] = process.argv.slice(2)",
    "process.env.DSH_TUI_LANG = 'en'",
    "const fs = await import('node:fs')",
    "const path = await import('node:path')",
    "process.env.HOME = home",
    "process.env.USERPROFILE = home",
    "process.env.CLAUDE_CONFIG_DIR = configDir",
    "process.env.DSH_HOME = dshHome",
    "for (const key of Object.keys(process.env)) {",
    "  const upper = key.toUpperCase()",
    "  if (upper.startsWith('ANTHROPIC_') || upper === 'CLAUDECODE' || (upper.startsWith('CLAUDE_CODE_') && upper !== 'CLAUDE_CODE_EXECUTABLE')) delete process.env[key]",
    "}",
    "process.env.CLAUDE_CODE_EXECUTABLE = process.execPath",
    "const dataDir = path.join(home, '.dsh-tui', 'backends', 'claude')",
    "fs.mkdirSync(dataDir, { recursive: true })",
    "const open = async claudeBackend => {",
    "  try {",
    "    const session = await claudeBackend.open({ kind: 'create', cwd: home }, { cwd: home, debug: () => undefined, warn: () => undefined })",
    "    await session.dispose()",
    "    return 'opened'",
    "  } catch (error) { return 'rejected: ' + (error instanceof Error ? error.message : String(error)) }",
    "}",
    "const report = outcome => console.log('@@RESULT@@' + JSON.stringify(outcome))",
    "try {",
    "  const { claudeBackend } = await import(backendUrl)",
    "  fs.writeFileSync(path.join(dataDir, 'channels.json'), JSON.stringify({ active: 'relay', channels: [{ id: 'relay', name: 'Relay', baseUrl: 'https://relay.example/api' }] }))",
    "  const s1 = await open(claudeBackend)",
    "  fs.writeFileSync(path.join(dataDir, 'channels.json'), JSON.stringify({ active: 'relay', channels: [{ id: 'relay', name: 'Relay', baseUrl: 'https://relay.example/api', tokenRef: 'CHANNEL_RELAY_TOKEN' }] }))",
    "  fs.writeFileSync(path.join(dshHome, '.credentials.yaml'), 'refs:\\n  CHANNEL_RELAY_TOKEN: synthetic-channel-token-not-real\\n')",
    "  fs.writeFileSync(path.join(configDir, 'settings.json'), JSON.stringify({ apiKeyHelper: 'echo synthetic-helper-key-not-real' }))",
    "  const s2 = await open(claudeBackend)",
    "  report({ s1, s2 })",
    "} catch (error) {",
    "  report({ crashed: error instanceof Error ? error.message : String(error) })",
    "}",
  ].join('\n')
  const probe = join(home, 'refuse-probe.mjs')
  writeFileSync(probe, child)
  try {
    const ran = await new Promise<{ code: number | null; stdout: string; stderr: string }>(resolve => {
      execFile(process.execPath, ['--import', 'tsx/esm', probe, backendUrl, home, configDir, dshHome], {
        cwd: root,
        timeout: 60_000,
        // A child that inherits a broken/relative TMP chokes inside tsx; its
        // temp lives in its own isolated home.
        env: { ...process.env, TMP: home, TEMP: home, TMPDIR: home },
      }, (error, stdout, stderr) => {
        resolve({ code: error === null ? 0 : (error.code ?? 1), stdout: String(stdout), stderr: String(stderr) })
      })
    })
    const line = ran.stdout.split(/\r?\n/u).find(l => l.startsWith('@@RESULT@@'))
    const parsed = line === undefined ? undefined : JSON.parse(line.slice('@@RESULT@@'.length)) as { s1?: string; s2?: string; crashed?: string }
    const outcomeText = JSON.stringify(parsed ?? {})
    const synthetic = ['synthetic-channel-token-not-real', 'synthetic-helper-key-not-real']
    check('refuse-backend: the isolated child ran and reported both scenarios',
      parsed !== undefined && parsed.crashed === undefined && ran.code === 0, { code: ran.code, stderr: ran.stderr.slice(0, 300), stdout: ran.stdout.slice(0, 300) })
    check('refuse-backend: a tokenless custom-endpoint channel refuses the start with the actionable sentence',
      parsed?.s1 === 'rejected: ' + t('claude-channel-token-missing', { name: 'Relay', host: 'relay.example' }), parsed?.s1)
    check('refuse-backend: a channel token under a settings apiKeyHelper refuses the start the same way',
      parsed?.s2 === 'rejected: ' + t('claude-channel-helper-conflict'), parsed?.s2)
    check('refuse-backend: no synthetic credential material travels in the refusals',
      synthetic.every(secret => !outcomeText.includes(secret)), outcomeText.slice(0, 300))
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

// ---- 17. the outbound credential matrix (real CLI, loopback) ---------------
//
// The shape checks say the flag layer carries the blanks; this checks what
// the blanks do against the installed CLI (the SDK's bundled native binary,
// the one production ships). The isolated user settings hold an old
// credential sentinel on one of the three keys (plus an old base URL, the
// cc-switch shape), the active channel points at a 127.0.0.1 listener, and
// no outbound request may carry the old sentinel: with a token, only the
// channel sentinel travels; tokenless, the requests are anonymous
// (production refuses to spawn that shape at all; the pin must hold even
// for it). One control cell runs first: the same settings with the
// listener URL and no channel, where the sentinel must arrive. That shows
// both that the CLI applies the user settings env over the child env (the
// leak being guarded) and that the listener detects sentinels (otherwise
// every "absent" below would mean nothing). Isolation per cell: fresh
// HOME/USERPROFILE/CLAUDE_CONFIG_DIR, a child env built from scratch
// (PATH/SystemRoot/telemetry flags only), the listener answers 401 so no
// turn ever succeeds, and only booleans/counts leave the listener, never a
// header or body. The flag layer goes the production way, as a private file
// (flag-settings.ts): every cell also checks that neither the argv the SDK
// built nor /proc/<pid>/cmdline carries a sentinel, and that the file is
// gone afterwards. One last cell passes the same layer inline: the outcome
// is the same, and the token is on the command line. Skipped with a
// visible SKIP (never a silent pass) when the SDK or its bundled CLI is
// absent.
{
  const OLD_SENTINEL = 'r3-old-sentinel-not-a-token'
  const CHANNEL_SENTINEL = 'r3-channel-sentinel-not-a-token'
  const CELL_MS = 12_000
  let sdk: Awaited<ReturnType<typeof loadClaudeSdk>> | undefined
  let cli: string | undefined
  try {
    sdk = await loadClaudeSdk()
    const require = createRequire(import.meta.url)
    const sdkEntry = require.resolve('@anthropic-ai/claude-agent-sdk') as string
    const ext = process.platform === 'win32' ? '.exe' : ''
    cli = createRequire(sdkEntry).resolve(`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/claude${ext}`) as string
  } catch (error) {
    console.log(`SKIP loopback (R3-1): the SDK or its bundled CLI is not installed (${error instanceof Error ? error.message : String(error)}) — the outbound matrix was NOT exercised`)
  }
  if (sdk !== undefined && cli !== undefined) {
    const root = mkdtempSync(join(tmpdir(), 'dshtui-channels-loop-'))
    try {
      // `inline` passes the flag layer as an object (the SDK puts it in the
      // CLI's argv); the default is the production form, a private file.
      const cell = async (label: string, settingsEnv: Record<string, string>, mode: 'control' | { readonly token?: string; readonly inline?: true }): Promise<void> => {
        const home = join(root, label)
        const config = join(home, 'config')
        const cwd = join(home, 'cwd')
        mkdirSync(config, { recursive: true })
        mkdirSync(cwd, { recursive: true })
        let seenOld = false
        let seenChannel = false
        let requests = 0
        // Early finish: once a credential-bearing request has been seen a few
        // times, the process's merged credentials are known; otherwise wait
        // up to the cap.
        let verdictReady: (() => void) | undefined
        const early = new Promise<void>(resolve => { verdictReady = () => resolve() })
        const server = http.createServer((request, response) => {
          requests += 1
          const values = Object.values(request.headers).map(value => Array.isArray(value) ? value.join(' ') : String(value ?? '')).join('\n')
          if (values.includes(OLD_SENTINEL)) seenOld = true
          if (values.includes(CHANNEL_SENTINEL)) seenChannel = true
          if (requests >= 3 && (seenChannel || (mode === 'control' && seenOld))) verdictReady?.()
          request.resume()
          response.writeHead(401, { 'content-type': 'application/json' })
          response.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'loopback' } }))
        })
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
        const loopbackUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`
        // The synthetic user settings, written after the listener exists (the
        // control's base URL is the listener's own dynamic port).
        writeFileSync(join(config, 'settings.json'), JSON.stringify({
          env: Object.fromEntries(Object.entries(settingsEnv).map(([key, value]) => [key, value === 'LOOPBACK' ? loopbackUrl : value])),
        }))
        // The child env is built from scratch (the SDK's `env` option
        // replaces the child environment): only PATH, SystemRoot, the
        // telemetry kill-switches and the isolated home/config pointers.
        // Nothing of the host's identity or credentials is inherited.
        const base: Record<string, string> = {
          PATH: process.env.PATH ?? '',
          ...(process.env.SystemRoot === undefined ? {} : { SystemRoot: process.env.SystemRoot }),
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
          DISABLE_TELEMETRY: '1',
          HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: config,
          TMP: home, TEMP: home, TMPDIR: home,
        }
        const settings = async (): Promise<{ env: Record<string, string> }> => ({ env: settingsEnv })
        const plan = mode === 'control' ? undefined : await resolveClaudeAuth({ ...base }, undefined, {
          settings,
          globalConfig: () => undefined,
          channel: { baseUrl: loopbackUrl, ...(mode.token === undefined ? {} : { token: mode.token }) },
        })
        const abort = new AbortController()
        const started = Date.now()
        const inline = mode !== 'control' && mode.inline === true
        const flagFile = plan?.settings === undefined || inline ? undefined : writeFlagSettingsFile(plan.settings)
        // What the CLI was started with: the argv the SDK built and, on
        // Linux, the kernel's view of it (/proc/<pid>/cmdline).
        const argv: string[] = []
        const query = sdk.query({
          prompt: 'loopback probe: reply with the single word ok',
          options: {
            cwd,
            env: plan === undefined ? base : plan.env,
            ...(plan?.settings === undefined ? {} : { settings: flagFile?.path ?? plan.settings }),
            settingSources: ['user'],
            permissionMode: 'default',
            model: 'haiku',
            maxTurns: 1,
            abortController: abort,
            stderr: () => undefined,
            spawnClaudeCodeProcess: spawnOptions => {
              const child = spawnProcess(spawnOptions.command, spawnOptions.args, {
                cwd: spawnOptions.cwd, env: spawnOptions.env as NodeJS.ProcessEnv, signal: spawnOptions.signal, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true,
              })
              argv.push(...spawnOptions.args)
              if (process.platform === 'linux' && child.pid !== undefined) {
                try { argv.push(...readFileSync(`/proc/${child.pid}/cmdline`, 'utf8').split('\0')) } catch { /* already gone */ }
              }
              return child
            },
          },
        })
        try {
          await Promise.race([
            (async () => {
              try {
                for await (const message of query) {
                  if ((message as { type?: string }).type === 'result') break
                }
              } catch {
                // The CLI died on our 401s: what was observed so far decides.
              }
            })(),
            early,
            new Promise<void>(resolve => { setTimeout(resolve, CELL_MS) }),
          ])
        } finally {
          abort.abort()
          try { await Promise.race([query.close().catch(() => undefined), new Promise(resolve => { setTimeout(resolve, 5000) })]) } catch { /* already gone */ }
          await new Promise<void>(resolve => server.close(() => resolve()))
          flagFile?.dispose()
        }
        console.log(`loopback ${label}: requests=${requests} old=${seenOld} channel=${seenChannel} argv=${argv.length} in ${Date.now() - started}ms`)
        if (mode === 'control') {
          // The control: without a channel pin the settings credential does
          // reach the listener. That is the leak itself, and it makes the
          // absence checks below meaningful.
          check(`loopback control: the settings credential reaches the listener (the leak mechanism is real and detectable)`,
            requests > 0 && seenOld && !seenChannel, { requests })
          return
        }
        check(`loopback ${label}: no outbound request carries the OLD settings sentinel`, requests > 0 && !seenOld, { requests })
        if (mode.token !== undefined) check(`loopback ${label}: the channel token is the credential that travels`, seenChannel)
        const settingsArg = argv[argv.indexOf('--settings') + 1] ?? ''
        if (inline) {
          // The comparison cell: the inline form gives the same outcome, and
          // it is the one that puts the token on the command line.
          check(`loopback ${label}: the inline form puts the token in the CLI's argv`, argv.some(arg => arg.includes(CHANNEL_SENTINEL)), argv.length)
        } else {
          check(`loopback ${label}: the CLI gets the flag layer as a file path, the token is in no argv entry`,
            argv.includes('--settings') && settingsArg === flagFile?.path && !argv.some(arg => arg.includes(CHANNEL_SENTINEL) || arg.includes(OLD_SENTINEL)), { settingsArg, entries: argv.length })
          check(`loopback ${label}: the flag settings file is gone after the run`, flagFile !== undefined && !existsSync(flagFile.path))
        }
      }
      // The control, then the six-cell matrix: tokenless/token × the three
      // credential keys cc-switch could have left in user settings.
      await cell('control', { ANTHROPIC_BASE_URL: 'LOOPBACK', ANTHROPIC_AUTH_TOKEN: OLD_SENTINEL }, 'control')
      for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN']) {
        await cell(`tokenless-${key}`, { ANTHROPIC_BASE_URL: 'https://old.invalid', [key]: OLD_SENTINEL }, {})
        await cell(`token-${key}`, { ANTHROPIC_BASE_URL: 'https://old.invalid', [key]: OLD_SENTINEL }, { token: CHANNEL_SENTINEL })
      }
      await cell('token-ANTHROPIC_AUTH_TOKEN-inline', { ANTHROPIC_BASE_URL: 'https://old.invalid', ANTHROPIC_AUTH_TOKEN: OLD_SENTINEL }, { token: CHANNEL_SENTINEL, inline: true })
    } finally {
      // Cleanup only ever removes the directory this run created under
      // tmpdir, by exact prefix, retrying through the Windows EPERM window
      // where a just-killed CLI still holds a handle (the same retry pattern
      // as channels.ts's renameIntoPlace).
      if (root.startsWith(join(tmpdir(), 'dshtui-channels-loop-'))) {
        const waitCell = new Int32Array(new SharedArrayBuffer(4))
        for (let attempt = 0; ; attempt++) {
          try {
            rmSync(root, { recursive: true, force: true })
            break
          } catch (error) {
            const code = typeof error === 'object' && error !== null ? String((error as NodeJS.ErrnoException).code) : ''
            if (attempt >= 10 || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'ENOTEMPTY')) throw error
            Atomics.wait(waitCell, 0, 0, Math.min(2 ** attempt, 500))
          }
        }
      }
    }
  }
}

console.log('\nverify-claude-channels OK (' + passed + ' checks)')
process.exit(0)
