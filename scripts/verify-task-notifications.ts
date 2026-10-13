/**
 * Task notifications: real shared channel lifecycle, focus policy, terminal
 * detection, native titles, OSC 9/99/777 framing and redirected-output safety.
 * No live backend.
 * Run: node --import tsx/esm scripts/verify-task-notifications.ts
 */
import assert from 'node:assert/strict'
import { setImmediate as nextDispatch } from 'node:timers/promises'
import { PassThrough, Writable } from 'node:stream'
import type { AgentEvent, AgentEventMeta, AgentEventOf, TurnEndReason } from '../src/agent/events.js'
import type { AgentSession, AgentSessionStatus } from '../src/agent/session.js'
import { createChannel } from '../src/dsh-adapter/channel.js'
import { Config } from '../src/dsh-adapter/index.js'
import { configValues } from '../src/dsh-adapter/compat/settings.js'
import { createTerminalNotifier } from '../src/ink/terminal-notification.js'
import { getTerminalFocusState, resetTerminalFocusState, setTerminalFocused } from '../src/ink/terminal-focus-state.js'
import { setXtversionName, getNotificationProtocol } from '../src/ink/terminal.js'
import { osc, wrapForMultiplexer } from '../src/ink/termio/osc.js'
import { getGraphemeSegmenter } from '../src/utils/intl.js'
import { setLang, t } from '../src/i18n.js'

const savedEnv = { TERM_PROGRAM: process.env.TERM_PROGRAM, TERM: process.env.TERM, TMUX: process.env.TMUX, STY: process.env.STY }
const writes: string[] = []
const stdout = Object.assign(new Writable({
  write(chunk, _encoding, done) { writes.push(String(chunk)); done() },
}), { isTTY: true })
const notifier = createTerminalNotifier(stdout)

class FakeSession implements AgentSession {
  readonly ref
  readonly cwd = process.cwd()
  status: AgentSessionStatus = 'idle'
  readonly capabilities = { native: {} }
  readonly listeners = new Set<(batch: readonly AgentEvent[], meta: AgentEventMeta) => void>()
  constructor(id: string) { this.ref = { backendId: 'fake', sessionId: id } }
  history = async (): Promise<readonly AgentEvent[]> => []
  subscribe(listener: (batch: readonly AgentEvent[], meta: AgentEventMeta) => void) {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  submit = async () => ({ accepted: true })
  cancel = async () => ({ stillQueued: [], outcome: 'confirmed' as const })
  dispose = async () => {}
  emit(batch: readonly AgentEvent[], replay = false): void {
    for (const listener of this.listeners) listener(batch, { replay, wake: 'none' })
  }
  start(turn: number): void {
    this.status = 'running'
    this.emit([{ type: 'session.status', status: 'running' }, { type: 'turn.start', turn, origin: 'user', time: turn }])
  }
  reply(turn: number, text: string, seq: number, extra: Partial<AgentEventOf<'assistant.message'>> = {}): void {
    this.emit([{
      type: 'assistant.message', turn, step: seq, seq, anchor: String(seq),
      attemptId: `reply-${seq}`, time: turn, canonical: true,
      blocks: [{ type: 'text', text }], ...extra,
    }])
  }
  end(turn: number, reason: TurnEndReason = { kind: 'completed' }): void {
    this.emit([{ type: 'turn.end', turn, reason, time: turn + 1 }])
  }
  idle(): void {
    this.status = 'idle'
    this.emit([{ type: 'session.status', status: 'idle' }])
  }
}

const ctx = {
  on: () => () => undefined,
  get: () => undefined,
  logger: { warn: () => undefined, info: () => undefined, debug: () => undefined },
} as never
const first = new FakeSession('first')
const second = new FakeSession('second')
let completed = 0
const channel = createChannel(ctx, first, {
  model: 'fake', provider: '', cwd: first.cwd, activity: false,
  openSession: async () => second,
  onTaskComplete: preview => { completed += 1; notifier.notify(t('task-complete-notification'), preview) },
})

try {
  delete process.env.TMUX
  delete process.env.STY
  delete process.env.TERM_PROGRAM
  process.env.TERM = 'xterm-256color'
  setLang('en')
  resetTerminalFocusState()
  notifier.notify('done')
  assert.deepEqual(writes, [], 'unknown focus stays quiet with the default policy')
  setTerminalFocused(false)
  notifier.notify('done')
  assert.equal(writes.pop(), '\x07', 'unknown terminal falls back to BEL')
  for (const [program, protocol, expected] of [
    ['ghostty', 'osc777', osc(777, 'notify', 'Task complete', 'done')],
    ['iTerm.app', 'osc9', osc(9, 'Task complete: done')],
    ['kitty', 'osc99', osc(99, 'i=1:d=0:p=title', 'Task complete') + osc(99, 'i=1:d=1:p=body', 'done')],
    ['WarpTerminal', 'osc9', osc(9, 'Task complete: done')],
    ['WezTerm', 'osc777', osc(777, 'notify', 'Task complete', 'done')],
  ]) {
    process.env.TERM_PROGRAM = program
    notifier.notify('Task complete', 'done')
    assert.equal(getNotificationProtocol(), protocol)
    assert.equal(writes.pop(), expected, `${program} preserves the title and reply`)
  }
  process.env.TERM_PROGRAM = 'ghostty'
  notifier.notify('Task; complete\x07', 'reply; with; semicolons\x1b]2;injected\x07')
  assert.equal(writes.pop(), osc(777, 'notify', 'Task  complete', 'reply; with; semicolons]2;injected'), 'OSC 777 cannot inject title fields or control sequences; reply semicolons survive')
  process.env.TMUX = '/tmp/fixture,1,0'
  notifier.notify('Task complete', 'reply')
  assert.equal(writes.pop(), wrapForMultiplexer(osc(777, 'notify', 'Task complete', 'reply')))
  delete process.env.TMUX
  const notificationTitle = 'dsh-TUI · Task complete'
  const header = osc(777, 'notify', notificationTitle, '')
  const oscEnd = header.endsWith('\x07') ? '\x07' : '\x1b\\'
  const oscPrefix = header.slice(0, -oscEnd.length)
  const bodyBudget = 2048 - Buffer.byteLength(header)
  const assertReceiverBudget = (data: string): void => {
    assert.ok(Buffer.byteLength(`\x1b]777;${data}${oscEnd}`) <= 2048, 'headless receiver enforces the complete OSC byte budget')
  }
  const receiverOverhead = Buffer.byteLength(`\x1b]777;${oscEnd}`)
  assert.doesNotThrow(() => assertReceiverBudget('a'.repeat(2048 - receiverOverhead)))
  for (const packetBytes of [2049, 2050]) {
    assert.throws(() => assertReceiverBudget('a'.repeat(packetBytes - receiverOverhead)), { code: 'ERR_ASSERTION' }, 'receiver must count the OSC introducer and terminator')
  }
  const deliveredBody = (packet: string): string => {
    assert.ok(packet.startsWith(oscPrefix))
    assert.ok(packet.endsWith(oscEnd))
    assert.ok(Buffer.byteLength(packet) <= 2048, 'full OSC 777 packet fits Ghostty, including title and terminator')
    return packet.slice(oscPrefix.length, -oscEnd.length)
  }
  notifier.notify(notificationTitle, 'a'.repeat(bodyBudget))
  const exactPacket = writes.pop()!
  assert.equal(Buffer.byteLength(exactPacket), 2048)
  assert.equal(deliveredBody(exactPacket), 'a'.repeat(bodyBudget), 'exact byte boundary does not truncate')
  notifier.notify(notificationTitle, 'a'.repeat(bodyBudget + 1))
  assert.equal(deliveredBody(writes.pop()!), `${'a'.repeat(bodyBudget - 3)}…`, 'ellipsis counts against the UTF-8 byte budget')
  for (const grapheme of ['👨‍👩‍👧‍👦', `e${'\u0301'.repeat(12)}`]) {
    notifier.notify(notificationTitle, grapheme.repeat(200))
    const body = deliveredBody(writes.pop()!)
    assert.ok(body.endsWith('…'))
    assert.ok([...getGraphemeSegmenter().segment(body.slice(0, -1))].every(part => part.segment === grapheme), 'byte truncation preserves whole emoji and combining graphemes')
  }
  notifier.notify(notificationTitle, `e${'\u0301'.repeat(2000)}`)
  assert.equal(deliveredBody(writes.pop()!), '…', 'a single oversized grapheme is omitted whole')
  const byteSession = new FakeSession('ghostty-byte-budget')
  const byteChannel = createChannel(ctx, byteSession, {
    model: 'fake', provider: '', cwd: byteSession.cwd, activity: false,
    onTaskComplete: preview => notifier.notify(notificationTitle, preview),
  })
  try {
    byteSession.start(0)
    byteSession.reply(0, '👨‍👩‍👧‍👦'.repeat(200), 1)
    byteSession.end(0)
    byteSession.idle()
    await nextDispatch()
    assert.ok(deliveredBody(writes.pop()!).endsWith('…'), 'real completion and preview generation also obey the Ghostty byte limit')
  } finally {
    byteChannel.releaseContributions()
  }
  process.env.TMUX = '/tmp/fixture,1,0'
  notifier.notify(notificationTitle, '👨‍👩‍👧‍👦'.repeat(200))
  const wrappedPacket = writes.pop()!
  assert.ok(wrappedPacket.startsWith('\x1bPtmux;') && wrappedPacket.endsWith('\x1b\\'))
  assert.ok(deliveredBody(wrappedPacket.slice('\x1bPtmux;'.length, -2).replaceAll('\x1b\x1b', '\x1b')).endsWith('…'), 'byte cap applies to the OSC forwarded by tmux, before DCS wrapping')
  delete process.env.TMUX
  notifier.notify('x'.repeat(3000), 'reply')
  assert.ok(Buffer.byteLength(writes.pop()!) <= 2048, 'an oversized title also respects the packet budget')
  process.env.TERM_PROGRAM = 'kitty'
  const longReply = '👨‍👩‍👧‍👦'.repeat(200)
  notifier.notify('Task complete', longReply)
  const kittyPacket = writes.pop()!
  const terminator = osc(99, '').endsWith('\x07') ? '\x07' : '\x1b\\'
  const parts = kittyPacket.split(terminator).filter(Boolean).map(part => {
    assert.ok(part.startsWith('\x1b]99;'))
    const split = part.indexOf(';', '\x1b]99;'.length)
    return { metadata: part.slice('\x1b]99;'.length, split), payload: part.slice(split + 1) }
  })
  assert.equal(parts[0]!.payload, 'Task complete')
  assert.ok(parts.slice(0, -1).every(part => part.metadata.includes('i=2:d=0:')))
  assert.equal(parts.at(-1)!.metadata, 'i=2:d=1:p=body')
  assert.ok(parts.every(part => Buffer.byteLength(part.payload) <= 2048), 'Kitty payloads respect the protocol byte cap')
  assert.equal(parts.slice(1).map(part => part.payload).join(''), longReply, 'Kitty UTF-8 chunking preserves the entire Unicode preview')
  for (const program of ['Apple_Terminal', 'vscode', 'Windows_Terminal', 'Alacritty']) {
    process.env.TERM_PROGRAM = program
    assert.equal(getNotificationProtocol(), 'bel', `${program} falls back to BEL`)
  }
  delete process.env.TERM_PROGRAM
  for (const term of ['xterm-kitty', 'xterm-ghostty']) {
    process.env.TERM = term
    assert.equal(getNotificationProtocol(), term === 'xterm-kitty' ? 'osc99' : 'osc777')
  }
  process.env.TERM = 'xterm-256color'
  notifier.configure('always', 'osc9')
  setTerminalFocused(true)
  process.env.TMUX = '/tmp/fixture,1,0'
  notifier.notify('done\x07\x1b\\\x9c')
  assert.equal(writes.pop(), wrapForMultiplexer(osc(9, 'done\\')), 'control bytes cannot terminate or inject OSC/tmux payloads')
  delete process.env.TMUX
  notifier.notify('Task complete', 'latest reply')
  assert.equal(writes.pop(), osc(9, 'Task complete: latest reply'), 'explicit OSC 9 retains a title prefix')
  notifier.notify(notificationTitle, longReply)
  assert.ok(Buffer.byteLength(writes.pop()!) <= 2048, 'explicit OSC 9 also fits Ghostty when used as a compatibility override')
  notifier.configure('off', 'osc9')
  notifier.notify('done')
  stdout.isTTY = false
  notifier.configure('always', 'osc9')
  notifier.notify('done')
  assert.deepEqual(writes, [], 'disabled and redirected output never receives notifications')
  stdout.isTTY = true
  const failing = createTerminalNotifier({ isTTY: true, write: () => { throw new Error('closed') } })
  failing.configure('always')
  assert.doesNotThrow(() => failing.notify('done'), 'notification failures do not fail the turn')
  notifier.configure('always', 'bel')
  notifier.notify('done')
  assert.equal(writes.pop(), '\x07', 'explicit BEL overrides detection')
  assert.equal(configValues(Config({ taskNotifications: 'off', notificationMethod: 'osc9' })).taskNotifications, 'off')
  assert.throws(() => configValues(Config({ notificationMethod: 'unknown' })))
  assert.equal(configValues(Config({})).taskNotifications, undefined, 'unset schema does not shadow deployment settings')

  notifier.configure('unfocused', 'osc9')
  setTerminalFocused(false)
  first.emit([{ type: 'turn.end', turn: 0, reason: { kind: 'completed' }, time: 1 }], true)
  await nextDispatch()
  assert.equal(completed, 0, 'replay does not notify')
  first.start(1)
  first.end(1)
  await nextDispatch()
  assert.equal(completed, 0, 'turn.end waits for the session to become idle')
  first.idle()
  await nextDispatch()
  assert.equal(completed, 1)
  assert.equal(writes.pop(), osc(9, 'dsh-TUI · Task complete'))
  first.end(1)
  first.emit([], false)
  await nextDispatch()
  assert.equal(completed, 1, 'duplicate end and quiet batches do not repeat a notification')
  for (const [turn, reason] of [[2, { kind: 'aborted' }], [3, { kind: 'interrupted' }], [4, { kind: 'error', message: 'fixture' }]] as const) {
    first.start(turn)
    first.end(turn, reason)
    first.idle()
    await nextDispatch()
    assert.equal(completed, 1, `${reason.kind} stays quiet`)
  }
  first.start(5)
  first.reply(5, 'Intermediate reply', 50)
  channel.submit('follow up')
  // Submission resolves into the channel's pending preview.
  await nextDispatch()
  assert.ok(channel.pending.length > 0)
  first.end(5)
  first.idle()
  await nextDispatch()
  assert.equal(completed, 1, 'queued inputs suppress intermediate completion')
  first.start(6)
  first.emit([{ type: 'pending.changed', items: [], claimed: channel.pending.map(item => item.id) }])
  first.reply(6, 'Final follow-up reply', 60)
  first.end(6)
  first.idle()
  await nextDispatch()
  assert.equal(completed, 2, 'the last queued turn notifies')
  assert.equal(writes.pop(), osc(9, 'dsh-TUI · Task complete: Final follow-up reply'), 'the last queued turn supplies its own reply under the title')
  first.start(7)
  first.emit([{ type: 'goal.change', operation: 'set', goal: { id: 'goal', revision: 1, objective: 'fixture', phase: 'active', maxGoalRounds: 5 } }])
  first.end(7)
  first.idle()
  await nextDispatch()
  assert.equal(completed, 2, 'active goals suppress intermediate completion')
  first.start(8)
  first.emit([{ type: 'goal.change', operation: 'complete', goal: { id: 'goal', revision: 2, objective: 'fixture', phase: 'complete', maxGoalRounds: 5 } }])
  first.end(8)
  first.idle()
  setTerminalFocused(true)
  await nextDispatch()
  assert.equal(completed, 3)
  assert.deepEqual(writes, [], 'focus is checked at delivery after the final goal turn')
  first.start(9)
  first.end(9)
  first.idle()
  const retired = [...first.listeners]
  assert.equal(await channel.newSession(), true)
  for (const listener of retired) listener([{ type: 'turn.end', turn: 10, reason: { kind: 'completed' }, time: 11 }], { replay: false })
  await nextDispatch()
  assert.equal(completed, 3, 'session switch fences scheduled and retained old callbacks')
  second.start(0)
  second.end(0)
  second.idle()
  await nextDispatch()
  assert.equal(completed, 4, 'turn numbering restarts with the replacement session')
  second.start(1)
  second.end(1)
  second.idle()
  second.emit([{ type: 'session.reset', trigger: 'fixture' }])
  await nextDispatch()
  assert.equal(completed, 4, 'conversation reset cancels pending delivery')
  second.start(0)
  second.end(0)
  second.idle()
  second.start(1)
  await nextDispatch()
  assert.equal(completed, 4, 'an automatic follow-up that starts immediately stays quiet')
  second.end(1)
  second.idle()
  await nextDispatch()
  assert.equal(completed, 5, 'the final follow-up notifies after conversation reset')
  second.start(2)
  second.end(2)
  second.idle()
  channel.releaseContributions()
  await nextDispatch()
  assert.equal(completed, 5, 'channel disposal cancels pending delivery')

  const previews: (string | undefined)[] = []
  const replySession = new FakeSession('reply-preview')
  // An adopted running session may finish before any live turn.start is seen.
  replySession.status = 'running'
  const replyChannel = createChannel(ctx, replySession, {
    model: 'fake', provider: '', cwd: replySession.cwd, activity: false,
    onTaskComplete: preview => { previews.push(preview) },
  })
  try {
    replySession.reply(0, '  First draft  ', 1)
    replySession.reply(0, 'ignored', 2, { blocks: [
      { type: 'reasoning', text: 'private reasoning' },
      { type: 'text', text: '  最新\n\t回复 ' },
      { type: 'text', text: '已\x1b[31m完成\x1b[0m。' },
    ] })
    replySession.reply(0, 'Old duplicate', 1)
    replySession.reply(0, 'Child reply', 3, { parentCallId: 'child' })
    replySession.reply(0, 'Interrupted reply', 4, { interrupted: true })
    replySession.reply(0, '', 5, { blocks: [{ type: 'tool_use' }] })
    replySession.end(0)
    replySession.idle()
    await nextDispatch()
    assert.equal(previews.at(-1), '最新 回复 已完成。', 'latest settled main reply wins; controls/whitespace are normalized and reasoning is excluded')

    const family = '👨‍👩‍👧‍👦'
    replySession.start(1)
    replySession.reply(1, family.repeat(200), 6)
    replySession.end(1)
    replySession.idle()
    await nextDispatch()
    assert.equal(previews.at(-1), family.repeat(200), 'exactly 200 graphemes do not truncate')
    replySession.start(2)
    replySession.reply(2, `${family.repeat(198)}e\u0301remaining text`, 7)
    replySession.end(2)
    replySession.idle()
    await nextDispatch()
    assert.equal(previews.at(-1), `${family.repeat(198)}e\u0301…`, 'truncation preserves emoji and combining graphemes')

    replySession.start(3)
    replySession.reply(3, '', 8, { blocks: [{ type: 'reasoning', text: 'private reasoning' }] })
    replySession.end(3)
    replySession.idle()
    await nextDispatch()
    assert.equal(previews.at(-1), undefined, 'a turn without reply text does not reuse a previous turn')
    replySession.start(4)
    replySession.emit([
      { type: 'assistant.attempt.start', attemptId: 'abandoned', turn: 4, step: 0 },
      { type: 'assistant.delta', attemptId: 'abandoned', index: 0, time: 4, delta: { kind: 'text', text: 'uncommitted draft' } },
      { type: 'assistant.attempt.end', attemptId: 'abandoned', outcome: 'abandoned', turn: 4, step: 0 },
    ])
    replySession.end(4)
    replySession.idle()
    await nextDispatch()
    assert.equal(previews.at(-1), undefined, 'abandoned streamed text never becomes a notification')
    replySession.start(5)
    replySession.reply(5, '# Review verdict **结论：通过**\n\n修复了 `src/foo.ts`，[详情](https://example.invalid)。', 9)
    replySession.end(5)
    replySession.idle()
    await nextDispatch()
    assert.equal(previews.at(-1), 'Review verdict 结论：通过 修复了 src/foo.ts，详情。', 'Markdown headings and emphasis become plain text before the desktop can enlarge them')
    replySession.start(6)
    replySession.reply(6, '# 标题\n\n> **重点**\n\n- 检查 `foo`\n- 检查 bar\n\n```ts\nconst value = 1\n```\n\n| 项目 | 状态 |\n| --- | --- |\n| 编译 | 通过 |', 10)
    replySession.end(6)
    replySession.idle()
    await nextDispatch()
    assert.equal(previews.at(-1), '标题 重点 检查 foo 检查 bar const value = 1 项目 状态 编译 通过', 'block boundaries survive as spaces without list/table/fence markup')
    replySession.start(7)
    replySession.reply(7, `<h1>正文</h1>\n\n**${family.repeat(200)}**`, 11)
    replySession.end(7)
    replySession.idle()
    await nextDispatch()
    assert.equal(previews.at(-1), `正文 ${family.repeat(196)}…`, 'HTML and Markdown styles are removed before Unicode-safe truncation')
    assert.equal(previews.length, 8)
  } finally {
    replyChannel.releaseContributions()
  }
  setXtversionName('Ghostty 1.2.0')
  assert.equal(getNotificationProtocol(), 'osc777', 'existing terminal probe supports native titles over SSH without TERM_PROGRAM')
  setLang('zh')
  assert.equal(t('task-complete-notification'), 'dsh-TUI · 任务已完成')

  const [React, { Terminal }, { render, Text, AlternateScreen, useInput }, { settled }] = await Promise.all([
    import('react'), import('@xterm/headless'), import('../src/ui.js'), import('./lib/term-test.mjs'),
  ])
  for (const [fullscreen, method] of [[false, 'auto'], [true, 'auto'], [false, 'osc9'], [true, 'osc9']] as const) {
    process.env.TERM_PROGRAM = 'ghostty'
    const term = new Terminal({ cols: 36, rows: 8, allowProposedApi: true })
    const notifications: { title?: string; message: string }[] = []
    term.parser.registerOscHandler(9, data => {
      if (!data.startsWith('4;')) notifications.push({ message: data })
      return true
    })
    term.parser.registerOscHandler(777, data => {
      assertReceiverBudget(data)
      const [command, title, ...body] = data.split(';')
      assert.equal(command, 'notify')
      notifications.push({ title, message: body.join(';') })
      return true
    })
    class Input extends PassThrough {
      isTTY = true
      raw = false
      setRawMode(raw: boolean): this { this.raw = raw; return this }
      ref(): this { return this }
      unref(): this { return this }
    }
    const input = new Input()
    const output = Object.assign(new Writable({
      write(chunk, _encoding, done) { term.write(String(chunk), done) },
    }), { isTTY: true, columns: 36, rows: 8 })
    const transport = createTerminalNotifier(output)
    transport.configure('unfocused', method)
    function Probe() {
      useInput(() => {})
      return React.createElement(Text, null, 'screen remains intact')
    }
    const content = React.createElement(Probe)
    const instance = await render(fullscreen ? React.createElement(AlternateScreen, null, content) : content, {
      stdin: input, stdout: output, stderr: output, patchConsole: false, exitOnCtrlC: false,
    })
    const session = new FakeSession(`render-${fullscreen}`)
    const rendered = createChannel(ctx, session, {
      model: 'fake', provider: '', cwd: session.cwd, activity: false,
      onTaskComplete: preview => transport.notify(t('task-complete-notification'), preview),
    })
    const screen = (): string => Array.from({ length: 8 }, (_, row) => term.buffer.active.getLine(row)?.translateToString(true) ?? '').join('\n')
    try {
      assert.ok(await settled(() => screen().includes('screen remains intact') && input.raw))
      const before = screen()
      input.write('\x1b[O')
      assert.ok(await settled(() => getTerminalFocusState() === 'blurred'))
      session.start(0)
      session.reply(0, '# 最新 AI 回复\n\n**已完成修复**', 1)
      session.end(0)
      session.idle()
      assert.ok(await settled(() => notifications.length === 1))
      assert.deepEqual(notifications[0], method === 'auto'
        ? { title: 'dsh-TUI · 任务已完成', message: '最新 AI 回复 已完成修复' }
        : { message: 'dsh-TUI · 任务已完成: 最新 AI 回复 已完成修复' })
      assert.equal(screen(), before, `${fullscreen ? 'fullscreen' : 'inline'} notification leaves the narrow screen intact`)
      input.write('\x1b[I')
      assert.ok(await settled(() => getTerminalFocusState() === 'focused'))
      session.start(1)
      session.end(1)
      session.idle()
      await nextDispatch()
      assert.equal(notifications.length, 1, 'real focus-in suppresses delivery')
      input.write('\x1b[O')
      assert.ok(await settled(() => getTerminalFocusState() === 'blurred'))
      session.start(2)
      session.end(2)
      session.idle()
      assert.ok(await settled(() => notifications.length === 2))
      assert.deepEqual(notifications[1], method === 'auto'
        ? { title: 'dsh-TUI · 任务已完成', message: '' }
        : { message: 'dsh-TUI · 任务已完成' }, 'a reply-less task displays only its title')
    } finally {
      rendered.releaseContributions()
      instance.unmount()
      assert.equal(input.raw, false, 'exit restores raw mode')
      term.dispose()
    }
  }
  console.log('verify-task-notifications OK')
} finally {
  channel.releaseContributions()
  resetTerminalFocusState()
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
}
