/**
 * 批 4 电池：messages.observe broker（C-042）。
 *
 *   A. 授权订阅收到双映射 envelope（user/message→message.received、
 *      assistant/message→message.sent），envelope 独立过 vendored schema，
 *      eventId/scope/messageId/author 逐字段；
 *   B. sequence=event.seq 单调含 gap（非映射事件留洞）；
 *   C. 无 grant：订阅快速失败（noop disposer + warn），零投递；
 *   D. 投递时撤销：store 翻转后订阅被释放 + warn，后续零投递；
 *   E. scope 按 session 正确标注（跨会话不串）；
 *   F. listener 抛错/拒绝被隔离，其他订阅续投；
 *   G. 截断：长文 summary 截断 + payload.truncated；短文无标记；
 *   H. 非映射事件零产出；session 无 id 丢弃；eventId 字符拍平；
 *   I. schema 缺失 fail-closed（suppress + warn）；畸形 schema 丢 envelope；
 *   J. 零持久化（broker 不落任何文件）；disposer 幂等。
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

const { Context } = await import('@deepseek-ai/cordis')
const pluginHostRow = await import('../src/dsh-adapter/plugin-host.js')
const { TuiMessageObserverRuntime, OBSERVE_SUMMARY_CELLS } = await import('../src/dsh-adapter/message-observer.js')
const { loadSpecData } = await import('../src/plugin-spec/registry.js')
const { check } = await import('../src/plugin-spec/schema-check.js')
const { DATA_DIR } = await import('../src/utils/paths.js')
import type { MessagesObserveEnvelope } from '../src/dsh-adapter/message-observer.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const data = loadSpecData(join(root, 'ecosystem-spec'))
if (!data) {
  console.error('vendored spec data unreadable (ecosystem-spec/)')
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

// ── 授权文件：alpha/beta 授予 messages.observe.read；spy 无授权 ──────────
mkdirSync(DATA_DIR, { recursive: true })
writeFileSync(join(DATA_DIR, 'extension-grants.json'), JSON.stringify({
  grants: { alpha: ['messages.observe.read'], beta: ['messages.observe.read'] },
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

const received = new Map<string, MessagesObserveEnvelope[]>()
const subscribeAs = async (plugin: string, listener?: (envelope: MessagesObserveEnvelope) => void): Promise<() => void> => {
  let disposer: () => void = () => false
  hostCtx.plugin({
    name: plugin,
    apply: (c: InstanceType<typeof Context>) => {
      disposer = c.get('tuiMessageObserver').subscribe(c, envelope => {
        const list = received.get(plugin) ?? []
        list.push(envelope)
        received.set(plugin, list)
        listener?.(envelope)
      })
    },
  })
  await sleep(30)
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
  broker.publish(session('sess-1'), userEvent(1, '  hello broker  ', 'm-user-1'))
  broker.publish(session('sess-1'), assistantEvent(2, 'reply text', 'm-asst-2'))
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
      check(envelope, data.schemas.message, data.schemas.message)
    } catch (error) {
      schemaError = error instanceof Error ? error.message : String(error)
    }
  }
  check1('delivered envelopes pass the vendored schema independently', schemaError === '', schemaError)
}

// ── B. sequence 单调含 gap ────────────────────────────────────────────────
{
  const before = (received.get('alpha') ?? []).length
  broker.publish(session('sess-1'), { type: 'assistant/chunk', seq: 3, time: 0, data: {} })
  broker.publish(session('sess-1'), { type: 'turn/start', seq: 4, time: 0, data: {} })
  broker.publish(session('sess-1'), userEvent(5, 'after gap'))
  broker.publish(session('sess-1'), assistantEvent(9, 'further'))
  await sleep(20)
  const list = (received.get('alpha') ?? []).slice(before)
  check1('unmapped events leave gaps (no envelopes)', list.length === 2, `got ${list.length}`)
  check1('sequence stays monotonic with gaps',
    list[0]?.sequence === 5 && list[1]?.sequence === 9, JSON.stringify(list.map(e => e.sequence)))
}

// ── C. 无 grant：快速失败 + 零投递 ────────────────────────────────────────
{
  const warnBefore = hostWarnings.length
  await subscribeAs('spy')
  broker.publish(session('sess-1'), userEvent(10, 'spy must not see this'))
  await sleep(20)
  check1('ungranted subscription delivers nothing', (received.get('spy') ?? []).length === 0)
  check1('subscribe-time denial warns with plugin + grant',
    hostWarnings.slice(warnBefore).some(line => line.includes('"spy"') && line.includes('messages.observe.read')))
}

// ── D. 投递时撤销：订阅被释放 + warn ──────────────────────────────────────
{
  // 可翻转的 store：先授后撤，直接测投递时复检（生产路径=改文件+重启后
  // 新 store；这里用可变 store 精确命中复检逻辑）。
  let granted = true
  const mutableGrants = {
    allows: (_plugin: string, permission: string) => permission === 'messages.observe.read' && granted,
    defaultOf: () => 'deny' as const,
    knownPermissions: () => ['messages.observe.read'],
    corrupt: false,
  }
  const freshCtx = new Context()
  const freshWarnings: string[] = []
  freshCtx.logger.warn = (format: unknown, ...params: unknown[]) => {
    freshWarnings.push([format, ...params].map(String).join(' '))
  }
  const runtime = new TuiMessageObserverRuntime(freshCtx, { grants: mutableGrants })
  const envelopes: MessagesObserveEnvelope[] = []
  runtime.subscribe(freshCtx, envelope => { envelopes.push(envelope) })
  runtime.publish(session('sess-x'), userEvent(1, 'before revocation'))
  await sleep(20)
  check1('deliver-time: granted delivery works', envelopes.length === 1)
  granted = false
  runtime.publish(session('sess-x'), userEvent(2, 'after revocation'))
  await sleep(20)
  check1('deliver-time: revoked subscription delivers nothing more', envelopes.length === 1)
  check1('deliver-time: revocation releases with a warning',
    freshWarnings.some(line => line.includes('released') && line.includes('revoked')))
  // 释放后再授予也不再投递（release 是终态，contract cleanup）。
  granted = true
  runtime.publish(session('sess-x'), userEvent(3, 're-granted'))
  await sleep(20)
  check1('release is terminal (re-grant does not resurrect)', envelopes.length === 1)
}

// ── E. scope 按 session 正确标注 ──────────────────────────────────────────
{
  const before = (received.get('alpha') ?? []).length
  broker.publish(session('sess-A'), userEvent(1, 'text of A'))
  broker.publish(session('sess-B'), userEvent(1, 'text of B'))
  await sleep(20)
  const [a, b] = (received.get('alpha') ?? []).slice(before)
  check1('same seq in two sessions stays distinct by scope',
    a?.scope === 'session:sess-A' && b?.scope === 'session:sess-B'
    && a?.eventId === 'sess-A:1' && b?.eventId === 'sess-B:1')
  check1('payloads do not cross sessions',
    (a?.payload.content[0] as { text: string }).text === 'text of A'
    && (b?.payload.content[0] as { text: string }).text === 'text of B')
}

// ── F. listener 抛错被隔离，续投不断 ──────────────────────────────────────
{
  await subscribeAs('beta', () => { throw new Error('listener exploded') })
  const warnBefore = hostWarnings.length
  broker.publish(session('sess-1'), userEvent(20, 'beta throws on this'))
  await sleep(30)
  check1('throwing listener does not block other subscribers',
    ((received.get('alpha') ?? []).some(e => e.sequence === 20)))
  check1('throwing listener is warned and isolated',
    hostWarnings.slice(warnBefore).some(line => line.includes('"beta"') && line.includes('isolated')))
  broker.publish(session('sess-1'), userEvent(21, 'delivery continues'))
  await sleep(20)
  check1('delivery continues after a throw',
    ((received.get('alpha') ?? []).some(e => e.sequence === 21))
    && ((received.get('beta') ?? []).some(e => e.sequence === 21)))
}

// ── G. 截断标记 ───────────────────────────────────────────────────────────
{
  const before = (received.get('alpha') ?? []).length
  const longText = '长'.repeat(OBSERVE_SUMMARY_CELLS * 4) // CJK：每字 2 cell，确保超 200 cell
  broker.publish(session('sess-1'), userEvent(30, longText))
  await sleep(20)
  const envelope = (received.get('alpha') ?? []).slice(before)[0]
  check1('long text marks truncated', envelope?.payload.truncated === true)
  check1('summary stays within the schema bound', (envelope?.summary.length ?? 9999) <= 1024)
  check1('content keeps the full text (within the 256Ki bound)',
    (envelope?.payload.content[0] as { text: string }).text === longText)
}

// ── H. 非映射事件零产出 / 无 id session / eventId 拍平 ────────────────────
{
  const before = (received.get('alpha') ?? []).length
  broker.publish(session('sess-1'), { type: 'tool/call', seq: 40, time: 0, data: {} })
  broker.publish(session('sess-1'), { type: 'user/message', seq: 'not-a-number', time: 0, data: {} })
  broker.publish({ noId: true }, userEvent(41, 'no session id'))
  broker.publish(session('sess/unsafe id'), userEvent(42, 'unsafe session id'))
  await sleep(20)
  const list = (received.get('alpha') ?? []).slice(before)
  check1('non-mapped events, bad seq and id-less sessions produce nothing', list.length === 1, `got ${list.length}`)
  check1('eventId flattens schema-unsafe characters',
    list[0]?.eventId === 'sess_unsafe_id:42' && /^[A-Za-z0-9._:-]+$/.test(list[0]?.eventId ?? ''))
}

// ── I. schema 缺失 fail-closed / 畸形 schema 丢 envelope ──────────────────
{
  // schema 不可用：suppress + warn once。
  const noSchemaCtx = new Context()
  const noSchemaWarnings: string[] = []
  noSchemaCtx.logger.warn = (format: unknown, ...params: unknown[]) => {
    noSchemaWarnings.push([format, ...params].map(String).join(' '))
  }
  const blind = new TuiMessageObserverRuntime(noSchemaCtx, {
    envelopeSchema: undefined,
    grants: { allows: () => true, defaultOf: () => 'allow' as const, knownPermissions: () => [], corrupt: false },
  })
  const blindEnvelopes: MessagesObserveEnvelope[] = []
  blind.subscribe(noSchemaCtx, envelope => { blindEnvelopes.push(envelope) })
  blind.publish(session('sess-1'), userEvent(1, 'suppressed'))
  blind.publish(session('sess-1'), userEvent(2, 'still suppressed'))
  await sleep(20)
  check1('missing schema suppresses all envelopes (fail closed)', blindEnvelopes.length === 0)
  check1('missing schema warns once', noSchemaWarnings.filter(line => line.includes('fail-closed')).length === 1)

  // 畸形 schema（永败）：envelope 产出后被丢弃 + warn。
  const strictCtx = new Context()
  const strictWarnings: string[] = []
  strictCtx.logger.warn = (format: unknown, ...params: unknown[]) => {
    strictWarnings.push([format, ...params].map(String).join(' '))
  }
  const strict = new TuiMessageObserverRuntime(strictCtx, {
    envelopeSchema: { type: 'object', required: ['never-present'] },
    grants: { allows: () => true, defaultOf: () => 'allow' as const, knownPermissions: () => [], corrupt: false },
  })
  const strictEnvelopes: MessagesObserveEnvelope[] = []
  strict.subscribe(strictCtx, envelope => { strictEnvelopes.push(envelope) })
  strict.publish(session('sess-1'), userEvent(1, 'dropped by self-check'))
  await sleep(20)
  check1('failing self-check drops the envelope', strictEnvelopes.length === 0)
  check1('self-check drop warns', strictWarnings.some(line => line.includes('vendored schema')))
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

// ── 汇总 ──────────────────────────────────────────────────────────────────
for (const dir of cleanup) rmSync(dir, { recursive: true, force: true })
if (failures.length > 0) {
  console.error(`plugin-messages battery FAILED (${failures.length}/${checks}):`)
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}
console.log(`plugin-messages battery OK (${checks} checks: mapping, schema, grants, revocation, scope, isolation, truncation, fail-closed, retention)`)
process.exit(0)
