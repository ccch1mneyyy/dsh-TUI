/**
 * The backend-neutral MCP elicitation ↔ questionnaire helper
 * (`src/channel/elicitation.ts`), pure and without a backend:
 *
 *  - schema → fields: enum (`enum` + `enumNames`, `oneOf` const + title,
 *    duplicate labels made unique), boolean, multi-select array, number /
 *    integer, plain text, anything else JSON; required vs optional; title
 *    and description fallbacks;
 *  - typed validation of free text (number range, integer, length, email,
 *    uri, real calendar dates, RFC3339 date-times, pattern, JSON);
 *  - a form flow: first ask (every field, then send / decline), decline,
 *    an invalid round re-asks only the invalid fields saying why, a valid
 *    re-ask completes with typed content (skipped optional fields absent),
 *    labels fixed when first asked (a language switch mid-flow still
 *    matches);
 *  - URL mode: no URL → nothing to ask; the question carries the link and
 *    accept / decline; the notice texts; the header chip clip;
 *  - zh and en both resolve every string; no vendor import in the module.
 *
 * Run: node --import tsx/esm scripts/verify-elicitation.ts
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const [
  { createElicitationForm, createElicitationUrlAsk, elicitationNotices, fieldQuestion, formFields, parseFieldText, serverHeader },
  { setLang, t },
] = await Promise.all([
  import('../src/channel/elicitation.js'),
  import('../src/i18n.js'),
])

let passed = 0
const check = (label: string, ok: boolean, detail?: unknown): void => {
  assert.ok(ok, detail === undefined ? label : `${label}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`)
  passed += 1
  console.log(`PASS ${label}`)
}
/** Key-order-insensitive JSON of a flat record. */
const sorted = (value: Readonly<Record<string, unknown>>): string => JSON.stringify(Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))))
const answers = (...items: { selected?: string[]; custom?: string }[]) => ({ answers: items.map(item => ({ selected: item.selected ?? [], ...(item.custom === undefined ? {} : { custom: item.custom }) })) })

setLang('en')

// ── module hygiene ──────────────────────────────────────────────────────
{
  const source = readFileSync(resolve(import.meta.dirname, '..', 'src', 'channel', 'elicitation.ts'), 'utf8')
  const imports = [...source.matchAll(/from '([^']+)'/gu)].map(match => match[1]!)
  check('the module imports only the agent domain and i18n', imports.every(path => path === '../agent/capabilities.js' || path === '../agent/events.js' || path === '../i18n.js'), imports)
}

// ── schema → fields ─────────────────────────────────────────────────────
const schema = {
  type: 'object',
  properties: {
    name: { type: 'string', title: 'Your name', minLength: 2 },
    age: { type: 'integer', minimum: 0, maximum: 150, description: 'Years' },
    color: { type: 'string', enum: ['r', 'g'], enumNames: ['Red', 'Green'], default: 'g' },
    size: { type: 'string', oneOf: [{ const: 's', title: 'Small' }, { const: 'l', title: 'Small' }] },
    agree: { type: 'boolean', default: true },
    tags: { type: 'array', items: { enum: ['a', 'b', 'c'] }, minItems: 1, maxItems: 2 },
    note: { type: 'string' },
    blob: { type: 'object' },
  },
  required: ['name', 'age', 'color', 'agree'],
}
const fields = formFields(schema)
const byKey = (key: string) => fields.find(field => field.key === key)!
check('fields keep declaration order', fields.map(field => field.key).join() === 'name,age,color,size,agree,tags,note,blob')
check('kinds follow the schema', fields.map(field => field.kind).join() === 'text,integer,choice,choice,boolean,multi,text,json', fields.map(field => field.kind))
check('required comes from the schema', byKey('name').required && !byKey('note').required)
check('the title falls back to the key', byKey('note').title === 'note' && byKey('name').title === 'Your name')
check('enumNames label an enum', JSON.stringify(byKey('color').choices) === JSON.stringify([{ label: 'Red', value: 'r' }, { label: 'Green', value: 'g' }]))
check('duplicate oneOf titles are made unique', byKey('size').choices!.map(choice => choice.label).join() === 'Small,Small (l)')
check('no properties → no fields', formFields({ type: 'object' }).length === 0 && formFields(undefined).length === 0 && formFields('junk').length === 0)

// ── typed validation ────────────────────────────────────────────────────
const parse = (key: string, text: string, override?: Record<string, unknown>) => parseFieldText(override === undefined ? byKey(key) : { ...byKey(key), schema: { ...byKey(key).schema, ...override } }, text)
check('an integer in range parses', JSON.stringify(parse('age', '42')) === '{"value":42}')
check('a fraction is not an integer', JSON.stringify(parse('age', '4.5')) === JSON.stringify({ error: t('elicit-invalid-integer') }))
check('above the maximum is refused', JSON.stringify(parse('age', '200')) === JSON.stringify({ error: t('elicit-invalid-max', { max: 150 }) }))
check('not a number is refused', JSON.stringify(parse('age', 'x')) === JSON.stringify({ error: t('elicit-invalid-number') }))
check('too short a text is refused', JSON.stringify(parse('name', 'A')) === JSON.stringify({ error: t('elicit-invalid-min-length', { n: 2 }) }))
check('length counts code points (CJK, emoji)', 'value' in parse('name', '张三') && 'value' in parse('name', '😀😀'))
check('email format', 'error' in parse('note', 'nope', { format: 'email' }) && 'value' in parse('note', 'a@b.co', { format: 'email' }))
check('uri format', 'error' in parse('note', 'not a uri', { format: 'uri' }) && 'value' in parse('note', 'https://x.test/a', { format: 'uri' }))
check('a date must be a real calendar day', 'error' in parse('note', '2024-02-30', { format: 'date' }) && 'value' in parse('note', '2024-02-29', { format: 'date' }) && 'error' in parse('note', '2023-02-29', { format: 'date' }))
check('a date-time needs a timezone and a valid clock', 'error' in parse('note', '2024-01-01T10:00:00', { format: 'date-time' }) && 'value' in parse('note', '2024-01-01T10:00:00Z', { format: 'date-time' }) && 'error' in parse('note', '2024-01-01T24:00:00Z', { format: 'date-time' }))
check('a pattern is enforced (and a broken one is left to the server)', 'error' in parse('note', 'abc', { pattern: '^\\d+$' }) && 'value' in parse('note', '123', { pattern: '^\\d+$' }) && 'value' in parse('note', 'abc', { pattern: '(' }))
check('a JSON field takes a scalar or a string array, never an object', 'value' in parseFieldText({ ...byKey('blob'), schema: { type: 'array' } }, '["a","b"]') && 'error' in parse('blob', '{"a":1}') && 'error' in parse('blob', '{oops'))

// ── field questions ─────────────────────────────────────────────────────
{
  const choice = fieldQuestion(byKey('color'), 'srv', undefined, undefined)
  check('a choice is options only, preselecting its default', choice.hideCustomInput === true && JSON.stringify(choice.defaultSelected) === '["Green"]' && choice.options.map(option => option.label).join() === 'Red,Green')
  const optional = fieldQuestion(byKey('note'), 'srv', undefined, undefined)
  check('an optional free-text field offers skip and the text row', optional.question === t('elicit-optional', { title: 'note' }) && optional.options.map(option => option.label).join() === t('elicit-skip') && optional.hideCustomInput !== true)
  const number = fieldQuestion(byKey('age'), 'srv', 'Lead line', t('elicit-invalid-number'))
  check('a re-asked number says why, keeps the lead and shows its range', (number.detail ?? '').split('\n').join('|') === [t('elicit-invalid', { reason: t('elicit-invalid-number') }), 'Lead line', 'Years', t('elicit-hint-range', { kind: t('elicit-kind-integer'), min: 0, max: 150 })].join('|'), number.detail)
  const multi = fieldQuestion(byKey('tags'), 'srv', undefined, undefined)
  check('a multi-select array is checkboxes', multi.multiSelect === true && multi.hideCustomInput === true && multi.options.length === 4)
}

// ── a form flow ─────────────────────────────────────────────────────────
const request = { serverName: 'github', displayName: 'GitHub MCP', title: 'Sign up', message: 'Tell us about you', requestedSchema: schema }
{
  const form = createElicitationForm(request)
  check('one question per field, then send / decline', form.questions.length === fields.length + 1 && form.questions.at(-1)!.options.map(option => option.label).join() === `${t('elicit-send')},${t('elicit-decline')}`)
  check('the header chip names the server, the lead rides on the first field', form.questions.every(question => question.header === 'GitHub MCP') && (form.questions[0]!.detail ?? '').startsWith('Sign up\nTell us about you'))
  check('the confirmation names the server', form.questions.at(-1)!.question === t('elicit-confirm', { server: 'github' }))
  const declined = form.answer(answers({ custom: 'Al' }, { custom: '3' }, { selected: ['Red'] }, {}, { selected: ['Yes'] }, {}, {}, {}, { selected: [t('elicit-decline')] }))
  check('declining ends the flow', declined.kind === 'decline')
}
{
  const form = createElicitationForm(request)
  const first = form.answer(answers(
    { custom: 'A' }, { custom: '200' }, { selected: ['Red'] }, { selected: [t('elicit-skip')] }, { selected: [t('elicit-no')] },
    { selected: ['a', 'b', 'c'] }, { selected: [t('elicit-skip')] }, { selected: [t('elicit-skip')] }, { selected: [t('elicit-send')] },
  ))
  check('an invalid round re-asks only the invalid fields, saying why', first.kind === 'reask' && first.questions.length === 3
    && (first.questions[0]!.detail ?? '').includes(t('elicit-invalid-min-length', { n: 2 }))
    && (first.questions[1]!.detail ?? '').includes(t('elicit-invalid-max', { max: 150 }))
    && (first.questions[2]!.detail ?? '').includes(t('elicit-invalid-max-items', { n: 2 })), first)
  // The flow fixed its labels when first asked; a language switch now must
  // not turn the remaining answers into mismatches.
  setLang('zh')
  const second = form.answer(answers({ custom: '  Ada ' }, { custom: '36' }, { selected: ['a'] }))
  setLang('en')
  check('a valid re-ask completes with typed content; skipped fields stay absent', second.kind === 'accept' && sorted(second.content) === sorted({ name: 'Ada', age: 36, color: 'r', agree: false, tags: ['a'] }), second)
}
{
  const empty = createElicitationForm({ serverName: 'srv', message: 'Just confirm', requestedSchema: {} })
  check('a field-less form is the confirmation alone, carrying the lead', empty.questions.length === 1 && empty.questions[0]!.detail === 'Just confirm')
  const done = empty.answer(answers({ selected: [t('elicit-send')] }))
  check('… and sending it accepts empty content', done.kind === 'accept' && JSON.stringify(done.content) === '{}')
}
{
  const form = createElicitationForm({ serverName: 'srv', message: '', requestedSchema: { type: 'object', properties: { pick: { type: 'string', enum: ['x'] } }, required: ['pick'] } })
  const step = form.answer(answers({}, { selected: [t('elicit-send')] }))
  check('a required choice left empty is re-asked', step.kind === 'reask' && (step.questions[0]!.detail ?? '').includes(t('elicit-invalid-choice')))
}

// ── URL mode and notices ────────────────────────────────────────────────
{
  check('no URL → nothing to ask', createElicitationUrlAsk({ serverName: 'srv', message: 'x' }) === undefined && createElicitationUrlAsk({ serverName: 'srv', message: 'x', url: '  ' }) === undefined)
  const ask = createElicitationUrlAsk({ serverName: 'github', message: '', url: 'https://example.test/auth' })!
  const question = ask.questions[0]!
  check('the URL question carries the link and accept / decline', question.link === 'https://example.test/auth' && question.question === t('elicit-url-question', { server: 'github' }) && question.options.map(option => option.label).join() === `${t('elicit-url-accept')},${t('elicit-decline')}` && question.hideCustomInput === true)
  check('accept is the first option only', ask.accepted(answers({ selected: [t('elicit-url-accept')] })) && !ask.accepted(answers({ selected: [t('elicit-decline')] })) && !ask.accepted(answers({})))
  const own = createElicitationUrlAsk({ serverName: 'github', message: 'Authorize the app', url: 'https://example.test' })!
  check('the server message is the question when present', own.questions[0]!.question === 'Authorize the app')
  check('notices name the server (and the URL)', elicitationNotices.urlOpen('github', 'https://x.test') === t('elicit-url-notice', { server: 'github', url: 'https://x.test' })
    && elicitationNotices.urlComplete('github') === t('elicit-url-complete', { server: 'github' })
    && elicitationNotices.urlMissing('github') === t('elicit-url-missing', { server: 'github' })
    && elicitationNotices.unsupported('github', 'hologram') === t('elicit-unsupported', { server: 'github', mode: 'hologram' }))
  check('the header chip clips a long server name', serverHeader('a   very long    server name that goes on') === 'a very long server name…' && serverHeader(' short ') === 'short')
}

// ── both languages resolve ──────────────────────────────────────────────
for (const lang of ['zh', 'en'] as const) {
  setLang(lang)
  const form = createElicitationForm(request)
  const texts = [
    ...form.questions.flatMap(question => [question.question, question.detail ?? '', ...question.options.flatMap(option => [option.label, option.description ?? ''])]),
    ...createElicitationUrlAsk({ serverName: 's', message: '', url: 'https://x.test' })!.questions.flatMap(question => [question.question, question.detail ?? '']),
  ]
  check(`${lang}: every string resolves (no raw keys)`, texts.every(text => !/\belicit-[a-z-]+\b/u.test(text)), texts.filter(text => /\belicit-/u.test(text)))
}
setLang('en')

console.log(`\nverify-elicitation OK (${passed} checks)`)
