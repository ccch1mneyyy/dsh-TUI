/**
 * verify-image-downsample — 入站图片适配回归（issue #938）。
 *
 * 覆盖：
 *   A. probeImageSize 纯函数：PNG / JPEG / WebP(VP8X、VP8、VP8L) / GIF
 *      合成头 → 正确宽高；未识别格式 → null（调用方必须强制解码）；
 *      VP8 lossy 的 2 位缩放位必须屏蔽（RFC 6386 §9.1）；
 *   B. withinDimensionLimits / downscaleTarget：边超、像素超、组合超
 *      → 保纵横比目标尺寸（三大缩放因子取最大）；
 *   C. adaptImageForAdmission（真 sharp）：超限缩放、限内不动、格式转换
 *      （限内也转）、alpha 保留或填白、动图保留或明确拒绝、坏字节报
 *      decode-failed；
 *   D. 真实入口（stageComposerImage + 附件库桩 = PromptInput 调用的同一条
 *      路径）：最终 mediaType 准入、与尺寸无关的转换、decode-failed 拒绝、
 *      动图处置、回报给 UI 的 adjustment；
 *   E. sharp 缺失（子进程 + loader 钩子把 optional 依赖变成不可解析）：
 *      仅当图片本来就可放行时降级交给附件库，其余明确报错。
 *
 * 运行：node --import tsx/esm scripts/verify-image-downsample.tsx
 */
export {} // 模块边界：避免顶层 await/全局名与其他 verify 脚本冲突

process.env.DSH_TUI_LANG = 'en'

let failures = 0
function check(name: string, ok: boolean, extra = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failures++
}

/** E 段子进程模式：先注册 loader 钩子再加载被测模块，让 `import('sharp')`
 *  像最小安装那样失败。A–D 段需要真 sharp，因此本模式只跑 E 段。 */
const NO_SHARP = process.env.DSH_VERIFY_IMAGE_NOSHARP === '1'
if (NO_SHARP) {
  const { register } = await import('node:module')
  register(new URL('./verify-image-downsample-nosharp-hook.mjs', import.meta.url).href)
}

const { probeImageSize, withinDimensionLimits, downscaleTarget, adaptImageForAdmission } =
  await import('../src/utils/imageResize.js')
const { createComposerImages } = await import('../src/dsh-adapter/channel/composer-images.js')
import type { StagedImageHandle } from '../src/adapter/ports/channel-view.js'

const LIMITS = { maxImageDimension: 1024, maxImagePixels: 1_048_576 }
const ACCEPTED = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']

/** Minimal structural type for the sharp calls this script makes; the package
 *  is an optionalDependency, so it stays loosely typed here. */
interface SharpLike {
  (input?: unknown, options?: unknown): {
    png(): { toBuffer(): Promise<Uint8Array> }
    webp(options?: unknown): { toBuffer(): Promise<Uint8Array> }
    gif(): { toBuffer(): Promise<Uint8Array> }
    metadata(): Promise<{
      width?: number
      height?: number
      pages?: number
      delay?: number[]
      loop?: number
      hasAlpha?: boolean
    }>
    raw(): { toBuffer(options: { resolveWithObject: boolean }): Promise<{ data: Uint8Array }> }
  }
}

async function loadSharp(): Promise<SharpLike> {
  const mod = (await import('sharp')) as unknown as { default?: unknown }
  return (typeof mod === 'function' ? mod : mod.default) as SharpLike
}

/** Solid PNG; `alpha` produces a fully transparent RGBA image whose hidden
 *  red channel only shows when alpha is dropped instead of filled. */
async function pngBytes(sharp: SharpLike, width: number, height: number, alpha = false): Promise<Uint8Array> {
  return sharp({
    create: {
      width,
      height,
      channels: alpha ? 4 : 3,
      background: alpha ? { r: 255, g: 0, b: 0, alpha: 0 } : '#336699',
    },
  }).png().toBuffer()
}

async function solidPng(sharp: SharpLike, width: number, height: number, background: string): Promise<Uint8Array> {
  return sharp({ create: { width, height, channels: 3, background } }).png().toBuffer()
}

async function webpBytes(sharp: SharpLike, width: number, height: number, quality = 80): Promise<Uint8Array> {
  return sharp({ create: { width, height, channels: 3, background: '#445566' } }).webp({ quality }).toBuffer()
}

/** A real 3-frame animation, joined into one multi-page container. */
async function animatedBytes(sharp: SharpLike, width: number, height: number, format: 'webp' | 'gif'): Promise<Uint8Array> {
  const frames = [
    await solidPng(sharp, width, height, '#336699'),
    await solidPng(sharp, width, height, '#ff8800'),
    await solidPng(sharp, width, height, '#0088ff'),
  ]
  const joined = sharp(frames, { join: { animated: true } })
  return format === 'webp' ? joined.webp({ quality: 80 }).toBuffer() : joined.gif().toBuffer()
}

/** Animation facts that must survive a re-encode: frame count, per-frame
 *  delays and the loop flag. Losing the delays keeps `pages > 1` while the
 *  "animation" plays at the wrong speed, so count alone is not enough. */
async function animationMeta(
  sharp: SharpLike,
  bytes: Uint8Array,
): Promise<{ pages: number; delay: number[]; loop: number | undefined; hasAlpha: boolean }> {
  const meta = await sharp(bytes, { animated: true }).metadata()
  return {
    pages: meta.pages ?? 1,
    delay: [...(meta.delay ?? [])],
    loop: meta.loop,
    hasAlpha: meta.hasAlpha === true,
  }
}

async function firstPixel(sharp: SharpLike, bytes: Uint8Array): Promise<number[]> {
  const { data } = await sharp(bytes).raw().toBuffer({ resolveWithObject: true })
  return [data[0] ?? -1, data[1] ?? -1, data[2] ?? -1]
}

/** PNG signature + IHDR claiming `width`×`height` with no pixel data: the byte
 *  probe measures it, sharp cannot decode it. */
function pngHeaderOnly(width: number, height: number): Uint8Array {
  const crc32 = (buf: Uint8Array): number => {
    let crc = 0xffffffff
    for (const byte of buf) {
      crc ^= byte
      for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
    }
    return (crc ^ 0xffffffff) >>> 0
  }
  const type = [0x49, 0x48, 0x44, 0x52]
  const body = new Uint8Array(13)
  body[0] = (width >>> 24) & 0xff; body[1] = (width >>> 16) & 0xff
  body[2] = (width >>> 8) & 0xff; body[3] = width & 0xff
  body[4] = (height >>> 24) & 0xff; body[5] = (height >>> 16) & 0xff
  body[6] = (height >>> 8) & 0xff; body[7] = height & 0xff
  body[8] = 8; body[9] = 2
  const crc = crc32(new Uint8Array([...type, ...body]))
  return new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0, 0, 0, 13, ...type, ...body,
    (crc >>> 24) & 0xff, (crc >>> 16) & 0xff, (crc >>> 8) & 0xff, crc & 0xff,
  ])
}

/** Truncated file: PNG signature plus a lone chunk type, nothing decodable.
 *  The probe returns null for it, so the gate must try a real decode. */
function truncatedPng(): Uint8Array {
  return new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1,
  ])
}

interface StoredImage { data: Uint8Array; mediaType: string }
type StagedAdjustment = StagedImageHandle['adjustment']
interface GateResult {
  stored: StoredImage | undefined
  adjustment: StagedAdjustment
  error: string | undefined
}

function gateAttachments(options: {
  mediaTypes: readonly string[]
  maxImageDimension?: number
  maxImagePixels?: number
  saved: StoredImage[]
}): unknown {
  return {
    imageLimits: {
      maxImageBytes: 20_000_000,
      maxImagesPerMessage: 8,
      maxMessageImageBytes: 40_000_000,
      maxImageDimension: options.maxImageDimension ?? LIMITS.maxImageDimension,
      maxImagePixels: options.maxImagePixels ?? LIMITS.maxImagePixels,
      mediaTypes: options.mediaTypes,
    },
    saveImage: async (input: StoredImage) => {
      options.saved.push({ data: input.data, mediaType: input.mediaType })
      return { attachmentId: `att-${options.saved.length}`, mediaType: input.mediaType, bytes: input.data.byteLength }
    },
  }
}

/** One real-entry paste: the call PromptInput makes, against a fake attachment
 *  store that records what would have been persisted. */
async function stageViaEntry(options: {
  mediaTypes: readonly string[]
  data: Uint8Array
  mediaType: string
}): Promise<GateResult> {
  const saved: StoredImage[] = []
  const attachments = gateAttachments({ mediaTypes: options.mediaTypes, saved })
  const ctx = { get: (key: string): unknown => (key === 'attachments' ? attachments : undefined) }
  const images = createComposerImages(ctx as never, { assertActive: () => {} } as never, { generation: () => 0 })
  let adjustment: GateResult['adjustment']
  let error: string | undefined
  try {
    const handle = await images.stageComposerImage(
      { data: options.data, mediaType: options.mediaType as never, name: 'probe.png' },
      0,
    )
    adjustment = handle.adjustment
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught)
  }
  return { stored: saved[0], adjustment, error }
}

if (!NO_SHARP) {
  // ── A. probeImageSize ──────────────────────────────────────────────────
  {
    const png = new Uint8Array(32)
    for (const [i, v] of [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].entries()) png[i] = v!
    const w = 1200
    const h = 800
    png.set([(w >>> 24) & 0xff, (w >>> 16) & 0xff, (w >>> 8) & 0xff, w & 0xff], 16)
    png.set([(h >>> 24) & 0xff, (h >>> 16) & 0xff, (h >>> 8) & 0xff, h & 0xff], 20)
    check('A1. probe PNG', JSON.stringify(probeImageSize(png)) === '{"width":1200,"height":800}')

    const jpeg = new Uint8Array([
      0xff, 0xd8,
      0xff, 0xe0, 0x00, 0x04, 0x00, 0x00,
      0xff, 0xc0, 0x00, 0x11, 0x08,
      (480 >> 8) & 0xff, 480 & 0xff, (640 >> 8) & 0xff, 640 & 0xff,
      0x03, 0x01, 0x11, 0x08,
    ])
    check('A2. probe JPEG', JSON.stringify(probeImageSize(jpeg)) === '{"width":640,"height":480}')

    const vp8x = new Uint8Array(30)
    vp8x.set([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0], 0)
    vp8x.set([0x57, 0x45, 0x42, 0x50], 8)
    vp8x.set([0x56, 0x50, 0x38, 0x58], 12)
    const put24 = (v: number, off: number): void => {
      vp8x[off] = v & 0xff
      vp8x[off + 1] = (v >> 8) & 0xff
      vp8x[off + 2] = (v >> 16) & 0xff
    }
    put24(1599, 24)
    put24(899, 27)
    check('A3. probe WebP VP8X', JSON.stringify(probeImageSize(vp8x)) === '{"width":1600,"height":900}')

    const gif = new Uint8Array(13)
    gif.set([0x47, 0x49, 0x46, 0x38, 0x39, 0x61], 0)
    gif.set([320 & 0xff, (320 >> 8) & 0xff], 6)
    gif.set([240 & 0xff, (240 >> 8) & 0xff], 8)
    check('A4. probe GIF', JSON.stringify(probeImageSize(gif)) === '{"width":320,"height":240}')

    check('A5. unknown bytes probe to null', probeImageSize(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])) === null)

    // VP8 lossy carries 14-bit dimensions with a 2-bit scale above them
    // (RFC 6386 §9.1). Scale bits set here MUST NOT inflate the measurement.
    const vp8 = new Uint8Array(30)
    vp8.set([0x52, 0x49, 0x46, 0x46], 0)
    vp8.set([0x57, 0x45, 0x42, 0x50], 8)
    vp8.set([0x56, 0x50, 0x38, 0x20], 12)
    vp8[26] = 640 & 0xff
    vp8[27] = ((640 >> 8) & 0x3f) | 0x80
    vp8[28] = 480 & 0xff
    vp8[29] = ((480 >> 8) & 0x3f) | 0x40
    check('A6. VP8 lossy masks the 2-bit scale field',
      JSON.stringify(probeImageSize(vp8)) === '{"width":640,"height":480}',
      JSON.stringify(probeImageSize(vp8)))
  }

  // ── B. limits math ─────────────────────────────────────────────────────
  {
    const limits = { maxImageDimension: 2000, maxImagePixels: 2_000_000 }
    check('B1. within: exact edge counts as inside',
      withinDimensionLimits({ width: 2000, height: 1 }, limits))
    check('B2. over one side',
      !withinDimensionLimits({ width: 2001, height: 100 }, limits))
    check('B3. over pixels only',
      !withinDimensionLimits({ width: 1500, height: 1500 }, limits))

    const t1 = downscaleTarget({ width: 4000, height: 2000 }, limits)
    check('B4. side-driven target halves 4000×2000 → 2000×1000',
      t1.width === 2000 && t1.height === 1000)
    const t2 = downscaleTarget({ width: 1500, height: 1500 }, limits)
    check('B5. pixel-driven target shrinks 1500×1500 inside 2M px',
      t2.width * t2.height <= 2_000_000 && t2.width === t2.height)
  }

  const sharp = await loadSharp()

  // ── C. adaptImageForAdmission（helper 层，真 sharp）────────────────────
  {
    const bigPng = await pngBytes(sharp, 3000, 2500)
    const c1 = await adaptImageForAdmission(bigPng, 'image/png', LIMITS, ACCEPTED)
    check('C1. oversized PNG resampled inside caps, format kept',
      c1.kind === 'adapted' && c1.mediaType === 'image/png' && c1.resized && !c1.flattened
      && c1.width <= LIMITS.maxImageDimension && c1.height <= LIMITS.maxImageDimension
      && c1.width * c1.height <= LIMITS.maxImagePixels,
      c1.kind === 'adapted' ? `${c1.width}×${c1.height}` : c1.kind)

    const smallPng = await pngBytes(sharp, 64, 48)
    const c2 = await adaptImageForAdmission(smallPng, 'image/png', LIMITS, ACCEPTED)
    check('C2. in-cap accepted image unchanged (no encoder work)', c2.kind === 'unchanged')

    const bigWebp = await webpBytes(sharp, 5000, 4000, 20)
    const c3 = await adaptImageForAdmission(bigWebp, 'image/webp', LIMITS, ACCEPTED)
    check('C3. large-dimension small-byte WebP measured and resampled',
      probeImageSize(bigWebp)?.width === 5000 && c3.kind === 'adapted' && c3.resized
      && c3.width <= LIMITS.maxImageDimension)

    const junk = new Uint8Array(512)
    for (let i = 0; i < junk.length; i++) junk[i] = (i * 31) & 0xff
    const c4 = await adaptImageForAdmission(junk, 'image/png', LIMITS, ACCEPTED)
    check('C4. undecodable bytes report decode-failed (no crash)',
      c4.kind === 'unavailable' && c4.reason === 'decode-failed')

    // Conversion is size-independent: an in-cap source the profile refuses is
    // still converted, never passed through.
    const c5 = await adaptImageForAdmission(smallPng, 'image/png', LIMITS, ['image/jpeg'])
    check('C5. unaccepted in-cap format converted without resampling',
      c5.kind === 'adapted' && c5.mediaType === 'image/jpeg' && !c5.resized
      && c5.width === 64 && c5.height === 48,
      c5.kind === 'adapted' ? `${c5.mediaType} ${c5.width}×${c5.height} resized=${c5.resized}` : c5.kind)

    const alphaPng = await pngBytes(sharp, 200, 100, true)
    const c6 = await adaptImageForAdmission(alphaPng, 'image/png', LIMITS, ['image/jpeg'])
    const c6Pixel = c6.kind === 'adapted' ? await firstPixel(sharp, c6.data) : [-1, -1, -1]
    check('C6. alpha into a jpeg-only profile is flattened onto white',
      c6.kind === 'adapted' && c6.mediaType === 'image/jpeg' && c6.flattened
      && c6Pixel.every(channel => channel > 240),
      c6.kind === 'adapted' ? `firstPixel=${c6Pixel.join(',')}` : c6.kind)

    const c7 = await adaptImageForAdmission(alphaPng, 'image/png', LIMITS, ['image/jpeg', 'image/webp'])
    check('C7. alpha prefers webp over jpeg (transparency survives)',
      c7.kind === 'adapted' && c7.mediaType === 'image/webp' && !c7.flattened,
      c7.kind === 'adapted' ? c7.mediaType : c7.kind)

    const c8 = await adaptImageForAdmission(smallPng, 'image/png', LIMITS, ['image/jpeg'])
    check('C8. opaque conversion does not flatten needlessly',
      c8.kind === 'adapted' && c8.mediaType === 'image/jpeg' && !c8.flattened)

    const animWebp = await animatedBytes(sharp, 1200, 900, 'webp')
    const animIn = await animationMeta(sharp, animWebp)
    const c9 = await adaptImageForAdmission(animWebp, 'image/webp', LIMITS, ['image/png', 'image/webp'])
    const c9Meta = c9.kind === 'adapted' ? await animationMeta(sharp, c9.data) : undefined
    check('C9. animated webp keeps its frames, delays and loop through a resize',
      c9.kind === 'adapted' && c9.animated && (c9Meta?.pages ?? 0) > 1
      && JSON.stringify(c9Meta?.delay) === JSON.stringify(animIn.delay)
      && c9Meta?.loop === animIn.loop,
      `in pages=${animIn.pages} delay=${JSON.stringify(animIn.delay)} → out pages=${c9Meta?.pages} delay=${JSON.stringify(c9Meta?.delay)}`)

    const c10 = await adaptImageForAdmission(animWebp, 'image/webp', LIMITS, ['image/png', 'image/jpeg'])
    check('C10. animation with no animation-capable target is refused',
      c10.kind === 'unavailable' && c10.reason === 'animated-unsupported',
      c10.kind === 'unavailable' ? c10.reason : c10.kind)

    const inCapAnim = await animatedBytes(sharp, 64, 48, 'webp')
    const c11 = await adaptImageForAdmission(inCapAnim, 'image/webp', LIMITS, ACCEPTED)
    check('C11. in-cap animated image passes through untouched', c11.kind === 'unchanged')

    const bigAlpha = await pngBytes(sharp, 2000, 1500, true)
    const c12 = await adaptImageForAdmission(bigAlpha, 'image/png', LIMITS, ACCEPTED)
    const c12Meta = c12.kind === 'adapted' ? await animationMeta(sharp, c12.data) : undefined
    check('C12. a resize that keeps the accepted format keeps the alpha channel',
      c12.kind === 'adapted' && !c12.flattened && c12Meta?.hasAlpha === true,
      c12.kind === 'adapted' ? `flattened=${c12.flattened} hasAlpha=${c12Meta?.hasAlpha}` : c12.kind)
  }

  // ── D. 真实入口（stageComposerImage + 附件库桩）─────────────────────────
  {
    const bigPng = await pngBytes(sharp, 3000, 3000)

    const d1 = await stageViaEntry({ mediaTypes: ACCEPTED, data: bigPng, mediaType: 'image/png' })
    const d1Probe = d1.stored ? probeImageSize(d1.stored.data) : null
    check('D1. oversized png: stored bytes resampled inside caps',
      d1.error === undefined && d1.stored?.mediaType === 'image/png'
      && (d1Probe?.width ?? 0) <= LIMITS.maxImageDimension && (d1Probe?.height ?? 0) <= LIMITS.maxImageDimension
      && d1.adjustment?.resized === true && d1.adjustment.mediaType === 'image/png',
      d1.error ?? `stored ${d1Probe?.width}×${d1Probe?.height}`)

    const smallPng = await pngBytes(sharp, 100, 60)
    const d2 = await stageViaEntry({ mediaTypes: ACCEPTED, data: smallPng, mediaType: 'image/png' })
    check('D2. in-cap png: byte-identical, no adjustment reported',
      d2.error === undefined && d2.adjustment === undefined && d2.stored !== undefined
      && d2.stored.data.byteLength === smallPng.byteLength
      && d2.stored.data.every((v, i) => v === smallPng[i]))

    // The promise C5 used to fake: a jpeg-only profile converts a PNG.
    const d3 = await stageViaEntry({ mediaTypes: ['image/jpeg'], data: bigPng, mediaType: 'image/png' })
    const d3Probe = d3.stored ? probeImageSize(d3.stored.data) : null
    check('D3. jpeg-only + oversized png: converted to jpeg inside caps',
      d3.error === undefined && d3.stored?.mediaType === 'image/jpeg'
      && (d3Probe?.width ?? 0) <= LIMITS.maxImageDimension && (d3Probe?.height ?? 0) <= LIMITS.maxImageDimension
      && d3.adjustment?.sourceMediaType === 'image/png' && d3.adjustment.mediaType === 'image/jpeg'
      && d3.adjustment.resized === true,
      d3.error ?? `${d3.stored?.mediaType} ${d3Probe?.width}×${d3Probe?.height}`)

    const d4 = await stageViaEntry({ mediaTypes: ['image/jpeg'], data: smallPng, mediaType: 'image/png' })
    check('D4. jpeg-only + in-cap png: same conversion path (size-independent)',
      d4.error === undefined && d4.stored?.mediaType === 'image/jpeg'
      && d4.adjustment?.resized === false && d4.adjustment.mediaType === 'image/jpeg',
      d4.error ?? `${d4.stored?.mediaType} resized=${d4.adjustment?.resized}`)

    const d5 = await stageViaEntry({ mediaTypes: ['image/png', 'image/jpeg'], data: bigPng, mediaType: 'image/png' })
    check('D5. an accepted source format is never transcoded for free',
      d5.error === undefined && d5.stored?.mediaType === 'image/png'
      && d5.adjustment?.mediaType === 'image/png' && d5.adjustment.sourceMediaType === 'image/png',
      d5.error ?? String(d5.stored?.mediaType))

    const alphaPng = await pngBytes(sharp, 1600, 1200, true)
    const d6 = await stageViaEntry({ mediaTypes: ['image/jpeg'], data: alphaPng, mediaType: 'image/png' })
    const d6Pixel = d6.stored ? await firstPixel(sharp, d6.stored.data) : [-1, -1, -1]
    check('D6. alpha png into jpeg-only: flattened onto white, reported',
      d6.error === undefined && d6.stored?.mediaType === 'image/jpeg'
      && d6.adjustment?.flattened === true && d6.adjustment.resized === true
      && d6Pixel.every(channel => channel > 240),
      d6.error ?? `firstPixel=${d6Pixel.join(',')}`)

    const d7 = await stageViaEntry({ mediaTypes: ['image/png'], data: truncatedPng(), mediaType: 'image/png' })
    check('D7. undecodable paste is refused at the entry, not handed to the store',
      d7.error !== undefined && d7.stored === undefined && d7.error.includes('decoded'),
      d7.error ?? 'no error')

    const animWebp = await animatedBytes(sharp, 1600, 1200, 'webp')
    const animWebpIn = await animationMeta(sharp, animWebp)
    const d8 = await stageViaEntry({ mediaTypes: ['image/webp', 'image/png'], data: animWebp, mediaType: 'image/webp' })
    const d8Meta = d8.stored ? await animationMeta(sharp, d8.stored.data) : undefined
    check('D8. animated paste through the entry keeps frames, delays and loop',
      d8.error === undefined && (d8Meta?.pages ?? 0) > 1
      && JSON.stringify(d8Meta?.delay) === JSON.stringify(animWebpIn.delay)
      && d8Meta?.loop === animWebpIn.loop,
      d8.error ?? `in delay=${JSON.stringify(animWebpIn.delay)} → out pages=${d8Meta?.pages} delay=${JSON.stringify(d8Meta?.delay)}`)

    const d9 = await stageViaEntry({ mediaTypes: ['image/png', 'image/jpeg'], data: animWebp, mediaType: 'image/webp' })
    check('D9. animated paste with no animation-capable target is refused',
      d9.error !== undefined && d9.stored === undefined && d9.error.includes('animated'),
      d9.error ?? 'no error')

    const animGif = await animatedBytes(sharp, 1600, 1200, 'gif')
    const d10 = await stageViaEntry({ mediaTypes: ACCEPTED, data: animGif, mediaType: 'image/gif' })
    const d10Meta = d10.stored ? await animationMeta(sharp, d10.stored.data) : undefined
    check('D10. oversized animated gif keeps its frames through the entry',
      d10.error === undefined && d10.stored?.mediaType === 'image/gif' && (d10Meta?.pages ?? 0) > 1,
      d10.error ?? `pages=${d10Meta?.pages}`)

    // D12: the resize-only path must not composite an accepted, alpha-carrying
    // format — transparency is the user's data, not an implementation detail.
    const bigAlphaPng = await pngBytes(sharp, 2000, 1500, true)
    const d12 = await stageViaEntry({ mediaTypes: ACCEPTED, data: bigAlphaPng, mediaType: 'image/png' })
    const d12Meta = d12.stored ? await animationMeta(sharp, d12.stored.data) : undefined
    check('D12. oversized alpha png keeps alpha through the entry (no flatten)',
      d12.error === undefined && d12.stored?.mediaType === 'image/png'
      && d12.adjustment?.resized === true && d12.adjustment.flattened === false
      && d12Meta?.hasAlpha === true,
      d12.error ?? `flattened=${d12.adjustment?.flattened} hasAlpha=${d12Meta?.hasAlpha}`)

    // D11: the generation guard protects the cross-await entry — a caller that
    // captured the epoch before a session change must be refused.
    const saved: StoredImage[] = []
    const attachments = gateAttachments({ mediaTypes: ACCEPTED, saved })
    const ctx = { get: (key: string): unknown => (key === 'attachments' ? attachments : undefined) }
    let generation = 0
    const images = createComposerImages(ctx as never, { assertActive: () => {} } as never, { generation: () => generation })
    const capturedEpoch = images.stagedImageGeneration()
    generation = 1
    const refused = await images.stageComposerImage({ data: smallPng, mediaType: 'image/png' }, capturedEpoch)
      .then(() => 'staged', (error: Error) => error.message)
    check('D11. session-change guard still refuses stale staging',
      refused.includes('session changed'),
      String(refused).slice(0, 60))
  }

  // ── E1. sharp 缺失场景放进子进程（loader 钩子只在子进程注册）──────────
  {
    const { spawnSync } = await import('node:child_process')
    const child = spawnSync(
      process.execPath,
      ['--import', 'tsx/esm', 'scripts/verify-image-downsample.tsx'],
      { encoding: 'utf8', env: { ...process.env, DSH_VERIFY_IMAGE_NOSHARP: '1' } },
    )
    const output = `${child.stdout ?? ''}${child.stderr ?? ''}`.trim()
    check('E1. sharp-missing scenarios pass in a sharp-less child process',
      child.status === 0, child.status === 0 ? '' : `exit=${child.status}`)
    if (output !== '') console.log(output.split('\n').map(line => `    ${line}`).join('\n'))
  }
} else {
  // ── E. sharp 缺失（子进程视角：A–D 段由父进程负责）─────────────────────
  const stage = async (
    data: Uint8Array,
    mediaType: string,
    mediaTypes: readonly string[] = ACCEPTED,
  ): Promise<{ ok: boolean; message: string; saved: StoredImage[] }> => {
    const saved: StoredImage[] = []
    const attachments = gateAttachments({ mediaTypes, saved })
    const ctx = { get: (key: string): unknown => (key === 'attachments' ? attachments : undefined) }
    const images = createComposerImages(ctx as never, { assertActive: () => {} } as never, { generation: () => 0 })
    try {
      await images.stageComposerImage({ data, mediaType: mediaType as never }, 0)
      return { ok: true, message: '', saved }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error), saved }
    }
  }

  // Unknown format + unmeasurable size + accepted media type: nothing can be
  // measured without the decoder, so this paste degrades to the store.
  const e2 = await stage(truncatedPng(), 'image/png')
  check('E2. sharp-missing degrades an unmeasurable paste to the store',
    e2.ok && e2.saved.length === 1 && e2.saved[0]?.mediaType === 'image/png',
    e2.ok ? `stored ${e2.saved[0]?.data.byteLength}B` : e2.message)

  // Measured oversize: the caps are known to be violated, so refusing now
  // beats handing the store bytes it must reject.
  const e3 = await stage(pngHeaderOnly(9000, 9000), 'image/png')
  check('E3. sharp-missing still refuses a measured oversize paste',
    !e3.ok && e3.message.includes('sharp is unavailable'),
    e3.ok ? 'staged' : e3.message)

  // Unaccepted format + no sharp: the conversion is impossible, so this is a
  // certain store rejection and must be stated at the paste.
  const e4 = await stage(truncatedPng(), 'image/gif', ['image/png'])
  check('E4. sharp-missing refuses a format the profile does not accept',
    !e4.ok && e4.message.includes('sharp is unavailable'),
    e4.ok ? 'staged' : e4.message)

  // Decode failure is not a degradation even without sharp in the picture:
  // the gate cannot measure AND cannot convert, so the paste stops here.
  const e5 = await stage(new Uint8Array(64).fill(7), 'image/png', ['image/jpeg'])
  check('E5. sharp-missing refuses an unconvertible unmeasurable paste',
    !e5.ok && e5.message.includes('sharp is unavailable'),
    e5.ok ? 'staged' : e5.message)
}

console.log(failures === 0 ? 'image ingress adaptation regression passed' : `${failures} failure(s)`)
process.exit(failures === 0 ? 0 : 1)
