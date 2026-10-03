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
 *      the file is the source;
 *   5. history is project-scoped: a submit made in workspace A is recalled
 *      there but never in workspace B, while legacy (unscoped) entries stay
 *      visible in both;
 *   6. a workspace switch inside ONE mount (the composer is not remounted)
 *      re-seeds the walk without losing the draft it started from: `↓`
 *      returns that draft instead of stepping through the old project's
 *      list, and `↑` continues in the new project's history;
 *   7. the same directory written differently (`/repo` vs `/repo/`) is one
 *      project, not a switch: the walk keeps its position instead of
 *      restarting at the newest entry.
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
}

const projectA = join(home, 'repo-a')
const projectB = join(home, 'repo-b')
channel.cwd = projectA
const inA = await mountComposer()
try {
  inA.stdin.write('submit in project a')
  await sleep(150) // 固定窗:pacing 等输入回显稳定再回车
  inA.stdin.write('\r')
  await settled(() => submitted.includes('submit in project a'))
  inA.stdin.write(UP)
  check('project A recalls its own submit', await settled(() => inA.shows('submit in project a')))
} finally {
  inA.instance.unmount()
}
check(
  'the project submit is persisted with its project key',
  await settled(() => readFileSync(historyFile, 'utf8').includes('"project"')),
)

channel.cwd = projectB
const inB = await mountComposer()
try {
  inB.stdin.write(UP)
  check('project B skips project A and recalls the newest legacy entry', await settled(() => inB.shows('fresh submit')))
  check('project B never shows project A input', !inB.shows('submit in project a'))
} finally {
  inB.instance.unmount()
}

// The same directory respelled (`/repo` vs `/repo/`, plus case on Windows)
// is the same project — the store keys it that way, so the composer must not
// read it as a workspace switch, which would restart the walk at the newest
// entry and drop the draft it started from.
channel.cwd = projectA
const respelled = await mountComposer()
try {
  respelled.stdin.write('respell draft')
  await sleep(150) // 固定窗:pacing 等输入回显稳定再按键
  respelled.stdin.write(UP)
  check(
    'a walk in project A recalls its own newest entry',
    await settled(() => respelled.shows('submit in project a')),
  )
  respelled.stdin.write(UP)
  check('the walk steps into the older legacy entry', await settled(() => respelled.shows('fresh submit')))
  channel.cwd = `${projectA}/`
  respelled.stdin.write(UP)
  check(
    'a respelled path to the same project keeps walking instead of restarting',
    await settled(() => respelled.shows(persisted[2]) && !respelled.shows('submit in project a')),
  )
  respelled.stdin.write(DOWN)
  check('down after the respelling stays in step', await settled(() => respelled.shows('fresh submit')))
  respelled.stdin.write(DOWN)
  check('down walks back to the newest entry', await settled(() => respelled.shows('submit in project a')))
  respelled.stdin.write(DOWN)
  check('the draft survives the respelling too', await settled(() => respelled.shows('respell draft')))
} finally {
  respelled.instance.unmount()
}

channel.cwd = projectA
const switching = await mountComposer()
try {
  switching.stdin.write('draft kept')
  await sleep(150) // 固定窗:pacing 等输入回显稳定再按键
  switching.stdin.write(UP)
  check('a walk in project A recalls its entry', await settled(() => switching.shows('submit in project a')))
  // One step deeper, so a ↓ still walking A's list would land on A's entry
  // rather than falling off the end onto the draft by coincidence.
  switching.stdin.write(UP)
  check('the walk steps into the older legacy entry', await settled(() => switching.shows('fresh submit')))
  channel.cwd = projectB
  switching.stdin.write(DOWN)
  check(
    'down after a mid-walk switch restores the draft',
    await settled(() => switching.shows('draft kept') && !switching.shows('submit in project a')),
  )
  switching.stdin.write(UP)
  check('up after the switch walks project B', await settled(() => switching.shows('fresh submit')))
  channel.cwd = projectA
  switching.stdin.write(UP)
  check(
    'up after switching back walks project A again',
    await settled(() => switching.shows('submit in project a') && !switching.shows('fresh submit')),
  )
  switching.stdin.write(DOWN)
  check('the original draft survives two switches', await settled(() => switching.shows('draft kept')))
} finally {
  switching.instance.unmount()
  rmSync(home, { recursive: true, force: true })
}

console.log(failed === 0 ? '\nverify-prompt-history-persist OK' : `\n${failed} check(s) FAILED`)
process.exit(failed === 0 ? 0 : 1)
