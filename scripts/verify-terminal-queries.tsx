/**
 * Delayed terminal-query replies must stay in raw mode and never become
 * visible shell input. Covers concurrent OSC 11 and XTVERSION batches.
 *
 * Also covers the DECRQM probe gate: macOS Terminal.app prints the trailing
 * `p` of `CSI ? 1049 $ p` as literal text, so the alt-screen health probe
 * must be skipped there and kept everywhere else.
 *
 * The tail half of the file pins the reply-claim gate: a post-flush reply
 * tail is only held/claimed while a query of the matching expected response
 * type is genuinely in flight, the shape can still complete into it, and the
 * bounded 1s window is open. That includes the pre-merge gap where the tail
 * after the ESC flush is itself split again, the type-mismatch control, and
 * the removed lastSentAt recency fallback driven through a real querier.
 */
import assert from 'node:assert/strict'
import { PassThrough, Writable } from 'node:stream'
import React, { useEffect } from 'react'
import { AlternateScreen, render, renderSync, Text, useInput, useStdin } from '../src/ui.js'
import instances from '../src/ink/instances.js'
import {
  INITIAL_STATE,
  parseMultipleKeypresses,
  type KeyParseState,
  type ParsedInput,
  type TerminalResponse,
} from '../src/ink/parse-keypress.js'
import { decrqm, oscColor, TerminalQuerier } from '../src/ink/terminal-querier.js'
import { supportsDecrqmProbe } from '../src/ink/terminal.js'
import { settled, sleep } from './lib/term-test.mjs'

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

  override ref(): this {
    return this
  }

  override unref(): this {
    return this
  }
}

const visibleInput: string[] = []
let oscSettled = false

function QueryProbe(): React.ReactNode {
  const { internal_eventEmitter, internal_querier } = useStdin()

  useEffect(() => {
    const onInput = ({ input }: { input: string }) => visibleInput.push(input)
    internal_eventEmitter?.on('input', onInput)
    return () => internal_eventEmitter?.removeListener('input', onInput)
  }, [internal_eventEmitter])

  useEffect(() => {
    if (internal_querier === null) return
    void Promise.all([
      internal_querier.send(oscColor(11)),
      internal_querier.flush(),
    ]).then(() => {
      oscSettled = true
    })
  }, [internal_querier])

  return <Text>terminal query probe</Text>
}

const stdin = new FakeStdin()
const stdout = new FakeStdout()
const instance = await render(<QueryProbe />, {
  stdin,
  stdout,
  stderr: new FakeStderr(),
  exitOnCtrlC: false,
  patchConsole: false,
})

assert.ok(
  await settled(() => stdout.output.includes('\x1b]11;?') && stdout.output.includes('\x1b[>0q')),
  'timed out waiting for the OSC 11 / XTVERSION queries to be written',
)
// 固定窗:探针 raw mode is already true here and must STAY true while the
// replies are late — a settle on the already-true condition would return
// immediately, so the delay window is the measurement.
await sleep(450)
assert.equal(stdin.isRaw, true, 'late terminal replies must remain protected by raw mode')

stdin.write('\x1b]11;rgb:0c0c/0c0c/0c0c\x1b\\\x1b[?61;4c')
assert.ok(await settled(() => oscSettled), 'timed out waiting for the OSC 11 reply to settle')
assert.equal(stdin.isRaw, true, 'the concurrent XTVERSION batch must retain raw mode')

stdin.write('\x1bP>|xterm.js(5.5.0)\x1b\\\x1b[?61;4c')
assert.ok(await settled(() => !stdin.isRaw), 'timed out waiting for raw mode to be released')
assert.deepEqual(visibleInput, [], 'terminal responses must not reach input listeners')

instance.unmount()
console.log('PASS: delayed OSC/XTVERSION replies stay raw and leave no visible residue')

// -- DECRQM probe gate (Terminal.app leaks the trailing `p`) ----------------
//
// Terminal.app does not implement DECRQM and its CSI parser abandons the
// sequence at the `$` intermediate byte, printing `p` at the cursor. The probe
// runs on every interaction dispatch, so an ungated probe spells a visible
// `p` per keypress. TERM=xterm-256color there, so TERM_PROGRAM is the only
// usable marker.
const realTermProgram = process.env.TERM_PROGRAM

// The probe rides on keyboard dispatch, which only runs when the tree
// actually consumes input.
function ProbeKeyConsumer(): React.ReactNode {
  useInput(() => {})
  return <Text>decrqm gate</Text>
}

const suspendedStdout = new FakeStdout()
let rawModeBorrowCount = 0
const suspendedQuerier = new TerminalQuerier(suspendedStdout, enabled => {
  rawModeBorrowCount += enabled ? 1 : -1
})
suspendedQuerier.suspend()
await Promise.all([
  suspendedQuerier.send(oscColor(11)),
  suspendedQuerier.flush(),
])
assert.equal(suspendedStdout.output, '')
assert.equal(rawModeBorrowCount, 0)
suspendedQuerier.resume()
const resumedQuery = suspendedQuerier.send(oscColor(11))
const resumedFlush = suspendedQuerier.flush()
assert.equal(rawModeBorrowCount, 2)
suspendedQuerier.onResponse({ type: 'osc', code: 11, data: 'rgb:0000/0000/0000' })
suspendedQuerier.onResponse({ type: 'da1', params: [61, 4] })
assert.ok(await resumedQuery)
await resumedFlush
assert.equal(rawModeBorrowCount, 0)
suspendedQuerier.dispose()

const handoffStdin = new FakeStdin()
const handoffStdout = new FakeStdout()
const handoffInstance = renderSync(
  <AlternateScreen>
    <ProbeKeyConsumer />
  </AlternateScreen>,
  {
    stdin: handoffStdin,
    stdout: handoffStdout,
    stderr: new FakeStderr(),
    exitOnCtrlC: false,
    patchConsole: false,
  },
)
const handoffInk = instances.get(handoffStdout)
assert.ok(handoffInk)
assert.equal(handoffStdout.output.includes('\x1b[>0q'), false)
handoffInk.enterAlternateScreen()
await new Promise<void>(resolve => setImmediate(resolve))
assert.equal(
  handoffStdout.output.includes('\x1b[>0q') ||
    handoffStdout.output.includes('\x1b[c'),
  false,
  'a deferred XTVERSION batch must not write while an external process owns the terminal',
)
handoffInk.exitAlternateScreen()
// 固定窗:探针 retry 不得在隔离期内发生——20ms 落在 120ms 的
// TERMINAL_REPLY_QUARANTINE_MS 之内，取样点必须早于 resume 定时器。
await sleep(20)
assert.equal(
  handoffStdout.output.includes('\x1b[>0q') ||
    handoffStdout.output.includes('\x1b[c'),
  false,
  'the XTVERSION retry must wait for the reply quarantine',
)
assert.ok(
  await settled(
    () =>
      handoffStdout.output.includes('\x1b[>0q') &&
      handoffStdout.output.includes('\x1b[c'),
  ),
  'the interrupted XTVERSION probe must retry after the reply quarantine',
)
handoffStdin.write('\x1bP>|ghostty(1.2.3)\x1b\\\x1b[?61;4c')
await new Promise<void>(resolve => setImmediate(resolve))
const completedXtversionCount =
  handoffStdout.output.split('\x1b[>0q').length - 1
handoffInk.enterAlternateScreen()
handoffInk.exitAlternateScreen()
// 固定窗:探针 已完成的 XTVERSION 不得重复——160ms 越过 120ms 的
// TERMINAL_REPLY_QUARANTINE_MS，让潜在的重发有时间显形。
await sleep(160)
assert.equal(
  handoffStdout.output.split('\x1b[>0q').length - 1,
  completedXtversionCount,
  'a completed XTVERSION probe must not repeat after later handoffs',
)
handoffInstance.unmount()
console.log('PASS: handoff suspends terminal queries and retries deferred XTVERSION')

process.env.TERM_PROGRAM = 'Apple_Terminal'
assert.equal(
  supportsDecrqmProbe(),
  false,
  'Apple_Terminal must be excluded from DECRQM probes',
)

for (const term of ['iTerm.app', 'ghostty', 'WezTerm', 'vscode']) {
  process.env.TERM_PROGRAM = term
  assert.equal(supportsDecrqmProbe(), true, `${term} must keep the DECRQM probe`)
}

// Unknown/unset terminals keep the spec-conforming probe: this is an
// exclusion of one known-broken terminal, not an allowlist.
delete process.env.TERM_PROGRAM
assert.equal(
  supportsDecrqmProbe(),
  true,
  'an unknown terminal must keep the DECRQM probe',
)

// End-to-end: a keypress must not put `$p` on the wire under Terminal.app.
// Asserted against real stdout bytes over the real trigger path (input
// dispatch calls probeAltScreenHealth) — the leak is a write, not a
// predicate, and this is exactly the user-visible scenario: one stray `p`
// per keystroke, landing at the cursor inside the prompt.
//
// <AlternateScreen> is required: the probe early-returns unless the instance
// is in alt-screen, so an inline tree would pass this assertion vacuously.
async function decrqmProbeBytes(termProgram: string): Promise<string> {
  process.env.TERM_PROGRAM = termProgram
  const probeStdin = new FakeStdin()
  const probeStdout = new FakeStdout()
  const probeInstance = await render(
    <AlternateScreen>
      <ProbeKeyConsumer />
    </AlternateScreen>,
    {
      stdin: probeStdin,
      stdout: probeStdout,
      stderr: new FakeStderr(),
      exitOnCtrlC: false,
      patchConsole: false,
    },
  )
  await settled(() => probeStdout.output.includes('\x1b[?1049h'))
  const beforeKeypress = probeStdout.output.length
  probeStdin.write('a')
  probeStdin.write('\x7f')
  // 固定窗:探针 negative assertion — the leak (if any) is written
  // asynchronously after dispatch, so the slice must span an observation
  // window rather than settle on an already-true condition.
  await sleep(120)
  const emitted = probeStdout.output.slice(beforeKeypress)
  probeInstance.unmount()
  return emitted
}

assert.equal(
  (await decrqmProbeBytes('Apple_Terminal')).includes('$p'),
  false,
  'Terminal.app must never receive a DECRQM probe (leaks a visible `p`)',
)

// Guard the guard: the same path on a conforming terminal must still probe,
// otherwise this assertion pair would also pass with the probe deleted
// outright (losing the alt-screen self-heal).
assert.equal(
  (await decrqmProbeBytes('iTerm.app')).includes('\x1b[?1049$p'),
  true,
  'conforming terminals must keep the alt-screen DECRQM probe',
)

// -- Late reply tails: host evidence × reply type × 1s window (AC-1..AC-5) --
//
// Windows ConPTY can split a DA1 reply across a timeout boundary: the ESC
// is flushed as a standalone key, and the remaining `[?61;...c` text must
// still be claimed as the terminal response rather than leaking into the
// prompt. A claim needs ALL THREE of a query genuinely in flight, an
// expected response type its shape can still complete into, and the bounded
// window (parse-keypress.ts). The evidence is read-only and absent means
// false, so these direct-driver cases inject it.
const DA1_TAIL = '[?61;4;6;7;14;21;22;23;24;28;32;42;52c'
const DA1_REPLY = `\x1b${DA1_TAIL}`
// Split point used by AC-4/AC-5: the reply cut after `ESC[?61;4;6`.
const DA1_SPLIT = 9
const withEvidence = (
  types: ReadonlyArray<TerminalResponse['type']>,
): KeyParseState => ({
  ...INITIAL_STATE,
  terminalExpectedResponseTypes: types,
})
const inFlight = withEvidence(['da1'])
/** Compact one-line summary for the claim-gate regressions. */
const summarizeInput = (parsed: ParsedInput[]): string[] =>
  parsed.map(item =>
    item.kind === 'key'
      ? `key:${item.sequence ?? ''}`
      : item.kind === 'response'
        ? `response:${item.response.type}`
        : `mouse:${item.button}`,
  )

// AC-1 · a lone ESC is flushed first and the DA1 tail arrives inside the window.
{
  let state = inFlight
  let parsed
  ;[parsed, state] = parseMultipleKeypresses(state, '\x1b')
  assert.deepEqual(parsed, [], 'AC-1: the leading ESC should stay pending until the flush')
  ;[parsed, state] = parseMultipleKeypresses(state, null)
  assert.equal(parsed[0]?.kind, 'key', 'AC-1: the timeout flush should release a lone Escape key')
  ;[parsed] = parseMultipleKeypresses(state, DA1_TAIL)
  assert.equal(parsed.length, 1, 'AC-1: the late DA1 tail should stay a single parsed item')
  assert.equal(parsed[0]?.kind, 'response', 'AC-1: the late DA1 tail must stay a terminal response')
  assert.equal(parsed[0]?.response.type, 'da1', 'AC-1: the DA1 tail must not leak as input text')
}

// AC-1b · that re-attach window is bounded by TIME, not by "the next call":
// a burst can interleave a chunk between the lone-ESC flush and the tail
// (another reply for a query sent in the same batch, or a keystroke, or the
// record hold above letting go). The real-ConPTY dry run leaked the tail when
// that interleaved chunk closed the window a call early.
{
  let state = inFlight
  let parsed
  ;[parsed, state] = parseMultipleKeypresses(state, '\x1b')
  ;[parsed, state] = parseMultipleKeypresses(state, null)
  assert.equal(parsed[0]?.kind, 'key', 'AC-1b: the flush should release the lone Escape')
  ;[parsed, state] = parseMultipleKeypresses(state, '\x1b[?1;2c')
  assert.equal(parsed[0]?.kind, 'response', 'AC-1b: the interleaved reply is claimed on its own')
  ;[parsed] = parseMultipleKeypresses(state, DA1_TAIL)
  assert.equal(parsed[0]?.kind, 'response', 'AC-1b: an interleaved chunk must not close the window')
  assert.equal(parsed[0]?.response.type, 'da1', 'AC-1b: the late DA1 tail is still the reply')
  // Same bytes with no query in flight stay literal: the window is evidence-gated.
  let bare = INITIAL_STATE
  ;[parsed, bare] = parseMultipleKeypresses(bare, '\x1b')
  ;[parsed, bare] = parseMultipleKeypresses(bare, null)
  ;[parsed, bare] = parseMultipleKeypresses(bare, '\x1b[?1;2c')
  ;[parsed] = parseMultipleKeypresses(bare, DA1_TAIL)
  assert.equal(parsed[0]?.kind, 'key', 'AC-1b: without evidence the window never opens')
  assert.equal(parsed[0]?.sequence, DA1_TAIL, 'AC-1b: the unevidenced tail reaches the body')
}

// AC-2 · every reply-specific split position survives 0..2 quiet flushes and
// still yields exactly one da1 response with no text leak. Cuts start after
// the `ESC[?` introducer: the bare `ESC[` prefix is deliberately outside the
// shape gate (holding it swallowed literal `ESC[`+letter input, #1073 review),
// so a flush exactly on that byte cannot be claimed by the T03 design.
{
  const feed = (chunks: Array<string | null>): ParsedInput[] => {
    let state = inFlight
    const out: ParsedInput[] = []
    for (const chunk of chunks) {
      const [parsed, next] = parseMultipleKeypresses(state, chunk)
      out.push(...parsed)
      state = next
    }
    return out
  }
  const checkDa1 = (chunks: Array<string | null>, label: string): void => {
    const parsed = feed(chunks)
    assert.equal(parsed.length, 1, `${label}: the split reply must yield exactly one item`)
    assert.equal(parsed[0]?.kind, 'response', `${label}: the reply must not leak into the body`)
    assert.equal(parsed[0]?.response.type, 'da1', `${label}: the reply must be claimed as da1`)
  }
  checkDa1([DA1_REPLY], 'AC-2 (0 flushes)')
  for (let cut = 3; cut < DA1_REPLY.length; cut++) {
    checkDa1([DA1_REPLY.slice(0, cut), null, DA1_REPLY.slice(cut)], `AC-2 (1 flush at ${cut})`)
  }
  for (let first = 3; first < DA1_REPLY.length - 1; first++) {
    for (let second = first + 1; second < DA1_REPLY.length; second++) {
      checkDa1(
        [
          DA1_REPLY.slice(0, first),
          null,
          DA1_REPLY.slice(first, second),
          null,
          DA1_REPLY.slice(second),
        ],
        `AC-2 (2 flushes at ${first},${second})`,
      )
    }
  }
}

// AC-3 · the control that got #796 rejected: without in-flight evidence the
// same bytes stay literal, both as a whole block and after a lone-ESC flush.
for (const [label, seeded] of [
  ['absent', INITIAL_STATE],
  ['empty', withEvidence([])],
] as const) {
  const [whole] = parseMultipleKeypresses(seeded, DA1_TAIL)
  assert.equal(whole.length, 1, `AC-3 (${label}): the literal DA1 tail should stay one key`)
  assert.equal(whole[0]?.kind, 'key', `AC-3 (${label}): the literal tail must not be a response`)
  assert.equal(
    whole[0]?.sequence,
    DA1_TAIL,
    `AC-3 (${label}): the literal tail must reach the body`,
  )

  let state = seeded
  let parsed
  ;[parsed, state] = parseMultipleKeypresses(state, '\x1b')
  assert.deepEqual(parsed, [], `AC-3 (${label}): the leading ESC should stay pending`)
  ;[parsed, state] = parseMultipleKeypresses(state, null)
  assert.equal(parsed[0]?.kind, 'key', `AC-3 (${label}): the lone ESC flush should stay a key`)
  ;[parsed] = parseMultipleKeypresses(state, DA1_TAIL)
  assert.equal(parsed.length, 1, `AC-3 (${label}): the post-ESC tail should stay one key`)
  assert.equal(parsed[0]?.kind, 'key', `AC-3 (${label}): the post-ESC tail must stay literal`)
  assert.equal(
    parsed[0]?.sequence,
    DA1_TAIL,
    `AC-3 (${label}): the post-ESC tail must reach the body`,
  )
}

// AC-4 · the 1s window against a controlled clock: once the window start is
// pushed past 1000ms, neither the re-attach nor the hold path claims again
// (same Date.now fixture as verify-win32-input.tsx).
{
  const originalNow = Date.now
  let now = 1_000_000
  Date.now = () => now
  try {
    let state = inFlight
    let parsed
    ;[, state] = parseMultipleKeypresses(state, '\x1b')
    ;[parsed, state] = parseMultipleKeypresses(state, null)
    assert.equal(parsed[0]?.kind, 'key', 'AC-4: the flush should arm the re-attach window')
    now += 1_500
    ;[parsed] = parseMultipleKeypresses(state, DA1_TAIL)
    assert.equal(parsed[0]?.kind, 'key', 'AC-4: an expired re-attach window must stay literal')
    assert.equal(parsed[0]?.sequence, DA1_TAIL, 'AC-4: the expired tail must stay literal text')

    now += 10_000
    state = inFlight
    ;[parsed, state] = parseMultipleKeypresses(state, DA1_REPLY.slice(0, DA1_SPLIT))
    assert.deepEqual(parsed, [], 'AC-4: the reply prefix should stay pending before the flush')
    ;[parsed, state] = parseMultipleKeypresses(state, null)
    assert.deepEqual(parsed, [], 'AC-4: the flush inside the window should hold the reply prefix')
    now += 1_500
    ;[parsed] = parseMultipleKeypresses(state, DA1_REPLY.slice(DA1_SPLIT))
    assert.equal(parsed[0]?.kind, 'key', 'AC-4: an expired hold must not claim the continuation')
    assert.equal(
      parsed[0]?.sequence,
      DA1_REPLY.slice(DA1_SPLIT),
      'AC-4: the released tail must reach the body',
    )
  } finally {
    Date.now = originalNow
  }
}

// AC-5 · the reply shapes parseTerminalResponse() knows, each split across a
// flush while evidence for its own type is injected, must claim that type.
{
  const shapes: Array<[string, string, number, TerminalResponse['type']]> = [
    ['DA1', DA1_REPLY, DA1_SPLIT, 'da1'],
    ['DA2', '\x1b[>0;276;0c', 4, 'da2'],
    ['DSR (DECXCPR)', '\x1b[?3;1R', 4, 'cursorPosition'],
    ['DECRPM', '\x1b[?25;1$y', 5, 'decrpm'],
    ['XTVERSION', '\x1bP>|xterm.js(5.5.0)\x1b\\', 8, 'xtversion'],
    ['kitty flags', '\x1b[?1u', 3, 'kittyKeyboard'],
    ['pixel size', '\x1b[4;600;800t', 5, 'terminalPixelSize'],
  ]
  for (const [name, sequence, cut, type] of shapes) {
    let state = withEvidence([type])
    let parsed
    ;[parsed, state] = parseMultipleKeypresses(state, sequence.slice(0, cut))
    assert.deepEqual(parsed, [], `AC-5 ${name}: the leading fragment must stay pending`)
    ;[parsed, state] = parseMultipleKeypresses(state, null)
    assert.deepEqual(parsed, [], `AC-5 ${name}: the flush must hold the reply prefix`)
    ;[parsed] = parseMultipleKeypresses(state, sequence.slice(cut))
    assert.equal(parsed.length, 1, `AC-5 ${name}: the completed reply must stay a single item`)
    assert.equal(parsed[0]?.kind, 'response', `AC-5 ${name}: the reply must not leak as input text`)
    assert.equal(parsed[0]?.response.type, type, `AC-5 ${name}: expected a ${type} response`)
  }
}

// ① · CodeRabbit #1177 pre-merge gap: the tail after the ESC flush is
// ITSELF split again (`[?61;4;6` → `;14;21;22c`). The re-attach window must
// reassemble it across calls; neither fragment may reach the draft.
{
  let state = inFlight
  let parsed
  ;[parsed, state] = parseMultipleKeypresses(state, '\x1b')
  assert.deepEqual(parsed, [], '① the leading ESC should stay pending until the flush')
  ;[parsed, state] = parseMultipleKeypresses(state, null)
  assert.equal(parsed[0]?.kind, 'key', '① the timeout flush should release a lone Escape key')
  ;[parsed, state] = parseMultipleKeypresses(state, '[?61;4;6')
  assert.deepEqual(
    parsed,
    [],
    '① the first tail fragment must not reach the body',
  )
  assert.equal(
    state.terminalResponseReattachTail,
    '[?61;4;6',
    '① the first tail fragment must be held for its continuation',
  )
  ;[parsed, state] = parseMultipleKeypresses(state, ';14;21;22c')
  assert.deepEqual(
    summarizeInput(parsed),
    ['response:da1'],
    '① the rejoined tail must be claimed as one DA1 response, not literal text',
  )
  assert.equal(
    parsed[0]?.kind === 'response' ? parsed[0].sequence : undefined,
    '\x1b[?61;4;6;14;21;22c',
    '① the claimed sequence must be the full reassembled reply',
  )
  assert.equal(
    state.terminalResponseReattachTail,
    undefined,
    '① the hold must clear once the reply completes',
  )
}

// ①b · the completion can share a chunk with trailing input: the reply is
// claimed and the suffix stays ordinary text (SGR-tail streaming parity).
{
  let state = inFlight
  let parsed
  ;[parsed, state] = parseMultipleKeypresses(state, '\x1b')
  ;[parsed, state] = parseMultipleKeypresses(state, null)
  ;[parsed, state] = parseMultipleKeypresses(state, '[?61;4')
  assert.deepEqual(parsed, [], '①b the first fragment must be held')
  ;[parsed] = parseMultipleKeypresses(state, ';6;14;21;22cXY')
  assert.deepEqual(
    summarizeInput(parsed),
    ['response:da1', 'key:XY'],
    '①b the completed reply must be claimed and the suffix kept literal',
  )
}

// ② · a mismatched expected type never claims: with only a DECRPM query in
// flight, a DA1-shaped tail stays literal — both when it is reassembled from
// two fragments and when it arrives whole. A claim is bound to the query
// lifecycle AND the expected response type, not to "a query was sent".
for (const label of ['split', 'whole'] as const) {
  let state = withEvidence(['decrpm'])
  let parsed
  ;[parsed, state] = parseMultipleKeypresses(state, '\x1b')
  assert.deepEqual(parsed, [], `② (${label}) the leading ESC should stay pending`)
  ;[parsed, state] = parseMultipleKeypresses(state, null)
  assert.equal(parsed[0]?.kind, 'key', `② (${label}) the flush should release the Escape`)
  const out: ParsedInput[] = []
  for (const chunk of label === 'split'
    ? ['[?61;4;6', ';14;21;22c']
    : [DA1_TAIL]) {
    const [chunkParsed, next] = parseMultipleKeypresses(state, chunk)
    out.push(...chunkParsed)
    state = next
  }
  assert.deepEqual(
    out.map(item => (item.kind === 'key' ? item.sequence : item.kind)),
    label === 'split'
      ? ['[?61;4;6', ';14;21;22c']
      : [DA1_TAIL],
    `② (${label}) the DA1 tail must stay literal while only DECRPM is expected`,
  )
  assert.equal(
    state.terminalResponseReattachTail,
    undefined,
    `② (${label}) no fragment may survive a type mismatch`,
  )
}

// ②b · the same gate still claims the shape it IS waiting for: a DECRPM tail
// split across the flush is reassembled into the expected response.
{
  let state = withEvidence(['decrpm'])
  let parsed
  ;[parsed, state] = parseMultipleKeypresses(state, '\x1b')
  ;[parsed, state] = parseMultipleKeypresses(state, null)
  ;[parsed, state] = parseMultipleKeypresses(state, '[?25;1')
  assert.deepEqual(parsed, [], '②b the DECRPM prefix must be held')
  ;[parsed] = parseMultipleKeypresses(state, '$y')
  assert.deepEqual(
    summarizeInput(parsed),
    ['response:decrpm'],
    '②b the expected DECRPM reply must be claimed',
  )
}

// ③ · the removed `lastSentAt ≤ 1s` fallback: evidence is the live query
// lifecycle. While a real querier query is awaiting its reply the host
// injects its type; once the flush sentinel drains it (queue empty) the same
// bytes that would have been claimed inside the old recency window must stay
// literal — being sent recently no longer authorizes anything.
{
  const lifecycleStdout = new FakeStdout()
  const lifecycle = new TerminalQuerier(lifecycleStdout)
  const pendingDecrpm = lifecycle.send(decrqm(2026))
  void lifecycle.flush()
  assert.deepEqual(
    [...lifecycle.pendingResponseTypes].sort(),
    ['da1', 'decrpm'],
    '③ an open query plus its flush sentinel must inject decrpm and da1',
  )
  assert.equal(lifecycle.hasPending, true, '③ the queue must still hold both entries')

  lifecycle.onResponse({ type: 'da1', params: [61, 4] })
  assert.equal(await pendingDecrpm, undefined, '③ the sentinel must drain the unanswered query')
  assert.equal(lifecycle.hasPending, false, '③ the queue must be empty after the sentinel')
  assert.equal(
    lifecycle.pendingResponseTypes.size,
    0,
    '③ a settled query must stop counting as evidence',
  )

  let state: KeyParseState = {
    ...INITIAL_STATE,
    terminalExpectedResponseTypes: [...lifecycle.pendingResponseTypes],
  }
  let parsed
  ;[parsed, state] = parseMultipleKeypresses(state, '\x1b')
  ;[parsed, state] = parseMultipleKeypresses(state, null)
  ;[parsed] = parseMultipleKeypresses(state, DA1_TAIL)
  assert.deepEqual(
    summarizeInput(parsed),
    [`key:${DA1_TAIL}`],
    '③ a tail after the query settled must stay literal (no time-window fallback)',
  )
  lifecycle.dispose()
}

// ④ · end-to-end through the real querier: with only a DECRPM query in
// flight the DA1 tail stays literal (mismatched type), while a pending
// flush() sentinel — whose reply IS this DA1 tail — still claims it.
{
  const mismatchQuerier = new TerminalQuerier(new FakeStdout())
  void mismatchQuerier.send(decrqm(2026))
  assert.deepEqual(
    [...mismatchQuerier.pendingResponseTypes],
    ['decrpm'],
    '④ an unanswered DECRPM query must inject only decrpm',
  )
  let state: KeyParseState = {
    ...INITIAL_STATE,
    terminalExpectedResponseTypes: [...mismatchQuerier.pendingResponseTypes],
  }
  let parsed
  ;[parsed, state] = parseMultipleKeypresses(state, '\x1b')
  ;[parsed, state] = parseMultipleKeypresses(state, null)
  ;[parsed] = parseMultipleKeypresses(state, DA1_TAIL)
  assert.deepEqual(
    summarizeInput(parsed),
    [`key:${DA1_TAIL}`],
    '④ a DA1 tail must stay literal while only DECRPM is expected',
  )
  mismatchQuerier.dispose()

  const sentinelQuerier = new TerminalQuerier(new FakeStdout())
  const sentinelDone = sentinelQuerier.flush()
  assert.deepEqual(
    [...sentinelQuerier.pendingResponseTypes],
    ['da1'],
    '④ a flush sentinel must inject the DA1 expectation it resolves on',
  )
  state = {
    ...INITIAL_STATE,
    terminalExpectedResponseTypes: [...sentinelQuerier.pendingResponseTypes],
  }
  ;[parsed, state] = parseMultipleKeypresses(state, '\x1b')
  ;[parsed, state] = parseMultipleKeypresses(state, null)
  ;[parsed] = parseMultipleKeypresses(state, DA1_TAIL)
  assert.deepEqual(
    summarizeInput(parsed),
    ['response:da1'],
    '④ a split sentinel DA1 reply must still be claimed',
  )
  sentinelQuerier.dispose()
  await sentinelDone
}

// ⑤ · CodeRabbit #1177 (hotfix): a hold whose query settles BEFORE its flush.
// App re-injects terminalExpectedResponseTypes on every call, so a settled
// query drops the evidence while the tokenizer still buffers the reply
// prefix. deferFlush then becomes false, and the old path
// (tokenizer.flush() -> parseKeypress()) dispatched the protocol prefix as a
// key/literal text. The flush must drop those bytes instead — the same
// caliber as the expiry path, and never anywhere near the body.
{
  let state = inFlight
  let parsed
  ;[parsed, state] = parseMultipleKeypresses(state, DA1_REPLY.slice(0, DA1_SPLIT))
  assert.deepEqual(parsed, [], '⑤ the reply prefix must stay buffered before the flush')
  ;[parsed, state] = parseMultipleKeypresses(state, null)
  assert.deepEqual(parsed, [], '⑤ the evidenced flush must hold the reply prefix')
  assert.notEqual(
    state.terminalResponseHoldAt,
    undefined,
    '⑤ the hold must record its first-capture deadline',
  )

  // The query settles (App re-injects the now-empty pending set) and the
  // re-armed flush timer fires with no claim left.
  ;[parsed, state] = parseMultipleKeypresses(
    { ...state, terminalExpectedResponseTypes: [] },
    null,
  )
  assert.deepEqual(
    parsed,
    [],
    '⑤ a hold that lost its query evidence must not dispatch the protocol prefix as keys',
  )
  assert.equal(state.incomplete, '', '⑤ the dropped prefix must leave nothing to re-arm on')
  assert.equal(
    state.terminalResponseHoldAt,
    undefined,
    '⑤ the dropped hold must clear its deadline',
  )
}

// ⑤b · control: the drop is gated on the reply shape. Bytes that never were a
// reply prefix (the bare `ESC[` introducer, deliberately outside the shape
// gate per the #1073 review) keep the pre-existing flush semantics even after
// the evidence disappears — the fix must not swallow ordinary input.
{
  let state = withEvidence(['da1'])
  let parsed
  ;[parsed, state] = parseMultipleKeypresses(state, '\x1b[')
  assert.deepEqual(parsed, [], '⑤b the bare introducer must stay buffered before the flush')
  assert.equal(
    state.terminalResponseHoldAt,
    undefined,
    '⑤b a non-reply shape must never open a hold',
  )
  ;[parsed] = parseMultipleKeypresses(
    { ...state, terminalExpectedResponseTypes: [] },
    null,
  )
  assert.equal(parsed.length, 1, '⑤b a non-reply-shaped buffer must still flush')
  assert.equal(parsed[0]?.kind, 'key', '⑤b the flushed fragment must stay an ordinary key')
  assert.equal(parsed[0]?.sequence, '\x1b[', '⑤b the fragment must reach the body unchanged')
}

// ⑤c · control: a reply-shaped buffer that never captured a hold (no evidence
// from the start) keeps the pre-gate literal release. Absent/empty evidence
// means "never claimed", so the release branch must stay bound to a captured
// hold timestamp instead of dropping every reply-shaped flush blindly.
{
  let state = withEvidence([])
  let parsed
  ;[parsed, state] = parseMultipleKeypresses(state, DA1_REPLY.slice(0, DA1_SPLIT))
  assert.deepEqual(parsed, [], '⑤c an evidence-less prefix must stay buffered until the flush')
  assert.equal(
    state.terminalResponseHoldAt,
    undefined,
    '⑤c no hold may be captured without evidence',
  )
  ;[parsed] = parseMultipleKeypresses(state, null)
  assert.equal(parsed.length, 1, '⑤c the unheld prefix must still flush')
  assert.equal(parsed[0]?.kind, 'key', '⑤c the unheld prefix must stay literal')
  assert.equal(
    parsed[0]?.sequence,
    DA1_REPLY.slice(0, DA1_SPLIT),
    '⑤c the unheld prefix must reach the body unchanged',
  )
}

console.log('PASS: late DA1 tails stay in the terminal-response lane')

if (realTermProgram === undefined) delete process.env.TERM_PROGRAM
else process.env.TERM_PROGRAM = realTermProgram

console.log('PASS: DECRQM probe is gated off for Apple_Terminal and kept elsewhere')
