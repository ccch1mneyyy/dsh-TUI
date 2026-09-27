#!/usr/bin/env node
/**
 * Regression for issue #986: `↑`/`↓` must walk the PERSISTED input history,
 * not only the entries submitted during this process.
 *
 * Seeds a temp HOME with a `history.jsonl` (append order = oldest line
 * first), then drives the real PromptInput:
 *
 *   1. `↑` from the empty composer reaches the NEWEST persisted entry — a
 *      missing reverse would surface the oldest one instead;
 *   2. the walk keeps descending into the older persisted entries and clamps
 *      there without desyncing;
 *   3. a submit made in this process heads the walk, with the persisted
 *      entries behind it in order and each offered exactly once;
 *   4. a remounted composer (a restart) still recalls that submit, because
 *      the file is the source.
 *
 * Run after build: `node scripts/verify-prompt-history-persist.mjs`.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Writable } from 'node:stream'
import { settled, sleep, viewportLines } from './lib/term-test.mjs'

// `DATA_DIR` is resolved at module load from the home directory, so the temp
// HOME must be in place before the harness imports the compiled app.
const home = mkdtempSync(join(tmpdir(), 'dsh-tui-history-persist-'))
process.env.HOME = home
process.env.USERPROFILE = home

const dataDir = join(home, '.dsh-tui')
const historyFile = join(dataDir, 'history.jsonl')
mkdirSync(dataDir, { recursive: true })
/** Append order: index 0 is the oldest entry, the last one is the newest. */
const persisted = ['persisted oldest', 'persisted middle', 'persisted newest']
writeFileSync(
  historyFile,
  persisted.map((text, index) => JSON.stringify({ text, ts: index + 1 })).join('\n') + '\n',
)

const [{ default: React }, { default: xtermHeadless }, { render }, { PromptInput }] = await Promise.all([
  import('react'),
  import('@xterm/headless'),
  import('../lib/types/ui.js'),
  import('../lib/types/components/PromptInput.js'),
])
const { Terminal: XTerm } = xtermHeadless

let failed = 0
/** Print one pass/fail line and keep a running failure count. */
function check(name, ok, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed += 1
}

const submitted = []
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
  submit(text) { submitted.push(text) },
  steer() {},
  interruptAndDeliver() { return 0 },
  removePending() { return false },
  stageImage() {},
  listFiles: async () => [],
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
    /** Step one key with pacing; no pollable "key handled" signal exists. */
    press: async key => {
      stdin.write(key)
      await sleep(120) // 固定窗:pacing 纯走位步间——假终端没有「按键已处理」的可轮询信号
    },
  }
}

const UP = '\x1b[A'
const DOWN = '\x1b[B'

const first = await mountComposer()
try {
  // The walk starts at the newest persisted entry; the file is append
  // ordered, so an unreversed seed would show `persisted[0]` here.
  first.stdin.write(UP)
  check('up recalls the newest persisted entry', await settled(() => first.shows(persisted[2])))

  first.stdin.write(UP)
  check('up walks into the middle persisted entry', await settled(() => first.shows(persisted[1])))

  first.stdin.write(UP)
  check('up walks into the oldest persisted entry', await settled(() => first.shows(persisted[0])))

  // Walking past the oldest entry clamps; the next `↓` must still land on the
  // entry one step newer (an out-of-range index would desync the walk).
  await first.press(UP)
  first.stdin.write(DOWN)
  check('clamping at the oldest keeps the walk in step', await settled(() => first.shows(persisted[1])))

  first.stdin.write(DOWN)
  check('down walks back towards the newest persisted entry', await settled(() => first.shows(persisted[2])))

  // Past the newest entry the walk returns to the draft that was stashed on
  // the first `↑` (empty here), so a fresh submit can be typed.
  await first.press(DOWN)
  first.stdin.write('fresh submit')
  await sleep(150) // 固定窗:pacing 等输入回显稳定再回车
  first.stdin.write('\r')
  check(
    'the composer is back on its own draft after the walk',
    await settled(() => submitted.length === 1 && submitted[0] === 'fresh submit'),
    JSON.stringify({ submitted }),
  )

  // This run's submit heads the walk; the persisted entries sit behind it, in
  // order and each exactly once (a duplicated seam would repeat it here).
  first.stdin.write(UP)
  check('up recalls the entry submitted in this process first', await settled(() => first.shows('fresh submit')))

  first.stdin.write(UP)
  check('the persisted entries stay behind it', await settled(() => first.shows(persisted[2])))

  first.stdin.write(UP)
  check('the walk stays chronological across the seam', await settled(() => first.shows(persisted[1])))
} finally {
  first.instance.unmount()
}

// A restart is a fresh mount reading the same file: the submit made above has
// to be there (persistence is async and best-effort, hence the poll).
check(
  'the submit reached the persisted history file',
  await settled(() => readFileSync(historyFile, 'utf8').includes('fresh submit')),
)

const second = await mountComposer()
try {
  second.stdin.write(UP)
  check('a remounted composer recalls the earlier submit', await settled(() => second.shows('fresh submit')))

  second.stdin.write(UP)
  check('and still reaches the entries persisted before it', await settled(() => second.shows(persisted[2])))
} finally {
  second.instance.unmount()
  rmSync(home, { recursive: true, force: true })
}

console.log(failed === 0 ? '\nverify-prompt-history-persist OK' : `\n${failed} check(s) FAILED`)
process.exit(failed === 0 ? 0 : 1)
