/**
 * OSC 7501 (Program Status Protocol) regression.
 *
 * Covers:
 * - Wire format for every state, plus the required `app` on each report
 *   (each report replaces its record, so a key must ride along every time)
 * - Free text: base64, control characters / newlines collapsed, byte-bounded
 *   on a code-point boundary, and the protocol's per-field limits
 * - Whole-report refusal: unknown state, `kind`/`progress` on states that
 *   forbid them, malformed `id`/`app`, oversized sequence
 * - `clear` with and without an `id`
 * - The enable gate: on by default, TTY required, `DSH_TUI_PROGRAM_STATUS`
 *   opt-out with the usual falsy spellings
 * - The hook end to end through a real Ink mount: precedence
 *   (blocked > working > done/error > idle), dedup of unchanged states, no
 *   `done` for a resumed session's stale outcome, and the disabled gate
 * - The terminal state's source: a real projector drives the close reason, so
 *   a turn that measured no usage still reports `error` (and cancels report
 *   idle) instead of reading the previous turn's ledger
 *
 * Run: node --import tsx/esm scripts/verify-osc7501.tsx
 */

import assert from 'node:assert/strict'
import { PassThrough, Writable } from 'node:stream'
import React from 'react'
import { renderSync, Text } from '../src/ui.js'
import { TerminalWriteProvider } from '../src/ink/useTerminalNotification.js'
import { useProgramStatus, PROGRAM_STATUS_APP } from '../src/ink/hooks/use-program-status.js'
import {
  clearProgramStatus,
  programStatus,
  sanitizeProgramText,
  supportsProgramStatus,
} from '../src/ink/termio/osc7501.js'
import instances from '../src/ink/instances.js'
import { createProjectorHarness } from './lib/projector-harness.ts'
import type { AgentEvent } from '../src/agent/events.js'

let failed = 0
function check(name: string, fn: () => void): void {
  try {
    fn()
    console.log(`  ok - ${name}`)
  } catch (error) {
    failed++
    console.log(`  FAIL - ${name}`)
    console.log(`    ${error instanceof Error ? error.message : String(error)}`)
  }
}

const ESC = '\x1b'
const PREFIX = `${ESC}]7501;`

// -----------------------------------------------------------------------------
// 1. Wire format
// -----------------------------------------------------------------------------
console.log('wire format')

check('working carries state and app', () => {
  assert.equal(
    programStatus({ state: 'working', app: 'dsh-tui' }),
    `${PREFIX}state=working:app=dsh-tui${ESC}\\`,
  )
})

check('blocked carries kind', () => {
  assert.equal(
    programStatus({ state: 'blocked', kind: 'permission', app: 'dsh-tui' }),
    `${PREFIX}state=blocked:kind=permission:app=dsh-tui${ESC}\\`,
  )
})

check('blocked with progress keeps spec pair order', () => {
  assert.equal(
    programStatus({ state: 'blocked', kind: 'question', progress: 40, app: 'dsh-tui' }),
    `${PREFIX}state=blocked:kind=question:progress=40:app=dsh-tui${ESC}\\`,
  )
})

check('msg is base64 of the single-line text', () => {
  assert.equal(
    programStatus({ state: 'done', app: 'dsh-tui', msg: 'Upgraded 12 packages' }),
    `${PREFIX}state=done:app=dsh-tui:msg=VXBncmFkZWQgMTIgcGFja2FnZXM=${ESC}\\`,
  )
})

check('non-ASCII msg is base64 UTF-8', () => {
  assert.equal(
    programStatus({ state: 'done', app: 'dsh-tui', msg: '世界' }),
    `${PREFIX}state=done:app=dsh-tui:msg=5LiW55WM${ESC}\\`,
  )
})

check('title and msg are independently encoded', () => {
  const out = programStatus({ state: 'working', app: 'dsh-tui', title: 'US East', msg: 'Pushing image' })
  assert.match(out, /:title=VVMgRWFzdA==/)
  assert.match(out, /:msg=UHVzaGluZyBpbWFnZQ==/)
})

check('sequence is ST-terminated (no BEL side effects)', () => {
  const out = programStatus({ state: 'working', app: 'dsh-tui' })
  assert.ok(out.endsWith(`${ESC}\\`))
  assert.ok(!out.includes('\x07'))
})

check('output is not tmux/screen wrapped', () => {
  // Passthrough would reach the outer terminal, which cannot tell panes apart
  // or see the program exit — the record lifetime depends on the pty.
  const out = programStatus({ state: 'working', app: 'dsh-tui' })
  assert.ok(out.startsWith(`${ESC}]7501;`))
  assert.ok(!out.includes('\x1bP'))
})

// -----------------------------------------------------------------------------
// 2. Sanitization and limits
// -----------------------------------------------------------------------------
console.log('sanitization and limits')

check('control characters and newlines are removed, not escaped', () => {
  assert.equal(sanitizeProgramText('a\nb\tc'), 'a b c')
  assert.equal(sanitizeProgramText('a\x1b]0;PWNED\x07b'), 'a ]0;PWNED b')
  assert.equal(sanitizeProgramText('x\x00y'), 'x y')
})

check('sanitized text never round-trips an escape sequence', () => {
  const out = programStatus({ state: 'error', app: 'dsh-tui', msg: 'boom\x1b]52;c;AAAA\x07' })
  const encoded = /msg=([A-Za-z0-9+/=]*)/.exec(out)?.[1] ?? ''
  const decoded = Buffer.from(encoded, 'base64').toString('utf8')
  assert.ok(!/[\x00-\x1f\x7f-\x9f]/.test(decoded), `control char survived: ${JSON.stringify(decoded)}`)
  assert.ok(!decoded.includes('\x1b'))
})

check('msg is truncated to the protocol cap without splitting a code point', () => {
  // 4 bytes per emoji: 2048 decoded bytes fits 512 of them exactly; the
  // encoded budget is the binding one here.
  const out = programStatus({ state: 'done', app: 'dsh-tui', msg: '🌊'.repeat(2000) })
  const encoded = /msg=([A-Za-z0-9+/=]*)/.exec(out)?.[1]
  assert.ok(encoded !== undefined)
  assert.ok(encoded.length <= 2732, `encoded msg ${encoded.length} over cap`)
  const decoded = Buffer.from(encoded, 'base64').toString('utf8')
  assert.ok(!decoded.includes('\ufffd'), 'truncation split a multi-byte character')
  assert.ok(decoded.startsWith('🌊'))
})

check('oversized title is truncated, empty text omits the key', () => {
  const out = programStatus({ state: 'working', app: 'dsh-tui', title: 'x'.repeat(500) })
  const encoded = /title=([A-Za-z0-9+/=]*)/.exec(out)?.[1]
  assert.ok(encoded !== undefined && encoded.length <= 256)
  const blank = programStatus({ state: 'working', app: 'dsh-tui', msg: '', title: '   ' })
  assert.ok(!blank.includes('msg='))
  assert.ok(!blank.includes('title='))
})

// -----------------------------------------------------------------------------
// 3. Whole-report refusal
// -----------------------------------------------------------------------------
console.log('whole-report refusal')

check('kind is refused outside blocked', () => {
  assert.equal(programStatus({ state: 'working', app: 'dsh-tui', kind: 'auth' }), '')
  assert.equal(programStatus({ state: 'done', app: 'dsh-tui', kind: 'permission' }), '')
})

check('progress is refused outside working/blocked and out of range', () => {
  assert.equal(programStatus({ state: 'done', app: 'dsh-tui', progress: 100 }), '')
  assert.equal(programStatus({ state: 'working', app: 'dsh-tui', progress: -1 }), '')
  assert.equal(programStatus({ state: 'working', app: 'dsh-tui', progress: 101 }), '')
  assert.equal(programStatus({ state: 'working', app: 'dsh-tui', progress: 1.5 }), '')
  assert.notEqual(programStatus({ state: 'working', app: 'dsh-tui', progress: 0 }), '')
  assert.notEqual(programStatus({ state: 'working', app: 'dsh-tui', progress: 100 }), '')
})

check('malformed app and id are refused', () => {
  assert.equal(programStatus({ state: 'working', app: 'a b' }), '')
  assert.equal(programStatus({ state: 'working', app: 'a/b' }), '')
  assert.equal(programStatus({ state: 'working', app: 'x'.repeat(33) }), '')
  assert.equal(programStatus({ state: 'working', id: 'a b' }), '')
  assert.equal(programStatus({ state: 'working', id: '/lead' }), '')
  assert.equal(programStatus({ state: 'working', id: 'x'.repeat(129) }), '')
})

check('valid hierarchical id is accepted', () => {
  assert.equal(
    programStatus({ state: 'working', id: 'build/test', app: 'dsh-tui' }),
    `${PREFIX}state=working:id=build/test:app=dsh-tui${ESC}\\`,
  )
})

check('even a maximal report stays inside the sequence cap', () => {
  // Every field is bounded, so no legal report can exceed 4096 bytes: the
  // largest possible body is the capped msg + title + app + state.
  const maximal = programStatus({
    state: 'working',
    id: 'a'.repeat(32),
    app: 'dsh-tui',
    title: 'y'.repeat(500),
    msg: 'z'.repeat(5000),
  })
  assert.ok(maximal !== '', 'a maximal legal report must encode')
  assert.ok(Buffer.byteLength(maximal, 'utf8') <= 4096, 'legal report exceeded the cap')
})

// -----------------------------------------------------------------------------
// 4. clear
// -----------------------------------------------------------------------------
console.log('clear')

check('clear without id removes every record', () => {
  assert.equal(clearProgramStatus(), `${PREFIX}state=clear${ESC}\\`)
})

check('clear with id removes that record and its children', () => {
  assert.equal(clearProgramStatus('us-east'), `${PREFIX}state=clear:id=us-east${ESC}\\`)
  assert.equal(clearProgramStatus('a b'), '')
})

check('state=clear via programStatus matches clearProgramStatus', () => {
  assert.equal(programStatus({ state: 'clear' }), clearProgramStatus())
})

check('a targeted clear keeps its id through programStatus', () => {
  // Dropping the id would widen a targeted clear into "remove every record on
  // the terminal", wiping records other programs own.
  assert.equal(programStatus({ state: 'clear', id: 'build' }), clearProgramStatus('build'))
  assert.equal(programStatus({ state: 'clear', id: 'build' }), `${PREFIX}state=clear:id=build${ESC}\\`)
  assert.notEqual(programStatus({ state: 'clear', id: 'build' }), clearProgramStatus())
})

check('a malformed id on clear is refused, not silently widened', () => {
  assert.equal(programStatus({ state: 'clear', id: 'a b' }), '')
})

// -----------------------------------------------------------------------------
// 5. Enable gate
// -----------------------------------------------------------------------------
console.log('enable gate')

check('on by default for an interactive stdout', () => {
  assert.equal(supportsProgramStatus(true, {}), true)
})

check('never reports without a TTY', () => {
  assert.equal(supportsProgramStatus(false, {}), false)
  assert.equal(supportsProgramStatus(false, { DSH_TUI_PROGRAM_STATUS: '1' }), false)
})

check('opt-out accepts the common falsy spellings', () => {
  for (const value of ['0', 'false', 'FALSE', 'no', 'off']) {
    assert.equal(supportsProgramStatus(true, { DSH_TUI_PROGRAM_STATUS: value }), false, value)
  }
  for (const value of ['1', 'true', 'yes', 'on']) {
    assert.equal(supportsProgramStatus(true, { DSH_TUI_PROGRAM_STATUS: value }), true, value)
  }
  assert.equal(supportsProgramStatus(true, { DSH_TUI_PROGRAM_STATUS: '' }), true)
})

// -----------------------------------------------------------------------------
// 6. Hook end to end
// -----------------------------------------------------------------------------
console.log('hook end to end')

type StatusChannel = {
  working: boolean
  turnOutcome: 'completed' | 'interrupted' | 'error' | undefined
  sessionTitle: string
  sessionId: string
}
type StatusInput = {
  channel: StatusChannel
  blocked: { kind: 'permission' | 'question' | 'auth'; message: string } | null
  enabled: boolean
}

/** A channel snapshot; `over` is what the case under test varies. */
const statusInput = (
  over: Partial<StatusChannel> = {},
  blocked: StatusInput['blocked'] = null,
  enabled = true,
): StatusInput => ({
  channel: { working: false, turnOutcome: undefined, sessionTitle: 'sess', sessionId: 's1', ...over },
  blocked,
  enabled,
})

class FakeStdout extends Writable {
  columns = 80
  rows = 24
  isTTY = true
  output = ''

  _write(chunk: unknown, _encoding: BufferEncoding, callback: () => void): void {
    this.output += String(chunk)
    callback()
  }
}

class FakeStderr extends Writable {
  isTTY = true

  _write(_chunk: unknown, _encoding: BufferEncoding, callback: () => void): void {
    callback()
  }
}

class FakeStdin extends PassThrough {
  isTTY = true
  isRaw = false

  setRawMode(enabled: boolean): this {
    this.isRaw = enabled
    return this
  }
}

/**
 * Mount the hook through a real Ink tree and drive it by re-rendering with a
 * new input (the same path a channel update takes in the app).
 */
function mountHook(initial: StatusInput) {
  const stdout = new FakeStdout()
  const stderr = new FakeStderr()
  const stdin = new FakeStdin()

  function Harness({ input }: { input: StatusInput }): React.ReactElement {
    useProgramStatus(input)
    return React.createElement(Text, null, 'probe')
  }

  const tree = (input: StatusInput): React.ReactElement =>
    React.createElement(
      TerminalWriteProvider,
      { value: (data: string) => { stdout.write(data) } },
      React.createElement(Harness, { input }),
    )

  const instance = renderSync(tree(initial), {
    stdin,
    stdout,
    stderr,
    exitOnCtrlC: false,
    patchConsole: false,
  })

  /** The OSC 7501 payloads this mount wrote, in order. */
  const reports = (): string[] =>
    [...stdout.output.matchAll(/\x1b\]7501;([^\x1b\x07]*)\x1b\\/g)]
      .map(match => match[1]!)
      .filter(part => !part.startsWith('?'))

  return {
    instance,
    set: (next: StatusInput) => { instance.rerender(tree(next)) },
    reports,
    stdout,
  }
}

const flush = async (): Promise<void> => { await new Promise<void>(resolve => setImmediate(resolve)) }

// idle at mount
{
  const { instance, reports } = mountHook(statusInput())
  await flush()
  assert.deepEqual(reports(), ['state=idle:app=dsh-tui:title=c2Vzcw=='])
  console.log('  ok - idle is reported at mount')
  instance.unmount()
}

// precedence and transitions
{
  const { instance, set, reports } = mountHook(statusInput())
  await flush()

  set(statusInput({ working: true }))
  await flush()
  set(statusInput({ working: true }, { kind: 'permission', message: 'Approval needed: Bash' }))
  await flush()
  // A parked prompt outranks the running turn it interrupted.
  assert.deepEqual(reports().slice(1), [
    'state=working:app=dsh-tui:title=c2Vzcw==',
    'state=blocked:kind=permission:app=dsh-tui:title=c2Vzcw==:msg=QXBwcm92YWwgbmVlZGVkOiBCYXNo',
  ])
  console.log('  ok - blocked outranks working')

  set(statusInput({ working: true }))
  await flush()
  set(statusInput({ turnOutcome: 'completed' }))
  await flush()
  const after = reports()
  assert.equal(after.at(-1), 'state=done:app=dsh-tui:title=c2Vzcw==')
  console.log('  ok - working falling edge reports done')

  set(statusInput({ working: true }))
  await flush()
  set(statusInput({ turnOutcome: 'error' }))
  await flush()
  assert.equal(reports().at(-1), 'state=error:app=dsh-tui:title=c2Vzcw==')
  console.log('  ok - error outcome reports error')

  set(statusInput({ working: true }))
  await flush()
  set(statusInput({ turnOutcome: 'interrupted' }))
  await flush()
  assert.equal(reports().at(-1), 'state=idle:app=dsh-tui:title=c2Vzcw==')
  console.log('  ok - an interrupted turn reports idle, not done')

  instance.unmount()
}

// dedup
{
  const { instance, set, reports } = mountHook(statusInput({ working: true }))
  await flush()
  const before = reports().length
  set(statusInput({ working: true }))
  await flush()
  set(statusInput({ working: true }))
  await flush()
  assert.equal(reports().length, before, 'an unchanged state must not re-report')
  console.log('  ok - unchanged state is deduplicated')
  instance.unmount()
}

// a resumed session's stale outcome must not claim a fresh done
{
  const { instance, reports } = mountHook(statusInput({ turnOutcome: 'completed' }))
  await flush()
  assert.deepEqual(reports(), ['state=idle:app=dsh-tui:title=c2Vzcw=='])
  console.log('  ok - stale outcome at mount reports idle, not done')
  instance.unmount()
}

// switching sessions without remounting must not replay the new session's
// history as a fresh done
{
  const { instance, set, reports } = mountHook(statusInput())
  await flush()

  // A turn ran and finished in session 1: the latch is armed, `done` is right.
  set(statusInput({ working: true }))
  await flush()
  set(statusInput({ turnOutcome: 'completed' }))
  await flush()
  assert.equal(reports().at(-1), 'state=done:app=dsh-tui:title=c2Vzcw==')

  // Switch to session 2: resetSessionProjection clears the projected outcome,
  // then the switch replays that session's own history and re-populates it
  // from its last turn.end. The stale latch would report that as a brand-new
  // `done`.
  set(statusInput({ turnOutcome: 'completed', sessionTitle: 'other', sessionId: 's2' }))
  await flush()
  assert.equal(
    reports().at(-1),
    'state=idle:app=dsh-tui:title=b3RoZXI=',
    'a session switch must not replay the target session history as a fresh done',
  )
  console.log('  ok - a session switch reports idle, not the replayed history as done')

  // The latch is per-session: session 2's own falling edge still reports done.
  set(statusInput({ working: true, sessionTitle: 'other', sessionId: 's2' }))
  await flush()
  set(statusInput({ turnOutcome: 'completed', sessionTitle: 'other', sessionId: 's2' }))
  await flush()
  assert.equal(reports().at(-1), 'state=done:app=dsh-tui:title=b3RoZXI=')
  console.log('  ok - the new session still reports its own done on the falling edge')

  instance.unmount()
}

// The terminal state must be projected from the turn's own close reason, not
// read off the usage ledger. The ledger is only written by a turn that
// measured something, so a usage-less turn would otherwise report idle (first
// turn, nothing to inherit) or inherit the previous turn's `completed` and
// report done.
//
// Each case folds REAL events through the production projector and mounts the
// hook on that projector's own state object, so the whole wire is under test:
// `turn.end.reason` → `channel.turnOutcome` → the OSC 7501 bytes.
{
  const user = (id: string, seq: number, turn: number): readonly AgentEvent[] => [
    { type: 'user.message', id, anchor: id, seq, time: 900 + seq, source: 'user', text: 'hi', blocks: [] },
    { type: 'turn.start', turn, origin: 'user', time: 1000 + seq },
  ]
  const measured = (turn: number, seq: number): readonly AgentEvent[] => [
    { type: 'assistant.attempt.start', attemptId: `a${turn}`, turn, step: 1, model: 'model-x' },
    { type: 'assistant.message', seq, anchor: `a${turn}`, turn, step: 1, attemptId: `a${turn}`, time: 6000, model: 'model-x', blocks: [{ type: 'text', text: 'answer' }], usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0 }, canonical: true },
    { type: 'assistant.attempt.end', attemptId: `a${turn}`, outcome: 'committed' },
  ]

  /** A mount whose channel IS a real projector state. */
  const mountProjection = () => {
    const rig = createProjectorHarness()
    rig.apply([{ type: 'session.title', title: 'sess', source: 'auto' }] as readonly AgentEvent[])
    const { instance, set, reports } = mountHook({ channel: rig.state, blocked: null, enabled: true })
    return {
      rig,
      reports,
      /** Fold events, then re-render: what a channel emit does in the app. */
      fold: async (events: readonly AgentEvent[]): Promise<void> => {
        rig.apply(events)
        set({ channel: rig.state, blocked: null, enabled: true })
        await flush()
      },
      unmount: () => instance.unmount(),
    }
  }

  // First turn fails before producing any usage: nothing to inherit, and the
  // failure still has to reach the terminal.
  const firstFailure = mountProjection()
  await firstFailure.fold(user('u1', 1, 1))
  assert.equal(firstFailure.reports().at(-1), 'state=working:app=dsh-tui:title=c2Vzcw==')
  await firstFailure.fold([{ type: 'turn.end', turn: 1, reason: { kind: 'error', message: 'boom' }, time: 2000 }] as readonly AgentEvent[])
  assert.equal(firstFailure.rig.state.turnUsage, undefined, 'a usage-less turn writes no ledger')
  assert.equal(firstFailure.rig.state.turnOutcome, 'error')
  assert.equal(firstFailure.reports().at(-1), 'state=error:app=dsh-tui:title=c2Vzcw==')
  firstFailure.unmount()
  console.log('  ok - a first usage-less failure reports error')

  // A successful turn, then a usage-less failure: the ledger still says
  // `completed`, which is exactly what must NOT be reported.
  const staleLedger = mountProjection()
  await staleLedger.fold(user('u1', 1, 1))
  await staleLedger.fold([
    ...measured(1, 2),
    { type: 'turn.end', turn: 1, reason: { kind: 'completed' }, time: 7000 },
  ] as readonly AgentEvent[])
  assert.equal(staleLedger.rig.state.turnOutcome, 'completed')
  assert.equal(staleLedger.rig.state.turnUsage?.outcome, 'completed')
  assert.equal(staleLedger.reports().at(-1), 'state=done:app=dsh-tui:title=c2Vzcw==')

  await staleLedger.fold(user('u2', 3, 2))
  assert.equal(staleLedger.reports().at(-1), 'state=working:app=dsh-tui:title=c2Vzcw==')
  await staleLedger.fold([{ type: 'turn.end', turn: 2, reason: { kind: 'error', message: 'late failure' }, time: 8000 }] as readonly AgentEvent[])
  assert.equal(staleLedger.rig.state.turnOutcome, 'error')
  assert.equal(
    staleLedger.rig.state.turnUsage?.outcome,
    'completed',
    'the previous turn keeps its ledger: that stale outcome is what the projection field exists to avoid',
  )
  assert.equal(staleLedger.reports().at(-1), 'state=error:app=dsh-tui:title=c2Vzcw==')
  console.log('  ok - a usage-less failure after a completed turn reports error, not the stale done')

  // Same shape, cancelled instead of failed: the spec wants idle.
  await staleLedger.fold(user('u3', 4, 3))
  await staleLedger.fold([{ type: 'turn.end', turn: 3, reason: { kind: 'aborted' }, time: 9000 }] as readonly AgentEvent[])
  assert.equal(staleLedger.rig.state.turnOutcome, 'interrupted')
  assert.equal(staleLedger.rig.state.turnUsage?.outcome, 'completed')
  assert.equal(staleLedger.reports().at(-1), 'state=idle:app=dsh-tui:title=c2Vzcw==')
  staleLedger.unmount()
  console.log('  ok - a usage-less cancel after a completed turn reports idle')
}

// disabled from the start writes nothing
{
  const { instance, stdout } = mountHook(statusInput({ working: true }, null, false))
  await flush()
  assert.ok(!stdout.output.includes(`${ESC}]7501;`), 'a disabled hook must not write')
  console.log('  ok - disabled reports nothing')
  instance.unmount()
}

// No report may outlive unmount: the protocol has the terminal drop
// working/blocked itself, and done/error must survive for the user.
for (const stdout of instances.keys()) instances.delete(stdout)

console.log(failed === 0 ? '\nall OSC 7501 checks passed' : `\n${failed} check(s) failed`)
process.exit(failed === 0 ? 0 : 1)
