/**
 * 鲸娘皮肤图像协议素材构建脚本（一次性转换，可重复运行、确定性输出）。
 *
 * 输入：用户提供的鲸娘表情包（22 个 GIF，文件名 = 序号-中文名-英文key，
 * 每页 552×528）。输出图像协议渲染用的原生像素帧：
 *
 *   assets/whaleGirl/img/<key>/<两位帧号>.png   （目标高、等比定宽、**保留真实 alpha**）
 *   assets/whaleGirl/img/timings.json           （key -> [{ dur, file }]，帧数全保留）
 *
 * 转换规则（与 skins.tsx 的 WhaleGirlImageSkin 消费端约定）：
 * - COALESCE：GIF 帧是增量差分，拿原始页会花屏。本脚本以
 *   sharp(file, { pages: -1 }) 的整段动画解码为主源——libvips 对整段
 *   解码逐页合成出完整画面（coalesce 由构造保证，不依赖单页行为）。
 *   另做两道实测护栏（见 probeCoalesceParity / 覆盖率断言）：
 *   a) 抽样比对「单页解码 vs 整段切片」的首/中/末三页——记录环境的
 *      单页行为（2026-10 实测 sharp 0.35.4 两者逐字节一致）；
 *   b) 逐页非透明覆盖率断言（alpha>0）：差分帧漏过合成会大面积透明
 *      （覆盖率塌陷），构建直接失败而不是把花屏帧落盘。
 * - ALPHA：**不做任何阈值/收缩**——缩放插值产生的半透明边缘原样保留
 *   （0-255 渐变），kitty 走全保真抗锯齿边；sixel 的硬掩码由渲染层在
 *   编码期提升（terminal-image.ts：coverage is promoted to a hard mask
 *   at encode time），构建期二值化是重复且有害的（把 kitty 也砍成 1bit，
 *   边缘发硬——2026-10 用户实测反馈）。GIF 源本身是 1bit 透明，半透明
 *   边缘只出现在「发生缩放」的档位；native 档（不缩放）保持源的真值。
 * - 分辨率档位（第 2 参，默认见 DEFAULT_HEIGHT）：等比缩到指定高度，
 *   'native' = 原生 552×528 不缩放。档位预算约束（运行轨 LRU/单帧上限）：
 *   素材总量 ≤25MB、单动画解码后 RGBA ≤8MB（最大动画 building 24 帧）。
 * - dur 沿用 GIF delay（0ms 按浏览器惯例当 100ms，钳 >=20ms 恒正），
 *   帧数全保留（267 帧不抽帧、不合帧）。
 *
 * 用法：node scripts/build-whale-girl-images.mjs [源GIF目录] [高度|native]
 * （默认目录是用户 2026-10-02 提供的素材位置，见 assets/whaleGirl/README.md）
 */
import { mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire('D:/code/projects/.worktrees/dsh-tui-live/package.json')
const sharp = require('sharp')

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_SOURCE = 'D:/code/projects/个人简历/05_面试PPT_东昇聚变/_素材/鲸娘表情包'
const OUT_DIR = join(REPO_ROOT, 'assets', 'whaleGirl', 'img')
// 参数既可 [源目录 [高度|native]]，也可 [高度|native]（源目录用默认）。
const argIsHeight = (value) => value === 'native' || /^\d+$/.test(value)
const SOURCE_DIR = process.argv[2] !== undefined && !argIsHeight(process.argv[2])
  ? process.argv[2]
  : DEFAULT_SOURCE
const heightArgRaw = process.argv[2] !== undefined && argIsHeight(process.argv[2])
  ? process.argv[2]
  : process.argv[3]

/** 默认档：素材与单动画解码内存双达标的最大高度（取舍见脚本头与回报）。
 * 2026-10-02 实测：native(552×528) 素材仅 1.6MB 但单动画解码 RGBA 26.7MB
 * （building 24 帧）远超 8MB 线；384px 仍 14.4MB 超线；288px（301×288）
 * 单动画 8127KB ≤ 8MB、素材 11.4MB ≤ 25MB——双达标的最大档。 */
const DEFAULT_HEIGHT = 288
const heightArg = heightArgRaw ?? String(DEFAULT_HEIGHT)
const NATIVE = heightArg === 'native'
const TARGET_HEIGHT = NATIVE ? 0 : Math.max(1, Math.floor(Number(heightArg)))
if (!NATIVE && !Number.isFinite(TARGET_HEIGHT)) throw new Error('高度参数非法: ' + heightArg)

/** 覆盖率塌陷断言阈值：任一页的非透明覆盖率不得低于该动画首页的 10%。 */
const COVERAGE_FLOOR_RATIO = 0.1
/** 单页/整段一致性抽样的步长（逐字节太慢，抽样 + 覆盖率双保险）。 */
const PARITY_STRIDE = 397

/** 文件名 → { title(中文), key(英文) }：序号-中文名-key（同 build-whale-girl-kit.mjs）。 */
function parseName(file) {
  const stem = file.replace(/\.gif$/, '')
  const parts = stem.split('-')
  if (parts.length < 3) throw new Error('素材文件名不符合 序号-中文名-key 形式: ' + file)
  const title = parts[1]
  const key = parts.slice(2).join('-')
  if (!/^[a-z][a-z0-9-]*$/.test(key)) throw new Error('动画 key 非法: ' + file + ' -> ' + key)
  return { title, key }
}

/** 一页 → 等比目标高 RGBA（保留真实 alpha，不做阈值/收缩）。 */
async function buildFrame(pageBuffer, sourceWidth, sourceHeight) {
  const pipeline = sharp(pageBuffer, { raw: { width: sourceWidth, height: sourceHeight, channels: 4 } })
  const resized = NATIVE
    ? pipeline
    : pipeline.resize(Math.max(1, Math.round((sourceWidth * TARGET_HEIGHT) / sourceHeight)), TARGET_HEIGHT, { fit: 'fill' })
  const { data, info } = await resized.raw().toBuffer({ resolveWithObject: true })
  if (data.length !== info.width * info.height * 4) throw new Error('缩放尺寸异常')
  return { data, width: info.width, height: info.height, opaque: countNonTransparent(data) }
}

function countNonTransparent(data) {
  let count = 0
  for (let i = 3; i < data.length; i += 4) if (data[i] > 0) count += 1
  return count
}

/** 单页解码 vs 整段切片抽样比对（环境行为记录 + 异常预警，不改变主源）。 */
async function probeCoalesceParity(file, strip, pageWidth, pageHeight, pages) {
  const probes = [0, Math.floor(pages / 2), pages - 1]
  const results = []
  for (const page of probes) {
    const single = await sharp(file, { page, pages: 1 }).ensureAlpha().raw().toBuffer()
    const offset = page * pageWidth * pageHeight * 4
    let mismatched = 0
    for (let i = 0; i < pageWidth * pageHeight * 4; i += PARITY_STRIDE) {
      if (single[i] !== strip[offset + i]) mismatched += 1
    }
    results.push({ page, mismatched })
  }
  return results
}

async function main() {
  const files = readdirSync(SOURCE_DIR).filter(f => f.endsWith('.gif')).sort()
  if (files.length === 0) throw new Error('源目录没有 GIF: ' + SOURCE_DIR)

  rmSync(OUT_DIR, { recursive: true, force: true })
  mkdirSync(OUT_DIR, { recursive: true })

  const timings = {}
  const stats = []
  let parityMismatches = 0
  for (const file of files) {
    const full = join(SOURCE_DIR, file)
    const meta = await sharp(full, { pages: -1 }).metadata()
    const pages = meta.pages ?? 1
    const pageWidth = meta.width
    // 整段解码（coalesce 主源）：libvips 把动画逐页合成，页高 = 总高/页数。
    const strip = await sharp(full, { pages: -1 }).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
    const pageHeight = strip.info.height / pages
    if (!Number.isInteger(pageHeight) || pageWidth * strip.info.height !== strip.data.length / 4) {
      throw new Error('整段解码尺寸异常: ' + file)
    }
    const parity = await probeCoalesceParity(full, strip.data, pageWidth, pageHeight, pages)
    parityMismatches += parity.filter(p => p.mismatched > 0).length
    const { title, key } = parseName(file)
    const frames = []
    const frameBytes = []
    let firstCoverage = 1
    let minCoverageRatio = 1
    let frameW = 0
    let frameH = 0
    for (let page = 0; page < pages; page += 1) {
      const delay = (meta.delay ?? [])[page] ?? 100
      const dur = Math.max(20, delay || 100)
      const slice = strip.data.subarray(page * pageWidth * pageHeight * 4, (page + 1) * pageWidth * pageHeight * 4)
      const frame = await buildFrame(Buffer.from(slice), pageWidth, pageHeight)
      if (page === 0) { frameW = frame.width; frameH = frame.height }
      else if (frame.width !== frameW || frame.height !== frameH) throw new Error('帧尺寸不一致: ' + file)
      const coverage = frame.opaque / (frame.width * frame.height)
      if (page === 0) firstCoverage = coverage
      minCoverageRatio = Math.min(minCoverageRatio, coverage / firstCoverage)
      const png = await sharp(frame.data, { raw: { width: frame.width, height: frame.height, channels: 4 } })
        .png()
        .toBuffer()
      frameBytes.push(png.length)
      const name = String(page).padStart(2, '0') + '.png'
      mkdirSync(join(OUT_DIR, key), { recursive: true })
      writeFileSync(join(OUT_DIR, key, name), png)
      frames.push({ dur, file: name })
    }
    if (minCoverageRatio < COVERAGE_FLOOR_RATIO) {
      throw new Error('覆盖率塌陷（疑似未合成差分帧）: ' + file + ' minRatio=' + minCoverageRatio.toFixed(3))
    }
    timings[key] = frames
    stats.push({ key, pages, bytes: frameBytes, rgba: pages * frameW * frameH * 4 })
    console.log('解码 ' + file + ' -> ' + key + ' (' + pages + ' 帧 ' + frameW + 'x' + frameH + ', 均值 ' + Math.round(frameBytes.reduce((s, b) => s + b, 0) / frameBytes.length / 1024) + 'KB)')
  }
  if (parityMismatches > 0) {
    console.warn('警告: ' + parityMismatches + ' 个抽样页的单页解码与整段切片不一致（本环境单页行为为差分）；已使用整段合成结果，输出不受影响。')
  } else {
    console.log('coalesce 实测: 单页解码与整段切片在全部抽样页（首/中/末）逐字节一致（步长 ' + PARITY_STRIDE + '），整段合成为主源。')
  }
  writeFileSync(join(OUT_DIR, 'timings.json'), JSON.stringify(timings), 'utf8')

  const allBytes = stats.flatMap(s => s.bytes)
  const total = allBytes.reduce((s, b) => s + b, 0)
  const sorted = [...allBytes].sort((a, b) => a - b)
  const fmt = n => Math.round(n / 1024) + 'KB'
  const maxAnim = stats.reduce((a, b) => (b.rgba > a.rgba ? b : a))
  console.log('写出 ' + OUT_DIR)
  console.log('档位: ' + (NATIVE ? 'native(源尺寸)' : TARGET_HEIGHT + 'px 高') + ' / 共 ' + stats.length + ' 动画 / ' + allBytes.length + ' 帧 / 素材总体积 ' + fmt(total))
  console.log('单帧分布: min ' + fmt(sorted[0]) + ' / 中位 ' + fmt(sorted[Math.floor(sorted.length / 2)]) + ' / max ' + fmt(sorted[sorted.length - 1]))
  console.log('单动画解码 RGBA 峰值: ' + maxAnim.key + ' ' + fmt(maxAnim.rgba) + ' (' + maxAnim.pages + ' 帧)')
  console.log('timings.json ' + fmt(statSync(join(OUT_DIR, 'timings.json')).size))
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
