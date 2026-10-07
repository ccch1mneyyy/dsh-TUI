/**
 * C2 controls through the real Codex session, shared stores/projector and Chat.
 * Only the external app-server is scripted: 80/40 columns × inline/fullscreen.
 * Covers running output tails, true patch line numbers, every command decision
 * label, secret input, Plan review/label, quota warning and backend interrupt text.
 * Run: node --import tsx/esm scripts/verify-codex-chat-controls.tsx
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const home = mkdtempSync(join(tmpdir(), 'codex-chat-controls-'))
process.env.HOME = home
process.env.USERPROFILE = home
process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_LANG = 'en'
process.env.DSH_TUI_THEME = 'dark'
delete process.env.DSH_TUI_BRAND

const [{ Writable, PassThrough }, React, { Terminal: XTerm }, { render }, { Chat }, { QuestionStore }, { PermissionStore }, { createChannel }, { setLang, t }, { default: instances }, { settled, sleep, viewportLines }] = await Promise.all([
  import('node:stream'), import('react'), import('@xterm/headless'), import('../src/ui.js'),
  import('../src/screens/Chat.js'), import('../src/channel/questions.js'), import('../src/channel/permissions.js'),
  import('../src/dsh-adapter/channel.js'), import('../src/i18n.js'), import('../src/ink/instances.js'), import('./lib/term-test.mjs'),
])
const { CWD, openHarness, THREAD } = await import('./lib/codex-session-harness.js')
setLang('en')
type Rec = Record<string, unknown>
let passed = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) throw new Error(label + (detail ? '\n' + detail : ''))
  passed += 1
  console.log('PASS ' + label)
}
const flat = (text: string): string => text.replace(/\s+/gu, '')
const command = (id: string, status = 'inProgress', output: string | null = null): Rec => ({
  type: 'commandExecution', id, command: "/bin/bash -lc 'printf lines'", cwd: CWD, source: 'agent', status,
  commandActions: [{ type: 'unknown', command: 'printf lines' }], aggregatedOutput: output, exitCode: output === null ? null : 0,
})

async function run(cols: number, fullscreen: boolean): Promise<void> {
  const tag = cols + 'c ' + (fullscreen ? 'fullscreen' : 'inline')
  const rows = 48
  const h = await openHarness({ configureFake(fake) {
    fake.on('model/list', () => ({ data: [{ id: 'gpt-5.6-terra', model: 'gpt-5.6-terra', displayName: 'Codex', supportedReasoningEfforts: [{ reasoningEffort: 'low' }] }], nextCursor: null }))
    fake.on('collaborationMode/list', () => ({ data: [{ name: 'Plan', mode: 'plan' }, { name: 'Default', mode: 'default' }] }))
    fake.on('thread/settings/update', () => ({}))
  } })
  const permissions = new PermissionStore()
  const questions = new QuestionStore()
  const ctx = { on: () => () => undefined, get: () => undefined, logger: { warn: () => undefined, info: () => undefined, debug: () => undefined } } as never
  const channel = createChannel(ctx, h.session, { model: 'Codex', provider: 'codex', cwd: CWD, activity: false, backendLabel: 'Codex', interaction: { permissions, questions } })
  channel.setDiffLayout('unified')
  const term = new XTerm({ cols, rows, scrollback: 400, allowProposedApi: true })
  class Output extends Writable {
    columns = cols
    rows = rows
    isTTY = true
    _write(chunk: unknown, _encoding: BufferEncoding, done: () => void): void { term.write(String(chunk), done) }
  }
  class Input extends PassThrough {
    isTTY = true
    setRawMode() { return this }
    ref() { return this }
    unref() { return this }
  }
  const stdin = new Input()
  const stdout = new Output()
  const view = (): string => viewportLines(term, rows).join('\n')
  const screen = (): string => {
    const buffer = term.buffer.active
    return Array.from({ length: buffer.length }, (_, y) => buffer.getLine(y)?.translateToString(true) ?? '').join('\n')
  }
  const app = await render(React.createElement(Chat, { channel: channel as never, questionStore: questions, approvalStore: permissions, fullscreen, trajectorySeen: true, onExit: () => undefined }),
    { stdout: stdout as never, stdin: stdin as never, stderr: stdout as never, exitOnCtrlC: false, patchConsole: false })
  for (const value of instances.values()) instances.set(process.stdout, value)
  const type = async (text: string): Promise<void> => {
    stdin.write(text)
    // 固定窗:pacing one input batch before Enter confirms it.
    await sleep(60)
  }
  const pick = async (digit: string): Promise<void> => { await type(digit); stdin.write('\r') }
  const start = async (text: string): Promise<string> => {
    const before = h.sent('turn/start').length
    await type(text)
    stdin.write('\r')
    check(tag + ': Chat sends ' + text, await settled(() => h.sent('turn/start').length === before + 1), view() + '\n' + JSON.stringify({working: channel.working, pending: channel.pending, sent: h.sent('turn/start')}))
    const params = h.sent('turn/start').at(-1)!
    const id = 'turn-' + (before + 1)
    await h.startTurn(id, String(params.clientUserMessageId), text)
    return id
  }
  const resolveLast = async (): Promise<void> => { await h.notify('serverRequest/resolved', { requestId: [...h.fake.responses.keys()].at(-1) }) }
  try {
    // 固定窗:pacing initial raw-mode handlers and first-frame subscriptions.
    await sleep(300)
    const turn = await start('stream output')
    await h.notify('item/started', { turnId: turn, item: command('live') })
    await h.notify('item/commandExecution/outputDelta', { turnId: turn, itemId: 'live', delta: Array.from({ length: 12 }, (_, i) => 'live-tail-' + (i + 1)).join('\n') + '\n' })
    h.clock.advance(100)
    check(tag + ': newest live output arrives before completion', await settled(() => view().includes('live-tail-12')) && channel.rows.some(row => row.tool?.callId === 'live' && row.tool.status === 'running'), view())
    const retained = fullscreen ? 8 : 5
    check(tag + ': output uses the mode-specific bounded tail', view().includes('live-tail-' + (13 - retained)) && !/live-tail-1\b/u.test(view()) && view().includes(t('tool-live-omitted', { count: 12 - retained })), view())
    await h.notify('item/commandExecution/outputDelta', { turnId: turn, itemId: 'live', delta: 'live-tail-13\n' })
    h.clock.advance(100)
    check(tag + ': another output chunk advances the same card', await settled(() => view().includes('live-tail-13')) && channel.rows.filter(row => row.tool?.callId === 'live').length === 1, view())
    await h.notify('item/completed', { turnId: turn, item: command('live', 'completed', 'settled-output\n') })
    check(tag + ': settlement removes the running tail', await settled(() => view().includes('settled-output') && !view().includes('live-tail-13')) && channel.rows.find(row => row.tool?.callId === 'live')?.tool?.liveOutput === undefined, view())

    const patch = { type: 'fileChange', id: 'patch', status: 'completed', changes: [{ path: CWD + '/numbered.ts', kind: { type: 'update', move_path: null }, diff: '@@ -120,3 +220,3 @@\n keep-anchor\n-old-anchor\n+new-anchor\n tail-anchor\n' }] }
    await h.notify('item/started', { turnId: turn, item: { ...patch, status: 'inProgress' } })
    await h.notify('item/completed', { turnId: turn, item: patch })
    check(tag + ': unified patch paints real old/new line numbers', await settled(() => /121 - old-anchor/u.test(view()) && /221 \+ new-anchor/u.test(view()) && /220   keep-anchor/u.test(view())), view())

    const exec = { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['printf'] } }
    const network = { applyNetworkPolicyAmendment: { network_policy_amendment: { host: 'example.invalid', action: 'allow' } } }
    const approval = h.fake.request('item/commandExecution/requestApproval', { threadId: THREAD, turnId: turn, itemId: 'approval', command: 'printf lines', cwd: CWD,
      availableDecisions: ['accept', 'acceptForSession', exec, network, 'decline', 'cancel'] })
    const labels = [t('codex-approve-accept'), t('codex-approve-session-command'), t('codex-approve-prefix', { prefix: 'printf' }), t('codex-approve-network', { host: 'example.invalid' }), t('codex-approve-decline')]
    check(tag + ': every offered decision has its localized label', await settled(() => labels.every(label => flat(view()).includes(flat(label)))), view())
    // Persistent approvals deliberately require navigation + Enter, not a digit.
    for (let step = 0; step < 3; step += 1) await type('\t')
    stdin.write('\r')
    const networkAnswer = await approval
    check(tag + ': network choice sends the exact offered amendment', JSON.stringify(networkAnswer.result) === JSON.stringify({ decision: network }), JSON.stringify(networkAnswer) + '\n' + view())
    await resolveLast()
    const cancel = h.fake.request('item/commandExecution/requestApproval', { threadId: THREAD, turnId: turn, itemId: 'cancel-label', command: 'printf lines', availableDecisions: ['cancel'] })
    check(tag + ': cancel-only uses the distinct tell-Codex label', await settled(() => flat(view()).includes(flat(t('codex-approve-cancel')))), view())
    stdin.write('\r')
    check(tag + ': cancel-only sends cancel, never decline', JSON.stringify((await cancel).result) === '{"decision":"cancel"}')
    await resolveLast()

    const secret = h.fake.request('item/tool/requestUserInput', { threadId: THREAD, turnId: turn, itemId: 'secret', isBlocking: true, questions: [{ id: 'token', header: 'Credential', question: 'Enter test secret', isSecret: true, isOther: true, options: [] }] })
    check(tag + ': secret questionnaire arrives through the real bridge', await settled(() => view().includes('Enter test secret')), view())
    await type('test-private-value')
    check(tag + ': secret input is masked on screen and scrollback', await settled(() => (view().split('\n').filter(line => !line.trimStart().startsWith('• ')).join('').match(/•/gu)?.length ?? 0) === 18) && !screen().includes('test-private-value'), view())
    stdin.write('\r')
    check(tag + ': secret answer sends original bytes only to the server', JSON.stringify((await secret).result) === '{"answers":{"token":{"answers":["test-private-value"]}}}')
    await resolveLast()
    await h.completeTurn(turn)

    await h.session.capabilities.modes!.set('plan')
    check(tag + ': Plan label reaches the real footer', await settled(() => h.session.capabilities.modes!.current() === 'plan' && view().includes(t('codex-mode-plan'))), view())
    const planned = await start('plan next')
    await h.notify('item/started', { turnId: planned, item: { type: 'plan', id: 'plan-item', text: '' } })
    await h.notify('item/plan/delta', { turnId: planned, itemId: 'plan-item', delta: '# Proposed steps\n\n1. Add regression coverage.' })
    await h.notify('item/completed', { turnId: planned, item: { type: 'plan', id: 'plan-item', text: '# Proposed steps\n\n1. Add regression coverage.' } })
    await h.completeTurn(planned)
    const planLabels = [t('codex-plan-yes'), t('codex-plan-clear'), t('codex-plan-stay')]
    check(tag + ': Plan review reuses the markdown decision panel', await settled(() => view().includes(t('codex-plan-implement')) && view().includes('Proposed steps') && planLabels.every(label => flat(view()).includes(flat(label)))), view())
    const beforeStay = h.sent('turn/start').length
    await pick('3')
    check(tag + ': stay in Plan dismisses review without a new turn', await settled(() => !view().includes(t('codex-plan-implement'))) && h.sent('turn/start').length === beforeStay && h.session.capabilities.modes!.current() === 'plan', view())

    h.fake.notify('account/rateLimits/updated', { rateLimits: { primary: { usedPercent: 95, windowDurationMins: 300 }, secondary: { usedPercent: 100, windowDurationMins: 10080 }, rateLimitReachedType: 'weekly' } })
    const quotaWarning = t('codex-rate-limit-reached', { kind: 'weekly' })
    check(tag + ': quota warning is localized on screen', await settled(() => view().includes(quotaWarning.slice(0, 30))) && channel.rows.some(row => row.text === quotaWarning), view())
    check(tag + ': both quota windows reach the channel', channel.rateLimit?.windows?.length === 2 && channel.rateLimit.windows[1]?.utilization === 1)

    const interrupted = await start('stop here')
    await h.completeTurn(interrupted, 'interrupted')
    check(tag + ': interrupt asks Codex instead of DeepSeek', await settled(() => flat(view()).includes(flat(t('interrupted-ask-backend', { name: 'Codex' })))) && !flat(view()).includes(flat(t('interrupted-ask-next'))), view())
    setLang('zh')
    check(tag + ': language switch keeps Codex interruption identity', await settled(() => flat(view()).includes(flat(t('interrupted-ask-backend', { name: 'Codex' })))), view())
    setLang('en')
  } finally {
    app.unmount()
    channel.releaseContributions()
    await h.session.dispose()
    term.dispose()
  }
}
// The neutral optional seam: DSH retains its exact row shape and painted cells;
// Claude/Codex use the same dependency without a concrete-backend import.
const [{ createChannelProjection }, { createInitialChannelView }, { TurnInterruptedRow }, { renderToScreen }, { cellAt }, { Text }] = await Promise.all([
  import('../src/channel/projection.js'), import('../src/dsh-adapter/channel/state.js'), import('../src/components/TurnInterruptedRow.js'),
  import('../src/ink/render-to-screen.js'), import('../src/ink/screen.js'), import('../src/ui.js'),
])
for (const lang of ['en', 'zh'] as const) {
  setLang(lang)
  for (const label of [undefined, 'Codex', 'Claude']) {
    const state = createInitialChannelView({ model: 'm', provider: 'p', cwd: CWD }, { agentId: 'a', sessionId: 's', mode: { id: 'normal', name: 'Normal' } as never, cwdDescription: CWD })
    const projector = createChannelProjection(state, {
      rowIds: { value: 1 }, ...(label === undefined ? {} : { backendLabel: () => label }),
      resetContextWarning: () => undefined, checkContextWarning: () => undefined, notify: () => () => undefined,
      jobs: { onOutputSeen: () => undefined, onStarted: () => undefined }, inputConvergence: { cancelInFlight: false }, selectionAttached: () => undefined,
    })
    projector.apply([{ type: 'turn.start', turn: 1, origin: 'user', time: 1 }, { type: 'turn.end', turn: 1, reason: { kind: 'interrupted' }, time: 2 }], { replay: false })
    const row = state.rows.find(row => row.kind === 'interrupt')!
    const ask = label === undefined ? t('interrupted-ask-next') : t('interrupted-ask-backend', { name: label })
    check(lang + ': ' + (label ?? 'DSH') + ' projector interrupt text', row.text === t('interrupted-by-user') + ask)
    if (label === undefined) check(lang + ': DSH row shape stays byte-exact', JSON.stringify(row) === JSON.stringify({ id: 1, kind: 'interrupt', text: t('interrupted-by-user') + t('interrupted-ask-next') }))
    for (const cols of [80, 40]) {
      const actual = renderToScreen(React.createElement(TurnInterruptedRow, { backendLabel: row.interruptBackend }), cols)
      const expected = renderToScreen(React.createElement(React.Fragment, null, React.createElement(Text, { dimColor: true }, t('interrupted-by-user')), React.createElement(Text, { dimColor: true }, ask)), cols)
      const sameCells = actual.height === expected.height && Array.from({ length: actual.height }, (_, y) => y).every(y =>
        Array.from({ length: cols }, (_, x) => x).every(x => JSON.stringify(cellAt(actual.screen, x, y)) === JSON.stringify(cellAt(expected.screen, x, y))))
      check(lang + ' ' + cols + 'c: ' + (label ?? 'DSH') + ' interrupt painted cells', sameCells)
    }
  }
}
setLang('en')
for (const cols of [80, 40]) for (const fullscreen of [false, true]) await run(cols, fullscreen)
console.log('\nverify-codex-chat-controls OK (' + passed + ' checks)')
process.exit(0)
