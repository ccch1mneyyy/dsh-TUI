/**
 * Claude notices audit: every SDK message kind that should tell the user
 * something produces a notice with a localized text and a dedupe key,
 * asserted one kind at a time over
 * `scripts/fixtures/claude/notices/messages.jsonl` (messages shaped per the
 * SDK d.ts):
 *
 *  api_retry (toast, key `api-retry`, the HTTP status when known) ·
 *  model_refusal_fallback (session: the model switches + a warning; local
 *  scope: a row only, the model unchanged) · model_refusal_no_fallback ·
 *  informational levels (info/notice → row, suggestion → toast, warning →
 *  both; a tool use's messages share a key) · notification priorities
 *  (low → row, medium → toast, high/immediate → warning; the CLI's key) ·
 *  rate_limit_event (allowed → nothing, allowed_warning → one warning per
 *  state, rejected → an error; the usage windows still update) ·
 *  permission_denied (warning + the call it concerns) · auth_status errors
 *  (progress is silent) · memory_recall (a row, counted) ·
 *  conversation_reset (`session.reset`) · elicitation_complete (no row: the
 *  session closes the URL panel);
 *
 * and the projector's key dedupe: a keyed notice replaces the toast of the
 * same key and updates its row in place while that row is still the last
 * one; zh and en texts both exist for every key used.
 *
 * Run: node --import tsx/esm scripts/verify-claude-notices.ts
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentEvent } from '../src/agent/events.js'
import { createClaudeTranslator } from '../src/backends/claude/translate.js'
import { createChannelProjection } from '../src/channel/projection.js'
import { createInitialChannelView } from '../src/dsh-adapter/channel/state.js'
import { i18nDict, setLang, t } from '../src/i18n.js'

setLang('en')
let passed = 0
const check = (label: string, ok: boolean, detail?: unknown): void => {
  assert.ok(ok, detail === undefined ? label : `${label}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`)
  passed += 1
  console.log(`PASS ${label}`)
}
type Notice = Extract<AgentEvent, { type: 'notice' }>
const fixture = new Map(readFileSync(join(import.meta.dirname, 'fixtures', 'claude', 'notices', 'messages.jsonl'), 'utf8').split('\n').filter(line => line.trim() !== '').map(line => {
  const { kind, msg } = JSON.parse(line) as { kind: string; msg: unknown }
  return [kind, msg] as const
}))
const NOW = Date.UTC(2026, 9, 2, 12, 0, 0)
const translator = createClaudeTranslator({ cwd: '/fixture/project', userRows: 'lifecycle', now: () => NOW })
const run = (kind: string): readonly AgentEvent[] => {
  const message = fixture.get(kind)
  assert.ok(message !== undefined, `fixture has ${kind}`)
  return translator.translate(message)
}
const notices = (events: readonly AgentEvent[]): Notice[] => events.filter((event): event is Notice => event.type === 'notice')
const only = (events: readonly AgentEvent[]): Notice | undefined => notices(events).length === 1 ? notices(events)[0] : undefined

{
  const retry = only(run('api_retry'))
  check('api_retry → a passing toast keyed api-retry, with the attempt and the HTTP status', retry?.level === 'notice' && retry.key === 'api-retry' && retry.text === t('claude-api-retry', { attempt: '2', max: '10', detail: t('claude-api-retry-status', { status: 529 }) }), retry)
  const bare = only(run('api_retry_no_status'))
  check('api_retry without a response status → the same key, no status', bare?.key === 'api-retry' && bare.text === t('claude-api-retry', { attempt: '3', max: '10', detail: '' }), bare)
}
{
  const events = run('model_refusal_fallback')
  const changed = events.find(event => event.type === 'model.changed')
  const notice = only(events)
  check('model_refusal_fallback (session) → the model switches (source fallback)', changed?.type === 'model.changed' && changed.model === 'claude-opus-4-8' && changed.source === 'fallback')
  check('… and a warning keyed model-fallback naming both models and the category', notice?.level === 'warning' && notice.key === 'model-fallback' && notice.text === t('claude-model-fallback', { model: 'claude-opus-4-8', original: 'claude-fable-5-1', category: t('claude-refusal-category-suffix', { category: 'cyber' }) }), notice)
  check('… later frames of that model do not repeat the change', !translator.translate({ type: 'stream_event', event: { type: 'message_start', message: { id: 'm-after', model: 'claude-opus-4-8', usage: {} } } }).some(event => event.type === 'model.changed'))
  const local = run('model_refusal_fallback_local')
  check('model_refusal_fallback (local scope) → a row only; the session model is unchanged', !local.some(event => event.type === 'model.changed') && only(local)?.level === 'info' && only(local)?.text === t('claude-model-fallback-local', { model: 'claude-opus-4-8', original: 'claude-fable-5-1' }))
  const refused = only(run('model_refusal_no_fallback'))
  check('model_refusal_no_fallback → a warning keyed model-refusal', refused?.level === 'warning' && refused.key === 'model-refusal' && refused.text === t('claude-model-refused', { model: 'claude-fable-5-1', category: t('claude-refusal-category-suffix', { category: 'bio' }) }), refused)
}
{
  const level = (kind: string): string | undefined => only(run(kind))?.level
  check('informational info → a row', level('informational_info') === 'info')
  const hook = only(run('informational_notice'))
  check('informational notice (inactive gray) → a row, keyed by its tool use', hook?.level === 'info' && hook.key === 'informational:toolu_fixture_hook')
  check('informational suggestion → a toast', level('informational_suggestion') === 'notice')
  check('informational warning → a warning (row + toast)', level('informational_warning') === 'warning')
}
{
  const notification = (kind: string): Notice | undefined => only(run(kind))
  check('notification low → a row, keyed by the CLI key', notification('notification_low')?.level === 'info' && notification('notification_low')?.key === 'notification:update-available')
  check('notification medium → a toast', notification('notification_medium')?.level === 'notice')
  check('notification high → a warning', notification('notification_high')?.level === 'warning')
  check('notification immediate → a warning', notification('notification_immediate')?.level === 'warning')
}
{
  const allowed = run('rate_limit_allowed')
  check('rate_limit allowed → the usage windows only, no notice', notices(allowed).length === 0 && allowed.some(event => event.type === 'rate-limit'))
  const warning = run('rate_limit_allowed_warning')
  const warned = only(warning)
  check('rate_limit allowed_warning → one warning keyed rate-limit (window, percent, when it resets)', warned?.level === 'warning' && warned.key === 'rate-limit' && warned.text === t('claude-rate-limit-warning', { window: t('status-rate-limit-five-hour'), percent: 91, resets: t('claude-rate-limit-resets', { time: t('claude-rate-limit-in', { duration: '2h 5m' }) }) }), warned)
  const again = run('rate_limit_allowed_warning_again')
  check('… the same state again stays quiet (the windows still update)', notices(again).length === 0 && again.some(event => event.type === 'rate-limit'))
  const rejected = only(run('rate_limit_rejected'))
  check('rate_limit rejected → an error keyed rate-limit', rejected?.level === 'error' && rejected.key === 'rate-limit' && rejected.text === t('claude-rate-limit-rejected', { window: t('status-rate-limit-seven-day'), resets: t('claude-rate-limit-resets', { time: t('claude-rate-limit-in', { duration: '3d 1h' }) }) }), rejected)
}
{
  const denied = only(run('permission_denied'))
  check('permission_denied → a warning on its call, keyed by it', denied?.level === 'warning' && denied.callId === 'toolu_fixture_denied' && denied.key === 'permission-denied:toolu_fixture_denied' && denied.text === t('claude-permission-denied-reason', { tool: 'Bash', reason: 'Bash(rm:*) is denied by a rule' }))
  const auth = only(run('auth_status_error'))
  check('auth_status with an error → an error keyed auth-status', auth?.level === 'error' && auth.key === 'auth-status' && auth.text === t('claude-auth-status-error', { error: 'OAuth refresh failed (401)' }))
  check('auth_status progress → nothing', run('auth_status_progress').length === 0)
  const memory = only(run('memory_recall'))
  check('memory_recall → a row with the count', memory?.level === 'info' && memory.key === 'memory-recall' && memory.text === t('claude-memory-recalled', { count: 2 }))
  const synthesized = only(run('memory_recall_synthesize'))
  check('memory_recall (synthesize) → a row saying it was distilled', synthesized?.level === 'info' && synthesized.text === t('claude-memory-synthesized'))
  const reset = run('conversation_reset')
  const resetEvent = reset.at(-1)
  check('conversation_reset → session.reset with its trigger (whatever was open closes first, no notice)',
    resetEvent?.type === 'session.reset' && resetEvent.trigger === 'plan_mode_exit'
      && reset.some(event => event.type === 'turn.end' && event.reason.kind === 'aborted') && notices(reset).length === 0,
    reset.map(event => event.type))
  check('elicitation_complete → nothing in the transcript (the session closes the panel)', run('elicitation_complete').length === 0)
}

// ── the projector dedupes by key ───────────────────────────────────────
{
  const view = createInitialChannelView(
    { model: 'm', provider: 'p', cwd: '/fixture' },
    { agentId: 'a', sessionId: 's', mode: { id: 'normal', name: 'Normal' } as never, cwdDescription: '/fixture' },
  )
  const state = { ...view, emit: () => undefined } as Parameters<typeof createChannelProjection>[0]
  const toasts: { text: string; dismissed: boolean }[] = []
  const projector = createChannelProjection(state, {
    rowIds: { value: 0 },
    resetContextWarning: () => undefined,
    checkContextWarning: () => undefined,
    notify: text => {
      const toast = { text, dismissed: false }
      toasts.push(toast)
      return () => { toast.dismissed = true }
    },
    jobs: { onOutputSeen: () => undefined, onStarted: () => undefined },
    inputConvergence: { cancelInFlight: false },
    selectionAttached: () => undefined,
  })
  const apply = (events: AgentEvent[]): void => projector.apply(events, { replay: false })
  apply([{ type: 'notice', level: 'notice', key: 'api-retry', text: 'retry 1/10' }])
  apply([{ type: 'notice', level: 'notice', key: 'api-retry', text: 'retry 2/10' }])
  check('a keyed toast replaces the previous toast of its key', toasts.length === 2 && toasts[0]!.dismissed && !toasts[1]!.dismissed)
  apply([{ type: 'notice', level: 'warning', key: 'rate-limit', text: 'close to the limit (90%)' }])
  apply([{ type: 'notice', level: 'warning', key: 'rate-limit', text: 'close to the limit (93%)' }])
  const limitRows = state.rows.filter(row => row.kind === 'notice' && row.text.startsWith('close to the limit'))
  check('a keyed row updates in place while it is the last row', limitRows.length === 1 && limitRows[0]!.text === 'close to the limit (93%)')
  apply([{ type: 'notice', level: 'info', text: 'something else' }])
  apply([{ type: 'notice', level: 'warning', key: 'rate-limit', text: 'close to the limit (95%)' }])
  check('… once other rows follow it, a new row is added (the history stays truthful)', state.rows.filter(row => row.kind === 'notice' && row.text.startsWith('close to the limit')).length === 2)
  apply([{ type: 'notice', level: 'info', text: 'plain one' }])
  apply([{ type: 'notice', level: 'info', text: 'plain one' }])
  check('unkeyed notices are never merged', state.rows.filter(row => row.text === 'plain one').length === 2)
}

// ── every notice key used here exists in both languages ─────────────────
{
  const keys = ['claude-api-retry', 'claude-api-retry-status', 'claude-model-fallback', 'claude-model-fallback-local', 'claude-model-refused', 'claude-refusal-category-suffix', 'claude-rate-limit-warning', 'claude-rate-limit-rejected', 'claude-rate-limit-resets', 'claude-rate-limit-in', 'claude-permission-denied-reason', 'claude-auth-status-error', 'claude-memory-recalled', 'claude-memory-synthesized'] as const
  const dict = i18nDict as Record<string, { zh?: unknown; en?: unknown }>
  check('zh and en texts exist for every notice key', keys.every(key => dict[key]?.zh !== undefined && dict[key]?.en !== undefined), keys.filter(key => dict[key]?.zh === undefined || dict[key]?.en === undefined))
}

console.log(`\nverify-claude-notices OK (${passed} checks)`)
