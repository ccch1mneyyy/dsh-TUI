/**
 * Regression tests for Option+Enter / Shift+Enter newline parsing (#110).
 *
 * Covers three delivery shapes:
 *  1. exact  — the sequence arrives alone ('\x1b\r', CSI u, modifyOtherKeys)
 *  2. merged — Option+Enter immediately followed by typed text in the same
 *     stdin chunk ('\x1b\rabc'): the tokenizer must split ESC CR off as a
 *     sequence instead of merging it into a text token (the CR would
 *     otherwise submit the prompt — P1 regression)
 *  3. chunked — ESC and CR arrive in separate reads ('\x1b' | '\rabc'):
 *     the tokenizer buffers across feed() calls and must still split
 *
 * Run with: node --import tsx/esm scripts/verify-keys.tsx
 * Exits 1 on the first failed assertion (CI gate).
 */
import { parseMultipleKeypresses, type KeyParseState, type ParsedInput } from '../src/ink/parse-keypress.js'

type KeySummary = {
  kind: string
  name?: string
  shift?: boolean
  meta?: boolean
  ctrl?: boolean
  super?: boolean
  seq?: string
}

function summarize(keys: ParsedInput[]): KeySummary[] {
  return keys.map((k) =>
    k.kind === 'key'
      ? {
          kind: 'key',
          name: k.name,
          shift: k.shift,
          meta: k.meta,
          ctrl: k.ctrl,
          super: k.super,
          seq: k.sequence,
        }
      : { kind: k.kind },
  )
}

class Feeder {
  private state: KeyParseState = { mode: 'NORMAL', incomplete: '', pasteBuffer: '' }

  feed(s: string | null): KeySummary[] {
    const [keys, st] = parseMultipleKeypresses(this.state, s)
    this.state = st
    return summarize(keys)
  }
}

let failures = 0

function check(label: string, actual: KeySummary[], expected: KeySummary[]): void {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) {
    console.log(`ok   ${label}`)
  } else {
    failures++
    console.log(`FAIL ${label}\n     expected ${e}\n     actual   ${a}`)
  }
}

const ret = (mods: Partial<KeySummary> = {}, seq = '\r'): KeySummary => ({
  kind: 'key',
  name: 'return',
  shift: false,
  meta: false,
  ctrl: false,
  super: false,
  seq,
  ...mods,
})
const text = (seq: string): KeySummary => ({
  kind: 'key',
  name: '',
  shift: false,
  meta: false,
  ctrl: false,
  super: false,
  seq,
})
// A single printable char parses with its letter as name; multi-char text
// tokens get name ''. Both are plain text for input purposes.
const char = (c: string): KeySummary => ({ ...text(c), name: c })
const escape = (seq = '\x1b'): KeySummary => ({
  kind: 'key',
  name: 'escape',
  shift: false,
  meta: false,
  ctrl: false,
  super: false,
  seq,
})
const named = (name: string, seq: string, mods: Partial<KeySummary> = {}): KeySummary => ({
  kind: 'key',
  name,
  shift: false,
  meta: false,
  ctrl: false,
  super: false,
  seq,
  ...mods,
})

// --- 1. exact sequences ---------------------------------------------------

check('plain CR is return without modifiers', new Feeder().feed('\r'), [ret()])
check('ESC CR is meta+return (Option+Enter)', new Feeder().feed('\x1b\r'), [
  ret({ meta: true }, '\x1b\r'),
])
check('ESC LF is meta+return', new Feeder().feed('\x1b\n'), [ret({ meta: true }, '\x1b\n')])
check('CSI 13;2u is shift+return', new Feeder().feed('\x1b[13;2u'), [
  ret({ shift: true }, '\x1b[13;2u'),
])
check('CSI 13;3u is meta+return', new Feeder().feed('\x1b[13;3u'), [
  ret({ meta: true }, '\x1b[13;3u'),
])
check('CSI 13;5u is ctrl+return (interruptSend path)', new Feeder().feed('\x1b[13;5u'), [
  ret({ ctrl: true }, '\x1b[13;5u'),
])
check('modifyOtherKeys CSI 27;2;13~ is shift+return', new Feeder().feed('\x1b[27;2;13~'), [
  ret({ shift: true }, '\x1b[27;2;13~'),
])
check('CSI 106;5u is ctrl+j', new Feeder().feed('\x1b[106;5u'), [
  named('j', '\x1b[106;5u', { ctrl: true }),
])
check('modifyOtherKeys CSI 27;5;106~ is ctrl+j', new Feeder().feed('\x1b[27;5;106~'), [
  named('j', '\x1b[27;5;106~', { ctrl: true }),
])

// --- 2. merged with following text ----------------------------------------

check('ESC CR + text splits into meta+return then text', new Feeder().feed('\x1b\rabc'), [
  ret({ meta: true }, '\x1b\r'),
  text('abc'),
])
check('ESC LF + text splits into meta+return then text', new Feeder().feed('\x1b\nabc'), [
  ret({ meta: true }, '\x1b\n'),
  text('abc'),
])
check('text + ESC CR + text keeps order', new Feeder().feed('a\x1b\rb'), [
  char('a'),
  ret({ meta: true }, '\x1b\r'),
  char('b'),
])
check('CSI-u Shift+Enter + text keeps order', new Feeder().feed('\x1b[13;2uabc'), [
  ret({ shift: true }, '\x1b[13;2u'),
  text('abc'),
])
check('text + DEL Backspace + text keeps order', new Feeder().feed('ab\x7fc'), [
  text('ab'),
  named('backspace', '\x7f'),
  char('c'),
])
check('text + BS Backspace + text keeps order', new Feeder().feed('ab\bc'), [
  text('ab'),
  named('backspace', '\b'),
  char('c'),
])
check('text + Tab + text keeps order', new Feeder().feed('ab\tc'), [
  text('ab'),
  named('tab', '\t'),
  char('c'),
])
check('text + Ctrl+C + text keeps order', new Feeder().feed('ab\x03d'), [
  text('ab'),
  named('c', '\x03', { ctrl: true }),
  char('d'),
])
check('mixed CR stays a piped-line text token', new Feeder().feed('ab\rc'), [
  text('ab\rc'),
])
check('bracketed paste preserves embedded controls', new Feeder().feed('\x1b[200~a\tb\x7fc\x1b[201~'), [
  text('a\tb\x7fc'),
])

// --- 3. chunked delivery ---------------------------------------------------

{
  const f = new Feeder()
  check('lone ESC buffers (no keys yet)', f.feed('\x1b'), [])
  check('CR+text completing a buffered ESC splits correctly', f.feed('\rabc'), [
    ret({ meta: true }, '\x1b\r'),
    text('abc'),
  ])
}
{
  const f = new Feeder()
  f.feed('\x1b')
  const flushed = f.feed(null)
  check('flush of a lone ESC still yields Escape', flushed, [
    { kind: 'key', name: 'escape', shift: false, meta: false, ctrl: false, super: false, seq: '\x1b' },
  ])
}

// --- unrelated regression guards -------------------------------------------

check('plain text passes through as one token', new Feeder().feed('hello'), [text('hello')])
check('double ESC emits the first Escape and buffers the second', (() => {
  const f = new Feeder()
  const first = f.feed('\x1b\x1b')
  const flushed = f.feed(null)
  return [...first, ...flushed]
})(), [escape(), escape()])

if (failures > 0) {
  console.error(`\n${failures} assertion(s) failed`)
  process.exit(1)
}
console.log('\nall keypress assertions passed')
