/**
 * Render the welcome-art screenshots shipped with the PR: one dark-terminal
 * and one light-terminal capture per mode, numbered in `/settings` order.
 *
 * Run after pnpm compile: node --import tsx/esm scripts/render-welcome-art-previews.mjs
 * Artifacts: docs/assets/welcome-art/<NN>-<id>-<theme>.png   (24 PNGs)
 *            docs/assets/welcome-art/index.json              (manifest)
 *            .local/welcome-art/<NN>-<id>-<theme>.svg        (raster source)
 */
import { mkdir, writeFile } from 'node:fs/promises'
import sharp from 'sharp'

const { MODE_IDS, modeOf, captureWelcomeArt, screenSvg, PAGE } = await import('./lib/welcome-art-preview.mjs')

const png = sharp.default ?? sharp
const directory = 'docs/assets/welcome-art'
const scratch = '.local/welcome-art'
await mkdir(directory, { recursive: true })
await mkdir(scratch, { recursive: true })

const manifest = []
for (const [index, id] of MODE_IDS.entries()) {
  const number = String(index + 1).padStart(2, '0')
  const mode = modeOf(id)
  const label = mode.labelZh
  const shots = {}
  for (const theme of ['dark', 'light']) {
    const capture = await captureWelcomeArt({ welcomeArt: id, theme, columns: 110, graphics: true })
    const { svg } = screenSvg(capture, {
      ...PAGE[theme],
      caption: `#${number}  ${label}   ·   ${capture.columns} 列   ·   ${theme === 'dark' ? '黑底终端' : '白底终端'}`,
    })
    await writeFile(`${scratch}/${number}-${id}-${theme}.svg`, svg)
    const file = `${directory}/${number}-${id}-${theme}.png`
    await png(Buffer.from(svg)).png().toFile(file)
    shots[theme] = file
    console.log(`${number}  ${id.padEnd(10)} ${theme.padEnd(5)} → ${file}`)
  }
  manifest.push({
    number,
    id,
    art: mode.art,
    codename: mode.codename ?? null,
    label: mode.label,
    labelZh: mode.labelZh,
    shots,
  })
}
await writeFile(`${directory}/index.json`, `${JSON.stringify(manifest, null, 2)}\n`)
console.log(`\n${manifest.length} modes → ${manifest.length * 2} previews in ${directory}/`)
