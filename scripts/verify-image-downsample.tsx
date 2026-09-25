/**
 * verify-image-downsample — 入站图片适配回归（issue #938）。
 *
 * 真实契约（每条都断言「交给附件库的字节/mediaType」或「粘贴时的拒绝」）：
 *   A. probeImageSize 纯函数：四种格式的合成头 → 正确宽高；VP8 lossy 的 2 位
 *      缩放位必须屏蔽；未识别/截断的字节 → null（调用方必须强制解码）；
 *   B. 真实入口（stageComposerImage + 附件库桩）：B1–B3 上限与不必要转码、
 *      B4/B5 尺寸无关的格式转换、B6 总像素上限、B7/B8 透明（优先保透明 /
 *      只能 jpeg 时显式填白）、B9 源格式被接受时保留 alpha、B10 需要改字节
 *      的动图明确拒绝、B11 限内动图原字节直通、B12/B13 解码失败（含截断
 *      GIF）拒绝、B14 提示数字取附件库回报、B15 allowlist 复查、B16 字节
 *      上限、B17 会话代际守卫；
 *   E. sharp 缺失（子进程 + loader 钩子让 optional 依赖不可解析）：可放行时
 *      降级交给附件库，已知超限/格式不可转换时粘贴即报错。
 *
 * 未覆盖：附件库自身的归一化（尺寸、格式、动图单帧化）不在本 PR 范围内，
 * 这里只验证「交给附件库之前」这一步。
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

/** E 段子进程模式：先注册钩子再加载被测模块，让 `import('sharp')` 像最小安装
 *  那样失败（A–B 段需要真 sharp，所以本模式只跑 E 段）。 */
const NO_SHARP = process.env.DSH_VERIFY_IMAGE_NOSHARP === '1'
if (NO_SHARP) {
  const { register } = await import('node:module')
  register(new URL('./verify-image-downsample-nosharp-hook.mjs', import.meta.url).href)
}

const { probeImageSize, adaptImageForAdmission } = await import('../src/utils/imageResize.js')
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
    metadata(): Promise<{ width?: number; height?: number; hasAlpha?: boolean }>
    raw(): { toBuffer(options: { resolveWithObject: boolean }): Promise<{ data: Uint8Array }> }
  }
}

async function loadSharp(): Promise<SharpLike> {
  const mod = (await import('sharp')) as unknown as { default?: unknown }
  return (typeof mod === 'function' ? mod : mod.default) as SharpLike
}

/** Solid PNG; `alpha` makes it fully transparent, so a dropped alpha channel
 *  shows up as a colour change instead of a silent no-op. */
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

async function animatedWebpBytes(sharp: SharpLike, width: number, height: number): Promise<Uint8Array> {
  const frames = [
    await pngBytes(sharp, width, height),
    await sharp({ create: { width, height, channels: 3, background: '#ff8800' } }).png().toBuffer(),
  ]
  return sharp(frames, { join: { animated: true } }).webp({ quality: 80 }).toBuffer()
}

async function firstPixel(sharp: SharpLike, bytes: Uint8Array): Promise<number[]> {
  const { data } = await sharp(bytes).raw().toBuffer({ resolveWithObject: true })
  return [data[0] ?? -1, data[1] ?? -1, data[2] ?? -1]
}

/** PNG signature + IHDR claiming `width`×`height`, no pixel data. Only the byte
 *  probe reads it: the sharp-missing cases never decode, so no CRC is needed. */
function pngHeaderClaims(width: number, height: number): Uint8Array {
  return new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52,
    (width >>> 24) & 0xff, (width >>> 16) & 0xff, (width >>> 8) & 0xff, width & 0xff,
    (height >>> 24) & 0xff, (height >>> 16) & 0xff, (height >>> 8) & 0xff, height & 0xff,
    8, 2, 0, 0, 0, 0, 0, 0, 0,
  ])
}

/** PNG signature + a lone chunk type: the probe returns null, so the gate has
 *  to try a real decode and must refuse when that fails. */
function truncatedPng(): Uint8Array {
  return new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1,
  ])
}

/** Same shape for GIF: a 10-byte header whose logical screen is 0×0. */
function truncatedGif(): Uint8Array {
  return new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0, 0, 0, 0])
}

interface StoredImage { data: Uint8Array; mediaType: string }
interface GateResult {
  stored: StoredImage | undefined
  adjustment: StagedImageHandle['adjustment']
  error: string | undefined
}

/** One real-entry paste: the call PromptInput makes, against a fake attachment
 *  store that records what it was handed. `report` lets a case simulate the
 *  store normalizing further (its own dimensions / media type). */
async function stageViaEntry(options: {
  mediaTypes: readonly string[]
  data: Uint8Array
  mediaType: string
  maxImageBytes?: number
  limits?: { maxImageDimension: number; maxImagePixels: number }
  report?: { width?: number; height?: number; mediaType?: string }
}): Promise<GateResult> {
  const saved: StoredImage[] = []
  const attachments = {
    imageLimits: {
      maxImageBytes: options.maxImageBytes ?? 20_000_000,
      maxImagesPerMessage: 8,
      maxMessageImageBytes: 40_000_000,
      maxImageDimension: options.limits?.maxImageDimension ?? LIMITS.maxImageDimension,
      maxImagePixels: options.limits?.maxImagePixels ?? LIMITS.maxImagePixels,
      mediaTypes: options.mediaTypes,
    },
    saveImage: async (input: { data: Uint8Array; mediaType: string }) => {
      saved.push({ data: input.data, mediaType: input.mediaType })
      return {
        attachmentId: `att-${saved.length}`,
        mediaType: options.report?.mediaType ?? input.mediaType,
        width: options.report?.width ?? 0,
        height: options.report?.height ?? 0,
        bytes: input.data.byteLength,
      }
    },
  }
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

/** Inside the per-side caps (the byte probe's own answer, no decode needed). */
const sidesWithinCaps = (bytes: Uint8Array): boolean => {
  const size = probeImageSize(bytes)
  return size !== null && size.width <= LIMITS.maxImageDimension && size.height <= LIMITS.maxImageDimension
}

if (!NO_SHARP) {
  // ── A. probeImageSize（纯字节，无依赖）──────────────────────────────────
  {
    const jpeg = new Uint8Array([
      0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00,
      0xff, 0xc0, 0x00, 0x11, 0x08,
      (480 >> 8) & 0xff, 480 & 0xff, (640 >> 8) & 0xff, 640 & 0xff,
      0x03, 0x01, 0x11, 0x08,
    ])
    const vp8x = new Uint8Array(30)
    vp8x.set([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0], 0)
    vp8x.set([0x57, 0x45, 0x42, 0x50], 8)
    vp8x.set([0x56, 0x50, 0x38, 0x58], 12)
    vp8x.set([1599 & 0xff, 1599 >> 8, 1599 >> 16], 24)
    vp8x.set([899 & 0xff, 899 >> 8, 899 >> 16], 27)
    const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x40, 0x01, 0xf0, 0x00])
    const vp8 = new Uint8Array(30)
    vp8.set([0x52, 0x49, 0x46, 0x46], 0)
    vp8.set([0x57, 0x45, 0x42, 0x50], 8)
    vp8.set([0x56, 0x50, 0x38, 0x20], 12)
    // 640×480 with both 2-bit scale fields set: they must not inflate the size.
    vp8[26] = 640 & 0xff
    vp8[27] = ((640 >> 8) & 0x3f) | 0x80
    vp8[28] = 480 & 0xff
    vp8[29] = ((480 >> 8) & 0x3f) | 0x40

    const cases: ReadonlyArray<readonly [string, Uint8Array, string]> = [
      ['A1. PNG', pngHeaderClaims(1200, 800), '{"width":1200,"height":800}'],
      ['A2. JPEG', jpeg, '{"width":640,"height":480}'],
      ['A3. WebP VP8X', vp8x, '{"width":1600,"height":900}'],
      ['A4. GIF', gif, '{"width":320,"height":240}'],
      ['A5. WebP VP8 (scale bits masked)', vp8, '{"width":640,"height":480}'],
      ['A6. unknown bytes → null', new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]), 'null'],
      ['A7. truncated GIF → null', truncatedGif(), 'null'],
      ['A8. truncated PNG → null', truncatedPng(), 'null'],
    ]
    for (const [name, bytes, expected] of cases) {
      check(name, JSON.stringify(probeImageSize(bytes)) === expected, JSON.stringify(probeImageSize(bytes)))
    }
  }

  const sharp = await loadSharp()

  // ── B. 真实入口（PromptInput 调用的那条路径 + 附件库桩）────────────────
  {
    const bigPng = await pngBytes(sharp, 3000, 3000)
    const smallPng = await pngBytes(sharp, 100, 60)

    const b1 = await stageViaEntry({ mediaTypes: ACCEPTED, data: bigPng, mediaType: 'image/png' })
    check('B1. oversize png: store gets resampled bytes, format kept',
      b1.error === undefined && b1.stored?.mediaType === 'image/png' && sidesWithinCaps(b1.stored.data)
      && b1.adjustment?.resized === true,
      b1.error ?? `stored ${JSON.stringify(probeImageSize(b1.stored!.data))}`)

    const b2 = await stageViaEntry({ mediaTypes: ACCEPTED, data: smallPng, mediaType: 'image/png' })
    check('B2. in-cap png: byte-identical, nothing reported',
      b2.error === undefined && b2.adjustment === undefined && b2.stored?.data.byteLength === smallPng.byteLength
      && b2.stored.data.every((v, i) => v === smallPng[i]))

    const b3 = await stageViaEntry({ mediaTypes: ['image/png', 'image/jpeg'], data: bigPng, mediaType: 'image/png' })
    check('B3. an accepted source format is never transcoded for free',
      b3.error === undefined && b3.stored?.mediaType === 'image/png'
      && b3.adjustment?.mediaType === 'image/png' && b3.adjustment.sourceMediaType === 'image/png',
      b3.error ?? String(b3.stored?.mediaType))

    const b4 = await stageViaEntry({ mediaTypes: ['image/jpeg'], data: bigPng, mediaType: 'image/png' })
    check('B4. jpeg-only + oversize png: converted to jpeg inside the caps',
      b4.error === undefined && b4.stored?.mediaType === 'image/jpeg' && sidesWithinCaps(b4.stored.data)
      && b4.adjustment?.sourceMediaType === 'image/png' && b4.adjustment.mediaType === 'image/jpeg'
      && b4.adjustment.resized === true,
      b4.error ?? `${b4.stored?.mediaType} ${JSON.stringify(probeImageSize(b4.stored!.data))}`)

    const b5 = await stageViaEntry({ mediaTypes: ['image/jpeg'], data: smallPng, mediaType: 'image/png' })
    check('B5. jpeg-only + in-cap png: same conversion (size-independent)',
      b5.error === undefined && b5.stored?.mediaType === 'image/jpeg' && b5.adjustment?.resized === false,
      b5.error ?? String(b5.stored?.mediaType))

    // Both sides fit a relaxed 2048 per-side cap, so only the total-pixel cap
    // (1.5 M > 1 M) can pull this in: a per-side-only implementation would
    // leave 1500x1000 and fail here.
    const densePng = await pngBytes(sharp, 1500, 1000)
    const denseLimits = { maxImageDimension: 2048, maxImagePixels: LIMITS.maxImagePixels }
    const b6 = await stageViaEntry({ mediaTypes: ACCEPTED, data: densePng, mediaType: 'image/png', limits: denseLimits })
    const b6Size = b6.stored ? probeImageSize(b6.stored.data) : null
    check('B6. the total-pixel cap alone forces a resample',
      b6.error === undefined && b6Size !== null && b6.adjustment?.resized === true
      && b6Size.width * b6Size.height <= LIMITS.maxImagePixels
      && b6Size.width <= denseLimits.maxImageDimension && b6Size.height <= denseLimits.maxImageDimension,
      b6.error ?? JSON.stringify(b6Size))

    const alphaPng = await pngBytes(sharp, 2400, 1600, true)
    const b7 = await stageViaEntry({ mediaTypes: ['image/jpeg'], data: alphaPng, mediaType: 'image/png' })
    const b7Pixel = b7.stored ? await firstPixel(sharp, b7.stored.data) : [-1, -1, -1]
    check('B7. alpha into a jpeg-only profile: store gets white, not black',
      b7.error === undefined && b7.stored?.mediaType === 'image/jpeg' && b7.adjustment?.flattened === true
      && b7Pixel.every(channel => channel > 240),
      b7.error ?? `firstPixel=${b7Pixel.join(',')}`)

    const b8 = await stageViaEntry({ mediaTypes: ['image/jpeg', 'image/webp'], data: alphaPng, mediaType: 'image/png' })
    check('B8. alpha prefers a transparency-capable target (webp over jpeg)',
      b8.error === undefined && b8.stored?.mediaType === 'image/webp' && b8.adjustment?.flattened === false,
      b8.error ?? String(b8.stored?.mediaType))

    const b9 = await stageViaEntry({ mediaTypes: ACCEPTED, data: alphaPng, mediaType: 'image/png' })
    const b9Alpha = b9.stored ? (await sharp(b9.stored.data).metadata()).hasAlpha === true : false
    check('B9. an accepted format keeps its alpha through the resize',
      b9.error === undefined && b9.adjustment?.flattened === false && b9Alpha,
      b9.error ?? `hasAlpha=${b9Alpha}`)

    const animWebp = await animatedWebpBytes(sharp, 1600, 1200)
    const b10 = await stageViaEntry({ mediaTypes: ACCEPTED, data: animWebp, mediaType: 'image/webp' })
    check('B10. an animated paste that must be re-encoded is refused outright',
      b10.error !== undefined && b10.stored === undefined && b10.error.includes('frames'),
      b10.error ?? 'no error')

    const inCapAnim = await animatedWebpBytes(sharp, 64, 48)
    const b11 = await stageViaEntry({ mediaTypes: ACCEPTED, data: inCapAnim, mediaType: 'image/webp' })
    check('B11. an in-cap animated paste reaches the store byte-identical',
      b11.error === undefined && b11.stored?.data.byteLength === inCapAnim.byteLength
      && b11.stored.data.every((v, i) => v === inCapAnim[i]),
      b11.error ?? String(b11.stored?.data.byteLength))

    const b12 = await stageViaEntry({ mediaTypes: ['image/png'], data: truncatedPng(), mediaType: 'image/png' })
    check('B12. an undecodable paste is refused, not handed to the store',
      b12.error !== undefined && b12.stored === undefined && b12.error.includes('decoded'),
      b12.error ?? 'no error')

    const b13 = await stageViaEntry({ mediaTypes: ACCEPTED, data: truncatedGif(), mediaType: 'image/gif' })
    check('B13. a truncated GIF is measured as unknown and refused, not waved through',
      b13.error !== undefined && b13.stored === undefined,
      b13.error ?? 'no error')

    const b14 = await stageViaEntry({
      mediaTypes: ACCEPTED,
      data: bigPng,
      mediaType: 'image/png',
      report: { width: 2048, height: 2048, mediaType: 'image/jpeg' },
    })
    check('B14. the report quotes what the STORE stored, not what the gate handed over',
      b14.error === undefined && b14.adjustment?.width === 2048 && b14.adjustment.height === 2048
      && b14.adjustment.mediaType === 'image/jpeg' && b14.adjustment.resized === true,
      b14.error ?? JSON.stringify(b14.adjustment))

    const b15 = await stageViaEntry({ mediaTypes: [], data: smallPng, mediaType: 'image/png' })
    check('B15. an empty allowlist still fails the media-type admission',
      b15.error !== undefined && b15.stored === undefined && b15.error.includes('not accepted'),
      b15.error ?? 'no error')

    const b16 = await stageViaEntry({
      mediaTypes: ACCEPTED,
      data: smallPng,
      mediaType: 'image/png',
      maxImageBytes: 10,
    })
    check('B16. the per-image byte cap is enforced before anything else',
      b16.error !== undefined && b16.stored === undefined && b16.error.includes('size limit'),
      b16.error ?? 'no error')

    // The generation guard protects the cross-await entry: a caller that
    // captured the epoch before a session change must be refused.
    let generation = 0
    const images = createComposerImages(
      {
        get: (key: string): unknown => (key === 'attachments'
          ? {
            imageLimits: {
              maxImageBytes: 20_000_000,
              maxImagesPerMessage: 8,
              maxMessageImageBytes: 40_000_000,
              maxImageDimension: LIMITS.maxImageDimension,
              maxImagePixels: LIMITS.maxImagePixels,
              mediaTypes: ACCEPTED,
            },
            saveImage: async (input: { data: Uint8Array; mediaType: string }) => ({
              attachmentId: 'att',
              mediaType: input.mediaType,
              width: 1,
              height: 1,
              bytes: input.data.byteLength,
            }),
          }
          : undefined),
      } as never,
      { assertActive: () => {} } as never,
      { generation: () => generation },
    )
    const capturedEpoch = images.stagedImageGeneration()
    generation = 1
    const refused = await images.stageComposerImage({ data: smallPng, mediaType: 'image/png' }, capturedEpoch)
      .then(() => 'staged', (error: Error) => error.message)
    check('B17. session-change guard still refuses stale staging',
      refused.includes('session changed'), String(refused).slice(0, 60))
  }

  // ── E1. sharp 缺失场景放进子进程（钩子只在子进程注册）──────────────────
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
  // ── E. sharp 缺失（子进程视角：A–B 段由父进程负责）─────────────────────
  const stage = async (
    data: Uint8Array,
    mediaType: string,
    mediaTypes: readonly string[] = ACCEPTED,
  ): Promise<{ ok: boolean; message: string; saved: number }> => {
    let saved = 0
    const attachments = {
      imageLimits: {
        maxImageBytes: 20_000_000,
        maxImagesPerMessage: 8,
        maxMessageImageBytes: 40_000_000,
        maxImageDimension: LIMITS.maxImageDimension,
        maxImagePixels: LIMITS.maxImagePixels,
        mediaTypes,
      },
      saveImage: async (input: { data: Uint8Array; mediaType: string }) => {
        saved += 1
        return { attachmentId: 'att', mediaType: input.mediaType, width: 1, height: 1, bytes: input.data.byteLength }
      },
    }
    const ctx = { get: (key: string): unknown => (key === 'attachments' ? attachments : undefined) }
    const images = createComposerImages(ctx as never, { assertActive: () => {} } as never, { generation: () => 0 })
    try {
      await images.stageComposerImage({ data, mediaType: mediaType as never }, 0)
      return { ok: true, message: '', saved }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error), saved }
    }
  }

  const e2 = await stage(truncatedPng(), 'image/png')
  check('E2. sharp-missing degrades an unmeasurable paste to the store',
    e2.ok && e2.saved === 1, e2.ok ? `stored ${e2.saved}` : e2.message)

  const e3 = await stage(pngHeaderClaims(9000, 9000), 'image/png')
  check('E3. sharp-missing still refuses a measured oversize paste',
    !e3.ok && e3.message.includes('sharp is unavailable'), e3.ok ? 'staged' : e3.message)

  const e4 = await stage(truncatedPng(), 'image/gif', ['image/png'])
  check(
    'E4. sharp-missing refuses a format the profile does not accept',
    !e4.ok && e4.message.includes('sharp is unavailable'),
    e4.ok ? 'staged' : e4.message,
  )

  const e5 = await stage(truncatedPng(), 'image/png', ['image/jpeg'])
  check('E5. sharp-missing refuses an unconvertible unmeasurable paste',
    !e5.ok && e5.message.includes('sharp is unavailable'), e5.ok ? 'staged' : e5.message)
}

console.log(failures === 0 ? 'image ingress adaptation regression passed' : `${failures} failure(s)`)
process.exit(failures === 0 ? 0 : 1)
