/**
 * 渠道档案（channel profiles）回归：/channel 二期的存储、真源优先级、
 * settings 导入、命令门控与切换后的显示刷新。
 *
 * 钉住的契约：
 *
 *  1. **存储 best-effort**（channels.ts 照抄 prefs.ts 的 IO 模型）：缺文件/
 *     坏文件读作空、写失败只进 debug 日志、提交走「同目录临时文件 +
 *     renameSync 原子落位」、窄化丢掉畸形条目（重复 id 取首个、悬空 active 丢弃）。
 *  2. **真源优先级**（modelEnv.ts 扩展，纯函数 + 会话接线两层）：active
 *     channel 的 models（精确 → base 归一）> active channel 的 tiers（档位
 *     关键字 + 保留 default）> 旧 model-names.json > settings env 档位推断 >
 *     原始 id。channel 未激活或文件缺省时行为与四期前逐字节一致。
 *  3. **导入形状**：ANTHROPIC_BASE_URL 的 host 作渠道名、
 *     ANTHROPIC_DEFAULT_{HAIKU,OPUS,SONNET,FABLE}_MODEL + ANTHROPIC_MODEL 吸成
 *     tiers（default 键）、绝不猜精确 models、重复导入刷新同 id 渠道（保留
 *     手写的 models）。
 *  4. **命令门控（/channel）**：BACKEND_CHANNEL_COMMAND 随 channels 能力出现
 *     （claude 可见），DSH 快照永不列出（该 flag 刻意不吃 dsh 短路）。
 *  5. **切换即刷新**：channel.setChannel 在同一次调用里写存储并经
 *     session-controls 的 refreshModelDisplay 钩子重算 modelDisplay——页脚
 *     显示立即换名，不等下一次 model.changed。
 *  6. **三期：连接真源**：channels.json 增 baseUrl/tokenRef/env（token 只进
 *     ~/.dsh/.credentials.yaml 那套凭据库，channels.json 永不落明文——专项
 *     断言）；激活渠道的连接在 spawn 管线注入（authPlan.env + SDK settings
     选项的 flag 层，CLI 2.1.287 的 settings env 会盖过进程 env，取证见
     .local/agent-backend-review.md 第四批增补四）；导入吸收 baseUrl/token；
 *     同连接切换就地刷新 vs 异连接走新会话重启漏斗（sameOptionConnection）；
 *     问句式向导（src/channel/channel-wizard.ts，headless 驱动）走 saveChannel/
     removeChannel/peekChannelImport 三动作。
 *
 *  7. **R3-1 凭据隔离**（.local/review/r3-channels-security.md）：携带连接的
 *     渠道在 flag 层逐字声明三个凭据键——API_KEY=''、OAUTH=''、AUTH_TOKEN=
 *     渠道 token 或 ''（空串压掉 user settings 里 cc-switch 写入的旧值）——
 *     并清空路由变量，child env 同步清理冲突拼写；自定义 endpoint 缺凭据
 *     fail-closed 拒绝启动（含 apiKeyHelper 冲突）；mismatch notice 扩展到
 *     被替换凭据的键名（不报值）。出站行为用隔离环回实证：真
 *     resolveClaudeAuth + 已装 CLI + 127.0.0.1 动态端口 listener，六格矩阵
 *     （tokenless/token × 三种旧凭据键）断言「出站请求不含旧 sentinel」——
 *     形状断言不替代行为断言；无 CLI 时显式 SKIP，不伪称覆盖。
 *
 * Run: node --import tsx/esm scripts/verify-claude-channels.ts
 */
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import http from 'node:http'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { channelCapabilities } from '../src/channel/capabilities.js'
import { channelSlug, fileClaudeChannels, importFromSettingsEnv, importTokenFromSettingsEnv, memoryClaudeChannels, sameChannelConnection } from '../src/backends/claude/channels.js'
import { channelTokenRef, fileClaudeChannelTokens, memoryClaudeChannelTokens } from '../src/backends/claude/channelTokens.js'
import { ClaudeChannelConflictError, channelMissingCredential, resolveClaudeAuth } from '../src/backends/claude/auth.js'
import { channelStartNotices } from '../src/backends/claude/backend.js'
import { loadClaudeSdk } from '../src/backends/claude/sdk.js'
import { runChannelWizard, sameOptionConnection } from '../src/channel/channel-wizard.js'
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
  check('slug: a name without alphanumerics still gets a STABLE id', channelSlug('智谱') === 'channel' && channelSlug('智谱') === channelSlug('智谱'), channelSlug('智谱'))
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

// ---- 3. the truth-source priority chain (pure) ------------------------------
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

// ---- 4. session wiring: the truth reads the store live ----------------------
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
    // No active channel: the whole chain degrades to today's behavior. The
    // fixture id deliberately carries NO tier keyword, so what stands is the
    // ANTHROPIC_MODEL fallback (a tier-keyword id stops at the unset tier env
    // and answers undefined — phase-1 semantics, unchanged).
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
  const channelsCap = { list: () => [], activeId: () => undefined, setActive: () => undefined, importFromSettings: () => undefined }
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
      const roster = channel.listChannels()
      check('bridge: listChannels bridges the capability rows and the active id', roster.channels.length === 2 && roster.activeId === 'zhipu' && roster.channels[0]?.models[0]?.to === 'glm-fix-5.3', roster)
      check('bridge: setChannel switches and refreshes the display in the SAME call', channel.setChannel('other') === true && channel.modelDisplay === 'other-opus', channel.modelDisplay)
      check('bridge: the store itself moved', store.read().active === 'other', store.read())
      check('bridge: setChannel refuses an unknown id', channel.setChannel('nope') === false && channel.modelDisplay === 'other-opus')
      const imported = channel.importChannel()
      check('bridge: importChannel lands in the roster', imported !== undefined && imported.id === 'settings' && channel.listChannels().channels.some(option => option.id === 'settings'), imported)
    } finally {
      channel.releaseContributions()
      await session.dispose()
    }
  } finally {
    process.env.CLAUDE_CONFIG_DIR = previous
    rmSync(envDir, { recursive: true, force: true })
  }
}

// ---- 7. wiring tripwires (source-level, the mode-roster precedent) ----------
{
  const { readFileSync: readSrc } = await import('node:fs')
  const readRepo = (rel: string): string => readSrc(new URL(rel, import.meta.url), 'utf8')
  const chatSrc = readRepo('../src/screens/Chat.tsx')
  check('tripwire: Chat hosts the channel overlay key branch', chatSrc.includes("overlay.kind === 'channel'"))
  check('tripwire: Chat renders ChannelPicker inside pickerPanels', chatSrc.includes('<ChannelPicker') && chatSrc.includes("import { ChannelPicker, type ChannelPickerRow } from '../components/ChannelPicker.js'"))
  check('tripwire: the confirm path drives setChannel/importChannel through the bridge', chatSrc.includes('channel.setChannel(row.option.id)') && chatSrc.includes('channel.importChannel()'))
  const controlsSrc = readRepo('../src/dsh-adapter/channel/core/actions.ts')
  check('tripwire: the switch action re-resolves the model display in the same call', controlsSrc.includes('deps.controls.refreshModelDisplay(deps.session())'))
}

// ---- 8. phase 3: connection fields in the store ------------------------------
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

// ---- 9. phase 3: the token credential store ---------------------------------
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

// ---- 9b. R3-3: every commit parses back as valid YAML (round-trip) --------
{
  const yaml = await import('yaml')
  const dir = mkdtempSync(join(tmpdir(), 'dshtui-channel-tokens-yaml-'))
  const storeFile = join(dir, '.credentials.yaml')
  const seeded = (text: string): void => { writeFileSync(storeFile, text) }
  const text = (): string => readFileSync(storeFile, 'utf8')
  const parses = () => yaml.parseDocument(text())
  try {
    // (a) a FLOW (inline) refs library: the write must extend the SAME
    //     top-level key — the old line-append created a duplicate `refs:`.
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
    // (h) only non-empty STRING scalars read as tokens.
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

// ---- 10. phase 3: the spawn injection shape (env + the flag layer) ----------
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
  // (b) the dsh-auth login is never injected alongside a channel connection —
  //     not even for a channel that pins the first-party origin.
  let freshCalls = 0
  const planFirstParty = await resolveClaudeAuth({ ...base }, { fresh: async () => { freshCalls += 1; return { access: 'oauth-token', expires: 0 } } }, {
    ...noSettings,
    channel: { baseUrl: 'https://api.anthropic.com', token: 'chan-token' },
  })
  check('inject: a channel connection outranks the dsh-auth login (no oauth alongside)',
    freshCalls === 0 && planFirstParty.source === 'auth-token' && planFirstParty.env.CLAUDE_CODE_OAUTH_TOKEN === undefined, planFirstParty)
  // (c) a channel without a stored token still pins the endpoint — and now
  //     pins all three credential keys EMPTY: production refuses to SPAWN a
  //     tokenless custom endpoint (backend.ts, the fail-closed checks below),
  //     but the plan itself stays defense-in-depth complete.
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
  //      nothing and leaves the ambient credentials exactly as they were —
  //      the phase-1/-2 behavior is a contract, not an accident.
  const planEnvOnly = await resolveClaudeAuth({ ...base }, undefined, { ...noSettings, channel: { env: { ANTHROPIC_LOG: 'debug' } } })
  check('inject: an env-only channel pins only its env and keeps the ambient credentials',
    planEnvOnly.settings?.env?.ANTHROPIC_LOG === 'debug' && Object.keys(planEnvOnly.settings?.env ?? {}).length === 1
    && planEnvOnly.env.ANTHROPIC_API_KEY === 'stale-key' && planEnvOnly.env.ANTHROPIC_AUTH_TOKEN === 'stale-token' && planEnvOnly.source === 'api-key', planEnvOnly)
  // (c4) fail-closed seams (R3-1 acceptance 3/4): a custom endpoint without
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
  // (c5) the cc-switch notices (R3-1 acceptance 5): which settings
  //      credentials the channel pin replaces — key names only.
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
  // (d) NO channel connection: the plan stays byte-identical to phase 2 (no
  //     flag layer, no env surgery) — the priority-chain regression guard.
  const legacy = await resolveClaudeAuth({ ...base }, undefined, noSettings)
  check('inject: without a channel the plan is unchanged (no flag layer, env as-is)',
    legacy.settings === undefined && legacy.env.ANTHROPIC_BASE_URL === 'https://stale.example' && legacy.env.ANTHROPIC_API_KEY === 'stale-key' && legacy.source === 'api-key', legacy)
  // (e) the session forwards BOTH layers into the SDK query options.
  const fake = fakeClaudeSdk(() => ({ capabilities: [], models }), controls)
  const session = await openClaudeSession(claudeDeps(fake.sdk, {
    auth: {
      plan,
      renew: () => Promise.resolve(plan),
    },
  }))
  await tick()
  const options = fake.queries[0]!.options as { env?: Record<string, string>; settings?: { env?: Record<string, string> } }
  check('inject: startRun passes the channel env to the child', options.env?.ANTHROPIC_AUTH_TOKEN === 'chan-token' && options.env?.ANTHROPIC_BASE_URL === 'https://relay.example/api', options.env)
  check('inject: startRun passes the flag layer through the SDK settings option', options.settings?.env?.ANTHROPIC_BASE_URL === 'https://relay.example/api' && options.settings?.env?.ANTHROPIC_AUTH_TOKEN === 'chan-token', options.settings)
  await session.dispose()
}

// ---- 11. phase 3: the settings import absorbs the connection ----------------
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

// ---- 11b. R3-5: flag > settings > inherited; the import drops OUR injections --
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
  // The cc-switch loop, end to end: the ACTIVE channel A injects itself at
  // spawn (auth plan flag layer), cc-switch rewrote settings to relay B —
  // "import from settings" must land B, not re-import A.
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

// ---- 12. phase 3: save/remove through the capability (the wizard's seams) ---
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

// ---- 12b. R3-6: tokenRef ownership (rotation reuse, conservative erase) ---
{
  const dir = mkdtempSync(join(tmpdir(), 'dshtui-channels-refs-'))
  const store = fileClaudeChannels(dir)
  const tokens = memoryClaudeChannelTokens()
  // Hand-migrated profiles pointing at foreign-shaped refs, one of them
  // SHARED by a second channel — the shapes the derived-ref-only paths left
  // behind as orphans (R3-6's probe).
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
    // (a) a rotation reuses the row's EXISTING ref: no orphaned credential,
    //     no silent move to the derived ref.
    const rotated = channels.save!({ id: 'legacy-example', name: 'legacy', token: 'rotated-secret' })
    check('refs: a rotation reuses the existing (non-derived) ref in place',
      tokens.read('LEGACY_REF') === 'rotated-secret' && tokens.declared('CHANNEL_LEGACY_EXAMPLE_TOKEN') === false
        && rotated.connection?.hasToken === true && store.read().channels.find(channel => channel.id === 'legacy-example')?.tokenRef === 'LEGACY_REF', { rotated, rows: store.read() })
    // (b) the settings import is a COPY rotating the same ref — settings.json
    //     itself is never touched.
    const imported = channels.importFromSettings()
    check('refs: the import rotates the existing ref and never edits settings.json',
      imported?.connection?.hasToken === true && tokens.read('LEGACY_REF') === 'imported-token'
        && readFileSync(join(envDir, 'settings.json'), 'utf8') === settingsText, imported)
    // (c) removing a channel SHARING a ref keeps it (the sibling still reads).
    check('refs: remove of a ref-sharing channel keeps the shared credential',
      channels.remove!('sibling') === true && tokens.read('SHARED_REF') === 'shared-secret')
    // (d) removing the hand-written-ref channel keeps its (possibly foreign)
    //     credential — only a DERIVED ref is provably ours to erase.
    check('refs: remove keeps a non-derived ref (ownership guard)',
      channels.remove!('legacy-example') === true && tokens.read('LEGACY_REF') === 'imported-token' && store.read().channels.length === 0)
    // (e) the derived-ref channel still erases on remove (the 12th section's
    //     contract, restated as the ownership guard's positive control).
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

// ---- 12c. R3-6 followup: SHARED DERIVED refs never dangle a sibling -------
{
  const dir = mkdtempSync(join(tmpdir(), 'dshtui-channels-shared-derived-'))
  const store = fileClaudeChannels(dir)
  const tokens = memoryClaudeChannelTokens()
  // B points at A's DERIVED ref (a hand edit or migration): the ref is legal
  // and derived-for-A, yet TWO rows reference it. Erasing it on A's account
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
    // (a) clearing A's token detaches the ROW but keeps the credential B
    //     reads — B did nothing wrong and must not be downgraded.
    const cleared = channels.save!({ id: 'a', name: 'A', token: '' })
    check('shared-ref: clearing one row keeps the credential the sibling reads',
      cleared.connection?.hasToken === false
        && store.read().channels.find(channel => channel.id === 'a')?.tokenRef === undefined
        && tokens.read('CHANNEL_A_TOKEN') === 'shared-secret'
        && bRow()?.tokenRef === 'CHANNEL_A_TOKEN',
      { cleared, rows: store.read(), token: tokens.read('CHANNEL_A_TOKEN') })
    // (b) removing A (which re-adopted its derived ref) keeps the credential
    //     B still references — no dangling reference.
    channels.save!({ id: 'a', name: 'A', token: 're-set' })
    check('shared-ref: remove keeps a derived ref another row still references',
      channels.remove!('a') === true && tokens.read('CHANNEL_A_TOKEN') === 're-set'
        && bRow()?.tokenRef === 'CHANNEL_A_TOKEN' && tokens.declared('CHANNEL_A_TOKEN'),
      { rows: store.read(), token: tokens.read('CHANNEL_A_TOKEN') })
    // (c) the LAST referent clears -> the credential dies with it (the
    //     un-shared positive control of the clear path's guard). B never had
    // a baseUrl, so the cleared row is mapping-only: no connection slice.
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

// ---- 13. phase 3: same connection vs restart --------------------------------
{
  const conn = (fingerprint: string, baseUrl?: string) => ({ baseUrl, hasToken: true, envKeys: [] as string[], fingerprint })
  const row = (id: string, connection?: ReturnType<typeof conn>) => ({ id, name: id, models: [], tiers: [], ...(connection === undefined ? {} : { connection }) })
  check('restart: equal fingerprints are the same connection (no restart)',
    sameOptionConnection(row('a', conn('fp1')), row('b', conn('fp1'))) === true)
  check('restart: a token rotation changes the fingerprint (restart)',
    sameOptionConnection(row('a', conn('fp1')), row('a', conn('fp2'))) === false)
  check('restart: mapping-only channels are the same connection',
    sameOptionConnection(row('a'), row('b')) === true)
  check('restart: mapping-only vs connected differs (restart)',
    sameOptionConnection(row('a'), row('b', conn('fp1'))) === false)
  check('restart: the backend comparator agrees on the profile level',
    sameChannelConnection({ baseUrl: 'https://x', tokenRef: 'R', env: { A: '1' } }, { baseUrl: 'https://x', tokenRef: 'R', env: { A: '1' } }) === true
    && sameChannelConnection({ baseUrl: 'https://x', tokenRef: 'R' }, { baseUrl: 'https://x', tokenRef: 'R', env: { A: '1' } }) === false)
}

// ---- 14. phase 3: the wizard, headless (scripted answers) -------------------
{
  const store = memoryClaudeChannels({ channels: [] })
  const tokens = memoryClaudeChannelTokens()
  const saveCalls: string[] = []
  const deps = {
    ask: async (request: { questions: { id: string }[] }, options?: { redact?: boolean }) => {
      const id = request.questions[0]!.id
      const answerFor: Record<string, { selected?: string[]; custom?: string }> = {
        action: { selected: ['__add__'] },
        name: { custom: 'ZhiPu' },
        baseurl: { custom: 'https://open.bigmodel.cn/api/anthropic' },
        token: { custom: 'wiz-secret' },
        tiers: { selected: ['__skip__'] },
        switch: { selected: ['__no__'] },
      }
      return { answers: [{ id, ...answerFor[id]! }] } as never
    },
    notify: () => undefined,
    pushLocal: () => undefined,
    roster: () => {
      const rows = store.read().channels.map(channel => ({
        id: channel.id, name: channel.name, models: [], tiers: [],
        ...(channel.baseUrl === undefined && channel.tokenRef === undefined ? {} : {
          connection: {
            ...(channel.baseUrl === undefined ? {} : { baseUrl: channel.baseUrl }),
            hasToken: channel.tokenRef !== undefined,
            envKeys: Object.keys(channel.env ?? {}),
            fingerprint: channel.baseUrl + ':' + String(channel.tokenRef),
          },
        }),
      }))
      return { channels: rows, activeId: store.read().active }
    },
    save: (input: { id: string; name: string; baseUrl?: string; token?: string }) => {
      saveCalls.push(input.id)
      const ref = channelTokenRef(input.id)
      if (input.token !== undefined) tokens.write(ref, input.token)
      store.save({
        id: input.id, name: input.name,
        ...(input.baseUrl === undefined ? {} : { baseUrl: input.baseUrl }),
        ...(input.token === undefined ? {} : { tokenRef: ref }),
      })
      return deps.roster().channels.find(row => row.id === input.id)
    },
    remove: (id: string) => { store.remove(id); return true },
    activate: (id: string) => { store.setActive(id); return true },
    peekSettings: () => ({ baseUrl: 'https://open.bigmodel.cn/api/anthropic', tiers: { opus: 'glm-5.3[1M]' } }),
  }
  // The option labels come from i18n; the fake answers above return sentinels
  // that match nothing, so patch t() indirectly: the wizard compares selected
  // against t(...) — sentinels never match except where we map them. Drive the
  // happy path by answering the REAL labels instead.
  const { t } = await import('../src/i18n.js')
  const pick: Record<string, string[]> = {
    action: [t('channel-wiz-opt-add')],
    tiers: [t('channel-wiz-opt-tiers-skip')],
    switch: [t('channel-wiz-opt-switch-no')],
  }
  const custom: Record<string, string> = { name: 'ZhiPu', baseurl: 'https://open.bigmodel.cn/api/anthropic', token: 'wiz-secret' }
  deps.ask = async (request: { questions: { id: string }[] }) => {
    const id = request.questions[0]!.id
    return { answers: [{ id, ...(pick[id] === undefined ? { custom: custom[id] ?? '' } : { selected: pick[id]! }) }] } as never
  }
  const outcome = await runChannelWizard(deps as never)
  const landed = store.read().channels[0]
  check('wizard: the add flow saves the channel with its connection',
    outcome.kind === 'saved' && landed?.id === 'zhipu' && landed?.baseUrl === 'https://open.bigmodel.cn/api/anthropic' && landed?.tokenRef === 'CHANNEL_ZHIPU_TOKEN', { outcome, landed })
  check('wizard: the token reached the credential seam only', tokens.read('CHANNEL_ZHIPU_TOKEN') === 'wiz-secret' && !JSON.stringify(landed).includes('wiz-secret'))
  // Same connection switch → no restart; different → restart.
  check('wizard: the comparator drives the restart flag', sameOptionConnection(deps.roster().channels[0], deps.roster().channels[0]) === true)
}

// ---- 14b. R3-2: delete/overwrite of the ACTIVE connection restarts ---------
{
  const { t } = await import('../src/i18n.js')
  /** In-memory wizard harness whose roster rows carry REAL-shaped
   * fingerprints (endpoint + ref + stored token, like controls.ts's
   * connectionFingerprint — a token rotation changes the fingerprint). */
  const harness = (initial: { active?: string; channels: readonly { id: string; name: string; baseUrl?: string; tokenRef?: string }[] }) => {
    const store = memoryClaudeChannels({ channels: [...initial.channels], ...(initial.active === undefined ? {} : { active: initial.active }) })
    const tokens = memoryClaudeChannelTokens()
    const rowOf = (channel: { id: string; name: string; baseUrl?: string; tokenRef?: string }) => ({
      id: channel.id, name: channel.name, models: [], tiers: [],
      ...(channel.baseUrl === undefined && channel.tokenRef === undefined ? {} : {
        connection: {
          ...(channel.baseUrl === undefined ? {} : { baseUrl: channel.baseUrl }),
          hasToken: channel.tokenRef !== undefined && tokens.declared(channel.tokenRef),
          envKeys: [] as string[],
          fingerprint: [channel.baseUrl ?? '', channel.tokenRef ?? '', channel.tokenRef === undefined ? '' : tokens.read(channel.tokenRef) ?? ''].join('/'),
        },
      }),
    })
    const wire = (answer: (id: string) => { selected?: string[]; custom?: string }) => ({
      ask: async (request: { questions: { id: string }[] }) => {
        const id = request.questions[0]!.id
        return { answers: [{ id, ...answer(id) }] } as never
      },
      notify: () => undefined,
      pushLocal: () => undefined,
      roster: () => ({ channels: store.read().channels.map(rowOf), activeId: store.read().active }),
      // The capability's save semantics (controls.ts): undefined fields keep
      // the current row's values; a token rotates the stored ref in place.
      save: (input: { id: string; name: string; baseUrl?: string; token?: string }) => {
        const current = store.read().channels.find(channel => channel.id === input.id)
        let ref = current?.tokenRef
        if (input.token !== undefined && input.token !== '') {
          ref = ref ?? channelTokenRef(input.id)
          tokens.write(ref, input.token)
        }
        store.save({
          id: input.id, name: input.name,
          ...(input.baseUrl === undefined ? { ...(current?.baseUrl === undefined ? {} : { baseUrl: current.baseUrl }) } : input.baseUrl === '' ? {} : { baseUrl: input.baseUrl }),
          ...(ref === undefined ? {} : { tokenRef: ref }),
        })
        return wire(undefined as never).roster().channels.find(row => row.id === input.id)
      },
      remove: (id: string) => { const had = store.read().channels.some(channel => channel.id === id); store.remove(id); return had },
      activate: (id: string) => { store.setActive(id); return true },
      peekSettings: () => undefined,
    })
    const deps = (selected: Record<string, string[]>, custom: Record<string, string> = {}) =>
      wire((id: string) => (selected[id] === undefined ? { custom: custom[id] ?? '' } : { selected: selected[id]! }))
    return { store, tokens, deps }
  }
  // (a) deleting the ACTIVE channel WITH a connection restarts (R3-2): the
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
  // (b) a mapping-only ACTIVE row never shaped the spawn → no restart.
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
  // (c) deleting an INACTIVE connected channel leaves the running row alone.
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
  // (d) the add flow overwriting the ACTIVE row (same name → same id) with a
  //     rotated token, then DECLINING the switch: the disk connection changed
  //     under the running child — restart anyway (R3-2/R3-4).
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

// ---- 14c. R3-4: an add colliding with another channel's id confirms ------
{
  const { t } = await import('../src/i18n.js')
  // The slug folds every non-alphanumeric name the same way: both Chinese
  // names derive id `channel` (the report's collision probe).
  check('clash: two non-alphanumeric names collide on one id', channelSlug('智谱') === channelSlug('硅基流动') && channelSlug('智谱') === 'channel')
  const h = () => {
    const store = memoryClaudeChannels({ active: 'channel', channels: [
      { id: 'channel', name: '智谱', baseUrl: 'https://open.bigmodel.cn/api/anthropic', tokenRef: 'CHANNEL_CHANNEL_TOKEN' },
    ] })
    const tokens = memoryClaudeChannelTokens({ CHANNEL_CHANNEL_TOKEN: 'zhipu-secret' })
    let saved = 0
    const deps = (selected: Record<string, string[]>, custom: Record<string, string> = {}) => ({
      ask: async (request: { questions: { id: string }[] }) => {
        const id = request.questions[0]!.id
        return { answers: [{ id, ...(selected[id] === undefined ? { custom: custom[id] ?? '' } : { selected: selected[id]! }) }] } as never
      },
      notify: () => undefined,
      pushLocal: () => undefined,
      roster: () => ({
        channels: store.read().channels.map(channel => ({
          id: channel.id, name: channel.name, models: [], tiers: [],
          ...(channel.baseUrl === undefined ? {} : {
            connection: { baseUrl: channel.baseUrl, hasToken: channel.tokenRef !== undefined, envKeys: [] as string[], fingerprint: [channel.baseUrl ?? '', channel.tokenRef ?? '', channel.tokenRef === undefined ? '' : tokens.read(channel.tokenRef) ?? ''].join('/') },
          }),
        })),
        activeId: store.read().active,
      }),
      save: (input: { id: string; name: string; baseUrl?: string; token?: string }) => {
        saved += 1
        tokens.write(channelTokenRef(input.id), input.token ?? 'kept')
        store.save({ id: input.id, name: input.name, ...(input.baseUrl === undefined ? {} : { baseUrl: input.baseUrl }), tokenRef: channelTokenRef(input.id) })
        return deps({} as never).roster().channels.find(row => row.id === input.id)
      },
      remove: (id: string) => { store.remove(id); return true },
      activate: (id: string) => { store.setActive(id); return true },
      peekSettings: () => undefined,
    })
    return { store, tokens, deps, savedCalls: () => saved }
  }
  // (a) declining the overwrite writes NOTHING (R3-4's zero-write bar).
  {
    const c = h()
    const outcome = await runChannelWizard(c.deps({
      action: [t('channel-wiz-opt-add')],
      clash: [t('channel-wiz-opt-clash-cancel')],
    }, { name: '硅基流动' }) as never)
    const row = c.store.read().channels[0]
    check('clash: declining the overwrite writes nothing',
      outcome.kind === 'cancelled' && outcome.restart === false && c.savedCalls() === 0
        && c.store.read().channels.length === 1 && row?.name === '智谱' && row?.baseUrl === 'https://open.bigmodel.cn/api/anthropic'
        && c.tokens.read('CHANNEL_CHANNEL_TOKEN') === 'zhipu-secret', { outcome, row })
  }
  // (b) confirming the overwrite saves — and because the clobbered row is
  //     ACTIVE with a changed connection, the funnel is owed (R3-2 link).
  {
    const c = h()
    const outcome = await runChannelWizard(c.deps({
      action: [t('channel-wiz-opt-add')],
      clash: [t('channel-wiz-opt-clash-overwrite')],
      switch: [t('channel-wiz-opt-switch-no')],
    }, { name: '硅基流动', baseurl: 'https://siliconflow.example/v1', token: 'sf-secret' }) as never)
    const row = c.store.read().channels[0]
    check('clash: confirming the overwrite replaces the row and restarts the active connection',
      outcome.kind === 'saved' && outcome.restart === true && row?.name === '硅基流动' && row?.baseUrl === 'https://siliconflow.example/v1'
        && c.tokens.read('CHANNEL_CHANNEL_TOKEN') === 'sf-secret', { outcome, row })
  }
  // (c) re-adding the SAME-named channel is the edit path — no clash gate.
  {
    const c = h()
    const outcome = await runChannelWizard(c.deps({
      action: [t('channel-wiz-opt-add')],
      switch: [t('channel-wiz-opt-switch-no')],
    }, { name: '智谱', baseurl: 'https://open.bigmodel.cn/api/anthropic' }) as never)
    check('clash: re-adding the same-named channel never trips the clash gate',
      outcome.kind === 'saved' && c.savedCalls() === 1, outcome)
  }
}

// ---- 15. wiring tripwires (source-level) ------------------------------------
{
  const { readFileSync: readSrc } = await import('node:fs')
  const readRepo = (rel: string): string => readSrc(new URL(rel, import.meta.url), 'utf8')
  const chatSrc = readRepo('../src/screens/Chat.tsx')
  check('tripwire: Chat runs the wizard from the add/manage rows', chatSrc.includes('runChannelWizard({') && chatSrc.includes("{ kind: 'add' }") && chatSrc.includes("{ kind: 'manage' }"))
  check('tripwire: Chat routes a connection change through the fresh-session funnel', chatSrc.includes('onRestartFreshSession(t(\'channel-switch-restart\'') && chatSrc.includes('sameOptionConnection(before, row.option)'))
  check('tripwire: Chat routes an import that changes the ACTIVE connection through the funnel (R3-2)',
    chatSrc.includes('before.id === imported.id') && chatSrc.includes('sameOptionConnection(before, imported)'))
  const pluginSrc = readRepo('../src/dsh-adapter/plugin.ts')
  check('tripwire: the composition root wires the funnel reusing the backend-switch branch',
    pluginSrc.includes('onRestartFreshSession: restartFreshSession') && pluginSrc.includes('backendSwitchRequested = backendChoice'))
  const authSrc = readRepo('../src/backends/claude/auth.ts')
  check('tripwire: the auth plan pins the channel connection in the flag layer', authSrc.includes('settings: { env: pinned }'))
  const actionsSrc = readRepo('../src/dsh-adapter/channel/core/actions.ts')
  check('tripwire: the channel actions delegate saveChannel/removeChannel/peekChannelImport',
    actionsSrc.includes('saveChannel: input =>') && actionsSrc.includes('removeChannel: id =>') && actionsSrc.includes('peekChannelImport: () =>'))
}

// ---- 16. R3-1: fail-closed refusals through the real backend.open ---------
//
// The unit checks above cover the predicates; this drives the WIRING: an
// isolated child process (temp HOME/USERPROFILE/CLAUDE_CONFIG_DIR/DSH_HOME,
// every ANTHROPIC_*/CLAUDE_CODE_* ambient variable scrubbed before the first
// import) imports the real backend and opens a session with (a) an active
// tokenless custom-endpoint channel and (b) a token channel under a settings
// apiKeyHelper. Both opens must REJECT with the actionable sentence — never
// spawn (the "CLI" is node itself, which exits at once on the SDK's args),
// never leak the synthetic token or helper material.
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

// ---- 17. R3-1: the outbound credential matrix (real CLI, loopback) --------
//
// The shape checks say the flag layer CARRIES the blanks; this proves what
// the blanks DO against the really-installed CLI (the SDK's bundled native
// binary — the one production ships): the isolated user settings hold an
// OLD credential sentinel on one of the three keys (plus an old base URL,
// the cc-switch shape), the active channel points at a 127.0.0.1 listener,
// and NO outbound request may carry the old sentinel — with a token, only
// the channel sentinel travels; tokenless, the requests are anonymous
// (production refuses to spawn that shape at all; this proves the pin
// holds even for it). One CONTROL cell first: the same settings with the
// listener URL and NO channel — the sentinel MUST arrive, proving both
// that the CLI applies user settings env over the child env (the R3-1
// mechanism) and that the listener detects sentinels (otherwise every
// "absent" below is vacuous). Isolation per cell: fresh HOME/USERPROFILE/
// CLAUDE_CONFIG_DIR, a child env built from zero (PATH/SystemRoot/telemetry
// flags only), the listener answers 401 so no turn ever succeeds, and only
// booleans/counts leave the listener — never a header or body. Skipped
// LOUDLY (never silently green) when the SDK or its bundled CLI is absent.
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
      const cell = async (label: string, settingsEnv: Record<string, string>, mode: 'control' | { readonly token?: string }): Promise<void> => {
        const home = join(root, label)
        const config = join(home, 'config')
        const cwd = join(home, 'cwd')
        mkdirSync(config, { recursive: true })
        mkdirSync(cwd, { recursive: true })
        let seenOld = false
        let seenChannel = false
        let requests = 0
        // Early finish (the report's methodology): once a credential-bearing
        // request was observed a few times over, the process's fixed merged
        // credentials have spoken — keep waiting only for the cap otherwise.
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
        // The synthetic user settings (written AFTER the listener exists —
        // the control's base URL is the listener's own dynamic port).
        writeFileSync(join(config, 'settings.json'), JSON.stringify({
          env: Object.fromEntries(Object.entries(settingsEnv).map(([key, value]) => [key, value === 'LOOPBACK' ? loopbackUrl : value])),
        }))
        // The child env is built from ZERO (the SDK's `env` option replaces
        // the child environment): only PATH, SystemRoot, the telemetry
        // kill-switches and the isolated home/config pointers — nothing of
        // the host's identity or credentials is inherited.
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
        const query = sdk.query({
          prompt: 'loopback probe: reply with the single word ok',
          options: {
            cwd,
            env: plan === undefined ? base : plan.env,
            ...(plan?.settings === undefined ? {} : { settings: plan.settings }),
            settingSources: ['user'],
            permissionMode: 'default',
            model: 'haiku',
            maxTurns: 1,
            abortController: abort,
            stderr: () => undefined,
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
                // The CLI died on our 401s — the observed window is the verdict.
              }
            })(),
            early,
            new Promise<void>(resolve => { setTimeout(resolve, CELL_MS) }),
          ])
        } finally {
          abort.abort()
          try { await Promise.race([query.close().catch(() => undefined), new Promise(resolve => { setTimeout(resolve, 5000) })]) } catch { /* already gone */ }
          await new Promise<void>(resolve => server.close(() => resolve()))
        }
        console.log(`loopback ${label}: requests=${requests} old=${seenOld} channel=${seenChannel} in ${Date.now() - started}ms`)
        if (mode === 'control') {
          // The negative/positive control: the settings credential DOES
          // reach the listener without any channel pin — the R3-1 leak
          // mechanism itself, and the proof that absence below is meaningful.
          check(`loopback control: the settings credential reaches the listener (the leak mechanism is real and detectable)`,
            requests > 0 && seenOld && !seenChannel, { requests })
          return
        }
        check(`loopback ${label}: no outbound request carries the OLD settings sentinel`, requests > 0 && !seenOld, { requests })
        if (mode.token !== undefined) check(`loopback ${label}: the channel token is the credential that travels`, seenChannel)
      }
      // The control, then the six-cell matrix: tokenless/token × the three
      // credential keys cc-switch could have left in user settings.
      await cell('control', { ANTHROPIC_BASE_URL: 'LOOPBACK', ANTHROPIC_AUTH_TOKEN: OLD_SENTINEL }, 'control')
      for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN']) {
        await cell(`tokenless-${key}`, { ANTHROPIC_BASE_URL: 'https://old.invalid', [key]: OLD_SENTINEL }, {})
        await cell(`token-${key}`, { ANTHROPIC_BASE_URL: 'https://old.invalid', [key]: OLD_SENTINEL }, { token: CHANNEL_SENTINEL })
      }
    } finally {
      // The cleanup guard (the report's methodology): only ever remove the
      // directory this run created under tmpdir, by exact prefix — retrying
      // the Windows EPERM window where a just-killed CLI still holds a
      // handle (channels.ts's renameIntoPlace retry pattern).
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
