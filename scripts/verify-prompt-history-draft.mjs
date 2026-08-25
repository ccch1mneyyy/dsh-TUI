#!/usr/bin/env node
/**
 * Regression for issue #287: traversing prompt history must preserve the
 * unfinished draft that was present before the first Up key.
 *
 * Drives the real PromptInput through fake stdin. After walking past both
 * ends of a two-entry history, Enter must submit the original draft rather
 * than nothing.
 *
 * Run after build: `node scripts/verify-prompt-history-draft.mjs`.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Writable } from 'node:stream'
import { settle } from './lib/term-test.mjs'

const home = mkdtempSync(join(tmpdir(), 'dsh-tui-history-draft-'))
process.env.HOME = home
process.env.USERPROFILE = home

const [{ default: React }, { render }, { PromptInput }] = await Promise.all([
  import('react'),
  import('../lib/types/ui.js'),
  import('../lib/types/components/PromptInput.js'),
])

function makeStreams() {
  const stdout = new Writable({ write(_chunk, _encoding, callback) { callback() } })
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
  return { stdout, stderr, stdin }
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

const { stdout, stderr, stdin } = makeStreams()
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

const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms))
const write = async (input) => {
  stdin.write(input)
  await wait(120)
}

try {
  // Startup and typing/arrow ordering keep fixed waits: the fake stdout
  // discards frames, so there is nothing observable to settle on for them.
  // Each Enter's effect IS observable through `submitted`, so settle there.
  await wait(300)
  await write('first')
  stdin.write('\r')
  await settle(() => submitted.length === 1)
  await write('second')
  stdin.write('\r')
  await settle(() => submitted.length === 2)
  await write('unfinished draft')

  // Repeated Up clamps at the oldest entry; repeated Down returns to and
  // stays on the draft after passing the newest entry.
  for (let i = 0; i < 3; i += 1) await write('\x1b[A')
  for (let i = 0; i < 3; i += 1) await write('\x1b[B')
  stdin.write('\r')
  await settle(() => submitted.length === 3)

  if (submitted.length !== 3 || submitted[2] !== 'unfinished draft') {
    console.error(`FAIL: unfinished draft was not restored: ${JSON.stringify(submitted)}`)
    process.exitCode = 1
  } else {
    console.log('verify-prompt-history-draft OK')
  }
} finally {
  instance.unmount()
  rmSync(home, { recursive: true, force: true })
}
