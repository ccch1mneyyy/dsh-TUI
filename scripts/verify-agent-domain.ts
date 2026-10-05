/**
 * Agent Domain gate (`pnpm run verify:agent-domain`):
 *
 *  1. Session references round-trip through `formatSessionRef` /
 *     `parseSessionRef`, including backend ids that contain a colon
 *     (`acp:gemini`) and session ids that do.
 *  2. Exhaustiveness is present in source: the shared projector folds
 *     `AgentEvent` in a `switch (event.type)` whose default is a `never`
 *     check, and every translator (`src/dsh-adapter/backend/translate.ts`,
 *     `src/backends/<id>/translate.ts`) carries an exhaustive
 *     `switch (type)` over `AgentEventType` with a `never` default, so a new
 *     event variant fails `tsc` in each place until it is decided.
 *  3. The DSH translator only emits the event types it declares
 *     (`dshEmits`), over every DSH fixture (live and replay).
 *
 * Plain fs + regex for (2): no TypeScript program, like verify:boundary.
 *
 * Run: node --import tsx/esm scripts/verify-agent-domain.ts
 */
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { AgentEvent } from '../src/agent/events.js'
import { DEFAULT_BACKEND_ID, formatSessionRef, parseSessionRef, sameSessionRef, type AgentSessionRef } from '../src/agent/refs.js'
import { createDshTranslator, dshEmits } from '../src/dsh-adapter/backend/translate.js'
import { FIXTURE_DIR, buildFixtures } from './fixtures/dsh/generate.js'

const SRC = resolve(import.meta.dirname, '..', 'src')
let passed = 0
const check = (label: string, ok: boolean, detail?: string): void => {
  assert.ok(ok, detail === undefined ? label : `${label}: ${detail}`)
  passed += 1
  console.log(`PASS ${label}`)
}

// ── 1. session references ───────────────────────────────────────────────
const known = ['dsh', 'claude', 'acp', 'acp:gemini']
const refs: AgentSessionRef[] = [
  { backendId: 'dsh', sessionId: 'sess-01' },
  { backendId: 'dsh', sessionId: 'claude:not-a-prefix-for-dsh' },
  { backendId: 'claude', sessionId: '6f1c2b8e-0000-4000-8000-000000000001' },
  { backendId: 'acp', sessionId: 'plain' },
  { backendId: 'acp:gemini', sessionId: 'g-1' },
  { backendId: 'acp:gemini', sessionId: 'with:colons:inside' },
]
for (const ref of refs) {
  const text = formatSessionRef(ref)
  const parsed = parseSessionRef(text, known)
  // A DSH id that happens to look prefixed is the one documented ambiguity:
  // DSH refs serialize bare, so `claude:…` reads back as a Claude ref.
  if (ref.backendId === DEFAULT_BACKEND_ID && text.includes(':')) {
    check(`bare DSH text "${text}" parses by known prefix`, parsed.backendId === 'claude')
    continue
  }
  check(`ref ${ref.backendId}:${ref.sessionId} round-trips`, sameSessionRef(parsed, ref), JSON.stringify(parsed))
}
check('longest known prefix wins (acp:gemini over acp)', parseSessionRef('acp:gemini:x', known).backendId === 'acp:gemini')
check('an unknown prefix is a bare DSH id', sameSessionRef(parseSessionRef('codex:abc', known), { backendId: 'dsh', sessionId: 'codex:abc' }))
check('a prefix with an empty session id is a bare DSH id', parseSessionRef('claude:', known).backendId === 'dsh')
check('an explicit dsh: prefix is not stripped', parseSessionRef('dsh:abc', known).sessionId === 'dsh:abc')

// ── 2. exhaustiveness in source ─────────────────────────────────────────
const read = (path: string): string => readFileSync(join(SRC, path), 'utf8')
const projection = read('channel/projection.ts')
check('projector switches over event.type', /switch \(event\.type\)/u.test(projection))
check('projector default is a never check over the event', /const \w+: never = event\b/u.test(projection))

const translators = ['dsh-adapter/backend/translate.ts']
const backendsDir = join(SRC, 'backends')
if (existsSync(backendsDir)) {
  for (const entry of readdirSync(backendsDir)) {
    if (existsSync(join(backendsDir, entry, 'translate.ts'))) {
      translators.push(entry === 'claude' ? 'backends/claude/translate/events.ts' : `backends/${entry}/translate.ts`)
    }
  }
}
for (const path of translators) {
  const source = read(path)
  const decision = /\(type: AgentEventType\)[^{]*\{\s*switch \(type\) \{[\s\S]*?const \w+: never = type\b/u.test(source)
  check(`${path}: exhaustive switch over AgentEventType with a never default`, decision)
}

// ── 3. the DSH translator only emits declared types ─────────────────────
const readJsonl = (path: string): unknown[] => {
  let raw: string
  try { raw = readFileSync(path, 'utf8') } catch { return [] }
  return raw.split('\n').filter(line => line.trim() !== '').map(line => JSON.parse(line) as unknown)
}
type Translator = ReturnType<typeof createDshTranslator>
const emitted = new Set<AgentEvent['type']>()
for (const fixture of buildFixtures()) {
  const events = readJsonl(join(FIXTURE_DIR, `${fixture.name}.jsonl`)) as Parameters<Translator['translateReplay']>[0]
  const frames = readJsonl(join(FIXTURE_DIR, `${fixture.name}.frames.jsonl`)) as Parameters<Translator['translateFrame']>[0][]
  const deps = { tools: () => undefined, scope: () => ({}), attachments: () => undefined }
  const live = createDshTranslator(deps)
  for (const event of events) for (const out of live.translateEvent(event)) emitted.add(out.type)
  for (const frame of frames) for (const out of live.translateFrame(frame)) emitted.add(out.type)
  for (const out of createDshTranslator(deps).translateReplay(events)) emitted.add(out.type)
}
const undeclared = [...emitted].filter(type => !dshEmits(type))
check('DSH fixtures emit only declared event types', undeclared.length === 0, undeclared.join(','))

console.log(`\nverify:agent-domain OK (${passed} checks)`)
