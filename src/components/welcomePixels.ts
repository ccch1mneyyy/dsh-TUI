/** Native square-pixel artwork. Empty cells inherit the terminal background. */
import { renderSpriteRows } from './Whale.js'
import { WHALE_FRAMES } from './whaleFrames.js'
import type { WordmarkStyle } from './wordmark.js'

const palette = {
  D: [20, 38, 96], B: [78, 111, 255], L: [190, 225, 255],
  W: [255, 255, 255], H: [204, 51, 153], Z: [128, 128, 128],
  r: [255, 83, 111], o: [255, 165, 74], y: [255, 226, 92],
  g: [76, 211, 165], b: [75, 190, 248], v: [159, 113, 245],
} satisfies Record<string, readonly [number, number, number]>
const glyphs: Record<string, readonly string[]> = {
  D: ['11110','10001','10001','10001','11110'], E: ['11111','10000','11110','10000','11111'],
  P: ['11110','10001','11110','10000','10000'], S: ['01111','10000','01110','00001','11110'],
  K: ['10001','10010','11100','10010','10001'], H: ['10001','10001','11111','10001','10001'],
  A: ['01110','10001','11111','10001','10001'], R: ['11110','10001','11110','10010','10001'],
  N: ['10001','11001','10101','10011','10001'],
  l: ['1000','1000','1000','1000','1111'], e: ['1111','1000','1110','1000','1111'],
  p: ['1110','1001','1110','1000','1000'],
}
const word = (text: string, gap: number): string[] => Array.from({ length: 5 }, (_, y) =>
  [...text].map(c => glyphs[c][y]).join('0'.repeat(gap)))

/** Five-pixel letters and their matching whale motif, packed two pixels per row. */
export function pixelWordmark(style: WordmarkStyle, frameIndex: number): readonly string[] {
  const width = style === 'deepsleep' ? 53 : 54
  const grid = Array.from({ length: 26 }, () => Array<string>(width).fill('.'))
  const put = (x: number, y: number, c: string): void => {
    if (y >= 0 && y < grid.length && x >= 0 && x < width) grid[y][x] = c
  }
  const title = style === 'deepsleep'
    ? word('DEEPS', 2).map((row, y) => row + '0' + word('leep', 1)[y])
    : word('DEEPSEEK', 2)
  for (const [y, row] of title.entries()) for (const [x, bit] of [...row].entries()) {
    if (bit === '1') put(x, 12 + y, style === 'deepsleep' && x >= 34 ? 'L' : 'B')
  }
  for (const [y, row] of word('HARNESS', 3).entries()) for (const [x, bit] of [...row].entries()) {
    if (bit === '1') put(x, 21 + y, 'B')
  }
  const frame = WHALE_FRAMES[frameIndex] ?? WHALE_FRAMES[0]
  const motif = frameIndex >= 17 ? 'Z' : frameIndex >= 14 && frameIndex <= 16 ? 'H'
    : frameIndex >= 4 && frameIndex <= 9 ? 'L' : undefined
  if (motif) {
    for (const [y, row] of frame.rows.entries()) for (const [x, c] of [...row].entries()) {
      if (c === motif && (motif !== 'L' || y < 7)) put(x + (motif === 'H' ? 22 : 18), y + 1, c)
    }
  }
  if (style === 'deepsleep') {
    for (const [y, row] of ['1111','0001','0010','1111'].entries()) {
      for (const [x, c] of [...row].entries()) if (c === '1') put(49 + x, y, 'Z')
    }
  }
  return renderSpriteRows(grid.map(row => row.join('')), palette)
}

/** Rainbow scene is drawn on its own grid; never downsample a whole-page PNG. */
export function rainbowPixels(columns: number, light: boolean): readonly string[] {
  const width = Math.max(40, Math.min(110, Math.floor(columns)))
  const grid = Array.from({ length: 30 }, () => Array<string>(width).fill('.'))
  const put = (x: number, y: number, c: string): void => {
    if (y >= 0 && y < grid.length && x >= 0 && x < width) grid[y][x] = c
  }
  for (const [y, row] of WHALE_FRAMES[0].rows.entries()) for (const [x, c] of [...row].entries()) {
    if (c !== '.') put(x, y + 3, c)
  }
  for (let x = 37; x < width; x++) {
    const wave = Math.floor(x / 5) % 2
    for (const [band, c] of [...'roygbv'].entries()) {
      put(x, 16 + wave + band * 2, c)
      put(x, 17 + wave + band * 2, c)
    }
  }
  const scale = width >= 94 ? 3 : width >= 76 ? 2 : 1
  const start = 39 + Math.max(0, Math.floor((width - 39 - 17 * scale) / 2))
  const letters = word('DSH', 1)
  for (const [y, row] of letters.entries()) for (const [x, c] of [...row].entries()) {
    if (c !== '1') continue
    for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) {
      const filled = (px: number, py: number): boolean => letters[Math.floor(py / scale)]?.[Math.floor(px / scale)] === '1'
      const px = x * scale + dx
      const py = y * scale + dy
      if (scale === 3 && [[-1, 0], [1, 0], [0, -1], [0, 1]].every(([a, b]) => filled(px + a, py + b))) continue
      put(start + x * scale + dx, y * scale + dy, light ? 'D' : 'L')
    }
  }
  for (const [x, y] of [[4, 3], [29, 1], [44, 1], [width - 5, 6], [7, 27]]) {
    for (const [dx, dy] of [[0, 0], [-1, 0], [1, 0], [0, -1], [0, 1]]) put(x + dx, y + dy, light ? 'D' : 'L')
  }
  return renderSpriteRows(grid.map(row => row.join('')), palette)
}
