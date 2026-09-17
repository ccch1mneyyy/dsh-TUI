import { whaleAnimation, withoutCapturedWhale } from './whale-animation.mjs'

const xml = value => String(value).replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c])

const ansi = [
  '#000000', '#cd0000', '#00cd00', '#cdcd00', '#0000ee', '#cd00cd', '#00cdcd', '#e5e5e5',
  '#7f7f7f', '#ff0000', '#00ff00', '#ffff00', '#5c5cff', '#ff00ff', '#00ffff', '#ffffff',
]

export function terminalColor(mode, value, defaultColor) {
  if (mode === 0) return defaultColor
  if (mode === 0x3000000) return `#${value.toString(16).padStart(6, '0')}`
  if (mode !== 0x1000000 && mode !== 0x2000000) throw new Error(`Unknown color mode: ${mode}`)
  if (value < 16) return ansi[value]
  if (value >= 232) return '#' + (8 + (value - 232) * 10).toString(16).padStart(2, '0').repeat(3)
  const n = value - 16
  const channel = v => (v === 0 ? 0 : 55 + 40 * v).toString(16).padStart(2, '0')
  return '#' + channel(Math.floor(n / 36)) + channel(Math.floor(n / 6) % 6) + channel(n % 6)
}

export function renderCell(cell, recording) {
  const [col, row, chars, span, fgMode, fgValue, bgMode, bgValue, flags] = cell
  const { cellWidth: cw, cellHeight: ch, fontSize } = recording
  const x = col * cw
  const y = row * ch
  const width = span * cw
  let fg = terminalColor(fgMode, fgValue, recording.foreground)
  let bg = terminalColor(bgMode, bgValue, recording.background)
  if (flags & 8) [fg, bg] = [bg, fg]
  let result = `<g data-cell="${col},${row}">`
  if (bg !== recording.background) result += `<rect x="${x}" y="${y}" width="${width}" height="${ch}" fill="${bg}"/>`
  const opacity = flags & 2 ? ' opacity=".5"' : ''
  if (chars.trim()) {
    result += `<text x="${x}" y="${y + ch - 4}" font-size="${fontSize}" fill="${fg}"${opacity}${flags & 1 ? ' font-weight="bold"' : ''}${flags & 4 ? ' font-style="italic"' : ''}>${xml(chars)}</text>`
  }
  return result + '</g>'
}

export function renderRuntime(recording) {
  if (recording.schema !== 1 || !recording.frames?.length) throw new Error('Invalid terminal capture')
  const whale = whaleAnimation(recording)
  recording = withoutCapturedWhale(recording)
  const { cols, rows, cellWidth, cellHeight, frames } = recording
  const width = cols * cellWidth
  const height = rows * cellHeight
  const duration = frames.reduce((sum, frame) => sum + frame.duration, 0)
  const key = cell => `${cell[0]},${cell[1]}`
  const maps = frames.map(frame => new Map(frame.cells.map(cell => [key(cell), JSON.stringify(cell)])))
  const common = frames[0].cells.filter(cell => maps.every(map => map.get(key(cell)) === JSON.stringify(cell)))
  const commonKeys = new Set(common.map(key))
  let elapsed = 0
  const styles = []
  const layers = frames.map((frame, index) => {
    const start = (elapsed / duration * 100).toFixed(6)
    elapsed += frame.duration
    const end = (elapsed / duration * 100).toFixed(6)
    styles.push(`.frame-${index}{animation:frame${index} ${duration}ms step-end infinite}
@keyframes frame${index}{${index === 0 ? '0%{visibility:visible}' : `0%{visibility:hidden}${start}%{visibility:visible}`}${end}%{visibility:hidden}}`)
    const cells = frame.cells.filter(cell => !commonKeys.has(key(cell)))
    return `<g class="frame frame-${index}" data-frame="${index}" data-name="${xml(frame.name)}">${cells.map(cell => renderCell(cell, recording)).join('')}</g>`
  })
  const zh = recording.language === 'zh'
  const title = zh ? 'dsh-TUI 真实终端录制' : 'dsh-TUI terminal capture'
  const desc = zh
    ? '隔离安装后的真实欢迎页、命令补全、帮助面板与输入过程；目录标签替换为欢迎语。未提交模型请求。'
    : 'Recorded welcome screen, command completion, help and typing; directory labels replaced with welcome copy. No model request was submitted.'
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="title desc">
<title id="title">${title}</title><desc id="desc">${desc}</desc>
<metadata>${xml(JSON.stringify({ versions: recording.versions, cols, rows, ansiSha256: recording.ansiSha256 }))}</metadata>
<style>text{font-family:Consolas,"Microsoft YaHei",monospace;letter-spacing:0}.frame{visibility:hidden}${styles.join('\n')}${whale.styles}</style>
<rect width="${width}" height="${height}" fill="${recording.background}"/>
<g id="common">${common.map(cell => renderCell(cell, recording)).join('')}</g>
${layers.join('\n')}
${whale.content}
</svg>
`
}
