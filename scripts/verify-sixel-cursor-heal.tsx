/** pnpm compile:src first; node --import tsx/esm scripts/verify-sixel-cursor-heal.tsx
 *
 * Sixel cursor-check self-heal regression.
 *
 * ConPTY writes its own sequences into the app's output stream without
 * checking whether a DCS is in flight — focus/unfocus events
 * (microsoft/terminal#17510) and the resize DSR/CPR round trip
 * (microsoft/terminal#19621). A sixel payload is ONE long DCS string, so such
 * an injection ends it early and the rest of the payload is printed as literal
 * text. The diff renderer cannot see that: those cells are blank in its model,
 * so an unchanged cell is never rewritten and the garbage survives until the
 * user presses Ctrl+L.
 *
 * Ink.verifySixelPark() answers with a DECXCPR check of the cursor the frame
 * parked, and runs the Ctrl+L recovery (physical erase + full repaint) when
 * the report disagrees. This script drives the real Ink + App against a fake
 * sixel terminal and asserts:
 *   A. every graphics frame verifies the parked cursor, bounded by the DA1
 *      barrier so the check can never wait forever;
 *   B. a matching report, and a terminal that stays silent, change nothing;
 *   C. a mismatching report clears the screen and repaints the whole model,
 *      reclaiming cells polluted by leaked payload text;
 *   D. repeated mismatches hit the breaker instead of clearing every frame;
 *   E. a declared cursor (IME caret) moves the expectation off the park row;
 *   F. frames without graphics never query at all.
 */
// First import on purpose: production React, see verify-terminal-images-sixel.tsx.
import '../lib/types/force-production-react.js'
import assert from 'node:assert/strict'
import { PassThrough, Writable } from 'node:stream'
import { setTimeout as delay } from 'node:timers/promises'
import React from 'react'
import xterm from '@xterm/headless'
import { AlternateScreen, Box, Image, Text, render } from '../lib/types/ui.js'
import instances from '../lib/types/ink/instances.js'
import { nodeCache } from '../lib/types/ink/node-cache.js'
import { useDeclaredCursor } from '../lib/types/ink/hooks/use-declared-cursor.js'
import type { TerminalImageSource } from '../lib/types/ink/terminal-image.js'

const { Terminal } = xterm
const COLS = 40
const ROWS = 16
/** The cell an alt-screen frame without a cursor declaration parks on. */
const PARK = `\x1b[?${ROWS};1R`
/** Payload characters, exactly as a cut-short DCS leaks them onto the screen. */
const LEAKED = '?{1392C?${174!69?K!136?B!6?w!9?A?'
const BURST = 3

async function until(check: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 15_000
  while (!check() && Date.now() < deadline) await delay(20)
  assert.ok(check(), message)
}

class Input extends PassThrough {
  isTTY = true
  setRawMode(): this { return this }
  ref(): this { return this }
  unref(): this { return this }
}

/** Fake sixel terminal: answers DA1 and DECSDM, and answers DECXCPR with
 *  whatever the scenario decided (undefined = a terminal that ignores it). */
class Output extends Writable {
  isTTY = true
  columns = COLS
  rows = ROWS
  chunks: string[] = []
  cpr: string | undefined = undefined
  constructor(readonly input: Input) { super() }
  text(start = 0): string { return this.chunks.slice(start).join('') }
  count(needle: string, start = 0): number { return this.text(start).split(needle).length - 1 }
  _write(chunk: unknown, _encoding: BufferEncoding, done: () => void): void {
    const text = String(chunk)
    this.chunks.push(text)
    const response = text === '\x1b[c' ? '\x1b[?61;4;28c'
      : text === '\x1b[?80$p' ? '\x1b[?80;2$y'
        : text === '\x1b[?6n' ? this.cpr
          : undefined
    if (response) queueMicrotask(() => this.input.write(response))
    done()
  }
}

/** A distinct source means a distinct asset key, which is the deterministic
 *  way to make a settled image repaint (and therefore re-verify). */
const shades = [160, 200, 90, 230, 120, 60].map(value => ({
  width: 24, height: 16, data: new Uint8Array(24 * 16 * 4).fill(value),
})) as TerminalImageSource[]
const stderr = new Writable({ write(_chunk: unknown, _encoding: BufferEncoding, done: () => void) { done() } })

/** A component that declares the native cursor (IME caret) on its own box. */
const Caret = ({ active }: { active: boolean }) => {
  const ref = useDeclaredCursor({ line: 0, column: 2, active })
  return <Box ref={ref as never} height={1} flexShrink={0}><Text>caretline</Text></Box>
}

/** Same frame, but the cursor is declared inside the caret box instead of
 *  falling back to the bottom-left park row. */
const treeWithCaret = (source: TerminalImageSource, active = true) => <AlternateScreen>
  <Box width={COLS} height={ROWS} flexDirection="column">
    <Caret active={active} />
    <Text>HEADER</Text>
    <Box height={2} flexShrink={0}>
      <Image source={source} width={4} height={2} presentation="transcript" alt="pic"><Text>LOADING</Text></Image>
    </Box>
    <Text>PROMPT</Text>
  </Box>
</AlternateScreen>

const tree = (source: TerminalImageSource | null) => <AlternateScreen>
  <Box width={COLS} height={ROWS} flexDirection="column">
    <Text>HEADER</Text>
    {source === null
      ? <Text>no image here</Text>
      : <Box height={2} flexShrink={0}>
          <Image source={source} width={4} height={2} presentation="transcript" alt="pic"><Text>LOADING</Text></Image>
        </Box>}
    <Text>PROMPT</Text>
  </Box>
</AlternateScreen>

// xterm replays the app's byte stream so the final assertions can be made on a
// real screen model. Sixel payloads are swallowed by the DCS handler — this
// script is about cells, not pixels.
const terminal = new Terminal({ cols: COLS, rows: ROWS, allowProposedApi: true })
terminal.parser.registerDcsHandler({ final: 'q' }, () => true)
let replayed = 0
async function replay(output: Output): Promise<void> {
  const bytes = output.text(replayed)
  replayed = output.chunks.length
  if (bytes) await new Promise<void>(resolve => { terminal.write(bytes, resolve) })
}
const screenText = (): string => Array.from({ length: ROWS }, (_value, row) =>
  terminal.buffer.active.getLine(row)?.translateToString(true) ?? '').join('\n')

const input = new Input()
const output = new Output(input)
let appAlive = true
const app = await render(tree(shades[0]!), {
  stdin: input, stdout: output, stderr, exitOnCtrlC: false, patchConsole: false, terminalImages: true,
})

try {
  // ── A. a graphics frame verifies the parked cursor ────────────────────────
  await until(() => output.count('\x1bP0;1;q') === 1, 'A1: the image paints as one Sixel payload')
  await until(() => output.count('\x1b[?6n') === 1, 'A2: the graphics frame verifies the parked cursor')
  assert.match(output.text(), /\x1b\[\?6n\x1b\[c/u, 'A3: the report is bounded by the DA1 barrier')
  await replay(output)
  const clears = output.count('\x1b[2J')
  assert.ok(clears >= 1, 'A4: alt-screen entry cleared once')
  await delay(200)
  assert.equal(output.count('\x1b[2J'), clears, 'A5: an unanswered report must never clear the screen')

  // ── B. a matching report changes nothing ──────────────────────────────────
  output.cpr = PARK
  app.rerender(tree(shades[1]!))
  await until(() => output.count('\x1bP0;1;q') === 2, 'B1: a new asset repaints the image')
  await until(() => output.count('\x1b[?6n') === 2, 'B2: the repaint verifies again')
  await delay(200)
  assert.equal(output.count('\x1b[2J'), clears, 'B3: a matching report must not clear the screen')

  // Windows Terminal answers DECXCPR with the page number appended
  // (CSI ? row ; col ; page R), so the check must parse that shape too.
  output.cpr = `\x1b[?${ROWS};1;1R`
  app.rerender(tree(shades[2]!))
  await until(() => output.count('\x1bP0;1;q') === 3, 'B4: a third asset repaints the image')
  await until(() => output.count('\x1b[?6n') === 3, 'B5: the repaint verifies again')
  await delay(200)
  assert.equal(output.count('\x1b[2J'), clears, 'B6: the page-parameter form is parsed, not a mismatch')

  // ── C. a mismatch heals: erase, then repaint the whole model ──────────────
  // Pollute the screen the way a cut-short payload does: cells the model calls
  // blank, written behind the app's back.
  await replay(output)
  await new Promise<void>(resolve => { terminal.write('\x1b[6;1H' + LEAKED, resolve) })
  assert.ok(screenText().includes(LEAKED), 'C0: precondition — the leaked text is on screen')

  output.cpr = '\x1b[?3;7;1R'
  const mark = output.chunks.length
  app.rerender(tree(shades[3]!))
  await until(() => output.count('\x1b[2J', mark) > 0, 'C1: a mismatching report clears the screen')
  const healed = output.text(mark)
  const afterErase = healed.slice(healed.indexOf('\x1b[2J'))
  assert.ok(afterErase.includes('HEADER'), 'C2: the healed frame repaints the whole model')
  assert.ok(afterErase.includes('\x1bP0;1;q'), 'C3: the healed frame re-emits the image')
  await replay(output)
  assert.ok(!screenText().includes(LEAKED), 'C4: the leaked payload text is gone from the screen')
  assert.ok(screenText().includes('HEADER'), 'C5: the repaint restored the frame content')

  // ── D. the breaker bounds repeats instead of clearing every frame ─────────
  // The burst is self-driven: each heal repaints the image, whose check reports
  // the same mismatch. It must settle on its own, and the frame after it must
  // render without clearing (a systematic mismatch would otherwise clear and
  // repaint forever).
  await delay(600)
  const settled = output.count('\x1b[2J')
  const queries = output.count('\x1b[?6n')
  await delay(300)
  assert.equal(output.count('\x1b[2J'), settled, 'D1: the heal burst settles without looping')
  assert.equal(output.count('\x1b[?6n'), queries, 'D2: the settled burst writes no further query')
  const heals = settled - clears
  assert.ok(heals >= 1, `D3: the mismatch actually healed (${heals})`)
  assert.ok(heals <= BURST, `D4: heals stay bounded by the breaker (${heals} > ${BURST})`)
  app.rerender(tree(shades[4]!))
  await delay(400)
  assert.equal(output.count('\x1b[2J'), settled, 'D5: a muted check renders on without clearing')
  assert.equal(output.count('\x1b[?6n'), queries, 'D6: the muted check writes no further query')
  await replay(output)
  assert.ok(screenText().includes('HEADER'), 'D7: the app keeps painting after the mute')

  // One Ink instance at a time: the phases below mount their own apps, and a
  // second live instance in the same process starves them (its frames never
  // reach the fake terminal), so the first one is retired here.
  output.isTTY = false
  app.unmount()
  appAlive = false

  // ── E. a declared cursor moves the expectation off the park row ───────────
  // The park cell is not always (rows,1): a component (IME caret, search box)
  // can declare where the cursor belongs, and the frame's last CUP is that
  // declaration. The check must judge reports against the same cell, or every
  // frame with a caret would look corrupted.
  const caretInput = new Input()
  const caretOutput = new Output(caretInput)
  const caret = await render(treeWithCaret(shades[0]!), {
    stdin: caretInput, stdout: caretOutput, stderr, exitOnCtrlC: false, patchConsole: false, terminalImages: true,
  })
  try {
    await until(() => caretOutput.count('\x1bP0;1;q') === 1, 'E0: the caret frame paints the image')
    const caretInk = instances.get(caretOutput) as unknown as {
      cursorDeclaration: { relativeX: number; relativeY: number; node: object } | null
    }
    const declaration = caretInk.cursorDeclaration
    assert.ok(declaration, 'E1: the declaration is live')
    const rect = nodeCache.get(declaration.node as never)
    assert.ok(rect, 'E2: the declared node has a layout rect')
    const declared = `\x1b[?${rect.y + declaration.relativeY + 1};${rect.x + declaration.relativeX + 1}R`
    assert.notEqual(declared, PARK, 'E3: the declared cell differs from the park row')
    caretOutput.cpr = declared
    const caretClears = caretOutput.count('\x1b[2J')
    caret.rerender(treeWithCaret(shades[1]!))
    await until(() => caretOutput.count('\x1bP0;1;q') === 2, 'E4: the caret frame repaints the image')
    await delay(200)
    assert.equal(caretOutput.count('\x1b[2J'), caretClears, 'E5: the declared cell is the expectation, not the park row')
    const caretMark = caretOutput.chunks.length
    caretOutput.cpr = PARK
    caret.rerender(treeWithCaret(shades[2]!))
    await until(() => caretOutput.count('\x1b[2J', caretMark) > 0,
      'E6: reporting the park row while a caret is declared is a mismatch')
  } finally {
    caretOutput.isTTY = false
    caret.unmount()
  }

  // ── F. frames without graphics never query ────────────────────────────────
  const quietInput = new Input()
  const quietOutput = new Output(quietInput)
  const quiet = await render(tree(null), {
    stdin: quietInput, stdout: quietOutput, stderr, exitOnCtrlC: false, patchConsole: false, terminalImages: true,
  })
  try {
    await delay(300)
    quiet.rerender(tree(null))
    await delay(400)
    assert.ok(quietOutput.chunks.length > 1, 'F1: the quiet app really renders frames')
    assert.equal(quietOutput.count('\x1bP0;1;q'), 0, 'F2: no graphics without an image')
    assert.equal(quietOutput.count('\x1b[?6n'), 0, 'F3: text-only frames never verify the cursor')
    // Positive control: the absence above must mean "no graphics", not "this
    // app never renders" (a starved second instance would pass vacuously).
    quiet.rerender(tree(shades[0]!))
    await until(() => quietOutput.count('\x1bP0;1;q') === 1, 'F4: the same app paints once it has an image')
    await until(() => quietOutput.count('\x1b[?6n') === 1, 'F5: a graphics frame does verify the cursor')
  } finally {
    quietOutput.isTTY = false
    quiet.unmount()
  }
} finally {
  output.isTTY = false
  if (appAlive) app.unmount()
}

console.log('Sixel cursor self-heal: parked-cursor verification, mismatch recovery, breaker and no-graphics silence passed')
