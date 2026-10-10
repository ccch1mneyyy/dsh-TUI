/**
 * Shutdown-detach regression: graceful TUI exit releases React effects while
 * terminal cleanup remains owned by finishExit. It must preserve the handoff
 * buffer and release stderr/console patches before post-exit work.
 */
import React from 'react'
import { PassThrough } from 'node:stream'
import { AlternateScreen, render, Text, useInput } from '../src/ui.js'
import instances from '../src/ink/instances.js'
import { EXIT_ALT_SCREEN } from '../src/ink/termio/dec.js'

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
const output: string[] = []
stdout.on('data', chunk => { output.push(String(chunk)) })

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
let effectCleanups = 0
let pendingCallbackRan = false
let mounted: () => void
const ready = new Promise<void>(resolve => { mounted = resolve })
function InputProbe(): React.ReactNode {
  useInput(input => { receivedInput += input })
  React.useEffect(() => {
    const pending = setImmediate(() => { pendingCallbackRan = true })
    mounted()
    return () => {
      effectCleanups += 1
      clearImmediate(pending)
    }
  }, [])
  return React.createElement(Text, null, 'shutdown regression')
}

const instance = await render(React.createElement(AlternateScreen, null, React.createElement(InputProbe)), {
  stdout,
  stdin: stdin as unknown as NodeJS.ReadStream,
  exitOnCtrlC: false,
  patchConsole: true,
})
await ready

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
const outputBeforeDetach = output.length
runtime?.detachForShutdown()

check('shutdown detach synchronously runs React effect cleanup', effectCleanups === 1)
check('shutdown detach keeps the alternate screen for the handoff owner', !output.slice(outputBeforeDetach).join('').includes(EXIT_ALT_SCREEN))
runtime?.detachForShutdown()
instance.unmount()
check('repeated detach and unmount do not repeat React cleanup', effectCleanups === 1)
check('repeated detach and unmount do not exit the alternate screen', !output.slice(outputBeforeDetach).join('').includes(EXIT_ALT_SCREEN))
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
// Stability probe (state must NOT change): receivedInput is already '' and
// must stay '' after the write drains — polling would return immediately,
// so keep the fixed one-tick window.
await new Promise(resolve => setImmediate(resolve))
check('shutdown detach cancels callbacks owned by React effects', !pendingCallbackRan)
check('detached Ink does not consume input meant for the replacement process', receivedInput === '')

// Release the test handle without attempting a second terminal cleanup.
instance.cleanup()

// Error-driven exits can start inside React's commit, where a synchronous
// passive flush is forbidden. The awaited detach must finish before handoff.
let commitCleanups = 0
let commitMounted: () => void
const commitReady = new Promise<void>(resolve => { commitMounted = resolve })
let commitInstance: Awaited<ReturnType<typeof render>>
let commitShutdown: void | Promise<void>
function CommitExitProbe({ exiting }: { exiting: boolean }): React.ReactNode {
  React.useEffect(() => {
    commitMounted()
    return () => { commitCleanups += 1 }
  }, [])
  React.useLayoutEffect(() => {
    if (exiting) commitShutdown = commitInstance.detachForShutdown()
  }, [exiting])
  return React.createElement(Text, null, 'commit exit')
}
const commitTree = (exiting: boolean) => React.createElement(
  AlternateScreen, null, React.createElement(CommitExitProbe, { exiting }),
)
commitInstance = await render(commitTree(false), {
  stdout, stdin: stdin as unknown as NodeJS.ReadStream,
  exitOnCtrlC: false, patchConsole: false,
})
await commitReady
const outputBeforeCommitExit = output.length
commitInstance.rerender(commitTree(true))
await commitShutdown
check('detach during a React commit finishes effect cleanup before handoff', commitCleanups === 1)
check('detach during a React commit preserves the alternate screen', !output.slice(outputBeforeCommitExit).join('').includes(EXIT_ALT_SCREEN))
commitInstance.cleanup()

console.log(results.join('\n'))
if (failures > 0) process.exit(1)
