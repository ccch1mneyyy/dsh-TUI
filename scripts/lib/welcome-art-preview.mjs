/**
 * Shared capture + raster helpers for the welcome-art previews and the
 * welcome-art regression.
 *
 * `captureWelcomeArt` mounts the real `LogoV2` component in an xterm headless
 * buffer and returns the settled cell grid — exactly what a terminal paints,
 * including the half-block fallback `Image` uses when no graphics protocol is
 * available. `screenSvg` turns that grid into a flat SVG that can be flattened
 * onto a black or a white page.
 */
import { PassThrough, Writable } from 'node:stream'
import React from 'react'
import { kittyImages } from './kitty-capture.mjs'

process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_LANG = 'zh'

// Compiled output, not `src/`: `welcomeImage.ts` resolves its PNGs relative to
// the *package* root (`lib/types/components/` → `assets/welcome/`), so a
// src-tree import would look for the assets two directories too high.
const ui = await import('../../lib/types/ui.js')
const { LogoV2 } = await import('../../lib/types/components/LogoV2.js')
const { WELCOME_ART_MODES } = await import('../../lib/types/components/welcomeArt.js')
const { loadWelcomeArtPair } = await import('../../lib/types/components/welcomeImage.js')
const xterm = await import('@xterm/headless')
const { settle, settled, writeParsed } = await import('../lib/term-test.mjs')

const { Terminal } = xterm.default ?? xterm

class Input extends PassThrough {
  isTTY = true
  setRawMode() { return this }
  ref() { return this }
  unref() { return this }
}

class Output extends Writable {
  isTTY = true
  rows = 40
  writes = []
  constructor(columns) { super(); this.columns = columns }
  _write(chunk, _encoding, done) { this.writes.push(String(chunk)); done() }
}

const MODEL = 'deepseek-v4-flash'
const CWD = 'D:/projects/deepsea'
const TIP = { zh: '输入 /model 切换模型', en: 'Use /model to switch models' }

/** Every mode id, `/settings` order — the numbering the previews use. */
export const MODE_IDS = WELCOME_ART_MODES.map(mode => mode.id)

export function modeOf(id) {
  const mode = WELCOME_ART_MODES.find(entry => entry.id === id)
  if (mode === undefined) throw new Error(`unknown welcome-art id: ${id}`)
  return mode
}

/**
 * Decode a mode's PNGs before the component mounts, so the swap-in repaint
 * lands on the very next effect instead of after a few hundred milliseconds
 * of `sharp` work. Cell modes have nothing to warm.
 */
export async function warmWelcomeArt(id, theme) {
  const mode = modeOf(id)
  if (mode.art === 'image') await loadWelcomeArtPair(mode.whale, mode.wordmark)

}

/**
 * Render one header and read it back cell by cell.
 *
 * The tree is the production one minus the AlternateScreen wrapper: the logo
 * block is what the previews show, and skipping the alternate screen keeps the
 * capture independent of the surrounding layout.
 */
export async function captureWelcomeArt({ welcomeArt, theme, columns = 110, whale = true, graphics = false }) {
  await warmWelcomeArt(welcomeArt, theme)
  const stdout = new Output(columns)
  const stderr = new Output(columns)
  const stdin = new Input()
  const content = React.createElement(ui.ThemeProvider, { theme },
      React.createElement(LogoV2, {
        model: MODEL, effort: 'high', cwd: CWD,
        skipIntro: true, whale, whaleIdle: false, drift: null,
        welcomeArt,
        tip: TIP,
      }))
  const instance = await ui.render(
    graphics ? React.createElement(ui.AlternateScreen, null, content) : content,
    { stdout, stderr, stdin, exitOnCtrlC: false, patchConsole: false },
  )
  const painted = () => stdout.writes.join('').includes(CWD)
  if (!await settled(painted)) {
    throw new Error(`welcome header did not render (${welcomeArt}, ${theme}, ${columns}): ${stderr.writes.join('')}`)
  }
  if (graphics && modeOf(welcomeArt).art === 'image') {
    if (!await settled(() => stdout.writes.join('').includes('a=q'))) throw new Error('Missing graphics probe')
    stdin.write('\x1b_Gi=31;OK\x1b\\\x1b[6;20;10t\x1b[4;800;1100t\x1b[?61;4c\x1b[?61;4c')
    if (!await settled(() => (stdout.writes.join('').match(/\x1b_Ga=p,/g) ?? []).length >= 2)) throw new Error('PNG placements missing')
  } else if (modeOf(welcomeArt).art === 'image') {
    const baseline = stdout.writes.length
    await settle(() => stdout.writes.length > baseline, { timeoutMs: 4000 })
  }
  const output = stdout.writes.join('')
  const graphicsImages = graphics ? await kittyImages(output) : []
  const term = new Terminal({ cols: columns, rows: 40, allowProposedApi: true })
  await writeParsed(term, output)
  // The logo block starts with a blank margin row, so trim leading and
  // trailing empty rows instead of stopping at the first one.
  const rows = []
  for (let y = 0; y < term.buffer.active.length; y++) {
    const line = term.buffer.active.getLine(y)
    const row = []
    for (let x = 0; x < columns; x++) {
      const cell = line?.getCell(x)
      row.push({
        text: cell?.getChars() ?? '',
        width: cell?.getWidth() ?? 1,
        fg: cell?.isFgRGB() ? '#' + cell.getFgColor().toString(16).padStart(6, '0') : null,
        bg: cell?.isBgRGB() ? '#' + cell.getBgColor().toString(16).padStart(6, '0') : null,
        dim: Boolean(cell?.isDim()),
        bold: Boolean(cell?.isBold()),
      })
    }
    rows.push({ row, text: (line?.translateToString(true) ?? '') })
  }
  let first = rows.findIndex(entry => entry.text.trim() !== '')
  if (graphicsImages.length) first = Math.min(first, ...graphicsImages.map(p => p.y))
  let last = rows.length - 1
  while (last >= 0 && rows[last].text.trim() === '') last--
  if (graphicsImages.length) last = Math.max(last, ...graphicsImages.map(p => p.y + p.rows - 1))
  const kept = first < 0 ? [] : rows.slice(first, last + 1)
  stdout.isTTY = false
  await instance.unmount()
  term.dispose()
  return {
    columns,
    theme,
    welcomeArt,
    whale,
    cells: kept.map(entry => entry.row),
    lines: kept.map(entry => entry.text),
    height: kept.length,
    graphicsImages: graphicsImages.map(p => ({ ...p, y: p.y - first })),
  }
}

/**
 * Column band the wordmark occupies: right of the 40-column whale box and its
 * 2-column gap while the whale shows, the full width when it is hidden.
 */
export function markBand(capture) {
  return [capture.whale === false ? 0 : 42, 92]
}

const escape = text => text.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

/** Cell size in the raster: 10×20 px keeps the terminal's ~1:2 cell aspect. */
export const CELL = { width: 10, height: 20 }
const PAD = 20
const CAPTION = 30

/**
 * Raster one capture onto a flat page. The terminal has no background of its
 * own — cells only carry a background where the art paints one — so the page
 * colour is the whole picture of "this art on a dark / light terminal".
 */
export function screenSvg(capture, { background, foreground, caption }) {
  const dark = background === '#000000'
  const width = capture.columns * CELL.width + PAD * 2
  const height = capture.cells.length * CELL.height + PAD * 2 + CAPTION
  const rect = (x, y, w, h, fill) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${fill}" shape-rendering="crispEdges"/>`
  let body = rect(0, 0, width, height, background)
  if (caption !== undefined) {
    body += `<text x="${PAD}" y="${PAD + 18}" fill="${dark ? '#7d8ba1' : '#6b7688'}" font-family="Microsoft YaHei, Consolas, monospace" font-size="15">${escape(caption)}</text>`
  }
  capture.cells.forEach((row, y) => row.forEach((cell, x) => {
    const left = PAD + x * CELL.width
    const top = PAD + CAPTION + y * CELL.height
    const fg = cell.fg ?? foreground
    if (cell.bg) body += rect(left, top, CELL.width * cell.width, CELL.height, cell.bg)
    if (cell.text === '▀') body += rect(left, top, CELL.width, CELL.height / 2, fg)
    else if (cell.text === '▄') body += rect(left, top + CELL.height / 2, CELL.width, CELL.height / 2, fg)
    else if (cell.text === '█') body += rect(left, top, CELL.width, CELL.height, fg)
    else if (cell.text.trim() && cell.width) {
      body += `<text x="${left}" y="${top + 15}" fill="${fg}" opacity="${cell.dim ? 0.62 : 1}" font-family="Consolas, Microsoft YaHei, monospace" font-size="16" font-weight="${cell.bold ? 700 : 400}">${escape(cell.text)}</text>`
    }
  }))
  for (const p of capture.graphicsImages ?? []) {
    body += `<image x="${PAD + p.x * CELL.width}" y="${PAD + CAPTION + p.y * CELL.height}" width="${p.columns * CELL.width}" height="${p.rows * CELL.height}" href="data:image/png;base64,${p.png}"/>`
  }
  return { width, height, svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${body}</svg>` }
}

/** Page colours of the two previews every mode ships. */
export const PAGE = {
  dark: { background: '#000000', foreground: '#E8E6E0' },
  light: { background: '#FFFFFF', foreground: '#343945' },
}

/**
 * How many cells in a column band carry one glyph — the discriminator between
 * the block font (`█`, `renderBigLine`) and the half-block image art
 * (`▀`/`▄`, `toHalfBlockRows`).
 */
export function glyphCells(capture, glyph, from = 0, to = capture.columns) {
  let n = 0
  for (const row of capture.cells) {
    for (let x = from; x < Math.min(to, row.length); x++) {
      if (row[x].text === glyph) n++
    }
  }
  return n
}

/** Half-block art cells (`▀` or `▄`) in a column band. */
export function artCells(capture, from = 0, to = capture.columns) {
  return glyphCells(capture, '▀', from, to) + glyphCells(capture, '▄', from, to)
}

/** Plain text of a capture, one line per row (blank cells keep their space). */
export function captureText(capture) {
  return capture.lines.join('\n')
}
