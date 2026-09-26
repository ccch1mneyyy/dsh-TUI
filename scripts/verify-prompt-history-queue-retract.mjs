#!/usr/bin/env node
/**
 * Regression for issue #986 (second half): recalling a message that is still
 * parked in the inbox must withdraw that queued copy — otherwise `↑` fills
 * the input with a text the queue is going to run anyway, and re-sending it
 * runs the same message twice.
 *
 * Alt+Up already withdraws explicitly; this drives the same text back through
 * the history walk and checks three outcomes:
 *
 *   - still withdrawable → the queue loses it and the withdrawal is announced;
 *   - already claimed by the running turn → the real channel refuses, so the
 *     queue keeps it and the notice says so instead of pretending;
 *   - a queued entry with different text → left alone.
 *
 * Run after build: `node scripts/verify-prompt-history-queue-retract.mjs`.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Writable } from 'node:stream'
import { settled, sleep, viewportLines } from './lib/term-test.mjs'

// `DATA_DIR` is resolved at module load from the home directory, so the temp
// HOME has to be in place before the harness imports the compiled app: this
// regression must never touch the real input history (it holds raw inputs).
const home = mkdtempSync(join(tmpdir(), 'dsh-tui-queue-retract-'))
process.env.HOME = home
process.env.USERPROFILE = home

const [{ default: React }, { default: xtermHeadless }, { render }, { PromptInput }, { t }] =
  await Promise.all([
    import('react'),
    import('@xterm/headless'),
    import('../lib/types/ui.js'),
    import('../lib/types/components/PromptInput.js'),
    import('../lib/types/i18n.js'),
  ])
const { Terminal: XTerm } = xtermHeadless

let failed = 0
/** Print one pass/fail line and keep a running failure count. */
function check(name, ok, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed += 1
}

const submitted = []
const notifications = []
const removePendingCalls = []
let removePendingResult = true

const channel = {
  mode: { id: 'default', plan: false },
  modeIndex: 0,
  cycleMode() {},
  commandList: [],
  commandCompletions: () => [],
  notifications,
  pending: [],
  working: false,
  notify(message) { notifications.push(message) },
  submit(text) { submitted.push(text) },
  steer() {},
  interruptAndDeliver() { return 0 },
  // Mirrors the real channel: a message the running turn already claimed is
  // refused (`agent.inbox.remove` returns false) and stays in the queue.
  removePending(id) {
    removePendingCalls.push(id)
    if (!removePendingResult) return false
    const index = channel.pending.findIndex(item => item.id === id)
    if (index === -1) return false
    channel.pending.splice(index, 1)
    return true
  },
  stageImage() {},
  listFiles: async () => [],
}

/** Park one message in the queue as the channel reports it to the composer. */
const park = (id, text) => {
  channel.pending.push({ id, text, images: [], placement: 'followup' })
}

/** Mount the real composer over a headless terminal. */
async function mountComposer() {
  const term = new XTerm({ cols: 100, rows: 30, scrollback: 100, allowProposedApi: true })
  const stdout = new Writable({
    write(chunk, _encoding, callback) {
      term.write(String(chunk), callback)
    },
  })
  stdout.columns = 100
  stdout.rows = 30
  stdout.isTTY = true
  const stderr = new Writable({ write(_chunk, _encoding, callback) { callback() } })
  stderr.isTTY = true
  const stdin = new PassThrough()
  stdin.isTTY = true
  stdin.setRawMode = () => stdin
  stdin.setEncoding = () => stdin
  stdin.ref = () => stdin
  stdin.unref = () => stdin
  const instance = await render(
    React.createElement(PromptInput, {
      channel,
      helpOpen: false,
      onToggleHelp() {},
      onRunCommand: () => false,
      selectionActive: false,
    }),
    { stdout, stderr, stdin, exitOnCtrlC: false, patchConsole: false },
  )
  // 固定窗:pacing 等挂载首帧与输入监听挂接——假终端没有可轮询的就绪条件
  await sleep(500)
  return {
    stdin,
    instance,
    shows: text => viewportLines(term).some(line => line.includes(text)),
  }
}

const UP = '\x1b[A'
const RETRACTED = t('input-retracted')
const CANNOT_RETRACT = t('input-cannot-retract')

const first = await mountComposer()
try {
  // The text the walk will recall: typed and sent in this process.
  first.stdin.write('queued message')
  await sleep(150) // 固定窗:pacing 等输入回显稳定再回车
  first.stdin.write('\r')
  check('the message is submitted', await settled(() => submitted.length === 1), JSON.stringify({ submitted }))

  // The model was working, so the host parks it: the queue and the history
  // now hold the same text.
  park('pending-1', 'queued message')
  first.stdin.write(UP)
  // Sanity anchor for "the walk landed on that entry"; the withdrawal
  // assertions below are what actually pin the behavior.
  check('up recalls the queued text', await settled(() => first.shows('queued message')))
  check(
    'the queued copy is withdrawn',
    removePendingCalls.length === 1 && removePendingCalls[0] === 'pending-1',
    JSON.stringify({ removePendingCalls }),
  )
  check('the withdrawal is announced', notifications.includes(RETRACTED), JSON.stringify({ notifications }))
  check('the queue no longer holds it', channel.pending.length === 0)

  // Claimed by the running turn: the channel refuses, so the copy stays.
  removePendingResult = false
  park('pending-2', 'queued message')
  first.stdin.write(UP)
  check(
    'a claimed message reports the refusal',
    await settled(() => notifications.includes(CANNOT_RETRACT)),
    JSON.stringify({ notifications }),
  )
  check(
    'and it stays in the queue',
    channel.pending.length === 1 && removePendingCalls.length === 2,
    JSON.stringify({ removePendingCalls, pending: channel.pending.length }),
  )

  // Queued text the walk never lands on must be left alone.
  channel.pending.length = 0
  park('pending-3', 'something else')
  const callsBefore = removePendingCalls.length
  first.stdin.write(UP)
  await sleep(300) // 固定窗:探针 断言「不匹配的排队项绝不被动」——对已成立条件轮询等于没测
  check(
    'an unrelated queue entry is left alone',
    removePendingCalls.length === callsBefore && channel.pending.length === 1,
    JSON.stringify({ callsBefore, removePendingCalls, pending: channel.pending.length }),
  )
} finally {
  first.instance.unmount()
  rmSync(home, { recursive: true, force: true })
}

console.log(failed === 0 ? '\nverify-prompt-history-queue-retract OK' : `\n${failed} check(s) FAILED`)
process.exit(failed === 0 ? 0 : 1)
