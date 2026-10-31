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
 * turn's async questions leave its tool running, accept a steered answer,
 * and dismiss without interruption; Esc then interrupts the command.
 *
 * Run: node --import tsx/esm scripts/verify-codex-chat.tsx
 */
process.env.FORCE_COLOR = '3'

const [{ Writable, PassThrough }, React, { Terminal: XTerm }, ui, { Chat }, { QuestionStore }, { createChannel }, { setLang, t }, { codexText }, { default: instances }, { settled, sleep, viewportLines }, { PermissionStore }] =
  await Promise.all([
    import('node:stream'),
    import('react'),
    import('@xterm/headless'),
    import('../src/ui.js'),
    import('../src/screens/Chat.js'),
    import('../src/dsh-adapter/questions.js'),
    import('../src/dsh-adapter/channel.js'),
    import('../src/i18n.js'),
    import('../src/backends/codex/text.js'),
    import('../src/ink/instances.js'),
    import('./lib/term-test.mjs'),
    import('../src/channel/permissions.js'),
  ])
import { NO_REPLY } from './lib/codex-fake-app-server.js'
import { CWD, openHarness, THREAD, tick } from './lib/codex-session-harness.js'
import { MAX_ROWS, trimLocalRows } from '../src/channel/transcript.js'
import { cleanCommandReport } from '../src/channel/sanitize.js'
import { createProjectorHarness } from './lib/projector-harness.js'
import { foldRows } from '../src/dsh-adapter/channel/transcript.js'

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
  const h = await openHarness({
    configureFake: fake => {
      // The real backend command catalog needs `skills/list` to resolve: with
      // it failing, `commands.changed` never lands and the completion menu has
      // no `/usage` row — the state where Enter happens to work.
      fake.on('skills/list', () => ({ data: [{ cwd: CWD, skills: [] }] }))
      // Two calls: exactly 200 lines + a real trailing newline (must not add a
      // blank row or a false truncation), then 300 lines (must be capped).
      let diffCalls = 0
      fake.on('gitDiffToRemote', () => {
        diffCalls += 1
        const count = diffCalls === 1 ? 200 : 300
        const prefix = diffCalls === 1 ? '+first ' : '+second '
        return { sha: 'abc', diff: `${Array.from({ length: count }, (_, i) => `${prefix}${i}`).join('\n')}\n` }
      })
      fake.on('account/rateLimits/read', () => ({
        rateLimits: {
          primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 1800000000 },
          secondary: { usedPercent: 50, windowDurationMins: 10080, resetsAt: 1800001000 },
          credits: { balance: '42.5', unlimited: false, hasCredits: true },
        },
      }))
    },
  })
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
        const asyncQuestion = { type: 'agentMessage', id: 'async-3', delivery: 'async', phase: 'final_answer', text: 'Which approach?\n- Small\n- Full\n\nAny details?', questions: [{ title: 'Which approach?', options: ['Small', 'Full'] }, { title: 'Any details?' }] }
        notify('item/started', { turnId, item: asyncQuestion })
        notify('item/completed', { turnId, item: asyncQuestion })
      }
    })()
    return NO_REPLY
  })
  h.fake.on('turn/interrupt', params => {
    setTimeout(() => notify('turn/completed', { turn: { id: params.turnId, items: [], status: 'interrupted', error: null } }), 5)
    return {}
  })
  h.fake.on('turn/steer', params => {
    const text = String((params.input as Rec[])[0]?.text ?? '')
    const reply = userItem('async-reply', String(params.clientUserMessageId), text)
    notify('item/started', { turnId: params.expectedTurnId, item: reply })
    notify('item/completed', { turnId: params.expectedTurnId, item: reply })
    return { turnId: params.expectedTurnId }
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
    // A backend command that answers itself has no channel-side echo: the
    // projector must draw its output live (issue #1774), not only on replay.
    await type('/usage')
    // The menu row is the path this fix exists for: without it Enter takes the
    // plain submit path and the completion dispatch is never exercised.
    check(`${tag}: the completion menu holds the backend command`, await settled(() => channel.commandCompletions('/usage').length === 1 && screen().includes('Show Codex')), view())
    stdin.write('\r')
    check(`${tag}: /usage keeps one row per window`, await settled(() => {
      const rows = channel.rows.filter(row => row.kind === 'local-output')
      return rows.some(row => row.text.includes('25%') && !row.text.includes('50%'))
        && rows.some(row => row.text.includes('50%') && !row.text.includes('25%'))
        && rows.some(row => row.text.includes('42.5'))
    }), view())
    check(`${tag}: /usage clears the draft`, await settled(() => !view().includes('❯ /usage')), view())
    check(`${tag}: /usage is on screen`, await settled(() => screen().includes('25%')), screen())
    check(`${tag}: /usage never starts a turn`, h.sent('turn/start').length === 0, String(h.sent('turn/start').length))
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
    check(`${tag}: async question opens while the session keeps working`, await settled(() => view().includes('Which approach?') && view().includes('Small')) && channel.working && h.session.status === 'running', view())
    stdin.write('\r')
    check(`${tag}: async default answer steers without interrupting`, await settled(() => h.sent('turn/steer').length === 1 && view().includes('Any details?')) && h.sent('turn/interrupt').length === 0, view())
    check(`${tag}: async answer echo is readable and has no protocol envelope`, await settled(() => channel.rows.some(row => row.kind === 'user' && row.text === '> Which approach?\n\nSmall')) && !screen().includes('send_user_message_question_reply'), view())
    stdin.write('\x1b')
    check(`${tag}: dismissing an async question leaves work running`, await settled(() => questions.getSnapshot() === null) && h.sent('turn/interrupt').length === 0 && channel.working, view())
    // While the turn runs, the menu dispatches a backend command through the
    // typed placement: it answers itself, never reaches turn/steer, and does
    // not start a new turn. The notice is the discriminator — `steerSend`
    // says "Interrupted", a plain submit would say "after this turn".
    const notices: string[] = []
    const notify = channel.notify
    channel.notify = (text, options) => {
      notices.push(text)
      return notify.call(channel, text, options)
    }
    await type('/usage')
    // 固定窗:墙钟 跨过 handleEnter 的 80ms Enter 去重窗
    await sleep(120)
    stdin.write('\r')
    check(`${tag}: /usage answers mid-turn without a steer or a new turn`, await settled(() => channel.rows.filter(row => row.kind === 'local' && row.text === '/usage').length >= 2
      && h.sent('turn/start').length === 3
      && !h.sent('turn/steer').some(request => JSON.stringify(request).includes('/usage'))), view())
    check(`${tag}: the mid-turn dispatch takes the typed placement`, notices.includes(t('input-interrupted-next')), JSON.stringify(notices))
    channel.notify = notify
    stdin.write('\x1b')
    check(`${tag}: Esc interrupts the turn`, await settled(() => h.sent('turn/interrupt').length === 1 && h.sent('turn/interrupt')[0]!.turnId === 'turn-3'))
    check(`${tag}: the interrupted card and the interrupt row show`, await settled(() => screen().includes(codexText('codex-interrupted')) && !channel.working), screen())

    // Exactly 200 lines + a trailing newline: no blank row, no false truncation.
    await type('/diff')
    stdin.write('\r')
    check(`${tag}: /diff keeps exactly 200 lines with a trailing newline`, await settled(() => {
      const rows = channel.rows.filter(row => row.kind === 'local-output')
      return rows.filter(row => row.text.startsWith('+first ')).length === 200
        && !rows.some(row => row.text.includes('truncated'))
        && !rows.some(row => row.text === '\u00a0')
    }), String(channel.rows.filter(row => row.kind === 'local-output').length))
    check(`${tag}: /diff titles its report block`, channel.rows.some(row => row.kind === 'local' && row.text === '/diff'))

    // 300 lines: capped at 200 with a truncation row.
    await type('/diff')
    stdin.write('\r')
    check(`${tag}: an oversized /diff is capped with a truncation row`, await settled(() => {
      const rows = channel.rows.filter(row => row.kind === 'local-output')
      return rows.filter(row => row.text.startsWith('+second ')).length === 200
        && rows.some(row => row.text.includes('truncated'))
    }), String(channel.rows.filter(row => row.kind === 'local-output').length))
  } finally {
    instance.unmount()
    channel.releaseContributions()
    await h.session.dispose()
    term.dispose()
  }
}

// The local-row budget must drop whole blocks: a run of headerless rows would
// be spliced as one block and wipe every earlier report at once.
{
  const rows: { kind: string }[] = []
  for (let block = 0; block < 4; block++) {
    rows.push({ kind: 'local' })
    for (let i = 0; i < 200; i++) rows.push({ kind: 'local-output' })
  }
  trimLocalRows(rows, 10)
  check('trimLocalRows drops whole blocks and keeps the newest', rows.length === 402 && rows.filter(row => row.kind === 'local').length === 2)
}

// The report budget's boundary: a trailing newline is a terminator, not a row.
{
  const exact = cleanCommandReport(`${Array.from({ length: 200 }, (_, i) => `+l${i}`).join('\n')}\n`)
  const over = cleanCommandReport(`${Array.from({ length: 201 }, (_, i) => `+l${i}`).join('\n')}\n`)
  check('cleanCommandReport: 200 lines + trailing newline is exact', exact.lines.length === 200 && !exact.truncated && !exact.lines.includes(''))
  check('cleanCommandReport: 201 lines + trailing newline truncates to 200', over.lines.length === 200 && over.truncated)
  // CRLF: the terminator is `\r\n`, so it must not charge a cell or unit to
  // the last line (which would clip a 4000-cell line or fake a 64K truncation).
  const crlfCells = cleanCommandReport(`${'x'.repeat(4000)}\r\n`)
  // A lone CR is a terminator too: it must not become a space row or charge
  // the last line with a cell.
  const loneCr = cleanCommandReport('\r')
  const loneCrCells = cleanCommandReport(`${'x'.repeat(4000)}\r`)
  // Exactly maxCodeUnits of content across narrow lines: the leftover `\r`
  // would push `raw` to 65_537 and fake a truncation.
  const exactUnits = `${Array.from({ length: 16 }, () => 'x'.repeat(4000)).join('\n')}\n${'y'.repeat(1520)}`
  const crlfUnits = cleanCommandReport(`${exactUnits}\r\n`)
  const crUnits = cleanCommandReport(`${exactUnits}\r`)
  check('cleanCommandReport: CRLF terminator does not clip the last line', crlfCells.lines.length === 1 && crlfCells.lines[0]!.length === 4000 && !crlfCells.truncated)
  check('cleanCommandReport: CRLF terminator does not fake a 64K truncation', exactUnits.length === 65_536 && crlfUnits.lines.length === 17 && !crlfUnits.truncated)
  check('cleanCommandReport: a lone CR is a terminator, not a row', loneCr.lines.length === 0 && !loneCr.truncated)
  check('cleanCommandReport: a lone CR does not clip the last line', loneCrCells.lines.length === 1 && loneCrCells.lines[0]!.length === 4000 && !loneCrCells.truncated)
  check('cleanCommandReport: a lone CR does not fake a 64K truncation', crUnits.lines.length === 17 && !crUnits.truncated)
}

// A report title is untrusted text too: the projector cleans it with the same
// sanitizer as the body before it becomes a `local` row.
{
  const harness = createProjectorHarness()
  harness.apply([{
    type: 'user.message',
    id: 'title-1',
    anchor: 'title-1',
    seq: 1,
    time: 0,
    source: 'command-output',
    text: 'line',
    blocks: [{ type: 'text', text: 'line' }],
    label: '\u001b[31m/diff\u001b[0m\x07',
    displayLive: true,
  } as never])
  const title = harness.state.rows.find(row => row.kind === 'local')
  check('a report title is sanitized before it becomes a row', title !== undefined && title.text === '/diff', JSON.stringify(title?.text))
}

// A label that cleans to nothing must not leave an empty title row.
{
  const harness = createProjectorHarness()
  harness.apply([{
    type: 'user.message',
    id: 'title-2',
    anchor: 'title-2',
    seq: 1,
    time: 0,
    source: 'command-output',
    text: 'line',
    blocks: [{ type: 'text', text: 'line' }],
    label: '\u001b[31m\u001b[0m\u0007',
    displayLive: true,
  } as never])
  const title = harness.state.rows.find(row => row.kind === 'local')
  check('an empty sanitized title falls back to the neutral label', title !== undefined && title.text === 'Command output', JSON.stringify(title?.text))
}

// A terminator-only report has no body: drawing its title alone would read as
// a render failure. The channel-side sink already drops it; both sinks agree.
{
  const harness = createProjectorHarness()
  harness.apply([{
    type: 'user.message',
    id: 'empty-1',
    anchor: 'empty-1',
    seq: 1,
    time: 0,
    source: 'command-output',
    text: '\n',
    blocks: [{ type: 'text', text: '\n' }],
    label: '/diff',
    displayLive: true,
  } as never])
  check('a terminator-only report draws no title row', harness.state.rows.length === 0)
}

// A middle splice that also grows the array must reset the fold cursor: the
// old boundary row moved even though `excess > from`, so the shifted assistant
// rows would never fold again. The fixture keeps foldable rows inside the
// shifted window (1 notice + 50 local + MAX_ROWS+49 assistant): the previous
// versions of the witness check left 10 assistant rows unfolded here.
// Derived from MAX_ROWS so a cap change cannot silently weaken the fixture.
{
  const cap = MAX_ROWS
  const rows: { kind: string; text: string; folded?: boolean }[] = []
  rows.push({ kind: 'notice', text: 'n' })
  for (let i = 0; i < 50; i++) rows.push({ kind: 'local', text: 'l' })
  for (let i = 0; i < cap + 49; i++) rows.push({ kind: 'assistant', text: 'a'.repeat(10) })
  const cursor = { rows: rows as unknown, index: 0, head: undefined as unknown, boundary: undefined as unknown }
  foldRows(rows as never, cap, cursor as never)
  trimLocalRows(rows as never, cap - 40)
  for (let i = 0; i < cap - 40; i++) rows.push({ kind: 'local', text: 'l' })
  foldRows(rows as never, cap, cursor as never)
  const excess = rows.length - cap
  const unfolded = rows.slice(0, excess).filter(row => row.kind === 'assistant' && row.folded !== true).length
  check('foldRows rescans after a net-growth middle splice', unfolded === 0)
}

// Same splice, but the incoming report replaces exactly the rows it removed:
// the array length never changes, so only the boundary witness can notice the
// shift. A length comparison would stay green here while memory retention
// returns.
{
  const cap = MAX_ROWS
  const rows: { kind: string; text: string; folded?: boolean }[] = []
  rows.push({ kind: 'notice', text: 'n' })
  for (let i = 0; i < 50; i++) rows.push({ kind: 'local', text: 'l' })
  for (let i = 0; i < cap + 49; i++) rows.push({ kind: 'assistant', text: 'a'.repeat(10) })
  const cursor = { rows: rows as unknown, index: 0, head: undefined as unknown, boundary: undefined as unknown }
  foldRows(rows as never, cap, cursor as never)
  const before = rows.length
  trimLocalRows(rows as never, cap)
  const removed = before - rows.length
  for (let i = 0; i < removed; i++) rows.push({ kind: 'local', text: 'l' })
  foldRows(rows as never, cap, cursor as never)
  const excess = rows.length - cap
  const unfolded = rows.slice(0, excess).filter(row => row.kind === 'assistant' && row.folded !== true).length
  check('foldRows rescans after an equal-length middle splice', removed > 0 && rows.length === before && unfolded === 0)
}

await run(80, false)
await run(80, true)
await run(40, false)
await run(40, true)
console.log(`\nverify-codex-chat OK (${passed} checks)`)
process.exit(0)
