/**
 * The header maid portrait floats transparent (fake Windows Terminal).
 *
 * The dsh-tui.whaleGirl setting renders the author's transparent-background
 * PNG through the terminal image protocols. The contract pinned here,
 * against the same fake Windows Terminal the inline-math probe uses (DA1
 * "?61;4;...c" selects Sixel; WT's default conformance honours background
 * select 1, so an unbacked raster really is transparent):
 * - the portrait reaches the frame as a transcript placement with
 *   transparent: true and no background — Sixel paints only her pixels
 *   and the terminal background/wallpaper shows through around her
 *   silhouette;
 * - the placement honors the caller's cell budget (a non-empty box);
 * - Kitty fitting enlarges the artwork into the box's physical pixels,
 *   keeping the transparent surround and the body's colours (#1381);
 * - a fake HiDPI Ghostty receives those pixels through the real renderer
 *   after cell-size probing, in both ordinary and narrow windows.
 *
 * Run: node --import tsx/esm scripts/verify-maid-portrait-transparent.tsx
 */
process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_LANG = 'en'

import assert from 'node:assert/strict'
import { PassThrough, Writable } from 'node:stream'
import { inflateSync } from 'node:zlib'
import React from 'react'
import { AlternateScreen, Box, render } from '../src/ui.js'
import { MaidPortrait } from '../src/components/maidPortrait.js'
import { ThemeProvider } from '../src/components/design-system/ThemeProvider.js'
import instances from '../src/ink/instances.js'
import { fitTerminalImageSource } from '../src/ink/terminal-image.js'
import type { TerminalImagePlacement, TerminalImageSource } from '../src/ink/terminal-image.js'
import { settled } from './lib/term-test.mjs'

// A stand-in for the trimmed whale-girl art: fully transparent surround
// (the trimmed canvas margins), opaque body, and a soft anti-aliased edge —
// the exact alpha profile the portrait ships with.
const W = 64, H = 64
const data = new Uint8Array(W * H * 4)
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const inside = x >= 16 && x < 48 && y >= 8 && y < 56
    const edge = inside && (x < 19 || x >= 45 || y < 11 || y >= 53)
    const alpha = inside ? (edge ? 128 : 255) : 0
    const i = (y * W + x) * 4
    data[i] = 240; data[i + 1] = 200; data[i + 2] = 210; data[i + 3] = alpha
  }
}
const portrait: TerminalImageSource = { data, width: W, height: H }

class Input extends PassThrough {
  isTTY = true
  setRawMode(): this { return this }
  ref(): this { return this }
  unref(): this { return this }
}
class Output extends Writable {
  isTTY = true
  columns = 80
  rows = 24
  data = ''
  _write(chunk: unknown, _encoding: BufferEncoding, done: () => void): void {
    const text = String(chunk)
    this.data += text
    const reply = text === '\x1b[c' ? '\x1b[?61;4;28c'
      : text === '\x1b[?80$p' ? '\x1b[?80;1$y'
        : text === '\x1b[16t' ? '\x1b[6;20;10t'
          : text === '\x1b[14t' ? '\x1b[4;400;600t'
            : /^\x1b\]11;\?/.test(text) ? '\x1b]11;rgb:ffff/ffff/ffff\x1b\\' : ''
    if (reply) queueMicrotask(() => input.write(reply))
    done()
  }
}
const input = new Input()
const output = new Output()
const stderr = new Writable({ write(_chunk: unknown, _encoding: BufferEncoding, done: () => void): void { done() } })
const app = await render(
  <AlternateScreen>
    <ThemeProvider theme="light">
      <Box width={80} flexDirection="row" justifyContent="center">
        <MaidPortrait source={portrait} maxColumns={40} maxRows={15} presentation="transcript" />
      </Box>
    </ThemeProvider>
  </AlternateScreen>,
  {
    stdin: input as unknown as NodeJS.ReadStream,
    stdout: output as unknown as NodeJS.WriteStream,
    stderr,
    exitOnCtrlC: false,
    patchConsole: false,
    terminalImages: true,
  },
)
const host = instances.get(output as unknown as NodeJS.WriteStream) as unknown as {
  frontFrame: { images?: readonly TerminalImagePlacement[] }
}
const placements = (): readonly TerminalImagePlacement[] => host.frontFrame.images ?? []
assert.ok(await settled(() => placements().some(value => value.presentation === 'transcript')),
  'the portrait reaches the frame after capability probing')
const placement = placements().find(value => value.presentation === 'transcript')
assert.ok(placement !== undefined, 'the portrait reaches the frame as a transcript placement')
assert.equal(placement.transparent, true, 'the portrait floats transparent — Sixel paints only her pixels')
assert.equal(placement.background, undefined, 'no backing colour slab behind her')
assert.ok(placement.columns > 0 && placement.rows > 0, 'the placement honors the cell budget')
const fitted = fitTerminalImageSource(portrait, placement.columns, placement.rows,
  { width: 10, height: 20 }, 'transcript')
assert.deepEqual([fitted.width, fitted.height], [placement.columns * 10, placement.rows * 20],
  'Kitty receives the physical pixels of the portrait slot')
// This square fixture occupies a 300x300 slot. Its opaque/soft body spans
// half the source width and three quarters of its height, so enlargement
// must paint well beyond the native 64x64 source while leaving the corners empty.
const center = (Math.floor(fitted.height / 2) * fitted.width + Math.floor(fitted.width / 2)) * 4
assert.deepEqual([...fitted.data.subarray(center, center + 4)], [240, 200, 210, 255])
assert.equal(fitted.data[3], 0, 'transparent surround must not turn into a backing slab')
const bodyEdge = (Math.floor(fitted.height / 2) * fitted.width + Math.floor(fitted.width * 0.28)) * 4
assert.deepEqual([...fitted.data.subarray(bodyEdge, bodyEdge + 4)], [240, 200, 210, 128],
  'enlarged soft edges retain their colours without dark fringes')
assert.equal(fitted.data[(Math.floor(fitted.height * 0.8) * fitted.width + Math.floor(fitted.width / 2)) * 4 + 3], 255,
  'the body must fill the slot beyond its native pixel extent')
await app.unmount()

// Exercise the actual MaidPortrait -> cell-size probe -> Kitty upload chain.
// The source is deliberately smaller than a 36x76 HiDPI cell box, as in #1381.
for (const columns of [80, 20]) {
  const kittyInput = new Input()
  class KittyOutput extends Writable {
    isTTY = true
    columns = columns
    rows = 24
    data = ''
    _write(chunk: unknown, _encoding: BufferEncoding, done: () => void): void {
      const text = String(chunk)
      this.data += text
      const reply = text.includes('a=q,') ? '\x1b_Gi=31;OK\x1b\\'
        : text === '\x1b[16t' ? '\x1b[6;76;36t'
          : text === '\x1b[14t' ? `\x1b[4;${this.rows * 76};${this.columns * 36}t`
            : text === '\x1b[>0q' ? '\x1bP>|ghostty(1.3.1)\x1b\\'
              : text === '\x1b[c' ? '\x1b[?62;4c' : ''
      if (reply) queueMicrotask(() => kittyInput.write(reply))
      done()
    }
  }
  const kittyOutput = new KittyOutput()
  const kittyApp = await render(
    <AlternateScreen>
      <ThemeProvider theme="light">
        <Box width={columns} flexDirection="row" justifyContent="center">
          <MaidPortrait source={portrait} maxColumns={Math.min(40, columns)} maxRows={11} presentation="transcript" />
        </Box>
      </ThemeProvider>
    </AlternateScreen>,
    {
      stdin: kittyInput as unknown as NodeJS.ReadStream,
      stdout: kittyOutput as unknown as NodeJS.WriteStream,
      stderr,
      exitOnCtrlC: false,
      patchConsole: false,
      terminalImages: true,
    },
  )
  try {
    const [width, height] = columns === 80 ? [828, 836] : [720, 684]
    assert.ok(await settled(() => kittyOutput.data.includes(`a=t,t=d,f=32,s=${width},v=${height},`)),
      `${columns} columns: the real upload must use the probed HiDPI pixels`)
    const upload = kittyOutput.data.slice(kittyOutput.data.lastIndexOf('\x1b_Ga=t,'))
    const chunks = [...upload.matchAll(/\x1b_G([^;]+);([^\x1b]*)\x1b\\/gu)]
    const encoded = Buffer.from(chunks.map(chunk => chunk[2]!).join(''), 'base64')
    const pixels = chunks[0]![1]!.includes('o=z') ? inflateSync(encoded) : encoded
    assert.equal(pixels.byteLength, width * height * 4)
    assert.equal(pixels[3], 0, 'the uploaded surround remains transparent')
    const center = (Math.floor(height / 2) * width + Math.floor(width / 2)) * 4
    assert.deepEqual([...pixels.subarray(center, center + 4)], [240, 200, 210, 255],
      'the uploaded artwork retains its opaque interior')
    assert.equal(pixels[(Math.floor(height * 0.8) * width + Math.floor(width / 2)) * 4 + 3], 255,
      'the uploaded artwork fills the box beyond its native extent')
  } finally {
    await kittyApp.unmount()
  }
}
console.log('verify-maid-portrait-transparent: all assertions passed')
