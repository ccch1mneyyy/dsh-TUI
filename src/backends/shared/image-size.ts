/**
 * Intrinsic image dimensions from the encoded bytes alone — no decode, no
 * dependencies. Backend-neutral (D15): the composer's staging gate
 * (`src/utils/imageResize.ts`, which adds the sharp-backed re-encode on top)
 * and the backends that admit pasted images both measure with this, and a
 * backend must not reach into `src/utils/` (B-3's boundary rule). The sharp
 * dependency stays on the host side, so this module is a pure leaf.
 *
 * Formats the probe cannot identify return null and MUST be forced through
 * an actual decode for measurement — never read as "small enough".
 */

/** Pixel dimensions read from an encoded image's header. */
export interface ImageSizeProbe {
  readonly width: number
  readonly height: number
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const

function probePng(b: Uint8Array): ImageSizeProbe | null {
  // IHDR is required to be the first chunk: width/height are big-endian
  // u32 at fixed offsets 16/20.
  if (b.length < 24) return null
  const width = (b[16]! << 24) | (b[17]! << 16) | (b[18]! << 8) | b[19]!
  const height = (b[20]! << 24) | (b[21]! << 16) | (b[22]! << 8) | b[23]!
  return width > 0 && height > 0 ? { width, height } : null
}

function probeJpeg(b: Uint8Array): ImageSizeProbe | null {
  // Walk the segment chain to the first SOF marker (C0–CF except C4 DHT,
  // C8 JPG, CC DAC); height/width are big-endian u16 at +5/+7 inside it.
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null
  let i = 2
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) return null
    const marker = b[i + 1]!
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd9)) {
      i += 2 // standalone markers carry no length
      continue
    }
    const segLen = (b[i + 2]! << 8) | b[i + 3]!
    if (segLen < 2) return null
    const isSof = marker >= 0xc0 && marker <= 0xcf
      && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
    if (isSof) {
      const height = (b[i + 5]! << 8) | b[i + 6]!
      const width = (b[i + 7]! << 8) | b[i + 8]!
      return width > 0 && height > 0 ? { width, height } : null
    }
    i += 2 + segLen
  }
  return null
}

function probeWebp(b: Uint8Array): ImageSizeProbe | null {
  // RIFF....WEBP followed by VP8X (extended) or VP8 (lossy) or VP8L
  // (lossless). VP8X carries the canvas size as 1-subtracted 24-bit LE;
  // VP8 carries u16 LE after the frame tag; VP8L packs 14-bit
  // 1-subtracted fields after the signature byte.
  if (b.length < 30) return null
  if (b[0] !== 0x52 || b[1] !== 0x49 || b[2] !== 0x46 || b[3] !== 0x46) return null
  if (b[8] !== 0x57 || b[9] !== 0x45 || b[10] !== 0x42 || b[11] !== 0x50) return null
  const fourcc = String.fromCharCode(b[12]!, b[13]!, b[14]!, b[15]!)
  if (fourcc === 'VP8X') {
    const width = 1 + ((b[24]! | (b[25]! << 8) | (b[26]! << 16)) & 0xffffff)
    const height = 1 + ((b[27]! | (b[28]! << 8) | (b[29]! << 16)) & 0xffffff)
    return { width, height }
  }
  if (fourcc === 'VP8 ') {
    // Uncompressed chunk header (10 bytes) then keyframe tag (3) then the
    // dimensions: 14-bit width/height in the low bits of each u16, with a
    // 2-bit horizontal/vertical scale in the top bits (RFC 6386 §9.1). Mask
    // them off, or an encoder that sets the scale bits is measured up to
    // 49152px too wide and gets shrunk far past the caps.
    const width = (b[26]! | (b[27]! << 8)) & 0x3fff
    const height = (b[28]! | (b[29]! << 8)) & 0x3fff
    return width > 0 && height > 0 ? { width, height } : null
  }
  if (fourcc === 'VP8L') {
    const bits = (b[21]! | (b[22]! << 8) | (b[23]! << 16) | (b[24]! << 24)) >>> 0
    const width = (bits & 0x3fff) + 1
    const height = ((bits >> 14) & 0x3fff) + 1
    return { width, height }
  }
  return null
}

function probeGif(b: Uint8Array): ImageSizeProbe | null {
  // Logical screen descriptor: u16 LE at fixed offsets 6/8. A truncated header
  // reads as 0×0 and would then look "inside the caps", so the zero check is
  // what keeps an unmeasurable file on the decode path.
  const width = b[6]! | (b[7]! << 8)
  const height = b[8]! | (b[9]! << 8)
  return width > 0 && height > 0 ? { width, height } : null
}

/**
 * The image media type the encoded bytes actually are, from the magic
 * bytes alone (the same signatures {@link probeImageSize} dispatches on):
 * PNG, JPEG, WebP (RIFF/WEBP) or GIF; anything else is undefined and the
 * caller keeps its own label (those bytes take the decode-or-refuse path
 * anyway). Used to keep a renamed file from travelling under a label its
 * content contradicts.
 */
export function sniffImageMediaType(bytes: Uint8Array): 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif' | undefined {
  if (bytes.length >= 8 && PNG_SIGNATURE.every((v, i) => bytes[i] === v)) return 'image/png'
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg'
  if (bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
    && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'image/webp'
  if (bytes.length >= 4 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) return 'image/gif'
  return undefined
}

/**
 * Measure intrinsic pixel dimensions from the encoded bytes alone — no
 * decode, no dependencies. Recognizes PNG / JPEG / WebP (VP8X, VP8,
 * VP8L) / GIF; anything else returns null, which callers MUST treat as
 * "unknown, force a real decode" — never as "small enough".
 */
export function probeImageSize(bytes: Uint8Array): ImageSizeProbe | null {
  if (bytes.length >= 8 && PNG_SIGNATURE.every((v, i) => bytes[i] === v)) {
    return probePng(bytes)
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    return probeJpeg(bytes)
  }
  if (bytes.length >= 30 && bytes[0] === 0x52 && bytes[8] === 0x57) {
    return probeWebp(bytes)
  }
  if (bytes.length >= 10
    && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) {
    return probeGif(bytes)
  }
  return null
}
