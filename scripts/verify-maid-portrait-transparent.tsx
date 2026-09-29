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
 * - the placement honors the caller's cell budget (a non-empty box).
 *
 * Run: node --import tsx/esm scripts/verify-maid-portrait-transparent.tsx
 */
process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_LANG = 'en'

import assert from 'node:assert/strict'
import { PassThrough, Writable } from 'node:stream'
import React from 'react'
import { AlternateScreen, Box, render } from '../src/ui.js'
import { MaidPortrait } from '../src/components/maidPortrait.js'
import { ThemeProvider } from '../src/components/design-system/ThemeProvider.js'
import instances from '../src/ink/instances.js'
import type { TerminalImagePlacement, TerminalImageSource } from '../src/ink/terminal-image.js'

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
const settled = (): boolean => placements().some(value => value.presentation === 'transcript')
const deadline = Date.now() + 10_000
while (!settled() && Date.now() < deadline) {
  await new Promise(resolve => setTimeout(resolve, 20))
}
const placement = placements().find(value => value.presentation === 'transcript')
assert.ok(placement !== undefined, 'the portrait reaches the frame as a transcript placement')
assert.equal(placement.transparent, true, 'the portrait floats transparent — Sixel paints only her pixels')
assert.equal(placement.background, undefined, 'no backing colour slab behind her')
assert.ok(placement.columns > 0 && placement.rows > 0, 'the placement honors the cell budget')
await app.unmount()
console.log('verify-maid-portrait-transparent: all assertions passed')
