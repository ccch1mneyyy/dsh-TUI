/**
 * Delayed terminal-query replies must stay in raw mode and never become
 * visible shell input. Covers concurrent OSC 11 and XTVERSION batches.
 */
import assert from 'node:assert/strict'
import { PassThrough, Writable } from 'node:stream'
import React, { useEffect } from 'react'
import { render, Text, useStdin } from '../src/ui.js'
import { oscColor } from '../src/ink/terminal-querier.js'

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
