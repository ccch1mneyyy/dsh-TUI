/**
 * Shutdown-detach regression: graceful TUI exit bypasses Ink's full unmount
 * path to keep late React cleanup from rewriting the main screen. It must
 * still release the process-level stderr/console patches: `/update` reports
 * a failed update only after the detach has happened.
 */
import React from 'react'
import { PassThrough } from 'node:stream'
import { render, Text } from '../src/ui.js'
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
const instance = await render(React.createElement(Text, null, 'shutdown regression'), {
  stdout,
  exitOnCtrlC: false,
  patchConsole: true,
})

const patchedStderrWrite = process.stderr.write
check('Ink installs the stderr guard while the TUI is mounted', patchedStderrWrite !== originalStderrWrite)

const sigcontListenersBefore = process.listenerCount('SIGCONT')
const resizeListenersBefore = stdout.listenerCount('resize')
const runtime = instances.get(stdout)
runtime?.detachForShutdown()

check('shutdown detach restores process.stderr.write before post-exit work', process.stderr.write === originalStderrWrite)
check('shutdown detach restores console output before post-exit work', console.log === originalConsoleLog)
check('shutdown detach removes the SIGCONT listener', process.listenerCount('SIGCONT') < sigcontListenersBefore)
check('shutdown detach removes the stdout resize listener', stdout.listenerCount('resize') < resizeListenersBefore)

// detach intentionally makes unmount a no-op. Remove the test-only map entry
// without attempting a second terminal cleanup.
instance.cleanup()

console.log(results.join('\n'))
if (failures > 0) process.exit(1)
