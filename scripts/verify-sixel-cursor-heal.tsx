/** pnpm compile:src first; node --import tsx/esm scripts/verify-sixel-cursor-heal.tsx
 *
 * Sixel cursor-check self-heal regression.
 *
 * ConPTY writes its own sequences into the app's output stream without checking
 * whether a DCS is in flight — focus/unfocus events (microsoft/terminal#17510)
 * and the resize DSR/CPR round trip (microsoft/terminal#19621). A sixel payload
 * is ONE long DCS string, so an injection ends it early and the rest of the
 * payload is printed as literal text. The diff renderer cannot see that: those
 * cells are blank in its model, so an unchanged cell is never rewritten and the
 * garbage survives until the user presses Ctrl+L.
 *
 * Ink.verifySixelPaint() judges a DECXCPR probe that rides INSIDE the graphics
 * frame, between the payload and the frame's park CUP. That placement is the
 * whole point: the park CUP is absolute, so it resets the cursor whether or not
 * text leaked — a probe written after the park reports a perfect position on a
 * wrecked screen. Measured on Windows Terminal: an intact 64px payload at (5,3)
 * leaves the cursor at (8,3); the same payload cut by an injected ESC leaves it
 * at (33,82); either way a following park(14,1) reports (14,1).
 *
 * The fake terminal below therefore tracks a real cursor: CUP moves it, text
 * advances and wraps it, a payload leaves it on the image's bottom-left cell,
 * and a payload cut mid-DCS prints its remainder as text before answering. The
 * app must learn the healthy value per geometry and clear the screen when a
 * later payload of the same geometry reports something else.
 *
 * Phases:
 *   A. the probe rides before the park, and a healthy frame never heals;
 *   B. the learned baseline repeats on a same-geometry repaint (no heal);
 *   C. a cut payload reports a far-away cursor → erase + full repaint;
 *   D. the breaker bounds repeats instead of clearing every frame;
 *   E. frames without graphics never probe (with a positive control).
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
import type { TerminalImageSource } from '../lib/types/ink/terminal-image.js'

const { Terminal } = xterm
const COLS = 46
const ROWS = 14
const CELL_HEIGHT = 20
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

/**
 * A fake Windows Terminal: one cursor, moved by CUP, advanced and wrapped by
 * text, parked on the image's bottom-left cell by a payload, and left wherever
 * a cut payload's leaked text ran off to. Escapes the model does not track are
 * skipped whole, so they never masquerade as printed characters.
 */
class Output extends Writable {
  isTTY = true
  columns = COLS
  rows = ROWS
  chunks: string[] = []
  /** Cut the next payload mid-DCS and print the remainder, as ConPTY does. */
  cutNextPayload = false
  leaked = ''
  cursor = { row: 1, col: 1 }
  private pending = ''
  constructor(readonly input: Input) { super() }
  text(start = 0): string { return this.chunks.slice(start).join('') }
  count(needle: string, start = 0): number { return this.text(start).split(needle).length - 1 }
  private advance(length: number): void {
    const col = this.cursor.col - 1 + length
    this.cursor = { row: Math.min(this.cursor.row + Math.floor(col / this.columns), this.rows), col: (col % this.columns) + 1 }
  }
  private reply(sequence: string): void { queueMicrotask(() => this.input.write(sequence)) }
  private consume(text: string): void {
    let i = 0
    while (i < text.length) {
      const rest = text.slice(i)
      if (rest.startsWith('\x1b')) {
        const cup = /^\x1b\[(\d+);(\d+)H/u.exec(rest)
        if (cup) { this.cursor = { row: Number(cup[1]), col: Number(cup[2]) }; i += cup[0].length; continue }
        if (rest.startsWith('\x1b[?6n')) { this.reply(`\x1b[?${this.cursor.row};${this.cursor.col};1R`); i += 6; continue }
        if (rest.startsWith('\x1b[c')) { this.reply('\x1b[?61;4;28c'); i += 3; continue }
        if (rest.startsWith('\x1b[?80$p')) { this.reply('\x1b[?80;2$y'); i += 7; continue }
        if (rest.startsWith('\x1bP0;1;q')) {
          const end = rest.indexOf('\x1b\\')
          if (end < 0) { this.pending = rest; return }
          const body = rest.slice(8, end)
          const bands = body.split('\n').length
          // Windows Terminal parks the cursor on the image's bottom-left cell.
          this.cursor = { row: Math.min(this.cursor.row + Math.floor((bands * 6) / CELL_HEIGHT), this.rows), col: this.cursor.col }
          if (this.cutNextPayload) {
            // An injected ESC ends the DCS here; everything after it is text.
            this.cutNextPayload = false
            const leftover = body.slice(Math.floor(body.length / 2))
            this.leaked = leftover
            this.advance(leftover.length)
          }
          i += end + 2
          continue
        }
        const csi = /^\x1b\[[0-9;?<=>]*[ -/]*[@-~]/u.exec(rest)
        if (csi) { i += csi[0].length; continue }
        const osc = /^\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/u.exec(rest)
        if (osc) { i += osc[0].length; continue }
        if (rest.length < 8) { this.pending = rest; return }
        i += 1
        continue
      }
      const next = rest.indexOf('\x1b')
      const plain = next < 0 ? rest : rest.slice(0, next)
      for (const ch of plain) {
        if (ch === '\r') this.cursor = { ...this.cursor, col: 1 }
        else if (ch === '\n') this.cursor = { row: Math.min(this.cursor.row + 1, this.rows), ...this.cursor, row: Math.min(this.cursor.row + 1, this.rows) }
        else this.advance(1)
      }
      i += plain.length
    }
  }
  _write(chunk: unknown, _encoding: BufferEncoding, done: () => void): void {
    this.chunks.push(String(chunk))
    this.consume(this.pending + String(chunk))
    this.pending = ''
    done()
  }
}

const shades = [160, 200, 90, 230].map(value => ({
  width: 24, height: 16, data: new Uint8Array(24 * 16 * 4).fill(value),
})) as TerminalImageSource[]
const stderr = new Writable({ write(_chunk: unknown, _encoding: BufferEncoding, done: () => void) { done() } })

const tree = (source: TerminalImageSource | null, tick = 0) => <AlternateScreen>
  <Box width={COLS} height={ROWS} flexDirection="column">
    <Text>HEADER {tick}</Text>
    <Text> </Text>
    {source === null
      ? <Text>no image here</Text>
      : <Box height={4} flexShrink={0}>
          <Image source={source} width={12} height={4} presentation="transcript" alt="pic"><Text>LOADING</Text></Image>
        </Box>}
    <Text> </Text>
    <Text>PROMPT</Text>
  </Box>
</AlternateScreen>

// xterm replays the app's byte stream so recovery can be asserted on a real
// screen model. Sixel payloads are swallowed by the DCS handler — this script is
// about cells, not pixels.
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
let tick = 0
const app = await render(tree(shades[0]!, tick), {
  stdin: input, stdout: output, stderr, exitOnCtrlC: false, patchConsole: false, terminalImages: true,
})
const ink = instances.get(output) as unknown as {
  sixelGraphicsManager: { invalidateAll(): void }
}
/** Repaint the same image geometry: invalidate, then flush a frame. */
function repaintSameGeometry(source: TerminalImageSource): void {
  ink.sixelGraphicsManager.invalidateAll()
  app.rerender(tree(source, ++tick))
}

try {
  // ── A. the probe rides inside the frame, before the park CUP ──────────────
  await until(() => output.count('\x1bP0;1;q') === 1, 'A1: the image paints as one Sixel payload')
  await until(() => output.count('\x1b[?6n') === 1, 'A2: the graphics frame probes the cursor')
  assert.match(output.text(), /\x1bP0;1;q[\s\S]*\x1b\\\x1b\[\?6n\x1b\[\d+;1H/u,
    'A3: the probe sits between the payload and the park CUP')
  await replay(output)
  const clears = output.count('\x1b[2J')
  await delay(200)
  assert.equal(output.count('\x1b[2J'), clears, 'A4: a healthy payload must not clear the screen')

  // ── B. the learned baseline repeats on a same-geometry repaint ────────────
  repaintSameGeometry(shades[0]!)
  await until(() => output.count('\x1b[?6n') === 2, 'B1: the repaint probes again')
  await delay(200)
  assert.equal(output.count('\x1b[2J'), clears, 'B2: a repeated healthy position must not clear the screen')

  // ── C. a cut payload reports a far-away cursor → heal ─────────────────────
  output.cutNextPayload = true
  const mark = output.chunks.length
  repaintSameGeometry(shades[0]!)
  await until(() => output.leaked !== '', 'C1: the fake terminal leaked payload text')
  await until(() => output.count('\x1b[2J', mark) > 0, 'C2: the cut payload clears the screen')
  const healed = output.text(mark)
  const afterErase = healed.slice(healed.indexOf('\x1b[2J'))
  assert.ok(afterErase.includes('HEADER'), 'C3: the healed frame repaints the whole model')
  assert.ok(afterErase.includes('\x1bP0;1;q'), 'C4: the healed frame re-emits the image')
  await replay(output)
  assert.ok(screenText().includes('HEADER'), 'C5: the repaint restored the frame content')

  // ── D. the breaker bounds repeats instead of clearing every frame ─────────
  for (let round = 0; round < 6; round++) {
    output.cutNextPayload = true
    repaintSameGeometry(shades[0]!)
    await delay(150)
  }
  await delay(400)
  const settled = output.count('\x1b[2J')
  const heals = settled - clears
  assert.ok(heals >= 2, `D1: repeated leaks keep healing (${heals})`)
  assert.ok(heals <= BURST, `D2: the breaker bounds heals (${heals} > ${BURST})`)
  const probes = output.count('\x1b[?6n')
  await delay(300)
  assert.equal(output.count('\x1b[2J'), settled, 'D3: the muted check stops clearing')
  assert.equal(output.count('\x1b[?6n'), probes, 'D4: the muted check stops probing')

  // One Ink instance at a time: a second live instance in the same process
  // starves this one (its frames never reach the fake terminal), so the app
  // under test is retired before the next phase mounts its own.
  output.isTTY = false
  app.unmount()
  appAlive = false

  // ── E. frames without graphics never probe ────────────────────────────────
  const quietInput = new Input()
  const quietOutput = new Output(quietInput)
  const quiet = await render(tree(null, 0), {
    stdin: quietInput, stdout: quietOutput, stderr, exitOnCtrlC: false, patchConsole: false, terminalImages: true,
  })
  try {
    await delay(300)
    quiet.rerender(tree(null, 1))
    await delay(400)
    assert.ok(quietOutput.chunks.length > 1, 'E1: the quiet app really renders frames')
    assert.equal(quietOutput.count('\x1b[?6n'), 0, 'E2: text-only frames never probe the cursor')
    // Positive control: the absence above must mean "no graphics", not "this app
    // never renders" — a starved second instance would pass vacuously.
    quiet.rerender(tree(shades[1]!, 2))
    await until(() => quietOutput.count('\x1bP0;1;q') === 1, 'E3: the same app paints once it has an image')
    await until(() => quietOutput.count('\x1b[?6n') === 1, 'E4: a graphics frame does probe the cursor')
  } finally {
    quietOutput.isTTY = false
    quiet.unmount()
  }
} finally {
  output.isTTY = false
  if (appAlive) app.unmount()
}

console.log('Sixel cursor self-heal: in-frame probe placement, learned baseline, cut-payload recovery, breaker and no-graphics silence passed')
