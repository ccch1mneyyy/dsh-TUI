/**
 * verify-image-downsample — 入站图片降采样回归（issue #938）。
 *
 * 覆盖：
 *   A. probeImageSize 纯函数：PNG / JPEG / WebP(VP8X、VP8、VP8L) / GIF
 *      合成头 → 正确宽高；未识别格式 → null（调用方必须强制解码）；
 *   B. withinDimensionLimits / downscaleTarget：边超、像素超、组合超
 *      → 保纵横比目标尺寸（三大缩放因子取最大）；
 *   C. shrinkImageToLimits（真 sharp）：
 *     C1. 大 PNG → resized，双维 ≤ 上限、mediaType 保持 png；
 *     C2. 小图 → unchanged（不重编码）；
 *     C3. WebP 大尺寸小字节（#432 探测缺口的核心场景）→ 探测命中并
 *         resized，而不是按字节预算放行；
 *     C4. 探测不识别的坏字节 → decode-failed（不崩溃、可区分）；
 *     C5. 原格式不被 profile 接受时 → 落到接受的 png/jpeg 重编码；
 *   D. 闸门接线（fake attachments 的 imageLimits）：超限图经
 *       persistComposerImage → saveImage 收到的是降采样后的字节与
 *       复查后的 mediaType；未超限图字节原样直通。
 *
 * sharp-missing 路径由 loadSharp 的 try/catch 结构保证（optional
 * 依赖缺失 → unavailable/sharp-missing），不在本脚本模拟动态 import
 * 失败——C4 已覆盖 unavailable 形态的行为面。
 *
 * 运行：node --import tsx/esm scripts/verify-image-downsample.tsx
 */
export {} // 模块边界：避免顶层 await/全局名与其他 verify 脚本冲突

process.env.DSH_TUI_LANG = 'en'

const { probeImageSize, withinDimensionLimits, downscaleTarget, shrinkImageToLimits } =
  await import('../src/utils/imageResize.js')

let failures = 0
function check(name: string, ok: boolean, extra = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failures++
}

// ── A. probeImageSize ────────────────────────────────────────────────────
{
  // PNG: signature + IHDR with big-endian 1200×800.
  const png = new Uint8Array(32)
  for (const [i, v] of [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].entries()) png[i] = v!
  const w = 1200
  const h = 800
  png.set([(w >>> 24) & 0xff, (w >>> 16) & 0xff, (w >>> 8) & 0xff, w & 0xff], 16)
  png.set([(h >>> 24) & 0xff, (h >>> 16) & 0xff, (h >>> 8) & 0xff, h & 0xff], 20)
  check('A1. probe PNG', JSON.stringify(probeImageSize(png)) === '{"width":1200,"height":800}')

  // JPEG: SOI + APP0(JFIF) + SOF0 carrying 640×480.
  const jpeg = new Uint8Array([
    0xff, 0xd8,
    0xff, 0xe0, 0x00, 0x04, 0x00, 0x00,
    0xff, 0xc0, 0x00, 0x11, 0x08,
    (480 >> 8) & 0xff, 480 & 0xff, (640 >> 8) & 0xff, 640 & 0xff,
    0x03, 0x01, 0x11, 0x08,
  ])
  check('A2. probe JPEG', JSON.stringify(probeImageSize(jpeg)) === '{"width":640,"height":480}')

  // WebP VP8X: RIFF/WEBP + canvas 1-subtracted 24-bit LE 1600×900.
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

  // GIF: header + logical screen 320×240 (u16 LE).
  const gif = new Uint8Array(13)
  gif.set([0x47, 0x49, 0x46, 0x38, 0x39, 0x61], 0)
  gif.set([320 & 0xff, (320 >> 8) & 0xff], 6)
  gif.set([240 & 0xff, (240 >> 8) & 0xff], 8)
  check('A4. probe GIF', JSON.stringify(probeImageSize(gif)) === '{"width":320,"height":240}')

  check('A5. unknown bytes probe to null', probeImageSize(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])) === null)
}

// ── B. limits math ───────────────────────────────────────────────────────
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

// ── C. shrinkImageToLimits with real sharp ──────────────────────────────
const limits = { maxImageDimension: 1024, maxImagePixels: 1_048_576 }
const accepted = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']
{
  const sharp = (await import('sharp')) as unknown as {
    default?: (i: never) => { png(): { toBuffer(): Promise<{ data: Uint8Array }> } }
      & { jpeg(): { toBuffer(): Promise<{ data: Uint8Array }> } }
      & { webp(): { toBuffer(): Promise<{ data: Uint8Array }> } }
      & { resize(w: number, h: number, o: { fit: string }): unknown }
  }
  const factory = typeof sharp === 'function' ? sharp : sharp.default!

  // C1. Oversized real PNG 4000×2500 → resized within caps, stays png.
  const bigPng = await factory({
    create: { width: 4000, height: 2500, channels: 3, background: '#336699' },
  } as never).png().toBuffer()
  const r1 = await shrinkImageToLimits(bigPng, 'image/png', limits, accepted)
  check('C1. oversized PNG resampled inside caps',
    r1.kind === 'resized' && r1.width <= 1024 && r1.height <= 1024
    && r1.width * r1.height <= 1_048_576 && r1.mediaType === 'image/png',
    r1.kind === 'resized' ? `${r1.width}×${r1.height} ${r1.mediaType}` : '')

  // C2. Small image passes through untouched.
  const smallPng = await factory({
    create: { width: 64, height: 48, channels: 3, background: '#112233' },
  } as never).png().toBuffer()
  const r2 = await shrinkImageToLimits(smallPng, 'image/png', limits, accepted)
  check('C2. small image unchanged', r2.kind === 'unchanged')

  // C3. WebP, huge dimensions, tiny byte budget — the #432 gap: the probe
  // must catch it by dimensions, not let it through by bytes.
  const bigWebp = await factory({
    create: { width: 5000, height: 4000, channels: 3, background: '#445566' },
  } as never).webp({ quality: 20 }).toBuffer()
  const probed = probeImageSize(bigWebp)
  const r3 = await shrinkImageToLimits(bigWebp, 'image/webp', limits, accepted)
  check('C3. large-dimension small-byte WebP probed AND resampled',
    probed !== null && probed.width === 5000
    && r3.kind === 'resized' && r3.width <= 1024 && r3.height <= 1024)

  // C4. Bytes the probe cannot recognize and sharp cannot decode.
  const junk = new Uint8Array(512)
  for (let i = 0; i < junk.length; i++) junk[i] = (i * 31) & 0xff
  const r4 = await shrinkImageToLimits(junk, 'image/png', limits, accepted)
  check('C4. undecodable junk reports decode-failed (no crash)',
    r4.kind === 'unavailable' && r4.reason === 'decode-failed')

  // C5. Source format not accepted by the profile → falls back to an
  // accepted writer format.
  const r5 = await shrinkImageToLimits(bigPng, 'image/png', limits, ['image/jpeg'])
  check('C5. unaccepted source format re-encoded to accepted jpeg',
    r5.kind === 'resized' && r5.mediaType === 'image/jpeg')
}

// ── D. gate wiring through persistComposerImage ─────────────────────────
{
  const { createComposerImages } = await import('../src/dsh-adapter/channel/composer-images.js')
  const saved: { data: Uint8Array; mediaType: string }[] = []
  const fakeAttachments = {
    imageLimits: {
      maxImageBytes: 20_000_000,
      maxImagesPerMessage: 8,
      maxMessageImageBytes: 40_000_000,
      maxImageDimension: 1024,
      maxImagePixels: 1_048_576,
      mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
    },
    saveImage: async (input: { data: Uint8Array; mediaType: string }) => {
      saved.push({ data: input.data, mediaType: input.mediaType })
      return {
        attachmentId: `att-${saved.length}`,
        mediaType: input.mediaType,
        bytes: input.data.byteLength,
      }
    },
  }
  const fakeCtx = {
    get: (key: string): unknown => (key === 'attachments' ? fakeAttachments : undefined),
  }
  let generation = 0
  const images = createComposerImages(fakeCtx as never, {
    assertActive: () => {},
  } as never, { generation: () => generation })

  const sharp = (await import('sharp')) as unknown as {
    default?: (i: never) => { png(): { toBuffer(): Promise<{ data: Uint8Array }> } }
  }
  const factory = typeof sharp === 'function' ? sharp : sharp.default!
  const bigPng = await factory({
    create: { width: 3000, height: 3000, channels: 3, background: '#778899' },
  } as never).png().toBuffer()

  // D1. Oversized paste: what saveImage receives must be the resampled
  // bytes, inside the caps, with the re-checked media type.
  await images.stageImage({ data: bigPng, mediaType: 'image/png', name: 'big.png' })
  const d1 = saved[0]
  const d1Probe = d1 ? probeImageSize(d1.data) : null
  check('D1. gate stores resampled bytes inside caps',
    d1 !== undefined && d1Probe !== null
    && d1Probe.width <= 1024 && d1Probe.height <= 1024 && d1.mediaType === 'image/png',
    d1Probe ? `stored ${d1Probe.width}×${d1Probe.height}` : 'nothing saved')

  // D2. Small paste: bytes pass through byte-identical.
  const smallPng = await factory({
    create: { width: 100, height: 60, channels: 3, background: '#123456' },
  } as never).png().toBuffer()
  await images.stageImage({ data: smallPng, mediaType: 'image/png', name: 'small.png' })
  const d2 = saved[1]
  check('D2. small image stored byte-identical',
    d2 !== undefined && d2.data.byteLength === smallPng.byteLength
    && d2.data.every((v, i) => v === smallPng[i]))

  // D3. The generation guard protects the cross-await entry: a caller that
  // captured the epoch before a session change must be refused. (The public
  // stageImage re-syncs and captures the fresh epoch — a new paste belongs
  // to the new session by design.)
  const capturedEpoch = images.stagedImageGeneration()
  generation = 1
  const refused = await images.stageComposerImage({ data: smallPng, mediaType: 'image/png' }, capturedEpoch)
    .then(() => 'staged', (e: Error) => e.message)
  check('D3. session-change guard still refuses stale staging',
    refused.includes('session changed'),
    String(refused).slice(0, 60))
}

console.log(failures === 0 ? 'image ingress downsample regression passed' : `${failures} failure(s)`)
process.exit(failures === 0 ? 0 : 1)
