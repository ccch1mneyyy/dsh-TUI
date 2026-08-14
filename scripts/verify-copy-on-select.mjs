/**
 * Headless verification of copy-on-select: with <AlternateScreen> mounted,
 * an SGR mouse drag must produce an OSC 52 clipboard write carrying the
 * selected text — fired by the useCopyOnSelect subscription when the drag
 * settles. Covers the three gaps that left the feature inert:
 *   1. TerminalWriteProvider (AlternateScreen's writeRaw context) — now
 *      provided by App, so mounting writes ENTER_ALT_SCREEN + mouse tracking.
 *   2. The useCopyOnSelect hook itself (ported here).
 *   3. Esc clears a settled selection ahead of other Esc meanings.
 *
 * Run against the compiled lib: `node scripts/verify-copy-on-select.mjs`
 */
import { Writable, PassThrough } from 'node:stream'
import React from 'react'
import {
  render,
  Text,
  AlternateScreen,
  useCopyOnSelect,
  useInput,
} from '../lib/types/ui.js'
import { useSelection } from '../lib/types/ink/hooks/use-selection.js'
import instances from '../lib/types/ink/instances.js'

// Force the pure OSC 52 path: SSH_CONNECTION skips the wl-copy/xclip/xsel
// probe chain so the assertion only depends on stdout frames.
process.env.SSH_CONNECTION = 'headless-test'
delete process.env.TMUX

let failed = 0
function check(name, ok, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed += 1
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

function makeStreams() {
  const stdout = new Writable({
    write(chunk, _enc, cb) {
      stdout.frames.push(String(chunk))
      cb()
    },
  })
  stdout.columns = 100
  stdout.rows = 30
  stdout.isTTY = true
  stdout.frames = []
  const stderr = new Writable({ write(_c, _e, cb) { cb() } })
  stderr.isTTY = true
  const stdin = new PassThrough()
  stdin.isTTY = true
  stdin.setRawMode = () => stdin
  stdin.setEncoding = () => stdin
  stdin.ref = () => stdin
  stdin.unref = () => stdin
  return { stdout, stderr, stdin }
}

function CopyOnSelectMount() {
  useCopyOnSelect()
  return null
}

// Raw mode (App's stdin 'readable' handler) is only armed when a useInput
// consumer exists — production has PromptInput/Chat; this tree needs one
// explicitly or injected mouse sequences are never read. The Esc binding
// mirrors Chat.tsx: a settled mouse selection is cleared before any other
// Esc meaning.
function InputConsumer() {
  const { clearSelection, hasSelection } = useSelection()
  useInput((_input, key, event) => {
    if (key.escape && hasSelection()) {
      clearSelection()
      event.stopImmediatePropagation()
    }
  })
  return null
}

async function run() {
  const { stdout, stderr, stdin } = makeStreams()
  const tree = React.createElement(
    AlternateScreen,
    null,
    React.createElement(CopyOnSelectMount),
    React.createElement(InputConsumer),
    React.createElement(Text, null, 'line zero'),
    React.createElement(Text, null, 'hello world'),
    React.createElement(Text, null, 'line two'),
  )
  const instance = await render(tree, {
    stdout,
    stderr,
    stdin,
    exitOnCtrlC: false,
    patchConsole: false,
  })
  // useSelection and AlternateScreen resolve the Ink instance via
  // instances.get(process.stdout); production renders to the real
  // process.stdout, so there the lookup just works. Here the render went to
  // a fake stdout, and the instance registers under that fake stdout key
  // only during render() — AFTER child components first read the map.
  // Alias the key, then re-render so useSelection's memoized stub is
  // recomputed against the real instance, and assert alt-screen state
  // explicitly (AlternateScreen's insertion effect already ran).
  const ink = instances.get(stdout)
  instances.set(process.stdout, ink)
  instance.rerender(tree)
  ink?.setAltScreenActive(true, true)

  await sleep(500)

  // 1. AlternateScreen mounted: alt-screen entered + mouse tracking on.
  const out0 = stdout.frames.join('')
  check('alt-screen entered (DEC 1049)', out0.includes('\x1b[?1049h'))
  check(
    'mouse tracking enabled (SGR 1000/1002/1003/1006)',
    out0.includes('\x1b[?1000h') && out0.includes('\x1b[?1006h'),
  )

  // 2. Drag-select "ello worl" on the 'hello world' row (terminal row 2,
  // 1-indexed): press at col 2, drag to col 10, release.
  stdin.write('\x1b[<0;2;2M')
  await sleep(100)
  stdin.write('\x1b[<32;10;2M')
  await sleep(100)
  stdin.write('\x1b[<0;10;2m')
  await sleep(300)

  const out1 = stdout.frames.join('')
  const osc52 = out1.match(/\x1b\]52;c;([A-Za-z0-9+/=]+)/)
  check('OSC 52 emitted on drag release', osc52 !== null)
  check(
    'clipboard payload is the selected text',
    osc52 !== null &&
      Buffer.from(osc52[1], 'base64').toString('utf8') === 'ello worl',
    osc52 ? Buffer.from(osc52[1], 'base64').toString('utf8') : 'no osc52',
  )
  check(
    'selection auto-clears after copy',
    ink?.hasTextSelection() === false,
  )

  // 3. Double-click word-select copies the word (multi-click path:
  // handleMultiClick → selectWordAt → same notify → same copy hook). The
  // copy fires on the SECOND release — while the second press is held
  // (isDragging), a drag could still extend the word selection, so the
  // clipboard is only written once the selection settles.
  stdin.write('\x1b[<0;5;2M')   // press   col 5 ('o' of hello)
  await sleep(80)
  stdin.write('\x1b[<0;5;2m')   // release
  await sleep(80)
  stdin.write('\x1b[<0;5;2M')   // second press within the multi-click window
  await sleep(80)
  stdin.write('\x1b[<0;5;2m')   // second release → word selection settles
  await sleep(300)
  const outWord = stdout.frames.join('')
  const osc52Word = [...outWord.matchAll(/\x1b\]52;c;([A-Za-z0-9+/=]+)/g)].at(-1)
  check(
    'double-click word-select copies the word',
    osc52Word !== undefined &&
      Buffer.from(osc52Word[1], 'base64').toString('utf8') === 'hello',
    osc52Word ? Buffer.from(osc52Word[1], 'base64').toString('utf8') : 'no osc52',
  )

  // 4. Esc cancels an in-progress drag without copying (press+drag held,
  // no release: the selection exists but has not settled).
  stdin.write('\x1b[<0;2;3M')   // press on 'line two' row
  await sleep(80)
  stdin.write('\x1b[<32;6;3M')  // drag held
  await sleep(150)
  check('mid-drag selection exists', ink?.hasTextSelection() === true)
  const before = stdout.frames.join('').match(/\x1b\]52;c;/g)?.length ?? 0
  stdin.write('\x1b')           // Esc
  await sleep(300)
  const after2 = stdout.frames.join('').match(/\x1b\]52;c;/g)?.length ?? 0
  check('Esc cancels the drag (selection gone)', ink?.hasTextSelection() === false)
  check('Esc cancel copies nothing', after2 === before)

  instance.unmount()
  await sleep(100)
  const out2 = stdout.frames.join('')
  check('alt-screen exited on unmount', out2.includes('\x1b[?1049l'))

  console.log(failed === 0 ? '\nAll checks passed.' : `\n${failed} check(s) FAILED.`)
  process.exit(failed === 0 ? 0 : 1)
}

run().catch(err => {
  console.error(err)
  process.exit(1)
})
