import React from 'react'
import { Image, useTerminalImageCellSize } from '../ui.js'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { TerminalImageSource } from '../ink/terminal-image.js'
import { DEFAULT_TERMINAL_CELL_SIZE } from '../ink/terminal-image.js'
import { loadSharp } from '../dsh-adapter/sharp.js'

/**
 * The maid portrait (鲸鱼娘) for `dsh-tui.whaleGirl` and the star modal —
 * the author-designed 464×464 pixel art shipped at `assets/whale-girl/`,
 * rendered FIRST as a real raster through the terminal image protocols
 * (Kitty graphics / Sixel): full fidelity, anti-aliased curves, the whole
 * palette. The chain degrades per surface when images cannot show — the
 * header falls back to the character-art maid (`WhaleGirl.tsx`, the
 * author's placeholder), the star modal to the animated pixel whale — so
 * the setting never leaves the header worse than the whale it replaces.
 */

/** 一套立绘资产：`assets/` 下的目录 + `normal`/`happy` 两张变体。 */
export interface PortraitAssets {
  readonly dir: string
  readonly normal: string
  readonly happy: string
}

/** 鲸鱼娘（DeepSeek 品牌，settings `dsh-tui.whaleGirl`）。 */
export const MAID_ASSETS: PortraitAssets = {
  dir: 'whale-girl',
  normal: 'whale-girl.png',
  happy: 'whale-girl-happy.png',
}

/** Claude 娘（claude 品牌，见 `branding.ts`）：取自 cc-bridge 的开发期占位
 * 素材（1024×1024 透明底×2）。授权注记：那边的 assets/README 标注授权未
 * 确认——本仓库自用没问题，再分发前需确认或替换。 */
export const CLAUDE_GIRL_ASSETS: PortraitAssets = {
  dir: 'claude-girl',
  normal: 'claude-girl.png',
  happy: 'claude-girl-happy.png',
}

/** 恶魔精灵（codex 品牌，见 `branding.ts`）：用户提供的淡紫像素立绘 ×2
 * （628×628 透明底，Lanczos 自 1254² 重采样）——常态 = 淡紫恶魔精灵头像，
 * 点击后切「按下红色按钮的紫月龙裔少女」几秒（与鲸鱼娘/claude 娘同一套
 * reactMaid 交互）。 */
export const CODEX_GIRL_ASSETS: PortraitAssets = {
  dir: 'codex-girl',
  normal: 'codex-girl.png',
  happy: 'codex-girl-happy.png',
}

/** 品牌档 → 立绘资产集（LogoV2 的立绘槽选这一份；deepseek 走鲸鱼娘）。 */
export function portraitAssetsOf(brand: 'deepseek' | 'claude' | 'codex'): PortraitAssets {
  return brand === 'claude' ? CLAUDE_GIRL_ASSETS : brand === 'codex' ? CODEX_GIRL_ASSETS : MAID_ASSETS
}

/** 一台机器上的两张立绘都解好、并补齐到**同一像素画布**上——几何完全一致，
 *  换图时宿主是「擦旧 + 画新」一次写入，不会留残影。 */
export interface MaidPortraits {
  readonly normal: TerminalImageSource
  readonly happy: TerminalImageSource
}

const assetPath = (dir: string, file: string): string | undefined =>
  [`../../../assets/${dir}/${file}`, `../../assets/${dir}/${file}`]
    .map(relative => fileURLToPath(new URL(relative, import.meta.url)))
    .find(candidate => existsSync(candidate))

// 每套资产一份进程内缓存（键 = 资产目录）；失败缓存成 `undefined`，坏安装
// 不会每次渲染都重试。
const loadCache = new Map<string, Promise<MaidPortraits | undefined>>()

/**
 * 解码一套立绘的两张变体（每套缓存一次）。两张都裁掉透明边后**居中补到
 * 同一张透明画布**（取两者较大的宽高）——所以它们的像素尺寸与单元格盒
 * 完全一致。资产候选同时覆盖两种目录深度：`lib/types/components`（发布
 * 形态）比 `src/components`（仓库形态）深一层。
 * @param assets - 资产集（默认鲸鱼娘；claude 品牌传 `CLAUDE_GIRL_ASSETS`）。
 * @returns 两张 RGBA 源；任一张缺失/解码失败时整体 `undefined`。
 */
export function loadMaidPortraits(assets: PortraitAssets = MAID_ASSETS): Promise<MaidPortraits | undefined> {
  let loadOnce = loadCache.get(assets.dir)
  if (loadOnce === undefined) {
    loadOnce = (async () => {
    try {
      const sharp = await loadSharp()
      if (sharp === undefined) return undefined
      const trimmed: Record<'normal' | 'happy', TerminalImageSource> = { normal: undefined as never, happy: undefined as never }
      for (const variant of ['normal', 'happy'] as const) {
        const path = assetPath(assets.dir, assets[variant])
        if (path === undefined) return undefined
        const decoded = await sharp(readFileSync(path), { failOn: 'error' })
          .toColourspace('srgb')
          .ensureAlpha()
          .raw()
          .toBuffer({ resolveWithObject: true })
        if (decoded.info.channels !== 4
          || decoded.data.byteLength !== decoded.info.width * decoded.info.height * 4) return undefined
        const rgba: TerminalImageSource = {
          data: new Uint8Array(decoded.data.buffer, decoded.data.byteOffset, decoded.data.byteLength),
          width: decoded.info.width,
          height: decoded.info.height,
        }
        trimmed[variant] = trimTransparent(rgba)
      }
      const width = Math.max(trimmed.normal.width, trimmed.happy.width)
      const height = Math.max(trimmed.normal.height, trimmed.happy.height)
      return { normal: centerOnCanvas(trimmed.normal, width, height), happy: centerOnCanvas(trimmed.happy, width, height) }
    } catch {
      return undefined
    }
    })()
    loadCache.set(assets.dir, loadOnce)
  }
  return loadOnce
}

/** 把一张已裁边的图居中放进 `width × height` 的透明画布（几何对齐用）。 */
function centerOnCanvas(source: TerminalImageSource, width: number, height: number): TerminalImageSource {
  if (source.width === width && source.height === height) return source
  const data = new Uint8Array(width * height * 4)
  const left = Math.floor((width - source.width) / 2)
  const top = Math.floor((height - source.height) / 2)
  for (let y = 0; y < source.height; y++) {
    const from = y * source.width * 4
    data.set(source.data.subarray(from, from + source.width * 4), ((top + y) * width + left) * 4)
  }
  return { data, width, height }
}

/**
 * Trim fully-transparent borders (the art's canvas margins) with a small
 * transparent pad. Sixel cannot express partial alpha, so the pad is dropped
 * by the coverage mask at encode time; trimming first hands the terminal the
 * artwork itself and lets the same cell box draw her larger.
 */
function trimTransparent(source: TerminalImageSource, pad = 4): TerminalImageSource {
  const { data, width, height } = source
  let minX = width
  let minY = height
  let maxX = -1
  let maxY = -1
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      // Anti-aliased edges carry alpha > 0, so only truly empty pixels fall
      // outside the bounding box.
      if (data[(y * width + x) * 4 + 3] === 0) continue
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
  }
  if (maxX < minX || maxY < minY) return source
  const left = Math.max(0, minX - pad)
  const top = Math.max(0, minY - pad)
  const right = Math.min(width - 1, maxX + pad)
  const bottom = Math.min(height - 1, maxY + pad)
  const cropWidth = right - left + 1
  const cropHeight = bottom - top + 1
  if (cropWidth === width && cropHeight === height) return source
  const cropped = new Uint8Array(cropWidth * cropHeight * 4)
  for (let y = 0; y < cropHeight; y++) {
    const from = ((top + y) * width + left) * 4
    cropped.set(data.subarray(from, from + cropWidth * 4), y * cropWidth * 4)
  }
  return { data: cropped, width: cropWidth, height: cropHeight }
}

/**
 * 两张立绘，终端图像能力确认后解码（一次把两张都备好，点击换图不等待）。
 * @param enabled - `useTerminalImages()` 的结果；为假时根本不解码。
 * @param assets - 资产集（默认鲸鱼娘；claude 品牌传 `CLAUDE_GIRL_ASSETS`）。
 * @returns 两张 RGBA 源；未就绪/不可用时为 `undefined`。
 */
export function useMaidPortraits(enabled: boolean, assets: PortraitAssets = MAID_ASSETS): MaidPortraits | undefined {
  const [sources, setSources] = React.useState<MaidPortraits | undefined>(undefined)
  React.useEffect(() => {
    if (!enabled) return
    let live = true
    void loadMaidPortraits(assets).then(next => {
      if (live && next !== undefined) setSources(next)
    })
    return () => { live = false }
  }, [enabled, assets])
  return enabled ? sources : undefined
}

/** Fallback aspect before the source lands (square canvas). */
const MAID_RATIO = 1

/**
 * The portrait's center column inside the whale's 40-column slot: the
 * aspect-fit image spans columns 5..34 (center 19.5). The welcome tagline
 * centers on this instead of `WHALE_CENTER` while the portrait shows.
 */
export const MAID_BOX_CENTER = 19.5

/**
 * The portrait as an Ink component: a `width × height` cell box (aspect-fit
 * from the real cell metrics so pixels stay square), centered horizontally
 * by the caller's slot. `presentation` follows the surface — `'transcript'`
 * opts into Sixel for the scrollable header, `'preview'` for modal cards —
 * and the portrait always floats `transparent`: her trimmed silhouette sits
 * on whatever the terminal shows, with no backing rectangle behind it.
 */
export function MaidPortrait({
  source,
  maxColumns,
  maxRows,
  presentation,
}: {
  /** Decoded RGBA snapshot; `undefined` keeps the caller's fallback. */
  readonly source?: TerminalImageSource
  /** Cell budget (the header passes the whale's 40-column slot). */
  readonly maxColumns: number
  readonly maxRows: number
  readonly presentation: 'transcript' | 'preview'
}): React.ReactNode {
  const cell = useTerminalImageCellSize() ?? DEFAULT_TERMINAL_CELL_SIZE
  const cellRatio = cell.height / cell.width
  // Fit the TRIMMED artwork's own aspect, not the source canvas: the raster
  // is her bounding box, so she fills the slot instead of floating in
  // transparent padding.
  const ratio = source !== undefined && source.height > 0 ? source.width / source.height : MAID_RATIO
  let width = maxColumns
  let height = Math.round(width / (cellRatio * ratio))
  if (height > maxRows) {
    height = maxRows
    width = Math.max(1, Math.min(maxColumns, Math.round(cellRatio * height * ratio)))
  }
  return (
    <Image
      transparent
      source={source}
      width={width}
      height={height}
      alt=""
      presentation={presentation}
    />
  )
}
