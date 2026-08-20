/**
 * Shutdown-detach regression: graceful TUI exit bypasses Ink's full unmount
 * path to keep late React cleanup from rewriting the main screen. It must
 * still release the process-level stderr/console patches: `/update` reports
 * a failed update only after the detach has happened.
 */
import React from 'react'
import { PassThrough } from 'node:stream'
import { render, Text, useInput } from '../src/ui.js'
import instances from '../src/ink/instances.js'

let failures = 0
const results: string[] = []
const check = (name: string, ok: boolean) => {
  results.push(`${ok ? 'PASS' : 'FAIL'}: ${name}`)
  if (!ok) failures++
}

const originalStderrWrite = process.stderr.write
const originalConsoleLog = console.log
const stdout = new PassThrough() as unknown as NodeJS.WriteStream
Object.assign(stdout, {isTTY: true, columns: 80, rows: 24})

class FakeStdin extends PassThrough {
  isTTY = true
  isRaw = false

  setRawMode(value: boolean): this {
    this.isRaw = value
    return this
  }

  ref(): this { return this }
  unref(): this { return this }
}

const stdin = new FakeStdin()
let receivedInput = ''
function InputProbe(): React.ReactNode {
  useInput(input => { receivedInput += input })
  return React.createElement(Text, null, 'shutdown regression')
}

const instance = await render(React.createElement(InputProbe), {
  stdout,
  stdin: stdin as unknown as NodeJS.ReadStream,
  exitOnCtrlC: false,
  patchConsole: true,
})

const patchedStderrWrite = process.stderr.write
check('Ink installs the stderr guard while the TUI is mounted', patchedStderrWrite !== originalStderrWrite)

const sigcontListenersBefore = process.listenerCount('SIGCONT')
const resizeListenersBefore = stdout.listenerCount('resize')
const stdinListenersBefore = stdin.listenerCount('readable')
const activeEio = Object.assign(new Error('read EIO'), {code: 'EIO'})
let activeEioEscaped = false
try {
  stdin.emit('error', activeEio)
} catch (error) {
  activeEioEscaped = error === activeEio
}
check('Ink does not absorb stdin EIO while the TUI is active', activeEioEscaped)

const runtime = instances.get(stdout)
runtime?.detachForShutdown()

check('shutdown detach restores process.stderr.write before post-exit work', process.stderr.write === originalStderrWrite)
check('shutdown detach restores console output before post-exit work', console.log === originalConsoleLog)
check('shutdown detach removes the SIGCONT listener', process.listenerCount('SIGCONT') < sigcontListenersBefore)
check('shutdown detach removes the stdout resize listener', stdout.listenerCount('resize') < resizeListenersBefore)
check('Ink owns a stdin reader before shutdown detach', stdinListenersBefore > 0)
check('shutdown detach removes the stdin reader', stdin.listenerCount('readable') < stdinListenersBefore)

const lateEio = Object.assign(new Error('read EIO'), {
  code: 'EIO',
  errno: -5,
  syscall: 'read',
})
let lateEioEscaped = false
try {
  stdin.emit('error', lateEio)
} catch (error) {
  lateEioEscaped = error === lateEio
}
check('shutdown detach absorbs a late stdin EIO', !lateEioEscaped)

const unexpectedStdinError = Object.assign(new Error('read EPERM'), {code: 'EPERM'})
let unexpectedErrorEscaped = false
try {
  stdin.emit('error', unexpectedStdinError)
} catch (error) {
  unexpectedErrorEscaped = error === unexpectedStdinError
}
check('shutdown detach does not absorb unexpected stdin errors', unexpectedErrorEscaped)

stdin.write('x')
await new Promise(resolve => setImmediate(resolve))
check('detached Ink does not consume input meant for the replacement process', receivedInput === '')

// detach intentionally makes unmount a no-op. Remove the test-only map entry
// without attempting a second terminal cleanup.
instance.cleanup()

console.log(results.join('\n'))
if (failures > 0) process.exit(1)
