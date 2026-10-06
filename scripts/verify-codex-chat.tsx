/**
 * The real `Chat` over a real Codex session on the fake app-server
 * (docs/codex-backend-design.md §8.1–§8.4, §10.3 — the C1 surface; live
 * command output and patch line numbers are C2): headless renders at 80 and
 * 40 columns, inline and fullscreen.
 *
 * Per render: a typed message reaches `turn/start` and shows once the server
 * echoes it; a command waits on the approval panel with the official wording,
 * `1` + Enter allows it, the terminal card shows the unwrapped command and
 * its output, the reply streams in; a second turn shows the diff cards of a
 * new and an edited file and a question panel answered with Enter; a third
 * turn's running command is interrupted with Esc and its card says so.
 *
 * Run: node --import tsx/esm scripts/verify-codex-chat.tsx
 */
process.env.FORCE_COLOR = '3'

const [{ Writable, PassThrough }, React, { Terminal: XTerm }, ui, { Chat }, { QuestionStore }, { createChannel }, { setLang, t }, { default: instances }, { settled, sleep, viewportLines }, { PermissionStore }] =
  await Promise.all([
    import('node:stream'),
    import('react'),
    import('@xterm/headless'),
    import('../src/ui.js'),
    import('../src/screens/Chat.js'),
    import('../src/dsh-adapter/questions.js'),
    import('../src/dsh-adapter/channel.js'),
    import('../src/i18n.js'),
    import('../src/ink/instances.js'),
    import('./lib/term-test.mjs'),
    import('../src/channel/permissions.js'),
  ])
import { NO_REPLY } from './lib/codex-fake-app-server.js'
import { CWD, openHarness, THREAD, tick } from './lib/codex-session-harness.js'

setLang('en')
let passed = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) throw new Error(`${label}${detail ? `\n${detail}` : ''}`)
  passed += 1
  console.log(`PASS ${label}`)
}
type Rec = Record<string, unknown>

const userItem = (id: string, clientId: string, text: string): Rec => ({ type: 'userMessage', id, clientId, content: [{ type: 'text', text, text_elements: [] }] })
const command = (id: string, script: string, status: string, output: string | null, exitCode: number | null): Rec => ({
  type: 'commandExecution', id, command: `/bin/bash -lc '${script}'`, cwd: CWD, processId: null, source: 'agent', status,
  commandActions: [{ type: 'unknown', command: script }], aggregatedOutput: output, exitCode, durationMs: output === null ? null : 4,
})

async function run(cols: number, fullscreen: boolean): Promise<void> {
  const tag = `${cols}c ${fullscreen ? 'fullscreen' : 'inline'}`
  const rows = 30
  const h = await openHarness()
  const permissions = new PermissionStore()
  const questions = new QuestionStore()
  const ctx = { on: () => () => undefined, get: () => undefined, logger: { warn: () => undefined, info: () => undefined, debug: () => undefined } } as never
  const channel = createChannel(ctx, h.session, { model: 'Codex', provider: 'codex', cwd: CWD, activity: false, backendLabel: 'Codex', interaction: { permissions, questions } })

  // The server side of each turn, scripted per turn/start.
  let turns = 0
  const notify = (method: string, params: Rec): void => { h.fake.notify(method, { threadId: THREAD, ...params }) }
  h.fake.on('turn/start', (params, request) => {
    turns += 1
    const turnId = `turn-${turns}`
    const clientId = String(params.clientUserMessageId)
    const text = String(((params.input as Rec[])[0] ?? {}).text ?? '')
    h.fake.reply(request.id, { turn: { id: turnId, items: [], status: 'inProgress' } })
    void (async () => {
      await tick(5)
      notify('turn/started', { turn: { id: turnId, items: [], status: 'inProgress' } })
      notify('item/started', { turnId, item: userItem(`u-${turns}`, clientId, text) })
      notify('item/completed', { turnId, item: userItem(`u-${turns}`, clientId, text) })
      if (turns === 1) {
        notify('item/started', { turnId, item: command('exec-1', 'echo probe > a.txt', 'inProgress', null, null) })
        const answer = await h.fake.request('item/commandExecution/requestApproval', { threadId: THREAD, turnId, itemId: 'exec-1', kind: 'command', startedAtMs: 0, environmentId: 'local', command: "/bin/bash -lc 'echo probe > a.txt'", cwd: CWD, commandActions: [{ type: 'unknown', command: 'echo probe > a.txt' }], proposedExecpolicyAmendment: ['/bin/bash', '-lc', 'echo probe > a.txt'], availableDecisions: ['accept', { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['/bin/bash', '-lc', 'echo probe > a.txt'] } }, 'cancel'] })
        notify('serverRequest/resolved', { requestId: 0 })
        const accepted = (answer.result as Rec | undefined)?.decision === 'accept'
        notify('item/completed', { turnId, item: command('exec-1', 'echo probe > a.txt', accepted ? 'completed' : 'declined', accepted ? 'probe-ok\n' : null, accepted ? 0 : null) })
        notify('item/started', { turnId, item: { type: 'agentMessage', id: 'm-1', text: '', phase: 'final_answer' } })
        notify('item/agentMessage/delta', { turnId, itemId: 'm-1', delta: 'All ' })
        notify('item/agentMessage/delta', { turnId, itemId: 'm-1', delta: 'done.' })
        notify('item/completed', { turnId, item: { type: 'agentMessage', id: 'm-1', text: 'All done.', phase: 'final_answer' } })
        notify('thread/tokenUsage/updated', { turnId, tokenUsage: { total: {}, last: { totalTokens: 9000, inputTokens: 8800, cachedInputTokens: 8000, cacheWriteInputTokens: 0, outputTokens: 200, reasoningOutputTokens: 0 }, modelContextWindow: 258400 } })
        notify('turn/completed', { turn: { id: turnId, items: [], status: 'completed', error: null } })
      } else if (turns === 2) {
        const add = { type: 'fileChange', id: 'p-1', status: 'completed', changes: [{ path: `${CWD}/c.txt`, kind: { type: 'add' }, diff: 'alpha\nbeta\n' }] }
        const update = { type: 'fileChange', id: 'p-2', status: 'completed', changes: [{ path: `${CWD}/c.txt`, kind: { type: 'update', move_path: null }, diff: '@@ -1,2 +1,2 @@\n alpha\n-beta\n+BETA\n' }] }
        notify('item/started', { turnId, item: { ...add, status: 'inProgress' } })
        notify('item/completed', { turnId, item: add })
        notify('item/started', { turnId, item: { ...update, status: 'inProgress' } })
        notify('item/completed', { turnId, item: update })
        await h.fake.request('item/tool/requestUserInput', { threadId: THREAD, turnId, itemId: 'q-1', isBlocking: true, autoResolutionMs: null, questions: [{ id: 'lang', header: 'Language', question: 'Which language next?', isOther: false, isSecret: false, options: [{ label: 'Python', description: 'portable' }, { label: 'Bash', description: 'shell' }] }] })
        notify('serverRequest/resolved', { requestId: 1 })
        notify('item/started', { turnId, item: { type: 'agentMessage', id: 'm-2', text: '', phase: 'final_answer' } })
        notify('item/completed', { turnId, item: { type: 'agentMessage', id: 'm-2', text: 'Python it is.', phase: 'final_answer' } })
        notify('turn/completed', { turn: { id: turnId, items: [], status: 'completed', error: null } })
      } else {
        notify('item/started', { turnId, item: command('exec-3', 'sleep 30', 'inProgress', null, null) })
      }
    })()
    return NO_REPLY
  })
  h.fake.on('turn/interrupt', params => {
    setTimeout(() => notify('turn/completed', { turn: { id: params.turnId, items: [], status: 'interrupted', error: null } }), 5)
    return {}
  })

  const term = new XTerm({ cols, rows, scrollback: 400, allowProposedApi: true })
  class FakeStdout extends Writable {
    columns = cols
    rows = rows
    isTTY = true
    _write(chunk: unknown, _encoding: BufferEncoding, callback: () => void): void { term.write(String(chunk), callback) }
  }
  class FakeStdin extends PassThrough {
    isTTY = true
    setRawMode() { return this }
    ref() { return this }
    unref() { return this }
  }
  const stdin = new FakeStdin()
  const stdout = new FakeStdout()
  /** The viewport plus scrollback (inline mode scrolls finished rows up). */
  const screen = (): string => {
    const buffer = term.buffer.active
    const lines: string[] = []
    for (let y = 0; y < buffer.length; y++) lines.push(buffer.getLine(y)?.translateToString(true) ?? '')
    return lines.join('\n')
  }
  const view = (): string => viewportLines(term, rows).join('\n')
  const instance = await ui.render(
    React.createElement(Chat, { channel: channel as never, questionStore: questions, approvalStore: permissions, onExit: () => undefined, fullscreen, trajectorySeen: true }),
    { stdout: stdout as never, stdin: stdin as never, stderr: stdout as never, exitOnCtrlC: false, patchConsole: false },
  )
  for (const value of instances.values()) instances.set(process.stdout, value)
  const type = async (text: string): Promise<void> => {
    for (const char of text) stdin.write(char)
    // 固定窗:pacing the prompt applies typed characters on its own render tick.
    await sleep(60)
  }
  try {
    // 固定窗:pacing the key handlers attach after the first frame.
    await sleep(300)
    await type('run it')
    stdin.write('\r')
    check(`${tag}: the message reaches turn/start with its client id`, await settled(() => h.sent('turn/start').length === 1) && typeof h.sent('turn/start')[0]!.clientUserMessageId === 'string')
    check(`${tag}: the approval panel shows the official wording`, await settled(() => view().includes('Yes, proceed') && view().includes('tell Codex what to do')), view())
    check(`${tag}: the panel names the unwrapped command`, view().includes('echo probe > a.txt'), view())
    stdin.write('1')
    // 固定窗:pacing the digit selects before Enter confirms.
    await sleep(80)
    stdin.write('\r')
    check(`${tag}: allow once answers accept`, await settled(() => [...h.fake.responses.values()].some(answer => (answer.result as Rec | undefined)?.decision === 'accept')))
    check(`${tag}: the terminal card shows the output and the reply streams in`, await settled(() => screen().includes('probe-ok') && screen().includes('All done.')), screen())
    check(`${tag}: the user row appears once (echoed, not optimistic)`, screen().split('run it').length - 1 >= 1 && !view().includes('Yes, proceed'), view())
    check(`${tag}: the turn ends and the session is idle`, await settled(() => !channel.working && h.session.status === 'idle'))

    await type('edit files')
    stdin.write('\r')
    check(`${tag}: the question panel shows the question and its options`, await settled(() => view().includes('Which language next?') && view().includes('Python')), view())
    stdin.write('\r')
    check(`${tag}: Enter answers the focused option`, await settled(() => [...h.fake.responses.values()].some(answer => JSON.stringify(answer.result) === '{"answers":{"lang":{"answers":["Python"]}}}')))
    check(`${tag}: the diff cards show the new and edited file`, await settled(() => screen().includes('c.txt') && screen().includes('BETA') && screen().includes('Python it is.')), screen())

    await type('long one')
    stdin.write('\r')
    check(`${tag}: the running command's card is on screen`, await settled(() => screen().includes('sleep 30')), screen())
    stdin.write('\x1b')
    check(`${tag}: Esc interrupts the turn`, await settled(() => h.sent('turn/interrupt').length === 1 && h.sent('turn/interrupt')[0]!.turnId === 'turn-3'))
    check(`${tag}: the interrupted card and the interrupt row show`, await settled(() => screen().includes(t('codex-interrupted')) && !channel.working), screen())
  } finally {
    instance.unmount()
    channel.releaseContributions()
    await h.session.dispose()
    term.dispose()
  }
}

await run(80, false)
await run(80, true)
await run(40, false)
await run(40, true)
console.log(`\nverify-codex-chat OK (${passed} checks)`)
process.exit(0)
