/**
 * Delayed terminal-query replies must stay in raw mode and never become
 * visible shell input. Covers concurrent OSC 11 and XTVERSION batches.
 *
 * Also covers the DECRQM probe gate: macOS Terminal.app prints the trailing
 * `p` of `CSI ? 1049 $ p` as literal text, so the alt-screen health probe
 * must be skipped there and kept everywhere else.
 */
import assert from 'node:assert/strict'
import { PassThrough, Writable } from 'node:stream'
import React, { useEffect } from 'react'
import { AlternateScreen, render, Text, useInput, useStdin } from '../src/ui.js'
import { oscColor } from '../src/ink/terminal-querier.js'
import { supportsDecrqmProbe } from '../src/ink/terminal.js'

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

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
async function waitFor(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return
    await sleep(10)
  }
  assert.fail('timed out waiting for terminal-query state')
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

await waitFor(() => stdout.output.includes('\x1b]11;?') && stdout.output.includes('\x1b[>0q'))
// Stability probe (must NOT change): raw mode is already true here and must
// stay true while the replies are late — a settle on the already-true
// condition would return immediately, so keep a fixed delay window.
await sleep(450)
assert.equal(stdin.isRaw, true, 'late terminal replies must remain protected by raw mode')

stdin.write('\x1b]11;rgb:0c0c/0c0c/0c0c\x1b\\\x1b[?61;4c')
await waitFor(() => oscSettled)
assert.equal(stdin.isRaw, true, 'the concurrent XTVERSION batch must retain raw mode')

stdin.write('\x1bP>|xterm.js(5.5.0)\x1b\\\x1b[?61;4c')
await waitFor(() => !stdin.isRaw)
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
  await waitFor(() => probeStdout.output.includes('\x1b[?1049h'))
  const beforeKeypress = probeStdout.output.length
  probeStdin.write('a')
  probeStdin.write('\x7f')
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

if (realTermProgram === undefined) delete process.env.TERM_PROGRAM
else process.env.TERM_PROGRAM = realTermProgram

console.log('PASS: DECRQM probe is gated off for Apple_Terminal and kept elsewhere')
