// Regression: OS-adapted Ctrl/Cmd shortcut resolution (macOS muscle memory).
//
// Drives resolveCtrlFlag()/resolveCmdHomeEnd() from
// lib/types/ink/events/input-event.js (run `pnpm build` first) and asserts
// the full platform/capability matrix:
//   - macOS + extended keys: app shortcuts (o/r/l/v, d, enter) trigger on
//     Cmd; reserved system keys (a/c/e/t/u/w and arrows) keep bare-Ctrl
//     semantics only; Ctrl+D stays dual-triggered as the exit hatch.
//   - macOS without extended keys: Cmd never arrives, Ctrl stays the trigger.
//   - non-macOS: behavior is unchanged.
//   - ⌘←/⌘→ maps to Home/End (line start/end), only on macOS + ext.
//
// Usage: node scripts/verify-cmd-keys.mjs

import assert from 'node:assert/strict'
import {
  resolveCtrlFlag,
  resolveCmdHomeEnd,
} from '../lib/types/ink/events/input-event.js'

let failures = 0
function check(label, actual, expected) {
  try {
    assert.equal(actual, expected)
    console.log(`ok   ${label}`)
  } catch (error) {
    failures++
    console.error(`FAIL ${label}: expected ${expected}, got ${actual}`)
  }
}

// macOS + extended key reporting (kitty/modifyOtherKeys).
const mac = [true, true]

// App shortcuts: Cmd is the trigger, bare Ctrl is not.
check('mac+ext: cmd+o triggers ctrl', resolveCtrlFlag('o', false, true, ...mac), true)
check('mac+ext: bare ctrl+o does not trigger', resolveCtrlFlag('o', true, false, ...mac), false)
check('mac+ext: cmd+v paste triggers', resolveCtrlFlag('v', false, true, ...mac), true)
check('mac+ext: cmd+r search triggers', resolveCtrlFlag('r', false, true, ...mac), true)

// Reserved system keys: ⌘ must not hijack them; bare Ctrl keeps readline use.
for (const name of ['a', 'c', 'e', 't', 'u', 'w']) {
  check(`mac+ext: cmd+${name} does NOT hijack ctrl`, resolveCtrlFlag(name, false, true, ...mac), false)
  check(`mac+ext: bare ctrl+${name} still works`, resolveCtrlFlag(name, true, false, ...mac), true)
}
check('mac+ext: cmd+d triggers (exit)', resolveCtrlFlag('d', false, true, ...mac), true)
check('mac+ext: bare ctrl+d still triggers (exit hatch)', resolveCtrlFlag('d', true, false, ...mac), true)
check('mac+ext: cmd+enter triggers (send now)', resolveCtrlFlag('return', false, true, ...mac), true)

// Arrows: ⌘←/⌘→ is Home/End on macOS, never a word jump; Ctrl+←/→ stays the
// emacs word jump.
check('mac+ext: cmd+left does not trigger ctrl word-jump', resolveCtrlFlag('left', false, true, ...mac), false)
check('mac+ext: cmd+right does not trigger ctrl word-jump', resolveCtrlFlag('right', false, true, ...mac), false)
check('mac+ext: bare ctrl+left keeps word jump', resolveCtrlFlag('left', true, false, ...mac), true)
check('mac+ext: cmd+left → home', resolveCmdHomeEnd('left', true, ...mac), 'home')
check('mac+ext: cmd+right → end', resolveCmdHomeEnd('right', true, ...mac), 'end')
check('mac+ext: plain left stays an arrow', resolveCmdHomeEnd('left', false, ...mac), null)
check('mac+ext: cmd+o is not home/end', resolveCmdHomeEnd('o', true, ...mac), null)

// macOS terminal without extended keys (Terminal.app, default iTerm2):
// Cmd never reaches the app, so Ctrl must keep working untouched.
check('mac-noext: ctrl+o triggers', resolveCtrlFlag('o', true, false, true, false), true)
check('mac-noext: ctrl+c triggers', resolveCtrlFlag('c', true, false, true, false), true)
check('mac-noext: ctrl+left triggers', resolveCtrlFlag('left', true, false, true, false), true)
check('mac-noext: no cmd home/end rewrite', resolveCmdHomeEnd('left', true, true, false), null)

// Windows/Linux: unchanged — ctrl is ctrl, super is ignored.
check('linux: ctrl+o triggers', resolveCtrlFlag('o', true, false, false, true), true)
check('linux: win-key+o does not hijack ctrl', resolveCtrlFlag('o', false, true, false, true), false)
check('linux: ctrl+c triggers', resolveCtrlFlag('c', true, false, false, true), true)
check('linux: ctrl+left triggers', resolveCtrlFlag('left', true, false, false, true), true)
check('linux: win-key+left is not home', resolveCmdHomeEnd('left', true, false, true), null)

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`)
  process.exit(1)
}
console.log('\nall cmd-key resolution checks passed')
