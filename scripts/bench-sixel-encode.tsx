/**
 * Sixel 编码耗时基准：量化 + sixelEncode，与 worker 内 SixelEncoderCache.render
 * 走同一条 encodeSixel 路径。只打印数字，不做断言；用于改动前后对比。
 *
 * 三种图 × 三档尺寸：
 *   flat  —— 纯色，调色板只有 1 色；
 *   photo —— 高斯噪声 blur 8，色彩分布接近照片；
 *   noise —— 高斯噪声，256 色都用满的最坏情况。
 *   384×192 是 transcript 缩略图量级，1024×512 是 transcript 上限，
 *   2048×1024 是 preview 上限（超过 4 MiB Sixel 输出预算时打印 over budget）。
 *
 * 先 pnpm compile；运行：node --import tsx/esm scripts/bench-sixel-encode.tsx
 */
import { loadSharp } from '../lib/types/dsh-adapter/sharp.js'
import { encodeSixel } from '../lib/types/ink/sixel-codec.js'
import type { TerminalImageSource } from '../lib/types/ink/terminal-image.js'

const sharp = await loadSharp()
if (!sharp) { console.log('SKIP bench-sixel-encode: optional sharp unavailable'); process.exit(0) }

const shapes = {
  flat: { background: { r: 0, g: 255, b: 0, alpha: 1 } },
  photo: { noise: { type: 'gaussian', mean: 128, sigma: 40 }, blur: 8 },
  noise: { noise: { type: 'gaussian', mean: 128, sigma: 40 } },
} as const
const sizes: ReadonlyArray<readonly [number, number]> = [[384, 192], [1024, 512], [2048, 1024]]
const ROUNDS = 3

async function makeSource(width: number, height: number, shape: keyof typeof shapes): Promise<TerminalImageSource> {
  const { blur, ...create } = { blur: 0.3, ...shapes[shape] }
  const data = await sharp({ create: { width, height, channels: 4, ...create } })
    .blur(blur).ensureAlpha().raw().toBuffer()
  return { data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength), width, height }
}

async function median(run: () => Promise<unknown>): Promise<string> {
  const samples: number[] = []
  for (let round = 0; round < ROUNDS; round++) {
    const start = performance.now()
    try { await run() } catch (error) {
      return (error as Error).message.includes('budget') ? 'over budget' : `error: ${(error as Error).message}`
    }
    samples.push(performance.now() - start)
  }
  samples.sort((a, b) => a - b)
  return `${samples[Math.floor(ROUNDS / 2)]!.toFixed(0)} ms`
}

console.log('| 尺寸 | ' + Object.keys(shapes).join(' | ') + ' |')
console.log('| --- | ' + Object.keys(shapes).map(() => '---').join(' | ') + ' |')
for (const [width, height] of sizes) {
  const cells: string[] = []
  for (const shape of Object.keys(shapes) as Array<keyof typeof shapes>) {
    const source = await makeSource(width, height, shape)
    const presentation = width > 1024 || height > 1024 ? 'preview' : 'transcript'
    cells.push(await median(() => encodeSixel({ source, width, height, background: '#ffffff', presentation })))
  }
  console.log(`| ${width}×${height} | ${cells.join(' | ')} |`)
}
