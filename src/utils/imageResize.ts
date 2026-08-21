/**
 * 粘贴图片的准入前降采样与尺寸探测。
 *
 * 服务端（attachment 域）的准入是严格的：单边像素、总像素、字节各自
 * 硬限，超限直接拒绝。现代屏幕的全屏截图（2K/4K）单边普遍超过默认
 * 单边限值，首贴即报错——与 Claude Code 的行为对齐，这里在提交前把
 * 图等比缩放进限，用户无感，服务端策略不变。
 *
 * sharp 为可选依赖：可用时执行真正的解码缩放与再编码；不可用时仅做
 * 尺寸探测并原样返回字节，由服务端严格准入报错兜底（用户可调大限额
 * 或补装 sharp）。尺寸探测本身是纯函数（PNG IHDR / JPEG SOF 段头解析），
 * 不依赖 sharp——token 的 (W×H) 显示在降级路径下仍然工作。
 */

/** 探测到的栅格尺寸；webp/gif 头解析未实现时为 undefined。 */
export interface ImageDimensions {
  width: number
  height: number
}

/** 图片媒体类型联合（与 attachment 域一致；降采样输出恒为 png）。 */
export type ShrinkMediaType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'

/** 降采样结果。shrunk=false 表示原样通过（未超限或 sharp 不可用）。 */
export interface ShrinkResult extends ImageDimensions {
  data: Uint8Array
  mediaType: ShrinkMediaType
  shrunk: boolean
}

/** 降采样需满足的准入子集（attachment 域 imageLimits 的镜像）。 */
export interface ShrinkLimits {
  maxImageBytes: number
  maxImageDimension?: number
}

/**
 * 从编码字节探测 PNG/JPEG 的固有尺寸（纯函数，逐段头解析）。
 * @param data - 图片编码字节。
 * @param mediaType - 声明的媒体类型（决定解析路径）。
 * @returns 尺寸；无法解析（含 webp/gif 与损坏头）时 undefined。
 */
export function imageDimensions(data: Uint8Array, mediaType: ShrinkMediaType): ImageDimensions | undefined {
  if (mediaType === 'image/png') return pngDimensions(data)
  if (mediaType === 'image/jpeg') return jpegDimensions(data)
  return undefined
}

function pngDimensions(data: Uint8Array): ImageDimensions | undefined {
  // PNG: 8 字节签名 + 4 长度 + "IHDR" + 4BE 宽 + 4BE 高。
  if (data.length < 24) return undefined
  if (data[0] !== 0x89 || data[1] !== 0x50 || data[2] !== 0x4e || data[3] !== 0x47) return undefined
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  return { width: view.getUint32(16), height: view.getUint32(20) }
}

function jpegDimensions(data: Uint8Array): ImageDimensions | undefined {
  // JPEG: FFD8 后逐段扫描；SOF0-15（去掉 DHT/DAC/RST 等）段内含 2BE 高 + 2BE 宽。
  if (data.length < 4 || data[0] !== 0xff || data[1] !== 0xd8) return undefined
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  let offset = 2
  while (offset + 9 < data.length) {
    if (data[offset] !== 0xff) return undefined
    const marker = data[offset + 1]!
    // SOF 段：C0-CF，剔除 C4(DHT)、C8(JPG)、CC(DAC)。
    const isStartOfFrame =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
    if (isStartOfFrame) {
      const height = view.getUint16(offset + 5)
      const width = view.getUint16(offset + 7)
      if (height === 0 || width === 0) return undefined
      return { width, height }
    }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd9)) {
      offset += 2 // 无长度段的标记
      continue
    }
    offset += 2 + view.getUint16(offset + 2) // 跳过段（2 字节长度自含）
  }
  return undefined
}

// sharp 是 optionalDependencies：缺席时降级。这里不用 `typeof import('sharp')`
// 取类型（未安装时编译即失败），而是按本模块实际用到的面描述最小接口——
// 声明处与上游 API 的偏离由 verify 脚本在安装了 sharp 的环境下覆盖。
interface SharpPipeline {
  metadata(): Promise<{ width?: number; height?: number }>
  resize(options: { width: number; height: number; fit: 'inside'; withoutEnlargement: boolean }): SharpPipeline
  png(options: { compressionLevel: number }): SharpPipeline
  toBuffer(): Promise<Buffer>
}
type SharpFactory = (input: Buffer, options?: { failOn?: 'none' | 'truncated' }) => SharpPipeline

let sharpModule: SharpFactory | null | undefined

async function loadSharp(): Promise<SharpFactory | null> {
  if (sharpModule !== undefined) return sharpModule
  try {
    // 非字面量 specifier 让 TS 放弃对 optional 依赖的静态模块解析
    //（字面量 import('sharp') 在未安装时编译期即 TS2307）。
    const specifier = 'sharp'
    const mod = (await import(specifier)) as unknown as { default: unknown }
    if (typeof mod.default !== 'function') throw new Error('unexpected sharp shape')
    sharpModule = mod.default as SharpFactory
  } catch {
    sharpModule = null // optional 依赖缺失：降级为原样提交
  }
  return sharpModule
}

/**
 * 等比降采样到准入限内：单边像素优先，编码字节超限时按 sqrt 比例再
 * 缩（最多三轮）。未超限、尺寸不可探测或 sharp 不可用时原样返回。
 * @param data - 图片编码字节。
 * @param mediaType - 媒体类型（png/jpeg 之外的类型 sharp 可用时仍可处理）。
 * @param limits - 准入限值。
 * @returns 处理后的字节、（降采样后的）尺寸与是否缩放标记。
 */
export async function shrinkImageToLimits(
  data: Uint8Array,
  mediaType: ShrinkMediaType,
  limits: ShrinkLimits,
): Promise<ShrinkResult> {
  const probe = imageDimensions(data, mediaType)
  const maxDimension = limits.maxImageDimension ?? Number.POSITIVE_INFINITY
  const dimensionOver = probe !== undefined && Math.max(probe.width, probe.height) > maxDimension
  if (!dimensionOver && data.byteLength <= limits.maxImageBytes) {
    return probe === undefined
      ? { data, mediaType, shrunk: false, width: 0, height: 0 }
      : { data, mediaType, shrunk: false, width: probe.width, height: probe.height }
  }
  const sharp = await loadSharp()
  if (sharp === null) {
    return { data, mediaType, shrunk: false, ...(probe ?? { width: 0, height: 0 }) }
  }
  // failOn 'truncated'：容忍非规范但可解码的文件，拒绝损坏数据（默认级别
  // 对非受信字素的稳健面；'none' 会跳过像素校验直喂原生解码器）。
  // 整个缩放过程包 try/catch：sharp 对畸形数据抛错时降级为原样提交，
  // 由服务端严格准入兜底——降采样永远不让粘贴路径崩溃。
  try {
    let pipeline = sharp(Buffer.from(data.buffer, data.byteOffset, data.byteLength), { failOn: 'truncated' })
    let scale = probe === undefined ? Number.POSITIVE_INFINITY : Math.min(1, maxDimension / Math.max(probe.width, probe.height))
    let encoded: Uint8Array = data
    let dims: ImageDimensions = probe ?? { width: 0, height: 0 }
    for (let round = 0; round < 3; round += 1) {
      const meta = await pipeline.metadata()
      // 头解析失败（webp/gif）时首轮据实重算比例——metadata 拿到真实尺寸。
      if (!Number.isFinite(scale)) {
        scale = Math.min(1, maxDimension / Math.max(meta.width ?? 1, meta.height ?? 1))
      }
      const target = Math.max(1, Math.round(Math.max(meta.width ?? 1, meta.height ?? 1) * scale))
      const buffer = await pipeline
        .resize({ width: target, height: target, fit: 'inside', withoutEnlargement: true })
        .png({ compressionLevel: 6 })
        .toBuffer()
      encoded = new Uint8Array(buffer)
      const after = await sharp(buffer).metadata()
      dims = { width: after.width ?? 0, height: after.height ?? 0 }
      if (encoded.byteLength <= limits.maxImageBytes && Math.max(dims.width, dims.height) <= maxDimension) {
        return { data: encoded, mediaType: 'image/png', shrunk: true, width: dims.width, height: dims.height }
      }
      scale *= Math.max(0.5, Math.sqrt(limits.maxImageBytes / Math.max(1, encoded.byteLength)))
      pipeline = sharp(buffer, { failOn: 'truncated' })
    }
    // 三轮仍未进限：字节超限由 channel 侧拦下抛错；尺寸超限交服务端准入。
    return { data: encoded, mediaType: 'image/png', shrunk: true, width: dims.width, height: dims.height }
  } catch {
    return { data, mediaType, shrunk: false, ...(probe ?? { width: 0, height: 0 }) }
  }
}
