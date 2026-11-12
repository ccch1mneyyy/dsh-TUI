/** Actual Ink write ordering under its production throttle; no real account. */
import './lib/fake-home.mjs'
import assert from 'node:assert/strict'
import { Writable, PassThrough } from 'node:stream'
import React from 'react'
import { render, Text, ThemeProvider, Box } from '../src/ui.js'
import { afterNextTerminalFlush, takeTerminalFlushWaiters } from '../src/ink/flush-tick.js'
import { writeDiffToTerminal } from '../src/ink/terminal.js'
import { WhaleCouponPrompt } from '../src/components/StarPrompt.js'

class Output extends Writable {
  columns = 80; rows = 24; isTTY = true; frames: string[] = []
  _write(chunk: Buffer, _encoding: string, done: () => void) { this.frames.push(String(chunk)); done() }
  has(text: string) { return this.frames.join('').includes(text) }
}
class BlockedOutput extends Output {
  blocked = true
  releaseWrite: (() => void) | undefined
  override _write(chunk: Buffer, encoding: string, done: () => void) {
    if (!this.blocked) return super._write(chunk, encoding, done)
    this.releaseWrite = () => { this.blocked = false; super._write(chunk, encoding, done) }
  }
}
const input = () => Object.assign(new PassThrough(), { isTTY: true, setRawMode() {}, ref() {}, unref() {} })
const wrap = (child: React.ReactNode) => <ThemeProvider theme="dark"><Box width={80} height={24}>{child}</Box></ThemeProvider>
const options = (stdout: Output) => ({ stdout: stdout as never, stderr: new Output() as never, stdin: input() as never, patchConsole: false, exitOnCtrlC: false, terminalImages: false })
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const notice = { kind: 'account-notification', orderId: 'paint', title: 'UNIQUE_NOTICE_TITLE', body: 'Message body', displayUntil: null, actions: [] } as const
const originalEnv = process.env.NODE_ENV
const originalNow = Date.now
try {
  delete process.env.NODE_ENV
  for (const removeBeforeFlush of [false, true]) {
    const stdout = new Output()
    const now = originalNow()
    Date.now = () => now
    const app = await render(wrap(<Text>BASE</Text>), options(stdout))
    let displayed = 0
    let presentedAtReport = false
    try {
      app.rerender(wrap(<WhaleCouponPrompt notice={notice} onShown={() => {
        displayed++; presentedAtReport = stdout.has(notice.title)
      }} onClose={() => {}} />))
      await sleep(35)
      assert.equal(stdout.has(notice.title), false, 'fixture keeps the modal inside the throttle window')
      assert.equal(displayed, 0, 'a committed but unflushed card is not displayed')
      const other = new Output()
      const otherApp = await render(wrap(<Text>OTHER_APP_FRAME</Text>), options(other))
      await sleep(1)
      assert.equal(other.has('OTHER_APP_FRAME'), true)
      assert.equal(displayed, 0, 'another output stream cannot acknowledge this card')
      await otherApp.unmount()
      if (removeBeforeFlush) app.rerender(wrap(<Text>REMOVED</Text>))
      Date.now = originalNow
      await sleep(50)
      if (removeBeforeFlush) {
        assert.equal(stdout.has(notice.title), false, 'superseded card never reached terminal output')
        assert.equal(displayed, 0, 'unmounted card sends no displayed event')
      } else {
        assert.equal(displayed, 1)
        assert.equal(presentedAtReport, true, 'displayed follows the actual terminal write')
        app.rerender(wrap(<Text>AFTER</Text>)); await sleep(25)
        assert.equal(displayed, 1, 'later frames never repeat the acknowledgement')
      }
    } finally { Date.now = originalNow; await app.unmount() }
  }
  // A previous write may backpressure this frame. A newer card must not
  // claim that older frame's completion, even on the same output stream.
  const blocked = new BlockedOutput()
  const heldApp = await render(wrap(<Text>BASE_BLOCKED</Text>), options(blocked))
  let oldReports = 0, newReports = 0
  heldApp.rerender(wrap(<WhaleCouponPrompt notice={notice} onShown={() => { oldReports++ }} onClose={() => {}} />))
  await sleep(35)
  assert.equal(oldReports, 0, 'enqueueing behind backpressure is not presentation')
  const newer = { ...notice, orderId: 'next-card', title: 'NEWER_NOTICE_TITLE' }
  heldApp.rerender(wrap(<WhaleCouponPrompt notice={newer} onShown={() => {
    assert.equal(blocked.has(newer.title), true, 'older queued frame cannot acknowledge a newer card')
    newReports++
  }} onClose={() => {}} />))
  await sleep(35)
  assert.equal(newReports, 0)
  blocked.releaseWrite?.()
  await sleep(40)
  assert.equal(oldReports, 0, 'retired card ignores its delayed write completion')
  assert.equal(newReports, 1)
  await heldApp.unmount()

  // Empty diffs need a completion barrier for the previously queued pixels.
  const barrier = new BlockedOutput()
  barrier.write('ALREADY_VISIBLE_CONTENT')
  let barrierReports = 0
  const offBarrier = afterNextTerminalFlush(barrier as never, () => { barrierReports++ })
  writeDiffToTerminal({ stdout: barrier } as never, [], false, takeTerminalFlushWaiters(barrier as never))
  await Promise.resolve()
  assert.equal(barrierReports, 0, 'empty frame does not bypass an unfinished write')
  barrier.releaseWrite?.(); await sleep(1)
  assert.equal(barrierReports, 1)
  offBarrier()
  let failedReports = 0
  const failed = new Writable({ write(_chunk, _encoding, done) { done(new Error('synthetic output failure')) } })
  failed.on('error', () => {})
  const offFailed = afterNextTerminalFlush(failed as never, () => { failedReports++ })
  writeDiffToTerminal({ stdout: failed } as never, [], false, takeTerminalFlushWaiters(failed as never))
  await sleep(1)
  assert.equal(failedReports, 0, 'failed output completion never reports displayed')
  offFailed()
  const cancelled = new Output()
  let cancelledReports = 0
  const offCancelled = afterNextTerminalFlush(cancelled as never, () => { cancelledReports++ })
  takeTerminalFlushWaiters(cancelled as never)?.()
  offCancelled()
  await Promise.resolve()
  assert.equal(cancelledReports, 0, 'unmount also cancels a queued completion microtask')
  process.env.NODE_ENV = 'test'
  const stdout = new Output()
  let shown = false
  const app = await render(wrap(<WhaleCouponPrompt notice={notice} onShown={() => {
    assert.equal(stdout.has(notice.title), true, 'synchronous renderer also writes before displayed')
    shown = true
  }} onClose={() => {}} />), options(stdout))
  try { await new Promise(resolve => setImmediate(resolve)); assert.equal(shown, true, 'mutation registration precedes synchronous resetAfterCommit') }
  finally { await app.unmount() }
  console.log('PASS account notification presentation: throttled, superseded, stream owner, backpressure, failed/empty writes, synchronous renderer')
} finally {
  Date.now = originalNow
  if (originalEnv === undefined) delete process.env.NODE_ENV
  else process.env.NODE_ENV = originalEnv
}
