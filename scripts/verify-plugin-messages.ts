/**
 * 批 4 电池：messages.observe broker（C-042）。
 *
 *   A. 授权订阅收到双映射 envelope（user/message→message.received、
 *      assistant/message→message.sent），envelope 独立过 vendored schema，
 *      eventId/scope/messageId/author 逐字段；
 *   B. sequence=event.seq 单调含 gap（非映射事件留洞）；
 *   C. 无 grant：订阅快速失败（noop disposer + warn），零投递；
 *   D. 投递时撤销：store 翻转后订阅被释放 + warn，后续零投递；
 *   E. scope 隔离（C-042）：订阅必须带精确 scope；只收同 scope 的
 *      envelope，跨会话零泄漏；过长 session scope 与空 scope 均拒绝；
 *   F. listener 抛错/拒绝被隔离，其他订阅续投；
 *   G. 截断：长文 summary 截断 + payload.truncated；短文无标记；
 *   H. 非映射事件零产出；session 无 id 丢弃；eventId 字符拍平；
 *   I. schema 缺失 fail-closed（suppress + warn）；畸形 schema 丢 envelope；
 *   J. 零持久化（broker 不落任何文件）；disposer 幂等。
 *   K. 图片块：attachment 引用经 attachments 服务解析为 base64 image
 *      block（过 schema）；不可读/超大/坏媒体型 → 丢弃 + truncated；
 *   L. 台账：subscribe 成功落 bind、disposer 落 release（恰一次）、
 *      scope 拒绝不落 bind。
 *
 * HOME/USERPROFILE 在导入 src 前隔离。
 *
 * Run via `node --import tsx/esm scripts/verify-plugin-messages.ts`.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// ── 隔离 HOME（必须先于任何 src 导入）─────────────────────────────────────
const fakeHome = mkdtempSync(join(tmpdir(), 'dsh-plugin-messages-home-'))
process.env.HOME = fakeHome
process.env.USERPROFILE = fakeHome
process.env.DSH_TUI_LANG = 'zh'

const { Context, Service } = await import('@deepseek-ai/cordis')
const pluginHostRow = await import('../src/dsh-adapter/plugin-host.js')
const {
  TuiMessageObserverRuntime,
  getHostMessageObserver,
  OBSERVE_SCOPE_MAX_CHARS,
  OBSERVE_SUMMARY_CELLS,
} = await import('../src/dsh-adapter/message-observer.js')
const { loadSpecData } = await import('../src/plugin-spec/registry.js')
const { check } = await import('../src/plugin-spec/schema-check.js')
const { DATA_DIR } = await import('../src/utils/paths.js')
const { mountAdmitted, testManifest, MESSAGE_COORDINATE } = await import('../src/dsh-adapter/plugin-test-utils.js')
const { validateMessageEvent } = await import('@dsh-std/messages')
import type { MessagesObserveEnvelope } from '../src/dsh-adapter/message-observer.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const data = loadSpecData(join(root, 'dsh-ecosystem-spec'))
if (!data) {
  console.error('vendored spec data unreadable (dsh-ecosystem-spec/)')
  process.exit(1)
}
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const cleanup: string[] = [fakeHome]

let checks = 0
const failures: string[] = []
const check1 = (name: string, ok: boolean, detail?: string) => {
  checks += 1
  if (!ok) failures.push(`${name}${detail ? `: ${detail}` : ''}`)
}

// ── 授权文件：按 manifest Component ID 与订阅 scope 授权 ──
mkdirSync(DATA_DIR, { recursive: true })
const componentId = (plugin: string) => `com.example.${plugin}`
const observeGrant = (plugin: string, scope: string) => ({ name: 'messages.observe.read', scope })
writeFileSync(join(DATA_DIR, 'extension-grants.json'), JSON.stringify({
  grants: {
    'com.example.alpha': [observeGrant('alpha', 'session:*')],
    'com.example.beta': [observeGrant('beta', 'session:*')],
    'com.example.carol': [observeGrant('carol', 'session:*')],
    'com.example.dave': [observeGrant('dave', 'session:*')],
  },
}))

const hostCtx = new Context()
const hostWarnings: string[] = []
hostCtx.logger.warn = (format: unknown, ...params: unknown[]) => {
  hostWarnings.push([format, ...params].map(String).join(' '))
}
hostCtx.plugin({ name: pluginHostRow.name, apply: pluginHostRow.apply })
await sleep(50)
const broker = hostCtx.get('tuiMessageObserver')
if (broker === undefined) {
  console.error('tuiMessageObserver not mounted')
  process.exit(1)
}
const publish = (runtime: InstanceType<typeof TuiMessageObserverRuntime>, session: unknown, event: unknown): void => {
  const host = getHostMessageObserver(runtime)
  if (host === undefined) throw new Error('message observer host ingress unavailable')
  host.publish(session, event)
}
check1('host-only publish ingress is absent from the plugin-visible broker',
  !('publish' in (broker as object)) && !('publishGuarded' in (broker as object)))

const received = new Map<string, MessagesObserveEnvelope[]>()
const admittedContexts = new Map<string, InstanceType<typeof Context>>()
const subscribeAs = async (
  plugin: string,
  listener?: (envelope: MessagesObserveEnvelope) => void,
  scope = 'session:sess-1',
  options: { declarePermission?: boolean; declareSubscription?: boolean; declaredScope?: string } = {},
): Promise<() => boolean> => {
  const declaredScope = options.declaredScope ?? scope
  const admitted = await mountAdmitted(hostCtx, plugin, testManifest({
    id: componentId(plugin),
    requires: [MESSAGE_COORDINATE],
    permissions: options.declarePermission === false ? [] : [observeGrant(plugin, declaredScope)],
    subscriptions: options.declareSubscription === false ? [] : [
      { apiVersion: MESSAGE_COORDINATE.apiVersion, kind: MESSAGE_COORDINATE.kind, scope: declaredScope },
    ],
  }))
  admittedContexts.set(plugin, admitted.context)
  const disposer = admitted.context.get('tuiMessageObserver').subscribe(admitted.context, envelope => {
    const list = received.get(plugin) ?? []
    list.push(envelope)
    received.set(plugin, list)
    listener?.(envelope)
  }, { scope })
  return disposer
}

const userEvent = (seq: number, text: string, id = `user-${seq}`) => ({
  type: 'user/message',
  seq,
  time: 1_700_000_000_000 + seq,
  data: { id, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } },
})
const assistantEvent = (seq: number, text: string, id = `asst-${seq}`) => ({
  type: 'assistant/message',
  seq,
  time: 1_700_000_000_000 + seq,
  data: {
    turn: 0,
    step: 0,
    message: { id, role: 'assistant', content: [{ type: 'text', text }], source: { kind: 'model' } },
  },
})
const session = (id: string) => ({ id })

await subscribeAs('alpha')

// ── A. 双映射 + envelope 逐字段 + 独立 schema 校验 ───────────────────────
{
  publish(broker, session('sess-1'), userEvent(1, '  hello broker  ', 'm-user-1'))
  publish(broker, session('sess-1'), assistantEvent(2, 'reply text', 'm-asst-2'))
  await sleep(20)
  const list = received.get('alpha') ?? []
  check1('two mapped envelopes delivered', list.length === 2, `got ${list.length}`)
  const [first, second] = list
  check1('user/message maps to message.received', first?.payload.kind === 'message.received')
  check1('assistant/message maps to message.sent', second?.payload.kind === 'message.sent')
  check1('eventId is <sessionId>:<seq>', first?.eventId === 'sess-1:1' && second?.eventId === 'sess-1:2')
  check1('scope is session:<id>', first?.scope === 'session:sess-1')
  check1('sequence is the event seq', first?.sequence === 1 && second?.sequence === 2)
  check1('eventType/eventVersion constants', first?.eventType === 'messages.observe' && first?.eventVersion === '0.15')
  check1('privacyClass is sensitive', first?.privacyClass === 'sensitive' && second?.privacyClass === 'sensitive')
  check1('messageId carried', first?.payload.messageId === 'm-user-1' && second?.payload.messageId === 'm-asst-2')
  check1('author labeled', first?.payload.author === 'user' && second?.payload.author === 'assistant')
  check1('content is one text block, trimmed',
    first?.payload.content.length === 1 && first?.payload.content[0].type === 'text'
    && (first?.payload.content[0] as { text: string }).text === 'hello broker')
  check1('no truncated flag on short text', first?.payload.truncated === undefined)
  let schemaError = ''
  for (const envelope of list) {
    try {
      validateMessageEvent(envelope)
    } catch (error) {
      schemaError = error instanceof Error ? error.message : String(error)
    }
  }
  check1('delivered envelopes pass the official validator independently', schemaError === '', schemaError)
}

// ── B. sequence 单调含 gap ────────────────────────────────────────────────
{
  const before = (received.get('alpha') ?? []).length
  publish(broker, session('sess-1'), { type: 'assistant/chunk', seq: 3, time: 0, data: {} })
  publish(broker, session('sess-1'), { type: 'turn/start', seq: 4, time: 0, data: {} })
  publish(broker, session('sess-1'), userEvent(5, 'after gap'))
  publish(broker, session('sess-1'), assistantEvent(9, 'further'))
  await sleep(20)
  const list = (received.get('alpha') ?? []).slice(before)
  check1('unmapped events leave gaps (no envelopes)', list.length === 2, `got ${list.length}`)
  check1('sequence stays monotonic with gaps',
    list[0]?.sequence === 5 && list[1]?.sequence === 9, JSON.stringify(list.map(e => e.sequence)))
}

// ── C. 无 grant：快速失败 + 零投递 ────────────────────────────────────────
{
  const warnBefore = hostWarnings.length
  await subscribeAs('spy', undefined, 'session:sess-1', {
    declarePermission: false,
    declareSubscription: false,
  })
  publish(broker, session('sess-1'), userEvent(10, 'spy must not see this'))
  await sleep(20)
  check1('ungranted subscription delivers nothing', (received.get('spy') ?? []).length === 0)
  check1('subscribe-time denial names the verified Component',
    hostWarnings.slice(warnBefore).some(line => line.includes('"com.example.spy"') && line.includes('statically declared')))
}

// ── D. 投递时撤销：订阅被释放 + warn ──────────────────────────────────────
{
  // 可翻转的 store：先授后撤，直接测投递时复检（生产路径=改文件+重启后
  // 新 store；这里用可变 store 精确命中复检逻辑）。
  let granted = true
  const mutableGrants = {
    allows: (_principal: unknown, permission: string, scope: string) =>
      permission === 'messages.observe.read' && scope === 'session:sess-1' && granted,
    defaultOf: () => 'deny' as const,
    knownPermissions: () => ['messages.observe.read'],
    corrupt: false,
  }
  // Keep the isolated broker in the host composition so the explicit
  // activation context remains valid while the test swaps its grant source.
  const freshCtx = hostCtx.isolate('tuiMessageObserver')
  const freshWarningsBefore = hostWarnings.length
  const runtime = new TuiMessageObserverRuntime(freshCtx, { grants: mutableGrants })
  const envelopes: MessagesObserveEnvelope[] = []
  runtime.subscribe(admittedContexts.get('alpha')!, envelope => { envelopes.push(envelope) }, { scope: 'session:sess-1' })
  publish(runtime, session('sess-1'), userEvent(1, 'before revocation'))
  await sleep(20)
  check1('deliver-time: granted delivery works', envelopes.length === 1)
  granted = false
  publish(runtime, session('sess-1'), userEvent(2, 'after revocation'))
  await sleep(20)
  check1('deliver-time: revoked subscription delivers nothing more', envelopes.length === 1)
  check1('deliver-time: revocation releases with a warning',
    hostWarnings.slice(freshWarningsBefore).some(line => line.includes('released') && line.includes('revoked')))
  // 释放后再授予也不再投递（release 是终态，contract cleanup）。
  granted = true
  publish(runtime, session('sess-1'), userEvent(3, 're-granted'))
  await sleep(20)
  check1('release is terminal (re-grant does not resurrect)', envelopes.length === 1)
}

// ── E. scope 隔离（C-042）：只收同 scope，跨会话零泄漏 ────────────────────
{
  await subscribeAs('carol', undefined, 'session:sess-A')
  await subscribeAs('dave', undefined, 'session:sess-B')
  publish(broker, session('sess-A'), userEvent(1, 'text of A'))
  publish(broker, session('sess-B'), userEvent(1, 'text of B'))
  await sleep(20)
  const carolList = received.get('carol') ?? []
  const daveList = received.get('dave') ?? []
  check1('a subscription receives ONLY its own scope', carolList.length === 1 && daveList.length === 1,
    `carol=${carolList.length} dave=${daveList.length}`)
  check1('scope labeled session:<id>, eventId per scope',
    carolList[0]?.scope === 'session:sess-A' && daveList[0]?.scope === 'session:sess-B'
    && carolList[0]?.eventId === 'sess-A:1' && daveList[0]?.eventId === 'sess-B:1')
  check1('payloads never cross scopes',
    (carolList[0]?.payload.content[0] as { text: string }).text === 'text of A'
    && (daveList[0]?.payload.content[0] as { text: string }).text === 'text of B')
  check1('a sess-1 subscription sees nothing from sess-A/sess-B',
    !(received.get('alpha') ?? []).some(envelope => envelope.scope !== 'session:sess-1'))
}

// ── E2. 空/缺失 scope 拒绝（订阅不成立，不落 bind 记录）────────────────────
{
  const warnBefore = hostWarnings.length
  let refusedDisposer: (() => boolean) | undefined
  refusedDisposer = broker.subscribe(admittedContexts.get('carol')!, () => {}, { scope: '   ' }) as () => boolean
  check1('blank scope is refused with a noop disposer', refusedDisposer?.() === false)
  check1('blank scope refusal warns',
    hostWarnings.slice(warnBefore).some(line => line.includes('not statically declared')),
    hostWarnings.slice(warnBefore).join(' | '))
}

// ── E3. 超长 session id 不得截断成另一个订阅 scope ─────────────────────────
{
  const sessionIdLimit = OBSERVE_SCOPE_MAX_CHARS - 'session:'.length
  const truncatedScope = `session:${'x'.repeat(sessionIdLimit)}`
  const before = (received.get('beta') ?? []).length
  const warningsBefore = hostWarnings.length
  await subscribeAs('beta', undefined, truncatedScope, { declaredScope: 'session:*' })
  // The previous slice() implementation delivered this into truncatedScope.
  publish(broker, session(`${'x'.repeat(sessionIdLimit)}y`), userEvent(1, 'must not cross long scope'))
  await sleep(20)
  check1('overlong session scope produces no envelope', (received.get('beta') ?? []).length === before)
  check1('overlong session scope is warned without logging the id',
    hostWarnings.slice(warningsBefore).some(line => line.includes('session scope exceeds')))
}

// ── F. listener 抛错被隔离，续投不断 ──────────────────────────────────────
{
  await subscribeAs('beta', () => { throw new Error('listener exploded') })
  const warnBefore = hostWarnings.length
  publish(broker, session('sess-1'), userEvent(20, 'beta throws on this'))
  await sleep(30)
  check1('throwing listener does not block other subscribers',
    ((received.get('alpha') ?? []).some(e => e.sequence === 20)))
  check1('throwing listener is warned and isolated',
    hostWarnings.slice(warnBefore).some(line => line.includes('"com.example.beta"') && line.includes('delivery continues')))
  publish(broker, session('sess-1'), userEvent(21, 'delivery continues'))
  await sleep(20)
  check1('delivery continues after a throw',
    ((received.get('alpha') ?? []).some(e => e.sequence === 21))
    && ((received.get('beta') ?? []).some(e => e.sequence === 21)))
}

// ── G. 截断标记 ───────────────────────────────────────────────────────────
{
  const before = (received.get('alpha') ?? []).length
  const longText = '长'.repeat(OBSERVE_SUMMARY_CELLS * 4) // CJK：每字 2 cell，确保超 200 cell
  publish(broker, session('sess-1'), userEvent(30, longText))
  await sleep(20)
  const envelope = (received.get('alpha') ?? []).slice(before)[0]
  check1('long text marks truncated', envelope?.payload.truncated === true)
  check1('summary stays within the schema bound', (envelope?.summary.length ?? 9999) <= 1024)
  check1('content keeps the full text (within the 256Ki bound)',
    (envelope?.payload.content[0] as { text: string }).text === longText)
}

// ── H. 非映射事件零产出 / 无 id session / eventId 拍平 ────────────────────
{
  const beforeAlpha = (received.get('alpha') ?? []).length
  publish(broker, session('sess-1'), { type: 'tool/call', seq: 40, time: 0, data: {} })
  publish(broker, session('sess-1'), { type: 'user/message', seq: 'not-a-number', time: 0, data: {} })
  publish(broker, { noId: true }, userEvent(41, 'no session id'))
  await sleep(20)
  check1('non-mapped events, bad seq and id-less sessions produce nothing',
    (received.get('alpha') ?? []).length === beforeAlpha,
    `got ${(received.get('alpha') ?? []).length - beforeAlpha}`)
  // eventId 拍平：订阅该 scope（carol 的第二订阅）后投递。
  const beforeCarol = (received.get('carol') ?? []).length
  await subscribeAs('carol', undefined, 'session:sess/unsafe id')
  publish(broker, session('sess/unsafe id'), userEvent(42, 'unsafe session id'))
  await sleep(20)
  const list = (received.get('carol') ?? []).slice(beforeCarol)
  check1('eventId flattens schema-unsafe characters',
    list.length === 1 && list[0]?.eventId === 'sess_unsafe_id:42' && /^[A-Za-z0-9._:-]+$/.test(list[0]?.eventId ?? ''),
    list[0]?.eventId)
}

// ── I. schema 缺失 fail-closed / 畸形 schema 丢 envelope ──────────────────
{
  // schema 不可用：suppress + warn once。
  const noSchemaCtx = hostCtx.isolate('tuiMessageObserver')
  const noSchemaWarningsBefore = hostWarnings.length
  const blind = new TuiMessageObserverRuntime(noSchemaCtx, {
    envelopeSchema: undefined,
    grants: { allows: () => true, defaultOf: () => 'allow' as const, knownPermissions: () => [], corrupt: false },
  })
  const blindEnvelopes: MessagesObserveEnvelope[] = []
  blind.subscribe(admittedContexts.get('alpha')!, envelope => { blindEnvelopes.push(envelope) }, { scope: 'session:sess-1' })
  publish(blind, session('sess-1'), userEvent(1, 'suppressed'))
  publish(blind, session('sess-1'), userEvent(2, 'still suppressed'))
  await sleep(20)
  check1('missing schema suppresses all envelopes (fail closed)', blindEnvelopes.length === 0)
  check1('missing schema warns once', hostWarnings.slice(noSchemaWarningsBefore).filter(line => line.includes('fail-closed')).length === 1)

  // 畸形 schema（永败）：envelope 产出后被丢弃 + warn。
  const strictCtx = hostCtx.isolate('tuiMessageObserver')
  const strictWarningsBefore = hostWarnings.length
  const strict = new TuiMessageObserverRuntime(strictCtx, {
    envelopeSchema: { type: 'object', required: ['never-present'] },
    grants: { allows: () => true, defaultOf: () => 'allow' as const, knownPermissions: () => [], corrupt: false },
  })
  const strictEnvelopes: MessagesObserveEnvelope[] = []
  strict.subscribe(admittedContexts.get('alpha')!, envelope => { strictEnvelopes.push(envelope) }, { scope: 'session:sess-1' })
  publish(strict, session('sess-1'), userEvent(1, 'dropped by self-check'))
  await sleep(20)
  check1('failing self-check drops the envelope', strictEnvelopes.length === 0)
  check1('self-check drop warns', hostWarnings.slice(strictWarningsBefore).some(line => line.includes('standard validator')))
}

// ── J. 零持久化 / disposer 幂等 ───────────────────────────────────────────
{
  const files = readdirSync(DATA_DIR).sort()
  // 批 5 起授权拒绝/撤销会落效果台账（宿主观测面，C-060）——允许台账文件，
  // 但 broker 自身依旧零历史，且台账里绝不允许出现消息内容。
  check1('the broker persists nothing beyond the host effect ledger',
    JSON.stringify(files) === JSON.stringify(['effect-ledger.jsonl', 'extension-grants.json'].sort()), files.join(','))
  const ledgerText = readFileSync(join(DATA_DIR, 'effect-ledger.jsonl'), 'utf8')
  const payloads = ['hello broker', 'spy must not see this', 'text of A', 'text of B', 'beta throws on this', 'delivery continues', 'unsafe session id']
  check1('no message payload reaches the ledger file', payloads.every(text => !ledgerText.includes(text)))
  const disposer = await subscribeAs('beta') // beta 有授权；第二个同名订阅
  check1('first release returns true', disposer() === true)
  check1('second release is a harmless false', disposer() === false)
}

// ── K. 图片块：attachment 引用 → base64；失败即弃 + truncated ──────────────
{
  class FakeAttachments extends Service {
    constructor(ctx: InstanceType<typeof Context>) {
      super(ctx, 'attachments')
    }
    async readImage(ref: unknown): Promise<{ data: Uint8Array }> {
      if ((ref as { attachmentId?: unknown }).attachmentId === 'broken') throw new Error('read failed')
      return { data: new Uint8Array([1, 2, 3]) }
    }
  }
  hostCtx.plugin(FakeAttachments)
  await sleep(30)
  const imgEvent = (seq: number, blocks: unknown[], id = `img-${seq}`) => ({
    type: 'user/message',
    seq,
    time: 1_700_100_000_000 + seq,
    data: { id, role: 'user', content: blocks, source: { kind: 'user' } },
  })
  const beforeDave = (received.get('dave') ?? []).length
  await subscribeAs('dave', undefined, 'session:sess-img')
  publish(broker, session('sess-img'), imgEvent(1, [
    { type: 'text', text: 'see ' },
    { type: 'image', attachment: { attachmentId: 'a1', mediaType: 'image/png', bytes: 3, width: 1, height: 1 } },
    { type: 'text', text: ' done' },
  ]))
  await sleep(30)
  const img1 = (received.get('dave') ?? []).slice(beforeDave)[0]
  const blocks = img1?.payload.content ?? []
  check1('image attachment resolves to a base64 image block in place',
    blocks.length === 3 && blocks[0]?.type === 'text' && blocks[1]?.type === 'image' && blocks[2]?.type === 'text',
    JSON.stringify(blocks.map(block => block.type)))
  check1('image data is base64 of the attachment bytes, mimeType from the ref',
    (blocks[1] as { data?: string } | undefined)?.data === 'AQID'
    && (blocks[1] as { mimeType?: string } | undefined)?.mimeType === 'image/png')
  check1('no truncation on a readable image', img1?.payload.truncated === undefined)
  let imgSchemaError = ''
  try {
    validateMessageEvent(img1)
  } catch (error) {
    imgSchemaError = error instanceof Error ? error.message : String(error)
  }
  check1('mixed text/image envelope passes the official validator', imgSchemaError === '', imgSchemaError)

  // 超大（bytes 超预算——读取前即拒）→ 丢弃 + truncated，两侧文本合一。
  publish(broker, session('sess-img'), imgEvent(2, [
    { type: 'text', text: 'before ' },
    { type: 'image', attachment: { attachmentId: 'big', mediaType: 'image/png', bytes: 192 * 1024 + 1 } },
    { type: 'text', text: ' after' },
  ]))
  // 读取失败（attachments 服务抛错）→ 丢弃 + truncated。
  publish(broker, session('sess-img'), imgEvent(3, [
    { type: 'text', text: 'broken image follows' },
    { type: 'image', attachment: { attachmentId: 'broken', mediaType: 'image/png', bytes: 3 } },
  ]))
  // 坏媒体型（不过 schema 的 mimeType 模式）→ 读取前即弃。
  publish(broker, session('sess-img'), imgEvent(4, [
    { type: 'image', attachment: { attachmentId: 'a2', mediaType: 'image/png; injected', bytes: 3 } },
  ]))
  await sleep(30)
  const dropped = (received.get('dave') ?? []).slice(beforeDave)
  const oversize = dropped.find(envelope => envelope.sequence === 2)
  check1('oversize image drops before any read, text blocks merge',
    oversize?.payload.content.length === 1 && oversize.payload.content[0].type === 'text'
    && (oversize.payload.content[0] as { text: string }).text === 'before  after')
  check1('oversize image marks truncated', oversize?.payload.truncated === true)
  const broken = dropped.find(envelope => envelope.sequence === 3)
  check1('unreadable image drops with truncated (text survives)',
    broken?.payload.truncated === true && broken.payload.content.length === 1
    && broken.payload.content[0].type === 'text')
  const badMime = dropped.find(envelope => envelope.sequence === 4)
  check1('bad-mime image drops; zero surviving blocks collapse to one empty text block',
    badMime?.payload.truncated === true && badMime.payload.content.length === 1
    && badMime.payload.content[0].type === 'text'
    && (badMime.payload.content[0] as { text: string }).text === '')
}

// ── M. 台账：subscribe bind / disposer release / 拒绝路径 ──────────────────
{
  const records = readFileSync(join(DATA_DIR, 'effect-ledger.jsonl'), 'utf8')
    .split('\n')
    .filter(line => line.trim() !== '')
    .map(line => JSON.parse(line) as {
      operation?: string
      pluginId?: string
      result?: string
      errorCode?: string
      resource?: { kind?: string; id?: string }
    })
  const subscriptionBinds = records.filter(record =>
    record.operation === 'bind' && record.resource?.kind === 'subscription' && record.result === 'applied')
  const subscriptionReleases = records.filter(record =>
    record.operation === 'release' && record.resource?.kind === 'subscription' && record.result === 'applied')
  check1('a successful subscribe lands a bind/subscription record',
    subscriptionBinds.some(record => record.pluginId === 'com.example.alpha' && record.resource?.id === 'com.example.alpha'))
  check1('the disposed beta subscription lands exactly one release record',
    subscriptionReleases.filter(record => record.pluginId === 'com.example.beta').length === 1)
  check1('a denied subscribe records permission bind failed (never a subscription bind)',
    !subscriptionBinds.some(record => record.pluginId === 'com.example.spy')
    && records.some(record =>
      record.pluginId === 'com.example.spy' && record.resource?.kind === 'permission'
      && record.result === 'failed' && record.errorCode === 'PERMISSION_NOT_GRANTED'))
  check1('a refused (blank-scope) subscribe leaves no bind record',
    subscriptionBinds.filter(record => record.pluginId === 'com.example.carol').length === 2,
    `carol binds: ${subscriptionBinds.filter(record => record.pluginId === 'com.example.carol').length} (2 legitimate, refusal must add none)`)
}

// ── 汇总 ──────────────────────────────────────────────────────────────────
for (const dir of cleanup) rmSync(dir, { recursive: true, force: true })
if (failures.length > 0) {
  console.error(`plugin-messages battery FAILED (${failures.length}/${checks}):`)
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}
console.log(`plugin-messages battery OK (${checks} checks: mapping, schema, grants, revocation, scope, isolation, truncation, fail-closed, retention)`)
process.exit(0)
