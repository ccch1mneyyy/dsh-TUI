/**
 * Character-cell image fallback: the pure grid builder, the renderer's
 * graphics status, and the transcript thumbnail / preview card that paint
 * half-block or ASCII cells where terminal graphics cannot.
 *
 * Run: node --import tsx/esm scripts/verify-image-text-fallback.tsx
 */
process.env.DSH_TUI_LANG = 'en'
process.env.FORCE_COLOR = '0'

import assert from 'node:assert/strict'
import { PassThrough, Writable } from 'node:stream'
import React from 'react'
import chalk from 'chalk'
import xterm from '@xterm/headless'
import type { TerminalImageSource } from '../src/ink/terminal-image.js'
import type { TranscriptImage } from '../src/dsh-adapter/transcript-images.js'
import type { TerminalImageStatus } from '../src/ui.js'
import { loadSharp } from '../src/dsh-adapter/sharp.js'
import { kittyGraphics } from '../src/ink/terminal-querier.js'
import { stringWidth } from '../src/ink/stringWidth.js'
import { settled, viewportLines } from './lib/term-test.mjs'

const { Terminal: XTerm } = xterm
const [
  { render, AlternateScreen, Box, Text, useTerminalImages, useTerminalImageStatus },
  { buildImageTextGrid, imageTextMode, isLightBackground },
  { clearTranscriptImageCacheForTests, TranscriptImages },
  { ImagePreviewOverlay },
] = await Promise.all([
  import('../src/ui.js'),
  import('../src/components/messages/imageTextFallback.js'),
  import('../src/components/messages/TranscriptImages.js'),
  import('../src/components/ImagePreviewOverlay.js'),
])

let passed = 0
function check(name: string, ok: boolean, detail = ''): void {
  assert.ok(ok, detail === '' ? name : `${name}\n${detail}`)
  passed++
}

/** Build an RGBA source from a per-pixel colour function. */
function source(width: number, height: number, pixel: (x: number, y: number) => readonly [number, number, number, number]): TerminalImageSource {
  const data = new Uint8Array(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) data.set(pixel(x, y), (y * width + x) * 4)
  }
  return { data, width, height }
}

const RED = [220, 40, 40, 255] as const
const BLUE = [40, 60, 220, 255] as const
const CLEAR = [0, 0, 0, 0] as const

type Grid = ReturnType<typeof buildImageTextGrid>
const rowText = (grid: Grid, row: number): string => grid[row]!.map(run => run.text).join('')
const rowWidth = (grid: Grid, row: number): number => stringWidth(rowText(grid, row))

// --- pure grid builder ------------------------------------------------------
{
  const grid = buildImageTextGrid(source(2, 2, (_x, y) => y === 0 ? RED : BLUE), 2, 1, 'color')
  check('color: one cell stacks the top pixel (fg) over the bottom pixel (bg)',
    grid.length === 1 && rowText(grid, 0) === '▀▀' && grid[0]!.length === 1 &&
      grid[0]![0]!.color === 'rgb(220,40,40)' && grid[0]![0]!.backgroundColor === 'rgb(40,60,220)',
    JSON.stringify(grid))
}
{
  const grid = buildImageTextGrid(source(3, 2, (x, y) => x === 0 ? (y === 0 ? CLEAR : BLUE) : x === 1 ? CLEAR : (y === 0 ? RED : CLEAR)), 3, 1, 'color')
  check('color: a transparent half becomes ▄ / blank / ▀ with no background',
    rowText(grid, 0) === '▄ ▀' &&
      grid[0]![0]!.color === 'rgb(40,60,220)' && grid[0]![0]!.backgroundColor === undefined &&
      grid[0]![1]!.color === undefined && grid[0]![2]!.backgroundColor === undefined,
    JSON.stringify(grid))
}
{
  // Four pixels wide, one tall, into a 4×2 cell box (a 4×4 pixel grid): the
  // strip lands on pixel row 1 — the lower half of the first cell row.
  const grid = buildImageTextGrid(source(4, 1, () => RED), 4, 2, 'color')
  check('color: aspect fit letterboxes into blank cells',
    rowText(grid, 0) === '▄▄▄▄' && rowText(grid, 1) === '    ', JSON.stringify(grid))
}
{
  // 2×4 into one cell (1×2 pixels): each half averages a 2×2 checker block.
  const checker = source(2, 4, (x, y) => (x + y) % 2 === 0 ? [0, 0, 0, 255] : [255, 255, 255, 255])
  const grid = buildImageTextGrid(checker, 1, 1, 'color')
  check('color: each target pixel area-averages the source pixels it covers',
    grid[0]![0]!.color === 'rgb(128,128,128)' && grid[0]![0]!.backgroundColor === 'rgb(128,128,128)',
    JSON.stringify(grid))
}
{
  // A dark-grey ramp (30..61) is invisible on a plain 0..255 mapping; the
  // percentile stretch spreads it over the whole glyph ramp.
  const gradient = source(32, 2, x => [30 + x, 30 + x, 30 + x, 255])
  const dark = rowText(buildImageTextGrid(gradient, 32, 1, 'ascii'), 0)
  check('ascii: percentile stretch spans the ramp on a low-contrast image',
    dark.startsWith(' ') && dark.endsWith('@'), JSON.stringify(dark))
  const light = rowText(buildImageTextGrid(gradient, 32, 1, 'ascii', true), 0)
  check('ascii: a light terminal background inverts the ramp',
    light.startsWith('@') && light.endsWith(' '), JSON.stringify(light))
  const flat = rowText(buildImageTextGrid(source(4, 2, () => [128, 128, 128, 255]), 4, 1, 'ascii'), 0)
  check('ascii: a flat image is not stretched into noise', flat === '++++', JSON.stringify(flat))
}
{
  const image = source(37, 23, (x, y) => [(x * 7) % 256, (y * 11) % 256, 90, 255])
  for (const [columns, rows] of [[24, 12], [10, 5], [7, 3], [1, 1], [61, 20]] as const) {
    for (const mode of ['color', 'ascii'] as const) {
      const grid = buildImageTextGrid(image, columns, rows, mode)
      check(`grid ${mode} ${columns}×${rows}: exactly rows × columns cells`,
        grid.length === rows && grid.every((_runs, row) => rowWidth(grid, row) === columns),
        grid.map((_runs, row) => rowText(grid, row)).join('\n'))
    }
  }
  const first = buildImageTextGrid(image, 24, 12, 'color')
  check('grid: memoized per source buffer and box',
    buildImageTextGrid(image, 24, 12, 'color') === first && buildImageTextGrid(image, 23, 12, 'color') !== first)
}
{
  const previous = process.env.DSH_TUI_IMAGE_TEXT_FALLBACK
  const level = chalk.level
  try {
    for (const off of ['0', 'false', 'OFF', ' no ']) {
      process.env.DSH_TUI_IMAGE_TEXT_FALLBACK = off
      check(`mode: DSH_TUI_IMAGE_TEXT_FALLBACK=${JSON.stringify(off)} turns the fallback off`, imageTextMode() === 'off')
    }
    delete process.env.DSH_TUI_IMAGE_TEXT_FALLBACK
    chalk.level = 0
    check('mode: no colour support uses ASCII', imageTextMode() === 'ascii')
    chalk.level = 2
    check('mode: colour support uses half-blocks', imageTextMode() === 'color')
  } finally {
    chalk.level = level
    if (previous === undefined) delete process.env.DSH_TUI_IMAGE_TEXT_FALLBACK
    else process.env.DSH_TUI_IMAGE_TEXT_FALLBACK = previous
  }
  check('background: light and dark hex backgrounds are told apart',
    isLightBackground('#f5f5f5') && !isLightBackground('#1e1e1e') && !isLightBackground(undefined) && !isLightBackground('red'))
}

// --- renderer status and rendered surfaces ---------------------------------
const COLS = 80
const ROWS = 30

class FakeStdout extends Writable {
  columns = COLS
  rows = ROWS
  isTTY = true
  output = ''
  constructor(private readonly terminal: InstanceType<typeof XTerm>) { super() }
  _write(chunk: unknown, _encoding: BufferEncoding, callback: () => void): void {
    this.output += String(chunk)
    this.terminal.write(String(chunk), callback)
  }
}
class FakeStderr extends Writable {
  isTTY = true
  _write(_chunk: unknown, _encoding: BufferEncoding, callback: () => void): void { callback() }
}
class FakeStdin extends PassThrough {
  isTTY = true
  setRawMode(): this { return this }
  override ref(): this { return this }
  override unref(): this { return this }
}

const GRAPHICS_ENV = ['TMUX', 'STY', 'DSH_TUI_ACCESSIBILITY', 'DSH_TUI_DISABLE_TERMINAL_IMAGES', 'DSH_TUI_IMAGE_PROTOCOL', 'DSH_TUI_IMAGE_TEXT_FALLBACK']

async function withTerminal(
  tree: React.ReactElement,
  options: {
    readonly env?: Readonly<Record<string, string>>
    readonly altScreen?: boolean
    readonly terminalImages?: boolean
    /** Terminal reply to the capability probe; omitted = never answered. */
    readonly reply?: string
  },
  check: (screen: () => string, rawOutput: () => string) => Promise<void>,
): Promise<void> {
  const previous = GRAPHICS_ENV.map(name => process.env[name])
  for (const name of GRAPHICS_ENV) delete process.env[name]
  Object.assign(process.env, options.env ?? {})
  const terminal = new XTerm({ cols: COLS, rows: ROWS, scrollback: 0, allowProposedApi: true })
  const stdout = new FakeStdout(terminal)
  const stdin = new FakeStdin()
  const app = await render(options.altScreen === true ? <AlternateScreen>{tree}</AlternateScreen> : tree, {
    stdin: stdin as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
    stderr: new FakeStderr() as NodeJS.WriteStream,
    exitOnCtrlC: false,
    patchConsole: false,
    terminalImages: options.terminalImages ?? true,
  })
  try {
    if (options.reply !== undefined) {
      assert.ok(await settled(() => stdout.output.includes(kittyGraphics(31).request)), 'the capability probe starts')
      stdin.write(options.reply)
    }
    await check(() => viewportLines(terminal, ROWS).join('\n'), () => stdout.output)
  } finally {
    await app.unmount()
    terminal.dispose()
    GRAPHICS_ENV.forEach((name, index) => {
      if (previous[index] === undefined) delete process.env[name]
      else process.env[name] = previous[index]
    })
  }
}

// Kitty OK + cell/window pixels + DA1 sentinels, as the transcript regression answers.
const KITTY_REPLY = '\x1b_Gi=31;OK\x1b\\\x1b[6;20;10t\x1b[4;720;720t\x1b[?61;4c\x1b[?61;4c\x1b[?61;4c'
// No Kitty answer and a DA1 without Sixel (4): the probe settles on none.
const NO_GRAPHICS_REPLY = '\x1b[?62;22c\x1b[?62;22c\x1b[?62;22c'

function StatusProbe({ log }: { readonly log: TerminalImageStatus[] }): React.ReactNode {
  useTerminalImages(true)
  const status = useTerminalImageStatus()
  React.useLayoutEffect(() => { log.push(status) }, [status])
  return <Text>status:{status}</Text>
}

async function statusRun(options: Parameters<typeof withTerminal>[1]): Promise<TerminalImageStatus[]> {
  const log: TerminalImageStatus[] = []
  await withTerminal(<StatusProbe log={log} />, options, async () => {
    await settled(() => log.length > 0 && log.at(-1) !== 'pending')
  })
  return log
}

{
  const log = await statusRun({ altScreen: true, reply: KITTY_REPLY })
  check('status: a Kitty terminal goes pending → ready and never reports unsupported',
    log.at(-1) === 'ready' && !log.includes('unsupported') && log[0] === 'pending', JSON.stringify(log))
}
{
  const log = await statusRun({ altScreen: true, reply: NO_GRAPHICS_REPLY })
  check('status: a probe that finds no protocol settles on unsupported',
    log.at(-1) === 'unsupported' && !log.includes('ready'), JSON.stringify(log))
}
{
  const log = await statusRun({ altScreen: true, env: { TMUX: '/tmp/tmux-1/default,1,0' } })
  check('status: tmux is unsupported from the first render', log[0] === 'unsupported' && log.length === 1, JSON.stringify(log))
}
{
  const log = await statusRun({ altScreen: true, env: { DSH_TUI_IMAGE_PROTOCOL: 'none' } })
  check('status: DSH_TUI_IMAGE_PROTOCOL=none is unsupported', log.at(-1) === 'unsupported', JSON.stringify(log))
}
{
  const log = await statusRun({})
  check('status: the inline main screen settles on unsupported after its first frame',
    log[0] === 'pending' && log.at(-1) === 'unsupported', JSON.stringify(log))
}
for (const [name, options] of [
  ['terminalImages: false', { altScreen: true, terminalImages: false }],
  ['DSH_TUI_DISABLE_TERMINAL_IMAGES', { altScreen: true, env: { DSH_TUI_DISABLE_TERMINAL_IMAGES: '1' } }],
  ['DSH_TUI_ACCESSIBILITY', { altScreen: true, env: { DSH_TUI_ACCESSIBILITY: '1' } }],
] as const) {
  const log = await statusRun(options)
  check(`status: ${name} reports disabled`, log.at(-1) === 'disabled', JSON.stringify(log))
}

const sharp = await loadSharp()
if (sharp === undefined) {
  console.log(`SKIP rendered fallback cases: optional sharp decoder is unavailable (${passed} pure checks passed)`)
  process.exit(0)
}

// Top half red, bottom half blue.
const png = new Uint8Array(await sharp(Buffer.from(source(16, 16, (_x, y) => y < 8 ? RED : BLUE).data), {
  raw: { width: 16, height: 16, channels: 4 },
}).png().toBuffer())

function image(id: string, name: string): TranscriptImage & { reads: number } {
  const fixture = {
    id,
    width: 16,
    height: 16,
    name,
    mediaType: 'image/png',
    reads: 0,
    async read(): Promise<Uint8Array> {
      fixture.reads++
      return png
    },
  }
  return fixture
}

const TMUX = { TMUX: '/tmp/tmux-1/default,1,0' }
const level = chalk.level
try {
  chalk.level = 3
  {
    clearTranscriptImageCacheForTests()
    const fixture = image('tmux-color', 'viewport.png')
    await withTerminal(
      <Box flexDirection="column"><TranscriptImages images={[fixture]} indent={0} /><Text>after-gallery</Text></Box>,
      { altScreen: true, env: TMUX },
      async (screen, rawOutput) => {
        check('thumbnail: tmux paints a 24×12 half-block grid',
          await settled(() => screen().split('\n').slice(0, 12).every(line => line.startsWith('▀'.repeat(24)))), screen())
        check('thumbnail: the half-blocks carry truecolour fg/bg', rawOutput().includes('38;2;220;40;40') && rawOutput().includes('48;2;40;60;220'))
        check('thumbnail: the label sits on the row under the cells', screen().split('\n')[12]!.includes('[Image · viewport.png]'), screen())
        check('thumbnail: the row after the gallery follows the label row', screen().split('\n')[13]!.startsWith('after-gallery'), screen())
        check('thumbnail: the fallback decodes once and never emits graphics', fixture.reads === 1 && !rawOutput().includes('\x1b_G'))
      },
    )
  }
  {
    clearTranscriptImageCacheForTests()
    const fixture = image('kitty', 'kitty.png')
    await withTerminal(
      <TranscriptImages images={[fixture]} indent={0} />,
      { altScreen: true, reply: KITTY_REPLY },
      async (screen, rawOutput) => {
        check('thumbnail: a Kitty terminal places graphics', await settled(() => rawOutput().includes('\x1b_Ga=')), rawOutput().slice(-400))
        check('thumbnail: a Kitty terminal never paints half-block cells', !screen().includes('▀') && !rawOutput().includes('▀'))
      },
    )
  }
  for (const [name, env] of [
    ['DSH_TUI_IMAGE_TEXT_FALLBACK=0', { ...TMUX, DSH_TUI_IMAGE_TEXT_FALLBACK: '0' }],
    ['DSH_TUI_ACCESSIBILITY', { ...TMUX, DSH_TUI_ACCESSIBILITY: '1' }],
    ['DSH_TUI_DISABLE_TERMINAL_IMAGES', { ...TMUX, DSH_TUI_DISABLE_TERMINAL_IMAGES: '1' }],
  ] as const) {
    clearTranscriptImageCacheForTests()
    const fixture = image(`off-${name}`, 'label.png')
    await withTerminal(<TranscriptImages images={[fixture]} indent={0} />, { altScreen: true, env }, async screen => {
      check(`thumbnail: ${name} keeps the label-only box`, await settled(() => screen().includes('[Image · label.png]')), screen())
      check(`thumbnail: ${name} never reads pixels or paints cells`, fixture.reads === 0 && !screen().includes('▀'))
    })
  }
  chalk.level = 0
  {
    clearTranscriptImageCacheForTests()
    const fixture = image('tmux-ascii', 'ascii.png')
    await withTerminal(<TranscriptImages images={[fixture]} indent={0} />, { altScreen: true, env: TMUX }, async screen => {
      // Red is the brighter half (luminance 77 vs 64): top rows map to the
      // dense end of the stretched ramp, bottom rows to the blank end.
      check('thumbnail: without colour the cells are a contrast-stretched ASCII ramp',
        await settled(() => screen().split('\n')[0]!.startsWith('@'.repeat(24)) && screen().split('\n')[11]!.trim() === ''
          && screen().split('\n')[12]!.includes('[Image · ascii.png]')), screen())
    })
  }
  chalk.level = 3
  {
    clearTranscriptImageCacheForTests()
    const fixture = image('preview-card', 'card.png')
    await withTerminal(
      <Box width={COLS} height={ROWS}><ImagePreviewOverlay image={fixture} onClose={() => {}} /></Box>,
      { altScreen: true, env: TMUX },
      async screen => {
        check('preview: the modal card paints half-block cells where graphics cannot',
          await settled(() => screen().split('\n').filter(line => line.includes('▀▀▀▀▀▀▀▀')).length >= 10), screen())
        check('preview: the card keeps its title', screen().includes('card.png'), screen())
        check('preview: the card decodes through the thumbnail tier once', fixture.reads === 1, String(fixture.reads))
      },
    )
  }
} finally {
  chalk.level = level
}

console.log(`Image text fallback regression passed (${passed} checks)`)
