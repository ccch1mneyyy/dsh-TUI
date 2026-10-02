/**
 * 鲸娘皮肤素材包构建脚本（一次性转换，可重复运行、确定性输出）。
 *
 * 输入：用户提供的鲸娘表情包（22 个 GIF，文件名 = 序号-中文名-英文key，
 * 每页 552×528，GIF 逐帧已由 libvips 合成为完整画面）。输出与 deepy 同
 * schema 的字母格素材包 assets/whaleGirl/frames.json：
 *
 *   { size: [42, 30], palette: { K: '#rrggbb', ... },
 *     animations: [{ key, title, frames: [{ dur, rows }] }] }
 *
 * 转换规则：
 * - 每页等比 contain 进 42×30 字母格（552×528 → 高 30、宽约 31，水平
 *   居中，两侧补 '.'），透明像素（alpha < ${ALPHA_THRESHOLD}）→ '.'；
 * - 跨全部动画统计网格分辨率下的主色直方图，近色聚成 ≤${PALETTE_MAX} 个单字符键
 *   （可打印非 '.' 字符，按出现频次降序分配），像素按最近质心归键；
 * - dur 取 GIF 的 per-frame delay；连续相同帧合并（dur 相加）；单动画
 *   超过 ${FRAME_CAP} 帧时等距抽帧并合并时长（267 帧的源目前都不超，逻辑
 *   留着以防素材更新）。
 *
 * 用法：node scripts/build-whale-girl-kit.mjs [源GIF目录]
 * （默认目录是用户 2026-10-02 提供的素材位置，见 assets/whaleGirl/README.md）
 */
import { mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const sharp = require('sharp')

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SOURCE_DIR = process.argv[2] ?? 'D:/code/projects/个人简历/05_面试PPT_东昇聚变/_素材/鲸娘表情包'
const OUT_DIR = join(REPO_ROOT, 'assets', 'whaleGirl')
const OUT_JSON = join(OUT_DIR, 'frames.json')
const OUT_README = join(OUT_DIR, 'README.md')

const COLUMNS = 42
const ROWS = 30
const ALPHA_THRESHOLD = 128
const PALETTE_MAX = 30
/** 近色合并阈值（RGB 欧氏距离；质心间小于它的两个簇并成一个）。 */
const MERGE_DISTANCE = 48
const FRAME_CAP = 30
/** 调色键字符表：可打印、非 '.'、按簇频次降序取用。 */
const PALETTE_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'

/** 文件名 → { title(中文), key(英文) }：序号-中文名-key；中文名本身不含
 * '-'，key 可以（idle-look / poke-left / smile-hearts …），所以第二段固定
 * 是 title、第三段起全部拼回 key。 */
function parseName(file) {
  const stem = file.replace(/\.gif$/, '')
  const parts = stem.split('-')
  if (parts.length < 3) throw new Error('素材文件名不符合 序号-中文名-key 形式: ' + file)
  const title = parts[1]
  const key = parts.slice(2).join('-')
  if (!/^[a-z][a-z0-9-]*$/.test(key)) throw new Error('动画 key 非法: ' + file + ' -> ' + key)
  return { title, key }
}

/** 解析一页 → 42×30 RGBA 网格（contain 居中，透明底）。 */
async function decodePage(file, page) {
  const { data } = await sharp(file, { page, pages: 1 })
    .ensureAlpha()
    .resize(COLUMNS, ROWS, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .raw()
    .toBuffer({ resolveWithObject: true })
  if (data.length !== COLUMNS * ROWS * 4) throw new Error('解码尺寸异常: ' + file + ' page ' + page)
  return data
}

async function main() {
  const files = readdirSync(SOURCE_DIR).filter(f => f.endsWith('.gif')).sort()
  if (files.length === 0) throw new Error('源目录没有 GIF: ' + SOURCE_DIR)

  // --- 1. 逐 GIF 逐页解码到网格 ------------------------------------------
  const decoded = []
  for (const file of files) {
    const full = join(SOURCE_DIR, file)
    const meta = await sharp(full, { pages: -1 }).metadata()
    const pages = meta.pages ?? 1
    const delays = meta.delay ?? []
    const { title, key } = parseName(file)
    const frames = []
    for (let page = 0; page < pages; page += 1) {
      const delay = delays[page] ?? delays[delays.length - 1] ?? 100
      // GIF 的 0ms 延时按浏览器惯例当 100ms；钳到 >=20ms 保证 dur 恒正。
      const dur = Math.max(20, delay || 100)
      frames.push({ dur, grid: await decodePage(full, page) })
    }
    decoded.push({ file, title, key, frames })
    console.log('解码 ' + file + ' -> ' + key + ' (' + pages + ' 帧)')
  }

  // --- 2. 全局主色直方图（4bit/通道分箱，箱内加权平均）--------------------
  const bins = new Map()
  for (const animation of decoded) {
    for (const frame of animation.frames) {
      for (let i = 0; i < frame.grid.length; i += 4) {
        if (frame.grid[i + 3] < ALPHA_THRESHOLD) continue
        const r = frame.grid[i]
        const g = frame.grid[i + 1]
        const b = frame.grid[i + 2]
        const binId = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4)
        const bin = bins.get(binId) ?? { r: 0, g: 0, b: 0, count: 0 }
        bin.r += r
        bin.g += g
        bin.b += b
        bin.count += 1
        bins.set(binId, bin)
      }
    }
  }
  // 确定性排序：count 降序，平手按箱 id 升序。
  const ordered = [...bins.entries()].sort((a, b) => b[1].count - a[1].count || a[0] - b[0])
  const centroid = bin => [Math.round(bin.r / bin.count), Math.round(bin.g / bin.count), Math.round(bin.b / bin.count)]
  const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])

  // --- 3. 贪心聚类：近色（<=MERGE_DISTANCE）并入最近簇；簇数到 PALETTE_MAX
  //        后余色一律归最近簇。--------------------------------------------
  const clusters = [] // { rgb:[r,g,b], count }（count 是簇内像素数）
  for (const [, bin] of ordered) {
    const rgb = centroid(bin)
    let nearest = -1
    let nearestDist = Number.POSITIVE_INFINITY
    for (let i = 0; i < clusters.length; i += 1) {
      const d = distance(rgb, clusters[i].rgb)
      if (d < nearestDist) { nearestDist = d; nearest = i }
    }
    if (nearest >= 0 && (nearestDist <= MERGE_DISTANCE || clusters.length >= PALETTE_MAX)) {
      const cluster = clusters[nearest]
      const total = cluster.count + bin.count
      cluster.rgb = [
        Math.round((cluster.rgb[0] * cluster.count + rgb[0] * bin.count) / total),
        Math.round((cluster.rgb[1] * cluster.count + rgb[1] * bin.count) / total),
        Math.round((cluster.rgb[2] * cluster.count + rgb[2] * bin.count) / total),
      ]
      cluster.count = total
    } else {
      clusters.push({ rgb, count: bin.count })
    }
  }
  // 簇排序同样确定：count 降序，平手按颜色字典序。
  clusters.sort((a, b) => b.count - a.count || a.rgb[0] - b.rgb[0] || a.rgb[1] - b.rgb[1] || a.rgb[2] - b.rgb[2])
  if (clusters.length > PALETTE_MAX) throw new Error('聚类结果超过 ' + PALETTE_MAX + ' 个键（不应发生）')
  const hex = rgb => '#' + rgb.map(v => v.toString(16).padStart(2, '0')).join('')
  const palette = {}
  const keys = []
  clusters.forEach((cluster, index) => {
    const char = PALETTE_CHARS[index]
    palette[char] = hex(cluster.rgb)
    keys.push(char)
  })

  // --- 4. 像素归键 → rows；连续相同帧合并；超帧数上限等距抽帧 -------------
  const nearestKey = (r, g, b) => {
    let best = 0
    let bestDist = Number.POSITIVE_INFINITY
    for (let i = 0; i < clusters.length; i += 1) {
      const d = distance([r, g, b], clusters[i].rgb)
      if (d < bestDist) { bestDist = d; best = i }
    }
    return keys[best]
  }
  const usedKeys = new Set()
  const frameRows = frame => {
    const rows = []
    for (let y = 0; y < ROWS; y += 1) {
      let row = ''
      for (let x = 0; x < COLUMNS; x += 1) {
        const i = (y * COLUMNS + x) * 4
        if (frame.grid[i + 3] < ALPHA_THRESHOLD) { row += '.'; continue }
        const key = nearestKey(frame.grid[i], frame.grid[i + 1], frame.grid[i + 2])
        usedKeys.add(key)
        row += key
      }
      rows.push(row)
    }
    return rows
  }
  const mergeIdentical = frames => {
    const merged = []
    for (const frame of frames) {
      const last = merged[merged.length - 1]
      if (last !== undefined && last.rows.join('\n') === frame.rows.join('\n')) last.dur += frame.dur
      else merged.push(frame)
    }
    return merged
  }
  const capFrames = frames => {
    if (frames.length <= FRAME_CAP) return frames
    const kept = []
    let prev = -1
    for (let k = 0; k < FRAME_CAP; k += 1) {
      const index = Math.floor((k * frames.length) / FRAME_CAP)
      const dur = frames.slice(prev + 1, index + 1).reduce((sum, f) => sum + f.dur, 0)
      kept.push({ dur, rows: frames[index].rows })
      prev = index
    }
    return kept
  }

  const animations = decoded.map(animation => {
    let frames = animation.frames.map(frame => ({ dur: frame.dur, rows: frameRows(frame) }))
    const before = frames.length
    frames = capFrames(mergeIdentical(frames))
    console.log('  ' + animation.key + ' (' + animation.title + '): ' + before + ' 帧 -> ' + frames.length + ' 帧, 周期 ' + frames.reduce((s, f) => s + f.dur, 0) + 'ms')
    return { key: animation.key, title: animation.title, frames }
  })

  // 构建侧只保留实际用到的键（校验侧要求键全部在帧里出现过）。
  for (const key of Object.keys(palette)) {
    if (!usedKeys.has(key)) delete palette[key]
  }

  const kit = { size: [COLUMNS, ROWS], palette, animations }
  const json = JSON.stringify(kit)
  mkdirSync(OUT_DIR, { recursive: true })
  writeFileSync(OUT_JSON, json, 'utf8')
  writeFileSync(OUT_README, '# 鲸娘 · 终端版素材包\n\n由用户提供的鲸娘表情包 GIF（22 个动画）转换而来，非官方作品；转换脚本见 scripts/build-whale-girl-kit.mjs，格式与 assets/deepy/frames.json 相同。\n', 'utf8')
  console.log('调色板 ' + Object.keys(palette).length + ' 键: ' + JSON.stringify(palette))
  console.log('写出 ' + OUT_JSON + ' (' + Math.round(json.length / 1024) + 'KB, ' + animations.length + ' 动画, ' + animations.reduce((s, a) => s + a.frames.length, 0) + ' 帧)')
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
