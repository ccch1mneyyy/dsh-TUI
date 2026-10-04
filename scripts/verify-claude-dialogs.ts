/**
 * MCP elicitation and the CLI's user dialogs on a Claude session
 * (docs/agent-backend-design.md §4.3, §4.7; Phase 5b), over a fake SDK —
 * no CLI, no network:
 *
 *  - the query declares `onElicitation`, `onUserDialog` and
 *    `supportedDialogKinds: ['refusal_fallback_prompt']`;
 *  - form mode: one question per schema field (enum → choices with their
 *    titles, boolean → yes / no with its default, multi-select array →
 *    checkboxes, string / number → the free-text row with a constraint
 *    hint, an optional field skippable), then send / decline; invalid
 *    answers are asked again with the reason (only those fields), valid ones
 *    become typed content (`{action:'accept', content}`); decline,
 *    dismiss (cancel) and the SDK's abort (cancel, panel withdrawn);
 *  - URL mode: a notice row with the URL, a question carrying the link,
 *    accept / decline; `system/elicitation_complete` closes it as accepted;
 *    an unsupported mode is declined with a notice;
 *  - the refusal-fallback dialog: retry → `retry_fallback`, cancel →
 *    `cancelled`, dismissal → `{behavior:'cancelled'}`; an undeclared kind
 *    is cancelled at once; a redelivered request joins the same answer;
 *  - status: `requires-action` while a dialog is parked; dispose cancels
 *    what is still open;
 *  - end to end through the channel's interaction bridge and the real
 *    QuestionStore, and the questionnaire panel renders the link.
 *
 * Run: node --import tsx/esm scripts/verify-claude-dialogs.ts
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'dsh-tui-claude-dialogs-'))
process.env.HOME = home
process.env.USERPROFILE = home
process.env.FORCE_COLOR = '3'

const [
  { openClaudeSession },
  { memoryClaudePrefs },
  { formFields, parseFieldText },
  { createChannel },
  { QuestionStore },
  { PermissionStore },
  { setLang, t },
  { settled },
  fakes,
] = await Promise.all([
  import('../src/backends/claude/session.js'),
  import('../src/backends/claude/prefs.js'),
  import('../src/backends/claude/dialogs.js'),
  import('../src/dsh-adapter/channel.js'),
  import('../src/channel/questions.js'),
  import('../src/channel/permissions.js'),
  import('../src/i18n.js'),
  import('./lib/term-test.mjs'),
  import('./lib/claude-fake-sdk.js'),
])
type AgentEvent = import('../src/agent/events.js').AgentEvent
type QuestionRequest = Extract<AgentEvent, { type: 'question.request' }>['request']

setLang('en')
let passed = 0
const check = (label: string, ok: boolean, detail?: unknown): void => {
  assert.ok(ok, detail === undefined ? label : `${label}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`)
  passed += 1
  console.log(`PASS ${label}`)
}
const { fakeClaudeSdk, claudeDeps, tick } = fakes
const ctx = { on: () => () => undefined, get: () => undefined, logger: { warn: () => undefined, info: () => undefined, debug: () => undefined } } as never
type Elicit = (request: Record<string, unknown>, options: { signal: AbortSignal; requestId: string }) => Promise<Record<string, unknown> | null>
type Dialog = (request: Record<string, unknown>, options: { signal: AbortSignal; requestId: string }) => Promise<Record<string, unknown> | null>

async function open() {
  const fake = fakeClaudeSdk()
  const session = await openClaudeSession(claudeDeps(fake.sdk, { prefs: memoryClaudePrefs() }))
  const events: AgentEvent[] = []
  session.subscribe(batch => { events.push(...batch) })
  await tick()
  const options = fake.queries[0]!.options as Record<string, unknown>
  const lastAsk = (): QuestionRequest | undefined => events.filter((event): event is Extract<AgentEvent, { type: 'question.request' }> => event.type === 'question.request').at(-1)?.request
  return { fake, session, events, options, elicit: options.onElicitation as Elicit, dialog: options.onUserDialog as Dialog, lastAsk }
}
const answer = (...items: { selected?: string[]; custom?: string }[]) => ({ answers: items.map(item => ({ selected: item.selected ?? [], ...(item.custom === undefined ? {} : { custom: item.custom }) })) })

// ── the query declares the callbacks ───────────────────────────────────
{
  const { session, options } = await open()
  check('the query wires onElicitation and onUserDialog', typeof options.onElicitation === 'function' && typeof options.onUserDialog === 'function')
  check('… and declares exactly the dialog kinds it renders', JSON.stringify(options.supportedDialogKinds) === JSON.stringify(['refusal_fallback_prompt']))
  await session.dispose()
}

// ── schema → fields, and typed validation ──────────────────────────────
{
  const fields = formFields({
    type: 'object',
    properties: {
      name: { type: 'string', title: 'Your name', minLength: 2 },
      age: { type: 'integer', minimum: 0, maximum: 150 },
      color: { type: 'string', enum: ['red', 'green'], enumNames: ['Red', 'Green'] },
      size: { type: 'string', oneOf: [{ const: 's', title: 'Small' }, { const: 'l', title: 'Large' }] },
      subscribe: { type: 'boolean', default: true },
      tags: { type: 'array', items: { type: 'string', enum: ['x', 'y'] } },
      email: { type: 'string', format: 'email', description: 'Where to write' },
      when: { type: 'string', format: 'date' },
      stamp: { type: 'string', format: 'date-time' },
      extra: { type: 'object' },
    },
    required: ['name', 'age', 'color', 'size'],
  })
  check('fields keep declaration order and kinds', fields.map(field => `${field.key}:${field.kind}:${field.required ? 'req' : 'opt'}`).join() === 'name:text:req,age:integer:req,color:choice:req,size:choice:req,subscribe:boolean:opt,tags:multi:opt,email:text:opt,when:text:opt,stamp:text:opt,extra:json:opt', fields.map(field => field.kind))
  check('enum titles: enumNames and oneOf const/title', JSON.stringify(fields[2]!.choices) === JSON.stringify([{ label: 'Red', value: 'red' }, { label: 'Green', value: 'green' }]) && fields[3]!.choices?.[1]?.label === 'Large')
  const value = (key: string, text: string) => parseFieldText(fields.find(field => field.key === key)!, text)
  check('integer: parsed as a number; a fraction, a word, out of range refused', JSON.stringify(value('age', '42')) === '{"value":42}' && 'error' in value('age', '4.5') && 'error' in value('age', 'old') && 'error' in value('age', '151'))
  check('string: minLength and email format', 'error' in value('name', 'A') && 'value' in value('name', 'Ann') && 'error' in value('email', 'nope') && 'value' in value('email', 'a@b.co'))
  check('an object field (not an MCP primitive) is refused as text', 'error' in value('extra', '{"a":1}'))
  // Date.parse cannot judge RFC3339 dates: it rolls 2024-02-31 over into
  // March instead of refusing it, so the calendar is checked for real.
  check('date: a real calendar day (rollovers refused, leap days kept)',
    'value' in value('when', '2024-02-29') && 'value' in value('when', '2023-12-31')
    && 'error' in value('when', '2024-02-31') && 'error' in value('when', '2023-02-29') && 'error' in value('when', '2024-04-31') && 'error' in value('when', '2024-13-01') && 'error' in value('when', '02/29/2024'))
  // Full RFC3339: the timezone is required and explicit (never the local
  // fallback), the day real, the clock within range, t/z lower case legal,
  // fractional seconds and numeric offsets kept.
  check('date-time: full RFC3339 — timezone required, real day, clock in range',
    'value' in value('stamp', '2024-01-01T00:00:00Z') && 'value' in value('stamp', '2024-01-01t00:00:00z')
    && 'value' in value('stamp', '2024-06-15T12:30:45-05:30') && 'value' in value('stamp', '2024-01-01T00:00:00.123Z') && 'value' in value('stamp', '2024-01-01T23:59:59.5+00:00')
    && 'error' in value('stamp', '2024-01-01T00:00:00') && 'error' in value('stamp', '2024-02-30T10:00:00Z') && 'error' in value('stamp', '2024-01-01T24:00:00Z') && 'error' in value('stamp', '2024-01-01T00:00:00+8:00') && 'error' in value('stamp', '2024-01-01 00:00:00Z'))
  // A leap second is legal RFC3339 syntax (Date.parse would refuse it);
  // whether the day really had one stays the server's to check.
  check('date-time: a leap second is legal syntax',
    'value' in value('stamp', '2016-12-31T23:59:60Z') && 'value' in value('stamp', '2017-01-01T07:59:60+08:00') && 'error' in value('stamp', '2024-01-01T00:00:61Z'))
}

// ── form mode: ask, re-ask the invalid, accept typed content ────────────
{
  const { session, events, elicit, lastAsk } = await open()
  const schema = {
    type: 'object',
    properties: {
      name: { type: 'string', title: 'Your name', minLength: 2 },
      age: { type: 'integer', minimum: 0, maximum: 150 },
      color: { type: 'string', enum: ['red', 'green'], enumNames: ['Red', 'Green'] },
      subscribe: { type: 'boolean', default: true },
      tags: { type: 'array', items: { type: 'string', enum: ['x', 'y'] } },
      email: { type: 'string', format: 'email' },
    },
    required: ['name', 'age', 'color'],
  }
  const pending = elicit({ serverName: 'acme', message: 'Tell us about you', mode: 'form', requestedSchema: schema }, { signal: new AbortController().signal, requestId: 'r1' })
  await tick()
  const ask = lastAsk()!
  check('one question per field, then send / decline', ask.questions.length === 7 && ask.questions.at(-1)!.options.map(option => option.label).join() === `${t('claude-elicit-send')},${t('claude-elicit-decline')}`)
  check('the first question carries the request message', (ask.questions[0]!.detail ?? '').includes('Tell us about you') && ask.questions[0]!.header === 'acme')
  check('choices are options only (no free text); a boolean preselects its default', ask.questions[2]!.hideCustomInput === true && JSON.stringify(ask.questions[3]!.defaultSelected) === JSON.stringify([t('claude-elicit-yes')]))
  check('a multi-select array is checkboxes', ask.questions[4]!.multiSelect === true)
  check('an optional field can be skipped; a number shows its range', ask.questions[5]!.options.some(option => option.label === t('claude-elicit-skip')) && (ask.questions[1]!.detail ?? '').includes('150'))
  check('the session needs the user while it is open', session.status === 'requires-action')
  session.capabilities.questions!.respond(ask.requestId, answer(
    { custom: 'A' }, { custom: '200' }, { selected: ['Red'] }, { selected: [t('claude-elicit-no')] }, { selected: ['x'] }, { selected: [t('claude-elicit-skip')] }, { selected: [t('claude-elicit-send')] },
  ))
  await tick()
  const again = lastAsk()!
  check('invalid answers are asked again, only those fields, saying why', again.requestId !== ask.requestId && again.questions.length === 2 && (again.questions[0]!.detail ?? '').includes(t('claude-elicit-invalid-min-length', { n: 2 })) && (again.questions[1]!.detail ?? '').includes(t('claude-elicit-invalid-max', { max: 150 })), again.questions.map(question => question.detail))
  check('… the first ask was withdrawn', events.some(event => event.type === 'question.settled' && event.requestId === ask.requestId))
  session.capabilities.questions!.respond(again.requestId, answer({ custom: 'Ann' }, { custom: '30' }))
  const result = await pending
  check('valid answers accept with typed content (the skipped field omitted)', JSON.stringify(result) === JSON.stringify({ action: 'accept', content: { color: 'red', subscribe: false, tags: ['x'], name: 'Ann', age: 30 } }), result)
  check('… the panel closes and the session is idle again', events.some(event => event.type === 'question.settled' && event.requestId === again.requestId) && session.status === 'idle')

  // Decline, dismiss, abort.
  const declined = elicit({ serverName: 'acme', message: 'Again?', requestedSchema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] } }, { signal: new AbortController().signal, requestId: 'r2' })
  await tick()
  session.capabilities.questions!.respond(lastAsk()!.requestId, answer({ selected: [t('claude-elicit-yes')] }, { selected: [t('claude-elicit-decline')] }))
  check('decline → {action:"decline"}', JSON.stringify(await declined) === '{"action":"decline"}')
  const dismissed = elicit({ serverName: 'acme', message: 'Dismiss me', requestedSchema: { type: 'object', properties: {} } }, { signal: new AbortController().signal, requestId: 'r3' })
  await tick()
  check('a schema with no fields asks only send / decline, with the message', lastAsk()!.questions.length === 1 && lastAsk()!.questions[0]!.detail === 'Dismiss me')
  session.capabilities.questions!.cancel(lastAsk()!.requestId)
  check('a dismissed panel → {action:"cancel"}', JSON.stringify(await dismissed) === '{"action":"cancel"}')
  const controller = new AbortController()
  const aborted = elicit({ serverName: 'acme', message: 'Abort me', requestedSchema: { type: 'object', properties: { a: { type: 'string' } } } }, { signal: controller.signal, requestId: 'r4' })
  await tick()
  const abortedAsk = lastAsk()!.requestId
  controller.abort()
  check('the SDK abort withdraws the panel and answers cancel', JSON.stringify(await aborted) === '{"action":"cancel"}' && events.some(event => event.type === 'question.settled' && event.requestId === abortedAsk))
  await session.dispose()
}

// ── URL mode, completion, unsupported modes ────────────────────────────
{
  const { session, events, elicit, lastAsk, fake } = await open()
  const url = 'https://auth.example.com/connect?x=1'
  const accepted = elicit({ serverName: 'github', message: 'Authorize GitHub', mode: 'url', url, elicitationId: 'e1' }, { signal: new AbortController().signal, requestId: 'u1' })
  await tick()
  const notice = events.find((event): event is Extract<AgentEvent, { type: 'notice' }> => event.type === 'notice' && event.text.includes(url))
  check('URL mode: a notice row names the server and the URL', notice !== undefined && notice.level === 'info' && notice.text.includes('github'))
  check('URL mode: the question carries the link and accept / decline', lastAsk()!.questions[0]!.link === url && lastAsk()!.questions[0]!.options.length === 2)
  session.capabilities.questions!.respond(lastAsk()!.requestId, answer({ selected: [t('claude-elicit-url-accept')] }))
  check('URL mode: accept → {action:"accept"}', JSON.stringify(await accepted) === '{"action":"accept"}')
  const declined = elicit({ serverName: 'github', message: 'Again', mode: 'url', url, elicitationId: 'e2' }, { signal: new AbortController().signal, requestId: 'u2' })
  await tick()
  session.capabilities.questions!.respond(lastAsk()!.requestId, answer({ selected: [t('claude-elicit-decline')] }))
  check('URL mode: decline → {action:"decline"}', JSON.stringify(await declined) === '{"action":"decline"}')
  const completed = elicit({ serverName: 'github', message: 'Wait for me', mode: 'url', url, elicitationId: 'e3' }, { signal: new AbortController().signal, requestId: 'u3' })
  await tick()
  const shown = lastAsk()!.requestId
  fake.queries[0]!.emit({ type: 'system', subtype: 'elicitation_complete', mcp_server_name: 'github', elicitation_id: 'e3' })
  check('elicitation_complete closes the URL panel as accepted', JSON.stringify(await completed) === '{"action":"accept"}' && await settled(() => events.some(event => event.type === 'question.settled' && event.requestId === shown)))
  const noUrl = await elicit({ serverName: 'github', message: 'No link', mode: 'url' }, { signal: new AbortController().signal, requestId: 'u4' })
  check('URL mode without a URL is declined', JSON.stringify(noUrl) === '{"action":"decline"}')
  const unsupported = await elicit({ serverName: 'odd', message: 'Huh', mode: 'hologram' }, { signal: new AbortController().signal, requestId: 'u5' })
  check('a mode this client cannot render is declined, with a notice', JSON.stringify(unsupported) === '{"action":"decline"}' && events.some(event => event.type === 'notice' && event.level === 'warning' && event.text === t('claude-elicit-unsupported', { server: 'odd', mode: 'hologram' })))
  // Labels are fixed when the flow parks: a language switch while the
  // panel is open does not turn the answer into a mismatch.
  const switched = elicit({ serverName: 'acme', message: 'Lang', requestedSchema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] } }, { signal: new AbortController().signal, requestId: 'u6' })
  await tick()
  const shownLabels = lastAsk()!.questions.map(question => question.options.map(option => option.label))
  setLang('zh')
  session.capabilities.questions!.respond(lastAsk()!.requestId, answer({ selected: [shownLabels[0]![0]!] }, { selected: [shownLabels[1]![0]!] }))
  // A mismatch would re-ask instead of answering: bounded, it fails here.
  const switchedResult = await Promise.race([switched, new Promise(resolve => { setTimeout(() => resolve('re-asked instead of answered'), 2000) })])
  setLang('en')
  check('a language switch while the panel is open keeps the answer valid', JSON.stringify(switchedResult) === '{"action":"accept","content":{"ok":true}}', switchedResult)
  // Dispose with one still open.
  const open1 = elicit({ serverName: 'github', message: 'Left open', mode: 'url', url, elicitationId: 'e9' }, { signal: new AbortController().signal, requestId: 'u9' })
  await tick()
  await session.dispose()
  check('dispose cancels what is still open', JSON.stringify(await open1) === '{"action":"cancel"}')
}

// ── the refusal-fallback dialog ────────────────────────────────────────
{
  const { session, events, dialog, lastAsk } = await open()
  const payload = { originalModel: 'claude-fable-5-1', fallbackModel: 'claude-opus-4-8', apiRefusalCategory: 'cyber', guidanceText: 'This request was declined.' }
  const retried = dialog({ dialogKind: 'refusal_fallback_prompt', payload }, { signal: new AbortController().signal, requestId: 'd1' })
  await tick()
  const ask = lastAsk()!
  check('the dialog asks retry on the fallback model / cancel', ask.questions[0]!.options.map(option => option.label).join() === `${t('claude-refusal-retry', { model: 'claude-opus-4-8' })},${t('claude-refusal-cancel')}` && ask.questions[0]!.question === t('claude-refusal-question', { model: 'claude-fable-5-1' }))
  check('… with the guidance and the category', (ask.questions[0]!.detail ?? '').includes('This request was declined.') && (ask.questions[0]!.detail ?? '').includes('cyber'))
  session.capabilities.questions!.respond(ask.requestId, answer({ selected: [t('claude-refusal-retry', { model: 'claude-opus-4-8' })] }))
  check('retry → {behavior:"completed", result:"retry_fallback"}', JSON.stringify(await retried) === '{"behavior":"completed","result":"retry_fallback"}')
  const cancelled = dialog({ dialogKind: 'refusal_fallback_prompt', payload }, { signal: new AbortController().signal, requestId: 'd2' })
  await tick()
  session.capabilities.questions!.respond(lastAsk()!.requestId, answer({ selected: [t('claude-refusal-cancel')] }))
  check('cancel → {behavior:"completed", result:"cancelled"}', JSON.stringify(await cancelled) === '{"behavior":"completed","result":"cancelled"}')
  const dismissed = dialog({ dialogKind: 'refusal_fallback_prompt', payload }, { signal: new AbortController().signal, requestId: 'd3' })
  await tick()
  // A redelivered request joins the open one (one panel, one answer).
  const redelivered = dialog({ dialogKind: 'refusal_fallback_prompt', payload }, { signal: new AbortController().signal, requestId: 'd3' })
  await tick()
  check('a redelivered request opens no second panel', events.filter(event => event.type === 'question.request' && event.request.requestId === 'dialog-d3').length === 1)
  session.capabilities.questions!.cancel(lastAsk()!.requestId)
  check('a dismissed dialog → {behavior:"cancelled"} (the default), for both deliveries', JSON.stringify(await dismissed) === '{"behavior":"cancelled"}' && JSON.stringify(await redelivered) === '{"behavior":"cancelled"}')
  const before = events.length
  const unknown = await dialog({ dialogKind: 'auto_mode_server_fallback', payload: {} }, { signal: new AbortController().signal, requestId: 'd4' })
  check('an undeclared kind is cancelled at once, no panel', JSON.stringify(unknown) === '{"behavior":"cancelled"}' && !events.slice(before).some(event => event.type === 'question.request'))
  const controller = new AbortController()
  const aborted = dialog({ dialogKind: 'refusal_fallback_prompt', payload }, { signal: controller.signal, requestId: 'd5' })
  await tick()
  controller.abort()
  check('the SDK abort withdraws the dialog', JSON.stringify(await aborted) === '{"behavior":"cancelled"}')
  // A redelivery's own signal counts like the first one's: aborting it
  // withdraws the shared panel and answers both deliveries.
  const first = dialog({ dialogKind: 'refusal_fallback_prompt', payload }, { signal: new AbortController().signal, requestId: 'd6' })
  await tick()
  const second = new AbortController()
  const again = dialog({ dialogKind: 'refusal_fallback_prompt', payload }, { signal: second.signal, requestId: 'd6' })
  await tick()
  second.abort()
  const outcomes = await Promise.race([Promise.all([first, again]), new Promise(resolve => { setTimeout(() => resolve('hung'), 1000) })])
  check('a redelivery\'s abort withdraws the shared dialog for both deliveries',
    JSON.stringify(outcomes) === '[{"behavior":"cancelled"},{"behavior":"cancelled"}]' && events.some(event => event.type === 'question.settled' && event.requestId === 'dialog-d6'), outcomes)
  const third = dialog({ dialogKind: 'refusal_fallback_prompt', payload }, { signal: new AbortController().signal, requestId: 'd7' })
  await tick()
  const gone = new AbortController()
  gone.abort()
  const late = dialog({ dialogKind: 'refusal_fallback_prompt', payload }, { signal: gone.signal, requestId: 'd7' })
  const both = await Promise.race([Promise.all([third, late]), new Promise(resolve => { setTimeout(() => resolve('hung'), 1000) })])
  check('… and one that arrives already aborted settles the group at once',
    JSON.stringify(both) === '[{"behavior":"cancelled"},{"behavior":"cancelled"}]' && session.status !== 'requires-action', both)
  await session.dispose()
}

// ── end to end: channel bridge + QuestionStore, and the panel's link ──
{
  const fake = fakeClaudeSdk()
  const session = await openClaudeSession(claudeDeps(fake.sdk, { prefs: memoryClaudePrefs() }))
  const questions = new QuestionStore()
  const permissions = new PermissionStore()
  const channel = createChannel(ctx, session, { model: 'Claude Agent', provider: 'claude', cwd: '/fixture/project', activity: false, backendLabel: 'Claude Agent', interaction: { permissions, questions } })
  try {
    const elicit = (fake.queries[0]!.options as Record<string, unknown>).onElicitation as Elicit
    const url = 'https://auth.example.com/ok'
    const pending = elicit({ serverName: 'github', message: 'Connect GitHub', mode: 'url', url, elicitationId: 'x1' }, { signal: new AbortController().signal, requestId: 'c1' })
    check('the URL question parks in the shared store with its link', await settled(() => questions.getSnapshot()?.question.link === url))
    questions.answerCurrent({ selected: [t('claude-elicit-url-accept')] })
    check('the store answer reaches the SDK', JSON.stringify(await pending) === '{"action":"accept"}')
    const form = elicit({ serverName: 'acme', message: 'Pick', requestedSchema: { type: 'object', properties: { n: { type: 'number', minimum: 1 } }, required: ['n'] } }, { signal: new AbortController().signal, requestId: 'c2' })
    await settled(() => questions.getSnapshot()?.question.question === 'n')
    questions.answerCurrent({ selected: [], custom: '0' })
    questions.answerCurrent({ selected: [t('claude-elicit-send')] })
    check('an invalid store answer is asked again in the store', await settled(() => (questions.getSnapshot()?.question.detail ?? '').includes(t('claude-elicit-invalid-min', { min: 1 }))))
    questions.answerCurrent({ selected: [], custom: '2.5' })
    check('… and the valid one is sent', JSON.stringify(await form) === '{"action":"accept","content":{"n":2.5}}')
  } finally {
    channel.releaseContributions()
    await session.dispose()
  }
}

// ── the questionnaire panel renders the link ───────────────────────────
{
  const [React, { render }, { AskUserQuestionPanel }, { PassThrough, Writable }] = await Promise.all([
    import('react'),
    import('../src/ui.js'),
    import('../src/components/questions/AskUserQuestionPanel.js'),
    import('node:stream'),
  ])
  class Out extends Writable {
    columns = 90
    rows = 30
    isTTY = true
    frames: string[] = []
    _write(chunk: unknown, _encoding: BufferEncoding, callback: () => void) { this.frames.push(String(chunk)); callback() }
  }
  class In extends PassThrough {
    isTTY = true
    setRawMode() { return this }
    ref() { return this }
    unref() { return this }
  }
  const stdout = new Out()
  const url = 'https://auth.example.com/panel'
  const instance = await render(React.createElement(AskUserQuestionPanel, {
    question: { id: '0', question: 'Authorize', header: 'github', detail: t('claude-elicit-url-detail'), link: url, options: [{ label: t('claude-elicit-url-accept') }, { label: t('claude-elicit-decline') }], hideCustomInput: true },
    position: 1, total: 1, answered: 0, canGoBack: false, canGoForward: false,
    onAnswer: () => undefined, onCancel: () => undefined,
  } as never), { stdout: stdout as never, stdin: new In() as never, stderr: new Out() as never, exitOnCtrlC: false, patchConsole: false })
  await settled(() => stdout.frames.join('').includes('auth.example.com/panel'))
  const plain = stdout.frames.join('').replace(/\u001b\][^\u0007]*\u0007/gu, '').replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/gu, '')
  check('the panel shows the link under the question', plain.includes(url), plain.slice(-600))
  instance.unmount()
}

console.log(`\nverify-claude-dialogs OK (${passed} checks)`)
process.exit(0)
