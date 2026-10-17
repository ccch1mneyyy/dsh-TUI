#!/usr/bin/env node
/**
 * Regenerate the installer brand assets (ICO, header BMP and the welcome-page
 * animation frames) from the checked-in SVG sources. Run it only when the
 * artwork changes, then commit the binaries.
 *
 *   node scripts/windows/make-brand-assets.mjs
 *
 * sharp is intentionally not a dependency: the generated files are committed,
 * so neither CI nor a normal build ever needs an SVG rasterizer.
 *
 * The welcome page replays the README logo's 5200 ms step-end timeline as 16
 * frames: the whale blinks, flutters a fin and wags its tail while the GitHub
 * star tile cycles through its four states. Both README logos are sampled so the
 * installer can pick the frame set that matches the selected UI language.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const assets = join(here, 'assets')
const readme = join(resolve(here, '../..'), 'docs/assets/readme')

let sharp
try {
  sharp = (await import('sharp')).default
} catch {
  console.error('sharp is required to regenerate the assets: npm install --no-save sharp')
  process.exit(1)
}

async function raster(markup, width, height) {
  const { data } = await sharp(Buffer.from(markup), { density: 96 })
    .resize(width, height, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
  return data
}

const rasterFile = (file, width, height) => raster(readFileSync(join(assets, file), 'utf8'), width, height)

function bmpEntry(rgba, width, height) {
  const header = Buffer.alloc(40)
  header.writeUInt32LE(40, 0)
  header.writeInt32LE(width, 4)
  header.writeInt32LE(height * 2, 8)
  header.writeUInt16LE(1, 12)
  header.writeUInt16LE(32, 14)
  const xor = Buffer.alloc(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const source = ((height - 1 - y) * width + x) * 4
      const target = (y * width + x) * 4
      xor[target] = rgba[source + 2]
      xor[target + 1] = rgba[source + 1]
      xor[target + 2] = rgba[source]
      xor[target + 3] = rgba[source + 3]
    }
  }
  const andStride = Math.ceil(width / 32) * 4
  return Buffer.concat([header, xor, Buffer.alloc(andStride * height)])
}

function writeBmp(file, rgba, width, height) {
  const stride = (width * 3 + 3) & ~3
  const pixels = Buffer.alloc(stride * height)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const source = ((height - 1 - y) * width + x) * 4
      const target = y * stride + x * 3
      pixels[target] = rgba[source + 2]
      pixels[target + 1] = rgba[source + 1]
      pixels[target + 2] = rgba[source]
    }
  }
  const header = Buffer.alloc(54)
  header.write('BM', 0, 'ascii')
  header.writeUInt32LE(54 + pixels.length, 2)
  header.writeUInt32LE(54, 10)
  header.writeUInt32LE(40, 14)
  header.writeInt32LE(width, 18)
  header.writeInt32LE(height, 22)
  header.writeUInt16LE(1, 26)
  header.writeUInt16LE(24, 28)
  header.writeUInt32LE(pixels.length, 34)
  writeFileSync(join(assets, file), Buffer.concat([header, pixels]))
}

/** Pull one balanced <g> block out of a README logo by a marker inside it. */
function groupOf(source, marker) {
  const at = source.indexOf(marker)
  if (at < 0) throw new Error(`Missing ${marker}`)
  const start = source.lastIndexOf('<g', at)
  const tokens = /<g\b|<\/g>/g
  tokens.lastIndex = start
  let depth = 0
  for (let match = tokens.exec(source); match; match = tokens.exec(source)) {
    if (match[0] === '<g') depth++
    else if (--depth === 0) return source.slice(start, match.index + 4)
  }
  throw new Error(`Unbalanced ${marker}`)
}

/** Replace the group's own class/transform and give its <text> a real font. */
function place(markup, transform, font) {
  const split = markup.indexOf('>') + 1
  const tag = markup.slice(0, split)
    .replace(/ class="[^"]*"/, '')
    .replace(/ transform="[^"]*"/, '')
    .replace('<g', `<g transform="${transform}"`)
  const body = font ? markup.slice(split).replace(/<text /g, `<text font-family="${font}" `) : markup.slice(split)
  return tag + body
}

const TILE_FONT = "'DejaVu Sans Mono','Noto Sans CJK SC',monospace"

/** One README logo, reduced to the whale poses and the star tiles. */
function parseLogo(file) {
  const source = readFileSync(join(readme, file), 'utf8')
  return {
    whale: index => place(groupOf(source, `class="logo-whale-frame logo-whale-${index}"`), '', ''),
    tile: name => place(groupOf(source, `class="${name}"`), '', TILE_FONT),
  }
}
const LOGOS = { zh: parseLogo('logo.svg'), en: parseLogo('logo-en.svg') }

// Welcome panel geometry (164x314, MUI_WELCOMEFINISHPAGE_BITMAP).
const WELCOME_WIDTH = 164
const WELCOME_HEIGHT = 314
const WHALE_SCALE = 3.4375
const WHALE_X = 13.25
const WHALE_Y = 88
const TILE_SCALE = 0.85
const TILE_X = 7.2
const TILE_Y = 46

// The README timeline is step-end over 16 slots of 325 ms.
const WHALE_POSES = [0, 1, 0, 2, 3, 2, 0, 4, 5, 6, 7, 6, 5, 4, 0, 0]
const STAR_TILES = [
  { name: 'logo-desire', steps: [1, 2, 3] },
  { name: 'logo-star-idle', steps: [5, 6, 7] },
  { name: 'logo-thank', steps: [9, 10, 11] },
  { name: 'logo-star-active', steps: [13, 14, 15] },
]

const PANEL_TEXT = [
  '<text x="82.75" y="228" text-anchor="middle" font-family="Inter, \'Segoe UI\', \'DejaVu Sans\', sans-serif" font-size="25" font-weight="700" letter-spacing="2.8" fill="#263146">dsh<tspan fill="#4e6fff">-TUI</tspan></text>',
  '<rect x="34" y="240" width="96" height="1.6" fill="#abc2ec"/>',
  '<text x="82" y="257" text-anchor="middle" font-family="\'DejaVu Sans Mono\', Consolas, monospace" font-size="7.5" font-weight="600" letter-spacing="2.6" fill="#687386">DEEPSEEK HARNESS</text>',
  '<text x="82" y="269" text-anchor="middle" font-family="\'DejaVu Sans Mono\', Consolas, monospace" font-size="7.5" font-weight="600" letter-spacing="2.6" fill="#687386">TERMINAL INTERFACE</text>',
  '<text x="82" y="296" text-anchor="middle" font-family="Inter, \'Segoe UI\', \'DejaVu Sans\', sans-serif" font-size="8" letter-spacing="0.6" fill="#8a94a6">Windows x64 &#183; Offline setup</text>',
]

function welcomeFrame(locale, step) {
  const logo = LOGOS[locale]
  const tile = STAR_TILES.find(entry => entry.steps.includes(step))
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${WELCOME_WIDTH} ${WELCOME_HEIGHT}" width="${WELCOME_WIDTH}" height="${WELCOME_HEIGHT}">`,
    '<defs><linearGradient id="panel" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f4f8ff"/><stop offset="1" stop-color="#dbe6ff"/></linearGradient></defs>',
    `<rect x="0" y="0" width="${WELCOME_WIDTH}" height="${WELCOME_HEIGHT}" fill="url(#panel)"/>`,
    `<rect x="0" y="0" width="${WELCOME_WIDTH}" height="4" fill="#4e6fff"/>`,
    tile ? `<g transform="translate(${TILE_X} ${TILE_Y}) scale(${TILE_SCALE})">${logo.tile(tile.name)}</g>` : '',
    `<g shape-rendering="crispEdges" transform="translate(${WHALE_X} ${WHALE_Y}) scale(${WHALE_SCALE})">${logo.whale(WHALE_POSES[step])}</g>`,
    ...PANEL_TEXT,
    '</svg>',
  ].join('')
}

// The title-bar icon is the DeepSeek Harness desktop whale. Small sizes keep the
// bare glyph so it stays legible; larger sizes use the rounded app badge.
const icon = readFileSync(join(assets, 'icon.svg'), 'utf8')
const mark = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="163 266 824 612" width="824" height="612">
  <defs><linearGradient id="whale" x1="849.855" y1="39.085" x2="331.636" y2="802.645" gradientUnits="userSpaceOnUse">
    <stop offset="0.0855249" stop-color="#1C2434"/><stop offset="1" stop-color="#0F1115"/>
  </linearGradient></defs>
  <path fill="url(#whale)" d="${icon.match(/id="tray-glyph"[\s\S]*?<path[^>]*\sd="([^"]*)"/)[1]}"/>
</svg>`
const ICON = [
  [16, mark], [24, mark], [32, mark],
  [48, icon], [64, icon], [128, icon], [256, icon],
]

const entries = []
for (const [size, markup] of ICON) entries.push({ size, data: bmpEntry(await raster(markup, size, size), size, size) })

const ico = Buffer.alloc(6 + 16 * entries.length)
ico.writeUInt16LE(0, 0)
ico.writeUInt16LE(1, 2)
ico.writeUInt16LE(entries.length, 4)
let offset = ico.length
entries.forEach((entry, index) => {
  const base = 6 + index * 16
  ico[base] = entry.size >= 256 ? 0 : entry.size
  ico[base + 1] = entry.size >= 256 ? 0 : entry.size
  ico.writeUInt16LE(1, base + 4)
  ico.writeUInt16LE(32, base + 6)
  ico.writeUInt32LE(entry.data.length, base + 8)
  ico.writeUInt32LE(offset, base + 12)
  offset += entry.data.length
})
writeFileSync(join(assets, 'dsh-tui.ico'), Buffer.concat([ico, ...entries.map(entry => entry.data)]))

writeBmp('dsh-tui-header.bmp', await rasterFile('header.svg', 150, 57), 150, 57)
for (const locale of Object.keys(LOGOS)) {
  for (let step = 0; step < WHALE_POSES.length; step++) {
    const name = `dsh-tui-welcome-${locale}-${String(step).padStart(2, '0')}.bmp`
    writeBmp(name, await raster(welcomeFrame(locale, step), WELCOME_WIDTH, WELCOME_HEIGHT), WELCOME_WIDTH, WELCOME_HEIGHT)
  }
}
console.log(`Brand assets regenerated: dsh-tui.ico, dsh-tui-header.bmp, ${Object.keys(LOGOS).length * WHALE_POSES.length} welcome frames`)
