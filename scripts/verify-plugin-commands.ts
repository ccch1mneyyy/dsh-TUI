/**
 * 批 5 电池（二）：commands 契约对齐（C-041）。
 *
 *   A. 真实依赖映射：真 dsh-commands 重复注册抛出的纯文案 Error 经
 *      mapCommandError 后带 code=DUPLICATE_CONTRIBUTION_ID（原名/原文/
 *      cause 保留）；
 *   B. 文案变体与透传：两种已知重复文案都映射；非重复 Error 与非 Error
 *      值原样透传（同一引用）；
 *   C. hasCommandErrorCode 判定面；
 *   D. withCommandErrorMapping：成功透传、重复重抛带码、其他重抛原引用；
 *   E. 契约错误码词表恰好 6 个；
 *   F. invoke 检查点门语义：denies 撤销 commands.invoke 后 root 被拒；
 *      默认 allow；他人 denies 不影响 root；
 *   G. channel 接线断言：检查点在 execute 之前、deny 文案走 i18n、skill
 *      注册 catch 映射并台账记录（applied/failed）、invoke deny 台账；
 *   H. 非破坏签名：四个托管服务 register 系方法不传 identity 照旧返回
 *      disposer（看护挂钩零行为变化）；
 *   I. 被遮蔽命令可达：`/<pluginId>:<name>` 语法与目录解析（其余冒号行仍是
 *      文本）、被本地遮蔽的已归属命令只以限定名列出且 register() 当即可见、
 *      未遮蔽命令只列裸名但限定名可执行、未归属/不可作命名空间的遮蔽进
 *      /plugin 诊断、插件互撞只到各自 owner、限定名与裸名同一 invoke 路径
 *      （同参数与图片）且 owner/root deny 同样拦下；pluginId 走共享命名空间
 *      语法（pluginIdentity.ts）：反向域名 manifest id（com.example.echo）与旧
 *      短名都可作命名空间，畸形写法（com..x、Com.x、x.）仍是文本。
 *
 * HOME/USERPROFILE 在导入 src 前隔离。
 *
 * Run via `node --import tsx/esm scripts/verify-plugin-commands.ts`.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { compositionAndCoreSource } from './lib/channel-composition.mjs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// ── 隔离 HOME（必须先于任何 src 导入）─────────────────────────────────────
const fakeHome = mkdtempSync(join(tmpdir(), 'dsh-plugin-commands-home-'))
process.env.HOME = fakeHome
process.env.USERPROFILE = fakeHome
process.env.DSH_TUI_LANG = 'zh'
process.env.DSH_TUI_ADAPTER_MODE = 'new'

const { Context } = await import('@deepseek-ai/cordis')
const { default: CommandRuntime } = await import('@deepseek-ai/dsh-commands')
const { createScope } = await import('@deepseek-ai/dsh-scope')
const {
  COMMAND_ERROR_CODES,
  hasCommandErrorCode,
  mapCommandError,
  withCommandErrorMapping,
} = await import('../src/dsh-adapter/command-errors.js')
const { parseGrantStore } = await import('../src/adapter/standard/grants.js')
const { TuiStatusRuntime } = await import('../src/dsh-adapter/status.js')
const { default: TuiShortcutRuntime } = await import('../src/dsh-adapter/shortcuts.js')
const { TuiSceneRuntime } = await import('../src/dsh-adapter/scenes.js')
const { TuiRendererRuntime } = await import('../src/dsh-adapter/renderers.js')
const { mountAdmitted, mountAdmissionHost, testManifest, COMMAND_COORDINATE } = await import('../scripts/lib/plugin-test-utils.js')

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const cleanup: string[] = [fakeHome]

let checks = 0
const failures: string[] = []
const check1 = (name: string, ok: boolean, detail?: string) => {
  checks += 1
  if (!ok) failures.push(`${name}${detail ? `: ${detail}` : ''}`)
}

// ── A. 真实依赖映射 ───────────────────────────────────────────────────────
{
  const ctx = new Context()
  ctx.plugin(CommandRuntime)
  await sleep(50)
  const service = ctx.get('commands')
  check1('real dsh-commands mounts standalone', service !== undefined)
  const definition = { name: 'dup-probe', description: '电池探针', handler: () => ({ kind: 'success' }) }
  service.register(definition as never)
  let thrown: unknown
  try {
    service.register(definition as never)
  } catch (error) {
    thrown = error
  }
  check1('real duplicate registration throws', thrown instanceof Error)
  const mapped = mapCommandError(thrown)
  check1('mapped error carries DUPLICATE_CONTRIBUTION_ID', hasCommandErrorCode(mapped, 'DUPLICATE_CONTRIBUTION_ID'))
  check1('original preserved as cause', (mapped as { cause?: unknown }).cause === thrown)
  check1('message preserved verbatim', (mapped as Error).message === (thrown as Error).message)
}

// ── B. 文案变体与透传 ─────────────────────────────────────────────────────
{
  const variants = [
    'command "x" is already registered (for a per-agent variant, mount a command-injected plugin under that agent\'s `agent.ctx`)',
    'command "x" is already registered in this scope',
  ]
  for (const [index, message] of variants.entries()) {
    const mapped = mapCommandError(new Error(message))
    check1(`variant ${index + 1} maps to DUPLICATE_CONTRIBUTION_ID`, hasCommandErrorCode(mapped, 'DUPLICATE_CONTRIBUTION_ID'), message)
  }
  const other = new Error('command "x" failed: handler exploded')
  check1('non-duplicate error passes through unchanged', mapCommandError(other) === other)
  const notPrefixed = new Error('warning: command "x" is already registered (paraphrased)')
  check1('message not STARTING with the duplicate sentence passes through', mapCommandError(notPrefixed) === notPrefixed)
  for (const value of ['plain string', null, 42, { code: 'DUPLICATE_CONTRIBUTION_ID' }]) {
    check1(`non-Error ${JSON.stringify(value)} passes through`, mapCommandError(value) === value)
  }
}

// ── C. hasCommandErrorCode 判定面 ─────────────────────────────────────────
{
  const coded = mapCommandError(new Error('command "x" is already registered in this scope'))
  check1('true for the matching code', hasCommandErrorCode(coded, 'DUPLICATE_CONTRIBUTION_ID'))
  check1('false for a different code', !hasCommandErrorCode(coded, 'COMMAND_NOT_FOUND'))
  for (const value of [null, undefined, 'DUPLICATE_CONTRIBUTION_ID', 0, new Error('plain')]) {
    check1(`false for ${String(value)}`, !hasCommandErrorCode(value, 'DUPLICATE_CONTRIBUTION_ID'))
  }
}

// ── D. withCommandErrorMapping ────────────────────────────────────────────
{
  const resolved = await withCommandErrorMapping(() => 42)
  check1('successful operation resolves through', resolved === 42)
  let coded: unknown
  try {
    await withCommandErrorMapping(() => {
      throw new Error('command "x" is already registered in this scope')
    })
  } catch (error) {
    coded = error
  }
  check1('duplicate rethrow carries the code', hasCommandErrorCode(coded, 'DUPLICATE_CONTRIBUTION_ID'))
  const original = new TypeError('unrelated')
  let rethrown: unknown
  try {
    await withCommandErrorMapping(() => {
      throw original
    })
  } catch (error) {
    rethrown = error
  }
  check1('unrelated error rethrown as the same reference', rethrown === original)
}

// ── E. 契约错误码词表 ─────────────────────────────────────────────────────
{
  check1(
    'vocabulary matches the contract (6 codes)',
    JSON.stringify([...COMMAND_ERROR_CODES].sort()) === JSON.stringify([
      'COMMAND_FAILED',
      'COMMAND_NOT_FOUND',
      'DUPLICATE_CONTRIBUTION_ID',
      'INVOCATION_CANCELLED',
      'INVOCATION_DEADLINE_EXCEEDED',
      'PERMISSION_NOT_GRANTED',
    ]),
    COMMAND_ERROR_CODES.join(','),
  )
}

// ── F. invoke 检查点门语义 ────────────────────────────────────────────────
{
  const revoked = parseGrantStore(JSON.stringify({ denies: { root: ['commands.invoke'] } }))
  check1('legacy unscoped deny cannot be widened into a command grant',
    !revoked.allows({ componentId: 'root' }, 'commands.invoke', 'root.command'))
  const defaulted = parseGrantStore('{}')
  check1('commands.invoke defaults to allow for a valid command scope (registry-driven)',
    defaulted.allows({ componentId: 'root' }, 'commands.invoke', 'root.command'))
  const others = parseGrantStore(JSON.stringify({ denies: {
    'evil-plugin': [{ name: 'commands.invoke', scope: 'evil-plugin.command' }],
  } }))
  check1("another plugin's denies do not affect root",
    others.allows({ componentId: 'root' }, 'commands.invoke', 'root.command'))
  check1('the denied plugin itself is blocked',
    !others.allows({ componentId: 'evil-plugin' }, 'commands.invoke', 'evil-plugin.command'))
}

// ── F2. 命令归属（C-041 per-owner 检查点的数据源）─────────────────────────
{
  const { commandOwner } = await import('../src/dsh-adapter/command-attribution.js')
  const attrCtx = new Context()
  attrCtx.plugin(CommandRuntime)
  await mountAdmissionHost(attrCtx, 'commands battery F2')
  const host = attrCtx.get('tuiPluginHost')
  check1('command live probe is not exposed on the plugin-visible host service',
    typeof (host as { probeCommandReversible?: unknown } | undefined)?.probeCommandReversible === 'undefined')
  const commands = attrCtx.get('commands')
  const globalAgent = {}
  const resolved = (agent: object, name: string) => commands?.find(agent as never, name)
  check1('registerCommand surface exists on the plugin-host row', typeof host?.registerCommand === 'function')

  // 经托管面注册：必须使用已 admission 的 Component 与显式 contribution ID。
  const evil = await mountAdmitted(attrCtx, 'evil-plugin', testManifest({
    id: 'com.example.evil-plugin',
    requires: [COMMAND_COORDINATE],
    commands: [{ id: 'evil-plugin.evil-cmd', title: 'Evil command' }],
    permissions: [{ name: 'commands.invoke', scope: 'evil-plugin.evil-cmd' }],
  }))
  const registerVia = (definition: unknown) =>
    host!.registerCommand(evil.context, 'evil-plugin.evil-cmd', definition as never)
  const disposer = registerVia({ name: 'evil-cmd', description: '归属探针', handler: () => ({ kind: 'success' }) })
  check1('mediated registration attributes the command to the plugin fiber',
    commandOwner(attrCtx, resolved(globalAgent, 'evil-cmd'))?.componentId === 'com.example.evil-plugin')

  // 直接 ctx.get('commands') 注册 → 未归属（文档化 C-070 边界）。
  commands?.register({ name: 'accessor-cmd', description: '直接注册', handler: () => ({ kind: 'success' }) } as never)
  check1('direct ctx.get registration stays unattributed (documented boundary)',
    commandOwner(attrCtx, resolved(globalAgent, 'accessor-cmd')) === undefined)

  // 托管面重复注册 → 映射为 DUPLICATE_CONTRIBUTION_ID，原印不动。
  let duplicateMapped = false
  try {
    registerVia({ name: 'evil-cmd', description: '再注册一次', handler: () => ({ kind: 'success' }) })
  } catch (error) {
    duplicateMapped = hasCommandErrorCode(error, 'DUPLICATE_CONTRIBUTION_ID')
  }
  check1('mediated duplicate registration throws DUPLICATE_CONTRIBUTION_ID', duplicateMapped)
  check1('the failed duplicate left the original stamp intact',
    commandOwner(attrCtx, resolved(globalAgent, 'evil-cmd'))?.componentId === 'com.example.evil-plugin')

  // disposer 摘印且幂等。
  disposer()
  check1('the mediated disposer lifts the stamp', commandOwner(attrCtx, resolved(globalAgent, 'evil-cmd')) === undefined)
  disposer()
  check1('double dispose stays harmless (no stamp, no throw)', commandOwner(attrCtx, resolved(globalAgent, 'evil-cmd')) === undefined)

  // dsh-commands resolves same-name entries per agent scope. Attribute the
  // selected definition itself, then unload one plugin without its wrapper.
  const agentA = {}
  const agentB = {}
  const scopeA = createScope(attrCtx, agentA)
  const scopeB = createScope(attrCtx, agentB)
  const scopedAMounted = await mountAdmitted(scopeA.ctx, 'scope-plugin-a', testManifest({
    id: 'com.example.scope-plugin-a',
    requires: [COMMAND_COORDINATE],
    commands: [{ id: 'scope-plugin-a.scoped-same', title: 'agent A' }],
    permissions: [{ name: 'commands.invoke', scope: 'scope-plugin-a.scoped-same' }],
  }))
  const scopedBMounted = await mountAdmitted(scopeB.ctx, 'scope-plugin-b', testManifest({
    id: 'com.example.scope-plugin-b',
    requires: [COMMAND_COORDINATE],
    commands: [{ id: 'scope-plugin-b.scoped-same', title: 'agent B' }],
    permissions: [{ name: 'commands.invoke', scope: 'scope-plugin-b.scoped-same' }],
  }))
  host!.registerCommand(scopedAMounted.context, 'scope-plugin-a.scoped-same', {
    name: 'scoped-same', description: 'agent A', handler: () => ({ kind: 'success' }),
  } as never)
  host!.registerCommand(scopedBMounted.context, 'scope-plugin-b.scoped-same', {
    name: 'scoped-same', description: 'agent B', handler: () => ({ kind: 'success' }),
  } as never)
  const scopedA = scopedAMounted.fiber
  const definitionA = resolved(agentA, 'scoped-same')
  check1('same command name keeps separate owners in separate agent scopes',
    commandOwner(attrCtx, definitionA)?.componentId === 'com.example.scope-plugin-a'
    && commandOwner(attrCtx, resolved(agentB, 'scoped-same'))?.componentId === 'com.example.scope-plugin-b')
  await Promise.resolve(scopedA.dispose())
  await sleep(30)
  check1('fiber teardown removes the scoped command definition', resolved(agentA, 'scoped-same') === undefined)
  check1('fiber teardown also removes its attribution stamp',
    commandOwner(attrCtx, definitionA) === undefined
    && commandOwner(attrCtx, resolved(agentB, 'scoped-same'))?.componentId === 'com.example.scope-plugin-b')
  await scopeA.dispose()
  await scopeB.dispose()
}

// ── G. channel 接线断言 ───────────────────────────────────────────────────
{
  // Phase 4a: the DSH extension (channel/extensions.ts) composes the invoker.
  const channel = readFileSync(join(root, 'src/dsh-adapter/channel/extensions.ts'), 'utf8')
  const invoker = readFileSync(join(root, 'src/dsh-adapter/channel/external-commands.ts'), 'utf8')
  const definitionLookup = invoker.indexOf('const definition = service.find(commandAgent, name)')
  const ownerLookup = invoker.indexOf('const owner = commandOwner(ctx, definition)')
  const imagePreparation = invoker.indexOf('const batch = await registryCommandImages(', definitionLookup)
  const checkpoint = invoker.indexOf('const denied = authorize(definition, name, requested)', definitionLookup)
  check1('owner-scoped invoke checkpoint is extracted into external-commands.ts', checkpoint !== -1)
  check1('owner lookup uses the effective definition', ownerLookup !== -1 && ownerLookup < checkpoint)
  const executeAfter = invoker.indexOf('service.execute', checkpoint)
  check1('owner checkpoint runs BEFORE service.execute', executeAfter > checkpoint)
  check1('image preparation runs before the live grant checkpoint',
    imagePreparation > definitionLookup && checkpoint > imagePreparation)
  check1('the live grant checkpoint re-reads the grant store per invocation',
    invoker.includes("if (!deps.allows({ componentId: 'root' }, 'commands.invoke', rootScope))"))
  check1('the live grant checkpoint immediately precedes command execution',
    executeAfter > checkpoint)
  check1('owner deny keeps the structured draft-preserving error outcome',
    invoker.includes("return t('command-invoke-denied-owner'") && invoker.includes('consumeDraft: false'))
  check1('owner invoke deny records a scoped permission id', invoker.includes('resource: { kind: \'permission\', id: `${owner.componentId}:commands.invoke:${owner.commandId}` }'))
  // The negative half reads every composition root and core module (Phase 4a
  // moved composition code into channel/core/*).
  check1('channel composes external invocation instead of retaining policy', channel.includes('createExternalCommandInvoker(') && !compositionAndCoreSource().includes('commandOwner(ctx, definition)'))
  const skills = readFileSync(join(root, 'src/dsh-adapter/channel/skill-catalog.ts'), 'utf8')
  check1('skill register catch maps through mapCommandError', /catch \(error\) \{[\s\S]{0,400}mapCommandError\(error\)/.test(skills))
  check1("skill success recorded as command create applied",
    skills.includes("{ operation: 'create', resource: { kind: 'command', id: name }, result: 'applied' }"))
  check1('skill failure recorded with DUPLICATE_CONTRIBUTION_ID or COMMAND_FAILED',
    skills.includes("? 'DUPLICATE_CONTRIBUTION_ID' : 'COMMAND_FAILED'"))
  check1('command-errors imported by skill-catalog.ts',
    skills.includes("import { hasCommandErrorCode, mapCommandError } from '../command-errors.js'"))
  check1('command-attribution imported by external-commands.ts',
    /import \{[^}]*\bcommandOwner\b[^}]*\} from '\.\.\/command-attribution\.js'/.test(invoker))
  const ownerCheckpoint = checkpoint
  check1('per-owner checkpoint present', ownerCheckpoint !== -1)
  check1('per-owner checkpoint runs BEFORE service.execute',
    invoker.indexOf('service.execute', ownerCheckpoint) > ownerCheckpoint)
  check1('composer-images invocation is version-gated (0.1.0-rc.8 threshold + 4-param shape present)',
    invoker.includes('supportsImages(')
    && invoker.includes("installedMeetsVersion('@deepseek-ai/dsh-commands', '0.1.0-rc.8')")
    && invoker.includes('ImagesExecute'))
  check1('command discovery mirrors the upstream input admission flag (0.1.5 `attachments`, legacy `images` fallback)',
    /acceptsImages:[^\n]*\battachments\b[^\n]*\bimages\b/.test(skills))
  check1('draft-aware command outcome is additive',
    invoker.includes('Promise<ExternalCommandOutcome | undefined>')
      && channel.includes('runExternalCommandOutcome'))
  const pluginHost = readFileSync(join(root, 'src/dsh-adapter/plugin-host.ts'), 'utf8')
  check1('the plugin-host row exposes the mediated registerCommand',
    pluginHost.includes('registerCommand(pluginCtx: Context'))
  check1('registerCommand stamps the resolved definition',
    pluginHost.includes('stampCommandOwner(host, attributedDefinition, identity, contributionId)'))
  // commands/change fires synchronously inside register(): the catalog
  // refresh it triggers must already see the owner (WP4 listing).
  const stampAt = pluginHost.indexOf('stampCommandOwner(host, attributedDefinition, identity, contributionId)')
  const registerAt = pluginHost.indexOf('dispose = commands.register(attributedDefinition)')
  check1('registerCommand stamps BEFORE register() and lifts the stamp on a refusal',
    stampAt !== -1 && registerAt > stampAt
    && pluginHost.indexOf('unstampCommandOwner(host, attributedDefinition, identity.activationId)', registerAt) !== -1)
  check1('registerCommand resolves commands through the canonical activation context', pluginHost.includes("caller.get('commands')"))
  check1('registerCommand maps duplicate errors', pluginHost.includes('mapCommandError(error)'))

  const i18n = readFileSync(join(root, 'src/i18n.ts'), 'utf8')
  const keyIdx = i18n.indexOf("'command-invoke-denied'")
  check1("i18n key 'command-invoke-denied' exists", keyIdx !== -1)
  const entry = i18n.slice(keyIdx, keyIdx + 400)
  check1('zh translation present', /zh:\s*'[^']*授权文件拒绝[^']*'/.test(entry))
  check1('en translation present', /en:\s*'[^']*grants file[^']*'/.test(entry))
  const ownerIdx = i18n.indexOf("'command-invoke-denied-owner'")
  check1("i18n key 'command-invoke-denied-owner' exists", ownerIdx !== -1)
  const ownerEntry = i18n.slice(ownerIdx, ownerIdx + 500)
  check1('owner deny zh translation names the owner', ownerEntry.includes('{{owner}}'))
  check1('owner deny en translation present', /en:\s*'[^']*owner plugin[^']*'/.test(ownerEntry))
  const imageAdmissionIdx = i18n.indexOf("'command-images-unsupported'")
  check1("i18n key 'command-images-unsupported' exists", imageAdmissionIdx !== -1)
}

// ── H. 非破坏签名（不传 identity 照旧可用）──────────────────────────────────
{
  const ctx = new Context()
  new TuiShortcutRuntime(ctx)
  new TuiSceneRuntime(ctx)
  new TuiStatusRuntime(ctx)
  new TuiRendererRuntime(ctx)
  let activation: import('@deepseek-ai/cordis').Context | undefined
  const fiber = ctx.inject(['tuiShortcuts', 'tuiScenes', 'tuiStatus', 'tuiRenderers'], (pluginCtx) => {
    activation = pluginCtx
    const disposeShortcut = pluginCtx.tuiShortcuts.register('ctrl+shift+q', { description: '无 identity', handler: () => {} })
    check1('tuiShortcuts.register without identity returns a disposer', typeof disposeShortcut === 'function')
    disposeShortcut()

    const disposeScene = pluginCtx.tuiScenes.register({ id: 'demo-scene', component: () => null })
    check1('tuiScenes.register without identity returns a disposer', typeof disposeScene === 'function')
    disposeScene()

    const disposeStatus = pluginCtx.tuiStatus.set('demo-key', 'text')
    check1('tuiStatus.set without identity returns a disposer', typeof disposeStatus === 'function')
    disposeStatus()

    const disposeRenderer = pluginCtx.tuiRenderers.register('demo-plugin/note', () => undefined)
    check1('tuiRenderers.register without identity returns a disposer', typeof disposeRenderer === 'function')
    disposeRenderer()
  })
  await fiber
  if (activation === undefined) throw new Error('non-breaking signature probe did not activate')
  await fiber.dispose()
  await ctx.fiber.dispose()
}

// ── I. 被遮蔽的插件命令可达（/<pluginId>:<name>）───────────────────────────
{
  const {
    completeCommands, findCommand, LOCAL_COMMANDS, parseCatalogCommand, parseCommandName, parseQualifiedCommandName,
  } = await import('../src/commands.js')
  const { createSkillCatalog } = await import('../src/dsh-adapter/channel/skill-catalog.js')
  const { createExternalCommandInvoker } = await import('../src/dsh-adapter/channel/external-commands.js')
  const { pluginsInfoLines } = await import('../src/dsh-adapter/plugins-info.js')
  const { t } = await import('../src/i18n.js')
  type Entry = import('../src/commands.js').LocalCommand

  // I0. 只有裸 /permission 是用户切换宿主权限：/<pluginId>:permission 只能是插件
  //     自己的归属命令（宿主的 /permission 没有 owner，没有限定名），绝不能把插件
  //     命令的参数当成宿主权限偏好记下来。
  {
    const { tracksUserPermissionSwitch } = await import('../src/dsh-adapter/channel/extensions.js')
    check1('the bare /permission is a user permission switch', tracksUserPermissionSwitch('permission'))
    check1('a qualified /<pluginId>:permission is the plugin\'s own command, never tracked',
      !tracksUserPermissionSwitch('com.example.echo:permission') && !tracksUserPermissionSwitch('dsh-context:permission'))
  }

  // I1. 语法：冒号只在目录能解析到插件命令时才是命令；其余冒号行照旧是文本。
  check1('qualified name splits into owner + registry name',
    JSON.stringify(parseQualifiedCommandName('dsh-context:context')) === JSON.stringify({ owner: 'dsh-context', name: 'context' }))
  // The owner follows the shared plugin-namespace grammar (pluginIdentity.ts):
  // a manifest id (reverse-DNS included) or a legacy slug.
  check1('a reverse-DNS manifest id is a qualified owner',
    JSON.stringify(parseQualifiedCommandName('com.example.echo:run')) === JSON.stringify({ owner: 'com.example.echo', name: 'run' }))
  check1('a legacy slug id is still a qualified owner',
    JSON.stringify(parseQualifiedCommandName('my_plugin:run')) === JSON.stringify({ owner: 'my_plugin', name: 'run' }))
  for (const bad of ['context', 'a:b:c', 'A:b', 'a:B', 'a:', ':b', 'a :b', 'com..x:run', 'Com.x:run', 'x.:run', '.x:run', 'com.example.echo:run:x', 'com.example.echo:Run']) {
    check1(`not a qualified name: ${JSON.stringify(bad)}`, parseQualifiedCommandName(bad) === undefined)
  }
  // pluginIdentity.ts spells the manifest `namespacedId` without the schema
  // spelling's ambiguous `-`: pin it to the vendored schema by enumeration,
  // and pin linear time on the shape that makes the schema spelling backtrack
  // exponentially (it runs on typed lines).
  {
    const { createRequire } = await import('node:module')
    const { isManifestNamespacedId, isPluginNamespace } = await import('../src/pluginIdentity.js')
    const schemaPath = createRequire(import.meta.url).resolve('@dsh-std/manifest/schema/dsh-plugin-0.15.schema.json')
    const schema = JSON.parse(readFileSync(schemaPath, 'utf8')) as { $defs: { namespacedId: { pattern: string } } }
    const manifestId = new RegExp(schema.$defs.namespacedId.pattern, 'u')
    const legacyId = /^[a-z][a-z0-9_-]*$/u
    const alphabet = ['a', '0', '-', '.', '_', ':']
    let enumerated = 0
    let mismatch: string | undefined
    const walk = (prefix: string, depth: number): void => {
      if (mismatch !== undefined) return
      if (prefix !== '') {
        enumerated += 1
        if (isPluginNamespace(prefix) !== (manifestId.test(prefix) || legacyId.test(prefix))) mismatch = prefix
        // The manifest-only predicate (command scopes, the invoke checkpoint's root scope).
        if (isManifestNamespacedId(prefix) !== manifestId.test(prefix)) mismatch = `manifest-only: ${prefix}`
      }
      if (depth > 0) for (const char of alphabet) walk(prefix + char, depth - 1)
    }
    walk('', 7)
    check1(`the namespace grammar is exactly manifest namespacedId ∪ legacy slug (${enumerated} strings)`, mismatch === undefined, JSON.stringify(mismatch))
    check1('uppercase and whitespace are never a namespace',
      !isPluginNamespace('Com.example') && !isPluginNamespace('com.Example') && !isPluginNamespace('com. example') && !isPluginNamespace('com.example '))
    const hostile = 'a' + '-a'.repeat(5000)
    const started = performance.now()
    const hostileResults = [
      isPluginNamespace(hostile + '!'),
      isManifestNamespacedId(hostile + '!'),
      parseQualifiedCommandName(hostile + ':X'),
      parseCatalogCommand('/' + hostile + ':X', []),
    ]
    const elapsed = performance.now() - started
    check1('a long hyphen run that fails to match is rejected in linear time',
      hostileResults.every(result => result === false || result === undefined) && elapsed < 250, `${elapsed.toFixed(1)}ms`)
  }
  check1('the strict registry parser keeps rejecting colon names', parseCommandName('/dsh-context:context') === undefined)
  const fixture: Entry[] = [
    ...LOCAL_COMMANDS,
    { name: 'dsh-context:context', description: 'plugin context', external: true, owner: 'dsh-context' },
    { name: 'ctx-extra', description: 'plugin extra', external: true, owner: 'dsh-context' },
    { name: 'plan', description: 'plan mode', external: true },
    { name: 'superpowers:brainstorm', description: 'backend command', skill: true, origin: 'backend' },
    // An unattributed registry command whose own name has a colon.
    { name: 'acme:deploy', description: 'unattributed colon command', external: true },
    // The shadowed listing form of a reverse-DNS plugin's `run`.
    { name: 'com.example.echo:run', description: 'echo run', external: true, owner: 'com.example.echo' },
  ]
  check1('a listed qualified line parses with its raw input verbatim',
    JSON.stringify(parseCatalogCommand('/dsh-context:context  a b', fixture)) === JSON.stringify({ name: 'dsh-context:context', rawInput: '  a b' }))
  check1('the unlisted qualified form of a non-shadowed plugin command parses',
    parseCatalogCommand('/dsh-context:ctx-extra x', fixture)?.name === 'dsh-context:ctx-extra')
  check1('a qualified line naming another owner stays text', parseCatalogCommand('/other:ctx-extra', fixture) === undefined)
  check1('a qualified line for an unattributed command stays text', parseCatalogCommand('/dsh-context:plan', fixture) === undefined)
  check1("a backend's own ns:cmd stays text (reaches the backend verbatim)", parseCatalogCommand('/superpowers:brainstorm go', fixture) === undefined)
  check1('an unattributed registry colon command is not read as owner-qualified', parseCatalogCommand('/acme:deploy now', fixture) === undefined)
  check1('plain lines parse exactly as parseCommandName',
    JSON.stringify(parseCatalogCommand('/plan off', fixture)) === JSON.stringify(parseCommandName('/plan off')))
  check1('a qualified prefix glued to more text is not a command', parseCatalogCommand('/dsh-context:context:x', fixture) === undefined)
  check1('findCommand resolves an owner-qualified bare entry', findCommand(fixture, 'dsh-context:ctx-extra')?.name === 'ctx-extra')
  check1('findCommand never crosses owners', findCommand(fixture, 'other:ctx-extra') === undefined)
  check1('findCommand keeps the local name local', findCommand(fixture, 'context')?.external !== true)
  check1('a listed reverse-DNS qualified line parses with its raw input verbatim',
    JSON.stringify(parseCatalogCommand('/com.example.echo:run  a b', fixture)) === JSON.stringify({ name: 'com.example.echo:run', rawInput: '  a b' }))
  check1('findCommand resolves the reverse-DNS qualified entry',
    findCommand(fixture, 'com.example.echo:run')?.owner === 'com.example.echo')
  // Malformed namespaces stay text even when a catalog entry spells them: the
  // grammar, not the catalog, refuses them.
  const malformed: Entry[] = ['com..x', 'Com.x', 'x.'].map(owner => ({ name: `${owner}:run`, description: 'malformed', external: true, owner }))
  for (const line of ['/com..x:run', '/Com.x:run', '/x.:run', '/com..x:run go']) {
    check1(`a malformed namespace line stays text: ${JSON.stringify(line)}`, parseCatalogCommand(line, malformed) === undefined)
  }
  const menu = completeCommands('/', fixture)
  check1('the / menu lists the shadowed command in its qualified form, owner attached',
    menu.some(row => row.name === 'dsh-context:context' && row.owner === 'dsh-context' && row.description === 'plugin context'))
  check1('a non-shadowed plugin command is listed bare only (no duplicate)',
    menu.filter(row => row.name.endsWith('ctx-extra')).map(row => row.name).join() === 'ctx-extra')
  check1('the local keeps exactly one bare row', menu.filter(row => row.name === 'context').length === 1)
  check1('typing the owner prefix completes the qualified row',
    completeCommands('/dsh-c', fixture).map(row => row.commandLine).includes('/dsh-context:context'))
  check1('the / menu tags the reverse-DNS qualified row with its owner',
    menu.some(row => row.name === 'com.example.echo:run' && row.owner === 'com.example.echo'))
  check1('typing a reverse-DNS owner prefix completes its qualified row',
    completeCommands('/com.ex', fixture).map(row => row.commandLine).join() === '/com.example.echo:run')
  check1('bare-name prefixes are unchanged (local first, no extra row)',
    completeCommands('/contex', fixture).map(row => row.name).join() === 'context')

  // I2. 目录合并：真 registry + 真 plugin-host + 已准入的插件。
  const wpCtx = new Context()
  wpCtx.plugin(CommandRuntime)
  await mountAdmissionHost(wpCtx, 'commands battery I')
  const wpHost = wpCtx.get('tuiPluginHost')!
  const wpCommands = wpCtx.get('commands')!
  const lifecycle: Array<[string, unknown]> = []
  const agent = { id: 'agent-wp4', session: { id: 'session-wp4', append: (type: string, data: unknown) => { lifecycle.push([type, data]); return true } } }
  let published: readonly Entry[] = []
  const catalog = createSkillCatalog(wpCtx, {
    owner: { current: () => true, own: (cleanup: () => void) => cleanup },
    commandService: wpCommands,
    agent: () => agent as never,
    cwd: () => fakeHome,
    setCommands: commands => { published = commands },
    commandDescriptions: () => undefined,
    working: () => false,
    deliverUserText: () => {},
  })
  catalog.start()
  const listed = (name: string) => published.find(entry => entry.name === name)
  const ran: Array<{ who: string; rawInput: string }> = []
  const handlerFor = (who: string) => ({ rawInput }: { rawInput: string }) => {
    ran.push({ who, rawInput })
    return { kind: 'success' as const, text: `${who} ok` }
  }
  // The vendored manifest projection admits a single `commands.invoke`
  // permission per facet: an exact command id for one declared command, the
  // `<id>.*` namespace wildcard for several.
  const fibers: Array<{ dispose(): unknown }> = []
  const plugins = async (target: typeof wpCtx, id: string, names: readonly string[]) => {
    const mounted = await mountAdmitted(target, id, testManifest({
      id,
      requires: [COMMAND_COORDINATE],
      commands: names.map(name => ({ id: `${id}.${name}` })),
      permissions: [{ name: 'commands.invoke', scope: names.length === 1 ? `${id}.${names[0]}` : `${id}.*` }],
    }))
    fibers.push(mounted.fiber)
    return (name: string, extra: Record<string, unknown> = {}) => wpHost.registerCommand(mounted.context, `${id}.${name}`, {
      name, description: `${id} ${name}`, handler: handlerFor(`${id}:${name}`), ...extra,
    } as never)
  }
  const plugin = async (target: typeof wpCtx, id: string, name: string) => {
    const register = await plugins(target, id, [name])
    return (extra: Record<string, unknown> = {}) => register(name, extra)
  }

  // dsh-context declares two commands (`dsh-context.context`, `dsh-context.ctx`)
  // under one `dsh-context.*` permission.
  const dshContext = await plugins(wpCtx, 'dsh-context', ['context', 'ctx'])
  const releaseContext = dshContext('context', { input: { hint: '<tab>', attachments: true } })
  // No manual refresh: the synchronous commands/change inside register()
  // must already see the verified owner (stamp-before-register).
  check1('a shadowed attributed command is listed as /<pluginId>:<name> straight from register()',
    listed('dsh-context:context')?.owner === 'dsh-context' && listed('dsh-context:context')?.external === true)
  check1('the qualified entry keeps the plugin description, hint and image admission',
    listed('dsh-context:context')?.description === 'dsh-context context' && listed('dsh-context:context')?.tag === '<tab>'
      && listed('dsh-context:context')?.acceptsImages === true)
  check1('the bare name stays the local command (local first)',
    published.filter(entry => entry.name === 'context').length === 1 && listed('context')?.external !== true)
  const releaseCtx = dshContext('ctx')
  check1('the same Component registers its second declared command under dsh-context.*',
    listed('ctx')?.owner === 'dsh-context' && listed('ctx')?.external === true
      && listed('dsh-context:context')?.owner === 'dsh-context')
  ;(await plugin(wpCtx, 'extra-plugin', 'ctx-extra'))()
  check1('a non-shadowed attributed command is listed bare with its owner',
    listed('ctx-extra')?.owner === 'extra-plugin' && listed('extra-plugin:ctx-extra') === undefined)
  // Reverse-DNS manifest ids are namespaces too (they used to be refused).
  ;(await plugin(wpCtx, 'com.example.dotted', 'config'))()
  check1('a shadowed command of a reverse-DNS plugin is listed as /<pluginId>:<name>',
    listed('com.example.dotted:config')?.owner === 'com.example.dotted' && listed('com.example.dotted:config')?.external === true)
  ;(await plugin(wpCtx, 'com.example.echo', 'run'))()
  check1('a non-shadowed command of a reverse-DNS plugin is listed bare with its owner',
    listed('run')?.owner === 'com.example.echo' && listed('com.example.echo:run') === undefined)

  // Unattributed and un-namespaceable shadows are reported, never listed.
  wpCommands.register({ name: 'status', description: 'direct status', handler: handlerFor('direct:status') } as never)
  wpCommands.register({ definitionId: 'acme.direct-tools\u001b[31m', name: 'cost', description: 'direct cost', handler: handlerFor('direct:cost') } as never)
  wpCommands.register({ name: 'compact', description: 'registry compact', handler: handlerFor('direct:compact') } as never)
  // Admission only ever binds manifest ids, so an owner outside the namespace
  // grammar needs a forged stamp: it must stay unreachable and reported.
  const { stampCommandOwner } = await import('../src/dsh-adapter/command-attribution.js')
  const forgedTips = { name: 'tips', description: 'forged tips', handler: handlerFor('Forged_Owner:tips') }
  stampCommandOwner(wpCtx, forgedTips, { componentId: 'Forged_Owner', activationId: 'forged-activation' } as never, 'forged.tips')
  wpCommands.register(forgedTips as never)
  const shadowed = catalog.shadowedCommands()
  const shadowOf = (name: string) => shadowed.find(entry => entry.name === name)
  check1('an unattributed shadowed command is unreachable and reported without an owner',
    shadowOf('status') !== undefined && shadowOf('status')?.owner === undefined
      && !published.some(entry => entry.name.endsWith(':status')))
  check1('an unattributed definitionId is carried as an unverified hint', shadowOf('cost')?.declared?.startsWith('acme.direct-tools') === true)
  check1('an owner id outside the namespace grammar is reported with that owner',
    shadowOf('tips')?.owner === 'Forged_Owner' && !published.some(entry => entry.name.endsWith(':tips')))
  check1('a reverse-DNS owner is reachable, so it is not reported', shadowOf('config') === undefined)
  check1('the registry /compact the local /compact routes to is not reported', shadowOf('compact') === undefined)
  check1('reachable qualified commands are not reported', shadowOf('context') === undefined)

  // Plugin vs plugin: DSH keeps the bare-name behavior (same-scope duplicate
  // refused); a qualified name only ever reaches its own verified owner.
  const refusedAsDuplicate = (registerIt: () => unknown): boolean => {
    try {
      registerIt()
      return false
    } catch (error) {
      return hasCommandErrorCode(error, 'DUPLICATE_CONTRIBUTION_ID')
    }
  }
  ;(await plugin(wpCtx, 'shared-a', 'shared'))()
  const sharedB = await plugin(wpCtx, 'shared-b', 'shared')
  check1('the second plugin registering the same bare name is refused (DSH behavior kept)', refusedAsDuplicate(sharedB))
  check1('the winner stays listed bare under its owner', listed('shared')?.owner === 'shared-a')
  ;(await plugin(wpCtx, 'doctor-a', 'doctor'))()
  const doctorB = await plugin(wpCtx, 'doctor-b', 'doctor')
  check1('a refused duplicate of a shadowed name leaves the winner as the only qualified row',
    refusedAsDuplicate(doctorB) && listed('doctor-a:doctor') !== undefined && listed('doctor-b:doctor') === undefined)

  // I3. 执行：同一 invoke 路径、同样参数/图片、同样的授权检查点。
  let grants = parseGrantStore('{}')
  const executeCalls: Array<{ line: string; images: readonly { data: string }[] }> = []
  const spy = {
    find: (target: unknown, name: string) => wpCommands.find(target as never, name),
    list: (target: unknown) => wpCommands.list(target as never),
    // 4-parameter shape: the composer-images path. Forward without images —
    // the real registry would need an attachment store; the spy records
    // exactly what the invoker hands over.
    execute: async (target: unknown, line: string, images: readonly { data: string }[], signal: AbortSignal) => {
      executeCalls.push({ line, images })
      return wpCommands.execute(target as never, line, [], signal)
    },
  }
  const staged = new Map([['stage-1', { mediaType: 'image/png', bytes: 4, name: 'a.png' }]])
  const store = {
    imageLimits: { maxImageBytes: 1024, mediaTypes: ['image/png'], maxImagesPerMessage: 4, maxMessageImageBytes: 4096 },
    readImage: async () => ({ data: new Uint8Array([1, 2, 3, 4]) }),
  }
  const invoker = createExternalCommandInvoker(wpCtx, {
    commandService: spy as never,
    runtime: { mode: 'new', slices: [] },
    agent: () => agent as never,
    capture: () => 1,
    bindingCurrent: () => true,
    allows: (subject, permission, scope) => grants.allows(subject, permission, scope),
    composer: { snapshot: () => staged, includeLegacyImageRefs: (_line: string, refs: readonly unknown[]) => refs } as never,
    attachments: () => store as never,
    notify: () => {},
  })
  const imageRefs = [{ token: '[Image #1]', stageId: 'stage-1' }] as never
  const qualified = await invoker.invoke('dsh-context:context', ' tab-1 [Image #1]', imageRefs)
  const qualifiedCall = executeCalls.at(-1)
  check1('the qualified form runs the plugin handler with the raw input verbatim',
    qualified?.kind === 'success' && qualified.consumeDraft && ran.at(-1)?.who === 'dsh-context:context'
      && ran.at(-1)?.rawInput === ' tab-1 [Image #1]')
  check1('the registry sees the bare command line', qualifiedCall?.line === '/context tab-1 [Image #1]')
  check1('the composer image rides along exactly as on the bare path',
    qualifiedCall?.images.length === 1 && qualifiedCall.images[0]?.data === Buffer.from([1, 2, 3, 4]).toString('base64'))
  check1('the lifecycle record names the registry command',
    lifecycle.some(([type, data]) => type === 'command/run' && (data as { name?: unknown }).name === 'context'))
  await invoker.invoke('context', ' tab-1 [Image #1]', imageRefs)
  const bareCall = executeCalls.at(-1)
  check1('bare and qualified hand the registry identical lines and images',
    JSON.stringify(bareCall) === JSON.stringify(qualifiedCall))
  const extra = await invoker.invoke('extra-plugin:ctx-extra', ' x')
  check1('the unlisted qualified form of a non-shadowed command still executes',
    extra?.kind === 'success' && ran.at(-1)?.who === 'extra-plugin:ctx-extra' && ran.at(-1)?.rawInput === ' x')
  const callsBefore = executeCalls.length
  const ranBefore = ran.length
  check1('another owner\'s qualified form is "no such command"', await invoker.invoke('extra-plugin:context', '') === undefined)
  check1('an unattributed command has no qualified form', await invoker.invoke('dsh-context:status', '') === undefined)
  check1('an unknown qualified name is "no such command"', await invoker.invoke('dsh-context:nope', '') === undefined)
  check1('the refused duplicate owner cannot reach the winner\'s command',
    await invoker.invoke('shared-b:shared', '') === undefined && await invoker.invoke('doctor-b:doctor', '') === undefined)
  check1('nothing executed for any refused qualified name', executeCalls.length === callsBefore && ran.length === ranBefore)
  const sharedRun = await invoker.invoke('shared-a:shared', '')
  const doctorRun = await invoker.invoke('doctor-a:doctor', ' --x')
  check1('each attributed winner is reachable through its own qualified name',
    sharedRun?.kind === 'success' && doctorRun?.kind === 'success' && ran.at(-1)?.who === 'doctor-a:doctor'
      && ran.at(-1)?.rawInput === ' --x')
  const dottedRun = await invoker.invoke('com.example.dotted:config', ' --y')
  check1('a shadowed reverse-DNS command executes through its qualified name',
    dottedRun?.kind === 'success' && ran.at(-1)?.who === 'com.example.dotted:config' && ran.at(-1)?.rawInput === ' --y')
  const echoRun = await invoker.invoke('com.example.echo:run', ' hi')
  check1('/com.example.echo:run executes the echo plugin\'s run',
    echoRun?.kind === 'success' && ran.at(-1)?.who === 'com.example.echo:run' && ran.at(-1)?.rawInput === ' hi')
  const ranBeforeForeign = ran.length
  check1('a reverse-DNS qualified name never reaches another owner',
    await invoker.invoke('com.example.echo:config', '') === undefined && await invoker.invoke('com.example.dotted:run', '') === undefined
      && ran.length === ranBeforeForeign)
  grants = parseGrantStore(JSON.stringify({ denies: { 'com.example.dotted': [{ name: 'commands.invoke', scope: 'com.example.dotted.config' }] } }))
  const dottedDenied = await invoker.invoke('com.example.dotted:config', '')
  check1('an owner deny keyed by the reverse-DNS id blocks its qualified form',
    dottedDenied?.kind === 'error' && ran.length === ranBeforeForeign
      && dottedDenied.text === t('command-invoke-denied-owner', { name: 'com.example.dotted:config', owner: 'com.example.dotted' }))
  grants = parseGrantStore('{}')

  grants = parseGrantStore(JSON.stringify({ denies: { 'dsh-context': [{ name: 'commands.invoke', scope: 'dsh-context.context' }] } }))
  const ranBeforeDeny = ran.length
  const ownerDenied = await invoker.invoke('dsh-context:context', ' a')
  const ownerDeniedBare = await invoker.invoke('context', ' a')
  check1('an owner deny blocks the qualified form, naming it as typed',
    ownerDenied?.kind === 'error' && !ownerDenied.consumeDraft
      && ownerDenied.text === t('command-invoke-denied-owner', { name: 'dsh-context:context', owner: 'dsh-context' }))
  check1('the same owner deny blocks the bare form', ownerDeniedBare?.kind === 'error' && !ownerDeniedBare.consumeDraft)
  check1('another plugin\'s command stays reachable', (await invoker.invoke('extra-plugin:ctx-extra', ''))?.kind === 'success')
  check1('an exact deny leaves the same plugin\'s other command reachable',
    (await invoker.invoke('ctx', ''))?.kind === 'success' && ran.at(-1)?.who === 'dsh-context:ctx')
  grants = parseGrantStore(JSON.stringify({ denies: { root: [{ name: 'commands.invoke', scope: 'dsh-context.context' }] } }))
  const rootDenied = await invoker.invoke('dsh-context:context', '')
  check1('a root deny blocks the qualified form too', rootDenied?.kind === 'error' && rootDenied.text === t('command-invoke-denied'))
  check1('no denied invocation reached a handler',
    ran.slice(ranBeforeDeny).every(entry => entry.who === 'extra-plugin:ctx-extra' || entry.who === 'dsh-context:ctx'))
  // `dsh-context.*` is the parent scope of both of its commands: a wildcard
  // deny closes the whole plugin, and an exact deny still wins over a
  // wildcard grant (the same broad/narrow rule as `session:*`).
  grants = parseGrantStore(JSON.stringify({ denies: { 'dsh-context': [{ name: 'commands.invoke', scope: 'dsh-context.*' }] } }))
  const ranBeforeWildcard = ran.length
  const wildcardContext = await invoker.invoke('dsh-context:context', '')
  const wildcardCtx = await invoker.invoke('ctx', '')
  check1('a dsh-context.* deny blocks every command of that plugin',
    wildcardContext?.kind === 'error' && wildcardCtx?.kind === 'error' && ran.length === ranBeforeWildcard
      && wildcardCtx.text === t('command-invoke-denied-owner', { name: 'ctx', owner: 'dsh-context' }))
  check1('a wildcard deny leaves other plugins reachable',
    (await invoker.invoke('extra-plugin:ctx-extra', ''))?.kind === 'success')
  grants = parseGrantStore(JSON.stringify({
    grants: { 'dsh-context': [{ name: 'commands.invoke', scope: 'dsh-context.*' }] },
    denies: { 'dsh-context': [{ name: 'commands.invoke', scope: 'dsh-context.ctx' }] },
  }))
  const narrowCtx = await invoker.invoke('ctx', '')
  const broadContext = await invoker.invoke('dsh-context:context', '')
  check1('an exact deny wins over the wildcard grant at the invoke checkpoint',
    narrowCtx?.kind === 'error' && broadContext?.kind === 'success' && ran.at(-1)?.who === 'dsh-context:context')
  grants = parseGrantStore('{}')

  // Agent-scoped shadow of a global plugin command: DSH resolves ONE
  // definition per agent, so only the scoped owner is addressable there.
  const scope = createScope(wpCtx, agent)
  ;(await plugin(scope.ctx, 'scoped-plugin', 'shared'))()
  catalog.refreshCommands()
  check1('an agent-scoped shadow lists under its own owner', listed('shared')?.owner === 'scoped-plugin')
  check1('the scoped owner is reachable qualified', (await invoker.invoke('scoped-plugin:shared', ''))?.kind === 'success'
    && ran.at(-1)?.who === 'scoped-plugin:shared')
  check1('the global owner it shadows for this agent is not run in its place', await invoker.invoke('shared-a:shared', '') === undefined)
  await scope.dispose()

  // Unregistering drops the qualified row and its execution.
  releaseContext()
  check1('releasing the command drops its qualified row', listed('dsh-context:context') === undefined)
  check1('a released qualified command is "no such command"', await invoker.invoke('dsh-context:context', '') === undefined)
  check1('releasing one command keeps the plugin\'s other command', listed('ctx')?.owner === 'dsh-context')
  releaseCtx()
  check1('releasing the second command drops it too', listed('ctx') === undefined)

  // I4. /plugin 诊断：只列不可达的遮蔽命令，经 cell() 净化。
  const diagDir = mkdtempSync(join(tmpdir(), 'dsh-plugin-commands-diag-'))
  cleanup.push(diagDir)
  const diagDeps = { grants: parseGrantStore('{}'), dataDir: diagDir, ledgerFile: join(diagDir, 'none.jsonl'), storageDir: join(diagDir, 'storage') }
  const overview = pluginsInfoLines('', { ...diagDeps, shadowedCommands: catalog.shadowedCommands() })
  check1('the overview gains the shadowed-commands header',
    overview.includes(t('plugins-shadowed-header', { count: catalog.shadowedCommands().length })))
  check1('an unattributed row says the owner is unknown', overview.includes(t('plugins-shadowed-row-unknown', { name: 'status' })))
  check1('an un-namespaceable owner row names that owner',
    overview.includes(t('plugins-shadowed-row-namespace', { name: 'tips', owner: 'Forged_Owner' })))
  check1('no diagnostics row for the reachable reverse-DNS command', !overview.some(line => line.includes('com.example.dotted')))
  const declaredRow = overview.find(line => line.includes('acme.direct-tools'))
  check1('a declared definitionId row is sanitized (no control characters)', declaredRow !== undefined && !/[\u0000-\u001f]/u.test(declaredRow))
  check1('the section ends with the registerCommand hint', overview.includes(t('plugins-shadowed-hint')))
  check1('no section when nothing is shadowed', !pluginsInfoLines('', { ...diagDeps, shadowedCommands: [] }).includes(t('plugins-shadowed-hint')))
  check1('the short `list` form carries no diagnostics section',
    !pluginsInfoLines('list', { ...diagDeps, shadowedCommands: catalog.shadowedCommands() }).includes(t('plugins-shadowed-hint')))

  // I5. UI 分发接线：输入框、落地页与 Chat 的默认分支共用同一解析。
  const prompt = readFileSync(join(root, 'src/components/PromptInput.tsx'), 'utf8')
  const chat = readFileSync(join(root, 'src/screens/Chat.tsx'), 'utf8')
  check1('the composer parses commands against the catalog',
    prompt.includes('const parsed = parseCatalogCommand(text, channel.commandList)')
      && prompt.includes('const command = findCommand(channel.commandList, parsed.name)'))
  check1('the launchpad parses commands against the catalog',
    chat.includes("parseCatalogCommand(text, channel.commandList)") && chat.includes('findCommand(channel.commandList, parsed.name)'))
  check1('Chat dispatches registry commands through findCommand',
    chat.includes('const external = findCommand(channel.commandList, name)?.external === true'))

  catalog.release()
  for (const fiber of fibers.reverse()) await Promise.resolve(fiber.dispose())
  await wpCtx.fiber.dispose()
}

// ── 汇总 ──────────────────────────────────────────────────────────────────
for (const dir of cleanup) rmSync(dir, { recursive: true, force: true })
if (failures.length > 0) {
  console.error(`plugin-commands battery FAILED (${failures.length}/${checks}):`)
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}
console.log(`plugin-commands battery OK (${checks} checks: real-dependency mapping, variants, code predicate, wrapper, vocabulary, invoke gate, channel wiring, non-breaking signatures, qualified plugin commands)`)
process.exit(0)
