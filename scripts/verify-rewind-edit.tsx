/**
 * Rewind -> restore -> edit -> resend through the real Chat and Channel.
 * Uses real V3 sessions, fake durable inboxes and a headless terminal. The
 * inbox fixture follows 0.1.5's full-log projection (inherited insertions are
 * pending again when rewind cuts off the matching claim). Covers repeated
 * rewinds, next-turn/next-step cancellation and restore from the child log.
 * No model calls or user-profile writes.
 * Run: node --import tsx/esm scripts/verify-rewind-edit.tsx
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Writable } from 'node:stream'
import React from 'react'
import xterm from '@xterm/headless'
import { Context } from '@deepseek-ai/cordis'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage, createAssistantMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import type { CreateAgentOptions } from '@deepseek-ai/dsh-agent'
import { settled, sleep, viewportLines } from './lib/term-test.mjs'

const home = mkdtempSync(join(tmpdir(), 'dsh-tui-rewind-edit-'))
process.env.HOME = home
process.env.USERPROFILE = home
process.env.DSH_TUI_LANG = 'en'
process.env.DSH_TUI_DISABLE_TERMINAL_IMAGES = '1'

const [{ render, AlternateScreen }, { Chat }, { QuestionStore }, { createChannel }, { createChannelUi, createChannelUiLease }] = await Promise.all([
  import('../src/ui.js'),
  import('../src/screens/Chat.js'),
  import('../src/dsh-adapter/questions.js'),
  import('../src/dsh-adapter/channel.js'),
  import('../src/adapter/channel/ui.js'),
])

function appendReply(session: Session, turn: number, message: UserMessage): void {
  session.append('step/start', { turn, step: 1 })
  session.append('user/message', message, { surfaceOp: 'append' })
  session.append('assistant/message', {
    turn, step: 1, stream: [],
    message: createAssistantMessage({ source: { provider: 'fake', model: 'model' }, content: [{ type: 'text', text: 'Done' }] }),
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn, step: 1 })
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
}

async function verify(fullscreen: boolean, columns: number, entry: 'slash' | 'escape' | 'tree'): Promise<void> {
  const terminal = new xterm.Terminal({ cols: columns, rows: 30, allowProposedApi: true })
  const stdout = Object.assign(new Writable({
    write(chunk, _encoding, callback) { terminal.write(String(chunk), callback) },
  }), { isTTY: true, columns, rows: 30 })
  const stderr = new Writable({ write(_chunk, _encoding, callback) { callback() } })
  const stdin = Object.assign(new PassThrough(), {
    isTTY: true, setRawMode() { return this }, ref() { return this }, unref() { return this },
  })
  const ctx = new Context()
  const delivered: Array<{ session: Session; text: string }> = []
  const makeAgent = (session: Session) => {
    // 0.1.5's Inbox projection folds the complete log, including inherited
    // splices. A cut before turn/start keeps insertion but drops its claim.
    const pending: Record<'next-turn' | 'next-step', UserMessage[]> = { 'next-turn': [], 'next-step': [] }
    for (const event of session.snapshotEvents()) {
      if (event.type !== 'agent/inbox/spliced') continue
      const splice = event.data
      pending[splice.target].splice(splice.start, splice.removedCount ?? 0, ...splice.inserted)
    }
    const splice = (target: 'next-turn' | 'next-step', start: number, count: number, inserted: UserMessage[], canceled = false) => {
      if (count === 0 && inserted.length === 0) return []
      const event = session.append('agent/inbox/spliced', {
        target, start, removedCount: count, inserted,
        ...(canceled ? { outcome: 'canceled' as const } : {}),
      })
      const removed = pending[target].splice(start, count, ...inserted)
      ctx.emit('session/event', session, event)
      return removed
    }
    const agent = {
      id: String(session.id), status: 'idle', session,
      ctx: { on: () => () => {} },
      followup(message: UserMessage) {
        splice('next-turn', pending['next-turn'].length, 0, [message])
        while (pending['next-turn'].length > 0) {
          const turn = (session.snapshotEvents().filter(event => event.type === 'turn/start').length) + 1
          const start = session.append('turn/start', { turn })
          ctx.emit('session/event', session, start)
          for (const context of splice('next-step', 0, pending['next-step'].length, [])) {
            ctx.emit('agent/inbox/claimed', { agent: agent as never, message: context, turn })
          }
          const claimed = splice('next-turn', 0, 1, [])[0]!
          ctx.emit('agent/inbox/claimed', { agent: agent as never, message: claimed, turn })
          delivered.push({ session, text: claimed.content.filter(block => block.type === 'text').map(block => block.text).join('\n') })
          const from = session.seq
          appendReply(session, turn, claimed)
          for (const event of session.snapshotEvents(from)) ctx.emit('session/event', session, event)
        }
      },
      steer() { throw new Error('idle rewind must not steer') },
      cancel() {},
      inbox: {
        get nextTurn() { return pending['next-turn'] },
        get nextStep() { return pending['next-step'] },
        clear() {
          splice('next-step', 0, pending['next-step'].length, [], true)
          splice('next-turn', 0, pending['next-turn'].length, [], true)
        },
        remove: () => true,
      },
    }
    return agent
  }
  const source = Session.create(SessionId('source'), [], {
    version: 3, id: SessionId('source'), createdAt: 1, isSeeded: false, cwd: home,
  })
  source.append('turn/start', { turn: 1 })
  appendReply(source, 1, createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '你好' }] }))
  source.append('agent/inbox/spliced', {
    target: 'next-step', start: 0, inserted: [createUserMessage({
      source: { kind: 'plugin', plugin: 'probe' }, content: [{ type: 'text', text: 'Old step context' }],
    })],
  })
  const forks: Session[] = []
  ctx.provide('agents', {
    async create(options: CreateAgentOptions) {
      const session = Session.create(options.sessionId, options.seed, {
        version: 3, id: options.sessionId, createdAt: 1, isSeeded: false, ...options.meta,
      }, options.inheritedEventCount)
      const agent = makeAgent(session)
      const setup = await options.setup?.(ctx, agent as never)
      setup?.commit()
      forks.push(session)
      return { agent, dispose: async () => {} }
    },
  } as never)
  const channel = createChannel(ctx, makeAgent(source) as never, {
    model: 'model', provider: 'fake', cwd: home, activity: false, whaleIdle: false,
  })
  const lease = createChannelUiLease(() => true)
  const screen = <Chat channel={createChannelUi(channel, 'legacy', lease)} questionStore={new QuestionStore()} onExit={() => {}} fullscreen={fullscreen} />
  const app = await render(fullscreen ? <AlternateScreen>{screen}</AlternateScreen> : screen, {
    stdin: stdin as never, stdout: stdout as never, stderr: stderr as never,
    exitOnCtrlC: false, patchConsole: false,
  })
  const shows = (text: string) => viewportLines(terminal).some(line => line.includes(text))
  /**
   * A prompt ROW, not just any row carrying the text.
   *
   * The composer's row now begins with the session entry control (`⌸ `) before
   * the caret glyph, so anchoring on `^\s*❯` stopped matching the very row it
   * was written to find: the draft was on screen and the assertion said it was
   * never typed. The anchor therefore skips that leading control.
   */
  const promptShows = (text: string) => viewportLines(terminal).some(line => /^\s*(?:⌸\s*)?❯/u.test(line) && line.includes(text))
  const enter = async () => {
    await sleep(120) // 固定窗:墙钟 Enter deduplication is 80 ms in both Chat and PromptInput
    stdin.write('\r')
  }
  try {
    assert.ok(await settled(() => shows('你好')), 'initial transcript rendered')
    stdin.write('hi')
    assert.ok(await settled(() => promptShows('hi')), 'original draft typed')
    await enter()
    assert.ok(await settled(() => delivered.length === 1 && channel.rows.some(row => row.text === 'hi')), 'original prompt sent')
    let current = source
    let prompt = 'hi'
    for (let round = 0; round < 2; round++) {
      const originalEvents = current.snapshotEvents()
      if (entry === 'tree') {
        const row = channel.rows.findLast(row => row.kind === 'user')!
        assert.equal(await channel.rewindToNode(String(current.id), row.seq!, 'rewind'), prompt)
        // The tree action returns its draft to the UI; this case exercises
        // that backend sibling without coupling to the tree browser layout.
        //
        // Let Chat PROCESS the swap first. `rewindToNode` resolves as soon as
        // the channel has committed the new session, while the screen that
        // notices it — and drops the previous conversation's text — commits a
        // beat later. Typing in that gap is a race, not a requirement, and it
        // used to be won only by accident.
        await sleep(150) // 固定窗:pacing 等 Chat 处理完会话切换再模拟用户输入
        stdin.write(prompt)
      } else if (entry === 'slash') {
        stdin.write('/rewind')
        assert.ok(await settled(() => promptShows('/rewind')), 'slash command typed')
        await enter()
      } else {
        stdin.write('\x1b')
        await sleep(120) // 固定窗:pacing separate Esc bytes so the parser does not combine them
        stdin.write('\x1b')
      }
      if (entry !== 'tree') {
        assert.ok(await settled(() => shows('Rewind') && shows('last message')), 'rewind picker opened')
        await enter()
        assert.ok(await settled(() => shows('Rewind conversation')), 'rewind confirmation opened')
        await enter()
      }
      assert.ok(await settled(() => forks.length === round + 1 && promptShows(prompt)), 'selected prompt restored')
      const child = forks[round]!
      const canceled = child.ownEvents().flatMap(event => event.type === 'agent/inbox/spliced' && event.data.outcome === 'canceled' ? [event.data.target] : [])
      assert.deepEqual(canceled, round === 0 ? ['next-step', 'next-turn'] : ['next-turn'], 'restored queues canceled in the child')
      const restored = Session.fromRestore(child.id, [...child.snapshotEvents()], { ...child.header }, child.inheritedEventCount, 'shared-frozen')
      const resumed = makeAgent(restored)
      assert.equal(resumed.inbox.nextTurn.length + resumed.inbox.nextStep.length, 0, 'cancellation survives rehydration')
      stdin.write('hihi')
      const edited = prompt + 'hihi'
      assert.ok(await settled(() => promptShows(edited)), 'edited text is visible')
      await enter()
      assert.ok(await settled(() => delivered.length >= round + 2), 'edited prompt delivered')
      assert.deepEqual(delivered.map(item => item.text), round === 0 ? ['hi', 'hihihi'] : ['hi', 'hihihi', 'hihihihihi'], 'exactly one delivery per Enter, with no historical replay')
      assert.equal(delivered.at(-1)?.session, child, 'delivery targets the rewound session')
      assert.ok(await settled(() => shows(edited)), 'edited user message rendered')
      assert.deepEqual(child.deriveMessages().filter(message => message.role === 'user').map(message => message.content[0]), [
        { type: 'text', text: '你好' }, { type: 'text', text: edited },
      ], 'the selected original message is absent from the fork')
      assert.deepEqual(current.snapshotEvents(), originalEvents, 'source history stays untouched')
      current = child
      prompt = edited
    }
    console.log(`PASS rewind/edit/resend (${fullscreen ? 'fullscreen' : 'inline'}, ${columns} columns, ${entry})`)
  } finally {
    await app.unmount()
    lease.dispose()
    channel.releaseContributions()
    terminal.dispose()
  }
}

try {
  for (const fullscreen of [false, true]) {
    for (const columns of [40, 80]) {
      for (const entry of ['slash', 'escape', 'tree'] as const) await verify(fullscreen, columns, entry)
    }
  }
} finally {
  rmSync(home, { recursive: true, force: true })
}
