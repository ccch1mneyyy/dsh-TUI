#!/usr/bin/env node
/**
 * SIGCONT raw-mode restore regression (compiled lib).
 *
 * `Ctrl+Z` no longer suspends the app, so an EXTERNAL stop (`kill -STOP`, the
 * shell's `suspend`, SIGTSTP) is the only way to stop it — and while the job is
 * stopped the shell owns the tty and leaves it in its own COOKED modes. On
 * SIGCONT the app must put its own termios back, otherwise the composer keeps
 * drawing frames while the line discipline echoes every keystroke and delivers
 * nothing until Enter.
 *
 * Mounts the real tree over a fake TTY stdin whose `isRaw` flag the test
 * controls, then emits SIGCONT the way the kernel would.
 *
 * Also covers the PAUSED handoff (an external editor owns the tty): with the
 * alt screen active, `pause()` models the handoff — a SIGCONT during it must
 * touch nothing (no termios re-assert, no repaint, no alt-screen re-entry) —
 * and the ordinary path must resume once the app is unpaused again.
 *
 * Run after build: `node scripts/verify-sigcont-rawmode.mjs`
 */
import { PassThrough, Writable } from 'node:stream'
import { settle, settled, sleep } from './lib/term-test.mjs'
import instances from '../lib/types/ink/instances.js'

const [{ default: React }, { render, AlternateScreen }, { PromptInput }] = await Promise.all([
  import('react'),
  import('../lib/types/ui.js'),
  import('../lib/types/components/PromptInput.js'),
])

let failed = 0
function check(name, ok, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed += 1
}

const writes = []
const stdout = new Writable({ write(chunk, _encoding, callback) { writes.push(String(chunk)); callback() } })
stdout.columns = 100
stdout.rows = 30
stdout.isTTY = true
const stderr = new Writable({ write(_chunk, _encoding, callback) { callback() } })
stderr.isTTY = true
const stdin = new PassThrough()
stdin.isTTY = true
stdin.isRaw = false
const rawCalls = []
let kernelRaw = false
stdin.setRawMode = mode => {
  rawCalls.push(mode)
  stdin.isRaw = mode
  kernelRaw = mode
  return stdin
}
stdin.setEncoding = () => stdin
stdin.ref = () => stdin
stdin.unref = () => stdin

const channel = {
  mode: { id: 'default', plan: false },
  modeIndex: 0,
  cycleMode() {},
  commandList: [],
  commandCompletions: () => [],
  notifications: [],
  pending: [],
  working: false,
  notify() {},
  submit() {},
  steer() {},
  interruptAndDeliver() { return 0 },
  removePending() { return false },
  stageImage() {},
  listFiles: async () => [],
}

const instance = await render(
  React.createElement(AlternateScreen, null,
    React.createElement(PromptInput, {
      channel,
      helpOpen: false,
      onToggleHelp() {},
      onRunCommand: () => false,
      selectionActive: false,
    }),
  ),
  { stdout, stderr, stdin, exitOnCtrlC: false, patchConsole: false },
)

try {
  await sleep(250) // 固定窗:pacing 等启动首帧（假 stdout 丢弃全部帧，无可 settle 的锚点）
  check('raw mode is enabled while the composer is mounted', rawCalls.includes(true) && stdin.isRaw === true,
    JSON.stringify(rawCalls))

  const ink = instances.get(stdout)
  check('the Ink instance is reachable for pause()/resume()', ink !== undefined)
  const initialRawCount = ink.app.rawModeEnabledCount
  const initialReaders = stdin.listenerCount('readable')
  // Kernel state changes behind Node's cached isRaw property, with NO input.
  kernelRaw = false
  rawCalls.length = 0
  check('idle recovery restores raw mode without waiting for readable or Enter',
    await settled(() => kernelRaw, { timeoutMs: 6500 }), JSON.stringify(rawCalls))
  check('idle recovery leaves the raw reference count and listeners unchanged',
    ink.app.rawModeEnabledCount === initialRawCount && stdin.listenerCount('readable') === initialReaders)
  check('raw recovery timer does not keep the process alive', ink.rawModeRecoveryTimer?.hasRef() === false)

  rawCalls.length = 0
  ink.reassertTerminalModes()
  check('input-gap recovery also reasserts raw mode', rawCalls.includes(true))
  rawCalls.length = 0
  ink.handleTerminalFocusProbe(true)
  check('focus recovery also reasserts raw mode', rawCalls.includes(true))

  const savedSetRawMode = stdin.setRawMode
  let escaped = false
  try {
    stdin.setRawMode = () => { throw new Error('fixture revoked tty') }
    try { ink.reassertOwnedRawMode() } catch { escaped = true }
  } finally {
    stdin.setRawMode = savedSetRawMode
  }
  check('periodic raw recovery tolerates a revoked tty ioctl', !escaped)
  kernelRaw = false
  ink.reassertOwnedRawMode()
  check('a later raw recovery can succeed after the ioctl failure', kernelRaw)


  // The shell reset termios to its own cooked modes while the job was stopped.
  // `stdin.isRaw` is deliberately left alone: Node caches it as a plain stream
  // property, so after an external stop it still reads `true` while the tty is
  // cooked — that stale cache is exactly why the app must re-issue the ioctl
  // unconditionally instead of trusting the flag.
  rawCalls.length = 0
  process.emit('SIGCONT')
  await settle(() => rawCalls.includes(true))
  check('SIGCONT re-issues raw mode after an external stop', rawCalls.includes(true), JSON.stringify(rawCalls))

  // Every continue re-asserts termios (the ioctl is idempotent): the app cannot
  // tell a live raw mode from a stale cache.
  rawCalls.length = 0
  process.emit('SIGCONT')
  await settle(() => rawCalls.includes(true))
  check('a later SIGCONT re-asserts again', rawCalls.includes(true), JSON.stringify(rawCalls))

  // ── paused handoff (external editor owns the tty) ──────────
  // The <AlternateScreen> wrapper has flipped altScreenActive. `pause()` models
  // the external-editor handoff. A SIGCONT here — e.g. the editor's own Ctrl+Z
  // suspending the whole process group — must be left entirely to the child: no
  // termios re-assert, no repaint, no alt-screen re-entry (all three share the
  // same `isPaused` early return in handleResume).
  ink.pause()
  check('pause clears the periodic raw recovery timer', ink.rawModeRecoveryTimer === undefined)
  await sleep(120) // 固定窗:pacing 等 pause() 的收尾重绘落地
  rawCalls.length = 0
  const pausedWrites = writes.length
  ink.reassertOwnedRawMode()
  ink.reassertTerminalModes()
  ink.handleTerminalFocusProbe(true)
  process.emit('SIGCONT')
  await sleep(120) // 固定窗:探针 暂停期间 SIGCONT 必须完全静默：只能等观察窗
  check('SIGCONT while paused touches nothing (no raw mode, no repaint, no alt-screen re-entry)',
    !rawCalls.includes(true) && writes.length === pausedWrites,
    `raw=${JSON.stringify(rawCalls)} writes=${writes.length - pausedWrites}`)

  // Unpausing restores the ordinary path: the next SIGCONT re-asserts termios
  // (and, with the alt screen active, re-enters it).
  ink.resume()
  check('resume restarts periodic raw recovery', ink.rawModeRecoveryTimer !== undefined)
  await sleep(80) // 固定窗:pacing 等 resume 的重绘落地
  rawCalls.length = 0
  process.emit('SIGCONT')
  await settle(() => rawCalls.includes(true))
  check('SIGCONT after resume re-asserts raw mode again', rawCalls.includes(true), JSON.stringify(rawCalls))

  instance.unmount()
  check('unmount clears periodic raw recovery', ink.rawModeRecoveryTimer === undefined)
  await sleep(120) // 固定窗:pacing 等 unmount 的清理落地（无单一可轮询锚点）
  rawCalls.length = 0
  ink.reassertOwnedRawMode()
  ink.reassertTerminalModes()
  ink.handleTerminalFocusProbe(true)
  process.emit('SIGCONT')
  await sleep(100) // 固定窗:探针 断言 unmount 后 SIGCONT 不得碰 tty：只能等观察窗
  check('SIGCONT after unmount does not touch the tty', rawCalls.length === 0, JSON.stringify(rawCalls))

  if (failed > 0) {
    console.error(`\n${failed} sigcont check(s) failed`)
    process.exitCode = 1
  } else {
    console.log('\nverify-sigcont-rawmode OK')
  }
} finally {
  try { instance.unmount() } catch { /* already unmounted */ }
}
