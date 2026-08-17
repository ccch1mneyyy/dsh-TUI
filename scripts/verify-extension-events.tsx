/**
 * End-to-end verification of the plugin decision-event seam
 * (dsh-tui-extensions): a REAL cordis context, a REAL createChannel over a
 * fake agent, and a REAL Chat screen driven through a fake TTY.
 *
 * Covered contracts:
 *  1. tui/input transform — a plugin's substitute text is what gets
 *     delivered (the typed text never reaches the agent).
 *  2. tui/input cancel — nothing is delivered, the reason is toasted.
 *  3. tui/input crash isolation — a throwing listener degrades to
 *     "no opinion"; delivery proceeds unchanged.
 *  3b. serial chain integrity — a blank rewrite / a throw / a junk return /
 *     a throwing-getter (hostile) return must NOT bail the chain: later veto
 *     listeners still run (the per-listener normalize+isolate dispatch, not
 *     raw ctx.serial).
 *  4. tui/rewind-prompt modes — the confirm pane renders the plugin's
 *     modes, picking one threads its id through rewindTo, and the
 *     tui/rewind-done summary + tui/session-switched('rewind') fire.
 *     Malformed mode fields (a non-string description/label) are stripped
 *     or dropped, never rendered raw.
 *  5. tui/rewind-prompt cancel — the rewind is vetoed before any fork.
 *  6. tui/session-switch veto + tui/session-switched on /new.
 *  7. tui/compact veto + execution through the real channel (fake
 *     compaction service via serviceForAgent's ctx.get fallback).
 *  8. compact stale-drop — a slow listener plus /new during the await must
 *     abandon the old session's compaction, never run it on the new agent.
 *  8b. compact stale-drop ABA — /new then /resume BACK to the origin session
 *     reuses its id; the reference-based stale check must still drop.
 *
 *  9. session-switch stale-drop — a parked /resume must not roll over a
 *     newer session that completed mid-await (D-6, reference comparison).
 *  9b. enqueue-time origin binding — a submission queued behind a slow
 *     decision stays bound to the session it was typed in (D-6).
 *  9c. rewind-prompt stale-drop — a parked rewind decision cancels when the
 *     session changes mid-await.
 *  9d. rewind-done decoupled — the summary listener must not delay the
 *     picked text's return nor park tui/session-switched.
 * 10. D-8 — the parked indicator covers the WHOLE decision wait (sticky
 *     until the decision settles).
 *
 * D-7 note: this battery mounts NO extensions row, so the decision guard
 * comes from createChannel itself (the P1 backstop for a stale patch /
 * bare embed). The harness subscribes on the ROOT context, so the isolated
 * home carries an extension-grants.json granting root the four intercept
 * permissions; an ungranted named plugin is asserted denied.
 *
 * Follows repro-picker-windowing.tsx: fake session event log, fake
 * sessions/agents services, plainText ANSI wash over stdout frames.
 */
process.env.FORCE_COLOR = '3'
// 断言针对中文 i18n 文案（toast/标题），与运行环境的 locale 无关。
process.env.DSH_TUI_LANG = 'zh'

// 家目录隔离：touchSession/clearResumeTarget（/new 与 rewind 都会走）写
// ~/.dsh-tui 的真实文件，必须先切到临时目录再 import src。HOME 与
// USERPROFILE 必须成对设置（POSIX 读 HOME、Windows 读 USERPROFILE）。
const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs')
const { tmpdir } = await import('node:os')
const { join: joinPath } = await import('node:path')
const isolatedHome = mkdtempSync(joinPath(tmpdir(), 'dshtui-ext-events-home-'))
process.env.HOME = isolatedHome
process.env.USERPROFILE = isolatedHome
mkdirSync(joinPath(isolatedHome, '.dsh-tui'), { recursive: true })
// createChannel installs the D-7 decision guard itself (the backstop for a
// missing dsh-tui-extensions row — this battery mounts none, so it exercises
// exactly that path). The guard reads this file at channel creation; the
// harness subscribes on the ROOT context, so root needs the grants the
// production default-deny posture would otherwise refuse.
writeFileSync(joinPath(isolatedHome, '.dsh-tui', 'extension-grants.json'), JSON.stringify({
  grants: {
    root: [
      'session.input.intercept',
      'session.rewind.intercept',
      'session.switch.intercept',
      'session.compact.intercept',
    ],
  },
}))

const [
  { PassThrough, Writable },
  React,
  { Context },
  { render },
  { Chat },
  { QuestionStore },
  { createChannel },
] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('@deepseek-ai/cordis'),
  import('../src/ui.js'),
  import('../src/screens/Chat.js'),
  import('../src/dsh-adapter/questions.js'),
  import('../src/dsh-adapter/channel.js'),
])

class FakeStdout extends Writable {
  columns = 100
  rows = 28
  isTTY = true
  frames: string[] = []
  _write(chunk: unknown, _encoding: BufferEncoding, callback: () => void) {
    this.frames.push(String(chunk))
    callback()
  }
}

class FakeStderr extends Writable {
  isTTY = true
  _write(_chunk: unknown, _encoding: BufferEncoding, callback: () => void) {
    callback()
  }
}

class FakeStdin extends PassThrough {
  isTTY = true
  setRawMode() { return this }
  ref() { return this }
  unref() { return this }
}

const plainText = (frames: string[]) => frames
  .join('')
  .replace(/\x1b\[(\d+)C/g, (_, n) => ' '.repeat(Number(n)))
  .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
  .replace(/\x1b\]9;[^\x07]*\x07/g, '')
  .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

/** Toasts are a LIST — the screen shows only the newest, so toast
 *  assertions read the channel's notification queue, not the frames. */
const notified = (fragment: string): boolean =>
  (channel as unknown as { notifications: readonly { text: string }[] }).notifications
    .some(item => item.text.includes(fragment))

let failures = 0
const check = (name: string, ok: boolean, detail = '') => {
  if (!ok) failures += 1
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok || detail === '' ? '' : ` — ${detail}`}`)
}

const NOW = 1700000000000

/** 10 closed turns, each turn/start + user/message + turn/end (rewindable). */
function makeEvents() {
  const events: Array<Record<string, unknown>> = []
  for (let i = 0; i < 10; i++) {
    events.push(
      { seq: i * 3, time: NOW + i * 30, type: 'turn/start', data: { turn: i } },
      {
        seq: i * 3 + 1,
        time: NOW + i * 30 + 5,
        type: 'user/message',
        data: { source: { kind: 'user' }, content: [{ type: 'text', text: `消息 ${String(i).padStart(2, '0')}` }] },
      },
      { seq: i * 3 + 2, time: NOW + i * 30 + 10, type: 'turn/end', data: { turn: i, reason: { kind: 'completed' } } },
    )
  }
  return events
}

const stubAgentCtx = { on: () => () => {} }

let forkSeq = 0

function makeAgent(id: string, sessionEvents: readonly unknown[], captured: { followupTexts: string[] }) {
  return {
    id,
    status: 'idle',
    session: { id: `s-${id}`, seq: sessionEvents.length, events: sessionEvents, header: {} },
    ctx: stubAgentCtx,
    followup(message: { content?: readonly { type?: string; text?: string }[] }) {
      const text = (message.content ?? []).filter(block => block?.type === 'text').map(block => block.text ?? '').join('\n')
      captured.followupTexts.push(text)
    },
    steer() {},
    // interruptAndDeliver aborts before re-queueing.
    cancel() {},
    inbox: { remove: () => true },
  }
}

function makeServices(captured: { followupTexts: string[]; compactCalls: string[] }) {
  return {
    sessions: { fork(session: { events: readonly unknown[] }) { return { events: session.events } } },
    agents: {
      // Unique ids per creation — state.agentId comparisons (stale-drop)
      // are meaningless if every fake agent shares one id.
      async create(options: { sessionId: string; seed?: readonly unknown[] }) {
        forkSeq += 1
        return { agent: makeAgent(`fork-${forkSeq}`, options.seed ?? [], captured), dispose: async () => {} }
      },
      // Real dsh derives the agent id from the session: resuming session A
      // yields a NEW agent object whose id equals the ORIGINAL agent's id
      // again (A → /new → /resume A). The compact stale-drop must therefore
      // compare agent REFERENCES, not ids — this fake reproduces the reuse.
      async resume(options: { resumeSessionId: string }) {
        return { agent: makeAgent(options.resumeSessionId.replace(/^s-/u, ''), makeEvents(), captured), dispose: async () => {} }
      },
    },
    llm: {
      listProviders: () => [{ id: 'fake-provider' }],
      listModels: async () => [{ provider: 'fake-provider', id: 'model-00', name: 'Model 00' }],
    },
    // serviceForAgent falls back to ctx.get when no preset roster exists, so
    // a root-provided fake compaction service reaches channel.compact().
    compaction: {
      async compactNow(agent: { id: string }) {
        captured.compactCalls.push(agent.id)
        return true
      },
    },
  }
}

// ── harness: real cordis root + real channel + real Chat ────────────────
const ctx = new Context()
const captured = { followupTexts: [] as string[], compactCalls: [] as string[] }
const services = makeServices(captured)
for (const [key, value] of Object.entries(services)) {
  // Plain-data services: provide them on the root so channel's ctx.get
  // resolves them exactly as the real service rows would.
  ;(ctx as unknown as { provide(name: string, value: unknown): () => void }).provide(key, value)
}

const channel = createChannel(ctx as never, makeAgent('a1', makeEvents(), captured) as never, {
  model: 'model-00', cwd: '/tmp/demo', provider: 'fake-provider', activity: false,
})

const stdout = new FakeStdout()
const stdin = new FakeStdin()
const instance = await render(
  <Chat channel={channel as never} questionStore={new QuestionStore()} onExit={() => {}} />,
  { stdout, stdin, stderr: new FakeStderr(), exitOnCtrlC: false, patchConsole: false },
)
await sleep(800)

// ── 0. D-7 backstop: NO extensions row is mounted in this battery, yet an
// ungranted plugin's intercept subscription is still denied — the guard
// comes from createChannel itself (the stale-patch / bare-embed path) ─────
{
  ctx.plugin({
    name: 'ungranted-probe',
    apply: (c: Context) => {
      c.on('tui/input', () => ({ cancel: true }))
    },
  })
  await sleep(150)
  channel.submit('穿透检查')
  await sleep(400)
  check('decision guard (no extensions row): ungranted plugin subscription denied',
    captured.followupTexts.some(text => text.includes('穿透检查')),
    JSON.stringify(captured.followupTexts))
}

// ── 1. tui/input transform ──────────────────────────────────────────────
{
  const dispose = ctx.on('tui/input', event => {
    if (event.text === '原始输入') return { text: '改写后的输入' }
    return undefined
  })
  channel.submit('原始输入')
  await sleep(300)
  check('tui/input transform: delivered text is the plugin substitute',
    captured.followupTexts.some(text => text.includes('改写后的输入')),
    JSON.stringify(captured.followupTexts))
  check('tui/input transform: the typed text never reached the agent',
    !captured.followupTexts.some(text => text.includes('原始输入')))
  dispose()
}

// ── 2. tui/input cancel (+ reason toast) ────────────────────────────────
{
  const before = captured.followupTexts.length
  const dispose = ctx.on('tui/input', event =>
    event.text === '别发这个' ? { cancel: true, reason: '插件拦截了这条输入' } : undefined)
  channel.submit('别发这个')
  await sleep(300)
  check('tui/input cancel: nothing delivered', captured.followupTexts.length === before)
  check('tui/input cancel: reason toasted',
    plainText(stdout.frames).includes('插件拦截了这条输入'))
  dispose()
}

// ── 2b. decision text sanitization + parked-state indicator (RFC 0005 D-8) ─
{
  // A veto reason is toast-bound plugin text: control chars are stripped
  // before it reaches the notification queue.
  const dispose = ctx.on('tui/input', event =>
    event.text === '消毒检查' ? { cancel: true, reason: '拦截\x1b[31m\x07原因' } : undefined)
  channel.submit('消毒检查')
  await sleep(300)
  check('tui/input cancel: reason sanitized before toasting',
    notified('拦截 [31m 原因')
    && !(channel as unknown as { notifications: readonly { text: string }[] }).notifications
      .some(item => item.text.includes('\x1b')))
  dispose()

  // D-8: a decision still pending past 400ms surfaces a parked indicator.
  // The listener resolves at ~600ms — deterministically beyond the threshold.
  const disposeSlow = ctx.on('tui/input', async event => {
    if (event.text !== '慢决定') return undefined
    await sleep(600)
    return { cancel: true, reason: '慢否决落地' } as const
  })
  channel.submit('慢决定')
  await sleep(550)
  check('pending decision: parked indicator toasted past 400ms',
    notified('正在等待插件决定（tui/input）'))
  await sleep(400)
  check('pending decision: the slow veto still lands',
    notified('慢否决落地') && !captured.followupTexts.some(text => text.includes('慢决定')))
  // …and the indicator is dismissed the moment the decision lands — it must
  // not linger for its 4s timeout after the flow already continued.
  check('pending decision: the parked indicator is dismissed on resolution',
    !(channel as unknown as { notifications: readonly { text: string }[] }).notifications
      .some(item => item.text.includes('正在等待插件决定')))
  disposeSlow()
}

// ── 2c. bare intercepts toast the host-localized fallback ───────────────
{
  const disposeCancel = ctx.on('tui/input', event =>
    event.text === '无声拦截' ? { cancel: true } : undefined)
  channel.submit('无声拦截')
  await sleep(400)
  check('tui/input cancel without reason: host fallback toasted',
    notified('操作已被插件取消')
    && !captured.followupTexts.some(text => text.includes('无声拦截')))
  disposeCancel()

  const disposeHandled = ctx.on('tui/input', event =>
    event.text === '无声接管' ? { handled: true } : undefined)
  channel.submit('无声接管')
  await sleep(400)
  check('tui/input handled without notice: host fallback toasted',
    notified('输入已由插件处理')
    && !captured.followupTexts.some(text => text.includes('无声接管')))
  disposeHandled()
}

// ── 2d. decision+delivery FIFO: a slow A never lets B overtake ──────────
{
  const dispose = ctx.on('tui/input', async event => {
    if (event.text === '慢条甲') await sleep(400)
    return undefined
  })
  channel.submit('慢条甲')
  channel.submit('快条乙')
  await sleep(900)
  const indexA = captured.followupTexts.findIndex(text => text.includes('慢条甲'))
  const indexB = captured.followupTexts.findIndex(text => text.includes('快条乙'))
  check('fifo: a slow decision on A does not let B overtake',
    indexA !== -1 && indexB !== -1 && indexA < indexB, JSON.stringify(captured.followupTexts))
  dispose()
}

// ── 2e. Ctrl+Enter re-queue passes through tui/input ─────────────────────
{
  const dispose = ctx.on('tui/input', event =>
    event.text === '插队文本' ? { cancel: true, reason: '插队被拦截' } : undefined)
  const before = captured.followupTexts.length
  channel.interruptAndDeliver(['插队文本'])
  await sleep(700) // the fake has no whenIdle → 200ms fallback timer + decision
  check('interruptAndDeliver: the tui/input veto applies to the Ctrl+Enter path',
    captured.followupTexts.length === before && notified('插队被拦截'))
  dispose()

  channel.interruptAndDeliver(['插队放行'])
  await sleep(700)
  check('interruptAndDeliver: the re-queue delivers without a veto',
    captured.followupTexts.some(text => text.includes('插队放行')))
}

// ── 3. tui/input crash isolation ────────────────────────────────────────
{
  const dispose = ctx.on('tui/input', () => {
    throw new Error('plugin exploded')
  })
  channel.submit('照常发送')
  await sleep(300)
  check('tui/input crash: a throwing listener degrades to no-opinion',
    captured.followupTexts.some(text => text.includes('照常发送')))
  dispose()
}

// ── 3b. serial chain integrity: malformed/crashing listeners CANNOT skip a
// later veto (raw ctx.serial would bail at the first object return or
// reject at the first throw, cutting the chain) ──────────────────────────
{
  // Blank rewrite first, veto second: the blank {text} is ignored and the
  // chain continues to the veto.
  const disposeBlank = ctx.on('tui/input', event =>
    event.text === '空白改写' ? { text: '   ' } : undefined)
  const disposeVeto = ctx.on('tui/input', event =>
    event.text === '空白改写' ? { cancel: true, reason: '安全否决生效' } : undefined)
  const before = captured.followupTexts.length
  channel.submit('空白改写')
  await sleep(300)
  check('serial chain: blank rewrite does NOT bail the chain (veto still runs)',
    captured.followupTexts.length === before && notified('安全否决生效'))
  disposeBlank()
  disposeVeto()

  // Throwing listener first, veto second: the crash is isolated, the veto
  // still runs.
  const disposeThrow = ctx.on('tui/input', event => {
    if (event.text === '崩溃在前') throw new Error('exploded')
    return undefined
  })
  const disposeVeto2 = ctx.on('tui/input', event =>
    event.text === '崩溃在前' ? { cancel: true, reason: '崩溃后的否决生效' } : undefined)
  channel.submit('崩溃在前')
  await sleep(300)
  check('serial chain: a throwing listener does NOT skip the later veto',
    !captured.followupTexts.some(text => text.includes('崩溃在前')) && notified('崩溃后的否决生效'))
  disposeThrow()
  disposeVeto2()

  // Junk primitive return first, transform second: junk is ignored.
  const disposeJunk = ctx.on('tui/input', event =>
    event.text === '垃圾返回' ? (true as never) : undefined)
  const disposeTransform = ctx.on('tui/input', event =>
    event.text === '垃圾返回' ? { text: '垃圾已被改写' } : undefined)
  channel.submit('垃圾返回')
  await sleep(300)
  check('serial chain: junk primitive return is skipped, later transform wins',
    captured.followupTexts.some(text => text.includes('垃圾已被改写')))
  disposeJunk()
  disposeTransform()

  // Hostile return value: an object whose property access THROWS (a Proxy or
  // a throwing getter). normalize runs inside the isolation boundary, so the
  // throw is logged and the chain still reaches the later veto — it must not
  // reject the whole dispatch.
  const disposeHostile = ctx.on('tui/input', event => {
    if (event.text !== '敌意返回') return undefined
    const hostile = {}
    Object.defineProperty(hostile, 'text', {
      get() { throw new Error('hostile getter') },
    })
    return hostile as never
  })
  const disposeVeto3 = ctx.on('tui/input', event =>
    event.text === '敌意返回' ? { cancel: true, reason: '敌意后的否决生效' } : undefined)
  channel.submit('敌意返回')
  await sleep(300)
  check('serial chain: a throwing-getter return is skipped, later veto still runs',
    !captured.followupTexts.some(text => text.includes('敌意返回')) && notified('敌意后的否决生效'))
  disposeHostile()
  disposeVeto3()
}

// ── 4. rewind modes: picker → mode list → rewindTo(mode) → done/switched ─
{
  const seen: { promptSeq?: number; doneMode?: string | null; switchedKind?: string } = {}
  const disposePrompt = ctx.on('tui/rewind-prompt', event => {
    seen.promptSeq = event.seq
    return {
      modes: [
        { id: 'files', label: '回退会话 + 恢复文件', description: '撤销此后的文件修改' },
        { id: 'branch', label: '回退并打标记' },
        // 畸形字段必须被剥离后复制，原始对象不得进入渲染路径:description
        // 非字符串 → 丢弃该字段但保留条目(id/label 合规);label 非字符串
        // → 整个条目丢弃。修复前 description:{} 会在 ListItem 的 .replace
        // 处直接崩掉确认面板。
        { id: 'junk-desc', label: '坏描述模式', description: {} as never },
        { id: 'junk-label', label: 42 as never },
      ],
    }
  })
  const disposeDone = ctx.on('tui/rewind-done', event => {
    seen.doneMode = event.mode
    return event.mode === 'files' ? '已恢复 2 个文件' : undefined
  })
  const disposeSwitched = ctx.on('tui/session-switched', event => {
    seen.switchedKind = event.kind
  })

  // Double-Esc on the empty input opens the picker (3s arming window).
  stdin.write('\x1b')
  await sleep(120)
  stdin.write('\x1b')
  await sleep(400)
  const listShown = plainText(stdout.frames.slice(-30)).includes('消息 09')
  check('rewind picker opens on double-Esc', listShown)

  // Enter on the newest message → the plugin decision resolves → mode list.
  stdin.write('\r')
  await sleep(400)
  const afterEnter = plainText(stdout.frames.slice(-40))
  check('rewind confirm renders plugin modes',
    afterEnter.includes('回退会话 + 恢复文件') && afterEnter.includes('仅回退会话'),
    afterEnter.slice(-200))
  check('rewind confirm: malformed description stripped, entry kept (no render crash)',
    afterEnter.includes('坏描述模式'))
  check('tui/rewind-prompt received the picked message seq', seen.promptSeq !== undefined)

  // ↓ once moves to the first plugin mode; Enter rewinds with it.
  stdin.write('\x1b[B')
  await sleep(150)
  stdin.write('\r')
  await sleep(600)
  check('picked mode id threaded to tui/rewind-done', seen.doneMode === 'files', String(seen.doneMode))
  check('tui/rewind-done summary toasted', notified('已恢复 2 个文件'))
  check("tui/session-switched fired with kind 'rewind'", seen.switchedKind === 'rewind')
  disposePrompt()
  disposeDone()
  disposeSwitched()
}

// ── 5. rewind veto: picker stays open, no fork ───────────────────────────
{
  const disposePrompt = ctx.on('tui/rewind-prompt', () => ({ cancel: true, reason: '该消息不可回退' }))
  const forkCountBefore = captured.followupTexts.length // proxy for "nothing happened"
  // The section-4 rewind restored the picked message into the input for
  // re-editing: the first Esc clears it, then the double-Esc opens the
  // picker on the now-empty input.
  stdin.write('\x1b')
  await sleep(150)
  stdin.write('\x1b')
  await sleep(120)
  stdin.write('\x1b')
  await sleep(400)
  stdin.write('\r') // Enter on the newest message → veto
  await sleep(400)
  const tail = plainText(stdout.frames.slice(-40))
  check('tui/rewind-prompt cancel: reason toasted', notified('该消息不可回退'))
  check('tui/rewind-prompt cancel: picker still open (list visible)', tail.includes('消息 09'))
  check('tui/rewind-prompt cancel: no delivery side effects', captured.followupTexts.length === forkCountBefore)
  stdin.write('\x1b') // close the picker
  await sleep(200)
  disposePrompt()
}

// ── 6. session-switch veto + switched on /new ────────────────────────────
{
  const seen: string[] = []
  const disposeSwitch = ctx.on('tui/session-switch', event => {
    seen.push(`veto:${event.kind}`)
    return { cancel: true, reason: '本工作区禁止开会话' }
  })
  const vetoed = await channel.newSession()
  check('tui/session-switch veto: /new refused', vetoed === false)
  check('tui/session-switch veto: reason toasted', notified('本工作区禁止开会话'))
  disposeSwitch()

  const disposeSwitched = ctx.on('tui/session-switched', event => {
    seen.push(`switched:${event.kind}`)
  })
  const switched = await channel.newSession()
  check('/new succeeds without the veto', switched === true)
  await sleep(200)
  check("tui/session-switched fired with kind 'new'", seen.includes('switched:new'), seen.join(','))
  disposeSwitched()
}

// ── 7. tui/compact veto + execution through the real channel ─────────────
{
  const dispose = ctx.on('tui/compact', () => ({ cancel: true, reason: '禁止压缩' }))
  channel.compact()
  await sleep(300)
  check('tui/compact veto: compaction never ran', captured.compactCalls.length === 0)
  check('tui/compact veto: reason toasted', notified('禁止压缩'))
  dispose()

  channel.compact()
  await sleep(400)
  check('tui/compact without the veto: compaction runs on the live agent',
    captured.compactCalls.length === 1, JSON.stringify(captured.compactCalls))
}

// ── 8. compact stale-drop: a slow listener + /new during the await ───────
{
  let release: (value: undefined) => void = () => {}
  const gate = new Promise<undefined>(resolve => { release = resolve })
  const dispose = ctx.on('tui/compact', () => gate)
  channel.compact()
  await sleep(200)
  const switched = await channel.newSession()
  check('compact stale-drop setup: /new succeeded mid-await', switched === true)
  release(undefined)
  await sleep(400)
  check('compact stale-drop: the old session’s compaction never ran',
    captured.compactCalls.length === 1, JSON.stringify(captured.compactCalls))
  check('compact stale-drop: stale notice toasted', notified('压缩已取消'))
  dispose()
}

// ── 8b. compact stale-drop ABA: /new then /resume BACK to the origin ─────
// Session ids are reusable: the slow listener's await spans
// A → /new → /resume A, after which state.agentId EQUALS the origin id again
// (the fake agents.resume reproduces real dsh's id reuse). An id-based stale
// check would pass here and compact the NEW agent through the OLD scope's
// service; the reference comparison must still drop it.
{
  let release: (value: undefined) => void = () => {}
  const gate = new Promise<undefined>(resolve => { release = resolve })
  const dispose = ctx.on('tui/compact', () => gate)
  channel.compact()
  await sleep(200)
  const switched = await channel.newSession()
  check('compact ABA setup: /new succeeded mid-await', switched === true)
  const resumed = await channel.resumeTo('s-a1')
  check('compact ABA setup: /resume back to the origin session succeeded', resumed === true)
  release(undefined)
  await sleep(400)
  check('compact ABA: id reuse does NOT revive the stale compaction',
    captured.compactCalls.length === 1, JSON.stringify(captured.compactCalls))
  dispose()
}

// ── 9. session-switch stale-drop: a parked /resume must not roll over a
// newer session that completed mid-await (D-6, reference comparison) ──────
{
  // Live is s-a1 here (section 8b resumed back to it); move off it first.
  const moved = await channel.newSession()
  check('switch stale setup: /new off the origin succeeded', moved === true)
  let release: (value: undefined) => void = () => {}
  const gate = new Promise<undefined>(resolve => { release = resolve })
  const dispose = ctx.on('tui/session-switch', event =>
    event.kind === 'resume' ? gate : undefined)
  const resumePromise = channel.resumeTo('s-a1')
  await sleep(200)
  const switched = await channel.newSession()
  check('switch stale setup: a second /new completed mid-await', switched === true)
  release(undefined)
  const resumed = await resumePromise
  check('session-switch stale: the parked /resume is dropped', resumed === false)
  check('session-switch stale: stale notice toasted', notified('等待插件期间会话已切换'))
  dispose()
}

// ── 9b. enqueue-time origin binding: a submission queued behind a slow
// decision stays bound to the session it was typed in — a mid-wait /new
// must drop BOTH, never deliver the follower's text into the new session ──
{
  let release: (value: undefined) => void = () => {}
  const gate = new Promise<undefined>(resolve => { release = resolve })
  const dispose = ctx.on('tui/input', async event => {
    if (event.text === '旧会话首条') await gate
    return undefined
  })
  const before = captured.followupTexts.length
  channel.submit('旧会话首条')
  channel.submit('旧会话次条')
  await sleep(300) // the predecessor's decision is parked on the gate
  const switched = await channel.newSession()
  check('enqueue origin setup: /new succeeded while the predecessor parked', switched === true)
  release(undefined)
  await sleep(500)
  check('enqueue-time origin: the parked predecessor is dropped as stale',
    !captured.followupTexts.some(text => text.includes('旧会话首条')),
    JSON.stringify(captured.followupTexts.slice(before)))
  check('enqueue-time origin: the queued follower never reaches the new session',
    captured.followupTexts.length === before, JSON.stringify(captured.followupTexts.slice(before)))
  dispose()
}

// ── 9c. rewind-prompt stale-drop: a parked rewind decision cancels when the
// session changes mid-await (same D-6 identity check as the other points) ─
{
  let release: (value: undefined) => void = () => {}
  const gate = new Promise<undefined>(resolve => { release = resolve })
  const dispose = ctx.on('tui/rewind-prompt', () => gate)
  const promptPromise = channel.promptRewind({ seq: 1, text: '消息 00' } as never)
  await sleep(300)
  const switched = await channel.newSession()
  check('rewind stale setup: /new succeeded while the rewind decision parked', switched === true)
  release(undefined)
  const result = await promptPromise
  check('rewind-prompt stale: the parked decision resolves to cancel',
    result === 'cancel', JSON.stringify(result))
  check('rewind-prompt stale: stale notice toasted', notified('等待插件期间会话已切换'))
  dispose()
}

// ── 9d. rewind-done decoupled: the summary listener must NOT delay the
// picked text's return to the draft, and tui/session-switched must not wait
// for it either (a hung listener would otherwise park both forever) ───────
{
  let release: (value: string) => void = () => {}
  const gate = new Promise<string>(resolve => { release = resolve })
  let doneStarted = false
  const disposeDone = ctx.on('tui/rewind-done', () => {
    doneStarted = true
    return gate
  })
  const switchedKinds: string[] = []
  const disposeSwitched = ctx.on('tui/session-switched', event => {
    switchedKinds.push(event.kind)
  })
  const rewindPromise = channel.rewindTo({ seq: 4, text: '回退恢复文本' } as never, null)
  const text = await Promise.race([rewindPromise, sleep(900).then(() => 'TIMEOUT' as const)])
  check('rewind-done decoupled: rewindTo returns the picked text without waiting for the listener',
    text === '回退恢复文本', String(text))
  check('rewind-done decoupled: the summary listener was still dispatched', doneStarted)
  check('rewind-done decoupled: session-switched did not wait for the listener',
    switchedKinds.includes('rewind'), switchedKinds.join(','))
  release('迟到摘要')
  await sleep(300)
  check('rewind-done decoupled: the late summary still toasts', notified('迟到摘要'))
  disposeDone()
  disposeSwitched()
}

// ── 10. D-8: the parked indicator covers the WHOLE decision wait — sticky
// while parked (no ~4s auto-expiry), dismissed the moment it settles ──────
{
  let release: (value: undefined) => void = () => {}
  const gate = new Promise<undefined>(resolve => { release = resolve })
  const dispose = ctx.on('tui/input', event => (event.text === '超长等待' ? gate : undefined))
  channel.submit('超长等待')
  await sleep(600) // past the 400ms threshold: the indicator is up
  check('pending indicator: raised past the threshold', notified('正在等待插件决定（tui/input）'))
  await sleep(4400) // well past the old 4s auto-expiry — the decision is still parked
  check('pending indicator: still up while the decision is parked',
    notified('正在等待插件决定（tui/input）'))
  release(undefined)
  await sleep(400)
  check('pending indicator: dismissed when the decision finally settles',
    !(channel as unknown as { notifications: readonly { text: string }[] }).notifications
      .some(item => item.text.includes('正在等待插件决定')))
  check('pending indicator: the settled input is delivered',
    captured.followupTexts.some(text => text.includes('超长等待')))
  dispose()
}

await instance.unmount()

if (failures > 0) {
  console.error(`${failures} check(s) failed`)
  process.exit(1)
}
console.log('extension decision-event seam verified')
process.exit(0)
