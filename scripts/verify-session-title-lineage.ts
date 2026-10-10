/**
 * 会话血缘 × 自动标题回归：空白会话上的 `/model` 不得让首个真实 prompt
 * 永远拿不到自动生成的 session title。
 *
 *  1. 纯函数矩阵（childRecordsLineage）：只有会话脚手架事件的 seed 不记
 *     血缘；人写的 user/message（纯图片也算）记血缘；插件来源的 user-role
 *     消息不记。
 *  2. 真链路（channel.switchModel + fake agents）：空白源的子会话
 *     `meta.parentSession` 必须缺席（上游 dsh-session-title 只在
 *     `parentSession === undefined` 的会话上为首条人消息安排生成）；已对话
 *     的源仍必须记血缘（既有 /model 分支语义不得被这次修复削掉）。
 *
 * 背景：/model 过去无条件把当前会话重建成 seeded fork 并写 parentSession，
 * 而上游的 first-prompt provider 对有 parent 的会话永久不合格（fork 不重试，
 * 只有 ctx.sessionTitle.refresh() 才重来，TUI 没有这个面）。于是“先 /model
 * 再提问”的新会话只剩 fallback 标题——首条 prompt 的 40 字节腰斩。
 *
 * 运行：node --import tsx/esm scripts/verify-session-title-lineage.ts
 */
// 隔离家目录：switchModel 会把选择写进 ~/.dsh-tui/model.json（modelPrefs 在
// 模块加载时按 homedir() 解析）。必须在 import src 之前；HOME 与
// USERPROFILE 成对设置，两个平台都隔离。
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const reproHome = mkdtempSync(join(tmpdir(), 'dshtui-title-lineage-'))
process.env.HOME = reproHome
process.env.USERPROFILE = reproHome

const [{ createChannel }, { childRecordsLineage }, { settled }] = await Promise.all([
  import('../src/dsh-adapter/channel.js'),
  import('../src/dsh-adapter/channel/session-lineage.js'),
  import('./lib/term-test.mjs'),
])

let failed = 0
function check(name: string, ok: boolean, extra = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed += 1
}

type AnyEvent = { readonly seq: number, readonly time: number, readonly type: string, readonly data: Record<string, unknown> }
const ev = (seq: number, type: string, data: Record<string, unknown> = {}): AnyEvent =>
  ({ seq, time: 1_700_000_000_000 + seq, type, data })

// ==== 1. 纯函数矩阵 ==========================================================
{
  const scaffolding = [
    ev(0, 'permission/preset', { preset: 'danger-full-access' }),
    ev(1, 'sandbox/mode', { mode: 'workspace-write' }),
    ev(2, 'approval/policy', { policy: 'ask' }),
  ]
  check('lineage: an empty seed records none', childRecordsLineage([]) === false)
  check('lineage: session scaffolding records none', childRecordsLineage(scaffolding) === false)
  check(
    'lineage: a human prompt records lineage',
    childRecordsLineage([...scaffolding, ev(3, 'user/message', {
      source: { kind: 'user' }, content: [{ type: 'text', text: '改一下标题' }],
    })]) === true,
  )
  check(
    'lineage: an image-only human prompt still records lineage',
    childRecordsLineage([ev(0, 'user/message', {
      source: { kind: 'user' }, content: [{ type: 'image', attachment: { attachmentId: 'sha256:x' } }],
    })]) === true,
  )
  check(
    'lineage: a plugin-sourced user-role message records none',
    childRecordsLineage([
      ev(0, 'user/message', { source: { kind: 'plugin', plugin: 'x' }, content: [{ type: 'text', text: 'injected' }] }),
      ev(1, 'user/message', { content: [{ type: 'text', text: 'sourceless' }] }),
    ]) === false,
    'both non-human sources must stay non-lineage',
  )
}

// ==== 2. 真链路：switchModel 建子会话时写的 meta.parentSession ===============
const stubAgentCtx = { on: () => () => {} }
function makeAgent(id: string, sessionId: string, sessionEvents: readonly unknown[]) {
  // The live Session contract includes the durable `append` the cut-policy
  // replay uses (`/model` no longer only reads the cut — it writes the facts a
  // conversation-less cut carries into the unseeded child, T-FIX-17). The
  // double records them in its own log, and `seq` stays the exclusive offset.
  const events = [...sessionEvents]
  return {
    id,
    status: 'idle',
    session: {
      id: sessionId,
      get seq() { return events.length },
      events,
      header: {},
      append(type: string, data: Record<string, unknown>): void {
        events.push({ seq: events.length, time: 1_700_000_000_000 + events.length, type, data })
      },
    },
    ctx: stubAgentCtx,
    followup() {},
    steer() {},
    inbox: { remove: () => true },
  } as never
}

function assemble(sourceEvents: readonly AnyEvent[]) {
  const creates: Array<Record<string, unknown>> = []
  const services: Record<string, unknown> = {
    agents: {
      async create(options: Record<string, unknown>) {
        creates.push(options)
        const seed = (options['seed'] ?? []) as readonly unknown[]
        return { agent: makeAgent(`fork-${creates.length}`, `child-${creates.length}`, seed), dispose: async () => {} }
      },
    },
    llm: {
      listProviders: () => [{ id: 'fake-provider' }],
      listModels: async () => [{ provider: 'fake-provider', id: 'model-b', name: 'Model B' }],
    },
  }
  const ctx = {
    on: () => () => {},
    get: (name: string) => services[name],
    logger: { warn() {} },
  }
  const channel = createChannel(ctx as never, makeAgent('a1', 'source-session', sourceEvents) as never, {
    model: 'model-a',
    cwd: '/tmp/demo',
    provider: 'fake-provider',
    activity: false,
  })
  return { channel, creates }
}

const blankSource = [
  ev(0, 'permission/preset', { preset: 'danger-full-access' }),
  ev(1, 'sandbox/mode', { mode: 'workspace-write' }),
  ev(2, 'approval/policy', { policy: 'ask' }),
  ev(3, 'subagent/model-selection-policy', { allowedModels: [] }),
]
{
  const { channel, creates } = assemble(blankSource)
  const switched = await channel.switchModel('fake-provider', 'model-b')
  const adopted = await settled(() => creates.length === 1)
  check('blank: switch succeeds and creates exactly one child', switched === true && adopted, `creates=${creates.length}`)
  const meta = (creates[0]?.['meta'] ?? {}) as Record<string, unknown>
  check('blank: the child records no parentSession', meta['parentSession'] === undefined, JSON.stringify(meta))
  // T-FIX-10/11/12 changed this semantics ON PURPOSE (declared in PR #1407's
  // "Change outline"): a source that never held a conversation no longer seeds
  // its `/model` child at all, so there is no inherited cut left to mark. The
  // child is created as an ordinary fresh session (`createFreshAgent`: no
  // `seed`, no `seedLength`/`isSeeded`, no `parentSession`) because the host
  // materialises the seed prefix BEFORE `session/created` (agent-loop
  // `appendUnstoredSuffix` → `writer.append` → `persistBatch(…,
  // isMaterialized: false)` → `materialize()`), which would publish a seeded
  // child of an empty source as a permission-initialization shell — exactly the
  // blank sidebar row this change exists to remove. The two checks below are
  // the previous pair ("still inherits the seed" / "is a seeded root") restated
  // for that semantics; the `prompted` case keeps the opposite direction.
  // Evidence: POST-ARCHIVE-ADDENDUM.md §11 (PR #1407 CI forensics) and
  // T-FIX-10-SUMMARY.md「为什么必须换 createFreshAgent 而不只是 seed: []」.
  check(
    'blank: the child starts unseeded (an empty cut copies nothing)',
    ((creates[0]?.['seed'] ?? []) as unknown[]).length === 0,
    JSON.stringify(creates[0]?.['seed'] ?? null),
  )
  check(
    'blank: the child is a fresh root (no inherited cut is marked)',
    meta['isSeeded'] === undefined && meta['seedLength'] === undefined,
    JSON.stringify(meta),
  )
}

{
  const { channel, creates } = assemble([
    ...blankSource,
    ev(4, 'turn/start', { turn: 0 }),
    ev(5, 'user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: '第一个问题' }] }),
    ev(6, 'turn/end', { turn: 0, reason: { kind: 'completed' } }),
  ])
  const switched = await channel.switchModel('fake-provider', 'model-b')
  const adopted = await settled(() => creates.length === 1)
  check('prompted: switch succeeds and creates exactly one child', switched === true && adopted, `creates=${creates.length}`)
  const meta = (creates[0]?.['meta'] ?? {}) as Record<string, unknown>
  check(
    'prompted: the child still records the source as its parent',
    String(meta['parentSession']) === 'source-session',
    JSON.stringify(meta),
  )
  // The opposite direction of the `blank` pair above, and the reason the fix is
  // a verdict instead of "never seed": a source that holds a conversation still
  // copies its whole prefix and still marks that cut as inherited.
  const seed = (creates[0]?.['seed'] ?? []) as unknown[]
  check(
    'prompted: the child still inherits the whole source prefix',
    seed.length > 0 && (meta['isSeeded'] === true || meta['seedLength'] === seed.length),
    JSON.stringify(meta),
  )
}

process.exit(failed)
