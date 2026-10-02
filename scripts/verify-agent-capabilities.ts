/**
 * 能力解析层回归（`src/dsh-adapter/channel/capabilities.ts`）：
 * 用假 registry / 假服务注入，不依赖真 preset 或真组合，钉住四类判定——
 *   1. 注册表有 `compact` 而本地压缩服务缺席 → 走注册表命令；
 *   2. 本地压缩服务在场 → 永远优先本地事务（注册表命令也在也一样，
 *      官方 handler 没有 tui/compact 决策事件、进度行、Esc 取消与切换 settle）；
 *   3. 两者皆无 → 报 `none` 且带**原因**（i18n 文案不是键名本身），
 *      命令列表里该条目被标注为不可用（仍是可分发的条目，不能静默转投模型）；
 *   4. 自定义 preset 自适应：能力来自活服务的 scope 链读取，不来自 preset id
 *      清单（唯一的 preset id 读取是官方 Minimal 的 ask_user_question 剥离，
 *      由 verify:minimal-preset-tools 固定）。
 * 另钉住唯一性：Chat 的 /compact、/plan 与 mode-actions 的 plan 判定都吃同一份事实。
 * 运行：node --import tsx/esm scripts/verify-agent-capabilities.ts
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { LOCAL_COMMANDS, localizedDescription } from '../src/commands.js'
import { createChannel } from '../src/dsh-adapter/channel.js'
import {
  agentCapabilityEvidence,
  annotateCommandCapabilities,
  resolveAgentCapabilities,
  type CapabilityEvidence,
} from '../src/dsh-adapter/channel/capabilities.js'
import { setLang, t } from '../src/i18n.js'

let checks = 0
const ok = (condition: unknown, message: string): void => {
  assert.ok(condition, message)
  checks += 1
}

/** One fake composition: which services are mounted, which commands registered. */
function fixture(options: {
  services?: readonly string[]
  tools?: readonly string[]
  commands?: readonly string[]
  presetId?: string
} = {}): CapabilityEvidence {
  const services = new Set(options.services ?? [])
  const tools = new Set(options.tools ?? [])
  const commands = new Set(options.commands ?? [])
  const agent = { id: 'fixture-agent', session: { header: {}, events: [] } }
  return {
    agent: agent as never,
    commandService: {
      find: (_agent: unknown, name: string) => (commands.has(name) ? { name } : undefined),
    } as never,
    service: key =>
      services.has(key) ? (key === 'compaction' ? { compactNow(): void {} } : {}) : undefined,
    toolPresent: name => tools.has(name),
    presetId: options.presetId,
  }
}

/**
 * A real Channel over a fake composition, to observe the one-time capability
 * notice a bind publishes. `services` is the flat set of mounted services;
 * nothing else is wired, which is exactly the degrading composition the notice
 * is about.
 */
function bindFixtureChannel(presetId: string | undefined, services: readonly string[]) {
  const mounted = new Set(services)
  const ctx = {
    get(name: string) {
      if (name === 'agentPresets') {
        return {
          defaultId: 'standard',
          list: async () => [],
          resolve: async (id: string) => ({ id, trust: 'system' }),
          mount: async () => ({}),
          recompose: async (id: string) => ({ id, trust: 'system' }),
        }
      }
      return mounted.has(name) ? (name === 'compaction' ? { compactNow(): void {} } : {}) : undefined
    },
    on: () => () => undefined,
    logger: { warn(): void {} },
  }
  const agent = {
    id: 'gap-agent',
    status: 'idle',
    session: {
      id: 'gap-session',
      seq: 0,
      ...(presetId === undefined ? {} : { header: { agentPreset: presetId } }),
      events: [],
    },
    ctx: { on: () => () => undefined },
    followup: () => undefined,
    steer: () => undefined,
  }
  return createChannel(
    ctx as never,
    agent as never,
    { model: 'model', provider: 'provider', cwd: '/tmp', activity: false },
  )
}

// ── 1/2. `/compact` 的路由：本地服务在场即本地；只有注册表命令时走注册表 ──
const bothMounted = resolveAgentCapabilities(fixture({
  services: ['compaction'],
  commands: ['compact'],
}))
ok(bothMounted.compact.route === 'local', 'a mounted compaction service keeps /compact on the TUI transaction')
ok(bothMounted.compaction === true, 'compaction fact follows the service')

const localOnly = resolveAgentCapabilities(fixture({ services: ['compaction'] }))
ok(localOnly.compact.route === 'local', 'no registry command still runs the local /compact')

const registryOnly = resolveAgentCapabilities(fixture({ commands: ['compact'] }))
ok(registryOnly.compact.route === 'registry', 'a registry /compact is the fallback when the local service is absent')
ok(registryOnly.compaction === false, 'a registry command alone is not a compaction service')

// ── 3. 两者皆无：带原因的不可用，且 Help/补全条目标注出来 ──
const neither = resolveAgentCapabilities(fixture())
ok(neither.compact.route === 'none', '/compact with neither route reports none')
assert.equal(neither.compact.route === 'none' ? neither.compact.reasonKey : undefined, 'capability-reason-no-compaction')
ok(neither.plan.route === 'none', '/plan without the registry command reports none')
assert.equal(neither.plan.route === 'none' ? neither.plan.reasonKey : undefined, 'capability-reason-no-plan-command')
ok(neither.questionTool === false, 'no host ask tool in the catalog means no questionnaire')
ok(neither.pruner === false && neither.skills === false, 'absent services are reported absent')

for (const [lang, marker] of [['zh', '压缩'], ['en', 'compaction']] as const) {
  setLang(lang)
  for (const capability of [neither.compact, neither.plan]) {
    assert.ok(capability.route === 'none')
    const reason = t(capability.reasonKey)
    ok(reason.length > 0 && reason !== capability.reasonKey, `${lang}: the reason resolves to copy, not the key`)
    const message = t('capability-unavailable', { name: 'compact', reason })
    ok(message.includes('compact') && message.includes(reason), `${lang}: the refusal names the command and the reason`)
    ok(message !== 'capability-unavailable', `${lang}: the refusal template resolves`)
  }
  const annotated = annotateCommandCapabilities(LOCAL_COMMANDS, neither)
  const entry = annotated.find(command => command.name === 'compact')
  assert.ok(entry !== undefined, 'the annotated list keeps /compact dispatchable')
  ok(
    entry.descriptionKey === 'cmd-desc-compact-unavailable',
    `${lang}: the unavailable entry points at the marked description`,
  )
  const described = localizedDescription(entry)
  ok(described.length > 0 && described !== 'cmd-desc-compact-unavailable', `${lang}: the marked description resolves`)
  ok(
    lang === 'zh' ? described.includes('不可用') : described.includes('unavailable'),
    `${lang}: the marked description states unavailability: ${described}`,
  )
  ok(described.includes(marker), `${lang}: the marked description keeps the reason visible`)
  const clear = annotated.find(command => command.name === 'clear')
  ok(clear === LOCAL_COMMANDS.find(command => command.name === 'clear'), `${lang}: untouched entries keep their identity`)
}
setLang('zh')
assert.equal(LOCAL_COMMANDS.some(command => command.name === 'compact'), true, '/compact stays a declared local command')
assert.equal(LOCAL_COMMANDS.some(command => command.name === 'plan'), false, '/plan is advertised only when the registry serves it')

// Available capabilities leave the list byte-identical (no copy, nothing marked).
const availableList = [{ name: 'compact', description: 'Summarize earlier turns to free context space' }]
ok(
  annotateCommandCapabilities(availableList, bothMounted) === availableList,
  'an available command list is returned unchanged',
)
ok(
  annotateCommandCapabilities(availableList, neither)[0]?.descriptionKey === 'cmd-desc-compact-unavailable',
  'an unavailable command list is re-described',
)
ok(availableList[0]?.descriptionKey === undefined, 'annotation never mutates the input list')

// ── 4. 自定义 preset 自适应（能力来自事实，不来自 preset id 清单）──
const custom = resolveAgentCapabilities(fixture({
  services: ['compaction', 'toolResultPruner', 'skills'],
  tools: ['ask_user_question'],
  commands: ['compact', 'plan'],
  presetId: 'my-preset',
}))
ok(custom.compaction === true && custom.pruner === true, 'a user preset that adds the services back gets them')
ok(custom.questionTool === true && custom.skills === true, 'a user preset keeps the host questionnaire and skills')
ok(custom.compact.route === 'local' && custom.plan.route === 'registry', 'a user preset resolves both routes')
ok(
  annotateCommandCapabilities(LOCAL_COMMANDS, custom).find(command => command.name === 'compact')?.descriptionKey === undefined,
  'a fully capable user preset leaves /compact unmarked',
)

// The ONE preset-id read: the official Minimal ask_user_question carve-out. It
// is a tool-catalog filter, so it must not touch any other fact.
const minimalWithServices = resolveAgentCapabilities(fixture({
  services: ['compaction', 'toolResultPruner'],
  tools: ['ask_user_question'],
  commands: ['compact'],
  presetId: 'minimal',
}))
ok(minimalWithServices.questionTool === false, 'the official Minimal preset hides the host questionnaire')
ok(minimalWithServices.compaction === true && minimalWithServices.pruner === true, 'the carve-out reads no other fact')
const minimalLike = resolveAgentCapabilities(fixture({
  tools: ['ask_user_question'],
  presetId: 'minimal-deep',
}))
ok(minimalLike.questionTool === true, 'only the official id is carved out, not a name prefix')

// ── 活服务读取走 agent 的 scope 链（serviceForAgent），根上下文缺席也算在场 ──
const scopedService = { compactNow(): void {} }
const scopeCtx = {
  get(name: string) {
    if (name === 'agentPresets') {
      return {
        defaultId: 'standard',
        list: async () => [],
        resolve: async (id: string) => ({ id, trust: 'system' }),
        mount: async () => ({}),
        recompose: async (id: string) => ({ id, trust: 'system' }),
        serviceFor: (_agent: unknown, key: string) => (key === 'compaction' ? scopedService : undefined),
      }
    }
    return undefined
  },
  logger: { warn(): void {} },
}
const scopedAgent = { id: 'scoped', session: { header: { agentPreset: 'standard' }, events: [] } }
const scopedCaps = resolveAgentCapabilities(agentCapabilityEvidence(scopeCtx as never, scopedAgent as never))
ok(scopedCaps.compact.route === 'local', 'a preset-realm compaction service is seen through the scope chain')
ok(scopedCaps.pruner === false, 'an unmounted pruner stays absent through the scope chain')

const rootCtx = {
  get(name: string) {
    if (name === 'compaction') return { compactNow(): void {} }
    if (name === 'commands') return { find: (_agent: unknown, cmd: string) => (cmd === 'plan' ? { name: cmd } : undefined) }
    return undefined
  },
  logger: { warn(): void {} },
}
const rootCaps = resolveAgentCapabilities(agentCapabilityEvidence(rootCtx as never, scopedAgent as never))
ok(rootCaps.compact.route === 'local', 'a rosterless composition still reads the root context')
ok(rootCaps.plan.route === 'registry', 'the root registry answers /plan without a roster')

// ── 单一口径：三个调用点吃同一份事实，重复判定已删 ──
const chatSource = readFileSync(new URL('../src/screens/Chat.tsx', import.meta.url), 'utf8')
ok(chatSource.includes('channel.capabilities().compact'), 'Chat dispatches /compact through the capability facts')
ok(chatSource.includes('channel.capabilities().plan'), 'Chat dispatches /plan through the capability facts')
ok(
  chatSource.includes("t('capability-unavailable', { name: 'compact'"),
  'Chat refuses /compact with the capability reason',
)
const modeSource = readFileSync(new URL('../src/dsh-adapter/channel/mode-actions.ts', import.meta.url), 'utf8')
ok(!modeSource.includes("commandService?.find(agent, 'plan')"), 'mode-actions no longer keeps its own /plan lookup')
ok(modeSource.includes('resolveAgentCapabilities('), 'mode-actions reads the shared capability facts')

// ── 进入/恢复一个缺能力的 preset：一次后果告知，且按缺什么选文案 ──
for (const [presetId, services, expected] of [
  ['minimal', [], 'capability-gap-compaction-pruner'],
  ['minimal', ['compaction'], 'capability-gap-pruner'],
  ['minimal', ['toolResultPruner'], 'capability-gap-compaction'],
  ['minimal', ['compaction', 'toolResultPruner'], undefined],
  ['standard', ['compaction'], 'capability-gap-pruner'],
  [undefined, [], undefined],
] as const) {
  const channel = bindFixtureChannel(presetId, services)
  const label = `${presetId ?? '(no preset)'} + [${services.join(',')}]`
  if (expected === undefined) {
    ok(channel.notifications.length === 0, `${label}: no capability gap is announced`)
  } else {
    ok(channel.notifications.length === 1, `${label}: exactly one gap notice`)
    ok(channel.notifications[0]?.text === t(expected), `${label}: the notice names what is missing`)
    ok(channel.notifications[0]?.color === 'warning', `${label}: the notice is a warning`)
  }
  channel.releaseContributions()
}

// ── 标注必须真的挂在「已发布」的命令表上（红队盲点 N4b）─────────────────
// 只断言纯函数 annotateCommandCapabilities 的输出是不够的：把接线删掉（构造时
// 不标注、或刷新时不标注），上面所有断言仍然全绿，而用户看到的 Help 里
// `/compact` 又变回「看起来可用」。这里从 bind 出来的真实 channel 上读
// `commandList`，并要求正反两侧都对。
{
  const unavailable = bindFixtureChannel(undefined, [])
  const compactEntry = unavailable.commandList.find(command => command.name === 'compact')
  ok(
    compactEntry?.descriptionKey === 'cmd-desc-compact-unavailable',
    'the published command list annotates /compact when no route exists',
  )
  unavailable.releaseContributions()

  const available = bindFixtureChannel('standard', ['compaction'])
  // `some(...)` 而不是 `find(...)?.`：条目整个消失时可选链会得到 undefined，
  // 断言照样为真——那正是这条要防的回归。
  ok(
    available.commandList.some(command => command.name === 'compact' && command.descriptionKey === undefined),
    'the published command list leaves /compact unannotated when the local route exists',
  )
  available.releaseContributions()

  // 刷新路径（skill catalog 的 setCommands 回调）同样必须经过标注：删掉那一行
  // 不会被任何既有门禁拦住，所以在这里按源码钉住这条接线。
  const source = readFileSync(new URL('../src/dsh-adapter/channel.ts', import.meta.url), 'utf8')
  ok(
    source.includes('annotateCommandCapabilities(commands, capabilitiesOf())'),
    'the command-list refresh path annotates through the shared capability facts',
  )
}

console.log(`agent capability resolution OK (${checks} checks)`)
