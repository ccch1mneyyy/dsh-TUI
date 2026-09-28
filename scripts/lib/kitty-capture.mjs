/** Decode the actual Kitty payload/placement stream, for reproducible raster QA. */
import { inflateSync } from 'node:zlib'
import sharp from 'sharp'

export async function kittyImages(output, cellWidth = 10, cellHeight = 20) {
  const images = new Map()
  const placements = new Map()
  let pending
  for (const match of output.matchAll(/\x1b_G([^;]*);([^\x1b]*)\x1b\\/g)) {
    const control = Object.fromEntries(match[1].split(',').map(v => v.split('=')))
    if (control.a === 't') pending = { control, data: '' }
    if (pending && (control.a === 't' || control.a === undefined)) {
      pending.data += match[2]
      if (control.m === '0') {
        const { s, v, i } = pending.control
        const raw = inflateSync(Buffer.from(pending.data, 'base64'))
        if (raw.length !== Number(s) * Number(v) * 4) throw new Error('Invalid Kitty RGBA payload')
        images.set(i, await sharp(raw, { raw: { width: Number(s), height: Number(v), channels: 4 } }).png().toBuffer())
        pending = undefined
      }
    }
    if (control.a === 'p') {
      const prefix = output.slice(0, match.index)
      const cup = [...prefix.matchAll(/\x1b\[(\d+);(\d+)H/g)].at(-1)
      if (!cup) throw new Error('Kitty placement without cursor position')
      placements.set(control.p, { id: control.i, x: Number(cup[2]) - 1, y: Number(cup[1]) - 1,
        columns: Number(control.c), rows: Number(control.r) })
    }
    if (control.a === 'd') {
      if (control.p) placements.delete(control.p)
      else for (const [key, placement] of placements) if (placement.id === control.i) placements.delete(key)
    }
  }
  return Promise.all([...placements.values()].map(async p => {
    const source = images.get(p.id)
    if (!source) throw new Error('Kitty placement has no uploaded pixels')
    const png = await sharp(source).resize(p.columns * cellWidth, p.rows * cellHeight).png().toBuffer()
    return { ...p, png: png.toString('base64') }
  }))
}
